// RFC-306 — branch activation: the ONE judgment that decides whether a node
// executes or is skipped because the branch feeding it was closed.
//
// Domain-only and PURE: no DB, no scheduler, no definition traversal. Callers
// (application/resolveNodeActivation.ts for dispatch, application/branchTrace.ts for
// run trace) resolve each inbound edge to an `EdgeActivation` first and hand the
// list here. That split is deliberate — the trace surface and the dispatcher MUST
// reach the same verdict, and the only way to guarantee that is for both to call
// this function rather than re-deriving "is this node live" from row statuses.
//
// Vocabulary:
//   - a PORT is inactive when its producer marked it `<port name="p"
//     active="false">` (persisted as node_run_outputs.active = 0);
//   - an EDGE is inactive when its source port is inactive, or when the source
//     NODE was itself skipped (a skipped node produces nothing, so every edge
//     leaving it is dead);
//   - a NODE is skipped when its inbound edges fail the join rule below.
//
// What this file deliberately does NOT do: decide anything from a node's own
// status. A node with no inbound edges is always active — the roots of the graph
// cannot be branched away, and pretending otherwise would let an empty edge list
// silently kill a whole workflow.

import type { JoinMode } from '@agent-workflow/shared'

/** Why one inbound edge is not carrying anything this round. */
export type EdgeInactiveReason =
  /** Source port carried `active="false"`. */
  | 'port-inactive'
  /** Source node was itself skipped — nothing left that port at all. */
  | 'source-skipped'

export type EdgeActivation =
  | Readonly<{ kind: 'active' }>
  | Readonly<{ kind: 'inactive'; reason: EdgeInactiveReason }>
  /**
   * The upstream has not settled (no done/skipped row visible). The dispatch
   * frontier normally guarantees this never happens — a node only becomes ready
   * once its transitive upstreams are complete — so this exists for the same
   * defensive reason `resolveUpstreamInputs` warns and continues on a missing
   * upstream row instead of throwing: an unreadable upstream must not be read as
   * "branch closed". Treated as ACTIVE (fail-open), because the alternative is
   * skipping real work on a bookkeeping gap.
   */
  | Readonly<{ kind: 'unresolved' }>

export type NodeActivation =
  | Readonly<{ kind: 'active' }>
  | Readonly<{
      kind: 'skipped'
      reason: 'all-inbound-inactive' | 'required-inbound-inactive'
    }>

export interface NodeActivationInput {
  /** Inbound dataflow edges, already projected + resolved by the caller. */
  inbound: readonly EdgeActivation[]
  /** Node's join policy; absent upstream ⇒ callers pass 'any' (the default). */
  joinMode: JoinMode
  /**
   * RFC-306 §10 — the user pressed "run anyway" on a skipped node. Forces this
   * one node active regardless of its inbound edges; inactive inputs then render
   * as empty strings. Does NOT propagate: the downstream re-decides from what
   * this node actually emits.
   */
  forceActivated?: boolean
}

export function resolveNodeActivation(input: NodeActivationInput): NodeActivation {
  const ACTIVE = { kind: 'active' } as const
  if (input.forceActivated === true) return ACTIVE
  if (input.inbound.length === 0) return ACTIVE

  // `unresolved` counts as active (see EdgeActivation) — so a node whose
  // upstream rows are momentarily unreadable runs rather than silently dies.
  const isLive = (e: EdgeActivation): boolean => e.kind !== 'inactive'

  if (input.joinMode === 'all') {
    return input.inbound.every(isLive)
      ? ACTIVE
      : { kind: 'skipped', reason: 'required-inbound-inactive' }
  }
  return input.inbound.some(isLive) ? ACTIVE : { kind: 'skipped', reason: 'all-inbound-inactive' }
}

/**
 * Whether a settled upstream row + port row make an edge active.
 *
 * Kept here (rather than inline at the two call sites) so "a skipped source is
 * an inactive edge" and "an absent port row means ACTIVE" are stated once. That
 * second rule is the backwards-compatibility hinge of the whole RFC: a port the
 * producer never emitted has no row at all, and RFC-306 §4.2 pins it to active —
 * only an explicit marker closes a branch.
 */
export function edgeActivationOf(source: {
  /** node_runs.status of the picked upstream row; undefined ⇒ no row visible. */
  status?: string
  /** node_run_outputs.active of the consumed port; undefined ⇒ no port row. */
  portActive?: boolean
}): EdgeActivation {
  if (source.status === undefined) return { kind: 'unresolved' }
  if (source.status === 'skipped') return { kind: 'inactive', reason: 'source-skipped' }
  if (source.portActive === false) return { kind: 'inactive', reason: 'port-inactive' }
  return { kind: 'active' }
}
