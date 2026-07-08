// RFC-106 — drag-connect drop-target hit-testing (PURE).
//
// `findNewInputTarget` is the shared authority for "which node would a drag land
// on, and what NEW input port name would it create". It drives the live preview
// (ConnectDropHint), the custom connection line, and the edge build
// (handleConnect / onConnectEnd) — so "what you see while dragging" === "what you
// get on release". The new-vs-reuse decision and the absolute-coord box helper
// live in connectResolve.ts, which composes these.
//
// The core mis-wire this fixes: a catch-all drop used to reuse the source's
// output port name verbatim, so two upstreams both exposing `result` collided on
// one `C.result`. Here a NEW input gets a name de-conflicted against the target's
// existing inputs via `nextFreeInputPort`.
//
// Scope (Codex design gate): only `agent-single` and `output` accept arbitrary
// named inputs via the PortHandles catch-all, so only they are hit-test targets.
// review (single `__review_input__`), wrapper-fanout (inline boundary handles)
// and wrapper-loop/git (reject inbound edges in v1) are NOT targets — those
// gestures fall through to the existing connect paths with zero behavior change.

import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { declaredPorts } from '@agent-workflow/shared'

/**
 * The target node's current input port names, mirroring how `computePorts`
 * derives the left-side inputs: distinct inbound-edge target port names
 * (excluding `wrapper-output` boundary edges), plus the node's DECLARED data
 * inputs from the shared port table (RFC-146 — fork #5 of five is gone).
 * Declared inputs now include a wrapper-fanout's `inputs[]` (previously only
 * an output node's `ports[].name` was known here), aligning drop-target /
 * free-port-picking with the Handles the canvas actually renders.
 *
 * Input declarations never consult the agent set (agent inputs are pure
 * edge-derived prompt vars), so an empty lookup is passed.
 */
export function existingInputPorts(def: WorkflowDefinition, node: WorkflowNode): string[] {
  const out: string[] = []
  for (const e of def.edges) {
    if (e.target.nodeId !== node.id) continue
    if (e.boundary === 'wrapper-output') continue
    if (!out.includes(e.target.portName)) out.push(e.target.portName)
  }
  for (const p of declaredPorts(node, def, EMPTY_AGENTS).dataInputs) {
    if (!out.includes(p.name)) out.push(p.name)
  }
  return out
}

const EMPTY_AGENTS: ReadonlyMap<string, Agent> = new Map<string, Agent>()

/**
 * Pick a port name that does not collide with `existing`. `desired` if free,
 * else `desired_2`, `desired_3`, … (generalizes the output-node `_2/_3`
 * disambiguation that lived in `applyConnectionForReviewOutput`, so agent and
 * output share ONE algorithm — the new input name is unique on every supported
 * target, killing the same-name fan-in mis-wire).
 */
export function nextFreeInputPort(existing: readonly string[], desired: string): string {
  if (!existing.includes(desired)) return desired
  let i = 2
  while (existing.includes(`${desired}_${i}`)) i += 1
  return `${desired}_${i}`
}

/** Kinds whose left input is the PortHandles catch-all with arbitrary named
 *  ports — the only hit-test targets (RFC-106 scope). */
function acceptsNamedInputs(kind: string): boolean {
  return kind === 'agent-single' || kind === 'output'
}

/** A node's flow-space bounding box (from xyflow node.position + measured). */
export interface NodeBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Hit-test the drag pointer (FLOW coords) against node bounding boxes and, if it
 * is over a supported target node (agent-single / output, not the source),
 * return that node + the NEW input port name the drop would create (deconflicted
 * against the node's existing inputs). Topmost box wins (boxes are in render
 * order; iterate from the end). Pure.
 *
 * Returns null for clarify / cross-clarify CHANNEL drags (drag started from an
 * agent's `__clarify__` ask port, or from a clarify / clarify-cross-agent node's
 * answer/feedback output) — those are wired by their own classifiers, never as a
 * new data input, so they must not show a new-input preview.
 */
export function findNewInputTarget(
  definition: WorkflowDefinition,
  boxes: readonly NodeBox[],
  point: { x: number; y: number },
  sourceNodeId: string,
  sourceHandle: string,
): { nodeId: string; portName: string } | null {
  if (sourceHandle === '__clarify__') return null
  const sourceNode = definition.nodes.find((n) => n.id === sourceNodeId)
  if (sourceNode?.kind === 'clarify' || sourceNode?.kind === 'clarify-cross-agent') return null
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const b = boxes[i]!
    if (b.id === sourceNodeId) continue
    if (point.x < b.x || point.x > b.x + b.w || point.y < b.y || point.y > b.y + b.h) continue
    const node = definition.nodes.find((n) => n.id === b.id)
    if (node === undefined || !acceptsNamedInputs(node.kind)) continue
    return {
      nodeId: b.id,
      portName: nextFreeInputPort(existingInputPorts(definition, node), sourceHandle),
    }
  }
  return null
}
