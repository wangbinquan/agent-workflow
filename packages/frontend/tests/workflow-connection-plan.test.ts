// RFC-199 B5 — the connection planner is the shared, immutable semantic
// oracle for drag adapters and the guided Connection Dialog.

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

function node(value: Record<string, unknown>): WorkflowNode {
  return value as unknown as WorkflowNode
}

function agent(id: string, agentName = id): WorkflowNode {
  return node({ id, kind: 'agent-single', agentId: agentName, agentName, position: { x: 0, y: 0 } })
}

function definition(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges }
}

function context(
  agentsByName: WorkflowSemanticContext['agentsByName'] = {},
  inventoryRevision = 'inventory-1',
): WorkflowSemanticContext {
  return { agentsByName, inventoryRevision }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
}

describe('planWorkflowConnection generic contract', () => {
  test('REUSE replaces the occupied input without mutating the definition', () => {
    const occupied: WorkflowEdge = {
      id: 'occupied',
      source: { nodeId: 'prior', portName: 'result' },
      target: { nodeId: 'target', portName: 'requirement' },
    }
    const def = definition([agent('source'), agent('prior'), agent('target')], [occupied])
    deepFreeze(def)

    const plan = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        edgeId: 'fresh',
        source: { nodeId: 'source', portName: 'result' },
        targetNodeId: 'target',
        target: { mode: 'reuse', portName: 'requirement' },
      },
      context(),
    )

    expect(plan).toMatchObject({
      ok: true,
      removeEdgeIds: ['occupied'],
      compatibility: 'compatible',
      contextRevision: 'inventory-1',
      preview: { replacedEdgeIds: ['occupied'] },
    })
    if (!plan.ok) throw new Error('expected a valid plan')
    expect(plan.addEdges).toEqual([
      {
        id: 'fresh',
        source: { nodeId: 'source', portName: 'result' },
        target: { nodeId: 'target', portName: 'requirement' },
      },
    ])
    expect(def.edges).toEqual([occupied])
  })

  test('NEW allocates a separate input and an ordinary cycle is advisory only', () => {
    const def = definition(
      [agent('a'), agent('b')],
      [
        {
          id: 'back-path',
          source: { nodeId: 'b', portName: 'out' },
          target: { nodeId: 'a', portName: 'in' },
        },
      ],
    )
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        edgeId: 'cycle-edge',
        source: { nodeId: 'a', portName: 'out' },
        targetNodeId: 'b',
        target: { mode: 'new', portName: 'out_2' },
      },
      context(),
    )

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.removeEdgeIds).toEqual([])
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'topology-cycle' }))
  })

  test('missing, self and exact duplicate stay structural blockers', () => {
    const duplicate: WorkflowEdge = {
      id: 'same',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'in' },
    }
    const def = definition([agent('a'), agent('b')], [duplicate])

    expect(
      planWorkflowConnection(
        def,
        {
          kind: 'generic',
          source: { nodeId: '', portName: 'out' },
          targetNodeId: 'b',
          target: { mode: 'reuse', portName: 'in' },
        },
        context(),
      ),
    ).toMatchObject({ ok: false, reason: { code: 'connection-endpoint-missing' } })
    expect(
      planWorkflowConnection(
        def,
        {
          kind: 'generic',
          source: { nodeId: 'a', portName: 'out' },
          targetNodeId: 'a',
          target: { mode: 'reuse', portName: 'in' },
        },
        context(),
      ),
    ).toMatchObject({ ok: false, reason: { code: 'connection-self-loop' } })
    expect(
      planWorkflowConnection(
        def,
        {
          kind: 'generic',
          source: duplicate.source,
          targetNodeId: duplicate.target.nodeId,
          target: { mode: 'reuse', portName: duplicate.target.portName },
        },
        context(),
      ),
    ).toMatchObject({ ok: false, reason: { code: 'connection-exact-duplicate' } })
  })
})

describe('planWorkflowConnection fixed review policy', () => {
  const def = definition(
    [
      agent('markdown-source', 'markdown-agent'),
      agent('list-source', 'list-agent'),
      agent('string-source', 'string-agent'),
      agent('unloaded-source', 'missing-agent'),
      node({ id: 'malformed-source', kind: 'agent-single' }),
      node({ id: 'plain-input', kind: 'input', inputKey: 'doc' }),
      node({
        id: 'review',
        kind: 'review',
        inputSource: { nodeId: 'markdown-source', portName: 'doc' },
      }),
    ],
    [
      {
        id: 'occupied-review',
        source: { nodeId: 'markdown-source', portName: 'doc' },
        target: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
      },
    ],
  )
  const semantic = context({
    'markdown-agent': { outputs: ['doc'], outputKinds: { doc: 'markdown' } },
    'list-agent': { outputs: ['docs'], outputKinds: { docs: 'list<path<md>>' } },
    'string-agent': { outputs: ['text'], outputKinds: { text: 'string' } },
  })

  test('accepts a declared markdown list and previews approved_doc → accepted', () => {
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        edgeId: 'review-edge',
        source: { nodeId: 'list-source', portName: 'docs' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )

    expect(plan).toMatchObject({
      ok: true,
      compatibility: 'compatible',
      removeEdgeIds: ['occupied-review'],
      preview: {
        semanticPortRenames: [
          { nodeId: 'review', fromPortName: 'approved_doc', toPortName: 'accepted' },
        ],
      },
    })
  })

  test('known non-markdown is incompatible while unloaded inventory is unknown', () => {
    const known = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        source: { nodeId: 'string-source', portName: 'text' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )
    const unknown = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        source: { nodeId: 'unloaded-source', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )

    expect(known).toMatchObject({ ok: true, compatibility: 'incompatible' })
    expect(unknown).toMatchObject({ ok: true, compatibility: 'unknown' })
  })

  test('non-agent/malformed sources are incompatible and refreshed inventory recomputes unknown', () => {
    const nonAgent = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        source: { nodeId: 'plain-input', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )
    const beforeLoad = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        source: { nodeId: 'unloaded-source', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      context({}, 'inventory-old'),
    )
    const malformed = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        source: { nodeId: 'malformed-source', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      semantic,
    )
    const afterLoad = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        source: { nodeId: 'unloaded-source', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'reuse', portName: REVIEW_INPUT_PORT_NAME },
      },
      context(
        { 'missing-agent': { outputs: ['doc'], outputKinds: { doc: 'path<md>' } } },
        'inventory-new',
      ),
    )
    expect(nonAgent).toMatchObject({ ok: true, compatibility: 'incompatible' })
    expect(malformed).toMatchObject({ ok: true, compatibility: 'incompatible' })
    expect(beforeLoad).toMatchObject({
      ok: true,
      compatibility: 'unknown',
      contextRevision: 'inventory-old',
    })
    expect(afterLoad).toMatchObject({
      ok: true,
      compatibility: 'compatible',
      contextRevision: 'inventory-new',
    })
  })

  test('review rejects NEW or a non-fixed target port', () => {
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'generic',
        source: { nodeId: 'markdown-source', portName: 'doc' },
        targetNodeId: 'review',
        target: { mode: 'new', portName: 'other' },
      },
      semantic,
    )
    expect(plan).toMatchObject({ ok: false, reason: { code: 'review-fixed-input-required' } })
  })
})

describe('planWorkflowConnection domain requests', () => {
  test('clarify questioner materializes the paired channel atomically', () => {
    const def = definition([agent('questioner'), node({ id: 'clarify', kind: 'clarify' })])
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'clarify-questioner',
        questionerNodeId: 'questioner',
        clarifyNodeId: 'clarify',
        edgeIds: { ask: 'ask', answer: 'answer' },
      },
      context(),
    )
    expect(plan).toMatchObject({ ok: true, compatibility: 'compatible' })
    if (!plan.ok) return
    expect(plan.addEdges).toEqual([
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
    ])
  })

  test('fan-out input requires a legal shard and demotes every prior shard immutably', () => {
    const fanout = node({
      id: 'fanout',
      kind: 'wrapper-fanout',
      nodeIds: ['inner'],
      inputs: [
        { name: 'old_a', kind: 'list<string>', isShardSource: true },
        { name: 'old_b', kind: 'list<string>', isShardSource: true },
      ],
    })
    const def = definition([agent('outer'), agent('inner'), fanout])
    deepFreeze(def)

    const blocked = planWorkflowConnection(
      def,
      {
        kind: 'fanout-boundary-input',
        wrapperNodeId: 'fanout',
        outerEndpoint: { nodeId: 'outer', portName: 'items' },
        innerEndpoint: { nodeId: 'inner', portName: 'item' },
        port: { portName: 'next', kind: 'string', role: 'shard' },
      },
      context(),
    )
    expect(blocked).toMatchObject({ ok: false, reason: { code: 'fanout-shard-kind-not-list' } })

    const plan = planWorkflowConnection(
      def,
      {
        kind: 'fanout-boundary-input',
        wrapperNodeId: 'fanout',
        outerEndpoint: { nodeId: 'outer', portName: 'items' },
        innerEndpoint: { nodeId: 'inner', portName: 'item' },
        port: { portName: 'next', kind: 'list<string>', role: 'shard' },
        edgeIds: { outer: 'outer-edge', boundary: 'boundary-edge' },
      },
      context({ outer: { outputs: ['items'], outputKinds: { items: 'list<string>' } } }),
    )

    expect(plan).toMatchObject({ ok: true, compatibility: 'compatible' })
    if (!plan.ok) return
    expect(plan.nodePatches).toEqual([
      {
        kind: 'set-fanout-inputs',
        wrapperNodeId: 'fanout',
        inputs: [
          { name: 'old_a', kind: 'list<string>' },
          { name: 'old_b', kind: 'list<string>' },
          { name: 'next', kind: 'list<string>', isShardSource: true },
        ],
      },
    ])
    expect(plan.addEdges).toEqual([
      {
        id: 'outer-edge',
        source: { nodeId: 'outer', portName: 'items' },
        target: { nodeId: 'fanout', portName: 'next' },
      },
      {
        id: 'boundary-edge',
        source: { nodeId: 'fanout', portName: 'next' },
        target: { nodeId: 'inner', portName: 'item' },
        boundary: 'wrapper-input',
      },
    ])
  })

  test('a broadcast cannot leave a wrapper with no shard source', () => {
    const def = definition([
      agent('outer'),
      agent('inner'),
      node({ id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['inner'], inputs: [] }),
    ])
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'fanout-boundary-input',
        wrapperNodeId: 'fanout',
        outerEndpoint: { nodeId: 'outer', portName: 'context' },
        innerEndpoint: { nodeId: 'inner', portName: 'context' },
        port: { portName: 'context', kind: 'string', role: 'broadcast' },
      },
      context(),
    )
    expect(plan).toMatchObject({ ok: false, reason: { code: 'fanout-shard-source-missing' } })
  })

  test('a broadcast preserves the one existing shard and checks the outer kind', () => {
    const def = definition([
      agent('outer'),
      agent('inner'),
      node({
        id: 'fanout',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
      }),
    ])
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'fanout-boundary-input',
        wrapperNodeId: 'fanout',
        outerEndpoint: { nodeId: 'outer', portName: 'context' },
        innerEndpoint: { nodeId: 'inner', portName: 'context' },
        port: { portName: 'context', kind: 'string', role: 'broadcast' },
      },
      context({ outer: { outputs: ['context'], outputKinds: { context: 'string' } } }),
    )
    expect(plan).toMatchObject({ ok: true, compatibility: 'compatible' })
    if (!plan.ok) return
    expect(plan.nodePatches).toEqual([
      {
        kind: 'set-fanout-inputs',
        wrapperNodeId: 'fanout',
        inputs: [
          { name: 'items', kind: 'list<string>', isShardSource: true },
          { name: 'context', kind: 'string' },
        ],
      },
    ])
  })

  test('fan-out output request encodes inner boundary and outer connection sides explicitly', () => {
    const def = definition([
      agent('inner'),
      agent('outer'),
      node({ id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['inner'], inputs: [] }),
    ])
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'fanout-boundary-output',
        wrapperNodeId: 'fanout',
        innerEndpoint: { nodeId: 'inner', portName: 'summary' },
        outerEndpoint: { nodeId: 'outer', portName: 'summary' },
        port: { portName: 'promoted', kind: 'markdown' },
        edgeIds: { boundary: 'boundary', outer: 'outer' },
      },
      context({
        inner: {
          role: 'aggregator',
          outputs: ['summary'],
          outputKinds: { summary: 'markdown' },
          outputWrapperPortNames: { summary: 'promoted' },
        },
      }),
    )
    expect(plan).toMatchObject({ ok: true, compatibility: 'compatible' })
    if (!plan.ok) return
    expect(plan.addEdges).toEqual([
      {
        id: 'boundary',
        source: { nodeId: 'inner', portName: 'summary' },
        target: { nodeId: 'fanout', portName: 'promoted' },
        boundary: 'wrapper-output',
      },
      {
        id: 'outer',
        source: { nodeId: 'fanout', portName: 'promoted' },
        target: { nodeId: 'outer', portName: 'summary' },
      },
    ])
  })

  test('fan-out output reports an undeclared or mismapped aggregator output as incompatible', () => {
    const def = definition([
      agent('inner'),
      agent('outer'),
      node({ id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['inner'], inputs: [] }),
    ])
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'fanout-boundary-output',
        wrapperNodeId: 'fanout',
        innerEndpoint: { nodeId: 'inner', portName: 'missing' },
        outerEndpoint: { nodeId: 'outer', portName: 'summary' },
        port: { portName: 'promoted', kind: 'markdown' },
      },
      context({
        inner: {
          role: 'aggregator',
          outputs: ['summary'],
          outputKinds: { summary: 'markdown' },
          outputWrapperPortNames: { summary: 'promoted' },
        },
      }),
    )
    expect(plan).toMatchObject({ ok: true, compatibility: 'incompatible' })
  })

  test('fan-out output also applies fixed target authority to its outer connection', () => {
    const def = definition([
      agent('inner'),
      node({ id: 'review', kind: 'review', inputSource: { nodeId: '', portName: '' } }),
      node({ id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['inner'], inputs: [] }),
    ])
    const plan = planWorkflowConnection(
      def,
      {
        kind: 'fanout-boundary-output',
        wrapperNodeId: 'fanout',
        innerEndpoint: { nodeId: 'inner', portName: 'summary' },
        outerEndpoint: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
        port: { portName: 'summary', kind: 'markdown' },
      },
      context({
        inner: {
          role: 'aggregator',
          outputs: ['summary'],
          outputKinds: { summary: 'markdown' },
        },
      }),
    )
    expect(plan).toMatchObject({ ok: true, compatibility: 'incompatible' })
  })
})
