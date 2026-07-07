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

import { and, eq, inArray, isNotNull, isNull, ne, notInArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'

import type { DbClient } from '@/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import {
  canReassign,
  deriveQuestionPhase,
  reconcileDesiredEntries,
  resolveHandlerRun,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
  type HandlerRunView,
  type RunLineageView,
  type TaskQuestionPhase,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

type ClarifyRoundRow = typeof clarifyRounds.$inferSelect
type TaskQuestionRow = typeof taskQuestions.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

const log = createLogger('task-questions')

export interface TaskQuestionDTO {
  id: string
  taskId: string
  /** The clarify/cross-clarify round's node-run id (the `/clarify/$id` page). NULL for a
   *  manual question (RFC-120 §15) — it has no clarify round / answer page. */
  originNodeRunId: string | null
  questionId: string
  questionTitle: string
  sourceKind: 'self' | 'cross' | 'manual'
  /** RFC-134: + 'echo'（改派回执——只读知会卡）。 */
  roleKind: 'self' | 'questioner' | 'designer' | 'echo'
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

function parseScopes(json: string | null): Record<string, ClarifyQuestionScope> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? (v as Record<string, ClarifyQuestionScope>) : {}
  } catch {
    return {}
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

/** Graph role nodes read straight off the round row (no workflow-def / find* needed):
 *  self → askingNodeId is the asking node; cross → askingNodeId is the questioner,
 *  targetConsumerNodeId is the (default) designer. */
function graphForRound(round: ClarifyRoundRow) {
  return {
    askingNodeId: round.kind === 'self' ? round.askingNodeId : null,
    questionerNodeId: round.kind === 'cross' ? round.askingNodeId : null,
    designerNodeId: round.targetConsumerNodeId,
  }
}

/** RFC-128 P2-1 — tx-aware core of {@link reconcileTaskQuestionsForRound}: upsert a
 *  round's desired handler entries onto the GIVEN transaction. Extracted so the
 *  per-question seal primitive (services/clarifySeal.ts) can reconcile INSIDE its own
 *  single atomic dbTxSync (dbTxSync does not nest). Idempotent; preserves the manual
 *  overlay (override / confirmation / staged / sealed / audit) on existing rows.
 *
 *  RFC-128 P3 (designer 逐题下发) — the designer gate is now TRULY per-question: a designer
 *  entry is created for each question that is SEALED (its own task_questions `sealed_at` is
 *  set, OR the whole round is answered) AND designer-scoped. This replaces the P2-4a interim
 *  that keyed the WHOLE round (`round.status === 'answered'`); a PARTIAL seal of Q1 (designer
 *  scope) now emits Q1's designer entry while an unsealed Q2 emits none. The matching
 *  per-question dispatch (assertDesignerReady readiness exempts the dispatched origins) +
 *  injection (buildNodeQueueExternalFeedback renders a partial round) land in the same P3, so
 *  a per-question designer row is fully usable (stageable + dispatchable + injects only its
 *  own Q&A). Golden lock: a FULL seal marks every question sealed (round answered ⇒ the
 *  `roundAnswered` short-circuit below), reproducing the old whole-round behavior
 *  byte-for-byte. The questioner/self entries stay unconditional (always re-run).
 *
 *  The per-question sealed set = the round's already-stamped `sealed_at` entries (read off
 *  the GIVEN tx, so a lazy reconcile sees prior committed seals) UNION
 *  `opts.additionalSealedQuestionIds` — the in-flight seal subset sealRoundQuestions passes
 *  because its `sealed_at` stamp runs AFTER this reconcile in the same tx (the new designer
 *  entry must appear in THIS pass, before it can be stamped). */
export function reconcileRoundEntriesTx(
  tx: DbTxSync,
  round: ClarifyRoundRow,
  opts: { additionalSealedQuestionIds?: Iterable<string> } = {},
): void {
  if (round.status === 'canceled' || round.status === 'abandoned') return
  const questions = parseQuestions(round.questionsJson)
  if (questions.length === 0) return
  // RFC-128 P3 per-question seal gate (see the doc comment): a full seal (round answered)
  // marks every question sealed (golden lock); otherwise a question is sealed iff its own
  // entry carries `sealed_at` OR it is in this call's in-flight seal subset.
  const roundAnswered = round.status === 'answered'
  const sealedIds = new Set<string>(opts.additionalSealedQuestionIds ?? [])
  // RFC-128 P3 (Codex P2-1): the per-question `sealed_at` timestamp of each ALREADY-sealed
  // question (from its existing questioner/self/designer row). When this reconcile is the FIRST
  // to create a question's designer row while that question is already sealed — the lazy path on
  // pre-P3 (P2-4a) partial-seal data, where the designer row never existed — the new row must
  // carry `sealed_at` too, because listTaskQuestions / stageTaskQuestion judge a partial-round
  // entry's seal state by the row's OWN `sealed_at` (a NULL would render the sealed question as
  // unsealed → unstageable). In-flight seals (additionalSealedQuestionIds) are NOT here yet
  // (their stamp runs in sealRoundQuestions step 4, after this reconcile) → their new rows stay
  // NULL and step 4 stamps them (golden lock for the seal path).
  const sealedAtByQuestion = new Map<string, number>()
  if (!roundAnswered) {
    const existing = tx
      .select({ questionId: taskQuestions.questionId, sealedAt: taskQuestions.sealedAt })
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId))
      .all()
    for (const e of existing) {
      if (e.sealedAt !== null) {
        sealedIds.add(e.questionId)
        sealedAtByQuestion.set(e.questionId, e.sealedAt)
      }
    }
  }
  const questionSealed: Record<string, boolean> = {}
  for (const q of questions) questionSealed[q.id] = roundAnswered || sealedIds.has(q.id)
  const desired = reconcileDesiredEntries({
    kind: round.kind,
    questions,
    questionSealed,
    // RFC-120 T9 (Codex H2): a directive='stop' round intentionally skips the
    // designer rerun → no designer entry (else a deferred task parks forever on it).
    directive: round.directive,
    scopes: parseScopes(round.questionScopesJson),
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
        // Codex P2-1: a NEW row for an ALREADY-sealed question inherits that question's
        // `sealed_at` so a lazily-created designer row is consistently sealed (see above). Rows
        // for in-flight / unsealed questions stay NULL. onConflictDoUpdate below never touches
        // `sealed_at`, so an existing row's seal stamp is preserved.
        sealedAt: sealedAtByQuestion.get(d.questionId) ?? null,
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

  // RFC-128 P3 (Codex P2-2) — reconcile UNDISPATCHED designer rows DOWN to `desired` (reconcile
  // is otherwise append-only). The only way `desired` drops a designer question it previously
  // emitted is a 'stop' FINALIZE (reconcileDesiredEntries suppresses ALL designer rows for a
  // stop round) or the question being removed from the round. A stale designer row from an
  // earlier continue partial-seal would otherwise stay visible + dispatchable on a now-stopped
  // round and mint a designer rerun the stop forbids. Constraints (Codex P2-2): (1) ONLY
  // role='designer' rows — questioner/self are unconditional, never cleaned; (2) ONLY
  // dispatched_at IS NULL — an already-dispatched rerun is a fait accompli, not recalled here;
  // (3) idempotent — a continue round's designer questions ARE in `desired`, so notInArray
  // matches none → nothing deleted (golden lock); (4) RFC-126 safe — an answered CONTINUE round
  // keeps its designer rows (still desired); only a stop round's UNDISPATCHED designer rows go.
  //
  // (5) Codex P2 re-gate — run ONLY when the round is FINALIZED (`roundAnswered`). The directive
  // is a FINALIZE-only decision: a PARTIAL defer-seal does NOT persist `directive` (clarifySeal
  // gates `directiveSet` on fullySealed), yet it DOES feed reconcile the TRANSIENT in-memory
  // directive. So a partial seal carrying `directive:'stop'` (e.g. seal q2=stop while q1 is
  // sealed+staged and q3 is still open) makes `desired` drop designer rows even though the
  // round's persisted directive is still null/continue. Without this gate the cleanup would
  // delete q1's UNDISPATCHED designer row — losing its human overlay (staged / override) — and
  // the lazy path (reading the persisted null→continue directive) would recreate it un-staged.
  // A designer row may only be cleaned once the round actually answers with stop, so partial
  // rounds (round still awaiting_human) skip cleanup entirely; their designer rows + overlays
  // are preserved until the directive is finalized.
  if (roundAnswered) {
    const desiredDesignerIds = desired
      .filter((d) => d.roleKind === 'designer')
      .map((d) => d.questionId)
    tx.delete(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId),
          eq(taskQuestions.roleKind, 'designer'),
          isNull(taskQuestions.dispatchedAt),
          ...(desiredDesignerIds.length > 0
            ? [notInArray(taskQuestions.questionId, desiredDesignerIds)]
            : []),
        ),
      )
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
  // RFC-134 D3：回执（echo）是只读知会卡——**任意相位**可 confirm（人「已知悉」即收卡）；
  // confirm 只收看板卡、不撤销投递（注入选取层不读 confirmation——投递撤销语义在任何条目上
  // 都不存在，老化是唯一出队方式）。其余角色保持仅 awaiting_confirm 可确认（guard 不变）。
  if (entry.roleKind !== 'echo') {
    const phase = await deriveEntryPhase(db, entry)
    if (phase !== 'awaiting_confirm') {
      throw new ConflictError(
        'task-question-not-awaiting-confirm',
        `task question is '${phase}', not awaiting_confirm`,
      )
    }
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

/** RFC-138 — what a reassign actually did: 'override' = the regular re-target write;
 *  'collapsed-to-questioner' = a cross designer entry re-targeted to its round's ASKING
 *  node degenerated into scope='questioner' (entry deleted, scope flipped — see below).
 *  RFC-140 W1 — 'collapsed-to-designer' = the MIRROR: a cross questioner entry re-targeted
 *  to its round's DESIGNER (targetConsumerNodeId) degenerated into scope='designer'. */
export type ReassignTaskQuestionAction =
  | 'override'
  | 'collapsed-to-questioner'
  | 'collapsed-to-designer'

/** Re-target (改派) an entry's handler to a workflow agent node. RFC-127 T4: ANY role
 *  (self/questioner via 借壳顶替, designer/manual via the original swap) is reassignable;
 *  the only constraint is the target must be a workflow agent node (Codex F5). */
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
  // Codex impl gate F3: don't re-target a terminal entry — the work is closed and
  // an override there only records moot intent / risks confusing the resolution.
  const phase = await deriveEntryPhase(db, entry)
  if (phase === 'done') {
    // RFC-126: 'closed' removed (no terminal-abandon); only 'done' (confirmed) is terminal.
    throw new ConflictError('task-question-terminal', `cannot reassign a '${phase}' question`)
  }
  // RFC-120 §15 (Codex re-gate): a MANUAL question has NO graph default to fall back to, so
  // its handler must ALWAYS be a node that has run (else the §18 park gate parks it on a
  // target dispatch can never mint → stranded awaiting_human). Require a run node here too,
  // matching createManualTaskQuestion. The clarify-designer override path is intentionally
  // NOT gated here: it keeps the shipped §18 design (reassign records intent, dispatch's
  // assertSafeFrontierTarget rejects a never-run frontier; the run graph-default is the
  // recoverable fallback — locked by the "never-run override target → rejected" test).
  if (entry.sourceKind === 'manual' && !(await taskNodeHasRun(db, entry.taskId, targetNodeId))) {
    throw new ValidationError(
      'manual-question-target-never-run',
      `cannot assign a manual question to '${targetNodeId}': it has no prior node_run (a manual question reruns its handler, so the handler must have run at least once)`,
    )
  }
  // RFC-138 — collapse 分支：cross 轮 designer 行改派到**该轮提问节点**时，写 override 会双跑
  // ——questioner 行恒 mint 续跑（cause 'cross-clarify-questioner-rerun'）+ 本行再 mint 修订
  // rerun（cause 'cross-clarify-answer'），两 cause 互斥（auto-split + in-flight 门 + 双账本
  // 守卫）强制串行成两条 rerun、同一 Q&A 处理两遍。RFC-134 只定义了「承接≠提问节点→echo
  // 补投」的半边不变量；承接==提问节点的去重合并在此补上：语义等价于「把该题 scope 事后改为
  // questioner」——两表 question_scopes_json 翻转 + 删本行，该题只剩 questioner 行（本就指向
  // 提问节点）→ 天然一条续跑、单份投递，并顺带脱离 dispatch 的整轮单目标 409。round 缺失 /
  // kind≠cross / 目标≠提问节点 ⇒ 回落常规 override 路径（golden-lock 逐字不变）。
  if (entry.sourceKind === 'cross' && entry.roleKind === 'designer') {
    const round = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
        .limit(1)
    )[0]
    if (round !== undefined && round.kind === 'cross' && targetNodeId === round.askingNodeId) {
      return collapseDesignerEntryToQuestioner(db, entry, round, actor)
    }
  }
  // RFC-140 W1 — the MIRROR collapse: a cross questioner entry re-targeted to its round's
  // DESIGNER (targetConsumerNodeId). Writing an override here would leave the question with TWO
  // rows on ONE node carrying mutually-exclusive causes (questioner-rerun + designer-answer) —
  // the auto-split then forces two serial reruns processing the SAME Q&A twice (QMGP5 2026-07-03
  // 16:21, deferredEntryCount=5), and the questioner-rerun's inline-resume semantics don't even
  // apply to the designer node. Semantically this reassign IS "flip the question's scope to
  // 'designer' after the fact": the designer row (which already targets the designer) becomes the
  // question's ONLY handler; the asking node keeps visibility via an echo receipt (RFC-134 — the
  // asymmetry vs RFC-138: there the SURVIVOR itself points at the asking node, here it doesn't).
  // round missing / kind≠cross / target≠designer ⇒ fall through to the regular override path.
  if (entry.sourceKind === 'cross' && entry.roleKind === 'questioner') {
    const round = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
        .limit(1)
    )[0]
    if (
      round !== undefined &&
      round.kind === 'cross' &&
      round.targetConsumerNodeId !== null &&
      targetNodeId === round.targetConsumerNodeId
    ) {
      return collapseQuestionerEntryToDesigner(db, entry, round, actor)
    }
  }
  // RFC-120 §18 (model A, corrected): once dispatched (`dispatched_at` set), the
  // entry is committed for execution — the upstream-frontier rerun was minted and the
  // scheduler cascade will bind + inject it; a late reassign would silently re-target
  // work in flight. Post-dispatch retargeting is reopen's job. dispatchTaskQuestions
  // claims under `dispatched_at IS NULL` inside a dbTxSync, so a concurrent dispatch
  // can stamp between loadEntry and here; do the override write as a CAS on the SAME
  // column so the two race cleanly — if a dispatch won (dispatched_at is no longer
  // NULL), affect 0 rows and reject. (Non-deferred tasks never set dispatched_at, so
  // this is byte-for-byte for them — the CAS always matches.)
  let updated = false
  dbTxSync(db, (tx) => {
    const stillOpen = tx
      .select({ id: taskQuestions.id })
      .from(taskQuestions)
      .where(and(eq(taskQuestions.id, entryId), isNull(taskQuestions.dispatchedAt)))
      .all()
    if (stillOpen.length === 0) return // dispatched concurrently (or already) → no write
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
  return 'override'
}

/** RFC-138 — the collapse tx: flip the question's scope to 'questioner' on BOTH scope
 *  tables（clarify_rounds 是 reconcile 的 SoT；cross_clarify_sessions 按 RFC-058 lockstep
 *  双写，镜像 sealRoundQuestions 的纪律）并删除该题仍未下发的 designer 行。CAS 在
 *  dispatched_at 同列上（与 override 路径同语义——并发 dispatch 赢者恒胜 → 409）；round 行
 *  在 tx 内重读后 merge（绝不用 tx 外快照，防并发 seal 的 merge 写丢键）。questioner 行
 *  零改动——它本就指向提问节点，collapse 后成为该题唯一承接。不产生 override 审计戳
 *  （行已删除，不在残留行上伪造）；可见性走审计 log + 路由响应 action 字段（D4）。 */
function collapseDesignerEntryToQuestioner(
  db: DbClient,
  entry: TaskQuestionRow,
  round: ClarifyRoundRow,
  actor: TaskQuestionActor,
): ReassignTaskQuestionAction {
  let collapsed = false
  let dispatchedElsewhere: string | null = null
  dbTxSync(db, (tx) => {
    // Re-read the entry INSIDE the tx (Codex impl-gate round-2 P2): a sealRoundQuestions commit
    // between the caller's loadEntry and this tx stamps the questioner row's sealed_at — deciding
    // the survivor/echo seal from the STALE pre-tx snapshot would delete that freshly-sealed row
    // and leave the new rows unsealed forever (no later seal call comes; selectAgentQueue filters
    // unsealed rows → the echo receipt would never inject). The tx read sees every committed seal.
    const curEntry = tx
      .select({ id: taskQuestions.id, sealedAt: taskQuestions.sealedAt })
      .from(taskQuestions)
      .where(and(eq(taskQuestions.id, entry.id), isNull(taskQuestions.dispatchedAt)))
      .all()[0]
    if (curEntry === undefined) return // dispatched concurrently (or already) → no write
    // RFC-140 遗留修复（用户 2026-07-05 裁决）— 幸存 questioner 行三分支（镜像 RFC-140 W1 的
    // survivor 处理）：既存行可能带旧第三节点 override（曾被改派到 X）。塌缩语义是「该题让提
    // 问节点自己消化」，幸存行必须真的指回提问节点：
    //   - 已下发且 effective ≠ 提问节点（在 X 上执行）→ 409 拒塌缩（已提交执行不可改目标，
    //     reopen 的职责）；
    //   - 已下发且 effective == 提问节点 → 塌缩照做、幸存行零改动（义务已在正轨）；
    //   - 未下发带旧 override → 归一化清 override + 改派审计戳（effective 回落提问节点）。
    const existingQuestioner = tx
      .select()
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
          eq(taskQuestions.questionId, entry.questionId),
          eq(taskQuestions.roleKind, 'questioner'),
        ),
      )
      .all()[0]
    if (existingQuestioner !== undefined && existingQuestioner.dispatchedAt !== null) {
      const effective =
        existingQuestioner.overrideTargetNodeId ?? existingQuestioner.defaultTargetNodeId
      if (effective !== round.askingNodeId) {
        dispatchedElsewhere = effective
        return // survivor already dispatched to a third node — committed work, reopen's job
      }
      // dispatched AND already on the asking node → collapse proceeds, survivor untouched.
    }
    const cur = tx
      .select({
        questionScopesJson: clarifyRounds.questionScopesJson,
        status: clarifyRounds.status,
      })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, round.id))
      .all()[0]
    const merged = { ...parseScopes(cur?.questionScopesJson ?? null) }
    merged[entry.questionId] = 'questioner'
    const scopesJson = JSON.stringify(merged)
    tx.update(clarifyRounds)
      .set({ questionScopesJson: scopesJson })
      .where(eq(clarifyRounds.id, round.id))
      .run()
    // RFC-058 dual-write — the cross round's legacy session row shares the SAME id.
    tx.update(crossClarifySessions)
      .set({ questionScopesJson: scopesJson })
      .where(eq(crossClarifySessions.id, round.id))
      .run()
    tx.delete(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
          eq(taskQuestions.questionId, entry.questionId),
          eq(taskQuestions.roleKind, 'designer'),
          isNull(taskQuestions.dispatchedAt),
        ),
      )
      .run()
    // Codex impl-gate P2（两轮）— 幸存 questioner 行必须「存在且可被 park/渲染」，collapse
    // 事务内自足保证，不依赖事后 reconcile：
    //   (a) insert-if-missing：异常形态下（懒建/损坏数据只物化了 designer 行）questioner 行
    //       缺席——事后 listTaskQuestions 会按 answered 轮补建但 sealed_at=NULL，照样被 park
    //       源滤掉。此处按 reconcile 同形补建（唯一索引 origin+question+role 上
    //       onConflictDoNothing，常规路径已有行 ⇒ 零写）。
    //   (b) seal 行戳归一化（镜像 RFC-134 §3.1）：legacy answered 轮懒建行无逐行 sealed_at，
    //       而 self/questioner park 源 (fetchSelfQuestionerParkEntries) 以 `sealed_at IS NOT
    //       NULL` 过滤——designer 行（原 park 锚点）删除后，未补戳的 questioner 行会被滤掉
    //       → 调度不再驻留、该题续跑永不 mint（投递丢失）。继承被删行的戳，无则取 now；
    //       sealed_by 保持 NULL（「answered 轮证据落戳」审计语义，非人工 seal）；已有戳不改写。
    const now = Date.now()
    const survivorSealedAt = entry.sealedAt ?? now
    tx.insert(taskQuestions)
      .values({
        id: ulid(),
        taskId: entry.taskId,
        originNodeRunId: entry.originNodeRunId,
        questionId: entry.questionId,
        questionTitle: entry.questionTitle,
        sourceKind: 'cross',
        roleKind: 'questioner',
        iteration: entry.iteration,
        loopIter: entry.loopIter,
        defaultTargetNodeId: round.askingNodeId,
        sealedAt: survivorSealedAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
      })
      .run()
    tx.update(taskQuestions)
      .set({ sealedAt: survivorSealedAt, updatedAt: now })
      .where(
        and(
          eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
          eq(taskQuestions.questionId, entry.questionId),
          eq(taskQuestions.roleKind, 'questioner'),
          isNull(taskQuestions.sealedAt),
        ),
      )
      .run()
    // RFC-140 遗留修复 — 未下发幸存行的旧 override 归一化（CAS 在 dispatched_at 同列，与
    // dispatch 竞争时输者零写；已下发同目标的分支在上方判定为零改动，不会到达这里的写）。
    if (
      existingQuestioner !== undefined &&
      existingQuestioner.dispatchedAt === null &&
      existingQuestioner.overrideTargetNodeId !== null
    ) {
      tx.update(taskQuestions)
        .set({
          overrideTargetNodeId: null,
          lastReassignedBy: actor.userId,
          lastReassignedAt: now,
          updatedAt: now,
        })
        .where(and(eq(taskQuestions.id, existingQuestioner.id), isNull(taskQuestions.dispatchedAt)))
        .run()
    }
    collapsed = true
  })
  if (dispatchedElsewhere !== null) {
    throw new ConflictError(
      'task-question-already-dispatched',
      `cannot collapse: this question's questioner entry is already dispatched to '${dispatchedElsewhere}' — retargeting committed work is reopen's job`,
    )
  }
  if (!collapsed) {
    throw new ConflictError(
      'task-question-already-dispatched',
      `cannot reassign a dispatched question (dispatched_at is set) — use reopen to re-target after dispatch`,
    )
  }
  log.info('designer entry collapsed to questioner scope', {
    taskId: entry.taskId,
    entryId: entry.id,
    originNodeRunId: entry.originNodeRunId,
    questionId: entry.questionId,
    askingNodeId: round.askingNodeId,
    actorUserId: actor.userId,
  })
  return 'collapsed-to-questioner'
}

/** RFC-140 W1 — the MIRROR collapse tx (see collapseDesignerEntryToQuestioner above for the
 *  shared discipline: dispatched_at CAS, tx-inner scope re-read + merge, lockstep dual-write).
 *  Differences forced by the direction:
 *   - The SURVIVOR is the designer row (may not exist — a question whose scope was 'questioner'
 *     never reconciled one) → insert-if-missing + seal normalization + staged_at inheritance
 *     (the user's staging intent transfers with the question).
 *   - Survivor three-branch (Codex design-gate P2, two rounds): an EXISTING designer row that is
 *     already DISPATCHED is committed work — if its effective target IS the designer, collapse
 *     proceeds with the survivor untouched (RFC-138 D6 mirror: the revision is already on the
 *     right track, zero new mint); if it points at a THIRD node, the user's "give it to the
 *     designer" intent cannot be met without retargeting committed work → 409 (reopen's job).
 *     An existing UNDISPATCHED survivor with a stale third-node override is normalized back to
 *     the designer (override cleared + reassign audit stamp).
 *   - ECHO materialization (the RFC-134 invariant, the key asymmetry vs RFC-138): the survivor
 *     does NOT point at the asking node, so the asking node would lose this question's Q&A
 *     delivery entirely — insert an 'echo' receipt row (dispatched immediately, zero-mint,
 *     idempotent on the (origin, question, role) unique key). Rendering reads the round's
 *     answers_json at inject time, so a pre-answer collapse is safe (the asking node gets no
 *     new rerun before the answers dispatch anyway). */
function collapseQuestionerEntryToDesigner(
  db: DbClient,
  entry: TaskQuestionRow,
  round: ClarifyRoundRow,
  actor: TaskQuestionActor,
): ReassignTaskQuestionAction {
  const designerNodeId = round.targetConsumerNodeId
  if (designerNodeId === null) return 'override' // caller guards; defensive
  let collapsed = false
  let dispatchedElsewhere: string | null = null
  dbTxSync(db, (tx) => {
    // Re-read the entry INSIDE the tx (Codex impl-gate round-2 P2): a sealRoundQuestions commit
    // between the caller's loadEntry and this tx stamps the questioner row's sealed_at — deciding
    // the survivor/echo seal from the STALE pre-tx snapshot would delete that freshly-sealed row
    // and leave the new rows unsealed forever (no later seal call comes; selectAgentQueue filters
    // unsealed rows → the echo receipt would never inject). The tx read sees every committed seal.
    const curEntry = tx
      .select({ id: taskQuestions.id, sealedAt: taskQuestions.sealedAt })
      .from(taskQuestions)
      .where(and(eq(taskQuestions.id, entry.id), isNull(taskQuestions.dispatchedAt)))
      .all()[0]
    if (curEntry === undefined) return // dispatched concurrently (or already) → no write
    // Survivor three-branch: read the question's existing designer row FIRST — a dispatched
    // survivor pointing away from the designer aborts the whole collapse (no partial write).
    const existingDesigner = tx
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
    if (existingDesigner !== undefined && existingDesigner.dispatchedAt !== null) {
      const effective =
        existingDesigner.overrideTargetNodeId ?? existingDesigner.defaultTargetNodeId
      if (effective !== designerNodeId) {
        dispatchedElsewhere = effective
        return // dispatched to a third node — committed work, cannot retarget here
      }
      // dispatched AND already on the designer → collapse proceeds, survivor untouched (D6 mirror).
    }
    const cur = tx
      .select({
        questionScopesJson: clarifyRounds.questionScopesJson,
        status: clarifyRounds.status,
      })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, round.id))
      .all()[0]
    const merged = { ...parseScopes(cur?.questionScopesJson ?? null) }
    merged[entry.questionId] = 'designer'
    const scopesJson = JSON.stringify(merged)
    tx.update(clarifyRounds)
      .set({ questionScopesJson: scopesJson })
      .where(eq(clarifyRounds.id, round.id))
      .run()
    // RFC-058 dual-write — the cross round's legacy session row shares the SAME id.
    tx.update(crossClarifySessions)
      .set({ questionScopesJson: scopesJson })
      .where(eq(crossClarifySessions.id, round.id))
      .run()
    tx.delete(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
          eq(taskQuestions.questionId, entry.questionId),
          eq(taskQuestions.roleKind, 'questioner'),
          isNull(taskQuestions.dispatchedAt),
        ),
      )
      .run()
    const now = Date.now()
    // Seal inheritance MUST NOT fabricate answer evidence (Codex impl-gate P1): a questioner row
    // exists BEFORE its answer is submitted (unlike RFC-138's designer rows, which reconcile only
    // post-seal), so an unconditional `?? now` would stamp an UNANSWERED question as sealed — the
    // stage gate / dispatch would then inject an entry with no answers_json content, and the real
    // answer's seal would hit the already-sealed path. Only an ANSWERED round justifies the
    // RFC-138-style backfill (the answer provably exists); otherwise inherit verbatim (possibly
    // NULL — the real seal later stamps ALL of the question's rows: sealRoundQuestions step (4)
    // keys (origin, questionId) + IS NULL with NO role filter, so the survivor + echo get their
    // stamps then).
    const survivorSealedAt =
      cur?.status === 'answered' ? (curEntry.sealedAt ?? now) : curEntry.sealedAt
    if (existingDesigner === undefined) {
      // insert-if-missing (scope was 'questioner' → reconcile never built a designer row);
      // staged_at inherited so the user's staging intent survives the flip.
      tx.insert(taskQuestions)
        .values({
          id: ulid(),
          taskId: entry.taskId,
          originNodeRunId: entry.originNodeRunId,
          questionId: entry.questionId,
          questionTitle: entry.questionTitle,
          sourceKind: 'cross',
          roleKind: 'designer',
          iteration: entry.iteration,
          loopIter: entry.loopIter,
          defaultTargetNodeId: designerNodeId,
          sealedAt: survivorSealedAt,
          stagedAt: entry.stagedAt,
          stagedBy: entry.stagedBy,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
        })
        .run()
    } else if (existingDesigner.dispatchedAt === null) {
      // Normalize the undispatched survivor: clear a stale third-node override (Codex P2) +
      // reassign audit stamp; inherit seal / staged only where the survivor lacks them.
      tx.update(taskQuestions)
        .set({
          ...(existingDesigner.overrideTargetNodeId !== null
            ? {
                overrideTargetNodeId: null,
                lastReassignedBy: actor.userId,
                lastReassignedAt: now,
              }
            : {}),
          ...(existingDesigner.sealedAt === null && survivorSealedAt !== null
            ? { sealedAt: survivorSealedAt }
            : {}),
          ...(existingDesigner.stagedAt === null && entry.stagedAt !== null
            ? { stagedAt: entry.stagedAt, stagedBy: entry.stagedBy }
            : {}),
          updatedAt: now,
        })
        .where(eq(taskQuestions.id, existingDesigner.id))
        .run()
    }
    // Echo receipt for the asking node (RFC-134 shape, mirrored from the dispatch-tx echo
    // materialization: dispatched immediately, zero-mint, unique-key idempotent).
    tx.insert(taskQuestions)
      .values({
        id: ulid(),
        taskId: entry.taskId,
        originNodeRunId: entry.originNodeRunId,
        questionId: entry.questionId,
        questionTitle: entry.questionTitle,
        sourceKind: 'cross',
        roleKind: 'echo',
        iteration: entry.iteration,
        loopIter: entry.loopIter,
        defaultTargetNodeId: round.askingNodeId,
        overrideTargetNodeId: null,
        dispatchedAt: now,
        dispatchedBy: actor.userId,
        sealedAt: survivorSealedAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
      })
      .run()
    collapsed = true
  })
  if (dispatchedElsewhere !== null) {
    throw new ConflictError(
      'task-question-already-dispatched',
      `cannot collapse: this question's designer entry is already dispatched to '${dispatchedElsewhere}' — retargeting committed work is reopen's job`,
    )
  }
  if (!collapsed) {
    throw new ConflictError(
      'task-question-already-dispatched',
      `cannot reassign a dispatched question (dispatched_at is set) — use reopen to re-target after dispatch`,
    )
  }
  log.info('questioner entry collapsed to designer scope', {
    taskId: entry.taskId,
    entryId: entry.id,
    originNodeRunId: entry.originNodeRunId,
    questionId: entry.questionId,
    designerNodeId,
    askingNodeId: round.askingNodeId,
    actorUserId: actor.userId,
  })
  return 'collapsed-to-designer'
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
      // 条目已「提交执行」，stage 只会留下脏戳（生来已下发的 echo 回执同理）。守卫是**单条条件
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
 *  the in-tx CAS re-read). */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['done', 'canceled'])

/** Throw a ConflictError when the task is terminal (done/canceled). Used BEFORE any insert /
 *  dispatched_at stamp / node_run mint so nothing is left orphaned on a finished task. */
export function assertTaskAcceptsQuestions(taskId: string, status: string): void {
  if (TERMINAL_TASK_STATUSES.has(status)) {
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
    if (cur === undefined || TERMINAL_TASK_STATUSES.has(cur.status)) {
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
