// RFC-056 — cross-clarify-agent node drag helpers (parallel to clarifyDragHelper).
//
// Two drag interactions:
//
//   A. Reverse drag (questioner channel)
//      User drags from the cross-clarify node's left-side `questions`
//      input handle onto a downstream agent-single questioner node. One
//      gesture builds TWO edges:
//        1. questioner.__clarify__   → cross-clarify.questions      (ask)
//        2. cross-clarify.to_questioner → questioner.__clarify_response__
//                                       (visual, runtime wires answers
//                                        through cross_clarify_sessions)
//      Same pattern as RFC-023 reverse drag.
//
//   B. Forward drag (designer manual edge)
//      User drags from the cross-clarify node's `to_designer` output
//      handle onto an upstream agent-single designer node. One gesture
//      builds ONE edge:
//        cross-clarify.to_designer → designer.__external_feedback__
//      The `__external_feedback__` system port is synthetic — visible
//      on the canvas only while ≥ 1 cross-clarify points at the agent.
//
// All exports are pure functions, mirroring clarifyDragHelper.ts.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

export {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
}

// ---------------------------------------------------------------------------
// pre-flight checks
// ---------------------------------------------------------------------------

/**
 * True when the given workflow node can host a cross-clarify channel.
 * v1 accepts agent-single only (validator emits
 * `cross-clarify-target-not-agent-single` for any other kind, including
 * agent-multi).
 */
export function isValidCrossClarifyQuestioner(node: WorkflowNode | undefined): boolean {
  if (node === undefined) return false
  return node.kind === 'agent-single'
}

/**
 * True when the agent already has an outbound `__clarify__` edge that
 * specifically targets ANOTHER cross-clarify node — i.e. a duplicate
 * cross-clarify on the same questioner agent. Per RFC-056 design.md
 * §4.2, an agent CAN have both an RFC-023 `clarify` target AND an
 * RFC-056 `clarify-cross-agent` target on the same `__clarify__`
 * source port ("罕见但合法"); the runtime picks cross-clarify when both
 * are present. So this pre-flight intentionally does NOT block when
 * the existing edge points at a plain `clarify` node — only when it
 * points at another cross-clarify node, which would be a real
 * duplicate the validator rejects.
 */
export function questionerHasExistingClarifyChannel(
  def: WorkflowDefinition,
  agentNodeId: string,
): boolean {
  return def.edges.some((e) => {
    if (e.source.nodeId !== agentNodeId) return false
    if (e.source.portName !== CLARIFY_SOURCE_PORT_NAME) return false
    const tgt = def.nodes.find((n) => n.id === e.target.nodeId)
    return tgt?.kind === 'clarify-cross-agent'
  })
}

/**
 * True when the cross-clarify node already has its `to_designer` manual
 * edge wired. v1 v1 permits exactly one designer per cross-clarify node;
 * additional drops collapse to no-op.
 */
export function crossClarifyHasDesignerEdge(
  def: WorkflowDefinition,
  crossClarifyNodeId: string,
): boolean {
  return def.edges.some(
    (e) =>
      e.source.nodeId === crossClarifyNodeId &&
      e.source.portName === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  )
}

// ---------------------------------------------------------------------------
// builders — reverse-drag & manual-drag
// ---------------------------------------------------------------------------

/**
 * Build the two edges that materialise a cross-clarify QUESTIONER channel.
 * Caller is expected to splice both into `definition.edges[]` atomically.
 */
export function buildCrossClarifyQuestionerEdges(
  questionerNodeId: string,
  crossClarifyNodeId: string,
): [WorkflowEdge, WorkflowEdge] {
  const tail = ulid().slice(-6).toLowerCase()
  return [
    {
      id: `cross_clarify_${tail}_ask`,
      source: { nodeId: questionerNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: crossClarifyNodeId, portName: CROSS_CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: `cross_clarify_${tail}_ans`,
      source: {
        nodeId: crossClarifyNodeId,
        portName: CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
      },
      target: { nodeId: questionerNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
}

/** Build the single `to_designer → designer.__external_feedback__` edge. */
export function buildCrossClarifyDesignerEdge(
  crossClarifyNodeId: string,
  designerNodeId: string,
): WorkflowEdge {
  const tail = ulid().slice(-6).toLowerCase()
  return {
    id: `cross_clarify_${tail}_designer`,
    source: { nodeId: crossClarifyNodeId, portName: CROSS_CLARIFY_OUT_TO_DESIGNER_PORT },
    target: { nodeId: designerNodeId, portName: CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT },
  }
}

// ---------------------------------------------------------------------------
// drag-end application
// ---------------------------------------------------------------------------

/**
 * Apply the questioner reverse-drag. Same shape as RFC-023's
 * `applyClarifyReverseDrag`: returns `def` by reference on any pre-flight
 * failure, otherwise appends the two edges.
 *
 * Rejection cases:
 *   - cross-clarify nodeId missing / kind mismatch         → reject
 *   - questioner missing or not agent-single               → reject
 *   - questioner already has another clarify wired         → reject
 */
export function applyCrossClarifyQuestionerReverseDrag(
  def: WorkflowDefinition,
  args: { questionerNodeId: string; crossClarifyNodeId: string },
): WorkflowDefinition {
  const { questionerNodeId, crossClarifyNodeId } = args
  const crossNode = def.nodes.find((n) => n.id === crossClarifyNodeId)
  const agentNode = def.nodes.find((n) => n.id === questionerNodeId)
  if (crossNode === undefined || crossNode.kind !== 'clarify-cross-agent') return def
  if (!isValidCrossClarifyQuestioner(agentNode)) return def
  if (questionerHasExistingClarifyChannel(def, questionerNodeId)) return def
  const [ask, ans] = buildCrossClarifyQuestionerEdges(questionerNodeId, crossClarifyNodeId)
  return { ...def, edges: [...def.edges, ask, ans] }
}

/**
 * Apply the forward designer drag. Single edge.
 *
 * Rejection cases:
 *   - cross-clarify nodeId missing / kind mismatch         → reject
 *   - designer missing or not agent-single                 → reject
 *   - cross-clarify already has another to_designer edge   → reject
 */
export function applyCrossClarifyDesignerDrag(
  def: WorkflowDefinition,
  args: { crossClarifyNodeId: string; designerNodeId: string },
): WorkflowDefinition {
  const { crossClarifyNodeId, designerNodeId } = args
  const crossNode = def.nodes.find((n) => n.id === crossClarifyNodeId)
  const agentNode = def.nodes.find((n) => n.id === designerNodeId)
  if (crossNode === undefined || crossNode.kind !== 'clarify-cross-agent') return def
  if (agentNode === undefined || agentNode.kind !== 'agent-single') return def
  if (crossClarifyHasDesignerEdge(def, crossClarifyNodeId)) return def
  const edge = buildCrossClarifyDesignerEdge(crossClarifyNodeId, designerNodeId)
  return { ...def, edges: [...def.edges, edge] }
}

// ---------------------------------------------------------------------------
// connection classifier — for handleConnect / isValidConnection
// ---------------------------------------------------------------------------

/**
 * Pure classifier for "is this xyflow Connection a cross-clarify drop?".
 * Returns the resolved nodeIds + direction:
 *
 *   - 'questioner-reverse': source.handle='__clarify__' / target.handle='questions'
 *     OR source.handle='to_questioner' / target.handle='__clarify_response__'
 *     (forward drag dropping the answers edge onto questioner)
 *   - 'designer-forward': source.handle='to_designer' /
 *     target.handle='__external_feedback__'
 *
 * Returns null for any other shape (caller falls through to the normal
 * edge-creation path).
 */
export function classifyCrossClarifyConnection(
  def: WorkflowDefinition,
  conn: {
    source: string | null
    target: string | null
    sourceHandle: string | null
    targetHandle: string | null
  },
):
  | {
      kind: 'questioner-reverse'
      questionerNodeId: string
      crossClarifyNodeId: string
    }
  | {
      kind: 'designer-forward'
      crossClarifyNodeId: string
      designerNodeId: string
    }
  | null {
  if (conn.source === null || conn.target === null) return null

  // questioner-reverse: drop on cross-clarify.questions handle.
  if (conn.targetHandle === CROSS_CLARIFY_INPUT_PORT_NAME) {
    const tgt = def.nodes.find((n) => n.id === conn.target)
    if (tgt !== undefined && tgt.kind === 'clarify-cross-agent') {
      return {
        kind: 'questioner-reverse',
        questionerNodeId: conn.source,
        crossClarifyNodeId: conn.target,
      }
    }
  }
  // questioner-reverse via forward direction: drop cross.to_questioner →
  // agent.__clarify_response__.
  if (
    conn.sourceHandle === CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT &&
    conn.targetHandle === CLARIFY_RESPONSE_TARGET_PORT_NAME
  ) {
    const src = def.nodes.find((n) => n.id === conn.source)
    if (src !== undefined && src.kind === 'clarify-cross-agent') {
      return {
        kind: 'questioner-reverse',
        questionerNodeId: conn.target,
        crossClarifyNodeId: conn.source,
      }
    }
  }
  // designer-forward: drop cross.to_designer onto agent.__external_feedback__.
  if (conn.sourceHandle === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT) {
    const src = def.nodes.find((n) => n.id === conn.source)
    if (src !== undefined && src.kind === 'clarify-cross-agent') {
      return {
        kind: 'designer-forward',
        crossClarifyNodeId: conn.source,
        designerNodeId: conn.target,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// cleanup — node + edge removal cascade
// ---------------------------------------------------------------------------

/** Identify whether an edge is part of a cross-clarify channel + which half. */
export function describeCrossClarifyChannelEdge(edge: WorkflowEdge):
  | {
      crossClarifyNodeId: string
      questionerNodeId: string
      half: 'ask' | 'ans'
    }
  | { crossClarifyNodeId: string; designerNodeId: string; half: 'designer' }
  | null {
  if (
    edge.source.portName === CLARIFY_SOURCE_PORT_NAME &&
    edge.target.portName === CROSS_CLARIFY_INPUT_PORT_NAME
  ) {
    return {
      questionerNodeId: edge.source.nodeId,
      crossClarifyNodeId: edge.target.nodeId,
      half: 'ask',
    }
  }
  if (
    edge.source.portName === CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT &&
    edge.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME
  ) {
    return {
      crossClarifyNodeId: edge.source.nodeId,
      questionerNodeId: edge.target.nodeId,
      half: 'ans',
    }
  }
  if (
    edge.source.portName === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT &&
    edge.target.portName === CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT
  ) {
    return {
      crossClarifyNodeId: edge.source.nodeId,
      designerNodeId: edge.target.nodeId,
      half: 'designer',
    }
  }
  return null
}

/** Cascade-remove cross-clarify edges when the user deletes a node. */
export function clearCrossClarifyEdgesForRemovedNodes(
  def: WorkflowDefinition,
  removedIds: ReadonlyArray<string>,
): WorkflowDefinition {
  if (removedIds.length === 0) return def
  const removed = new Set(removedIds)
  let changed = false
  const nextEdges = def.edges.filter((e) => {
    const refsRemoved = removed.has(e.source.nodeId) || removed.has(e.target.nodeId)
    if (!refsRemoved) return true
    if (describeCrossClarifyChannelEdge(e) !== null) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...def, edges: nextEdges } : def
}
