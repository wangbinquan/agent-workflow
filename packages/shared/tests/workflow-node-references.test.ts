// RFC-199 T7.1 — node-reference inventory regressions.
// Locks recursive wrapper closure, full-idMap clipboard rewrite, survivor-set
// delete pruning, edge / top-level-output port rename, passthrough ratchet, and
// deep immutability. Frontend clipboard/history wiring is deliberately out of
// scope. RFC-354 (schema v6): node-level PortRef fields are gone — the only
// inventoried node references are node-id lists; PortRefs live on edges and
// top-level outputs, which the transforms handle directly.

import { describe, expect, test } from 'bun:test'
import {
  NODE_KIND,
  WORKFLOW_NODE_REFERENCE_INVENTORY,
  WorkflowNodeSchema,
  collectNodeReferenceClosure,
  pruneDeletedNodeReferences,
  pruneWorkflowPortReferences,
  rewriteCopiedNodeReferences,
  rewriteCopiedWorkflowSlice,
  rewriteWorkflowPortReferences,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../src'

function node(
  id: string,
  kind: WorkflowNode['kind'],
  fields: Record<string, unknown> = {},
): WorkflowNode {
  return { id, kind, ...fields } as WorkflowNode
}

function edge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  boundary?: WorkflowEdge['boundary'],
): WorkflowEdge {
  return {
    id,
    source: { nodeId: sourceNodeId, portName: 'out' },
    target: { nodeId: targetNodeId, portName: 'in' },
    ...(boundary !== undefined ? { boundary } : {}),
  }
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

describe('WORKFLOW_NODE_REFERENCE_INVENTORY ratchets', () => {
  test('inventory is exhaustive for the complete NodeKind universe', () => {
    expect(Object.keys(WORKFLOW_NODE_REFERENCE_INVENTORY).sort()).toEqual([...NODE_KIND].sort())
  })

  test('no kind declares a node-level PortRef field any more (RFC-354 schema v6)', () => {
    for (const descriptor of Object.values(WORKFLOW_NODE_REFERENCE_INVENTORY)) {
      expect(Object.keys(descriptor).sort()).toEqual(
        'opaqueFields' in descriptor ? ['nodeIdLists', 'opaqueFields'] : ['nodeIdLists'],
      )
    }
  })

  test('passthrough existing-kind reference field fails visible instead of silently leaking', () => {
    const parsed = WorkflowNodeSchema.parse({
      id: 'review',
      kind: 'review',
      rerunnableOnReject: ['inside'],
      futureSource: { nodeId: 'outside', portName: 'future' },
      mysteryNodeId: 'outside-top-level',
    })
    const result = rewriteCopiedNodeReferences(
      parsed,
      new Map([
        ['review', 'review-copy'],
        ['inside', 'inside-copy'],
      ]),
    )
    expect(result.safe).toBe(false)
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'node-reference-inventory-unmanaged',
        nodeId: 'review',
        field: 'futureSource',
        referencedNodeId: 'outside',
        action: 'abort',
      }),
    )
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'node-reference-inventory-unmanaged',
        nodeId: 'review',
        field: 'mysteryNodeId',
        referencedNodeId: 'outside-top-level',
        action: 'abort',
      }),
    )
  })

  test('a v5 PortRef field left on a node is an unmanaged reference, never silently kept', () => {
    // The v5 → v6 upgrader strips these; a document that skipped it must not
    // paste an old node id through the field the inventory no longer owns.
    const result = rewriteCopiedNodeReferences(
      node('review', 'review', { inputSource: { nodeId: 'outside', portName: 'doc' } }),
      new Map([['review', 'review-copy']]),
    )
    expect(result.safe).toBe(false)
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'node-reference-inventory-unmanaged',
        nodeId: 'review',
        field: 'inputSource',
        referencedNodeId: 'outside',
        action: 'abort',
      }),
    )
  })

  test('malformed inventoried node-id lists fail closed instead of leaking old node ids', () => {
    const cases: Array<{
      node: WorkflowNode
      field: string
      referencedNodeId: string
    }> = [
      {
        node: node('git', 'wrapper-git', {
          nodeIds: ['inside', { nodeId: 'outside-list' }],
        }),
        field: 'nodeIds[1]',
        referencedNodeId: 'outside-list',
      },
      {
        node: node('review', 'review', {
          rerunnableOnReject: [{ nodeId: 'outside-rerun' }],
        }),
        field: 'rerunnableOnReject[0]',
        referencedNodeId: 'outside-rerun',
      },
    ]
    for (const fixture of cases) {
      const result = rewriteCopiedNodeReferences(
        fixture.node,
        new Map([
          [fixture.node.id, `${fixture.node.id}-copy`],
          ['inside', 'inside-copy'],
        ]),
      )
      expect(result.safe, fixture.field).toBe(false)
      expect(result.warnings, fixture.field).toContainEqual(
        expect.objectContaining({
          code: 'node-reference-inventory-malformed',
          nodeId: fixture.node.id,
          field: fixture.field,
          referencedNodeId: fixture.referencedNodeId,
          action: 'abort',
        }),
      )
    }
  })

  test('reference-free fields do not trip the ratchet', () => {
    const fixtures = [
      node('review', 'review', { rerunnableOnReject: [], rerunnableOnIterate: [] }),
      // v6 exit condition: a predicate over the loop's own return port — no node id.
      node('loop', 'wrapper-loop', {
        nodeIds: [],
        exitCondition: { kind: 'port-equals', portName: 'verdict', value: 'STOP' },
      }),
      node('fan', 'wrapper-fanout', { nodeIds: [], shardSourcePort: 'docs' }),
    ]
    for (const fixture of fixtures) {
      const result = rewriteCopiedNodeReferences(
        fixture,
        new Map([[fixture.id, `${fixture.id}-copy`]]),
      )
      expect(result.safe, fixture.id).toBe(true)
      expect(result.warnings, fixture.id).toEqual([])
    }
  })

  test('reference-like passthrough subtrees are ratcheted at any depth', () => {
    const fixtures: Array<{ node: WorkflowNode; field: string }> = [
      {
        node: node('loop', 'wrapper-loop', {
          exitCondition: {
            kind: 'port-empty',
            portName: 'out',
            future: { nestedNodeId: 'outside' },
          },
        }),
        field: 'exitCondition.future.nestedNodeId',
      },
      {
        node: node('review', 'review', {
          policy: { source: { nodeId: 'outside', portName: 'future' } },
        }),
        field: 'policy.source',
      },
      {
        node: node('output', 'output', {
          routing: [{ target: { nodeId: 'outside', portName: 'x' } }],
        }),
        field: 'routing[].target',
      },
    ]
    for (const fixture of fixtures) {
      const result = rewriteCopiedNodeReferences(
        fixture.node,
        new Map([[fixture.node.id, `${fixture.node.id}-copy`]]),
      )
      expect(result.safe, fixture.field).toBe(false)
      expect(result.warnings, fixture.field).toContainEqual(
        expect.objectContaining({
          code: 'node-reference-inventory-unmanaged',
          nodeId: fixture.node.id,
          field: fixture.field,
          referencedNodeId: 'outside',
          action: 'abort',
        }),
      )
    }
  })
})

describe('collectNodeReferenceClosure', () => {
  test('recurses git→loop→fanout through forward refs and truncates missing/cycle refs', () => {
    const def = definition([
      node('git', 'wrapper-git', { nodeIds: ['loop', 'missing-child'] }),
      node('leaf', 'agent-single'),
      // loop/fanout are declared after their parent: the complete byId index
      // must resolve them before traversal begins.
      node('loop', 'wrapper-loop', { nodeIds: ['fanout'] }),
      node('fanout', 'wrapper-fanout', { nodeIds: ['leaf', 'git'] }),
      node('outside', 'agent-single'),
    ])

    const result = collectNodeReferenceClosure(def, ['git'])

    expect(result.nodeIds).toEqual(['git', 'leaf', 'loop', 'fanout'])
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'wrapper-child-missing',
        nodeId: 'git',
        referencedNodeId: 'missing-child',
      }),
    )
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'wrapper-membership-cycle',
        nodeId: 'fanout',
        referencedNodeId: 'git',
        cycle: ['git', 'loop', 'fanout', 'git'],
      }),
    )
  })

  test('missing selected root yields a structured warning and no fallback id', () => {
    const result = collectNodeReferenceClosure(definition([node('a', 'agent-single')]), ['ghost'])
    expect(result.nodeIds).toEqual([])
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'wrapper-child-missing',
        field: 'selection',
        referencedNodeId: 'ghost',
      }),
    ])
  })
})

describe('rewriteCopiedWorkflowSlice', () => {
  test('uses the complete idMap in a second pass, preserves boundary, and filters externals', () => {
    const source = {
      nodes: [
        node('git', 'wrapper-git', { nodeIds: ['loop', 'outside', 'legacy-missing'] }),
        node('loop', 'wrapper-loop', {
          nodeIds: ['agent'],
          exitCondition: { kind: 'port-equals', portName: 'kept', value: 'done' },
        }),
        node('review', 'review', {
          rerunnableOnReject: ['agent', 'outside'],
          rerunnableOnIterate: ['outside', 'agent'],
        }),
        node('output', 'output'),
        // Declared last to lock forward-reference rewriting.
        node('agent', 'agent-single', { metadata: { nested: { untouched: true } } }),
      ],
      edges: [
        // RFC-354: the loop return value is a wrapper-output edge (kept — inside the slice)
        edge('kept', 'agent', 'loop', 'wrapper-output'),
        // … and one bound to a node outside the slice (dropped)
        edge('cleared', 'outside', 'loop', 'wrapper-output'),
        edge('external', 'outside', 'review'),
        edge('to-output', 'agent', 'output'),
      ],
    }
    const snapshot = JSON.parse(JSON.stringify(source))
    const idMap = new Map([
      ['git', 'git-copy'],
      ['loop', 'loop-copy'],
      ['review', 'review-copy'],
      ['output', 'output-copy'],
      ['agent', 'agent-copy'],
    ])
    const result = rewriteCopiedWorkflowSlice(source, idMap)
    expect(result.safe).toBe(true)
    expect(result.nodes.map((entry) => entry.id)).toEqual([
      'git-copy',
      'loop-copy',
      'review-copy',
      'output-copy',
      'agent-copy',
    ])
    expect((result.nodes[0] as Record<string, unknown>).nodeIds).toEqual(['loop-copy'])
    const loop = result.nodes[1] as Record<string, unknown>
    expect(loop.nodeIds).toEqual(['agent-copy'])
    // The exit condition names the loop's own return port: nothing to rewrite.
    expect(loop.exitCondition).toEqual({ kind: 'port-equals', portName: 'kept', value: 'done' })
    const review = result.nodes[2] as Record<string, unknown>
    expect(review.rerunnableOnReject).toEqual(['agent-copy'])
    expect(review.rerunnableOnIterate).toEqual(['agent-copy'])
    expect(result.edges).toEqual([
      {
        id: 'kept',
        source: { nodeId: 'agent-copy', portName: 'out' },
        target: { nodeId: 'loop-copy', portName: 'in' },
        boundary: 'wrapper-output',
      },
      {
        id: 'to-output',
        source: { nodeId: 'agent-copy', portName: 'out' },
        target: { nodeId: 'output-copy', portName: 'in' },
      },
    ])
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'copy-reference-outside-slice',
          nodeId: 'git',
          field: 'nodeIds',
          referencedNodeId: 'outside',
          action: 'filter',
        }),
        expect.objectContaining({
          code: 'copy-reference-outside-slice',
          edgeId: 'cleared',
          field: 'source',
          action: 'drop',
        }),
        expect.objectContaining({
          code: 'copy-reference-outside-slice',
          edgeId: 'external',
          action: 'drop',
        }),
      ]),
    )
    // Neither transformation nor later edits to its result may alias source.
    expect(source).toEqual(snapshot)
    ;(
      (result.nodes[4] as Record<string, unknown>).metadata as {
        nested: { untouched: boolean }
      }
    ).nested.untouched = false
    expect(
      ((source.nodes[4] as Record<string, unknown>).metadata as { nested: { untouched: boolean } })
        .nested.untouched,
    ).toBe(true)
  })
})

describe('pruneDeletedNodeReferences', () => {
  test('uses the final survivor set across nodes, edges, and top-level outputs', () => {
    const source = definition(
      [
        node('live', 'agent-single'),
        node('doomed', 'agent-single'),
        node('git', 'wrapper-git', {
          nodeIds: ['live', 'doomed'],
          size: { width: 800, height: 600 },
        }),
        node('fanout', 'wrapper-fanout', {
          nodeIds: ['doomed', 'live'],
          size: { width: 700, height: 500, sizeLocked: true },
        }),
        node('loop', 'wrapper-loop', {
          nodeIds: ['live', 'doomed'],
          size: { width: 600, height: 400 },
          exitCondition: { kind: 'port-empty', portName: 'result' },
        }),
        node('review', 'review', {
          rerunnableOnReject: ['live', 'doomed'],
          rerunnableOnIterate: ['doomed'],
        }),
        node('output', 'output'),
      ],
      [
        edge('drop-edge', 'live', 'doomed'),
        edge('keep-edge', 'live', 'review'),
        // RFC-354: the loop return bound to the deleted node goes with it
        edge('drop-return', 'doomed', 'loop', 'wrapper-output'),
        edge('drop-output', 'doomed', 'output'),
      ],
      [
        { name: 'kept', bind: { nodeId: 'live', portName: 'result' } },
        { name: 'stale', bind: { nodeId: 'doomed', portName: 'result' } },
      ],
    )
    const snapshot = JSON.parse(JSON.stringify(source))
    const survivors = new Set(['live', 'git', 'fanout', 'loop', 'review', 'output'])
    const result = pruneDeletedNodeReferences(source, survivors)
    expect(result.safe).toBe(true)
    expect(result.definition.nodes.map((entry) => entry.id)).not.toContain('doomed')
    const git = result.definition.nodes[1] as Record<string, unknown>
    expect(git.nodeIds).toEqual(['live'])
    expect(git.size).toBeUndefined()
    const fanout = result.definition.nodes[2] as Record<string, unknown>
    expect(fanout.nodeIds).toEqual(['live'])
    expect(fanout.size).toEqual({ width: 700, height: 500, sizeLocked: true })
    const loop = result.definition.nodes[3] as Record<string, unknown>
    expect(loop.nodeIds).toEqual(['live'])
    expect(loop.size).toBeUndefined()
    expect(loop.exitCondition).toEqual({ kind: 'port-empty', portName: 'result' })
    const review = result.definition.nodes[4] as Record<string, unknown>
    expect(review.rerunnableOnReject).toEqual(['live'])
    expect(review.rerunnableOnIterate).toEqual([])
    expect(result.definition.edges.map((entry) => entry.id)).toEqual(['keep-edge'])
    expect(result.definition.outputs).toEqual([
      { name: 'kept', bind: { nodeId: 'live', portName: 'result' } },
    ])
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'deleted-node-reference-pruned',
        edgeId: 'drop-return',
        field: 'source',
        referencedNodeId: 'doomed',
        action: 'drop',
      }),
    )
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'deleted-node-reference-pruned',
        field: 'outputs[1].bind',
        referencedNodeId: 'doomed',
        action: 'drop',
      }),
    )
    expect(source).toEqual(snapshot)
  })
})

describe('rewriteWorkflowPortReferences', () => {
  test('input node port rename reaches every edge and top-level output without changing declarations', () => {
    const source = definition(
      [
        node('input', 'input', { inputKey: 'old_key' }),
        node('review', 'review', { rerunnableOnReject: [], rerunnableOnIterate: [] }),
        node('output', 'output'),
        node('loop', 'wrapper-loop', {
          nodeIds: ['input'],
          // names the LOOP's return port, which happens to share the input's port name
          exitCondition: { kind: 'port-empty', portName: 'old_key' },
        }),
      ],
      [
        {
          id: 'boundary',
          source: { nodeId: 'input', portName: 'old_key' },
          target: { nodeId: 'input', portName: 'old_key' },
          boundary: 'wrapper-input',
        },
        {
          id: 'to-review',
          source: { nodeId: 'input', portName: 'old_key' },
          target: { nodeId: 'review', portName: '__review_input__' },
        },
        {
          id: 'to-output',
          source: { nodeId: 'input', portName: 'old_key' },
          target: { nodeId: 'output', portName: 'result' },
        },
      ],
      [{ name: 'result', bind: { nodeId: 'input', portName: 'old_key' } }],
    )
    const snapshot = JSON.parse(JSON.stringify(source))
    const result = rewriteWorkflowPortReferences(source, [
      { nodeId: 'input', fromPortName: 'old_key', toPortName: 'new_key' },
    ])
    expect(result.safe).toBe(true)
    expect(result.warnings).toEqual([])
    // Declaration/key collision policy belongs to the frontend clipboard layer.
    expect((result.definition.nodes[0] as Record<string, unknown>).inputKey).toBe('old_key')
    // A loop return port is the loop's own name space — untouched by an input rename.
    expect((result.definition.nodes[3] as Record<string, unknown>).exitCondition).toEqual({
      kind: 'port-empty',
      portName: 'old_key',
    })
    expect(result.definition.edges).toEqual([
      {
        id: 'boundary',
        source: { nodeId: 'input', portName: 'new_key' },
        target: { nodeId: 'input', portName: 'new_key' },
        boundary: 'wrapper-input',
      },
      {
        id: 'to-review',
        source: { nodeId: 'input', portName: 'new_key' },
        target: { nodeId: 'review', portName: '__review_input__' },
      },
      {
        id: 'to-output',
        source: { nodeId: 'input', portName: 'new_key' },
        target: { nodeId: 'output', portName: 'result' },
      },
    ])
    expect(result.definition.outputs).toEqual([
      { name: 'result', bind: { nodeId: 'input', portName: 'new_key' } },
    ])
    expect(source).toEqual(snapshot)
  })
})

describe('pruneWorkflowPortReferences', () => {
  test('drops every edge and top-level output that reads a disappeared port', () => {
    const source = definition(
      [
        node('producer', 'agent-single'),
        node('review', 'review'),
        node('output', 'output'),
        node('loop', 'wrapper-loop', {
          nodeIds: ['producer'],
          exitCondition: { kind: 'port-empty', portName: 'result' },
        }),
      ],
      [
        {
          id: 'ordinary',
          source: { nodeId: 'producer', portName: 'gone' },
          target: { nodeId: 'output', portName: 'result' },
        },
        {
          id: 'boundary',
          source: { nodeId: 'producer', portName: 'gone' },
          target: { nodeId: 'loop', portName: 'result' },
          boundary: 'wrapper-output',
        },
        {
          id: 'to-review',
          source: { nodeId: 'producer', portName: 'gone' },
          target: { nodeId: 'review', portName: '__review_input__' },
        },
        {
          id: 'survivor',
          source: { nodeId: 'producer', portName: 'stays' },
          target: { nodeId: 'output', portName: 'other' },
        },
      ],
      [{ name: 'result', bind: { nodeId: 'producer', portName: 'gone' } }],
    )
    const snapshot = JSON.parse(JSON.stringify(source))
    const result = pruneWorkflowPortReferences(source, [{ nodeId: 'producer', portName: 'gone' }])
    expect(result.safe).toBe(true)
    expect(result.definition.edges.map((entry) => entry.id)).toEqual(['survivor'])
    expect(result.definition.outputs).toEqual([])
    expect(result.definition.nodes).toEqual(source.nodes)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'disappeared-port-reference-pruned',
          edgeId: 'boundary',
          field: 'source',
          referencedNodeId: 'producer',
          referencedPortName: 'gone',
          action: 'drop',
        }),
        expect.objectContaining({
          code: 'disappeared-port-reference-pruned',
          field: 'outputs[0].bind',
          referencedNodeId: 'producer',
          referencedPortName: 'gone',
          action: 'drop',
        }),
      ]),
    )
    expect(source).toEqual(snapshot)
  })
})
