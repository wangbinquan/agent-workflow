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
//   - triggerDesignerRerun: mints a fresh designer node_run (cause
//     'cross-clarify-answer', retryIndex = prior-max + 1) that revises in
//     place. It does NOT roll back the worktree (patch 2026-06-22) — the
//     prior draft is supplied via the scheduler's `## Prior Output (to be
//     updated)` prompt block, and downstream re-dispatch is lazy (RFC-074).
//     Persistent-stop cross-clarify nodes stay reset to pending but dispatch
//     detects them via resolveCrossNodeStopped (questioner node-level directive).
//   - triggerQuestionerStopRerun: cascade-reset the questioner. dispatch
//     time the questioner's prompt picks up the STOP CLARIFYING anchor +
//     full Q&A history via the cross-clarify path.
//   - dispatchCrossClarifyNode: scheduler-side helper. Checks for persistent
//     stop. If present, transitions the cross-clarify node_run pending→done
//     ('persistent-stop') without parking. Otherwise the questioner emit-
//     clarify lands here via createCrossClarifySession.
//   - buildExternalFeedbackSources: pulls the latest directive='continue'
//     session per source-questioner-node for the upcoming designer rerun.
//   - resolveCrossNodeStopped / listSummaries / getDetail / cleanupForTask:
//     read-side helpers used by REST + scheduler / runner.
//
// Source-of-truth contracts:
//   - clarify_iteration counts ROUNDS of clarify feedback (both self + cross
//     after RFC-064 unification) per loop_iter; the `kind` column on
//     `clarify_rounds` is the only "self vs cross" discriminator. Orthogonal
//     to review_iteration (review), retry_index (process retries).
//   - directive='stop' persists across loop iterations (queried by node id
//     alone). Q&A history resets per loop_iter (queries always carry loop_iter).
//   - sealAnswersServerSide is reused verbatim from services/clarify.ts so
//     answer-tampering defences stay identical between self / cross paths.

import {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  resolveCrossClarifySessionMode,
  type ClarifyAnswer,
  type ClarifyCrossAgentNode,
  type ClarifyDirective,
  type ClarifyQuestion,
  type ClarifyTruncationWarning,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { clarifyRounds, crossClarifySessions, tasks } from '@/db/schema'
import { setNodeRunStatus } from '@/services/lifecycle'
import { mintNodeRun } from '@/services/nodeRunMint'
import { NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { getNodeClarifyDirectiveRow } from '@/services/taskClarifyDirective'
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
  // RFC-162: `questionScopes` removed (scope deleted).
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
 * RFC-217 T7 (C-A) — READ adapter: a `clarify_rounds` cross row re-shaped into
 * the legacy cross-session column names the DTO mappers consume (mirror of
 * clarify.ts's selfRoundAsSession; both drop with the tables in T8).
 */
type CrossSessionShape = typeof crossClarifySessions.$inferSelect
function crossRoundAsSession(r: typeof clarifyRounds.$inferSelect): CrossSessionShape {
  return {
    id: r.id,
    taskId: r.taskId,
    crossClarifyNodeId: r.intermediaryNodeId,
    crossClarifyNodeRunId: r.intermediaryNodeRunId,
    sourceQuestionerNodeId: r.askingNodeId,
    sourceQuestionerNodeRunId: r.askingNodeRunId,
    targetDesignerNodeId: r.targetConsumerNodeId,
    loopIter: r.loopIter,
    iteration: r.iteration,
    questionsJson: r.questionsJson,
    answersJson: r.answersJson,
    directive: r.directive,
    status: r.status as CrossSessionShape['status'],
    designerRunTriggeredAt: r.designerRunTriggeredAt,
    createdAt: r.createdAt,
    answeredAt: r.answeredAt,
    abandonedAt: r.abandonedAt,
    questionScopesJson: r.questionScopesJson,
  }
}

const crossRounds = () => eq(clarifyRounds.kind, 'cross')

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
    .select({ iteration: clarifyRounds.iteration })
    .from(clarifyRounds)
    .where(
      and(
        crossRounds(),
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.intermediaryNodeId, args.crossClarifyNodeId),
        eq(clarifyRounds.loopIter, args.loopIter),
      ),
    )
    .orderBy(desc(clarifyRounds.iteration))
    .limit(1)
  const iteration = prior.length === 0 ? 0 : (prior[0]?.iteration ?? 0) + 1

  // Mint cross-clarify node_run row parked at awaiting_human. RFC-053:
  // park-human enforces pending|running → awaiting_human; we mint at
  // 'awaiting_human' directly so the runner doesn't need a separate
  // pending->awaiting_human leg.
  const crossClarifyNodeRunId = await mintNodeRun(args.db, {
    taskId: args.taskId,
    nodeId: args.crossClarifyNodeId,
    status: 'awaiting_human',
    cause: 'cross-clarify-park',
    iteration: args.loopIter,
    overrides: { startedAt: createdAt },
  })

  const sessionId = ulid()
  const questionsJson = JSON.stringify(args.questions)
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
    questionsJson,
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    designerRunTriggeredAt: null,
    createdAt,
    answeredAt: null,
    abandonedAt: null,
  })

  // RFC-058 T12 dual-write — mirror to clarify_rounds with kind='cross'.
  // RFC-056 v1 keeps cross-clarify on agent-single, so askingShardKey = null.
  await args.db.insert(clarifyRounds).values({
    id: sessionId,
    taskId: args.taskId,
    kind: 'cross',
    askingNodeId: args.sourceQuestionerNodeId,
    askingNodeRunId: args.sourceQuestionerNodeRunId,
    askingShardKey: null,
    intermediaryNodeId: args.crossClarifyNodeId,
    intermediaryNodeRunId: crossClarifyNodeRunId,
    targetConsumerNodeId: args.targetDesignerNodeId,
    loopIter: args.loopIter,
    iteration,
    questionsJson,
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    truncationWarningsJson: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
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
// evaluateDesignerRerunReadiness — multi-source aggregation.
// ---------------------------------------------------------------------------

export interface EvaluateDesignerRerunReadinessArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  definition: WorkflowDefinition
  /** Limit the readiness scan to a specific loop iteration. Non-loop = 0. */
  loopIter: number
  /**
   * RFC-128 P3 — origin node-run ids (= cross_clarify_sessions.cross_clarify_node_run_id,
   * which equals task_questions.origin_node_run_id) of the designer questions being DISPATCHED
   * right now. A per-question dispatch explicitly dispatches the SEALED questions of these
   * sources even while their round is still awaiting_human (a partial seal), so a sibling
   * whose latest session is one of these is NOT counted as "pending" — we are not waiting for
   * its remaining (unsealed) questions. Other awaiting_human siblings (not in this set) still
   * gate the dispatch (golden lock: rfc120 H3/H2 multi-source readiness). Empty / omitted on
   * the immediate-submit path → byte-for-byte the pre-RFC-128 readiness (golden lock).
   */
  dispatchedOrigins?: ReadonlySet<string>
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
  // RFC-162 (correlation-readiness barrier reframe): a handler node with NO cross-clarify
  // to_designer sibling has NOTHING to correlate — it is immediately READY. This is the case
  // for a reassign-added upstream/downstream reviser (an arbitrary agent node that is not a
  // graph designer). The N:1 barrier below still applies to GENUINE graph designers (≥1
  // sibling cross-clarify node points at them via to_designer). Pre-RFC-162 this returned
  // `ready:false` (a defensive relic: an unwired designer never reran) — but the old model
  // never reassigned to a non-designer, so nothing depended on the false.
  if (siblingNodeIds.length === 0) {
    return { ready: true, sources: [], pendingCrossClarifyNodeIds: [] }
  }

  const sources: DesignerRerunReadinessSource[] = []
  const pending: string[] = []
  for (const nodeId of siblingNodeIds) {
    // Latest session for this (nodeId, loop_iter).
    const rawRows = await args.db
      .select()
      .from(clarifyRounds)
      .where(
        and(
          crossRounds(),
          eq(clarifyRounds.taskId, args.taskId),
          eq(clarifyRounds.intermediaryNodeId, nodeId),
          eq(clarifyRounds.loopIter, args.loopIter),
        ),
      )
      .orderBy(desc(clarifyRounds.iteration))
      .limit(1)
    const latest = rawRows[0] === undefined ? undefined : crossRoundAsSession(rawRows[0])
    if (latest === undefined) {
      pending.push(nodeId)
      continue
    }
    if (latest.status === 'awaiting_human') {
      // RFC-128 P3: a per-question dispatch explicitly dispatches THIS source's sealed
      // questions even though its round is still awaiting_human (a partial seal). So a
      // sibling whose latest session is being dispatched from is NOT pending — we are not
      // waiting for its remaining questions; its sealed Q&A is injected via the per-node
      // queue at dispatch (buildNodeQueueExternalFeedback), not via readiness.sources. Other
      // awaiting_human siblings still gate (golden lock H3/H2).
      if (args.dispatchedOrigins?.has(latest.crossClarifyNodeRunId)) continue
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
  const questionerNodeId = findQuestionerNodeForCrossClarify(
    args.definition,
    args.crossClarifyNodeId,
  )
  if (questionerNodeId === undefined) {
    return { kind: 'no-questioner' }
  }
  // RFC-132 T7: the questioner's node-level clarify directive is the single source of
  // truth for stop/continue. answer-stop (sealRoundQuestions) and the canvas toggle both
  // write the questioner node's directive, so node last-write-wins subsumes the RFC-123
  // recency gate (a stale 'continue' is overwritten by a later answer-stop → stopped; a
  // toggle 'continue' after a stop → re-enabled).
  const stopped = await resolveCrossNodeStopped(args.db, args.taskId, questionerNodeId)
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
 * RFC-056 + RFC-123 + RFC-132 T7: should the cross-clarify NODE short-circuit to done?
 * The questioner node's node-level clarify directive (`task_node_clarify_directives`) is the
 * SINGLE source of truth. Both the answer-stop path (sealRoundQuestions → setNodeClarifyDirective
 * on the questioner node) and the canvas toggle write it, so node last-write-wins subsumes the
 * old RFC-123 recency gate: a stale 'continue' followed by a later answer-stop resolves to
 * 'stop' (stopped); a toggle 'continue' after a stop re-enables the questioner. No row or
 * 'continue' ⇒ not stopped. The legacy `crossClarifySessions.directive` column is retained for
 * audit only and no longer read here (design §1).
 */
export async function resolveCrossNodeStopped(
  db: DbClient,
  taskId: string,
  questionerNodeId: string,
): Promise<boolean> {
  return (await getNodeClarifyDirectiveRow(db, taskId, questionerNodeId))?.directive === 'stop'
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
  const all = (
    await db
      .select()
      .from(clarifyRounds)
      .where(crossRounds())
      .orderBy(desc(clarifyRounds.createdAt))
  ).map(crossRoundAsSession)
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
    .from(clarifyRounds)
    .where(and(crossRounds(), eq(clarifyRounds.intermediaryNodeRunId, crossClarifyNodeRunId)))
    .orderBy(desc(clarifyRounds.createdAt))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'cross-clarify-session-not-found',
      `no cross_clarify_session for node_run ${crossClarifyNodeRunId}`,
    )
  }
  return rowToSession(crossRoundAsSession(row))
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
  // RFC-058 T12 dual-write — mirror cleanup on clarify_rounds (cross slice).
  await db
    .delete(clarifyRounds)
    .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.kind, 'cross')))
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

// RFC-162: `validateQuestionScopes` / `parseQuestionScopesJson` deleted with scope.

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

/**
 * RFC-128 P5-D — re-emit the legacy `cross-clarify.answered` (+ `cross-clarify.rejected` for a stop
 * round) WS event(s) for a (now-answered) CROSS round so OTHER clients invalidate clarify
 * list/detail/pending-count + node-runs after a DEFERRED quick answer (autoDispatchClarifyRound
 * reuses the legacy quick path's notification, which it otherwise bypasses). No-op unless the
 * session exists AND is answered. Pass `rejectedQuestionerNodeRunId` (the dispatched questioner
 * rerun, or '' when deferred) ONLY for a stop round to also fire the rejected event.
 */
export async function broadcastCrossClarifyAnsweredForRound(
  db: DbClient,
  crossClarifyNodeRunId: string,
  opts: { rejectedQuestionerNodeRunId?: string } = {},
): Promise<void> {
  const row = (
    await db
      .select()
      .from(clarifyRounds)
      .where(and(crossRounds(), eq(clarifyRounds.intermediaryNodeRunId, crossClarifyNodeRunId)))
      .orderBy(desc(clarifyRounds.createdAt))
      .limit(1)
  )[0]
  if (row === undefined) return
  const legacy = crossRoundAsSession(row)
  if (legacy.status !== 'answered') return
  const session = rowToSession(legacy)
  broadcastCrossClarifyAnswered(legacy.taskId, session)
  if (opts.rejectedQuestionerNodeRunId !== undefined) {
    broadcastCrossClarifyRejected(row.taskId, session, opts.rejectedQuestionerNodeRunId)
  }
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
