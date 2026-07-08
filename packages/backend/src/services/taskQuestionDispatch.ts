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

import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'
import {
  type CauseClass,
  causeClassForEntry,
  isDispatchedEntryConsumed,
} from '@/services/clarifyRerunLedger'
import { evaluateDesignerRerunReadiness } from '@/services/crossClarify'
import { pickFreshestRun } from '@/services/freshness'
import { abandonSupersededMergeStates } from '@/services/lifecycle'
import { buildMintNodeRunValues } from '@/services/nodeRunMint'
import {
  assertTaskAcceptsQuestions,
  taskNodeHasRun,
  QUESTION_DISPATCH_CLOSED_TASK_STATUSES,
} from '@/services/taskQuestions'
import { ConflictError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import {
  echoSiblingKey,
  planEchoEntries,
  type EchoPlan,
  type EchoSiblingSnapshot,
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
  /** RFC-128 P5-BC (R2-3 auto-split, §5.2.13): entries NOT dispatched this batch because their
   *  home is serializing a different cause class first (a sealed designer + sealed self on the
   *  same node). They stay STAGED — the next "批量下发" dispatches them once the first batch's
   *  rerun is done+output (the in-flight gate releases it). Empty in the common single-cause
   *  case (golden-lock). */
  deferred: Array<{ entryId: string; homeNodeId: string; reason: string }>
}

type TaskQuestionRow = typeof taskQuestions.$inferSelect

const EMPTY_RESULT: DispatchTaskQuestionsResult = {
  reruns: [],
  dispatchedEntryIds: [],
  deferred: [],
}

/** Thrown inside the atomic tx to roll it back when a concurrent dispatcher already
 *  claimed part of the selection (→ no stamp, no mint, no orphan). */
class ConcurrentClaim extends Error {}

/** Thrown inside the atomic tx to roll it back when a concurrent dispatch already left an
 *  OPEN (unconsumed) dispatched question on an affected node (→ ConflictError). RFC-133: carries
 *  the blocker run (when one exists) so the ConflictError can surface WHAT to wait for. */
class NodeDispatchInFlight extends Error {
  constructor(readonly blocker: { nodeId: string; runId?: string; runStatus?: string }) {
    super(`node ${blocker.nodeId} already has an open (unconsumed) dispatched question`)
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

// RFC-127 借壳: the "home" node a borrowed designer rerun is MINTED on (run.node_id).
// A clarify-designer keeps the GRAPH designer (default) — an override only swaps the
// brain, not the run's node; manual (no default) falls back to its override (its own
// node). This翻转s the old `override ?? default` so override no longer moves the home.
function homeTarget(e: TaskQuestionRow): string | null {
  return e.defaultTargetNodeId ?? e.overrideTargetNodeId
}

// RFC-128 P5-BC (§5.2.12 F3) — the rerun-cause class an entry's dispatch mints, derived from its
// 承接 role. CauseClass + causeClassForEntry + the immediate-ledger oracle live in
// @/services/clarifyRerunLedger (RFC-133 moved causeClassForEntry there so the queued-entry
// cause guard shares the ONE definition).
// Auto-split dispatch priority (§5.2.13): self/questioner (blocking-output, §0) BEFORE designer.
const CAUSE_PRIORITY: Record<CauseClass, number> = {
  'clarify-answer': 0,
  'cross-clarify-questioner-rerun': 1,
  'cross-clarify-answer': 2,
}

/**
 * RFC-128 P5-BC dispatch readiness gate (F2, §5.2.11). Every CLARIFY-derived requested entry
 * must be SEALED before dispatch (manual entries are always sealed — the instruction IS the
 * content). Keyed on the seal MARKER: the entry's own `sealed_at` OR its round being 'answered'
 * (a full seal backfills no per-entry sealed_at on the designer rows it creates) — NOT
 * answerSummary (a partial round leaves it unreliable, Codex F3). Throws (fail-fast precondition,
 * nothing stamped) when ANY requested clarify entry is unsealed.
 */
async function assertRequestedEntriesSealed(
  db: DbClient,
  requested: TaskQuestionRow[],
): Promise<void> {
  const clarifyEntries = requested.filter((e) => e.sourceKind !== 'manual')
  const unsealed = clarifyEntries.filter((e) => e.sealedAt === null)
  if (unsealed.length === 0) return
  // The remaining (sealed_at NULL) entries may still be on a fully-answered round (full seal
  // backfills no per-entry sealed_at). Resolve those rounds; only entries on a non-answered
  // round are genuinely unsealed.
  const originIds = Array.from(new Set(unsealed.map((e) => e.originNodeRunId)))
  const rounds = await db
    .select({
      origin: clarifyRounds.intermediaryNodeRunId,
      status: clarifyRounds.status,
    })
    .from(clarifyRounds)
    .where(inArray(clarifyRounds.intermediaryNodeRunId, originIds))
  const answeredOrigins = new Set(
    rounds.filter((r) => r.status === 'answered').map((r) => r.origin),
  )
  const stillUnsealed = unsealed.filter((e) => !answeredOrigins.has(e.originNodeRunId))
  if (stillUnsealed.length > 0) {
    throw new ConflictError(
      'task-question-not-sealed',
      `cannot dispatch ${stillUnsealed.length} question(s) (${stillUnsealed
        .map((e) => e.id)
        .join(
          ', ',
        )}): their answer is not sealed yet. Seal (answer) every question before dispatching it.`,
    )
  }
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
  // RFC-140 W2 (Codex design-gate rounds 3-4): the QUESTION-WRITE lock (B) is acquired HERE —
  // around the WHOLE read→plan→stamp pipeline — not just the stamp+mint tx. The auto-dispatch
  // deferred marker is stamped from the pre-tx `deferredEntries` plan; with the lock only on the
  // tx, a stage/unstage could interleave between the plan read and the stamp and resurrect a
  // withdrawn dispatch intent (a millisecond-timestamp CAS was rejected as the guard — same-ms
  // unstage+re-stage collides). Lock discipline: callers MUST NOT hold lock B when calling this
  // (the semaphore is non-reentrant); stageTaskQuestion takes the same lock (RFC-140).
  return await getTaskQuestionWriteSem(taskId).run(() =>
    dispatchTaskQuestionsLocked(db, taskId, entryIds, actor),
  )
}

/** RFC-140 W2 (Codex impl-gate P1) — the auto-redispatch entry: SELECT the auto-split-deferred
 *  set (marker + undispatched + still staged) and dispatch it in ONE lock-B holding. The tick's
 *  select and the dispatch MUST share the lock: a pre-selected id list handed to the public
 *  dispatchTaskQuestions would race a concurrent unstage — the withdrawn entry's marker/staged
 *  are cleared, but dispatch filters on neither, so the stale id would still dispatch withdrawn
 *  work. Returns EMPTY_RESULT when nothing is queued. */
export async function dispatchDeferredTaskQuestions(
  db: DbClient,
  taskId: string,
  actor: DispatchTaskQuestionsActor,
  opts?: {
    /** Codex impl-gate round-2 P2 — when the dispatch fails with a ConflictError whose code
     *  this predicate accepts, clear the markers of THIS attempt's selected ids INSIDE the same
     *  lock-B holding (then rethrow). Clearing after the lock is released races a queued user
     *  dispatch that stamps FRESH markers — a task-wide post-hoc clear would wipe those too. */
    clearMarkersOn?: (conflictCode: string) => boolean
  },
): Promise<DispatchTaskQuestionsResult> {
  return await getTaskQuestionWriteSem(taskId).run(async () => {
    const deferred = await db
      .select({ id: taskQuestions.id })
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.taskId, taskId),
          isNotNull(taskQuestions.autoDispatchDeferredAt),
          isNull(taskQuestions.dispatchedAt),
          isNotNull(taskQuestions.stagedAt),
        ),
      )
    if (deferred.length === 0) return EMPTY_RESULT
    const ids = deferred.map((d) => d.id)
    try {
      return await dispatchTaskQuestionsLocked(db, taskId, ids, actor)
    } catch (err) {
      if (
        err instanceof ConflictError &&
        opts?.clearMarkersOn !== undefined &&
        opts.clearMarkersOn(err.code)
      ) {
        await db
          .update(taskQuestions)
          .set({ autoDispatchDeferredAt: null, updatedAt: Date.now() })
          .where(and(inArray(taskQuestions.id, ids), isNull(taskQuestions.dispatchedAt)))
      }
      throw err
    }
  })
}

async function dispatchTaskQuestionsLocked(
  db: DbClient,
  taskId: string,
  entryIds: string[],
  actor: DispatchTaskQuestionsActor,
): Promise<DispatchTaskQuestionsResult> {
  // 0. RFC-132 PR-B (universal deferred model): every task dispatches through this ONE path now
  //    (the route routes ALL clarify answers to autoDispatchClarifyRound → dispatchTaskQuestions).
  //    The legacy immediate-mint path is route-unreachable, so there is no double-mint risk to gate
  //    against; the `deferredQuestionDispatch` flag is no longer read. Only the not-found + terminal
  //    guards remain.
  const taskRow = (
    await db
      .select({
        snapshot: tasks.workflowSnapshot,
        status: tasks.status,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  // RFC-120 §15 (Codex re-gate): reject on a TERMINAL task (done/canceled) BEFORE stamping
  // dispatched_at or minting any node_run — a finished task has no scheduler to run the rerun
  // (resumeTask can't resume done/canceled), so a mint here would strand a pending rerun.
  assertTaskAcceptsQuestions(taskId, taskRow.status)

  // 1. The requested still-undispatched entries (dispatched_at IS NULL). RFC-128 P5-BC: the
  //    designer-only filter is GONE — self/questioner entries dispatch too. Role-specific gating
  //    (readiness, single-cause, single-borrow, in-flight, mint cause) is applied below.
  const requested = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        inArray(taskQuestions.id, entryIds),
        eq(taskQuestions.taskId, taskId),
        isNull(taskQuestions.dispatchedAt),
        // RFC-128 P5-BC §5.2.14 step 2 — skip SUPERSEDED entries. A quick whole-round finalize marks
        // its round's sealed-undispatched self/q entries `confirmation='confirmed'` (their answer is
        // already in the whole-round continuation); re-dispatching one would double-execute. Normal
        // entries are 'open' at dispatch time (confirmTaskQuestion only runs post-handler), so this
        // is golden-lock for every non-superseded dispatch.
        eq(taskQuestions.confirmation, 'open'),
      ),
    )
  if (requested.length === 0) return EMPTY_RESULT

  // 1a. RFC-128 P5-BC dispatch readiness gate (F2, §5.2.11): every CLARIFY-derived requested
  //     entry must be SEALED before dispatch — otherwise a not-yet-answered question would be
  //     dispatched + bound (no answer exists) → an empty rerun that also suppresses the whole-
  //     round path (read-side dispatched exclusion). Self/questioner entries are reconciled
  //     UNCONDITIONALLY (not seal-gated like designer), so this is the real guard the broadening
  //     needs. Keyed on `sealed_at` (or the whole round 'answered' — a full seal backfills no
  //     per-entry sealed_at on designer rows) — NOT answerSummary (unreliable on a partial round,
  //     Codex F3). Manual entries are always sealed (no clarify round). Fail-fast (precondition).
  await assertRequestedEntriesSealed(db, requested)

  // 2. Per-origin single-target validation — a cross round must not be split across
  //    handlers in v1 (its session is shared). Checked against ALL still-open (un-
  //    dispatched) designer entries of each TOUCHED origin, not just the requested subset
  //    (so dispatching q1→X of a round whose q2→default-designer is rejected, not silently
  //    split). Fail fast — no partial dispatch.
  //
  //    RFC-128 P5-BC (Codex impl-gate, F4 mixed-role scoping): this is a DESIGNER-only constraint
  //    (the designer session is consumed as a unit). Scope it to the origins of the requested
  //    DESIGNER entries — NOT all requested origins. After the designer-only filter was removed
  //    from `requested`, a pure self/questioner dispatch from a cross round would otherwise pull in
  //    that round's split/undispatched DESIGNER entries and reject — even though the questioner
  //    rerun neither consumes nor mints them. A pure self/questioner dispatch carries no designer
  //    multi-target constraint.
  const touchedDesignerOrigins = new Set(
    requested.filter((e) => e.roleKind === 'designer').map((e) => e.originNodeRunId),
  )
  const allOpen =
    touchedDesignerOrigins.size === 0
      ? []
      : await db
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
    if (!touchedDesignerOrigins.has(e.originNodeRunId)) continue
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

  // 3. Group the requested entries by (TARGET node, rerun-cause class). RFC-131 T4 去借壳: mint the
  //    rerun on the EFFECTIVE TARGET (override ?? default) — a reassign MOVES the run to the target
  //    node, which runs its OWN agent (no RFC-127 借壳). A non-reassigned entry (override NULL) has
  //    effectiveTarget == default, so it still mints on the origin designer (golden-lock unchanged).
  //    RFC-128 P5-BC: the cause class (self→clarify-answer / questioner→cross-clarify-questioner-rerun
  //    / designer→cross-clarify-answer) discriminates which entries can share ONE rerun — a single
  //    node_run carries ONE rerun_cause (§5.2.12 F3), so different causes on the same target are
  //    SEPARATE reruns that must serialize, never collapse.
  const byHomeCause = new Map<string, Map<CauseClass, TaskQuestionRow[]>>()
  for (const e of requested) {
    const home = effectiveTarget(e)
    if (home === null) continue
    const cause = causeClassForEntry(e)
    const causes = byHomeCause.get(home) ?? new Map<CauseClass, TaskQuestionRow[]>()
    const list = causes.get(cause) ?? []
    list.push(e)
    causes.set(cause, list)
    byHomeCause.set(home, causes)
  }
  if (byHomeCause.size === 0) return EMPTY_RESULT

  // 4a. RFC-131 T4 去借壳: NO single-borrow gate. Pre-131 a (home, cause) group minted ONE borrowed
  //     rerun that ran ONE agent, so a group naming >1 agent was rejected (task-question-home-multi-
  //     borrow). De-borrow keys the group on the EFFECTIVE TARGET and mints on that node running its
  //     OWN agent — every reassigned question goes to its own target (never sharing one rerun's
  //     borrowed agent), so the gate is obsolete. A mixed native+reassigned group on one target all
  //     rides that target's per-node queue (buildNodeQueueExternalFeedback) into its single rerun.

  // 4b. RFC-128 P5-BC route auto-split (R2-3, §5.2.13): a home with MIXED cause classes (e.g. a
  //     sealed self question + a sealed designer question both staged onto the same node) cannot
  //     dispatch both in one batch — they are separate reruns with mutually-exclusive causes
  //     (§5.2.12). Because §11.1 made "批量下发 = ALL staged" (no per-card checkbox),整批 reject
  //     would dead-loop the user (全量提交 → 全量 reject). Instead AUTO-SPLIT: dispatch ONE cause
  //     class per home this batch, DEFER the rest (stays staged). Each home keeps ≥1 cause, so the
  //     affected-home set is UNCHANGED (only WHICH entries on a home dispatch changes). The next
  //     "批量下发" dispatches the deferred cause once the first batch's rerun is done+output (the
  //     in-flight gate releases it). Manual/single-cause homes are a no-op (golden-lock).
  //
  //     R3-2 (Codex design gate round 3, anti-starvation FAIRNESS): the cause to dispatch is the
  //     one whose OLDEST queued entry is oldest (aging by `staged_at ?? created_at`). A fixed
  //     "self/questioner ALWAYS first" order would starve an older delayed designer if a NEW
  //     same-home self/questioner keeps getting (re-)staged after each batch — the next "all
  //     staged" would forever re-pick self/questioner. Aging guarantees the delayed cause wins
  //     once its entries are older than the newcomers. Ties (equal age) break to self/questioner
  //     first (§0 blocking-output) so a fresh mixed batch keeps the intended ordering.
  const dispatchEntries: TaskQuestionRow[] = []
  const deferredEntries: Array<{ entryId: string; homeNodeId: string; reason: string }> = []
  const byTarget = new Map<string, TaskQuestionRow[]>()
  for (const [home, causes] of byHomeCause) {
    // Aging key per cause = the OLDEST queued entry's (staged_at ?? created_at). The cause with
    // the smallest key (oldest waiting) is dispatched first; CAUSE_PRIORITY tiebreaks equal ages.
    const causeAge = (cause: CauseClass): number =>
      Math.min(...causes.get(cause)!.map((e) => e.stagedAt ?? e.createdAt))
    const sortedCauses = [...causes.keys()].sort((a, b) => {
      const ageDiff = causeAge(a) - causeAge(b)
      return ageDiff !== 0 ? ageDiff : CAUSE_PRIORITY[a] - CAUSE_PRIORITY[b]
    })
    const selected = sortedCauses[0]!
    byTarget.set(home, causes.get(selected)!)
    for (const cause of sortedCauses) {
      if (cause === selected) {
        dispatchEntries.push(...causes.get(cause)!)
      } else {
        for (const e of causes.get(cause)!) {
          deferredEntries.push({
            entryId: e.id,
            homeNodeId: home,
            reason: `node '${home}' is dispatching a different question type first (${selected}); dispatch this one after that rerun finishes (done with output).`,
          })
        }
      }
    }
  }

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
  //     uses. This covers a pending/running rerun AND a FAILED one.
  //     RFC-133 (live deadlock QMGP5): a QUEUED (trigger NULL) entry is open only while its
  //     target owes a RUN OBLIGATION (non-done top-level run) or this batch mints an ALIEN
  //     cause there — a never-run / all-done target releases (its next run binds the queue).
  //     mintCauseByTarget = the cause this batch mints per FRONTIER node (non-frontier
  //     affected nodes are not minted here → pure run-obligation check for them).
  const mintCauseByTarget: ReadonlyMap<string, CauseClass> = new Map(
    [...frontier].map((n) => [n, causeClassForEntry(byTarget.get(n)![0]!)]),
  )
  await assertNoInFlightDispatch(db, taskId, affected, mintCauseByTarget)
  // (RFC-132 ③: the 5d immediate-ledger precheck is gone with the immediate quick channel.)

  // 6. Pre-compute each frontier mint's inherited values (async reads) BEFORE the tx so the
  //    tx body is purely synchronous (atomic with the dispatched_at stamp).
  const mintPlans = await Promise.all(
    // RFC-131 T4 去借壳: NO borrow — the rerun is minted ON the effective target, which runs its OWN
    // agent (pass null, never an agent_override_name). RFC-128 P5-BC: pass the target's ROLE-derived
    // rerun cause (auto-split guarantees one cause per target this batch) + the parsed definition.
    [...frontier].map(async (nodeId) =>
      buildFrontierMintPlan(
        db,
        taskId,
        nodeId,
        null,
        causeClassForEntry(byTarget.get(nodeId)![0]!),
        definition,
      ),
    ),
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
  // RFC-128 P5-BC: stamp + plan only the AUTO-SPLIT-selected entries (dispatchEntries), not the
  // full requested set — the deferred (lower-cause) entries stay staged for a follow-up batch.
  const dispatchIds = dispatchEntries.map((e) => e.id)
  // Codex (ship-gate) — the snapshot the mint plan was computed from: each entry's effective
  // target (override ?? default) + origin round. A concurrent reassignTaskQuestion can change
  // override_target_node_id while dispatched_at is NULL (between this read and the tx below),
  // which would make the planned frontier mint serve a STALE handler — the entry's NEW handler
  // gets no rerun + the old node's queue won't bind it → stranded `processing`. The tx re-
  // verifies this snapshot is still current before stamping.
  const plannedByEntry = new Map(
    dispatchEntries.map((e) => [e.id, { target: effectiveTarget(e), origin: e.originNodeRunId }]),
  )
  const now = Date.now()
  let committed = false
  // RFC-134: 本批物化的回执计划（tx 内赋值、commit 后 log 用）。
  let echoPlans: EchoPlan[] = []
  try {
    // RFC-128 §5.2.14 final-gate (user-authorized): the per-task QUESTION-WRITE lock (B) protects
    // this stamp+mint tx from a clarify/cross-clarify SUBMIT's {precheck→rollback→tx} interleave —
    // closing the submit-side stale-precheck/rollback-clobber + double-mint window. B only
    // (dispatch never touches the worktree / never runs an agent → no worktree write lock A
    // needed). Lock order: dispatch takes B alone; the submit takes A ≻ B; no B→A here → no
    // deadlock. RFC-140 W2: the lock is now acquired at the dispatchTaskQuestions ENTRY (whole
    // read→plan→stamp pipeline) — see the wrapper above; this block runs lock-held.
    {
      dbTxSync(db, (tx) => {
        // (Codex re-gate H2): the terminal pre-check (assertTaskAcceptsQuestions, above) is a
        // TOCTOU window — the scheduler can trySetTaskStatus(done/canceled) between it and this
        // tx. Re-read tasks.status INSIDE the tx and roll back the WHOLE tx (no stamp, no mint)
        // if the task went terminal, so nothing is minted onto a finished task. Reuses the SAME
        // terminal set as the pre-check (no drift).
        const curTask = tx
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .all()[0]
        if (curTask === undefined || QUESTION_DISPATCH_CLOSED_TASK_STATUSES.has(curTask.status)) {
          throw new ConflictError(
            'task-terminal',
            `task ${taskId} became ${curTask?.status ?? 'missing'} before dispatch committed; nothing stamped or minted`,
          )
        }
        const stillNull = tx
          .select({
            id: taskQuestions.id,
            override: taskQuestions.overrideTargetNodeId,
            def: taskQuestions.defaultTargetNodeId,
            origin: taskQuestions.originNodeRunId,
          })
          .from(taskQuestions)
          // RFC-128 P5-BC §5.2.14 (Codex impl-gate finding B): the CAS re-checks `confirmation='open'`
          // too, NOT just `dispatched_at IS NULL`. A quick whole-round finalize that committed between
          // the async `requested` read and this tx CONSUMES (confirms) the round's sealed-undispatched
          // self/q entries; once its continuation is done+output the open-ledger recheck no longer
          // blocks, so without this predicate a now-confirmed entry would still pass the CAS (its
          // `dispatched_at` is still NULL) and get stamped/minted → duplicate rerun. A confirmed entry
          // now shrinks `stillNull` → ConcurrentClaim → whole-tx rollback (nothing stamped/minted).
          .where(
            and(
              inArray(taskQuestions.id, dispatchIds),
              isNull(taskQuestions.dispatchedAt),
              eq(taskQuestions.confirmation, 'open'),
            ),
          )
          .all()
        if (stillNull.length !== dispatchIds.length) throw new ConcurrentClaim()
        // Re-verify the planned snapshot is unchanged (atomic with the stamp+mint). A concurrent
        // reassign/reconcile that moved any entry's effective target (or origin) → retryable
        // rollback; the caller re-plans against the new target and retries (nothing stamped/minted).
        for (const c of stillNull) {
          const planned = plannedByEntry.get(c.id)
          const curTarget = c.override ?? c.def
          if (
            planned === undefined ||
            curTarget !== planned.target ||
            c.origin !== planned.origin
          ) {
            throw new TargetChanged(c.id)
          }
        }
        // In-tx in-flight recheck (synchronous concurrency net, SAME oracles as the async prechecks)
        // — re-run BOTH ledger gates inside the tx so a concurrent dispatch / quick-channel answer
        // committed between the prechecks and here can't slip a double-mint past. Fetch the task's
        // runs + output ids ONCE for both.
        const txRuns = tx.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).all()
        const txOutputIds: ReadonlySet<string> =
          txRuns.length === 0
            ? new Set<string>()
            : new Set(
                tx
                  .select({ nodeRunId: nodeRunOutputs.nodeRunId })
                  .from(nodeRunOutputs)
                  .where(
                    inArray(
                      nodeRunOutputs.nodeRunId,
                      txRuns.map((r) => r.id),
                    ),
                  )
                  .all()
                  .map((r) => r.nodeRunId),
              )
        // (a) RFC-128 P5-BC (R2-2, §5.2.12 contract 3): the in-flight recheck spans ANY deferred role
        //     (self/questioner/designer) DISPATCHED entry — the cross-batch serialization half.
        //     RFC-134 D4：白名单**有意**不含 'echo'——回执不 mint、无 rerun_cause，是 cause 序列化
        //     的显式豁免项（queued 回执绝不 409 阻塞后续任何下发）。不得「顺手」扩入（源码文本锁）。
        const txDispatched = tx
          .select()
          .from(taskQuestions)
          .where(
            and(
              eq(taskQuestions.taskId, taskId),
              inArray(taskQuestions.roleKind, ['self', 'questioner', 'designer']),
              isNotNull(taskQuestions.dispatchedAt),
            ),
          )
          .all()
        if (txDispatched.length > 0) {
          const blocker = findOpenDispatchTarget(
            affected,
            {
              entries: txDispatched,
              runs: txRuns,
              outputRunIds: txOutputIds,
            },
            mintCauseByTarget,
          )
          if (blocker !== null) throw new NodeDispatchInFlight(blocker)
        }
        // RFC-132 ③: the in-tx IMMEDIATE (quick-channel) recheck is GONE with the immediate
        // ledger — nothing mints quick continuations anymore (autoDispatchClarifyRound is the
        // only answer path and it dispatches), so the dispatched-ledger recheck above is complete.
        tx.update(taskQuestions)
          .set({ dispatchedAt: now, dispatchedBy: actor.userId, updatedAt: now })
          // §5.2.14 finding B: confirmation='open' mirrors the CAS guard — never stamp a SUPERSEDED
          // (quick-finalize-confirmed) entry (the CAS above already threw ConcurrentClaim if any
          // dispatchId got confirmed; this keeps the write itself self-consistent).
          .where(
            and(
              inArray(taskQuestions.id, dispatchIds),
              isNull(taskQuestions.dispatchedAt),
              eq(taskQuestions.confirmation, 'open'),
            ),
          )
          .run()
        // RFC-140 W2 — stamp the auto-serial redispatch marker on the auto-split-DEFERRED entries
        // (same tx = atomic with the batch's dispatched_at stamp; lock B is held across the whole
        // read→plan→stamp pipeline, so the plan cannot be stale vs a concurrent stage/unstage).
        // The user expressed dispatch intent for the WHOLE batch; the scheduler tick auto-
        // dispatches these once their home's in-flight rerun finishes. dispatched_at IS NULL
        // keeps a concurrently-claimed row inert (its marker would be inert anyway).
        if (deferredEntries.length > 0) {
          tx.update(taskQuestions)
            .set({ autoDispatchDeferredAt: now, updatedAt: now })
            .where(
              and(
                inArray(
                  taskQuestions.id,
                  deferredEntries.map((d) => d.entryId),
                ),
                isNull(taskQuestions.dispatchedAt),
              ),
            )
            .run()
        }
        for (const p of mintPlans) {
          // RFC-144 D12: same abandon-before-insert invariant as mintNodeRun —
          // this sync-mint escape hatch is the ONE insert path outside the
          // factory, so it carries the same supersede retirement in the same tx.
          abandonSupersededMergeStates({
            db: tx,
            taskId: p.values.taskId,
            nodeId: p.values.nodeId,
            iteration: p.values.iteration ?? 0,
            supersededByRunId: p.values.id,
          })
          // RFC-098 WP-10 forbids direct node_runs inserts outside the mint factory. This
          // site is SAFE: (1) the row's fields come from buildMintNodeRunValues — the SAME
          // factory mintNodeRun uses, so zero hand-copied inheritance / cause drift; (2) the
          // insert MUST be synchronous to commit atomically with the dispatched_at stamp
          // (an async mintNodeRun would yield + commit early, defeating the atomicity).
          // rfc098-allow-direct-node-run-insert
          tx.insert(nodeRuns).values(p.values).run()
        }
        // RFC-134 §3.1 — seal 行戳归一化（Codex R5-F9）：本批 stamp 的 clarify 行若 sealed_at
        // NULL（能过 assertRequestedEntriesSealed 只因源轮已 answered——契约 #17「已下发 ≠
        // 可渲染」），同事务补行戳，凡下发必可被 selectAgentQueue 渲染（顺带修 pre-existing
        // 「懒建行下发给承接方后永不注入」投递洞）。sealed_by 留 NULL =「answered 轮证据落戳」
        // 的审计语义（非人工 seal）；manual 不补（无 seal 概念）；已 sealed 不改写（黄金锁）；
        // 历史已下发行不追溯（forward-only）。
        tx.update(taskQuestions)
          .set({ sealedAt: now, updatedAt: now })
          .where(
            and(
              inArray(taskQuestions.id, dispatchIds),
              isNull(taskQuestions.sealedAt),
              ne(taskQuestions.sourceKind, 'manual'),
            ),
          )
          .run()
        // RFC-134 §3.2-3.3 — 改派回执（asker echo）：对「有效承接 ≠ 提问节点」的 self/questioner
        // 条目物化 roleKind='echo' 回执行——目标=提问节点、生来已下发、trigger NULL 排队，等提
        // 问节点下次自然运行由统一注入器平铺注入（**不 mint**、不入 frontier/守卫——D1/D4 豁免，
        // 见 design §4）。identity (origin, question, 'echo') 唯一索引 + onConflictDoNothing 保
        // crash-retry 幂等。兄弟跳过判定（交付感知+可渲染性+stampedIds 单值化）在纯 oracle 内。
        const batchOrigins = [...new Set(dispatchEntries.map((e) => e.originNodeRunId))]
        const siblingRows =
          batchOrigins.length === 0
            ? []
            : tx
                .select({
                  id: taskQuestions.id,
                  originNodeRunId: taskQuestions.originNodeRunId,
                  questionId: taskQuestions.questionId,
                  defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
                  overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
                  dispatchedAt: taskQuestions.dispatchedAt,
                  sealedAt: taskQuestions.sealedAt,
                  sourceKind: taskQuestions.sourceKind,
                })
                .from(taskQuestions)
                .where(
                  and(
                    eq(taskQuestions.taskId, taskId),
                    inArray(taskQuestions.originNodeRunId, batchOrigins),
                  ),
                )
                .all()
        const siblingsByQuestion = new Map<string, EchoSiblingSnapshot[]>()
        for (const s of siblingRows) {
          const key = echoSiblingKey(s.originNodeRunId, s.questionId)
          const list = siblingsByQuestion.get(key)
          if (list) list.push(s)
          else siblingsByQuestion.set(key, [s])
        }
        echoPlans = planEchoEntries({
          batch: dispatchEntries,
          siblingsByQuestion,
          stampedIds: new Set(dispatchIds),
          batchTimestamp: now,
        })
        for (const p of echoPlans) {
          tx.insert(taskQuestions)
            .values({
              id: ulid(),
              taskId,
              originNodeRunId: p.originNodeRunId,
              questionId: p.questionId,
              questionTitle: p.questionTitle,
              sourceKind: p.sourceKind,
              roleKind: 'echo',
              iteration: p.iteration,
              loopIter: p.loopIter,
              defaultTargetNodeId: p.targetNodeId,
              overrideTargetNodeId: null,
              dispatchedAt: now,
              dispatchedBy: actor.userId,
              sealedAt: p.sealedAt,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({
              target: [
                taskQuestions.originNodeRunId,
                taskQuestions.questionId,
                taskQuestions.roleKind,
              ],
            })
            .run()
        }
        committed = true
      })
    }
  } catch (e) {
    if (e instanceof ConcurrentClaim) return EMPTY_RESULT
    if (e instanceof NodeDispatchInFlight) {
      throw new ConflictError(
        'task-question-node-dispatch-in-flight',
        `cannot dispatch to '${e.blocker.nodeId}': it has an unfinished rerun obligation${
          e.blocker.runStatus !== undefined
            ? ` (run ${e.blocker.runId}: ${e.blocker.runStatus})`
            : ''
        } or an open dispatched question of a different kind (a concurrent dispatch won). Dispatch the remaining questions after that node's run finishes.`,
        e.blocker,
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
    entryIds: dispatchEntries.filter((e) => effectiveTarget(e) === p.nodeId).map((e) => e.id),
  }))
  log.info('task questions dispatched', {
    taskId,
    actorUserId: actor.userId,
    dispatchedEntryCount: dispatchIds.length,
    deferredEntryCount: deferredEntries.length,
    affectedNodeCount: affected.size,
    frontierRerunCount: reruns.length,
  })
  // RFC-134 §3.6 — 回执审计 log（提问节点零 mint，仅入队）。
  for (const p of echoPlans) {
    log.info('reassign echo queued for asking node', {
      taskId,
      askerNodeId: p.targetNodeId,
      originNodeRunId: p.originNodeRunId,
      questionId: p.questionId,
    })
  }
  return { reruns, dispatchedEntryIds: dispatchIds, deferred: deferredEntries }
}

/** Minimal projection both the async pre-check and the in-tx recheck pass to the pure
 *  predicate, so "unconsumed" is defined IDENTICALLY in both (and to the read-side). */
interface OpenDispatchInputs {
  /** Every dispatched (dispatched_at-set) task_question of the task. */
  entries: ReadonlyArray<
    Pick<
      TaskQuestionRow,
      'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind' | 'sourceKind'
    >
  >
  /** Every node_run of the task. */
  runs: ReadonlyArray<typeof nodeRuns.$inferSelect>
  /** node_run ids that captured ≥1 <workflow-output> row (the "done == consumed" signal). */
  outputRunIds: ReadonlySet<string>
}

/** RFC-133: the blocker surfaced by the in-flight gate — the node plus (when one exists) the
 *  open run the user is actually waiting on, so the 409 is actionable. */
interface OpenDispatchBlocker {
  nodeId: string
  runId?: string
  runStatus?: string
}

/**
 * Codex (ship-gate) — the FIRST affected node that already holds an OPEN (unconsumed)
 * dispatched question, or null. "Unconsumed" is the SAME oracle the read-side uses
 * (resolveHandlerRun lineage): a dispatched entry is open while its handler run is
 * pending/running, or FAILED (revivable — a newer mint would clobber its lineage window).
 * RFC-133: a QUEUED (trigger NULL) entry is open only while its target owes a run obligation
 * (non-done top-level run) or `mintCauseByTarget` says this batch mints an ALIEN cause there
 * (Codex design-gate P2) — a never-run / all-done target no longer wedges the dispatch
 * (isDispatchedEntryConsumed §RFC-133).
 */
function findOpenDispatchTarget(
  affected: ReadonlySet<string>,
  inputs: OpenDispatchInputs,
  /** cause this batch will mint per FRONTIER node; absent key = no mint on that node. */
  mintCauseByTarget: ReadonlyMap<string, CauseClass>,
): OpenDispatchBlocker | null {
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
    // RFC-131 T4 去借壳: in-flight is tracked on the EFFECTIVE TARGET (override ?? default) — the
    // node where the rerun is minted (a reassign moves the run to the target, not the origin home).
    const target = e.overrideTargetNodeId ?? e.defaultTargetNodeId
    if (target === null || target === '' || !affected.has(target)) continue
    if (
      !isDispatchedEntryConsumed(
        e,
        inputs.runs,
        lineageViews,
        'in-flight',
        mintCauseByTarget.get(target),
      )
    ) {
      // Best-effort blocker run: the open (non-done top-level) run on the target — present for
      // the run-obligation & bound-handler cases, absent for a pure cause-serialization block.
      const blockerRun = inputs.runs.find(
        (r) => r.nodeId === target && r.parentNodeRunId === null && r.status !== 'done',
      )
      return blockerRun !== undefined
        ? { nodeId: target, runId: blockerRun.id, runStatus: blockerRun.status }
        : { nodeId: target }
    }
  }
  return null
}

/**
 * Async pre-check: reject the dispatch when ANY affected target node already has an OPEN
 * (unconsumed) dispatched question — a pending/running/FAILED handler rerun, a queued entry
 * whose target still owes a run obligation, or a queued entry this batch would collapse into
 * an alien-cause mint (RFC-133). The user dispatches the remaining questions AFTER that
 * node's open run finishes.
 */
async function assertNoInFlightDispatch(
  db: DbClient,
  taskId: string,
  affected: ReadonlySet<string>,
  mintCauseByTarget: ReadonlyMap<string, CauseClass>,
): Promise<void> {
  // RFC-128 P5-BC (R2-2, §5.2.12 contract 3): span ANY deferred role (self/questioner/designer),
  // not designer-only — a home with an in-flight self/questioner dispatch must block a later
  // designer dispatch (and vice-versa), or the same-home reruns double-mint (cross-batch
  // serialization). isDispatchedEntryConsumed / findOpenDispatchTarget are already role-agnostic
  // (they key on the HOME = default ?? override + trigger_run_id lineage).
  const entries = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        // RFC-134 D4：白名单**有意**不含 'echo'（序列化豁免——queued 回执绝不阻塞下发）；
        // 不得「顺手」扩入（源码文本锁）。
        inArray(taskQuestions.roleKind, ['self', 'questioner', 'designer']),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  if (entries.length === 0) return
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  const blocker = findOpenDispatchTarget(
    affected,
    { entries, runs, outputRunIds },
    mintCauseByTarget,
  )
  if (blocker !== null) {
    throw new ConflictError(
      'task-question-node-dispatch-in-flight',
      `cannot dispatch to '${blocker.nodeId}': it has an unfinished rerun obligation${
        blocker.runStatus !== undefined ? ` (run ${blocker.runId}: ${blocker.runStatus})` : ''
      } or an open dispatched question of a different kind. Dispatch the remaining questions after that node's run finishes.`,
      blocker,
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

/** RFC-127 借壳: a borrowed override entry is "home" on `nodeId` when its run is minted
 *  there (home = default ?? override) and the override genuinely names a DIFFERENT node
 *  whose agent is borrowed. Shared by the designer + self/questioner resolvers. */
function isBorrowHomeFor(e: TaskQuestionRow, nodeId: string): boolean {
  const home = homeTarget(e)
  return home === nodeId && e.overrideTargetNodeId !== null && e.overrideTargetNodeId !== home
}

/** RFC-127 借壳: resolve a node's agentName from the frozen workflow snapshot (the SAME
 *  source canReassign validated against). null = unresolvable / non-agent node. */
function resolveNodeAgentName(def: WorkflowDefinition, nodeId: string): string | null {
  return (
    ((def.nodes ?? []).find((n) => n.id === nodeId) as { agentName?: string } | undefined)
      ?.agentName ?? null
  )
}

/**
 * RFC-127 borrow authority for scheduler dispatch.
 *
 * Two ledgers feed the SAME scheduler borrow point (scheduler.runOneNode), because the
 * two reassign flows consume on different signals:
 *   - **designer** (deferred dispatch): the durable source is the node's still-open
 *     dispatched task_question (dispatched_at + trigger_run_id consumption) — queued /
 *     failed => keep open for retry/revival; done (regardless of output — RFC-139) =>
 *     consumed; non-frontier cascade mint => resolve this home node's own queued one.
 *     Keyed on task_questions.loop_iter (= round.loop_iter, the real wrapper-loop index for
 *     cross rounds).
 *   - **self / questioner** (immediate clarify-round continuation): the entry never
 *     touches dispatched_at; consumption rides the round's RFC-070 stamp (round-based,
 *     resolveImmediateBorrowForNode). Keyed on the round's ASKING run iteration (self rows
 *     project loop_iter=0, so loop_iter can't gate the wrapper loop — P2-3).
 *
 * The scheduler resolves the agent BEFORE the pending row's rerun cause is known (and a
 * retry/revival loses the original clarify cause), so it cannot tell a clarify-answer /
 * questioner rerun (immediate ledger) from a cross-clarify-answer designer dispatch (designer
 * ledger). The two ledgers must therefore NOT both claim the same home at the same iteration —
 * if they do, the borrowed agent is ambiguous and we reject (P2-2). Throws ConflictError on an
 * unresolvable borrow (multi-borrow within a home — P2-1; or dual-ledger overlap — P2-2); the
 * scheduler converts it to a node-level failure.
 */
/** RFC-128 P5-BC (Codex impl-gate, §5.2.3④ run-self) — a ledger's OPEN status + its borrow.
 *  Distinguishes the THREE states the multi-ledger reject needs: CLOSED (no open rerun), OPEN
 *  RUN-SELF (an open rerun that runs the home's OWN agent — no borrow), OPEN BORROWED (an open
 *  rerun that borrows X). The early `string | null` shape conflated CLOSED with OPEN-RUN-SELF
 *  (both null), so a run-self ledger went UNCOUNTED — a run-self ledger + another open ledger on
 *  the same home escaped the reject (two separate pending reruns → duplicate execution). */
interface LedgerResolution {
  /** An open (unconsumed) pending/in-flight rerun exists for this ledger on (home, iteration). */
  open: boolean
  /** The borrowed agentName (null = run the home's OWN agent). Meaningful only when `open`. */
  borrowAgentName: string | null
  /** RFC-139 ②: the open BOUND entries' trigger_run_ids — the ledger's 承接锚 (handler-chain
   *  anchors). Queued entries mint NO anchor (not yet on any chain). Two open ledgers whose
   *  anchor sets INTERSECT share one handler chain (bindTriggerRun rebinds every injected entry
   *  across ledgers to the same run): one pending rerun serves both — NOT duplicate execution. */
  anchorRunIds: ReadonlySet<string>
}
const CLOSED_LEDGER: LedgerResolution = {
  open: false,
  borrowAgentName: null,
  anchorRunIds: new Set(),
}

/** Human-readable ledger state for the conflict error (audit-only; no attribution). */
function ledgerDesc(l: LedgerResolution): string {
  if (!l.open) return '(none)'
  return l.borrowAgentName !== null ? `→ ${l.borrowAgentName}` : 'open (run self)'
}

export async function resolveBorrowForNode(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
  workflowDef: WorkflowDefinition,
): Promise<string | null> {
  // Hot-path gate: both remaining ledgers (designer + deferred self/questioner) are
  // dispatched-only — a task with NO dispatched entries has no ledger at all → no borrow, no
  // conflict. (RFC-132 ③: the immediate quick-channel ledger is gone; RFC-131 T4 already made
  // both dispatched ledgers move-semantics, so borrowAgentName is structurally null — the
  // remaining value of this resolver is the multi-ledger duplicate-execution reject below.)
  const hasDispatched =
    (
      await db
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), isNotNull(taskQuestions.dispatchedAt)))
        .limit(1)
    )[0] !== undefined
  if (!hasDispatched) return null

  // Dispatched entries exist → FULL open-detection on both ledgers (counting OPEN RUN-SELF).
  const designer = await resolveDesignerBorrowForNode(db, taskId, nodeId, iteration, workflowDef)
  // RFC-128 P5-BC (clean-path ④ / §5.2.12 F3): the THIRD ledger — control-channel DISPATCHED
  // self/questioner reruns (deferred per-question dispatch; dispatched_at + trigger_run_id
  // consumption, mirroring the designer ledger but keyed by the asking run's iteration for the
  // self loop_iter=0 projection — P2-3).
  const deferredSelfQ = await resolveDeferredSelfQuestionerBorrowForNode(
    db,
    taskId,
    nodeId,
    iteration,
    workflowDef,
  )
  // P2-2 (Codex impl-gate, 2 rounds) + RFC-128 §5.2.12 F3 (collapse 推翻, dual→triple ledger) +
  // Codex impl-gate run-self fix (§5.2.3④): two reruns OPEN on the SAME home+iteration across ANY
  // two ledgers are SEPARATE pending node_runs with MUTUALLY-EXCLUSIVE causes (clarify-answer /
  // cross-clarify-questioner-rerun [isClarifyRerun TRUE] vs cross-clarify-answer [FALSE]).
  // runOneNode consumes/binds by NODE, not by ledger — the first run to fire binds, and the other
  // pending row runs later as stale duplicate work (or orphans, per ULID order). So EVEN when two
  // ledgers borrow the SAME agent — OR when one (or both) is OPEN RUN-SELF (no borrow) — the
  // EXECUTION is ambiguous (duplicate work) AND a single node_run carries ONE rerun_cause that
  // cannot serve two roles. Reject by counting OPEN ledgers (NOT non-null borrow agents — that
  // early shape missed open run-self). The borrow returned is the single open ledger's (null =
  // run self). The user serializes them (dispatch single-cause gate + the in-flight gate).
  //
  // RFC-139 ② (anchor coalescing): duplicate execution is a property of HANDLER CHAINS, not
  // ledger count. Once a released rerun starts, buildClarifyQueueContext → bindTriggerRun rebinds
  // EVERY injected entry (across both ledgers) to that one run; if it then fails / is interrupted,
  // both ledgers point at the SAME chain — its revival is ONE rerun serving both, and killing it
  // here would dead-loop every revival attempt (QMGP5 post-bind shape, Codex design-gate P1). So
  // reject only when the open ledgers' anchor sets are DISJOINT (incl. an all-queued ledger, whose
  // empty anchor set means its rerun is NOT yet on the other ledger's chain — the dual-queued /
  // hand-crafted divergent-bound shapes stay rejected).
  const openLedgers = [designer, deferredSelfQ].filter((l) => l.open)
  if (openLedgers.length > 1) {
    const [a, b] = openLedgers as [LedgerResolution, LedgerResolution]
    const coalesced = [...a.anchorRunIds].some((id) => b.anchorRunIds.has(id))
    if (!coalesced) {
      throw new ConflictError(
        'task-question-borrow-ledger-conflict',
        `node '${nodeId}' (iter ${iteration}) has multiple open reassignment ledgers (dispatched designer ${ledgerDesc(designer)}, dispatched self/questioner ${ledgerDesc(deferredSelfQ)}); they are separate pending reruns with mutually-exclusive causes that would duplicate execution — resolve / serialize them before the node reruns.`,
      )
    }
  }
  return openLedgers[0]?.borrowAgentName ?? null
}

/**
 * RFC-128 P5-BC (clean-path ④, §5.2.12 F3) — the deferred self/questioner borrow ledger.
 * Control-channel DISPATCHED self/questioner reruns (dispatched_at set by dispatchTaskQuestions),
 * mirroring resolveDesignerBorrowForNode's `isDispatchedEntryConsumed` consumption (dispatched_at
 * + trigger_run_id lineage → done = consumed regardless of output [RFC-139]; queued/failed = keep
 * open). Unlike the designer ledger (keyed on task_questions.loop_iter), self rows project
 * loop_iter=0, so the wrapper-loop iteration is matched via the round's ASKING run iteration
 * (P2-3, same as the immediate ledger). Single-borrow gate (P2-1) rejects a home reassigned to
 * conflicting agents in one continuation. Returns the borrowed agentName, or null.
 */
async function resolveDeferredSelfQuestionerBorrowForNode(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
  workflowDef: WorkflowDefinition,
): Promise<LedgerResolution> {
  // Control-channel DISPATCHED self/questioner entries (dispatched_at set). Include no-override
  // rows so a "borrow X + run self" mix on one home is DETECTED (P2-1), not first-picked, AND so
  // an OPEN RUN-SELF dispatch is counted as an open ledger (Codex impl-gate run-self fix).
  const entries = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        inArray(taskQuestions.roleKind, ['self', 'questioner']),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  // RFC-131 T4 去借壳: match on the EFFECTIVE TARGET (override ?? default) — a reassigned entry's
  // rerun is minted on the target node, so its ledger belongs to the target, not the origin home.
  const homeEntries = entries.filter((e) => effectiveTarget(e) === nodeId)
  if (homeEntries.length === 0) return CLOSED_LEDGER
  // NB: NO "no borrow → return early" fast path — we must read to detect an OPEN RUN-SELF ledger
  // (the early fast path returned null for run-self → it went uncounted in the multi-ledger reject).

  const rounds = await db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, taskId),
        inArray(
          clarifyRounds.intermediaryNodeRunId,
          homeEntries.map((e) => e.originNodeRunId),
        ),
      ),
    )
  const roundByOrigin = new Map(rounds.map((r) => [r.intermediaryNodeRunId, r]))
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const runById = new Map(runs.map((r) => [r.id, r]))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  const lineageViews: RunLineageView[] = runs.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    iteration: r.iteration,
    loopIter: 0,
    rerunCause: r.rerunCause,
    status: r.status,
    startedAt: r.startedAt,
    hasOutput: outputRunIds.has(r.id),
    parentNodeRunId: r.parentNodeRunId,
  }))
  // OPEN (unconsumed) home entries at THIS loop iteration, matched via the asking run (P2-3),
  // consumed via the dispatched-entry lineage (isDispatchedEntryConsumed, same oracle the
  // read-side resolveDispatchedEntryHandler + park source use).
  const open = homeEntries.filter((e) => {
    const round = roundByOrigin.get(e.originNodeRunId)
    if (round === undefined) return false
    const askingRun = runById.get(round.askingNodeRunId)
    if (askingRun === undefined || askingRun.iteration !== iteration) return false
    return !isDispatchedEntryConsumed(e, runs, lineageViews, 'revivable')
  })
  if (open.length === 0) return CLOSED_LEDGER

  const borrows = new Set(
    open.map((e) => (isBorrowHomeFor(e, nodeId) ? e.overrideTargetNodeId : null)),
  )
  if (borrows.size > 1) {
    throw new ConflictError(
      'task-question-home-multi-borrow',
      `node '${nodeId}' (iter ${iteration}) has dispatched self/questioner questions reassigned to conflicting handlers (${[
        ...borrows,
      ]
        .map((b) => b ?? '(self)')
        .join(
          ', ',
        )}) in one continuation; a single rerun runs one agent — align them to one handler.`,
    )
  }
  // Ledger is OPEN (≥1 unconsumed dispatched entry). Borrow = the single named agent, or null
  // (run self) — both are an OPEN ledger that the multi-ledger reject must count.
  const borrowNode = [...borrows][0] ?? null
  return {
    open: true,
    borrowAgentName: borrowNode === null ? null : resolveNodeAgentName(workflowDef, borrowNode),
    // RFC-139 ②: open BOUND entries' triggers = this ledger's handler-chain anchors (queued → none).
    anchorRunIds: new Set(
      open.map((e) => e.triggerRunId).filter((id): id is string => id !== null),
    ),
  }
}

/**
 * RFC-127 designer borrow (deferred dispatch ledger). Consumption is dispatched_at +
 * trigger_run_id (isDispatchedEntryConsumed); keyed on task_questions.loop_iter (= round.loop_iter,
 * the real wrapper-loop index for cross rounds).
 *
 * Codex impl-gate run-self fix (§5.2.3④): selects ALL dispatched designer home entries — NOT only
 * `override IS NOT NULL` ones. The early override-only filter MISSED a run-self designer dispatch
 * (no override) → it was reported CLOSED even when it was an open pending rerun, so a run-self
 * designer + another open ledger on one home escaped the multi-ledger reject. Now an OPEN run-self
 * designer dispatch is reported `{ open: true, borrowAgentName: null }`.
 */
async function resolveDesignerBorrowForNode(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
  workflowDef: WorkflowDefinition,
): Promise<LedgerResolution> {
  const entries = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        eq(taskQuestions.loopIter, iteration),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  // RFC-131 T4 去借壳: EFFECTIVE TARGET match (override ?? default == nodeId) — includes run-self
  // designer dispatches (override NULL), so an open run-self designer ledger is counted. A reassigned
  // entry's ledger belongs to the target node (where its rerun is minted), not the origin home.
  const candidates = entries.filter((e) => effectiveTarget(e) === nodeId)
  if (candidates.length === 0) return CLOSED_LEDGER

  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  const lineageViews: RunLineageView[] = runs.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    iteration: r.iteration,
    loopIter: 0,
    rerunCause: r.rerunCause,
    status: r.status,
    startedAt: r.startedAt,
    hasOutput: outputRunIds.has(r.id),
    parentNodeRunId: r.parentNodeRunId,
  }))
  const openCandidates = candidates
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((e) => !isDispatchedEntryConsumed(e, runs, lineageViews, 'revivable'))
  if (openCandidates.length === 0) return CLOSED_LEDGER
  // The dispatch per-home single-borrow gate (dispatchTaskQuestions step 4a) ensures the open
  // designer entries on a home agree on ONE handler (one rerun runs one agent). Pick the borrowed
  // one if any (else all run-self → null). The ledger is OPEN either way.
  const borrowEntry = openCandidates.find((e) => isBorrowHomeFor(e, nodeId))
  const borrowNode = borrowEntry?.overrideTargetNodeId ?? null
  return {
    open: true,
    borrowAgentName: borrowNode === null ? null : resolveNodeAgentName(workflowDef, borrowNode),
    // RFC-139 ②: open BOUND entries' triggers = this ledger's handler-chain anchors (queued → none).
    anchorRunIds: new Set(
      openCandidates.map((e) => e.triggerRunId).filter((id): id is string => id !== null),
    ),
  }
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
  // Shared predicate (RFC-120 §15 Codex re-gate): create / reassign / dispatch all agree on
  // "runnable" via taskNodeHasRun, so a manual/override target accepted upstream is dispatchable.
  if (!(await taskNodeHasRun(db, taskId, targetNodeId))) {
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
  // RFC-128 P5-BC: scope to DESIGNER rows — a self/questioner home (self/cross-questioner entries)
  // is NOT a cross-clarify graph designer, so multi-source designer readiness does not apply to it
  // (assertDesignerReady 对 self/q 跳过, §5.2.12). A pure-override / self/q group → empty → skip.
  const graphSubset = group.filter(
    (e) => e.defaultTargetNodeId === targetNodeId && e.roleKind === 'designer',
  )
  if (graphSubset.length === 0) return // pure-override or self/questioner group — not the graph designer
  // RFC-128 P3: the rounds we are dispatching FROM are exempt from the awaiting_human "pending"
  // gate — their sealed questions are the whole point of this dispatch (a partial-seal round
  // stays awaiting_human). origin_node_run_id == cross_clarify_sessions.cross_clarify_node_run_id,
  // so the readiness scan can match the dispatched sessions and skip them; an UNRESOLVED sibling
  // (not in this set) still rejects the dispatch (golden lock H3/H2 multi-source readiness).
  const dispatchedOrigins = new Set(graphSubset.map((e) => e.originNodeRunId))
  for (const loopIter of new Set(graphSubset.map((e) => e.loopIter))) {
    const readiness = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: targetNodeId,
      definition,
      loopIter,
      dispatchedOrigins,
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
  // RFC-127 借壳: the node whose agent X is borrowed (null = home runs its own agent).
  borrowOverrideNodeId: string | null,
  // RFC-128 P5-BC (F3): the role-derived rerun cause (self→clarify-answer / questioner→
  // cross-clarify-questioner-rerun / designer→cross-clarify-answer). The whole batch on a home
  // is one cause (auto-split). Replaces the old hardcoded 'cross-clarify-answer'.
  cause: CauseClass,
  definition: WorkflowDefinition,
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
  // RFC-127 借壳: resolve the borrowed node's agentName from the frozen snapshot (the SAME
  // source canReassign validated against). null = no borrow → the home runs its own agent.
  const agentOverrideName =
    borrowOverrideNodeId === null ? null : resolveNodeAgentName(definition, borrowOverrideNodeId)
  const values = buildMintNodeRunValues({
    id: preId,
    taskId,
    nodeId: targetNodeId,
    status: 'pending',
    cause,
    retryIndex,
    iteration: last.iteration,
    inheritFrom: last,
    overrides: { startedAt: null, agentOverrideName },
  })
  return { nodeId: targetNodeId, preId, iteration: last.iteration, values }
}
