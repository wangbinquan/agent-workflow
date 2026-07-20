// RFC-199 B0 / T0.5 — golden-lock the legacy drag-connect semantics before
// B5 replaces the inline WorkflowCanvas branches with a shared planner.
//
// This intentionally composes the same production helpers used by the live
// drag path. The fixture covers the two geometric outcomes (NEW / REUSE), the
// review and output field mirrors, the paired clarify channel, and fan-out
// boundary tagging. B5 may change the implementation shape, but these exact
// graph results remain the equivalence oracle.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildEdgeFromConnection,
  markBoundaryWrapperInput,
  markBoundaryWrapperOutput,
} from '../src/components/canvas/WorkflowCanvas'
import {
  applyClarifyReverseDrag,
  classifyClarifyConnection,
} from '../src/components/canvas/clarifyDragHelper'
import {
  applyConnectionForReviewOutput,
  REVIEW_INPUT_HANDLE_ID,
} from '../src/components/canvas/connectionSync'
import { resolveDropTarget } from '../src/components/canvas/connectResolve'
import {
  createWorkflowSemanticContext,
  planWorkflowConnection,
  type ConnectionRequest,
} from '../src/lib/workflow-connection-plan'
import { applyWorkflowTransition } from '../src/lib/workflow-transition'

function node(value: Record<string, unknown>): WorkflowNode {
  return value as unknown as WorkflowNode
}

function definition(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes,
    edges,
  }
}

function agent(id: string): WorkflowNode {
  return node({ id, kind: 'agent-single', agentName: id, position: { x: 0, y: 0 } })
}

function edgeShape(edge: WorkflowEdge): Omit<WorkflowEdge, 'id'> {
  const { id: _id, ...shape } = edge
  return shape
}

function installExistingInputHandle(nodeId: string, portName: string, x: number, y: number): void {
  const root = document.createElement('div')
  root.className = 'react-flow__node'
  root.dataset.id = nodeId
  const handle = document.createElement('div')
  handle.className = 'react-flow__handle'
  handle.dataset.handleid = portName
  Object.defineProperty(handle, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: x - 4,
      top: y - 4,
      right: x + 4,
      bottom: y + 4,
      width: 8,
      height: 8,
      x: x - 4,
      y: y - 4,
      toJSON: () => ({}),
    }),
  })
  root.appendChild(handle)
  document.body.appendChild(root)
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('RFC-199 T0.5 legacy drag-connect golden', () => {
  test('body drop resolves NEW and deconflicts the target input name', () => {
    const def = definition(
      [agent('source'), agent('prior'), agent('target')],
      [
        {
          id: 'existing',
          source: { nodeId: 'prior', portName: 'result' },
          target: { nodeId: 'target', portName: 'result' },
        },
      ],
    )
    installExistingInputHandle('target', 'result', 220, 120)

    const resolved = resolveDropTarget(
      def,
      [{ id: 'target', x: 200, y: 100, w: 240, h: 120 }],
      { x: 300, y: 160 },
      { x: 300, y: 160 },
      'source',
      'result',
    )
    expect(resolved).toEqual({ kind: 'new', nodeId: 'target', portName: 'result_2' })

    const built = buildEdgeFromConnection(def, {
      source: 'source',
      target: resolved?.nodeId,
      sourceHandle: 'result',
      targetHandle: resolved?.portName,
    })
    expect(built).not.toBeNull()
    expect(edgeShape(built!)).toEqual({
      source: { nodeId: 'source', portName: 'result' },
      target: { nodeId: 'target', portName: 'result_2' },
    })
  })

  test('precise handle drop resolves REUSE and replaces the occupied input source', () => {
    const existing: WorkflowEdge = {
      id: 'existing',
      source: { nodeId: 'prior', portName: 'result' },
      target: { nodeId: 'target', portName: 'requirement' },
    }
    const def = definition([agent('source'), agent('prior'), agent('target')], [existing])
    installExistingInputHandle('target', 'requirement', 220, 120)

    const resolved = resolveDropTarget(
      def,
      [{ id: 'target', x: 200, y: 100, w: 240, h: 120 }],
      { x: 220, y: 120 },
      { x: 220, y: 120 },
      'source',
      'result',
    )
    expect(resolved).toEqual({ kind: 'reuse', nodeId: 'target', portName: 'requirement' })

    const built = buildEdgeFromConnection(def, {
      source: 'source',
      target: resolved?.nodeId,
      sourceHandle: 'result',
      targetHandle: resolved?.portName,
    })
    expect(built).not.toBeNull()
    const replaced = [
      ...def.edges.filter(
        (candidate) =>
          !(
            candidate.target.nodeId === built!.target.nodeId &&
            candidate.target.portName === resolved?.portName
          ),
      ),
      built!,
    ]
    expect(replaced.map(edgeShape)).toEqual([
      {
        source: { nodeId: 'source', portName: 'result' },
        target: { nodeId: 'target', portName: 'requirement' },
      },
    ])
  })

  test('review drag writes the fixed input edge and inputSource mirror together', () => {
    const def = definition([
      agent('source'),
      node({
        id: 'review',
        kind: 'review',
        inputSource: { nodeId: '', portName: '' },
        position: { x: 300, y: 0 },
      }),
    ])
    const built = buildEdgeFromConnection(def, {
      source: 'source',
      target: 'review',
      sourceHandle: 'document',
      targetHandle: REVIEW_INPUT_HANDLE_ID,
    })!
    const next = applyConnectionForReviewOutput({ ...def, edges: [built] }, built)

    expect(next.edges.map(edgeShape)).toEqual([
      {
        source: { nodeId: 'source', portName: 'document' },
        target: { nodeId: 'review', portName: REVIEW_INPUT_HANDLE_ID },
      },
    ])
    expect(next.nodes.find((candidate) => candidate.id === 'review')).toMatchObject({
      inputSource: { nodeId: 'source', portName: 'document' },
    })
  })

  test('output catch-all drag appends the named port and bind mirror', () => {
    const def = definition([
      agent('source'),
      node({ id: 'output', kind: 'output', ports: [], position: { x: 300, y: 0 } }),
    ])
    const built = buildEdgeFromConnection(def, {
      source: 'source',
      target: 'output',
      sourceHandle: 'report',
      targetHandle: 'report',
    })!
    const next = applyConnectionForReviewOutput({ ...def, edges: [built] }, built, {
      viaCatchAll: true,
    })

    expect(next.nodes.find((candidate) => candidate.id === 'output')).toMatchObject({
      ports: [{ name: 'report', bind: { nodeId: 'source', portName: 'report' } }],
    })
    expect(next.edges.map(edgeShape)).toEqual([
      {
        source: { nodeId: 'source', portName: 'report' },
        target: { nodeId: 'output', portName: 'report' },
      },
    ])
  })

  test('clarify drag produces the same paired channel in either classified direction', () => {
    const def = definition([
      agent('source'),
      node({ id: 'clarify', kind: 'clarify', position: { x: 300, y: 0 } }),
    ])
    const reverse = classifyClarifyConnection(def, {
      source: 'source',
      target: 'clarify',
      sourceHandle: 'ignored-business-output',
      targetHandle: 'questions',
    })
    const forward = classifyClarifyConnection(def, {
      source: 'clarify',
      target: 'source',
      sourceHandle: 'answers',
      targetHandle: 'ignored-business-input',
    })
    expect(reverse).toEqual({
      sourceAgentNodeId: 'source',
      clarifyNodeId: 'clarify',
      direction: 'reverse',
    })
    expect(forward).toEqual({
      sourceAgentNodeId: 'source',
      clarifyNodeId: 'clarify',
      direction: 'forward',
    })

    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: reverse!.sourceAgentNodeId,
      clarifyNodeId: reverse!.clarifyNodeId,
    })
    expect(next.edges.map(edgeShape)).toEqual([
      {
        source: { nodeId: 'source', portName: '__clarify__' },
        target: { nodeId: 'clarify', portName: 'questions' },
      },
      {
        source: { nodeId: 'clarify', portName: 'answers' },
        target: { nodeId: 'source', portName: '__clarify_response__' },
      },
    ])
  })

  test('fan-out inner crossings retain their input/output boundary authority', () => {
    const wrapper = node({
      id: 'fanout',
      kind: 'wrapper-fanout',
      nodeIds: ['inner'],
      inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      position: { x: 0, y: 0 },
    })
    const def = definition([wrapper, agent('inner')])
    const input = markBoundaryWrapperInput(def, {
      id: 'input',
      source: { nodeId: 'fanout', portName: 'docs' },
      target: { nodeId: 'inner', portName: 'docs' },
    })
    const output = markBoundaryWrapperOutput(def, {
      id: 'output',
      source: { nodeId: 'inner', portName: 'summary' },
      target: { nodeId: 'fanout', portName: 'summary' },
    })

    expect(input.boundary).toBe('wrapper-input')
    expect(output.boundary).toBe('wrapper-output')
  })
})

describe('RFC-199 B5 planner adapter equivalence', () => {
  const semantic = createWorkflowSemanticContext([
    {
      name: 'source',
      outputs: ['result', 'document', 'report'],
      outputKinds: { result: 'string', document: 'markdown', report: 'markdown' },
    },
  ])

  function applyRequest(def: WorkflowDefinition, request: ConnectionRequest): WorkflowDefinition {
    const plan = planWorkflowConnection(def, request, semantic)
    if (!plan.ok) throw new Error(plan.reason.code)
    return applyWorkflowTransition(def, { kind: 'connection', plan }, semantic).next
  }

  test('NEW and REUSE preserve the legacy target-port outcomes', () => {
    const existing: WorkflowEdge = {
      id: 'existing',
      source: { nodeId: 'prior', portName: 'result' },
      target: { nodeId: 'target', portName: 'result' },
    }
    const def = definition([agent('source'), agent('prior'), agent('target')], [existing])

    const added = applyRequest(def, {
      kind: 'generic',
      edgeId: 'new-edge',
      source: { nodeId: 'source', portName: 'result' },
      targetNodeId: 'target',
      target: { mode: 'new', portName: 'result_2' },
    })
    const legacyAdded: WorkflowDefinition = {
      ...def,
      edges: [
        ...def.edges,
        {
          id: 'new-edge',
          source: { nodeId: 'source', portName: 'result' },
          target: { nodeId: 'target', portName: 'result_2' },
        },
      ],
    }
    expect(JSON.stringify(added)).toBe(JSON.stringify(legacyAdded))
    expect(added.edges.map(edgeShape)).toEqual([
      edgeShape(existing),
      {
        source: { nodeId: 'source', portName: 'result' },
        target: { nodeId: 'target', portName: 'result_2' },
      },
    ])

    const reused = applyRequest(def, {
      kind: 'generic',
      edgeId: 'reuse-edge',
      source: { nodeId: 'source', portName: 'result' },
      targetNodeId: 'target',
      target: { mode: 'reuse', portName: 'result' },
    })
    const legacyReused: WorkflowDefinition = {
      ...def,
      edges: [
        {
          id: 'reuse-edge',
          source: { nodeId: 'source', portName: 'result' },
          target: { nodeId: 'target', portName: 'result' },
        },
      ],
    }
    expect(JSON.stringify(reused)).toBe(JSON.stringify(legacyReused))
    expect(reused.edges.map(edgeShape)).toEqual([
      {
        source: { nodeId: 'source', portName: 'result' },
        target: { nodeId: 'target', portName: 'result' },
      },
    ])
  })

  test('review/output mirrors and clarify pair remain one atomic result', () => {
    const reviewDef = definition([
      agent('source'),
      node({
        id: 'review',
        kind: 'review',
        inputSource: { nodeId: '', portName: '' },
      }),
    ])
    const review = applyRequest(reviewDef, {
      kind: 'generic',
      edgeId: 'review-edge',
      source: { nodeId: 'source', portName: 'document' },
      targetNodeId: 'review',
      target: { mode: 'reuse', portName: REVIEW_INPUT_HANDLE_ID },
    })
    const reviewEdge: WorkflowEdge = {
      id: 'review-edge',
      source: { nodeId: 'source', portName: 'document' },
      target: { nodeId: 'review', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const legacyReview = applyConnectionForReviewOutput(
      { ...reviewDef, edges: [reviewEdge] },
      reviewEdge,
    )
    expect(JSON.stringify(review)).toBe(JSON.stringify(legacyReview))
    expect(review.nodes.find((candidate) => candidate.id === 'review')).toMatchObject({
      inputSource: { nodeId: 'source', portName: 'document' },
    })

    const outputDef = definition([
      agent('source'),
      node({ id: 'output', kind: 'output', ports: [] }),
    ])
    const output = applyRequest(outputDef, {
      kind: 'generic',
      edgeId: 'output-edge',
      source: { nodeId: 'source', portName: 'report' },
      targetNodeId: 'output',
      target: { mode: 'new', portName: 'report' },
    })
    const outputEdge: WorkflowEdge = {
      id: 'output-edge',
      source: { nodeId: 'source', portName: 'report' },
      target: { nodeId: 'output', portName: 'report' },
    }
    const legacyOutput = applyConnectionForReviewOutput(
      { ...outputDef, edges: [outputEdge] },
      outputEdge,
      { viaCatchAll: true },
    )
    expect(JSON.stringify(output)).toBe(JSON.stringify(legacyOutput))
    expect(output.nodes.find((candidate) => candidate.id === 'output')).toMatchObject({
      ports: [{ name: 'report', bind: { nodeId: 'source', portName: 'report' } }],
    })

    const clarifyDef = definition([agent('source'), node({ id: 'clarify', kind: 'clarify' })])
    const clarify = applyRequest(clarifyDef, {
      kind: 'clarify-questioner',
      questionerNodeId: 'source',
      clarifyNodeId: 'clarify',
      edgeIds: { ask: 'ask', answer: 'answer' },
    })
    expect(clarify.edges.map(edgeShape)).toEqual([
      {
        source: { nodeId: 'source', portName: '__clarify__' },
        target: { nodeId: 'clarify', portName: 'questions' },
      },
      {
        source: { nodeId: 'clarify', portName: 'answers' },
        target: { nodeId: 'source', portName: '__clarify_response__' },
      },
    ])
  })

  test('generic inner crossings keep the same fan-out boundary tags', () => {
    const def = definition([
      node({
        id: 'fanout',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      }),
      agent('inner'),
    ])
    const withInput = applyRequest(def, {
      kind: 'generic',
      edgeId: 'input',
      source: { nodeId: 'fanout', portName: 'docs' },
      targetNodeId: 'inner',
      target: { mode: 'reuse', portName: 'docs' },
    })
    const legacyInput = markBoundaryWrapperInput(def, {
      id: 'input',
      source: { nodeId: 'fanout', portName: 'docs' },
      target: { nodeId: 'inner', portName: 'docs' },
    })
    expect(JSON.stringify(withInput)).toBe(JSON.stringify({ ...def, edges: [legacyInput] }))
    const withOutput = applyRequest(withInput, {
      kind: 'generic',
      edgeId: 'output',
      source: { nodeId: 'inner', portName: 'summary' },
      targetNodeId: 'fanout',
      target: { mode: 'reuse', portName: 'summary' },
    })
    const legacyOutput = markBoundaryWrapperOutput(withInput, {
      id: 'output',
      source: { nodeId: 'inner', portName: 'summary' },
      target: { nodeId: 'fanout', portName: 'summary' },
    })
    expect(JSON.stringify(withOutput)).toBe(
      JSON.stringify({ ...withInput, edges: [...withInput.edges, legacyOutput] }),
    )
    expect(withOutput.edges.map((edge) => edge.boundary)).toEqual([
      'wrapper-input',
      'wrapper-output',
    ])
  })
})
