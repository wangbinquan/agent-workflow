// RFC-056 PR-C T9 — locks the cross-clarify drag helper contract.
//
// LOCKS:
//   1. applyCrossClarifyQuestionerReverseDrag mints the 2 expected edges
//      (questioner.__clarify__ → cross.questions /
//       cross.to_questioner → questioner.__clarify_response__).
//   2. applyCrossClarifyDesignerDrag mints the 1 expected edge
//      (cross.to_designer → designer.__external_feedback__).
//   3. Pre-flight rejections: agent-multi questioner is rejected; v1 strict.
//   4. Pre-flight rejections: designer drop onto agent-multi is rejected.
//   5. crossClarifyHasDesignerEdge true after applyDesignerDrag.
//   6. classifyCrossClarifyConnection returns 'questioner-reverse' for
//      reverse-drag drops on cross.questions handle.
//   7. classifyCrossClarifyConnection returns 'designer-forward' for
//      forward drag on cross.to_designer source.
//   8. clearCrossClarifyEdgesForRemovedNodes drops cross-clarify edges
//      cascading from a removed designer.
//
// If any of these go red the canvas drag UX has drifted — investigate
// before relaxing.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import {
  applyCrossClarifyDesignerDrag,
  applyCrossClarifyQuestionerReverseDrag,
  buildCrossClarifyDesignerEdge,
  buildCrossClarifyQuestionerEdges,
  classifyCrossClarifyConnection,
  clearCrossClarifyEdgesForRemovedNodes,
  crossClarifyHasDesignerEdge,
} from '../src/components/canvas/crossClarifyDragHelper'

function baseDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [],
    outputs: [],
  }
}

describe('RFC-056 buildCrossClarifyQuestionerEdges', () => {
  test('returns ask + ans edges with the correct port wiring', () => {
    const [ask, ans] = buildCrossClarifyQuestionerEdges('questioner', 'cross1')
    expect(ask.source).toEqual({ nodeId: 'questioner', portName: '__clarify__' })
    expect(ask.target).toEqual({ nodeId: 'cross1', portName: 'questions' })
    expect(ans.source).toEqual({ nodeId: 'cross1', portName: 'to_questioner' })
    expect(ans.target).toEqual({ nodeId: 'questioner', portName: '__clarify_response__' })
  })
})

describe('RFC-056 buildCrossClarifyDesignerEdge', () => {
  test('returns the single edge wiring cross.to_designer → designer.__external_feedback__', () => {
    const edge = buildCrossClarifyDesignerEdge('cross1', 'designer')
    expect(edge.source).toEqual({ nodeId: 'cross1', portName: 'to_designer' })
    expect(edge.target).toEqual({ nodeId: 'designer', portName: '__external_feedback__' })
  })
})

describe('RFC-056 applyCrossClarifyQuestionerReverseDrag', () => {
  test('appends 2 edges on happy path', () => {
    const def = baseDef()
    const next = applyCrossClarifyQuestionerReverseDrag(def, {
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
    expect(next.edges.length).toBe(2)
    expect(next.edges[0]?.source.portName).toBe('__clarify__')
    expect(next.edges[1]?.source.portName).toBe('to_questioner')
  })

  test('rejects when questioner is agent-multi (v1 strict)', () => {
    const def = {
      ...baseDef(),
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer' as string },
        { id: 'questioner', kind: 'agent-multi', agentName: 'questioner' as string },
        { id: 'cross1', kind: 'clarify-cross-agent' as const },
      ],
    } as unknown as WorkflowDefinition
    const next = applyCrossClarifyQuestionerReverseDrag(def, {
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
    expect(next).toBe(def)
  })

  test('rejects when the questioner already has another cross-clarify wired (would be duplicate cross-clarify)', () => {
    const def = baseDef()
    def.nodes.push({ id: 'cross2', kind: 'clarify-cross-agent' })
    def.edges.push({
      id: 'pre',
      source: { nodeId: 'questioner', portName: '__clarify__' },
      target: { nodeId: 'cross2', portName: 'questions' },
    })
    const next = applyCrossClarifyQuestionerReverseDrag(def, {
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
    expect(next).toBe(def)
  })

  test('ALLOWS coexistence with an existing RFC-023 clarify (per RFC-056 design.md §4.2: cross-clarify wins at runtime)', () => {
    // An agent CAN have both a plain `clarify` target AND a
    // `clarify-cross-agent` target on the same `__clarify__` source port.
    // The pre-flight must NOT reject the cross-clarify drop in that case
    // — the canvas would otherwise prevent a legal configuration the
    // runtime explicitly supports.
    const def = baseDef()
    def.nodes.push({ id: 'self_clarify', kind: 'clarify' })
    def.edges.push({
      id: 'pre_self',
      source: { nodeId: 'questioner', portName: '__clarify__' },
      target: { nodeId: 'self_clarify', portName: 'questions' },
    })
    const next = applyCrossClarifyQuestionerReverseDrag(def, {
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
    // Two new edges appended (ask + ans) on top of the pre-existing
    // self-clarify edge; the self-clarify edge is preserved.
    expect(next).not.toBe(def)
    expect(next.edges.length).toBe(3)
    expect(
      next.edges.some(
        (e) => e.source.portName === '__clarify__' && e.target.nodeId === 'self_clarify',
      ),
    ).toBe(true)
    expect(
      next.edges.some((e) => e.source.portName === '__clarify__' && e.target.nodeId === 'cross1'),
    ).toBe(true)
  })
})

describe('RFC-056 applyCrossClarifyDesignerDrag', () => {
  test('appends 1 edge on happy path', () => {
    const def = baseDef()
    const next = applyCrossClarifyDesignerDrag(def, {
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
    expect(next.edges.length).toBe(1)
    expect(next.edges[0]?.target.portName).toBe('__external_feedback__')
  })

  test('rejects when designer is agent-multi (v1 strict)', () => {
    const def = baseDef() as WorkflowDefinition
    def.nodes = def.nodes.map((n) =>
      n.id === 'designer' ? { ...n, kind: 'agent-multi' as const } : n,
    )
    const next = applyCrossClarifyDesignerDrag(def, {
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
    expect(next).toBe(def)
  })

  test('rejects when cross-clarify already has another to_designer edge', () => {
    let def = baseDef()
    def = applyCrossClarifyDesignerDrag(def, {
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
    expect(def.edges.length).toBe(1)
    expect(crossClarifyHasDesignerEdge(def, 'cross1')).toBe(true)
    const next = applyCrossClarifyDesignerDrag(def, {
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
    expect(next).toBe(def)
  })
})

describe('RFC-056 classifyCrossClarifyConnection', () => {
  test('reverse-drag drops on cross.questions handle return "questioner-reverse"', () => {
    const def = baseDef()
    const out = classifyCrossClarifyConnection(def, {
      source: 'questioner',
      target: 'cross1',
      sourceHandle: '__clarify__',
      targetHandle: 'questions',
    })
    expect(out).toEqual({
      kind: 'questioner-reverse',
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
  })

  test('forward drag from cross.to_designer returns "designer-forward"', () => {
    const def = baseDef()
    const out = classifyCrossClarifyConnection(def, {
      source: 'cross1',
      target: 'designer',
      sourceHandle: 'to_designer',
      targetHandle: '__external_feedback__',
    })
    expect(out).toEqual({
      kind: 'designer-forward',
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
  })

  test('null when neither end is a cross-clarify node', () => {
    const def = baseDef()
    const out = classifyCrossClarifyConnection(def, {
      source: 'questioner',
      target: 'designer',
      sourceHandle: 'main',
      targetHandle: 'inp',
    })
    expect(out).toBeNull()
  })
})

describe('RFC-056 clearCrossClarifyEdgesForRemovedNodes', () => {
  test('drops all 3 cross-clarify channel edges when the cross-clarify node is removed', () => {
    let def = baseDef()
    def = applyCrossClarifyQuestionerReverseDrag(def, {
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
    def = applyCrossClarifyDesignerDrag(def, {
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
    expect(def.edges.length).toBe(3)
    const next = clearCrossClarifyEdgesForRemovedNodes(def, ['cross1'])
    expect(next.edges.length).toBe(0)
  })

  test('drops only the to_designer edge when only the designer is removed', () => {
    let def = baseDef()
    def = applyCrossClarifyQuestionerReverseDrag(def, {
      questionerNodeId: 'questioner',
      crossClarifyNodeId: 'cross1',
    })
    def = applyCrossClarifyDesignerDrag(def, {
      crossClarifyNodeId: 'cross1',
      designerNodeId: 'designer',
    })
    const next = clearCrossClarifyEdgesForRemovedNodes(def, ['designer'])
    expect(next.edges.length).toBe(2)
    // Remaining edges are the ask + ans questioner channel.
    const ports = next.edges.map((e) => e.source.portName)
    expect(ports.sort()).toEqual(['__clarify__', 'to_questioner'])
  })
})
