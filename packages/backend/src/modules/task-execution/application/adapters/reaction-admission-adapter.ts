// RFC-368 T6 —— TaskExecution 对数字员工 `ReactionExecutionAdmissionParticipantInTxV1` 的实现。
//
// 这是 record-before-act 的落点：数字员工在**它自己的 claim 事务里**调 `activateClaim` +
// `admitLaunch`，两者与 claim 的写入同一笔提交；提交之后才发生真正的 `launch`。
//
// 三条关键设计（RFC-368 design §3.2，设计门 P1-2/P1-3 的解法）：
//
//   · `executionRef` 在 **admission 事务内就被预分配**并落库。于是「任务已建、ref 还没写回」
//     那一格根本不存在——崩溃重放按 operation 命中同一行、拿回同一个 id，`launch` 用它当
//     taskId，重复调用天然幂等。`56bb82b50` 那个「一次 Reaction 起两个任务」的缺陷因此不是
//     「修好了」，而是**结构上不可能发生**。
//
//   · `operation_ref` 是**稳定主键**（round + attempt ordinal），`claim_epoch` 是**每次派发
//     递增的列**。两者都做唯一键会互斥：同一个 ordinal 派发失败后重派（epoch +1）就插不进去，
//     round 当场卡死。所以 `admitLaunch` 对同一个 `(operation, requestHash)` **幂等返回既有
//     回执**，同时把 fence 推进到当前 epoch。
//
//   · 参与者只接 `tx`，不持裸 DB handle；作用域退出即失效（仓内 `InTx` 定式）。
//
// 文件落在 `application/adapters/*-adapter.ts` 不是随意选的：账本按这个路径把 TE→DE 的类型
// 引用判成 `required-implementation`（合法实现方向）而不是跨域债。持久化本身在同模块的
// `infrastructure/reactionExecutionAdmissions.ts`，那边不引 DE 的任何类型；两者之间隔着
// `application/ports/reactionAdmissionStore.ts`——应用层不得直接依赖 infrastructure
// （`rfc294-review-module-layer-rules`），实现由组合根注入。

import { ulid } from 'ulid'

import { ConflictError } from '@/util/errors'
import type { ReactionAdmissionStore } from '../ports/reactionAdmissionStore'
import type {
  ReactionClaimEpoch,
  ReactionClaimFenceReceiptV1,
  ReactionExecutionAdmissionParticipantInTxV1,
  ReactionExecutionAdmissionReceiptV1,
  ReactionOperationRef,
  ReactionRequestHash,
} from '@/modules/digital-employee/composition/required-ports'

export function composeReactionExecutionAdmissionParticipantInTx(
  store: ReactionAdmissionStore,
  options: { readonly now: () => number; readonly mintExecutionRef?: () => string },
): ReactionExecutionAdmissionParticipantInTxV1 {
  const now = options.now
  const mint = options.mintExecutionRef ?? (() => ulid())
  const participant: ReactionExecutionAdmissionParticipantInTxV1 = {
    __brand: 'reaction-execution-admission-in-tx-v1',

    async activateClaim(input) {
      const existing = await store.listByRound(input.reaction.roundRef)
      const highest = existing.at(-1) ?? null
      const observed = highest === null ? null : (highest.claimEpoch as ReactionClaimEpoch)
      // CAS：调用方必须说清它以为当前 epoch 是几。说错了就是它手上的 round 行已经过期
      // （别处推进过），这一轮派发直接让位，下一 tick 用新读到的值重来。
      if (observed !== input.expectedPreviousEpoch) {
        throw new ConflictError(
          'employee-reaction-claim-stale',
          `reaction claim epoch moved: expected ${String(input.expectedPreviousEpoch)}, found ${String(observed)}`,
        )
      }
      if (input.nextEpoch <= (observed ?? -1)) {
        throw new ConflictError(
          'employee-reaction-claim-not-advancing',
          `reaction claim epoch must advance: ${String(observed)} → ${String(input.nextEpoch)}`,
        )
      }
      return Object.freeze({
        __brand: 'te-journal-backed-reaction-claim-fence-v1',
        roundRef: input.reaction.roundRef,
        claimEpoch: input.nextEpoch,
        fenceRevision: (highest?.fenceRevision ?? 0) + 1,
        caseId: input.employeeCase.id,
        authority: { subject: input.authority.subject, revision: input.authority.revision },
      }) satisfies ReactionClaimFenceReceiptV1
    },

    async admitLaunch(input) {
      const stamp = now()
      const existing = await store.find(input.operation)
      if (existing !== null) {
        // 同一个 operation 已登记过。这是崩溃重放或派发重试——**必须返回同一个 execution**，
        // 否则就会起第二个任务，正是本 RFC 要消灭的那件事。
        if (existing.requestHash !== input.requestHash) {
          throw new ConflictError(
            'employee-reaction-admission-hash-mismatch',
            `reaction admission ${input.operation} was admitted with a different request`,
          )
        }
        if (existing.claimEpoch !== input.fence.claimEpoch) {
          await store.advanceFence({
            operationRef: input.operation,
            claimEpoch: input.fence.claimEpoch,
            fenceRevision: input.fence.fenceRevision,
            now: stamp,
          })
        }
        return frozenReceipt(input, existing.executionRef)
      }
      const executionRef = mint()
      await store.insert({
        operationRef: input.operation,
        caseId: input.fence.caseId,
        roundRef: input.fence.roundRef,
        claimEpoch: input.fence.claimEpoch,
        fenceRevision: input.fence.fenceRevision,
        requestHash: input.requestHash,
        authoritySubject: input.fence.authority.subject,
        authorityRevision: input.fence.authority.revision,
        executionRef,
        now: stamp,
      })
      return frozenReceipt(input, executionRef)
    },

    async closeClaim(input) {
      // 收口对**这一轮的所有** admission 行生效：一个 round 可能经历多次 attempt（每次一个
      // operation）。结算时它们一起终结，否则旧行会永久停在 admitted/launched。
      const rows = await store.listByRound(input.reaction.roundRef)
      for (const row of rows) {
        await store.close(row.operationRef, now())
      }
    },
  }
  return Object.freeze(participant)
}

function frozenReceipt(
  input: {
    readonly fence: ReactionClaimFenceReceiptV1
    readonly operation: ReactionOperationRef
    readonly requestHash: ReactionRequestHash
  },
  executionRef: string,
): ReactionExecutionAdmissionReceiptV1 {
  return Object.freeze({
    __brand: 'te-journal-backed-reaction-admission-v1',
    fence: input.fence,
    operation: input.operation,
    requestHash: input.requestHash,
    execution: executionRef,
  }) satisfies ReactionExecutionAdmissionReceiptV1
}
