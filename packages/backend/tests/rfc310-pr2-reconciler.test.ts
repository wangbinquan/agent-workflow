// RFC-310 PR-2 T26 —— MissionReconciler 单轮循环（真实 store + typed fake 端口）。
//
// 锁：①indeterminate 停机的端到端形状——admission 占位 facts（unknown）下第
// 一轮 decision 是 collect-repository-facts，collector 注入 java cells 后第二
// 轮才命中 change.implement；②run-agent-action 的 decision 补全（templateRef
// 来自员工 route，是 decision 的一部分）+ ActionRun（writable）+ attempt 台账
// 起点；③launcher 未接线 → typed blocked + ActionRun failed（缺席的接线必须
// 红——dev-gotchas「写了两行库 ≠ 在跑」）；④guard wait → durable wake 落行，
// 同 facts 重复 reconcile 走 decision input 去重（deduped）且不重复 arm；
// ⑤MR 外部终态 guard 优先：mark-terminal → merged absorbing + claim 释放；
// ⑥每轮 readinessJson 落盘且 unknown required-gate 不折算 pass。

import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type {
  AgentActionLauncherPort,
  RepositoryFactsCollectorPort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import {
  developmentActionRuns,
  developmentAgentAttempts,
  developmentDecisions,
} from '../src/db/schema'
import { buildPr2Fixture, JAVA_CELLS } from './helpers/rfc310Pr2Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

const repoCollector: RepositoryFactsCollectorPort = {
  async collect() {
    return { cells: structuredClone(JAVA_CELLS) as never, factsRef: 'probe-1' }
  },
}

const okLauncher: AgentActionLauncherPort = {
  async launch() {
    return { ok: true, executionRef: 'exec-001' }
  },
  async fetchOutcome(executionRef: string) {
    return { kind: 'pending' as const, executionRef, taskStatus: 'running' }
  },
  async cancel() {
    return { settled: 'already-terminal' as const }
  },
}

describe('rfc310 pr2 reconciler', () => {
  test('collect-then-implement journey: indeterminate → collect → route-completed action', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-journey-1')
    const deps = f.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: f.db, overrides: { agentLauncher: okLauncher } }),
    })

    const first = await runMissionReconcile(deps, missionId)
    expect(first).toMatchObject({
      kind: 'decided',
      selected: { kind: 'collect-repository-facts' },
      handled: 'collected',
    })
    const afterCollect = f.store.getMission(missionId)!
    expect(afterCollect.repositoryFactsRef).not.toBeNull()

    const second = await runMissionReconcile(deps, missionId)
    expect(second).toMatchObject({
      kind: 'decided',
      selected: {
        kind: 'run-agent-action',
        capabilityId: 'change.implement',
        templateRef: `${f.templateId}@1`,
      },
      handled: 'action-launched',
    })
    const runs = f.db.select().from(developmentActionRuns).all()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.writable).toBe(1)
    expect(runs[0]!.templateId).toBe(f.templateId)
    const attempts = f.db.select().from(developmentAgentAttempts).all()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.executionRef).toBe('exec-001')
    expect(attempts[0]!.rerunSeq).toBe(0)
    const mission = f.store.getMission(missionId)!
    expect(mission.currentActionRunId).toBe(runs[0]!.id)
    expect(mission.readinessJson).not.toBeNull()

    // decision 的 selectedJson 持久化的是补全后 templateRef（canonical trace 合同）。
    const decisions = f.db.select().from(developmentDecisions).all()
    const actionDecision = decisions.find((d) => d.selectedJson.includes('run-agent-action'))!
    expect(actionDecision.selectedJson).toContain(`${f.templateId}@1`)
    expect(actionDecision.selectedJson).not.toContain('pending-route')
  })

  test('missing launcher is a typed block, never a silent skip', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-nolaunch-1')
    // PR-11 起 launcher 的接线判定按模板 executor 分流（agent / script），不再是
    // 「所有端口之前」的总闸。要证明缺 launcher 仍是 typed block，就必须把其余端口
    // 全接好、只摘掉 agent launcher；否则先撞上 action-baseline-not-wired，这条测
    // 试测的就不是它名字说的那件事了。
    const { agentLauncher: _omittedLauncher, ...portsWithoutLauncher } = fakeAgentActionPorts({
      db: f.db,
    })
    const deps = f.deps({ repositoryFacts: repoCollector, ...portsWithoutLauncher })

    await runMissionReconcile(deps, missionId)
    const second = await runMissionReconcile(deps, missionId)
    expect(second).toMatchObject({ kind: 'decided', handled: 'action-launch-failed' })
    const mission = f.store.getMission(missionId)!
    expect(mission.status).toBe('blocked')
    expect(mission.blockCode).toBe('agent-launcher-not-wired')
    const run = f.db.select().from(developmentActionRuns).all()[0]!
    expect(run.status).toBe('failed')
    expect(run.failureJson).toContain('agent-launcher-not-wired')
  })

  test('unsettled effect stops at the guard, arms a durable wake, and dedupes on replay', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-wait-1')
    const mission = f.store.getMission(missionId)!
    const effect = f.store.prepareEffect({
      id: ulid(),
      missionId,
      actionRunId: null,
      effectKind: 'mr.ensure',
      intentDigest: 'd'.repeat(64),
      idempotencyKey: `wait-test-${missionId}`,
      epoch: mission.epoch,
      now: Date.now(),
    })
    f.store.markEffectDispatched(effect.effect.id, Date.now())

    const deps = f.deps({})
    const first = await runMissionReconcile(deps, missionId)
    expect(first).toMatchObject({
      kind: 'decided',
      selected: { kind: 'wait', reason: 'effect-unsettled' },
      handled: 'wake-armed',
    })
    const decisionId = (first as { decisionId: string }).decisionId
    expect(f.store.getWake(missionId, decisionId)).not.toBeNull()

    const replay = await runMissionReconcile(deps, missionId)
    expect(replay).toMatchObject({ kind: 'deduped', decisionId })
  })

  test('external MR terminal wins over everything; claim released; terminal absorbs', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-terminal-1')
    const mission = f.store.getMission(missionId)!
    const claim = ulid()
    expect(
      f.store.claimMr({
        id: claim,
        codeHostEndpointRef: 'ep-1',
        stableProjectRef: 'proj-1',
        mrIid: '42',
        missionId,
        epoch: mission.epoch,
        headSha: 'a'.repeat(40),
        now: Date.now(),
      }),
    ).toEqual({ ok: true })
    // 把 mission 推到 watching 并注入含 mr.terminalState=merged 的采集快照。
    const snapshotId = ulid()
    f.store.insertFactSnapshot({
      id: snapshotId,
      missionId,
      missionRevision: mission.revision,
      capturedAt: '2026-08-18T12:00:00+00:00',
      cellsJson: JSON.stringify({
        ...JAVA_CELLS,
        'mr.terminalState': { state: 'known', value: 'merged', sourceRevision: 'mr-snap-1' },
      }),
      refsJson: '{}',
      digest: 'e'.repeat(64),
      now: Date.now(),
    })
    const fresh = f.store.getMission(missionId)!
    expect(
      f.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
        status: 'publishing',
        mrClaimId: claim,
        repositoryFactsRef: snapshotId,
      }).ok,
    ).toBe(true)
    const toWatching = f.store.getMission(missionId)!
    expect(
      f.store.occUpdate(toWatching.id, toWatching.revision, toWatching.epoch, {
        status: 'watching',
      }).ok,
    ).toBe(true)

    const deps = f.deps({})
    const outcome = await runMissionReconcile(deps, missionId)
    expect(outcome).toMatchObject({
      kind: 'decided',
      selected: { kind: 'mark-terminal', terminal: 'merged' },
      handled: 'terminal',
    })
    const terminal = f.store.getMission(missionId)!
    expect(terminal.status).toBe('merged')
    expect(terminal.terminalKind).toBe('merged')

    const noop = await runMissionReconcile(deps, missionId)
    expect(noop).toEqual({ kind: 'terminal-noop' })
  })

  test('readinessJson never counts an unknown required gate as pass', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('idem-readiness-1')
    const mission = f.store.getMission(missionId)!
    const snapshotId = ulid()
    f.store.insertFactSnapshot({
      id: snapshotId,
      missionId,
      missionRevision: mission.revision,
      capturedAt: '2026-08-18T12:00:00+00:00',
      cellsJson: JSON.stringify({
        ...JAVA_CELLS,
        'pipeline.requiredGatesAllPass': {
          state: 'unknown',
          reason: 'provider outage',
          collectable: true,
        },
        'mr.mergeable': { state: 'known', value: 'yes', sourceRevision: 'mr-1' },
      }),
      refsJson: '{}',
      digest: 'f'.repeat(64),
      now: Date.now(),
    })
    const fresh = f.store.getMission(missionId)!
    f.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, { repositoryFactsRef: snapshotId })

    // launcher 缺席会把 mission block——这里只关心 readiness 投影本身。
    await runMissionReconcile(f.deps({}), missionId)
    const after = f.store.getMission(missionId)!
    expect(after.readinessJson).not.toBeNull()
    const readiness = JSON.parse(after.readinessJson!) as {
      automationReady: boolean
      status: string
      machineHolds: { kind: string; detail: string }[]
    }
    expect(readiness.automationReady).toBe(false)
    expect(readiness.status).not.toBe('ready-to-merge')
    expect(
      readiness.machineHolds.some(
        (h) => h.kind === 'required-gate-not-pass' && h.detail.includes('unknown'),
      ),
    ).toBe(true)
  })
})
