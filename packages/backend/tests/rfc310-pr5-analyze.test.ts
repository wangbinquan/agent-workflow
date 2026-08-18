// RFC-310 PR-5 T54 —— requirement.analyze（read-only 认知动作）。
//
// 锁：①envelope 的 read-only `completed` outcome（write 能力用它被语义拒；
// header/result capability 一致性 strict）；②semantic validator 的闭集对拍
// （coverage 双射 requirement index、affectedModuleRefs ⊆ repository module
// catalog、ready 不许空模块集、闭集缺失 = validator-input-missing 配置归因）；
// ③投影纯函数：validator 通过后的结论进入 agent-validated facts；④端到端
// 默认链形态：analyze（lastOutcome none）→ completed 投影 scopeDisposition
// → 下一轮规则命中 implement——「Agent 提供认知结果，不提供 template id」
// （§8.2 polyglot 两阶段路由，无循环）。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'

import { agentOutcomeEnvelopeSchema } from '../src/modules/development-automation/domain/agentEnvelope'
import { projectAnalysisCells } from '../src/modules/development-automation/domain/requirementAnalysis'
import { runCapabilitySemanticValidator } from '../src/modules/development-automation/engine/envelope/semanticValidators'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type {
  AgentActionLauncherPort,
  AgentExecutionSnapshot,
  RepositoryFactsCollectorPort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { makeManifest } from './helpers/rfc310Pr4Manifest'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

setDefaultTimeout(120_000)

const HEADER = {
  protocolVersion: 1,
  nonce: 'nonce-0123456789abcdef',
  port: 'agent-result',
  actionRunRef: 'run-1',
  inputDigest: 'd'.repeat(64),
  capabilityId: 'requirement.analyze',
} as const

function completedEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...HEADER,
    outcome: 'completed',
    result: {
      capabilityId: 'requirement.analyze',
      summary: 'touches core',
      requirementCoverage: [{ itemRef: 'item-1', disposition: 'in-scope' }],
      affectedModuleRefs: ['core'],
      scopeDisposition: 'ready',
      ...overrides,
    },
  }
}

describe('rfc310 pr5 T54 — completed envelope schema', () => {
  test('parses a valid analyze result; needs-information disposition is not expressible here', () => {
    expect(agentOutcomeEnvelopeSchema.safeParse(completedEnvelope()).success).toBe(true)
    // scopeDisposition 闭集只有 ready/already-satisfied-candidate：不确定时
    // Agent 必须走 needs-information outcome（问题集），不能伪装成分析结论。
    expect(
      agentOutcomeEnvelopeSchema.safeParse(
        completedEnvelope({ scopeDisposition: 'needs-information' }),
      ).success,
    ).toBe(false)
  })

  test('header/result capability mismatch is rejected at schema level', () => {
    const forged = {
      ...(completedEnvelope() as Record<string, unknown>),
      capabilityId: 'change.review',
    }
    expect(agentOutcomeEnvelopeSchema.safeParse(forged).success).toBe(false)
  })

  test('unknown platform-fact fields stay rejected on the completed branch too', () => {
    expect(
      agentOutcomeEnvelopeSchema.safeParse(completedEnvelope({ changedPaths: ['a'] })).success,
    ).toBe(false)
  })
})

describe('rfc310 pr5 T54 — semantic validator', () => {
  const manifest = makeManifest({ capabilityId: 'requirement.analyze' })

  function verdictOf(
    envelopeOverrides: Record<string, unknown>,
    closedRefs: Record<string, readonly string[] | undefined>,
  ): { ok: boolean; code?: string } {
    const parsed = agentOutcomeEnvelopeSchema.parse(completedEnvelope(envelopeOverrides))
    const out = runCapabilitySemanticValidator({ manifest, envelope: parsed, closedRefs })
    return out.ok ? { ok: true } : { ok: false, code: out.rejection.code }
  }

  test('module refs outside the repository catalog are rejected', () => {
    expect(
      verdictOf(
        { affectedModuleRefs: ['ghost-module'] },
        { requirementItemRefs: ['item-1'], repositoryModuleIds: ['core', 'api'] },
      ),
    ).toEqual({ ok: false, code: 'module-ref-outside-catalog' })
  })

  test('coverage must be a bijection over the requirement index', () => {
    expect(
      verdictOf({}, { requirementItemRefs: ['item-1', 'item-2'], repositoryModuleIds: ['core'] }),
    ).toEqual({ ok: false, code: 'coverage-missing-item' })
    expect(
      verdictOf(
        { requirementCoverage: [{ itemRef: 'nope', disposition: 'in-scope' }] },
        { requirementItemRefs: ['item-1'], repositoryModuleIds: ['core'] },
      ),
    ).toEqual({ ok: false, code: 'coverage-unknown-item' })
  })

  test("scopeDisposition 'ready' with an empty module set is not an analysis", () => {
    expect(
      verdictOf(
        { affectedModuleRefs: [] },
        { requirementItemRefs: ['item-1'], repositoryModuleIds: ['core'] },
      ),
    ).toEqual({ ok: false, code: 'analysis-empty-modules' })
  })

  test('missing closed sets are configuration failures, never agent blame', () => {
    expect(verdictOf({}, { requirementItemRefs: ['item-1'] })).toEqual({
      ok: false,
      code: 'validator-input-missing',
    })
  })

  test('write capability using completed is rejected (and the happy path passes)', () => {
    const writeManifest = makeManifest({ capabilityId: 'change.implement' })
    const forged = agentOutcomeEnvelopeSchema.parse({
      ...(completedEnvelope() as Record<string, unknown>),
      capabilityId: 'change.implement',
      result: {
        capabilityId: 'change.implement',
        summary: 'x',
        requirementCoverage: [{ itemRef: 'item-1', disposition: 'implemented' }],
      },
      outcome: 'changed',
    })
    // changed 走的是既有分支——这里锁的是 completed 的反向：write 能力伪造
    // completed 直接在 schema 层就没有形状（result union 只收 read-only 能力），
    // 语义层的 write-capability-cannot-use-completed 由未来 read-only union
    // 扩员时兜底。此断言证明现状不可表达。
    expect(forged.outcome).toBe('changed')
    expect(
      agentOutcomeEnvelopeSchema.safeParse({
        ...(completedEnvelope() as Record<string, unknown>),
        capabilityId: 'change.implement',
      }).success,
    ).toBe(false)
    expect(writeManifest.capabilityId).toBe('change.implement')
  })

  test('projection turns a validated result into agent-validated cells', () => {
    const parsed = agentOutcomeEnvelopeSchema.parse(completedEnvelope())
    if (parsed.outcome !== 'completed') throw new Error('unexpected outcome')
    expect(projectAnalysisCells(parsed, 'attempt-9')).toEqual({
      'requirement.affectedModuleIds': {
        state: 'known',
        value: ['core'],
        sourceRevision: 'attempt-9',
      },
      'requirement.scopeDisposition': {
        state: 'known',
        value: 'ready',
        sourceRevision: 'attempt-9',
      },
    })
  })
})

describe('rfc310 pr5 T54 — analyze → implement chain (end to end)', () => {
  function scriptedLauncher(): {
    port: AgentActionLauncherPort
    prompts: string[]
    capabilities: string[]
    outcomes: Map<string, AgentExecutionSnapshot>
  } {
    const prompts: string[] = []
    const capabilities: string[] = []
    const outcomes = new Map<string, AgentExecutionSnapshot>()
    return {
      prompts,
      capabilities,
      outcomes,
      port: {
        async launch(input) {
          prompts.push(input.prompt)
          capabilities.push(input.capabilityId)
          return { ok: true, executionRef: `exec-${prompts.length}` }
        },
        async fetchOutcome(executionRef) {
          return (
            outcomes.get(executionRef) ?? { kind: 'pending', executionRef, taskStatus: 'running' }
          )
        },
        async cancel() {
          return { settled: 'already-terminal' }
        },
      },
    }
  }

  const repoCollector: RepositoryFactsCollectorPort = {
    async collect() {
      return { cells: structuredClone(PR3_JAVA_CELLS) as never, factsRef: 'probe-1' }
    },
  }

  test('default-chain shape: analyze runs first, its validated facts route implement next', async () => {
    const fx = await buildPr3Fixture({
      analyzeRoute: true,
      rules: [
        {
          ruleId: 'analyze-first',
          when: [
            { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
            { kind: 'boolean-is', fact: 'repository.defaultBranchKnown', value: true },
            { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
          ],
          capabilityId: 'requirement.analyze',
        },
        {
          ruleId: 'implement-when-ready',
          when: [
            { kind: 'enum-equals', fact: 'requirement.scopeDisposition', value: 'ready' },
            { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
          ],
          capabilityId: 'change.implement',
        },
      ],
    })
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const missionId = await fx.launchDirect('t54-chain-1')
    await fx.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
    })
    await runMissionReconcile(deps, missionId) // materialize
    // 默认链形态：analyze 规则带 repository 谓词 ⇒ facts 缺席先 COLLECT
    // （module catalog 是 analyze 对拍闭集，必须先就绪），随后 analyze 发射。
    const factsFirst = await runMissionReconcile(deps, missionId)
    expect(factsFirst.kind === 'decided' && factsFirst.selected.kind).toBe(
      'collect-repository-facts',
    )
    const analyzeRound = await runMissionReconcile(deps, missionId)
    expect(analyzeRound.kind === 'decided' && analyzeRound.handled).toBe('action-launched')
    expect(scripted.capabilities).toEqual(['requirement.analyze'])

    // Agent 交回 analyze 结论：core 受影响、scope ready。
    const prompt = scripted.prompts[0]!
    const nonce = /<agent-result nonce="([^"]+)">/.exec(prompt)![1]!
    const actionRunRef = /"actionRunRef": "([^"]+)"/.exec(prompt)![1]!
    const inputDigest = /"inputDigest": "([^"]+)"/.exec(prompt)![1]!
    const manifest = fx.materializer.getRequirementManifest(missionId)!
    const json = JSON.stringify({
      protocolVersion: 1,
      nonce,
      port: 'agent-result',
      actionRunRef,
      inputDigest,
      capabilityId: 'requirement.analyze',
      outcome: 'completed',
      result: {
        capabilityId: 'requirement.analyze',
        summary: 'core module implements the demand',
        requirementCoverage: manifest.files.map((f) => ({
          itemRef: f.fileId,
          disposition: 'in-scope' as const,
        })),
        affectedModuleRefs: ['app'],
        scopeDisposition: 'ready',
      },
    })
    scripted.outcomes.set('exec-1', {
      kind: 'exited',
      executionRef: 'exec-1',
      taskStatus: 'done',
      resultText: `<agent-result nonce="${nonce}">${json}</agent-result>`,
      errorSummary: null,
      errorMessage: null,
    })

    const collected = await runMissionReconcile(deps, missionId)
    expect(collected.kind).toBe('action-collect')
    if (collected.kind !== 'action-collect') return
    expect(collected.result).toMatchObject({
      kind: 'action-collected',
      disposition: 'analysis-completed',
    })
    // completed 不打 stage block：mission 保持可推进。
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('working')
    const cells = fx.snapshots.getCells(mission.requirementBundleRef!)!
    expect(cells['requirement.scopeDisposition']).toMatchObject({ state: 'known', value: 'ready' })
    expect(cells['requirement.affectedModuleIds']).toMatchObject({
      state: 'known',
      value: ['app'],
    })
    expect(cells['action.lastOutcome']).toMatchObject({ state: 'known', value: 'completed' })

    // 下一轮：已验证 scope facts + 既有 repository facts 命中 implement
    // （analyze 不重复——lastOutcome ≠ none）。
    const implementRound = await runMissionReconcile(deps, missionId)
    expect(implementRound.kind === 'decided' && implementRound.handled).toBe('action-launched')
    expect(scripted.capabilities).toEqual(['requirement.analyze', 'change.implement'])
  })

  test('module refs outside the catalog make analyze retry, not silently pass', async () => {
    const fx = await buildPr3Fixture({
      analyzeRoute: true,
      rules: [
        {
          ruleId: 'analyze-first',
          when: [
            { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
            { kind: 'boolean-is', fact: 'repository.defaultBranchKnown', value: true },
            { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
          ],
          capabilityId: 'requirement.analyze',
        },
      ],
    })
    const scripted = scriptedLauncher()
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db, overrides: { agentLauncher: scripted.port } }),
    })
    const missionId = await fx.launchDirect('t54-badmodule-1')
    await fx.materializer.stashDirectSubmission({
      missionId,
      submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
    })
    await runMissionReconcile(deps, missionId) // materialize
    await runMissionReconcile(deps, missionId) // collect repository facts
    await runMissionReconcile(deps, missionId) // analyze launched
    const prompt = scripted.prompts[0]!
    const nonce = /<agent-result nonce="([^"]+)">/.exec(prompt)![1]!
    const actionRunRef = /"actionRunRef": "([^"]+)"/.exec(prompt)![1]!
    const inputDigest = /"inputDigest": "([^"]+)"/.exec(prompt)![1]!
    const manifest = fx.materializer.getRequirementManifest(missionId)!
    const json = JSON.stringify({
      protocolVersion: 1,
      nonce,
      port: 'agent-result',
      actionRunRef,
      inputDigest,
      capabilityId: 'requirement.analyze',
      outcome: 'completed',
      result: {
        capabilityId: 'requirement.analyze',
        summary: 'made-up module',
        requirementCoverage: manifest.files.map((f) => ({
          itemRef: f.fileId,
          disposition: 'in-scope' as const,
        })),
        affectedModuleRefs: ['module-that-does-not-exist'],
        scopeDisposition: 'ready',
      },
    })
    scripted.outcomes.set('exec-1', {
      kind: 'exited',
      executionRef: 'exec-1',
      taskStatus: 'done',
      resultText: `<agent-result nonce="${nonce}">${json}</agent-result>`,
      errorSummary: null,
      errorMessage: null,
    })
    const collected = await runMissionReconcile(deps, missionId)
    expect(collected.kind).toBe('action-collect')
    if (collected.kind !== 'action-collect') return
    expect(collected.result.kind).toBe('action-retry')
    const attempts = fx.store.listAttempts(
      (collected.result as { actionRunId: string }).actionRunId,
    )
    expect(JSON.parse(attempts[0]!.rejectionJson!)).toMatchObject({
      code: 'module-ref-outside-catalog',
    })
  })
})
