// 2026-05-24 regression lock — markBoundaryWrapperInput stamps the
// `boundary: 'wrapper-input'` flag on edges the user drag-creates from a
// wrapper-fanout input port into an inner node. The task-execution fanout
// strategy/domain projection iterates only over
// `edges.filter(e => e.boundary === 'wrapper-input')`; without this tag a
// drag-authored edge renders on the canvas but is silently ignored at
// runtime — which is exactly the bug a user just hit:
//
//   "现在拖动分片包装器的输入节点无法连接到内部的节点的输入"
//
// The visual fix is the dual-purpose Handle (target+source) on the
// wrapper-fanout input row in WrapperNodes.tsx; this file pins the data
// side so the boundary tag survives any future refactor of handleConnect.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import {
  markBoundaryWrapperInput,
  markBoundaryWrapperOutput,
} from '../src/components/canvas/WorkflowCanvas'

function defWith(nodes: WorkflowDefinition['nodes']): WorkflowDefinition {
  return { $schema_version: 2, inputs: [], nodes, edges: [] } as WorkflowDefinition
}

function fanout(id: string, nodeIds: string[]) {
  return {
    id,
    kind: 'wrapper-fanout',
    position: { x: 0, y: 0 },
    nodeIds,
    inputs: [{ name: 'docs', kind: 'list<string>', isShardSource: true }],
  } as unknown as WorkflowDefinition['nodes'][number]
}

function agent(id: string) {
  return {
    id,
    kind: 'agent-single',
    position: { x: 0, y: 0 },
    agentName: 'doc',
  } as unknown as WorkflowDefinition['nodes'][number]
}

function edge(opts: {
  source: { nodeId: string; portName: string }
  target: { nodeId: string; portName: string }
}): WorkflowEdge {
  return {
    id: 'e1',
    source: opts.source,
    target: opts.target,
  }
}

describe('markBoundaryWrapperInput', () => {
  test('tags an edge from a wrapper-fanout input into an inner node', () => {
    const prev = defWith([fanout('w1', ['a1']), agent('a1')])
    const e = edge({
      source: { nodeId: 'w1', portName: 'docs' },
      target: { nodeId: 'a1', portName: 'docs' },
    })
    const out = markBoundaryWrapperInput(prev, e)
    expect(out.boundary).toBe('wrapper-input')
  })

  test('no-op when source is not a wrapper-fanout', () => {
    const prev = defWith([agent('a1'), agent('a2')])
    const e = edge({
      source: { nodeId: 'a1', portName: 'out' },
      target: { nodeId: 'a2', portName: 'in' },
    })
    const out = markBoundaryWrapperInput(prev, e)
    expect(out).toBe(e)
    expect(out.boundary).toBeUndefined()
  })

  test('no-op when the target is not in the wrapper-fanout nodeIds[]', () => {
    // Outsider target — this would be an external rewire, not a boundary
    // edge. The runtime would refuse to interpret it as wrapper-input
    // anyway because the target sits outside the wrapper.
    const prev = defWith([fanout('w1', ['inner']), agent('outsider')])
    const e = edge({
      source: { nodeId: 'w1', portName: 'docs' },
      target: { nodeId: 'outsider', portName: 'docs' },
    })
    const out = markBoundaryWrapperInput(prev, e)
    expect(out).toBe(e)
    expect(out.boundary).toBeUndefined()
  })

  test('preserves an existing boundary marker (idempotent / explicit wins)', () => {
    const prev = defWith([fanout('w1', ['a1']), agent('a1')])
    const e: WorkflowEdge = {
      ...edge({
        source: { nodeId: 'w1', portName: 'docs' },
        target: { nodeId: 'a1', portName: 'docs' },
      }),
      boundary: 'wrapper-input',
    }
    const out = markBoundaryWrapperInput(prev, e)
    expect(out).toBe(e)
  })
})

describe('markBoundaryWrapperOutput', () => {
  test('tags an edge from an inner node into a wrapper-fanout output port', () => {
    const prev = defWith([fanout('w1', ['agg']), agent('agg')])
    const e = edge({
      source: { nodeId: 'agg', portName: 'summary' },
      target: { nodeId: 'w1', portName: 'summary' },
    })
    const out = markBoundaryWrapperOutput(prev, e)
    expect(out.boundary).toBe('wrapper-output')
  })

  test('no-op when target is not a wrapper-fanout', () => {
    const prev = defWith([agent('a1'), agent('a2')])
    const e = edge({
      source: { nodeId: 'a1', portName: 'out' },
      target: { nodeId: 'a2', portName: 'in' },
    })
    const out = markBoundaryWrapperOutput(prev, e)
    expect(out).toBe(e)
    expect(out.boundary).toBeUndefined()
  })

  test('no-op when the source is not in the wrapper-fanout nodeIds[]', () => {
    // Source sits outside the wrapper — this would be an external drag,
    // not a boundary edge. Runtime would refuse to interpret it as
    // wrapper-output anyway.
    const prev = defWith([fanout('w1', ['inner']), agent('outsider')])
    const e = edge({
      source: { nodeId: 'outsider', portName: 'out' },
      target: { nodeId: 'w1', portName: 'summary' },
    })
    const out = markBoundaryWrapperOutput(prev, e)
    expect(out).toBe(e)
    expect(out.boundary).toBeUndefined()
  })

  test('preserves an existing boundary marker (idempotent / explicit wins)', () => {
    const prev = defWith([fanout('w1', ['agg']), agent('agg')])
    const e: WorkflowEdge = {
      ...edge({
        source: { nodeId: 'agg', portName: 'summary' },
        target: { nodeId: 'w1', portName: 'summary' },
      }),
      boundary: 'wrapper-output',
    }
    const out = markBoundaryWrapperOutput(prev, e)
    expect(out).toBe(e)
  })
})
