// RFC-053 PR-C P-2 — single source of truth for per-NodeKind cross-cutting
// behavior.
//
// Many "scan all nodes / for-each kind" operations (retry cascade, resource
// limits, daemon-restart orphan reap, worktree GC, graceful shutdown) used
// to hardcode kind checks inline — `if (kind === 'review' || kind ===
// 'clarify') skip…`. That style means adding a new NodeKind silently does
// the wrong thing in every cross-cutting site until each is audited.
//
// `NODE_KIND_BEHAVIORS satisfies Record<NodeKind, NodeKindBehavior>` flips
// the responsibility: a new NodeKind must fill in every behavior dimension
// at compile time (TypeScript exhaustiveness on the `satisfies` Record),
// so the system stays consistent by construction.
//
// **Today**: only `retryCascade` is consulted at runtime (services/task.ts
// retryNode). The other four dimensions document intended behavior and
// stand ready for the future per-kind hooks called out in RFC-053
// design.md §P-2. Their values can disagree with the current code paths
// (which are kind-blind) without breaking anything — the table is the
// "what should happen", not the "what does happen" until each consumer is
// updated to query it.
//
// Add a new NodeKind? Add a new behavior dimension? TypeScript will fail
// to compile until you fill in the matrix.

import { type NodeKind } from './schemas/workflow'

// ---------------------------------------------------------------------------
// Behavior dimensions.
// ---------------------------------------------------------------------------

/**
 * retryNode cascade behavior: when the user retries an upstream node,
 * should the downstream node of this kind be minted as a
 * `retryIndex+1` placeholder (status=failed, errorMessage='queued for
 * retry') so the scheduler picks it up on the next pass?
 *
 *   - 'mint-placeholder' — Yes. The kind has a real per-attempt process
 *     to retry (agent / wrapper). RFC-052 background: this was the
 *     default-and-only behavior, which caused the review-cascade-stuck
 *     bug. Now an explicit value per kind.
 *   - 'skip' — No. The kind has no process state (input/output/review/
 *     clarify); minting a placeholder just produces stale rows that
 *     break `isFresherNodeRun` selection downstream.
 *
 * Consumed by `services/task.ts retryNode`.
 */
export type RetryCascadeBehavior = 'mint-placeholder' | 'skip'

/**
 * Per-node resource limits (future hook). Today `services/limits.ts`
 * operates at task level only; the per-node-timeout (`node.timeoutMs`)
 * is enforced inside the runner via `SIGTERM`. This dimension documents
 * which kinds participate in a hypothetical per-node time budget the
 * limits service might enforce in the future.
 *
 *   - 'enforce-time-budget' — agent / wrapper kinds, running as
 *     subprocesses with measurable wall-clock cost.
 *   - 'opt-out' — input/output/review/clarify never "run" in a way that
 *     consumes server-side compute; their elapsed time is just
 *     "waiting for user / data routing".
 */
export type LimitsBehavior = 'enforce-time-budget' | 'opt-out'

/**
 * `services/orphans.ts reapOrphanRuns` on daemon start: which kinds, if
 * their node_run is in non-terminal status when the daemon comes back
 * up, should be flipped to `interrupted`?
 *
 *   - 'mark-interrupted' — agent / wrapper rows that were `running` /
 *     `pending` at the moment of crash — those processes are gone.
 *   - 'leave-alone' — review / clarify rows in `awaiting_*` represent
 *     user-pending state that survives a daemon restart. Today this is
 *     ENFORCED implicitly by orphans.ts querying only
 *     `status IN ('running', 'pending')`. Listing here as documentation.
 *
 * `input` / `output` kinds rarely have node_run rows in non-terminal
 * status (their runOneNode is a no-op / synchronous), but if any
 * orphaned row appears it's safer to mark-interrupted than leave alone.
 */
export type OrphanReapBehavior = 'mark-interrupted' | 'leave-alone'

/**
 * Worktree GC (services/gc.ts) — does a task-level GC interact with this
 * node kind differently? Today GC operates on TASK terminal status; node-
 * kind doesn't matter. Documented here for future "pin worktree as long
 * as any pending review exists" semantics.
 *
 *   - 'gc-with-task' — normal. When the task is terminal + age ≥ threshold
 *     the worktree is collected.
 *   - 'pin' — placeholder for future "this kind keeps the worktree alive
 *     even when task is terminal" semantics (none today).
 */
export type GcBehavior = 'gc-with-task' | 'pin'

/**
 * `services/shutdown.ts gracefulShutdown` — task-level today (calls
 * `abortAllActiveTasks` which signals the per-task controller). Per-node
 * shutdown participation is implicit through the runner's abort path.
 *
 *   - 'graceful-abort' — agent / wrapper kinds; their runner subprocess
 *     receives SIGTERM on shutdown.
 *   - 'no-op' — input/output/review/clarify have no subprocess to abort.
 */
export type ShutdownBehavior = 'graceful-abort' | 'no-op'

export interface NodeKindBehavior {
  retryCascade: RetryCascadeBehavior
  limits: LimitsBehavior
  orphanReap: OrphanReapBehavior
  gc: GcBehavior
  shutdown: ShutdownBehavior
}

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

/**
 * Per-kind behavior matrix. `satisfies Record<NodeKind, NodeKindBehavior>`
 * makes adding a NodeKind without filling in all dimensions a compile
 * error.
 *
 * "Process kinds" (those that actually spawn subprocesses) — agent-single,
 * agent-multi, wrapper-git, wrapper-loop — share the same row: cascade,
 * enforce limits, reap on orphan, GC with task, graceful abort.
 *
 * "Non-process kinds" — input, output, review, clarify — share the dual
 * row: no cascade (RFC-052), opt-out of time budgets, leave-alone on
 * orphan reap, normal GC, no-op shutdown.
 */
export const NODE_KIND_BEHAVIORS = {
  'agent-single': {
    retryCascade: 'mint-placeholder',
    limits: 'enforce-time-budget',
    orphanReap: 'mark-interrupted',
    gc: 'gc-with-task',
    shutdown: 'graceful-abort',
  },
  'agent-multi': {
    retryCascade: 'mint-placeholder',
    limits: 'enforce-time-budget',
    orphanReap: 'mark-interrupted',
    gc: 'gc-with-task',
    shutdown: 'graceful-abort',
  },
  'wrapper-git': {
    retryCascade: 'mint-placeholder',
    limits: 'enforce-time-budget',
    orphanReap: 'mark-interrupted',
    gc: 'gc-with-task',
    shutdown: 'graceful-abort',
  },
  'wrapper-loop': {
    retryCascade: 'mint-placeholder',
    limits: 'enforce-time-budget',
    orphanReap: 'mark-interrupted',
    gc: 'gc-with-task',
    shutdown: 'graceful-abort',
  },
  review: {
    retryCascade: 'skip',
    limits: 'opt-out',
    orphanReap: 'leave-alone',
    gc: 'gc-with-task',
    shutdown: 'no-op',
  },
  clarify: {
    retryCascade: 'skip',
    limits: 'opt-out',
    orphanReap: 'leave-alone',
    gc: 'gc-with-task',
    shutdown: 'no-op',
  },
  input: {
    retryCascade: 'skip',
    limits: 'opt-out',
    orphanReap: 'leave-alone',
    gc: 'gc-with-task',
    shutdown: 'no-op',
  },
  output: {
    retryCascade: 'skip',
    limits: 'opt-out',
    orphanReap: 'leave-alone',
    gc: 'gc-with-task',
    shutdown: 'no-op',
  },
} as const satisfies Record<NodeKind, NodeKindBehavior>

// ---------------------------------------------------------------------------
// Derived predicates (kept for callers that want the boolean form).
// ---------------------------------------------------------------------------

/**
 * Convenience predicate equivalent to
 * `NODE_KIND_BEHAVIORS[kind].retryCascade === 'mint-placeholder'`.
 * Same semantics as the legacy `isProcessNodeKind` shipped in RFC-052;
 * both implementations agree by the table above. `isProcessNodeKind`
 * remains the public name to minimise churn.
 */
export function nodeKindParticipatesInRetryCascade(kind: NodeKind): boolean {
  return NODE_KIND_BEHAVIORS[kind].retryCascade === 'mint-placeholder'
}
