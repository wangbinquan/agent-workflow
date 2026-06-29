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

import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
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

export interface TaskQuestionDTO {
  id: string
  taskId: string
  /** The clarify/cross-clarify round's node-run id (the `/clarify/$id` page). NULL for a
   *  manual question (RFC-120 §15) — it has no clarify round / answer page. */
  originNodeRunId: string | null
  questionId: string
  questionTitle: string
  sourceKind: 'self' | 'cross' | 'manual'
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
  reopenCount: number
  /** Brief of the human's answer for this question (null if unanswered). */
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

/** One clarify_round → upsert its desired handler entries (idempotent; preserves
 *  override / confirmation / staged / audit on existing rows). */
export function reconcileTaskQuestionsForRound(db: DbClient, round: ClarifyRoundRow): void {
  const desired = reconcileDesiredEntries({
    kind: round.kind,
    questions: parseQuestions(round.questionsJson),
    roundAnswered: round.status === 'answered',
    // RFC-120 T9 (Codex H2): a directive='stop' round intentionally skips the
    // designer rerun → no designer entry (else a deferred task parks forever on it).
    directive: round.directive,
    scopes: parseScopes(round.questionScopesJson),
    graph: graphForRound(round),
  })
  if (desired.length === 0) return
  const now = Date.now()
  dbTxSync(db, (tx) => {
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
  })
}

/** The entry's authoritative handler run id = the RFC-070 consumption stamp (set
 *  when the handler finished done+output, Codex F4). NULL while in flight / never
 *  dispatched. We do NOT guess a run from cause+node+iteration (Codex impl gate F1)
 *  — an in-flight answered round surfaces as `dispatchedInFlight` instead. */
function resolveTriggerForEntry(
  round: ClarifyRoundRow,
  roleKind: TaskQuestionRow['roleKind'],
): string | null {
  if (round.status !== 'answered') return null // not dispatched
  return roleKind === 'questioner' ? round.consumedByQuestionerRunId : round.consumedByConsumerRunId
}

/** Resolve one entry's phase inputs from the round + the task's runs. The handler
 *  run is looked up by the stamp id DIRECTLY (authoritative, includes fanout child
 *  rows — Codex impl gate F2); an answered round without a stamp is in-flight.
 *
 *  RFC-120 §18 (model A, corrected): for a DEFERRED task, a designer entry's OWN
 *  `dispatched_at` is the dispatch signal — NULL means NOT yet dispatched (the task
 *  is parked awaiting_human), so the row reads pending/staged, NOT processing. Once
 *  dispatched (`dispatched_at` set) but not yet bound to a run (`trigger_run_id`
 *  NULL), the handler is queued/rerunning → processing (dispatchedInFlight). Once
 *  bound (`trigger_run_id` set at the node's RERUN), resolve that run's lineage
 *  (processing → awaiting_confirm). For NON-deferred tasks (and questioner/self
 *  entries), the immediate flow never touches `dispatched_at`/`trigger_run_id`, so
 *  the consumption-stamp logic stays byte-for-byte (golden-lock). */
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

function resolveEntryHandler(
  round: ClarifyRoundRow,
  entry: TaskQuestionRow,
  runs: NodeRunRow[],
  outputRunIds: Set<string>,
  deferred: boolean,
): { handlerRun: HandlerRunView | null; dispatchedInFlight: boolean } {
  if (deferred && entry.roleKind === 'designer') {
    return resolveDispatchedEntryHandler(entry, runs, outputRunIds)
  }
  const triggerRunId = resolveTriggerForEntry(round, entry.roleKind)
  const row = triggerRunId ? runs.find((r) => r.id === triggerRunId) : undefined
  if (!row) return { handlerRun: null, dispatchedInFlight: round.status === 'answered' }
  return {
    handlerRun: {
      status: row.status,
      startedAt: row.startedAt,
      hasOutput: outputRunIds.has(row.id),
    },
    dispatchedInFlight: false,
  }
}

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

  // RFC-120 T9 (Codex H2): the task's deferred flag picks the phase signal — the
  // entry's own trigger_run_id (deferred) vs the round consumption stamp (legacy).
  const taskRow = (
    await db
      .select({ deferred: tasks.deferredQuestionDispatch })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  const deferred = taskRow?.deferred === true

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
    const { handlerRun, dispatchedInFlight } = resolveEntryHandler(
      round,
      e,
      runs,
      outputRunIds,
      deferred,
    )
    const phase = deriveQuestionPhase({
      roundStatus: round.status,
      confirmation: e.confirmation,
      isStaged: e.stagedAt !== null,
      dispatchedInFlight,
      handlerRun,
    })
    if (opts.sourceNodeId && round.askingNodeId !== opts.sourceNodeId) continue
    if (opts.phase && phase !== opts.phase) continue
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
      reopenCount: e.reopenCount,
      answerSummary: summarizeAnswer(round, e.questionId),
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

/** Short human-readable summary of the answer to one question (labels + custom). */
function summarizeAnswer(round: ClarifyRoundRow, questionId: string): string | null {
  if (round.status !== 'answered') return null
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
// SELF-GATED on tasks.deferred_question_dispatch: a non-deferred task always
// resolves to the empty set (its designer rerun already fired immediately at
// submit, so a lazily-reconciled entry with NULL trigger_run_id must NOT be
// mistaken for "undispatched"). Every gate consumer therefore sees byte-for-byte
// today's behavior for non-deferred tasks — the golden-lock boundary.
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
  const taskRow = (
    await db
      .select({ deferred: tasks.deferredQuestionDispatch })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (taskRow?.deferred !== true) return new Set()
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
  const entries = [...clarifyDesigner, ...manualDesigner]
  if (entries.length === 0) return new Set()
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
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
    // Dispatched → in-flight UNTIL consumed (handler run done+output, via lineage).
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
    const consumed = hr !== null && hr.status === 'done' && hr.hasOutput
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
  // RFC-120 T9 (Codex H2): deferred tasks read the dispatch signal off the entry's
  // own trigger_run_id (see resolveEntryHandler); non-deferred stays byte-for-byte.
  const taskRow = (
    await db
      .select({ deferred: tasks.deferredQuestionDispatch })
      .from(tasks)
      .where(eq(tasks.id, entry.taskId))
      .limit(1)
  )[0]
  const { handlerRun, dispatchedInFlight } = resolveEntryHandler(
    round,
    entry,
    runs,
    outputRunIds,
    taskRow?.deferred === true,
  )
  return deriveQuestionPhase({
    roundStatus: round.status,
    confirmation: entry.confirmation,
    isStaged: entry.stagedAt !== null,
    dispatchedInFlight,
    handlerRun,
  })
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

/** Re-target (改派) a designer entry's handler to a workflow agent node (Codex F5). */
export async function reassignTaskQuestion(
  db: DbClient,
  entryId: string,
  targetNodeId: string,
  actor: TaskQuestionActor,
): Promise<void> {
  const entry = await loadEntry(db, entryId)
  const agentNodeIds = await agentNodeIdsForTask(db, entry.taskId)
  if (!canReassign({ roleKind: entry.roleKind }, targetNodeId, agentNodeIds)) {
    throw new ValidationError(
      'task-question-reassign-invalid',
      `cannot reassign '${entry.roleKind}' entry to '${targetNodeId}' (designer-only + must be an agent node)`,
    )
  }
  // Codex impl gate F3: don't re-target a terminal entry — the work is closed and
  // an override there only records moot intent / risks confusing the resolution.
  const phase = await deriveEntryPhase(db, entry)
  if (phase === 'done' || phase === 'closed') {
    throw new ConflictError('task-question-terminal', `cannot reassign a '${phase}' question`)
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
}

/** Stage / unstage (拖入·拖出「待下发」). Approves an entry for batch dispatch. */
export async function stageTaskQuestion(
  db: DbClient,
  entryId: string,
  staged: boolean,
  actor: TaskQuestionActor,
): Promise<void> {
  await loadEntry(db, entryId)
  await db
    .update(taskQuestions)
    .set(
      staged
        ? { stagedAt: Date.now(), stagedBy: actor.userId, updatedAt: Date.now() }
        : { stagedAt: null, stagedBy: null, updatedAt: Date.now() },
    )
    .where(eq(taskQuestions.id, entryId))
}

/** Max lengths for a manual question (title mirrors ClarifyQuestion.title ≤ 512). */
const MANUAL_TITLE_MAX = 512
const MANUAL_BODY_MAX = 20000

/** RFC-120 §15 (Codex re-gate) — task statuses that will NEVER re-enter scheduling, so a
 *  manual question created / dispatched on them would strand (no scheduler to run the rerun).
 *  `failed`/`interrupted`/`awaiting_*` are resumable/active (resumeTask resumes them), so they
 *  are NOT terminal here. Shared by createManualTaskQuestion + dispatchTaskQuestions. */
const TERMINAL_TASK_STATUSES = new Set(['done', 'canceled'])

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
  // RFC-120 §15 — load the gating facts together: deferred flag (H2) + task status (re-gate).
  const taskRow = (
    await db
      .select({ deferred: tasks.deferredQuestionDispatch, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  // (Codex impl-gate H2): a manual question can ONLY ever be dispatched + injected on a
  // deferred-dispatch task (dispatchTaskQuestions + buildNodeQueueExternalFeedback are
  // deferred-gated). Creating one on a non-deferred task would be undispatchable orphan data.
  if (taskRow?.deferred !== true) {
    throw new ConflictError(
      'task-not-deferred-dispatch',
      `task ${taskId} is not a deferred-dispatch task; manual questions cannot be created (they could never be dispatched / injected)`,
    )
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
  const id = ulid()
  const now = Date.now()
  await db.insert(taskQuestions).values({
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
    // §15: a handler is required → the row is created staged (待下发) so the park gate holds
    // the task awaiting_human until the human dispatches it.
    stagedAt: now,
    stagedBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  })
  return { id }
}
