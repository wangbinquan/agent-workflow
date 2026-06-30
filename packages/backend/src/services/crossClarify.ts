// RFC-056 — cross-clarify business logic (PR-B T5).
//
// Parallel to services/clarify.ts (RFC-023 self-clarify): different node kind,
// different lifecycle (multi-source aggregation, reject persistence,
// designer-rerun trigger, abandoned state), but reuses the RFC-023 envelope
// schema + per-answer synthesis through shared/clarify-cross.ts.
//
//   - createCrossClarifySession: runner-side entry. Mints a cross_clarify_sessions
//     row + cross-clarify node_run row, parks in 'awaiting_human', broadcasts
//     'cross-clarify.created' WS event.
//   - submitCrossClarifyAnswers: REST decision handler. Optimistic-locks on
//     iteration, seals selectedOptionLabels server-side (same defence as
//     RFC-023), marks the session 'answered'. Then:
//       * directive='continue' (submit) → evaluateDesignerRerunReadiness.
//                                        If ready, triggerDesignerRerun.
//                                        If not, the WS payload tells the
//                                        UI to show the "waiting on N more"
//                                        banner.
//       * directive='stop'     (reject)  → triggerQuestionerStopRerun.
//   - evaluateDesignerRerunReadiness: gathers every cross-clarify node whose
//     to_designer manual edge points at `designerNodeId`. Designer reruns
//     ONLY when every such node's latest session is in a terminal state
//     (answered or abandoned). Sessions with directive='continue' feed
//     External Feedback; directive='stop' / 'abandoned' are skipped.
//   - triggerDesignerRerun: mints a fresh designer node_run (cause
//     'cross-clarify-answer', retryIndex = prior-max + 1) that revises in
//     place. It does NOT roll back the worktree (patch 2026-06-22) — the
//     prior draft is supplied via the scheduler's `## Prior Output (to be
//     updated)` prompt block, and downstream re-dispatch is lazy (RFC-074).
//     Persistent-stop cross-clarify nodes stay reset to pending but dispatch
//     detects them via hasPersistentStop.
//   - triggerQuestionerStopRerun: cascade-reset the questioner. dispatch
//     time the questioner's prompt picks up the STOP CLARIFYING anchor +
//     full Q&A history via the cross-clarify path.
//   - dispatchCrossClarifyNode: scheduler-side helper. Checks for persistent
//     stop. If present, transitions the cross-clarify node_run pending→done
//     ('persistent-stop') without parking. Otherwise the questioner emit-
//     clarify lands here via createCrossClarifySession.
//   - buildExternalFeedbackSources: pulls the latest directive='continue'
//     session per source-questioner-node for the upcoming designer rerun.
//   - hasPersistentStop / listSummaries / getDetail / cleanupForTask:
//     read-side helpers used by REST + scheduler / runner.
//
// Source-of-truth contracts:
//   - clarify_iteration counts ROUNDS of clarify feedback (both self + cross
//     after RFC-064 unification) per loop_iter; the `kind` column on
//     `clarify_rounds` is the only "self vs cross" discriminator. Orthogonal
//     to review_iteration (review), retry_index (process retries).
//   - directive='stop' persists across loop iterations (queried by node id
//     alone). Q&A history resets per loop_iter (queries always carry loop_iter).
//   - sealAnswersServerSide is reused verbatim from services/clarify.ts so
//     answer-tampering defences stay identical between self / cross paths.

import {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  ClarifyQuestionScopeSchema,
  buildClarifyPromptBlock,
  buildExternalFeedbackBlock,
  countDesignerScopedAcrossSources,
  extractDesignerScopedSubset,
  mergeSealedAnswers,
  NEW_CLARIFY_TRIGGER_CAUSES,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  renderClarifyQuestionsBlock,
  renderManualFeedbackSection,
  resolveCrossClarifySessionMode,
  type ClarifyAnswer,
  type ClarifyCrossAgentNode,
  type ClarifyDirective,
  type ClarifyPromptContext,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
  type ClarifyTruncationWarning,
  type CrossClarifySourceContext,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
} from '@/db/schema'
import { parseAnswersArray, sealAnswersServerSide } from '@/services/clarify'
import {
  hasOpenDispatchedEntryOnHome,
  roundHasDispatchedSelfQuestioner,
} from '@/services/clarifyRerunLedger'
import { setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { getTaskQuestionWriteSem } from '@/services/taskWriteLocks'
import { buildMintNodeRunValues, mintNodeRun } from '@/services/nodeRunMint'
import { pickFreshestRun } from '@/services/freshness'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { buildFrozenAttributionSet } from '@/services/clarifyRounds'
import { loadSealedQuestionIds, reconcileRoundEntriesTx } from '@/services/taskQuestions'
import {
  getNodeClarifyDirectiveRow,
  setNodeClarifyDirective,
} from '@/services/taskClarifyDirective'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('cross-clarify')

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

export type CrossClarifySessionStatus = 'awaiting_human' | 'answered' | 'abandoned'

export interface CrossClarifySession {
  id: string
  taskId: string
  crossClarifyNodeId: string
  crossClarifyNodeRunId: string
  sourceQuestionerNodeId: string
  sourceQuestionerNodeRunId: string
  targetDesignerNodeId: string | null
  loopIter: number
  iteration: number
  questions: ClarifyQuestion[]
  answers?: ClarifyAnswer[]
  directive: ClarifyDirective | null
  status: CrossClarifySessionStatus
  designerRunTriggeredAt: number | null
  createdAt: number
  answeredAt: number | null
  abandonedAt: number | null
  /** RFC-059: per-question scope persisted at submit time. NULL when row
   *  predates RFC-059 OR when client did not send `questionScopes` — runtime
   *  treats NULL as "every question is 'designer'" via `resolveQuestionScope`
   *  (preserves RFC-056/058 behaviour). */
  questionScopes: Record<string, ClarifyQuestionScope> | null
}

export interface CrossClarifySessionSummary {
  id: string
  taskId: string
  /** RFC-037 parity: display name of the owning task. Required so the
   *  mixed inbox can group rows by task name regardless of kind. */
  taskName: string
  crossClarifyNodeId: string
  crossClarifyNodeRunId: string
  sourceQuestionerNodeId: string
  targetDesignerNodeId: string | null
  loopIter: number
  iteration: number
  questionCount: number
  status: CrossClarifySessionStatus
  directive: ClarifyDirective | null
  createdAt: number
  answeredAt: number | null
}

// ---------------------------------------------------------------------------
// createCrossClarifySession — runner-side entry point.
// ---------------------------------------------------------------------------

export interface CreateCrossClarifySessionArgs {
  db: DbClient
  taskId: string
  /** Workflow nodeId of the cross-clarify node (the human-gated form). */
  crossClarifyNodeId: string
  /** Workflow nodeId of the questioner agent (the one that emitted
   *  <workflow-clarify>). */
  sourceQuestionerNodeId: string
  /** node_runs.id of the questioner run that produced this envelope. */
  sourceQuestionerNodeRunId: string
  /** Workflow nodeId of the designer agent resolved from `to_designer` manual
   *  edge. Pass `null` to skip designer-side correlation (validator warns at
   *  edit time; runtime records the gap for the abandoned-invariant scan). */
  targetDesignerNodeId: string | null
  /** wrapper-loop iteration index (parent loop scope). 0 for non-loop placement. */
  loopIter: number
  /** Parsed cross-clarify envelope questions (already validated by
   *  parseCrossClarifyEnvelopeBody at the runner). */
  questions: ClarifyQuestion[]
  /** Non-fatal warnings from the parser; mirrors RFC-023 truncation surface. */
  truncationWarnings?: ClarifyTruncationWarning[]
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface CreateCrossClarifySessionResult {
  session: CrossClarifySession
  /** node_runs.id of the freshly-minted cross-clarify node_run owning this session. */
  crossClarifyNodeRunId: string
}

/**
 * Mint a cross_clarify_sessions row + parked cross-clarify node_run. Iteration
 * counter is derived from the latest existing row for the same
 * (crossClarifyNodeId, loopIter) — fresh, prior row's iteration + 1.
 */
export async function createCrossClarifySession(
  args: CreateCrossClarifySessionArgs,
): Promise<CreateCrossClarifySessionResult> {
  const now = args.now ?? Date.now
  const createdAt = now()

  // Compute new iteration index: max(existing.iteration) + 1 in the same
  // (node, loopIter); 0 if no prior session for this loop_iter.
  const prior = await args.db
    .select({ iteration: crossClarifySessions.iteration })
    .from(crossClarifySessions)
    .where(
      and(
        eq(crossClarifySessions.taskId, args.taskId),
        eq(crossClarifySessions.crossClarifyNodeId, args.crossClarifyNodeId),
        eq(crossClarifySessions.loopIter, args.loopIter),
      ),
    )
    .orderBy(desc(crossClarifySessions.iteration))
    .limit(1)
  const iteration = prior.length === 0 ? 0 : (prior[0]?.iteration ?? 0) + 1

  // Mint cross-clarify node_run row parked at awaiting_human. RFC-053:
  // park-human enforces pending|running → awaiting_human; we mint at
  // 'awaiting_human' directly so the runner doesn't need a separate
  // pending->awaiting_human leg.
  const crossClarifyNodeRunId = await mintNodeRun(args.db, {
    taskId: args.taskId,
    nodeId: args.crossClarifyNodeId,
    status: 'awaiting_human',
    cause: 'cross-clarify-park',
    iteration: args.loopIter,
    overrides: { startedAt: createdAt },
  })

  const sessionId = ulid()
  const questionsJson = JSON.stringify(args.questions)
  await args.db.insert(crossClarifySessions).values({
    id: sessionId,
    taskId: args.taskId,
    crossClarifyNodeId: args.crossClarifyNodeId,
    crossClarifyNodeRunId,
    sourceQuestionerNodeId: args.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: args.sourceQuestionerNodeRunId,
    targetDesignerNodeId: args.targetDesignerNodeId,
    loopIter: args.loopIter,
    iteration,
    questionsJson,
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    designerRunTriggeredAt: null,
    createdAt,
    answeredAt: null,
    abandonedAt: null,
  })

  // RFC-058 T12 dual-write — mirror to clarify_rounds with kind='cross'.
  // RFC-056 v1 keeps cross-clarify on agent-single, so askingShardKey = null.
  await args.db.insert(clarifyRounds).values({
    id: sessionId,
    taskId: args.taskId,
    kind: 'cross',
    askingNodeId: args.sourceQuestionerNodeId,
    askingNodeRunId: args.sourceQuestionerNodeRunId,
    askingShardKey: null,
    intermediaryNodeId: args.crossClarifyNodeId,
    intermediaryNodeRunId: crossClarifyNodeRunId,
    targetConsumerNodeId: args.targetDesignerNodeId,
    loopIter: args.loopIter,
    iteration,
    questionsJson,
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    truncationWarningsJson: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
  })

  if (args.truncationWarnings && args.truncationWarnings.length > 0) {
    log.warn('cross-clarify envelope truncated to limits', {
      sessionId,
      warnings: args.truncationWarnings.map((w) => w.code),
    })
  }

  const session: CrossClarifySession = {
    id: sessionId,
    taskId: args.taskId,
    crossClarifyNodeId: args.crossClarifyNodeId,
    crossClarifyNodeRunId,
    sourceQuestionerNodeId: args.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: args.sourceQuestionerNodeRunId,
    targetDesignerNodeId: args.targetDesignerNodeId,
    loopIter: args.loopIter,
    iteration,
    questions: args.questions,
    directive: null,
    status: 'awaiting_human',
    designerRunTriggeredAt: null,
    questionScopes: null,
    createdAt,
    answeredAt: null,
    abandonedAt: null,
  }
  broadcastCrossClarifyCreated(args.taskId, session)
  return { session, crossClarifyNodeRunId }
}

// ---------------------------------------------------------------------------
// submitCrossClarifyAnswers — REST decision handler.
// ---------------------------------------------------------------------------

export interface SubmitCrossClarifyAnswersArgs {
  db: DbClient
  /** node_runs.id of the cross-clarify node (NOT the questioner / designer). */
  crossClarifyNodeRunId: string
  answers: ClarifyAnswer[]
  /** RFC-056: 'continue' = submit (feed designer); 'stop' = reject (questioner
   *  STOP CLARIFYING + persistent). */
  directive: ClarifyDirective
  /** Optimistic-lock guard. When set, must equal session.iteration; otherwise
   *  409 'cross-clarify-iteration-mismatch'. */
  ifMatchIteration?: number
  /** Defaults to 'local'. Reserved for per-user attribution. */
  answeredBy?: string
  /** RFC-099 (D7/D8) — task-relationship role of the submitter; enables the
   *  clarify_rounds attribution freeze. UI/audit only. */
  submittedByRole?: 'owner' | 'user' | 'admin'
  /** Defaults to Date.now(). */
  now?: () => number
  /** RFC-059: per-question scope decisions. Optional (old clients / all-
   *  designer default). Keys MUST be questionIds present in the session's
   *  questions array; unknown keys / non-enum scope values throw
   *  ValidationError 400 'cross-clarify-question-scopes-malformed'. */
  questionScopes?: Record<string, ClarifyQuestionScope>
}

export interface SubmitCrossClarifyAnswersResult {
  session: CrossClarifySession
  /**
   * Outcome of the submit:
   *   - directive='continue' AND aggregated designer-scoped Q&A count > 0 AND
   *     all sibling cross-clarify nodes pointing to the same designer are also
   *     resolved → 'designer-rerun-triggered' with the new designer node_run id.
   *   - directive='continue' AND siblings still awaiting → 'designer-waiting'
   *     (UI shows the multi-source banner).
   *   - directive='continue' AND target designer can't be resolved →
   *     'designer-target-missing' (warning event recorded; no rerun).
   *   - directive='stop' → 'questioner-stop-triggered' with the new
   *     questioner node_run id.
   *   - RFC-059 directive='continue' AND this session's questionScopes are
   *     all 'questioner' → 'questioner-continue-triggered'. Designer is not
   *     rerun; questioner cascades with the full Q&A (no STOP CLARIFYING).
   *   - RFC-059 directive='continue' AND aggregated designer-scoped Q&A
   *     count across all resolved sources = 0 → 'designer-skipped-all-
   *     questioner-scope'. Designer is not rerun; each source's questioner
   *     was already cascaded at its own submit.
   */
  outcome:
    | { kind: 'designer-rerun-triggered'; designerNodeRunId: string; sourceCount: number }
    | { kind: 'designer-waiting'; pendingCrossClarifyNodeIds: string[] }
    | { kind: 'designer-target-missing' }
    | { kind: 'questioner-stop-triggered'; questionerNodeRunId: string }
    | { kind: 'questioner-continue-triggered'; questionerNodeRunId: string }
    | { kind: 'designer-skipped-all-questioner-scope' }
    // RFC-120 T9 (model A): the task opted into deferred dispatch, so the
    // designer-scoped answer was recorded + its designer task_questions entries
    // created undispatched, but the designer rerun is NOT triggered here — it
    // waits for an explicit dispatchTaskQuestions batch-dispatch.
    | { kind: 'designer-deferred'; deferredQuestionCount: number }
}

/**
 * Persist answers + directive, close the cross-clarify node_run, and drive
 * the appropriate downstream action (designer rerun batched, or questioner
 * stop rerun). Caller (REST route) is responsible for invoking resumeTask.
 */
export async function submitCrossClarifyAnswers(
  args: SubmitCrossClarifyAnswersArgs,
): Promise<SubmitCrossClarifyAnswersResult> {
  const now = args.now ?? Date.now
  const answeredBy = args.answeredBy ?? 'local'
  const answeredAt = now()

  const sessionRows = await args.db
    .select()
    .from(crossClarifySessions)
    .where(eq(crossClarifySessions.crossClarifyNodeRunId, args.crossClarifyNodeRunId))
    .orderBy(desc(crossClarifySessions.createdAt))
    .limit(1)
  const row = sessionRows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'cross-clarify-session-not-found',
      `no cross_clarify_session for node_run ${args.crossClarifyNodeRunId}`,
    )
  }
  if (row.status !== 'awaiting_human') {
    throw new ConflictError(
      'cross-clarify-already-answered',
      `cross_clarify_session ${row.id} status is ${row.status}, expected awaiting_human`,
    )
  }
  if (args.ifMatchIteration !== undefined && args.ifMatchIteration !== row.iteration) {
    throw new ConflictError(
      'cross-clarify-iteration-mismatch',
      `If-Match iteration ${args.ifMatchIteration} != server ${row.iteration}`,
    )
  }
  if (args.directive !== 'continue' && args.directive !== 'stop') {
    throw new ValidationError(
      'cross-clarify-directive-invalid',
      `directive must be 'continue' or 'stop', got '${args.directive}'`,
    )
  }
  // RFC-128 P5-BC §5.2.14 mixed-path step 1 (questioner submit-side dispatch-mode guard). Once this
  // cross round has ANY dispatched questioner entry it is PERMANENTLY excluded from the questioner
  // whole-round render path (selectAnsweredRoundsForConsumer → roundsWithDispatchedEntries), so a
  // quick whole-round finalize would mint a continuation that renders NOTHING for it → the
  // un-dispatched answers are DROPPED + a second rerun double-mints. Reject ANY dispatched (in-flight
  // OR consumed) — finish via the control channel. No dispatched questioner entry ⇒ no-op
  // (golden-lock for non-deferred tasks).
  //
  // NOTE (§5.2.14 scope): steps 2 (consume superseded sealed-undispatched) + 3 (collapse the mint
  // into a synchronous dbTxSync to also close the concurrent double-mint race) are applied to the
  // SELF path (submitClarifyAnswers) this round; the QUESTIONER path's atomic conversion is a
  // deferred follow-up (submitCrossClarifyAnswers's critical section also threads the designer +
  // deferred branches and warrants its own focused pass + adversarial gate). Until then this guard
  // closes the SEQUENTIAL questioner data-loss; the concurrent race window remains for the
  // questioner path only.
  if (await roundHasDispatchedSelfQuestioner(args.db, args.crossClarifyNodeRunId)) {
    throw new ConflictError(
      'clarify-quick-finalize-round-dispatched',
      `cannot quick-finalize cross-clarify round ${args.crossClarifyNodeRunId}: it has a dispatched questioner entry (the round is in control-channel dispatch mode). Finish the remaining questions via the control channel (seal + dispatch).`,
    )
  }

  // Seal answers server-side defending against client option-label injection.
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  const sealedSubset = sealAnswersServerSide(questions, args.answers)
  // RFC-059: validate questionScopes against the session's questions BEFORE any write so a malformed
  // map can't reach the DB (throws ValidationError 400 'cross-clarify-question-scopes-malformed'). Pure
  // (args + questions, not answer-dependent) → stays before the lock.
  const validatedScopes = validateQuestionScopes(args.questionScopes, questions)
  // RFC-058 dual-write: the clarify_round row mirrors this cross session (id == session id). Loaded for
  // the §5.2.14 finding-3 in-tx reconcile of the QUESTIONER entries (+ finding-1 deferred designer).
  const roundRow = (
    await args.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, row.id)).limit(1)
  )[0]
  // §5.2.14 finding 1 — load the task row BEFORE the lock so the deferred-designer branch can
  // MATERIALIZE its designer task_questions IN the same B-protected tx as the flip (was a post-lock
  // reconcileTaskQuestionsForRound → the designer rows + the answered flip were not atomic, so a
  // concurrent dispatch / scheduler park could observe the answered round with no designer rows yet and
  // mis-decide). Reused post-tx for the workflow snapshot / readiness.
  const taskRow = (await args.db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${row.taskId} not found`)
  }
  // §5.2.14 finding 2 — the answer/scope MERGE and everything derived from it (attribution, the
  // questioner cascade mint values, the designer split) are computed UNDER the per-task QUESTION-WRITE
  // lock B, from the round's CURRENT answers_json + scopes (re-read inside the lock) — NOT from the
  // pre-lock `row` snapshot. Else a concurrent control-channel seal (sealRoundQuestions, also under B)
  // committing a locked answer after a pre-lock read would be OVERWRITTEN by this submit's stale
  // whole-round answers_json (data loss, breaks the P2-2 locked-answer guarantee). Hoisted for the
  // post-lock sessionAfter / branch.
  let sealedAnswers: ClarifyAnswer[] = []
  let effectiveScopes: Record<string, ClarifyQuestionScope> | null = null
  let designerSplit!: ReturnType<typeof extractDesignerScopedSubset>
  let questionerCascadeRerunId: string | null = null
  // RFC-128 P5-BC §5.2.14 — atomic {merge → claim → recheck → (cascade) reconcile+consume+questioner-
  // mint → (deferred) designer reconcile → flip}, all UNDER the per-task QUESTION-WRITE lock B so the
  // cross submit serializes against dispatchTaskQuestions + sealRoundQuestions + the other submit path.
  // B only (cross submit has NO worktree rollback → no worktree write lock A needed). Lock order:
  // cross-submit takes B alone (no nesting) → no B→A → deadlock-free; B is short. The cross flip stays
  // committed here so peers + the questioner park read this session resolved (peer-aggregation
  // invariant). The questioner cascade MINT is in the tx (finding 2); only the async designer / multi-
  // source readiness stay AFTER the tx. session CAS (finding 1) + in-tx consume+mint (finding 2/3) +
  // confirmation-gated dispatch (finding B) close the double-submit AND dispatch double-mint.
  await getTaskQuestionWriteSem(row.taskId).run(async () => {
    // finding 2 — re-read the round's CURRENT answers_json + scopes UNDER the lock (a concurrent seal
    // committed before we acquired B is now visible) and MERGE against them, so a sealed/locked answer
    // is never clobbered by this submit's stale whole-round value (P2-2). B is held across the whole
    // callback (incl. these awaits) so no other writer interleaves between the read and the tx.
    const cur = (
      await args.db
        .select({
          answersJson: crossClarifySessions.answersJson,
          questionScopesJson: crossClarifySessions.questionScopesJson,
        })
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.id, row.id))
        .limit(1)
    )[0]
    // RFC-128 §7 per-question merge-write + P2-2: a locked (already-sealed) question keeps its sealed
    // answer instead of being overwritten by the posted whole-round value. No prior seal ⇒ lockedIds
    // empty ⇒ merge == overwrite (golden-lock).
    const lockedIds = await loadSealedQuestionIds(args.db, args.crossClarifyNodeRunId)
    sealedAnswers = mergeSealedAnswers(
      parseAnswersArray(cur?.answersJson ?? null),
      sealedSubset,
      lockedIds,
    )
    // RFC-128 P2-3 / P2-3b — MERGE scopes with the round's CURRENT stored scopes; a LOCKED question's
    // scope is sealed too (keep stored, ignore incoming) so a stale tab can't re-route a sealed
    // questioner-scope answer back to designer. Empty ⇒ null (golden-lock).
    const existingScopes = parseQuestionScopesJson(cur?.questionScopesJson ?? null)
    const mergedScopes: Record<string, ClarifyQuestionScope> = { ...(existingScopes ?? {}) }
    for (const [qid, scope] of Object.entries(validatedScopes ?? {})) {
      if (!lockedIds.has(qid)) mergedScopes[qid] = scope
    }
    effectiveScopes = Object.keys(mergedScopes).length > 0 ? mergedScopes : null
    const questionScopesJson = effectiveScopes === null ? null : JSON.stringify(effectiveScopes)
    const answersJson = JSON.stringify(sealedAnswers)
    // RFC-058 T12 dual-write attribution — from the freshly-merged answers (RFC-099 freeze).
    const attributionSet =
      args.submittedByRole !== undefined
        ? {
            answeredBy,
            ...(await buildFrozenAttributionSet(args.db, row.id, sealedAnswers, {
              userId: answeredBy,
              role: args.submittedByRole,
            })),
          }
        : {}
    // RFC-059 designer split (from the MERGED answers/scopes) — drives the questioner-cascade decision,
    // the deferred-designer reconcile (finding 1) + the post-lock branch. effectiveScopes is used for
    // BOTH persistence and routing so a prior-sealed questioner-scope question omitted from this
    // request is not re-routed to designer.
    designerSplit = extractDesignerScopedSubset(questions, sealedAnswers, effectiveScopes)
    // This submit CASCADES the questioner (→ its entries superseded) iff a 'stop' finalize OR the
    // RFC-059 all-questioner-scope fast path (0 designer-scoped questions). When a designer-scoped
    // subset exists the questioner is NOT cascaded here (the designer/deferred path owns the round) so
    // its entries are left to that path (RFC-059 unchanged).
    const cascadesQuestioner = args.directive === 'stop' || designerSplit.questions.length === 0
    // finding 1: the deferred-designer path (continue + a designer-scoped subset + a designer target +
    // the task opted into deferred dispatch) MATERIALIZES its designer task_questions IN this tx (vs.
    // the old post-lock reconcileTaskQuestionsForRound) so the designer rows + the answered flip commit
    // atomically — a concurrent dispatch / scheduler park never sees the answered round row-less.
    const isDeferredDesignerPath =
      args.directive === 'continue' &&
      designerSplit.questions.length > 0 &&
      row.targetDesignerNodeId !== null &&
      taskRow.deferredQuestionDispatch
    // finding 2 — compute the questioner cascade rerun VALUES now (async read of the questioner run) so
    // the INSERT runs inside the tx (atomic with the flip → visible to a concurrent dispatch's in-
    // flight / immediate-ledger gate → no post-tx double-mint window). Only the SYNC insert is in the
    // tx; the multi-source designer readiness / designer rerun stay async after (finding 3).
    let questionerRerunValues: ReturnType<typeof buildMintNodeRunValues> | null = null
    // (home node + iteration of the questioner rerun — typed-number, for the in-tx reciprocal check).
    let questionerHome: { nodeId: string; iteration: number } | null = null
    if (cascadesQuestioner) {
      const lastRun = (
        await args.db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.id, row.sourceQuestionerNodeRunId))
          .limit(1)
      )[0]
      if (lastRun === undefined) {
        throw new NotFoundError(
          'cross-clarify-questioner-run-not-found',
          `questioner node_run ${row.sourceQuestionerNodeRunId} not found`,
        )
      }
      questionerHome = { nodeId: lastRun.nodeId, iteration: lastRun.iteration }
      questionerRerunValues = buildMintNodeRunValues({
        taskId: row.taskId,
        nodeId: lastRun.nodeId,
        status: 'pending',
        cause: 'cross-clarify-questioner-rerun',
        iteration: lastRun.iteration,
        inheritFrom: lastRun,
        overrides: { startedAt: null },
      })
    }
    dbTxSync(args.db, (tx) => {
      // finding 1 (concurrent double-submit): atomically claim the session. The loser sees the
      // winner's committed 'answered' → reject (no second flip, no second cascade).
      const claim = tx
        .select({ status: crossClarifySessions.status })
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.id, row.id))
        .limit(1)
        .all()
      if (claim[0]?.status !== 'awaiting_human') {
        throw new ConflictError(
          'cross-clarify-already-answered',
          `cross_clarify_session ${row.id} was answered concurrently (lost the submit claim)`,
        )
      }
      // finding 2 (atomic dispatch-mode recheck): a round with ANY dispatched questioner entry is
      // permanently excluded from the questioner whole-round render path → quick-finalize would drop
      // its answers + double-mint. Reject (the early async guard catches the common case; this closes
      // the concurrent window).
      const dispatched = tx
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.originNodeRunId, args.crossClarifyNodeRunId),
            eq(taskQuestions.roleKind, 'questioner'),
            isNotNull(taskQuestions.dispatchedAt),
          ),
        )
        .limit(1)
        .all()
      if (dispatched.length > 0) {
        throw new ConflictError(
          'clarify-quick-finalize-round-dispatched',
          `cannot quick-finalize cross-clarify round ${args.crossClarifyNodeRunId}: a concurrent control-channel dispatch claimed it. Finish via the control channel.`,
        )
      }
      // finding 2 step 2 + finding 3: when this submit cascades the questioner, MATERIALIZE (idempotent)
      // + CONFIRM the round's open-undispatched QUESTIONER entries — they are superseded by the
      // cascade. reconcile covers the virgin case (no rows yet → a later lazy reconcile would otherwise
      // create OPEN dispatchable rows); the confirm covers the control-seal case. DESIGNER entries are
      // NOT confirmed (the designer/deferred path owns them). Only runs in the cascade branches, so the
      // designer path's RFC-059 questioner handling is untouched.
      if (cascadesQuestioner) {
        if (questionerRerunValues !== null && questionerHome !== null) {
          // reciprocal in-flight check (PRECISE, ALL-ROLE per 3rd-gate finding P2): a concurrent
          // deferred dispatch of ANOTHER round's entry reassigned (RFC-127 借壳) to THIS questioner home
          // may have committed a pending rerun just before this tx. Keyed on an OPEN (unconsumed)
          // DISPATCHED entry of ANY deferred role (self/questioner/designer) whose home == this home —
          // a node carries at most ONE open ledger, so a designer (cross-clarify-answer) open rerun on
          // the same node also blocks (mirrors assertNoInFlightDispatch). NOT "any pending rerun" (a
          // prior quick continuation has no dispatched entry → no false reject). taskId-scoped.
          const dispatchedHome = tx
            .select({
              triggerRunId: taskQuestions.triggerRunId,
              defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
              overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
            })
            .from(taskQuestions)
            .where(
              and(
                eq(taskQuestions.taskId, row.taskId),
                inArray(taskQuestions.roleKind, ['self', 'questioner', 'designer']),
                isNotNull(taskQuestions.dispatchedAt),
              ),
            )
            .all()
          if (dispatchedHome.length > 0) {
            const txRuns = tx.select().from(nodeRuns).where(eq(nodeRuns.taskId, row.taskId)).all()
            const txOutputIds = new Set(
              tx
                .select({ id: nodeRunOutputs.nodeRunId })
                .from(nodeRunOutputs)
                .where(
                  inArray(
                    nodeRunOutputs.nodeRunId,
                    txRuns.map((r) => r.id),
                  ),
                )
                .all()
                .map((r) => r.id),
            )
            if (
              hasOpenDispatchedEntryOnHome(
                questionerHome.nodeId,
                dispatchedHome,
                txRuns,
                txOutputIds,
              )
            ) {
              throw new ConflictError(
                'cross-clarify-questioner-rerun-in-flight',
                `questioner home '${questionerHome.nodeId}' already has an OPEN dispatched rerun ledger (a concurrent dispatch won) — not double-minting`,
              )
            }
          }
          // finding 2: MINT the questioner cascade rerun IN the tx (committed atomically with the flip →
          // immediately visible to a concurrent dispatch's immediate-ledger / in-flight gate → no
          // post-tx double-mint window). The post-tx stop / continue-fast branch reuses this id.
          // rfc098-allow-direct-node-run-insert: values from the mint factory.
          tx.insert(nodeRuns).values(questionerRerunValues).run()
          questionerCascadeRerunId = questionerRerunValues.id
        }
        if (roundRow !== undefined) {
          reconcileRoundEntriesTx(tx, {
            ...roundRow,
            status: 'answered',
            answersJson,
            directive: args.directive,
            questionScopesJson,
          })
          tx.update(taskQuestions)
            .set({
              confirmation: 'confirmed',
              confirmedBy: answeredBy,
              confirmedByRole: args.submittedByRole ?? null,
              confirmedAt: answeredAt,
              updatedAt: answeredAt,
            })
            .where(
              and(
                eq(taskQuestions.originNodeRunId, args.crossClarifyNodeRunId),
                eq(taskQuestions.roleKind, 'questioner'),
                isNull(taskQuestions.dispatchedAt),
                eq(taskQuestions.confirmation, 'open'),
              ),
            )
            .run()
        }
      }
      // finding 1 (deferred designer) — when this submit records a designer-scoped continuation on a
      // deferred-dispatch task, MATERIALIZE the round's task_questions (incl. the undispatched designer
      // rows the scheduler park + batch dispatch key off) IN this tx, atomic with the answered flip.
      // Mutually exclusive with the cascade branch above (cascadesQuestioner is false on this path).
      // Idempotent (reconcileRoundEntriesTx's onConflictDoUpdate never touches `confirmation`). Replaces
      // the old post-lock reconcileTaskQuestionsForRound, which left the designer rows + the flip in
      // separate transactions → a concurrent dispatch / scheduler park could observe the round answered
      // with no designer rows.
      if (isDeferredDesignerPath && roundRow !== undefined) {
        reconcileRoundEntriesTx(tx, {
          ...roundRow,
          status: 'answered',
          answersJson,
          directive: args.directive,
          questionScopesJson,
        })
      }
      // RFC-076 T0-extend note: unlike submitClarifyAnswers, this session → answered
      // flip CANNOT be deferred past the (now in-tx) questioner cascade mint + the async designer
      // trigger below — the
      // multi-source readiness check (extractDesignerScopedSubset + peer aggregation, see the
      // `continue` branch) requires THIS session to read as resolved so a peer's submit sees it, and the
      // asking questioner's park keys off this same status (deriveFrontier.askingRunIds). A concurrent
      // runScope tick landing between this committed flip and an async downstream could briefly judge the
      // questioner complete, but that is self-correcting (the questioner rerun re-mints as a fresher run
      // → stale downstream re-dispatches, RFC-074 provenance) — a wasted re-run, never a wrong final
      // state. So the flip is committed here (in-tx, under lock B) and we keep peer-aggregation
      // correctness.
      // flip cross_clarify_session → answered.
      tx.update(crossClarifySessions)
        .set({
          answersJson,
          status: 'answered',
          directive: args.directive,
          answeredAt,
          questionScopesJson,
        })
        .where(eq(crossClarifySessions.id, row.id))
        .run()
      // RFC-058 T12 dual-write — mirror to clarify_rounds (+ RFC-059 scopes + RFC-099 attribution).
      tx.update(clarifyRounds)
        .set({
          answersJson,
          status: 'answered',
          directive: args.directive,
          answeredAt,
          questionScopesJson,
          ...attributionSet,
        })
        .where(eq(clarifyRounds.id, row.id))
        .run()
    })
  })

  // RFC-053: resume-clarify enforces awaiting_human → done. Cross-clarify shares the same transition
  // shape so we reuse the event kind. Stays AFTER the tx (lifecycle CAS, s14 forbids direct writes);
  // the flip is already committed so the cross node is never `done` with the session still awaiting.
  await transitionNodeRunStatus({
    db: args.db,
    nodeRunId: args.crossClarifyNodeRunId,
    event: { kind: 'resume-clarify' },
    extra: { finishedAt: answeredAt },
  })

  const sessionAfter = mergeAnswered(
    row,
    sealedAnswers,
    args.directive,
    answeredAt,
    effectiveScopes,
  )
  void answeredBy

  // Branch on directive.
  if (args.directive === 'stop') {
    // RFC-123: mirror the stop into the per-(task, asking-node) directive (canvas
    // toggle single source of truth) for the QUESTIONER node — so the toggle shows
    // 停止反问 and the stop rides nodeStopOverride. Additive: cross also persists via
    // hasPersistentStop. `answeredBy` is the audit-only setter id (never a prompt).
    await setNodeClarifyDirective(
      args.db,
      row.taskId,
      row.sourceQuestionerNodeId,
      'stop',
      answeredBy,
    )
    // §5.2.14 finding 2: the questioner rerun was already minted IN the tx above (atomic, no double-
    // mint window). The STOP behaviour (STOP CLARIFYING anchor) rides the persisted directive='stop'
    // at render time — the mint itself is identical, so we reuse the tx-minted id.
    const questionerNodeRunId = questionerCascadeRerunId!
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    broadcastCrossClarifyRejected(row.taskId, sessionAfter, questionerNodeRunId)
    return {
      session: sessionAfter,
      outcome: {
        kind: 'questioner-stop-triggered',
        questionerNodeRunId,
      },
    }
  }

  // directive === 'continue'.
  // RFC-059 fast path — if THIS session resolves with zero designer-scoped
  // questions, skip designer rerun entirely + cascade only the questioner.
  // Even in the multi-source scenario: peer sessions whose designer count
  // > 0 will trigger the designer when they submit (their readiness check
  // aggregates all already-resolved peers including this one). Letting the
  // questioner cascade now means the user doesn't wait for peers.
  // (designerSplit was computed UNDER lock B above, from the merged answers — finding 2.)
  if (designerSplit.questions.length === 0) {
    // §5.2.14 finding 2: questioner rerun already minted IN the tx above (atomic). Reuse the id.
    const questionerNodeRunId = questionerCascadeRerunId!
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return {
      session: sessionAfter,
      outcome: {
        kind: 'questioner-continue-triggered',
        questionerNodeRunId,
      },
    }
  }

  const designerNodeId = row.targetDesignerNodeId
  if (designerNodeId === null) {
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return { session: sessionAfter, outcome: { kind: 'designer-target-missing' } }
  }

  // Multi-source aggregation: only fire when every sibling cross-clarify
  // pointing at this designer (within the same loop_iter on the questioner
  // side; design.md §5.2) is resolved. (taskRow was loaded before lock B — finding 1.)

  // RFC-120 T9 (model A) — deferred question dispatch. When the task opted in,
  // a designer-scoped answer is recorded above (status='answered' + node_run
  // done + questioner cascade is unchanged), but the designer rerun is NOT
  // triggered here. Instead the round's designer task_questions entries are
  // created eagerly (the read-side reconcile is otherwise lazy, and the
  // scheduler park gate must see the undispatched designer rows), so the task
  // parks awaiting_human until an explicit dispatchTaskQuestions batch-dispatch
  // mints the rerun. Flag false → this whole block is skipped and the path
  // below is byte-for-byte the immediate-dispatch behavior (golden-lock).
  if (taskRow.deferredQuestionDispatch) {
    // finding 1: the round's designer task_questions were already MATERIALIZED inside the B-protected
    // flip tx above (reconcileRoundEntriesTx on the answered round, gated on isDeferredDesignerPath ==
    // this exact branch) — atomic with the flip, so there is NO post-lock reconcile here (it would be a
    // separate tx, re-opening the non-atomic window). Just broadcast + return the deferred outcome.
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return {
      session: sessionAfter,
      outcome: { kind: 'designer-deferred', deferredQuestionCount: designerSplit.questions.length },
    }
  }

  const definition = parseDefinitionFromSnapshot(taskRow.workflowSnapshot)
  if (definition === null) {
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return { session: sessionAfter, outcome: { kind: 'designer-target-missing' } }
  }

  const readiness = await evaluateDesignerRerunReadiness({
    db: args.db,
    taskId: row.taskId,
    designerNodeId,
    definition,
    loopIter: row.loopIter,
  })
  if (!readiness.ready) {
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return {
      session: sessionAfter,
      outcome: {
        kind: 'designer-waiting',
        pendingCrossClarifyNodeIds: readiness.pendingCrossClarifyNodeIds,
      },
    }
  }

  // RFC-059: even when all siblings resolved, skip the designer rerun if
  // the aggregated designer-scoped Q&A count is zero — every source is
  // all-questioner-scoped. Each source's questioner was cascaded at its
  // own submit (fast path above), so there is nothing left to do here.
  const aggregatedDesignerCount = countDesignerScopedAcrossSources(
    readiness.sources.map((s) => ({
      questions: s.questions,
      answers: s.answers,
      scopes: s.questionScopes,
    })),
  )
  if (aggregatedDesignerCount === 0) {
    broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
    return {
      session: sessionAfter,
      outcome: { kind: 'designer-skipped-all-questioner-scope' },
    }
  }

  // All siblings resolved → fire designer rerun + sibling cascade.
  const rerun = await triggerDesignerRerun({
    db: args.db,
    taskId: row.taskId,
    designerNodeId,
    sources: readiness.sources,
    loopIter: row.loopIter,
    definition,
    now,
  })
  // Stamp designer_run_triggered_at on every consumed session for audit.
  for (const src of readiness.sources) {
    await args.db
      .update(crossClarifySessions)
      .set({ designerRunTriggeredAt: rerun.triggeredAt })
      .where(eq(crossClarifySessions.id, src.sessionId))
    // RFC-058 T12 dual-write — mirror designer_run_triggered_at stamp.
    await args.db
      .update(clarifyRounds)
      .set({ designerRunTriggeredAt: rerun.triggeredAt })
      .where(eq(clarifyRounds.id, src.sessionId))
  }
  broadcastCrossClarifyAnswered(row.taskId, sessionAfter)
  broadcastDesignerRerunBatched(
    row.taskId,
    rerun.designerNodeRunId,
    readiness.sources.map((s) => s.sourceQuestionerNodeId),
  )
  return {
    session: sessionAfter,
    outcome: {
      kind: 'designer-rerun-triggered',
      designerNodeRunId: rerun.designerNodeRunId,
      sourceCount: readiness.sources.length,
    },
  }
}

// ---------------------------------------------------------------------------
// evaluateDesignerRerunReadiness — multi-source aggregation.
// ---------------------------------------------------------------------------

export interface EvaluateDesignerRerunReadinessArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  definition: WorkflowDefinition
  /** Limit the readiness scan to a specific loop iteration. Non-loop = 0. */
  loopIter: number
  /**
   * RFC-128 P3 — origin node-run ids (= cross_clarify_sessions.cross_clarify_node_run_id,
   * which equals task_questions.origin_node_run_id) of the designer questions being DISPATCHED
   * right now. A per-question dispatch explicitly dispatches the SEALED questions of these
   * sources even while their round is still awaiting_human (a partial seal), so a sibling
   * whose latest session is one of these is NOT counted as "pending" — we are not waiting for
   * its remaining (unsealed) questions. Other awaiting_human siblings (not in this set) still
   * gate the dispatch (golden lock: rfc120 H3/H2 multi-source readiness). Empty / omitted on
   * the immediate-submit path → byte-for-byte the pre-RFC-128 readiness (golden lock).
   */
  dispatchedOrigins?: ReadonlySet<string>
}

export interface DesignerRerunReadinessSource {
  sessionId: string
  crossClarifyNodeId: string
  sourceQuestionerNodeId: string
  iteration: number
  questions: ClarifyQuestion[]
  answers: ClarifyAnswer[]
  /** RFC-059: per-question scope captured at submit time. NULL on RFC-056
   *  legacy rows; runtime falls back to all-designer via
   *  `resolveQuestionScope`. Downstream callers
   *  (`buildExternalFeedbackContext`, submit `countDesignerScopedAcrossSources`)
   *  use this to keep designer-scoped Q&A only. */
  questionScopes: Record<string, ClarifyQuestionScope> | null
}

export interface DesignerRerunReadiness {
  ready: boolean
  /** When ready=true, the directive='continue' sources that should feed the
   *  designer's External Feedback. directive='stop' / abandoned siblings are
   *  not included here even though they count toward "resolved". */
  sources: DesignerRerunReadinessSource[]
  /** When ready=false, the cross-clarify NodeIds still in awaiting_human. */
  pendingCrossClarifyNodeIds: string[]
}

/**
 * Determine whether `designerNodeId` is ready to rerun based on the latest
 * session (per cross-clarify NodeId, scoped to `loopIter`) of every sibling
 * cross-clarify node whose `to_designer` edge targets it.
 *
 * Readiness rule:
 *   ready ⟺ every sibling's latest session in this loop_iter has
 *           status ∈ {answered, abandoned}.
 *
 * Sources for the rerun:
 *   {latest where directive='continue' AND status='answered'}.
 *   directive='stop' / status='abandoned' siblings count as resolved but do
 *   NOT feed External Feedback.
 */
export async function evaluateDesignerRerunReadiness(
  args: EvaluateDesignerRerunReadinessArgs,
): Promise<DesignerRerunReadiness> {
  const siblingNodeIds = findCrossClarifyNodesPointingToDesigner(
    args.definition,
    args.designerNodeId,
  )
  if (siblingNodeIds.length === 0) {
    return { ready: false, sources: [], pendingCrossClarifyNodeIds: [] }
  }

  const sources: DesignerRerunReadinessSource[] = []
  const pending: string[] = []
  for (const nodeId of siblingNodeIds) {
    // Latest session for this (nodeId, loop_iter).
    const rows = await args.db
      .select()
      .from(crossClarifySessions)
      .where(
        and(
          eq(crossClarifySessions.taskId, args.taskId),
          eq(crossClarifySessions.crossClarifyNodeId, nodeId),
          eq(crossClarifySessions.loopIter, args.loopIter),
        ),
      )
      .orderBy(desc(crossClarifySessions.iteration))
      .limit(1)
    const latest = rows[0]
    if (latest === undefined) {
      pending.push(nodeId)
      continue
    }
    if (latest.status === 'awaiting_human') {
      // RFC-128 P3: a per-question dispatch explicitly dispatches THIS source's sealed
      // questions even though its round is still awaiting_human (a partial seal). So a
      // sibling whose latest session is being dispatched from is NOT pending — we are not
      // waiting for its remaining questions; its sealed Q&A is injected via the per-node
      // queue at dispatch (buildNodeQueueExternalFeedback), not via readiness.sources. Other
      // awaiting_human siblings still gate (golden lock H3/H2).
      if (args.dispatchedOrigins?.has(latest.crossClarifyNodeRunId)) continue
      pending.push(nodeId)
      continue
    }
    // Already-consumed sessions (designerRunTriggeredAt set) do not feed
    // again — they were part of a prior batch. Skip them as "resolved" so
    // we don't re-trigger off a stale row when a single new sibling just
    // submitted.
    if (latest.designerRunTriggeredAt !== null) {
      continue
    }
    if (latest.status === 'answered' && latest.directive === 'continue') {
      const questions = JSON.parse(latest.questionsJson) as ClarifyQuestion[]
      const answers =
        latest.answersJson !== null ? (JSON.parse(latest.answersJson) as ClarifyAnswer[]) : []
      sources.push({
        sessionId: latest.id,
        crossClarifyNodeId: nodeId,
        sourceQuestionerNodeId: latest.sourceQuestionerNodeId,
        iteration: latest.iteration,
        questions,
        answers,
        questionScopes: parseQuestionScopesJson(latest.questionScopesJson),
      })
    }
    // 'answered'+'stop' / 'abandoned' → resolved, no source contribution.
  }
  return {
    ready: pending.length === 0,
    sources,
    pendingCrossClarifyNodeIds: pending,
  }
}

// ---------------------------------------------------------------------------
// triggerDesignerRerun — new designer node_run (no worktree rollback).
// ---------------------------------------------------------------------------

export interface TriggerDesignerRerunArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  sources: DesignerRerunReadinessSource[]
  loopIter: number
  /** RFC-056 §5.2 step 4 (patch 2026-05-22) sibling cascade walks the
   *  workflow's edges. Threading the definition from the caller avoids a
   *  second DB hop for the workflow snapshot; the helper falls back to
   *  loading from `tasks.workflow_snapshot` when omitted. */
  definition?: WorkflowDefinition
  now?: () => number
}

export interface TriggerDesignerRerunResult {
  designerNodeRunId: string
  triggeredAt: number
}

/**
 * Mint a fresh designer node_run (cause 'cross-clarify-answer', retryIndex =
 * prior-max + 1) to revise with the aggregated External Feedback. The
 * worktree is NOT rolled back (patch 2026-06-22 — the designer revises in
 * place; its prior draft is re-supplied via the scheduler's
 * `## Prior Output (to update or regenerate)` prompt block). Downstream re-dispatch is
 * lazy (RFC-074): once this rerun produces a fresh done row,
 * recomputeFreshnessAndDemote demotes + re-dispatches stale downstream. The
 * caller is expected to call resumeTask once.
 */
export async function triggerDesignerRerun(
  args: TriggerDesignerRerunArgs,
): Promise<TriggerDesignerRerunResult> {
  const now = (args.now ?? Date.now)()

  // Latest designer node_run (any status, ANY parent) — the inheritance
  // source for the fresh mint below.
  // RFC-096 (audit S-13 / 附录 C #7): pick by pure ULID id via the shared
  // picker. The old `desc(startedAt)` had two pathologies — freshly minted
  // rerun rows never write startedAt (NULL sorts LAST under DESC, so they
  // could never be selected and a second trigger re-picked the stale row) and
  // mark-running REWRITES startedAt (a resumed old-iteration row jumped to the
  // front, anchoring inheritance/retry-bump on the wrong iteration —
  // the minted pending row was then invisible to the current frontier and
  // cross-clarify stalled). Child rows stay SELECTABLE on purpose: a designer
  // inside a wrapper-fanout lives on shard child rows, and its rerun must
  // inherit shardKey + parentNodeRunId (locked by cross-clarify-service
  // 'preserves shard_key + parent_node_run_id passthrough').
  const designerRows = await args.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, args.taskId), eq(nodeRuns.nodeId, args.designerNodeId)))
  const lastDesigner = pickFreshestRun(designerRows, { topLevelOnly: false })
  if (lastDesigner === undefined) {
    throw new NotFoundError(
      'cross-clarify-designer-run-not-found',
      `no designer node_run for ${args.designerNodeId} in task ${args.taskId}`,
    )
  }

  // patch 2026-06-22 (RFC-056): the cross-clarify-answer designer rerun does
  // NOT roll the worktree back to pre_snapshot. The designer is revising with
  // External Feedback — a continuation, not a retry — so its prior output (and
  // any downstream work sitting on top) is preserved; the prior draft is
  // re-supplied via the scheduler's `## Prior Output (to update or regenerate)` prompt
  // block. A genuine process-retry of THIS rerun still rolls back to its own
  // fresh pre_snapshot via the scheduler retry path; only this revise-with-
  // feedback rerun stops rolling back. See
  // design/RFC-056-clarify-cross-agent/patch-2026-06-22-designer-rerun-no-rollback.md.

  // Mint a fresh designer node_run. RFC-074 PR-C: freshness is now pure ULID
  // id-order, so the new row — being the latest insert — ALWAYS wins
  // `isFresherNodeRun` over any prior done row. No clarifyIteration counter is
  // computed or written.
  //
  // RFC-098 WP-10 (对抗检视修订 #11): the rerun_cause column is explicit now
  // ('cross-clarify-answer' below), so the scheduler's gate-2 no longer keys
  // on retryIndex at all — the old "deliberately retry_index ≥ 1 so
  // isClarifyRerun stays FALSE" proxy hack is dead. The max+1 bump below is
  // kept ONLY so the attempts switcher / lineage stays monotonic per
  // (node, iteration) (cross-clarify-designer-retry-index.test.ts pins it;
  // it deliberately did NOT flip with WP-10). The designer rerun keeps riding
  // the separate retry-agnostic `isCrossClarifyTriggeredRerun` update-mode
  // path, and every "clarify generation" consumer stays retry-AGNOSTIC,
  // keyed on prior-`done` id-order (priorDoneGenerationsForRun / memoryInject
  // anchor / frontend clarifyRoundForRun). See design §6.4.1 / §6.5.
  const topLevelDesignerRows = designerRows.filter(
    (r) => r.parentNodeRunId === null && r.iteration === lastDesigner.iteration,
  )
  const newDesignerRetryIndex =
    topLevelDesignerRows.length === 0
      ? 0
      : Math.max(...topLevelDesignerRows.map((r) => r.retryIndex)) + 1
  const designerNodeRunId = await mintNodeRun(args.db, {
    taskId: args.taskId,
    nodeId: args.designerNodeId,
    status: 'pending',
    cause: 'cross-clarify-answer',
    retryIndex: newDesignerRetryIndex,
    iteration: lastDesigner.iteration,
    inheritFrom: lastDesigner,
    overrides: { startedAt: null },
  })

  // RFC-074 (T-B8): no downstream sibling cascade. Pre-minting downstream
  // pending rows here was exactly the speculative-mint over-trigger RFC-074
  // eliminates. Provenance freshness now propagates the rerun lazily — once this
  // designer rerun produces a fresh done row, the scheduler's per-batch
  // recomputeFreshnessAndDemote demotes its now-stale downstream and
  // re-dispatches them, recording fresh consumed. See design §4.3 / D9.
  log.info('cross-clarify designer rerun triggered', {
    taskId: args.taskId,
    designerNodeId: args.designerNodeId,
    designerNodeRunId,
    sourceCount: args.sources.length,
  })

  return { designerNodeRunId, triggeredAt: now }
}

// ---------------------------------------------------------------------------
// triggerQuestionerStopRerun — reject path.
// ---------------------------------------------------------------------------

export interface TriggerQuestionerStopRerunArgs {
  db: DbClient
  taskId: string
  questionerNodeRunId: string
  now?: () => number
}

export interface TriggerQuestionerStopRerunResult {
  questionerNodeRunId: string
}

/**
 * Mint a fresh questioner node_run keyed on the same (nodeId, iteration)
 * so the next scheduler pass dispatches it. The questioner's prompt picks
 * up the STOP CLARIFYING anchor + full Q&A history through the cross-
 * clarify path automatically at dispatch time (scheduler/runner hook).
 */
export async function triggerQuestionerStopRerun(
  args: TriggerQuestionerStopRerunArgs,
): Promise<TriggerQuestionerStopRerunResult> {
  return mintQuestionerRerun(args)
}

// ---------------------------------------------------------------------------
// RFC-059 triggerQuestionerContinueRerun — fast path when this session is
// all-questioner-scope. Twin of triggerQuestionerStopRerun: same shape,
// same node_run inheritance rules, but caller does NOT persist directive=
// 'stop' (the session keeps directive='continue') and does NOT append the
// STOP CLARIFYING anchor. The questioner cascade rerun picks up the full
// Q&A through the existing buildPromptContext / buildQuestionerCross-
// ClarifyContext path — those readers don't consult questionScopesJson,
// so the questioner always sees every answer regardless of scope.
// ---------------------------------------------------------------------------

export interface TriggerQuestionerContinueRerunArgs {
  db: DbClient
  taskId: string
  questionerNodeRunId: string
  now?: () => number
}

export interface TriggerQuestionerContinueRerunResult {
  questionerNodeRunId: string
}

export async function triggerQuestionerContinueRerun(
  args: TriggerQuestionerContinueRerunArgs,
): Promise<TriggerQuestionerContinueRerunResult> {
  return mintQuestionerRerun(args)
}

/**
 * Mint a fresh questioner node_run keyed on (nodeId, iteration). Shared
 * helper for both `triggerQuestionerStopRerun` (reject) and
 * `triggerQuestionerContinueRerun` (RFC-059 fast path). The behavioural
 * difference (STOP CLARIFYING anchor injection) lives at prompt-render
 * time, controlled by the session's persisted directive — the rerun's
 * dispatch path is identical.
 *
 * RFC-074 PR-C: no clarifyIteration bump. The scheduler's
 * `isQuestionerCrossClarifyRerun` gate is now `clarifyMode === 'cross'` (PR-B
 * regression fix) and the cross-questioner prompt context ages by the RFC-070
 * `consumedByQuestionerRunId IS NULL` stamp — neither reads cci. Freshness is
 * pure id-order, so this freshly-minted row is the latest insert and wins
 * `isFresherNodeRun` automatically. The old max-participant+1 bump (the
 * symptom-masking patch for task 01KSESDVXQVRQX1FXG6N432C52) is gone.
 */
async function mintQuestionerRerun(args: {
  db: DbClient
  taskId: string
  questionerNodeRunId: string
}): Promise<{ questionerNodeRunId: string }> {
  const lastRun = (
    await args.db.select().from(nodeRuns).where(eq(nodeRuns.id, args.questionerNodeRunId)).limit(1)
  )[0]
  if (lastRun === undefined) {
    throw new NotFoundError(
      'cross-clarify-questioner-run-not-found',
      `questioner node_run ${args.questionerNodeRunId} not found`,
    )
  }

  // RFC-098 WP-10: cause='cross-clarify-questioner-rerun' rides the same
  // scheduler gate-2 set as 'clarify-answer' (the questioner's stop-directive
  // scoping / inline behavior is "same logical round continues") — stated
  // outright now instead of the old "retryIndex 0 + generation > 0" proxy.
  const newId = await mintNodeRun(args.db, {
    taskId: args.taskId,
    nodeId: lastRun.nodeId,
    status: 'pending',
    cause: 'cross-clarify-questioner-rerun',
    iteration: lastRun.iteration,
    inheritFrom: lastRun,
    overrides: { startedAt: null },
  })
  return { questionerNodeRunId: newId }
}

// ---------------------------------------------------------------------------
// dispatchCrossClarifyNode — scheduler-side helper.
// ---------------------------------------------------------------------------

export interface DispatchCrossClarifyResult {
  /** 'short-circuit-stop' = persistent stop hit, node_run forced done.
   *  'awaiting' = needs envelope from questioner; nothing to do, the runner
   *               will create a session when the questioner emits clarify.
   *  'no-questioner' = validator missed cross-clarify-input-source-missing;
   *                    return failed so the scheduler surfaces it. */
  kind: 'short-circuit-stop' | 'awaiting' | 'no-questioner'
}

/**
 * The scheduler calls this when a cross-clarify node enters its dispatch
 * branch (one of: first-time visit / sibling cascade reset / loop-iter
 * advance). The cross-clarify node itself has no agent to run — it is
 * the human-gated form. Dispatch logic:
 *
 *   1. Check the cross_clarify_sessions table for any directive='stop'
 *      session matching this node_id (across all loop_iter).
 *   2. If found → transition the node_run pending → done (persistent-stop);
 *      do NOT park awaiting_human. The questioner's own cascade rerun
 *      runs through STOP CLARIFYING. This satisfies S3 (reject persistence).
 *   3. Otherwise → no-op; await the questioner emit-clarify → session
 *      creation flow which will park the SAME node_run row (via
 *      createCrossClarifySession's own park).
 */
export async function dispatchCrossClarifyNode(args: {
  db: DbClient
  taskId: string
  crossClarifyNodeId: string
  /** node_runs.id the scheduler is dispatching. */
  nodeRunId: string
  definition: WorkflowDefinition
}): Promise<DispatchCrossClarifyResult> {
  const questionerNodeId = findQuestionerNodeForCrossClarify(
    args.definition,
    args.crossClarifyNodeId,
  )
  if (questionerNodeId === undefined) {
    return { kind: 'no-questioner' }
  }
  // RFC-123 (B2): the questioner's canvas toggle is authoritative for re-enable —
  // an explicit, RECENT 'continue' (user flipped the toggle back AFTER the stop)
  // overrides hasPersistentStop so the questioner can ask again. A stale 'continue'
  // (older than the stop), a 'stop', or no row ⇒ hasPersistentStop unchanged.
  const stopped = await resolveCrossNodeStopped(
    args.db,
    args.taskId,
    args.crossClarifyNodeId,
    questionerNodeId,
  )
  if (stopped) {
    // RFC-053: mark-done is running → done; we set the node_run to running
    // first (mark-running from pending). The cross-clarify node has no
    // real worker; transitioning briefly into running is fine — keeps
    // the lifecycle invariant happy.
    await setNodeRunStatus({
      db: args.db,
      nodeRunId: args.nodeRunId,
      to: 'done',
      allowedFrom: ['pending'],
      reason: 'cross-clarify-persistent-stop',
      extra: { finishedAt: Date.now() },
    })
    return { kind: 'short-circuit-stop' }
  }
  return { kind: 'awaiting' }
}

/**
 * RFC-056: returns true if any directive='stop' row exists for this
 * (taskId, crossClarifyNodeId), regardless of loop_iter. Persistence is
 * defined at the cross-clarify node level — once rejected, the questioner
 * never asks via this node again in the same task.
 */
export async function hasPersistentStop(
  db: DbClient,
  taskId: string,
  crossClarifyNodeId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: crossClarifySessions.id })
    .from(crossClarifySessions)
    .where(
      and(
        eq(crossClarifySessions.taskId, taskId),
        eq(crossClarifySessions.crossClarifyNodeId, crossClarifyNodeId),
        eq(crossClarifySessions.directive, 'stop'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * RFC-123: the timestamp of the most-recent directive='stop' session for this
 * cross-clarify node (answeredAt, createdAt fallback), or null if none. Used to
 * recency-gate the questioner toggle's 'continue' re-enable against the stop it
 * would override.
 */
export async function latestPersistentStopAt(
  db: DbClient,
  taskId: string,
  crossClarifyNodeId: string,
): Promise<number | null> {
  const rows = await db
    .select({
      answeredAt: crossClarifySessions.answeredAt,
      createdAt: crossClarifySessions.createdAt,
    })
    .from(crossClarifySessions)
    .where(
      and(
        eq(crossClarifySessions.taskId, taskId),
        eq(crossClarifySessions.crossClarifyNodeId, crossClarifyNodeId),
        eq(crossClarifySessions.directive, 'stop'),
      ),
    )
  let latest: number | null = null
  for (const r of rows) {
    const t = r.answeredAt ?? r.createdAt
    if (t !== null && (latest === null || t > latest)) latest = t
  }
  return latest
}

/**
 * RFC-056 + RFC-123: should the cross-clarify NODE short-circuit to done?
 * True when a persistent 'stop' exists AND the questioner's canvas toggle does NOT
 * explicitly re-enable it. The toggle re-enables ('continue') only when it is at
 * least as RECENT as the latest stop — a stale pre-RFC-123 'continue' row (kept by
 * the canvas API while answer-stop did not update the table) must not re-open a
 * later stop. No persistent stop ⇒ false; no toggle row / 'stop' toggle / stale
 * 'continue' ⇒ plain hasPersistentStop (golden-lock).
 */
export async function resolveCrossNodeStopped(
  db: DbClient,
  taskId: string,
  crossClarifyNodeId: string,
  questionerNodeId: string,
): Promise<boolean> {
  if (!(await hasPersistentStop(db, taskId, crossClarifyNodeId))) return false
  const qRow = await getNodeClarifyDirectiveRow(db, taskId, questionerNodeId)
  if (qRow?.directive !== 'continue') return true
  const stopAt = await latestPersistentStopAt(db, taskId, crossClarifyNodeId)
  // re-enable (not stopped) only when the 'continue' toggle is at least as recent
  // as the stop it overrides; otherwise stay stopped (conservative on unknown time).
  return stopAt === null || stopAt > qRow.updatedAt
}

// ---------------------------------------------------------------------------
// External Feedback prompt assembly — designer rerun side.
// ---------------------------------------------------------------------------

export interface BuildExternalFeedbackArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  loopIter: number
  /** RFC-074 PR-C: the designer's clarify generation, derived by the scheduler
   *  from prior-done id-order (replaces the retired clarifyIteration counter).
   *  0 = first designer run → no consumed cross-clarify batch to surface. Used
   *  only for the early-exit guard and the rendered "round" display; aging
   *  itself is the RFC-070 `consumedByConsumerRunId IS NULL` stamp below. */
  designerGeneration: number
  definition: WorkflowDefinition
  /**
   * RFC-120 §18 (model A, corrected): the about-to-run node's OWN node_run id.
   * Passed by the scheduler ONLY for a deferred-dispatch task. When set,
   * buildExternalFeedbackContext takes the PER-NODE-QUEUE branch — selecting this
   * node's dispatched-unconsumed designer queue (effective handler == designerNodeId),
   * BINDING it to this run (trigger_run_id = dispatchedRunId), and building the block —
   * independent of the `__external_feedback__` graph edge. This is AUTHORITATIVE for
   * deferred tasks (no graph fall-through): a graph designer and an arbitrary override
   * target both inject from the same per-node queue. Omitted on the (non-deferred)
   * graph-path call → byte-for-byte the existing behaviour (golden-lock).
   */
  dispatchedRunId?: string
}

export interface ExternalFeedbackPromptContext {
  block: string
  iteration: string
  sourcesCsv: string
  /**
   * RFC-056 §6 update mode (2026-05-22 amendment): pre-rendered designer's
   * last done output (via shared `buildPriorOutputBlock`), populated only
   * when the rerun was triggered by a cross-clarify submit AND the prior
   * done node_run captured at least one non-empty port output. The shared
   * `renderUserPrompt` emits `## Prior Output (to update or regenerate)` +
   * `## Update Directive` sections when this is set. Undefined / empty
   * preserves legacy regenerate-from-inputs behaviour.
   */
  priorOutputBlock?: string
  /**
   * RFC-120 T9 (model A): true when this context came from the RUN-SCOPED override
   * path (buildRunScopedExternalFeedback) — the handler is an override target
   * handed a NEW question via External Feedback, NOT a designer revising its own
   * prior draft. The scheduler suppresses the generic RFC-119 `priorOutputUpdate`
   * (Update Directive) for such a run so an override target with its own prior
   * outputs is not wrongly told to "update" them (Codex M1).
   */
  runScoped?: boolean
  /**
   * RFC-120 §18 (ship-gate): for a deferred per-node-queue context, true iff the rendered
   * queue includes ≥1 GRAPH-owned round for THIS node (an entry whose default_target_node_id
   * == this node — a genuine graph-designer round), false for a pure-override handoff. The
   * scheduler attaches the cross-clarify `priorOutputBlock` (RFC-119 Prior Output + Update
   * Directive) ONLY when graphOwned is true: an override target that also happens to have its
   * own `__external_feedback__` edge + prior output must process the REASSIGNED question, NOT
   * rewrite its own old artifact (the topology gate `hasExternalFeedbackChannel` is not an
   * ownership signal). Undefined on the non-deferred graph path (untouched, golden-lock).
   */
  graphOwned?: boolean
}

/**
 * Build the {{__external_feedback__}} prompt context for the designer's
 * about-to-spawn run. Pulls every directive='continue' session whose
 * designer_run_triggered_at corresponds to the latest designer run batch
 * (per-source latest within loop_iter); orders sources by NodeId dictionary.
 * Returns `undefined` when no consumed sessions exist (first run / no
 * sources / designer hasn't been triggered by cross-clarify yet).
 */
export async function buildExternalFeedbackContext(
  args: BuildExternalFeedbackArgs,
): Promise<ExternalFeedbackPromptContext | undefined> {
  // RFC-120 §18 (model A, corrected) — per-node INJECTION queue. When the scheduler
  // passes the rerun's OWN node_run id (it does so ONLY for a deferred-dispatch task),
  // bind + inject THIS node's dispatched-unconsumed designer queue — the questions
  // whose effective handler (override ?? graph designer) is this node, committed for
  // execution (`dispatched_at` set) and not yet bound to a finished run. This is
  // AUTHORITATIVE for deferred tasks (no graph fall-through), so a graph designer and
  // an arbitrary override target both inject from the same per-node queue and an
  // overridden-away question is simply absent from the graph designer's queue — no
  // C1 exclusion, no double-handling (RFC-120 §18.3). The graph `__external_feedback__`
  // path below is the NON-deferred (golden-lock) mechanism only.
  if (args.dispatchedRunId !== undefined) {
    return buildNodeQueueExternalFeedback(
      args.db,
      args.taskId,
      args.designerNodeId,
      args.dispatchedRunId,
      args.designerGeneration,
    )
  }

  if (args.designerGeneration <= 0) return undefined

  const siblingNodeIds = findCrossClarifyNodesPointingToDesigner(
    args.definition,
    args.designerNodeId,
  )
  if (siblingNodeIds.length === 0) return undefined

  const sources: CrossClarifySourceContext[] = []
  for (const nodeId of siblingNodeIds) {
    const rows = await args.db
      .select()
      .from(crossClarifySessions)
      .where(
        and(
          eq(crossClarifySessions.taskId, args.taskId),
          eq(crossClarifySessions.crossClarifyNodeId, nodeId),
          eq(crossClarifySessions.loopIter, args.loopIter),
          eq(crossClarifySessions.status, 'answered'),
          eq(crossClarifySessions.directive, 'continue'),
          // RFC-070: drop sources already baked into a prior designer
          // done-with-output run. Replaces the iteration-counter cutoff that
          // mis-fired when self-clarify rounds pushed the unified
          // clarifyIteration past cross_clarify_sessions.iteration's local
          // counter — see RFC-070 proposal §1.4 (task
          // `01KSHDCASXA5GDKN3KDZVXYYT0`).
          isNull(crossClarifySessions.consumedByConsumerRunId),
        ),
      )
      .orderBy(desc(crossClarifySessions.iteration))
      .limit(1)
    const latest = rows[0]
    if (latest === undefined) continue
    const questions = JSON.parse(latest.questionsJson) as ClarifyQuestion[]
    const answers =
      latest.answersJson !== null ? (JSON.parse(latest.answersJson) as ClarifyAnswer[]) : []
    // RFC-059: filter to designer-scoped subset BEFORE the source enters the
    // External Feedback block. NULL scopes (RFC-056/058 legacy rows or
    // clients that omit questionScopes) fall back to all-designer via
    // `extractDesignerScopedSubset` / `resolveQuestionScope`, so this block
    // is byte-equivalent to the pre-RFC-059 behaviour on legacy rows.
    //
    // Critical invariant: this filter applies ONLY to the designer side.
    // The questioner cascade rerun reads via
    // `clarifyRounds.ts/buildPromptContext` (consumerKind='cross-questioner')
    // which does NOT consult questionScopesJson — the questioner always
    // sees every answer regardless of scope. C3 grep guards lock that.
    const scopes = parseQuestionScopesJson(latest.questionScopesJson)
    const subset = extractDesignerScopedSubset(questions, answers, scopes)
    if (subset.questions.length === 0) {
      // RFC-059: every question on this source went to the questioner.
      // Skip the source entirely so the designer's prompt doesn't render
      // an empty `### From '...' (round N)` heading with no Q&A under it.
      continue
    }
    sources.push({
      sourceQuestionerNodeId: latest.sourceQuestionerNodeId,
      crossClarifyNodeId: nodeId,
      iteration: latest.iteration,
      questions: subset.questions,
      answers: subset.answers,
    })
  }
  if (sources.length === 0) return undefined
  const block = buildExternalFeedbackBlock(sources)
  const csv = sources
    .slice()
    .sort((a, b) => a.sourceQuestionerNodeId.localeCompare(b.sourceQuestionerNodeId))
    .map((s) => s.sourceQuestionerNodeId)
    .join(', ')
  return {
    block,
    iteration: String(args.designerGeneration),
    sourcesCsv: csv,
  }
}

/**
 * RFC-120 §18 (model A, corrected) per-node-queue External Feedback — build the
 * `## External Feedback` block from THIS handler node's dispatched-unconsumed designer
 * queue, and BIND that queue to the current rerun. Selection (independent of any graph
 * `__external_feedback__` edge):
 *
 *   roleKind='designer' AND dispatched_at IS NOT NULL (committed for execution)
 *   AND effective handler (override ?? graph designer) == `handlerNodeId`
 *   AND the question renders for THIS run's LINEAGE: trigger_run_id IS NULL (unbound →
 *       pick + bind), OR trigger_run_id is in the current run's process-retry lineage
 *       window AND that lineage is NOT yet consumed (no done+output run).
 *
 * Codex H2 (process-retry must keep the feedback): a process-retry mints a FRESH node_run
 * id. Selecting only `trigger_run_id IS NULL OR == dispatchedRunId` would DROP a question
 * bound to the FAILED first attempt — the retry's different id can't reselect it, so the
 * retry would run WITHOUT the External Feedback while the read-side lineage treats it as the
 * handler continuation → false awaiting_confirm for work that never saw the Q&A. So we
 * frame the same lineage window resolveHandlerRun uses ([anchor, next-clarify-rerun),
 * excluding consumed) and re-render + REBIND any question whose binding is an earlier,
 * still-unconsumed run in THIS run's lineage. The block reuses the SAME
 * `buildExternalFeedbackBlock` the graph path uses. Returns undefined when the node has no
 * renderable queue (a non-handler node that merely re-ran via cascade → no injection).
 */
async function buildNodeQueueExternalFeedback(
  db: DbClient,
  taskId: string,
  handlerNodeId: string,
  dispatchedRunId: string,
  generation: number,
): Promise<ExternalFeedbackPromptContext | undefined> {
  // ALL dispatched designer entries whose effective handler is this node (trigger state
  // filtered in JS by the lineage window below).
  const candidates = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        isNotNull(taskQuestions.dispatchedAt),
        // RFC-127 借壳: select by HOME node (default designer; manual falls back to override),
        // not by override — the borrowed run is minted ON the home node, so the home's per-node
        // queue must pick up this entry + bind its trigger_run_id to the home's rerun. Reading
        // by override would miss it → answer not injected, trigger_run_id unbound, stuck.
        or(
          eq(taskQuestions.defaultTargetNodeId, handlerNodeId),
          and(
            isNull(taskQuestions.defaultTargetNodeId),
            eq(taskQuestions.overrideTargetNodeId, handlerNodeId),
          ),
        ),
      ),
    )
  if (candidates.length === 0) return undefined

  // Frame the lineage on this run's node + iteration (mirrors resolveHandlerRun). All of
  // the node's runs at this iteration are the process-retry / clarify-rerun chain.
  const rRow = (
    await db.select().from(nodeRuns).where(eq(nodeRuns.id, dispatchedRunId)).limit(1)
  )[0]
  const sameNode = rRow
    ? await db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            eq(nodeRuns.nodeId, handlerNodeId),
            eq(nodeRuns.iteration, rRow.iteration),
          ),
        )
    : []
  const outputRunIds = await runIdsWithOutputCC(
    db,
    sameNode.map((r) => r.id),
  )

  const entries = candidates.filter((e) =>
    renderableForRun(e.triggerRunId, dispatchedRunId, sameNode, outputRunIds),
  )
  if (entries.length === 0) return undefined

  // BIND every rendered entry not already pinned to THIS run (unbound NULLs + earlier-
  // lineage rebinds) → the consumption marker for the node's NEXT rerun + the read-side.
  const toBind = entries.filter((e) => e.triggerRunId !== dispatchedRunId).map((e) => e.id)
  if (toBind.length > 0) {
    await db
      .update(taskQuestions)
      .set({ triggerRunId: dispatchedRunId, updatedAt: Date.now() })
      .where(inArray(taskQuestions.id, toBind))
  }

  // RFC-120 §15 (§15.4 注入面归一): resolve each queued entry's content by source. CLARIFY
  // entries (self/cross) derive Q&A from their origin clarify round (session); MANUAL entries
  // (§15) inject manual_body — a human-authored instruction with no round. Both render into
  // the SAME `## External Feedback` block. A manual row's synthetic origin matches no round,
  // so it MUST be handled here (not via the byRound lookup below).
  const clarifyEntries = entries.filter((e) => e.sourceKind !== 'manual')
  const manualEntries = entries.filter((e) => e.sourceKind === 'manual')

  // Group the queued CLARIFY questionIds by their origin round.
  const byRound = new Map<string, Set<string>>()
  for (const e of clarifyEntries) {
    const set = byRound.get(e.originNodeRunId) ?? new Set<string>()
    set.add(e.questionId)
    byRound.set(e.originNodeRunId, set)
  }

  const sources: CrossClarifySourceContext[] = []
  for (const [originRunId, questionIds] of byRound) {
    const round = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, originRunId))
        .limit(1)
    )[0]
    // RFC-128 P3: a designer entry can be dispatched once ITS question is sealed, even while
    // the round is still awaiting_human (a PARTIAL seal). The queued `questionIds` come from
    // dispatched designer entries, which are necessarily sealed (the stage gate requires it),
    // and `answers_json` carries ONLY sealed answers (mergeSealedAnswers) — an unsealed
    // sibling's answer is simply absent. So we no longer require the WHOLE round to be
    // 'answered'; restricting to `questionIds` below injects only the sealed Q&A. We still skip
    // a vanished / terminal (canceled/abandoned) round and one with no answers at all. A
    // fully-answered round still passes (golden lock).
    if (
      round === undefined ||
      round.status === 'canceled' ||
      round.status === 'abandoned' ||
      round.answersJson === null
    )
      continue
    const allQuestions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
    const allAnswers = JSON.parse(round.answersJson) as ClarifyAnswer[]
    const answerById = new Map(allAnswers.map((a) => [a.questionId, a]))
    const questions: ClarifyQuestion[] = []
    const answers: ClarifyAnswer[] = []
    for (const q of allQuestions) {
      if (!questionIds.has(q.id)) continue
      const a = answerById.get(q.id)
      if (a === undefined) continue
      questions.push(q)
      answers.push(a)
    }
    if (questions.length === 0) continue
    sources.push({
      sourceQuestionerNodeId: round.askingNodeId,
      // unused by buildExternalFeedbackBlock; the origin run id keeps the type total.
      crossClarifyNodeId: originRunId,
      iteration: round.iteration,
      questions,
      answers,
    })
  }
  // RFC-120 §15: manual entries render their human-authored instruction (manual_body).
  const manualBlock = manualEntries
    .map((e) => renderManualFeedbackSection(e.manualTitle, e.manualBody))
    .filter((s) => s.length > 0)
    .join('\n\n')

  if (sources.length === 0 && manualBlock.length === 0) return undefined

  // RFC-120 §18 (ship-gate): does THIS node own ≥1 GRAPH-designer round in the rendered queue
  // (an entry whose default == this node)? Drives the scheduler's ownership-gated prior-output:
  // a pure-override handoff (graphOwned=false) must NOT be told to update its own old artifact.
  // A manual entry's default is NULL, so a pure-manual queue keeps graphOwned=false correctly
  // (the handler must PROCESS the instruction, not rewrite its own old artifact).
  const graphOwned = entries.some((e) => e.defaultTargetNodeId === handlerNodeId)

  // RFC-120 §15: concatenate the clarify Q&A block + the manual instruction block into one
  // `## External Feedback` body (clarify first for stable ordering; either may be empty).
  const clarifyBlock = buildExternalFeedbackBlock(sources)
  const block = [clarifyBlock, manualBlock].filter((s) => s.length > 0).join('\n\n')
  const csvParts = sources
    .slice()
    .sort((a, b) => a.sourceQuestionerNodeId.localeCompare(b.sourceQuestionerNodeId))
    .map((s) => s.sourceQuestionerNodeId)
  if (manualEntries.length > 0) csvParts.push('manual')
  const csv = csvParts.join(', ')
  return { block, iteration: String(generation), sourcesCsv: csv, runScoped: true, graphOwned }
}

/**
 * RFC-120 §18 (Codex H2) — should a dispatched designer question bound to `triggerRunId`
 * render for the current run `currentRunId`? `sameNode` is every node_run on the handler
 * node at the current run's iteration (the process-retry / clarify-rerun chain). A question
 * renders iff:
 *   - triggerRunId IS NULL (unbound → first render of this run picks + binds it); OR
 *   - triggerRunId is in `sameNode` AND the current run is inside triggerRunId's lineage
 *     WINDOW [triggerRunId, next-clarify-rerun-after-it) AND that window has NO consumed
 *     (done+output) run. This re-renders a question bound to a FAILED earlier attempt for
 *     its process-retry, but NOT a question already consumed (done+output), and NOT one
 *     bound to a SEPARATE later clarify dispatch (that dispatch is the window's upper bound).
 */
function renderableForRun(
  triggerRunId: string | null,
  currentRunId: string,
  sameNode: ReadonlyArray<typeof nodeRuns.$inferSelect>,
  outputRunIds: ReadonlySet<string>,
): boolean {
  if (triggerRunId === null) return true
  const anchor = sameNode.find((r) => r.id === triggerRunId)
  if (anchor === undefined) return false // bound to a run in another frame / GC'd → not ours
  const triggerCauses = new Set<string>(NEW_CLARIFY_TRIGGER_CAUSES)
  // Upper bound = the next NEW-clarify rerun strictly after the anchor (a separate dispatch).
  let upperBound: string | null = null
  for (const r of sameNode) {
    if (r.id > triggerRunId && r.rerunCause !== null && triggerCauses.has(r.rerunCause)) {
      if (upperBound === null || r.id < upperBound) upperBound = r.id
    }
  }
  const inWindow = (id: string): boolean =>
    id >= triggerRunId && (upperBound === null || id < upperBound)
  if (!inWindow(currentRunId)) return false // current run belongs to a later dispatch window
  // Consumed iff any TOP-LEVEL run in the window already produced output.
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
async function runIdsWithOutputCC(db: DbClient, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, runIds))
  return new Set(rows.map((r) => r.nodeRunId))
}

// ---------------------------------------------------------------------------
// Questioner cross-clarify Q&A prompt assembly — RFC-056 §5.4 §6.4.
// ---------------------------------------------------------------------------

export interface BuildQuestionerCrossClarifyContextArgs {
  db: DbClient
  taskId: string
  /** The questioner agent node being re-spawned. */
  questionerNodeId: string
  /** The questioner's about-to-run `clarifyIteration` (RFC-064 unified
   *  counter — covers cross-clarify rounds). Values ≤ 0 return undefined
   *  (first ever run has no prior Q&A to surface). */
  targetClarifyIteration: number
}

/**
 * RFC-056 §5.4 §6.4: build a ClarifyPromptContext for the questioner's
 * cross-clarify rerun. Reuses the RFC-023 prompt shape (`questionsBlock` /
 * `answersBlock` / `iteration` / `directive`) so `renderUserPrompt` emits
 * the same `## Clarify Q&A` / `## Prior Rounds (Questions)` sections — the
 * agent reads its own past questions + the designer's answers + the standing
 * directive (continue → ask-bias preamble; stop → STOP CLARIFYING trailer)
 * without any new template wiring.
 *
 * Differs from `buildClarifyPromptContext` only in the data source: pulls
 * from `cross_clarify_sessions WHERE source_questioner_node_id=?` instead of
 * `clarify_sessions WHERE source_agent_node_id=?`. Both tables share the
 * RFC-023 envelope schema so the rendering helpers (`renderClarifyQuestionsBlock`
 * / `buildClarifyPromptBlock`) work verbatim.
 *
 * Returns `undefined` when the questioner has no answered sessions yet (a
 * first cross-clarify dispatch, or a node that never went through cross-
 * clarify) — the renderer then degrades to no `## Clarify Q&A` section.
 */
export async function buildQuestionerCrossClarifyContext(
  args: BuildQuestionerCrossClarifyContextArgs,
): Promise<ClarifyPromptContext | undefined> {
  if (args.targetClarifyIteration <= 0) return undefined

  const rows = await args.db
    .select()
    .from(crossClarifySessions)
    .where(
      and(
        eq(crossClarifySessions.taskId, args.taskId),
        eq(crossClarifySessions.sourceQuestionerNodeId, args.questionerNodeId),
        eq(crossClarifySessions.status, 'answered'),
        // RFC-070: questioner-side row-state aging — drop rounds already
        // baked into a prior questioner done-with-output run on the cascade
        // path.
        isNull(crossClarifySessions.consumedByQuestionerRunId),
      ),
    )
    .orderBy(asc(crossClarifySessions.iteration))

  if (rows.length === 0) return undefined

  const questionParts: string[] = []
  const answerParts: string[] = []
  // `directive='stop'` from any session this round flips the questioner's
  // prompt to the STOP CLARIFYING trailer per §5.4. We pick the LAST row's
  // directive — sessions arrive in iteration order so the latest is the
  // standing instruction.
  let latestDirective: ClarifyDirective = 'continue'

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    let questions: ClarifyQuestion[]
    let answers: ClarifyAnswer[]
    try {
      questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
      answers = row.answersJson !== null ? (JSON.parse(row.answersJson) as ClarifyAnswer[]) : []
    } catch (err) {
      log.warn('cross-clarify questioner context JSON parse failed; skipping round', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    const isLast = i === rows.length - 1
    const directive = (row.directive ?? 'continue') as ClarifyDirective
    if (isLast) latestDirective = directive
    const roundLabel = `### Round ${row.iteration + 1}`
    questionParts.push(`${roundLabel}\n${renderClarifyQuestionsBlock(questions)}`)
    answerParts.push(
      `${roundLabel}\n${buildClarifyPromptBlock(questions, answers, isLast ? directive : undefined)}`,
    )
  }

  if (questionParts.length === 0) return undefined

  return {
    questionsBlock: questionParts.join('\n\n'),
    answersBlock: answerParts.join('\n\n'),
    iteration: String(args.targetClarifyIteration),
    remaining: '',
    directive: latestDirective,
  }
}

// ---------------------------------------------------------------------------
// Read-side helpers used by REST routes.
// ---------------------------------------------------------------------------

export interface ListCrossClarifySummariesFilter {
  taskId?: string
  status?: CrossClarifySessionStatus | 'all'
  limit?: number
}

export async function listCrossClarifySummaries(
  db: DbClient,
  filter: ListCrossClarifySummariesFilter = {},
): Promise<CrossClarifySessionSummary[]> {
  const all = await db
    .select()
    .from(crossClarifySessions)
    .orderBy(desc(crossClarifySessions.createdAt))
  const desired = filter.status ?? 'awaiting_human'
  const filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desired !== 'all' && r.status !== desired) return false
    return true
  })
  const limit = filter.limit ?? 100
  const sliced = filtered.slice(0, limit)
  // RFC-037 parity: bulk-fetch task names for the included rows so each
  // summary carries a non-empty taskName (mirrors listClarifySummaries).
  const taskIds = Array.from(new Set(sliced.map((r) => r.taskId)))
  const taskNameByTaskId = new Map<string, string>()
  if (taskIds.length > 0) {
    const taskRows = await db.select({ id: tasks.id, name: tasks.name }).from(tasks)
    const wanted = new Set(taskIds)
    for (const r of taskRows) if (wanted.has(r.id)) taskNameByTaskId.set(r.id, r.name)
  }
  return sliced.map((r) => rowToSummary(r, taskNameByTaskId.get(r.taskId) ?? ''))
}

export async function getCrossClarifyDetail(
  db: DbClient,
  crossClarifyNodeRunId: string,
): Promise<CrossClarifySession> {
  const rows = await db
    .select()
    .from(crossClarifySessions)
    .where(eq(crossClarifySessions.crossClarifyNodeRunId, crossClarifyNodeRunId))
    .orderBy(desc(crossClarifySessions.createdAt))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'cross-clarify-session-not-found',
      `no cross_clarify_session for node_run ${crossClarifyNodeRunId}`,
    )
  }
  return rowToSession(row)
}

/**
 * Task delete path — drop every cross_clarify_session for this task. The
 * FK CASCADE on tasks(id) handles the row eviction too; this is explicit
 * so any future audit / WS broadcast surface stays clean.
 */
export async function cleanupCrossClarifySessionsForTask(
  db: DbClient,
  taskId: string,
): Promise<void> {
  await db.delete(crossClarifySessions).where(eq(crossClarifySessions.taskId, taskId))
  // RFC-058 T12 dual-write — mirror cleanup on clarify_rounds (cross slice).
  await db
    .delete(clarifyRounds)
    .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.kind, 'cross')))
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function mergeAnswered(
  row: typeof crossClarifySessions.$inferSelect,
  sealedAnswers: ClarifyAnswer[],
  directive: ClarifyDirective,
  answeredAt: number,
  questionScopes: Record<string, ClarifyQuestionScope> | null,
): CrossClarifySession {
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  return {
    id: row.id,
    taskId: row.taskId,
    crossClarifyNodeId: row.crossClarifyNodeId,
    crossClarifyNodeRunId: row.crossClarifyNodeRunId,
    sourceQuestionerNodeId: row.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: row.sourceQuestionerNodeRunId,
    targetDesignerNodeId: row.targetDesignerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questions,
    answers: sealedAnswers,
    directive,
    status: 'answered',
    designerRunTriggeredAt: row.designerRunTriggeredAt,
    createdAt: row.createdAt,
    answeredAt,
    abandonedAt: row.abandonedAt,
    questionScopes,
  }
}

/**
 * RFC-059 — defensive validation of submit body's `questionScopes` map
 * against the session's persisted questions. Three failure modes are turned
 * into a single `ValidationError` 400 'cross-clarify-question-scopes-
 * malformed' so the REST route maps cleanly:
 *
 *   - undefined / null input → returns undefined (caller writes NULL,
 *     runtime falls back to all-designer).
 *   - any key that is NOT a questionId in the session → reject.
 *   - any value that is not 'designer' | 'questioner' (zod parse fails) → reject.
 *
 * Empty object `{}` is accepted (every question defaults to 'designer').
 * Sparse maps are accepted (questions not mentioned default to 'designer').
 */
function validateQuestionScopes(
  scopes: Record<string, ClarifyQuestionScope> | undefined,
  questions: ClarifyQuestion[],
): Record<string, ClarifyQuestionScope> | undefined {
  if (scopes === undefined) return undefined
  const validQuestionIds = new Set(questions.map((q) => q.id))
  const out: Record<string, ClarifyQuestionScope> = {}
  for (const [questionId, scope] of Object.entries(scopes)) {
    if (!validQuestionIds.has(questionId)) {
      throw new ValidationError(
        'cross-clarify-question-scopes-malformed',
        `questionScopes references unknown questionId '${questionId}'`,
      )
    }
    const parsed = ClarifyQuestionScopeSchema.safeParse(scope)
    if (!parsed.success) {
      throw new ValidationError(
        'cross-clarify-question-scopes-malformed',
        `questionScopes['${questionId}'] is not 'designer' or 'questioner' (got ${JSON.stringify(scope)})`,
      )
    }
    out[questionId] = parsed.data
  }
  return out
}

function rowToSession(row: typeof crossClarifySessions.$inferSelect): CrossClarifySession {
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  const out: CrossClarifySession = {
    id: row.id,
    taskId: row.taskId,
    crossClarifyNodeId: row.crossClarifyNodeId,
    crossClarifyNodeRunId: row.crossClarifyNodeRunId,
    sourceQuestionerNodeId: row.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: row.sourceQuestionerNodeRunId,
    targetDesignerNodeId: row.targetDesignerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questions,
    directive: (row.directive ?? null) as ClarifyDirective | null,
    status: row.status as CrossClarifySessionStatus,
    designerRunTriggeredAt: row.designerRunTriggeredAt,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    abandonedAt: row.abandonedAt,
    questionScopes: parseQuestionScopesJson(row.questionScopesJson),
  }
  if (row.answersJson !== null) {
    try {
      out.answers = JSON.parse(row.answersJson) as ClarifyAnswer[]
    } catch {
      /* ignore corrupt answers */
    }
  }
  return out
}

/**
 * RFC-059 — parse the `question_scopes_json` column back into the runtime
 * map. NULL / parse failure → null (runtime treats null as all-designer via
 * `resolveQuestionScope`).
 */
function parseQuestionScopesJson(raw: string | null): Record<string, ClarifyQuestionScope> | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const out: Record<string, ClarifyQuestionScope> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const z = ClarifyQuestionScopeSchema.safeParse(v)
      if (z.success) out[k] = z.data
    }
    return out
  } catch {
    return null
  }
}

function rowToSummary(
  row: typeof crossClarifySessions.$inferSelect,
  taskName = '',
): CrossClarifySessionSummary {
  let questionCount = 0
  try {
    const qs = JSON.parse(row.questionsJson) as ClarifyQuestion[]
    questionCount = Array.isArray(qs) ? qs.length : 0
  } catch {
    questionCount = 0
  }
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
    crossClarifyNodeId: row.crossClarifyNodeId,
    crossClarifyNodeRunId: row.crossClarifyNodeRunId,
    sourceQuestionerNodeId: row.sourceQuestionerNodeId,
    targetDesignerNodeId: row.targetDesignerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questionCount,
    status: row.status as CrossClarifySessionStatus,
    directive: (row.directive ?? null) as ClarifyDirective | null,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

function parseDefinitionFromSnapshot(snapshotJson: string): WorkflowDefinition | null {
  try {
    return JSON.parse(snapshotJson) as WorkflowDefinition
  } catch {
    return null
  }
}

function broadcastCrossClarifyCreated(taskId: string, session: CrossClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.created',
    nodeRunId: session.crossClarifyNodeRunId,
    crossClarifyNodeId: session.crossClarifyNodeId,
    sessionId: session.id,
    iteration: session.iteration,
    sourceQuestionerNodeId: session.sourceQuestionerNodeId,
    targetDesignerNodeId: session.targetDesignerNodeId,
  })
}

function broadcastCrossClarifyAnswered(taskId: string, session: CrossClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.answered',
    nodeRunId: session.crossClarifyNodeRunId,
    sessionId: session.id,
    iteration: session.iteration,
    directive: session.directive ?? 'continue',
  })
}

function broadcastCrossClarifyRejected(
  taskId: string,
  session: CrossClarifySession,
  questionerNodeRunId: string,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.rejected',
    nodeRunId: session.crossClarifyNodeRunId,
    sessionId: session.id,
    questionerNodeRunId,
  })
}

function broadcastDesignerRerunBatched(
  taskId: string,
  designerNodeRunId: string,
  sourceQuestionerNodeIds: string[],
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'cross-clarify.designer-rerun-batched',
    designerNodeRunId,
    sourceQuestionerNodeIds,
  })
}

// Re-exports for the runner / scheduler / route layer so they don't pull
// directly from shared in two places.
export {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  resolveCrossClarifySessionMode,
}
export type { ClarifyCrossAgentNode }
