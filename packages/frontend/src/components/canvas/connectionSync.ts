// RFC-007 — keep `definition.edges[]` and the per-node persistence fields
// (`review.inputSource`, `output.ports[i].bind`) in lock-step at edit time.
//
// scheduler / runner read the fields, not the edges (see
// design/RFC-005-human-review/design.md §9 + scheduler.dispatchReviewNode).
// The canvas, however, only used to write edges on connect — so a dragged
// edge into a review or output node left the corresponding field empty,
// and a typed-in field had no matching edge on the canvas. Both surfaces
// must mirror each other. RFC-199 makes applyWorkflowTransition the only
// edit-time chokepoint; this module now provides its low-level mirror
// primitives plus the one-shot load healer.
//
// All exports are pure functions. They return the input definition by
// reference when nothing changes, so upstream React effects can rely on
// `===` to short-circuit; the same trick keeps RFC-004 `healLoadedDefinition`
// from looping with the auto-save useEffect.
//
// Production edit surfaces must not call these primitives directly:
//   1. applyWorkflowTransition → applyConnection/applyDisconnect
//   2. workflows.edit.healLoadedDefinition → healFieldEdgeConsistency
// syncEdgeFromFormField remains only as a legacy golden-oracle helper.

import {
  REVIEW_INPUT_PORT_NAME,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

// Shared schema exports the zod `PortRefSchema` but not the inferred type;
// the shape is `{nodeId, portName}`, both strings. Carrying it locally
// avoids modifying the shared package for a frontend-only sync layer.
type PortRef = { nodeId: string; portName: string }

/**
 * Stable handle id for the review node's single left-side target Handle
 * (see RFC-007 design §3.1). Distinct from RFC-003's `__inbound__` catch-all
 * so the two paths never collide in `translateInboundConnection`.
 */
export const REVIEW_INPUT_HANDLE_ID = REVIEW_INPUT_PORT_NAME

const EMPTY_PORT_REF: PortRef = { nodeId: '', portName: '' }

function makeEdgeId(): string {
  return `edge_${ulid().slice(-6).toLowerCase()}`
}

/**
 * Strict "edge-worthy" check used by {@link syncEdgeFromFormField} and the
 * heal pass: a partial ref (one half empty) is treated as "no edge yet" so
 * mid-keystroke states don't materialize half-wired edges that the
 * validator would just flag downstream.
 */
function isCompleteRef(p: PortRef | null | undefined): boolean {
  if (p === null || p === undefined) return false
  return p.nodeId !== '' && p.portName !== ''
}

function portRefEqual(a: PortRef, b: PortRef): boolean {
  return a.nodeId === b.nodeId && a.portName === b.portName
}

function readInputSource(node: WorkflowNode): PortRef {
  const raw = (node as unknown as { inputSource?: { nodeId?: unknown; portName?: unknown } })
    .inputSource
  const nodeId = typeof raw?.nodeId === 'string' ? raw.nodeId : ''
  const portName = typeof raw?.portName === 'string' ? raw.portName : ''
  return { nodeId, portName }
}

interface OutputPort {
  name: string
  bind: PortRef
}

function readOutputPorts(node: WorkflowNode): OutputPort[] {
  const raw = (node as unknown as { ports?: unknown }).ports
  if (!Array.isArray(raw)) return []
  return raw.map((p) => {
    const port = p as { name?: unknown; bind?: { nodeId?: unknown; portName?: unknown } }
    const name = typeof port.name === 'string' ? port.name : ''
    const bindNodeId = typeof port.bind?.nodeId === 'string' ? port.bind.nodeId : ''
    const bindPortName = typeof port.bind?.portName === 'string' ? port.bind.portName : ''
    return { name, bind: { nodeId: bindNodeId, portName: bindPortName } }
  })
}

function replaceNode(
  def: WorkflowDefinition,
  nodeId: string,
  patch: (n: WorkflowNode) => WorkflowNode,
): WorkflowDefinition {
  const idx = def.nodes.findIndex((n) => n.id === nodeId)
  if (idx === -1) return def
  const next = patch(def.nodes[idx]!)
  if (next === def.nodes[idx]) return def
  const nodes = def.nodes.slice()
  nodes[idx] = next
  return { ...def, nodes }
}

function setReviewInputSource(
  def: WorkflowDefinition,
  reviewNodeId: string,
  nextRef: PortRef,
): WorkflowDefinition {
  return replaceNode(def, reviewNodeId, (n) => {
    if (n.kind !== 'review') return n
    const prev = readInputSource(n)
    if (portRefEqual(prev, nextRef)) return n
    return { ...(n as object), inputSource: nextRef } as unknown as WorkflowNode
  })
}

function setOutputPortBind(
  def: WorkflowDefinition,
  outputNodeId: string,
  portName: string,
  nextRef: PortRef,
): WorkflowDefinition {
  return replaceNode(def, outputNodeId, (n) => {
    if (n.kind !== 'output') return n
    const ports = readOutputPorts(n)
    const idx = ports.findIndex((p) => p.name === portName)
    if (idx === -1) return n
    if (portRefEqual(ports[idx]!.bind, nextRef)) return n
    const nextPorts = ports.slice()
    nextPorts[idx] = { ...ports[idx]!, bind: nextRef }
    return { ...(n as object), ports: nextPorts } as unknown as WorkflowNode
  })
}

/**
 * After WorkflowCanvas builds an edge from a fresh xyflow Connection and
 * appends it to `def.edges`, hand the whole definition through this fn.
 *
 * - target is a review node + targetHandle === REVIEW_INPUT_HANDLE_ID:
 *     drop any prior edge into that review node (review is single-input);
 *     rewrite the just-appended edge's target.portName to the sentinel;
 *     write node.inputSource ← edge.source.
 * - target is an output node and `opts.viaCatchAll` is true (i.e. the user
 *     dropped on the catch-all left strip — see {@link translateInboundConnection}):
 *     always append a NEW port to `node.ports[]`. The proposed port name is
 *     `edge.target.portName` (the upstream port's name); if that name is
 *     already taken we suffix it `_2`, `_3`, ... so a single output node can
 *     receive multiple unrelated upstreams. Edge.target.portName is rewritten
 *     to the disambiguated name so the canvas line lands on the new handle.
 * - target is an output node and `opts.viaCatchAll` is false (the user
 *     dropped on a specific named handle):
 *     drop any prior edge into that (outputNodeId, portName) pair and rewrite
 *     the matching `port.bind` — this is the explicit "rebind THIS port"
 *     action. Falls through to auto-create when the named port no longer
 *     exists (defensive: shouldn't happen since xyflow only registers
 *     handles for declared ports, but the caller can't preflight it).
 * - otherwise: return def unchanged (caller's append is preserved as-is for
 *   the agent / wrapper-loop path).
 *
 * The newly-added edge is identified by `edge.id`; the helper mutates that
 * edge in-place inside `def.edges` (via filter + append-rewrite) when port
 * disambiguation renames it.
 */
export function applyConnectionForReviewOutput(
  def: WorkflowDefinition,
  edge: WorkflowEdge,
  opts: { viaCatchAll?: boolean } = {},
): WorkflowDefinition {
  const targetNode = def.nodes.find((n) => n.id === edge.target.nodeId)
  if (targetNode === undefined) return def

  if (targetNode.kind === 'review' && edge.target.portName === REVIEW_INPUT_HANDLE_ID) {
    // Drop earlier inbound edges to this review; the new one survives.
    const filtered = def.edges.filter((e) => e.id === edge.id || e.target.nodeId !== targetNode.id)
    const withFields = setReviewInputSource({ ...def, edges: filtered }, targetNode.id, {
      nodeId: edge.source.nodeId,
      portName: edge.source.portName,
    })
    return withFields
  }

  if (targetNode.kind === 'output') {
    const ports = readOutputPorts(targetNode)
    const requestedName = edge.target.portName
    const nextBind: PortRef = {
      nodeId: edge.source.nodeId,
      portName: edge.source.portName,
    }
    const portExists = ports.some((p) => p.name === requestedName)

    // Catch-all drop, OR a named-handle drop on a port that no longer
    // exists, both flow through the "append a new port" path. Catch-all
    // forces this branch even if the upstream port name already exists
    // (disambiguate with `_2`, `_3`, …) so output can accept many
    // independent upstreams — see RFC-007 follow-up.
    const wantAppend = opts.viaCatchAll === true || !portExists
    if (wantAppend) {
      const finalName =
        portExists && opts.viaCatchAll === true
          ? uniquePortName(ports, requestedName)
          : requestedName
      // If we renamed the port for disambiguation, rewrite the edge's
      // target.portName to match so the canvas line lands on the new handle.
      const rewrittenEdges = def.edges.map((e) =>
        e.id === edge.id
          ? ({ ...e, target: { ...e.target, portName: finalName } } as WorkflowEdge)
          : e,
      )
      // Drop earlier inbound edges to (outputNodeId, finalName) — only matters
      // when finalName === requestedName AND the port already existed (the
      // named-handle rebind path defensively falling through here).
      const filtered = rewrittenEdges.filter(
        (e) =>
          e.id === edge.id ||
          !(e.target.nodeId === targetNode.id && e.target.portName === finalName),
      )
      const appended: OutputPort[] = ports.some((p) => p.name === finalName)
        ? ports.map((p) => (p.name === finalName ? { ...p, bind: nextBind } : p))
        : [...ports, { name: finalName, bind: nextBind }]
      const withPort = replaceNode(
        { ...def, edges: filtered },
        targetNode.id,
        (n) =>
          ({
            ...(n as object),
            ports: appended,
          }) as unknown as WorkflowNode,
      )
      return withPort
    }

    // Explicit rebind onto an existing named handle: drop any prior edge
    // into (outputNodeId, requestedName) and overwrite the bind in place.
    const filtered = def.edges.filter(
      (e) =>
        e.id === edge.id ||
        !(e.target.nodeId === targetNode.id && e.target.portName === requestedName),
    )
    return setOutputPortBind({ ...def, edges: filtered }, targetNode.id, requestedName, nextBind)
  }

  return def
}

/**
 * Pick a port name that doesn't collide with any of `existing`. Suffixes
 * with `_2`, `_3`, … (no leading `_` for the first attempt, matching the
 * `default port_1` style already used by the NodeInspector's "Add port"
 * button).
 */
function uniquePortName(existing: OutputPort[], requested: string): string {
  const taken = new Set(existing.map((p) => p.name))
  if (!taken.has(requested)) return requested
  for (let i = 2; i < 1000; i++) {
    const candidate = `${requested}_${i}`
    if (!taken.has(candidate)) return candidate
  }
  // Defensive fallback — pathological case where 998 ports share a base name.
  return `${requested}_${Date.now()}`
}

/**
 * Mirror of {@link applyConnectionForReviewOutput} for edge deletion.
 *
 * For each entry in `deletedEdges`, if its target is a review / output node,
 * clear the corresponding field. The edges themselves are assumed to have
 * already been removed from `def` by the caller.
 *
 * Note: the deleted edges' `target.nodeId` may name a node that has been
 * removed at the same time (cascade-delete). In that case the field clear
 * is a no-op because `replaceNode` short-circuits when the node is missing.
 */
export function applyDisconnectForReviewOutput(
  def: WorkflowDefinition,
  deletedEdges: WorkflowEdge[],
): WorkflowDefinition {
  let next = def
  for (const edge of deletedEdges) {
    const node = next.nodes.find((n) => n.id === edge.target.nodeId)
    if (node === undefined) continue
    if (node.kind === 'review' && edge.target.portName === REVIEW_INPUT_HANDLE_ID) {
      next = setReviewInputSource(next, node.id, EMPTY_PORT_REF)
    } else if (node.kind === 'output') {
      const ports = readOutputPorts(node)
      if (ports.some((p) => p.name === edge.target.portName)) {
        next = setOutputPortBind(next, node.id, edge.target.portName, EMPTY_PORT_REF)
      }
    }
  }
  return next
}

/**
 * When the NodeInspector form updates `inputSource` (review) or one of the
 * `port.bind` slots (output), call this to bring `definition.edges` along.
 *
 * - prev empty + next non-empty → append a fresh edge
 * - prev non-empty + next empty → drop the matching edge
 * - prev non-empty + next different → replace
 * - prev === next → return def unchanged (ref-equal)
 *
 * `target` identifies the sink side. For review nodes, pass
 * `portName = REVIEW_INPUT_HANDLE_ID`; for output nodes, pass the
 * `port.name` the user is editing.
 */
export function syncEdgeFromFormField(
  def: WorkflowDefinition,
  target: { nodeId: string; portName: string },
  prev: PortRef | null,
  next: PortRef | null,
): WorkflowDefinition {
  const prevComplete = isCompleteRef(prev)
  const nextComplete = isCompleteRef(next)
  if (!prevComplete && !nextComplete) return def
  if (prevComplete && nextComplete && prev !== null && next !== null && portRefEqual(prev, next)) {
    return def
  }
  // Drop any edge currently landing on (target.nodeId, target.portName) —
  // single-input semantics for both review and output ports.
  const filtered = def.edges.filter(
    (e) => !(e.target.nodeId === target.nodeId && e.target.portName === target.portName),
  )
  if (!nextComplete) {
    if (filtered.length === def.edges.length) return def
    return { ...def, edges: filtered }
  }
  if (next === null) return def
  const fresh: WorkflowEdge = {
    id: makeEdgeId(),
    source: { nodeId: next.nodeId, portName: next.portName },
    target: { nodeId: target.nodeId, portName: target.portName },
  }
  return { ...def, edges: [...filtered, fresh] }
}

/**
 * Idempotent one-shot reconciliation for old workflows opened in the editor:
 *
 * - field has value but no matching edge in `def.edges` → append the edge
 *   (covers RFC-007-old workflows where the form was the only way to set
 *   inputSource / port.bind)
 * - edge exists but field is empty → write the field (covers YAML imports
 *   that authored edges directly)
 * - both present but disagree → take the edge as ground truth (visual is
 *   the user's most recent action; the field is treated as stale)
 * - both present and agree → no change
 *
 * Returns the input `def` reference when no work is needed.
 */
export function healFieldEdgeConsistency(def: WorkflowDefinition): WorkflowDefinition {
  let result = def
  // Snapshot the current node list once. Mutations below produce new node
  // / edge arrays but we still want to iterate over the original kinds.
  for (const node of def.nodes) {
    if (node.kind === 'review') {
      const field = readInputSource(node)
      const edge = result.edges.find(
        (e) => e.target.nodeId === node.id && e.target.portName === REVIEW_INPUT_HANDLE_ID,
      )
      if (edge !== undefined) {
        const edgeRef: PortRef = { nodeId: edge.source.nodeId, portName: edge.source.portName }
        if (!portRefEqual(field, edgeRef)) {
          result = setReviewInputSource(result, node.id, edgeRef)
        }
      } else if (isCompleteRef(field)) {
        const fresh: WorkflowEdge = {
          id: makeEdgeId(),
          source: { nodeId: field.nodeId, portName: field.portName },
          target: { nodeId: node.id, portName: REVIEW_INPUT_HANDLE_ID },
        }
        result = { ...result, edges: [...result.edges, fresh] }
      }
    } else if (node.kind === 'output') {
      const ports = readOutputPorts(node)
      for (const port of ports) {
        if (port.name === '') continue
        const edge = result.edges.find(
          (e) => e.target.nodeId === node.id && e.target.portName === port.name,
        )
        if (edge !== undefined) {
          const edgeRef: PortRef = { nodeId: edge.source.nodeId, portName: edge.source.portName }
          if (!portRefEqual(port.bind, edgeRef)) {
            result = setOutputPortBind(result, node.id, port.name, edgeRef)
          }
        } else if (isCompleteRef(port.bind)) {
          const fresh: WorkflowEdge = {
            id: makeEdgeId(),
            source: { nodeId: port.bind.nodeId, portName: port.bind.portName },
            target: { nodeId: node.id, portName: port.name },
          }
          result = { ...result, edges: [...result.edges, fresh] }
        }
      }
    }
  }
  return result
}
