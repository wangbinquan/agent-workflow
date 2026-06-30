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
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { evaluateDesignerRerunReadiness } from '@/services/crossClarify'
import { pickFreshestRun } from '@/services/freshness'
import { buildMintNodeRunValues } from '@/services/nodeRunMint'
import {
  assertTaskAcceptsQuestions,
  resolveTriggerForEntry,
  taskNodeHasRun,
  TERMINAL_TASK_STATUSES,
} from '@/services/taskQuestions'
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
  /** RFC-128 P5-BC (R2-3 auto-split, §5.2.13): entries NOT dispatched this batch because their
   *  home is serializing a different cause class first (a sealed designer + sealed self on the
   *  same node). They stay STAGED — the next "批量下发" dispatches them once the first batch's
   *  rerun is done+output (the in-flight gate releases it). Empty in the common single-cause
   *  case (golden-lock). */
  deferred: Array<{ entryId: string; homeNodeId: string; reason: string }>
}

type TaskQuestionRow = typeof taskQuestions.$inferSelect
type ClarifyRoundRow = typeof clarifyRounds.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

const EMPTY_RESULT: DispatchTaskQuestionsResult = {
  reruns: [],
  dispatchedEntryIds: [],
  deferred: [],
}

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

// RFC-127 借壳: the "home" node a borrowed designer rerun is MINTED on (run.node_id).
// A clarify-designer keeps the GRAPH designer (default) — an override only swaps the
// brain, not the run's node; manual (no default) falls back to its override (its own
// node). This翻转s the old `override ?? default` so override no longer moves the home.
function homeTarget(e: TaskQuestionRow): string | null {
  return e.defaultTargetNodeId ?? e.overrideTargetNodeId
}

// RFC-127 借壳: the node whose AGENT is borrowed (caller resolves its agentName), or
// null when the home node runs its OWN agent (no override, or manual where the
// override IS the home).
function borrowAgentNode(e: TaskQuestionRow): string | null {
  const home = homeTarget(e)
  return e.overrideTargetNodeId !== null && e.overrideTargetNodeId !== home
    ? e.overrideTargetNodeId
    : null
}

// RFC-128 P5-BC (§5.2.12 F3) — the rerun-cause class an entry's dispatch mints, derived from its
//承接 role. A node_run carries ONE rerun_cause; entries of different classes on the same home are
// SEPARATE reruns (serialized, never collapsed). self/questioner causes are isClarifyRerun=TRUE
// (inline resume + directive gating); designer's cross-clarify-answer is FALSE (update mode).
type CauseClass = 'clarify-answer' | 'cross-clarify-questioner-rerun' | 'cross-clarify-answer'
function causeClassForEntry(e: TaskQuestionRow): CauseClass {
  if (e.roleKind === 'self') return 'clarify-answer'
  if (e.roleKind === 'questioner') return 'cross-clarify-questioner-rerun'
  return 'cross-clarify-answer' // designer (incl. manual)
}
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

  // 0. Batch-dispatch is ONLY valid on an opted-in deferred task. On a non-deferred task
  //    the immediate flow already minted the designer rerun, so minting again off a
  //    lazily-reconciled (NULL) entry would DOUBLE-mint. The route rejects this too; this
  //    is the defensive net for any direct service caller.
  const taskRow = (
    await db
      .select({
        deferred: tasks.deferredQuestionDispatch,
        snapshot: tasks.workflowSnapshot,
        status: tasks.status,
      })
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

  // 3. Group the requested entries by (HOME node, rerun-cause class). RFC-127 借壳: the HOME node
  //    (run.node_id = default ?? override) is where the borrowed rerun is minted. RFC-128 P5-BC:
  //    the cause class (self→clarify-answer / questioner→cross-clarify-questioner-rerun /
  //    designer→cross-clarify-answer) discriminates which entries can share ONE rerun — a single
  //    node_run carries ONE rerun_cause (§5.2.12 F3), so different causes on the same home are
  //    SEPARATE reruns that must serialize, never collapse.
  const byHomeCause = new Map<string, Map<CauseClass, TaskQuestionRow[]>>()
  for (const e of requested) {
    const home = homeTarget(e)
    if (home === null) continue
    const cause = causeClassForEntry(e)
    const causes = byHomeCause.get(home) ?? new Map<CauseClass, TaskQuestionRow[]>()
    const list = causes.get(cause) ?? []
    list.push(e)
    causes.set(cause, list)
    byHomeCause.set(home, causes)
  }
  if (byHomeCause.size === 0) return EMPTY_RESULT

  // 4a. Per-(home, cause) single-borrow gate (precondition, fail-fast — RFC-127 P2-1 / §5.2.13):
  //     a (home, cause) group mints ONE borrowed rerun, which runs ONE agent. Reject if it names
  //     >1 agent (incl. {X, null} = some borrowed + some self). Scoped PER CAUSE so a home that
  //     legitimately holds different causes (self + designer) is NOT a multi-borrow — that is the
  //     auto-split case below, not a reject.
  for (const [home, causes] of byHomeCause) {
    for (const group of causes.values()) {
      const borrows = new Set(group.map(borrowAgentNode))
      if (borrows.size > 1) {
        throw new ConflictError(
          'task-question-home-multi-borrow',
          `node '${home}' would mint one borrowed rerun but its dispatched questions name multiple agents (${[...borrows].map((b) => b ?? '(self)').join(', ')}); a single rerun runs one agent — dispatch them separately or align their handler.`,
        )
      }
    }
  }

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
  //     uses (done+output). This covers a pending/running rerun AND a FAILED / un-run one. The
  //     user dispatches the rest AFTER that node's rerun reaches done+output (its failed run
  //     can still be revived/retried and render its feedback in the meantime).
  await assertNoInFlightDispatch(db, taskId, affected)

  // 6. Pre-compute each frontier mint's inherited values (async reads) BEFORE the tx so the
  //    tx body is purely synchronous (atomic with the dispatched_at stamp).
  const mintPlans = await Promise.all(
    // RFC-127 借壳: pass the home group's borrow agent (the per-home gate above ensures the group
    // names exactly one) + the parsed definition (to resolve its agentName). RFC-128 P5-BC: pass
    // the home's ROLE-derived rerun cause (auto-split guarantees one cause per home this batch).
    [...frontier].map(async (nodeId) =>
      buildFrontierMintPlan(
        db,
        taskId,
        nodeId,
        borrowAgentNode(byTarget.get(nodeId)![0]!),
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
  try {
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
      if (curTask === undefined || TERMINAL_TASK_STATUSES.has(curTask.status)) {
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
        .where(and(inArray(taskQuestions.id, dispatchIds), isNull(taskQuestions.dispatchedAt)))
        .all()
      if (stillNull.length !== dispatchIds.length) throw new ConcurrentClaim()
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
      // RFC-128 P5-BC (R2-2, §5.2.12 contract 3): the in-flight recheck spans ANY deferred role
      // (self/questioner/designer) dispatched entry — the cross-batch serialization half. A
      // home with an in-flight self/questioner dispatch must block a later designer dispatch (and
      // vice-versa), or the two same-home reruns double-mint.
      const txEntries = tx
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
        .where(and(inArray(taskQuestions.id, dispatchIds), isNull(taskQuestions.dispatchedAt)))
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
    entryIds: dispatchEntries.filter((e) => homeTarget(e) === p.nodeId).map((e) => e.id),
  }))
  log.info('task questions dispatched', {
    taskId,
    actorUserId: actor.userId,
    dispatchedEntryCount: dispatchIds.length,
    deferredEntryCount: deferredEntries.length,
    affectedNodeCount: affected.size,
    frontierRerunCount: reruns.length,
  })
  return { reruns, dispatchedEntryIds: dispatchIds, deferred: deferredEntries }
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
    // RFC-127 借壳: in-flight is tracked on the HOME node (where the run is minted).
    const target = e.defaultTargetNodeId ?? e.overrideTargetNodeId
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
  const blocker = findOpenDispatchTarget(affected, { entries, runs, outputRunIds })
  if (blocker !== null) {
    throw new ConflictError(
      'task-question-node-dispatch-in-flight',
      `cannot dispatch to '${blocker}': it already has an OPEN (unconsumed) dispatched question. Dispatch the remaining questions after that node's rerun finishes (done with output).`,
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
 *     failed / outputless => keep borrowing for retry/revival; done+output => consumed,
 *     drop borrow; non-frontier cascade mint => resolve this home node's own queued one.
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
export async function resolveBorrowForNode(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
  workflowDef: WorkflowDefinition,
): Promise<string | null> {
  const immediate = await resolveImmediateBorrowForNode(db, taskId, nodeId, iteration, workflowDef)
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
  // P2-2 (Codex impl-gate, 2 rounds) + RFC-128 §5.2.12 F3 (collapse 推翻, dual→triple ledger):
  // two reruns open on the SAME home+iteration across ANY two ledgers are SEPARATE pending
  // node_runs with MUTUALLY-EXCLUSIVE causes (clarify-answer / cross-clarify-questioner-rerun
  // [isClarifyRerun TRUE] vs cross-clarify-answer [FALSE]). runOneNode consumes/binds by NODE,
  // not by ledger — the first run to fire binds, and the other pending row runs later as stale
  // duplicate work (or orphans, per ULID order). So EVEN when two ledgers borrow the SAME agent
  // the EXECUTION is ambiguous (duplicate work) AND a single node_run carries ONE rerun_cause
  // that cannot serve two roles — reject any same-home multi-ledger overlap (the early-draft
  // "same agent → collapse one rerun" is WRONG: cause is single-valued + exclusive). The user
  // resolves one before the node reruns (dispatch serializes via single-cause gate + the
  // in-flight gate). The two same-home borrows are serialized across batches, not collapsed.
  const openLedgers = [immediate, designer, deferredSelfQ].filter((b): b is string => b !== null)
  if (openLedgers.length > 1) {
    throw new ConflictError(
      'task-question-borrow-ledger-conflict',
      `node '${nodeId}' (iter ${iteration}) has multiple open reassignment ledgers (self/questioner immediate → ${immediate ?? '(none)'}, dispatched designer → ${designer ?? '(none)'}, dispatched self/questioner → ${deferredSelfQ ?? '(none)'}); they are separate pending reruns with mutually-exclusive causes that would duplicate execution — resolve / serialize them before the node reruns.`,
    )
  }
  return openLedgers[0] ?? null
}

/**
 * RFC-128 P5-BC (clean-path ④, §5.2.12 F3) — the deferred self/questioner borrow ledger.
 * Control-channel DISPATCHED self/questioner reruns (dispatched_at set by dispatchTaskQuestions),
 * mirroring resolveDesignerBorrowForNode's `isDispatchedEntryConsumed` consumption (dispatched_at
 * + trigger_run_id lineage → done+output = consumed, drop borrow; queued/failed/outputless = keep
 * borrowing). Unlike the designer ledger (keyed on task_questions.loop_iter), self rows project
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
): Promise<string | null> {
  // Control-channel DISPATCHED self/questioner entries (dispatched_at set). Include no-override
  // rows so a "borrow X + run self" mix on one home is DETECTED (P2-1), not first-picked.
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
  const homeEntries = entries.filter((e) => homeTarget(e) === nodeId)
  if (homeEntries.length === 0) return null
  // Golden-lock fast path: no real borrow on this home → no rounds/runs read needed.
  if (!homeEntries.some((e) => isBorrowHomeFor(e, nodeId))) return null

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
    return !isDispatchedEntryConsumed(e, runs, lineageViews)
  })
  if (open.length === 0) return null

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
  const borrowNode = [...borrows][0] ?? null
  if (borrowNode === null) return null
  return resolveNodeAgentName(workflowDef, borrowNode)
}

/**
 * RFC-127 designer borrow (deferred dispatch ledger) — the shipped path, unchanged except for
 * extraction. Consumption is dispatched_at + trigger_run_id (isDispatchedEntryConsumed); keyed on
 * task_questions.loop_iter (= round.loop_iter, the real wrapper-loop index for cross rounds).
 */
async function resolveDesignerBorrowForNode(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
  workflowDef: WorkflowDefinition,
): Promise<string | null> {
  const entries = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        eq(taskQuestions.loopIter, iteration),
        isNotNull(taskQuestions.dispatchedAt),
        isNotNull(taskQuestions.overrideTargetNodeId),
      ),
    )
  const candidates = entries.filter((e) => isBorrowHomeFor(e, nodeId))
  if (candidates.length === 0) return null

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
  const open = candidates
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .find((e) => !isDispatchedEntryConsumed(e, runs, lineageViews))
  if (open?.overrideTargetNodeId === undefined || open.overrideTargetNodeId === null) return null
  return resolveNodeAgentName(workflowDef, open.overrideTargetNodeId)
}

/**
 * RFC-127 借壳 (self / questioner immediate path). These reruns are minted the instant the
 * human answers (clarify.ts mintNodeRun 'clarify-answer' on the asking node P; crossClarify
 * mintQuestionerRerun 'cross-clarify-questioner-rerun' on the questioner) and NEVER touch
 * dispatched_at / trigger_run_id. So unlike the designer ledger, consumption is ROUND-based:
 * the entry's clarify round + its role's RFC-070 consumption stamp (resolveTriggerForEntry —
 * self ⇒ consumed_by_consumer_run_id, questioner ⇒ consumed_by_questioner_run_id). The home
 * node borrows X while the round is answered-but-unconsumed, and stops once the continuation
 * rerun lands done+output (the stamp is set ⇒ an unrelated future rerun runs the home's own
 * agent — the golden-lock). Returns the borrowed agentName, or null.
 *
 * P2-3 (loop iteration): self clarify rounds project loop_iter=0 (taskQuestions.ts — "node_runs
 * .iteration IS the loop index; loop_iter projected 0"), so the persisted task_question loop_iter
 * can't gate a wrapper-loop iteration ≥ 1. We match the round's ASKING run iteration (the
 * P/questioner run that emitted the envelope, whose node_runs.iteration IS the loop index) to the
 * scheduler iteration instead.
 *
 * P2-1 (single-borrow gate): one continuation rerun re-runs the home node ONCE, so it borrows at
 * most ONE agent. The OPEN (unconsumed) home entries must agree on a single decision — a round
 * reassigned to two agents, or a mix of "borrow X" + "run self", is rejected (ConflictError), not
 * silently first-picked. (Mirrors the designer dispatch per-home single-borrow gate.)
 */
async function resolveImmediateBorrowForNode(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
  workflowDef: WorkflowDefinition,
): Promise<string | null> {
  // ALL self/questioner entries — include no-override ("run self") rows so a "borrow X + run
  // self" mix within one home is DETECTED (P2-1), not silently first-picked. No loop_iter filter
  // here (self rows project 0); iteration is matched via the round's asking run below (P2-3).
  // RFC-128 P5-BC: EXCLUDE control-channel per-question entries (`sealed_at` set) — those ride
  // the DEFERRED self/questioner ledger (resolveDeferredSelfQuestionerBorrowForNode, dispatched_at
  // consumption), not the quick-channel round-based immediate ledger. `sealed_at` NULL ⟺ a
  // quick-channel continuation (the only thing this ledger owns) → byte-for-byte golden-lock.
  const entries = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        inArray(taskQuestions.roleKind, ['self', 'questioner']),
        isNull(taskQuestions.sealedAt),
      ),
    )
  // home = default ?? override (self: the asking node P; questioner: the questioner node).
  const homeEntries = entries.filter((e) => homeTarget(e) === nodeId)
  if (homeEntries.length === 0) return null
  // Golden-lock fast path: no real borrow on this home → no rounds/runs read needed.
  if (!homeEntries.some((e) => isBorrowHomeFor(e, nodeId))) return null

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

  // OPEN (unconsumed) home entries at THIS loop iteration, matched via the asking run (P2-3).
  const open = homeEntries.filter((e) => {
    const round = roundByOrigin.get(e.originNodeRunId)
    if (round === undefined) return false // round vanished (task edited) → not borrowable
    const askingRun = runById.get(round.askingNodeRunId)
    if (askingRun === undefined || askingRun.iteration !== iteration) return false
    return !isRoundEntryConsumed(e, round, runs, outputRunIds)
  })
  if (open.length === 0) return null

  // P2-1 single-borrow gate: each open entry's decision is its borrow node (or null = run self).
  // >1 distinct (incl. {X, self}) ⇒ ambiguous for the single continuation rerun ⇒ reject.
  const borrows = new Set(
    open.map((e) => (isBorrowHomeFor(e, nodeId) ? e.overrideTargetNodeId : null)),
  )
  if (borrows.size > 1) {
    throw new ConflictError(
      'task-question-home-multi-borrow',
      `node '${nodeId}' (iter ${iteration}) has self/questioner questions reassigned to conflicting handlers (${[
        ...borrows,
      ]
        .map((b) => b ?? '(self)')
        .join(
          ', ',
        )}) in one continuation; a single rerun runs one agent — align them to one handler.`,
    )
  }
  const borrowNode = [...borrows][0] ?? null
  if (borrowNode === null) return null
  return resolveNodeAgentName(workflowDef, borrowNode)
}

/** RFC-127 借壳: is a self/questioner clarify-round entry CONSUMED? = its role's RFC-070
 *  consumption stamp (resolveTriggerForEntry) points at a done+output run — the SAME oracle
 *  the read-side (resolveEntryHandler) uses. Stamp NULL (continuation rerun queued/running/
 *  failed) or anchor GC'd → NOT consumed (keep borrowing for the retry/revival). */
function isRoundEntryConsumed(
  entry: Pick<TaskQuestionRow, 'roleKind'>,
  round: ClarifyRoundRow,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): boolean {
  const triggerRunId = resolveTriggerForEntry(round, entry.roleKind)
  if (triggerRunId === null) return false
  const row = runs.find((r) => r.id === triggerRunId)
  if (row === undefined) return false
  return row.status === 'done' && outputRunIds.has(row.id)
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
