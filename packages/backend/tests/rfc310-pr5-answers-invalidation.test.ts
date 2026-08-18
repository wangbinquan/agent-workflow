// RFC-310 PR-5 T55 —— 新 answer revision 使 in-flight action 失效。
//
// 锁：①平台渠道 submitMissionAnswers 提交成功 ⇒ 运行中 attempt 被 cancel
// （launcher.cancel 尽力）+ settle 'discarded'（input-invalidated）+ run
// failed + currentActionRunId 清；②失效**不计 fresh 预算**——后续轮规则开的
// 是全新 ActionRun（rerunSeq 从 0 起）；③无 in-flight 动作时 no-op；④原渠道
// （collect-requirement-answers 收齐）同一收束路径。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'

import { invalidateInFlightAction } from '../src/modules/development-automation/application/actionInvalidation'
import { submitMissionAnswers } from '../src/modules/development-automation/application/commands/submitMissionAnswers'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type {
  AgentActionLauncherPort,
  RepositoryFactsCollectorPort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

setDefaultTimeout(120_000)

const repoCollector: RepositoryFactsCollectorPort = {
  async collect() {
    return { cells: structuredClone(PR3_JAVA_CELLS) as never, factsRef: 'probe-1' }
  },
}

function cancelTrackingLauncher(): { port: AgentActionLauncherPort; canceled: string[] } {
  const canceled: string[] = []
  let seq = 0
  return {
    canceled,
    port: {
      async launch() {
        seq += 1
        return { ok: true, executionRef: `exec-${seq}` }
      },
      async fetchOutcome(executionRef) {
        return { kind: 'pending', executionRef, taskStatus: 'running' }
      },
      async cancel(executionRef) {
        canceled.push(executionRef)
        return { settled: 'canceled' }
      },
    },
  }
}

async function launchWithInFlightAction(
  fx: Awaited<ReturnType<typeof buildPr3Fixture>>,
  deps: ReturnType<Awaited<ReturnType<typeof buildPr3Fixture>>['deps']>,
  key: string,
): Promise<{ missionId: string; actionRunId: string }> {
  const missionId = await fx.launchDirect(key)
  await fx.materializer.stashDirectSubmission({
    missionId,
    submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
  })
  await runMissionReconcile(deps, missionId) // materialize
  await runMissionReconcile(deps, missionId) // collect facts
  const launched = await runMissionReconcile(deps, missionId)
  expect(launched.kind === 'decided' && launched.handled).toBe('action-launched')
  const mission = fx.store.getMission(missionId)!
  return { missionId, actionRunId: mission.currentActionRunId! }
}

describe('rfc310 pr5 T55 — answers invalidate in-flight actions', () => {
  test('platform-channel submit cancels + discards the running attempt and frees the mission', async () => {
    const fx = await buildPr3Fixture()
    const tracking = cancelTrackingLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: tracking.port } }),
    })
    const { missionId, actionRunId } = await launchWithInFlightAction(fx, deps, 't55-submit-1')

    // 正常流下「answers 提交」与「in-flight action」被 guards + admissibility
    // 双重隔离；T55 防的是 HTTP submit 与 sweep reconcile 的 OCC 竞态窗
    // （submit 读到 awaiting 后、sweep 并发把 mission 推回 working 并发射动作）。
    // 直接构造交错后置态：问题集 pending + mission awaiting + 动作在跑。
    const stashed = await fx.materializer.stashQuestionSet({
      missionId,
      origin: 'platform',
      channel: 'platform',
      questions: [{ questionId: 'q1', text: 'which db?', answerKind: 'text', choices: null }],
    })
    expect(stashed.ok).toBe(true)
    if (!stashed.ok) return
    {
      const mission = fx.store.getMission(missionId)!
      const moved = fx.store.occUpdate(mission.id, mission.revision, mission.epoch, {
        status: 'awaiting-information',
      })
      expect(moved.ok).toBe(true)
    }
    expect(fx.store.getMission(missionId)!.currentActionRunId).toBe(actionRunId)

    const result = await submitMissionAnswers(
      {
        store: fx.store,
        snapshots: fx.snapshots,
        requirement: fx.materializer,
        ports: deps.ports,
        now: () => Date.now(),
      },
      {
        missionId,
        questionSetRef: stashed.questionSetRef,
        answers: [{ questionId: 'q1', answer: 'postgres' }],
      },
    )
    expect(result.status).toBe('working')

    // in-flight attempt：cancel 被调、attempt discarded、run failed、指针清。
    expect(tracking.canceled).toEqual(['exec-1'])
    const attempts = fx.store.listAttempts(actionRunId)
    expect(attempts[attempts.length - 1]).toMatchObject({ status: 'discarded' })
    expect(JSON.parse(attempts[attempts.length - 1]!.rejectionJson!)).toMatchObject({
      code: 'input-invalidated',
    })
    expect(fx.store.getActionRun(actionRunId)!.status).toBe('failed')
    expect(fx.store.getMission(missionId)!.currentActionRunId).toBeNull()

    // 不计 fresh 预算：下一轮开全新 ActionRun（rerunSeq 重新 0/0）。
    const relaunched = await runMissionReconcile(deps, missionId)
    expect(relaunched.kind === 'decided' && relaunched.handled).toBe('action-launched')
    const fresh = fx.store.getMission(missionId)!
    expect(fresh.currentActionRunId).not.toBe(actionRunId)
    const newAttempts = fx.store.listAttempts(fresh.currentActionRunId!)
    expect(newAttempts[0]).toMatchObject({ rerunSeq: 0, attemptSeq: 0 })
  })

  test('no in-flight action → helper is a no-op', async () => {
    const fx = await buildPr3Fixture()
    const missionId = await fx.launchDirect('t55-noop-1')
    const mission = fx.store.getMission(missionId)!
    const out = await invalidateInFlightAction(
      { store: fx.store, now: () => Date.now() },
      mission,
      'input-invalidated',
    )
    expect(out).toBe(false)
  })

  test('cancel failure does not block local settlement (ledger is authoritative)', async () => {
    const fx = await buildPr3Fixture()
    const throwing: AgentActionLauncherPort = {
      async launch() {
        return { ok: true, executionRef: 'exec-1' }
      },
      async fetchOutcome(executionRef) {
        return { kind: 'pending', executionRef, taskStatus: 'running' }
      },
      async cancel() {
        throw new Error('runner unreachable')
      },
    }
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: throwing } }),
    })
    const { missionId, actionRunId } = await launchWithInFlightAction(fx, deps, 't55-cancelfail-1')
    const mission = fx.store.getMission(missionId)!
    const out = await invalidateInFlightAction(
      { store: fx.store, ports: deps.ports, now: () => Date.now() },
      mission,
      'input-invalidated',
    )
    expect(out).toBe(true)
    expect(fx.store.getActionRun(actionRunId)!.status).toBe('failed')
    expect(fx.store.getMission(missionId)!.currentActionRunId).toBeNull()
  })
})
