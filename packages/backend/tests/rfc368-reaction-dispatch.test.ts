// RFC-368 T8 / T11 / T13 —— 数字员工的 Reaction 派发臂（取代 outbox 的 `execution-launch`）。
//
// 锁四件事：
//   ① record-before-act：admission 与派发 epoch 同事务登记，执行身份在事务里就写到 round 上，
//      `launch` 拿的是同一个 id（design §4.1）。
//   ② 崩溃重放：admission 已提交、`launch` 没回来时进程死掉——租约过期后另一个 worker 重选这个
//      round，拿到**同一个执行身份**，admission 日志仍只有一行。这是 E9-C 那条缺陷
//      （一次 Reaction 起两个任务）在新合同下的结构性解法。
//   ③ 派发级预算：`launch` 本身失败时按 `dispatchRetrySchedule` 退避重派，耗尽后走终结分支，
//      两个用户可见字面值按 design §4.2 固定（`reaction-dispatch-failed` / `reaction-dispatch: `）——
//      不会无限重试（设计门 P1-7）。
//   ④ 案例已终止：不建任务，round 收成 obsolete，案例的 terminalKind 不被覆写。
// 另锁 T13：round 结算与 admission 收口同事务，不留 admitted/launched 残行。

import { describe, expect, test } from 'bun:test'

import { describeEachProvider } from './helpers/eachProvider'
import {
  REACTION_LEASE_MS,
  REACTION_ROUND,
  reactionRows,
  reactionService,
  scriptedPort,
  seedReaction,
} from './helpers/rfc368ReactionFixture'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import { composeReactionExecutionAdmissionParticipantInTx } from '@/modules/task-execution/application/adapters/reaction-admission-adapter'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'

const OPERATION_0 = `reaction:${REACTION_ROUND}:0`

describe('RFC-368 T8 —— Reaction 派发臂', () => {
  describeEachProvider('dispatchOneReaction', (harness) => {
    let clock = 10_000
    let minted = 0
    const now = () => clock
    const mint = () => `execution-${++minted}`
    function reset(): void {
      clock = 10_000
      minted = 0
    }
    const launchesOf = (port: ReturnType<typeof scriptedPort>) =>
      port.launches.map(({ operation, execution }) => ({ operation, execution }))

    test('① 同事务登记 admission 并把执行身份写到 round；launch 用的是同一个 id', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      expect(await reactionService(harness.db, { port, now, mint }).dispatchOneReaction()).toBe(
        'launched',
      )
      expect(launchesOf(port)).toEqual([{ operation: OPERATION_0, execution: 'execution-1' }])
      const rows = await reactionRows(harness.db)
      expect(rows.round).toMatchObject({ state: 'running', executionRef: 'execution-1' })
      expect(rows.dispatch).toMatchObject({
        claimEpoch: 1,
        dispatchAttempts: 1,
        operationRef: OPERATION_0,
      })
      expect(rows.admissions.map((row) => [row.operationRef, row.executionRef])).toEqual([
        [OPERATION_0, 'execution-1'],
      ])
    })

    test('② 崩溃重放：admission 已提交、launch 没回来——租约过期后重选，同一个执行身份', async () => {
      reset()
      await seedReaction(harness.db)
      const crashed = scriptedPort()
      // worker-a 的 launch 永不返回：模拟 admission 提交之后、launch 回执之前进程死掉。
      crashed.launchBehavior = () => new Promise<void>(() => {})
      void reactionService(harness.db, {
        port: crashed,
        now,
        mint,
        workerId: 'worker-a',
      }).dispatchOneReaction()
      await Bun.sleep(50)
      expect(crashed.launches).toHaveLength(1)
      expect((await reactionRows(harness.db)).round.state).toBe('planned')

      // 租约还在：别的 worker 领不到。
      const port = scriptedPort()
      const other = reactionService(harness.db, { port, now, mint, workerId: 'worker-b' })
      expect(await other.dispatchOneReaction()).toBe('idle')

      clock += REACTION_LEASE_MS + 1
      expect(await other.dispatchOneReaction()).toBe('launched')
      expect(launchesOf(crashed)).toEqual([{ operation: OPERATION_0, execution: 'execution-1' }])
      expect(launchesOf(port)).toEqual([{ operation: OPERATION_0, execution: 'execution-1' }])
      const rows = await reactionRows(harness.db)
      expect(rows.round).toMatchObject({ state: 'running', executionRef: 'execution-1' })
      expect(rows.admissions).toHaveLength(1)
      expect(rows.dispatch).toMatchObject({ claimEpoch: 2, dispatchAttempts: 2 })
    })

    test('③ launch 失败按派发级退避重派；耗尽后结算 failed、案例 blocked，字面值固定', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      port.launchBehavior = async () => {
        throw new Error('exact agent unavailable')
      }
      const failing = reactionService(harness.db, { port, now, mint })
      expect(await failing.dispatchOneReaction()).toBe('retried')
      let rows = await reactionRows(harness.db)
      expect(rows.round).toMatchObject({ state: 'planned', executionRef: null })
      expect(rows.dispatch).toMatchObject({
        dispatchAttempts: 1,
        dispatchClaimedBy: null,
        dispatchLeaseExpiresAt: null,
        operationRef: null,
        nextAttemptAt: clock + 100,
        lastDispatchError: 'exact agent unavailable',
      })
      // 退避未到：不重派。
      expect(await failing.dispatchOneReaction()).toBe('idle')

      clock += 100
      expect(await failing.dispatchOneReaction()).toBe('settled')
      // 两次派发同一个 ordinal ⇒ 同一个 operation、同一个执行身份（admission 幂等）。
      expect(port.launches.map((launch) => launch.execution)).toEqual([
        'execution-1',
        'execution-1',
      ])
      rows = await reactionRows(harness.db)
      expect(rows.round.state).toBe('failed')
      expect(JSON.parse(rows.round.outputJson!)).toEqual({
        kind: 'reaction-dispatch-failed',
        errorCode: 'internal-error',
        detail: 'exact agent unavailable',
      })
      expect(rows.employeeCase).toMatchObject({
        state: 'blocked',
        blockReason: 'reaction-dispatch: exact agent unavailable',
        activeRoundId: null,
      })
      // T13：结算与收口同事务。
      expect(rows.admissions.map((row) => row.state)).toEqual(['closed'])
    })

    test('③′ handoffOnExhausted=false ⇒ 耗尽后案例直接终止', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      port.launchBehavior = async () => {
        throw new Error('boom')
      }
      const failing = reactionService(harness.db, { port, now, mint, handoffOnExhausted: false })
      await failing.dispatchOneReaction()
      clock += 100
      expect(await failing.dispatchOneReaction()).toBe('settled')
      expect((await reactionRows(harness.db)).employeeCase).toMatchObject({
        state: 'terminal',
        terminalKind: 'platform-dispatch-failed',
      })
    })

    test('④ 案例已终止：不建任务，round 收成 obsolete，terminalKind 原样保留', async () => {
      reset()
      await seedReaction(harness.db, { caseState: 'terminal', terminalKind: 'user-canceled' })
      const port = scriptedPort()
      expect(await reactionService(harness.db, { port, now, mint }).dispatchOneReaction()).toBe(
        'settled',
      )
      expect(port.launches).toEqual([])
      const rows = await reactionRows(harness.db)
      expect(rows.round.state).toBe('obsolete')
      expect(rows.employeeCase).toMatchObject({
        state: 'terminal',
        terminalKind: 'user-canceled',
        activeRoundId: null,
      })
    })

    test('未到期不派发', async () => {
      reset()
      await seedReaction(harness.db, { nextAttemptAt: clock + 1 })
      const port = scriptedPort()
      expect(await reactionService(harness.db, { port, now, mint }).dispatchOneReaction()).toBe(
        'idle',
      )
      expect(port.launches).toEqual([])
      expect((await reactionRows(harness.db)).dispatch.dispatchAttempts).toBe(0)
    })

    test('T13：round 正常结算时 admission 同事务收口', async () => {
      reset()
      await seedReaction(harness.db)
      await reactionService(harness.db, { port: scriptedPort(), now, mint }).dispatchOneReaction()
      await createRuntimePersistence(harness.db, {
        reactionAdmission: (tx) =>
          composeReactionExecutionAdmissionParticipantInTx(createReactionAdmissionStore(tx), {
            now,
          }),
      }).settleRound({ roundId: REACTION_ROUND, state: 'completed', outputJson: '{}', now: clock })
      expect((await reactionRows(harness.db)).admissions.map((row) => row.state)).toEqual([
        'closed',
      ])
    })
  })
})
