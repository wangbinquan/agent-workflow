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

import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  clarifyRounds,
  clarifySessions,
  crossClarifySessions,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
} from '@/db/schema'
import {
  buildClarifyPromptBlock,
  NEW_CLARIFY_TRIGGER_CAUSES,
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
  // RFC-128 P5-BC (clean-path ②, §5.2.3②): on a DEFERRED task, a self/questioner round that
  // went per-question DISPATCH is consumed PER-ENTRY (its trigger_run_id binding +
  // resolveDispatchedEntryHandler), NOT by this whole-round stamp — a whole-round stamp would
  // over-consume a partial round's still-undispatched sibling questions. So exclude those rounds
  // from the self/questioner whole-round stamp below. A NON-deferred task (or a deferred round
  // that never went per-question — the quick-channel immediate path) keeps the whole-round stamp
  // byte-for-byte (golden-lock). The designer block (2) is unaffected — its per-node queue never
  // reads the whole-round stamp, so the existing designer stamp is harmless.
  const deferred = await isDeferredTask(db, run.taskId)
  const excludedSelfRoundIds = deferred ? await dispatchedRoundIds(db, run.taskId, 'self') : []
  const excludedQuestionerRoundIds = deferred
    ? await dispatchedRoundIds(db, run.taskId, 'questioner')
    : []
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
        ...(excludedSelfRoundIds.length > 0
          ? [notInArray(clarifyRounds.id, excludedSelfRoundIds)]
          : []),
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
        // Legacy session shares its id with the clarify round (RFC-058 dual-write) → same
        // exclusion set keeps the two tables in lockstep (dual-write-consistency nets).
        ...(excludedSelfRoundIds.length > 0
          ? [notInArray(clarifySessions.id, excludedSelfRoundIds)]
          : []),
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
        // RFC-128 P5-BC (clean-path ②): exclude per-question DISPATCHED questioner rounds
        // (consumed per-entry, not whole-round). golden-lock for quick-channel rounds.
        ...(excludedQuestionerRoundIds.length > 0
          ? [notInArray(clarifyRounds.id, excludedQuestionerRoundIds)]
          : []),
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
        ...(excludedQuestionerRoundIds.length > 0
          ? [notInArray(crossClarifySessions.id, excludedQuestionerRoundIds)]
          : []),
      ),
    )
}

/** RFC-128 P5-BC (clean-path ②) — is the task a deferred-dispatch task? */
async function isDeferredTask(db: DbClient, taskId: string): Promise<boolean> {
  const row = (
    await db
      .select({ deferred: tasks.deferredQuestionDispatch })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  return row?.deferred === true
}

/** RFC-128 P5-BC (clean-path ②) — clarify_rounds.id of every round with ≥1 per-question
 *  DISPATCHED entry of the given self/questioner role. Those rounds are consumed PER-ENTRY
 *  (trigger_run_id), so markClarifyRoundsConsumedBy excludes them from the whole-round stamp.
 *  Keyed on `dispatched_at` (the per-question dispatch marker), matching the read-side exclusion. */
async function dispatchedRoundIds(
  db: DbClient,
  taskId: string,
  roleKind: 'self' | 'questioner',
): Promise<string[]> {
  const rows = await db
    .select({ id: clarifyRounds.id })
    .from(clarifyRounds)
    .innerJoin(
      taskQuestions,
      eq(taskQuestions.originNodeRunId, clarifyRounds.intermediaryNodeRunId),
    )
    .where(
      and(
        eq(clarifyRounds.taskId, taskId),
        eq(taskQuestions.roleKind, roleKind),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  return rows.map((r) => r.id)
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
    // RFC-128 P5-BC (clean-path, double-injection 读侧半 §5.2.5): drop any round that has a
    // per-question DISPATCHED self entry — it is now injected per-question by
    // buildClarifyNodeQueueContext, so the whole-round path must not ALSO inject it. Keyed on
    // `dispatched_at` (NOT `sealed_at`): a sealed-but-undispatched question is not yet
    // per-question injected (dispatch is what triggers it), so it must still ride the
    // whole-round path until dispatched (else it would be dropped from BOTH paths).
    const dispatchedSelfOrigins = await roundsWithDispatchedEntries(args.db, args.taskId, 'self')
    return rows
      .filter((r) => (r.askingShardKey ?? null) === shardKey)
      .filter((r) => !dispatchedSelfOrigins.has(r.intermediaryNodeRunId))
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
  // RFC-128 P5-BC (double-injection 读侧半 §5.2.5): drop any round with a per-question
  // DISPATCHED QUESTIONER entry (it is now injected per-question by buildClarifyNodeQueueContext).
  // ROLE-SPECIFIC: a dispatched DESIGNER entry of the same cross round must NOT suppress the
  // questioner's whole-round read — the designer rides its own per-node queue (P3 mainline) and
  // the questioner keeps seeing the full round until ITS OWN question is dispatched (P5-BC).
  const dispatchedQuestionerOrigins = await roundsWithDispatchedEntries(
    args.db,
    args.taskId,
    'questioner',
  )
  return rows
    .filter((r) => !dispatchedQuestionerOrigins.has(r.intermediaryNodeRunId))
    .sort((a, b) => a.iteration - b.iteration)
}

/** RFC-128 P5-BC (double-injection 读侧半 §5.2.5) — origin node-run ids of the rounds that
 *  have ≥1 per-question DISPATCHED entry of the given role (`dispatched_at IS NOT NULL`). A
 *  round in this set is injected per-question (buildClarifyNodeQueueContext), so the whole-round
 *  read path (selectAnsweredRoundsForConsumer) must exclude it — the scheduler 二选一 (XOR)
 *  read-side half. `origin_node_run_id == clarify_rounds.intermediary_node_run_id`. */
async function roundsWithDispatchedEntries(
  db: DbClient,
  taskId: string,
  roleKind: 'self' | 'questioner',
): Promise<Set<string>> {
  const rows = await db
    .select({ origin: taskQuestions.originNodeRunId })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, roleKind),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  return new Set(rows.map((r) => r.origin))
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
    const directive = resolveRoundDirective(
      row,
      isLast,
      args.directiveOverride,
      args.directiveOverrideAt,
    )
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
 * RFC-122/123 round directive resolution (extracted from buildPromptContext's loop so the
 * per-question builder below renders the trailer byte-for-byte). The on-canvas STOP/CONTINUE
 * toggle (directiveOverride) wins over the answered round's own directive for the LAST round.
 * A 'continue' override (re-enable) applies ONLY when it is at least as recent as this round
 * (RFC-123 recency gate); 'stop' is unconditional (RFC-122 durable). No override / no
 * directiveOverrideAt ⇒ byte-for-byte the row's own directive.
 */
function resolveRoundDirective(
  row: Pick<typeof clarifyRounds.$inferSelect, 'directive' | 'answeredAt'>,
  isLast: boolean,
  directiveOverride: ClarifyDirective | undefined,
  directiveOverrideAt: number | undefined,
): ClarifyDirective {
  const rowDirective = (row.directive ?? 'continue') as ClarifyDirective
  let overrideApplies = isLast && directiveOverride !== undefined
  if (overrideApplies && directiveOverride === 'continue' && directiveOverrideAt !== undefined) {
    overrideApplies = directiveOverrideAt >= (row.answeredAt ?? 0)
  }
  return overrideApplies ? (directiveOverride as ClarifyDirective) : rowDirective
}

// ---------------------------------------------------------------------------
// buildClarifyNodeQueueContext (RFC-128 P5-BC, clean-path ①) — the self/questioner
// per-question MIRROR of crossClarify.buildNodeQueueExternalFeedback, but rendered into the
// SAME ClarifyPromptContext shape buildPromptContext returns (drop-in for the scheduler's
// self / cross-questioner clarify injection). For a DEFERRED task whose asking/questioner node
// holds DISPATCHED self/questioner questions, this is the AUTHORITATIVE injection (the
// scheduler 二选一 XOR-suppresses the whole-round buildPromptContext path; the read-side
// roundsWithDispatchedEntries exclusion is the other half — §5.2.5 double-injection root-out).
// ---------------------------------------------------------------------------

export interface BuildClarifyNodeQueueContextArgs {
  db: DbClient
  definition: WorkflowDefinition
  taskId: string
  /** 'self' → self entries (asking node == consumerNodeId); 'cross-questioner' → questioner
   *  entries (questioner node == consumerNodeId). Designer uses the EF per-node queue, not this. */
  consumerKind: 'self' | 'cross-questioner'
  /** The HOME node this rerun runs on (= the run's node_id; the entry's default ?? override). */
  consumerNodeId: string
  /** This rerun's OWN node_run id — frames the lineage window (renderableForRun) + the
   *  trigger_run_id binding (per-entry consume marker, clean-path ②). */
  dispatchedRunId: string
  /** ctx.iteration (clarifyGeneration) — matches buildPromptContext's targetIteration. */
  targetIteration: number
  sessionMode?: 'isolated' | 'inline'
  applyLatestDirective?: boolean
  directiveOverride?: ClarifyDirective
  directiveOverrideAt?: number
}

/**
 * Build the self/questioner clarify ClarifyPromptContext from THIS home node's
 * dispatched-unconsumed per-question queue, and BIND that queue to the current rerun. Mirrors
 * buildNodeQueueExternalFeedback's selection + lineage window + binding, then renders via the
 * RFC-023 ClarifyPromptContext shape (so renderUserPrompt emits the same `## Clarify Q&A`
 * sections). Returns undefined when this node has no renderable per-question queue.
 *
 * Golden-lock (R2-4 注入条件 §5.2.6): when the rendered round's dispatched set covers EVERY
 * question of the round (a full-round same-batch dispatch) → render byte-for-byte the legacy
 * whole-round buildPromptContext (NO sibling/scope block). Only a PARTIAL dispatch (a sibling
 * question not in this batch) prepends a sibling-status scope block + "only this question"
 * instruction. The scope block carries ZERO attribution (RFC-099 prompt-isolation).
 */
export async function buildClarifyNodeQueueContext(
  args: BuildClarifyNodeQueueContextArgs,
): Promise<ClarifyPromptContext | undefined> {
  const roleKind = args.consumerKind === 'self' ? 'self' : 'questioner'
  // 1. Dispatched self/questioner entries whose HOME (default ?? override) is this node. RFC-127
  //    借壳: select by HOME (the borrowed run is minted on the home node), not the override.
  const candidates = await args.db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, args.taskId),
        eq(taskQuestions.roleKind, roleKind),
        isNotNull(taskQuestions.dispatchedAt),
        or(
          eq(taskQuestions.defaultTargetNodeId, args.consumerNodeId),
          and(
            isNull(taskQuestions.defaultTargetNodeId),
            eq(taskQuestions.overrideTargetNodeId, args.consumerNodeId),
          ),
        ),
      ),
    )
  if (candidates.length === 0) return undefined

  // 2. Frame the lineage window on this run's node + iteration (mirrors resolveHandlerRun /
  //    buildNodeQueueExternalFeedback): all of the node's runs at this iteration are the
  //    process-retry / clarify-rerun chain.
  const rRow = (
    await args.db.select().from(nodeRuns).where(eq(nodeRuns.id, args.dispatchedRunId)).limit(1)
  )[0]
  const sameNode = rRow
    ? await args.db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, args.taskId),
            eq(nodeRuns.nodeId, args.consumerNodeId),
            eq(nodeRuns.iteration, rRow.iteration),
          ),
        )
    : []
  const outputRunIds = await runIdsWithOutput(
    args.db,
    sameNode.map((r) => r.id),
  )
  const entries = candidates.filter((e) =>
    isQueueEntryRenderableForRun(e.triggerRunId, args.dispatchedRunId, sameNode, outputRunIds),
  )
  if (entries.length === 0) return undefined

  // 3. BIND every rendered entry not already pinned to THIS run (unbound NULLs + earlier-lineage
  //    rebinds) → the per-entry consume marker for the node's NEXT rerun + the read-side
  //    (resolveDispatchedEntryHandler). clean-path ②.
  const toBind = entries.filter((e) => e.triggerRunId !== args.dispatchedRunId).map((e) => e.id)
  if (toBind.length > 0) {
    await args.db
      .update(taskQuestions)
      .set({ triggerRunId: args.dispatchedRunId, updatedAt: Date.now() })
      .where(inArray(taskQuestions.id, toBind))
  }

  // 4. Group the queued questionIds by their origin round + render.
  const byRound = new Map<string, Set<string>>()
  for (const e of entries) {
    const set = byRound.get(e.originNodeRunId) ?? new Set<string>()
    set.add(e.questionId)
    byRound.set(e.originNodeRunId, set)
  }
  // Load the rounds in ascending iteration order (chronological, like buildPromptContext).
  const rounds: Array<typeof clarifyRounds.$inferSelect> = []
  for (const originRunId of byRound.keys()) {
    const round = (
      await args.db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, originRunId))
        .limit(1)
    )[0]
    if (
      round === undefined ||
      round.status === 'canceled' ||
      round.status === 'abandoned' ||
      round.answersJson === null
    )
      continue
    rounds.push(round)
  }
  if (rounds.length === 0) return undefined
  rounds.sort((a, b) => a.iteration - b.iteration)

  const inlineMode = args.sessionMode === 'inline'
  const renderRounds = inlineMode ? rounds.slice(-1) : rounds
  const applyLatestDirective = args.applyLatestDirective ?? true

  const questionParts: string[] = []
  const answerParts: string[] = []
  let latestDirective: ClarifyDirective = 'continue'
  for (let i = 0; i < renderRounds.length; i++) {
    const round = renderRounds[i]!
    const dispatchedIds = byRound.get(round.intermediaryNodeRunId) ?? new Set<string>()
    let allQuestions: ClarifyQuestion[]
    let allAnswers: ClarifyAnswer[]
    try {
      allQuestions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
      allAnswers = JSON.parse(round.answersJson ?? '[]') as ClarifyAnswer[]
    } catch (err) {
      log.warn('clarify node-queue context JSON parse failed; skipping round', {
        roundId: round.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    // R2-4 golden-lock: full-round same batch (every question dispatched) → render the WHOLE
    // round byte-for-byte legacy; else partial → only the dispatched subset + sibling block.
    const isFullRound = allQuestions.every((q) => dispatchedIds.has(q.id))
    const questions = isFullRound
      ? allQuestions
      : allQuestions.filter((q) => dispatchedIds.has(q.id))
    const answerById = new Map(allAnswers.map((a) => [a.questionId, a]))
    const answers = questions
      .map((q) => answerById.get(q.id))
      .filter((a): a is ClarifyAnswer => a !== undefined)
    if (questions.length === 0) continue
    const isLast = i === renderRounds.length - 1
    const directive = resolveRoundDirective(
      round,
      isLast,
      args.directiveOverride,
      args.directiveOverrideAt,
    )
    if (isLast && applyLatestDirective) latestDirective = directive
    const roundLabel = `### Round ${round.iteration + 1}`
    questionParts.push(`${roundLabel}\n${renderClarifyQuestionsBlock(questions)}`)
    const answerBody = `${roundLabel}\n${buildClarifyPromptBlock(questions, answers, isLast && applyLatestDirective ? directive : undefined)}`
    if (isFullRound) {
      answerParts.push(answerBody)
    } else {
      // Partial: prepend a sibling-status scope block (ZERO attribution — RFC-099). The agent
      // must address ONLY the dispatched question(s); siblings are handled by separate runs.
      answerParts.push(`${renderSiblingScopeBlock(allQuestions, dispatchedIds)}\n\n${answerBody}`)
    }
  }
  if (questionParts.length === 0) return undefined

  return {
    questionsBlock: questionParts.join('\n\n'),
    answersBlock: answerParts.join('\n\n'),
    iteration: String(args.targetIteration),
    remaining: computeRemaining(args.definition, args.consumerNodeId, args.targetIteration),
    directive: latestDirective,
    ...(inlineMode ? { mode: 'inline' as const, currentRoundOnly: true } : {}),
  }
}

/** RFC-128 P5-BC — the sibling-status scope block prepended to a PARTIAL per-question answers
 *  block (R2-4 §5.2.6). Lists the round's OTHER questions (not in this dispatch) with a coarse
 *  status and instructs the agent to address ONLY the dispatched question(s). Carries NO
 *  attribution / owner / role ids (RFC-099 prompt-isolation — locked by the rfc128 prompt-
 *  isolation test). */
function renderSiblingScopeBlock(
  allQuestions: ClarifyQuestion[],
  dispatchedIds: ReadonlySet<string>,
): string {
  const siblings = allQuestions.filter((q) => !dispatchedIds.has(q.id))
  const lines: string[] = [
    '### Scope of this run (partial answer)',
    '- This run addresses ONLY the question(s) shown below. The other questions of this clarify round are handled by SEPARATE runs — do NOT re-ask or re-answer them here.',
  ]
  if (siblings.length > 0) {
    lines.push('- Sibling questions (handled elsewhere — for context only):')
    for (const q of siblings) lines.push(`  - ${q.title}`)
  }
  return lines.join('\n')
}

/**
 * RFC-128 P5-BC — pure mirror of crossClarify.renderableForRun (RFC-120 §18 Codex H2): should
 * a dispatched per-question entry bound to `triggerRunId` render for run `currentRunId`?
 * `sameNode` = every node_run on the home node at the current run's iteration (the
 * process-retry / clarify-rerun chain). Renders iff: triggerRunId IS NULL (unbound → first
 * render picks + binds), OR triggerRunId is in `sameNode` AND `currentRunId` is inside
 * triggerRunId's lineage window [triggerRunId, next-clarify-rerun) AND that window has NO
 * consumed (done+output) top-level run. Replicated here (not imported) to avoid a
 * clarifyRounds↔crossClarify module cycle; both frame the SAME NEW_CLARIFY_TRIGGER_CAUSES window.
 */
function isQueueEntryRenderableForRun(
  triggerRunId: string | null,
  currentRunId: string,
  sameNode: ReadonlyArray<typeof nodeRuns.$inferSelect>,
  outputRunIds: ReadonlySet<string>,
): boolean {
  if (triggerRunId === null) return true
  const anchor = sameNode.find((r) => r.id === triggerRunId)
  if (anchor === undefined) return false // bound to a run in another frame / GC'd → not ours
  const triggerCauses = new Set<string>(NEW_CLARIFY_TRIGGER_CAUSES)
  let upperBound: string | null = null
  for (const r of sameNode) {
    if (r.id > triggerRunId && r.rerunCause !== null && triggerCauses.has(r.rerunCause)) {
      if (upperBound === null || r.id < upperBound) upperBound = r.id
    }
  }
  const inWindow = (id: string): boolean =>
    id >= triggerRunId && (upperBound === null || id < upperBound)
  if (!inWindow(currentRunId)) return false
  for (const r of sameNode) {
    if (
      r.parentNodeRunId === null &&
      inWindow(r.id) &&
      r.status === 'done' &&
      outputRunIds.has(r.id)
    )
      return false
  }
  return true
}

/** node_run ids (within `runIds`) that captured ≥1 `<workflow-output>` row. */
async function runIdsWithOutput(db: DbClient, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, runIds))
  return new Set(rows.map((r) => r.nodeRunId))
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
