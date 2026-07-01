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
// channel share this per-question state — a question can be sealed exactly once).

import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  clarifyRounds,
  clarifySessions,
  crossClarifySessions,
  nodeRuns,
  taskQuestions,
} from '@/db/schema'
import { parseAnswersArray, sealAnswersServerSide } from '@/services/clarify'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'
import { reconcileRoundEntriesTx } from '@/services/taskQuestions'
import { setNodeClarifyDirective } from '@/services/taskClarifyDirective'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  mergeSealedAnswers,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
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
  /** Optional per-question scope choice (cross rounds only — chosen at answer time).
   *  Merged into the round's question_scopes_json so the reconcile designer gate can
   *  see it. Ignored for self rounds (no designer). */
  scopes?: Record<string, ClarifyQuestionScope>
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
  /** RFC-128 P5-0 hotfix stranding guard, NARROWED by P5-BC (§5.2.1) — when true, REJECT a full
   *  seal of a self/questioner-continuation round (a self round, or a cross round with a
   *  questioner-scope question / directive=stop) **only on a NON-deferred task**. On a NON-deferred
   *  task there is no self/questioner park source (loadUndispatchedSelfQuestionerTargets self-gates
   *  on the deferred flag), so such a full seal would close the intermediary node_run, release the
   *  asking-run park, and strand the continuation. On a DEFERRED task P5-BC's park + dispatch path
   *  IS the release path — the seal is ALLOWED (the sealed entry parks its home until board
   *  dispatch mints the continuation), so the guard is LIFTED. The API route opts in; the raw
   *  storage primitive leaves it false. DESIGNER-only cross full seal is unaffected (the §18
   *  designer park holds it). Decision is by round KIND + per-question SCOPE — never the directive
   *  alone — mirroring reconcileDesiredEntries. */
  rejectSelfQuestionerFullSeal?: boolean
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
  now?: () => number
}

export interface SealRoundQuestionsResult {
  /** Question ids sealed by THIS call (after dropping unknowns + de-dup). */
  sealedQuestionIds: string[]
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

function parseScopes(json: string | null): Record<string, ClarifyQuestionScope> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? (v as Record<string, ClarifyQuestionScope>) : {}
  } catch {
    return {}
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
      // a sealed_at marker. A re-seal of any of those is rejected (seal-exactly-once). Read
      // inside the tx so the check + the stamp below are atomic (no double-seal race).
      const existingEntries = tx
        .select({ questionId: taskQuestions.questionId, sealedAt: taskQuestions.sealedAt })
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, args.originNodeRunId))
        .all()
      const alreadySealed = new Set<string>()
      if (round.status === 'answered') for (const q of questions) alreadySealed.add(q.id)
      for (const e of existingEntries) if (e.sealedAt !== null) alreadySealed.add(e.questionId)
      for (const id of sealingSet) {
        if (alreadySealed.has(id)) {
          throw new ConflictError(
            'clarify-question-already-sealed',
            `question '${id}' is already sealed; it cannot be sealed again`,
          )
        }
      }

      // (1) Merge the sealed subset into the round's answers_json (per-question merge-write).
      // No lockedIds needed here: the seal subset is disjoint from already-sealed ids
      // (rejected above), so it never overwrites a locked answer.
      const merged = mergeSealedAnswers(parseAnswersArray(round.answersJson), sealedSubset)
      const mergedJson = JSON.stringify(merged)

      // (2) Merge any per-question scope choice into the round's question_scopes_json
      // (P2-3: never drop a previously-stored scope).
      const mergedScopes = { ...parseScopes(round.questionScopesJson) }
      if (args.scopes) {
        for (const [qid, scope] of Object.entries(args.scopes)) {
          if ((scope === 'designer' || scope === 'questioner') && questionIds.has(qid)) {
            mergedScopes[qid] = scope
          }
        }
      }
      const scopesJson = Object.keys(mergedScopes).length > 0 ? JSON.stringify(mergedScopes) : null

      // (5) Flip the round → answered ONLY when EVERY question is now sealed.
      const newSealed = new Set<string>([...alreadySealed, ...sealingSet])
      const fullySealed = questions.every((q) => newSealed.has(q.id))

      // RFC-128 P2 (Codex P2-2) — round-level directive. Provided wins; else keep the round's
      // existing value; else default 'continue'. Fed (in-memory) to the reconcile designer gate
      // and persisted to clarify_rounds + the legacy session ONLY on a FULL seal (see directive
      // gate below). The 'continue' default is REQUIRED for the §18 designer park:
      // loadUndispatchedDesignerTargets filters clarify_rounds.directive='continue', so a NULL
      // directive would leave a fully-sealed designer round un-parked → (with the node-run
      // closed below) the task would advance past it instead of waiting for board dispatch. A
      // 'stop' round produces NO designer entries (reconcileDesiredEntries).
      const effectiveDirective: ClarifyDirective =
        args.directive ?? (round.directive as ClarifyDirective | null) ?? 'continue'

      // RFC-132 PR-B (universal deferred model, §6) — the RFC-128 P5-0 stranding guard is REMOVED.
      // It rejected a self/questioner FULL seal on a NON-deferred task (no park/dispatch release path
      // → the quick channel's continuation would strand). Under the universal deferred model EVERY
      // task has the self/questioner park source (loadUndispatchedParkTargets) + control-channel
      // dispatch release path, so a full seal parks (never strands) for all tasks — the guard is
      // lifted universally. `rejectSelfQuestionerFullSeal` callers still pass the flag (kept in the
      // args for a narrow boundary; now a no-op); the `deferredQuestionDispatch` flag is no longer
      // read here.

      // RFC-128 P2 (Codex P2-2 follow-up) — persist the directive ONLY when the round fully
      // seals; a PARTIAL seal writes it to NEITHER table:
      //   - the legacy session's directive is read by hasPersistentStop / resolveCrossNodeStopped
      //     WITHOUT a status filter (crossClarify.ts) — a 'stop' written while the session is
      //     still awaiting_human would be taken as a PERMANENT node stop and short-circuit the
      //     cross node BEFORE the round is answered;
      //   - clarify_rounds.directive's only scheduling reader (loadUndispatchedDesignerTargets)
      //     filters status='answered', so a partial round's directive is never consulted.
      // Deferring both writes to full seal matches "partial seal is pure derived state, changes
      // nothing schedulable". The reconcile below still uses the IN-MEMORY effectiveDirective (a
      // partial seal produces no designer entries regardless — P2-4a).
      const directiveSet = fullySealed ? { directive: effectiveDirective } : {}

      // Write clarify_rounds (the SoT): merged answers + merged scopes; flip status (+ directive
      // + answeredAt) only when fully sealed. Keep status 'awaiting_human' on a partial seal
      // (NEVER a new DB 'partial' status — RFC-128 §2 / RFC-126).
      tx.update(clarifyRounds)
        .set({
          answersJson: mergedJson,
          questionScopesJson: scopesJson,
          ...directiveSet,
          ...(fullySealed
            ? {
                status: 'answered' as const,
                answeredAt: ts,
                ...(args.sealedBy !== undefined ? { answeredBy: args.sealedBy } : {}),
              }
            : {}),
        })
        .where(eq(clarifyRounds.id, round.id))
        .run()

      // Dual-write the legacy session table (RFC-058 keeps both in lockstep on the
      // overlapping columns) by the SHARED row id. crossClarifySessions has no answered_by
      // column (matches submitCrossClarifyAnswers), so we mirror answers + scopes + (on full
      // seal only) directive + status + answeredAt — the fields the dual-write-consistency nets
      // assert. Directive is gated on fullySealed for the hasPersistentStop reason above.
      const legacySet = {
        answersJson: mergedJson,
        questionScopesJson: scopesJson,
        ...(fullySealed ? { status: 'answered' as const, answeredAt: ts, ...directiveSet } : {}),
      }
      if (round.kind === 'self') {
        tx.update(clarifySessions).set(legacySet).where(eq(clarifySessions.id, round.id)).run()
      } else {
        tx.update(crossClarifySessions)
          .set(legacySet)
          .where(eq(crossClarifySessions.id, round.id))
          .run()
      }

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
      if (fullySealed) {
        tx.update(nodeRuns)
          .set({ status: 'done', finishedAt: ts })
          .where(and(eq(nodeRuns.id, args.originNodeRunId), eq(nodeRuns.status, 'awaiting_human')))
          .run()
      }

      // (3) Reconcile against the EFFECTIVE round (status + directive reflect the writes
      // above). RFC-128 P3: the reconcile designer gate is per-question — pass THIS call's
      // sealing subset as `additionalSealedQuestionIds` because the `sealed_at` stamp (4) runs
      // AFTER this reconcile in the same tx, so a just-sealed designer-scope question's entry
      // must be created HERE (before it can be stamped). A partial seal of a designer-scope
      // question now emits its designer entry (P3 放开 P2-4a); a full seal marks every question
      // sealed (golden lock). A 'stop' round still emits no designer entries. Done on the SAME
      // tx (dbTxSync can't nest).
      reconcileRoundEntriesTx(
        tx,
        {
          ...round,
          status: fullySealed ? 'answered' : round.status,
          directive: effectiveDirective,
          answersJson: mergedJson,
          questionScopesJson: scopesJson,
          answeredAt: fullySealed ? ts : round.answeredAt,
        },
        { additionalSealedQuestionIds: sealingSet },
      )

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

      // (4b) RFC-128 (用户 2026-07-01) — AUTO-STAGE: opt-in (centralized-answer control channel).
      // Stamp `staged_at` on THIS call's sealed entries in the SAME tx so a sealed question lands
      // directly in 待下发 (staged) — pickup-ready for the board's "批量下发全下" — instead of 待指派
      // (pending, which needs a manual 移入待下发). Target set + IS-NULL idempotency MIRROR (4)'s
      // sealed_at stamp (every role entry of the freshly-sealed questions; a question in sealingSet
      // was NOT sealed before this call, so it could not have been staged before — the IS-NULL guard
      // just makes the write idempotent). staged_by mirrors sealed_by (RFC-099 audit-only). NOT set
      // when autoStage is falsy → golden-lock: autoDispatch / raw-primitive seals are byte-for-byte
      // unchanged, and the park sources are unaffected (they key on round status / sealed_at).
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
        sealedQuestionIds: [...sealingSet],
        roundFullySealed: fullySealed,
        // Post-tx side effect inputs (RFC-128 P2 Codex P2-2): mirror the quick path's
        // stop → canvas directive write when the round FINALIZES with 'stop'.
        stopFinalized: fullySealed && effectiveDirective === 'stop',
        taskId: round.taskId,
        askingNodeId: round.askingNodeId,
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
    await setNodeClarifyDirective(
      args.db,
      txResult.taskId,
      txResult.askingNodeId,
      'stop',
      args.sealedBy ?? 'local',
    )
  }
  return {
    sealedQuestionIds: txResult.sealedQuestionIds,
    roundFullySealed: txResult.roundFullySealed,
  }
}
