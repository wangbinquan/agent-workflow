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

import { and, asc, count, desc, eq, isNull } from 'drizzle-orm'
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
  type ClarifyTruncationWarning,
  type ClarifyNode,
  type WorkflowDefinition,
  type WorkflowNode,
  findClarifyNodeForAgent,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { clarifyRounds, clarifySessions, nodeRuns, tasks } from '@/db/schema'
import { transitionNodeRunStatus } from '@/services/lifecycle'
import { mintNodeRun } from '@/services/nodeRunMint'
import { NotFoundError, ValidationError } from '@/util/errors'
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
      // RFC-053: park-human enforces pending|running → awaiting_human.
      await transitionNodeRunStatus({
        db,
        nodeRunId: clarifyNodeRunId,
        event: { kind: 'park-human' },
        extra: { startedAt: existingClarifyRun.startedAt ?? now() },
      })
    }
  } else {
    // RFC-074 PR-C: the clarify node_run no longer carries a clarifyIteration
    // counter — freshness is pure id-order and the round index lives on the
    // clarify_sessions / clarify_rounds rows (iterationIndex), not here.
    clarifyNodeRunId = await mintNodeRun(db, {
      taskId,
      nodeId: clarifyNodeId,
      status: 'awaiting_human',
      cause: 'clarify-park',
      iteration: 0,
      overrides: {
        parentNodeRunId: parentNodeRunId ?? null,
        shardKey: sourceShardKey,
        startedAt: now(),
      },
    })
  }

  const sessionId = ulid()
  const createdAt = now()
  const questionsJson = JSON.stringify(validated.questions)
  const truncationWarningsJson =
    truncationWarnings && truncationWarnings.length > 0 ? JSON.stringify(truncationWarnings) : null
  await db.insert(clarifySessions).values({
    id: sessionId,
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    clarifyNodeRunId,
    iterationIndex,
    questionsJson,
    answersJson: null,
    status: 'awaiting_human',
    truncationWarningsJson,
    createdAt,
    answeredAt: null,
    answeredBy: null,
  })

  // RFC-058 T12 — dual-write to clarify_rounds so the unified service
  // (services/clarifyRounds.ts) sees every new self-clarify round. The
  // legacy clarify_sessions row above is still authoritative for reads;
  // T17 drops the legacy table once all readers migrate. Schema mapping
  // mirrors migration 0031's INSERT FROM clauses verbatim.
  await db.insert(clarifyRounds).values({
    id: sessionId,
    taskId,
    kind: 'self',
    askingNodeId: sourceAgentNodeId,
    askingNodeRunId: sourceAgentNodeRunId,
    askingShardKey: sourceShardKey,
    intermediaryNodeId: clarifyNodeId,
    intermediaryNodeRunId: clarifyNodeRunId,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: iterationIndex,
    questionsJson,
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    truncationWarningsJson,
    designerRunTriggeredAt: null,
    abandonedAt: null,
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

  // RFC-037: fetch tasks.name once so the WS summary carries the joined
  // display name. Missing task (hard delete race) degrades to empty string;
  // the schema accepts any string and the frontend has its own fallback.
  const taskNameRow = await db
    .select({ name: tasks.name })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const taskName = taskNameRow[0]?.name ?? ''

  // RFC-037 follow-up: resolve clarify node title from the snapshot once so
  // the WS create-event summary carries it; otherwise subscribers re-fetch
  // the list to learn the title. Failure / missing title leaves null.
  const titlesByTaskAndNode = await loadNodeTitlesByTask(db, [taskId])
  const resolvedClarifyTitle = titlesByTaskAndNode.get(taskId)?.get(clarifyNodeId)
  if (typeof resolvedClarifyTitle === 'string' && resolvedClarifyTitle.length > 0) {
    session.clarifyNodeTitle = resolvedClarifyTitle
  }

  broadcastClarifyCreated(taskId, taskName, session)
  return { session, clarifyNodeRunId }
}

// ---------------------------------------------------------------------------
// READ-side helpers used by REST routes.
// ---------------------------------------------------------------------------

export interface ListClarifySummariesFilter {
  taskId?: string
  status?: ClarifySessionStatus | 'all'
  limit?: number
}

/**
 * RFC-217 T7 (C-A) — READ adapter: a `clarify_rounds` self row re-shaped into
 * the legacy session column names every DTO mapper below consumes. The
 * unified table has been dual-written since RFC-058; reads flip here first,
 * the legacy tables drop in T8 (the real T17).
 */
type SelfSessionShape = typeof clarifySessions.$inferSelect
function selfRoundAsSession(r: typeof clarifyRounds.$inferSelect): SelfSessionShape {
  return {
    id: r.id,
    taskId: r.taskId,
    sourceAgentNodeId: r.askingNodeId,
    sourceAgentNodeRunId: r.askingNodeRunId ?? '',
    sourceShardKey: r.askingShardKey,
    clarifyNodeId: r.intermediaryNodeId,
    clarifyNodeRunId: r.intermediaryNodeRunId ?? '',
    iterationIndex: r.iteration,
    questionsJson: r.questionsJson,
    answersJson: r.answersJson,
    // kind='self' rows only ever use the self status subset (DB CHECK per
    // kind, schema.ts) — the cast narrows 'abandoned' away.
    status: r.status as SelfSessionShape['status'],
    truncationWarningsJson: r.truncationWarningsJson,
    createdAt: r.createdAt,
    answeredAt: r.answeredAt,
    answeredBy: r.answeredBy,
    directive: r.directive,
  }
}

const selfRounds = () => eq(clarifyRounds.kind, 'self')

export async function listClarifySummaries(
  db: DbClient,
  filter: ListClarifySummariesFilter = {},
): Promise<ClarifySessionSummary[]> {
  const all = (
    await db.select().from(clarifyRounds).where(selfRounds()).orderBy(desc(clarifyRounds.createdAt))
  ).map(selfRoundAsSession)
  const desired = filter.status ?? 'awaiting_human'
  const filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desired !== 'all' && r.status !== desired) return false
    return true
  })
  const limit = filter.limit ?? 100
  const sliced = filtered.slice(0, limit)

  // Look up each session's source-agent node display name from the task's
  // workflowSnapshot (mirrors the review summary path which already does
  // the same for review nodes). Lets the inbox render the user-set node
  // title instead of the opaque agent node id. Snapshot read errors or
  // missing nodes degrade to `null` so the frontend keeps the existing
  // fallback to `sourceAgentNodeId`.
  const taskIds = Array.from(new Set(sliced.map((r) => r.taskId)))
  const titleByTaskAndNode = await loadNodeTitlesByTask(db, taskIds)
  const taskNameByTaskId = await loadTaskNamesByTaskId(db, taskIds)

  return sliced.map((row) => {
    const summary = rowToSummary(row, taskNameByTaskId.get(row.taskId) ?? '')
    const titles = titleByTaskAndNode.get(row.taskId)
    const srcTitle = titles?.get(row.sourceAgentNodeId)
    summary.sourceAgentNodeTitle =
      typeof srcTitle === 'string' && srcTitle.length > 0 ? srcTitle : null
    const clarTitle = titles?.get(row.clarifyNodeId)
    summary.clarifyNodeTitle =
      typeof clarTitle === 'string' && clarTitle.length > 0 ? clarTitle : null
    return summary
  })
}

/**
 * RFC-037: bulk-fetch `tasks.name` for the given taskIds. Returns a map
 * keyed by taskId. Missing rows (task hard-deleted) surface as absent — the
 * caller falls back to empty string so the schema-required `taskName` field
 * still parses. Mirrors loadAgentNodeTitlesByTask in shape so future joins
 * can be batched.
 */
async function loadTaskNamesByTaskId(
  db: DbClient,
  taskIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out
  const taskRows = await db.select().from(tasks)
  const wanted = new Set(taskIds)
  for (const t of taskRows) {
    if (!wanted.has(t.id)) continue
    out.set(t.id, t.name)
  }
  return out
}

/**
 * Bulk-fetch the `tasks.workflowSnapshot` rows for `taskIds` and extract
 * each non-empty node title into a nested map `taskId → nodeId → title`.
 * Both source-agent and clarify nodes are indexed so the inbox can render
 * `sourceAgentNodeTitle` AND `clarifyNodeTitle` (RFC-037 follow-up: clarify
 * surface aligned with the review side, which uses node titles with nodeId
 * fallback). Pure read; corrupt snapshots or missing tasks degrade to empty.
 */
async function loadNodeTitlesByTask(
  db: DbClient,
  taskIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>()
  if (taskIds.length === 0) return out
  const taskRows = await db.select().from(tasks)
  const wanted = new Set(taskIds)
  for (const t of taskRows) {
    if (!wanted.has(t.id)) continue
    const inner = new Map<string, string>()
    try {
      const def = JSON.parse(t.workflowSnapshot) as WorkflowDefinition
      for (const node of def.nodes ?? []) {
        const rec = node as Record<string, unknown>
        // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
        if (rec.kind !== 'agent-single' && rec.kind !== 'clarify') continue
        const title = typeof rec.title === 'string' ? rec.title.trim() : ''
        if (title.length === 0) continue
        inner.set(node.id, title)
      }
    } catch {
      // corrupt snapshot — leave inner empty; callers fall back to nodeId.
    }
    out.set(t.id, inner)
  }
  return out
}

export async function countPendingClarifications(db: DbClient): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(clarifyRounds)
    .where(and(selfRounds(), eq(clarifyRounds.status, 'awaiting_human')))
  return rows[0]?.n ?? 0
}

export async function getClarifyDetail(
  db: DbClient,
  clarifyNodeRunId: string,
): Promise<ClarifySession> {
  const rows = await db
    .select()
    .from(clarifyRounds)
    .where(and(selfRounds(), eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId)))
    .orderBy(desc(clarifyRounds.createdAt))
    .limit(1)
  const row = rows[0] === undefined ? undefined : selfRoundAsSession(rows[0])
  if (row === undefined) {
    throw new NotFoundError(
      'clarify-session-not-found',
      `no clarify_session for clarify node_run ${clarifyNodeRunId}`,
    )
  }
  const session = rowToSession(row)
  // RFC-037 follow-up: resolve the clarify node's `WorkflowNode.title` from
  // the task snapshot so the detail page can render "任务名 / 节点标题"
  // mirroring the review side. Failure to resolve degrades to null and the
  // frontend keeps the existing fallback to `clarifyNodeId`.
  const titlesByTaskAndNode = await loadNodeTitlesByTask(db, [row.taskId])
  const clarTitle = titlesByTaskAndNode.get(row.taskId)?.get(row.clarifyNodeId)
  if (typeof clarTitle === 'string' && clarTitle.length > 0) {
    session.clarifyNodeTitle = clarTitle
  } else {
    session.clarifyNodeTitle = null
  }
  return session
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
  // RFC-058 T12 dual-write — mirror cleanup on clarify_rounds so the unified
  // table doesn't accumulate orphaned rows after task delete.
  await db
    .delete(clarifyRounds)
    .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.kind, 'self')))
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
  // RFC-074 PR-C: the clarify node_run no longer carries a clarifyIteration
  // counter, so this round's existing clarify run is located via the
  // clarify_sessions row that owns it — keyed by (clarifyNodeId,
  // sourceShardKey, iterationIndex), which still carries the round index. A
  // re-emit within the same round finds the prior session and reuses its node
  // run; a new round has no session yet and falls through to a fresh mint.
  const sessionRows = await db
    .select({ clarifyNodeRunId: clarifyRounds.intermediaryNodeRunId })
    .from(clarifyRounds)
    .where(
      and(
        selfRounds(),
        eq(clarifyRounds.taskId, taskId),
        eq(clarifyRounds.intermediaryNodeId, clarifyNodeId),
        eq(clarifyRounds.iteration, iterationIndex),
        shardKey === null
          ? isNull(clarifyRounds.askingShardKey)
          : eq(clarifyRounds.askingShardKey, shardKey),
      ),
    )
    .orderBy(asc(clarifyRounds.createdAt))
  const owningRunId = sessionRows[0]?.clarifyNodeRunId ?? undefined
  if (owningRunId === undefined) return undefined
  const runRows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, owningRunId)).limit(1)
  return runRows[0]
}

/** RFC-128 §7 — safe parse of a round's `answers_json` into a ClarifyAnswer[] for the
 *  per-question merge-write. Returns [] for NULL, malformed JSON, or a non-array payload
 *  (some fixtures seed a legacy '{}' placeholder; production seeds NULL). Keeping this
 *  tolerant means the merge boundary never throws on a virgin/legacy round (golden-lock:
 *  empty existing → merge returns the incoming subset unchanged). */
export function parseAnswersArray(json: string | null): ClarifyAnswer[] {
  if (json === null) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyAnswer[]) : []
  } catch {
    return []
  }
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
 * RFC-128 §1/§7: this is a pure SUBSET sealer — it validates+normalises exactly the
 * answers passed in (whether the whole round or a single question) and returns them;
 * per-question merging into the round's `answers_json` is the caller's job (via
 * {@link mergeSealedAnswers}). A non-array payload throws `clarify-answers-not-array`
 * (runtime guard, kept). An EMPTY array is a no-op that returns `[]` (NOT an error —
 * the loop simply doesn't run); this is locked by rfc128-p0-whole-round-seal-net.
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

function broadcastClarifyCreated(taskId: string, taskName: string, session: ClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify.created',
    nodeRunId: session.clarifyNodeRunId,
    clarifyNodeId: session.clarifyNodeId,
    sourceShardKey: session.sourceShardKey ?? null,
    iterationIndex: session.iterationIndex,
    session: sessionToSummary(session, taskName),
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

/**
 * RFC-128 P5-D — re-emit the legacy `clarify.answered` WS event for a (now-answered) SELF round so
 * OTHER clients invalidate clarify list/detail/pending-count + node-runs after a DEFERRED quick
 * answer (autoDispatchClarifyRound reuses the legacy quick path's notification, which it otherwise
 * bypasses). No-op unless the session exists AND is answered. `rerunNodeRunId` is the dispatched
 * self rerun (or '' when the auto-dispatch was deferred to manual — the invalidation still fires).
 */
export async function broadcastSelfClarifyAnsweredForRound(
  db: DbClient,
  clarifyNodeRunId: string,
  rerunNodeRunId: string,
): Promise<void> {
  const raw = (
    await db
      .select()
      .from(clarifyRounds)
      .where(and(selfRounds(), eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId)))
      .orderBy(desc(clarifyRounds.createdAt))
      .limit(1)
  )[0]
  const row = raw === undefined ? undefined : selfRoundAsSession(raw)
  if (row === undefined || row.status !== 'answered') return
  broadcastClarifyAnswered(row.taskId, rowToSession(row), rerunNodeRunId)
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

function rowToSummary(
  row: typeof clarifySessions.$inferSelect,
  taskName: string,
): ClarifySessionSummary {
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
    // RFC-037: required field; caller passes joined `tasks.name`.
    taskName,
    sourceAgentNodeId: row.sourceAgentNodeId,
    // Populated by listClarifySummaries (which has access to the task
    // snapshot); single-session paths leave this null and the frontend
    // falls back to `sourceAgentNodeId`.
    sourceAgentNodeTitle: null,
    sourceShardKey: row.sourceShardKey,
    clarifyNodeId: row.clarifyNodeId,
    // Same convention as sourceAgentNodeTitle — list path enriches from
    // snapshot, single-session paths leave null and the frontend falls
    // back to `clarifyNodeId`.
    clarifyNodeTitle: null,
    clarifyNodeRunId: row.clarifyNodeRunId,
    iterationIndex: row.iterationIndex,
    questionCount,
    status: row.status as ClarifySessionStatus,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

function sessionToSummary(session: ClarifySession, taskName: string): ClarifySessionSummary {
  return {
    id: session.id,
    taskId: session.taskId,
    // RFC-037: required field; caller resolves and passes `tasks.name`.
    taskName,
    sourceAgentNodeId: session.sourceAgentNodeId,
    sourceAgentNodeTitle: null,
    sourceShardKey: session.sourceShardKey ?? null,
    clarifyNodeId: session.clarifyNodeId,
    clarifyNodeTitle: session.clarifyNodeTitle ?? null,
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
