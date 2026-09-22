// RFC-368 T6 —— admission 日志与 tx-bound 参与者。
//
// 这支锁的是 record-before-act 的三条核心保证（design §3.2 / §7）：
//   ① `admitLaunch` 在**事务内预分配** executionRef 并落库——崩溃重放按 operation 命中同一行、
//      拿回同一个 id。「一次 Reaction 起两个任务」因此不是「修好了」，是结构上不可能发生。
//   ② `operation` 是稳定键、`claim_epoch` 是行上递增的列。同一个 ordinal 派发失败后重派
//      （epoch +1）必须仍然命中同一行，否则 round 卡死（设计门 P1-3）。
//   ③ claim CAS 与 admission 写入在**同一个事务**里：中途抛错，两者都不留（AC-3）。

import { describe, expect, test } from 'bun:test'

import { DomainError } from '@/util/errors'

import { describeEachProvider } from './helpers/eachProvider'
import { reactionExecutionAdmissions } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { composeReactionExecutionAdmissionParticipantInTx } from '@/modules/task-execution/application/adapters/reaction-admission-adapter'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'
import type {
  ReactionClaimEpoch,
  ReactionOperationRef,
  ReactionRequestHash,
} from '@/modules/digital-employee/composition/required-ports'

const ROUND = 'round-admission'
const CASE = 'case-admission'
const OPERATION = `reaction:${ROUND}:0` as ReactionOperationRef
const HASH = 'a'.repeat(64) as ReactionRequestHash
const AUTHORITY = { subject: 'user-1', revision: 3 }

/** 断言抛出的是带指定 `code` 的领域错误——`code` 才是稳定契约，`message` 只给人看。 */
async function expectDomainCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  await promise.catch((error: unknown) => {
    caught = error
  })
  expect(caught).toBeInstanceOf(DomainError)
  expect((caught as DomainError).code).toBe(code)
}

function epoch(value: number): ReactionClaimEpoch {
  return value as ReactionClaimEpoch
}

describe('RFC-368 T6 —— Reaction admission（record-before-act）', () => {
  describeEachProvider('同事务 claim + admission', (harness) => {
    async function admit(input: {
      readonly operation?: ReactionOperationRef
      readonly hash?: ReactionRequestHash
      readonly expectedPreviousEpoch: ReactionClaimEpoch | null
      readonly nextEpoch: ReactionClaimEpoch
      readonly mint?: () => string
      readonly throwAfterAdmit?: boolean
    }): Promise<string> {
      const session = databaseSessionFor(harness.db)
      let executionRef = ''
      await session.transaction(async (tx) => {
        const participant = composeReactionExecutionAdmissionParticipantInTx(
          createReactionAdmissionStore(tx),
          {
            now: () => 1_000,
            ...(input.mint === undefined ? {} : { mintExecutionRef: input.mint }),
          },
        )
        const fence = await participant.activateClaim({
          employeeCase: { id: CASE },
          reaction: { roundRef: ROUND },
          expectedPreviousEpoch: input.expectedPreviousEpoch,
          nextEpoch: input.nextEpoch,
          authority: AUTHORITY,
        })
        const receipt = await participant.admitLaunch({
          fence,
          operation: input.operation ?? OPERATION,
          requestHash: input.hash ?? HASH,
        })
        executionRef = receipt.execution
        if (input.throwAfterAdmit === true) throw new Error('rfc368-rollback-probe')
      })
      return executionRef
    }

    test('admitLaunch 在事务内预分配 executionRef 并落库', async () => {
      const executionRef = await admit({
        expectedPreviousEpoch: null,
        nextEpoch: epoch(1),
        mint: () => 'execution-minted-in-tx',
      })
      expect(executionRef).toBe('execution-minted-in-tx')
      const row = await createReactionAdmissionStore(harness.db).find(OPERATION)
      expect(row).toMatchObject({
        operationRef: OPERATION,
        roundRef: ROUND,
        claimEpoch: 1,
        executionRef: 'execution-minted-in-tx',
        state: 'admitted',
      })
    })

    test('同 operation 重放拿回同一个 execution，不新建行（AC-4）', async () => {
      const first = await admit({
        expectedPreviousEpoch: null,
        nextEpoch: epoch(1),
        mint: () => 'execution-first',
      })
      // 崩溃重放：同一个 operation、同一个 hash，但派发轮次推进了（epoch 1 → 2）。
      const replay = await admit({
        expectedPreviousEpoch: epoch(1),
        nextEpoch: epoch(2),
        mint: () => 'execution-second-must-not-be-used',
      })
      expect(replay).toBe(first)
      const rows = await harness.db.select().from(reactionExecutionAdmissions).all()
      expect(rows).toHaveLength(1)
      // fence 推进到当前 epoch，行仍是那一行（P1-3：epoch 不参与唯一键）。
      expect(rows[0]?.claimEpoch).toBe(2)
    })

    test('同 operation 换了请求内容则拒绝——那不是重放', async () => {
      await admit({ expectedPreviousEpoch: null, nextEpoch: epoch(1) })
      await expectDomainCode(
        admit({
          expectedPreviousEpoch: epoch(1),
          nextEpoch: epoch(2),
          hash: 'b'.repeat(64) as ReactionRequestHash,
        }),
        'employee-reaction-admission-hash-mismatch',
      )
    })

    test('epoch CAS：调用方说错当前 epoch 就让位', async () => {
      await admit({ expectedPreviousEpoch: null, nextEpoch: epoch(1) })
      await expectDomainCode(
        admit({ expectedPreviousEpoch: null, nextEpoch: epoch(2) }),
        'employee-reaction-claim-stale',
      )
    })

    test('epoch 必须推进，不能原地或倒退', async () => {
      await admit({ expectedPreviousEpoch: null, nextEpoch: epoch(1) })
      await expectDomainCode(
        admit({ expectedPreviousEpoch: epoch(1), nextEpoch: epoch(1) }),
        'employee-reaction-claim-not-advancing',
      )
    })

    test('AC-3：事务中途抛错，admission 行不留——claim 与 admission 同生共死', async () => {
      await expect(
        admit({ expectedPreviousEpoch: null, nextEpoch: epoch(1), throwAfterAdmit: true }),
      ).rejects.toThrow('rfc368-rollback-probe')
      expect(await harness.db.select().from(reactionExecutionAdmissions).all()).toHaveLength(0)
    })

    test('closeClaim 收口这一轮的**所有** attempt 行，不留 admitted 残留', async () => {
      await admit({ expectedPreviousEpoch: null, nextEpoch: epoch(1) })
      await admit({
        operation: `reaction:${ROUND}:1` as ReactionOperationRef,
        hash: 'c'.repeat(64) as ReactionRequestHash,
        expectedPreviousEpoch: epoch(1),
        nextEpoch: epoch(2),
      })
      const session = databaseSessionFor(harness.db)
      await session.transaction(async (tx) => {
        await composeReactionExecutionAdmissionParticipantInTx(createReactionAdmissionStore(tx), {
          now: () => 2_000,
        }).closeClaim({
          reaction: { roundRef: ROUND },
          expectedCurrentEpoch: epoch(2),
          reason: 'completed',
        })
      })
      const rows = await harness.db.select().from(reactionExecutionAdmissions).all()
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.state === 'closed')).toBe(true)
    })

    test('markLaunched 只推进 admitted 行，重复调用无副作用', async () => {
      await admit({ expectedPreviousEpoch: null, nextEpoch: epoch(1) })
      const store = createReactionAdmissionStore(harness.db)
      await store.markLaunched(OPERATION, 3_000)
      await store.markLaunched(OPERATION, 4_000)
      expect((await store.find(OPERATION))?.state).toBe('launched')
    })
  })
})
