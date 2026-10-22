// RFC-396: semantic identity, adaptive combinations and evidence boundaries.
// These fixtures describe requirements independently of the planner's scoring implementation.
import { describe, expect, test } from 'bun:test'
import type {
  GraphDesignDocument,
  GraphEvidenceBinding,
  GraphProposal,
  GraphSubmodel,
  GraphViewProposal,
} from '@agent-workflow/shared'
import {
  applyGraphProposal,
  graphContentRefs,
  graphDigest,
  graphImpact,
  staleGraphReads,
  validateGraphDocument,
} from '../src/modules/development-automation/domain/graph-development/model'
import { selectGraphViews } from '../src/modules/development-automation/domain/graph-development/selectViews'
import { createGraphImplementationBasis } from '../src/modules/development-automation/domain/graph-development/implementationBasis'
import {
  graphObligationCoverage,
  projectGraphEvidence,
} from '../src/modules/development-automation/domain/graph-development/evidence'
import {
  checkGraphDecisionTable,
  enumerateGraphStatePaths,
} from '../src/modules/development-automation/domain/graph-development/behaviorChecks'
import { renderGraphModel } from '../src/modules/development-automation/domain/graph-development/renderViews'

function document(): GraphDesignDocument {
  return {
    schemaVersion: 1,
    id: 'design-a',
    caseId: 'case-a',
    revision: 1,
    title: '预约',
    goals: ['避免重复预约'],
    repositoryId: 'repo-a',
    repositoryBaseline: { kind: 'commit', commitSha: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
    concerns: [
      {
        id: 'availability',
        revision: 1,
        statement: '如何防止重复预约',
        purpose: 'implement',
        priority: 'required',
        disposition: 'addressed',
        sourceIds: ['request'],
        resolutionIds: ['booking'],
      },
    ],
    elements: [
      {
        id: 'booking',
        revision: 1,
        kind: 'requirement',
        label: '预约',
        description: '同一时段最多一笔预约',
        sourceIds: ['request'],
        obligationIds: ['unique-booking'],
      },
    ],
    relations: [],
    models: [
      {
        id: 'booking-flow',
        revision: 1,
        label: '预约行为',
        kind: 'flow',
        elementIds: ['booking'],
        relationIds: [],
        sourceIds: ['request'],
      },
    ],
    views: [],
    sources: [
      {
        id: 'request',
        kind: 'material',
        artifactRef: 'artifact-a',
        digest: '1'.repeat(64),
        label: '人的原始需求',
      },
    ],
    obligations: [
      {
        id: 'unique-booking',
        revision: 1,
        statement: '并发预约只有一笔成功',
        elementIds: ['booking'],
        concernIds: ['availability'],
        verification: {
          kind: 'manual',
          instructions: '同时发起两笔预约并检查结果',
          owner: null,
          when: null,
        },
      },
    ],
  }
}
function candidate(id: string, coverage = ['availability'], cost = 1): GraphViewProposal {
  return {
    id,
    title: id,
    purpose: '澄清当前问题',
    capabilityRef: { id: 'flow', version: 1 },
    coverage: coverage.map((concernId) => ({
      concernId,
      contribution: 1,
      explanation: '呈现该问题的明确行为',
    })),
    modelIds: ['booking-flow'],
    elementIds: ['booking'],
    relationIds: [],
    sourceIds: ['request'],
    readingCost: cost,
    generationCost: 1,
    rationale: '额外价值',
    limitations: [],
    replaces: [],
  }
}
function proposal(current: GraphDesignDocument, next: GraphDesignDocument): GraphProposal {
  return {
    schemaVersion: 1,
    id: 'proposal-a',
    designId: current.id,
    requestId: 'request-a',
    kind: 'semantic-change',
    readSet: graphContentRefs(current),
    invocationRef: 'invocation-a',
    status: 'proposed',
    explanation: '补充约束',
    document: next,
    plan: null,
    createdAt: 1,
  }
}
function evidence(): GraphEvidenceBinding {
  return {
    id: 'evidence-a',
    kind: 'execution',
    basisDigest: '2'.repeat(64),
    obligationIds: ['unique-booking'],
    readSet: graphContentRefs(document()),
    candidateTreeOid: 'tree-a',
    commitSha: 'commit-a',
    profileRef: { id: 'profile-a', revision: 1, digest: '3'.repeat(64) },
    environmentDigest: '4'.repeat(64),
    executionRef: 'verification-a',
    artifactRef: 'artifact-result',
    artifactDigest: '5'.repeat(64),
    ci: null,
    result: 'passed',
    summary: '真实回执',
    limitations: [],
    recordedAt: 1,
  }
}

describe('RFC-396 adaptive expression', () => {
  test('simple requirements need one useful view, not a mandatory diagram set', () => {
    const result = selectGraphViews(
      document(),
      [candidate('overview'), candidate('duplicate', ['availability'], 2)],
      { reading: 10, generation: 10 },
    )
    expect(result.selectedIds).toHaveLength(1)
    expect(result.uncoveredConcernIds).toEqual([])
    expect(result.decisions.find((item) => item.candidateId === 'duplicate')?.selected).toBe(false)
  })
  test('additional concerns change the combination without a requirement-category switch', () => {
    const current = document()
    current.concerns.push({
      ...current.concerns[0]!,
      id: 'priority',
      statement: '冲突时的优先级',
      purpose: 'decide',
    })
    const result = selectGraphViews(
      current,
      [candidate('availability-view'), candidate('priority-view', ['priority'])],
      { reading: 5, generation: 5 },
    )
    expect(new Set(result.selectedIds)).toEqual(new Set(['availability-view', 'priority-view']))
    expect(result.uncoveredConcernIds).toEqual([])
  })
  test('budget exhaustion and unsupported expressions retain required gaps', () => {
    const unavailable = {
      ...candidate('unknown'),
      capabilityRef: { id: 'uninstalled-renderer', version: 1 },
    }
    const result = selectGraphViews(
      document(),
      [unavailable, candidate('too-costly', ['availability'], 20)],
      { reading: 1, generation: 1 },
    )
    expect(result.selectedIds).toEqual([])
    expect(result.uncoveredConcernIds).toEqual(['availability'])
    expect(result.decisions.find((item) => item.candidateId === 'unknown')?.reason).toBe(
      'unsupported-capability-version',
    )
  })
  test('pinned stale views survive a new plan but do not conceal uncovered concerns', () => {
    const current = document()
    current.views.push({
      id: 'pinned-view',
      revision: 1,
      title: '人的固定视图',
      purpose: '保留阅读路径',
      capabilityRef: { id: 'flow', version: 1 },
      modelIds: ['booking-flow'],
      elementIds: ['booking'],
      relationIds: [],
      sourceIds: ['request'],
      concernIds: ['availability'],
      status: 'needs-update',
      pinned: true,
      explanation: '保留',
      limitations: [],
    })
    const result = selectGraphViews(current, [], { reading: 0, generation: 0 })
    expect(result.selectedIds).toEqual(['pinned-view'])
    expect(result.overBudget).toBe(true)
    expect(result.uncoveredConcernIds).toEqual(['availability'])
  })
  test('candidate order does not change the selected semantic combination', () => {
    const candidates = [candidate('one'), candidate('two')]
    expect(selectGraphViews(document(), candidates, { reading: 3, generation: 3 })).toEqual(
      selectGraphViews(document(), [...candidates].reverse(), { reading: 3, generation: 3 }),
    )
  })
})

describe('RFC-396 semantic truth and versions', () => {
  test('same labels do not merge identities; unresolved references are rejected', () => {
    const current = document()
    current.elements.push({ ...current.elements[0]!, id: 'another-booking' })
    expect(validateGraphDocument(current)).toEqual([])
    current.elements.push({ ...current.elements[0]! })
    expect(validateGraphDocument(current).some((item) => item.code === 'duplicate-id')).toBe(true)
    current.elements.pop()
    current.relations.push({
      id: 'broken',
      revision: 1,
      from: 'booking',
      to: 'missing',
      kind: 'depends-on',
      label: '依赖',
      sourceIds: [],
    })
    expect(validateGraphDocument(current).some((item) => item.code === 'missing-reference')).toBe(
      true,
    )
  })
  test('containment cycles fail while legitimate behavior cycles remain valid', () => {
    const current = document()
    current.relations.push({
      id: 'loop',
      revision: 1,
      from: 'booking',
      to: 'booking',
      kind: 'flow',
      label: '重试',
      sourceIds: [],
    })
    expect(validateGraphDocument(current)).toEqual([])
    current.relations[0]!.kind = 'containment'
    expect(validateGraphDocument(current).some((item) => item.code === 'containment-cycle')).toBe(
      true,
    )
  })
  test('a model cannot promote a provisional human answer to decided', () => {
    const current = document()
    current.sources.push({
      id: 'human',
      kind: 'clarify',
      taskId: 'task',
      roundId: 'round',
      questionId: 'question',
      confirmedBasis: 'basis',
      originalAnswer: '先不自动抢占，负责人未知',
      decision: { status: 'provisional' },
    })
    current.elements.push({
      id: 'decision',
      revision: 1,
      kind: 'decision',
      label: '抢占策略',
      description: '待进一步确认',
      sourceIds: ['human'],
      decision: { status: 'decided' },
    })
    expect(
      validateGraphDocument(current).some((item) => item.code === 'decision-source-mismatch'),
    ).toBe(true)
  })
  test('stale proposals cannot overwrite changed semantic content', () => {
    const original = document()
    const proposed = proposal(original, { ...original, title: '更新后的预约' })
    const current = structuredClone(original)
    current.elements[0]!.description = '用户已改为需要人工批准'
    current.elements[0]!.revision++
    expect(applyGraphProposal(current, proposed).status).toBe('stale')
    expect(current.title).toBe('预约')
  })
  test('partial read sets preserve unrelated concurrent edits and human sources', () => {
    const original = document()
    const proposedDocument = structuredClone(original)
    proposedDocument.elements[0]!.description = '补充原子占用'
    const proposed = proposal(original, proposedDocument)
    proposed.readSet = proposed.readSet.filter((ref) => ref.id === 'booking')
    const current = structuredClone(original)
    current.title = '用户修改标题'
    proposed.document.title = current.title
    const applied = applyGraphProposal(current, proposed)
    expect(applied.status).toBe('accepted')
    if (applied.status !== 'accepted') return
    expect(applied.document.title).toBe('用户修改标题')
    expect(applied.document.elements[0]!.description).toBe('补充原子占用')
    expect(applied.document.elements[0]!.revision).toBe(2)
    expect(applied.document.sources).toEqual(original.sources)
  })
  test('proposal deletes declared objects while preserving concurrent unread objects and immutable sources', () => {
    const original = document()
    const proposed = proposal(original, {
      ...original,
      concerns: [],
      elements: [],
      models: [],
      obligations: [],
      sources: [],
    })
    const current = structuredClone(original)
    current.elements.push({
      id: 'concurrent',
      revision: 1,
      kind: 'requirement',
      label: 'Concurrent',
      description: '',
      sourceIds: [],
      obligationIds: [],
    })
    const applied = applyGraphProposal(current, proposed)
    expect(applied.status).toBe('accepted')
    if (applied.status !== 'accepted') return
    expect(applied.document.elements.map((element) => element.id)).toEqual(['concurrent'])
    expect(applied.document.concerns).toEqual([])
    expect(applied.document.models).toEqual([])
    expect(applied.document.obligations).toEqual([])
    expect(applied.document.sources).toEqual(original.sources)
  })
  test('a proposal cannot delete a pinned view', () => {
    const current = document()
    current.views.push({
      id: 'pinned',
      revision: 1,
      title: 'Pinned',
      purpose: 'clarify',
      capabilityRef: { id: 'flow', version: 1 },
      modelIds: ['booking-flow'],
      elementIds: ['booking'],
      relationIds: [],
      sourceIds: ['request'],
      concernIds: ['availability'],
      status: 'current',
      pinned: true,
      explanation: '',
      limitations: [],
    })
    expect(() => applyGraphProposal(current, proposal(current, { ...current, views: [] }))).toThrow(
      'graph-proposal-cannot-unpin:pinned',
    )
  })
  test('dependency impact does not treat containment as implementation dependence', () => {
    const current = document()
    current.elements.push(
      { ...current.elements[0]!, id: 'dependent' },
      { ...current.elements[0]!, id: 'child' },
    )
    current.relations.push(
      {
        id: 'dep',
        revision: 1,
        from: 'dependent',
        to: 'booking',
        kind: 'depends-on',
        label: '',
        sourceIds: [],
      },
      {
        id: 'contains',
        revision: 1,
        from: 'booking',
        to: 'child',
        kind: 'containment',
        label: '',
        sourceIds: [],
      },
    )
    expect(
      graphImpact(current, ['booking']).affectedIds.filter((id) =>
        current.elements.some((element) => element.id === id),
      ),
    ).toEqual(['booking', 'dependent'])
    expect(staleGraphReads(current, graphContentRefs(current))).toEqual([])
  })
})

describe('RFC-396 implementation basis and evidence', () => {
  test('exports are deterministic and preserve unassigned human arrangements', () => {
    const first = createGraphImplementationBasis({
      id: 'basis-a',
      document: document(),
      includedElementIds: ['booking'],
      createdAt: 10,
    })
    const second = createGraphImplementationBasis({
      id: 'basis-b',
      document: document(),
      includedElementIds: ['booking'],
      createdAt: 20,
    })
    expect(first.digest).toBe(second.digest)
    expect(first.files.find((file) => file.path === 'acceptance.json')?.content).toContain(
      '"owner":null',
    )
    expect(first.files.some((file) => file.path === 'manifest.json')).toBe(true)
    expect(first.files.every((file) => graphDigest(file.content) === file.digest)).toBe(true)
  })
  test('open critical concerns and unassigned verification block a basis', () => {
    const current = document()
    current.concerns[0]!.disposition = 'open'
    expect(() =>
      createGraphImplementationBasis({
        id: 'basis',
        document: current,
        includedElementIds: ['booking'],
        createdAt: 1,
      }),
    ).toThrow('unresolved-concern')
    current.concerns[0]!.disposition = 'addressed'
    current.obligations[0]!.verification = { kind: 'unassigned', reason: '尚未安排' }
    expect(() =>
      createGraphImplementationBasis({
        id: 'basis',
        document: current,
        includedElementIds: ['booking'],
        createdAt: 1,
      }),
    ).toThrow('verification-unassigned')
  })
  test('actual receipts retain their historical result when candidate content changes', () => {
    const target = {
      document: document(),
      basisDigest: '2'.repeat(64),
      candidateTreeOid: 'new-tree',
      profileDigests: { 'profile-a': '3'.repeat(64) },
      environmentDigest: '4'.repeat(64),
      commitSha: 'commit-a',
    }
    const projected = projectGraphEvidence(evidence(), target)
    expect(projected.freshness).toBe('stale')
    expect(projected.evidence.result).toBe('passed')
    expect(graphObligationCoverage(target.document, [projected])[0]!.state).toBe('pending')
  })
  test('an AI passed claim without execution provenance never satisfies an obligation', () => {
    const current = document()
    current.obligations[0]!.verification = {
      kind: 'execution',
      profileRef: { id: 'profile-a', revision: 1, digest: '3'.repeat(64) },
      testRefs: ['concurrency'],
    }
    const projected = projectGraphEvidence(
      { ...evidence(), executionRef: null },
      {
        document: current,
        basisDigest: '2'.repeat(64),
        candidateTreeOid: 'tree-a',
        profileDigests: { 'profile-a': '3'.repeat(64) },
        environmentDigest: '4'.repeat(64),
        commitSha: 'commit-a',
      },
    )
    expect(projected.freshness).not.toBe('current')
    expect(graphObligationCoverage(current, [projected])[0]!.state).toBe('pending')
  })
  test('CI evidence from another commit is stale even when a tree identifier matches', () => {
    const receipt = {
      ...evidence(),
      ci: { workflow: 'CI', sha: 'old-sha', runId: 'run', jobId: null, step: null },
    }
    expect(
      projectGraphEvidence(receipt, {
        document: document(),
        basisDigest: receipt.basisDigest,
        candidateTreeOid: receipt.candidateTreeOid,
        profileDigests: { 'profile-a': '3'.repeat(64) },
        environmentDigest: receipt.environmentDigest,
        commitSha: 'new-sha',
      }).reasons,
    ).toContain('different-ci-sha')
  })
})

describe('RFC-396 bounded behavioral models', () => {
  test('cyclic states report bounded paths and missing executable bindings', () => {
    const current = document()
    current.relations.push({
      id: 'retry',
      revision: 1,
      from: 'booking',
      to: 'booking',
      kind: 'transition',
      label: '重试',
      sourceIds: [],
    })
    const model: Extract<GraphSubmodel, { kind: 'state' }> = {
      id: 'states',
      revision: 1,
      label: '重试',
      sourceIds: [],
      kind: 'state',
      stateIds: ['booking'],
      initialStateId: 'booking',
      terminalStateIds: [],
      transitions: [
        { relationId: 'retry', event: 'retry', guards: [], actionRef: null, assertionRefs: [] },
      ],
    }
    const result = enumerateGraphStatePaths(current, model, { depth: 2, paths: 10, inputs: [{}] })
    expect(result.paths.map((path) => path.transitionIds.length)).toEqual([0, 1, 2])
    expect(result.truncated).toBe(true)
    expect(result.missingBindingIds).toEqual(['retry'])
  })
  test('overlapping unique rules conflict and untested inputs stay uncovered', () => {
    const model: Extract<GraphSubmodel, { kind: 'decision-table' }> = {
      id: 'rules',
      revision: 1,
      label: '优先级',
      sourceIds: [],
      kind: 'decision-table',
      inputFields: ['priority'],
      resolution: 'unique',
      rows: [
        {
          id: 'one',
          ruleId: 'normal',
          priority: 1,
          conditions: [{ field: 'priority', operator: 'gte', value: 1 }],
          output: { accepted: true },
          assertionRefs: [],
        },
        {
          id: 'two',
          ruleId: 'urgent',
          priority: 2,
          conditions: [{ field: 'priority', operator: 'gte', value: 5 }],
          output: { accepted: false },
          assertionRefs: [],
        },
      ],
    }
    const result = checkGraphDecisionTable(model, [
      { priority: 2 },
      { priority: 7 },
      { priority: 0 },
    ])
    expect(result.map((item) => item.result)).toEqual(['matched', 'conflict', 'uncovered'])
  })
  test('render identity is stable when labels change', () => {
    const current = document()
    const first = renderGraphModel(current, current.models[0]!)
    current.elements[0]!.label = '更清楚的名称'
    const second = renderGraphModel(current, current.models[0]!)
    expect(first.elementIndex[0]!.renderId).toBe(second.elementIndex[0]!.renderId)
    expect(first.source).not.toBe(second.source)
  })
})
