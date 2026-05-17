// Clarify business logic (RFC-023 PR-B).
//
// Sibling of services/review.ts: this module owns the clarify feature's state
// transitions outside the scheduler / runner / REST layer. The split mirrors
// how review works so anyone familiar with that path can read this one too.
//
//   - createClarifySession: invoked by runner.ts when an agent reply parsed
//     as a <workflow-clarify> envelope. Mints a clarify_sessions row +
//     clarify-node node_run row (one per shard for agent-multi), parks them
//     in 'awaiting_human', broadcasts clarify.created on /ws/tasks/.
//   - submitClarifyAnswers: REST decision handler. Validates the
//     optimistic-lock guard (ifMatchIteration), seals selectedOptionLabels
//     from server-side question.options (defends against client forgery),
//     marks the session 'answered', closes the clarify node_run, then calls
//     triggerAgentRerunFromClarify.
//   - triggerAgentRerunFromClarify: rolls back to the source agent's
//     pre_snapshot, mints a fresh node_runs row at clarifyIteration + 1 with
//     retry_index reset to 0 (shard_key + parent_node_run_id passthrough).
//     Caller is expected to call resumeTask after this returns.
//   - buildClarifyPromptContext: builds the ClarifyPromptContext for the
//     scheduler before runNode.
//   - listClarifySummaries / countPending / getClarifyDetail: REST reads.
//   - cleanupSessionsForTask: invoked from task delete path.
//
// Source-of-truth contracts:
//   - clarify_iteration counts ASK-then-ANSWER rounds, orthogonal to
//     reviewIteration (review) and retryIndex (process retries). A shard
//     child's clarify_iteration tracks that shard alone.
//   - selectedOptionLabels is always reconstituted server-side from
//     selectedOptionIndices + question.options; clients can post anything
//     and it gets overwritten before persistence.
//   - The exclusive-or contract between <workflow-output> and <workflow-clarify>
//     is enforced in services/runner.ts via services/envelope.detectEnvelopeKind.
//     This module assumes the envelope it receives is already validated as
//     clarify-only.

import { and, asc, count, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  ClarifyAnswerSchema,
  ClarifyEnvelopeBodySchema,
  ClarifyQuestionSchema,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
  type ClarifySession,
  type ClarifySessionStatus,
  type ClarifySessionSummary,
  type ClarifyPromptContext,
  type ClarifyTruncationWarning,
  type ClarifyNode,
  type WorkflowDefinition,
  type WorkflowNode,
  buildClarifyPromptBlock,
  findClarifyNodeForAgent,
  renderClarifyQuestionsBlock,
  resolveClarifySessionMode,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { clarifySessions, nodeRuns, tasks } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { rollbackToSnapshot } from '@/util/git'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('clarify')

// ---------------------------------------------------------------------------
// createClarifySession — runner-side entry point.
// ---------------------------------------------------------------------------

export interface CreateClarifySessionArgs {
  db: DbClient
  taskId: string
  /** Workflow node id of the asking agent. */
  sourceAgentNodeId: string
  /**
   * node_runs.id of the asking agent's run. For agent-multi this is the
   * shard child node_run id (one session per shard). For agent-single it is
   * the single asking node_run id.
   */
  sourceAgentNodeRunId: string
  /** Shard key when source is an agent-multi shard child; null otherwise. */
  sourceShardKey: string | null
  /** Workflow node id of the clarify node wired to this agent. */
  clarifyNodeId: string
  /** Matches the asking node_run's clarifyIteration at ask-time. */
  iterationIndex: number
  /** Parsed questions from <workflow-clarify>; pre-validated by parseClarifyEnvelopeBody. */
  questions: ClarifyQuestion[]
  /** Non-fatal warnings from parseClarifyEnvelopeBody (option/question truncations). */
  truncationWarnings?: ClarifyTruncationWarning[]
  /**
   * Parent node_run id passthrough for agent-multi shard cases: when the
   * asking node_run is itself a fan-out shard child, the clarify node_run we
   * mint here inherits the parent (the agent-multi fan-out parent) so the
   * task detail view can group by it.
   */
  parentNodeRunId?: string | null
  /** Defaults to Date.now(). Override for deterministic tests. */
  now?: () => number
}

export interface CreateClarifySessionResult {
  session: ClarifySession
  /** node_runs.id of the clarify node instance that owns this session. */
  clarifyNodeRunId: string
}

/**
 * Create a clarify_sessions row + the clarify-node node_run that owns it. The
 * clarify node_run is keyed by (clarify_node_id, source_shard_key) for
 * agent-multi so each shard parks independently; agent-single keys on
 * (clarify_node_id, NULL).
 *
 * Idempotent: if a same-shard awaiting_human row already exists for this
 * (clarify_node_id, source_shard_key) at this iterationIndex, we update
 * questions_json in place rather than minting a duplicate. This is purely
 * defensive — in production each call should land a fresh session.
 */
export async function createClarifySession(
  args: CreateClarifySessionArgs,
): Promise<CreateClarifySessionResult> {
  const {
    db,
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    iterationIndex,
    questions,
    truncationWarnings,
    parentNodeRunId,
  } = args
  const now = args.now ?? Date.now

  // Defensive validation: callers are expected to have already run
  // parseClarifyEnvelopeBody, but a stray code path could land here with
  // raw shapes. Re-validate via the same schema so the DB row is always
  // round-trip-safe.
  const validated = ClarifyEnvelopeBodySchema.parse({ questions })

  const existingClarifyRun = await findClarifyNodeRunForShard(
    db,
    taskId,
    clarifyNodeId,
    sourceShardKey,
    iterationIndex,
  )
  let clarifyNodeRunId: string
  if (existingClarifyRun) {
    clarifyNodeRunId = existingClarifyRun.id
    if (existingClarifyRun.status !== 'awaiting_human') {
      await db
        .update(nodeRuns)
        .set({ status: 'awaiting_human', startedAt: existingClarifyRun.startedAt ?? now() })
        .where(eq(nodeRuns.id, clarifyNodeRunId))
    }
  } else {
    clarifyNodeRunId = ulid()
    await db.insert(nodeRuns).values({
      id: clarifyNodeRunId,
      taskId,
      nodeId: clarifyNodeId,
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: iterationIndex,
      parentNodeRunId: parentNodeRunId ?? null,
      shardKey: sourceShardKey,
      startedAt: now(),
    })
  }

  const sessionId = ulid()
  const createdAt = now()
  await db.insert(clarifySessions).values({
    id: sessionId,
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    clarifyNodeRunId,
    iterationIndex,
    questionsJson: JSON.stringify(validated.questions),
    answersJson: null,
    status: 'awaiting_human',
    truncationWarningsJson:
      truncationWarnings && truncationWarnings.length > 0
        ? JSON.stringify(truncationWarnings)
        : null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
  })

  const session: ClarifySession = {
    id: sessionId,
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    clarifyNodeRunId,
    iterationIndex,
    questions: validated.questions,
    status: 'awaiting_human',
    createdAt,
    answeredAt: null,
    answeredBy: null,
    // Directive is captured at submit time; awaiting_human sessions don't
    // have one yet. NULL surfaces as 'continue' to readers that need a
    // concrete value (see buildClarifyPromptContext).
    directive: null,
  }
  if (truncationWarnings && truncationWarnings.length > 0) {
    session.truncationWarnings = truncationWarnings
  }

  broadcastClarifyCreated(taskId, session)
  return { session, clarifyNodeRunId }
}

// ---------------------------------------------------------------------------
// submitClarifyAnswers — REST decision handler.
// ---------------------------------------------------------------------------

export interface SubmitClarifyAnswersArgs {
  db: DbClient
  /** node_runs.id of the clarify node (NOT of the source agent). */
  clarifyNodeRunId: string
  answers: ClarifyAnswer[]
  /** Optimistic-lock guard. When provided, must equal session.iterationIndex. */
  ifMatchIteration?: number
  /** Defaults to 'local'. Reserved for future per-user attribution. */
  answeredBy?: string
  /** RFC-023 directive: 'continue' (default) keeps the legacy ask-channel
   *  behaviour for the asking agent's next rerun; 'stop' instructs the runner
   *  to (1) inject a "user wants no more clarifications" sentence into the
   *  next-round prompt and (2) suppress the <workflow-clarify> protocol
   *  block for that single rerun only. */
  directive?: ClarifyDirective
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface SubmitClarifyAnswersResult {
  session: ClarifySession
  /** Newly minted source-agent node_run id (clarifyIteration + 1, retry_index = 0). */
  rerunNodeRunId: string
}

/**
 * Persist user answers for a clarify session, mark the clarify node_run
 * done, mint a fresh source-agent node_run, and broadcast clarify.answered.
 *
 * The caller (REST route) is responsible for invoking resumeTask after this
 * returns so the scheduler picks the rerun node_run up.
 *
 * Throws:
 *   - NotFoundError('clarify-session-not-found') when no row matches.
 *   - ConflictError('clarify-already-answered') when status !== awaiting_human.
 *   - ConflictError('clarify-iteration-mismatch') when ifMatchIteration set
 *     and doesn't match the persisted iterationIndex (412 semantics).
 *   - ValidationError when answers reference unknown questionIds or out-of-range
 *     option indices.
 */
export async function submitClarifyAnswers(
  args: SubmitClarifyAnswersArgs,
): Promise<SubmitClarifyAnswersResult> {
  const { db, clarifyNodeRunId, ifMatchIteration } = args
  const now = args.now ?? Date.now
  const answeredBy = args.answeredBy ?? 'local'
  const directive: ClarifyDirective = args.directive ?? 'continue'

  const sessionRows = await db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    .orderBy(desc(clarifySessions.createdAt))
    .limit(1)
  const sessionRow = sessionRows[0]
  if (sessionRow === undefined) {
    throw new NotFoundError(
      'clarify-session-not-found',
      `no clarify_session for clarify node_run ${clarifyNodeRunId}`,
    )
  }
  if (sessionRow.status !== 'awaiting_human') {
    throw new ConflictError(
      'clarify-already-answered',
      `clarify_session ${sessionRow.id} status is ${sessionRow.status}, expected awaiting_human`,
    )
  }
  if (ifMatchIteration !== undefined && ifMatchIteration !== sessionRow.iterationIndex) {
    throw new ConflictError(
      'clarify-iteration-mismatch',
      `If-Match iteration ${ifMatchIteration} does not match server iteration ${sessionRow.iterationIndex}`,
    )
  }

  const questions = JSON.parse(sessionRow.questionsJson) as ClarifyQuestion[]
  const sealedAnswers = sealAnswersServerSide(questions, args.answers)

  const answeredAt = now()
  await db
    .update(clarifySessions)
    .set({
      answersJson: JSON.stringify(sealedAnswers),
      status: 'answered',
      answeredAt,
      answeredBy,
      directive,
    })
    .where(eq(clarifySessions.id, sessionRow.id))

  // Close the clarify node_run.
  await db
    .update(nodeRuns)
    .set({ status: 'done', finishedAt: answeredAt })
    .where(eq(nodeRuns.id, clarifyNodeRunId))

  // Mint the source-agent rerun.
  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, sessionRow.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${sessionRow.taskId} not found`)
  }
  const sourceRunRow = (
    await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.id, sessionRow.sourceAgentNodeRunId))
      .limit(1)
  )[0]
  if (sourceRunRow === undefined) {
    throw new NotFoundError(
      'clarify-source-run-not-found',
      `source agent node_run ${sessionRow.sourceAgentNodeRunId} not found`,
    )
  }

  // RFC-026: in inline session mode, skip the worktree rollback. The agent
  // is about to resume its prior opencode session, which holds tool-call
  // history mentioning the worktree state it left behind. Rolling files
  // back to pre_snapshot now would desynchronise the agent's "I just
  // touched / read file X" memory from the actual filesystem and produce
  // confusing failures. RFC-023 protocol forbids agents from writing
  // during a clarify round anyway, so this is usually a no-op — but we
  // err on the safe side and let the session's view of the worktree stay
  // authoritative. See proposal §8 + design §8.
  const clarifyNodeForRerun = resolveClarifyNodeFromTaskSnapshot(
    taskRow.workflowSnapshot,
    sessionRow.clarifyNodeId,
  )
  const sessionModeForRerun = clarifyNodeForRerun
    ? resolveClarifySessionMode(clarifyNodeForRerun)
    : 'isolated'
  if (
    sessionModeForRerun !== 'inline' &&
    sourceRunRow.preSnapshot !== null &&
    sourceRunRow.preSnapshot !== '' &&
    taskRow.worktreePath !== ''
  ) {
    try {
      await rollbackToSnapshot(taskRow.worktreePath, sourceRunRow.preSnapshot)
    } catch (err) {
      log.warn('clarify rollback failed', {
        nodeRunId: sourceRunRow.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const rerunNodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: rerunNodeRunId,
    taskId: sessionRow.taskId,
    nodeId: sourceRunRow.nodeId,
    status: 'pending',
    // retryIndex resets to 0 on clarify rerun — clarify_iteration is the
    // counter that grows; treating clarify as a fresh attempt keeps the
    // retry budget intact for genuine process failures.
    retryIndex: 0,
    iteration: sourceRunRow.iteration,
    parentNodeRunId: sourceRunRow.parentNodeRunId ?? null,
    shardKey: sourceRunRow.shardKey ?? null,
    reviewIteration: sourceRunRow.reviewIteration,
    clarifyIteration: sourceRunRow.clarifyIteration + 1,
    preSnapshot: sourceRunRow.preSnapshot,
  })

  const sealedSession: ClarifySession = {
    id: sessionRow.id,
    taskId: sessionRow.taskId,
    sourceAgentNodeId: sessionRow.sourceAgentNodeId,
    sourceAgentNodeRunId: sessionRow.sourceAgentNodeRunId,
    sourceShardKey: sessionRow.sourceShardKey,
    clarifyNodeId: sessionRow.clarifyNodeId,
    clarifyNodeRunId: sessionRow.clarifyNodeRunId,
    iterationIndex: sessionRow.iterationIndex,
    questions,
    answers: sealedAnswers,
    status: 'answered',
    createdAt: sessionRow.createdAt,
    answeredAt,
    answeredBy,
    directive,
  }
  if (sessionRow.truncationWarningsJson) {
    try {
      sealedSession.truncationWarnings = JSON.parse(
        sessionRow.truncationWarningsJson,
      ) as ClarifyTruncationWarning[]
    } catch {
      /* ignore corrupt warnings JSON */
    }
  }

  broadcastClarifyAnswered(sessionRow.taskId, sealedSession, rerunNodeRunId)
  return { session: sealedSession, rerunNodeRunId }
}

// ---------------------------------------------------------------------------
// buildClarifyPromptContext — scheduler-side prompt assembly hook.
// ---------------------------------------------------------------------------

export interface BuildClarifyPromptContextArgs {
  db: DbClient
  /** Workflow definition (snapshot) — used to compute wrapper-loop remaining. */
  definition: WorkflowDefinition
  taskId: string
  /** Workflow node id of the agent about to be re-run. */
  agentNodeId: string
  /**
   * clarifyIteration of the about-to-be-run node_run. The context is built
   * from the LAST answered session with iterationIndex < targetIteration.
   * A targetIteration of 0 returns undefined (no prior session to surface).
   */
  targetIteration: number
  /**
   * Shard key when re-running an agent-multi shard child; null for agent-single.
   * Sessions are filtered by source_shard_key so the right shard's Q&A lands
   * in the right rerun's prompt.
   */
  shardKey: string | null
  /**
   * RFC-026: which clarify session mode the upstream clarify node selected
   * for this rerun. `'isolated'` (default / undefined) keeps RFC-023 multi-
   * round dump behavior verbatim. `'inline'` collapses the result to the
   * SINGLE most-recent answered round (no prior questions, no historical
   * answers) and tags the returned context with `mode: 'inline'` so
   * `renderUserPrompt` switches to the short inline trailing reminder.
   *
   * Inline mode relies on the runner spawning opencode with
   * `--session <prior-id>` so older rounds + the bi-modal preamble are
   * already in opencode's session memory. Rerendering them here would
   * duplicate context the agent already has.
   */
  sessionMode?: 'isolated' | 'inline'
}

/**
 * Compose the ClarifyPromptContext for the agent's next run. Returns
 * `undefined` when there is no prior answered session to surface (first
 * run, or no clarify channel exercised yet at this shard).
 *
 * Multi-round behaviour: every prior answered session for this
 * (task, agent, shard) — not just the most recent — is rendered in
 * chronological order, with each round wrapped in a `### Round N` header.
 * Dropping older rounds would lose the user's earlier answers as soon as
 * the agent asked a follow-up question. The trailing directive trailer
 * (`KEEP CLARIFYING IF NEEDED` / `STOP CLARIFYING`) only attaches to the
 * latest round, since it is the user's standing instruction for the
 * upcoming rerun; earlier rounds' directives are historical and would just
 * confuse the agent if echoed verbatim.
 */
export async function buildClarifyPromptContext(
  args: BuildClarifyPromptContextArgs,
): Promise<ClarifyPromptContext | undefined> {
  if (args.targetIteration <= 0) return undefined

  // We deliberately query by (sourceAgentNodeId, taskId, sourceShardKey) +
  // status = 'answered' + iterationIndex < targetIteration so an in-flight
  // unanswered session never bleeds into the next prompt; only sealed
  // answers feed the agent.
  const allRows = await db_selectAnsweredSessionsForRerun(args)
  if (allRows.length === 0) return undefined

  // RFC-026: inline mode collapses the dump to the single most-recent round.
  // The runner is about to spawn opencode with `--session <prior-id>` so
  // earlier rounds live in opencode's session memory already.
  const inlineMode = args.sessionMode === 'inline'
  const rows = inlineMode ? allRows.slice(-1) : allRows

  const questionParts: string[] = []
  const answerParts: string[] = []
  let latestDirective: ClarifyDirective = 'continue'

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    let questions: ClarifyQuestion[]
    let answers: ClarifyAnswer[]
    try {
      questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
      answers = JSON.parse(row.answersJson ?? '[]') as ClarifyAnswer[]
    } catch (err) {
      log.warn('clarify context JSON parse failed; skipping round', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    const isLast = i === rows.length - 1
    // Coalesce legacy NULL directive to 'continue' — pre-directive rows always
    // behaved that way at submit time. Anything else from the DB is one of the
    // CHECK-constrained enum values from the migration.
    const directive = (row.directive ?? 'continue') as ClarifyDirective
    if (isLast) latestDirective = directive
    const roundLabel = `### Round ${row.iterationIndex + 1}`
    questionParts.push(`${roundLabel}\n${renderClarifyQuestionsBlock(questions)}`)
    answerParts.push(
      `${roundLabel}\n${buildClarifyPromptBlock(questions, answers, isLast ? directive : undefined)}`,
    )
  }

  if (questionParts.length === 0) return undefined

  const ctx: ClarifyPromptContext = {
    questionsBlock: questionParts.join('\n\n'),
    answersBlock: answerParts.join('\n\n'),
    iteration: String(args.targetIteration),
    remaining: computeRemaining(args.definition, args.agentNodeId, args.targetIteration),
    directive: latestDirective,
    // RFC-026: tag the context so renderUserPrompt picks the right trailing
    // block (inline reminder vs full bi-modal preamble) and the right answers
    // section heading.
    ...(inlineMode ? { mode: 'inline' as const, currentRoundOnly: true } : {}),
  }
  return ctx
}

async function db_selectAnsweredSessionsForRerun(
  args: BuildClarifyPromptContextArgs,
): Promise<Array<typeof clarifySessions.$inferSelect>> {
  // Drizzle doesn't have a clean "lt" import path that the rest of this
  // module uses; the queries here stay small enough to enumerate and sort
  // in memory.
  const rows = await args.db
    .select()
    .from(clarifySessions)
    .where(
      and(
        eq(clarifySessions.taskId, args.taskId),
        eq(clarifySessions.sourceAgentNodeId, args.agentNodeId),
        eq(clarifySessions.status, 'answered'),
      ),
    )
  const filtered = rows.filter(
    (r) => r.iterationIndex < args.targetIteration && (r.sourceShardKey ?? null) === args.shardKey,
  )
  // Ascending: oldest → newest, so the multi-round rendering reads
  // chronologically and the LAST element is the most recent round.
  filtered.sort((a, b) => a.iterationIndex - b.iterationIndex)
  return filtered
}

/**
 * RFC-023 design §5.6: when the asking agent is nested inside a wrapper-loop,
 * compute remaining = max_iterations - targetIteration as a string the agent
 * can plug into a prompt template. Returns '' when no enclosing loop has a
 * cap (the agent reads "no cap visible").
 */
function computeRemaining(
  definition: WorkflowDefinition,
  agentNodeId: string,
  targetIteration: number,
): string {
  for (const node of definition.nodes) {
    if (node.kind !== 'wrapper-loop') continue
    const nodeRec = node as Record<string, unknown>
    const innerIds = nodeRec.nodeIds
    if (!Array.isArray(innerIds)) continue
    if (!innerIds.includes(agentNodeId)) continue
    const maxIterRaw = nodeRec.maxIterations
    if (typeof maxIterRaw !== 'number' || maxIterRaw <= 0) continue
    const remaining = Math.max(0, maxIterRaw - targetIteration)
    return String(remaining)
  }
  return ''
}

// ---------------------------------------------------------------------------
// READ-side helpers used by REST routes.
// ---------------------------------------------------------------------------

export interface ListClarifySummariesFilter {
  taskId?: string
  status?: ClarifySessionStatus | 'all'
  limit?: number
}

export async function listClarifySummaries(
  db: DbClient,
  filter: ListClarifySummariesFilter = {},
): Promise<ClarifySessionSummary[]> {
  const all = await db.select().from(clarifySessions).orderBy(desc(clarifySessions.createdAt))
  const desired = filter.status ?? 'awaiting_human'
  const filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desired !== 'all' && r.status !== desired) return false
    return true
  })
  const limit = filter.limit ?? 100
  const sliced = filtered.slice(0, limit)
  return sliced.map(rowToSummary)
}

export async function countPendingClarifications(db: DbClient): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(clarifySessions)
    .where(eq(clarifySessions.status, 'awaiting_human'))
  return rows[0]?.n ?? 0
}

export async function getClarifyDetail(
  db: DbClient,
  clarifyNodeRunId: string,
): Promise<ClarifySession> {
  const rows = await db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    .orderBy(desc(clarifySessions.createdAt))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'clarify-session-not-found',
      `no clarify_session for clarify node_run ${clarifyNodeRunId}`,
    )
  }
  return rowToSession(row)
}

// ---------------------------------------------------------------------------
// cleanupSessionsForTask — task delete path.
// ---------------------------------------------------------------------------

/**
 * Delete every clarify_session belonging to a task. Called from the task
 * delete path BEFORE the task row is dropped (cascade would also handle it,
 * but explicit deletion keeps the WS broadcast surface clean if we ever add
 * a clarify.canceled event).
 */
export async function cleanupSessionsForTask(db: DbClient, taskId: string): Promise<void> {
  await db.delete(clarifySessions).where(eq(clarifySessions.taskId, taskId))
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

async function findClarifyNodeRunForShard(
  db: DbClient,
  taskId: string,
  clarifyNodeId: string,
  shardKey: string | null,
  iterationIndex: number,
): Promise<typeof nodeRuns.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, clarifyNodeId),
        eq(nodeRuns.clarifyIteration, iterationIndex),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  return rows.find((r) => (r.shardKey ?? null) === shardKey)
}

/**
 * Rebuild selectedOptionLabels from selectedOptionIndices + question.options.
 * Clients post both fields; only the indices are trusted. This defends
 * against clients trying to inject custom labels (e.g. for prompt injection
 * attacks) when the underlying question never offered that string.
 *
 * Additionally drops indices that point outside the question's options
 * array and drops answers whose questionId is unknown to the session
 * (silently — the agent's next-round prompt will simply not see them).
 *
 * Throws ValidationError on a totally empty answers array — agents that ask
 * for required input deserve a hard error rather than a silent "no answers".
 */
export function sealAnswersServerSide(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
): ClarifyAnswer[] {
  if (!Array.isArray(answers)) {
    throw new ValidationError('clarify-answers-not-array', 'answers payload must be an array')
  }
  const byId = new Map(questions.map((q) => [q.id, q]))
  const sealed: ClarifyAnswer[] = []
  for (const ans of answers) {
    const parsed = ClarifyAnswerSchema.safeParse(ans)
    if (!parsed.success) {
      throw new ValidationError(
        'clarify-answer-malformed',
        `answer for question '${ans?.questionId}': ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      )
    }
    const a = parsed.data
    const q = byId.get(a.questionId)
    if (q === undefined) {
      // Unknown question id — defensive drop. We don't throw because a
      // future migration that adds id renames shouldn't break old drafts.
      log.warn('clarify answer references unknown question id', { questionId: a.questionId })
      continue
    }
    const indices = a.selectedOptionIndices.filter((i) => i >= 0 && i < q.options.length)
    const labels = indices.map((i) => q.options[i]?.label ?? '').filter((s) => s.length > 0)
    sealed.push({
      questionId: a.questionId,
      selectedOptionIndices: indices,
      selectedOptionLabels: labels,
      customText: a.customText,
    })
  }
  return sealed
}

function broadcastClarifyCreated(taskId: string, session: ClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify.created',
    nodeRunId: session.clarifyNodeRunId,
    clarifyNodeId: session.clarifyNodeId,
    sourceShardKey: session.sourceShardKey ?? null,
    iterationIndex: session.iterationIndex,
    session: sessionToSummary(session),
  })
}

function broadcastClarifyAnswered(
  taskId: string,
  session: ClarifySession,
  rerunNodeRunId: string,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify.answered',
    nodeRunId: session.clarifyNodeRunId,
    clarifyNodeId: session.clarifyNodeId,
    sourceShardKey: session.sourceShardKey ?? null,
    iterationIndex: session.iterationIndex,
    rerunNodeRunId,
    session,
  })
}

function rowToSession(row: typeof clarifySessions.$inferSelect): ClarifySession {
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  const out: ClarifySession = {
    id: row.id,
    taskId: row.taskId,
    sourceAgentNodeId: row.sourceAgentNodeId,
    sourceAgentNodeRunId: row.sourceAgentNodeRunId,
    sourceShardKey: row.sourceShardKey,
    clarifyNodeId: row.clarifyNodeId,
    clarifyNodeRunId: row.clarifyNodeRunId,
    iterationIndex: row.iterationIndex,
    questions,
    status: row.status as ClarifySessionStatus,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    answeredBy: row.answeredBy,
    // History views surface this; null until the user has submitted (or
    // pre-directive rows that predate the column).
    directive: row.directive === null ? null : (row.directive as ClarifyDirective),
  }
  if (row.answersJson !== null) {
    try {
      out.answers = JSON.parse(row.answersJson) as ClarifyAnswer[]
    } catch {
      /* ignore corrupt answers; surface as missing */
    }
  }
  if (row.truncationWarningsJson !== null) {
    try {
      out.truncationWarnings = JSON.parse(row.truncationWarningsJson) as ClarifyTruncationWarning[]
    } catch {
      /* ignore */
    }
  }
  return out
}

function rowToSummary(row: typeof clarifySessions.$inferSelect): ClarifySessionSummary {
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
    sourceAgentNodeId: row.sourceAgentNodeId,
    sourceShardKey: row.sourceShardKey,
    clarifyNodeId: row.clarifyNodeId,
    clarifyNodeRunId: row.clarifyNodeRunId,
    iterationIndex: row.iterationIndex,
    questionCount,
    status: row.status as ClarifySessionStatus,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

function sessionToSummary(session: ClarifySession): ClarifySessionSummary {
  return {
    id: session.id,
    taskId: session.taskId,
    sourceAgentNodeId: session.sourceAgentNodeId,
    sourceShardKey: session.sourceShardKey ?? null,
    clarifyNodeId: session.clarifyNodeId,
    clarifyNodeRunId: session.clarifyNodeRunId,
    iterationIndex: session.iterationIndex,
    questionCount: session.questions.length,
    status: session.status,
    createdAt: session.createdAt,
    answeredAt: session.answeredAt ?? null,
  }
}

// ---------------------------------------------------------------------------
// definition-level helpers re-exported for runner.ts / scheduler.ts wiring.
// ---------------------------------------------------------------------------

/**
 * Find the clarify node wired to a given agent node by looking for an outbound
 * edge on the system port `__clarify__`. Returns undefined when the agent has
 * no clarify channel attached. Thin wrapper over shared/findClarifyNodeForAgent
 * so the backend can co-locate the lookup with its other clarify helpers.
 */
export function findClarifyNodeIdForAgent(
  definition: WorkflowDefinition,
  agentNodeId: string,
): string | undefined {
  return findClarifyNodeForAgent(definition, agentNodeId)
}

/** Returns the workflow node object for a clarify id, when present. */
export function findClarifyNode(
  definition: WorkflowDefinition,
  clarifyNodeId: string,
): WorkflowNode | undefined {
  return definition.nodes.find((n) => n.id === clarifyNodeId && n.kind === 'clarify')
}

/**
 * RFC-026: parse a task's stored workflowSnapshot JSON and pull out the clarify
 * node by id. Returns undefined when the snapshot is malformed or the id isn't
 * present (e.g. workflow was edited after task launch and the snapshot is
 * stale in a way that drops the clarify node — falls back to isolated then).
 *
 * Kept narrow on purpose: callers want `resolveClarifySessionMode` access at
 * REST-handler time WITHOUT pulling the whole definition into scope.
 */
export function resolveClarifyNodeFromTaskSnapshot(
  workflowSnapshotJson: string,
  clarifyNodeId: string,
): ClarifyNode | undefined {
  let snap: unknown
  try {
    snap = JSON.parse(workflowSnapshotJson)
  } catch {
    return undefined
  }
  const nodes = (snap as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return undefined
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const rec = n as { id?: unknown; kind?: unknown }
    if (rec.kind !== 'clarify') continue
    if (rec.id !== clarifyNodeId) continue
    return n as ClarifyNode
  }
  return undefined
}

// Constants re-export for tests / runner wire-ups so callers don't pull
// directly from shared in two places.
export { CLARIFY_INPUT_PORT_NAME, CLARIFY_SOURCE_PORT_NAME, ClarifyQuestionSchema }
