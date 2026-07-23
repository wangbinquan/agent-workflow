// RFC-199 B5 — all graph semantics are applied once by one reconciler.

import {
  REVIEW_INPUT_PORT_NAME,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agent-workflow/shared'
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
    $schema_version: 4,
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

describe('applyWorkflowTransition review semantic rename', () => {
  const semantic = context({
    single: { outputs: ['doc'], outputKinds: { doc: 'markdown' } },
    multi: { outputs: ['docs'], outputKinds: { docs: 'list<markdown>' } },
  })

  test('single → multi → single rewrites all downstream PortRefs atomically', () => {
    const start = definition(
      [
        agent('single-source', 'single'),
        agent('multi-source', 'multi'),
        node({
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'single-source', portName: 'doc' },
        }),
        node({
          id: 'output',
          kind: 'output',
          ports: [{ name: 'reviewed', bind: { nodeId: 'review', portName: 'approved_doc' } }],
        }),
        node({
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: [],
          exitCondition: { kind: 'port-empty', nodeId: 'review', portName: 'approved_doc' },
          outputBindings: [
            { name: 'reviewed', bind: { nodeId: 'review', portName: 'approved_doc' } },
          ],
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

    const multiResult = applyWorkflowTransition(
      start,
      { kind: 'connection', plan: toMulti },
      semantic,
    )
    const multi = multiResult.next
    expect(readNode(multi, 'review').inputSource).toEqual({
      nodeId: 'multi-source',
      portName: 'docs',
    })
    expect(multi.edges.find((edge) => edge.id === 'review-out')?.source.portName).toBe('accepted')
    expect(readNode(multi, 'output').ports).toEqual([
      { name: 'reviewed', bind: { nodeId: 'review', portName: 'accepted' } },
    ])
    expect(readNode(multi, 'loop').exitCondition).toEqual({
      kind: 'port-empty',
      nodeId: 'review',
      portName: 'accepted',
    })
    expect(readNode(multi, 'loop').outputBindings).toEqual([
      { name: 'reviewed', bind: { nodeId: 'review', portName: 'accepted' } },
    ])
    expect(multi.outputs).toEqual([
      { name: 'reviewed', bind: { nodeId: 'review', portName: 'accepted' } },
    ])

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
    expect(readNode(roundTrip, 'output').ports).toEqual([
      { name: 'reviewed', bind: { nodeId: 'review', portName: 'approved_doc' } },
    ])
    expect(roundTrip.outputs?.[0]?.bind.portName).toBe('approved_doc')
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

  test('review and output form transitions canonicalize mirrors without duplicate edges', () => {
    const start = definition(
      [
        agent('old'),
        agent('fresh'),
        node({
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'old', portName: 'doc' },
        }),
        node({
          id: 'output',
          kind: 'output',
          ports: [{ name: 'report', bind: { nodeId: 'old', portName: 'doc' } }],
        }),
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

    const reviewResult = applyWorkflowTransition(
      start,
      {
        kind: 'set-review-input-source',
        reviewNodeId: 'review',
        inputSource: { nodeId: 'fresh', portName: 'doc' },
      },
      context(),
    )
    expect(readNode(reviewResult.next, 'review').inputSource).toEqual({
      nodeId: 'fresh',
      portName: 'doc',
    })
    expect(reviewResult.next.edges.filter((edge) => edge.target.nodeId === 'review')).toEqual([
      expect.objectContaining({
        source: { nodeId: 'fresh', portName: 'doc' },
        target: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
      }),
    ])

    const outputResult = applyWorkflowTransition(
      reviewResult.next,
      {
        kind: 'set-output-ports',
        outputNodeId: 'output',
        ports: [
          { name: 'report', bind: { nodeId: 'fresh', portName: 'doc' } },
          { name: 'empty', bind: { nodeId: '', portName: '' } },
        ],
      },
      context(),
    )
    expect(readNode(outputResult.next, 'output').ports).toEqual([
      { name: 'report', bind: { nodeId: 'fresh', portName: 'doc' } },
      { name: 'empty', bind: { nodeId: '', portName: '' } },
    ])
    expect(outputResult.next.edges.filter((edge) => edge.target.nodeId === 'output')).toEqual([
      expect.objectContaining({
        source: { nodeId: 'fresh', portName: 'doc' },
        target: { nodeId: 'output', portName: 'report' },
      }),
    ])
  })

  test('output NEW/REUSE updates edge and bind once without duplicate declarations', () => {
    const start = definition(
      [
        agent('source'),
        agent('prior'),
        node({
          id: 'output',
          kind: 'output',
          ports: [{ name: 'report', bind: { nodeId: 'prior', portName: 'old' } }],
        }),
      ],
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
    expect(readNode(next, 'output').ports).toEqual([
      { name: 'report', bind: { nodeId: 'source', portName: 'report' } },
    ])
  })

  test('a disappeared derived fan-out outlet prunes ghost edges and mirrors', () => {
    const start = definition(
      [
        agent('aggregator', 'agg'),
        node({ id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['aggregator'], inputs: [] }),
        node({
          id: 'output',
          kind: 'output',
          ports: [{ name: 'report', bind: { nodeId: 'fanout', portName: 'promoted' } }],
        }),
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
    expect(readNode(result.next, 'output').ports).toEqual([
      { name: 'report', bind: { nodeId: '', portName: '' } },
    ])
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'disappeared-port-reference-pruned',
        edgeId: 'ghost-after-change',
      }),
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

  test('output target rename updates its declaration and every matching edge atomically', () => {
    const start = definition(
      [
        agent('a'),
        agent('b'),
        node({
          id: 'output',
          kind: 'output',
          ports: [{ name: 'old', bind: { nodeId: 'a', portName: 'result' } }],
        }),
      ],
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
    expect(readNode(result.next, 'output').ports).toEqual([
      { name: 'renamed', bind: { nodeId: 'a', portName: 'result' } },
    ])
    expect(result.next.edges.map((edge) => edge.target.portName)).toEqual(['renamed', 'renamed'])
  })

  test('fan-out input rename updates the declaration, outer edge, and boundary source', () => {
    const start = definition(
      [
        agent('outer'),
        agent('inner'),
        node({
          id: 'fanout',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
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
    expect(readNode(result.next, 'fanout').inputs).toEqual([
      { name: 'records', kind: 'list<string>', isShardSource: true },
    ])
    expect(result.next.edges[0]?.target.portName).toBe('records')
    expect(result.next.edges[1]?.source.portName).toBe('records')
  })

  test('review and boundary target ports reject arbitrary rename with zero mutation', () => {
    const start = definition(
      [
        agent('source'),
        node({
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'source', portName: 'doc' },
        }),
        node({ id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['source'], inputs: [] }),
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
