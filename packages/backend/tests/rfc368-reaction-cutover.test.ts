// RFC-368 刀 3 —— 切换期的两类存量数据（用户 2026-09-23 裁决）。
//
//   T5b：切换前留下的在途 `execution-launch` outbox 行（pending / claimed）由**启动后第一次派发**
//        一次性收编（与 RFC-354 的 frame backfill 同一种做法：代码回填、两个引擎共用一份——
//        PG 的迁移序列表达不了数据迁移）。到期时刻 / 尝试次数 / 上次错误原样平移，
//        `previousError` 裁剪后存成重试反馈（C2-4：不能丢，否则那次重试的纠错信息消失），
//        payload 里预算收敛过的 plan 写回 round，outbox 行删除。旧 outbox 臂不得先把它们领走。
//   在跑的旧 round：由旧路径启动、从没 admission 过、也没有派发行。inspect 照常（TE 放宽核对，
//        见 rfc368-reaction-execution-adapter），失败重试时补建派发行。

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { describeEachProvider } from './helpers/eachProvider'
import {
  REACTION_CASE,
  REACTION_ROUND,
  reactionPlanJson,
  reactionRows,
  reactionService,
  scriptedPort,
  seedReaction,
} from './helpers/rfc368ReactionFixture'
import { employeeOsOutbox } from '@/db/schema'
import type { ReactionDiagnosticsRef } from '@/modules/digital-employee/composition/required-ports'
import { sanitizeReactionText } from '@/modules/digital-employee/domain/reactionArtifacts'
import { createReactionArtifactPersistence } from '@/modules/digital-employee/infrastructure/reactionArtifactStore'

describe('RFC-368 刀 3 —— 切换期存量', () => {
  describeEachProvider('T5b 收编 + 旧路径在跑的 round', (harness) => {
    let clock = 10_000
    let minted = 0
    const now = () => clock
    const mint = () => `execution-${++minted}`

    async function legacyLaunchRow(input: {
      readonly id: string
      readonly roundId: string
      readonly state: 'pending' | 'claimed'
      readonly previousError: string | null
    }): Promise<void> {
      await harness.db
        .insert(employeeOsOutbox)
        .values({
          id: input.id,
          caseId: REACTION_CASE,
          kind: 'execution-launch',
          payloadJson: JSON.stringify({
            roundId: input.roundId,
            plan: JSON.parse(reactionPlanJson({ maxTotalTokens: 500 })) as unknown,
            attempt: { ordinal: 1, mode: 'same-scene', previousError: input.previousError },
          }),
          dedupeKey: `execution-launch:${input.roundId}:1`,
          state: input.state,
          attemptCount: 1,
          nextAttemptAt: 0,
          lastError: 'previous dispatch error',
          createdAt: 1,
          updatedAt: 1,
        })
        .run()
    }

    test('T5b：在途行搬成派发行、反馈与预算不丢，旧 outbox 臂不碰它', async () => {
      clock = 10_000
      minted = 0
      await seedReaction(harness.db, { withDispatch: false, attemptOrdinal: 1 })
      await legacyLaunchRow({
        id: 'legacy-launch',
        roundId: REACTION_ROUND,
        state: 'claimed',
        previousError: 'execution-output-missing: no result port',
      })
      const port = scriptedPort()
      const service = reactionService(harness.db, { port, now, mint })

      // worker 循环里 outbox 排在派发之前：旧臂必须跳过这类行，否则它会报「未实现」直到终结。
      expect(await service.runOneOutbox()).toBe('idle')

      expect(await service.dispatchOneReaction()).toBe('launched')
      const feedback = sanitizeReactionText({
        errorCode: 'execution-output-missing',
        errorDetail: 'no result port',
        workspaceRoot: null,
      })
      const launch = port.launches.at(-1)!
      expect(launch.operation).toBe(`reaction:${REACTION_ROUND}:1`)
      expect(launch.prepared.request.attempt as unknown).toEqual({
        ordinal: 1,
        mode: 'same-scene',
        retryFeedback: { kind: 'artifact', ref: `retry-feedback:${feedback.digest}` },
      })
      expect((launch.prepared.request.plan as { maxTotalTokens: number }).maxTotalTokens).toBe(500)
      expect(
        await createReactionArtifactPersistence(harness.db).read(
          `retry-feedback:${feedback.digest}`,
        ),
      ).toBe('execution-output-missing: no result port')
      const rows = await reactionRows(harness.db)
      expect(JSON.parse(rows.round.planJson).maxTotalTokens).toBe(500)
      // 领取时尝试次数在平移来的 1 之上 +1。
      expect(rows.dispatch).toMatchObject({ dispatchAttempts: 2 })
      expect(
        await harness.db
          .select()
          .from(employeeOsOutbox)
          .where(eq(employeeOsOutbox.id, 'legacy-launch'))
          .all(),
      ).toEqual([])
    })

    test('T5b：round 已不在 planned 的遗留行直接删掉，不建派发行', async () => {
      clock = 10_000
      minted = 0
      await seedReaction(harness.db, {
        withDispatch: false,
        roundState: 'running',
        executionRef: 'legacy-task',
      })
      await legacyLaunchRow({
        id: 'stale-launch',
        roundId: REACTION_ROUND,
        state: 'pending',
        previousError: null,
      })
      const port = scriptedPort()
      expect(await reactionService(harness.db, { port, now, mint }).dispatchOneReaction()).toBe(
        'idle',
      )
      expect(port.launches).toEqual([])
      expect(await harness.db.select().from(employeeOsOutbox).all()).toEqual([])
    })

    test('旧路径启动的在跑 round：照常 inspect，失败重试时补建派发行', async () => {
      clock = 10_000
      minted = 0
      await seedReaction(harness.db, {
        withDispatch: false,
        roundState: 'running',
        executionRef: 'legacy-task',
      })
      const port = scriptedPort()
      const service = reactionService(harness.db, { port, now, mint })
      port.snapshot = {
        kind: 'failed',
        errorClass: 'semantic',
        errorCode: 'boom',
        diagnostics: (await createReactionArtifactPersistence(harness.db).put(
          'diagnostics',
          sanitizeReactionText({ errorCode: 'boom', errorDetail: 'x', workspaceRoot: null }),
          clock,
        )) as ReactionDiagnosticsRef,
        metering: { sourceRef: 'task:legacy-task', durationMs: 1, totalTokens: 1 },
      }
      expect(await service.inspectOneExecution()).toBe('retried')
      const rows = await reactionRows(harness.db)
      expect(rows.round).toMatchObject({ state: 'planned', attemptOrdinal: 1, executionRef: null })
      expect(rows.dispatch).toMatchObject({ claimEpoch: 0, dispatchAttempts: 0 })
      clock += 100
      expect(await service.dispatchOneReaction()).toBe('launched')
      expect(port.launches.at(-1)!.operation).toBe(`reaction:${REACTION_ROUND}:1`)
    })
  })
})
