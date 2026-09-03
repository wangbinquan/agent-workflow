// RFC-199 B5 — all graph semantics are applied once by one reconciler.
//
// RFC-354 (schema v6): a review's input, an output node's ports, a loop's
// returns and a fan-out's parameters are all edges — no transition writes a
// PortRef mirror any more, and the fan-out's `shardSourcePort` is the only
// node-level patch a connection can carry.

import {
  REVIEW_INPUT_PORT_NAME,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  planWorkflowConnection,
  type WorkflowSemanticContext,
} from '../src/lib/workflow-connection-plan'
import { applyWorkflowTransition } from '../src/lib/workflow-transition'

function node(value: Record<string, unknown>): WorkflowNode {
  return value as unknown as WorkflowNode
}

function agent(id: string, agentName = id): WorkflowNode {
  return node({ id, kind: 'agent-single', agentId: agentName, agentName })
}

function definition(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = [],
  outputs?: WorkflowDefinition['outputs'],
): WorkflowDefinition {
  return {
    $schema_version: 6,
    inputs: [],
    nodes,
    edges,
    ...(outputs !== undefined ? { outputs } : {}),
  }
}

function context(
  agentsByName: WorkflowSemanticContext['agentsByName'] = {},
  inventoryRevision = 'inventory-1',
): WorkflowSemanticContext {
  return { agentsByName, inventoryRevision }
}

function readNode(def: WorkflowDefinition, id: string): Record<string, unknown> {
  return def.nodes.find((candidate) => candidate.id === id) as unknown as Record<string, unknown>
}

const RETIRED_PORTREF_FIELDS = ['inputSource', 'ports', 'outputBindings', 'inputs'] as const

function assertNoPortRefFields(def: WorkflowDefinition): void {
  for (const candidate of def.nodes) {
    if (candidate.kind === 'input') continue
    const record = candidate as unknown as Record<string, unknown>
    for (const field of RETIRED_PORTREF_FIELDS) {
      expect(field in record, `${candidate.id}.${field} must not be written`).toBe(false)
    }
  }
}

describe('applyWorkflowTransition review semantic rename', () => {
  const semantic = context({
    single: { outputs: ['doc'], outputKinds: { doc: 'markdown' } },
    multi: { outputs: ['docs'], outputKinds: { docs: 'list<markdown>' } },
  })

  test('single → multi → single rewrites every downstream edge and definition output atomically', () => {
    const start = definition(
      [
        agent('single-source', 'single'),
        agent('multi-source', 'multi'),
        node({ id: 'review', kind: 'review' }),
        node({ id: 'output', kind: 'output' }),
        node({
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['review'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', portName: 'reviewed' },
        }),
      ],
      [
        {
          id: 'review-in',
          source: { nodeId: 'single-source', portName: 'doc' },
          target: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
        },
        {
          id: 'review-out',
          source: { nodeId: 'review', portName: 'approved_doc' },
          target: { nodeId: 'output', portName: 'reviewed' },
        },
        {
          id: 'loop-return',
          source: { nodeId: 'review', portName: 'approved_doc' },
          target: { nodeId: 'loop', portName: 'reviewed' },
          boundary: 'wrapper-output',
        },
      ],
      [{ name: 'reviewed', bind: { nodeId: 'review', portName: 'approved_doc' } }],
    )

    const toMulti = planWorkflowConnection(
      start,
      {
        kind: 'generic',
        edgeId: 'review-in-multi',
        source: { nodeId: 'multi-source', portName: 'docs' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )
    if (!toMulti.ok) throw new Error('expected multi review plan')

    const multi = applyWorkflowTransition(
      start,
      { kind: 'connection', plan: toMulti },
      semantic,
    ).next
    expect(multi.edges.filter((edge) => edge.target.nodeId === 'review')).toEqual([
      expect.objectContaining({
        id: 'review-in-multi',
        source: { nodeId: 'multi-source', portName: 'docs' },
      }),
    ])
    expect(multi.edges.find((edge) => edge.id === 'review-out')?.source.portName).toBe('accepted')
    expect(multi.edges.find((edge) => edge.id === 'loop-return')?.source.portName).toBe('accepted')
    // The loop's OWN return port name is untouched — only its source moved.
    expect(multi.edges.find((edge) => edge.id === 'loop-return')?.target.portName).toBe('reviewed')
    expect(readNode(multi, 'loop').exitCondition).toEqual({
      kind: 'port-empty',
      portName: 'reviewed',
    })
    expect(multi.outputs).toEqual([
      { name: 'reviewed', bind: { nodeId: 'review', portName: 'accepted' } },
    ])
    assertNoPortRefFields(multi)

    const toSingle = planWorkflowConnection(
      multi,
      {
        kind: 'generic',
        edgeId: 'review-in-single',
        source: { nodeId: 'single-source', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )
    if (!toSingle.ok) throw new Error('expected single review plan')
    const roundTrip = applyWorkflowTransition(
      multi,
      { kind: 'connection', plan: toSingle },
      semantic,
    ).next

    expect(roundTrip.edges.find((edge) => edge.id === 'review-out')?.source.portName).toBe(
      'approved_doc',
    )
    expect(roundTrip.edges.find((edge) => edge.id === 'loop-return')?.source.portName).toBe(
      'approved_doc',
    )
    expect(roundTrip.outputs?.[0]?.bind.portName).toBe('approved_doc')
    assertNoPortRefFields(roundTrip)
  })
})

describe('applyWorkflowTransition graph reconciliation', () => {
  test('rejects a connection plan when either its graph or inventory snapshot is stale', () => {
    const start = definition([agent('source'), agent('target')])
    const semantic = context()
    const plan = planWorkflowConnection(
      start,
      {
        kind: 'generic',
        source: { nodeId: 'source', portName: 'result' },
        targetNodeId: 'target',
        target: { mode: 'new', portName: 'result' },
      },
      semantic,
    )
    if (!plan.ok) throw new Error('expected connection plan')

    const changed: WorkflowDefinition = {
      ...start,
      inputs: [{ key: 'late_input', label: 'Late input', kind: 'text' }],
    }
    const graphResult = applyWorkflowTransition(changed, { kind: 'connection', plan }, semantic)
    expect(graphResult.next).toBe(changed)
    expect(graphResult.warnings).toContainEqual(
      expect.objectContaining({ code: 'connection-plan-graph-stale' }),
    )

    const inventoryResult = applyWorkflowTransition(
      start,
      { kind: 'connection', plan },
      context({}, 'inventory-2'),
    )
    expect(inventoryResult.next).toBe(start)
    expect(inventoryResult.warnings).toContainEqual(
      expect.objectContaining({ code: 'connection-plan-context-stale' }),
    )
  })

  test('review and output connections write edges only — never a v5 PortRef mirror', () => {
    const start = definition(
      [
        agent('old'),
        agent('fresh'),
        node({ id: 'review', kind: 'review' }),
        node({ id: 'output', kind: 'output' }),
      ],
      [
        {
          id: 'old-review',
          source: { nodeId: 'old', portName: 'doc' },
          target: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
        },
        {
          id: 'old-output',
          source: { nodeId: 'old', portName: 'doc' },
          target: { nodeId: 'output', portName: 'report' },
        },
      ],
    )
    const semantic = context()
    const reviewPlan = planWorkflowConnection(
      start,
      {
        kind: 'generic',
        edgeId: 'fresh-review',
        source: { nodeId: 'fresh', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )
    if (!reviewPlan.ok) throw new Error('expected review plan')
    const reviewResult = applyWorkflowTransition(
      start,
      { kind: 'connection', plan: reviewPlan },
      semantic,
    )
    expect(reviewResult.next.edges.filter((edge) => edge.target.nodeId === 'review')).toEqual([
      expect.objectContaining({
        id: 'fresh-review',
        source: { nodeId: 'fresh', portName: 'doc' },
        target: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
      }),
    ])

    const outputPlan = planWorkflowConnection(
      reviewResult.next,
      {
        kind: 'generic',
        edgeId: 'fresh-output',
        source: { nodeId: 'fresh', portName: 'doc' },
        targetNodeId: 'output',
        target: { mode: 'new', portName: 'report' },
      },
      semantic,
    )
    if (!outputPlan.ok) throw new Error('expected output plan')
    const outputResult = applyWorkflowTransition(
      reviewResult.next,
      { kind: 'connection', plan: outputPlan },
      semantic,
    )
    // NEW on a taken name lands on `report_2`; the old port keeps its edge.
    expect(
      outputResult.next.edges
        .filter((edge) => edge.target.nodeId === 'output')
        .map((edge) => [edge.id, edge.target.portName]),
    ).toEqual([
      ['old-output', 'report'],
      ['fresh-output', 'report_2'],
    ])
    assertNoPortRefFields(outputResult.next)
  })

  test('output REUSE replaces the occupying edge once without any node declaration', () => {
    const start = definition(
      [agent('source'), agent('prior'), node({ id: 'output', kind: 'output' })],
      [
        {
          id: 'old',
          source: { nodeId: 'prior', portName: 'old' },
          target: { nodeId: 'output', portName: 'report' },
        },
      ],
    )
    const semantic = context()
    const plan = planWorkflowConnection(
      start,
      {
        kind: 'generic',
        edgeId: 'fresh',
        source: { nodeId: 'source', portName: 'report' },
        targetNodeId: 'output',
        target: { mode: 'reuse', portName: 'report' },
      },
      semantic,
    )
    if (!plan.ok) throw new Error('expected output plan')

    const next = applyWorkflowTransition(start, { kind: 'connection', plan }, semantic).next
    expect(next.edges).toEqual([
      {
        id: 'fresh',
        source: { nodeId: 'source', portName: 'report' },
        target: { nodeId: 'output', portName: 'report' },
      },
    ])
    expect(readNode(next, 'output')).toEqual({ id: 'output', kind: 'output' })
  })

  test('a disappeared derived fan-out outlet prunes ghost edges', () => {
    const start = definition(
      [
        agent('aggregator', 'agg'),
        node({
          id: 'fanout',
          kind: 'wrapper-fanout',
          nodeIds: ['aggregator'],
          shardSourcePort: 'docs',
        }),
        node({ id: 'output', kind: 'output' }),
      ],
      [
        {
          id: 'ghost-after-change',
          source: { nodeId: 'fanout', portName: 'promoted' },
          target: { nodeId: 'output', portName: 'report' },
        },
      ],
    )
    const semantic = context({
      agg: {
        role: 'aggregator',
        outputs: ['raw'],
        outputKinds: { raw: 'markdown' },
        outputWrapperPortNames: { raw: 'promoted' },
      },
    })
    const changed: WorkflowDefinition = {
      ...start,
      nodes: start.nodes.map((candidate) =>
        candidate.id === 'fanout'
          ? (node({ ...candidate, nodeIds: [] }) as WorkflowNode)
          : candidate,
      ),
    }

    const result = applyWorkflowTransition(
      start,
      { kind: 'replace-definition', next: changed },
      semantic,
    )

    expect(result.next.edges).toEqual([])
    expect(readNode(result.next, 'output')).toEqual({ id: 'output', kind: 'output' })
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'disappeared-port-reference-pruned',
        edgeId: 'ghost-after-change',
      }),
    )
  })

  test('removing a loop return edge prunes the downstream edge that read the return', () => {
    const start = definition(
      [
        agent('worker'),
        node({
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', portName: 'final' },
        }),
        agent('consumer'),
      ],
      [
        {
          id: 'return',
          source: { nodeId: 'worker', portName: 'out' },
          target: { nodeId: 'loop', portName: 'final' },
          boundary: 'wrapper-output',
        },
        {
          id: 'downstream',
          source: { nodeId: 'loop', portName: 'final' },
          target: { nodeId: 'consumer', portName: 'final' },
        },
      ],
    )
    const result = applyWorkflowTransition(
      start,
      { kind: 'delete-selection', nodeIds: [], edgeIds: ['return'] },
      context(),
    )
    expect(result.next.edges).toEqual([])
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'disappeared-port-reference-pruned', edgeId: 'downstream' }),
    )
  })

  test('removing either clarify half removes its sibling in the same transaction', () => {
    const start = definition(
      [agent('questioner'), node({ id: 'clarify', kind: 'clarify' })],
      [
        {
          id: 'ask',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'clarify', portName: 'questions' },
        },
        {
          id: 'answer',
          source: { nodeId: 'clarify', portName: 'answers' },
          target: { nodeId: 'questioner', portName: '__clarify_response__' },
        },
      ],
    )
    const result = applyWorkflowTransition(
      start,
      { kind: 'replace-definition', next: { ...start, edges: [start.edges[1]!] } },
      context(),
    )
    expect(result.next.edges).toEqual([])
  })

  test('member deletion refits unlocked wrappers and preserves locked wrapper dimensions', () => {
    const start = definition([
      agent('open-child'),
      agent('locked-child'),
      node({
        id: 'open-wrapper',
        kind: 'wrapper-git',
        nodeIds: ['open-child'],
        size: { width: 500, height: 300 },
      }),
      node({
        id: 'locked-wrapper',
        kind: 'wrapper-loop',
        nodeIds: ['locked-child'],
        size: { width: 700, height: 450, sizeLocked: true },
      }),
    ])

    const result = applyWorkflowTransition(
      start,
      {
        kind: 'delete-selection',
        nodeIds: ['open-child', 'locked-child'],
        edgeIds: [],
      },
      context(),
    )
    expect(readNode(result.next, 'open-wrapper').nodeIds).toEqual([])
    expect(readNode(result.next, 'open-wrapper').size).toBeUndefined()
    expect(readNode(result.next, 'locked-wrapper').nodeIds).toEqual([])
    expect(readNode(result.next, 'locked-wrapper').size).toEqual({
      width: 700,
      height: 450,
      sizeLocked: true,
    })
  })

  test('output target rename moves every edge on that port name atomically', () => {
    const start = definition(
      [agent('a'), agent('b'), node({ id: 'output', kind: 'output' })],
      [
        {
          id: 'selected',
          source: { nodeId: 'a', portName: 'result' },
          target: { nodeId: 'output', portName: 'old' },
        },
        {
          id: 'same-declaration',
          source: { nodeId: 'b', portName: 'result' },
          target: { nodeId: 'output', portName: 'old' },
        },
      ],
    )
    const result = applyWorkflowTransition(
      start,
      { kind: 'rename-edge-target-port', edgeId: 'selected', portName: 'renamed' },
      context(),
    )
    expect(result.warnings).toEqual([])
    expect(result.next.edges.map((edge) => edge.target.portName)).toEqual(['renamed', 'renamed'])
    expect(readNode(result.next, 'output')).toEqual({ id: 'output', kind: 'output' })
  })

  test('output target rename onto a name another edge uses is refused', () => {
    const start = definition(
      [agent('a'), agent('b'), node({ id: 'output', kind: 'output' })],
      [
        {
          id: 'selected',
          source: { nodeId: 'a', portName: 'result' },
          target: { nodeId: 'output', portName: 'old' },
        },
        {
          id: 'taken',
          source: { nodeId: 'b', portName: 'result' },
          target: { nodeId: 'output', portName: 'renamed' },
        },
      ],
    )
    const result = applyWorkflowTransition(
      start,
      { kind: 'rename-edge-target-port', edgeId: 'selected', portName: 'renamed' },
      context(),
    )
    expect(result.next).toBe(start)
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'edge-target-port-conflict' }),
    )
  })

  test('fan-out parameter rename moves the outer edge, the boundary source and shardSourcePort', () => {
    const start = definition(
      [
        agent('outer'),
        agent('inner'),
        node({
          id: 'fanout',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          shardSourcePort: 'items',
        }),
      ],
      [
        {
          id: 'outer-edge',
          source: { nodeId: 'outer', portName: 'items' },
          target: { nodeId: 'fanout', portName: 'items' },
        },
        {
          id: 'boundary-edge',
          source: { nodeId: 'fanout', portName: 'items' },
          target: { nodeId: 'inner', portName: 'item' },
          boundary: 'wrapper-input',
        },
      ],
    )
    const result = applyWorkflowTransition(
      start,
      { kind: 'rename-edge-target-port', edgeId: 'outer-edge', portName: 'records' },
      context(),
    )
    expect(readNode(result.next, 'fanout').shardSourcePort).toBe('records')
    expect(result.next.edges[0]?.target.portName).toBe('records')
    expect(result.next.edges[1]?.source.portName).toBe('records')
  })

  test('wrapper-git parameter rename moves the parameter edge and its wrapper-input hand-off', () => {
    const start = definition(
      [
        agent('outer'),
        agent('inner'),
        node({ id: 'git', kind: 'wrapper-git', nodeIds: ['inner'] }),
      ],
      [
        {
          id: 'param',
          source: { nodeId: 'outer', portName: 'spec' },
          target: { nodeId: 'git', portName: 'spec' },
        },
        {
          id: 'handoff',
          source: { nodeId: 'git', portName: 'spec' },
          target: { nodeId: 'inner', portName: 'spec' },
          boundary: 'wrapper-input',
        },
      ],
    )
    const result = applyWorkflowTransition(
      start,
      { kind: 'rename-edge-target-port', edgeId: 'param', portName: 'brief' },
      context(),
    )
    expect(result.warnings).toEqual([])
    expect(
      result.next.edges.map((edge) => [edge.id, edge.source.portName, edge.target.portName]),
    ).toEqual([
      ['param', 'spec', 'brief'],
      ['handoff', 'brief', 'spec'],
    ])
  })

  test('review and boundary target ports reject arbitrary rename with zero mutation', () => {
    const start = definition(
      [
        agent('source'),
        node({ id: 'review', kind: 'review' }),
        node({
          id: 'fanout',
          kind: 'wrapper-fanout',
          nodeIds: ['source'],
          shardSourcePort: 'items',
        }),
      ],
      [
        {
          id: 'review-edge',
          source: { nodeId: 'source', portName: 'doc' },
          target: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
        },
        {
          id: 'boundary-edge',
          source: { nodeId: 'fanout', portName: 'items' },
          target: { nodeId: 'source', portName: 'item' },
          boundary: 'wrapper-input',
        },
      ],
    )
    for (const edgeId of ['review-edge', 'boundary-edge']) {
      const result = applyWorkflowTransition(
        start,
        { kind: 'rename-edge-target-port', edgeId, portName: 'renamed' },
        context(),
      )
      expect(result.next).toBe(start)
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'edge-target-port-rename-blocked' }),
      )
    }
  })
})

describe('RFC-354 — the reconciler carries no v5 PortRef write', () => {
  test('workflow-transition.ts source has no inputSource / ports / outputBindings / inputs write', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'lib', 'workflow-transition.ts'),
      'utf8',
    )
    expect(src).not.toMatch(/inputSource/)
    expect(src).not.toMatch(/outputBindings/)
    expect(src).not.toMatch(/\bports\s*:/)
    expect(src).not.toMatch(/\binputs\s*:\s*patch/)
    expect(src).not.toMatch(/set-review-input-source|set-output-ports|set-fanout-inputs/)
  })
})
