import {
  compareClarifyRoundRecency,
  compareClarifyRoundInboxOrder,
} from '../domain/clarifyRoundOrder'
import {
  readClarifyHistory,
  readClarifyHistoryCandidates,
  mergeClarifyHistory,
} from './clarifyHistoryProjection'
import {
  taskGateOpenCondition,
  taskGateVisibleCondition,
  createTaskGateQueries,
  createNodeRunQueries,
} from '@/modules/task-execution/public/queries'

import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  isMindmapRound,
  TERMINAL_TASK_STATUSES,
  type ClarifyDirective,
  type ClarifyDraftValue,
  type ClarifyQuestion,
  type ClarifyRound,
  type ClarifyRoundSummary,
  type TaskActorRole,
  type WorkflowDefinition,
  terminatedAsForStatus,
  type ClarifyRoundStatus,
} from '@agent-workflow/shared'
// RFC-349 SQLite compatibility adapter for the RFC-058 clarify-round helpers.
// Provider-neutral callers enter through services/clarify/rounds.ts or the
// collaboration public query/command surface; database mechanisms stay here.
//
// RFC-058 T12 — unified clarify_rounds service helpers（现役出口以下列为准；
// 旧的 selectAnsweredRoundsForConsumer / buildPromptContext /
// markClarifyRoundsConsumedBy 已随 RFC-132 PR-C/PR-E 删除，prompt 注入统一走
// clarifyQueue.selectAgentQueue 的 flatBlock 单路径）。
//
//   - `resolveEffectiveClarifyChannel` / `shouldInjectStopNotice`（RFC-122）——
//     scheduler 消费的纯决策 oracle：本次运行的有效反问通道与 stop 提示注入。
//   - `computeRemaining` —— 反问轮剩余提问预算的唯一计算口。
//   - `listClarifyRounds` / `listClarifyRoundSummaries` / `getClarifyRoundDetail`
//     —— REST 读路径（kind-discriminated，含 wrapper-loop `loopIter` 过滤，
//     RFC-056 缺口 2 的结构性修复保留在 WHERE 子句里）。
//   - `saveClarifyDraft`（RFC-099）—— 服务端逐题协作草稿（last-write-wins +
//     逐题归属 + 提交冻结）。

import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { chunkedAll } from '@/util/sqlChunk'

import { NotFoundError } from '@/util/errors'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import { readClarifyAnswerProjection } from './clarifyAnswerQueries'
import { createClarifyAnswerWritePort } from './clarifyAnswerWrite'

/**
 * RFC-122: pure oracle for the scheduler's `effectiveHasClarifyChannel` — the
 * "mandatory ask-back is ACTIVE" signal threaded to the runner. Extracted from
 * the inline scheduler boolean so the per-node STOP override has a directly
 * testable surface (golden-lock: `nodeStopOverride=false` reproduces the exact
 * pre-RFC-122 expression). Ask-back is active ⟺ the node wires a clarify channel
 * AND no STOP directive is in force (neither a 'stop' answered round nor the
 * on-canvas per-node toggle) AND the run is a genuine clarify round (not a
 * review reject/iterate re-production, unless it is itself a clarify-answer
 * rerun mid-review). Covers BOTH self-clarify and cross-questioner, since
 * `hasClarifyChannel` (agentHasClarifyChannel) is true for either.
 */
export function resolveEffectiveClarifyChannel(args: {
  hasClarifyChannel: boolean
  /** `clarifyContext?.directive` — 'stop' from a prior answered round. */
  contextDirective?: ClarifyDirective
  /** RFC-122 per-(task, asking-node) override resolved to 'stop' at dispatch. */
  nodeStopOverride: boolean
  /** `reviewContext !== undefined`. */
  reviewActive: boolean
  /** This run continues a clarify round. RFC-183: the scheduler feeds the
   *  LINEAGE verdict (`continuesClarifyLineage` over the persisted cause
   *  chain), so a clarify-answer round's technical continuations
   *  (process-retry / revival) count too — not just the answer rerun itself. */
  isClarifyRerun: boolean
}): boolean {
  return (
    args.hasClarifyChannel &&
    args.contextDirective !== 'stop' &&
    !args.nodeStopOverride &&
    (!args.reviewActive || args.isClarifyRerun)
  )
}

/**
 * RFC-122 (H2 fix): should the renderer inject the standalone
 * `### User directive: STOP CLARIFYING` trailer for this dispatch?
 *
 * Inject exactly when the per-(task, asking-node) override is 'stop' AND the
 * clarifyContext's `answersBlock` does NOT already carry the trailer — which it
 * does iff `ctx.directive === 'stop'` (set by buildPromptContext when the
 * directiveOverride was applied, i.e. `applyLatestDirective` was in effect).
 * This guarantees the STOP text appears EXACTLY ONCE across all cases:
 *   - undefined context (first run / pre-clarify error-retry)              → notice,
 *   - context whose trailer was withheld because `applyLatestDirective=false`
 *     (a review reject/iterate rerun that still carries prior clarify Q&A)  → notice,
 *   - context that already carries the STOP trailer                        → no notice.
 * No override ⇒ false (golden-lock — the trailer source is unchanged).
 */
export function shouldInjectStopNotice(args: {
  nodeStopOverride: boolean
  /** `clarifyContext?.directive`. */
  contextDirective?: ClarifyDirective
}): boolean {
  return args.nodeStopOverride && args.contextDirective !== 'stop'
}

/**
 * RFC-023 design §5.6 wrapper-loop remaining counter — copied from
 * services/clarify.ts so this module stays self-contained. Returns '' when
 * the consumer is not inside an enclosing loop with a maxIterations cap.
 *
 * Exported for RFC-132 PR-C: the scheduler assembles the flat ClarifyPromptContext
 * (which no longer flows through buildClarifyNodeQueueContext) and reuses this to
 * populate the `{{__clarify_remaining__}}` token.
 */
export function computeRemaining(
  definition: WorkflowDefinition,
  consumerNodeId: string,
  targetIteration: number,
): string {
  for (const node of definition.nodes) {
    if (node.kind !== 'wrapper-loop') continue
    const rec = node as unknown as Record<string, unknown>
    const innerIds = rec.nodeIds
    if (!Array.isArray(innerIds)) continue
    if (!innerIds.includes(consumerNodeId)) continue
    const maxIterRaw = rec.maxIterations
    if (typeof maxIterRaw !== 'number' || maxIterRaw <= 0) continue
    return String(Math.max(0, maxIterRaw - targetIteration))
  }
  return ''
}

// ---------------------------------------------------------------------------
// listClarifyRoundSummaries — REST read helper.
// ---------------------------------------------------------------------------

export interface ListClarifyRoundsFilter {
  taskId?: string
  kind?: 'self' | 'cross' | 'all'
  status?: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned' | 'all'
  limit?: number
}

/** RFC-311 — the shared WHERE for clarify_rounds list surfaces, pushed into
 *  SQL so the existing (task_id) / (kind,status) indexes actually serve the
 *  15s inbox poll instead of a full-table scan + JS filter (audit L1-4). */
function clarifyRoundsCondition(
  db: object,
  filter: {
    taskId?: string
    kind?: 'self' | 'cross' | 'all'
    status?: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned' | 'all'
  },
): SQL<unknown> | undefined {
  const desiredKind = filter.kind ?? 'all'
  const desiredStatus = filter.status ?? 'awaiting_human'
  const conditions: SQL<unknown>[] = []
  const { clarifyRounds } = tablesOf(db)
  if (filter.taskId !== undefined) conditions.push(eq(clarifyRounds.taskId, filter.taskId))
  if (desiredKind !== 'all') conditions.push(eq(clarifyRounds.kind, desiredKind))
  if (desiredStatus !== 'all') conditions.push(eq(clarifyRounds.status, desiredStatus))
  return conditions.length > 0 ? and(...conditions) : undefined
}

export async function listClarifyRounds(
  db: PersistenceDb,
  filter: ListClarifyRoundsFilter = {},
): Promise<Array<PersistenceTables['clarifyRounds']['$inferSelect']>> {
  const { clarifyRounds } = tablesOf(db)
  // `id desc` secondary key: created_at has millisecond resolution and the old
  // "SQL order then JS filter" pass had no defined intra-millisecond order;
  // ULIDs are monotonic within a millisecond, so this pins newest-first.
  const base = db
    .select()
    .from(clarifyRounds)
    .where(clarifyRoundsCondition(db, filter))
    .orderBy(desc(clarifyRounds.createdAt), desc(clarifyRounds.id))
  const rows = mergeClarifyHistory(
    await (filter.limit === undefined ? base : base.limit(filter.limit)),
    await readClarifyHistory(db, {
      taskId: filter.taskId,
      kind: filter.kind === 'all' ? undefined : filter.kind,
      status: filter.status === 'all' ? undefined : (filter.status ?? 'awaiting_human'),
    }),
  )
  rows.sort(compareClarifyRoundInboxOrder)
  return filter.limit === undefined ? rows : rows.slice(0, filter.limit)
}

// ---------------------------------------------------------------------------
// listClarifyRoundSummaries + getClarifyRoundDetail — REST projectors.
//
// RFC-058 T14: unified REST returns single ClarifyRoundSummary[] / ClarifyRound
// shapes (collapses legacy ClarifySession + CrossClarifySession into one).
// Title resolution mirrors the legacy listClarifySummaries behavior — task
// name from `tasks.name` + node titles from `tasks.workflowSnapshot`.
// ---------------------------------------------------------------------------

export interface ListClarifyRoundSummariesFilter {
  taskId?: string
  kind?: 'self' | 'cross' | 'all'
  status?: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned' | 'all'
  limit?: number
}

/**
 * Compact ClarifyRoundSummary projection of clarify_rounds rows for the
 * REST `/api/clarify` inbox endpoint. Resolves the owning task name (RFC-037
 * parity) and the asking + intermediary node titles from
 * `tasks.workflowSnapshot`. Sort: createdAt descending.
 */
export async function listClarifyRoundSummaries(
  db: PersistenceDb,
  filter: ListClarifyRoundSummariesFilter = {},
): Promise<ClarifyRoundSummary[]> {
  const desiredStatus = filter.status ?? 'awaiting_human'
  // Awaiting-human filtering must precede the window; explicit statuses can
  // bound the live page before the sorted merge with immutable history.
  let filtered = await listClarifyRounds(db, {
    ...filter,
    limit: desiredStatus === 'awaiting_human' ? undefined : (filter.limit ?? 100),
  })
  // RFC-202 T6: the awaiting_human TODO view must not surface rounds whose
  // task is already terminal — dead tasks' rounds cluttered the inbox forever
  // (audit R8; done/canceled rounds are hard-sealed by the terminal sweep,
  // failed/interrupted are revivable so they are only FILTERED here and
  // reappear if the task is resumed). Applied BEFORE the limit slice: a page
  // of terminal-task zombies must not push actionable rounds out of the
  // window (Codex design-gate P1). Historical queries (explicit status)
  // stay unfiltered.
  if (desiredStatus === 'awaiting_human' && filtered.length > 0) {
    const statusByTaskId = await loadTaskStatusesByTaskId(
      db,
      Array.from(new Set(filtered.map((r) => r.taskId))),
    )
    filtered = filtered.filter((r) => {
      const st = statusByTaskId.get(r.taskId)
      return st === undefined || !(TERMINAL_TASK_STATUSES as readonly string[]).includes(st)
    })
  }
  const limit = filter.limit ?? 100
  const sliced = filtered.slice(0, limit)

  const taskIds = Array.from(new Set(sliced.map((r) => r.taskId)))
  const taskNameByTaskId = await loadTaskNamesByTaskId(db, taskIds)
  const titleByTaskAndNode = await loadNodeTitlesByTask(db, taskIds)

  return sliced.map((row) => rowToSummary(row, taskNameByTaskId, titleByTaskAndNode))
}

/**
 * RFC-311 — the 15s inbox badge as ONE indexed count(*). Mirrors the old
 * "listClarifyRoundSummaries({status:'awaiting_human', limit:MAX}) then
 * filterRoundsByTaskVisibility" pipeline predicate-for-predicate:
 *   cr.status='awaiting_human'                  (idx_clarify_rounds_kind_status)
 *   task terminal filter (RFC-202 T6)           — orphan rounds (no task row)
 *     stay COUNTED, exactly like the JS `st === undefined ||` branch;
 *   per-actor visibility (RFC-099 D5)           — tasks:read:all counts all
 *     (orphans included); otherwise owner/collaborator only, and orphans drop
 *     out, exactly like filterRoundsByTaskVisibility's "look up rows first"
 *     behavior. Locked by the rfc311-badge-counts oracle test.
 *
 * RFC-359 AC-11 —— 「ONE indexed count(*)」此前只对 `tasks:read:all` 成立。**其余所有人**
 * （生产上的绝大多数请求）走的是三段式：把全部 awaiting 轮次的 taskId 捞出来 → 再问一次
 * `visibleTaskIds`（内部还按 sqlChunk 分块，任务多了不止一条）→ 在 JS 里 reduce 计数。
 * 数字一直是对的，所以 `rfc311-badge-counts` 的对拍一直绿——它比的是数字，比不出语句数。
 * 代价只在 PostgreSQL 上显形：每一段在 SQLite 上是进程内调用（~0μs），在 PG 上是一次真实
 * 网络往返（实测该端点 SQLite P95 1.58ms / PG 3.46ms，差值不随行数放大）。
 * 现在两条分支都是一条语句：可见性谓词由 `taskVisibilityCondition` 直接 AND 进 WHERE，
 * 与 `visibleTaskIds` 同一个片段，两条路不可能漂。往返数由
 * `rfc359-w57-clarify-badge-round-trip-budget` 双引擎钉住。
 */
export async function countAwaitingClarifyRounds(db: PersistenceDb, actor: Actor): Promise<number> {
  const canReadAllTasks = actor.permissions.has('tasks:read:all')
  const { clarifyRounds } = tablesOf(db)
  const conditions: SQL<unknown>[] = [
    eq(clarifyRounds.status, 'awaiting_human'),
    taskGateOpenCondition(db, clarifyRounds.taskId, canReadAllTasks),
  ]
  if (!canReadAllTasks) {
    conditions.push(
      taskGateVisibleCondition(db, clarifyRounds.taskId, {
        userId: actor.user.id,
        canReadAllTasks: false,
      }),
    )
  }
  const history = await readClarifyHistoryCandidates(db, { status: 'awaiting_human' })
  // One relation avoids expression-depth and bind-count growth with archived rounds.
  const historyCount =
    history.length === 0
      ? undefined
      : sql`(
    WITH archived_clarify(round_id, task_id) AS (VALUES ${sql.join(
      history.map((row) => sql`(${row.id}, ${row.taskId})`.inlineParams()),
      sql`, `,
    )})
    SELECT count(*) FROM archived_clarify
    WHERE NOT EXISTS (SELECT 1 FROM ${clarifyRounds} WHERE ${clarifyRounds.id} = archived_clarify.round_id)
    AND ${taskGateOpenCondition(db, sql`archived_clarify.task_id`, false)}
    ${
      canReadAllTasks
        ? sql``
        : sql`AND ${taskGateVisibleCondition(db, sql`archived_clarify.task_id`, {
            userId: actor.user.id,
            canReadAllTasks: false,
          })}`
    }
  )`
  const rows = await db
    .select({
      n:
        historyCount === undefined
          ? count()
          : sql<number>`count(*) + ${historyCount}`.mapWith(Number),
    })
    .from(clarifyRounds)
    .where(and(...conditions))
  return rows[0]?.n ?? 0
}

/**
 * Fetch the ClarifyRound detail keyed by intermediary node_run id (matches
 * the REST path `/api/clarify/:nodeRunId` semantics for both kind variants).
 * Throws NotFoundError when no matching row exists.
 */
export async function getClarifyRoundDetail(
  db: PersistenceDb,
  intermediaryNodeRunId: string,
): Promise<ClarifyRound> {
  const { clarifyRounds } = tablesOf(db)
  const rows = await db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
    .orderBy(desc(clarifyRounds.createdAt))
    .limit(1)
  const history = (await readClarifyHistory(db, { intermediaryNodeRunId })).filter(
    (row) => row.intermediaryNodeRunId === intermediaryNodeRunId,
  )
  const row = mergeClarifyHistory(rows, history).sort(compareClarifyRoundRecency)[0]
  if (row === undefined) {
    throw new NotFoundError(
      'clarify-round-not-found',
      `no clarify_round for intermediary node_run ${intermediaryNodeRunId}`,
    )
  }
  const titlesByTaskAndNode = await loadNodeTitlesByTask(db, [row.taskId])
  const detail = rowToDetail(row, titlesByTaskAndNode, await readClarifyAnswerProjection(db, row))
  // RFC-202 T6 (Codex impl-gate P2): the UI must explain WHY a round was
  // sealed — inferring it from the task's MUTABLE current status misattributes
  // history (e.g. a canceled-then-retried task's abandoned round would read as
  // an autonomous dismissal). The park-carrier node_run's errorMessage records
  // the transition-time cause ('task-canceled' / 'task-done' from the terminal
  // sweep, 'wg-clarify-disabled' from the workgroup flip); expose it
  // verbatim as an optional field.
  if (row.status === 'canceled' || row.status === 'abandoned') {
    const [run] = await createNodeRunQueries(db).listHistoryFields(
      { runIds: [intermediaryNodeRunId], limit: 1 },
      ['errorMessage'],
    )
    if (run?.errorMessage != null && run.errorMessage !== '') {
      detail.sealedCause = run.errorMessage
    }
  }
  return detail
}

function rowToSummary(
  row: PersistenceTables['clarifyRounds']['$inferSelect'],
  taskNameByTaskId: Map<string, string>,
  titlesByTaskAndNode: Map<string, Map<string, string>>,
): ClarifyRoundSummary {
  const titles = titlesByTaskAndNode.get(row.taskId)
  const askingTitle = titles?.get(row.askingNodeId)
  const intermediaryTitle = titles?.get(row.intermediaryNodeId)
  let questionCount = 0
  try {
    const parsed = JSON.parse(row.questionsJson) as ClarifyQuestion[]
    questionCount = Array.isArray(parsed) ? parsed.length : 0
  } catch {
    /* leave 0 */
  }
  return {
    id: row.id,
    taskId: row.taskId,
    taskName: taskNameByTaskId.get(row.taskId) ?? '',
    kind: row.kind as 'self' | 'cross',
    terminatedAs: terminatedAsForStatus(row.status as ClarifyRoundStatus),
    askingNodeId: row.askingNodeId,
    askingNodeTitle: typeof askingTitle === 'string' && askingTitle.length > 0 ? askingTitle : null,
    askingShardKey: row.askingShardKey,
    intermediaryNodeId: row.intermediaryNodeId,
    intermediaryNodeTitle:
      typeof intermediaryTitle === 'string' && intermediaryTitle.length > 0
        ? intermediaryTitle
        : null,
    intermediaryNodeRunId: row.intermediaryNodeRunId,
    targetConsumerNodeId: row.targetConsumerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questionCount,
    status: row.status as 'awaiting_human' | 'answered' | 'canceled' | 'abandoned',
    directive: (row.directive ?? null) as ClarifyDirective | null,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

function rowToDetail(
  row: PersistenceTables['clarifyRounds']['$inferSelect'],
  titlesByTaskAndNode: Map<string, Map<string, string>>,
  projection: Awaited<ReturnType<typeof readClarifyAnswerProjection>>,
): ClarifyRound {
  const titles = titlesByTaskAndNode.get(row.taskId)
  const intermediaryTitle = titles?.get(row.intermediaryNodeId)
  let questions: ClarifyQuestion[] = []
  const answers = projection.detailAnswers
  let truncationWarnings: ClarifyRound['truncationWarnings']
  try {
    questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  } catch {
    /* keep empty */
  }
  if (row.truncationWarningsJson !== null) {
    try {
      truncationWarnings = JSON.parse(
        row.truncationWarningsJson,
      ) as ClarifyRound['truncationWarnings']
    } catch {
      /* keep undefined */
    }
  }
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind as 'self' | 'cross',
    terminatedAs: terminatedAsForStatus(row.status as ClarifyRoundStatus),
    askingNodeId: row.askingNodeId,
    askingNodeRunId: row.askingNodeRunId,
    askingShardKey: row.askingShardKey,
    intermediaryNodeId: row.intermediaryNodeId,
    intermediaryNodeRunId: row.intermediaryNodeRunId,
    intermediaryNodeTitle:
      typeof intermediaryTitle === 'string' && intermediaryTitle.length > 0
        ? intermediaryTitle
        : null,
    targetConsumerNodeId: row.targetConsumerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questions,
    ...(isMindmapRound(questions) ? { interactionMode: 'mindmap' as const } : {}),
    ...(answers !== undefined ? { answers } : {}),
    directive: (row.directive ?? null) as ClarifyDirective | null,
    status: row.status as 'awaiting_human' | 'answered' | 'canceled' | 'abandoned',
    ...(truncationWarnings !== undefined ? { truncationWarnings } : {}),
    sessionMode: null,
    designerRunTriggeredAt: row.designerRunTriggeredAt,
    abandonedAt: row.abandonedAt,
    // RFC-162: `questionScopes` removed (scope deleted).
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    answeredBy: row.answeredBy,
    // RFC-099 (D7/D8) — UI-only attribution + live draft state. These fields
    // are NEVER read by buildPromptContext above (prompt isolation).
    submittedByRole: (row.submittedByRole ?? null) as ClarifyRound['submittedByRole'],
    answerAttributions: projection.answerAttributions,
    draftAnswers: projection.draftAnswers,
  }
}

async function loadTaskStatusesByTaskId(
  db: PersistenceDb,
  taskIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out

  const rows = await createTaskGateQueries(db)
    .listContexts(taskIds)
    .then((rows) => rows.map((row) => ({ id: row.id, status: row.status })))
  for (const t of rows) out.set(t.id, t.status)
  return out
}

async function loadTaskNamesByTaskId(
  db: PersistenceDb,
  taskIds: string[],
): Promise<Map<string, string>> {
  // RFC-311: WHERE id IN + two-column projection. The previous shape read the
  // ENTIRE tasks table (every workflow_snapshot/inputs JSON included) on each
  // 15s inbox poll and filtered in JS — the single heaviest steady-state load
  // the audit found (L1-3); `loadTaskStatusesByTaskId` above always had the
  // correct shape.
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out
  const rows = await chunkedAll(taskIds, (ids) => {
    return createTaskGateQueries(db)
      .listContexts(ids)
      .then((rows) => rows.map((row) => ({ id: row.id, name: row.name })))
  })
  for (const t of rows) out.set(t.id, t.name)
  return out
}

async function loadNodeTitlesByTask(
  db: PersistenceDb,
  taskIds: string[],
): Promise<Map<string, Map<string, string>>> {
  // RFC-311: same WHERE id IN fix as loadTaskNamesByTaskId — this variant was
  // worse still because it JSON.parses every fetched row's workflowSnapshot.
  const out = new Map<string, Map<string, string>>()
  if (taskIds.length === 0) return out
  const taskRows = await chunkedAll(taskIds, (ids) => {
    return createTaskGateQueries(db)
      .listDefinitionContexts(ids)
      .then((rows) => rows.map((row) => ({ id: row.id, workflowSnapshot: row.workflowSnapshot })))
  })
  for (const t of taskRows) {
    const inner = new Map<string, string>()
    try {
      const def = JSON.parse(t.workflowSnapshot) as WorkflowDefinition
      for (const node of def.nodes ?? []) {
        const rec = node as Record<string, unknown>
        // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
        if (
          rec.kind !== 'agent-single' &&
          rec.kind !== 'clarify' &&
          rec.kind !== 'clarify-cross-agent'
        )
          continue
        const title = typeof rec.title === 'string' ? rec.title.trim() : ''
        if (title.length === 0) continue
        inner.set(node.id, title)
      }
    } catch {
      /* leave inner empty */
    }
    out.set(t.id, inner)
  }
  return out
}

// ---------------------------------------------------------------------------
// RFC-099 (D8/D14) — collaborative answer drafts + attribution freeze.
// All of this is UI/audit plumbing: none of these columns are read by
// buildPromptContext / buildClarifyPromptBlock (locked by the rfc099
// prompt-isolation tests).
// ---------------------------------------------------------------------------

export interface SaveClarifyDraftArgs {
  db: PersistenceDb
  /** The intermediary (clarify / clarify-cross-agent) node_run the client is on. */
  intermediaryNodeRunId: string
  roundId: string
  questionId: string
  value: ClarifyDraftValue
  editor: { userId: string; displayName: string; role: TaskActorRole }
  /**
   * RFC-359 W7 —— 草稿提交后的实时投影由装配点注入（`CollaborationClarifyDraftEventPublisher`），
   * 持久化实现不再直接够全局广播器。省略时退回内联广播，保住既有 service 层调用方。
   */
  draftEvents?: {
    publish(input: {
      readonly taskId: string
      readonly nodeRunId: string
      readonly roundId: string
      readonly questionId: string
      readonly editor: { userId: string; displayName: string; role: TaskActorRole }
      readonly occurredAt: number
    }): Promise<void>
  }
}

export interface SaveClarifyDraftResult {
  roundId: string
  questionId: string
  updatedAt: number
}

/**
 * Per-question last-write-wins draft save. The target adapter updates only that
 * question's draft and attribution, under a shared round hold. Same-question
 * races resolve to the later writer; sealing and follow-ups take the round fence.
 */
export async function saveClarifyDraft(
  args: SaveClarifyDraftArgs,
): Promise<SaveClarifyDraftResult> {
  const { taskId, updatedAt: now } = await createClarifyAnswerWritePort(args.db).saveDraft(args)
  // Live-sync other members' open forms ("X just edited question N").
  if (args.draftEvents !== undefined) {
    await args.draftEvents.publish({
      taskId,
      nodeRunId: args.intermediaryNodeRunId,
      roundId: args.roundId,
      questionId: args.questionId,
      editor: args.editor,
      occurredAt: now,
    })
  } else {
    taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
      id: -1,
      type: 'clarify.draft.updated',
      nodeRunId: args.intermediaryNodeRunId,
      roundId: args.roundId,
      questionId: args.questionId,
      editor: args.editor,
      ts: now,
    })
  }
  return { roundId: args.roundId, questionId: args.questionId, updatedAt: now }
}
