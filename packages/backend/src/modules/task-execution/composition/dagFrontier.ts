// RFC-332 — pure DAG frontier owner.

import type {
  MergeStateOrNull,
  NodeKind,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import { NODE_KIND, NODE_KIND_BEHAVIORS, isMergeStateSettled } from '@agent-workflow/shared'
import {
  areTransitiveUpstreamsCompleted,
  buildFreshestSettledPerNode,
  isFresherNodeRun,
  isNodeRunFresh,
  parseConsumedJson,
  type NodeRunRow,
} from '@/services/freshness'
import {
  isDispatchable,
  isReviewSupersededRow,
  WRAPPER_KINDS,
  wrapperRevivalEvidence,
} from '@/services/dispatchFrontier'

export interface Frontier {
  /** done∧fresh ∪ exhausted(loop-max terminal, HIGH-2) ∪ settles-without-row leaves. */
  completed: Set<string>
  /** transitive upstreams completed ∧ isDispatchable ∧ ∉ inFlight ∧ ∉ dispatchedThisInvocation. */
  ready: string[]
  /**
   * RFC-092 (audit S-1): for every `ready` node whose latest row is `pending`,
   * that row's id. The caller records these into its per-invocation
   * `dispatchedPendingRowIds` set so each pending anchor row is released AT
   * MOST ONCE — an out-of-band rerun mint (clarify answer / review decision)
   * carries a fresh ULID and re-releases the node; a leaked pending row that a
   * dispatch failed to consume degrades back to the stall semantics instead of
   * hot-looping.
   *
   * RFC-098 B3 (audit S-3): a ready WRAPPER whose latest row is awaiting_*
   * contributes its inner revival-EVIDENCE row id here instead (the inner
   * pending rerun / approved review row, wrapperRevivalEvidence) — same
   * one-shot release contract, keyed on the evidence rather than the wrapper
   * row itself.
   */
  pendingAnchors: Map<string, string>
  /** latest awaiting_review / awaiting_human, NOT going to ready (terminal bubbling). */
  awaitingReview: string[]
  awaitingHuman: string[]
  /** latest failed, NOT going to ready (a dispatchable failed row = pending resume, not terminal). */
  failed: string[]
  /** latest 'exhausted' (loop-max) — a terminal FAILURE, surfaced when the scope is quiescent. */
  exhausted: string[]
  /**
   * RFC-095 (audit S-12): nodes whose upstreams are complete and which are not
   * in flight, yet are neither dispatchable nor in any park bucket — the old
   * silent black holes (orphaned running rows, supersede-marker canceled rows,
   * consumed pending anchors, skipped, …). Surfaced in the stalled diagnostic;
   * `reason` is free-text payload, not an API contract.
   */
  blocked: Array<{ nodeId: string; status: string; reason: string }>
  /** every in-scope node is completed ⇒ scope may return done. */
  allSettled: boolean
}

// Graph-visit no-op kinds write NO node_run row (C1); they settle without one
// once upstreams are done and no session is open (N6). RFC-146: derived from
// the behavior table (today: clarify / clarify-cross-agent) instead of a
// hand-maintained literal twin.
export const SETTLES_WITHOUT_ROW_KINDS = new Set<NodeKind>(
  NODE_KIND.filter((k) => NODE_KIND_BEHAVIORS[k].settlesWithoutRow),
)

function isLiveStatus(status: string): boolean {
  return (
    status === 'pending' ||
    status === 'running' ||
    status === 'awaiting_human' ||
    status === 'awaiting_review'
  )
}

/**
 * @param rows                     all node_runs for the task (filtered inside)
 * @param openClarifyNodeIds       clarify / clarify-cross-agent node ids with an
 *   UNANSWERED session (N6 positive evidence — caller queries clarify_sessions /
 *   cross_clarify_sessions). A no-row clarify leaf only settles when NOT here,
 *   closing the "agent done, createClarifyRound(kind='self') not yet written" window.
 * @param dispatchedThisInvocation nodes already dispatched this runScope call
 *   (N3 — recovers the old remaining.delete per-invocation dedup; pure status
 *   read can't tell "already-dispatched parked wrapper" from "fresh resume").
 * @param openClarifyNodeIds       clarify / cross-clarify NODE ids with an open
 *   session (N6 — see loadOpenClarify).
 * @param askingRunIds             node_run ids of asking agent / questioner runs
 *   with an open clarify session. Their `done` row is a clarify park, NOT a
 *   completion: excluded from `completed` and bucketed awaitingHuman until the
 *   answer mints a rerun (S12). See loadOpenClarify.
 * @param dispatchedPendingRowIds  pending row ids already released through the
 *   RFC-092 pending-anchor bypass this invocation (caller records
 *   `Frontier.pendingAnchors` of every dispatch). Bounds the bypass to one
 *   release per row — see Frontier.pendingAnchors.
 */
/**
 * RFC-306 (design-gate P1#7) — the upstream run that makes a stale skip stale.
 *
 * Returns the freshest settled run id among this node's structural upstreams
 * that the skip row did NOT consume. That id is the release key: it identifies
 * the generation of new evidence, so the release fires once per upstream re-run
 * rather than once per tick.
 */
function freshestUpstreamEvidenceId(
  skippedRow: NodeRunRow,
  upstreams: readonly string[],
  freshestSettled: Map<string, NodeRunRow>,
): string | undefined {
  const consumed = parseConsumedJson(skippedRow.consumedUpstreamRunsJson)
  let best: string | undefined
  for (const upstreamId of upstreams) {
    const current = freshestSettled.get(upstreamId)
    if (current === undefined) continue
    if (consumed[upstreamId] === current.id) continue // this leg is unchanged
    if (best === undefined || current.id > best) best = current.id
  }
  return best
}

/** RFC-311 — the frontier consumes the freshness column contract (see
 *  `NodeRunRow` in services/freshness.ts); the per-tick query projects exactly
 *  those columns instead of dragging prompt_text / iso JSON along. */
export type FrontierRunRow = NodeRunRow

export function deriveFrontier(
  rows: ReadonlyArray<FrontierRunRow>,
  definition: WorkflowDefinition,
  scopeNodes: WorkflowNode[],
  scopeIds: Set<string>,
  iteration: number,
  upstreamsOf: Map<string, string[]>,
  inFlight: ReadonlySet<string>,
  dispatchedThisInvocation: ReadonlySet<string>,
  openClarifyNodeIds: ReadonlySet<string>,
  askingRunIds: ReadonlySet<string> = new Set(),
  dispatchedPendingRowIds: ReadonlySet<string> = new Set(),
  // RFC-120 T9 (model A): effective handler nodes (override ?? designer) of a
  // deferred-dispatch task's undispatched designer task_questions. Each is kept
  // OUT of `completed` (its done draft is NOT a completion — downstream blocks)
  // and parked awaiting_human until batch-dispatch mints its rerun. Empty for
  // every non-deferred task → byte-for-byte today's frontier (golden-lock).
  deferredHandlerNodeIds: ReadonlySet<string> = new Set(),
): Frontier {
  const latestPerNode = new Map<string, FrontierRunRow>()
  for (const r of rows) {
    if (r.iteration !== iteration) continue
    if (!scopeIds.has(r.nodeId)) continue
    if (r.parentNodeRunId !== null) continue // skip fan-out child rows
    if (isFresherNodeRun(r, latestPerNode.get(r.nodeId))) latestPerNode.set(r.nodeId, r)
  }
  const freshestSettled = buildFreshestSettledPerNode(rows, scopeIds, iteration)

  // Pass 1 — done∧fresh (old seed口径) + exhausted (loop-max true terminal,
  // HIGH-2). An asking agent's `done` run with an OPEN clarify session is NOT a
  // completion (it is mid-conversation, parked awaiting the answer) — excluded
  // here, bucketed awaitingHuman below (S12: matches the old batch model keeping
  // the asking agent out of `completed` via runOneNode's awaiting_human return).
  const completed = new Set<string>()
  const exhausted: string[] = []
  for (const [nodeId, r] of latestPerNode) {
    if (askingRunIds.has(r.id)) continue
    // RFC-120 T9: a deferred designer handler's done draft is NOT a completion —
    // exclude it from `completed` so its downstream stays blocked until dispatch.
    if (deferredHandlerNodeIds.has(nodeId)) continue
    // RFC-130 D15: an ISOLATED done run counts as complete ONLY once its delta has
    // been merged back into the canonical worktree (merge_state='merged'). A row
    // still in 'pending-merge' / 'conflict-*' / 'isolating' / 'merge-failed' has a
    // 'done' status (the runner set it) but its output never reached canonical —
    // gating downstream on merge_state closes the crash window (runner-done →
    // daemon crash → merge-back never ran). Legacy / passthrough rows leave
    // merge_state NULL and pass this gate byte-for-byte (golden-lock).
    if (
      r.status === 'done' &&
      isNodeRunFresh(r, freshestSettled) &&
      // RFC-144: the settled set {NULL, merged} now derives from the shared
      // transition table (SETTLED_MERGE_STATES) — in-flight iso states
      // ('isolating' / 'pending-merge' / 'conflict-human' / 'merge-failed' /
      // 'abandoned') are gated out; null/'merged' pass (legacy golden-lock).
      isMergeStateSettled(r.mergeState)
    ) {
      completed.add(nodeId)
    }
    // RFC-306: a fresh `skipped` row completes its node. The node did not run —
    // by design — and holding the scope open for it would turn every closed
    // branch into `scheduler stalled` (the pre-RFC-306 outcome of a node that
    // could never become ready). No merge_state gate: a skipped node spawns no
    // process and therefore owns no isolated worktree to merge back.
    //
    // Downstream is NOT force-skipped from here. Each downstream node becomes
    // ready and makes its OWN judgment at dispatch (runOneNode), because with
    // `joinMode: 'any'` a node fed by one skipped and one live upstream must
    // still run. Propagation is the emergent result of that per-node judgment,
    // never a graph walk that assumes it.
    else if (r.status === 'skipped' && isNodeRunFresh(r, freshestSettled)) {
      completed.add(nodeId)
    }
    // 'exhausted' (loop hit maxIterations without exit) is a TERMINAL FAILURE,
    // not a completion. Marking it completed made a resume invocation see an
    // exhausted top-level loop as done → the task silently flipped failed→done
    // and downstream consumed empty output. Bucket it as a failure so the scope
    // fails consistently on the first run AND any resume. See
    // scheduler-boundary-loop-exhausted-resume.test.ts.
    else if (r.status === 'exhausted') exhausted.push(nodeId)
  }
  // Pass 2 — settles-without-row (C1/N6). clarify nodes have no structural
  // upstream (channel edges dropped) so are leaves; cross-clarify depends on its
  // questioner (settled in pass 1), so one pass over pass-1 `completed` suffices.
  for (const n of scopeNodes) {
    if (completed.has(n.id)) continue
    if (!SETTLES_WITHOUT_ROW_KINDS.has(n.kind)) continue
    const latest = latestPerNode.get(n.id)
    if (latest !== undefined && isLiveStatus(latest.status)) continue
    if (openClarifyNodeIds.has(n.id)) continue
    if (areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) completed.add(n.id)
  }

  // RFC-092 (audit S-1, design §1.2b): node ids whose ASKING run still has an
  // open (un-answered) clarify session. submitClarifyAnswers mints the rerun
  // row BEFORE writing the answers / flipping the session (clarify.ts, no real
  // transaction under bun:sqlite) — releasing that pending row inside the
  // window would start the rerun without its answers. Derived from the rows we
  // already hold; the set empties the tick after the session flips answered.
  const openAskingNodeIds = new Set<string>()
  if (askingRunIds.size > 0) {
    for (const r of rows) {
      if (askingRunIds.has(r.id)) openAskingNodeIds.add(r.nodeId)
    }
  }

  const awaitingReview: string[] = []
  const awaitingHuman: string[] = []
  const failed: string[] = []
  const blocked: Array<{ nodeId: string; status: string; reason: string }> = []
  const ready: string[] = []
  const pendingAnchors = new Map<string, string>()
  let remainingCount = 0
  for (const n of scopeNodes) {
    if (completed.has(n.id)) continue
    remainingCount += 1
    // RFC-120 T9 (model A): a deferred designer handler parks awaiting_human until
    // batch-dispatch mints its rerun (mirrors the askingRunIds park below). Its
    // done draft is not (re-)dispatchable here — dispatchTaskQuestions stamps
    // trigger_run_id + mints the pending rerun, which the next tick picks up once
    // this node leaves the deferred set.
    if (deferredHandlerNodeIds.has(n.id)) {
      awaitingHuman.push(n.id)
      continue
    }
    const latest = latestPerNode.get(n.id)
    // Asking agent parked on an open clarify: its `done` row is mid-conversation,
    // not a completion and not (re-)dispatchable — submitClarifyAnswers mints the
    // rerun. Park it in awaitingHuman so the scope bubbles awaiting_human (and so
    // a `done`-status latest doesn't fall through to no bucket → false stall).
    if (latest !== undefined && askingRunIds.has(latest.id)) {
      awaitingHuman.push(n.id)
      continue
    }
    // RFC-092 (audit S-1): a `pending` latest row is an explicit new-work
    // signal (out-of-band rerun mint by submitClarifyAnswers / review
    // iterate-reject, or a resume placeholder). The per-invocation node-level
    // dedup must NOT permanently mask it — that turned a mid-run clarify
    // answer into a false `scheduler stalled` failure. Release it once per
    // ROW (dispatchedPendingRowIds), and never while its asking session is
    // still open (answer-write race window — see openAskingNodeIds above).
    const pendingAnchorReleasable =
      latest !== undefined &&
      latest.status === 'pending' &&
      !dispatchedPendingRowIds.has(latest.id) &&
      !openAskingNodeIds.has(n.id)
    // RFC-098 B3 (audit S-3 + the RFC-092 documented limitation): a parked
    // WRAPPER row (awaiting_*) gets the same one-shot in-invocation release,
    // keyed on its inner REVIVAL EVIDENCE row (the pending rerun a mid-run
    // clarify answer minted, or the done∧fresh review row an approve flipped
    // — wrapperRevivalEvidence, dispatchFrontier.ts). Without this, a wrapper
    // already in `dispatchedThisInvocation` could never pick up the human
    // action and the task fell back to awaiting_* needing a manual resume.
    //
    // No-busy-loop argument (five layers, mirrors RFC-092 §1.3):
    //   ① the evidence ROW id is recorded into dispatchedPendingRowIds on
    //      dispatch (pendingAnchors below) — the same evidence releases the
    //      wrapper at most once per invocation;
    //   ② a dispatched wrapper enters `inFlight` — no re-dispatch same tick;
    //   ③ the wrapper resume immediately flips its row running — `latest`
    //      leaves awaiting_*, this predicate stops matching while it runs;
    //   ④ the inner runScope consumes a pending evidence row via its
    //      pendingExisting reuse (row flips running → terminal) — the
    //      evidence disappears; NEW evidence can only be minted by a new
    //      human action (fresh ULID re-arms exactly one more release);
    //   ④' while the evidence node's clarify session is still OPEN (answers
    //      mid-write), openAskingNodeIds blocks the release — the next tick
    //      after the session flips answered releases it;
    //   ⑤ pathological leak (inner exits without consuming the pending row —
    //      the known RFC-092 shape): the anchor is already recorded, so no
    //      further release — degrades to the bounded park/stalled semantics.
    const wrapperEvidence =
      latest !== undefined &&
      (latest.status === 'awaiting_human' || latest.status === 'awaiting_review') &&
      WRAPPER_KINDS.has(n.kind)
        ? wrapperRevivalEvidence(latest, rows, definition)
        : null
    const wrapperAnchorReleasable =
      wrapperEvidence !== null &&
      !dispatchedPendingRowIds.has(wrapperEvidence.rowId) &&
      !openAskingNodeIds.has(wrapperEvidence.nodeId)
    // RFC-306 (design-gate P1#7) — a STALE skip gets the same one-shot release.
    //
    // Without it: `N` is skipped early in an invocation; later in the SAME
    // invocation the deciding upstream re-runs (a review iterate released by a
    // pending anchor) and re-opens the branch. `N`'s skip is now stale, but `N`
    // is already in `dispatchedThisInvocation` and owns no pending row of its
    // own, so it can never go ready again — the scope quiesces and reports
    // `scheduler stalled`, i.e. a NORMAL branch flip surfaces as task failure.
    //
    // The release is keyed on the EVIDENCE — the upstream run that made the skip
    // stale — not on the skip row, so it is one-shot per new upstream generation
    // (layer ① of the RFC-092 no-busy-loop argument): the same upstream row can
    // release this node at most once per invocation, and a further release needs
    // a genuinely newer upstream run.
    const staleSkipEvidenceId =
      latest !== undefined &&
      latest.status === 'skipped' &&
      !isNodeRunFresh(latest, freshestSettled)
        ? (freshestUpstreamEvidenceId(latest, upstreamsOf.get(n.id) ?? [], freshestSettled) ?? null)
        : null
    const staleSkipReleasable =
      staleSkipEvidenceId !== null && !dispatchedPendingRowIds.has(staleSkipEvidenceId)
    const dispatchable =
      areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed) &&
      !inFlight.has(n.id) &&
      (pendingAnchorReleasable ||
        wrapperAnchorReleasable ||
        staleSkipReleasable ||
        !dispatchedThisInvocation.has(n.id)) &&
      isDispatchable(latest, n.kind, freshestSettled, rows, definition)
    if (dispatchable) {
      ready.push(n.id)
      if (latest !== undefined && latest.status === 'pending') {
        pendingAnchors.set(n.id, latest.id)
      } else if (staleSkipEvidenceId !== null) {
        // Record the evidence on EVERY ready pass (same reasoning as the wrapper
        // anchor below): a re-skip against the same upstream generation must not
        // release the node a second time.
        pendingAnchors.set(n.id, staleSkipEvidenceId)
      } else if (wrapperEvidence !== null) {
        // Record the wrapper's evidence row EVERY time it goes ready (also on
        // the plain !dispatchedThisInvocation release) so layer ① holds: a
        // re-park at the same window with the same done-review evidence stays
        // parked instead of hot-looping.
        pendingAnchors.set(n.id, wrapperEvidence.rowId)
      }
      continue
    }
    // RFC-095 (audit S-12): EXHAUSTIVE bucketing over the full NodeRunStatus
    // universe — a new status fails compilation here instead of silently
    // becoming an undiagnosable "scheduler stalled". The three park buckets
    // collect UNCONDITIONALLY (pre-RFC-095 semantics: an awaiting/failed row
    // parks regardless of upstream readiness — quiescent priority awaiting_* >
    // failed depends on it; derive-frontier.test.ts locks the failed case).
    // Only the `blocked` diagnostic branches gate on "upstreams complete ∧ not
    // in flight" — waiting-on-upstream / in-flight nodes are not stuck points.
    switch (latest?.status) {
      case 'awaiting_review':
        awaitingReview.push(n.id)
        break
      case 'awaiting_human':
        awaitingHuman.push(n.id)
        break
      case 'failed':
        failed.push(n.id)
        break
      case 'exhausted':
        break // already collected into the exhausted bucket in pass 1
      default: {
        if (!areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) break
        if (inFlight.has(n.id)) break
        const st = latest?.status
        switch (st) {
          case undefined:
            // clarify / cross-clarify graph-visit no-ops write no row; with an
            // open session pass 2 keeps them unsettled — a normal park, not a
            // dedup pathology. Anything else here was dispatched this
            // invocation and produced no row.
            blocked.push({
              nodeId: n.id,
              status: 'absent',
              reason: openClarifyNodeIds.has(n.id) ? 'open-clarify-window' : 'in-invocation-dedup',
            })
            break
          case 'pending':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: openAskingNodeIds.has(n.id)
                ? 'open-clarify-window'
                : 'pending-anchor-consumed',
            })
            break
          case 'running':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'orphaned-running-row (restart daemon to reap, audit S-12)',
            })
            break
          case 'canceled':
            // RFC-095: plain canceled rows are revival-dispatchable; only
            // review-supersede marker rows stay parked (see isDispatchable). A
            // plain canceled row lands here only via the per-invocation dedup.
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: isReviewSupersededRow(latest!)
                ? 'review-superseded'
                : 'canceled-in-invocation-dedup',
            })
            break
          case 'skipped':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'skipped-has-no-dispatch-semantics',
            })
            break
          case 'done': {
            // RFC-130 §6.3 / RFC-144: exhaustive over MergeStateOrNull — a done row
            // parked at 'conflict-human' bubbles awaiting_human (decideScopeOutcome);
            // 'merge-failed' is a hard merge failure → the scope fails; 'abandoned'
            // (superseded generation, RFC-144) joins the stale-done dedup bucket like
            // every other stale row; a NEW merge state added to the union without a
            // bucket here is a compile error.
            const ms = (latest?.mergeState ?? null) as MergeStateOrNull
            switch (ms) {
              case 'conflict-human':
                awaitingHuman.push(n.id)
                break
              case 'merge-failed':
                failed.push(n.id)
                break
              case null:
              case 'isolating':
              case 'pending-merge':
              case 'merged':
              case 'abandoned':
                blocked.push({
                  nodeId: n.id,
                  status: st,
                  reason: 'stale-done-in-invocation-dedup',
                })
                break
              default: {
                const _exhaustive: never = ms
                void _exhaustive
                // Runtime-unknown legacy value — same dedup bucket as before.
                blocked.push({
                  nodeId: n.id,
                  status: st,
                  reason: 'stale-done-in-invocation-dedup',
                })
              }
            }
            break
          }
          case 'interrupted':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'interrupted-in-invocation-dedup',
            })
            break
          default: {
            // awaiting_* / failed / exhausted were collected by the outer
            // switch — anything reaching here is a NEW NodeRunStatus value.
            const _exhaustive: never = st
            void _exhaustive
          }
        }
      }
    }
  }
  return {
    completed,
    ready,
    pendingAnchors,
    awaitingReview,
    awaitingHuman,
    failed,
    exhausted,
    blocked,
    allSettled: remainingCount === 0,
  }
}
