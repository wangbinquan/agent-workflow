// RFC-023 — clarify node reverse-drag helpers.
//
// Reverse-drag UX: the user starts a drag from the clarify node's left-side
// input handle (`questions`) and drops it onto an agent-{single,multi} node.
// That single user gesture must produce TWO edges in `definition.edges[]`:
//
//   1. `agent.__clarify__`   → `clarify.questions`          (ask channel)
//   2. `clarify.answers`     → `agent.__clarify_response__` (answer channel —
//                                                            visual only; runtime
//                                                            injects answers via
//                                                            prompt context)
//
// The second edge is "visual only" in the runtime sense: the scheduler reads
// `clarify_session` rows + ClarifyService to wire answers back into the
// asking agent's next-round prompt, not through this edge. The edge still
// exists for canvas legibility — without it, the user sees a one-way arrow
// out of the agent and the cycle isn't obvious. Deleting the second edge in
// the canvas does NOT break answer injection (asserted by
// `clarify-reverse-drag-two-edges.test.ts` via the taskDagGraph owner).
//
// All exports are pure functions. Mirrors connectionSync conventions so
// WorkflowCanvas.handleConnect can chain them with the existing
// review/output drag branches.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

export {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
}

/**
 * True when the given workflow node can host a clarify channel. v1 accepts
 * agent-single only (RFC-060 PR-E removed agent-multi). Wrapper-git /
 * wrapper-loop / wrapper-fanout / review / output / input / another clarify
 * are all rejected (the validator emits `clarify-target-not-agent` for the
 * same set; this fn keeps the canvas pre-flight check in sync).
 */
export function isValidClarifyTarget(node: WorkflowNode | undefined): boolean {
  if (node === undefined) return false
  return node.kind === 'agent-single'
}

/**
 * True when the given agent node already has a clarify channel wired
 * (outbound edge on its system `__clarify__` port). Used by the drag
 * handler to short-circuit the second drop before the schema-level
 * `clarify-multiple-clarify-on-same-agent` validator rule would catch it.
 */
export function hasExistingClarifyChannel(def: WorkflowDefinition, agentNodeId: string): boolean {
  return def.edges.some(
    (e) => e.source.nodeId === agentNodeId && e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
}

/**
 * RFC-063 — true when the given clarify node already has an agent attached
 * via the reverse-drag pattern (inbound edge on `questions` from an
 * `__clarify__` source port). Used by the drag handler to short-circuit
 * a second-agent drop before the schema-level
 * `clarify-multiple-source-agents` validator rule would catch it on save.
 * This is the canvas-level mirror of `hasExistingClarifyChannel`: that one
 * blocks the reverse direction (one agent → many clarify); this blocks the
 * forward direction (one clarify → many agents).
 */
export function clarifyHasAttachedAgent(def: WorkflowDefinition, clarifyNodeId: string): boolean {
  return def.edges.some(
    (e) =>
      e.target.nodeId === clarifyNodeId &&
      e.target.portName === CLARIFY_INPUT_PORT_NAME &&
      e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
}

/**
 * Build the pair of edges that materialise a clarify channel between a
 * source agent and a clarify node. Caller is expected to splice both into
 * `definition.edges[]` in one commit so the canvas never momentarily shows
 * a half-wired cycle.
 *
 * Edge IDs are ULID-derived for collision safety with multi-rapid-drag
 * users; tests can match on the `_ask` / `_ans` suffix instead of the
 * random tail.
 */
export function buildClarifyEdges(
  sourceAgentNodeId: string,
  clarifyNodeId: string,
): [WorkflowEdge, WorkflowEdge] {
  const tail = ulid().slice(-6).toLowerCase()
  return [
    {
      id: `clarify_${tail}_ask`,
      source: { nodeId: sourceAgentNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: clarifyNodeId, portName: CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: `clarify_${tail}_ans`,
      source: { nodeId: clarifyNodeId, portName: CLARIFY_OUTPUT_PORT_NAME },
      target: { nodeId: sourceAgentNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
}

/**
 * Convenience for the canvas connect handler: validate the drop, look up
 * the agent node, and splice the two edges in atomically. Returns the
 * original `def` by reference when validation fails so React effects can
 * short-circuit on `===`.
 *
 *   - clarifyNodeId / sourceAgentNodeId not in def        → reject
 *   - source is not agent-single                            → reject
 *   - the agent already has another clarify wired          → reject
 *   - otherwise: append both edges and return new def
 */
export function applyClarifyReverseDrag(
  def: WorkflowDefinition,
  args: { sourceAgentNodeId: string; clarifyNodeId: string },
): WorkflowDefinition {
  const { sourceAgentNodeId, clarifyNodeId } = args
  const clarifyNode = def.nodes.find((n) => n.id === clarifyNodeId)
  const agentNode = def.nodes.find((n) => n.id === sourceAgentNodeId)
  if (clarifyNode === undefined || clarifyNode.kind !== 'clarify') return def
  if (!isValidClarifyTarget(agentNode)) return def
  if (hasExistingClarifyChannel(def, sourceAgentNodeId)) return def
  // RFC-063: a single clarify node may only attach to one agent. Block a
  // second-agent reverse-drag before the validator catches it on save.
  if (clarifyHasAttachedAgent(def, clarifyNodeId)) return def
  const [ask, ans] = buildClarifyEdges(sourceAgentNodeId, clarifyNodeId)
  return { ...def, edges: [...def.edges, ask, ans] }
}

/**
 * Pure classifier for "is this xyflow Connection a clarify-channel drop?"
 * Used by both `handleConnect` (to route the drop into
 * `applyClarifyReverseDrag`) and `isValidConnection` (to fast-fail before
 * xyflow commits a stray normal edge). Returns the (agent, clarify) pair
 * the drop implies + which direction the user dragged. Returns null when
 * the connection is NOT a clarify-channel drop (caller falls through to
 * the normal edge-creation path).
 *
 * The function deliberately does NOT check `hasExistingClarifyChannel` —
 * isValidConnection enforces that separately so the rejection happens
 * visually (red dashed line) instead of silently no-opping inside the
 * drop handler.
 */
export function classifyClarifyConnection(
  def: WorkflowDefinition,
  conn: {
    source: string | null
    target: string | null
    sourceHandle: string | null
    targetHandle: string | null
  },
): { sourceAgentNodeId: string; clarifyNodeId: string; direction: 'reverse' | 'forward' } | null {
  // Reverse drag: user grabbed the clarify input handle (questions) and
  // dropped on an agent output port. xyflow normalises to source=agent,
  // target=clarify, targetHandle='questions'.
  if (
    conn.targetHandle === CLARIFY_INPUT_PORT_NAME &&
    conn.source !== null &&
    conn.target !== null
  ) {
    const targetNode = def.nodes.find((n) => n.id === conn.target)
    if (targetNode !== undefined && targetNode.kind === 'clarify') {
      return {
        sourceAgentNodeId: conn.source,
        clarifyNodeId: conn.target,
        direction: 'reverse',
      }
    }
  }
  // Forward drag: user grabbed clarify.answers and dropped on any agent
  // input handle. Without this branch the drop would create a stray
  // `clarify.answers → agent.<input>` edge that the runtime ignores (the
  // clarify channel keys off agent.__clarify__ outbound, not this edge).
  if (
    conn.sourceHandle === CLARIFY_OUTPUT_PORT_NAME &&
    conn.source !== null &&
    conn.target !== null
  ) {
    const sourceNode = def.nodes.find((n) => n.id === conn.source)
    if (sourceNode !== undefined && sourceNode.kind === 'clarify') {
      return {
        sourceAgentNodeId: conn.target,
        clarifyNodeId: conn.source,
        direction: 'forward',
      }
    }
  }
  return null
}

/**
 * Drop-side cleanup: when the user deletes an agent or clarify node,
 * cascade-remove any clarify channel edges that referenced it. Otherwise
 * the canvas would render dangling arrows.
 *
 * Returns `def` by reference if no clarify edges referenced the removed
 * ids.
 */
export function clearClarifyEdgesForRemovedNodes(
  def: WorkflowDefinition,
  removedIds: ReadonlyArray<string>,
): WorkflowDefinition {
  if (removedIds.length === 0) return def
  const removed = new Set(removedIds)
  let changed = false
  const nextEdges = def.edges.filter((e) => {
    const refsRemoved = removed.has(e.source.nodeId) || removed.has(e.target.nodeId)
    const isClarifyChannelEdge =
      e.source.portName === CLARIFY_SOURCE_PORT_NAME ||
      e.target.portName === CLARIFY_INPUT_PORT_NAME ||
      e.source.portName === CLARIFY_OUTPUT_PORT_NAME ||
      e.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME
    if (refsRemoved && isClarifyChannelEdge) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...def, edges: nextEdges } : def
}

/**
 * Identify whether an edge is one half of a clarify channel. Returns a
 * `{ agentNodeId, clarifyNodeId, half }` descriptor when it is, `null`
 * otherwise. The pair is keyed by the (agent, clarify) tuple so a single
 * agent with two clarify nodes wired (a misconfiguration the validator
 * already rejects) still bookkeeps independently.
 */
export function describeClarifyChannelEdge(
  edge: WorkflowEdge,
): { agentNodeId: string; clarifyNodeId: string; half: 'ask' | 'ans' } | null {
  if (
    edge.source.portName === CLARIFY_SOURCE_PORT_NAME &&
    edge.target.portName === CLARIFY_INPUT_PORT_NAME
  ) {
    return { agentNodeId: edge.source.nodeId, clarifyNodeId: edge.target.nodeId, half: 'ask' }
  }
  if (
    edge.source.portName === CLARIFY_OUTPUT_PORT_NAME &&
    edge.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME
  ) {
    return { agentNodeId: edge.target.nodeId, clarifyNodeId: edge.source.nodeId, half: 'ans' }
  }
  return null
}

/**
 * Bug-fix cascade: when the user deletes ONE half of a clarify channel
 * (either the ask or the ans edge), the other half is conceptually dead
 * weight — keeping it would leave the runtime believing the channel is
 * still wired (scheduler keys on the ask edge) AND would render an arrow
 * pointing nowhere meaningful. So whenever `removedEdges` contains a
 * clarify-channel edge, we look up its sibling in `def.edges` and drop
 * that too.
 *
 * Returns `def` by reference if no clarify channel edges were removed
 * (so React effects can short-circuit on `===`).
 */
export function cascadeRemoveClarifyChannel(
  def: WorkflowDefinition,
  removedEdges: ReadonlyArray<WorkflowEdge>,
): WorkflowDefinition {
  if (removedEdges.length === 0) return def
  const brokenPairs = new Set<string>()
  for (const e of removedEdges) {
    const desc = describeClarifyChannelEdge(e)
    if (desc !== null) {
      brokenPairs.add(`${desc.agentNodeId}|${desc.clarifyNodeId}`)
    }
  }
  if (brokenPairs.size === 0) return def
  let changed = false
  const nextEdges = def.edges.filter((e) => {
    const desc = describeClarifyChannelEdge(e)
    if (desc === null) return true
    const key = `${desc.agentNodeId}|${desc.clarifyNodeId}`
    if (brokenPairs.has(key)) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...def, edges: nextEdges } : def
}
