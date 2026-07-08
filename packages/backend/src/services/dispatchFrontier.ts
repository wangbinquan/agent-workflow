// RFC-076 PR-A — trim-B dispatch predicates (PURE; LIVE since PR-B wired
// deriveFrontier into runScope — scheduler.ts consumes isDispatchable every
// dispatch tick; RFC-094 removed the stale "currently UNWIRED" claim that
// post-dated the wiring, audit S-26).
//
// These are the two NOVEL predicates the dispatch frontier needs, on top
// of fix A's computeReadyNodes / areTransitiveUpstreamsCompleted (freshness.ts).
// They are the much-reviewed (3 adversarial rounds) corrections to the original
// full-B sketch:
//
//   - isDispatchable(latestRow, kind, …) — the per-node status gate. The crux
//     (round-2 N1): `failed`/`interrupted` MUST be dispatchable — they are the
//     resume / retry / daemon-restart re-mint signal (resumeTask leaves the
//     failed row and lets the scheduler mint retry_index=max+1; reapOrphanRuns
//     flips running→interrupted). Excluding them — as full-B did — would turn
//     every resume into "scheduler stalled". `exhausted` (loop-max, a true
//     terminal, round-3 HIGH-2) is NOT dispatchable. A FRESH leaf `awaiting_*`
//     stays parked (round-1 C2 busy-loop fix); a STALE one (upstream advanced)
//     re-dispatches like a stale `done` (S8/S11/S12 — re-park the review against
//     the fresh upstream). A WRAPPER's `awaiting_*` IS dispatchable (round-2 N2
//     resume anchor), but only when its inner scope has fresh post-answer work.
//
//   - wrapperRevivalEvidence(wrapperRow, rows, definition) — round-3 HIGH-1,
//     extended by RFC-098 B3 (audit S-3). A wrapper-loop parks its OWN
//     top-level row at `parentIteration`, but its inner descendants (and the
//     clarify/review rerun minted on answer) live at the loop counter `i`.
//     Scanning the wrapper's own iteration would miss the i≥1 rerun → the
//     answered task would re-park forever ("scheduler stalled"). So the scan
//     window comes from the wrapper PROGRESS payload's iteration for loops,
//     and from the wrapper row's own iteration for git wrappers (git inner
//     shares the wrapper iteration). `wrapperHasFreshInnerWork` is the
//     boolean shell kept for the existing predicate consumers.
//
// PURE module: only types + freshness primitives (isNodeRunFresh /
// isFresherNodeRun / buildFreshestDonePerNode, freshness.ts) +
// decodeWrapperProgress (wrapperProgress.ts, itself pure). No DB / scheduler
// import. The frontier ORCHESTRATION (read rows → latestPerNode → freshestDone
// → completed → ready) lives in scheduler.ts deriveFrontier (PR-B, live).
// Pure-function locks: dispatch-frontier.test.ts + derive-frontier.test.ts.

import { WRAPPER_NODE_KINDS } from '@agent-workflow/shared'
import type { NodeKind, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { nodeRuns } from '../db/schema'
import { buildFreshestDonePerNode, isFresherNodeRun, isNodeRunFresh } from './freshness'
import { decodeWrapperProgress } from './wrapperProgress'

type NodeRunRow = typeof nodeRuns.$inferSelect

/** The container kinds whose parked rows are resume anchors (exported for
 *  deriveFrontier's wrapper-anchor release and retryNode's ⑥-11 carve-out).
 *  flag-audit W0: membership now derives from shared WRAPPER_NODE_KINDS. */
export const WRAPPER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(WRAPPER_NODE_KINDS)

/**
 * RFC-095 — keeps review-superseded canceled rows PARKED (the pending rerun
 * row minted right after carries the revival — dispatching the superseded row
 * inside the supersede→mint await window would run the agent without its
 * review context). LOAD-BEARING dispatch contract.
 *
 * RFC-145: the judgment reads the structured `superseded_by_review` column
 * (written by review.ts in the same atomic supersede write; legacy rows were
 * backfilled by migration 0077). The old errorMessage prefix marker remains
 * as human breadcrumbs only — machine reads of errorMessage are forbidden by
 * the rfc145 source guard. The startsWith edge cases (null / empty / partial
 * prefix / embedded note) are structurally gone: a row is superseded iff the
 * column is non-null.
 */
export function isReviewSupersededRow(row: Pick<NodeRunRow, 'supersededByReview'>): boolean {
  // Normalize undefined (plain test-fixture rows) → null (real DB column):
  // a row is superseded iff the column carries a decision.
  return (row.supersededByReview ?? null) !== null
}

/** Safe read of a wrapper node's inner `nodeIds` (absent / non-array → []). */
function innerNodeIdsOf(node: WorkflowNode | undefined): string[] {
  const raw = (node as { nodeIds?: unknown } | undefined)?.nodeIds
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * All transitive inner-descendant node ids of a wrapper (direct inner +
 * recursively the inner of any nested wrapper). Cycle-safe via `visiting`
 * (definitions are acyclic containment trees, but guard defensively). G6.
 */
export function wrapperInnerDescendants(
  wrapperNodeId: string,
  definition: WorkflowDefinition,
  acc: Set<string> = new Set(),
  visiting: Set<string> = new Set(),
): Set<string> {
  if (visiting.has(wrapperNodeId)) return acc
  visiting.add(wrapperNodeId)
  const node = definition.nodes.find((n) => n.id === wrapperNodeId)
  for (const id of innerNodeIdsOf(node)) {
    acc.add(id)
    wrapperInnerDescendants(id, definition, acc, visiting)
  }
  return acc
}

/**
 * RFC-098 B3 (audit S-7) — the EXTERNAL upstream source set of a loop/git
 * wrapper: every node OUTSIDE the wrapper that feeds data into the wrapper's
 * inner scope (or into the wrapper row itself). This is the key set
 * `computeWrapperConsumed` (scheduler.ts) stamps onto the wrapper's
 * `consumed_upstream_runs_json` at fresh-mint, so an upstream rerun (clarify
 * answer, review iterate, …) demotes the wrapper's done row to stale and the
 * frontier re-dispatches it — the same provenance contract wrapper-fanout has
 * carried since RFC-074 §8 D3.
 *
 * Membership = edges `external → (inner descendant ∪ wrapper itself)`:
 *   - inner descendants because v1 loop/git wrappers accept NO inbound edges
 *     (workflow.validator.ts 'does not accept inbound edges in v1') — external
 *     data enters via direct external→inner edges that resolveUpstreamInputs
 *     reads with the full definition.edges;
 *   - the wrapper itself to cover wrapper→wrapper ordering edges (the
 *     validator rejects them but the scheduler honors them — see
 *     scheduler-audit-s04's wg1→wg2 sequencing edge).
 *
 * Edge filtering MIRRORS buildScopeUpstreams (scheduler.ts) — the same five
 * channel-edge rules isClarifyChannelEdge (shared/clarify.ts) classifies,
 * including the carve-out that `questioner.__clarify__ → clarify-cross-agent`
 * is a REAL dataflow dep (kept), plus the review `inputSource` implicit
 * dependency. Keep the two in lockstep: a source buildScopeUpstreams would
 * gate dispatch on must also be provenance-tracked here, and vice versa.
 *
 * Pure function — definition-only, no DB / rows.
 */
export function wrapperExternalUpstreamSources(
  wrapperNodeId: string,
  definition: WorkflowDefinition,
): Set<string> {
  const scope = wrapperInnerDescendants(wrapperNodeId, definition)
  scope.add(wrapperNodeId)
  const kindById = new Map(definition.nodes.map((n) => [n.id, n.kind]))
  const sources = new Set<string>()
  for (const e of definition.edges) {
    if (!scope.has(e.target.nodeId)) continue
    if (scope.has(e.source.nodeId)) continue
    // Channel-edge skip rules — verbatim from buildScopeUpstreams:
    // agent.__clarify__ → clarify is dispatched out-of-band (skip), but
    // questioner.__clarify__ → clarify-cross-agent is a kept dataflow dep.
    if (e.source.portName === '__clarify__') {
      if (kindById.get(e.target.nodeId) === 'clarify') continue
      // clarify-cross-agent target → fall through (kept).
    }
    // Answer / cross-clarify back-channels are prompt-injected, not consumed
    // as dataflow inputs — never provenance sources.
    if (
      e.target.portName === '__clarify_response__' ||
      e.target.portName === '__external_feedback__' ||
      e.source.portName === 'to_designer' ||
      e.source.portName === 'to_questioner'
    ) {
      continue
    }
    sources.add(e.source.nodeId)
  }
  // review.inputSource is an implicit upstream dep (no user-authored edge) —
  // same rule buildScopeUpstreams applies, but here only EXTERNAL sources
  // qualify (an in-scope inputSource is intra-wrapper dataflow, not
  // provenance).
  for (const n of definition.nodes) {
    if (!scope.has(n.id)) continue
    if (n.kind !== 'review') continue
    const inp = (n as Record<string, unknown>).inputSource as { nodeId?: unknown } | undefined
    if (inp === undefined || typeof inp.nodeId !== 'string') continue
    if (scope.has(inp.nodeId)) continue
    sources.add(inp.nodeId)
  }
  return sources
}

/** The revival-evidence row a parked wrapper may be released on. */
export interface WrapperRevivalEvidence {
  /** node_run id of the evidence row — the one-shot release key. */
  rowId: string
  /** inner node the evidence row belongs to — the open-asking race guard key. */
  nodeId: string
}

/**
 * RFC-076 round-3 HIGH-1, refactored + extended by RFC-098 B3 (audit S-3 +
 * the RFC-092 documented limitation). Does a parked wrapper's inner scope
 * hold fresh post-human work? Returns the EVIDENCE row (max-id qualifying
 * row) so deriveFrontier can key its one-shot release + open-asking guard on
 * it, or null when the wrapper must stay parked.
 *
 * A row qualifies as evidence iff it belongs to an inner descendant, sits in
 * the wrapper's inner ITERATION WINDOW, and is either:
 *   - `pending` — the rerun row submitClarifyAnswers / submitReviewDecision
 *     (iterate/reject) mints while the wrapper is suspended; or
 *   - a `kind === 'review'` node's `done` ∧ fresh row — the approve branch
 *     flips the review row done WITHOUT minting anything (audit S-3), so the
 *     approved review itself is the only resume signal. Restricting to review
 *     kind is load-bearing: any inner agent's done row would otherwise unlock
 *     the wrapper and break clarify parking (dispatch-frontier.test.ts N2).
 *
 * CONTRACT (RFC-098 adversarial-review revision #8): the review done∧fresh
 * judgment MUST use a freshest-done map built INSIDE this function at the
 * inner window — `buildFreshestDonePerNode(rows, innerDescendants, innerIter)`.
 * The caller's outer-scope freshestDone map is keyed to the WRAPPER's own
 * iteration/scope and would mis-judge i≥1 inner rows (silently never/always
 * fresh). Do not "optimize" by threading the outer map in.
 *
 * Iteration window:
 *   - wrapper-loop: the loop counter from the wrapper's progress payload (the
 *     iteration the inner scope parked on). Malformed/absent → 0 (mirrors the
 *     runtime resume fallback `startIter=0`). NOT the wrapper row's own
 *     iteration (which is the parent scope's iteration — would miss i≥1 work).
 *   - wrapper-git: the wrapper row's own iteration (git inner shares it).
 *
 * Known DEPTH-1 limitation (revision #8): the scan covers all transitive
 * inner descendants but applies the OUTER wrapper's single window. Evidence
 * born inside a nested loop-in-git lives at the INNER loop's counter `j`, so
 * a deep approve/answer does not release the outermost wrapper — the same
 * blind spot the pending-row evidence has always had. Recorded in
 * design/RFC-098 §B3 as accepted; not fixed here.
 */
export function wrapperRevivalEvidence(
  wrapperRow: NodeRunRow,
  rows: readonly NodeRunRow[],
  definition: WorkflowDefinition,
): WrapperRevivalEvidence | null {
  const node = definition.nodes.find((n) => n.id === wrapperRow.nodeId)
  const kind = node?.kind
  let innerIter: number
  if (kind === 'wrapper-loop') {
    const progress = decodeWrapperProgress(wrapperRow.wrapperProgressJson, () => {})
    innerIter = progress?.iteration ?? 0
  } else {
    // wrapper-git (and any non-loop wrapper): inner shares the wrapper iteration.
    innerIter = wrapperRow.iteration
  }
  const inner = wrapperInnerDescendants(wrapperRow.nodeId, definition)
  const kindById = new Map(definition.nodes.map((n) => [n.id, n.kind]))
  // Built lazily — most calls see no inner done review row at the window.
  let innerFreshest: Map<string, NodeRunRow> | null = null
  let best: NodeRunRow | undefined
  for (const r of rows) {
    if (!inner.has(r.nodeId)) continue
    if (r.iteration !== innerIter) continue
    let qualifies = false
    if (r.status === 'pending') {
      qualifies = true
    } else if (r.status === 'done' && kindById.get(r.nodeId) === 'review') {
      if (innerFreshest === null) {
        innerFreshest = buildFreshestDonePerNode(rows, inner, innerIter)
      }
      qualifies = isNodeRunFresh(r, innerFreshest)
    }
    if (!qualifies) continue
    if (isFresherNodeRun(r, best)) best = r
  }
  return best === undefined ? null : { rowId: best.id, nodeId: best.nodeId }
}

/**
 * Boolean shell over `wrapperRevivalEvidence` — kept under the original name
 * for the predicate consumers (isDispatchable below,
 * dispatch-frontier-fanout-fresh.test.ts imports it directly).
 */
export function wrapperHasFreshInnerWork(
  wrapperRow: NodeRunRow,
  rows: readonly NodeRunRow[],
  definition: WorkflowDefinition,
): boolean {
  return wrapperRevivalEvidence(wrapperRow, rows, definition) !== null
}

/**
 * RFC-076 trim-B per-node dispatch gate. Given a node's LATEST top-level run
 * row (or undefined if it never ran), its workflow kind, the current
 * freshest-done map, and the full row set + definition (for the wrapper
 * carve-out), decide whether the node may be (re-)dispatched.
 *
 *   undefined            → true   (never ran)
 *   pending              → true   (out-of-band mint / placeholder)
 *   done ∧ !fresh        → true   (stale-done re-run; fix A multi-hop demote)
 *   failed | interrupted → true   (resume / retry re-mint signal — N1; the
 *                                  scheduler mints retry_index=max+1, bounded by
 *                                  runOneNode's attempt ≤ retryIndex+maxRetries)
 *   canceled             → !superseded (RFC-095 / audit S-22 — revival signal,
 *                                  same class as interrupted; review-supersede
 *                                  marker rows stay parked)
 *   wrapper awaiting_*   → wrapperHasFreshInnerWork (N2 resume anchor + HIGH-1;
 *                                  RFC-098 S-3 extends the evidence to inner
 *                                  review done∧fresh rows — see
 *                                  wrapperRevivalEvidence)
 *   leaf awaiting_*      → !fresh (stale parked re-runs; fresh parked stays — C2)
 *   exhausted | running | skipped → false (loop-max true terminal / in flight /
 *                                  no mint path — see the exhaustive switch)
 *
 * In-pass busy-loop protection does NOT come from this gate — it comes from the
 * scheduler's per-invocation `dispatchedThisInvocation` set (N3) + runOneNode
 * minting a `pending` row on dispatch. This gate only decides eligibility.
 */
export function isDispatchable(
  row: NodeRunRow | undefined,
  kind: NodeKind,
  freshestDonePerUpstream: Map<string, NodeRunRow>,
  rows: readonly NodeRunRow[],
  definition: WorkflowDefinition,
): boolean {
  if (row === undefined) return true
  // RFC-095: exhaustive switch over the FULL NodeRunStatus universe — adding a
  // new status fails compilation here instead of silently falling into the
  // "not dispatchable" black hole (audit S-12: five historical bucket misses).
  switch (row.status) {
    case 'pending':
      return true
    case 'done':
      return !isNodeRunFresh(row, freshestDonePerUpstream)
    case 'failed':
    case 'interrupted':
      return true
    case 'canceled':
      // RFC-095 (audit S-22): a canceled row is a REVIVAL signal, same class
      // as interrupted — execution was externally cut short (task cancel keeps
      // the worktree; retryNode on a canceled task is a designed UI flow).
      // EXCEPT a review-supersede marker: submitReviewDecision flips the old
      // author row to canceled BEFORE minting the pending rerun (review.ts) —
      // dispatching inside that await window would run the agent without its
      // review context. The marker row stays parked; the rerun row (fresh
      // ULID) carries the revival.
      return !isReviewSupersededRow(row)
    case 'awaiting_human':
    case 'awaiting_review': {
      if (WRAPPER_KINDS.has(kind)) return wrapperHasFreshInnerWork(row, rows, definition)
      // Leaf parked (review / clarify). C2 keeps a FRESH parked leaf parked — it
      // is genuinely waiting on a human, and re-dispatching it every tick would
      // busy-loop. But a parked leaf whose consumed upstream has since advanced is
      // STALE: the artifact under review changed out from under the pending human
      // decision. It must re-dispatch (re-park a fresh review against the new
      // upstream), exactly like a stale `done` row — symmetric with the line
      // above. Approving a stale parked review would otherwise leave it consuming
      // an obsolete upstream run, surfacing as a spurious re-review on the next
      // scope entry (the RFC-074 demote-the-stale-parked-review path the old batch
      // model performed via recomputeFreshnessAndDemote; combination-scenarios
      // S8/S11/S12 lock this). `dispatchedThisInvocation` (N3) still bounds it to
      // one re-dispatch per invocation, so no busy-loop.
      return !isNodeRunFresh(row, freshestDonePerUpstream)
    }
    case 'exhausted':
      // loop-max true terminal (RFC-076 HIGH-2) — never re-dispatched.
      return false
    case 'running':
      // In flight (or an orphaned row — surfaced via Frontier.blocked, not here).
      return false
    case 'skipped':
      // Zero mint points in src today; whoever enables it must decide its
      // dispatch semantics HERE first (this case makes that explicit).
      return false
    default: {
      const _exhaustive: never = row.status
      return _exhaustive
    }
  }
}

// -----------------------------------------------------------------------------
// RFC-095 — decideScopeOutcome (pure; audit WP-2 / S-1 structural finish)
// -----------------------------------------------------------------------------

export interface BlockedNode {
  nodeId: string
  status: string
  reason: string
}

export interface ScopeOutcomeInput {
  awaitingHuman: readonly string[]
  awaitingReview: readonly string[]
  exhausted: readonly string[]
  failed: readonly string[]
  blocked: readonly BlockedNode[]
  allSettled: boolean
}

export type ScopeOutcome =
  | { kind: 'ok' }
  | { kind: 'awaiting_human' | 'awaiting_review'; nodeId: string }
  | { kind: 'failed'; detail: { summary: string; message: string; nodeId?: string } }

/**
 * The quiescent-scope decision runScope makes once nothing is in flight and
 * nothing is newly ready, extracted from the inline if-chain so the priority
 * order is table-testable (rfc095-scope-outcome.test.ts). Priority is
 * byte-equivalent to the pre-RFC-095 block:
 *
 *   awaitingHuman > awaitingReview > firstFailureDetail > exhausted
 *   > allSettled→ok > stalled
 *
 * The only increment: the stalled summary now carries the Frontier.blocked
 * diagnostics (audit S-12 — "scheduler stalled" used to name no node at all);
 * the message stays 'no ready nodes in scope' for machine-facing stability.
 */
export function decideScopeOutcome(
  f: ScopeOutcomeInput,
  firstFailureDetail?: { summary: string; message: string; nodeId?: string },
): ScopeOutcome {
  if (f.awaitingHuman.length > 0) {
    return { kind: 'awaiting_human', nodeId: f.awaitingHuman[0]! }
  }
  if (f.awaitingReview.length > 0) {
    return { kind: 'awaiting_review', nodeId: f.awaitingReview[0]! }
  }
  if (firstFailureDetail !== undefined) {
    return { kind: 'failed', detail: firstFailureDetail }
  }
  // A terminal 'exhausted' loop in this scope is a failure even on a resume
  // invocation where it wasn't (re-)dispatched this call (so firstFailureDetail
  // is unset) — never let it fall through to allSettled→ok.
  if (f.exhausted.length > 0) {
    const exId = f.exhausted[0]!
    return {
      kind: 'failed',
      detail: {
        summary: `wrapper-loop ${exId} exhausted (max iterations reached)`,
        message: 'wrapper-loop-exhausted',
        nodeId: exId,
      },
    }
  }
  if (f.allSettled) {
    return { kind: 'ok' }
  }
  // Stalled — surface WHICH nodes are stuck and why (the diagnostic payload is
  // free text for humans/logs, not an API contract; tests prefix-match only).
  const blockedPart =
    f.blocked.length > 0
      ? ` — blocked nodes: ${f.blocked.map((b) => `${b.nodeId}(${b.status}: ${b.reason})`).join(', ')}`
      : ''
  const failedPart = f.failed.length > 0 ? `; failed parked: ${f.failed.join(', ')}` : ''
  return {
    kind: 'failed',
    detail: {
      summary: `scheduler stalled${blockedPart}${failedPart}`,
      message: 'no ready nodes in scope',
      ...(f.blocked.length > 0 ? { nodeId: f.blocked[0]!.nodeId } : {}),
    },
  }
}
