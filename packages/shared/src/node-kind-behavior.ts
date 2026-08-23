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
    isAgent: true,
    settlesWithoutRow: false,
  },
  'wrapper-git': {
    retryCascade: 'mint-placeholder',
    isAgent: false,
    settlesWithoutRow: false,
  },
  'wrapper-loop': {
    retryCascade: 'mint-placeholder',
    isAgent: false,
    settlesWithoutRow: false,
  },
  // RFC-060 — wrapper-fanout shares the wrapper-* row: holds a container
  // node_run whose status is driven by inner subgraph shards + aggregator.
  'wrapper-fanout': {
    retryCascade: 'mint-placeholder',
    isAgent: false,
    settlesWithoutRow: false,
  },
  review: {
    retryCascade: 'skip',
    isAgent: false,
    settlesWithoutRow: false,
  },
  clarify: {
    retryCascade: 'skip',
    isAgent: false,
    settlesWithoutRow: true,
  },
  // RFC-056 — cross-agent clarify shares the clarify row. The distinct
  // runtime semantics (multi-source aggregation, reject persistence,
  // designer rerun trigger) live in services/crossClarify.ts and the
  // scheduler hook, not in this cross-cutting table.
  'clarify-cross-agent': {
    retryCascade: 'skip',
    isAgent: false,
    settlesWithoutRow: true,
  },
  input: {
    retryCascade: 'skip',
    isAgent: false,
    settlesWithoutRow: false,
  },
  output: {
    retryCascade: 'skip',
    isAgent: false,
    settlesWithoutRow: false,
  },
  // RFC-243 — call nodes represent real execution (an independent child
  // task), so they cascade on retry and count as process-bearing; they own
  // no opencode session THEMSELVES (each node inside the child task does),
  // and they always write a container-style node_run row.
  'call-workflow': {
    retryCascade: 'mint-placeholder',
    isAgent: false,
    settlesWithoutRow: false,
  },
  'call-workgroup': {
    retryCascade: 'mint-placeholder',
    isAgent: false,
    settlesWithoutRow: false,
  },
  // RFC-253 — a script node runs a real subprocess in the task worktree, so it
  // cascades on retry and is process-bearing. It owns NO model session (no
  // prompt, no inventory, no transcript — `isAgent: false` keeps it out of
  // every agent-only path: inventory capture, memory injection, clarify), and
  // it always writes its own node_run row.
  script: {
    retryCascade: 'mint-placeholder',
    isAgent: false,
    settlesWithoutRow: false,
  },
  // RFC-269 — a code-host call issues one real outbound API request with real
  // external side effects (a comment gets posted, an MR gets merged), so it
  // cascades on retry and is process-bearing exactly like `script`. It owns no
  // model session (`isAgent: false` keeps it out of inventory capture, memory
  // injection and clarify), and always writes its own node_run row.
  //
  // Unlike `script` it spawns NO subprocess — the daemon issues the request
  // itself. That difference lives in the executor, not in this table: every dimension here
  // is about scheduling/lifecycle, which the two kinds genuinely share.
  'code-host-call': {
    retryCascade: 'mint-placeholder',
    isAgent: false,
    settlesWithoutRow: false,
  },
  // RFC-304 / **RFC-310 retired the execution chain** — read this row as a
  // RETIRED kind, not a live one.
  //
  // It used to be the single synthesized node of a code-capability round,
  // driving a whole stage sequence (program / script / ai / invoke) inside one
  // node_run. RFC-310 PR-10 T104 deleted that chain: `scheduler.ts` now answers
  // any `code-round` node with a typed failure (`code-round-retired`) telling
  // the operator to use development missions instead. The kind survives ONLY so
  // that historical interrupted rounds resumed after a daemon restart fail
  // legibly instead of crashing the scheduler, and so the frontend can still
  // render / link those historical tasks.
  //
  // The values below are therefore the values a retired row needs, not a
  // description of live behaviour: `mint-placeholder` keeps retry cascade
  // shaped like the other row-owning kinds so a resumed historical task walks
  // the ordinary failure path, and `isAgent: false` holds it out of the
  // agent-only paths (inventory capture, memory injection, clarify all key off
  // `isAgentNodeKind` and each assumes exactly one session per row).
  //
  // ⚠️ RFC-317 T43 —— 这段描述之前是**现在时**，写着「it drives a whole stage
  // sequence … so it is process-bearing」，而那条链早已删除。没有任何守卫会因为
  // 一个 kind 退役而重新审视它的行——`node-kind-behavior-table.test.ts` 当时只
  // 逐值锁了 14 个 kind 里的 9 个，这一行不在其中。该测试现已改为遍历整个
  // NODE_KIND，任何一行退役都必须在那里被重新确认一次。
  'code-round': {
    retryCascade: 'mint-placeholder',
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
 *
 * RFC-317 T43 — this is now the ONLY "does this kind bear a process" judgment.
 * There used to be a second column (`isProcess`) plus an `isProcessNodeKind`
 * predicate reading it. The two columns were hand-kept equal on every row (the
 * table test asserted exactly that), and R6 measurement found the predicate had
 * **zero production callers** — only tests, which asserted it against the very
 * column it read. A second hand-synced column with no consumer is a drift
 * hazard that buys nothing, so the column and its predicate were deleted.
 */
export function nodeKindParticipatesInRetryCascade(kind: NodeKind): boolean {
  return NODE_KIND_BEHAVIORS[kind].retryCascade === 'mint-placeholder'
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
  // Object.hasOwn (not `in`): raw kind strings come from DB rows / wire
  // payloads; inherited keys ('constructor', 'toString') must not index
  // the table. RFC-146 impl-gate fix.
  return kind != null && Object.hasOwn(NODE_KIND_BEHAVIORS, kind)
    ? NODE_KIND_BEHAVIORS[kind as NodeKind].isAgent
    : false
}

/**
 * RFC-146 — settles-without-row family (C1/N6): graph-visit no-op kinds
 * whose completion is derived, not row-backed. The scheduler derives its
 * SETTLES_WITHOUT_ROW set from this.
 */
export function nodeKindSettlesWithoutRow(kind: NodeKind | string | null | undefined): boolean {
  return kind != null && Object.hasOwn(NODE_KIND_BEHAVIORS, kind)
    ? NODE_KIND_BEHAVIORS[kind as NodeKind].settlesWithoutRow
    : false
}
