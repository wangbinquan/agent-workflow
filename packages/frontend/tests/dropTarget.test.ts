// RFC-106 — the pure building blocks of drop resolution: deconflicted new-input
// naming (`nextFreeInputPort`, the same-name fan-in fix) and the input-port
// derivation (`existingInputPorts`). The node hit-test (`findNewInputTarget`)
// and the new-vs-reuse resolution are locked in connect-drop-hint.test.ts.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { existingInputPorts, nextFreeInputPort } from '../src/components/canvas/dropTarget'

function def(
  nodes: Array<{ id: string; kind: string } & Record<string, unknown>>,
  edges: Array<{ s: [string, string]; t: [string, string]; boundary?: string }> = [],
): WorkflowDefinition {
  return {
    nodes: nodes as unknown as WorkflowNode[],
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      source: { nodeId: e.s[0], portName: e.s[1] },
      target: { nodeId: e.t[0], portName: e.t[1] },
      ...(e.boundary !== undefined ? { boundary: e.boundary } : {}),
    })) as unknown as WorkflowEdge[],
  } as unknown as WorkflowDefinition
}

describe('nextFreeInputPort', () => {
  test('no collision → desired unchanged', () => {
    expect(nextFreeInputPort(['a', 'b'], 'result')).toBe('result')
  })
  test('collision → _2', () => {
    expect(nextFreeInputPort(['result'], 'result')).toBe('result_2')
  })
  test('consecutive occupancy skips ahead', () => {
    expect(nextFreeInputPort(['result', 'result_2', 'result_3'], 'result')).toBe('result_4')
  })
})

describe('existingInputPorts', () => {
  test('derives from inbound edges; excludes wrapper-output boundary; output ports are edges too (RFC-354)', () => {
    const d = def(
      [
        { id: 'C', kind: 'agent-single', agentName: 'x' },
        { id: 'O', kind: 'output' },
      ],
      [
        { s: ['A', 'r'], t: ['C', 'in1'] },
        { s: ['B', 'r'], t: ['C', 'in2'] },
        { s: ['B', 'r'], t: ['O', 'declared'] },
        { s: ['C', 'o'], t: ['O', 'collected'], boundary: 'wrapper-output' }, // excluded
      ],
    )
    expect(existingInputPorts(d, d.nodes[0]!)).toEqual(['in1', 'in2'])
    expect(existingInputPorts(d, d.nodes[1]!)).toEqual(['declared'])
  })
})
