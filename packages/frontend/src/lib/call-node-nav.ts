// RFC-245 — task-detail canvas call-node click target.
//
// Clicking a `call-workflow` / `call-workgroup` node on the task-status canvas
// opens the CHILD TASK it launched (`/tasks/{childTaskId}`) instead of the
// NodeDetailDrawer — the third instance of the same path RFC-158 (review node →
// review page) and RFC-161 (clarify node → clarify page) established: a node
// whose real content lives on another page never opens the drawer from the
// canvas.
//
// WHICH generation this routes to (design D2, user-decided "strict freshest"):
// the node's current state is its FRESHEST top-level run, and "freshest" here is
// NOT a locally invented "max ULID" rule — it is the repo's single freshness
// authority `isFresherNodeRun` (services/freshness.ts, RFC-074 PR-C: pure ULID
// id ordering, "the newest-inserted row always wins", locked by
// isfresher-noderun-baseline.test.ts). The scheduler's latestPerNode, upstream
// input resolution and both sibling nav oracles all read runs through it; this
// file deliberately mirrors it, and exports the same current-run oracle for the
// call-node canvas status projection, rather than adding a second ordering
// assumption. (The design gate raised ULID monotonicity as a
// P0; it is a SYSTEM-WIDE premise — if it broke, the scheduler would mis-pick
// rows long before the canvas did — and is registered in docs/audit-backlog.md
// as a system-level item, not patched per consumer.)
//
// A newer run with NO childTaskId therefore SHADOWS an older run that has one:
// retryNode mints a fresh generation whose child is not launched yet
// (scheduler.ts stamps child_task_id BEFORE starting the child, so the window is
// short), and during that window the node must be un-clickable rather than route
// to the superseded child. This is the same invariant the RFC-161 design gate
// converged on ("a newer null must shadow an older clickable run").
//
// Top-level filter (`parentNodeRunId === null`) is defensive: RFC-243 v1 rejects
// call nodes inside a fan-out wrapper (`call-workflow-in-fanout-unsupported`,
// workflow.validator.ts), so no sharded call rows exist today. If that opens up,
// per-shard navigation needs its own decision instead of silently inheriting
// this one.
//
// ACL is NOT decided here — this stays a pure oracle over node_runs. Whether the
// child is actually visible to the viewer is composed at the call site from the
// ACL-filtered children query (design D5), exactly like ChildTaskLink does.

import type { NodeRun } from '@agent-workflow/shared'

/** Single-valued kind, mirroring `reviewNav` / `clarifyNav`'s shape so the
 *  `data-*`-attribute-presence CSS idiom stays identical across the three. */
export type CallNodeNavKind = 'child'

export interface CallNodeNav {
  /** Navigation target: `/tasks/{childTaskId}`. */
  childTaskId: string
}

/** Freshest (later-minted) row of a non-empty list — the same pure `id` compare
 *  as `isFresherNodeRun` (services/freshness.ts). */
function freshest(rows: NodeRun[]): NodeRun {
  let best = rows[0]!
  for (const r of rows) if (r.id > best.id) best = r
  return best
}

/**
 * The call node's current top-level run, using the same freshness authority as
 * navigation. Exported so the task canvas can paint status from the SAME
 * generation it routes to — a newly minted retry placeholder commonly has
 * `startedAt === null`, so the route's legacy startedAt picker would otherwise
 * keep showing the superseded generation's colour.
 */
export function deriveCurrentCallNodeRun(runs: NodeRun[], nodeId: string): NodeRun | null {
  const topLevel = runs.filter((r) => r.nodeId === nodeId && r.parentNodeRunId === null)
  return topLevel.length === 0 ? null : freshest(topLevel)
}

/**
 * The click target for one call workflow node, or null when it should not be
 * clickable at all (design D1: call nodes never fall back to the drawer).
 *
 * Reads ONLY the freshest top-level run's `childTaskId`; an older generation's
 * child must never be reachable once a newer generation exists.
 */
export function deriveCallNodeNav(runs: NodeRun[], nodeId: string): CallNodeNav | null {
  const current = deriveCurrentCallNodeRun(runs, nodeId)
  if (current === null) return null
  const childTaskId = current.childTaskId
  if (typeof childTaskId !== 'string' || childTaskId.length === 0) return null
  return { childTaskId }
}

/**
 * Compose the pure oracle with the ACL-filtered children list (design D5).
 *
 * Demote to "not clickable" ONLY when the children query has SUCCESSFULLY
 * loaded and the child is absent — proof of absence, not absence of proof. A
 * still-loading or errored query keeps the node clickable, matching
 * ChildTaskLink's optimism: child membership is a superset of parent
 * membership, so "visible" is the normal case, and one network blip must not
 * strip the entry point off every call node on the canvas.
 *
 * `children` is `undefined` while loading and an array once loaded;
 * `queryErrored` must be passed separately because TanStack Query may retain an
 * old array alongside a refetch error.
 */
export function callNavIsReachable(
  childTaskId: string,
  children: readonly { id: string }[] | undefined,
  queryErrored: boolean = false,
): boolean {
  // TanStack Query can retain the last successful `data` alongside a refetch
  // error. D5 says an errored query is absence-of-proof, not proof-of-absence,
  // so stale data must not demote the node in that state.
  if (queryErrored) return true
  if (children === undefined) return true
  return children.some((child) => child.id === childTaskId)
}
