// RFC-058 T12 — unified clarify_rounds service helpers. Provides the
// kind-discriminated read APIs that the scheduler + REST routes use.
//
//   - `selectAnsweredRoundsForConsumer` reads from clarify_rounds with the
//     right WHERE clause per `consumerKind` ∈ {self | cross-designer |
//     cross-questioner}, including the wrapper-loop `loopIter` filter so the
//     RFC-056 缺口 2 (iter ≥ 2 reading prior iter Q&A) is structurally fixed.
//
//   - `buildPromptContext` composes the `ClarifyPromptContext` from the
//     selected rows. Replaces both `buildClarifyPromptContext` (RFC-023)
//     and `buildQuestionerCrossClarifyContext` (RFC-056) — three
//     consumerKind branches share one render path.
//
//   - `markClarifyRoundsConsumedBy` (RFC-070) is the post-done stamp helper:
//     when a consumer agent finishes 'done' with at least one captured
//     `<workflow-output>` row, every Q&A row this run consumed has its
//     `consumed_by_..._run_id` column stamped with the run's id. The aging
//     filter then becomes a plain `IS NULL` predicate on subsequent reads,
//     eliminating the cross-iteration vs unified-clarifyIteration counter
//     mismatch class of bugs (see RFC-070 proposal §1).

import { and, desc, eq, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { clarifyRounds, clarifySessions, crossClarifySessions, tasks } from '@/db/schema'
import {
  buildClarifyPromptBlock,
  renderClarifyQuestionsBlock,
  type ClarifyAnswer,
  type ClarifyAnswerAttributions,
  type ClarifyDirective,
  type ClarifyDraftValue,
  type ClarifyPromptContext,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
  type ClarifyRound,
  type ClarifyRoundSummary,
  type TaskActorRole,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { ConflictError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('clarify-rounds')

// ---------------------------------------------------------------------------
// markClarifyRoundsConsumedBy (RFC-070) — stamp Q&A rows this run consumed.
// ---------------------------------------------------------------------------

export interface MarkClarifyRoundsConsumedByArgs {
  /** ULID of the consumer node_run that just finished 'done' with at least
   *  one captured `<workflow-output>` row. */
  id: string
  taskId: string
  /** Workflow node id of the consumer (e.g. designer agent, self-clarify
   *  asking agent, questioner asking agent on cascade rerun). */
  nodeId: string
  /** Shard key when the consumer is an agent-multi child; null otherwise.
   *  Only used to restrict self-clarify stamps to the matching shard so
   *  sibling-shard Q&A rounds aren't stamped by an unrelated shard's done. */
  shardKey: string | null
}

/**
 * Stamp `consumed_by_..._run_id` on every Q&A row this consumer node_run
 * just baked into a `<workflow-output>`. Subsequent reruns reading the same
 * tables filter on `IS NULL` — the row is gone from the prompt without any
 * counter math.
 *
 * Three predicate branches (run in one call; cheap UPDATE-where on indexed
 * columns):
 *
 *   1. Self-clarify path — the consumer IS the asking agent. Stamp every
 *      answered kind='self' row keyed on (taskId, askingNodeId, shardKey),
 *      plus its `clarify_sessions` mirror.
 *
 *   2. Cross-clarify designer path — the consumer is the designer
 *      (target_consumer_node_id). Stamp every answered+continue kind='cross'
 *      row whose target points at this node, plus its `cross_clarify_sessions`
 *      mirror.
 *
 *   3. Cross-clarify questioner path — the consumer is the questioner
 *      (asking agent) on its cascade rerun. Stamp every answered kind='cross'
 *      row whose asking points at this node, plus its `cross_clarify_sessions`
 *      mirror.
 *
 * All UPDATEs include `consumed_by_..._run_id IS NULL` so concurrent done
 * runs never double-stamp; the first run to grab a row wins.
 *
 * Call site: invoked by runner.ts at the tail of `runNode`, after
 * `setNodeRunStatus({to:'done'})` succeeds AND at least one
 * `node_run_outputs` row was just inserted. Clarify-only / no-output paths
 * do not call this helper so their rows stay consumed=NULL.
 */
export async function markClarifyRoundsConsumedBy(
  db: DbClient,
  run: MarkClarifyRoundsConsumedByArgs,
): Promise<void> {
  const shardKey = run.shardKey
  // --- 1. self-clarify (clarify_rounds + clarify_sessions mirror) ---
  await db
    .update(clarifyRounds)
    .set({ consumedByConsumerRunId: run.id })
    .where(
      and(
        eq(clarifyRounds.taskId, run.taskId),
        eq(clarifyRounds.kind, 'self'),
        eq(clarifyRounds.askingNodeId, run.nodeId),
        eq(clarifyRounds.status, 'answered'),
        isNull(clarifyRounds.consumedByConsumerRunId),
        shardKey === null
          ? isNull(clarifyRounds.askingShardKey)
          : eq(clarifyRounds.askingShardKey, shardKey),
      ),
    )
  await db
    .update(clarifySessions)
    .set({ consumedByConsumerRunId: run.id })
    .where(
      and(
        eq(clarifySessions.taskId, run.taskId),
        eq(clarifySessions.sourceAgentNodeId, run.nodeId),
        eq(clarifySessions.status, 'answered'),
        isNull(clarifySessions.consumedByConsumerRunId),
        shardKey === null
          ? isNull(clarifySessions.sourceShardKey)
          : eq(clarifySessions.sourceShardKey, shardKey),
      ),
    )
  // --- 2. cross-clarify designer (clarify_rounds + cross_clarify_sessions mirror) ---
  await db
    .update(clarifyRounds)
    .set({ consumedByConsumerRunId: run.id })
    .where(
      and(
        eq(clarifyRounds.taskId, run.taskId),
        eq(clarifyRounds.kind, 'cross'),
        eq(clarifyRounds.targetConsumerNodeId, run.nodeId),
        eq(clarifyRounds.status, 'answered'),
        eq(clarifyRounds.directive, 'continue'),
        isNull(clarifyRounds.consumedByConsumerRunId),
      ),
    )
  await db
    .update(crossClarifySessions)
    .set({ consumedByConsumerRunId: run.id })
    .where(
      and(
        eq(crossClarifySessions.taskId, run.taskId),
        eq(crossClarifySessions.targetDesignerNodeId, run.nodeId),
        eq(crossClarifySessions.status, 'answered'),
        eq(crossClarifySessions.directive, 'continue'),
        isNull(crossClarifySessions.consumedByConsumerRunId),
      ),
    )
  // RFC-120 §18 (model A, corrected): block 2b (the per-origin "round-scoped" override
  // consumption keyed on task_questions.trigger_run_id == run.id) is GONE. In the
  // corrected per-node-queue model an overridden-away question is simply absent from the
  // graph designer's queue (its effective handler is the override target, so the graph
  // designer never re-injects it — buildNodeQueueExternalFeedback selects by effective
  // handler, no graph cross_clarify_sessions read for deferred tasks). The
  // double-handling that block 2b patched can no longer occur, and consumption is now
  // per-question via the trigger_run_id BINDING stamped at the node's rerun — not a
  // whole-round stamp here (which over-consumed sibling questions of a split round).
  // --- 3. cross-clarify questioner (clarify_rounds + cross_clarify_sessions mirror) ---
  await db
    .update(clarifyRounds)
    .set({ consumedByQuestionerRunId: run.id })
    .where(
      and(
        eq(clarifyRounds.taskId, run.taskId),
        eq(clarifyRounds.kind, 'cross'),
        eq(clarifyRounds.askingNodeId, run.nodeId),
        eq(clarifyRounds.status, 'answered'),
        isNull(clarifyRounds.consumedByQuestionerRunId),
      ),
    )
  await db
    .update(crossClarifySessions)
    .set({ consumedByQuestionerRunId: run.id })
    .where(
      and(
        eq(crossClarifySessions.taskId, run.taskId),
        eq(crossClarifySessions.sourceQuestionerNodeId, run.nodeId),
        eq(crossClarifySessions.status, 'answered'),
        isNull(crossClarifySessions.consumedByQuestionerRunId),
      ),
    )
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
          // RFC-070: drop rows already baked into a prior done-with-output
          // node_run. No iteration math; the mark helper writes this stamp
          // when the consumer agent finishes 'done' with a captured port.
          isNull(clarifyRounds.consumedByConsumerRunId),
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
          // RFC-070: designer-side aging — drop rows already baked into a
          // prior designer done-with-output run.
          isNull(clarifyRounds.consumedByConsumerRunId),
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
        // RFC-070: questioner-side aging — drop rows already baked into a
        // prior questioner done-with-output run (cascade rerun path).
        isNull(clarifyRounds.consumedByQuestionerRunId),
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
   *   - cross-designer → consumer's clarifyIteration
   *   - cross-questioner → consumer's clarifyIteration
   * Values <= 0 short-circuit to `undefined` (first run, nothing to surface).
   */
  targetIteration: number
  shardKey?: string | null
  loopIter?: number
  /** RFC-026 inline collapses to single-most-recent round + tags ctx.mode. */
  sessionMode?: 'isolated' | 'inline'
  /** False on review-iterate / process-retry reruns so a stale 'stop' from
   *  the prior clarify round doesn't follow into the new rerun. */
  applyLatestDirective?: boolean
  /** RFC-122: per-(task, asking-node) clarify-directive override. When set the
   *  rendered last-round trailer AND `ctx.directive` use THIS directive instead
   *  of the answered round's own — so the on-canvas "停止反问" toggle wins over a
   *  prior "继续反问" answer (otherwise the answersBlock would still carry the
   *  contradictory KEEP CLARIFYING trailer). Only applied to the last round and
   *  only when `applyLatestDirective` is in effect, mirroring the row-directive
   *  gate. `undefined` (default) ⇒ byte-for-byte unchanged. */
  directiveOverride?: ClarifyDirective
  /** RFC-123: the toggle row's `updatedAt`. When set AND `directiveOverride` is
   *  'continue', the override (re-enable) applies ONLY if it is at least as recent
   *  as the last answered round — a stale pre-RFC-123 'continue' toggle must not
   *  re-enable a LATER 'stop' answer. A 'stop' override stays unconditional. */
  directiveOverrideAt?: number
}

/**
 * Compose the ClarifyPromptContext for the consumer's about-to-run prompt.
 * Returns `undefined` when there is no prior answered round to surface.
 *
 * RFC-070: aging is row-state (`consumed_by_..._run_id IS NULL`) rather than
 * an iteration counter cutoff. `selectAnsweredRoundsForConsumer` already
 * applies the filter; this function just renders what comes back. RFC-058
 * 缺口 1 + 2 (questioner aging gap + wrapper-loop loop_iter isolation) stay
 * structurally fixed via the per-consumerKind SELECT predicates.
 */
export async function buildPromptContext(
  args: BuildPromptContextArgs,
): Promise<ClarifyPromptContext | undefined> {
  // RFC-074 PR-C: all three consumer kinds age rounds purely by the RFC-070
  // consumed-by stamp (`consumed_by_*_run_id IS NULL`, applied in
  // selectAnsweredRoundsForConsumer) — there is no longer a cci-counter cutoff.
  // The retired `iteration < targetIteration` / `targetIteration <= 0` scoping
  // was the cross-scale comparison (round index vs the dropped clarifyIteration)
  // that silently dropped a questioner's Q&A once the downstream-cascade cci
  // bump went away (PR-B regression). Every answered-but-unconsumed round is, by
  // construction, a genuinely-prior round the rerun should see; once a rerun
  // finishes done-with-output the mark helper stamps the rows so they age out.
  const priorRounds = await selectAnsweredRoundsForConsumer({
    db: args.db,
    taskId: args.taskId,
    consumerKind: args.consumerKind,
    consumerNodeId: args.consumerNodeId,
    ...(args.loopIter !== undefined ? { loopIter: args.loopIter } : {}),
    ...(args.shardKey !== undefined ? { shardKey: args.shardKey } : {}),
  })
  if (priorRounds.length === 0) return undefined

  const inlineMode = args.sessionMode === 'inline'
  const rows = inlineMode ? priorRounds.slice(-1) : priorRounds

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
    // RFC-122: the on-canvas STOP/CONTINUE toggle (directiveOverride) takes
    // precedence over the answered round's own directive for the LAST round —
    // so a node toggled to 'stop' renders the STOP CLARIFYING trailer + reports
    // ctx.directive='stop' even if the user's last answer clicked "keep". No
    // override ⇒ `args.directiveOverride` is undefined ⇒ row directive (unchanged).
    const rowDirective = (row.directive ?? 'continue') as ClarifyDirective
    // RFC-122: the on-canvas toggle (directiveOverride) overrides the last round's
    // own directive. RFC-123: a 'continue' override (re-enable) applies ONLY when it
    // is at least as recent as this answered round — a stale pre-RFC-123 'continue'
    // toggle row must not re-enable a LATER 'stop' answer. 'stop' is unconditional
    // (RFC-122 durable); no directiveOverrideAt ⇒ no recency gate (byte-for-byte for
    // callers that don't pass it).
    let overrideApplies = isLast && args.directiveOverride !== undefined
    if (
      overrideApplies &&
      args.directiveOverride === 'continue' &&
      args.directiveOverrideAt !== undefined
    ) {
      overrideApplies = args.directiveOverrideAt >= (row.answeredAt ?? 0)
    }
    const directive = overrideApplies ? (args.directiveOverride as ClarifyDirective) : rowDirective
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
  /** This run continues a clarify round (clarify-answer rerun). */
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
