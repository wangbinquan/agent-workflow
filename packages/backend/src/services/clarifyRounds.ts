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
//   - `freezeAnswerAttributions` / `buildFrozenAttributionSet` —— 提交时点的
//     归属快照（审计列/只读 UI 用，绝不进 agent prompt）。

import { desc, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { clarifyRounds, nodeRuns, tasks } from '@/db/schema'
import {
  TERMINAL_TASK_STATUSES,
  type ClarifyAnswer,
  type ClarifyAnswerAttributions,
  type ClarifyDirective,
  type ClarifyDraftValue,
  type ClarifyQuestion,
  type ClarifyRound,
  type ClarifyRoundSummary,
  type TaskActorRole,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { ConflictError, NotFoundError } from '@/util/errors'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

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

export async function listClarifyRounds(
  db: DbClient,
  filter: ListClarifyRoundsFilter = {},
): Promise<Array<typeof clarifyRounds.$inferSelect>> {
  const all = await db.select().from(clarifyRounds).orderBy(desc(clarifyRounds.createdAt))
  const desiredKind = filter.kind ?? 'all'
  const desiredStatus = filter.status ?? 'awaiting_human'
  const filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desiredKind !== 'all' && r.kind !== desiredKind) return false
    if (desiredStatus !== 'all' && r.status !== desiredStatus) return false
    return true
  })
  return filter.limit !== undefined ? filtered.slice(0, filter.limit) : filtered
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
  db: DbClient,
  filter: ListClarifyRoundSummariesFilter = {},
): Promise<ClarifyRoundSummary[]> {
  const all = await db.select().from(clarifyRounds).orderBy(desc(clarifyRounds.createdAt))
  const desiredKind = filter.kind ?? 'all'
  const desiredStatus = filter.status ?? 'awaiting_human'
  let filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desiredKind !== 'all' && r.kind !== desiredKind) return false
    if (desiredStatus !== 'all' && r.status !== desiredStatus) return false
    return true
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
 * Fetch the ClarifyRound detail keyed by intermediary node_run id (matches
 * the REST path `/api/clarify/:nodeRunId` semantics for both kind variants).
 * Throws NotFoundError when no matching row exists.
 */
export async function getClarifyRoundDetail(
  db: DbClient,
  intermediaryNodeRunId: string,
): Promise<ClarifyRound> {
  const rows = await db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
    .orderBy(desc(clarifyRounds.createdAt))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'clarify-round-not-found',
      `no clarify_round for intermediary node_run ${intermediaryNodeRunId}`,
    )
  }
  const titlesByTaskAndNode = await loadNodeTitlesByTask(db, [row.taskId])
  const detail = rowToDetail(row, titlesByTaskAndNode)
  // RFC-202 T6 (Codex impl-gate P2): the UI must explain WHY a round was
  // sealed — inferring it from the task's MUTABLE current status misattributes
  // history (e.g. a canceled-then-retried task's abandoned round would read as
  // an autonomous dismissal). The park-carrier node_run's errorMessage records
  // the transition-time cause ('task-canceled' / 'task-done' from the terminal
  // sweep, 'wg-clarify-disabled' from the workgroup flip); expose it
  // verbatim as an optional field.
  if (row.status === 'canceled' || row.status === 'abandoned') {
    const run = (
      await db
        .select({ errorMessage: nodeRuns.errorMessage })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, intermediaryNodeRunId))
        .limit(1)
    )[0]
    if (run?.errorMessage != null && run.errorMessage !== '') {
      detail.sealedCause = run.errorMessage
    }
  }
  return detail
}

function rowToSummary(
  row: typeof clarifyRounds.$inferSelect,
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
  row: typeof clarifyRounds.$inferSelect,
  titlesByTaskAndNode: Map<string, Map<string, string>>,
): ClarifyRound {
  const titles = titlesByTaskAndNode.get(row.taskId)
  const intermediaryTitle = titles?.get(row.intermediaryNodeId)
  let questions: ClarifyQuestion[] = []
  let answers: ClarifyAnswer[] | undefined
  let truncationWarnings: ClarifyRound['truncationWarnings']
  try {
    questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  } catch {
    /* keep empty */
  }
  if (row.answersJson !== null) {
    try {
      answers = JSON.parse(row.answersJson) as ClarifyAnswer[]
    } catch {
      /* keep undefined */
    }
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
    answerAttributions: parseJsonRecord<ClarifyRound['answerAttributions']>(
      row.answerAttributionsJson,
    ),
    draftAnswers: parseJsonRecord<ClarifyRound['draftAnswers']>(row.draftAnswersJson),
  }
}

/** Defensive JSON parse → null on malformed / non-object. */
function parseJsonRecord<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

async function loadTaskStatusesByTaskId(
  db: DbClient,
  taskIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out
  const rows = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, taskIds))
  for (const t of rows) out.set(t.id, t.status)
  return out
}

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
  db: DbClient
  /** The intermediary (clarify / clarify-cross-agent) node_run the client is on. */
  intermediaryNodeRunId: string
  roundId: string
  questionId: string
  value: ClarifyDraftValue
  editor: { userId: string; displayName: string; role: TaskActorRole }
}

export interface SaveClarifyDraftResult {
  roundId: string
  questionId: string
  updatedAt: number
}

/**
 * Per-question last-write-wins draft save. The read-modify-write of the two
 * JSON columns runs inside a synchronous transaction, so concurrent saves on
 * DIFFERENT questions merge instead of clobbering each other; same-question
 * races resolve to the later writer (D14).
 */
export async function saveClarifyDraft(
  args: SaveClarifyDraftArgs,
): Promise<SaveClarifyDraftResult> {
  const rows = await args.db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, args.roundId))
    .limit(1)
  const row = rows[0]
  if (row === undefined || row.intermediaryNodeRunId !== args.intermediaryNodeRunId) {
    throw new NotFoundError('clarify-round-not-found', `clarify round '${args.roundId}' not found`)
  }
  if (row.status !== 'awaiting_human') {
    throw new ConflictError(
      'clarify-round-not-awaiting',
      `clarify round '${args.roundId}' is '${row.status}' — drafts only apply while awaiting_human`,
    )
  }
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  if (!questions.some((q) => q.id === args.questionId)) {
    throw new NotFoundError(
      'clarify-question-not-found',
      `question '${args.questionId}' not in round '${args.roundId}'`,
    )
  }
  const now = Date.now()
  dbTxSync(args.db, (tx) => {
    const fresh = tx
      .select({
        draftAnswersJson: clarifyRounds.draftAnswersJson,
        answerAttributionsJson: clarifyRounds.answerAttributionsJson,
        status: clarifyRounds.status,
      })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, args.roundId))
      .get()
    if (fresh === undefined || fresh.status !== 'awaiting_human') {
      throw new ConflictError(
        'clarify-round-not-awaiting',
        `clarify round '${args.roundId}' is no longer awaiting_human`,
      )
    }
    const drafts = parseJsonRecord<Record<string, ClarifyDraftValue>>(fresh.draftAnswersJson) ?? {}
    const attrs = parseJsonRecord<ClarifyAnswerAttributions>(fresh.answerAttributionsJson) ?? {}
    drafts[args.questionId] = args.value
    attrs[args.questionId] = { userId: args.editor.userId, role: args.editor.role, updatedAt: now }
    tx.update(clarifyRounds)
      .set({
        draftAnswersJson: JSON.stringify(drafts),
        answerAttributionsJson: JSON.stringify(attrs),
      })
      .where(eq(clarifyRounds.id, args.roundId))
      .run()
  })
  // Live-sync other members' open forms ("X just edited question N").
  taskBroadcaster.broadcast(TASK_CHANNEL(row.taskId), {
    id: -1,
    type: 'clarify.draft.updated',
    nodeRunId: args.intermediaryNodeRunId,
    roundId: args.roundId,
    questionId: args.questionId,
    editor: args.editor,
    ts: now,
  })
  return { roundId: args.roundId, questionId: args.questionId, updatedAt: now }
}

/** True when a submitted answer's user-state equals the stored draft value. */
function draftMatchesAnswer(draft: ClarifyDraftValue | undefined, answer: ClarifyAnswer): boolean {
  if (draft === undefined) return false
  const a = [...(draft.selectedOptionIndices ?? [])].sort((x, y) => x - y)
  const b = [...(answer.selectedOptionIndices ?? [])].sort((x, y) => x - y)
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) return false
  return (draft.customText ?? '') === (answer.customText ?? '')
}

/**
 * Pure attribution freeze (D8): per answered question, keep the draft's last
 * editor when the submitted value matches the draft; otherwise the submitter
 * modified it at submit time and the attribution becomes theirs.
 */
export function freezeAnswerAttributions(args: {
  answers: readonly ClarifyAnswer[]
  draftAnswers: Record<string, ClarifyDraftValue> | null
  draftAttributions: ClarifyAnswerAttributions | null
  submitter: { userId: string; role: TaskActorRole }
  now: number
}): ClarifyAnswerAttributions {
  const out: ClarifyAnswerAttributions = {}
  for (const answer of args.answers) {
    const draft = args.draftAnswers?.[answer.questionId]
    const draftAttr = args.draftAttributions?.[answer.questionId]
    if (draftAttr !== undefined && draftMatchesAnswer(draft, answer)) {
      out[answer.questionId] = draftAttr
    } else {
      out[answer.questionId] = {
        userId: args.submitter.userId,
        role: args.submitter.role,
        updatedAt: args.now,
      }
    }
  }
  return out
}

/**
 * Build the clarify_rounds `.set()` fragment that freezes attribution at
 * submit time. Reads the round's current draft columns; returns the frozen
 * attribution + cleared draft. Callers (submitClarifyAnswers /
 * submitCrossClarifyAnswers) spread it into their existing rounds update so
 * the freeze rides the same write.
 */
export async function buildFrozenAttributionSet(
  db: DbClient,
  roundId: string,
  answers: readonly ClarifyAnswer[],
  submitter: { userId: string; role: TaskActorRole },
): Promise<{
  submittedByRole: TaskActorRole
  answerAttributionsJson: string
  draftAnswersJson: null
}> {
  const rows = await db
    .select({
      draftAnswersJson: clarifyRounds.draftAnswersJson,
      answerAttributionsJson: clarifyRounds.answerAttributionsJson,
    })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, roundId))
    .limit(1)
  const row = rows[0]
  const frozen = freezeAnswerAttributions({
    answers,
    draftAnswers: parseJsonRecord<Record<string, ClarifyDraftValue>>(row?.draftAnswersJson ?? null),
    draftAttributions: parseJsonRecord<ClarifyAnswerAttributions>(
      row?.answerAttributionsJson ?? null,
    ),
    submitter,
    now: Date.now(),
  })
  return {
    submittedByRole: submitter.role,
    answerAttributionsJson: JSON.stringify(frozen),
    draftAnswersJson: null,
  }
}
