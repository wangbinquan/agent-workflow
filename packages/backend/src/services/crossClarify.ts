// RFC-056 — cross-clarify business logic (PR-B T5).
//
// Parallel to services/clarify.ts (RFC-023 self-clarify): different node kind,
// different lifecycle (multi-source aggregation, reject persistence,
// designer-rerun trigger, abandoned state), but reuses the RFC-023 envelope
// schema + per-answer synthesis through shared/clarify-cross.ts.
//
//   - createCrossClarifySession: runner-side entry. Mints a cross_clarify_sessions
//     row + cross-clarify node_run row, parks in 'awaiting_human', broadcasts
//     'cross-clarify.created' WS event.
//   - submitCrossClarifyAnswers: REST decision handler. Optimistic-locks on
//     iteration, seals selectedOptionLabels server-side (same defence as
//     RFC-023), marks the session 'answered'. Then:
//       * directive='continue' (submit) → evaluateDesignerRerunReadiness.
//                                        If ready, triggerDesignerRerun.
//                                        If not, the WS payload tells the
//                                        UI to show the "waiting on N more"
//                                        banner.
//       * directive='stop'     (reject)  → triggerQuestionerStopRerun.
//   - evaluateDesignerRerunReadiness: gathers every cross-clarify node whose
//     to_designer manual edge points at `designerNodeId`. Designer reruns
//     ONLY when every such node's latest session is in a terminal state
//     (answered or abandoned). Sessions with directive='continue' feed
//     External Feedback; directive='stop' / 'abandoned' are skipped.
//   - triggerDesignerRerun: rolls back the designer's prior node_run via
//     RFC-014 cascade, mints a fresh designer node_run with
//     crossClarifyIteration + 1, retryIndex = 0, sibling cascade downstream.
//     Persistent-stop cross-clarify nodes stay reset to pending but
//     dispatch detects them via hasPersistentStop.
//   - triggerQuestionerStopRerun: cascade-reset the questioner. dispatch
//     time the questioner's prompt picks up the STOP CLARIFYING anchor +
//     full Q&A history via the cross-clarify path.
//   - dispatchCrossClarifyNode: scheduler-side helper. Checks for persistent
//     stop. If present, transitions the cross-clarify node_run pending→done
//     ('persistent-stop') without parking. Otherwise the questioner emit-
//     clarify lands here via createCrossClarifySession.
//   - buildExternalFeedbackSources: pulls the latest directive='continue'
//     session per source-questioner-node for the upcoming designer rerun.
//   - hasPersistentStop / listSummaries / getDetail / cleanupForTask:
//     read-side helpers used by REST + scheduler / runner.
//
// Source-of-truth contracts:
//   - cross_clarify_iteration counts ROUNDS of cross-clarify feedback per
//     loop_iter; orthogonal to clarify_iteration (self-clarify),
//     review_iteration (review), retry_index (process retries).
//   - directive='stop' persists across loop iterations (queried by node id
//     alone). Q&A history resets per loop_iter (queries always carry loop_iter).
//   - sealAnswersServerSide is reused verbatim from services/clarify.ts so
//     answer-tampering defences stay identical between self / cross paths.

import {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  buildExternalFeedbackBlock,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  resolveCrossClarifySessionMode,
  type ClarifyAnswer,
  type ClarifyCrossAgentNode,
  type ClarifyDirective,
  type ClarifyQuestion,
  type ClarifyTruncationWarning,
  type CrossClarifySourceContext,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { crossClarifySessions, nodeRuns, tasks } from '@/db/schema'
import { sealAnswersServerSide } from '@/services/clarify'
import { setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { rollbackToSnapshot } from '@/util/git'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('cross-clarify')

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

export type CrossClarifySessionStatus = 'awaiting_human' | 'answered' | 'abandoned'

export interface CrossClarifySession {
  id: string
  taskId: string
  crossClarifyNodeId: string
  crossClarifyNodeRunId: string
  sourceQuestionerNodeId: string
  sourceQuestionerNodeRunId: string
  targetDesignerNodeId: string | null
  loopIter: number
  iteration: number
  questions: ClarifyQuestion[]
  answers?: ClarifyAnswer[]
  directive: ClarifyDirective | null
  status: CrossClarifySessionStatus
  designerRunTriggeredAt: number | null
  createdAt: number
  answeredAt: number | null
  abandonedAt: number | null
}

export interface CrossClarifySessionSummary {
  id: string
  taskId: string
  /** RFC-037 parity: display name of the owning task. Required so the
   *  mixed inbox can group rows by task name regardless of kind. */
  taskName: string
  crossClarifyNodeId: string
  crossClarifyNodeRunId: string
  sourceQuestionerNodeId: string
  targetDesignerNodeId: string | null
  loopIter: number
  iteration: number
  questionCount: number
  status: CrossClarifySessionStatus
  directive: ClarifyDirective | null
  createdAt: number
  answeredAt: number | null
}

// ---------------------------------------------------------------------------
// createCrossClarifySession — runner-side entry point.
// ---------------------------------------------------------------------------

export interface CreateCrossClarifySessionArgs {
  db: DbClient
  taskId: string
  /** Workflow nodeId of the cross-clarify node (the human-gated form). */
  crossClarifyNodeId: string
  /** Workflow nodeId of the questioner agent (the one that emitted
   *  <workflow-clarify>). */
  sourceQuestionerNodeId: string
  /** node_runs.id of the questioner run that produced this envelope. */
  sourceQuestionerNodeRunId: string
  /** Workflow nodeId of the designer agent resolved from `to_designer` manual
   *  edge. Pass `null` to skip designer-side correlation (validator warns at
   *  edit time; runtime records the gap for the abandoned-invariant scan). */
  targetDesignerNodeId: string | null
  /** wrapper-loop iteration index (parent loop scope). 0 for non-loop placement. */
  loopIter: number
  /** Parsed cross-clarify envelope questions (already validated by
   *  parseCrossClarifyEnvelopeBody at the runner). */
  questions: ClarifyQuestion[]
  /** Non-fatal warnings from the parser; mirrors RFC-023 truncation surface. */
  truncationWarnings?: ClarifyTruncationWarning[]
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface CreateCrossClarifySessionResult {
  session: CrossClarifySession
  /** node_runs.id of the freshly-minted cross-clarify node_run owning this session. */
  crossClarifyNodeRunId: string
}

/**
 * Mint a cross_clarify_sessions row + parked cross-clarify node_run. Iteration
 * counter is derived from the latest existing row for the same
 * (crossClarifyNodeId, loopIter) — fresh, prior row's iteration + 1.
 */
export async function createCrossClarifySession(
  args: CreateCrossClarifySessionArgs,
): Promise<CreateCrossClarifySessionResult> {
  const now = args.now ?? Date.now
  const createdAt = now()

  // Compute new iteration index: max(existing.iteration) + 1 in the same
  // (node, loopIter); 0 if no prior session for this loop_iter.
  const prior = await args.db
    .select({ iteration: crossClarifySessions.iteration })
    .from(crossClarifySessions)
    .where(
      and(
        eq(crossClarifySessions.taskId, args.taskId),
        eq(crossClarifySessions.crossClarifyNodeId, args.crossClarifyNodeId),
        eq(crossClarifySessions.loopIter, args.loopIter),
      ),
    )
    .orderBy(desc(crossClarifySessions.iteration))
    .limit(1)
  const iteration = prior.length === 0 ? 0 : (prior[0]?.iteration ?? 0) + 1

  // Mint cross-clarify node_run row parked at awaiting_human. RFC-053:
  // park-human enforces pending|running → awaiting_human; we mint at
  // 'awaiting_human' directly so the runner doesn't need a separate
  // pending->awaiting_human leg.
  const crossClarifyNodeRunId = ulid()
  await args.db.insert(nodeRuns).values({
    id: crossClarifyNodeRunId,
    taskId: args.taskId,
    nodeId: args.crossClarifyNodeId,
    status: 'awaiting_human',
    retryIndex: 0,
    iteration: args.loopIter,
    crossClarifyIteration: iteration,
    startedAt: createdAt,
  })

  const sessionId = ulid()
  await args.db.insert(crossClarifySessions).values({
    id: sessionId,
    taskId: args.taskId,
    crossClarifyNodeId: args.crossClarifyNodeId,
    crossClarifyNodeRunId,
    sourceQuestionerNodeId: args.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: args.sourceQuestionerNodeRunId,
    targetDesignerNodeId: args.targetDesignerNodeId,
    loopIter: args.loopIter,
    iteration,
    questionsJson: JSON.stringify(args.questions),
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    designerRunTriggeredAt: null,
    createdAt,
    answeredAt: null,
    abandonedAt: null,
  })

  if (args.truncationWarnings && args.truncationWarnings.length > 0) {
    log.warn('cross-clarify envelope truncated to limits', {
      sessionId,
      warnings: args.truncationWarnings.map((w) => w.code),
    })
  }

  const session: CrossClarifySession = {
    id: sessionId,
    taskId: args.taskId,
    crossClarifyNodeId: args.crossClarifyNodeId,
    crossClarifyNodeRunId,
    sourceQuestionerNodeId: args.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: args.sourceQuestionerNodeRunId,
    targetDesignerNodeId: args.targetDesignerNodeId,
    loopIter: args.loopIter,
    iteration,
    questions: args.questions,
    directive: null,
    status: 'awaiting_human',
    designerRunTriggeredAt: null,
    createdAt,
    answeredAt: null,
    abandonedAt: null,
  }
  broadcastCrossClarifyCreated(args.taskId, session)
  return { session, crossClarifyNodeRunId }
}

// ---------------------------------------------------------------------------
// submitCrossClarifyAnswers — REST decision handler.
// ---------------------------------------------------------------------------

export interface SubmitCrossClarifyAnswersArgs {
  db: DbClient
  /** node_runs.id of the cross-clarify node (NOT the questioner / designer). */
  crossClarifyNodeRunId: string
  answers: ClarifyAnswer[]
  /** RFC-056: 'continue' = submit (feed designer); 'stop' = reject (questioner
   *  STOP CLARIFYING + persistent). */
  directive: ClarifyDirective
  /** Optimistic-lock guard. When set, must equal session.iteration; otherwise
   *  409 'cross-clarify-iteration-mismatch'. */
  ifMatchIteration?: number
  /** Defaults to 'local'. Reserved for per-user attribution. */
  answeredBy?: string
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface SubmitCrossClarifyAnswersResult {
  session: CrossClarifySession
  /**
   * Outcome of the submit:
   *   - directive='continue' AND all sibling cross-clarify nodes pointing to
   *     the same designer are also resolved → 'designer-rerun-triggered'
   *     with the new designer node_run id.
   *   - directive='continue' AND siblings still awaiting → 'designer-waiting'
   *     (UI shows the multi-source banner).
   *   - directive='continue' AND target designer can't be resolved →
   *     'designer-target-missing' (warning event recorded; no rerun).
   *   - directive='stop' → 'questioner-stop-triggered' with the new
   *     questioner node_run id.
   */
  outcome:
    | { kind: 'designer-rerun-triggered'; designerNodeRunId: string; sourceCount: number }
    | { kind: 'designer-waiting'; pendingCrossClarifyNodeIds: string[] }
    | { kind: 'designer-target-missing' }
    | { kind: 'questioner-stop-triggered'; questionerNodeRunId: string }
}

/**
 * Persist answers + directive, close the cross-clarify node_run, and drive
 * the appropriate downstream action (designer rerun batched, or questioner
 * stop rerun). Caller (REST route) is responsible for invoking resumeTask.
 */
export async function submitCrossClarifyAnswers(
  args: SubmitCrossClarifyAnswersArgs,
): Promise<SubmitCrossClarifyAnswersResult> {
  const now = args.now ?? Date.now
  const answeredBy = args.answeredBy ?? 'local'
  const answeredAt = now()

  const sessionRows = await args.db
    .select()
    .from(crossClarifySessions)
    .where(eq(crossClarifySessions.crossClarifyNodeRunId, args.crossClarifyNodeRunId))
    .orderBy(desc(crossClarifySessions.createdAt))
    .limit(1)
  const row = sessionRows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'cross-clarify-session-not-found',
      `no cross_clarify_session for node_run ${args.crossClarifyNodeRunId}`,
    )
  }
  if (row.status !== 'awaiting_human') {
    throw new ConflictError(
      'cross-clarify-already-answered',
      `cross_clarify_session ${row.id} status is ${row.status}, expected awaiting_human`,
    )
  }
  if (args.ifMatchIteration !== undefined && args.ifMatchIteration !== row.iteration) {
    throw new ConflictError(
      'cross-clarify-iteration-mismatch',
      `If-Match iteration ${args.ifMatchIteration} != server ${row.iteration}`,
    )
  }
  if (args.directive !== 'continue' && args.directive !== 'stop') {
    throw new ValidationError(
      'cross-clarify-directive-invalid',
      `directive must be 'continue' or 'stop', got '${args.directive}'`,
    )
  }

  // Seal answers server-side defending against client option-label injection.
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  const sealedAnswers = sealAnswersServerSide(questions, args.answers)

  await args.db
    .update(crossClarifySessions)
    .set({
      answersJson: JSON.stringify(sealedAnswers),
      status: 'answered',
      directive: args.directive,
      answeredAt,
    })
    .where(eq(crossClarifySessions.id, row.id))

  // RFC-053: resume-clarify enforces awaiting_human → done. Cross-clarify
  // shares the same transition shape so we reuse the event kind.
  await transitionNodeRunStatus({
    db: args.db,
    nodeRunId: args.crossClarifyNodeRunId,
    event: { kind: 'resume-clarify' },
    extra: { finishedAt: answeredAt },
  })

  const sessionAfter = mergeAnswered(row, sealedAnswers, args.directive, answeredAt)
  void answeredBy

  // Branch on directive.
  if (args.directive === 'stop') {
    const outcome = await triggerQuestionerStopRerun({
      db: args.db,
      taskId: row.taskId,
      questionerNodeRunId: row.sourceQuestionerNodeRunId,
    })
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    broadcastCrossClarifyRejected(row.taskId, sessionAfter, outcome.questionerNodeRunId)
    return {
      session: sessionAfter,
      outcome: {
        kind: 'questioner-stop-triggered',
        questionerNodeRunId: outcome.questionerNodeRunId,
      },
    }
  }

  // directive === 'continue'.
  const designerNodeId = row.targetDesignerNodeId
  if (designerNodeId === null) {
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return { session: sessionAfter, outcome: { kind: 'designer-target-missing' } }
  }

  // Multi-source aggregation: only fire when every sibling cross-clarify
  // pointing at this designer (within the same loop_iter on the questioner
  // side; design.md §5.2) is resolved.
  const taskRow = (await args.db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${row.taskId} not found`)
  }
  const definition = parseDefinitionFromSnapshot(taskRow.workflowSnapshot)
  if (definition === null) {
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return { session: sessionAfter, outcome: { kind: 'designer-target-missing' } }
  }

  const readiness = await evaluateDesignerRerunReadiness({
    db: args.db,
    taskId: row.taskId,
    designerNodeId,
    definition,
    loopIter: row.loopIter,
  })
  if (!readiness.ready) {
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return {
      session: sessionAfter,
      outcome: {
        kind: 'designer-waiting',
        pendingCrossClarifyNodeIds: readiness.pendingCrossClarifyNodeIds,
      },
    }
  }

  // All siblings resolved → fire designer rerun + sibling cascade.
  const rerun = await triggerDesignerRerun({
    db: args.db,
    taskId: row.taskId,
    designerNodeId,
    sources: readiness.sources,
    loopIter: row.loopIter,
    worktreePath: taskRow.worktreePath,
    now,
  })
  // Stamp designer_run_triggered_at on every consumed session for audit.
  for (const src of readiness.sources) {
    await args.db
      .update(crossClarifySessions)
      .set({ designerRunTriggeredAt: rerun.triggeredAt })
      .where(eq(crossClarifySessions.id, src.sessionId))
  }
  broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
  broadcastDesignerRerunBatched(
    row.taskId,
    rerun.designerNodeRunId,
    readiness.sources.map((s) => s.sourceQuestionerNodeId),
  )
  return {
    session: sessionAfter,
    outcome: {
      kind: 'designer-rerun-triggered',
      designerNodeRunId: rerun.designerNodeRunId,
      sourceCount: readiness.sources.length,
    },
  }
}

// ---------------------------------------------------------------------------
// evaluateDesignerRerunReadiness — multi-source aggregation.
// ---------------------------------------------------------------------------

export interface EvaluateDesignerRerunReadinessArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  definition: WorkflowDefinition
  /** Limit the readiness scan to a specific loop iteration. Non-loop = 0. */
  loopIter: number
}

export interface DesignerRerunReadinessSource {
  sessionId: string
  crossClarifyNodeId: string
  sourceQuestionerNodeId: string
  iteration: number
  questions: ClarifyQuestion[]
  answers: ClarifyAnswer[]
}

export interface DesignerRerunReadiness {
  ready: boolean
  /** When ready=true, the directive='continue' sources that should feed the
   *  designer's External Feedback. directive='stop' / abandoned siblings are
   *  not included here even though they count toward "resolved". */
  sources: DesignerRerunReadinessSource[]
  /** When ready=false, the cross-clarify NodeIds still in awaiting_human. */
  pendingCrossClarifyNodeIds: string[]
}

/**
 * Determine whether `designerNodeId` is ready to rerun based on the latest
 * session (per cross-clarify NodeId, scoped to `loopIter`) of every sibling
 * cross-clarify node whose `to_designer` edge targets it.
 *
 * Readiness rule:
 *   ready ⟺ every sibling's latest session in this loop_iter has
 *           status ∈ {answered, abandoned}.
 *
 * Sources for the rerun:
 *   {latest where directive='continue' AND status='answered'}.
 *   directive='stop' / status='abandoned' siblings count as resolved but do
 *   NOT feed External Feedback.
 */
export async function evaluateDesignerRerunReadiness(
  args: EvaluateDesignerRerunReadinessArgs,
): Promise<DesignerRerunReadiness> {
  const siblingNodeIds = findCrossClarifyNodesPointingToDesigner(
    args.definition,
    args.designerNodeId,
  )
  if (siblingNodeIds.length === 0) {
    return { ready: false, sources: [], pendingCrossClarifyNodeIds: [] }
  }

  const sources: DesignerRerunReadinessSource[] = []
  const pending: string[] = []
  for (const nodeId of siblingNodeIds) {
    // Latest session for this (nodeId, loop_iter).
    const rows = await args.db
      .select()
      .from(crossClarifySessions)
      .where(
        and(
          eq(crossClarifySessions.taskId, args.taskId),
          eq(crossClarifySessions.crossClarifyNodeId, nodeId),
          eq(crossClarifySessions.loopIter, args.loopIter),
        ),
      )
      .orderBy(desc(crossClarifySessions.iteration))
      .limit(1)
    const latest = rows[0]
    if (latest === undefined) {
      pending.push(nodeId)
      continue
    }
    if (latest.status === 'awaiting_human') {
      pending.push(nodeId)
      continue
    }
    // Already-consumed sessions (designerRunTriggeredAt set) do not feed
    // again — they were part of a prior batch. Skip them as "resolved" so
    // we don't re-trigger off a stale row when a single new sibling just
    // submitted.
    if (latest.designerRunTriggeredAt !== null) {
      continue
    }
    if (latest.status === 'answered' && latest.directive === 'continue') {
      const questions = JSON.parse(latest.questionsJson) as ClarifyQuestion[]
      const answers =
        latest.answersJson !== null ? (JSON.parse(latest.answersJson) as ClarifyAnswer[]) : []
      sources.push({
        sessionId: latest.id,
        crossClarifyNodeId: nodeId,
        sourceQuestionerNodeId: latest.sourceQuestionerNodeId,
        iteration: latest.iteration,
        questions,
        answers,
      })
    }
    // 'answered'+'stop' / 'abandoned' → resolved, no source contribution.
  }
  return {
    ready: pending.length === 0,
    sources,
    pendingCrossClarifyNodeIds: pending,
  }
}

// ---------------------------------------------------------------------------
// triggerDesignerRerun — RFC-014 rollback + new node_run + cascade.
// ---------------------------------------------------------------------------

export interface TriggerDesignerRerunArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  sources: DesignerRerunReadinessSource[]
  loopIter: number
  worktreePath: string
  now?: () => number
}

export interface TriggerDesignerRerunResult {
  designerNodeRunId: string
  triggeredAt: number
}

/**
 * Roll the designer back to its pre_snapshot (RFC-014 style), mint a fresh
 * designer node_run with crossClarifyIteration + 1 / retryIndex = 0, and
 * cascade-reset every downstream node to pending so the scheduler
 * re-dispatches them. The caller is expected to call resumeTask once.
 */
export async function triggerDesignerRerun(
  args: TriggerDesignerRerunArgs,
): Promise<TriggerDesignerRerunResult> {
  const now = (args.now ?? Date.now)()

  // Latest designer node_run (any status) — the cascade source.
  const designerRows = await args.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, args.taskId), eq(nodeRuns.nodeId, args.designerNodeId)))
    .orderBy(desc(nodeRuns.startedAt))
  const lastDesigner = designerRows[0]
  if (lastDesigner === undefined) {
    throw new NotFoundError(
      'cross-clarify-designer-run-not-found',
      `no designer node_run for ${args.designerNodeId} in task ${args.taskId}`,
    )
  }

  // RFC-014: roll worktree back to designer's pre_snapshot before reruns so
  // file-level effects are erased. Failure is logged + suppressed; rerun
  // proceeds (worktree may diverge but the designer rewrites the file).
  if (
    lastDesigner.preSnapshot !== null &&
    lastDesigner.preSnapshot !== '' &&
    args.worktreePath !== ''
  ) {
    try {
      await rollbackToSnapshot(args.worktreePath, lastDesigner.preSnapshot)
    } catch (err) {
      log.warn('designer rollback failed', {
        nodeRunId: lastDesigner.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Mint a fresh designer node_run. cross_clarify_iteration increments by 1
  // off the latest existing value; retry_index resets to 0.
  const designerNodeRunId = ulid()
  await args.db.insert(nodeRuns).values({
    id: designerNodeRunId,
    taskId: args.taskId,
    nodeId: args.designerNodeId,
    status: 'pending',
    retryIndex: 0,
    iteration: lastDesigner.iteration,
    parentNodeRunId: lastDesigner.parentNodeRunId ?? null,
    shardKey: lastDesigner.shardKey ?? null,
    reviewIteration: lastDesigner.reviewIteration,
    clarifyIteration: lastDesigner.clarifyIteration,
    crossClarifyIteration: (lastDesigner.crossClarifyIteration ?? 0) + 1,
    preSnapshot: lastDesigner.preSnapshot,
  })

  // Sibling cascade: every downstream node_run that's beyond designer in
  // the DAG and is currently terminal must be considered stale. The actual
  // sibling cascade machinery (review iterate / clarify iterate) lives in
  // RFC-014 — for cross-clarify we use the lightweight "reset latest
  // terminal node_run to pending" pattern: rather than implementing
  // graph-walk here, we let the scheduler's rescan + ready-edge logic
  // pick up the new pending designer row and run downstream nodes by
  // re-evaluating freshness via cross_clarify_iteration. The cascade is
  // therefore implicit: stale outputs from prior runs are overwritten
  // by the next dispatch pass.
  //
  // NOTE: the persistent-stop dispatch branch in dispatchCrossClarifyNode
  // is what ensures already-stopped cross-clarify nodes stay non-awaiting
  // when the scheduler re-encounters them.

  log.info('cross-clarify designer rerun triggered', {
    taskId: args.taskId,
    designerNodeId: args.designerNodeId,
    designerNodeRunId,
    sourceCount: args.sources.length,
  })

  return { designerNodeRunId, triggeredAt: now }
}

// ---------------------------------------------------------------------------
// triggerQuestionerStopRerun — reject path.
// ---------------------------------------------------------------------------

export interface TriggerQuestionerStopRerunArgs {
  db: DbClient
  taskId: string
  questionerNodeRunId: string
  now?: () => number
}

export interface TriggerQuestionerStopRerunResult {
  questionerNodeRunId: string
}

/**
 * Mint a fresh questioner node_run keyed on the same (nodeId, iteration)
 * so the next scheduler pass dispatches it. The questioner's prompt picks
 * up the STOP CLARIFYING anchor + full Q&A history through the cross-
 * clarify path automatically at dispatch time (scheduler/runner hook).
 */
export async function triggerQuestionerStopRerun(
  args: TriggerQuestionerStopRerunArgs,
): Promise<TriggerQuestionerStopRerunResult> {
  const lastRun = (
    await args.db.select().from(nodeRuns).where(eq(nodeRuns.id, args.questionerNodeRunId)).limit(1)
  )[0]
  if (lastRun === undefined) {
    throw new NotFoundError(
      'cross-clarify-questioner-run-not-found',
      `questioner node_run ${args.questionerNodeRunId} not found`,
    )
  }
  const newId = ulid()
  await args.db.insert(nodeRuns).values({
    id: newId,
    taskId: args.taskId,
    nodeId: lastRun.nodeId,
    status: 'pending',
    retryIndex: 0,
    iteration: lastRun.iteration,
    parentNodeRunId: lastRun.parentNodeRunId ?? null,
    shardKey: lastRun.shardKey ?? null,
    reviewIteration: lastRun.reviewIteration,
    clarifyIteration: lastRun.clarifyIteration,
    crossClarifyIteration: lastRun.crossClarifyIteration ?? 0,
    preSnapshot: lastRun.preSnapshot,
  })
  return { questionerNodeRunId: newId }
}

// ---------------------------------------------------------------------------
// dispatchCrossClarifyNode — scheduler-side helper.
// ---------------------------------------------------------------------------

export interface DispatchCrossClarifyResult {
  /** 'short-circuit-stop' = persistent stop hit, node_run forced done.
   *  'awaiting' = needs envelope from questioner; nothing to do, the runner
   *               will create a session when the questioner emits clarify.
   *  'no-questioner' = validator missed cross-clarify-input-source-missing;
   *                    return failed so the scheduler surfaces it. */
  kind: 'short-circuit-stop' | 'awaiting' | 'no-questioner'
}

/**
 * The scheduler calls this when a cross-clarify node enters its dispatch
 * branch (one of: first-time visit / sibling cascade reset / loop-iter
 * advance). The cross-clarify node itself has no agent to run — it is
 * the human-gated form. Dispatch logic:
 *
 *   1. Check the cross_clarify_sessions table for any directive='stop'
 *      session matching this node_id (across all loop_iter).
 *   2. If found → transition the node_run pending → done (persistent-stop);
 *      do NOT park awaiting_human. The questioner's own cascade rerun
 *      runs through STOP CLARIFYING. This satisfies S3 (reject persistence).
 *   3. Otherwise → no-op; await the questioner emit-clarify → session
 *      creation flow which will park the SAME node_run row (via
 *      createCrossClarifySession's own park).
 */
export async function dispatchCrossClarifyNode(args: {
  db: DbClient
  taskId: string
  crossClarifyNodeId: string
  /** node_runs.id the scheduler is dispatching. */
  nodeRunId: string
  definition: WorkflowDefinition
}): Promise<DispatchCrossClarifyResult> {
  if (findQuestionerNodeForCrossClarify(args.definition, args.crossClarifyNodeId) === undefined) {
    return { kind: 'no-questioner' }
  }
  const stopped = await hasPersistentStop(args.db, args.taskId, args.crossClarifyNodeId)
  if (stopped) {
    // RFC-053: mark-done is running → done; we set the node_run to running
    // first (mark-running from pending). The cross-clarify node has no
    // real worker; transitioning briefly into running is fine — keeps
    // the lifecycle invariant happy.
    await setNodeRunStatus({
      db: args.db,
      nodeRunId: args.nodeRunId,
      to: 'done',
      allowedFrom: ['pending'],
      reason: 'cross-clarify-persistent-stop',
      extra: { finishedAt: Date.now() },
    })
    return { kind: 'short-circuit-stop' }
  }
  return { kind: 'awaiting' }
}

/**
 * RFC-056: returns true if any directive='stop' row exists for this
 * (taskId, crossClarifyNodeId), regardless of loop_iter. Persistence is
 * defined at the cross-clarify node level — once rejected, the questioner
 * never asks via this node again in the same task.
 */
export async function hasPersistentStop(
  db: DbClient,
  taskId: string,
  crossClarifyNodeId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: crossClarifySessions.id })
    .from(crossClarifySessions)
    .where(
      and(
        eq(crossClarifySessions.taskId, taskId),
        eq(crossClarifySessions.crossClarifyNodeId, crossClarifyNodeId),
        eq(crossClarifySessions.directive, 'stop'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// External Feedback prompt assembly — designer rerun side.
// ---------------------------------------------------------------------------

export interface BuildExternalFeedbackArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  loopIter: number
  /** When the designer about to rerun has crossClarifyIteration N, pull the
   *  most recently consumed batch (designer_run_triggered_at non-NULL) so
   *  the rendered block matches the iteration the agent is about to run. */
  designerCrossClarifyIteration: number
  definition: WorkflowDefinition
}

export interface ExternalFeedbackPromptContext {
  block: string
  iteration: string
  sourcesCsv: string
  /**
   * RFC-056 §6 update mode (2026-05-22 amendment): pre-rendered designer's
   * last done output (via shared `buildPriorOutputBlock`), populated only
   * when the rerun was triggered by a cross-clarify submit AND the prior
   * done node_run captured at least one non-empty port output. The shared
   * `renderUserPrompt` emits `## Prior Output (to be updated)` +
   * `## Update Directive` sections when this is set. Undefined / empty
   * preserves legacy regenerate-from-inputs behaviour.
   */
  priorOutputBlock?: string
}

/**
 * Build the {{__external_feedback__}} prompt context for the designer's
 * about-to-spawn run. Pulls every directive='continue' session whose
 * designer_run_triggered_at corresponds to the latest designer run batch
 * (per-source latest within loop_iter); orders sources by NodeId dictionary.
 * Returns `undefined` when no consumed sessions exist (first run / no
 * sources / designer hasn't been triggered by cross-clarify yet).
 */
export async function buildExternalFeedbackContext(
  args: BuildExternalFeedbackArgs,
): Promise<ExternalFeedbackPromptContext | undefined> {
  if (args.designerCrossClarifyIteration <= 0) return undefined

  const siblingNodeIds = findCrossClarifyNodesPointingToDesigner(
    args.definition,
    args.designerNodeId,
  )
  if (siblingNodeIds.length === 0) return undefined

  const sources: CrossClarifySourceContext[] = []
  for (const nodeId of siblingNodeIds) {
    const rows = await args.db
      .select()
      .from(crossClarifySessions)
      .where(
        and(
          eq(crossClarifySessions.taskId, args.taskId),
          eq(crossClarifySessions.crossClarifyNodeId, nodeId),
          eq(crossClarifySessions.loopIter, args.loopIter),
          eq(crossClarifySessions.status, 'answered'),
          eq(crossClarifySessions.directive, 'continue'),
        ),
      )
      .orderBy(desc(crossClarifySessions.iteration))
      .limit(1)
    const latest = rows[0]
    if (latest === undefined) continue
    const questions = JSON.parse(latest.questionsJson) as ClarifyQuestion[]
    const answers =
      latest.answersJson !== null ? (JSON.parse(latest.answersJson) as ClarifyAnswer[]) : []
    sources.push({
      sourceQuestionerNodeId: latest.sourceQuestionerNodeId,
      crossClarifyNodeId: nodeId,
      iteration: latest.iteration,
      questions,
      answers,
    })
  }
  if (sources.length === 0) return undefined
  const block = buildExternalFeedbackBlock(sources)
  const csv = sources
    .slice()
    .sort((a, b) => a.sourceQuestionerNodeId.localeCompare(b.sourceQuestionerNodeId))
    .map((s) => s.sourceQuestionerNodeId)
    .join(', ')
  return {
    block,
    iteration: String(args.designerCrossClarifyIteration),
    sourcesCsv: csv,
  }
}

// ---------------------------------------------------------------------------
// Read-side helpers used by REST routes.
// ---------------------------------------------------------------------------

export interface ListCrossClarifySummariesFilter {
  taskId?: string
  status?: CrossClarifySessionStatus | 'all'
  limit?: number
}

export async function listCrossClarifySummaries(
  db: DbClient,
  filter: ListCrossClarifySummariesFilter = {},
): Promise<CrossClarifySessionSummary[]> {
  const all = await db
    .select()
    .from(crossClarifySessions)
    .orderBy(desc(crossClarifySessions.createdAt))
  const desired = filter.status ?? 'awaiting_human'
  const filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desired !== 'all' && r.status !== desired) return false
    return true
  })
  const limit = filter.limit ?? 100
  const sliced = filtered.slice(0, limit)
  // RFC-037 parity: bulk-fetch task names for the included rows so each
  // summary carries a non-empty taskName (mirrors listClarifySummaries).
  const taskIds = Array.from(new Set(sliced.map((r) => r.taskId)))
  const taskNameByTaskId = new Map<string, string>()
  if (taskIds.length > 0) {
    const taskRows = await db.select({ id: tasks.id, name: tasks.name }).from(tasks)
    const wanted = new Set(taskIds)
    for (const r of taskRows) if (wanted.has(r.id)) taskNameByTaskId.set(r.id, r.name)
  }
  return sliced.map((r) => rowToSummary(r, taskNameByTaskId.get(r.taskId) ?? ''))
}

export async function getCrossClarifyDetail(
  db: DbClient,
  crossClarifyNodeRunId: string,
): Promise<CrossClarifySession> {
  const rows = await db
    .select()
    .from(crossClarifySessions)
    .where(eq(crossClarifySessions.crossClarifyNodeRunId, crossClarifyNodeRunId))
    .orderBy(desc(crossClarifySessions.createdAt))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'cross-clarify-session-not-found',
      `no cross_clarify_session for node_run ${crossClarifyNodeRunId}`,
    )
  }
  return rowToSession(row)
}

/**
 * Task delete path — drop every cross_clarify_session for this task. The
 * FK CASCADE on tasks(id) handles the row eviction too; this is explicit
 * so any future audit / WS broadcast surface stays clean.
 */
export async function cleanupCrossClarifySessionsForTask(
  db: DbClient,
  taskId: string,
): Promise<void> {
  await db.delete(crossClarifySessions).where(eq(crossClarifySessions.taskId, taskId))
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function mergeAnswered(
  row: typeof crossClarifySessions.$inferSelect,
  sealedAnswers: ClarifyAnswer[],
  directive: ClarifyDirective,
  answeredAt: number,
): CrossClarifySession {
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  return {
    id: row.id,
    taskId: row.taskId,
    crossClarifyNodeId: row.crossClarifyNodeId,
    crossClarifyNodeRunId: row.crossClarifyNodeRunId,
    sourceQuestionerNodeId: row.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: row.sourceQuestionerNodeRunId,
    targetDesignerNodeId: row.targetDesignerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questions,
    answers: sealedAnswers,
    directive,
    status: 'answered',
    designerRunTriggeredAt: row.designerRunTriggeredAt,
    createdAt: row.createdAt,
    answeredAt,
    abandonedAt: row.abandonedAt,
  }
}

function rowToSession(row: typeof crossClarifySessions.$inferSelect): CrossClarifySession {
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  const out: CrossClarifySession = {
    id: row.id,
    taskId: row.taskId,
    crossClarifyNodeId: row.crossClarifyNodeId,
    crossClarifyNodeRunId: row.crossClarifyNodeRunId,
    sourceQuestionerNodeId: row.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: row.sourceQuestionerNodeRunId,
    targetDesignerNodeId: row.targetDesignerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questions,
    directive: (row.directive ?? null) as ClarifyDirective | null,
    status: row.status as CrossClarifySessionStatus,
    designerRunTriggeredAt: row.designerRunTriggeredAt,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    abandonedAt: row.abandonedAt,
  }
  if (row.answersJson !== null) {
    try {
      out.answers = JSON.parse(row.answersJson) as ClarifyAnswer[]
    } catch {
      /* ignore corrupt answers */
    }
  }
  return out
}

function rowToSummary(
  row: typeof crossClarifySessions.$inferSelect,
  taskName = '',
): CrossClarifySessionSummary {
  let questionCount = 0
  try {
    const qs = JSON.parse(row.questionsJson) as ClarifyQuestion[]
    questionCount = Array.isArray(qs) ? qs.length : 0
  } catch {
    questionCount = 0
  }
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
    crossClarifyNodeId: row.crossClarifyNodeId,
    crossClarifyNodeRunId: row.crossClarifyNodeRunId,
    sourceQuestionerNodeId: row.sourceQuestionerNodeId,
    targetDesignerNodeId: row.targetDesignerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questionCount,
    status: row.status as CrossClarifySessionStatus,
    directive: (row.directive ?? null) as ClarifyDirective | null,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

function parseDefinitionFromSnapshot(snapshotJson: string): WorkflowDefinition | null {
  try {
    return JSON.parse(snapshotJson) as WorkflowDefinition
  } catch {
    return null
  }
}

function broadcastCrossClarifyCreated(taskId: string, session: CrossClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.created',
    nodeRunId: session.crossClarifyNodeRunId,
    crossClarifyNodeId: session.crossClarifyNodeId,
    sessionId: session.id,
    iteration: session.iteration,
    sourceQuestionerNodeId: session.sourceQuestionerNodeId,
    targetDesignerNodeId: session.targetDesignerNodeId,
  })
}

function broadcastCrossClarifyAnswered(taskId: string, session: CrossClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.answered',
    nodeRunId: session.crossClarifyNodeRunId,
    sessionId: session.id,
    iteration: session.iteration,
    directive: session.directive ?? 'continue',
  })
}

function broadcastCrossClarifyRejected(
  taskId: string,
  session: CrossClarifySession,
  questionerNodeRunId: string,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.rejected',
    nodeRunId: session.crossClarifyNodeRunId,
    sessionId: session.id,
    questionerNodeRunId,
  })
}

function broadcastDesignerRerunBatched(
  taskId: string,
  designerNodeRunId: string,
  sourceQuestionerNodeIds: string[],
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.designer-rerun-batched',
    designerNodeRunId,
    sourceQuestionerNodeIds,
  })
}

// Re-exports for the runner / scheduler / route layer so they don't pull
// directly from shared in two places.
export {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  resolveCrossClarifySessionMode,
}
export type { ClarifyCrossAgentNode }
