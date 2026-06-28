// RFC-120 §18 (model A, corrected) — one-click batch-dispatch of deferred designer
// questions via UPSTREAM-FRONTIER mint + per-node queue (NOT the old mint-all-upfront).
//
// A deferred-dispatch task (tasks.deferred_question_dispatch) records a designer-scoped
// cross-clarify answer WITHOUT triggering the designer rerun (crossClarify
// .submitCrossClarifyAnswers → 'designer-deferred'); the round's designer task_questions
// rows are created undispatched (dispatched_at NULL) and the scheduler frontier parks the
// task awaiting_human (taskQuestions.loadUndispatchedDesignerTargets keyed on
// dispatched_at). dispatchTaskQuestions is the explicit "下发" the human triggers once the
// handlers are chosen:
//
//   1. Mark the SELECTED still-undispatched designer entries `dispatched_at` (committed
//      for execution) — this RELEASES the park (their effective handler nodes leave the
//      gate). `trigger_run_id` is NOT stamped here: binding happens at the node's RERUN
//      (buildExternalFeedbackContext), not at batch-dispatch.
//   2. Mint a rerun for ONLY the UPSTREAM FRONTIER of the affected handler-node set —
//      the affected nodes with NO affected ancestor in the dataflow DAG. A frontier node
//      A is upstream of an affected node B ⟹ mint A only; A's fresh `done` then makes B's
//      downstream draft STALE (RFC-074 provenance freshness) → the scheduler cascade
//      demotes + re-dispatches B against A's fresh output → B drains ITS queue. A and B
//      are NEVER minted-to-run simultaneously (the mint-all-upfront double-execution /
//      ordering / consumption-mismatch bugs are dissolved — §18.3).
//   3. Resume is the CALLER's job (resumeTask), mirroring the clarify route.
//
// The dispatched_at stamp + the frontier mints commit TOGETHER in one dbTxSync (a crash
// between would either strand a released-but-un-minted frontier node — its draft is fresh
// so it never re-runs — or orphan a pending rerun while the gate still parks it; a
// concurrent dispatcher's SELECT-still-NULL guard sees a short group, throws, and rolls
// the whole tx back: no stamp, no mint, no orphan). Per-target consumption / C1 graph
// exclusion / dispatch-time trigger_run_id binding are GONE — the per-node queue model
// (buildExternalFeedbackContext / markClarifyRoundsConsumedBy) replaces them.

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { evaluateDesignerRerunReadiness } from '@/services/crossClarify'
import { pickFreshestRun } from '@/services/freshness'
import { buildMintNodeRunValues } from '@/services/nodeRunMint'
import { ConflictError } from '@/util/errors'
import { createLogger } from '@/util/log'
import {
  resolveHandlerRun,
  type RunLineageView,
  type WorkflowDefinition,
  type WorkflowEdge,
} from '@agent-workflow/shared'

const log = createLogger('task-questions.dispatch')

/** Audit-only actor identity. NEVER enters a prompt (RFC-099 prompt-isolation). */
export interface DispatchTaskQuestionsActor {
  userId: string
  role: 'owner' | 'user' | 'admin'
}

export interface DispatchedRerun {
  /** Frontier handler node the rerun was minted for. */
  targetNodeId: string
  /** The freshly minted handler rerun (cause 'cross-clarify-answer', pending). */
  nodeRunId: string
  /** dispatched entry ids whose effective handler is this frontier node. */
  entryIds: string[]
}

export interface DispatchTaskQuestionsResult {
  /** The frontier reruns minted this call (downstream affected nodes are NOT here — the
   *  scheduler cascade mints them against the frontier's fresh output). */
  reruns: DispatchedRerun[]
  /** EVERY entry stamped dispatched_at this call (frontier + cascade handler nodes). */
  dispatchedEntryIds: string[]
}

type TaskQuestionRow = typeof taskQuestions.$inferSelect

const EMPTY_RESULT: DispatchTaskQuestionsResult = { reruns: [], dispatchedEntryIds: [] }

/** Thrown inside the atomic tx to roll it back when a concurrent dispatcher already
 *  claimed part of the selection (→ no stamp, no mint, no orphan). */
class ConcurrentClaim extends Error {}

/** Thrown inside the atomic tx to roll it back when a concurrent dispatch already left an
 *  OPEN (unconsumed) dispatched designer question on an affected node (→ ConflictError). */
class NodeDispatchInFlight extends Error {
  constructor(readonly nodeId: string) {
    super(`node ${nodeId} already has an open (unconsumed) dispatched designer question`)
  }
}

/** Thrown inside the atomic tx to roll it back when a concurrent reassign/reconcile moved an
 *  entry's effective target (or origin) since the mint plan was computed (→ retryable
 *  ConflictError so the caller re-plans against the new target). */
class TargetChanged extends Error {
  constructor(readonly entryId: string) {
    super(`task_question ${entryId} effective target changed since the dispatch plan was computed`)
  }
}

function parseDefinition(snapshot: string): WorkflowDefinition | null {
  try {
    return JSON.parse(snapshot) as WorkflowDefinition
  } catch {
    return null
  }
}

/** The handler that actually runs this entry: the override target if reassigned, else
 *  the graph designer (default). */
function effectiveTarget(e: TaskQuestionRow): string | null {
  return e.overrideTargetNodeId ?? e.defaultTargetNodeId
}

/** Cross-clarify / RFC-023 CHANNEL edges (injected via prompt context, not consumed as
 *  dataflow inputs) — mirrors the scheduler's buildScopeUpstreams filter, so the frontier
 *  is computed on the SAME dataflow DAG that drives RFC-074 provenance freshness (the
 *  cascade). Two agent handler nodes are never connected through a cross-clarify node
 *  (both hops are channel edges), so dropping these uniformly is exact for agent ancestry. */
function isChannelEdge(e: WorkflowEdge): boolean {
  return (
    e.source.portName === '__clarify__' ||
    e.target.portName === '__clarify_response__' ||
    e.target.portName === '__external_feedback__' ||
    e.source.portName === 'to_designer' ||
    e.source.portName === 'to_questioner'
  )
}

/** Does `node` have ANY node in `affected` as a transitive dataflow ancestor? */
function hasAffectedAncestor(
  node: string,
  upstreams: Map<string, string[]>,
  affected: ReadonlySet<string>,
  seen: Set<string> = new Set(),
): boolean {
  for (const up of upstreams.get(node) ?? []) {
    if (seen.has(up)) continue
    seen.add(up)
    if (affected.has(up)) return true
    if (hasAffectedAncestor(up, upstreams, affected, seen)) return true
  }
  return false
}

/** RFC-120 §18 — the UPSTREAM FRONTIER of `affected`: the affected nodes with NO affected
 *  node as a transitive dataflow ancestor. Only these get minted; the scheduler cascade
 *  re-dispatches the rest against the frontier's fresh output. */
function computeUpstreamFrontier(
  definition: WorkflowDefinition,
  affected: ReadonlySet<string>,
): Set<string> {
  const upstreams = new Map<string, string[]>()
  for (const e of definition.edges ?? []) {
    if (isChannelEdge(e)) continue
    const list = upstreams.get(e.target.nodeId) ?? []
    if (!list.includes(e.source.nodeId)) list.push(e.source.nodeId)
    upstreams.set(e.target.nodeId, list)
  }
  const frontier = new Set<string>()
  for (const n of affected) {
    if (!hasAffectedAncestor(n, upstreams, affected)) frontier.add(n)
  }
  return frontier
}

/**
 * Batch-dispatch the deferred designer task_questions in `entryIds`: stamp them
 * dispatched_at, mint the upstream-frontier handler reruns, leave the rest to the
 * scheduler cascade. Resume is the caller's job.
 */
export async function dispatchTaskQuestions(
  db: DbClient,
  taskId: string,
  entryIds: string[],
  actor: DispatchTaskQuestionsActor,
): Promise<DispatchTaskQuestionsResult> {
  if (entryIds.length === 0) return EMPTY_RESULT

  // 0. Batch-dispatch is ONLY valid on an opted-in deferred task. On a non-deferred task
  //    the immediate flow already minted the designer rerun, so minting again off a
  //    lazily-reconciled (NULL) entry would DOUBLE-mint. The route rejects this too; this
  //    is the defensive net for any direct service caller.
  const taskRow = (
    await db
      .select({ deferred: tasks.deferredQuestionDispatch, snapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (taskRow?.deferred !== true) {
    throw new ConflictError(
      'task-not-deferred-dispatch',
      `task ${taskId} is not a deferred-dispatch task; refusing to mint (its designer rerun already fired immediately at submit)`,
    )
  }

  // 1. The requested still-undispatched designer entries (dispatched_at IS NULL).
  const requested = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        inArray(taskQuestions.id, entryIds),
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        isNull(taskQuestions.dispatchedAt),
      ),
    )
  if (requested.length === 0) return EMPTY_RESULT

  // 2. Per-origin single-target validation — a cross round must not be split across
  //    handlers in v1 (its session is shared). Checked against ALL still-open (un-
  //    dispatched) designer entries of each TOUCHED origin, not just the requested subset
  //    (so dispatching q1→X of a round whose q2→default-designer is rejected, not silently
  //    split). Fail fast — no partial dispatch.
  const touchedOrigins = new Set(requested.map((e) => e.originNodeRunId))
  const allOpen = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        isNull(taskQuestions.dispatchedAt),
      ),
    )
  const openByOrigin = new Map<string, TaskQuestionRow[]>()
  for (const e of allOpen) {
    if (!touchedOrigins.has(e.originNodeRunId)) continue
    const list = openByOrigin.get(e.originNodeRunId) ?? []
    list.push(e)
    openByOrigin.set(e.originNodeRunId, list)
  }
  for (const [roundOrigin, roundEntries] of openByOrigin) {
    const targets = new Set(
      roundEntries.map(effectiveTarget).filter((t): t is string => t !== null),
    )
    if (targets.size > 1) {
      throw new ConflictError(
        'task-question-round-multi-target',
        `round ${roundOrigin} has open designer questions for multiple handler nodes (${[...targets].join(', ')}); a cross-clarify round is consumed as a unit in v1 — reassign its designer questions to a single handler before dispatching.`,
      )
    }
  }

  // 3. Group the requested entries by effective handler → the AFFECTED handler-node set.
  const byTarget = new Map<string, TaskQuestionRow[]>()
  for (const e of requested) {
    const t = effectiveTarget(e)
    if (t === null) continue
    const list = byTarget.get(t)
    if (list) list.push(e)
    else byTarget.set(t, [e])
  }
  if (byTarget.size === 0) return EMPTY_RESULT

  // 4. The UPSTREAM FRONTIER of the affected set (the only nodes we mint).
  const definition = parseDefinition(taskRow.snapshot)
  if (definition === null) {
    throw new ConflictError(
      'task-question-snapshot-unparseable',
      `task ${taskId} workflow snapshot is not valid JSON; cannot compute dispatch frontier`,
    )
  }
  const affected = new Set(byTarget.keys())
  const frontier = computeUpstreamFrontier(definition, affected)

  // 5. Multi-source readiness — for EVERY affected GRAPH-DESIGNER node (frontier AND
  //    non-frontier), BEFORE stamping any dispatched_at (Codex H2 re-gate). The deferred
  //    submit skipped the immediate multi-source readiness gate, so dispatch is the ONLY
  //    guard: a non-frontier affected graph designer would otherwise get dispatched_at with
  //    no check, then the scheduler cascade runs it with a sibling cross-clarify source
  //    still awaiting_human → partial feedback. assertDesignerReady self-scopes to the
  //    graph-designer subset of the group (default_target == node), so a pure-override
  //    target is a no-op (it rides the per-node queue, not the graph siblings). Reject the
  //    WHOLE dispatch if any affected graph designer isn't ready (fail fast, nothing stamped).
  for (const nodeId of affected) {
    await assertDesignerReady(db, taskId, nodeId, byTarget.get(nodeId) ?? [], definition)
  }

  // 5b. Safety (prior node_run to inherit) — on the FRONTIER nodes only (the ones we mint
  //     here). A frontier mint inherits the node's freshest run, so a never-run frontier
  //     target is rejected (safe first-run minting is the deferred F3 item). Cascade
  //     (non-frontier) affected nodes are minted by the scheduler (first-run / demote
  //     naturally), so they carry no prior-run precondition here.
  for (const nodeId of frontier) {
    await assertSafeFrontierTarget(db, taskId, nodeId)
  }

  // 5c. Codex (ship-gate) — DO NOT mint a second cross-clarify-answer rerun on a node that
  //     already holds an OPEN (unconsumed) dispatched designer question: two reruns on the
  //     same (node, iteration) conflict (ULID freshness picks the newer, the older's bound
  //     question strands; a NEWER rerun also becomes the upper bound of the prior question's
  //     lineage window, so a failed-then-revived run never re-renders its feedback). REJECT
  //     the dispatch when ANY affected target node has an open dispatched question — open ==
  //     NOT consumed, where "consumed" is the SAME resolveHandlerRun lineage the read-side
  //     uses (done+output). This covers a pending/running rerun AND a FAILED / un-run one. The
  //     user dispatches the rest AFTER that node's rerun reaches done+output (its failed run
  //     can still be revived/retried and render its feedback in the meantime).
  await assertNoInFlightDispatch(db, taskId, affected)

  // 6. Pre-compute each frontier mint's inherited values (async reads) BEFORE the tx so the
  //    tx body is purely synchronous (atomic with the dispatched_at stamp).
  const mintPlans = await Promise.all(
    [...frontier].map(async (nodeId) => buildFrontierMintPlan(db, taskId, nodeId)),
  )

  // 7. ONE dbTxSync: CAS-stamp dispatched_at on the requested entries + insert the frontier
  //    node_runs. A concurrent dispatcher that already claimed ≥1 → ConcurrentClaim →
  //    rollback (no stamp, no mint, no orphan). The open-dispatch check is RE-RUN
  //    synchronously here as the concurrency net (SAME oracle as the async pre-check): two
  //    dispatches that both pass the async check serialize at the tx — the second sees the
  //    first's freshly-committed open dispatched question and rolls back (NodeDispatchInFlight
  //    → the same ConflictError; no double-mint). It reads PRIOR dispatched entries only (this
  //    batch is stamped BELOW). Within ONE dispatch the byTarget grouping already yields
  //    exactly one rerun per node (q1+q2 to the same node → one mint plan → one rerun).
  const requestedIds = requested.map((e) => e.id)
  // Codex (ship-gate) — the snapshot the mint plan was computed from: each entry's effective
  // target (override ?? default) + origin round. A concurrent reassignTaskQuestion can change
  // override_target_node_id while dispatched_at is NULL (between this read and the tx below),
  // which would make the planned frontier mint serve a STALE handler — the entry's NEW handler
  // gets no rerun + the old node's queue won't bind it → stranded `processing`. The tx re-
  // verifies this snapshot is still current before stamping.
  const plannedByEntry = new Map(
    requested.map((e) => [e.id, { target: effectiveTarget(e), origin: e.originNodeRunId }]),
  )
  const now = Date.now()
  let committed = false
  try {
    dbTxSync(db, (tx) => {
      const stillNull = tx
        .select({
          id: taskQuestions.id,
          override: taskQuestions.overrideTargetNodeId,
          def: taskQuestions.defaultTargetNodeId,
          origin: taskQuestions.originNodeRunId,
        })
        .from(taskQuestions)
        .where(and(inArray(taskQuestions.id, requestedIds), isNull(taskQuestions.dispatchedAt)))
        .all()
      if (stillNull.length !== requestedIds.length) throw new ConcurrentClaim()
      // Re-verify the planned snapshot is unchanged (atomic with the stamp+mint). A concurrent
      // reassign/reconcile that moved any entry's effective target (or origin) → retryable
      // rollback; the caller re-plans against the new target and retries (nothing stamped/minted).
      for (const c of stillNull) {
        const planned = plannedByEntry.get(c.id)
        const curTarget = c.override ?? c.def
        if (planned === undefined || curTarget !== planned.target || c.origin !== planned.origin) {
          throw new TargetChanged(c.id)
        }
      }
      const txEntries = tx
        .select()
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.taskId, taskId),
            eq(taskQuestions.roleKind, 'designer'),
            isNotNull(taskQuestions.dispatchedAt),
          ),
        )
        .all()
      if (txEntries.length > 0) {
        const txRuns = tx.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).all()
        const outRows =
          txRuns.length === 0
            ? []
            : tx
                .select({ nodeRunId: nodeRunOutputs.nodeRunId })
                .from(nodeRunOutputs)
                .where(
                  inArray(
                    nodeRunOutputs.nodeRunId,
                    txRuns.map((r) => r.id),
                  ),
                )
                .all()
        const txOutputIds = new Set(outRows.map((r) => r.nodeRunId))
        const blocker = findOpenDispatchTarget(affected, {
          entries: txEntries,
          runs: txRuns,
          outputRunIds: txOutputIds,
        })
        if (blocker !== null) throw new NodeDispatchInFlight(blocker)
      }
      tx.update(taskQuestions)
        .set({ dispatchedAt: now, dispatchedBy: actor.userId, updatedAt: now })
        .where(and(inArray(taskQuestions.id, requestedIds), isNull(taskQuestions.dispatchedAt)))
        .run()
      for (const p of mintPlans) {
        // RFC-098 WP-10 forbids direct node_runs inserts outside the mint factory. This
        // site is SAFE: (1) the row's fields come from buildMintNodeRunValues — the SAME
        // factory mintNodeRun uses, so zero hand-copied inheritance / cause drift; (2) the
        // insert MUST be synchronous to commit atomically with the dispatched_at stamp
        // (an async mintNodeRun would yield + commit early, defeating the atomicity).
        // rfc098-allow-direct-node-run-insert
        tx.insert(nodeRuns).values(p.values).run()
      }
      committed = true
    })
  } catch (e) {
    if (e instanceof ConcurrentClaim) return EMPTY_RESULT
    if (e instanceof NodeDispatchInFlight) {
      throw new ConflictError(
        'task-question-node-dispatch-in-flight',
        `cannot dispatch to '${e.nodeId}': it already has an OPEN (unconsumed) dispatched designer question (a concurrent dispatch won). Dispatch the remaining questions after that node's rerun finishes (done with output).`,
      )
    }
    if (e instanceof TargetChanged) {
      throw new ConflictError(
        'task-question-target-changed',
        `task question ${e.entryId} was reassigned to a different handler while this dispatch was being planned. Re-run the dispatch to plan against the new target.`,
      )
    }
    throw e
  }
  if (!committed) return EMPTY_RESULT

  const reruns: DispatchedRerun[] = mintPlans.map((p) => ({
    targetNodeId: p.nodeId,
    nodeRunId: p.preId,
    entryIds: requested.filter((e) => effectiveTarget(e) === p.nodeId).map((e) => e.id),
  }))
  log.info('task questions dispatched', {
    taskId,
    actorUserId: actor.userId,
    dispatchedEntryCount: requestedIds.length,
    affectedNodeCount: affected.size,
    frontierRerunCount: reruns.length,
  })
  return { reruns, dispatchedEntryIds: requestedIds }
}

/** Minimal projection both the async pre-check and the in-tx recheck pass to the pure
 *  predicate, so "unconsumed" is defined IDENTICALLY in both (and to the read-side). */
interface OpenDispatchInputs {
  /** Every dispatched (dispatched_at-set) designer task_question of the task. */
  entries: ReadonlyArray<
    Pick<TaskQuestionRow, 'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId'>
  >
  /** Every node_run of the task. */
  runs: ReadonlyArray<typeof nodeRuns.$inferSelect>
  /** node_run ids that captured ≥1 <workflow-output> row (the "done == consumed" signal). */
  outputRunIds: ReadonlySet<string>
}

/**
 * Codex (ship-gate) — the FIRST affected node that already holds an OPEN (unconsumed)
 * dispatched designer question, or null. "Unconsumed" is the SAME oracle the read-side uses
 * (resolveHandlerRun lineage → done+output == consumed): a dispatched entry is open while it
 * is queued (trigger_run_id NULL), running, OR its handler run FAILED with no output — only a
 * done+output handler run counts as consumed. This is wider than "pending/running rerun":
 * minting a newer cross-clarify-answer rerun on the same (node, iteration) while a prior
 * dispatched question is unconsumed would make the newer run the upper bound of the prior
 * question's lineage window → a later revival/retry of the failed run never re-renders its
 * feedback → the question strands `processing` forever. So we reject the new dispatch.
 */
function findOpenDispatchTarget(
  affected: ReadonlySet<string>,
  inputs: OpenDispatchInputs,
): string | null {
  const lineageViews: RunLineageView[] = inputs.runs.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    iteration: r.iteration,
    loopIter: 0,
    rerunCause: r.rerunCause,
    status: r.status,
    startedAt: r.startedAt,
    hasOutput: inputs.outputRunIds.has(r.id),
    parentNodeRunId: r.parentNodeRunId,
  }))
  for (const e of inputs.entries) {
    const target = e.overrideTargetNodeId ?? e.defaultTargetNodeId
    if (target === null || target === '' || !affected.has(target)) continue
    if (!isDispatchedEntryConsumed(e, inputs.runs, lineageViews)) {
      return target
    }
  }
  return null
}

/** Is a dispatched designer entry CONSUMED? = its handler run, resolved through the same
 *  resolveHandlerRun lineage the read-side uses, is done WITH output (hasOutput is already
 *  folded into `lineageViews`). Queued (trigger NULL), running, failed, or GC'd anchor →
 *  NOT consumed (still open). */
function isDispatchedEntryConsumed(
  entry: Pick<TaskQuestionRow, 'triggerRunId'>,
  runs: OpenDispatchInputs['runs'],
  lineageViews: RunLineageView[],
): boolean {
  if (entry.triggerRunId === null) return false // queued (not yet bound) → open
  const anchorRow = runs.find((r) => r.id === entry.triggerRunId)
  if (anchorRow === undefined) return false // anchor GC'd → treat as open (conservative)
  const hr = resolveHandlerRun({
    effectiveTargetNodeId: anchorRow.nodeId,
    iteration: anchorRow.iteration,
    loopIter: 0,
    triggerRunId: entry.triggerRunId,
    runs: lineageViews,
  })
  return hr !== null && hr.status === 'done' && hr.hasOutput
}

/**
 * Async pre-check: reject the dispatch when ANY affected target node already has an OPEN
 * (unconsumed) dispatched designer question — covers a pending/running rerun AND a FAILED /
 * un-run one (a dispatched question whose handler run failed is still unconsumed). The user
 * dispatches the remaining questions AFTER that node's rerun reaches done+output (its failed
 * run can still be revived/retried and render its feedback in the meantime).
 */
async function assertNoInFlightDispatch(
  db: DbClient,
  taskId: string,
  affected: ReadonlySet<string>,
): Promise<void> {
  const entries = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  if (entries.length === 0) return
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  const blocker = findOpenDispatchTarget(affected, { entries, runs, outputRunIds })
  if (blocker !== null) {
    throw new ConflictError(
      'task-question-node-dispatch-in-flight',
      `cannot dispatch to '${blocker}': it already has an OPEN (unconsumed) dispatched designer question. Dispatch the remaining questions after that node's rerun finishes (done with output).`,
    )
  }
}

/** node_run ids (within `runIds`) that captured ≥1 <workflow-output> row. */
async function runIdsWithOutput(db: DbClient, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, runIds))
  return new Set(rows.map((r) => r.nodeRunId))
}

/**
 * A frontier mint inherits the node's freshest run. Reject a never-run target — safe
 * first-run minting for never-run frontier targets is the deferred F3 item (a never-run
 * NON-frontier target is fine: the scheduler first-runs it when its upstream frontier
 * completes). The old "override TO a node that itself has a feedback edge" reject is GONE:
 * the per-node queue (buildExternalFeedbackContext) injects by effective handler, so an
 * override to ANY agent node — designer or not — carries the answer without a graph edge.
 */
async function assertSafeFrontierTarget(
  db: DbClient,
  taskId: string,
  targetNodeId: string,
): Promise<void> {
  const hasRun =
    (
      await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, targetNodeId)))
        .limit(1)
    )[0] !== undefined
  if (!hasRun) {
    throw new ConflictError(
      'task-question-unsafe-dispatch-target',
      `cannot dispatch to frontier '${targetNodeId}': no prior node_run to inherit. Safe first-run minting for never-run frontier targets is the next layer (RFC-120 §16 F3).`,
    )
  }
}

/**
 * Codex H3 — a GRAPH-designer frontier dispatch must satisfy the SAME multi-source
 * readiness the immediate path enforces: every sibling cross-clarify node pointing at the
 * designer (within the round's loop_iter) must be resolved before the designer reruns.
 * Dispatching while a sibling is still awaiting_human would mint a PARTIAL rerun and force
 * a second rerun when it answers. Reject instead.
 *
 * Re-gate fix (mixed batch): the readiness gate keys on the GRAPH-DESIGNER subset of the
 * group — the entries whose `default_target_node_id == targetNodeId` (the genuine rounds
 * this node owns by graph). It must NOT be skipped just because the group ALSO contains an
 * override-TO this node (an entry whose default was elsewhere). Skip readiness only when
 * that subset is EMPTY (a pure-override group rides the per-node queue with its own
 * question set, not the graph designer's siblings).
 */
async function assertDesignerReady(
  db: DbClient,
  taskId: string,
  targetNodeId: string,
  group: TaskQuestionRow[],
  definition: WorkflowDefinition,
): Promise<void> {
  const graphSubset = group.filter((e) => e.defaultTargetNodeId === targetNodeId)
  if (graphSubset.length === 0) return // pure-override group — not the graph designer
  for (const loopIter of new Set(graphSubset.map((e) => e.loopIter))) {
    const readiness = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: targetNodeId,
      definition,
      loopIter,
    })
    if (!readiness.ready) {
      throw new ConflictError(
        'task-question-designer-not-ready',
        `cannot dispatch designer '${targetNodeId}' (loop ${loopIter}): sibling cross-clarify node(s) still awaiting an answer (${readiness.pendingCrossClarifyNodeIds.join(', ')}). Answer all of the designer's cross-clarify rounds before dispatching so it reruns with the full feedback in one batch.`,
      )
    }
  }
}

interface FrontierMintPlan {
  nodeId: string
  preId: string
  iteration: number
  values: typeof nodeRuns.$inferInsert
}

/**
 * Pre-build a frontier node's pending rerun values (cause 'cross-clarify-answer',
 * inheriting the node's freshest run, retry_index = prior-top-level-max + 1, startedAt
 * NULL) with a PREALLOCATED id, so the insert can run synchronously inside the dispatch tx.
 * Field-identical to triggerDesignerRerun's mint (both go through buildMintNodeRunValues).
 */
async function buildFrontierMintPlan(
  db: DbClient,
  taskId: string,
  targetNodeId: string,
): Promise<FrontierMintPlan> {
  const targetRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, targetNodeId)))
  const last = pickFreshestRun(targetRuns, { topLevelOnly: false })
  if (last === undefined) {
    throw new ConflictError(
      'task-question-unsafe-dispatch-target',
      `cannot dispatch to frontier '${targetNodeId}': no prior node_run to inherit`,
    )
  }
  const topLevel = targetRuns.filter(
    (r) => r.parentNodeRunId === null && r.iteration === last.iteration,
  )
  const retryIndex = topLevel.length === 0 ? 0 : Math.max(...topLevel.map((r) => r.retryIndex)) + 1
  const preId = ulid()
  const values = buildMintNodeRunValues({
    id: preId,
    taskId,
    nodeId: targetNodeId,
    status: 'pending',
    cause: 'cross-clarify-answer',
    retryIndex,
    iteration: last.iteration,
    inheritFrom: last,
    overrides: { startedAt: null },
  })
  return { nodeId: targetNodeId, preId, iteration: last.iteration, values }
}
