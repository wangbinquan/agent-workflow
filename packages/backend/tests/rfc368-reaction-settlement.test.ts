// RFC-368 T10 / T12 / T14 —— Reaction 在新合同下的结算、round 级重试与取消语义。
//
//   T10：执行失败后的 round 级重试——纠错反馈裁剪后按内容地址存档、派发时只带 ref；预算收敛后
//        的 plan **写回 round**（请求 hash 只对 round 上冻结的 plan 算，写回后同一 ordinal 的
//        重放才稳定，设计门 P1-4）；派发行重置成「下一个 ordinal 待派发」。反馈写失败降级成
//        不带反馈，不阻塞重试（偏离 D8）。
//   T12：按 `{operation, executionRef}` 查快照；诊断 ref 解回正文、不重复 errorCode 前缀。
//   T14（G7）：取消 ⇒ `stopped` ⇒ 结算但**不消耗重试预算**；用户终止案例时顺手停掉在跑的 agent，
//        停不掉也不把终止本身报成失败。
// 另锁 D 侧的产物存档：同一段正文只存一行（AC-9），sink 按工作区根改写路径（R2）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describeEachProvider } from './helpers/eachProvider'
import {
  REACTION_ROUND,
  reactionRows,
  reactionService,
  scriptedPort,
  seedReaction,
} from './helpers/rfc368ReactionFixture'
import { employeeReactionArtifacts } from '@/db/schema'
import type { ReactionArtifactPersistence } from '@/modules/digital-employee/application/ports/reactionArtifacts'
import { composeReactionArtifactPorts } from '@/modules/digital-employee/composition/reactionArtifacts'
import type {
  ReactionDiagnosticsRef,
  ReactionRetryFeedbackRef,
} from '@/modules/digital-employee/composition/required-ports'
import { sanitizeReactionText } from '@/modules/digital-employee/domain/reactionArtifacts'
import { createReactionArtifactPersistence } from '@/modules/digital-employee/infrastructure/reactionArtifactStore'

const METERING = { sourceRef: 'task:execution-1', durationMs: 5, totalTokens: 100 }

describe('RFC-368 T10/T12/T14 —— Reaction 结算', () => {
  describeEachProvider('新合同下的 inspect / 重试 / 取消', (harness) => {
    let clock = 10_000
    let minted = 0
    const now = () => clock
    const mint = () => `execution-${++minted}`
    function reset(): void {
      clock = 10_000
      minted = 0
    }

    async function diagnostics(errorCode: string, errorDetail: string): Promise<string> {
      return await createReactionArtifactPersistence(harness.db).put(
        'diagnostics',
        sanitizeReactionText({ errorCode, errorDetail, workspaceRoot: null }),
        clock,
      )
    }

    test('T10：失败 ⇒ 反馈存档、预算写回 plan、派发行重置；下一次派发带反馈 ref 用新 ordinal', async () => {
      reset()
      await seedReaction(harness.db, { maxTotalTokens: 1_000 })
      const port = scriptedPort()
      const service = reactionService(harness.db, { port, now, mint })
      expect(await service.dispatchOneReaction()).toBe('launched')

      port.snapshot = {
        kind: 'failed',
        errorClass: 'semantic',
        errorCode: 'execution-output-missing',
        diagnostics: (await diagnostics(
          'execution-output-missing',
          'no result port',
        )) as ReactionDiagnosticsRef,
        metering: METERING,
      }
      expect(await service.inspectOneExecution()).toBe('retried')

      let rows = await reactionRows(harness.db)
      expect(rows.round).toMatchObject({ state: 'planned', executionRef: null, attemptOrdinal: 1 })
      // T12：诊断正文解回来时不重复 errorCode 前缀。
      expect(JSON.parse(rows.round.outputJson!)).toMatchObject({
        errorCode: 'execution-output-missing',
        errorDetail: 'no result port',
      })
      // 预算收敛写回 round：案例上限 1000，已用 100 ⇒ 900。
      expect(JSON.parse(rows.round.planJson).maxTotalTokens).toBe(900)
      const feedback = sanitizeReactionText({
        errorCode: 'execution-output-missing',
        errorDetail: 'no result port',
        workspaceRoot: null,
      })
      expect(rows.dispatch).toMatchObject({
        dispatchAttempts: 0,
        dispatchClaimedBy: null,
        dispatchLeaseExpiresAt: null,
        operationRef: null,
        nextAttemptAt: clock + 100,
        retryFeedbackRef: `retry-feedback:${feedback.digest}`,
        lastDispatchError: null,
      })

      clock += 100
      expect(await service.dispatchOneReaction()).toBe('launched')
      const retry = port.launches.at(-1)!
      expect(retry.operation).toBe(`reaction:${REACTION_ROUND}:1`)
      expect(retry.execution).toBe('execution-2')
      expect(retry.prepared.request.attempt as unknown).toEqual({
        ordinal: 1,
        mode: 'same-scene',
        retryFeedback: { kind: 'artifact', ref: `retry-feedback:${feedback.digest}` },
      })
      expect((retry.prepared.request.plan as { maxTotalTokens: number }).maxTotalTokens).toBe(900)
      // 反馈 ref 能被 TE 侧的 reader 解回正文。
      const ports = composeReactionArtifactPorts(createReactionArtifactPersistence(harness.db), now)
      expect(
        await ports.retryFeedback.read(
          `retry-feedback:${feedback.digest}` as ReactionRetryFeedbackRef,
        ),
      ).toBe('execution-output-missing: no result port')
      rows = await reactionRows(harness.db)
      expect(rows.admissions.map((row) => row.operationRef).sort()).toEqual([
        `reaction:${REACTION_ROUND}:0`,
        `reaction:${REACTION_ROUND}:1`,
      ])
    })

    test('T10：反馈存档失败 ⇒ 降级成不带反馈，照常重试，原因记在派发行上', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      const real = createReactionArtifactPersistence(harness.db)
      const broken: ReactionArtifactPersistence = {
        put: async (kind, text, at) => {
          if (kind === 'retry-feedback') throw new Error('disk full')
          return await real.put(kind, text, at)
        },
        read: (ref) => real.read(ref),
      }
      const service = reactionService(harness.db, { port, now, mint, artifacts: broken })
      await service.dispatchOneReaction()
      port.snapshot = {
        kind: 'failed',
        errorClass: 'semantic',
        errorCode: 'boom',
        diagnostics: (await diagnostics('boom', 'x')) as ReactionDiagnosticsRef,
        metering: METERING,
      }
      expect(await service.inspectOneExecution()).toBe('retried')
      expect((await reactionRows(harness.db)).dispatch).toMatchObject({
        retryFeedbackRef: null,
        lastDispatchError: 'retry-feedback-unavailable: disk full',
      })
      clock += 100
      await service.dispatchOneReaction()
      expect(port.launches.at(-1)!.prepared.request.attempt.retryFeedback).toEqual({
        kind: 'none',
      })
    })

    test('T14：stopped ⇒ 结算但不消耗重试预算，案例挂起等人处理', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      const service = reactionService(harness.db, { port, now, mint })
      await service.dispatchOneReaction()
      port.snapshot = {
        kind: 'stopped',
        receipt: 'stopped:execution-1' as never,
        metering: METERING,
      }
      expect(await service.inspectOneExecution()).toBe('failed')
      const rows = await reactionRows(harness.db)
      // 不进重试判定：ordinal 不前进、派发行不重置、没有第二次 launch。
      expect(rows.round).toMatchObject({ state: 'failed', attemptOrdinal: 0 })
      expect(JSON.parse(rows.round.outputJson!)).toEqual({
        kind: 'stopped',
        executionRef: 'execution-1',
      })
      expect(rows.employeeCase).toMatchObject({
        state: 'blocked',
        blockReason: 'execution-canceled',
      })
      expect(rows.dispatch.retryFeedbackRef).toBeNull()
      expect(port.launches).toHaveLength(1)
      expect(rows.admissions.map((row) => row.state)).toEqual(['closed'])
    })

    test('T14：用户终止案例 ⇒ 停掉在跑的 agent；随后 stopped 结算时案例保持终止与原 terminalKind', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      const service = reactionService(harness.db, { port, now, mint })
      await service.dispatchOneReaction()

      expect((await service.terminate('case-rfc368', 'user-terminated')).state).toBe('terminal')
      expect(port.canceled).toEqual([`reaction:${REACTION_ROUND}:0|execution-1`])

      port.snapshot = {
        kind: 'stopped',
        receipt: 'stopped:execution-1' as never,
        metering: METERING,
      }
      await service.inspectOneExecution()
      const rows = await reactionRows(harness.db)
      expect(rows.round.state).toBe('failed')
      expect(rows.employeeCase).toMatchObject({
        state: 'terminal',
        terminalKind: 'user-terminated',
        activeRoundId: null,
      })
    })

    test('T14：停不掉 agent 也不把终止本身报成失败', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      port.cancelBehavior = async () => {
        throw new Error('execution already gone')
      }
      const service = reactionService(harness.db, { port, now, mint })
      await service.dispatchOneReaction()
      expect((await service.terminate('case-rfc368', 'user-terminated')).state).toBe('terminal')
      expect(port.canceled).toHaveLength(1)
    })
  })

  describeEachProvider('数字员工的产物存档', (harness) => {
    test('同一段正文只存一行；ref 自解释、按 digest 读回', async () => {
      const store = createReactionArtifactPersistence(harness.db)
      const text = sanitizeReactionText({ errorCode: 'e', errorDetail: 'd', workspaceRoot: null })
      const first = await store.put('retry-feedback', text, 1)
      const second = await store.put('retry-feedback', text, 2)
      // 同一正文先以另一种 kind 存过：主键冲突不新增行，但按 ref 仍能读回。
      const crossKind = await store.put('diagnostics', text, 3)
      expect(first).toBe(`retry-feedback:${text.digest}`)
      expect(second).toBe(first)
      expect(await harness.db.select().from(employeeReactionArtifacts).all()).toHaveLength(1)
      expect(await store.read(first)).toBe('e: d')
      expect(await store.read(crossKind)).toBe('e: d')
      expect(await store.read('not-a-ref')).toBeNull()
      expect(await store.read(`diagnostics:${'0'.repeat(64)}`)).toBeNull()
    })

    test('诊断 sink 在数字员工侧裁剪：工作区路径改相对、栈帧整行丢弃', async () => {
      const ports = composeReactionArtifactPorts(
        createReactionArtifactPersistence(harness.db),
        () => 1,
      )
      const ref = await ports.diagnosticsSink.put({
        errorCode: 'boom',
        errorDetail: 'failed at /wt/task/src/a.ts\n    at run (/wt/task/src/a.ts:1:2)',
        workspaceRoot: '/wt/task',
      })
      expect(await ports.diagnostics.read(ref)).toBe('boom: failed at src/a.ts')
    })
  })
})

describe('RFC-368 T12 —— 人审三来源映射（源码层兜底；投影需要完整 type descriptor，集成覆盖在刀 3）', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../src/modules/digital-employee/application/runtimeService.ts'),
    'utf8',
  )

  test('`unknown` 回落到 round 状态（⇒ null），`not-applicable` 投影成 skipped', () => {
    expect(source).toContain("return snapshot.kind === 'unknown' ? null : snapshot.kind")
    expect(source).toMatch(
      /if \(taskState === 'not-applicable'\) \{\s*return \[\s*\{[^}]*state: 'skipped' as const/,
    )
  })
})
