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
import { clarifyRounds, taskQuestions, tasks } from '@/db/schema'
import { sealRoundQuestions } from '@/services/clarifySeal'
import {
  dispatchTaskQuestions,
  type DispatchTaskQuestionsResult,
} from '@/services/taskQuestionDispatch'
import { loadSealedQuestionIds } from '@/services/taskQuestions'
import { ConflictError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import type { ClarifyAnswer, ClarifyDirective, ClarifyQuestionScope } from '@agent-workflow/shared'

const log = createLogger('clarify-auto-dispatch')

const EMPTY_DISPATCH: DispatchTaskQuestionsResult = {
  reruns: [],
  dispatchedEntryIds: [],
  deferred: [],
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

  // 1. Locate the round (kind + task). The route already gated membership; this is the data read.
  const round = (
    await db
      .select({
        kind: clarifyRounds.kind,
        taskId: clarifyRounds.taskId,
        status: clarifyRounds.status,
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

  // 2. Defensive deferred re-check — autodispatch is the SINGLE per-question path, valid ONLY on a
  //    deferred task. The route routes non-deferred quick answers to the legacy immediate mint, so
  //    this guards a direct service caller (and matches dispatchTaskQuestions' own deferred gate).
  const taskRow = (
    await db
      .select({ deferred: tasks.deferredQuestionDispatch })
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

  // 3. Seal the round (control channel). A quick whole-round finalize seals every question; an
  //    earlier control-channel partial seal already locked some questions (sealed_at set), and
  //    sealRoundQuestions rejects re-sealing a locked question — so seal only the not-yet-sealed
  //    subset (the locked answers are preserved by their existing sealed_at). If EVERYTHING is
  //    already sealed (all locked), skip the seal and go straight to dispatch. sealRoundQuestions
  //    takes lock B internally; this is OUTSIDE any B (no nesting).
  const lockedIds = await loadSealedQuestionIds(db, originNodeRunId)
  const sealAnswers = args.answers.filter((a) => !lockedIds.has(a.questionId))
  let sealedQuestionIds: string[] = []
  let roundFullySealed = round.status === 'answered'
  if (sealAnswers.length > 0) {
    const sealResult = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: sealAnswers,
      // RFC-128 P5-0 stranding guard, NARROWED by P5-BC (§5.2.1): the guard is LIFTED on a deferred
      // task (the self/questioner park + dispatch path below IS the release path). Opt in anyway so a
      // direct misuse on a non-deferred task (already rejected above) stays consistent with the route.
      rejectSelfQuestionerFullSeal: true,
      ...(args.directive !== undefined ? { directive: args.directive } : {}),
      ...(args.scopes !== undefined ? { scopes: args.scopes } : {}),
      sealedBy: args.actor.userId,
      ...(args.now !== undefined ? { now: args.now } : {}),
    })
    sealedQuestionIds = sealResult.sealedQuestionIds
    roundFullySealed = sealResult.roundFullySealed
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

  // 5. AUTO-dispatch — the SAME dispatchTaskQuestions the board's manual 批量下发 calls (single path).
  //    It takes lock B internally (NOT nested inside the seal's B — sequential, no reentry). When the
  //    round produced no dispatchable self/questioner entry (e.g. a designer-only cross round whose
  //    questioner entries were already dispatched) this is a no-op.
  const dispatch =
    entries.length > 0
      ? await dispatchTaskQuestions(
          db,
          round.taskId,
          entries.map((e) => e.id),
          args.actor,
        )
      : EMPTY_DISPATCH

  log.info('clarify round auto-dispatched (quick channel, deferred)', {
    taskId: round.taskId,
    originNodeRunId,
    kind: round.kind,
    sealedCount: sealedQuestionIds.length,
    roundFullySealed,
    dispatchedEntryCount: dispatch.dispatchedEntryIds.length,
    deferredEntryCount: dispatch.deferred.length,
    rerunCount: dispatch.reruns.length,
  })

  return {
    taskId: round.taskId,
    kind: round.kind,
    sealedQuestionIds,
    roundFullySealed,
    dispatch,
  }
}
