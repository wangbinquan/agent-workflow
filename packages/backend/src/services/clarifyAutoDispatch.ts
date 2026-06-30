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
// B for its tx; dispatchTaskQuestions acquires + RELEASES B for its tx. This module calls them
// SEQUENTIALLY (never nesting one inside the other under a held B) — so B is taken twice in series,
// never re-entered. Wrapping the dispatch inside the seal's B would deadlock (B is held → dispatch's
// B.acquire() queues forever). The seal-commit→dispatch gap is race-safe: dispatchTaskQuestions
// re-reads under B and CAS-guards every entry (`dispatched_at IS NULL` + `confirmation='open'`) +
// re-runs its readiness / in-flight / immediate-ledger gates, so any interleaving is caught there
// (no double-mint, no stamp of a superseded entry).
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
import { clarifyRounds, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { resolveClarifyNodeFromTaskSnapshot } from '@/services/clarify'
import { sealRoundQuestions } from '@/services/clarifySeal'
import { loadRollbackTarget, rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import {
  dispatchTaskQuestions,
  type DispatchTaskQuestionsResult,
} from '@/services/taskQuestionDispatch'
import { loadSealedQuestionIds } from '@/services/taskQuestions'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
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

  // 2. Defensive deferred re-check — autodispatch is the SINGLE per-question path, valid ONLY on a
  //    deferred task. The route routes non-deferred quick answers to the legacy immediate mint, so
  //    this guards a direct service caller (and matches dispatchTaskQuestions' own deferred gate).
  const taskRow = (
    await db
      .select({
        deferred: tasks.deferredQuestionDispatch,
        worktreePath: tasks.worktreePath,
        workflowSnapshot: tasks.workflowSnapshot,
      })
      .from(tasks)
      .where(eq(tasks.id, round.taskId))
      .limit(1)
  )[0]
  if (taskRow?.deferred !== true) {
    throw new ConflictError(
      'task-not-deferred-dispatch',
      `task ${round.taskId} is not a deferred-dispatch task; the quick channel mints immediately on a non-deferred task (autodispatch is the deferred single path)`,
    )
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
  //    Codex round-5 — the seal above ALREADY committed (round answered + clarify node closed). If
  //    dispatchTaskQuestions then hits a CONFLICT gate (e.g. a same-home in-flight rerun, a never-run
  //    frontier, a concurrent target change), do NOT surface a FAILED response for the saved answer:
  //    the entries are sealed-undispatched + parked (loadUndispatchedParkTargets) and recoverable via
  //    the board's 批量下发, so DEFER the auto-dispatch (return success + dispatchDeferredReason) — the
  //    quick API stays idempotent-safe. Only dispatch ConflictErrors are caught; other errors throw.
  let dispatchDeferredReason: string | undefined
  const tryDispatch = async (): Promise<DispatchTaskQuestionsResult> => {
    try {
      return await dispatchTaskQuestions(db, round.taskId, entryIds, args.actor)
    } catch (err) {
      if (err instanceof ConflictError) {
        dispatchDeferredReason = err.code
        log.warn('autodispatch deferred to manual board dispatch (post-seal dispatch conflict)', {
          taskId: round.taskId,
          originNodeRunId,
          reason: err.code,
        })
        return EMPTY_DISPATCH
      }
      throw err
    }
  }

  let dispatch: DispatchTaskQuestionsResult
  if (entryIds.length === 0) {
    dispatch = EMPTY_DISPATCH
  } else if (selfRollbackRun !== null) {
    dispatch = await getTaskWriteSem(round.taskId).run(async () => {
      // Skip the destructive rollback if a concurrent dispatch already claimed any of these entries
      // (it owns the worktree state; the dispatch below CAS-skips them anyway) — mirrors the
      // submit-side pre-rollback guard so a stale rollback can't clobber a concurrent rerun.
      const claimed = await db
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(and(inArray(taskQuestions.id, entryIds), isNotNull(taskQuestions.dispatchedAt)))
      if (claimed.length === 0) {
        const target = await loadRollbackTarget(db, round.taskId)
        if (target !== null) {
          try {
            await rollbackNodeRunWorktrees(
              target,
              selfRollbackRun,
              { resetOnEmptySnapshot: false },
              log,
            )
          } catch (err) {
            log.warn('autodispatch self rollback failed', {
              nodeRunId: selfRollbackRun.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      // Dispatch under A (B inner — A ≻ B, no reentry; sealRoundQuestions' B already released).
      return tryDispatch()
    })
  } else {
    dispatch = await tryDispatch()
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
