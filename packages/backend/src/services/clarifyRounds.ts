// RFC-058 T12 — unified clarify_rounds service helpers. Provides the
// kind-discriminated read APIs that the scheduler + REST routes will switch
// to in T13+. Designed for incremental migration:
//
//   - `computeHistoryCutoff` is the single backend entry point for the GENERAL
//     aging rule. Replaces the inline calculation in scheduler.ts:1372-1405.
//     `iterationField` argument lets one call cover both clarifyIteration
//     (RFC-023 self path) and crossClarifyIteration (RFC-056 cross path).
//
//   - `selectAnsweredRoundsForConsumer` reads from clarify_rounds with the
//     right WHERE clause per `consumerKind` ∈ {self | cross-designer |
//     cross-questioner}, including the wrapper-loop `loopIter` filter so the
//     RFC-056 缺口 2 (iter ≥ 2 reading prior iter Q&A) is structurally fixed.
//
//   - `buildPromptContext` composes the `ClarifyPromptContext` from the
//     selected rows, applying the GENERAL aging cutoff via shared
//     `applyAgingCutoff`. Replaces both `buildClarifyPromptContext` (RFC-023)
//     and `buildQuestionerCrossClarifyContext` (RFC-056) — three
//     consumerKind branches share one render path. The cutoff-driven aging
//     gap (RFC-056 缺口 1) is auto-fixed for cross-questioner too.
//
// Writes to clarify_rounds (createClarifyRound, submitClarifyRoundAnswers)
// land in a follow-up — for now writes still flow through the legacy
// services/clarify.ts + services/crossClarify.ts paths. The plan is to
// add a dual-write so clarify_rounds stays in sync until T17 drops the
// legacy tables.

import { and, desc, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import {
  applyAgingCutoff,
  buildClarifyPromptBlock,
  renderClarifyQuestionsBlock,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyPromptContext,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
  type ClarifyRound,
  type ClarifyRoundSummary,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('clarify-rounds')

// ---------------------------------------------------------------------------
// computeHistoryCutoff — GENERAL aging rule single source of truth.
// ---------------------------------------------------------------------------

export interface ComputeHistoryCutoffArgs {
  db: DbClient
  taskId: string
  nodeId: string
  /**
   * `'clarifyIteration'` for kind='self' rerun paths (RFC-023);
   * `'crossClarifyIteration'` for kind='cross' designer / questioner reruns
   * (RFC-056 §6 update mode + §5.4 questioner cascade).
   */
  iterationField: 'clarifyIteration' | 'crossClarifyIteration'
  /**
   * The about-to-run node_run row. Excluded from the prior lookup; also
   * supplies the freshness comparator (parent / shardKey).
   */
  currentRunRow?: typeof nodeRuns.$inferSelect
  /**
   * Shard key when the about-to-run node is an agent-multi child; null
   * otherwise. Prior runs in a different shard never feed the cutoff.
   */
  shardKey: string | null
}

/**
 * Return the iteration of the latest fresher done node_run that produced a
 * captured `<workflow-output>` row in `node_run_outputs`. Used by
 * `buildPromptContext` to drop clarify rounds whose answers are already baked
 * into a prior output (RFC-056 §6 amendment, generalised to every rerun).
 *
 * Returns `undefined` when no such prior run exists — the GENERAL no-op case
 * where the entire Q&A history should still feed the next prompt.
 *
 * Mirrors scheduler.ts:1372-1405 inline logic verbatim so the move is
 * byte-equivalent for kind='self'; the kind='cross' case (using
 * `crossClarifyIteration`) is the new GENERAL extension.
 */
export async function computeHistoryCutoff(
  args: ComputeHistoryCutoffArgs,
): Promise<number | undefined> {
  const candidates = await args.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, args.taskId), eq(nodeRuns.nodeId, args.nodeId)))

  const eligible: Array<typeof nodeRuns.$inferSelect> = []
  for (const r of candidates) {
    if (args.currentRunRow !== undefined && r.id === args.currentRunRow.id) continue
    if (r.parentNodeRunId !== null) continue
    if ((r.shardKey ?? null) !== args.shardKey) continue
    if (args.currentRunRow !== undefined && !isFresherForCutoff(args.currentRunRow, r)) continue
    eligible.push(r)
  }
  if (eligible.length === 0) return undefined

  const outputsRows = await args.db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(
      inArray(
        nodeRunOutputs.nodeRunId,
        eligible.map((r) => r.id),
      ),
    )
  const haveOutputs = new Set<string>(outputsRows.map((o) => o.nodeRunId))

  let priorCompleted: typeof nodeRuns.$inferSelect | undefined
  for (const r of eligible) {
    if (!haveOutputs.has(r.id)) continue
    if (isFresherForCutoff(r, priorCompleted)) priorCompleted = r
  }
  if (priorCompleted === undefined) return undefined

  return args.iterationField === 'clarifyIteration'
    ? priorCompleted.clarifyIteration
    : priorCompleted.crossClarifyIteration
}

/**
 * Local copy of scheduler's `isFresherNodeRun` semantics so this module
 * does not introduce a cycle with scheduler.ts. Order:
 *   1. clarifyIteration desc (newer round wins)
 *   2. retryIndex desc (later attempt wins)
 *   3. id desc (last-inserted ULID wins)
 */
function isFresherForCutoff(
  candidate: typeof nodeRuns.$inferSelect,
  incumbent: typeof nodeRuns.$inferSelect | undefined,
): boolean {
  if (incumbent === undefined) return true
  if (candidate.clarifyIteration !== incumbent.clarifyIteration) {
    return candidate.clarifyIteration > incumbent.clarifyIteration
  }
  if (candidate.retryIndex !== incumbent.retryIndex) {
    return candidate.retryIndex > incumbent.retryIndex
  }
  return candidate.id > incumbent.id
}

// ---------------------------------------------------------------------------
// selectAnsweredRoundsForConsumer — read path per consumerKind.
// ---------------------------------------------------------------------------

export type ConsumerKind = 'self' | 'cross-designer' | 'cross-questioner'

export interface SelectAnsweredRoundsArgs {
  db: DbClient
  taskId: string
  /**
   * `'self'`           → reads kind='self' rows where asking_node_id matches
   *                       (asking is the consumer). Uses shardKey filter.
   * `'cross-designer'` → reads kind='cross' rows where target_consumer_node_id
   *                       matches AND directive='continue'. One latest row
   *                       per intermediary_node_id (the cross-clarify node)
   *                       per loopIter.
   * `'cross-questioner'` → reads kind='cross' rows where asking_node_id
   *                         matches (questioner reads its own Q&A history).
   *                         Filters on loopIter so wrapper-loop iter ≥ 2
   *                         doesn't leak prior iter answers — closes the
   *                         RFC-056 缺口 2.
   */
  consumerKind: ConsumerKind
  consumerNodeId: string
  loopIter?: number
  shardKey?: string | null
}

/**
 * Pull the answered clarify_rounds rows the consumer should see this rerun,
 * before aging cutoff is applied. Rows are returned in ascending iteration
 * order so multi-round rendering reads chronologically.
 */
export async function selectAnsweredRoundsForConsumer(
  args: SelectAnsweredRoundsArgs,
): Promise<Array<typeof clarifyRounds.$inferSelect>> {
  if (args.consumerKind === 'self') {
    const rows = await args.db
      .select()
      .from(clarifyRounds)
      .where(
        and(
          eq(clarifyRounds.taskId, args.taskId),
          eq(clarifyRounds.kind, 'self'),
          eq(clarifyRounds.askingNodeId, args.consumerNodeId),
          eq(clarifyRounds.status, 'answered'),
        ),
      )
    const shardKey = args.shardKey ?? null
    return rows
      .filter((r) => (r.askingShardKey ?? null) === shardKey)
      .sort((a, b) => a.iteration - b.iteration)
  }

  if (args.consumerKind === 'cross-designer') {
    // Per-intermediary latest answered+continue row, scoped to loopIter.
    const loopIter = args.loopIter ?? 0
    const rows = await args.db
      .select()
      .from(clarifyRounds)
      .where(
        and(
          eq(clarifyRounds.taskId, args.taskId),
          eq(clarifyRounds.kind, 'cross'),
          eq(clarifyRounds.targetConsumerNodeId, args.consumerNodeId),
          eq(clarifyRounds.status, 'answered'),
          eq(clarifyRounds.directive, 'continue'),
          eq(clarifyRounds.loopIter, loopIter),
        ),
      )
    // Per intermediary node, keep only the highest-iteration row.
    const perIntermediary = new Map<string, typeof clarifyRounds.$inferSelect>()
    for (const r of rows) {
      const prior = perIntermediary.get(r.intermediaryNodeId)
      if (prior === undefined || r.iteration > prior.iteration) {
        perIntermediary.set(r.intermediaryNodeId, r)
      }
    }
    return Array.from(perIntermediary.values()).sort((a, b) =>
      a.intermediaryNodeId.localeCompare(b.intermediaryNodeId),
    )
  }

  // cross-questioner
  const loopIter = args.loopIter ?? 0
  const rows = await args.db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.kind, 'cross'),
        eq(clarifyRounds.askingNodeId, args.consumerNodeId),
        eq(clarifyRounds.status, 'answered'),
        eq(clarifyRounds.loopIter, loopIter),
      ),
    )
  return rows.sort((a, b) => a.iteration - b.iteration)
}

// ---------------------------------------------------------------------------
// buildPromptContext — replaces buildClarifyPromptContext +
// buildQuestionerCrossClarifyContext via consumerKind dispatch.
// ---------------------------------------------------------------------------

export interface BuildPromptContextArgs {
  db: DbClient
  definition: WorkflowDefinition
  taskId: string
  consumerKind: ConsumerKind
  consumerNodeId: string
  /**
   * The about-to-run node_run's iteration counter — interpretation depends on
   * consumerKind:
   *   - self           → consumer's clarifyIteration
   *   - cross-designer → consumer's crossClarifyIteration
   *   - cross-questioner → consumer's crossClarifyIteration
   * Values <= 0 short-circuit to `undefined` (first run, nothing to surface).
   */
  targetIteration: number
  /**
   * RFC-058 single aging entry. Computed by `computeHistoryCutoff`. Undefined
   * = full history.
   */
  historyCutoff?: number
  shardKey?: string | null
  loopIter?: number
  /** RFC-026 inline collapses to single-most-recent round + tags ctx.mode. */
  sessionMode?: 'isolated' | 'inline'
  /** False on review-iterate / process-retry reruns so a stale 'stop' from
   *  the prior clarify round doesn't follow into the new rerun. */
  applyLatestDirective?: boolean
}

/**
 * Compose the ClarifyPromptContext for the consumer's about-to-run prompt.
 * Returns `undefined` when there is no prior answered round to surface.
 *
 * Goes through the unified clarify_rounds table; the cutoff is applied once
 * via shared `applyAgingCutoff`. RFC-058 缺口 1 (questioner aging gap) and
 * RFC-058 缺口 2 (wrapper-loop loop_iter isolation) are both structurally
 * fixed: the cutoff + loopIter filter live in the SAME pipeline, so neither
 * branch can forget to apply them.
 */
export async function buildPromptContext(
  args: BuildPromptContextArgs,
): Promise<ClarifyPromptContext | undefined> {
  if (args.targetIteration <= 0) return undefined

  const allRows = await selectAnsweredRoundsForConsumer({
    db: args.db,
    taskId: args.taskId,
    consumerKind: args.consumerKind,
    consumerNodeId: args.consumerNodeId,
    ...(args.loopIter !== undefined ? { loopIter: args.loopIter } : {}),
    ...(args.shardKey !== undefined ? { shardKey: args.shardKey } : {}),
  })

  // Restrict to rounds whose iteration is strictly less than the consumer's
  // about-to-run iteration. Matches the RFC-023 + RFC-056 semantics
  // (iterationIndex < targetIteration).
  const priorRounds = allRows.filter((r) => r.iteration < args.targetIteration)
  if (priorRounds.length === 0) return undefined

  const postCutoffRows = applyAgingCutoff(priorRounds, args.historyCutoff)
  if (postCutoffRows.length === 0) return undefined

  const inlineMode = args.sessionMode === 'inline'
  const rows = inlineMode ? postCutoffRows.slice(-1) : postCutoffRows

  const questionParts: string[] = []
  const answerParts: string[] = []
  let latestDirective: ClarifyDirective = 'continue'
  const applyLatestDirective = args.applyLatestDirective ?? true

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    let questions: ClarifyQuestion[]
    let answers: ClarifyAnswer[]
    try {
      questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
      answers = JSON.parse(row.answersJson ?? '[]') as ClarifyAnswer[]
    } catch (err) {
      log.warn('clarify_rounds context JSON parse failed; skipping round', {
        roundId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    const isLast = i === rows.length - 1
    const directive = (row.directive ?? 'continue') as ClarifyDirective
    if (isLast && applyLatestDirective) latestDirective = directive
    const roundLabel = `### Round ${row.iteration + 1}`
    questionParts.push(`${roundLabel}\n${renderClarifyQuestionsBlock(questions)}`)
    answerParts.push(
      `${roundLabel}\n${buildClarifyPromptBlock(questions, answers, isLast && applyLatestDirective ? directive : undefined)}`,
    )
  }

  if (questionParts.length === 0) return undefined

  const ctx: ClarifyPromptContext = {
    questionsBlock: questionParts.join('\n\n'),
    answersBlock: answerParts.join('\n\n'),
    iteration: String(args.targetIteration),
    remaining: computeRemaining(args.definition, args.consumerNodeId, args.targetIteration),
    directive: latestDirective,
    ...(inlineMode ? { mode: 'inline' as const, currentRoundOnly: true } : {}),
  }
  return ctx
}

/**
 * RFC-023 design §5.6 wrapper-loop remaining counter — copied from
 * services/clarify.ts so this module stays self-contained. Returns '' when
 * the consumer is not inside an enclosing loop with a maxIterations cap.
 */
function computeRemaining(
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
  const filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desiredKind !== 'all' && r.kind !== desiredKind) return false
    if (desiredStatus !== 'all' && r.status !== desiredStatus) return false
    return true
  })
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
  return rowToDetail(row, titlesByTaskAndNode)
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
    // RFC-059 T5: parse questionScopesJson back into the DTO map. NULL or
    // parse failure → null (runtime treats null as all-designer via
    // `resolveQuestionScope`). kind='self' rows always carry null because
    // the self-clarify submit path never writes this column.
    questionScopes: parseRoundQuestionScopes(row.questionScopesJson),
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    answeredBy: row.answeredBy,
  }
}

/**
 * RFC-059 — defensive parse of `clarify_rounds.question_scopes_json` back
 * into the DTO map. NULL / parse failure / array / non-object → null.
 * Mirror of `crossClarify.ts/parseQuestionScopesJson` so the read path on
 * the unified table doesn't depend on importing it from the cross-clarify
 * service.
 */
function parseRoundQuestionScopes(raw: string | null): Record<string, ClarifyQuestionScope> | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const out: Record<string, ClarifyQuestionScope> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (v === 'designer' || v === 'questioner') out[k] = v
    }
    return out
  } catch {
    return null
  }
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
        if (
          rec.kind !== 'agent-single' &&
          rec.kind !== 'agent-multi' &&
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
