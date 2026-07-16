// RFC-199 T7.1 — node-reference inventory regressions.
// Locks recursive wrapper closure, full-idMap clipboard rewrite, survivor-set
// delete pruning, all-PortRef input rename, passthrough ratchet, and deep
// immutability. Frontend clipboard/history wiring is deliberately out of scope.

import { describe, expect, test } from 'bun:test'
import {
  NODE_KIND,
  WORKFLOW_NODE_REFERENCE_INVENTORY,
  WorkflowNodeSchema,
  collectNodeReferenceClosure,
  pruneDeletedNodeReferences,
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

  test('passthrough existing-kind reference field fails visible instead of silently leaking', () => {
    const parsed = WorkflowNodeSchema.parse({
      id: 'review',
      kind: 'review',
      inputSource: { nodeId: 'inside', portName: 'doc' },
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

  test('malformed inventoried reference shapes fail closed instead of leaking old node ids', () => {
    const cases: Array<{
      node: WorkflowNode
      field: string
      referencedNodeId: string
    }> = [
      {
        node: node('review', 'review', {
          inputSource: { nodeId: 'outside-direct', portName: 123 },
        }),
        field: 'inputSource',
        referencedNodeId: 'outside-direct',
      },
      {
        node: node('loop', 'wrapper-loop', {
          exitCondition: {
            kind: 'port-empty',
            nodeId: 'outside-embedded',
            portName: false,
          },
        }),
        field: 'exitCondition',
        referencedNodeId: 'outside-embedded',
      },
      {
        node: node('output', 'output', {
          ports: [
            {
              name: 'broken',
              bind: { nodeId: 'outside-binding', portName: 42 },
            },
          ],
        }),
        field: 'ports[0].bind',
        referencedNodeId: 'outside-binding',
      },
      {
        node: node('git', 'wrapper-git', {
          nodeIds: ['inside', { nodeId: 'outside-list' }],
        }),
        field: 'nodeIds[1]',
        referencedNodeId: 'outside-list',
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

  test('reference-free incomplete draft containers do not trip the malformed-shape ratchet', () => {
    const fixtures = [
      node('review', 'review', { inputSource: {} }),
      node('loop', 'wrapper-loop', {
        exitCondition: { kind: 'port-empty' },
        outputBindings: [{ name: 'draft' }],
      }),
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

  test('known reference containers still ratchet nested passthrough references', () => {
    const fixtures: Array<{ node: WorkflowNode; field: string }> = [
      {
        node: node('review', 'review', {
          inputSource: {
            nodeId: 'inside',
            portName: 'doc',
            future: { nodeId: 'outside', portName: 'future' },
          },
        }),
        field: 'inputSource.future',
      },
      {
        node: node('loop', 'wrapper-loop', {
          exitCondition: {
            kind: 'port-empty',
            nodeId: 'inside',
            portName: 'out',
            future: { nestedNodeId: 'outside' },
          },
        }),
        field: 'exitCondition.future.nestedNodeId',
      },
      {
        node: node('output', 'output', {
          ports: [
            {
              name: 'result',
              bind: {
                nodeId: 'inside',
                portName: 'out',
                future: { nodeId: 'outside', portName: 'future' },
              },
            },
          ],
        }),
        field: 'ports[].bind.future',
      },
      {
        node: node('draft', 'review', {
          inputSource: { future: { nodeId: 'outside', portName: 'future' } },
        }),
        field: 'inputSource.future',
      },
    ]

    for (const fixture of fixtures) {
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
  test('uses the complete idMap in a second pass, preserves boundary, and clears/filters externals', () => {
    const source = {
      nodes: [
        node('git', 'wrapper-git', { nodeIds: ['loop', 'outside', 'legacy-missing'] }),
        node('loop', 'wrapper-loop', {
          nodeIds: ['agent'],
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'agent',
            portName: 'result',
            value: 'done',
          },
          outputBindings: [
            { name: 'kept', bind: { nodeId: 'agent', portName: 'result' } },
            { name: 'cleared', bind: { nodeId: 'outside', portName: 'result' } },
          ],
        }),
        node('review', 'review', {
          inputSource: { nodeId: 'outside', portName: 'doc' },
          rerunnableOnReject: ['agent', 'outside'],
          rerunnableOnIterate: ['outside', 'agent'],
        }),
        node('output', 'output', {
          ports: [
            { name: 'kept', bind: { nodeId: 'agent', portName: 'result' } },
            { name: 'cleared', bind: { nodeId: 'outside', portName: 'result' } },
          ],
        }),
        // Declared last to lock forward-reference rewriting.
        node('agent', 'agent-single', { metadata: { nested: { untouched: true } } }),
      ],
      edges: [
        edge('boundary', 'agent', 'loop', 'wrapper-output'),
        edge('external', 'outside', 'review'),
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
    expect(loop.exitCondition).toEqual({
      kind: 'port-equals',
      nodeId: 'agent-copy',
      portName: 'result',
      value: 'done',
    })
    expect(loop.outputBindings).toEqual([
      { name: 'kept', bind: { nodeId: 'agent-copy', portName: 'result' } },
      { name: 'cleared', bind: { nodeId: '', portName: '' } },
    ])

    const review = result.nodes[2] as Record<string, unknown>
    expect(review.inputSource).toEqual({ nodeId: '', portName: '' })
    expect(review.rerunnableOnReject).toEqual(['agent-copy'])
    expect(review.rerunnableOnIterate).toEqual(['agent-copy'])

    const output = result.nodes[3] as Record<string, unknown>
    expect(output.ports).toEqual([
      { name: 'kept', bind: { nodeId: 'agent-copy', portName: 'result' } },
      { name: 'cleared', bind: { nodeId: '', portName: '' } },
    ])
    expect(result.edges).toEqual([
      {
        id: 'boundary',
        source: { nodeId: 'agent-copy', portName: 'out' },
        target: { nodeId: 'loop-copy', portName: 'in' },
        boundary: 'wrapper-output',
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
          nodeId: 'review',
          field: 'inputSource',
          action: 'clear',
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
          exitCondition: { kind: 'port-empty', nodeId: 'doomed', portName: 'result' },
          outputBindings: [{ name: 'result', bind: { nodeId: 'doomed', portName: 'result' } }],
        }),
        node('review', 'review', {
          inputSource: { nodeId: 'doomed', portName: 'doc' },
          rerunnableOnReject: ['live', 'doomed'],
          rerunnableOnIterate: ['doomed'],
        }),
        node('output', 'output', {
          ports: [{ name: 'result', bind: { nodeId: 'doomed', portName: 'result' } }],
        }),
      ],
      [edge('drop-edge', 'live', 'doomed'), edge('keep-edge', 'live', 'review')],
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
    expect(loop.exitCondition).toEqual({ kind: 'port-empty', nodeId: '', portName: '' })
    expect(loop.outputBindings).toEqual([{ name: 'result', bind: { nodeId: '', portName: '' } }])
    const review = result.definition.nodes[4] as Record<string, unknown>
    expect(review.inputSource).toEqual({ nodeId: '', portName: '' })
    expect(review.rerunnableOnReject).toEqual(['live'])
    expect(review.rerunnableOnIterate).toEqual([])
    expect((result.definition.nodes[5] as Record<string, unknown>).ports).toEqual([
      { name: 'result', bind: { nodeId: '', portName: '' } },
    ])
    expect(result.definition.edges.map((entry) => entry.id)).toEqual(['keep-edge'])
    expect(result.definition.outputs).toEqual([
      { name: 'kept', bind: { nodeId: 'live', portName: 'result' } },
    ])
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
  test('input node port rename reaches every PortRef without changing declarations/node field', () => {
    const source = definition(
      [
        node('input', 'input', { inputKey: 'old_key' }),
        node('review', 'review', {
          inputSource: { nodeId: 'input', portName: 'old_key' },
          rerunnableOnReject: [],
          rerunnableOnIterate: [],
        }),
        node('output', 'output', {
          ports: [{ name: 'result', bind: { nodeId: 'input', portName: 'old_key' } }],
        }),
        node('loop', 'wrapper-loop', {
          nodeIds: ['input'],
          exitCondition: { kind: 'port-empty', nodeId: 'input', portName: 'old_key' },
          outputBindings: [{ name: 'result', bind: { nodeId: 'input', portName: 'old_key' } }],
        }),
      ],
      [
        {
          id: 'boundary',
          source: { nodeId: 'input', portName: 'old_key' },
          target: { nodeId: 'input', portName: 'old_key' },
          boundary: 'wrapper-input',
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
    expect((result.definition.nodes[1] as Record<string, unknown>).inputSource).toEqual({
      nodeId: 'input',
      portName: 'new_key',
    })
    expect((result.definition.nodes[2] as Record<string, unknown>).ports).toEqual([
      { name: 'result', bind: { nodeId: 'input', portName: 'new_key' } },
    ])
    const loop = result.definition.nodes[3] as Record<string, unknown>
    expect(loop.exitCondition).toEqual({
      kind: 'port-empty',
      nodeId: 'input',
      portName: 'new_key',
    })
    expect(loop.outputBindings).toEqual([
      { name: 'result', bind: { nodeId: 'input', portName: 'new_key' } },
    ])
    expect(result.definition.edges[0]).toEqual({
      id: 'boundary',
      source: { nodeId: 'input', portName: 'new_key' },
      target: { nodeId: 'input', portName: 'new_key' },
      boundary: 'wrapper-input',
    })
    expect(result.definition.outputs).toEqual([
      { name: 'result', bind: { nodeId: 'input', portName: 'new_key' } },
    ])
    expect(source).toEqual(snapshot)
  })
})
