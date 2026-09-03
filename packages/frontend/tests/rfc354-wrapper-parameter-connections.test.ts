// RFC-354 — wrapper-git / wrapper-loop are nodes like any other on the canvas:
// an ordinary inbound edge declares a PARAMETER, and the wrapper hands it to
// its body through a `wrapper-input` boundary edge (the plumbing fan-out has
// always used). Replaces `canvas-wrapper-inbound-guard.test.ts`, which locked
// the pre-354 "no inbound ports on git / loop" rejection.
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { markBoundaryWrapperInput } from '../src/lib/workflow-connection-boundary'
import {
  planWorkflowConnection,
  type WorkflowSemanticContext,
} from '../src/lib/workflow-connection-plan'

function node(value: Record<string, unknown>): WorkflowNode {
  return value as unknown as WorkflowNode
}
const context: WorkflowSemanticContext = { agentsByName: {}, inventoryRevision: 'inventory-1' }
const def: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    node({ id: 'seed', kind: 'agent-single', agentName: 'seed', position: { x: 0, y: 0 } }),
    node({ id: 'git', kind: 'wrapper-git', nodeIds: ['worker'], position: { x: 0, y: 0 } }),
    node({
      id: 'loop',
      kind: 'wrapper-loop',
      nodeIds: ['checker'],
      maxIterations: 2,
      exitCondition: { kind: 'port-empty', nodeId: 'checker', portName: 'result' },
      outputBindings: [],
      position: { x: 0, y: 0 },
    }),
    node({ id: 'worker', kind: 'agent-single', agentName: 'w', position: { x: 0, y: 0 } }),
    node({ id: 'checker', kind: 'agent-single', agentName: 'c', position: { x: 0, y: 0 } }),
  ],
  edges: [],
}

describe('RFC-354 — wrapper parameters on the canvas', () => {
  test.each(['git', 'loop'] as const)(
    'an inbound edge into wrapper-%s plans as a parameter',
    (wrapperId) => {
      const plan = planWorkflowConnection(
        def,
        {
          kind: 'generic',
          edgeId: 'param',
          source: { nodeId: 'seed', portName: 'findings' },
          targetNodeId: wrapperId,
          target: { mode: 'new', portName: 'findings' },
        },
        context,
      )
      expect(plan.ok).toBe(true)
      if (!plan.ok) return
      expect(plan.addEdges).toEqual([
        {
          id: 'param',
          source: { nodeId: 'seed', portName: 'findings' },
          target: { nodeId: wrapperId, portName: 'findings' },
        },
      ])
      // A parameter has no declared kind of its own — nothing to be incompatible with.
      expect(plan.compatibility).toBe('compatible')
    },
  )

  test('a wrapper → member edge is tagged as the wrapper-input hand-off for every wrapper kind', () => {
    const edge: WorkflowEdge = {
      id: 'handoff',
      source: { nodeId: 'loop', portName: 'findings' },
      target: { nodeId: 'checker', portName: 'in' },
    }
    expect(markBoundaryWrapperInput(def, edge)).toEqual({ ...edge, boundary: 'wrapper-input' })
    const gitEdge: WorkflowEdge = {
      id: 'handoff-git',
      source: { nodeId: 'git', portName: 'findings' },
      target: { nodeId: 'worker', portName: 'in' },
    }
    expect(markBoundaryWrapperInput(def, gitEdge)).toEqual({
      ...gitEdge,
      boundary: 'wrapper-input',
    })
    // A wrapper → NON-member edge stays an ordinary edge (a closure into a
    // sibling scope is validated server-side, not tagged here).
    const outside: WorkflowEdge = {
      id: 'outside',
      source: { nodeId: 'loop', portName: 'findings' },
      target: { nodeId: 'worker', portName: 'in' },
    }
    expect(markBoundaryWrapperInput(def, outside)).toBe(outside)
  })

  test('kinds with no inbound data are still rejected', () => {
    const withInput: WorkflowDefinition = {
      ...def,
      nodes: [...def.nodes, node({ id: 'launcher', kind: 'input', position: { x: 0, y: 0 } })],
    }
    const plan = planWorkflowConnection(
      withInput,
      {
        kind: 'generic',
        edgeId: 'bad',
        source: { nodeId: 'seed', portName: 'findings' },
        targetNodeId: 'launcher',
        target: { mode: 'new', portName: 'x' },
      },
      context,
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason.code).toBe('connection-target-unsupported')
  })
})
