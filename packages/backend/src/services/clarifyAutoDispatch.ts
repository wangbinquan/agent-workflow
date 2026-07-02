// RFC-128 P5-D — quick-channel seal + AUTODISPATCH (the final P5 phase).
//
// §5.2.7 P5b single-path decision: a task's `deferred_question_dispatch` flag is the ONLY path
// source. On a DEFERRED task the self/questioner quick channel (反问页 quick answer, defer=false)
// is ALSO delayed — it does NOT mint an immediate continuation. Instead `defer` only decides
// AUTO vs MANUAL triggering of the SAME per-question dispatch (RFC-125 single delivery path, never
// a second path):
//
//   • Quick channel (defer=false) on a DEFERRED task → autoDispatchClarifyRound: seal the round
//     (the SAME control-channel sealRoundQuestions the defer=true path uses) then AUTO-trigger the
//     SAME dispatchTaskQuestions the board's 批量下发 uses (readiness + rerun-cause + auto-split +
//     in-flight gate all reused). NOT the legacy immediate mint.
//   • Manual control channel (defer=true, centralized-answer pane P4) → seal + leave the entry
//     STAGED; the user dispatches it explicitly later (P5-BC, unchanged).
//   • NON-deferred task → the quick channel keeps the legacy immediate mint
//     (submitClarifyAnswers / submitCrossClarifyAnswers, BYTE-FOR-BYTE unchanged — golden-lock).
//     The route NEVER calls this module for a non-deferred task; the deferred re-check below is the
//     defensive net for a direct service caller.
//
// LOCK ORDER / NO REENTRY (key correctness constraint): the per-task question-write lock B
// (getTaskQuestionWriteSem) is a NON-reentrant Semaphore(1). sealRoundQuestions acquires + RELEASES
// B for its tx; dispatchTaskQuestions acquires + RELEASES B for its tx. This module calls those two
// SEQUENTIALLY (B taken twice in series, never nested) — wrapping the dispatch inside the seal's B
// would deadlock (dispatch's B.acquire() would queue forever). The seal→dispatch gap is race-safe:
// dispatchTaskQuestions re-reads under B + CAS-guards every entry (`dispatched_at IS NULL` +
// `confirmation='open'`) + re-runs its readiness/in-flight/immediate-ledger gates, so any interleaving
// is caught there (no double-mint, no stamp of a superseded entry).
//
// The ONLY place this module ITSELF acquires B is the self-clarify rollback branch (round-10): it
// holds the worktree lock A OUTER and B INNER around the {same-home open-ledger preflight → worktree
// rollback} so a concurrent dispatch cannot mint a same-home rerun in the preflight→rollback gap and
// be clobbered (A ≻ B, matching submitClarifyAnswers' rollback critical section). That B is RELEASED
// before tryDispatch → dispatchTaskQuestions re-acquires a FRESH B (sequential, never B-within-B). No
// path acquires A while holding B → no A→B/B→A cycle → deadlock-free.
//
// SCOPE — self/questioner entries only. autoDispatch dispatches the round's self/questioner entries
// (the reruns the legacy quick channel minted immediately). DESIGNER entries (a cross designer-scope
// question) are NOT auto-dispatched: they keep riding the §18 designer park (loadUndispatchedDesigner-
// Targets) + the board's manual 批量下发 — the established deferred-designer flow (RFC-120 §18 / P3),
// which a deferred task ALWAYS finished via manual dispatch. Auto-dispatching them would also trip
// assertDesignerReady's multi-source readiness on the FIRST sibling answer (a 4xx in the fast path).
// The single-path invariant still holds: self/q (auto-triggered) + designer (manual-triggered) go
// through the ONE dispatchTaskQuestions mechanism — a single delivery path, two triggers.

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { resolveClarifyNodeFromTaskSnapshot } from '@/services/clarify'
import { hasOpenDispatchedEntryOnHome } from '@/services/clarifyRerunLedger'
import { sealRoundQuestions } from '@/services/clarifySeal'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'
import { buildFrozenAttributionSet } from '@/services/clarifyRounds'
import { validateQuestionScopes } from '@/services/crossClarify'
import { loadRollbackTarget, rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import {
  dispatchTaskQuestions,
  type DispatchTaskQuestionsResult,
} from '@/services/taskQuestionDispatch'
import { loadSealedQuestionIds } from '@/services/taskQuestions'
import { getTaskQuestionWriteSem, getTaskWriteSem } from '@/services/taskWriteLocks'
import { ConflictError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import {
  resolveClarifySessionMode,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
} from '@agent-workflow/shared'

const log = createLogger('clarify-auto-dispatch')

const EMPTY_DISPATCH: DispatchTaskQuestionsResult = {
  reruns: [],
  dispatchedEntryIds: [],
  deferred: [],
}

/** Codex round-6 — the dispatchTaskQuestions ConflictError codes the autodispatch may swallow as a
 *  success-with-`dispatchDeferredReason` (the answer is sealed + parked; a LATER board 批量下发 CAN
 *  mint the rerun). Everything ELSE (terminal task / unparseable snapshot / unsafe frontier /
 *  not-deferred / designer multi-target/borrow) is NON-recoverable — the board would reject it too —
 *  so it is RETHROWN rather than promising a rerun that can never mint. */
const RECOVERABLE_DISPATCH_CONFLICTS: ReadonlySet<string> = new Set([
  'task-question-node-dispatch-in-flight', // releases when the in-flight rerun reaches done+output
  'task-question-target-changed', // a concurrent reassign — re-plan against the new target
])

/** RFC-132 PR-B (§6 designer 切自动下发) — the ConflictError codes the DESIGNER auto-dispatch swallows
 *  as a PARK (the designer entries stay sealed-undispatched until a later sibling answer / board
 *  dispatch mints the rerun). Adds 'task-question-designer-not-ready' (multi-source readiness — sibling
 *  cross-clarify rounds still awaiting an answer) to the shared recoverable set; everything else
 *  (multi-target / unsafe frontier / terminal task) is RETHROWN. */
const DESIGNER_DEFERRABLE_CONFLICTS: ReadonlySet<string> = new Set([
  ...RECOVERABLE_DISPATCH_CONFLICTS,
  'task-question-designer-not-ready', // sibling cross-clarify round(s) still awaiting an answer
])

/** The question ids of a round from its questions_json (defensive parse; [] on malformed). */
function parseQuestionIds(questionsJson: string): string[] {
  try {
    const v = JSON.parse(questionsJson)
    return Array.isArray(v) ? (v as ClarifyQuestion[]).map((q) => q.id) : []
  } catch {
    return []
  }
}

/** RFC-098 B1 (Codex round-4) — the asking agent's run row WHEN a self-clarify isolated rerun is due
 *  a worktree rollback (the SAME predicate submitClarifyAnswers uses: NOT inline session mode AND a
 *  pre_snapshot exists), else null. Caller has already gated kind==='self' + a non-empty worktree. */
async function resolveSelfRollbackRun(
  db: DbClient,
  askingNodeRunId: string,
  intermediaryNodeId: string,
  workflowSnapshot: string,
): Promise<typeof nodeRuns.$inferSelect | null> {
  const askingRun = (
    await db.select().from(nodeRuns).where(eq(nodeRuns.id, askingNodeRunId)).limit(1)
  )[0]
  if (askingRun === undefined) return null
  const clarifyNode = resolveClarifyNodeFromTaskSnapshot(workflowSnapshot, intermediaryNodeId)
  const sessionMode = clarifyNode ? resolveClarifySessionMode(clarifyNode) : 'isolated'
  if (sessionMode === 'inline') return null
  if (askingRun.preSnapshot === null && askingRun.preSnapshotReposJson === null) return null
  return askingRun
}

/**
 * Codex round-8/9 — does `homeNodeId` already hold an OPEN (unconsumed) rerun ledger that the
 * destructive self rollback must NOT clobber? Mirrors the dispatch gate
 * (assertNoInFlightDispatch → hasOpenDispatchedEntryOnHome): an open (unconsumed) `dispatched_at`
 * self/questioner/designer entry whose home is this node. If open the autodispatch DEFERS without
 * rolling back, so the owning rerun resumes against an unclobbered worktree.
 * (RFC-132 ③: the immediate quick-channel half was deleted with the immediate ledger — the boot
 * shim converts pre-upgrade leftovers to dispatched entries, so this ONE gate covers all owners.)
 */
async function selfHomeHasOpenLedger(
  db: DbClient,
  taskId: string,
  homeNodeId: string,
): Promise<boolean> {
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = new Set(
    runs.length === 0
      ? []
      : (
          await db
            .select({ id: nodeRunOutputs.nodeRunId })
            .from(nodeRunOutputs)
            .where(
              inArray(
                nodeRunOutputs.nodeRunId,
                runs.map((r) => r.id),
              ),
            )
        ).map((r) => r.id),
  )
  // (a) dispatched ledger on the home (any deferred role).
  const dispatchedEntries = await db
    .select({
      triggerRunId: taskQuestions.triggerRunId,
      defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
      overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
      roleKind: taskQuestions.roleKind,
    })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        inArray(taskQuestions.roleKind, ['self', 'questioner', 'designer']),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  if (
    dispatchedEntries.length > 0 &&
    // RFC-133: this preflight guards the SELF rollback+dispatch — its mint is 'clarify-answer'.
    hasOpenDispatchedEntryOnHome(
      homeNodeId,
      dispatchedEntries,
      runs,
      outputRunIds,
      'clarify-answer',
    )
  ) {
    return true
  }
  // RFC-132 ③: the (b) immediate quick-channel half is GONE with the immediate ledger — every
  // live self/q rerun is a dispatched entry (autoDispatchClarifyRound), and pre-upgrade immediate
  // leftovers are converted to dispatched by the boot shim (reconcileLegacyImmediateRounds), so the
  // (a) dispatched gate above covers everything the destructive rollback must not clobber.
  return false
}

export interface AutoDispatchClarifyRoundArgs {
  db: DbClient
  /** The clarify / cross-clarify round's intermediary node_run id (= the route's :nodeRunId =
   *  clarify_rounds.intermediaryNodeRunId = task_questions.originNodeRunId). */
  originNodeRunId: string
  /** The whole-round answers the quick channel posted (a control-channel partial seal of an
   *  earlier sibling question is preserved — already-sealed ids are filtered out before sealing). */
  answers: ClarifyAnswer[]
  /** Round directive ('continue' | 'stop'); threaded to the seal so the control channel matches
   *  the quick path's stop semantics (a 'stop' cross round mints a questioner-stop rerun via
   *  dispatch + persists the canvas directive). */
  directive?: ClarifyDirective
  /** Per-question scope (cross rounds only); merged by the seal. */
  scopes?: Record<string, ClarifyQuestionScope>
  /** RFC-023 optimistic lock — the round iteration the client believes it is answering. When set
   *  and != the round's current iteration, reject (clarify-iteration-mismatch), mirroring the
   *  immediate path (submitClarifyAnswers / submitCrossClarifyAnswers); the /clarify page always
   *  sends it. */
  ifMatchIteration?: number
  /** Audit-only actor; NEVER enters a prompt (RFC-099). */
  actor: { userId: string; role: 'owner' | 'user' | 'admin' }
  now?: () => number
}

export interface AutoDispatchClarifyRoundResult {
  taskId: string
  kind: 'self' | 'cross'
  /** Question ids sealed by THIS call (the not-yet-sealed subset). */
  sealedQuestionIds: string[]
  /** True when the round is now fully sealed (answered). */
  roundFullySealed: boolean
  /** The dispatch outcome of the round's self/questioner entries. */
  dispatch: DispatchTaskQuestionsResult
  /** Codex round-5 — set (to the dispatch conflict's error code) when the round WAS sealed but the
   *  AUTO-dispatch was DEFERRED to manual board dispatch because dispatchTaskQuestions hit a conflict
   *  gate (e.g. a same-home in-flight rerun). The answer is durably saved (round answered, entries
   *  sealed-undispatched + parked) and recoverable via the board's 批量下发 — so the quick API returns
   *  SUCCESS (idempotent: a retry hits the answered-round guard, but the entries are already parked
   *  for manual dispatch) instead of surfacing a failed response for a committed answer. */
  dispatchDeferredReason?: string
}

/**
 * RFC-128 P5-D — the deferred-task quick-channel "seal then AUTO-dispatch". Seals the round
 * (control-channel sealRoundQuestions — the P5-0 self/questioner full-seal guard is LIFTED on a
 * deferred task, §5.2.1) then auto-triggers dispatchTaskQuestions on the round's self/questioner
 * entries (the SAME per-question dispatch the board uses). The caller (route) runs resumeTask after,
 * mirroring the manual dispatch route.
 */
export async function autoDispatchClarifyRound(
  args: AutoDispatchClarifyRoundArgs,
): Promise<AutoDispatchClarifyRoundResult> {
  const { db, originNodeRunId } = args

  // 1. Locate the round (kind + task + questions + asking run + clarify node). The route already
  //    gated membership. askingNodeRunId + intermediaryNodeId feed the self-clarify rollback below.
  const round = (
    await db
      .select({
        id: clarifyRounds.id,
        kind: clarifyRounds.kind,
        taskId: clarifyRounds.taskId,
        status: clarifyRounds.status,
        iteration: clarifyRounds.iteration,
        questionsJson: clarifyRounds.questionsJson,
        askingNodeRunId: clarifyRounds.askingNodeRunId,
        intermediaryNodeId: clarifyRounds.intermediaryNodeId,
      })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, originNodeRunId))
      .limit(1)
  )[0]
  if (round === undefined) {
    throw new NotFoundError(
      'clarify-round-not-found',
      `no clarify_round for origin node_run ${originNodeRunId}`,
    )
  }

  // 1a. The quick channel is a WHOLE-ROUND FINALIZE on a round still AWAITING an answer. Reject an
  //     already-finalized round (status != awaiting_human), mirroring the immediate path's
  //     double-submit rejection (submitClarifyAnswers' `clarify-already-answered`) AND closing the
  //     Codex impl-gate hole: a round FULLY sealed via the CONTROL channel (answered, its entries
  //     STAGED for explicit manual board dispatch) must NOT be hijacked into an auto-dispatch by a
  //     stale defer=false submit (all answers locked → no new seal → it would otherwise fall straight
  //     to dispatch). A control-channel round is dispatched ONLY via the explicit board endpoint. A
  //     PARTIAL control seal leaves the round awaiting_human, so the legitimate mixed flow (control
  //     seal q1 → quick-finalize the rest) still passes. Terminal rounds (canceled/abandoned) reject
  //     here too (sealRoundQuestions would also reject them).
  if (round.status !== 'awaiting_human') {
    throw new ConflictError(
      'clarify-already-answered',
      `clarify round ${originNodeRunId} is '${round.status}', not awaiting_human; it was already finalized (a control-channel full seal is dispatched via the board, not the quick channel)`,
    )
  }

  // 1b. RFC-023 optimistic lock — reject a stale answer (mirrors submitClarifyAnswers /
  //     submitCrossClarifyAnswers; the /clarify page always sends ifMatchIteration = round.iteration).
  if (args.ifMatchIteration !== undefined && args.ifMatchIteration !== round.iteration) {
    throw new ConflictError(
      'clarify-iteration-mismatch',
      `If-Match iteration ${args.ifMatchIteration} does not match server iteration ${round.iteration}`,
    )
  }

  // 2. RFC-132 PR-B (universal deferred model): autodispatch is THE single per-question path for
  //    EVERY task now (the route routes ALL clarify answers here). The `deferredQuestionDispatch`
  //    flag is no longer read; only the worktree + snapshot (for the self-clarify rollback below)
  //    are loaded, plus a not-found guard.
  const taskRow = (
    await db
      .select({
        worktreePath: tasks.worktreePath,
        workflowSnapshot: tasks.workflowSnapshot,
      })
      .from(tasks)
      .where(eq(tasks.id, round.taskId))
      .limit(1)
  )[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${round.taskId} not found`)
  }

  // 2b. RFC-059 questionScopes validation (BEFORE any write) — the legacy submitCrossClarifyAnswers
  //     validated the scope map against the round's questions (reject an unknown questionId / bad enum
  //     → ValidationError 'cross-clarify-question-scopes-malformed'); RFC-132 PR-B preserves that on
  //     the unified quick channel. Pure (args + questions); a malformed map never reaches the DB.
  if (args.scopes !== undefined) {
    const roundQuestions = ((): ClarifyQuestion[] => {
      try {
        return JSON.parse(round.questionsJson) as ClarifyQuestion[]
      } catch {
        return []
      }
    })()
    validateQuestionScopes(args.scopes, roundQuestions)
  }

  // 3. Seal the round (control channel) as a WHOLE-ROUND FINALIZE. The quick channel finalizes the
  //    ENTIRE round (the immediate path flips the whole round answered even when some answers are
  //    blank — "User did not answer this question."); the deferred path must match (golden-lock) AND
  //    must never dispatch a PARTIALLY sealed round (Codex impl-gate: a stale/malformed subset submit
  //    would otherwise seal+dispatch q1 while q2 stays parked → partial rerun + a second continuation
  //    for one round). So seal EVERY not-yet-locked question — the posted answer when present, else a
  //    blank answer (matching what the /clarify page itself pads). Already-locked questions (an earlier
  //    control-channel partial seal) keep their sealed answer (sealRoundQuestions rejects re-seal). The
  //    round is awaiting_human (guard 1a), so ≥1 question is unsealed ⇒ this is always a non-empty FULL
  //    seal. sealRoundQuestions takes lock B internally; this is OUTSIDE any B (no nesting).
  const lockedIds = await loadSealedQuestionIds(db, originNodeRunId)
  const providedById = new Map(args.answers.map((a) => [a.questionId, a]))
  const sealAnswers: ClarifyAnswer[] = parseQuestionIds(round.questionsJson)
    .filter((qid) => !lockedIds.has(qid))
    .map(
      (qid) =>
        providedById.get(qid) ?? {
          questionId: qid,
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: '',
        },
    )
  // Codex impl-gate (high): forward scope ONLY for the not-yet-locked questions sealed by THIS call.
  // sealRoundQuestions merges EVERY provided scope key (it does not itself filter locked questions), so
  // passing the whole quick-submit scope map would let a stale defer=false submit OVERWRITE an
  // already-sealed (control-channel) question's scope — e.g. control-seal q1 as 'designer', then a
  // stale quick finalize carrying q1:'questioner' would flip q1 → questioner, deleting q1's staged
  // designer entry (reconcile drops the designer row). Mirror the immediate path
  // (submitCrossClarifyAnswers, which skips lockedIds when merging scopes): drop locked-question scopes.
  const unlockedScopes =
    args.scopes !== undefined
      ? Object.fromEntries(Object.entries(args.scopes).filter(([qid]) => !lockedIds.has(qid)))
      : undefined
  const sealResult = await sealRoundQuestions({
    db,
    originNodeRunId,
    answers: sealAnswers,
    // RFC-128 P5-0 stranding guard, NARROWED by P5-BC (§5.2.1): the guard is LIFTED on a deferred
    // task (the self/questioner park + dispatch path below IS the release path). Opt in anyway so a
    // direct misuse on a non-deferred task (already rejected above) stays consistent with the route.
    rejectSelfQuestionerFullSeal: true,
    ...(args.directive !== undefined ? { directive: args.directive } : {}),
    ...(unlockedScopes !== undefined && Object.keys(unlockedScopes).length > 0
      ? { scopes: unlockedScopes }
      : {}),
    sealedBy: args.actor.userId,
    ...(args.now !== undefined ? { now: args.now } : {}),
  })
  const sealedQuestionIds = sealResult.sealedQuestionIds
  // Whole-round finalize: sealing every not-yet-locked question always completes the round. Guard
  // defensively — never auto-dispatch a round this op did not fully seal (no partial dispatch).
  const roundFullySealed = sealResult.roundFullySealed
  if (!roundFullySealed) {
    throw new ConflictError(
      'clarify-quick-finalize-incomplete',
      `clarify round ${originNodeRunId} was not fully sealed by this quick-channel finalize; refusing to auto-dispatch a partially sealed round`,
    )
  }

  // RFC-041 distill enqueue — 迁自 legacy submitClarifyAnswers(RFC-132 ②a 发现的生产缺口:
  // PR-B 切统一路径后 clarify 答复不再入 distill 队列)。语义等价:仅 self 轮(legacy cross
  // 从不 enqueue)、finalize 成功后、best-effort(队列坏不影响答复结果)。sourceEventId =
  // round id(与 legacy session id 同值,RFC-058 dual-write)。放在 seal 确认成功后、dispatch
  // 之前:即使后续 dispatch conflict rethrow,已答的轮同样值得蒸馏(seal 已 commit)。
  if (round.kind === 'self') {
    await enqueueDistillJob(db, {
      sourceKind: 'clarify',
      sourceEventId: round.id,
      taskId: round.taskId,
    }).catch(() => {
      /* swallow — best-effort */
    })
  }

  // 3b. RFC-099 (D8/D14/D17) attribution FREEZE — the quick channel is the "submit" the legacy
  //     submitClarifyAnswers / submitCrossClarifyAnswers froze attribution on (buildFrozenAttributionSet:
  //     per-question editor kept where the sealed value matches their draft, else the submitter; clears
  //     the draft; records the submitter's role). sealRoundQuestions does NOT freeze (it is the shared
  //     seal primitive), so RFC-132 PR-B re-applies the freeze here on the whole-round finalize. Reads
  //     the round's post-seal answers (authoritative merged set) so the draft-vs-submit comparison matches
  //     what the legacy path did. Never enters a prompt (RFC-099 — audit/UI only).
  const postSealRound = (
    await db
      .select({ answersJson: clarifyRounds.answersJson })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, round.id))
      .limit(1)
  )[0]
  const frozenAnswers = ((): ClarifyAnswer[] => {
    try {
      return JSON.parse(postSealRound?.answersJson ?? '[]') as ClarifyAnswer[]
    } catch {
      return args.answers
    }
  })()
  const attributionSet = await buildFrozenAttributionSet(db, round.id, frozenAnswers, {
    userId: args.actor.userId,
    role: args.actor.role,
  })
  await db.update(clarifyRounds).set(attributionSet).where(eq(clarifyRounds.id, round.id))

  // 4. Collect the round's SELF/QUESTIONER entries to auto-dispatch (sealed, not yet dispatched,
  //    still open). Designer entries are intentionally excluded (see the module header). The dispatch
  //    re-applies the same `dispatched_at IS NULL` + `confirmation='open'` filter under lock B, so
  //    this read is just the candidate set.
  const entries = await db
    .select({ id: taskQuestions.id })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.originNodeRunId, originNodeRunId),
        inArray(taskQuestions.roleKind, ['self', 'questioner']),
        isNull(taskQuestions.dispatchedAt),
        eq(taskQuestions.confirmation, 'open'),
        isNotNull(taskQuestions.sealedAt),
      ),
    )

  const entryIds = entries.map((e) => e.id)

  // 5. RFC-098 B1 worktree rollback for SELF-clarify ISOLATED reruns (Codex round-4 [high]). The
  //    legacy quick path (submitClarifyAnswers) resets the worktree to the asking run's pre_snapshot
  //    before the self continuation, so an isolated rerun starts from the clean pre-question tree
  //    (RFC-023 forbids clarify-time writes, so usually a no-op, but B1 errs safe). The deferred quick
  //    channel preserves this for the self path; dispatchTaskQuestions never rolls back. CROSS
  //    (questioner) reruns do NOT roll back — submitCrossClarifyAnswers has no rollback — so this is
  //    self-only. resolveSelfRollbackRun returns the asking run iff a rollback is due (self + isolated
  //    + a snapshot + a worktree), else null.
  const selfRollbackRun =
    round.kind === 'self' && entryIds.length > 0 && taskRow.worktreePath !== ''
      ? await resolveSelfRollbackRun(
          db,
          round.askingNodeRunId,
          round.intermediaryNodeId,
          taskRow.workflowSnapshot,
        )
      : null

  // 6. AUTO-dispatch — the SAME dispatchTaskQuestions the board's manual 批量下发 calls (single path).
  //    dispatchTaskQuestions takes lock B internally; NOT nested inside the seal's B (sealRoundQuestions
  //    already released it) → sequential, no reentry. When a self isolated rollback is due, run it
  //    FIRST under the worktree write lock A (serialized vs in-flight writer nodes, RFC-098 B1) and
  //    BEFORE the dispatch mints the pending rerun (the rerun must not exist when the tree resets);
  //    A is OUTER, dispatch's B is INNER → lock order A ≻ B, no B held while taking A → deadlock-free.
  //    A no-op when there are no dispatchable self/questioner entries.
  //
  //    Codex round-5/6 — the seal above ALREADY committed (round answered + clarify node closed). If
  //    dispatchTaskQuestions then hits a RECOVERABLE conflict gate, do NOT surface a FAILED response
  //    for the saved answer: the entries are sealed-undispatched + parked (loadUndispatchedParkTargets)
  //    and a LATER board 批量下发 CAN mint the rerun, so DEFER the auto-dispatch (return success +
  //    dispatchDeferredReason) — the quick API stays idempotent-safe. Only RECOVERABLE codes are
  //    swallowed: a same-home in-flight rerun (releases when it reaches done+output) + a concurrent
  //    target change (re-plan against the new target). NON-recoverable conflicts (terminal task,
  //    unparseable snapshot, never-run/unsafe frontier, not-deferred, designer multi-target/borrow)
  //    are RETHROWN — the board can't recover them either, so masking them as success would promise a
  //    rerun that can never mint (Codex round-6). Non-ConflictErrors always throw.
  let dispatchDeferredReason: string | undefined
  const tryDispatch = async (): Promise<DispatchTaskQuestionsResult> => {
    try {
      return await dispatchTaskQuestions(db, round.taskId, entryIds, args.actor)
    } catch (err) {
      if (err instanceof ConflictError && RECOVERABLE_DISPATCH_CONFLICTS.has(err.code)) {
        dispatchDeferredReason = err.code
        log.warn(
          'autodispatch deferred to manual board dispatch (recoverable post-seal conflict)',
          {
            taskId: round.taskId,
            originNodeRunId,
            reason: err.code,
          },
        )
        return EMPTY_DISPATCH
      }
      throw err
    }
  }

  let dispatch: DispatchTaskQuestionsResult
  if (entryIds.length === 0) {
    dispatch = EMPTY_DISPATCH
  } else if (selfRollbackRun !== null) {
    const selfRun = selfRollbackRun
    dispatch = await getTaskWriteSem(round.taskId).run(async () => {
      // Codex round-8/9/10 (high) — PRE-ROLLBACK same-home open-ledger guard (mirrors the legacy
      // submit-side pre-rollback guard, clarify.ts). The DESTRUCTIVE rollback runs BEFORE tryDispatch,
      // which treats a same-home in-flight conflict (task-question-node-dispatch-in-flight) as
      // RECOVERABLE + returns success. So if the self HOME already holds an OPEN (unconsumed) rerun
      // ledger — a DISPATCHED entry (any deferred role) OR an IMMEDIATE quick-channel continuation
      // (pending node_run, no dispatched_at; round-9) — an unconditional rollback would rewrite the
      // worktree UNDER it while the request still succeeds. selfHomeHasOpenLedger mirrors BOTH gates
      // dispatchTaskQuestions runs; on a hit, DEFER WITHOUT touching the worktree (the new entries stay
      // parked for a later board dispatch once the owning rerun reaches done+output).
      //
      // Round-10 ATOMICITY: the {claimed/selfHomeHasOpenLedger recheck → rollback} MUST hold the
      // question-write lock B too (under A), else a concurrent board dispatch / no-rollback autodispatch
      // can acquire B in the gap, stamp dispatched_at + mint a same-home rerun AFTER this clean preflight
      // but BEFORE the rollback resets the worktree → clobber. B serializes the preflight+rollback vs
      // dispatchTaskQuestions (which takes B). B is RELEASED before tryDispatch (which re-takes B —
      // non-reentrant Semaphore(1) would deadlock if B were still held). Lock order A ≻ B (A outer);
      // B is taken twice SEQUENTIALLY under A (preflight+rollback, then the dispatch), never nested.
      // This mirrors submitClarifyAnswers' A⊃B rollback critical section (RFC-098 B1 + §5.2.15).
      const rolledBack = await getTaskQuestionWriteSem(round.taskId).run(async () => {
        const claimed = await db
          .select({ id: taskQuestions.id })
          .from(taskQuestions)
          .where(and(inArray(taskQuestions.id, entryIds), isNotNull(taskQuestions.dispatchedAt)))
        if (claimed.length > 0 || (await selfHomeHasOpenLedger(db, round.taskId, selfRun.nodeId))) {
          return false // an open same-home ledger owns the home → defer WITHOUT rolling back
        }
        const target = await loadRollbackTarget(db, round.taskId)
        if (target !== null) {
          try {
            await rollbackNodeRunWorktrees(target, selfRun, { resetOnEmptySnapshot: false }, log)
          } catch (err) {
            log.warn('autodispatch self rollback failed', {
              nodeRunId: selfRun.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        return true
      })
      if (!rolledBack) {
        // Same-home open ledger → DEFER (no rollback, no mint). The in-flight gate in
        // dispatchTaskQuestions would reject anyway; the entries stay sealed-undispatched + parked.
        dispatchDeferredReason = 'task-question-node-dispatch-in-flight'
        log.warn(
          'autodispatch self rollback DEFERRED — same-home open rerun ledger owns the worktree',
          { taskId: round.taskId, originNodeRunId, home: selfRun.nodeId },
        )
        return EMPTY_DISPATCH
      }
      // B released → dispatch (re-takes B; A still held OUTER → A ≻ B, no reentry). A concurrent mint
      // that lands AFTER this rollback is a FRESH pending rerun (blocked by A from running) → not
      // clobbered; tryDispatch then catches its in-flight conflict + defers, no double-mint.
      return tryDispatch()
    })
  } else {
    dispatch = await tryDispatch()
  }

  // 7. RFC-132 PR-B (§6 designer 切自动下发) — a CROSS round's DESIGNER-scoped entries (sealed in
  //    step 3) are aggregated to their effective target designer(s) and auto-dispatched via the SAME
  //    dispatchTaskQuestions the board uses, replacing the legacy submitCrossClarifyAnswers →
  //    triggerDesignerRerun immediate mint. Multi-source readiness (assertDesignerReady inside
  //    dispatchTaskQuestions) rejects with 'task-question-designer-not-ready' until EVERY sibling
  //    cross-clarify round targeting the designer is answered — swallow it (park 等齐; the LAST
  //    sibling's answer aggregates + dispatches the whole batch, so buildNodeQueueExternalFeedback
  //    injects every source's Q&A in one designer rerun). A same-home in-flight designer rerun / a
  //    concurrent reassign are likewise deferrable (a later dispatch mints it). dispatchTaskQuestions
  //    takes lock B internally — this is a THIRD sequential B acquisition after the seal + self/q
  //    dispatch (never nested). self rounds have no designer entries ⇒ no-op for kind==='self'.
  let designerDispatch: DispatchTaskQuestionsResult = EMPTY_DISPATCH
  if (round.kind === 'cross') {
    // This round's sealed-undispatched-open designer entries → their effective target designer(s)
    // (override ?? graph designer).
    const thisRoundDesigner = await db
      .select({
        defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
        overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
      })
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, originNodeRunId),
          eq(taskQuestions.roleKind, 'designer'),
          isNull(taskQuestions.dispatchedAt),
          eq(taskQuestions.confirmation, 'open'),
          isNotNull(taskQuestions.sealedAt),
        ),
      )
    const targetDesignerNodes = new Set(
      thisRoundDesigner
        .map((e) => e.overrideTargetNodeId ?? e.defaultTargetNodeId)
        .filter((t): t is string => t !== null && t !== ''),
    )
    if (targetDesignerNodes.size > 0) {
      // Aggregate ALL sibling rounds' sealed-undispatched-open designer entries for these designers,
      // so the LAST sibling's answer dispatches the full multi-source batch in one call.
      const allDesigner = await db
        .select()
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.taskId, round.taskId),
            eq(taskQuestions.roleKind, 'designer'),
            isNull(taskQuestions.dispatchedAt),
            eq(taskQuestions.confirmation, 'open'),
            isNotNull(taskQuestions.sealedAt),
          ),
        )
      const designerEntryIds = allDesigner
        .filter((e) =>
          targetDesignerNodes.has(e.overrideTargetNodeId ?? e.defaultTargetNodeId ?? ''),
        )
        .map((e) => e.id)
      if (designerEntryIds.length > 0) {
        try {
          designerDispatch = await dispatchTaskQuestions(
            db,
            round.taskId,
            designerEntryIds,
            args.actor,
          )
        } catch (err) {
          if (err instanceof ConflictError && DESIGNER_DEFERRABLE_CONFLICTS.has(err.code)) {
            log.info('designer auto-dispatch deferred (park 等齐 — siblings pending / in-flight)', {
              taskId: round.taskId,
              originNodeRunId,
              reason: err.code,
            })
          } else {
            throw err
          }
        }
      }
    }
  }
  // Fold the designer dispatch into the returned result so the route resumes the designer rerun too
  // (concat is a no-op when the designer batch was empty / deferred).
  dispatch = {
    reruns: [...dispatch.reruns, ...designerDispatch.reruns],
    dispatchedEntryIds: [...dispatch.dispatchedEntryIds, ...designerDispatch.dispatchedEntryIds],
    deferred: [...dispatch.deferred, ...designerDispatch.deferred],
  }

  log.info('clarify round auto-dispatched (quick channel, deferred)', {
    taskId: round.taskId,
    originNodeRunId,
    kind: round.kind,
    sealedCount: sealedQuestionIds.length,
    roundFullySealed,
    dispatchedEntryCount: dispatch.dispatchedEntryIds.length,
    deferredEntryCount: dispatch.deferred.length,
    rerunCount: dispatch.reruns.length,
    ...(dispatchDeferredReason !== undefined ? { dispatchDeferredReason } : {}),
  })

  return {
    taskId: round.taskId,
    kind: round.kind,
    sealedQuestionIds,
    roundFullySealed,
    dispatch,
    ...(dispatchDeferredReason !== undefined ? { dispatchDeferredReason } : {}),
  }
}
