// RFC-368 T6 —— Reaction admission 日志的持久化实现（TaskExecution 拥有）。
//
// 只实现同模块 `application/ports/reactionAdmissionStore.ts` 那个端口，**不引数字员工的任何
// 类型**。两条守卫决定了这个形状：`rfc294-review-module-layer-rules` 禁止应用层直接依赖
// infrastructure（所以是端口 + 组合根注入，不是 application 直接 import 这里），
// `rfc359-w5-t19f` 禁止模块顶层捕获 schema 表列（所以列选择写在函数体内）。

import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { reactionExecutionAdmissions } from '@/db/schema'
import type {
  ReactionAdmissionInsert,
  ReactionAdmissionRow,
  ReactionAdmissionStore,
} from '../application/ports/reactionAdmissionStore'

function rowColumns(): {
  operationRef: typeof reactionExecutionAdmissions.operationRef
  roundRef: typeof reactionExecutionAdmissions.roundRef
  claimEpoch: typeof reactionExecutionAdmissions.claimEpoch
  fenceRevision: typeof reactionExecutionAdmissions.fenceRevision
  executionRef: typeof reactionExecutionAdmissions.executionRef
  requestHash: typeof reactionExecutionAdmissions.requestHash
  state: typeof reactionExecutionAdmissions.state
} {
  return {
    operationRef: reactionExecutionAdmissions.operationRef,
    roundRef: reactionExecutionAdmissions.roundRef,
    claimEpoch: reactionExecutionAdmissions.claimEpoch,
    fenceRevision: reactionExecutionAdmissions.fenceRevision,
    executionRef: reactionExecutionAdmissions.executionRef,
    requestHash: reactionExecutionAdmissions.requestHash,
    state: reactionExecutionAdmissions.state,
  }
}

export function createReactionAdmissionStore(db: ProviderNeutralDatabase): ReactionAdmissionStore {
  return Object.freeze({
    async find(operationRef: string): Promise<ReactionAdmissionRow | null> {
      const row = await db
        .select(rowColumns())
        .from(reactionExecutionAdmissions)
        .where(eq(reactionExecutionAdmissions.operationRef, operationRef))
        .get()
      return row ?? null
    },

    async listByRound(roundRef: string): Promise<readonly ReactionAdmissionRow[]> {
      return await db
        .select(rowColumns())
        .from(reactionExecutionAdmissions)
        .where(eq(reactionExecutionAdmissions.roundRef, roundRef))
        .orderBy(reactionExecutionAdmissions.claimEpoch)
        .all()
    },

    async insert(input: ReactionAdmissionInsert) {
      await db
        .insert(reactionExecutionAdmissions)
        .values({
          operationRef: input.operationRef,
          caseId: input.caseId,
          roundRef: input.roundRef,
          claimEpoch: input.claimEpoch,
          fenceRevision: input.fenceRevision,
          requestHash: input.requestHash,
          authoritySubject: input.authoritySubject,
          authorityRevision: input.authorityRevision,
          executionRef: input.executionRef,
          state: 'admitted',
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run()
    },

    async advanceFence(input: {
      readonly operationRef: string
      readonly claimEpoch: number
      readonly fenceRevision: number
      readonly now: number
    }) {
      await db
        .update(reactionExecutionAdmissions)
        .set({
          claimEpoch: input.claimEpoch,
          fenceRevision: input.fenceRevision,
          updatedAt: input.now,
        })
        .where(eq(reactionExecutionAdmissions.operationRef, input.operationRef))
        .run()
    },

    async close(operationRef: string, now: number) {
      await db
        .update(reactionExecutionAdmissions)
        .set({ state: 'closed', updatedAt: now })
        .where(eq(reactionExecutionAdmissions.operationRef, operationRef))
        .run()
    },

    async markLaunched(operationRef: string, now: number) {
      await db
        .update(reactionExecutionAdmissions)
        .set({ state: 'launched', updatedAt: now })
        .where(
          and(
            eq(reactionExecutionAdmissions.operationRef, operationRef),
            eq(reactionExecutionAdmissions.state, 'admitted'),
          ),
        )
        .run()
    },
  })
}
