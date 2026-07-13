// RFC-132 PR-1 (T2) — the unified agent-queue selection + derived-aging helper.
//
// The DRY extraction of the ~60 duplicated lines shared by buildClarifyNodeQueueContext
// (clarifyRounds.ts, self / questioner) and buildNodeQueueExternalFeedback (crossClarify.ts,
// designer): pick a node's DISPATCHED, (sealed OR manual), UN-AGED task_questions — projected by
// effectiveTarget (override ?? default) — resolve each entry's Q&A (or manual body) for the flat
// renderer (T1), and — as an INDEPENDENT write — bind the picked entries' trigger_run_id to the
// current rerun (承接 marker).
//
// Layering (reference_binary_build_module_cycle): this module sits ABOVE clarifyRerunLedger (it
// imports isTargetNodeConsumed, the single RFC-131 derived-aging oracle) and BELOW clarifyRounds /
// crossClarify (which route through it in PR-2 / T3). It imports only schema / drizzle / util-log /
// clarifyRerunLedger / shared — no upward import — so wiring it into the two legacy injectors later
// introduces no module cycle.
//
// PR-1 lands it UNWIRED (no caller): the two legacy injectors are untouched. PR-2 (T3) drops it in
// and deletes the fork.

import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions } from '@/db/schema'
import { isTargetNodeConsumed } from '@/services/clarifyRerunLedger'
import { createLogger } from '@/util/log'
import {
  renderFlatClarifyQueue,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type FlatClarifyEntry,
  type TaskQuestionRoleKind,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

const log = createLogger('clarify-queue')

export interface SelectAgentQueueArgs {
  db: DbClient
  taskId: string
  /** The running agent node. Its "agent queue" = task_questions projected to it by
   *  effectiveTarget (override_target_node_id ?? default_target_node_id). */
  consumerNodeId: string
  /** This run's node_run id. Frames the (node, iteration) lineage window the derived-aging oracle
   *  scans, and is the trigger_run_id bindTriggerRun stamps. */
  dispatchedRunId: string
  /**
   * RFC-172 (route 2) — optional SHARD scoping for nodes whose runs fan out per shard (the
   * workgroup `__wg_member__` host node: one node, many concurrent member assignments keyed by
   * `node_runs.shard_key`). When provided (including `null`):
   *   - clarify entries are kept only if their origin round's `asking_shard_key === shardKey`;
   *   - the derived-aging window is scoped to `node_runs.shard_key === shardKey`
   *     (`null` → `IS NULL`, per the eq(col,null) hazard — memoryInject.ts:427 / clarify.ts:468).
   * `undefined` (the default, every existing caller) = today's node-only behavior —普通 agent-single
   * 节点 / leader 的单一 shard 身份零回归、golden-lock 不动。
   * Manual §15 entries are shard-AGNOSTIC (broadcast, never shard-filtered) — design §5 P2-1.
   */
  shardKey?: string | null
}

/** One un-aged entry of a node's agent queue, resolved for the flat renderer (T1). */
export interface AgentQueueEntry {
  /** task_questions.id — pass to bindTriggerRun. */
  id: string
  /** dispatched_at ordering anchor (the result is pre-sorted by dispatched_at then id). */
  dispatchedAt: number | null
  /** RFC-134 D9 — (originNodeRunId, questionId) 是渲染去重键（同题多行渲染一次、绑定全量）。 */
  questionId: string
  // 角色透传（含 RFC-134 echo）——本模块对角色**无特判**，选取/绑定/老化全角色同路径。
  roleKind: TaskQuestionRoleKind
  sourceKind: 'self' | 'cross' | 'manual'
  /** default_target_node_id — default==consumer ⟹ this node OWNS the graph round (not a
   *  pure-override handoff). RFC-141 removed the RFC-120 §18 suppressPriorOutput gate this used
   *  to drive (an override target now sees its own prior output too); kept surfaced for tests
   *  and future consumers that need the graph-owned distinction. */
  defaultTargetNodeId: string | null
  /** origin clarify round's node_run id (a §15 manual entry carries a synthetic origin) — surfaced
   *  as buildClarifyQueueContext's audit-only sourceRunIds. */
  originNodeRunId: string
  /** Render payload for renderFlatClarifyQueue: a resolved Q&A or a manual instruction. */
  render: FlatClarifyEntry
}

/**
 * Select a node's agent queue: DISPATCHED, (sealed OR manual), UN-AGED task_questions whose
 * effectiveTarget (override ?? default) is `consumerNodeId`, resolved to render-ready entries
 * (Q&A from the origin clarify round, or the manual body). PURE READ — no writes (binding is the
 * separate {@link bindTriggerRun}). Returns [] when the node has nothing to inject.
 *
 * Aging is RFC-131 derived ({@link isTargetNodeConsumed}): an entry ages out once its target
 * produced a done+output (or review-superseded canceled+output) top-level run at or after the
 * entry's trigger_run_id — read from run state, never persisted (crash-replay stable, zero schema).
 * An entry whose clarify round vanished / was canceled / abandoned / has no answers is dropped
 * (unrenderable); an all-empty manual entry is dropped too.
 *
 * Every role (self / questioner / designer) is selected in ONE query — the unified agent queue
 * (design §2 "consumerKind 消失"): no per-role SELECT fork. The sealed filter is `sealed_at IS NOT
 * NULL OR source_kind='manual'` (manual §15 carries no clarify answer / no seal but still injects
 * its manual_body).
 */
export async function selectAgentQueue(args: SelectAgentQueueArgs): Promise<AgentQueueEntry[]> {
  const { db, taskId, consumerNodeId, dispatchedRunId, shardKey } = args

  // 1. All DISPATCHED entries whose EFFECTIVE TARGET (override ?? default) is this node — every role
  //    in one query. RFC-131 T4 去借壳: select by the target the rerun is minted on (a reassign
  //    moves the run to the target node), not the origin home — reading the origin would miss a
  //    reassigned entry.
  const candidates = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        isNotNull(taskQuestions.dispatchedAt),
        or(
          eq(taskQuestions.overrideTargetNodeId, consumerNodeId),
          and(
            isNull(taskQuestions.overrideTargetNodeId),
            eq(taskQuestions.defaultTargetNodeId, consumerNodeId),
          ),
        ),
      ),
    )
  const dispatched = candidates.filter((e) => e.sealedAt !== null || e.sourceKind === 'manual')
  if (dispatched.length === 0) return []

  // 2. Frame the lineage window on this run's node + iteration (mirrors resolveHandlerRun): all of
  //    the node's runs at this iteration are the process-retry / clarify-rerun chain the derived-
  //    aging oracle scans.
  const rRow = (
    await db.select().from(nodeRuns).where(eq(nodeRuns.id, dispatchedRunId)).limit(1)
  )[0]
  const iteration = rRow?.iteration ?? 0
  const sameNode = rRow
    ? await db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            eq(nodeRuns.nodeId, consumerNodeId),
            eq(nodeRuns.iteration, iteration),
            // RFC-172 (route 2): scope the derived-aging window to this shard when the caller is
            // shard-fanned (workgroup member). Without it a sibling shard's output would age this
            // shard's entries. `null` MUST use IS NULL — `eq(col, null)` renders `= NULL` (always
            // false), the eq(col,null) hazard forked at memoryInject.ts:427 / clarify.ts:468.
            // `undefined` (普通节点/leader today) adds nothing → node-only window, golden-lock.
            ...(shardKey !== undefined
              ? [shardKey === null ? isNull(nodeRuns.shardKey) : eq(nodeRuns.shardKey, shardKey)]
              : []),
          ),
        )
    : []
  const outputRunIds = await runIdsWithOutput(
    db,
    sameNode.map((r) => r.id),
  )
  const aged = dispatched.filter(
    (e) => !isTargetNodeConsumed(consumerNodeId, iteration, e.triggerRunId, sameNode, outputRunIds),
  )
  if (aged.length === 0) return []

  // 3. Resolve each entry's render payload. Clarify entries derive (question, answer) from their
  //    origin clarify round; manual entries (§15) inject their human-authored body.
  const clarifyOriginIds = [
    ...new Set(aged.filter((e) => e.sourceKind !== 'manual').map((e) => e.originNodeRunId)),
  ]
  const roundByOrigin = new Map<
    string,
    {
      questions: Map<string, ClarifyQuestion>
      answers: Map<string, ClarifyAnswer>
      askingShardKey: string | null
    }
  >()
  for (const originId of clarifyOriginIds) {
    const round = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, originId))
        .limit(1)
    )[0]
    if (
      round === undefined ||
      round.status === 'canceled' ||
      round.status === 'abandoned' ||
      round.answersJson === null
    )
      continue
    let questions: ClarifyQuestion[]
    let answers: ClarifyAnswer[]
    try {
      questions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
      answers = JSON.parse(round.answersJson) as ClarifyAnswer[]
    } catch (err) {
      log.warn('clarify queue round JSON parse failed; skipping round', {
        roundId: round.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    roundByOrigin.set(originId, {
      questions: new Map(questions.map((q) => [q.id, q])),
      answers: new Map(answers.map((a) => [a.questionId, a])),
      askingShardKey: round.askingShardKey,
    })
  }

  const result: AgentQueueEntry[] = []
  for (const e of aged) {
    let render: FlatClarifyEntry | undefined
    if (e.sourceKind === 'manual') {
      const hasContent =
        (e.manualTitle ?? '').trim().length > 0 || (e.manualBody ?? '').trim().length > 0
      if (hasContent) render = { manualTitle: e.manualTitle, manualBody: e.manualBody }
    } else {
      const round = roundByOrigin.get(e.originNodeRunId)
      // RFC-172 (route 2): when the caller is shard-scoped (workgroup member), keep a clarify
      // entry only if its origin round was asked ON this shard — sibling shards on the shared
      // __wg_member__ node otherwise leak each other's Q&A. `shardKey === undefined` (普通节点/
      // leader today) = no shard filter, golden-lock. Manual §15 entries never reach this branch.
      if (round !== undefined && (shardKey === undefined || round.askingShardKey === shardKey)) {
        const question = round.questions.get(e.questionId)
        if (question !== undefined) render = { question, answer: round.answers.get(e.questionId) }
      }
    }
    if (render === undefined) continue
    result.push({
      id: e.id,
      dispatchedAt: e.dispatchedAt,
      questionId: e.questionId,
      roleKind: e.roleKind,
      sourceKind: e.sourceKind,
      defaultTargetNodeId: e.defaultTargetNodeId,
      originNodeRunId: e.originNodeRunId,
      render,
    })
  }

  // Stable flat order (design §5): dispatched_at then id (ULID monotonic tiebreak).
  result.sort(
    (a, b) =>
      (a.dispatchedAt ?? 0) - (b.dispatchedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return result
}

/**
 * Bind trigger_run_id = dispatchedRunId on the given entries — the 承接 marker the derived-aging
 * oracle reads next run (an entry ages out once its target produced done+output at/after this id).
 * INDEPENDENT write (split from {@link selectAgentQueue} per plan T2 so both are unit-testable).
 * Only rows NOT already pinned to dispatchedRunId are written (unbound NULLs + earlier-lineage
 * rebinds), so a re-render of the same run is idempotent (no updated_at churn). Returns the ids
 * actually bound.
 */
export async function bindTriggerRun(
  db: DbClient,
  entryIds: string[],
  dispatchedRunId: string,
): Promise<string[]> {
  if (entryIds.length === 0) return []
  const toBind = await db
    .select({ id: taskQuestions.id })
    .from(taskQuestions)
    .where(
      and(
        inArray(taskQuestions.id, entryIds),
        or(isNull(taskQuestions.triggerRunId), ne(taskQuestions.triggerRunId, dispatchedRunId)),
      ),
    )
  const ids = toBind.map((r) => r.id)
  if (ids.length === 0) return []
  await db
    .update(taskQuestions)
    .set({ triggerRunId: dispatchedRunId, updatedAt: Date.now() })
    .where(inArray(taskQuestions.id, ids))
  return ids
}

// ---------------------------------------------------------------------------
// buildClarifyQueueContext (RFC-132 PR-C / T3) — the SINGLE unified injector.
//
// Collapses the scheduler's two deferred injectors (clarifyRounds.buildClarifyNodeQueueContext
// for self / questioner + crossClarify.buildExternalFeedbackContext for the designer) into ONE
// call: select the node's whole agent queue (all roles, one query — design §2 "consumerKind 消失"),
// bind it to this rerun (承接 marker), and render the single flat `## Clarify Q&A` block (§5). A
// designer's questions land in the SAME block as self / questioner (§5 ②b render merge — no
// separate `## External Feedback`). Returns undefined when the node has nothing to inject.
// ---------------------------------------------------------------------------

export interface ClarifyQueueContext {
  /** The single flat `## Clarify Q&A` block (design §5) — inject verbatim via
   *  `ClarifyPromptContext.flatBlock`. */
  block: string
  /** The distinct origin clarify-round runs whose Q&A this block draws from (audit only — not read
   *  by any behavior gate). */
  sourceRunIds: string[]
  // RFC-141: the RFC-120 §18 `suppressPriorOutput` member is GONE (user ruling) — a pure-override
  // DESIGNER handoff now gets its own prior output injected like every other rerun; the reassigned
  // question rides the flat `## Clarify Q&A` block, and the prior-output directive's "see the
  // feedback above" points at it.
}

export interface BuildClarifyQueueContextArgs {
  db: DbClient
  /** Reserved (design §2 contract) — selection needs no definition; kept for forward-compat. */
  definition: WorkflowDefinition
  taskId: string
  /** The running agent node. */
  consumerNodeId: string
  /** This rerun's OWN node_run id — bound as the entries' trigger_run_id (承接 marker) + frames the
   *  derived-aging lineage window. */
  dispatchedRunId: string
  /** RFC-172 (route 2) — optional shard scoping, forwarded verbatim to {@link selectAgentQueue}.
   *  `undefined` (every existing caller) = node-only behavior. See SelectAgentQueueArgs.shardKey. */
  shardKey?: string | null
  /** Wrapper loopIter (design §2 — workflow loop, NOT a clarify round). Reserved; the flat queue is
   *  round-agnostic. */
  iteration: number
}

/**
 * The unified deferred clarify injector (design §2). Three steps:
 *   1. selectAgentQueue — the node's DISPATCHED, (sealed OR manual), UN-AGED task_questions across
 *      ALL roles in one query (self / questioner / designer / manual), derived-aged by the sole
 *      RFC-131 oracle. Empty ⇒ undefined.
 *   2. bindTriggerRun — stamp the picked entries' trigger_run_id to this rerun (承接 marker).
 *   3. renderFlatClarifyQueue — one flat `## Clarify Q&A` block, every question an equal peer (no
 *      rounds / scope / directive trailer / attribution — §5).
 */
export async function buildClarifyQueueContext(
  args: BuildClarifyQueueContextArgs,
): Promise<ClarifyQueueContext | undefined> {
  const { db, taskId, consumerNodeId, dispatchedRunId, shardKey } = args
  const entries = await selectAgentQueue({ db, taskId, consumerNodeId, dispatchedRunId, shardKey })
  if (entries.length === 0) return undefined
  // RFC-134 D9 — 同题同目标渲染去重（角色无关）：同一 (origin round, question) 的多行有效指向
  // 同一节点时（现状可构造：designer 条目被改派到 questioner 节点；RFC-134 新增：回执与后到的
  // 兄弟同指提问节点），Q&A 内容逐字相同（同轮 answers_json 同 qid）——渲染一次（保 dispatched_at
  // 最早序），绑定仍**全量**（下方 bindTriggerRun 传全部 id：每行独立老化/相位推进，看板不受影
  // 响）。manual 条目 origin 是合成唯一 ULID，键天然唯一、永不被去重（黄金锁）。
  const seenQuestion = new Set<string>()
  const renderEntries = entries.filter((e) => {
    const key = `${e.originNodeRunId}\x1f${e.questionId}`
    if (seenQuestion.has(key)) return false
    seenQuestion.add(key)
    return true
  })
  const block = renderFlatClarifyQueue(renderEntries.map((e) => e.render))
  if (block === undefined) return undefined // defensive: every entry rendered empty
  // 承接标记 — bind AFTER a renderable block is confirmed (mirrors the legacy injectors, which bind
  // only when they produce a context).
  await bindTriggerRun(
    db,
    entries.map((e) => e.id),
    dispatchedRunId,
  )
  return {
    block,
    sourceRunIds: [...new Set(entries.map((e) => e.originNodeRunId))],
  }
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
