// RFC-128 — per-question answer seal primitive (落库方案 C).
//
// This is the storage-layer vehicle the per-question answer endpoints (P2) and the
// centralized-answer pane (P4) build on. It seals a SUBSET of a clarify round's
// questions without minting any rerun (the defer/control channel; the quick-channel
// rerun mint stays in clarify.ts/crossClarify.ts). The ENTIRE sequence runs inside ONE
// dbTxSync (RFC-128 P2-1): the round + its entries are re-read inside the transaction
// and every write commits atomically, so two overlapping seals on the same round cannot
// lose-update answers_json or land "all sealed but round still awaiting_human". For each
// call it:
//
//   1. seals the passed answers server-side (sealAnswersServerSide — option-label
//      forgery defense, unknown-question drop) and MERGES them into the round's
//      `answers_json` (per-question merge-write; answers stay the content SoT);
//   2. merges any per-question scope choice into the round's `question_scopes_json`
//      (scope is chosen when a cross question is answered — RFC-128 §4 / P2-3);
//   3. reconciles the round's task_questions entries (questioner/self always; a designer
//      entry per SEALED designer-scope question — RFC-128 P3 per-question gate, including
//      the just-sealed subset of THIS call, since the sealed_at stamp (4) runs after);
//   4. stamps `sealed_at` on the (question × role) entries sealed by THIS call;
//   5. flips the round → 'answered' ONLY when EVERY question is now sealed (T4); a
//      partial seal leaves the round 'awaiting_human' (partial is a pure derived state,
//      never a new DB status — protects RFC-126's failed→resume invariant).
//
// Golden-lock: sealing ALL of a virgin round's questions in one call reproduces the old
// whole-round seal byte-for-byte on the observable columns (answers_json content +
// status flip), since merge-into-empty == overwrite and all-sealed == flip.
//
// Re-sealing an already-sealed question is rejected (the quick channel + control
// channel share this per-question state — a question can be sealed exactly once) —
// EXCEPT the RFC-136 re-answer path: a sealed question whose every non-echo entry is
// still 待指派 (dispatched_at IS NULL AND staged_at IS NULL — e.g. moved back out of
// 待下发) may be RE-sealed, overwriting its answers_json value in place (用户拍板
// 直接覆盖，无 prior_answer_snapshot_json / reopen_count — those stay dormant for the
// future RFC-120 AC-11 打回 flow). Any staged/dispatched entry keeps the 409.

import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { clarifyRounds, nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { parseAnswersArray, sealAnswersServerSide } from '@/services/clarify'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'
import { reconcileRoundEntriesTx } from '@/services/taskQuestions'
import { wgClarifyAskerKeyForRound } from './workgroup/askerKey'
import { setNodeClarifyDirective } from '@/services/taskClarifyDirective'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  mergeSealedAnswers,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
} from '@agent-workflow/shared'

export interface SealRoundQuestionsArgs {
  db: DbClient
  /** The clarify round's intermediary node_run id (= clarify_rounds.intermediaryNodeRunId
   *  = task_questions.originNodeRunId). Locates the round to seal into. */
  originNodeRunId: string
  /** The answers to seal in THIS call (a subset of the round's questions, or all of
   *  them). Sealed + merged into the round's answers_json; only known question ids are
   *  honored (unknowns dropped, matching sealAnswersServerSide). */
  answers: ClarifyAnswer[]
  /** Audit-only setter id (RFC-099 — NEVER enters an agent prompt). Stamped on the
   *  sealed entries' sealed_by and, when the round flips, on the round's answered_by. */
  sealedBy?: string
  /** RFC-128 P2 (Codex P2-2) — round-level directive ('continue' | 'stop'), threaded from
   *  the answer body so the control channel matches the quick path's directive semantics:
   *  it is persisted to clarify_rounds.directive (+ the legacy session) and FEEDS the
   *  reconcile designer gate (a 'stop' round produces NO designer entries). When the round
   *  fully seals with 'stop' the canvas directive (RFC-123 nodeStopOverride) is also written
   *  (post-tx, mirroring submitClarifyAnswers/submitCrossClarifyAnswers). When omitted the
   *  round's existing directive is preserved, defaulting to 'continue' — NB this default is
   *  also what the §18 designer park requires (loadUndispatchedDesignerTargets filters
   *  directive='continue'), so a full continue-seal correctly parks until board dispatch. */
  directive?: ClarifyDirective
  /** RFC-128 (用户 2026-07-01) — AUTO-STAGE: when true, stamp `staged_at` on THIS call's sealed
   *  entries INSIDE the seal tx, so a sealed question lands directly in 待下发 (staged) — ready for
   *  the board's "批量下发全下" (dispatchTaskQuestions = ALL staged) — instead of 待指派 (pending,
   *  which needs a manual 移入待下发). Opted in ONLY by the centralized-answer control channel
   *  (routes/clarify.ts defer=true branch). NOT passed by autoDispatchClarifyRound (P5-D dispatches
   *  immediately — staging is unnecessary and could perturb its flow) nor the raw primitive, so a
   *  non-autoStage seal is BYTE-FOR-BYTE unchanged (golden-lock). Same target set + IS-NULL
   *  idempotency as the `sealed_at` stamp (step 4); `staged_by` mirrors `sealed_by` (RFC-099
   *  audit-only setter id — NEVER enters an agent prompt). Does NOT affect the park sources
   *  (loadUndispatched{Designer,SelfQuestioner}Targets key on round status / sealed_at, not
   *  staged_at) → RFC-076 定序 / P5 park behaviour unchanged. */
  autoStage?: boolean
  /** RFC-136 (D7, Codex 实现门 P2 fold) — per-question re-answer DECLARATION: a sealed
   *  question may be RE-sealed (overwritten in place) ONLY when (a) its id is in this set
   *  AND (b) its every non-echo entry is still 待指派 (un-staged, un-dispatched). Only the
   *  centralized-answer control channel (routes/clarify.ts defer=true) forwards the
   *  client's `resubmitQuestionIds` here — the declaration means the pane SHOWED the
   *  committed answer and the user edited it on purpose. A per-question set (not a route
   *  boolean) closes the cross-channel race: a pane submission landing inside a QUICK
   *  submit's seal→dispatch lock-B window sees the question sealed, but the pane user
   *  never declared it (they thought it fresh) → exactly-once 409 → no silent overwrite
   *  of the in-flight answer. The quick channel itself never passes this (its own
   *  double-submit stays 409 → no double-mint, rfc128-p5-bc §5.2.14 finding 1).
   *  Omitted/empty ⇒ pre-RFC-136 behaviour byte-for-byte. */
  allowResealFor?: readonly string[]
  now?: () => number
}

export interface SealRoundQuestionsResult {
  /** Question ids FRESH-sealed by THIS call (after dropping unknowns + de-dup). RFC-136:
   *  re-sealed (re-answer) ids are NOT in here — see resealedQuestionIds. */
  sealedQuestionIds: string[]
  /** RFC-136 — question ids RE-sealed by this call (a previously-sealed 待指派 question
   *  whose answer was overwritten in place). Empty on a pure fresh seal (golden-lock). */
  resealedQuestionIds: string[]
  /** True when, after this call, EVERY question of the round is sealed → the round was
   *  flipped to 'answered'. False = partial seal (round stays 'awaiting_human'). */
  roundFullySealed: boolean
}

function parseQuestions(json: string): ClarifyQuestion[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyQuestion[]) : []
  } catch {
    return []
  }
}

/** RFC-128 §7/§10 — seal a subset of a clarify round's questions (control channel; no
 *  rerun mint). The whole sequence runs in ONE dbTxSync (P2-1): the round + entries are
 *  re-read inside the transaction (no TOCTOU) and all writes commit atomically. Async
 *  signature, fully-synchronous body (dbTxSync requires it) — `await`-able by callers and
 *  rejects cleanly when a guard throws. See the file header for the full contract. */
export async function sealRoundQuestions(
  args: SealRoundQuestionsArgs,
): Promise<SealRoundQuestionsResult> {
  const ts = (args.now ?? Date.now)()
  // RFC-128 §5.2.14 final-gate finding 2: sealRoundQuestions writes the round's answers/task_questions
  // and so MUST serialize on the SAME per-task QUESTION-WRITE lock B as the quick submit paths — else
  // a control-channel seal can commit a locked answer in the window where a concurrent quick submit
  // already read lockedIds (empty) and is about to write a stale whole-round answersJson over it
  // (data loss, breaks P2-2). The taskId is read first (for the lock); the tx re-reads the round
  // (TOCTOU-free). Lock order: sealRoundQuestions is HTTP-route-only (never under the scheduler's A),
  // takes B alone → no A→B/B→A cycle. The post-tx setNodeClarifyDirective stays outside B (different
  // table, no answers/question write).
  const taskIdRow = (
    await args.db
      .select({ taskId: clarifyRounds.taskId })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, args.originNodeRunId))
      .limit(1)
  )[0]
  const runSealTx = async () =>
    dbTxSync(args.db, (tx) => {
      // Re-read the round INSIDE the tx so a concurrent seal's committed answers/status are
      // observed (TOCTOU-free).
      const round = tx
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, args.originNodeRunId))
        .all()[0]
      if (round === undefined) {
        throw new NotFoundError(
          'clarify-round-not-found',
          `no clarify_round for origin node_run ${args.originNodeRunId}`,
        )
      }
      // RFC-126: a terminal/aborted round is not sealable (it produces no actionable
      // entries; sealing it would resurrect a dead round).
      if (round.status === 'canceled' || round.status === 'abandoned') {
        throw new ConflictError(
          'clarify-round-terminal',
          `clarify_round ${round.id} is '${round.status}'; cannot seal questions on it`,
        )
      }
      // RFC-202 T2 write-path guard: the read-path terminal filter and the
      // terminal sweep can both be raced or (hook failure) missed — the WRITE
      // must independently refuse to persist answers into a task that is
      // already done/canceled. Same-tx read keeps it TOCTOU-free. failed /
      // interrupted stay answerable (revivable, design §1).
      const owningTask = tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, round.taskId))
        .all()[0]
      if (
        owningTask !== undefined &&
        (owningTask.status === 'done' || owningTask.status === 'canceled')
      ) {
        throw new ConflictError(
          'task-terminal',
          `task ${round.taskId} is '${owningTask.status}'; this clarify round is sealed and no longer accepts answers`,
        )
      }

      const questions = parseQuestions(round.questionsJson)
      const questionIds = new Set(questions.map((q) => q.id))

      // Seal the passed answers (option-label forgery defense + unknown-question drop), then
      // keep only those that target a real question of this round.
      const sealedSubset = sealAnswersServerSide(questions, args.answers).filter((a) =>
        questionIds.has(a.questionId),
      )
      const sealingSet = new Set(sealedSubset.map((a) => a.questionId))
      if (sealingSet.size === 0) {
        throw new ValidationError(
          'clarify-seal-empty',
          'no sealable answers (the subset references no known question of this round)',
        )
      }

      // Which questions are ALREADY sealed: the whole round answered (all) OR an entry with
      // a sealed_at marker. Read inside the tx so the check + the stamp below are atomic
      // (no double-seal race). RFC-136 — per-question triage instead of a blanket reject:
      //   fresh    not sealed yet → the unchanged exactly-once path (golden-lock);
      //   reseal   sealed, and EVERY non-echo entry of the (origin, question) is still
      //            待指派 (dispatched_at IS NULL AND staged_at IS NULL — e.g. moved back
      //            out of 待下发) → overwrite the answer in place (用户拍板 直接覆盖);
      //   rejected everything else (staged / dispatched / no visible entry) → 409, the
      //            pre-RFC-136 behaviour. echo entries (RFC-134, born-dispatched) neither
      //            veto nor get re-stamped: the receipt card reads the injection face, not
      //            the seal face.
      const existingEntries = tx
        .select({
          questionId: taskQuestions.questionId,
          sealedAt: taskQuestions.sealedAt,
          stagedAt: taskQuestions.stagedAt,
          dispatchedAt: taskQuestions.dispatchedAt,
          roleKind: taskQuestions.roleKind,
        })
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, args.originNodeRunId))
        .all()
      const alreadySealed = new Set<string>()
      if (round.status === 'answered') for (const q of questions) alreadySealed.add(q.id)
      for (const e of existingEntries) if (e.sealedAt !== null) alreadySealed.add(e.questionId)
      const declaredReseal = new Set(args.allowResealFor ?? [])
      const resealSet = new Set<string>()
      for (const id of sealingSet) {
        if (!alreadySealed.has(id)) continue
        const rows = existingEntries.filter((e) => e.questionId === id)
        const resealable =
          declaredReseal.has(id) &&
          rows.length > 0 &&
          rows.every((e) => e.dispatchedAt === null && e.stagedAt === null)
        if (!resealable) {
          throw new ConflictError(
            'clarify-question-already-sealed',
            `question '${id}' is already sealed; only a 待指派 (pending, un-staged, un-dispatched) question explicitly declared for re-answer can be overwritten`,
          )
        }
        resealSet.add(id)
      }
      const freshSet = new Set([...sealingSet].filter((id) => !resealSet.has(id)))

      // (1) Merge the sealed subset into the round's answers_json (per-question merge-write).
      // Fresh ids never overwrite a locked answer (they were unsealed); RFC-136 reseal ids
      // overwrite their previous value ON PURPOSE (直接覆盖 — D3).
      const merged = mergeSealedAnswers(parseAnswersArray(round.answersJson), sealedSubset)
      const mergedJson = JSON.stringify(merged)

      // RFC-162: step (2) per-question scope merge DELETED (scope removed). The round's
      // `question_scopes_json` column is no longer written (stays whatever it was, unread).

      // (5) Flip the round → answered ONLY when EVERY question is now sealed. RFC-136:
      // `flipNow` gates every flip side effect (status/answeredAt/directive persist, legacy
      // dual-write flip, node_run close, stop finalization) to the transition INTO answered —
      // a re-answer on an already-answered round only rewrites answers_json + entry stamps
      // (AC-3: no re-flip, answeredAt/answeredBy preserved, no duplicate park/WS side effects).
      const wasAnswered = round.status === 'answered'
      const newSealed = new Set<string>([...alreadySealed, ...sealingSet])
      const fullySealed = questions.every((q) => newSealed.has(q.id))
      const flipNow = fullySealed && !wasAnswered

      // RFC-128 P2 (Codex P2-2) — round-level directive. Provided wins; else keep the round's
      // existing value; else default 'continue'. Fed (in-memory) to the reconcile designer gate
      // and persisted to clarify_rounds + the legacy session ONLY on a FULL seal (see directive
      // gate below). The 'continue' default is REQUIRED for the §18 designer park:
      // loadUndispatchedDesignerTargets filters clarify_rounds.directive='continue', so a NULL
      // directive would leave a fully-sealed designer round un-parked → (with the node-run
      // closed below) the task would advance past it instead of waiting for board dispatch. A
      // 'stop' round produces NO designer entries (reconcileDesiredEntries).
      // RFC-136: an ALREADY-answered round keeps its committed directive — the re-answer body
      // carries the schema default 'continue', which must NOT re-run reconcile with continue
      // semantics on a finalized 'stop' round (it would wrongly grow designer entries).
      const effectiveDirective: ClarifyDirective = wasAnswered
        ? ((round.directive as ClarifyDirective | null) ?? 'continue')
        : (args.directive ?? (round.directive as ClarifyDirective | null) ?? 'continue')

      // RFC-132 PR-B (universal deferred model, §6) — the RFC-128 P5-0 stranding guard is REMOVED.
      // It rejected a self/questioner FULL seal on a NON-deferred task (no park/dispatch release path
      // → the quick channel's continuation would strand). Under the universal deferred model EVERY
      // task has the self/questioner park source (loadUndispatchedParkTargets) + control-channel
      // dispatch release path, so a full seal parks (never strands) for all tasks — the guard is
      // lifted universally. The former opt-in guard arg (a no-op after the lift) was deleted in
      // the flag audit W0 (design/flag-audit-2026-07-07.md §3); the `deferredQuestionDispatch`
      // flag is no longer read here.

      // RFC-128 P2 (Codex P2-2 follow-up) + RFC-132 T7 — persist the directive ONLY when the
      // round fully seals; a PARTIAL seal writes it to NEITHER table:
      //   - stop detection now reads the questioner node's node-level directive
      //     (task_node_clarify_directives, via resolveCrossNodeStopped). The node-level write
      //     below (setNodeClarifyDirective, gated on stopFinalized = fullySealed) must NOT fire
      //     on a partial seal, or a 'stop' would be taken as a PERMANENT node stop and
      //     short-circuit the cross node BEFORE the round is answered. crossClarifySessions.directive
      //     is audit-only now, but is kept in lockstep (gated the same way) so the two never disagree;
      //   - clarify_rounds.directive's only scheduling reader (loadUndispatchedDesignerTargets)
      //     filters status='answered', so a partial round's directive is never consulted.
      // Deferring both writes to full seal matches "partial seal is pure derived state, changes
      // nothing schedulable". The reconcile below still uses the IN-MEMORY effectiveDirective (a
      // partial seal produces no designer entries regardless — P2-4a).
      const directiveSet = flipNow ? { directive: effectiveDirective } : {}

      // Write clarify_rounds (the SoT): merged answers + merged scopes; flip status (+ directive
      // + answeredAt) only when fully sealed NOW (RFC-136: an answered round being re-answered
      // keeps its original answeredAt/answeredBy/directive). Keep status 'awaiting_human' on a
      // partial seal (NEVER a new DB 'partial' status — RFC-128 §2 / RFC-126).
      tx.update(clarifyRounds)
        .set({
          answersJson: mergedJson,
          ...directiveSet,
          ...(flipNow
            ? {
                status: 'answered' as const,
                answeredAt: ts,
                ...(args.sealedBy !== undefined ? { answeredBy: args.sealedBy } : {}),
              }
            : {}),
        })
        .where(eq(clarifyRounds.id, round.id))
        .run()

      // RFC-217 T8（真 T17）—— 双写退役：clarify_rounds 即唯一数据源。

      // RFC-128 P2 (Codex P1) — on FULL seal, close the intermediary clarify/cross-clarify
      // node_run (awaiting_human → done) ATOMICALLY with the round flip (same dbTxSync).
      // Without this the answered round's clarify node_run stays awaiting_human and
      // deriveFrontier buckets it into awaitingHuman FOREVER: loadOpenClarify keys off the
      // SESSION status (already flipped to answered here), but the node_run's own
      // awaiting_human status is an INDEPENDENT park signal (scheduler.ts deriveFrontier) — so
      // the deferred round parks permanently, unresolvable even by a later board dispatch of
      // the staged designer questions. Mirrors the quick path's resume-clarify transition
      // (clarify.ts/crossClarify.ts). DEFER semantics are kept: NO rerun is minted and NO
      // resumeTask runs — the designer reruns fire later via board dispatch (P3 借壳), held
      // meanwhile by the §18 designer park (directive='continue' written above). The CAS on
      // status='awaiting_human' makes it a safe no-op if the node already left that state.
      // rfc053-allow-direct-status-write -- atomic clarify-node close on full seal (mirrors resume-clarify)
      // (RFC-136: flipNow — an answered round's node_run is already closed; the CAS would
      // no-op anyway, the gate just keeps the re-answer path free of flip side effects.)
      if (flipNow) {
        tx.update(nodeRuns)
          .set({ status: 'done', finishedAt: ts })
          .where(and(eq(nodeRuns.id, args.originNodeRunId), eq(nodeRuns.status, 'awaiting_human')))
          .run()
      }

      // (3) Reconcile against the EFFECTIVE round (status reflects the writes above). RFC-162:
      // reconcile emits only the ONE asker (self/questioner) entry per question — no designer
      // gate, no seal/scope/directive inputs. The questioner/self rows are unconditional; their
      // `sealed_at` is stamped in step (4) below. Done on the SAME tx (dbTxSync can't nest).
      reconcileRoundEntriesTx(tx, {
        ...round,
        status: fullySealed ? 'answered' : round.status,
        answersJson: mergedJson,
        // RFC-136: keep the committed answeredAt on a re-answer (flipNow only).
        answeredAt: flipNow ? ts : round.answeredAt,
      })

      // (4) Stamp sealed_at on the (question × role) entries sealed by THIS call that are
      // not yet stamped. Idempotent via IS NULL. (Designer entries created above for a
      // fully-sealed round derive `sealed` from round.status — no backfill needed.)
      tx.update(taskQuestions)
        .set({ sealedAt: ts, sealedBy: args.sealedBy ?? null, updatedAt: ts })
        .where(
          and(
            eq(taskQuestions.originNodeRunId, args.originNodeRunId),
            inArray(taskQuestions.questionId, [...sealingSet]),
            isNull(taskQuestions.sealedAt),
          ),
        )
        .run()

      // (4a) RFC-136 — RE-seal stamp: a re-answered question's entries get their
      // sealed_at/sealed_by moved to THIS call (unconditional — they are already stamped, the
      // IS-NULL write above skips them). (RFC-162: the echo exemption is gone — echo deleted.)
      if (resealSet.size > 0) {
        tx.update(taskQuestions)
          .set({ sealedAt: ts, sealedBy: args.sealedBy ?? null, updatedAt: ts })
          .where(
            and(
              eq(taskQuestions.originNodeRunId, args.originNodeRunId),
              inArray(taskQuestions.questionId, [...resealSet]),
            ),
          )
          .run()
      }

      // (4b) RFC-128 (用户 2026-07-01) — AUTO-STAGE: opt-in (centralized-answer control channel).
      // Stamp `staged_at` on THIS call's sealed entries in the SAME tx so a sealed question lands
      // directly in 待下发 (staged) — pickup-ready for the board's "批量下发全下" — instead of 待指派
      // (pending, which needs a manual 移入待下发). Target set + IS-NULL idempotency MIRROR (4)'s
      // sealed_at stamp. staged_by mirrors sealed_by (RFC-099 audit-only). NOT set
      // when autoStage is falsy → golden-lock: autoDispatch / raw-primitive seals are byte-for-byte
      // unchanged, and the park sources are unaffected (they key on round status / sealed_at).
      // RFC-136 (D4): reseal ids are in sealingSet too — the reseal guard proved staged_at IS NULL
      // on every non-echo entry, so a re-answered question auto-stages back into 待下发 exactly
      // like a fresh answer (改完即待发); echo rows keep their stamp via the IS-NULL guard.
      if (args.autoStage === true) {
        tx.update(taskQuestions)
          .set({ stagedAt: ts, stagedBy: args.sealedBy ?? null, updatedAt: ts })
          .where(
            and(
              eq(taskQuestions.originNodeRunId, args.originNodeRunId),
              inArray(taskQuestions.questionId, [...sealingSet]),
              isNull(taskQuestions.stagedAt),
            ),
          )
          .run()
      }

      return {
        // RFC-136: fresh-only — reseal ids are reported separately (quick-path consumers
        // like autoDispatch count fresh seals; a reseal never happens on their virgin rounds).
        sealedQuestionIds: [...freshSet],
        resealedQuestionIds: [...resealSet],
        roundFullySealed: fullySealed,
        // Post-tx side effect inputs (RFC-128 P2 Codex P2-2): mirror the quick path's
        // stop → canvas directive write when the round FINALIZES with 'stop'. RFC-136:
        // flipNow — a re-answer on an answered round never re-fires the canvas write.
        stopFinalized: flipNow && effectiveDirective === 'stop',
        taskId: round.taskId,
        askingNodeId: round.askingNodeId,
        askingShardKey: round.askingShardKey,
      }
    })
  // Run the seal tx UNDER the per-task question-write lock B (finding 2). If the round is missing the
  // taskId lookup is empty — run unlocked so the tx throws the canonical NotFoundError.
  const txResult =
    taskIdRow !== undefined
      ? await getTaskQuestionWriteSem(taskIdRow.taskId).run(runSealTx)
      : await runSealTx()

  // RFC-128 P2 (Codex P2-2) — mirror submitClarifyAnswers/submitCrossClarifyAnswers: a 'stop'
  // answer also writes the per-(task, asking-node) clarify directive (RFC-123 canvas toggle /
  // nodeStopOverride) so the toggle reflects the choice durably. Done AFTER the tx
  // (setNodeClarifyDirective is async + writes a different table); the round's own directive
  // is already persisted in-tx. askingNodeId is the source agent (self) or questioner (cross)
  // — the same node the quick paths target. Still NO rerun / NO resume (defer semantics).
  if (txResult.stopFinalized && txResult.askingNodeId) {
    // RFC-207 — the 6th arg stops the ASKER that asked, not every asker on the
    // node. The round records which shard asked; the key function collapses a
    // workgroup message turn to its member so a stop survives the next message.
    await setNodeClarifyDirective(
      args.db,
      txResult.taskId,
      txResult.askingNodeId,
      'stop',
      args.sealedBy ?? 'local',
      wgClarifyAskerKeyForRound(txResult.askingNodeId, txResult.askingShardKey ?? null),
    )
  }
  return {
    sealedQuestionIds: txResult.sealedQuestionIds,
    resealedQuestionIds: txResult.resealedQuestionIds,
    roundFullySealed: txResult.roundFullySealed,
  }
}
