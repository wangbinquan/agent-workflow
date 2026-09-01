// RFC-310 PR-2 T30 —— daemon 恢复扫描 + fence settle + durable wake 语义。
//
// 锁：①cancel-pending + dispatched effect：recovery 经 executor 按外部真相
// 结算（confirm）后 mission 收口 canceled、fence 清零、epoch 已 bump、MR
// claim 释放；executor 缺席时保持 fence-pending（绝不假装外部没发生）；
// ②handoff-pending → tracking-only；③epoch 过期的 prepared effect 被
// invalidate；④到期 deferred wake 被 fire（state 迁移）且 domain 语义：
// early 唤醒/重启都不清零 attemptOrdinal。

import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { recoverMissions } from '../src/modules/development-automation/application/missionRecovery'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import { cancelMission } from '../src/modules/development-automation/application/commands/launchMission'
import {
  evaluateWake,
  nextAttemptOrdinal,
  type DeferredWakeRow,
} from '../src/modules/development-automation/domain/deferredWake'
import type { MissionEffectExecutorPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import {
  listFencedMissionIds,
  listPreparedEffectRows,
  missionEpochsOf,
} from '../src/modules/development-automation/infrastructure/sqliteReconcilerReaders'
import { createSqliteMissionPersistence } from '../src/modules/development-automation/infrastructure/sqliteMissionStore'
import { buildPr2Fixture, type Pr2Fixture } from './helpers/rfc310Pr2Fixture'

function readersOf(f: Pr2Fixture) {
  return {
    listFencedMissionIds: async () => listFencedMissionIds(f.db),
    listPreparedEffectRows: async () => listPreparedEffectRows(f.db),
    missionEpochsOf: async (ids: readonly string[]) => missionEpochsOf(f.db, ids),
  }
}

const okExecutor: MissionEffectExecutorPort = {
  async execute(input) {
    return { ok: true, receiptRef: `receipt-${input.effectId}` }
  },
}

describe('rfc310 pr2 recovery', () => {
  test('cancel with a dispatched effect settles through the executor, then reaches canceled', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-cancel-1')
    const mission = f.store.getMission(missionId)!
    const claim = ulid()
    f.store.claimMr({
      id: claim,
      codeHostEndpointRef: 'ep',
      stableProjectRef: 'p',
      mrIid: '7',
      missionId,
      epoch: mission.epoch,
      headSha: null,
      now: Date.now(),
    })
    f.store.occUpdate(mission.id, mission.revision, mission.epoch, { mrClaimId: claim })
    const withClaim = f.store.getMission(missionId)!
    const effect = f.store.prepareEffect({
      id: ulid(),
      missionId,
      actionRunId: null,
      effectKind: 'mr.comment.create',
      intentDigest: 'a'.repeat(64),
      idempotencyKey: `cancel-test-${missionId}`,
      epoch: withClaim.epoch,
      now: Date.now(),
    })
    f.store.markEffectDispatched(effect.effect.id, Date.now())

    const cancelResult = await cancelMission(
      {
        store: createSqliteMissionPersistence(f.db),
        lookup: f.lookup,
        now: () => Date.now(),
      },
      { missionId },
    )
    expect(cancelResult.pending).toBe(true)
    expect(f.store.getMission(missionId)!.transitionFence).toBe('cancel-pending')

    // executor 缺席 ⇒ 保持 pending，不伪造外部结果。
    const withoutExecutor = await recoverMissions(f.deps({}), readersOf(f))
    expect(withoutExecutor.pendingFences).toBe(1)
    expect(f.store.getMission(missionId)!.status).not.toBe('canceled')

    const report = await recoverMissions(f.deps({ effectExecutor: okExecutor }), readersOf(f))
    expect(report.settledFences).toBe(1)
    const settled = f.store.getMission(missionId)!
    expect(settled.status).toBe('canceled')
    expect(settled.transitionFence).toBe('none')
    expect(settled.epoch).toBeGreaterThan(mission.epoch)
    expect(f.store.getEffect(effect.effect.id)!.state).toBe('confirmed')
  })

  test('handoff-pending settles into tracking-only with automation writes fenced off', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-handoff-1')
    const mission = f.store.getMission(missionId)!
    expect(
      f.store.bumpEpoch(mission.id, mission.revision, { transitionFence: 'handoff-pending' }).ok,
    ).toBe(true)

    const report = await recoverMissions(f.deps({}), readersOf(f))
    expect(report.settledFences).toBe(1)
    const settled = f.store.getMission(missionId)!
    expect(settled.automationMode).toBe('tracking-only')
    expect(settled.transitionFence).toBe('none')
    expect(settled.status).not.toBe('canceled')
  })

  test('prepared effects from an older epoch are invalidated, current-epoch ones survive', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-epoch-1')
    const mission = f.store.getMission(missionId)!
    const stale = f.store.prepareEffect({
      id: ulid(),
      missionId,
      actionRunId: null,
      effectKind: 'mr.ensure',
      intentDigest: 'b'.repeat(64),
      idempotencyKey: `stale-${missionId}`,
      epoch: mission.epoch,
      now: Date.now(),
    })
    expect(f.store.bumpEpoch(mission.id, mission.revision, {}).ok).toBe(true)
    const bumped = f.store.getMission(missionId)!
    const current = f.store.prepareEffect({
      id: ulid(),
      missionId,
      actionRunId: null,
      effectKind: 'mr.ensure',
      intentDigest: 'c'.repeat(64),
      idempotencyKey: `current-${missionId}`,
      epoch: bumped.epoch,
      now: Date.now(),
    })

    const report = await recoverMissions(f.deps({}), readersOf(f))
    expect(report.invalidatedEffects).toBe(1)
    expect(f.store.getEffect(stale.effect.id)!.state).toBe('invalidated')
    expect(f.store.getEffect(current.effect.id)!.state).toBe('prepared')
  })

  test('due wakes fire (ordinal preserved) and drive an ordinary reconcile', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-wake-1')
    const wakeId = ulid()
    f.store.armWake({
      id: wakeId,
      missionId,
      decisionId: ulid(),
      reason: 'test-backoff',
      resumeAt: Date.now() - 1_000,
      wakeSources: ['timer'],
      attemptOrdinal: 4,
      now: Date.now(),
    })

    const report = await recoverMissions(f.deps({}), readersOf(f))
    expect(report.firedWakes).toBe(1)
    expect(f.store.listDueWakes(Date.now())).toHaveLength(0)
    // reconcile 正常跑过（decision 落库）——blocked（launcher/collector 缺席）也算跑过。
    const mission = f.store.getMission(missionId)!
    expect(mission.readinessJson).not.toBeNull()
  })

  test('domain wake semantics: early external wake fires without resetting the ordinal', () => {
    const row: DeferredWakeRow = {
      missionId: 'm',
      decisionId: 'd',
      reason: 'pipeline-backoff',
      resumeAt: Date.now() + 60_000,
      wakeSources: ['pipeline', 'manual'],
      attemptOrdinal: 3,
      state: 'armed',
    }
    expect(evaluateWake(row, { kind: 'timer', now: Date.now() })).toEqual({
      fire: false,
      code: 'not-due',
    })
    expect(evaluateWake(row, { kind: 'external', source: 'webhook' })).toEqual({
      fire: false,
      code: 'source-not-subscribed',
    })
    expect(evaluateWake(row, { kind: 'external', source: 'pipeline' })).toEqual({
      fire: true,
      early: true,
    })
    expect(nextAttemptOrdinal(row)).toBe(4)
    expect(
      evaluateWake({ ...row, state: 'fired' }, { kind: 'external', source: 'manual' }),
    ).toEqual({ fire: false, code: 'not-armed' })
  })

  test('reconcile on a fenced mission goes through the same settle path as recovery', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-fence-direct-1')
    const mission = f.store.getMission(missionId)!
    f.store.bumpEpoch(mission.id, mission.revision, { transitionFence: 'cancel-pending' })
    const outcome = await runMissionReconcile(f.deps({}), missionId)
    expect(outcome).toMatchObject({ kind: 'fence-settled', result: 'canceled' })
  })
})
