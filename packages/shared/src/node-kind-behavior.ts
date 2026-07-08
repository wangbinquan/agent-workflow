// RFC-053 PR-C P-2 / RFC-146 — single source of truth for per-NodeKind
// cross-cutting behavior.
//
// Many "scan all nodes / for-each kind" operations used to hardcode kind
// checks inline — `if (kind === 'review' || kind === 'clarify') skip…`. That
// style means adding a new NodeKind silently does the wrong thing in every
// cross-cutting site until each is audited.
//
// `NODE_KIND_BEHAVIORS satisfies Record<NodeKind, NodeKindBehavior>` flips
// the responsibility: a new NodeKind must fill in every behavior dimension
// at compile time, so the system stays consistent by construction.
//
// RFC-146 admission rule: **every dimension in this table has a real runtime
// consumer** — grep-provable. The original RFC-053 table carried four
// aspirational dimensions (limits / orphanReap / gc / shutdown) that nothing
// ever consulted; they were a fake SSOT (the table said "what should happen"
// while kind-blind status-driven code did the real work) and were REMOVED:
//   - orphan reaping needs no per-kind knowledge: `orphans.ts` reaps rows in
//     status ∈ {running, pending} — review/clarify's awaiting_* rows survive a
//     daemon restart because of the STATUS filter, not a kind table.
//   - resource limits are task-level (`limits.ts`); per-node timeouts are
//     enforced inside the runner via SIGTERM.
//   - worktree GC and graceful shutdown operate on TASK state; node kind
//     never enters the decision.
// If a future feature genuinely needs per-kind behavior in those areas, add
// the dimension TOGETHER WITH its consumer.
//
// Add a new NodeKind? Add a new behavior dimension? TypeScript will fail to
// compile until you fill in the matrix.

import { type NodeKind } from './schemas/workflow'

// ---------------------------------------------------------------------------
// Behavior dimensions — each one names its runtime consumer(s).
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

export interface NodeKindBehavior {
  retryCascade: RetryCascadeBehavior
  /**
   * Process kinds spawn real work (an agent subprocess or a wrapper
   * container run). Consumed via `isProcessNodeKind`
   * (schemas/workflow.ts — RFC-146 made it table-backed; the historical
   * or-chain twin is gone) and by extension everywhere that predicate is
   * used (validator, canvas, retry cascade agreement tests).
   */
  isProcess: boolean
  /**
   * Agent kinds own an opencode/claude SESSION: a prompt, an inventory
   * snapshot, a live-capturable transcript. Consumed by
   * `isAgentNodeKind` — the single predicate that replaced five copies
   * (backend inventory.isAgentRunKind + PROMPT_CAPABLE_KINDS ×2, frontend
   * isPromptCapableKind + isAgentKind).
   */
  isAgent: boolean
  /**
   * deriveFrontier pass-2 (C1/N6): the kind's graph visit is a no-op that
   * writes NO node_run row; the node counts as settled once its upstreams
   * are done and no open session blocks it. Consumed by the scheduler's
   * SETTLES_WITHOUT_ROW_KINDS derivation and stuckTaskDetector's
   * awaiting-human family scan.
   */
  settlesWithoutRow: boolean
}

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

/**
 * Per-kind behavior matrix. `satisfies Record<NodeKind, NodeKindBehavior>`
 * makes adding a NodeKind without filling in all dimensions a compile
 * error.
 *
 * "Process kinds" — agent-single, wrapper-git, wrapper-loop, wrapper-fanout —
 * cascade on retry and are process-bearing. Only agent-single owns a session.
 * (RFC-060 PR-E removed agent-multi.)
 *
 * "Non-process kinds" — input, output, review, clarify family — no cascade
 * (RFC-052), no process, no session. The clarify family additionally settles
 * without a row (C1/N6).
 */
export const NODE_KIND_BEHAVIORS = {
  'agent-single': {
    retryCascade: 'mint-placeholder',
    isProcess: true,
    isAgent: true,
    settlesWithoutRow: false,
  },
  'wrapper-git': {
    retryCascade: 'mint-placeholder',
    isProcess: true,
    isAgent: false,
    settlesWithoutRow: false,
  },
  'wrapper-loop': {
    retryCascade: 'mint-placeholder',
    isProcess: true,
    isAgent: false,
    settlesWithoutRow: false,
  },
  // RFC-060 — wrapper-fanout shares the wrapper-* row: holds a container
  // node_run whose status is driven by inner subgraph shards + aggregator.
  'wrapper-fanout': {
    retryCascade: 'mint-placeholder',
    isProcess: true,
    isAgent: false,
    settlesWithoutRow: false,
  },
  review: {
    retryCascade: 'skip',
    isProcess: false,
    isAgent: false,
    settlesWithoutRow: false,
  },
  clarify: {
    retryCascade: 'skip',
    isProcess: false,
    isAgent: false,
    settlesWithoutRow: true,
  },
  // RFC-056 — cross-agent clarify shares the clarify row. The distinct
  // runtime semantics (multi-source aggregation, reject persistence,
  // designer rerun trigger) live in services/crossClarify.ts and the
  // scheduler hook, not in this cross-cutting table.
  'clarify-cross-agent': {
    retryCascade: 'skip',
    isProcess: false,
    isAgent: false,
    settlesWithoutRow: true,
  },
  input: {
    retryCascade: 'skip',
    isProcess: false,
    isAgent: false,
    settlesWithoutRow: false,
  },
  output: {
    retryCascade: 'skip',
    isProcess: false,
    isAgent: false,
    settlesWithoutRow: false,
  },
} as const satisfies Record<NodeKind, NodeKindBehavior>

// ---------------------------------------------------------------------------
// Derived predicates (kept for callers that want the boolean form).
// ---------------------------------------------------------------------------

/**
 * Convenience predicate equivalent to
 * `NODE_KIND_BEHAVIORS[kind].retryCascade === 'mint-placeholder'`.
 * Agrees with `isProcessNodeKind` by construction (both read this table
 * since RFC-146; the historical or-chain twin is gone).
 */
export function nodeKindParticipatesInRetryCascade(kind: NodeKind): boolean {
  return NODE_KIND_BEHAVIORS[kind].retryCascade === 'mint-placeholder'
}

/**
 * RFC-052/RFC-146 — kinds that actually spawn a process / hold a per-attempt
 * node_run row the scheduler dispatches (agent + the three wrappers).
 * RFC-146 moved this here from schemas/workflow.ts and made it table-backed —
 * the historical or-chain (`kind === 'agent-single' || isWrapperKind(kind)`)
 * and this table agreed only by convention; now there is one source.
 */
export function isProcessNodeKind(kind: NodeKind): boolean {
  return NODE_KIND_BEHAVIORS[kind].isProcess
}

/**
 * RFC-146 — THE agent-kind predicate. Replaced five scattered copies of
 * `kind === 'agent-single'` (backend inventory.isAgentRunKind +
 * PROMPT_CAPABLE_KINDS ×2, frontend isPromptCapableKind + isAgentKind).
 * Callers with nullable input keep their own null guard.
 */
export function isAgentNodeKind(kind: NodeKind | string | null | undefined): boolean {
  // Raw-surface tolerant (isWrapperKind idiom): rows carry plain strings and
  // callers pass nullable kinds — unknown/absent kinds are simply not agents.
  return kind != null && kind in NODE_KIND_BEHAVIORS
    ? NODE_KIND_BEHAVIORS[kind as NodeKind].isAgent
    : false
}

/**
 * RFC-146 — settles-without-row family (C1/N6): graph-visit no-op kinds
 * whose completion is derived, not row-backed. The scheduler derives its
 * SETTLES_WITHOUT_ROW set from this.
 */
export function nodeKindSettlesWithoutRow(kind: NodeKind | string | null | undefined): boolean {
  return kind != null && kind in NODE_KIND_BEHAVIORS
    ? NODE_KIND_BEHAVIORS[kind as NodeKind].settlesWithoutRow
    : false
}
