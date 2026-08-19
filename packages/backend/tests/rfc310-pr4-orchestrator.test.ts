// RFC-310 PR-4 —— attempt 编排全路径（launch 半 + collect 半，fake 端口）。
//
// 锁：①launch 台账合同（nonce 只落 digest、baselineRef ab1: codec、pre-state
// blob、executionRef 回填）；②collect 的 §7.5 流水线接线与 §7.7 分类
// （protocol → fresh rerun → 耗尽 blocked(agent-contract-exhausted)；boundary
// → discarded + fresh；pending → guards 的 active-action wait）；③validated
// 结算（candidate cell + run settled + currentActionRunId 清 + 诚实
// action-stage-complete block——下一阶段属 PR-5/PR-6，不静默重复启动作）；
// ④needs-information → agent 问题集入台账 → 澄清闭环接管。
// 真实文件系统/子进程面归 rfc310-pr4-journey 与 fork J/K 专项。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import { launchAgentAttempt } from '../src/modules/development-automation/application/agentActionOrchestrator'
import { decodeAgentAttemptBaselineRef } from '../src/modules/development-automation/domain/agentAttempt'
import type {
  AgentActionLauncherPort,
  AgentExecutionSnapshot,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import type { RepositoryFactsCollectorPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { buildPr3Fixture, PR3_JAVA_CELLS, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'
import { createSqliteActionTemplateStore } from '../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'

setDefaultTimeout(120_000)

const repoCollector: RepositoryFactsCollectorPort = {
  async collect() {
    return { cells: structuredClone(PR3_JAVA_CELLS) as never, factsRef: 'probe-1' }
  },
}

/** 可编程 launcher：记录 prompt、按脚本回放 fetchOutcome。 */
function scriptedLauncher(): {
  port: AgentActionLauncherPort
  prompts: string[]
  outcomes: Map<string, AgentExecutionSnapshot>
  launched: string[]
  platformInputPaths: string[][]
  workspacePaths: string[]
} {
  const prompts: string[] = []
  const launched: string[] = []
  const outcomes = new Map<string, AgentExecutionSnapshot>()
  const platformInputPaths: string[][] = []
  const workspacePaths: string[] = []
  let seq = 0
  return {
    prompts,
    launched,
    outcomes,
    platformInputPaths,
    workspacePaths,
    port: {
      async launch(input) {
        seq += 1
        const executionRef = `exec-${seq}`
        prompts.push(input.prompt)
        platformInputPaths.push([...input.platformInputPaths])
        workspacePaths.push(input.workspacePath)
        launched.push(executionRef)
        return { ok: true, executionRef }
      },
      async fetchOutcome(executionRef) {
        return (
          outcomes.get(executionRef) ?? {
            kind: 'pending',
            executionRef,
            taskStatus: 'running',
          }
        )
      },
      async cancel() {
        return { settled: 'already-terminal' }
      },
    },
  }
}

function extractNonce(prompt: string): string {
  const m = /<agent-result nonce="([^"]+)">/.exec(prompt)
  if (m === null) throw new Error('protocol block missing from prompt')
  return m[1]!
}

function extractIdentity(prompt: string): { actionRunRef: string; inputDigest: string } {
  const run = /"actionRunRef": "([^"]+)"/.exec(prompt)
  const digest = /"inputDigest": "([^"]+)"/.exec(prompt)
  if (run === null || digest === null) throw new Error('identity lines missing from prompt')
  return { actionRunRef: run[1]!, inputDigest: digest[1]! }
}

function doneWithFrame(executionRef: string, frameText: string): AgentExecutionSnapshot {
  return {
    kind: 'exited',
    executionRef,
    taskStatus: 'done',
    resultText: frameText,
    errorSummary: null,
    errorMessage: null,
  }
}

function changedEnvelope(
  prompt: string,
  itemRefs: readonly string[],
  capabilityId = 'change.implement',
): string {
  const nonce = extractNonce(prompt)
  const id = extractIdentity(prompt)
  const json = JSON.stringify({
    protocolVersion: 1,
    nonce,
    port: 'agent-result',
    actionRunRef: id.actionRunRef,
    inputDigest: id.inputDigest,
    capabilityId,
    outcome: 'changed',
    result: {
      capabilityId,
      summary: 'implemented',
      // coverage 与 requirement index 双射（semantic validator 闭集合同）。
      requirementCoverage: itemRefs.map((itemRef) => ({
        itemRef,
        disposition: 'implemented' as const,
      })),
    },
  })
  return `runtime log\n<agent-result nonce="${nonce}">\n${json}\n</agent-result>\n`
}

function requirementItemRefsOf(fx: Pr3Fixture, missionId: string): string[] {
  const manifest = fx.materializer.getRequirementManifest(missionId)
  if (manifest === null) throw new Error('requirement manifest missing')
  return manifest.files.map((f) => f.fileId)
}

async function launchToAction(
  fx: Pr3Fixture,
  deps: ReturnType<Pr3Fixture['deps']>,
  idempotencyKey: string,
): Promise<{ missionId: string; actionRunId: string }> {
  const missionId = await fx.launchDirect(idempotencyKey)
  // 路由装配步骤（stash direct 正文）在应用级 fixture 里手动执行。
  const stashed = await fx.materializer.stashDirectSubmission({
    missionId,
    submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
  })
  expect(stashed.ok).toBe(true)
  // 轮1 materialize → 轮2 collect facts → 轮3 action-launched。
  await runMissionReconcile(deps, missionId)
  await runMissionReconcile(deps, missionId)
  const third = await runMissionReconcile(deps, missionId)
  expect(third.kind === 'decided' && third.handled).toBe('action-launched')
  const mission = fx.store.getMission(missionId)!
  expect(mission.currentActionRunId).not.toBeNull()
  return { missionId, actionRunId: mission.currentActionRunId! }
}

describe('rfc310 pr4 — attempt orchestration (launch half)', () => {
  test('launch freezes the ledger contract: nonce digest only, ab1 baseline, pre-state blob, prompt protocol block', async () => {
    const fx = await buildPr3Fixture()
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const { actionRunId } = await launchToAction(fx, deps, 'orc-launch-1')

    const attempts = fx.store.listAttempts(actionRunId)
    expect(attempts).toHaveLength(1)
    const attempt = attempts[0]!
    expect(attempt.rerunSeq).toBe(0)
    expect(attempt.attemptSeq).toBe(0)
    expect(attempt.executionRef).toBe('exec-1')
    expect(attempt.status).toBe('claimed')
    expect(attempt.preSnapshotRef).not.toBeNull()

    // nonce 明文只出现在 prompt；台账是 digest（64hex ≠ 明文）。
    const nonce = extractNonce(scripted.prompts[0]!)
    expect(attempt.nonceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(attempt.nonceDigest).not.toBe(nonce)
    expect(nonce.length).toBeGreaterThanOrEqual(16)

    const baseline = decodeAgentAttemptBaselineRef(attempt.baselineRef)
    expect(baseline).not.toBeNull()
    expect(baseline!.repositorySnapshotRef).toBe(`git:${'a'.repeat(40)}`)

    // prompt 组装含 facts 摘要与不可覆盖协议块。
    expect(scripted.prompts[0]).toContain('repository.languages')
    expect(scripted.prompts[0]).toContain('# Output protocol (non-overridable')
    expect(scripted.platformInputPaths).toHaveLength(1)
    expect(scripted.platformInputPaths[0]).toHaveLength(1)
    expect(scripted.platformInputPaths[0]![0]).toMatch(/^\.agent-workflow\/inputs\/requirements\//)
  })

  test('missing execution ports are typed blocks (not silent skips)', async () => {
    const fx = await buildPr3Fixture()
    const scripted = scriptedLauncher()
    const ports = fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } })
    const { workspaceValidation: _drop, ...withoutValidation } = ports
    const deps = fx.deps({ repositoryFacts: repoCollector, ...withoutValidation })
    const missionId = await fx.launchDirect('orc-noport-1')
    await fx.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
    })
    await runMissionReconcile(deps, missionId)
    await runMissionReconcile(deps, missionId)
    const third = await runMissionReconcile(deps, missionId)
    expect(third.kind === 'decided' && third.handled).toBe('action-launch-failed')
    expect(fx.store.getMission(missionId)!.blockCode).toBe('workspace-validation-not-wired')
    // launch 失败清 currentActionRunId：mission 可经 retry 走出，不留悬挂动作。
    expect(fx.store.getMission(missionId)!.currentActionRunId).toBeNull()
  })
})

describe('rfc310 pr4 — attempt orchestration (collect half)', () => {
  test('pending execution → guards wait(active-action-running); done+valid envelope → validated + candidate + honest stage block', async () => {
    const fx = await buildPr3Fixture()
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const { missionId, actionRunId } = await launchToAction(fx, deps, 'orc-collect-1')

    // pending：collect 让路，guards 以 active-action wait。
    const waiting = await runMissionReconcile(deps, missionId)
    expect(waiting.kind === 'decided' && waiting.selected.kind).toBe('wait')

    scripted.outcomes.set(
      'exec-1',
      doneWithFrame(
        'exec-1',
        changedEnvelope(scripted.prompts[0]!, requirementItemRefsOf(fx, missionId)),
      ),
    )
    const collected = await runMissionReconcile(deps, missionId)
    expect(collected.kind).toBe('action-collect')
    if (collected.kind !== 'action-collect') return
    expect(collected.result).toMatchObject({
      kind: 'action-collected',
      disposition: 'validated-changed',
    })

    const attempts = fx.store.listAttempts(actionRunId)
    expect(attempts[0]!.status).toBe('validated')
    expect(attempts[0]!.outcomeRef).toBe('c'.repeat(64))
    const run = fx.store.getActionRun(actionRunId)!
    expect(run.status).toBe('settled')
    const mission = fx.store.getMission(missionId)!
    expect(mission.currentActionRunId).toBeNull()
    // PR-5 起 changed 不再打 stage block：candidateState='derived' 落 cells，
    // mission 保持 working，发布链（missionDeliveryChain）下轮接管。
    expect(mission.status).toBe('working')
    const cells = fx.snapshots.getCells(mission.requirementBundleRef!)!
    expect(cells['action.lastOutcome']).toMatchObject({ state: 'known', value: 'changed' })
    expect(cells['__action.candidateState']).toMatchObject({ state: 'known', value: 'derived' })
    expect(cells['__action.candidateRef']).toMatchObject({ state: 'known', value: 'c'.repeat(64) })
  })

  test('protocol failure → fresh rerun with new nonce; budget exhaustion → agent-contract-exhausted', async () => {
    const fx = await buildPr3Fixture()
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const { missionId, actionRunId } = await launchToAction(fx, deps, 'orc-retry-1')

    // A newer source generation arriving while the Agent is running must not
    // change a fresh-session retry into a different task.
    fx.store.insertMissionSource({
      id: 'source-drift-after-launch',
      missionId,
      generation: 99,
      sourceKind: 'direct',
      externalId: null,
      adapterId: null,
      adapterRevision: null,
      sourceRevision: 'unexpected-new-revision',
      bundleRef: 'unexpected-new-bundle',
      manifestDigest: 'f'.repeat(64),
      fileCount: 1,
      totalBytes: 10,
      state: 'materialized',
      createdAt: Date.now(),
    })

    // 坏 envelope（frame 缺失）→ planNextAttempt(protocol)：sameSession=0 ⇒
    // fresh rerun（template retryDefaults.freshSession=1 ⇒ rerunSeq 1 可用）。
    scripted.outcomes.set('exec-1', doneWithFrame('exec-1', 'no frame at all'))
    const retried = await runMissionReconcile(deps, missionId)
    expect(retried.kind).toBe('action-collect')
    if (retried.kind !== 'action-collect') return
    expect(retried.result).toMatchObject({ kind: 'action-retry', rerunSeq: 1 })

    const attempts = fx.store.listAttempts(actionRunId)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.status).toBe('rejected')
    expect(JSON.parse(attempts[0]!.rejectionJson!)).toMatchObject({ code: 'frame-missing' })
    expect(attempts[1]!.rerunSeq).toBe(1)
    // fresh rerun = 新 nonce（digest 不同）、同 inputDigest（nonce 不入 digest）。
    expect(attempts[1]!.nonceDigest).not.toBe(attempts[0]!.nonceDigest)
    expect(attempts[1]!.inputDigest).toBe(attempts[0]!.inputDigest)

    // 第二次仍坏 → freshSession 预算（1）耗尽 → blocked(agent-contract-exhausted)。
    scripted.outcomes.set('exec-2', doneWithFrame('exec-2', 'still no frame'))
    const exhausted = await runMissionReconcile(deps, missionId)
    expect(exhausted.kind).toBe('action-collect')
    if (exhausted.kind !== 'action-collect') return
    expect(exhausted.result).toMatchObject({
      kind: 'action-failed',
      blockCode: 'agent-contract-exhausted',
    })
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('blocked')
    expect(mission.blockCode).toBe('agent-contract-exhausted')
    expect(mission.currentActionRunId).toBeNull()
    expect(fx.store.getActionRun(actionRunId)!.status).toBe('failed')
  })

  test('feedback protocol retry rebuilds from the exact frozen comment body', async () => {
    const fx = await buildPr3Fixture({ feedbackRoute: true })
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const { missionId, actionRunId: priorRunId } = await launchToAction(
      fx,
      deps,
      'orc-feedback-retry-1',
    )
    fx.store.settleActionRun({
      id: priorRunId,
      status: 'settled',
      resultRef: null,
      failureJson: null,
      now: Date.now(),
    })
    let mission = fx.store.getMission(missionId)!
    expect(
      fx.store.occUpdate(mission.id, mission.revision, mission.epoch, {
        currentActionRunId: null,
      }).ok,
    ).toBe(true)
    mission = fx.store.getMission(missionId)!

    const template = createSqliteActionTemplateStore(fx.db)
      .list()
      .find((row) => row.extra.capabilityId === 'mr.feedback.apply')
    expect(template?.publishedRevision).toBe(1)
    const feedbackDecision = fx.store.insertDecision({
      id: 'feedback-retry-decision',
      missionId,
      missionRevision: mission.revision,
      policyId: mission.policyId,
      policyRevision: mission.policyRevision,
      employeeId: mission.employeeId,
      employeeRevision: mission.employeeRevision,
      factSnapshotId: null,
      factDigest: 'd'.repeat(64),
      workSetJson: null,
      guardTraceJson: '[]',
      ruleTraceJson: '[]',
      selectedJson: JSON.stringify({ capabilityId: 'mr.feedback.apply' }),
      canonicalDigest: 'c'.repeat(64),
      decisionInputDigest: 'b'.repeat(64),
      now: Date.now(),
    })
    const feedbackRunId = 'feedback-retry-action-run'
    expect(
      fx.store.createActionRun({
        id: feedbackRunId,
        missionId,
        missionRevision: mission.revision,
        decisionId: feedbackDecision.decisionId,
        capabilityId: 'mr.feedback.apply',
        capabilityContractVersion: 1,
        templateId: template!.id,
        templateRevision: 1,
        workSetDigest: null,
        inputFactDigest: 'e'.repeat(64),
        baselineRef: null,
        writable: true,
        now: Date.now(),
      }).ok,
    ).toBe(true)
    expect(
      fx.store.occUpdate(mission.id, mission.revision, mission.epoch, {
        currentActionRunId: feedbackRunId,
      }).ok,
    ).toBe(true)
    mission = fx.store.getMission(missionId)!

    const first = await launchAgentAttempt(deps, mission, {
      actionRunId: feedbackRunId,
      capabilityId: 'mr.feedback.apply',
      templateId: template!.id,
      templateRevision: 1,
      rerunSeq: 0,
      factsSummary: [],
      missionRevisionPin: mission.revision,
      feedbackSnapshot: {
        snapshotRef: 'feedback-snapshot-1',
        items: [
          {
            threadRef: 'thread-1',
            revision: 'revision-7',
            body: 'Rename the public method and keep binary compatibility.\nAdd a regression test.',
            path: 'src/App.java',
          },
        ],
      },
      retryBudget: { sameSession: 1, freshSession: 1 },
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    scripted.outcomes.set(first.executionRef, doneWithFrame(first.executionRef, 'no frame'))

    const retried = await runMissionReconcile(deps, missionId)
    expect(retried.kind).toBe('action-collect')
    if (retried.kind !== 'action-collect') return
    expect(retried.result).toMatchObject({ kind: 'action-retry', rerunSeq: 0 })

    const attempts = fx.store.listAttempts(feedbackRunId)
    expect(attempts).toHaveLength(2)
    expect(attempts.map((attempt) => [attempt.rerunSeq, attempt.attemptSeq])).toEqual([
      [0, 0],
      [0, 1],
    ])
    expect(attempts[1]!.inputDigest).toBe(attempts[0]!.inputDigest)
    expect(attempts[1]!.nonceDigest).not.toBe(attempts[0]!.nonceDigest)
    expect(scripted.workspacePaths.at(-1)).toBe(scripted.workspacePaths.at(-2))
    const feedbackPrompts = scripted.prompts.filter((prompt) =>
      prompt.includes('review feedback thread-1@revision-7'),
    )
    expect(feedbackPrompts).toHaveLength(2)
    expect(feedbackPrompts[1]).toContain(
      'Rename the public method and keep binary compatibility.\nAdd a regression test.',
    )
    expect(feedbackPrompts[1]).toContain('previous attempt rejection')
    expect(feedbackPrompts[1]).toContain('frame-missing')
  })

  test('boundary violation → attempt discarded (never same-session) + fresh rerun', async () => {
    const fx = await buildPr3Fixture()
    const scripted = scriptedLauncher()
    const base = fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } })
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...base,
      workspaceValidation: {
        capturePreState: () => '{}',
        validate: () => ({
          ok: false as const,
          kind: 'boundary' as const,
          code: 'protected-root-write',
          paths: ['.git/config'],
          detail: 'git metadata modified',
        }),
      },
    })
    const { missionId, actionRunId } = await launchToAction(fx, deps, 'orc-boundary-1')
    scripted.outcomes.set(
      'exec-1',
      doneWithFrame(
        'exec-1',
        changedEnvelope(scripted.prompts[0]!, requirementItemRefsOf(fx, missionId)),
      ),
    )
    const outcome = await runMissionReconcile(deps, missionId)
    expect(outcome.kind).toBe('action-collect')
    if (outcome.kind !== 'action-collect') return
    expect(outcome.result).toMatchObject({ kind: 'action-retry', rerunSeq: 1 })
    const attempts = fx.store.listAttempts(actionRunId)
    expect(attempts[0]!.status).toBe('discarded')
    expect(JSON.parse(attempts[0]!.rejectionJson!)).toMatchObject({ code: 'protected-root-write' })
  })

  test('needs-information → agent question set enters the clarification loop', async () => {
    const fx = await buildPr3Fixture()
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const { missionId } = await launchToAction(fx, deps, 'orc-questions-1')

    const nonce = extractNonce(scripted.prompts[0]!)
    const id = extractIdentity(scripted.prompts[0]!)
    const json = JSON.stringify({
      protocolVersion: 1,
      nonce,
      port: 'agent-result',
      actionRunRef: id.actionRunRef,
      inputDigest: id.inputDigest,
      capabilityId: 'change.implement',
      outcome: 'needs-information',
      result: {
        questions: [{ questionId: 'aq1', text: 'which db?', rationale: 'schema is ambiguous' }],
      },
    })
    scripted.outcomes.set(
      'exec-1',
      doneWithFrame('exec-1', `<agent-result nonce="${nonce}">${json}</agent-result>`),
    )
    const collected = await runMissionReconcile(deps, missionId)
    expect(collected.kind).toBe('action-collect')
    if (collected.kind !== 'action-collect') return
    expect(collected.result).toMatchObject({
      kind: 'action-collected',
      disposition: 'needs-information',
    })

    // 下一轮：澄清重派 publish（platform 渠道）→ awaiting-information。
    const published = await runMissionReconcile(deps, missionId)
    expect(published.kind === 'decided' && published.selected.kind).toBe(
      'publish-requirement-questions',
    )
    expect(fx.store.getMission(missionId)!.status).toBe('awaiting-information')
  })

  test('execution not-found → runtime-transient fresh rerun path', async () => {
    const fx = await buildPr3Fixture()
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const { missionId, actionRunId } = await launchToAction(fx, deps, 'orc-notfound-1')
    scripted.outcomes.set('exec-1', { kind: 'not-found', executionRef: 'exec-1' })
    const outcome = await runMissionReconcile(deps, missionId)
    expect(outcome.kind).toBe('action-collect')
    if (outcome.kind !== 'action-collect') return
    expect(outcome.result).toMatchObject({ kind: 'action-retry', rerunSeq: 1 })
    expect(fx.store.listAttempts(actionRunId)[0]!.status).toBe('rejected')
  })
})
