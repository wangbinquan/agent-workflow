// Round-trip tests for the workflow-definition ↔ xyflow translation
// helpers. The canvas itself depends on @xyflow/react which needs a DOM
// (covered separately via the typecheck + happy-dom env if we add an
// integration test).

import { describe, expect, test } from 'vitest'
import {
  __testToDefinition as toDefinition,
  __testToFlowEdges as toFlowEdges,
  __testToFlowNodes as toFlowNodes,
} from '../src/components/canvas/WorkflowCanvas'
import type { WorkflowDefinition } from '@agent-workflow/shared'

const DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [{ kind: 'text', key: 'req', label: '需求' }],
  nodes: [
    { id: 'i1', kind: 'input', inputKey: 'req', position: { x: 10, y: 20 } },
    { id: 'a1', kind: 'agent-single', agentName: 'coder', position: { x: 200, y: 30 } },
    { id: 'o1', kind: 'output', ports: [], position: { x: 400, y: 40 } },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'i1', portName: 'req' },
      target: { nodeId: 'a1', portName: 'req' },
    },
    {
      id: 'e2',
      source: { nodeId: 'a1', portName: 'out' },
      target: { nodeId: 'o1', portName: 'final' },
    },
  ],
}

describe('toFlowNodes', () => {
  test('preserves position and id', () => {
    const ns = toFlowNodes(DEF.nodes)
    expect(ns).toHaveLength(3)
    expect(ns[0]?.id).toBe('i1')
    expect(ns[0]?.position).toEqual({ x: 10, y: 20 })
  })

  test('falls back to a tile grid when position is absent', () => {
    const ns = toFlowNodes([{ id: 'x', kind: 'input', inputKey: 'k' }])
    expect(ns[0]?.position.x).toBeGreaterThan(0)
    expect(ns[0]?.position.y).toBeGreaterThan(0)
  })

  test('agent label includes agentName + id', () => {
    const ns = toFlowNodes(DEF.nodes)
    expect((ns[1]?.data as { label: string }).label).toContain('coder')
    expect((ns[1]?.data as { label: string }).label).toContain('a1')
  })

  test('agent-multi label is prefixed with fan-out glyph', () => {
    const ns = toFlowNodes([{ id: 'm1', kind: 'agent-multi', agentName: 'auditor' }])
    expect((ns[0]?.data as { label: string }).label.startsWith('🔀')).toBe(true)
  })
})

describe('toFlowEdges', () => {
  test('round-trips id + source/target + handles', () => {
    const es = toFlowEdges(DEF.edges)
    expect(es).toHaveLength(2)
    expect(es[0]?.source).toBe('i1')
    expect(es[0]?.target).toBe('a1')
    expect(es[0]?.sourceHandle).toBe('req')
    expect(es[0]?.targetHandle).toBe('req')
  })
})

describe('toDefinition', () => {
  test('updates node positions from flow nodes', () => {
    const flow = toFlowNodes(DEF.nodes)
    flow[0]!.position = { x: 999, y: 888 }
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.nodes[0]?.position).toEqual({ x: 999, y: 888 })
    expect(next.nodes[1]?.position).toEqual({ x: 200, y: 30 })
  })

  test('drops edges whose endpoints were removed', () => {
    // Remove the agent node.
    const flow = toFlowNodes(DEF.nodes).filter((n) => n.id !== 'a1')
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.nodes.map((n) => n.id)).toEqual(['i1', 'o1'])
    expect(next.edges).toEqual([])
  })

  test('drops edges that were removed in the flow shape', () => {
    const flow = toFlowNodes(DEF.nodes)
    // Keep all nodes, but only one edge in the flow.
    const flowEdges = toFlowEdges(DEF.edges).filter((e) => e.id === 'e1')
    const next = toDefinition(DEF, flow, flowEdges)
    expect(next.edges.map((e) => e.id)).toEqual(['e1'])
  })

  test('rounds positions to integers', () => {
    const flow = toFlowNodes(DEF.nodes)
    flow[0]!.position = { x: 10.4, y: 20.6 }
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.nodes[0]?.position).toEqual({ x: 10, y: 21 })
  })

  test('preserves non-canvas fields like $schema_version + inputs', () => {
    const flow = toFlowNodes(DEF.nodes)
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.$schema_version).toBe(1)
    expect(next.inputs).toEqual(DEF.inputs)
  })
})
