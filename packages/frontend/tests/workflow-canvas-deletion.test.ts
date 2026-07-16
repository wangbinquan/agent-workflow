// RFC-199 B4/T7.1 + T7.3 — one node deletion expands recursive wrapper
// ownership and returns one canonical survivor/prune result for history.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { Edge, Node, NodeChange } from '@xyflow/react'
import {
  deleteWorkflowSelection,
  reconcileFlowNodeChanges,
} from '../src/components/canvas/WorkflowCanvas'

describe('reconcileFlowNodeChanges', () => {
  test('a deferred/replayed remove is deterministic and never mutates its canonical inputs', () => {
    const nodes: Node[] = [
      { id: 'keep', position: { x: 0, y: 0 }, data: {} },
      { id: 'drop', position: { x: 100, y: 0 }, data: {}, selected: true },
    ]
    const edges: Edge[] = [
      { id: 'incident', source: 'keep', target: 'drop', selected: true },
      { id: 'keep-edge', source: 'keep', target: 'keep' },
    ]
    const changes: NodeChange[] = [{ type: 'remove', id: 'drop' }]

    const first = reconcileFlowNodeChanges(changes, nodes, edges)
    const replay = reconcileFlowNodeChanges(changes, nodes, edges)

    expect(first).toEqual(replay)
    expect(first.nodes.map((node) => node.id)).toEqual(['keep'])
    expect(first.edges.map((edge) => edge.id)).toEqual(['keep-edge'])
    expect(nodes.map((node) => node.id)).toEqual(['keep', 'drop'])
    expect(edges.map((edge) => edge.id)).toEqual(['incident', 'keep-edge'])
  })
})

describe('deleteWorkflowSelection', () => {
  test('recursively deletes nested wrapper descendants and prunes every surviving reference', () => {
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'outer', kind: 'wrapper-git', nodeIds: ['loop'] },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['child'],
          exitCondition: { kind: 'port-not-empty', nodeId: 'child', portName: 'out' },
          outputBindings: [{ name: 'looped', bind: { nodeId: 'child', portName: 'out' } }],
        },
        { id: 'child', kind: 'agent-single' },
        {
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'child', portName: 'out' },
          rerunnableOnReject: ['child'],
          rerunnableOnIterate: ['child'],
        },
        {
          id: 'output',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'child', portName: 'out' } }],
        },
      ],
      edges: [
        {
          id: 'incident',
          source: { nodeId: 'child', portName: 'out' },
          target: { nodeId: 'review', portName: 'in' },
        },
      ],
      outputs: [{ name: 'top', bind: { nodeId: 'child', portName: 'out' } }],
    }

    const result = deleteWorkflowSelection(definition, ['outer'], [])
    expect(result.safe).toBe(true)
    expect(result.definition.nodes.map((node) => node.id)).toEqual(['review', 'output'])
    expect(result.definition.edges).toEqual([])
    expect(result.definition.outputs).toEqual([])
    expect(result.definition.nodes[0]).toMatchObject({
      inputSource: { nodeId: '', portName: '' },
      rerunnableOnReject: [],
      rerunnableOnIterate: [],
    })
    expect(result.definition.nodes[1]).toMatchObject({
      ports: [{ name: 'final', bind: { nodeId: '', portName: '' } }],
    })
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(definition.nodes.map((node) => node.id)).toEqual([
      'outer',
      'loop',
      'child',
      'review',
      'output',
    ])
  })

  test('deleting only an edge preserves all nodes for the caller reconciliation step', () => {
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single' },
        { id: 'b', kind: 'agent-single' },
      ],
      edges: [
        {
          id: 'edge',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
      ],
    }
    const result = deleteWorkflowSelection(definition, [], ['edge'])
    expect(result.definition.nodes).toEqual(definition.nodes)
    expect(result.definition.edges).toEqual([])
  })
})
