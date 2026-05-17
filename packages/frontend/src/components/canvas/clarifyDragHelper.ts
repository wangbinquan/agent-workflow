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
// `clarify-reverse-drag-two-edges.test.ts` via grep against scheduler.ts).
//
// All exports are pure functions. Mirrors fanoutSourceSync / connectionSync
// conventions so WorkflowCanvas.handleConnect can chain them with the
// existing review/output drag branches.

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
 * agent-single + agent-multi only. Wrapper-git / wrapper-loop / review /
 * output / input / another clarify are all rejected (the validator emits
 * `clarify-target-not-agent` for the same set; this fn keeps the canvas
 * pre-flight check in sync).
 */
export function isValidClarifyTarget(node: WorkflowNode | undefined): boolean {
  if (node === undefined) return false
  return node.kind === 'agent-single' || node.kind === 'agent-multi'
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
 *   - source is not agent-single / agent-multi             → reject
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
  const [ask, ans] = buildClarifyEdges(sourceAgentNodeId, clarifyNodeId)
  return { ...def, edges: [...def.edges, ask, ans] }
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
