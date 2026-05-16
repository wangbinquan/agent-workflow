// Round-trip + port-inventory tests for the canvas translation helpers.

import { describe, expect, test } from 'vitest'
import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import type { NodeChange } from '@xyflow/react'
import {
  __testAffectsDefinition as affectsDefinition,
  __testComputePorts as computePorts,
  __testSameIds as sameIds,
  __testToDefinition as toDefinition,
  __testToFlowEdges as toFlowEdges,
  __testToFlowNodes as toFlowNodes,
} from '../src/components/canvas/WorkflowCanvas'

const CODER: Agent = {
  id: 'a',
  name: 'coder',
  description: '',
  outputs: ['code', 'notes'],
  readonly: false,
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

const AUDITOR: Agent = { ...CODER, name: 'auditor', outputs: ['findings'] }

const DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [{ kind: 'text', key: 'req', label: '需求' }],
  nodes: [
    { id: 'i1', kind: 'input', inputKey: 'req', position: { x: 10, y: 20 } },
    { id: 'a1', kind: 'agent-single', agentName: 'coder', position: { x: 200, y: 30 } },
    {
      id: 'o1',
      kind: 'output',
      ports: [{ name: 'final', bind: { nodeId: 'a1', portName: 'code' } }],
      position: { x: 400, y: 40 },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'i1', portName: 'req' },
      target: { nodeId: 'a1', portName: 'req' },
    },
    {
      id: 'e2',
      source: { nodeId: 'a1', portName: 'code' },
      target: { nodeId: 'o1', portName: 'final' },
    },
  ],
}

describe('computePorts', () => {
  const byName = new Map([
    ['coder', CODER],
    ['auditor', AUDITOR],
  ])

  test('input node: one output port from inputKey', () => {
    const ports = computePorts({ id: 'i1', kind: 'input', inputKey: 'req' }, byName, DEF)
    expect(ports.outputs).toEqual(['req'])
    // No incoming edges either.
    expect(ports.inputs).toEqual([])
  })

  test('agent-single: outputs from agent + inputs from inbound edges', () => {
    const ports = computePorts(DEF.nodes[1]!, byName, DEF)
    expect(ports.outputs).toEqual(['code', 'notes'])
    expect(ports.inputs).toEqual(['req'])
  })

  test('agent-multi: outputs + auto-appended errors port', () => {
    const ports = computePorts({ id: 'm1', kind: 'agent-multi', agentName: 'auditor' }, byName, {
      ...DEF,
      nodes: [],
    })
    expect(ports.outputs).toEqual(['findings', 'errors'])
  })

  test('output node: inputs from ports[].name', () => {
    const ports = computePorts(DEF.nodes[2]!, byName, DEF)
    expect(ports.inputs).toEqual(['final'])
  })

  test('wrapper-git: single git_diff output', () => {
    const ports = computePorts({ id: 'wg', kind: 'wrapper-git', nodeIds: ['a1'] }, byName, {
      ...DEF,
      nodes: [],
    })
    expect(ports.outputs).toEqual(['git_diff'])
  })

  test('wrapper-loop: outputs from outputBindings[].name', () => {
    const ports = computePorts(
      {
        id: 'wl',
        kind: 'wrapper-loop',
        nodeIds: ['a1'],
        maxIterations: 3,
        exitCondition: { kind: 'port-empty' },
        outputBindings: [{ name: 'final', bind: { nodeId: 'a1', portName: 'code' } }],
      },
      byName,
      { ...DEF, nodes: [] },
    )
    expect(ports.outputs).toEqual(['final'])
  })

  test('unknown agent → no outputs (port inventory is empty rather than crash)', () => {
    const ports = computePorts({ id: 'a1', kind: 'agent-single', agentName: 'ghost' }, byName, {
      ...DEF,
      nodes: [],
    })
    expect(ports.outputs).toEqual([])
  })
})

describe('toFlowNodes', () => {
  test('uses node.kind as xyflow type so the right component renders', () => {
    const flow = toFlowNodes(DEF.nodes, [CODER], DEF.edges)
    expect(flow[0]?.type).toBe('input')
    expect(flow[1]?.type).toBe('agent-single')
    expect(flow[2]?.type).toBe('output')
  })

  test('agent node data carries title + port inventory', () => {
    const flow = toFlowNodes(DEF.nodes, [CODER], DEF.edges)
    const agent = flow[1]?.data as {
      title: string
      outputPorts: string[]
      inputPorts: string[]
    }
    expect(agent.title).toBe('coder')
    expect(agent.outputPorts).toEqual(['code', 'notes'])
    expect(agent.inputPorts).toEqual(['req'])
  })

  test('falls back to a tile grid when position is absent', () => {
    const flow = toFlowNodes([{ id: 'x', kind: 'input', inputKey: 'k' }], [])
    expect(flow[0]?.position.x).toBeGreaterThan(0)
    expect(flow[0]?.position.y).toBeGreaterThan(0)
  })

  test('wrapper-git carries innerCount', () => {
    const flow = toFlowNodes([{ id: 'wg', kind: 'wrapper-git', nodeIds: ['a', 'b', 'c'] }], [])
    expect((flow[0]?.data as { innerCount?: number }).innerCount).toBe(3)
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
    const flow = toFlowNodes(DEF.nodes, [CODER], DEF.edges)
    flow[0]!.position = { x: 999, y: 888 }
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.nodes[0]?.position).toEqual({ x: 999, y: 888 })
    expect(next.nodes[1]?.position).toEqual({ x: 200, y: 30 })
  })

  test('drops edges whose endpoints were removed', () => {
    const flow = toFlowNodes(DEF.nodes, [CODER], DEF.edges).filter((n) => n.id !== 'a1')
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.nodes.map((n) => n.id)).toEqual(['i1', 'o1'])
    expect(next.edges).toEqual([])
  })

  test('drops edges that were removed in the flow shape', () => {
    const flow = toFlowNodes(DEF.nodes, [CODER], DEF.edges)
    const flowEdges = toFlowEdges(DEF.edges).filter((e) => e.id === 'e1')
    const next = toDefinition(DEF, flow, flowEdges)
    expect(next.edges.map((e) => e.id)).toEqual(['e1'])
  })

  test('rounds positions to integers', () => {
    const flow = toFlowNodes(DEF.nodes, [CODER], DEF.edges)
    flow[0]!.position = { x: 10.4, y: 20.6 }
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.nodes[0]?.position).toEqual({ x: 10, y: 21 })
  })

  test('preserves non-canvas fields like $schema_version + inputs', () => {
    const flow = toFlowNodes(DEF.nodes, [CODER], DEF.edges)
    const next = toDefinition(DEF, flow, toFlowEdges(DEF.edges))
    expect(next.$schema_version).toBe(1)
    expect(next.inputs).toEqual(DEF.inputs)
  })
})

// Regression: handleNodesChange used to propagate ALL xyflow NodeChanges
// to the parent, which (combined with the def-sync useEffect rebuilding
// nodes from the new definition reference) created a feedback loop —
// xyflow re-fired select/dimensions changes after every render and React
// hit "Maximum update depth exceeded". The predicate here gates the
// propagation so only data-affecting changes round-trip.
describe('affectsDefinition', () => {
  test('select-only changes are local UI state, do not affect the def', () => {
    const changes: NodeChange[] = [{ id: 'a1', type: 'select', selected: true }]
    expect(affectsDefinition(changes)).toBe(false)
  })

  test('dimensions-only changes (xyflow auto-measure) are local too', () => {
    const changes: NodeChange[] = [
      { id: 'a1', type: 'dimensions', dimensions: { width: 200, height: 80 } },
    ]
    expect(affectsDefinition(changes)).toBe(false)
  })

  test('mixed select + dimensions still does not affect the def', () => {
    const changes: NodeChange[] = [
      { id: 'a1', type: 'select', selected: false },
      { id: 'a1', type: 'dimensions', dimensions: { width: 200, height: 80 } },
    ]
    expect(affectsDefinition(changes)).toBe(false)
  })

  test('position-only changes do NOT propagate (committed at onNodeDragStop)', () => {
    // Per-tick position propagation caused a visible canvas flicker during
    // drag because the def-sync useEffect rebuilt the whole nodes array
    // from the freshly-committed definition (round-tripped through
    // toDefinition with `Math.round`) on every mousemove. Drag-end
    // positions are committed once via onNodeDragStop instead — see
    // affectsDefinition's docstring.
    const changes: NodeChange[] = [
      { id: 'a1', type: 'position', position: { x: 100, y: 200 }, dragging: false },
    ]
    expect(affectsDefinition(changes)).toBe(false)
  })

  test('add / remove changes affect the def', () => {
    const add: NodeChange[] = [
      { type: 'add', item: { id: 'new', position: { x: 0, y: 0 }, data: {} } as never },
    ]
    const rm: NodeChange[] = [{ type: 'remove', id: 'old' }]
    expect(affectsDefinition(add)).toBe(true)
    expect(affectsDefinition(rm)).toBe(true)
  })

  test('a position change mixed in with a select still does not propagate', () => {
    // Both ignored: position is committed at drag stop, select is local
    // UI state. Neither is a structural change to the persisted def.
    const changes: NodeChange[] = [
      { id: 'a1', type: 'select', selected: true },
      { id: 'a2', type: 'position', position: { x: 5, y: 5 }, dragging: false },
    ]
    expect(affectsDefinition(changes)).toBe(false)
  })

  test('empty change list is a no-op', () => {
    expect(affectsDefinition([])).toBe(false)
  })
})

// Regression: onSelectionChange used to mint a fresh `{nodes, edges}`
// object on every xyflow callback, even when the actual selected ids
// were unchanged. Combined with the canvas re-render after definition
// changes that produced an unbounded setState loop. The handler now
// uses sameIds inside a functional setState updater.
describe('sameIds', () => {
  test('two empty arrays', () => {
    expect(sameIds([], [])).toBe(true)
  })

  test('same ids in same order', () => {
    expect(sameIds(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true)
  })

  test('different lengths', () => {
    expect(sameIds(['a'], ['a', 'b'])).toBe(false)
  })

  test('same ids in different order is NOT equal (order matters)', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false)
  })

  test('one differing id', () => {
    expect(sameIds(['a', 'b'], ['a', 'c'])).toBe(false)
  })
})
