// RFC-120 — task question list / 任务中心 read-side service.
//
// Collection (reconcile) + handler-run resolution + list are all LAZY / read-time:
// derived from the existing clarify_rounds + node_runs + node_run_outputs, so the
// ledger needs ZERO edits to clarify.ts / crossClarify.ts (the answer→dispatch
// backend stays untouched — important while a concurrent RFC occupies those files).
//
//   * reconcileTaskQuestionsForRound — one clarify_round → its handler entries
//     (问题 × 承接角色), upserted idempotently (preserves the manual overlay:
//     override / confirmation / staged / audit).
//   * resolveEntryHandler — the entry's authoritative handler run, looked up by
//     the round's RFC-070 consumption stamp id (Codex F4; includes fanout child
//     rows — impl gate F2). Answered-without-stamp = in-flight (no run guessing — F1).
//   * listTaskQuestions — lazy-reconcile every round of a task, then derive each
//     entry's phase (pure deriveQuestionPhase) into a DTO for the board /
//     clarify-page / node badge.
//
// See design/RFC-120-task-question-list §2.3 / §4 / §11.

import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  canReassign,
  deriveQuestionPhase,
  reconcileDesiredEntries,
  resolveHandlerRun,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type HandlerRunView,
  type RunLineageView,
  type TaskQuestionPhase,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

type ClarifyRoundRow = typeof clarifyRounds.$inferSelect
type TaskQuestionRow = typeof taskQuestions.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

export interface TaskQuestionDTO {
  id: string
  taskId: string
  /** The clarify/cross-clarify round's node-run id (the `/clarify/$id` page). NULL for a
   *  manual question (RFC-120 §15) — it has no clarify round / answer page. */
  originNodeRunId: string | null
  questionId: string
  questionTitle: string
  sourceKind: 'self' | 'cross' | 'manual'
  /** RFC-162: 'echo' 已删。default self/questioner；designer = 人工增派的修订 handler。 */
  roleKind: 'self' | 'questioner' | 'designer'
  /** The node that ASKED the question (round.askingNodeId) — drives the node badge.
   *  NULL for a manual question (no source node; the board shows "手动"). */
  sourceNodeId: string | null
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
  /** override ?? default — who currently handles it. */
  effectiveTargetNodeId: string | null
  phase: TaskQuestionPhase
  confirmation: 'open' | 'confirmed'
  confirmedBy: string | null
  /** staged into 待下发 but not yet dispatched. */
  staged: boolean
  /** RFC-140 W2 — queued for the scheduler's auto-serial redispatch: the user's batch dispatch
   *  auto-split-deferred this entry (marker set, still undispatched, still staged). The board
   *  shows a "自动下发排队中" badge so the deferral is visible without a manual re-click. */
  autoDispatchDeferred: boolean
  /** RFC-128 §10 — this (question × role) entry's answer is sealed/locked. Derived from
   *  `sealed_at != null` OR the whole round being answered (a pre-RFC-128 answered round
   *  needs no backfill). Manual questions are always sealed (the instruction IS the
   *  content). Drives the centralized-answer pane (which unsealed questions remain),
   *  the /clarify grey-out, and the stage gate — these must use `sealed`, NOT
   *  `answerSummary !== null`, since a partial round leaves `answerSummary` independent
   *  of round status (Codex design gate F3). */
  sealed: boolean
  reopenCount: number
  /** Brief of the human's answer for this question (null if not yet sealed). Computed
   *  per-question independent of the round's `status` (RFC-128 F3): a sealed question in
   *  a still-awaiting_human (partial) round still shows its answer. */
  answerSummary: string | null
  createdAt: number
  updatedAt: number
}

function parseQuestions(json: string): ClarifyQuestion[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyQuestion[]) : []
  } catch {
    return []
  }
}

function parseAnswers(json: string | null): ClarifyAnswer[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyAnswer[]) : []
  } catch {
    return []
  }
}

/** Graph role node read straight off the round row (RFC-162: reconcile only needs the ASKER —
 *  self → askingNodeId is the asking node; cross → askingNodeId is the questioner). The graph
 *  designer is no longer consulted by reconcile (scope deleted; designer handlers are manual). */
function graphForRound(round: ClarifyRoundRow) {
  return {
    askingNodeId: round.kind === 'self' ? round.askingNodeId : null,
    questionerNodeId: round.kind === 'cross' ? round.askingNodeId : null,
  }
}

/** RFC-128 P2-1 — tx-aware core of {@link reconcileTaskQuestionsForRound}: upsert a
 *  round's desired handler entries onto the GIVEN transaction. Extracted so the
 *  per-question seal primitive (services/clarifySeal.ts) can reconcile INSIDE its own
 *  single atomic dbTxSync (dbTxSync does not nest). Idempotent; preserves the manual
 *  overlay (override / confirmation / staged / sealed / audit) on existing rows.
 *
 *  RFC-162 归一: reconcile emits exactly ONE entry per question — the ASKER (self/questioner).
 *  The designer-by-default gate (per-question seal + scope + directive) is DELETED; a designer
 *  handler row is created only by a human reassign (adds an upstream/downstream reviser — see
 *  {@link reassignTaskQuestion}) and is NEVER cleaned up by reconcile (reconcile is append-only
 *  for the asker rows; it must not touch the manually-added designer rows). The asker rows are
 *  UNCONDITIONAL (created lazily on first list / seal) and their `sealed_at` is stamped later by
 *  sealRoundQuestions. */
export function reconcileRoundEntriesTx(tx: DbTxSync, round: ClarifyRoundRow): void {
  if (round.status === 'canceled' || round.status === 'abandoned') return
  const questions = parseQuestions(round.questionsJson)
  if (questions.length === 0) return
  const desired = reconcileDesiredEntries({
    kind: round.kind,
    questions,
    graph: graphForRound(round),
  })
  const now = Date.now()
  for (const d of desired) {
    tx.insert(taskQuestions)
      .values({
        id: ulid(),
        taskId: round.taskId,
        originNodeRunId: round.intermediaryNodeRunId,
        questionId: d.questionId,
        questionTitle: d.questionTitle,
        sourceKind: d.sourceKind,
        roleKind: d.roleKind,
        iteration: round.iteration,
        loopIter: round.loopIter,
        defaultTargetNodeId: d.defaultTargetNodeId,
        sealedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
        // Only refresh the graph-derived snapshot; never touch the manual overlay.
        set: {
          defaultTargetNodeId: d.defaultTargetNodeId,
          questionTitle: d.questionTitle,
          updatedAt: now,
        },
      })
      .run()
  }
}

/** One clarify_round → upsert its desired handler entries (idempotent; preserves
 *  override / confirmation / staged / sealed / audit on existing rows). Thin wrapper that
 *  runs {@link reconcileRoundEntriesTx} in its own atomic transaction. */
export function reconcileTaskQuestionsForRound(db: DbClient, round: ClarifyRoundRow): void {
  // RFC-126: terminal/aborted rounds produce NO board entries — skip before opening a tx.
  if (round.status === 'canceled' || round.status === 'abandoned') return
  dbTxSync(db, (tx) => reconcileRoundEntriesTx(tx, round))
}

/** RFC-128 P2-2 — the question ids of a clarify round (located by its origin node-run id)
 *  that have been per-question sealed (any entry carries `sealed_at`). The quick-channel
 *  whole-round submit passes this as `lockedIds` to {@link mergeSealedAnswers} so a
 *  finalize never OVERWRITES an already-sealed answer (the control channel locked it).
 *  Empty for a round with no prior per-question seal → the quick channel stays byte-for-
 *  byte unchanged (golden-lock). */
export async function loadSealedQuestionIds(
  db: DbClient,
  originNodeRunId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ questionId: taskQuestions.questionId, sealedAt: taskQuestions.sealedAt })
    .from(taskQuestions)
    .where(eq(taskQuestions.originNodeRunId, originNodeRunId))
  const out = new Set<string>()
  for (const r of rows) if (r.sealedAt !== null) out.add(r.questionId)
  return out
}

/** Entry-level handler resolution from the entry's OWN dispatch state (dispatched_at +
 *  trigger_run_id + run lineage) — independent of any clarify round. Shared by deferred
 *  designer entries AND manual entries (RFC-120 §15): both ride the §18 per-node queue,
 *  bind at the node's RERUN, and never consult a clarify_round here.
 *
 *    dispatched_at NULL              → pending/staged (not dispatched).
 *    trigger_run_id NULL            → processing (dispatched, queued/rerunning, unbound).
 *    trigger_run_id set, anchor GC'd → processing (in-flight; don't reset).
 *    trigger_run_id set, anchor live → resolveHandlerRun lineage (Codex H1: anchor +
 *      process-retries up to the next clarify-cause rerun) → processing/awaiting_confirm. */
function resolveDispatchedEntryHandler(
  entry: TaskQuestionRow,
  runs: NodeRunRow[],
  outputRunIds: Set<string>,
): { handlerRun: HandlerRunView | null; dispatchedInFlight: boolean } {
  if (entry.dispatchedAt === null) {
    // Not yet dispatched → pending/staged (the gate parks the task here).
    return { handlerRun: null, dispatchedInFlight: false }
  }
  if (entry.triggerRunId === null) {
    // Dispatched (committed for execution) but not yet bound to a handler run —
    // the frontier rerun is queued / a cascade rerun hasn't reached it yet. The
    // binding happens at the node's RERUN (buildExternalFeedbackContext), not at
    // batch-dispatch, so the entry reads processing until then.
    return { handlerRun: null, dispatchedInFlight: true }
  }
  const anchorRow = runs.find((r) => r.id === entry.triggerRunId)
  // Stamped but the run row is gone (GC) → treat as in-flight rather than reset.
  if (!anchorRow) return { handlerRun: null, dispatchedInFlight: true }
  // RFC-120 T9 (Codex H1): resolve through the dispatched run's LINEAGE — the
  // anchor + any technical process-retries the scheduler minted (same node +
  // iteration, cause 'process-retry') up to the next clarify-cause rerun — via the
  // shared oracle. A later successful retry then reads awaiting_confirm instead of
  // sticking on a failed anchor. Anchor on the run's OWN node/iteration
  // (node_runs.iteration IS the loop index; loopIter is projected 0 to neutralize
  // the unused dimension, since the lineage is already framed by node+iteration).
  const handlerRun = resolveHandlerRun({
    effectiveTargetNodeId: anchorRow.nodeId,
    iteration: anchorRow.iteration,
    loopIter: 0,
    triggerRunId: entry.triggerRunId,
    runs: runs.map(
      (r): RunLineageView => ({
        id: r.id,
        nodeId: r.nodeId,
        iteration: r.iteration,
        loopIter: 0,
        rerunCause: r.rerunCause,
        status: r.status,
        startedAt: r.startedAt,
        hasOutput: outputRunIds.has(r.id),
        parentNodeRunId: r.parentNodeRunId,
      }),
    ),
  })
  return { handlerRun, dispatchedInFlight: handlerRun === null }
}

// RFC-132 PR-E:resolveEntryHandler/resolveTriggerForEntry(RFC-070 consumption-stamp 相位)
// 已删——统一模型下每个 entry 的相位一律从它自己的 dispatch 状态派生
// (resolveDispatchedEntryHandler:dispatched_at + trigger_run_id + run lineage)。新数据恒
// sealed+dispatched(autoDispatchClarifyRound);遗留 immediate 数据由 boot 迁移垫片
// (reconcileLegacyImmediateRounds)补 sealed+dispatched+trigger;垫片 skip 的数据损轮
// (answered 无 continuation run)显示 pending——用户可经 board dispatch 补救(旧逻辑永久
// processing 反而不可恢复)。

/** Lazy-reconcile every round of a task and project each entry into a DTO with
 *  its derived phase. Optional filters: by source node (node badge / clarify page)
 *  and/or by phase (board column). */
export async function listTaskQuestions(
  db: DbClient,
  taskId: string,
  opts: { sourceNodeId?: string; phase?: TaskQuestionPhase } = {},
): Promise<TaskQuestionDTO[]> {
  const rounds = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
  for (const round of rounds) reconcileTaskQuestionsForRound(db, round)

  const entries = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
  if (entries.length === 0) return []

  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  const roundByOrigin = new Map(rounds.map((r) => [r.intermediaryNodeRunId, r]))

  const out: TaskQuestionDTO[] = []
  for (const e of entries) {
    // RFC-120 §15 — manual question: human-authored, no clarify round. Phase derives
    // from the entry's OWN dispatch state (treat content as always answered; no human-
    // answer step), and it has no source node / clarify page. NEVER falls into a source-
    // node filter (it isn't a graph node). Branch BEFORE the round lookup (H4 read-side
    // fix: a manual row's synthetic origin matches no round → the old `if (!round) continue`
    // would drop it, making manual questions invisible).
    if (e.sourceKind === 'manual') {
      if (opts.sourceNodeId) continue
      const { handlerRun, dispatchedInFlight } = resolveDispatchedEntryHandler(
        e,
        runs,
        outputRunIds,
      )
      const phase = deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: e.confirmation,
        isStaged: e.stagedAt !== null,
        dispatchedInFlight,
        handlerRun,
      })
      if (opts.phase && phase !== opts.phase) continue
      out.push({
        id: e.id,
        taskId: e.taskId,
        originNodeRunId: null,
        questionId: e.questionId,
        questionTitle: e.manualTitle ?? e.questionTitle,
        sourceKind: 'manual',
        roleKind: e.roleKind,
        sourceNodeId: null,
        defaultTargetNodeId: e.defaultTargetNodeId,
        overrideTargetNodeId: e.overrideTargetNodeId,
        effectiveTargetNodeId: e.overrideTargetNodeId ?? e.defaultTargetNodeId,
        phase,
        confirmation: e.confirmation,
        confirmedBy: e.confirmedBy,
        staged: e.stagedAt !== null,
        autoDispatchDeferred:
          e.autoDispatchDeferredAt !== null && e.dispatchedAt === null && e.stagedAt !== null,
        // Manual questions are always sealed — the human-authored instruction IS the
        // answer/content; there is no separate human-answer step to seal.
        sealed: true,
        reopenCount: e.reopenCount,
        answerSummary: e.manualBody ?? null,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })
      continue
    }
    const round = roundByOrigin.get(e.originNodeRunId)
    if (!round) continue // round vanished (task edited); skip defensively
    const effectiveTargetNodeId = e.overrideTargetNodeId ?? e.defaultTargetNodeId
    const { handlerRun, dispatchedInFlight } = resolveDispatchedEntryHandler(e, runs, outputRunIds)
    const phase = deriveQuestionPhase({
      roundStatus: round.status,
      confirmation: e.confirmation,
      isStaged: e.stagedAt !== null,
      dispatchedInFlight,
      handlerRun,
    })
    if (opts.sourceNodeId && round.askingNodeId !== opts.sourceNodeId) continue
    if (opts.phase && phase !== opts.phase) continue
    // RFC-128 §10 — a question is sealed when its own per-question marker is set OR the
    // whole round is answered (golden-lock for pre-RFC-128 answered rounds, which carry
    // no sealed_at). answerSummary is then computed independent of round.status (F3).
    const sealed = round.status === 'answered' || e.sealedAt !== null
    out.push({
      id: e.id,
      taskId: e.taskId,
      originNodeRunId: e.originNodeRunId,
      questionId: e.questionId,
      questionTitle: e.questionTitle,
      sourceKind: e.sourceKind,
      roleKind: e.roleKind,
      sourceNodeId: round.askingNodeId,
      defaultTargetNodeId: e.defaultTargetNodeId,
      overrideTargetNodeId: e.overrideTargetNodeId,
      effectiveTargetNodeId,
      phase,
      confirmation: e.confirmation,
      confirmedBy: e.confirmedBy,
      staged: e.stagedAt !== null,
      autoDispatchDeferred:
        e.autoDispatchDeferredAt !== null && e.dispatchedAt === null && e.stagedAt !== null,
      sealed,
      reopenCount: e.reopenCount,
      answerSummary: summarizeAnswer(round, e.questionId, sealed),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })
  }
  return out
}

async function runIdsWithOutput(db: DbClient, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, runIds))
  return new Set(rows.map((r) => r.nodeRunId))
}

/** Short human-readable summary of the answer to one question (labels + custom).
 *  RFC-128 F3: gated on the per-question `sealed` flag, NOT on round.status — a sealed
 *  question in a still-awaiting_human (partial) round must still show its answer, and an
 *  unsealed question must not (even after the round flips, an unsealed sibling has no
 *  answer). For a pre-RFC-128 answered round every question is sealed, so this is
 *  byte-for-byte the old `round.status !== 'answered' → null` behavior (golden-lock). */
function summarizeAnswer(
  round: ClarifyRoundRow,
  questionId: string,
  sealed: boolean,
): string | null {
  if (!sealed) return null
  const ans = parseAnswers(round.answersJson).find((a) => a.questionId === questionId)
  if (!ans) return null
  const parts: string[] = []
  if (ans.selectedOptionLabels.length > 0) parts.push(ans.selectedOptionLabels.join(', '))
  if (ans.customText.trim()) parts.push(ans.customText.trim())
  const s = parts.join(' · ')
  return s.length > 200 ? `${s.slice(0, 200)}…` : s || null
}

// ---------------------------------------------------------------------------
// RFC-120 §18 (model A, corrected) — deferred-dispatch park gate (read-only).
//
// A deferred-dispatch task parks awaiting_human while it has ANY designer-role
// task_questions entry whose source round is answered, not yet dispatched
// (dispatched_at IS NULL) and not confirmed. The scheduler frontier keeps the
// entry's effective handler node (override ?? default designer) OUT of
// `completed` and bubbles awaiting_human; the T2 invariant + S2 stuck detector
// treat that park as VALID (not corrupt/stuck). RFC-120 §18: the gate key is
// `dispatched_at` (committed for execution) — NOT `trigger_run_id` (which now binds
// at the node's RERUN, after dispatch). Dispatching the entry sets dispatched_at →
// it leaves the gate; the frontier then mints only the upstream-frontier handlers
// and the scheduler cascade re-dispatches the rest.
//
// RFC-132 (universal deferred model): the per-task `deferred_question_dispatch`
// flag is DELETED — every task takes this park path (T8 flag 停读; the immediate
// designer-rerun-at-submit path no longer exists).
// ---------------------------------------------------------------------------

/** Effective handler nodes (override ?? default designer) that should PARK a
 *  deferred-dispatch task. A node parks only when it has ≥1 UNDISPATCHED designer entry
 *  (`dispatched_at` NULL) AND NO IN-FLIGHT one (Codex H1 re-gate).
 *
 *  Per-question dispatch (部分或全部问题) means a node can hold q1 dispatched (in-flight)
 *  AND q2 staged at the same time. Parking such a node would STRAND q1's already-minted
 *  rerun (deriveFrontier keeps a parked node out of `ready`), so a node with an in-flight
 *  dispatched designer question is NOT parked — it RUNS for q1; q2 stays staged for a later
 *  dispatch that reruns the node again. A dispatched question is IN-FLIGHT until consumed
 *  (its handler run, via the same resolveHandlerRun lineage the read-side uses, reaches
 *  done+output); once consumed, a still-undispatched sibling re-parks the node so a later
 *  dispatch isn't stranded. Empty for any non-deferred task (golden-lock). */
export async function loadUndispatchedDesignerTargets(
  db: DbClient,
  taskId: string,
): Promise<Set<string>> {
  // RFC-132 PR-D' 步骤1 (T8 flag 停读): 所有任务走 deferred park 语义（旧 flag 门移除）。
  const entries = await fetchDesignerParkEntries(db, taskId)
  if (entries.length === 0) return new Set()
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  return partitionUndispatchedParkTargets(entries, runs, outputRunIds)
}

/** RFC-120 §18 designer park ENTRIES (clarify answered+continue designer rows + manual designer
 *  rows), the projection partitionUndispatchedParkTargets consumes. Extracted so the per-role
 *  designer source AND the RFC-128 P5-D all-role {@link loadUndispatchedParkTargets} share ONE
 *  query (no drift). Caller applies the deferred-flag gate + the partition. */
async function fetchDesignerParkEntries(db: DbClient, taskId: string): Promise<ParkTargetEntry[]> {
  const clarifyDesigner = await db
    .select({
      dispatchedAt: taskQuestions.dispatchedAt,
      triggerRunId: taskQuestions.triggerRunId,
      defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
      overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
    })
    .from(taskQuestions)
    .innerJoin(
      clarifyRounds,
      eq(taskQuestions.originNodeRunId, clarifyRounds.intermediaryNodeRunId),
    )
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        ne(taskQuestions.confirmation, 'confirmed'),
        eq(clarifyRounds.status, 'answered'),
        // RFC-120 T9 (Codex H2): a directive='stop' round skips the designer rerun —
        // never park on it (defense; reconcile no longer creates such designer rows).
        eq(clarifyRounds.directive, 'continue'),
      ),
    )
  // RFC-120 §15 (Codex impl-gate H1): a MANUAL designer row has a synthetic origin with NO
  // clarify round, so the INNER JOIN above misses it — yet an undispatched manual row with a
  // handler MUST park its node exactly like a clarify designer row (else the scheduler can
  // complete the task past it, and a later dispatch can't resume a `done` task → the
  // instruction is lost / a rerun is minted post-completion). Manual content is always
  // ready (the instruction IS the content), so it joins NO round — just the same designer
  // park columns, fed through the IDENTICAL undispatched/in-flight/consumed classification.
  const manualDesigner = await db
    .select({
      dispatchedAt: taskQuestions.dispatchedAt,
      triggerRunId: taskQuestions.triggerRunId,
      defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
      overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
    })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        eq(taskQuestions.sourceKind, 'manual'),
        ne(taskQuestions.confirmation, 'confirmed'),
      ),
    )
  return [...clarifyDesigner, ...manualDesigner]
}

/** The minimal park-source entry projection both the designer (clarify + manual) and the
 *  RFC-128 P5-BC self/questioner park sources feed to {@link partitionUndispatchedParkTargets}. */
interface ParkTargetEntry {
  dispatchedAt: number | null
  triggerRunId: string | null
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
}

/** Shared HOME-node park classification (RFC-120 §18 Codex H1; RFC-128 P5-BC reuse). A home
 *  node parks iff it has ≥1 UNDISPATCHED entry (`dispatched_at` NULL) AND NO IN-FLIGHT one.
 *  A dispatched entry is in-flight UNTIL consumed (its handler run, via the SAME
 *  resolveHandlerRun lineage the read-side uses, reaches `done` — incl. done-no-output, a clarify-ask
 *  follow-up round; 2026-07-01 deadlock fix, mirrors isDispatchedEntryConsumed 'in-flight'); once consumed a
 *  still-undispatched sibling re-parks the node so a later dispatch isn't stranded. Parking
 *  a node with an in-flight dispatched entry would STRAND its already-minted rerun
 *  (deriveFrontier keeps a parked node out of `ready`), so such a node is NOT parked — it
 *  RUNS; the undispatched sibling stays staged for a later dispatch that reruns the node
 *  again. RFC-131 T4 去借壳: keys on the EFFECTIVE TARGET (override ?? default — where the rerun is
 *  minted; a reassign moves the run to the target node), not the origin home, else a reassigned
 *  question would park its origin node while its rerun is in flight on the target. */
function partitionUndispatchedParkTargets(
  entries: ReadonlyArray<ParkTargetEntry>,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): Set<string> {
  if (entries.length === 0) return new Set()
  const lineageViews = runs.map(
    (r): RunLineageView => ({
      id: r.id,
      nodeId: r.nodeId,
      iteration: r.iteration,
      loopIter: 0,
      rerunCause: r.rerunCause,
      status: r.status,
      startedAt: r.startedAt,
      hasOutput: outputRunIds.has(r.id),
      parentNodeRunId: r.parentNodeRunId,
    }),
  )
  const hasUndispatched = new Set<string>()
  const hasInFlight = new Set<string>()
  for (const e of entries) {
    const target = e.overrideTargetNodeId ?? e.defaultTargetNodeId
    if (target === null || target === '') continue
    if (e.dispatchedAt === null) {
      hasUndispatched.add(target)
      continue
    }
    // Dispatched → in-flight UNTIL consumed (handler run done, via lineage — see park-note).
    if (e.triggerRunId === null) {
      hasInFlight.add(target) // queued (frontier rerun pending; not yet bound)
      continue
    }
    const anchorRow = runs.find((r) => r.id === e.triggerRunId)
    if (!anchorRow) {
      hasInFlight.add(target) // stamped but run GC'd → treat as in-flight, not consumed
      continue
    }
    const hr = resolveHandlerRun({
      effectiveTargetNodeId: anchorRow.nodeId,
      iteration: anchorRow.iteration,
      loopIter: 0,
      triggerRunId: e.triggerRunId,
      runs: lineageViews,
    })
    // in-flight consume bar (RFC-128 2026-07-01 deadlock fix — mirrors isDispatchedEntryConsumed
    // 'in-flight'): a done handler, INCLUDING done-no-output (a clarify-ask follow-up round;
    // runner.ts:1321 — done PERMANENTLY without a <workflow-output> port), has terminated → NOT
    // in-flight → the node may park (it is not running a rerun, so parking strands nothing). Only
    // NON-done (pending/running/failed) keeps it in-flight. Keying on done+output here would strand
    // the node in-flight forever across a multi-round clarify chain (its handler is done-no-output).
    const consumed = hr !== null && hr.status === 'done'
    if (!consumed) hasInFlight.add(target)
  }
  const out = new Set<string>()
  for (const t of hasUndispatched) if (!hasInFlight.has(t)) out.add(t)
  return out
}

/** Does the task currently park on ≥1 undispatched designer entry? (Self-gated on
 *  the deferred flag — always false for non-deferred tasks.) */
export async function hasUndispatchedDesignerQuestions(
  db: DbClient,
  taskId: string,
): Promise<boolean> {
  return (await loadUndispatchedDesignerTargets(db, taskId)).size > 0
}

/**
 * RFC-128 P5-BC (clean-path ③) — the self/questioner mirror of
 * {@link loadUndispatchedDesignerTargets}. Effective HOME nodes (default asking/questioner
 * node ?? override) that should PARK a deferred-dispatch task because they hold a
 * control-channel-SEALED but not-yet-dispatched self/questioner question.
 *
 * Differs from the designer source on the readiness key: a self/questioner park keys on the
 * entry's OWN `sealed_at IS NOT NULL` (control-channel seal), NOT a `clarify_rounds.status =
 * 'answered'` join. A PARTIAL seal leaves the round 'awaiting_human' forever (RFC-128 §2
 * partial is pure-derived), so the designer source's `status='answered'` + `directive='continue'`
 * join would miss every partial-sealed self/questioner question. `sealed_at` is the exact
 * "answered (control channel), awaiting dispatch" marker — set ONLY by sealRoundQuestions
 * (RFC-132 deleted the quick-channel immediate-mint path, so every continuation flows
 * through a seal).
 *
 * The undispatched / in-flight / consumed classification is the SHARED
 * {@link partitionUndispatchedParkTargets} (byte-for-byte the designer source's tail).
 */
export async function loadUndispatchedSelfQuestionerTargets(
  db: DbClient,
  taskId: string,
): Promise<Set<string>> {
  // RFC-132 PR-D' 步骤1 (T8 flag 停读): 所有任务走 deferred park 语义。
  const entries = await fetchSelfQuestionerParkEntries(db, taskId)
  if (entries.length === 0) return new Set()
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  return partitionUndispatchedParkTargets(entries, runs, outputRunIds)
}

/** RFC-128 P5-BC self/questioner park ENTRIES (control-channel SEALED, not-confirmed self/q rows),
 *  the projection partitionUndispatchedParkTargets consumes. Extracted so the per-role source AND
 *  the all-role {@link loadUndispatchedParkTargets} share ONE query (no drift).
 *  RFC-128 P5-BC §5.2.14 mixed-path step 2 (park-starve fix): a home that was sealed-undispatched
 *  (q1, control channel) but whose round got QUICK-finalized no longer parks here — the quick
 *  finalize CONSUMES (marks `confirmation='confirmed'`) the round's sealed-undispatched self/q
 *  entries, and this query excludes `confirmation='confirmed'`. So the superseded q1 drops out
 *  automatically (no starvation, no re-park duplicate). */
async function fetchSelfQuestionerParkEntries(
  db: DbClient,
  taskId: string,
): Promise<ParkTargetEntry[]> {
  return db
    .select({
      dispatchedAt: taskQuestions.dispatchedAt,
      triggerRunId: taskQuestions.triggerRunId,
      defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
      overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
    })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        inArray(taskQuestions.roleKind, ['self', 'questioner']),
        ne(taskQuestions.confirmation, 'confirmed'),
        isNotNull(taskQuestions.sealedAt),
      ),
    )
}

/**
 * RFC-128 P5-D (Codex impl-gate round 3) — the ALL-ROLE deferred park source. The scheduler's
 * deferred park set must classify in-flight HOME-level across EVERY deferred role (designer +
 * self/questioner) TOGETHER, NOT as the per-role union of {@link loadUndispatchedDesignerTargets}
 * and {@link loadUndispatchedSelfQuestionerTargets}.
 *
 * Why the per-role union deadlocks (Codex round-3 [high]): partitionUndispatchedParkTargets is
 * in-flight-aware, but only WITHIN the entry set it is given. The per-role sources partition designer
 * and self/questioner entries SEPARATELY, so a SAME-HOME node N that holds an UNDISPATCHED designer
 * entry AND an IN-FLIGHT (dispatched, unconsumed) self/questioner rerun is parked by the designer
 * source (it sees no in-flight DESIGNER entry) — stalling the pending self/questioner rerun forever,
 * while the in-flight gate blocks the manual designer dispatch until that rerun finishes ⇒ permanent
 * deadlock. P5-D autodispatch makes this reachable (it mints a self/questioner rerun on a node that
 * may also be an undispatched designer home — the §5.2.13 same-home coincidence / 借壳).
 *
 * Fix: partition ALL deferred-role entries in ONE pass, so hasInFlight spans every role. A home with
 * an undispatched entry of one role AND an in-flight entry of ANOTHER role is then correctly NOT
 * parked — its in-flight rerun runs, and the undispatched sibling re-parks the node next tick once the
 * rerun is consumed. For every NON-same-home case this is byte-identical to the old union (a home with
 * only one role's undispatched entries, or in-flight entries of the same role, classifies the same).
 * The per-role helpers stay for direct callers/tests (RFC-132: every task takes this path).
 */
export async function loadUndispatchedParkTargets(
  db: DbClient,
  taskId: string,
): Promise<Set<string>> {
  // RFC-132 PR-D' 步骤1 (T8 flag 停读): 所有任务走 deferred park 语义。
  const entries = [
    ...(await fetchDesignerParkEntries(db, taskId)),
    ...(await fetchSelfQuestionerParkEntries(db, taskId)),
  ]
  if (entries.length === 0) return new Set()
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  return partitionUndispatchedParkTargets(entries, runs, outputRunIds)
}

// RFC-120 §18 (model A, corrected) — the per-node INJECTION gate is NOT a separate
// pre-check: for a deferred task the scheduler ALWAYS calls buildExternalFeedbackContext
// with the rerun's own node_run id, and that function self-gates (selects the node's
// dispatched-unbound designer queue by effective handler — `dispatched_at` set,
// `trigger_run_id` NULL — and returns undefined when empty). So "the gate opens when the
// node has a non-empty dispatched-unconsumed queue, in addition to topology" is enforced
// inside the injection path itself; a non-handler node that merely re-ran gets undefined.

// ---------------------------------------------------------------------------
// RFC-120 PR-B writes — confirm / reassign / stage. All write only the manual
// overlay on task_questions (collision-free; the answer→dispatch backend is
// untouched). The actor's identity is UI/audit-only — NEVER enters a prompt
// (RFC-099 prompt-isolation; these columns are not read by any prompt builder).
// ---------------------------------------------------------------------------

export interface TaskQuestionActor {
  userId: string
  /** task-relationship role snapshot (owner|user|admin). */
  role: string
}

async function loadEntry(db: DbClient, entryId: string): Promise<TaskQuestionRow> {
  const [e] = await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryId)).limit(1)
  if (!e) throw new NotFoundError('task-question-not-found', `task question ${entryId} not found`)
  return e
}

/** Derive one entry's current phase (loads its round + the task's runs). */
async function deriveEntryPhase(db: DbClient, entry: TaskQuestionRow): Promise<TaskQuestionPhase> {
  // RFC-120 §15 — manual question: no clarify round. Phase from the entry's OWN dispatch
  // state (content always answered; no human-answer step) — the SAME resolution the
  // read-side uses for manual rows.
  if (entry.sourceKind === 'manual') {
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, entry.taskId))
    const outputRunIds = await runIdsWithOutput(
      db,
      runs.map((r) => r.id),
    )
    const { handlerRun, dispatchedInFlight } = resolveDispatchedEntryHandler(
      entry,
      runs,
      outputRunIds,
    )
    return deriveQuestionPhase({
      roundStatus: 'answered',
      confirmation: entry.confirmation,
      isStaged: entry.stagedAt !== null,
      dispatchedInFlight,
      handlerRun,
    })
  }
  const [round] = await db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
    .limit(1)
  if (!round) return entry.stagedAt !== null ? 'staged' : 'pending'
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, entry.taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  // RFC-132: phase 一律从 entry 自身 dispatch 状态派生(dispatched_at + trigger_run_id)。
  const { handlerRun, dispatchedInFlight } = resolveDispatchedEntryHandler(
    entry,
    runs,
    outputRunIds,
  )
  return deriveQuestionPhase({
    roundStatus: round.status,
    confirmation: entry.confirmation,
    isStaged: entry.stagedAt !== null,
    dispatchedInFlight,
    handlerRun,
  })
}

/** Does `nodeId` have ≥1 prior node_run in this task? RFC-120 §15 (Codex re-gate): the SAME
 *  predicate dispatchTaskQuestions' assertSafeFrontierTarget uses — a node with no prior run
 *  cannot be "rerun" (a frontier mint inherits the freshest run; §18 F3). A manual question
 *  always reruns its handler, so its target MUST have run (else it would park-but-never-
 *  dispatch). Shared so create / reassign / dispatch agree on "runnable". */
export async function taskNodeHasRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
): Promise<boolean> {
  return (
    (
      await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
        .limit(1)
    )[0] !== undefined
  )
}

/** Agent-kind node ids of the task's frozen workflow snapshot (reassign candidates). */
async function agentNodeIdsForTask(db: DbClient, taskId: string): Promise<Set<string>> {
  const [t] = await db
    .select({ snapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!t) return new Set()
  try {
    const def = JSON.parse(t.snapshot) as WorkflowDefinition
    return new Set(def.nodes.filter((n) => n.kind.startsWith('agent')).map((n) => n.id))
  } catch {
    return new Set()
  }
}

/** Confirm (已处理待确认 → 完成). Only from awaiting_confirm; pure closure (D5). */
export async function confirmTaskQuestion(
  db: DbClient,
  entryId: string,
  actor: TaskQuestionActor,
): Promise<void> {
  const entry = await loadEntry(db, entryId)
  // Only an awaiting_confirm entry may be confirmed (已处理待确认 → 完成). (RFC-162: the echo
  // any-phase exemption is gone — echo deleted.)
  const phase = await deriveEntryPhase(db, entry)
  if (phase !== 'awaiting_confirm') {
    throw new ConflictError(
      'task-question-not-awaiting-confirm',
      `task question is '${phase}', not awaiting_confirm`,
    )
  }
  await db
    .update(taskQuestions)
    .set({
      confirmation: 'confirmed',
      confirmedBy: actor.userId,
      confirmedByRole: actor.role,
      confirmedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(and(eq(taskQuestions.id, entryId), eq(taskQuestions.confirmation, 'open')))
}

/** RFC-162 — what a reassign actually did:
 *  - 'added-designer'   = a clarify question gained (or re-targeted) an upstream/downstream
 *                          designer handler row (target ≠ the asking node). The asker's own
 *                          self/questioner entry is UNTOUCHED (single-card model keeps the
 *                          asker in the handler group). This is「让上游/下游修订」.
 *  - 'removed-designer' = the designer handler row was removed (target == the asking node, i.e.
 *                          "back to single card"); no-op when none existed.
 *  - 'moved-manual'     = a MANUAL question's handler was re-targeted (override move — manual
 *                          rows have no asker, so they still MOVE rather than add a sibling). */
export type ReassignTaskQuestionAction = 'added-designer' | 'removed-designer' | 'moved-manual'

/** Re-target (改派) a task question's handler to a workflow agent node.
 *
 *  RFC-162 归一: a clarify question is NEVER moved — reassign EDITS its designer handler group:
 *  targeting an upstream/downstream agent node ENSURES a `roleKind='designer'` handler row on
 *  that node (keeping the asker's self/questioner entry, so the asker always reruns + gets the
 *  Q&A — no strand, no echo); targeting the asking node itself REMOVES that designer row (back
 *  to the single default card). A MANUAL question (no asker) still MOVES via override. The only
 *  constraint is the target must be a workflow agent node (Codex F5). */
export async function reassignTaskQuestion(
  db: DbClient,
  entryId: string,
  targetNodeId: string,
  actor: TaskQuestionActor,
): Promise<ReassignTaskQuestionAction> {
  const entry = await loadEntry(db, entryId)
  const agentNodeIds = await agentNodeIdsForTask(db, entry.taskId)
  if (!canReassign(targetNodeId, agentNodeIds)) {
    throw new ValidationError(
      'task-question-reassign-invalid',
      `cannot reassign '${entry.roleKind}' entry to '${targetNodeId}' (target must be a workflow agent node)`,
    )
  }

  // ---- MANUAL question: MOVE its handler (override target). Manual rows have no asker, so
  //      there is no single-card default to keep — a reassign genuinely re-targets the one row.
  if (entry.sourceKind === 'manual') {
    // Codex impl gate F3: don't re-target a terminal (confirmed) entry.
    const phase = await deriveEntryPhase(db, entry)
    if (phase === 'done') {
      throw new ConflictError('task-question-terminal', `cannot reassign a '${phase}' question`)
    }
    // RFC-120 §15 (Codex re-gate): a manual question reruns its handler, so the handler must
    // have run at least once (else the §18 park gate parks it on a target dispatch can never mint).
    if (!(await taskNodeHasRun(db, entry.taskId, targetNodeId))) {
      throw new ValidationError(
        'manual-question-target-never-run',
        `cannot assign a manual question to '${targetNodeId}': it has no prior node_run (a manual question reruns its handler, so the handler must have run at least once)`,
      )
    }
    // Once dispatched the entry is committed for execution — CAS on `dispatched_at IS NULL` so a
    // concurrent dispatch that won leaves this a 0-row no-op → reject (reopen's job post-dispatch).
    let updated = false
    dbTxSync(db, (tx) => {
      const stillOpen = tx
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(and(eq(taskQuestions.id, entryId), isNull(taskQuestions.dispatchedAt)))
        .all()
      if (stillOpen.length === 0) return
      tx.update(taskQuestions)
        .set({
          overrideTargetNodeId: targetNodeId,
          lastReassignedBy: actor.userId,
          lastReassignedAt: Date.now(),
          updatedAt: Date.now(),
        })
        .where(and(eq(taskQuestions.id, entryId), isNull(taskQuestions.dispatchedAt)))
        .run()
      updated = true
    })
    if (!updated) {
      throw new ConflictError(
        'task-question-already-dispatched',
        `cannot reassign a dispatched question (dispatched_at is set) — use reopen to re-target after dispatch`,
      )
    }
    return 'moved-manual'
  }

  // ---- CLARIFY question (self/cross): EDIT the designer handler group of (origin, question).
  // Codex impl gate F3: don't edit a terminal (confirmed → 'done') question — it is closed and
  // adding/removing a handler there only records moot intent.
  const phase = await deriveEntryPhase(db, entry)
  if (phase === 'done') {
    throw new ConflictError('task-question-terminal', `cannot reassign a '${phase}' question`)
  }
  const round = (
    await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
      .limit(1)
  )[0]
  if (round === undefined) {
    throw new ConflictError(
      'task-question-round-missing',
      `cannot reassign question ${entryId}: its clarify round is gone`,
    )
  }
  const askingNodeId = round.askingNodeId

  // Target == the asking node → "back to single card": remove the designer handler row (if any).
  if (targetNodeId === askingNodeId) {
    let dispatched = false
    dbTxSync(db, (tx) => {
      const existing = tx
        .select({ id: taskQuestions.id, dispatchedAt: taskQuestions.dispatchedAt })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
            eq(taskQuestions.questionId, entry.questionId),
            eq(taskQuestions.roleKind, 'designer'),
          ),
        )
        .all()[0]
      if (existing === undefined) return // nothing to remove (already single card)
      if (existing.dispatchedAt !== null) {
        dispatched = true
        return
      }
      tx.delete(taskQuestions).where(eq(taskQuestions.id, existing.id)).run()
    })
    if (dispatched) {
      throw new ConflictError(
        'task-question-already-dispatched',
        `cannot remove a dispatched designer handler (dispatched_at is set) — use reopen after dispatch`,
      )
    }
    return 'removed-designer'
  }

  // Target ≠ asking node → ENSURE a designer handler row targeting it (add, or re-target an
  // existing UNDISPATCHED one). The asker's self/questioner entry is never touched.
  // RFC-163 note — this is deliberately allowed on a DISPATCHED asker too:「答完/重跑后让上游
  // 修订」is a first-class flow (the quick channel auto-dispatches the asker on answer, so by
  // the time a user decides an upstream revision is needed the asker is usually dispatched).
  // The new undispatched designer row simply becomes its own 待指派 single card (the board's
  // grouping only merges UNDISPATCHED siblings — groupBoardEntries case-4), and dispatching it
  // later reruns the asker via the normal cascade (a revision pass, not an out-of-order bug).
  let dispatched = false
  const now = Date.now()
  dbTxSync(db, (tx) => {
    const existing = tx
      .select()
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
          eq(taskQuestions.questionId, entry.questionId),
          eq(taskQuestions.roleKind, 'designer'),
        ),
      )
      .all()[0]
    if (existing !== undefined) {
      if (existing.dispatchedAt !== null) {
        dispatched = true
        return
      }
      tx.update(taskQuestions)
        .set({
          defaultTargetNodeId: targetNodeId,
          overrideTargetNodeId: null,
          lastReassignedBy: actor.userId,
          lastReassignedAt: now,
          updatedAt: now,
        })
        .where(eq(taskQuestions.id, existing.id))
        .run()
      return
    }
    tx.insert(taskQuestions)
      .values({
        id: ulid(),
        taskId: entry.taskId,
        originNodeRunId: entry.originNodeRunId,
        questionId: entry.questionId,
        questionTitle: entry.questionTitle,
        sourceKind: entry.sourceKind,
        roleKind: 'designer',
        iteration: round.iteration,
        loopIter: round.loopIter,
        // The designer handler's stable node IS the reassign target (default, no override). The
        // asker keeps its own self/questioner entry — this is an ADDITIONAL group member.
        defaultTargetNodeId: targetNodeId,
        // Inherit the ASKER's actual seal state (Codex impl-gate P1): keying only on whole-round
        // status strands a designer added after a PARTIAL (per-question) seal — RFC-128 P1 lets a
        // question be individually sealed (entry.sealedAt set) while the round stays
        // 'awaiting_human' (clarifySeal.ts:22), and no later seal re-includes an already-sealed
        // question, so a `null` here would leave the designer unstageable forever. Inherit the
        // source asker entry's sealedAt (covers both whole-round-answered and per-question seal);
        // fall back to the answered-round timestamp only when the asker row itself carries none.
        sealedAt:
          entry.sealedAt ?? (round.status === 'answered' ? (round.answeredAt ?? now) : null),
        // Inherit the ASKER's staged state too (用户 2026-07-10 bug:在待下发里改派，新 designer
        // 行生成即 pending → 组内混态 → RFC-163 分组卡被防御逻辑保守落回待指派、按钮却显示
        // 「移出待下发」)。stage 是组级动作（RFC-163）——在待下发的问题增派处理节点，新成员
        // 天然随组进待下发；asker.staged 必经 stage gate ⇒ 必 sealed ⇒ 上面的 sealedAt 继承
        // 非空，二者自洽。pending asker ⇒ 继承 null，行为不变。
        stagedAt: entry.stagedAt,
        stagedBy: entry.stagedBy,
        lastReassignedBy: actor.userId,
        lastReassignedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
      })
      .run()
  })
  if (dispatched) {
    throw new ConflictError(
      'task-question-already-dispatched',
      `cannot re-target a dispatched designer handler (dispatched_at is set) — use reopen after dispatch`,
    )
  }
  return 'added-designer'
}

/** RFC-128 §11 (D5) — is this entry's answer sealed? The SAME predicate the DTO's
 *  `sealed` field uses (see {@link listTaskQuestions}), so the board's per-question
 *  `hasStage` and this server-side stage gate agree:
 *    - manual question → always sealed (the human-authored instruction IS the content);
 *    - clarify entry → its own per-question marker `sealed_at` is set OR the whole round
 *      is answered (a pre-RFC-128 answered round carries no `sealed_at` — golden-lock for
 *      legacy data + the whole-round designer entries reconcile creates on a full seal).
 *  Keyed on the seal MARKER (sealed_at / round status), NOT on answerSummary: a partial
 *  round leaves answerSummary independent of round.status (Codex design gate F3), so
 *  answerSummary is unreliable as a "has an answer" signal here. */
async function isEntrySealed(db: DbClient, entry: TaskQuestionRow): Promise<boolean> {
  if (entry.sourceKind === 'manual') return true
  if (entry.sealedAt !== null) return true
  const [round] = await db
    .select({ status: clarifyRounds.status })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
    .limit(1)
  return round?.status === 'answered'
}

/** Stage / unstage (拖入·拖出「待下发」). Approves an entry for batch dispatch.
 *  RFC-140 W2: runs under the per-task QUESTION-WRITE lock (B) — dispatchTaskQuestions holds the
 *  same lock across its whole read→plan→stamp pipeline, so a stage/unstage can never interleave
 *  with a dispatch's deferred-marker planning (the resurrect-withdrawn-intent race). Both stage
 *  directions clear `auto_dispatch_deferred_at`: the marker's lifecycle invariant is "born only
 *  from a user-clicked batch dispatch's auto-split defer; ANY staging change kills it" — a
 *  re-staged entry is back in the暂存 state and must be batch-dispatched again. */
export async function stageTaskQuestion(
  db: DbClient,
  entryId: string,
  staged: boolean,
  actor: TaskQuestionActor,
): Promise<void> {
  const entry = await loadEntry(db, entryId)
  // RFC-128 §11 (D5) — 待下发 gate: a question may only ENTER 待下发 once its answer is
  // sealed (otherwise a later batch-dispatch would mint a handler rerun with no answer to
  // inject). Only the stage DIRECTION is gated; un-staging (移出待下发) is always allowed so
  // a mistaken stage can be undone even before the question is sealed.
  if (staged && !(await isEntrySealed(db, entry))) {
    throw new ConflictError(
      'task-question-not-sealed',
      `task question ${entryId} is not yet sealed; answer (seal) it before staging it for dispatch`,
    )
  }
  await getTaskQuestionWriteSem(entry.taskId).run(async () => {
    if (staged) {
      // RFC-134 D10（Codex R2-F4 + R3-F7 + 实现 gate fold）——已下发行不可 stage：dispatch 后
      // 条目已「提交执行」，stage 只会留下脏戳。守卫是**单条条件
      // 更新**（语句级原子）+ 受影响行数判定——没有任何先查后改窗口：并发 dispatch 在同列上
      // stamp `dispatched_at`，输掉 CAS 的一方恰得 0 行 → Conflict、零脏写。changes 非数字按 0
      // 处理（fail-closed：误报冲突可重试，静默脏戳不可挽回；驱动实际恒返 ChangeStats，同
      // auth/sessionStore.ts 成例）。
      const result = await db
        .update(taskQuestions)
        .set({
          stagedAt: Date.now(),
          stagedBy: actor.userId,
          autoDispatchDeferredAt: null,
          updatedAt: Date.now(),
        })
        .where(and(eq(taskQuestions.id, entryId), isNull(taskQuestions.dispatchedAt)))
      const changes = (result as unknown as { changes?: number }).changes
      if (typeof changes !== 'number' || changes !== 1) {
        throw new ConflictError(
          'task-question-already-dispatched',
          `cannot stage a dispatched question (dispatched_at is set) — it is already committed for execution`,
        )
      }
      return
    }
    // RFC-136（用户 2026-07-02「回答问题的按键又没了」）——unstage 按「题」级联：同
    // (originNodeRunId, questionId) 的全部未下发行一起移出待下发。用户在看板操作的心智单位
    // 是问题，而一个 cross 题有 questioner+designer 两行两张卡——只移一张会留下「半 staged」
    // 题：重答守卫（sealRoundQuestions reseal 判定）与答题池（groupAnswerableQuestions
    // pastPending 排除）都要求整题回到待指派，半 staged 让问题从面板消失且无法重答。已下发
    // 行不动（staged_at 留作审计，echo 生来已下发天然豁免）；stage 方向保持逐行（gate 逐行
    // CAS，且正常路径 autoStage 本就全行同进）。
    await db
      .update(taskQuestions)
      .set({ stagedAt: null, stagedBy: null, autoDispatchDeferredAt: null, updatedAt: Date.now() })
      .where(
        and(
          eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
          eq(taskQuestions.questionId, entry.questionId),
          isNull(taskQuestions.dispatchedAt),
        ),
      )
  })
}

/** Max lengths for a manual question (title mirrors ClarifyQuestion.title ≤ 512). */
const MANUAL_TITLE_MAX = 512
const MANUAL_BODY_MAX = 20000

/** RFC-120 §15 (Codex re-gate) — task statuses that will NEVER re-enter scheduling, so a
 *  manual question created / dispatched on them would strand (no scheduler to run the rerun).
 *  `failed`/`interrupted`/`awaiting_*` are resumable/active (resumeTask resumes them), so they
 *  are NOT terminal here. Shared by createManualTaskQuestion + dispatchTaskQuestions (incl.
 *  the in-tx CAS re-read).
 *
 *  flag-audit W0（§3-13）: renamed from `TERMINAL_TASK_STATUSES` — that name collided with
 *  shared/lifecycle.ts's 4-value lifecycle terminal set (this one is a deliberately NARROWER
 *  question-dispatch policy), and the same-name-different-meaning pair was a standing
 *  import-autocomplete trap (structuralDiff/store.ts already had to alias around it). */
export const QUESTION_DISPATCH_CLOSED_TASK_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'canceled',
])

/** Throw a ConflictError when the task is terminal (done/canceled). Used BEFORE any insert /
 *  dispatched_at stamp / node_run mint so nothing is left orphaned on a finished task. */
export function assertTaskAcceptsQuestions(taskId: string, status: string): void {
  if (QUESTION_DISPATCH_CLOSED_TASK_STATUSES.has(status)) {
    throw new ConflictError(
      'task-terminal',
      `task ${taskId} is ${status}; it will not re-enter scheduling, so questions cannot be created or dispatched on it`,
    )
  }
}

export interface CreateManualTaskQuestionInput {
  title: string
  body: string
  /** REQUIRED handler agent node (RFC-120 §15 semantics: 人提问→指派 agent 处理 — a manual
   *  question is always posed TO a node). The row is created staged (待下发, ready for batch-
   *  dispatch). An absent / non-agent target is rejected. (Re-target later via reassign.) */
  targetNodeId?: string | null
}

/** RFC-120 §15 — create a manual question (自主新增/复制): a human authors a title +
 *  instruction and ASSIGNS an agent node. It is inserted DIRECTLY (not via reconcile) as a
 *  source_kind='manual', role_kind='designer' (修订型 → re-targetable / dispatchable) row,
 *  created staged (待下发) so the §18 park gate keeps the task awaiting_human until it is
 *  dispatched. It has no clarify round, so it stores its OWN fresh ULID as origin_node_run_id
 *  — a non-null synthetic identity (§16 H4) that keeps the column NOT NULL and the identity
 *  unique (no collision with the full unique index). Dispatch + the External-Feedback
 *  injection of `manual_body` reuse the §18 per-node queue UNCHANGED. The author id is
 *  recorded for audit ONLY — it NEVER enters an agent prompt (RFC-099 prompt-isolation; no
 *  prompt builder reads manual_created_by). */
export async function createManualTaskQuestion(
  db: DbClient,
  taskId: string,
  input: CreateManualTaskQuestionInput,
  actor: TaskQuestionActor,
): Promise<{ id: string }> {
  // RFC-120 §15 — task status (re-gate). RFC-132 PR-D' 步骤1 (T8 flag 停读): 统一模型下所有
  // 任务都是 deferred-dispatch，manual 恒可创建（旧 deferred-only 门移除）。
  const taskRow = (
    await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
  )[0]
  if (taskRow === undefined) {
    throw new ConflictError('task-not-found', `task ${taskId} not found`)
  }
  // (Codex re-gate): reject on a TERMINAL task (done/canceled) — it will never re-enter
  // scheduling, so the row could never park / dispatch (orphan). failed/interrupted/awaiting_*
  // are resumable/active (resumeTask resumes them), so they are allowed.
  assertTaskAcceptsQuestions(taskId, taskRow.status)
  const title = input.title.trim()
  const body = input.body.trim()
  if (title === '') {
    throw new ValidationError('manual-question-title-required', 'title is required')
  }
  if (title.length > MANUAL_TITLE_MAX) {
    throw new ValidationError(
      'manual-question-title-too-long',
      `title exceeds ${MANUAL_TITLE_MAX} characters`,
    )
  }
  if (body === '') {
    throw new ValidationError('manual-question-body-required', 'body is required')
  }
  if (body.length > MANUAL_BODY_MAX) {
    throw new ValidationError(
      'manual-question-body-too-long',
      `body exceeds ${MANUAL_BODY_MAX} characters`,
    )
  }
  // (Codex re-gate): a handler is REQUIRED — a target-less manual row has NULL effective
  // target, which the park gate cannot park on (the gate is node-keyed) → the task could
  // complete past it. Requiring assignment at creation guarantees every manual row parks.
  const target =
    typeof input.targetNodeId === 'string' && input.targetNodeId.length > 0
      ? input.targetNodeId
      : null
  if (target === null) {
    throw new ValidationError(
      'manual-question-target-required',
      'targetNodeId is required (a manual question must be assigned to an agent node)',
    )
  }
  // Same guard as reassign: a manual question is 修订型 (role designer), so its handler
  // must be a workflow AGENT node (canReassign / Codex F5) — never an io/review/wrapper.
  const agentNodeIds = await agentNodeIdsForTask(db, taskId)
  if (!agentNodeIds.has(target)) {
    throw new ValidationError(
      'manual-question-target-invalid',
      `target node '${target}' is not an agent node in this task's workflow`,
    )
  }
  // RFC-172 R2-T5: '__wg_member__' is the ONE host node ALL workgroup member assignments share,
  // separated only by node_runs.shard_key. A manual question carries NO shard binding
  // (resolveEntryShardKeys → null for source_kind='manual'), so dispatching one would inherit an
  // ARBITRARY member's shard (the global-freshest run) and hijack that assignment — there is no way
  // to express "which member". A SELF clarify answer round-trips correctly only because its round
  // carries asking_shard_key; a manual question has no such round. Reject it. (Literal, not the
  // WG_MEMBER_NODE_ID import — workgroupLaunch pulls in task/workgroups/orchestrator services and
  // importing it here would risk a module-init cycle; rfc172 test source-locks the two to match.)
  if (target === '__wg_member__') {
    throw new ValidationError(
      'manual-question-workgroup-member-target',
      `cannot target '${target}': it is the shared workgroup member host node (every member assignment shares it, separated by shard_key). A manual question has no shard binding to select a member.`,
    )
  }
  // (Codex re-gate H1): the handler must have RUN — a manual question reruns its handler, and
  // dispatch's assertSafeFrontierTarget rejects a never-run frontier. A manual has no graph
  // default to fall back to, so without this the row would park on a node dispatch can never
  // mint → stranded awaiting_human. (v1 limit: can't pre-assign to a not-yet-run node.)
  if (!(await taskNodeHasRun(db, taskId, target))) {
    throw new ValidationError(
      'manual-question-target-never-run',
      `target node '${target}' has no prior node_run (a manual question reruns its handler, so the handler must have run at least once)`,
    )
  }
  const id = ulid()
  const now = Date.now()
  // (Codex re-gate H2): the terminal pre-check above is a TOCTOU window — the scheduler can
  // flip the task to done/canceled before this insert. Re-read tasks.status INSIDE the tx and
  // roll back (no row) if it went terminal, so a manual row is never inserted on a finished task.
  dbTxSync(db, (tx) => {
    const cur = tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).all()[0]
    if (cur === undefined || QUESTION_DISPATCH_CLOSED_TASK_STATUSES.has(cur.status)) {
      throw new ConflictError(
        'task-terminal',
        `task ${taskId} became ${cur?.status ?? 'missing'} before the manual question was inserted; nothing inserted`,
      )
    }
    tx.insert(taskQuestions)
      .values({
        id,
        taskId,
        // §16 H4: non-null synthetic identity (no real node_run; the read-side branches on
        // source_kind, not on this resolving to a round).
        originNodeRunId: ulid(),
        questionId: ulid(),
        questionTitle: title,
        sourceKind: 'manual',
        roleKind: 'designer',
        iteration: 0,
        loopIter: 0,
        defaultTargetNodeId: null,
        overrideTargetNodeId: target,
        manualTitle: title,
        manualBody: body,
        manualCreatedBy: actor.userId,
        // §15: a handler is required → the row is created staged (待下发) so the park gate
        // holds the task awaiting_human until the human dispatches it.
        stagedAt: now,
        stagedBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  return { id }
}
