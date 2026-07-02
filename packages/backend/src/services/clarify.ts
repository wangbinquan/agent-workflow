// Clarify business logic (RFC-023 PR-B).
//
// Sibling of services/review.ts: this module owns the clarify feature's state
// transitions outside the scheduler / runner / REST layer. The split mirrors
// how review works so anyone familiar with that path can read this one too.
//
//   - createClarifySession: invoked by runner.ts when an agent reply parsed
//     as a <workflow-clarify> envelope. Mints a clarify_sessions row +
//     clarify-node node_run row (one per shard for agent-multi), parks them
//     in 'awaiting_human', broadcasts clarify.created on /ws/tasks/.
//   - submitClarifyAnswers: REST decision handler. Validates the
//     optimistic-lock guard (ifMatchIteration), seals selectedOptionLabels
//     from server-side question.options (defends against client forgery),
//     marks the session 'answered', closes the clarify node_run, then calls
//     triggerAgentRerunFromClarify.
//   - triggerAgentRerunFromClarify: rolls back to the source agent's
//     pre_snapshot, mints a fresh node_runs row at clarifyIteration + 1 with
//     retry_index reset to 0 (shard_key + parent_node_run_id passthrough).
//     Caller is expected to call resumeTask after this returns.
//   - buildClarifyPromptContext: builds the ClarifyPromptContext for the
//     scheduler before runNode.
//   - listClarifySummaries / countPending / getClarifyDetail: REST reads.
//   - cleanupSessionsForTask: invoked from task delete path.
//
// Source-of-truth contracts:
//   - clarify_iteration counts ASK-then-ANSWER rounds, orthogonal to
//     reviewIteration (review) and retryIndex (process retries). A shard
//     child's clarify_iteration tracks that shard alone.
//   - selectedOptionLabels is always reconstituted server-side from
//     selectedOptionIndices + question.options; clients can post anything
//     and it gets overwritten before persistence.
//   - The exclusive-or contract between <workflow-output> and <workflow-clarify>
//     is enforced in services/runner.ts via services/envelope.detectEnvelopeKind.
//     This module assumes the envelope it receives is already validated as
//     clarify-only.

import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  ClarifyAnswerSchema,
  ClarifyEnvelopeBodySchema,
  ClarifyQuestionSchema,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
  type ClarifySession,
  type ClarifySessionStatus,
  type ClarifySessionSummary,
  type ClarifyTruncationWarning,
  type ClarifyNode,
  type WorkflowDefinition,
  type WorkflowNode,
  findClarifyNodeForAgent,
  mergeSealedAnswers,
  resolveClarifySessionMode,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import {
  clarifyRounds,
  clarifySessions,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import {
  hasOpenDispatchedEntryOnHome,
  roundHasDispatchedSelfQuestioner,
} from '@/services/clarifyRerunLedger'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'
import { transitionNodeRunStatus } from '@/services/lifecycle'
import { buildMintNodeRunValues, mintNodeRun } from '@/services/nodeRunMint'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { loadRollbackTarget, rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import { getTaskQuestionWriteSem, getTaskWriteSem } from '@/services/taskWriteLocks'
import { createLogger } from '@/util/log'
import { buildFrozenAttributionSet } from '@/services/clarifyRounds'
import { loadSealedQuestionIds, reconcileRoundEntriesTx } from '@/services/taskQuestions'
import { setNodeClarifyDirective } from '@/services/taskClarifyDirective'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('clarify')

// ---------------------------------------------------------------------------
// createClarifySession — runner-side entry point.
// ---------------------------------------------------------------------------

export interface CreateClarifySessionArgs {
  db: DbClient
  taskId: string
  /** Workflow node id of the asking agent. */
  sourceAgentNodeId: string
  /**
   * node_runs.id of the asking agent's run. For agent-multi this is the
   * shard child node_run id (one session per shard). For agent-single it is
   * the single asking node_run id.
   */
  sourceAgentNodeRunId: string
  /** Shard key when source is an agent-multi shard child; null otherwise. */
  sourceShardKey: string | null
  /** Workflow node id of the clarify node wired to this agent. */
  clarifyNodeId: string
  /** Matches the asking node_run's clarifyIteration at ask-time. */
  iterationIndex: number
  /** Parsed questions from <workflow-clarify>; pre-validated by parseClarifyEnvelopeBody. */
  questions: ClarifyQuestion[]
  /** Non-fatal warnings from parseClarifyEnvelopeBody (option/question truncations). */
  truncationWarnings?: ClarifyTruncationWarning[]
  /**
   * Parent node_run id passthrough for agent-multi shard cases: when the
   * asking node_run is itself a fan-out shard child, the clarify node_run we
   * mint here inherits the parent (the agent-multi fan-out parent) so the
   * task detail view can group by it.
   */
  parentNodeRunId?: string | null
  /** Defaults to Date.now(). Override for deterministic tests. */
  now?: () => number
}

export interface CreateClarifySessionResult {
  session: ClarifySession
  /** node_runs.id of the clarify node instance that owns this session. */
  clarifyNodeRunId: string
}

/**
 * Create a clarify_sessions row + the clarify-node node_run that owns it. The
 * clarify node_run is keyed by (clarify_node_id, source_shard_key) for
 * agent-multi so each shard parks independently; agent-single keys on
 * (clarify_node_id, NULL).
 *
 * Idempotent: if a same-shard awaiting_human row already exists for this
 * (clarify_node_id, source_shard_key) at this iterationIndex, we update
 * questions_json in place rather than minting a duplicate. This is purely
 * defensive — in production each call should land a fresh session.
 */
export async function createClarifySession(
  args: CreateClarifySessionArgs,
): Promise<CreateClarifySessionResult> {
  const {
    db,
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    iterationIndex,
    questions,
    truncationWarnings,
    parentNodeRunId,
  } = args
  const now = args.now ?? Date.now

  // Defensive validation: callers are expected to have already run
  // parseClarifyEnvelopeBody, but a stray code path could land here with
  // raw shapes. Re-validate via the same schema so the DB row is always
  // round-trip-safe.
  const validated = ClarifyEnvelopeBodySchema.parse({ questions })

  const existingClarifyRun = await findClarifyNodeRunForShard(
    db,
    taskId,
    clarifyNodeId,
    sourceShardKey,
    iterationIndex,
  )
  let clarifyNodeRunId: string
  if (existingClarifyRun) {
    clarifyNodeRunId = existingClarifyRun.id
    if (existingClarifyRun.status !== 'awaiting_human') {
      // RFC-053: park-human enforces pending|running → awaiting_human.
      await transitionNodeRunStatus({
        db,
        nodeRunId: clarifyNodeRunId,
        event: { kind: 'park-human' },
        extra: { startedAt: existingClarifyRun.startedAt ?? now() },
      })
    }
  } else {
    // RFC-074 PR-C: the clarify node_run no longer carries a clarifyIteration
    // counter — freshness is pure id-order and the round index lives on the
    // clarify_sessions / clarify_rounds rows (iterationIndex), not here.
    clarifyNodeRunId = await mintNodeRun(db, {
      taskId,
      nodeId: clarifyNodeId,
      status: 'awaiting_human',
      cause: 'clarify-park',
      iteration: 0,
      overrides: {
        parentNodeRunId: parentNodeRunId ?? null,
        shardKey: sourceShardKey,
        startedAt: now(),
      },
    })
  }

  const sessionId = ulid()
  const createdAt = now()
  const questionsJson = JSON.stringify(validated.questions)
  const truncationWarningsJson =
    truncationWarnings && truncationWarnings.length > 0 ? JSON.stringify(truncationWarnings) : null
  await db.insert(clarifySessions).values({
    id: sessionId,
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    clarifyNodeRunId,
    iterationIndex,
    questionsJson,
    answersJson: null,
    status: 'awaiting_human',
    truncationWarningsJson,
    createdAt,
    answeredAt: null,
    answeredBy: null,
  })

  // RFC-058 T12 — dual-write to clarify_rounds so the unified service
  // (services/clarifyRounds.ts) sees every new self-clarify round. The
  // legacy clarify_sessions row above is still authoritative for reads;
  // T17 drops the legacy table once all readers migrate. Schema mapping
  // mirrors migration 0031's INSERT FROM clauses verbatim.
  await db.insert(clarifyRounds).values({
    id: sessionId,
    taskId,
    kind: 'self',
    askingNodeId: sourceAgentNodeId,
    askingNodeRunId: sourceAgentNodeRunId,
    askingShardKey: sourceShardKey,
    intermediaryNodeId: clarifyNodeId,
    intermediaryNodeRunId: clarifyNodeRunId,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: iterationIndex,
    questionsJson,
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    truncationWarningsJson,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
  })

  const session: ClarifySession = {
    id: sessionId,
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId,
    sourceShardKey,
    clarifyNodeId,
    clarifyNodeRunId,
    iterationIndex,
    questions: validated.questions,
    status: 'awaiting_human',
    createdAt,
    answeredAt: null,
    answeredBy: null,
    // Directive is captured at submit time; awaiting_human sessions don't
    // have one yet. NULL surfaces as 'continue' to readers that need a
    // concrete value (see buildClarifyPromptContext).
    directive: null,
  }
  if (truncationWarnings && truncationWarnings.length > 0) {
    session.truncationWarnings = truncationWarnings
  }

  // RFC-037: fetch tasks.name once so the WS summary carries the joined
  // display name. Missing task (hard delete race) degrades to empty string;
  // the schema accepts any string and the frontend has its own fallback.
  const taskNameRow = await db
    .select({ name: tasks.name })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const taskName = taskNameRow[0]?.name ?? ''

  // RFC-037 follow-up: resolve clarify node title from the snapshot once so
  // the WS create-event summary carries it; otherwise subscribers re-fetch
  // the list to learn the title. Failure / missing title leaves null.
  const titlesByTaskAndNode = await loadNodeTitlesByTask(db, [taskId])
  const resolvedClarifyTitle = titlesByTaskAndNode.get(taskId)?.get(clarifyNodeId)
  if (typeof resolvedClarifyTitle === 'string' && resolvedClarifyTitle.length > 0) {
    session.clarifyNodeTitle = resolvedClarifyTitle
  }

  broadcastClarifyCreated(taskId, taskName, session)
  return { session, clarifyNodeRunId }
}

// ---------------------------------------------------------------------------
// submitClarifyAnswers — REST decision handler.
// ---------------------------------------------------------------------------

export interface SubmitClarifyAnswersArgs {
  db: DbClient
  /** node_runs.id of the clarify node (NOT of the source agent). */
  clarifyNodeRunId: string
  answers: ClarifyAnswer[]
  /** Optimistic-lock guard. When provided, must equal session.iterationIndex. */
  ifMatchIteration?: number
  /** Defaults to 'local'. Reserved for future per-user attribution. */
  answeredBy?: string
  /** RFC-099 (D7/D8) — task-relationship role of the submitter. When set,
   *  the clarify_rounds dual-write freezes per-question attribution
   *  (draft editors kept where the value matches) and records the
   *  submitter's role. UI/audit only — never enters prompts. */
  submittedByRole?: 'owner' | 'user' | 'admin'
  /** RFC-023 directive: 'continue' (default) keeps the legacy ask-channel
   *  behaviour for the asking agent's next rerun; 'stop' instructs the runner
   *  to (1) inject a "user wants no more clarifications" sentence into the
   *  next-round prompt and (2) suppress the <workflow-clarify> protocol
   *  block for that single rerun only. */
  directive?: ClarifyDirective
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface SubmitClarifyAnswersResult {
  session: ClarifySession
  /** Newly minted source-agent node_run id (clarifyIteration + 1, retry_index = 0). */
  rerunNodeRunId: string
}

/**
 * Persist user answers for a clarify session, mark the clarify node_run
 * done, mint a fresh source-agent node_run, and broadcast clarify.answered.
 *
 * The caller (REST route) is responsible for invoking resumeTask after this
 * returns so the scheduler picks the rerun node_run up.
 *
 * Throws:
 *   - NotFoundError('clarify-session-not-found') when no row matches.
 *   - ConflictError('clarify-already-answered') when status !== awaiting_human.
 *   - ConflictError('clarify-iteration-mismatch') when ifMatchIteration set
 *     and doesn't match the persisted iterationIndex (412 semantics).
 *   - ValidationError when answers reference unknown questionIds or out-of-range
 *     option indices.
 */
export async function submitClarifyAnswers(
  args: SubmitClarifyAnswersArgs,
): Promise<SubmitClarifyAnswersResult> {
  const { db, clarifyNodeRunId, ifMatchIteration } = args
  const now = args.now ?? Date.now
  const answeredBy = args.answeredBy ?? 'local'
  const directive: ClarifyDirective = args.directive ?? 'continue'

  const sessionRows = await db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    .orderBy(desc(clarifySessions.createdAt))
    .limit(1)
  const sessionRow = sessionRows[0]
  if (sessionRow === undefined) {
    throw new NotFoundError(
      'clarify-session-not-found',
      `no clarify_session for clarify node_run ${clarifyNodeRunId}`,
    )
  }
  if (sessionRow.status !== 'awaiting_human') {
    throw new ConflictError(
      'clarify-already-answered',
      `clarify_session ${sessionRow.id} status is ${sessionRow.status}, expected awaiting_human`,
    )
  }
  if (ifMatchIteration !== undefined && ifMatchIteration !== sessionRow.iterationIndex) {
    throw new ConflictError(
      'clarify-iteration-mismatch',
      `If-Match iteration ${ifMatchIteration} does not match server iteration ${sessionRow.iterationIndex}`,
    )
  }
  // RFC-128 P5-BC §5.2.14 mixed-path step 1 — submit-side dispatch-mode guard (EARLY fail-fast,
  // before any side effect). Once a round has ANY dispatched self/questioner entry it is PERMANENTLY
  // excluded from the whole-round render path (selectAnsweredRoundsForConsumer →
  // roundsWithDispatchedEntries), so a quick whole-round finalize would mint a continuation that
  // renders NOTHING for it → the un-dispatched answers are DROPPED (data-loss) and a second rerun
  // double-mints. Reject ANY dispatched (in-flight OR consumed) — the user finishes such a round via
  // the control channel. The race-tight recheck is repeated SYNCHRONOUSLY inside the dbTxSync below
  // (atomic with the mint); this early check just avoids the rollback/mint work on the common
  // sequential path. No dispatched entry ⇒ no-op (golden-lock: non-deferred tasks never dispatch).
  if (await roundHasDispatchedSelfQuestioner(db, clarifyNodeRunId)) {
    throw new ConflictError(
      'clarify-quick-finalize-round-dispatched',
      `cannot quick-finalize clarify round ${clarifyNodeRunId}: it has a dispatched self/questioner entry (the round is in control-channel dispatch mode). Finish the remaining questions via the control channel (seal + dispatch), not the quick whole-round finalize.`,
    )
  }

  const questions = JSON.parse(sessionRow.questionsJson) as ClarifyQuestion[]
  const sealedSubset = sealAnswersServerSide(questions, args.answers)
  const answeredAt = now()
  // RFC-128 §7 per-question merge-write + §5.2.14 finding 2: lockedIds + the answer MERGE are computed
  // INSIDE the question-write lock B below (re-reading the round's CURRENT answers_json + sealed set),
  // NOT here — else a concurrent control-channel seal (sealRoundQuestions, now also under B) committing
  // a locked answer after a pre-lock read would be OVERWRITTEN by this submit's stale whole-round
  // answers_json (data loss, breaks the P2-2 locked-answer guarantee). `sealedAnswers` is hoisted for
  // the post-lock sealedSession return; the merge result fills it under B. (Golden-lock: no prior seal
  // ⇒ lockedIds empty ⇒ merge-into-current == overwrite, byte-for-byte the old behavior.)
  let sealedAnswers: ClarifyAnswer[] = []

  // RFC-076 PR-0 (T0) + T0-extend — torn-read write-ordering. Resuming a clarify
  // is several writes for ONE logical event: (1) mint the source-agent rerun,
  // (2) flip clarify_session + clarify_rounds → answered, (3) flip the clarify
  // node_run → done. A reader — a concurrent runScope tick; under the RFC-076
  // race loop the user can answer branch A's clarify while sibling branch B is
  // still in flight, so the next tick re-reads node_runs mid-sequence — must
  // never see a state that lets the frontier FALSELY COMPLETE the asking agent
  // and run its downstream on a clarify-only / empty output.
  //
  // The asking agent's OWN run is `done` (the runner marks it so when it emits
  // <workflow-clarify>). Two independent facts keep it parked: the OPEN session
  // (deriveFrontier's askingRunIds, sourced from clarify_session.status =
  // awaiting_human) and — once minted — the pending rerun (which makes its prior
  // `done` row no longer the latest). The invariant is therefore: NEVER (session
  // answered ∧ rerun absent). So mint the rerun FIRST, flip the session SECOND,
  // flip the clarify node LAST; every intermediate state keeps the agent
  // protected by one or the other (the old order flipped the session — and, pre
  // PR-0, the clarify node — before the rerun, opening the gap across the
  // rollbackToSnapshot git-subprocess yield below). The rerun's fields come
  // entirely from `sourceRunRow` (incl. its ORIGINAL preSnapshot, independent of
  // the rollback), so the reorder is data-safe.
  //
  // RFC-128 P5-BC §5.2.14 — phases (1)+(2) [mint → flip session → flip round] now run in ONE
  // synchronous dbTxSync (below) instead of separate ordered awaits. A naive `db.transaction(async
  // …)` would NOT help (bun:sqlite commits at the first real `await`), but dbTxSync enforces a
  // SYNCHRONOUS body, so the mint+flips are atomic — strengthening the invariant (no visible window
  // at all) AND making the submit mutually atomic with dispatchTaskQuestions's dbTxSync (closes the
  // mixed-path double-mint race). Phase (3) [close clarify node] stays an async await AFTER the tx
  // (node_run status transitions must go through the lifecycle CAS — s14 forbids direct writes), and
  // since the rerun is already committed, the close still satisfies "never (clarify done ∧ rerun
  // absent)".

  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, sessionRow.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${sessionRow.taskId} not found`)
  }
  const sourceRunRow = (
    await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.id, sessionRow.sourceAgentNodeRunId))
      .limit(1)
  )[0]
  if (sourceRunRow === undefined) {
    throw new NotFoundError(
      'clarify-source-run-not-found',
      `source agent node_run ${sessionRow.sourceAgentNodeRunId} not found`,
    )
  }

  // RFC-026: in inline session mode, skip the worktree rollback. The agent
  // is about to resume its prior opencode session, which holds tool-call
  // history mentioning the worktree state it left behind. Rolling files
  // back to pre_snapshot now would desynchronise the agent's "I just
  // touched / read file X" memory from the actual filesystem and produce
  // confusing failures. RFC-023 protocol forbids agents from writing
  // during a clarify round anyway, so this is usually a no-op — but we
  // err on the safe side and let the session's view of the worktree stay
  // authoritative. See proposal §8 + design §8.
  const clarifyNodeForRerun = resolveClarifyNodeFromTaskSnapshot(
    taskRow.workflowSnapshot,
    sessionRow.clarifyNodeId,
  )
  const sessionModeForRerun = clarifyNodeForRerun
    ? resolveClarifySessionMode(clarifyNodeForRerun)
    : 'isolated'
  // RFC-098 B1 (audit S-9 / ⑥-10) + RFC-128 §5.2.14 finding 1: the rollback takes the task's WRITE
  // LOCK (getTaskWriteSem) so a mid-run answer can never reset/clean the worktree under an in-flight
  // writer. The rollback now runs INSIDE the widened sem below (after the durable session claim), NOT
  // here — see the claim-before-rollback block. (Finding 1: a destructive rollback BEFORE the claim
  // let a concurrent loser reset the worktree after the winner's continuation had already started.)

  // RFC-128 P5-BC §5.2.14 mixed-path step 3 — RFC-076 critical section, now ATOMIC. The original
  // sequence (mint rerun → flip session → flip clarify_round → close clarify node) was several
  // SEPARATE awaits; a concurrent dispatchTaskQuestions (its own synchronous dbTxSync) could commit
  // its stamp+mint in the window between this submit's dispatch-mode precheck and its mint → a
  // SECOND rerun on the same home (double-mint, Codex finding 2). bun:sqlite is single-threaded and
  // dbTxSync runs a SYNCHRONOUS body that never yields, so wrapping {dispatch-mode recheck → mint →
  // consume → flip session → flip round} in ONE dbTxSync makes it mutually atomic with dispatch's
  // dbTxSync: a dispatch either committed BEFORE (this recheck sees it → reject) or commits AFTER
  // (its own in-tx immediate-ledger recheck sees this minted continuation → reject). The clarify
  // node CLOSE stays AFTER the tx (RFC-076's LAST step) because a node_run status transition must go
  // through transitionNodeRunStatus (async lifecycle CAS; direct status writes are s14-forbidden);
  // "close after" preserves the invariant — the rerun is committed (in-tx) before the clarify node
  // is `done`, so no reader observes done-without-rerun. RFC-076 ordering UNCHANGED (mint →
  // session/round write → close); only the first two phases collapse from async-ordered into one
  // synchronous atomic tx.

  // (1) Mint VALUES first (T0). buildMintNodeRunValues is the SAME factory mintNodeRun uses (zero
  // cause/inheritance drift); the insert runs INSIDE the tx (synchronous, atomic with the flips).
  // retryIndex resets to 0; cause='clarify-answer' flips the scheduler's gate-2 (isClarifyRerun).
  // RFC-074 PR-C: no clarifyIteration bump — this fresh insert is the latest id, so isFresherNodeRun
  // picks it over the prior done row automatically.
  const rerunValues = buildMintNodeRunValues({
    taskId: sessionRow.taskId,
    nodeId: sourceRunRow.nodeId,
    status: 'pending',
    cause: 'clarify-answer',
    iteration: sourceRunRow.iteration,
    inheritFrom: sourceRunRow,
    overrides: { startedAt: null },
  })
  const rerunNodeRunId = rerunValues.id

  // RFC-058 dual-write: the clarify_round row mirrors this session (id == session id). Loaded for
  // the §5.2.14 finding-3 in-tx reconcile (materialize the round's self entries so a later lazy
  // reconcile can't recreate them OPEN + dispatchable on this superseded round).
  const roundRow = (
    await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, sessionRow.id)).limit(1)
  )[0]

  // RFC-128 §5.2.14 (final-gate, user-authorized) — the per-task QUESTION-WRITE lock B
  // (getTaskQuestionWriteSem) wraps the WHOLE critical section {durable claim → precheck → rollback →
  // mint/flip tx}, claiming the session BEFORE any worktree side effect. B serializes this submit
  // against dispatchTaskQuestions + the other submit path, so a deferred dispatch can NEVER commit
  // (stamp + mint) in the precheck↔rollback window (review-9 stale-precheck race), and two concurrent
  // submits serialize (the loser's claim sees 'answered' → rejects before its rollback). The rollback
  // stays BEFORE the mint (the rerun must not exist when the worktree resets); the mint/flip are
  // atomic in the inner dbTxSync.
  //
  // Worktree-lock A coupling (3rd-gate findings P2 + review-11/12): the long worktree write lock A
  // (getTaskWriteSem, held by scheduler writers for an ENTIRE agent run, RFC-098 B1) is needed ONLY
  // when a rollback actually runs. So when `needsRollback`, acquire A *OUTER* (BEFORE B) — the A-wait
  // happens while B is NOT held, so a B-waiting dispatch is never blocked behind an agent run; once A
  // is held, B is acquired for the short critical section. When NO rollback runs, A is NOT acquired at
  // all → these submits never queue behind a writer. Lock order A ≻ B (only in the rollback branch);
  // dispatch + cross-submit + no-rollback-submit take B only; scheduler writers take A only; NO
  // A-holder ever acquires B (submit*/dispatch are HTTP-route-only, never under the scheduler's A) →
  // no A→B/B→A cycle → deadlock-free. See taskWriteLocks.ts.
  const needsRollback =
    sessionModeForRerun !== 'inline' &&
    (sourceRunRow.preSnapshot !== null || sourceRunRow.preSnapshotReposJson !== null) &&
    taskRow.worktreePath !== ''
  const runUnderQuestionLock = (): Promise<void> =>
    getTaskQuestionWriteSem(taskRow.id).run(async () => {
      const claimRow = (
        await db
          .select({ status: clarifySessions.status, answersJson: clarifySessions.answersJson })
          .from(clarifySessions)
          .where(eq(clarifySessions.id, sessionRow.id))
          .limit(1)
      )[0]
      if (claimRow?.status !== 'awaiting_human') {
        throw new ConflictError(
          'clarify-already-answered',
          `clarify_session ${sessionRow.id} was answered concurrently (lost the submit claim before rollback)`,
        )
      }
      // §5.2.14 finding 2: merge the answers UNDER the lock, from the round's CURRENT answers_json
      // (claimRow, re-read just now) + the CURRENT sealed set — so a concurrent control-channel seal
      // (also under B) is observed and its locked answer is preserved (P2-2), never overwritten by a
      // stale pre-lock merge.
      const lockedIds = await loadSealedQuestionIds(db, clarifyNodeRunId)
      sealedAnswers = mergeSealedAnswers(
        parseAnswersArray(claimRow.answersJson),
        sealedSubset,
        lockedIds,
      )
      const answersJson = JSON.stringify(sealedAnswers)
      // RFC-058 T12 dual-write attribution (under the lock, from the freshly-merged answers).
      const attributionSet =
        args.submittedByRole !== undefined
          ? await buildFrozenAttributionSet(db, sessionRow.id, sealedAnswers, {
              userId: answeredBy,
              role: args.submittedByRole,
            })
          : {}
      // §5.2.14 PRE-ROLLBACK guards (under the question-write lock, BEFORE the destructive rollback) —
      // mirror the in-tx rejection checks so a conflict rejects WITHOUT first resetting the worktree
      // (which would clobber a concurrent dispatched rerun). A dispatch that won during the A-wait is
      // already committed + visible here (we re-read after acquiring both locks).
      //
      // (P1, 3rd-gate) finding-3 ANY-dispatched ROUND guard (incl. CONSUMED): once THIS round has any
      // dispatched self/q entry it is permanently excluded from the whole-round render path → a quick
      // finalize would drop answers. roundHasDispatchedSelfQuestioner catches consumed-too (the
      // home-only OPEN check below does not), so it must run BEFORE the rollback.
      if (await roundHasDispatchedSelfQuestioner(db, clarifyNodeRunId)) {
        throw new ConflictError(
          'clarify-quick-finalize-round-dispatched',
          `cannot quick-finalize clarify round ${clarifyNodeRunId}: a control-channel dispatch claimed it (round in dispatch mode) — rejecting before rollback`,
        )
      }
      // (P2, 3rd-gate) reciprocal ALL-ROLE open-ledger guard: an OPEN dispatched entry of ANY deferred
      // role (self/questioner/designer) whose home == this home → another open rerun ledger on this
      // node. Reject before rollback (mirrors assertNoInFlightDispatch's any-role span).
      const dispatchedPre = await db
        .select({
          triggerRunId: taskQuestions.triggerRunId,
          defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
          overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
          roleKind: taskQuestions.roleKind,
        })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.taskId, sessionRow.taskId),
            inArray(taskQuestions.roleKind, ['self', 'questioner', 'designer']),
            isNotNull(taskQuestions.dispatchedAt),
          ),
        )
      if (dispatchedPre.length > 0) {
        const preRuns = await db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, sessionRow.taskId))
        const preOutputIds = new Set(
          (
            await db
              .select({ id: nodeRunOutputs.nodeRunId })
              .from(nodeRunOutputs)
              .where(
                inArray(
                  nodeRunOutputs.nodeRunId,
                  preRuns.map((r) => r.id),
                ),
              )
          ).map((r) => r.id),
        )
        if (
          // RFC-133: the quick-finalize mints a 'clarify-answer' continuation on this home.
          hasOpenDispatchedEntryOnHome(
            sourceRunRow.nodeId,
            dispatchedPre,
            preRuns,
            preOutputIds,
            'clarify-answer',
          )
        ) {
          throw new ConflictError(
            'clarify-quick-finalize-rerun-in-flight',
            `node '${sourceRunRow.nodeId}' already has an OPEN dispatched rerun ledger (a concurrent dispatch won) — rejecting before rollback`,
          )
        }
      }
      // Rollback (AFTER the claim/prechecks). Runs ONLY when `needsRollback` — and in that case the
      // worktree lock A is already held OUTER (acquired before this question lock, below), so the reset
      // is serialized vs in-flight writer nodes (RFC-098 B1) without holding B while waiting for A.
      // Best-effort: a rollback failure logs + proceeds (RFC-098 semantics).
      if (needsRollback) {
        const target = await loadRollbackTarget(db, taskRow.id)
        if (target !== null) {
          try {
            await rollbackNodeRunWorktrees(
              target,
              sourceRunRow,
              { resetOnEmptySnapshot: false },
              log,
            )
          } catch (err) {
            log.warn('clarify rollback failed', {
              nodeRunId: sourceRunRow.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      dbTxSync(db, (tx) => {
        // §5.2.14 finding 1 (double-submit double-mint): atomically CLAIM the session inside the tx. Two
        // concurrent submits both pass the pre-tx awaiting_human / If-Match read, then serialize into
        // their (synchronous) txs; without this re-check the second still mints a SECOND rerun + rewrites
        // the answered session/round (the later async close failing is too late — the rerun is already
        // persisted). The first tx commits status='answered'; the second's reselect here sees 'answered'
        // → reject (nothing minted). bun:sqlite single-thread + dbTxSync sync body ⇒ the two txs cannot
        // interleave, so the loser always observes the winner's committed flip.
        const claim = tx
          .select({ status: clarifySessions.status })
          .from(clarifySessions)
          .where(eq(clarifySessions.id, sessionRow.id))
          .limit(1)
          .all()
        if (claim[0]?.status !== 'awaiting_human') {
          throw new ConflictError(
            'clarify-already-answered',
            `clarify_session ${sessionRow.id} was answered concurrently (lost the submit claim)`,
          )
        }
        // §5.2.14 step 1 (atomic, finding 2 race): re-check the round is NOT in control-channel dispatch
        // mode. A dispatch that committed since the early precheck is caught here BEFORE the mint; one
        // that commits later is caught by dispatch's own in-tx immediate-ledger recheck → no double-mint.
        const dispatched = tx
          .select({ id: taskQuestions.id })
          .from(taskQuestions)
          .where(
            and(
              eq(taskQuestions.originNodeRunId, clarifyNodeRunId),
              inArray(taskQuestions.roleKind, ['self', 'questioner']),
              isNotNull(taskQuestions.dispatchedAt),
            ),
          )
          .limit(1)
          .all()
        if (dispatched.length > 0) {
          throw new ConflictError(
            'clarify-quick-finalize-round-dispatched',
            `cannot quick-finalize clarify round ${clarifyNodeRunId}: a concurrent control-channel dispatch claimed it. Finish the remaining questions via the control channel.`,
          )
        }
        // §5.2.14 2nd-gate finding 2 (reciprocal in-flight check, PRECISE): a concurrent deferred
        // dispatch of ANOTHER round's self entry reassigned (RFC-127 借壳) to THIS home may have already
        // stamped it + minted a pending clarify-answer rerun on the home. The dispatch-mode recheck
        // above only sees THIS round's entries, so without this it would mint a SECOND clarify-answer
        // rerun on the same home. Keyed on an OPEN (unconsumed) DISPATCHED self entry whose home == this
        // home — NOT "any pending rerun" (a prior round's quick continuation has no dispatched entry, so
        // the legitimate sequential multi-round flow is not falsely rejected). taskId-scoped (node_id is
        // task-local). (Dispatch-first → caught here; submit-first → the dispatch's own in-tx
        // immediate-ledger gate sees this minted continuation → rejects.)
        const dispatchedHome = tx
          .select({
            triggerRunId: taskQuestions.triggerRunId,
            defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
            overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
            roleKind: taskQuestions.roleKind,
          })
          .from(taskQuestions)
          .where(
            and(
              eq(taskQuestions.taskId, sessionRow.taskId),
              inArray(taskQuestions.roleKind, ['self', 'questioner', 'designer']),
              isNotNull(taskQuestions.dispatchedAt),
            ),
          )
          .all()
        if (dispatchedHome.length > 0) {
          const txRuns = tx
            .select()
            .from(nodeRuns)
            .where(eq(nodeRuns.taskId, sessionRow.taskId))
            .all()
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
            // RFC-133: same 'clarify-answer' mint-cause as the async pre-check above.
            hasOpenDispatchedEntryOnHome(
              sourceRunRow.nodeId,
              dispatchedHome,
              txRuns,
              txOutputIds,
              'clarify-answer',
            )
          ) {
            throw new ConflictError(
              'clarify-quick-finalize-rerun-in-flight',
              `node '${sourceRunRow.nodeId}' already has an OPEN dispatched rerun ledger (a concurrent dispatch won) — not double-minting`,
            )
          }
        }
        // (1) Mint the rerun FIRST (T0). rfc098-allow-direct-node-run-insert: values come from the mint
        // factory, and the insert MUST be synchronous to commit atomically with the flips below (an
        // async mintNodeRun would yield + commit early, reopening the race).
        tx.insert(nodeRuns).values(rerunValues).run()
        // §5.2.14 finding 3 (lazy-reconcile 复活): MATERIALIZE the round's self entries in-tx BEFORE the
        // consume. A virgin quick-finalize (question list never opened, no control seal) has 0
        // task_questions, so a consume of "existing rows" would confirm nothing; later listTaskQuestions
        // lazily reconciles OPEN self entries on this answered round → stage/dispatchable → re-mint an
        // already-answered round. reconcileRoundEntriesTx is idempotent and its onConflictDoUpdate never
        // touches `confirmation`, so (a) it creates the missing rows now and (b) the later lazy reconcile
        // preserves the `confirmed` stamp the consume sets below. Self rounds have NO designer entries,
        // so the answered-round designer cleanup inside reconcile is a no-op here. roundRow should always
        // exist (createClarifySession dual-writes it); guard defensively.
        if (roundRow !== undefined) {
          reconcileRoundEntriesTx(tx, { ...roundRow, status: 'answered', answersJson, directive })
        }
        // §5.2.14 step 2 (consume): the quick whole-round answer SUPERSEDES the ENTIRE round — every
        // question is now answered (in the whole-round answersJson, rendered by the minted continuation).
        // So confirm ALL of the round's OPEN, UNDISPATCHED self/questioner entries — NOT just the sealed
        // ones (Codex impl-gate finding A): a partial control-seal already reconciled a row for EVERY
        // question (reconcileDesiredEntries iterates all questions), so a sibling answered only via this
        // quick finalize (q2, sealed_at NULL) would otherwise stay `open` on an answered round and remain
        // dispatchable → a duplicate clarify-answer rerun for an already-rendered answer. (Any DISPATCHED
        // self/q entry is impossible here — the dispatch-mode recheck above already rejected the round.)
        // Mark them `confirmation='confirmed'` so the §18 park source (excludes confirmed) no longer
        // parks the home AND dispatch (also confirmation='open'-gated) cannot re-mint them. confirmed_by
        // is audit-only (RFC-099, never a prompt). 0 rows for a round with no self/q entries (golden-lock
        // — a virgin quick finalize that was never read/sealed has no task_questions yet).
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
              eq(taskQuestions.originNodeRunId, clarifyNodeRunId),
              inArray(taskQuestions.roleKind, ['self', 'questioner']),
              isNull(taskQuestions.dispatchedAt),
              eq(taskQuestions.confirmation, 'open'),
            ),
          )
          .run()
        // (2) Flip the session → answered SECOND — only now that the rerun exists, so no concurrent
        // frontier read observes "session answered ∧ rerun absent" (T0-extend).
        tx.update(clarifySessions)
          .set({ answersJson, status: 'answered', answeredAt, answeredBy, directive })
          .where(eq(clarifySessions.id, sessionRow.id))
          .run()
        // RFC-058 T12 dual-write — mirror the answered state + frozen attribution to clarify_rounds
        // (idempotent: row exists from createClarifySession's dual-write).
        tx.update(clarifyRounds)
          .set({
            answersJson,
            status: 'answered',
            answeredAt,
            answeredBy,
            directive,
            ...attributionSet,
          })
          .where(eq(clarifyRounds.id, sessionRow.id))
          .run()
      })
    })
  // §5.2.14 conditional A ≻ B: take the worktree lock A OUTER only when a rollback runs (so the
  // A-wait never holds B → no dispatch stall behind an agent run); otherwise B only (no A).
  if (needsRollback) await getTaskWriteSem(taskRow.id).run(runUnderQuestionLock)
  else await runUnderQuestionLock()

  // RFC-123: a 'stop' answer writes the per-(task, asking-node) clarify directive
  // (the canvas "继续/停止反问" toggle's single source of truth) so the toggle
  // reflects the choice AND the stop rides the same `nodeStopOverride` channel as
  // the toggle — durable across retry/review reruns, not just this clarify-answer
  // rerun. Only 'stop' writes (D1): 'continue' is the default and must not clobber a
  // deliberate prior toggle. `answeredBy` is the audit-only setter id (never a prompt).
  if (directive === 'stop') {
    await setNodeClarifyDirective(
      db,
      sessionRow.taskId,
      sessionRow.sourceAgentNodeId,
      'stop',
      answeredBy,
    )
  }

  // (3) Close the clarify node_run LAST. RFC-053: resume-clarify enforces
  // awaiting_human → done. By the time clarify is `done`, the rerun row above
  // already exists (T0 invariant), so no reader observes done-without-rerun.
  await transitionNodeRunStatus({
    db,
    nodeRunId: clarifyNodeRunId,
    event: { kind: 'resume-clarify' },
    extra: { finishedAt: answeredAt },
  })

  const sealedSession: ClarifySession = {
    id: sessionRow.id,
    taskId: sessionRow.taskId,
    sourceAgentNodeId: sessionRow.sourceAgentNodeId,
    sourceAgentNodeRunId: sessionRow.sourceAgentNodeRunId,
    sourceShardKey: sessionRow.sourceShardKey,
    clarifyNodeId: sessionRow.clarifyNodeId,
    clarifyNodeRunId: sessionRow.clarifyNodeRunId,
    iterationIndex: sessionRow.iterationIndex,
    questions,
    answers: sealedAnswers,
    status: 'answered',
    createdAt: sessionRow.createdAt,
    answeredAt,
    answeredBy,
    directive,
  }
  if (sessionRow.truncationWarningsJson) {
    try {
      sealedSession.truncationWarnings = JSON.parse(
        sessionRow.truncationWarningsJson,
      ) as ClarifyTruncationWarning[]
    } catch {
      /* ignore corrupt warnings JSON */
    }
  }

  broadcastClarifyAnswered(sessionRow.taskId, sealedSession, rerunNodeRunId)
  // RFC-041: enqueue a memory-distill job for this just-answered session so
  // the distiller can lift any reusable preference / decision out of the
  // Q&A. Best-effort — distill is async, a broken queue must not affect
  // the clarify decision return.
  await enqueueDistillJob(db, {
    sourceKind: 'clarify',
    sourceEventId: sessionRow.id,
    taskId: sessionRow.taskId,
  }).catch(() => {
    /* swallow */
  })
  return { session: sealedSession, rerunNodeRunId }
}

// ---------------------------------------------------------------------------
// READ-side helpers used by REST routes.
// ---------------------------------------------------------------------------

export interface ListClarifySummariesFilter {
  taskId?: string
  status?: ClarifySessionStatus | 'all'
  limit?: number
}

export async function listClarifySummaries(
  db: DbClient,
  filter: ListClarifySummariesFilter = {},
): Promise<ClarifySessionSummary[]> {
  const all = await db.select().from(clarifySessions).orderBy(desc(clarifySessions.createdAt))
  const desired = filter.status ?? 'awaiting_human'
  const filtered = all.filter((r) => {
    if (filter.taskId !== undefined && r.taskId !== filter.taskId) return false
    if (desired !== 'all' && r.status !== desired) return false
    return true
  })
  const limit = filter.limit ?? 100
  const sliced = filtered.slice(0, limit)

  // Look up each session's source-agent node display name from the task's
  // workflowSnapshot (mirrors the review summary path which already does
  // the same for review nodes). Lets the inbox render the user-set node
  // title instead of the opaque agent node id. Snapshot read errors or
  // missing nodes degrade to `null` so the frontend keeps the existing
  // fallback to `sourceAgentNodeId`.
  const taskIds = Array.from(new Set(sliced.map((r) => r.taskId)))
  const titleByTaskAndNode = await loadNodeTitlesByTask(db, taskIds)
  const taskNameByTaskId = await loadTaskNamesByTaskId(db, taskIds)

  return sliced.map((row) => {
    const summary = rowToSummary(row, taskNameByTaskId.get(row.taskId) ?? '')
    const titles = titleByTaskAndNode.get(row.taskId)
    const srcTitle = titles?.get(row.sourceAgentNodeId)
    summary.sourceAgentNodeTitle =
      typeof srcTitle === 'string' && srcTitle.length > 0 ? srcTitle : null
    const clarTitle = titles?.get(row.clarifyNodeId)
    summary.clarifyNodeTitle =
      typeof clarTitle === 'string' && clarTitle.length > 0 ? clarTitle : null
    return summary
  })
}

/**
 * RFC-037: bulk-fetch `tasks.name` for the given taskIds. Returns a map
 * keyed by taskId. Missing rows (task hard-deleted) surface as absent — the
 * caller falls back to empty string so the schema-required `taskName` field
 * still parses. Mirrors loadAgentNodeTitlesByTask in shape so future joins
 * can be batched.
 */
async function loadTaskNamesByTaskId(
  db: DbClient,
  taskIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out
  const taskRows = await db.select().from(tasks)
  const wanted = new Set(taskIds)
  for (const t of taskRows) {
    if (!wanted.has(t.id)) continue
    out.set(t.id, t.name)
  }
  return out
}

/**
 * Bulk-fetch the `tasks.workflowSnapshot` rows for `taskIds` and extract
 * each non-empty node title into a nested map `taskId → nodeId → title`.
 * Both source-agent and clarify nodes are indexed so the inbox can render
 * `sourceAgentNodeTitle` AND `clarifyNodeTitle` (RFC-037 follow-up: clarify
 * surface aligned with the review side, which uses node titles with nodeId
 * fallback). Pure read; corrupt snapshots or missing tasks degrade to empty.
 */
async function loadNodeTitlesByTask(
  db: DbClient,
  taskIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>()
  if (taskIds.length === 0) return out
  const taskRows = await db.select().from(tasks)
  const wanted = new Set(taskIds)
  for (const t of taskRows) {
    if (!wanted.has(t.id)) continue
    const inner = new Map<string, string>()
    try {
      const def = JSON.parse(t.workflowSnapshot) as WorkflowDefinition
      for (const node of def.nodes ?? []) {
        const rec = node as Record<string, unknown>
        // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
        if (rec.kind !== 'agent-single' && rec.kind !== 'clarify') continue
        const title = typeof rec.title === 'string' ? rec.title.trim() : ''
        if (title.length === 0) continue
        inner.set(node.id, title)
      }
    } catch {
      // corrupt snapshot — leave inner empty; callers fall back to nodeId.
    }
    out.set(t.id, inner)
  }
  return out
}

export async function countPendingClarifications(db: DbClient): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(clarifySessions)
    .where(eq(clarifySessions.status, 'awaiting_human'))
  return rows[0]?.n ?? 0
}

export async function getClarifyDetail(
  db: DbClient,
  clarifyNodeRunId: string,
): Promise<ClarifySession> {
  const rows = await db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    .orderBy(desc(clarifySessions.createdAt))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError(
      'clarify-session-not-found',
      `no clarify_session for clarify node_run ${clarifyNodeRunId}`,
    )
  }
  const session = rowToSession(row)
  // RFC-037 follow-up: resolve the clarify node's `WorkflowNode.title` from
  // the task snapshot so the detail page can render "任务名 / 节点标题"
  // mirroring the review side. Failure to resolve degrades to null and the
  // frontend keeps the existing fallback to `clarifyNodeId`.
  const titlesByTaskAndNode = await loadNodeTitlesByTask(db, [row.taskId])
  const clarTitle = titlesByTaskAndNode.get(row.taskId)?.get(row.clarifyNodeId)
  if (typeof clarTitle === 'string' && clarTitle.length > 0) {
    session.clarifyNodeTitle = clarTitle
  } else {
    session.clarifyNodeTitle = null
  }
  return session
}

// ---------------------------------------------------------------------------
// cleanupSessionsForTask — task delete path.
// ---------------------------------------------------------------------------

/**
 * Delete every clarify_session belonging to a task. Called from the task
 * delete path BEFORE the task row is dropped (cascade would also handle it,
 * but explicit deletion keeps the WS broadcast surface clean if we ever add
 * a clarify.canceled event).
 */
export async function cleanupSessionsForTask(db: DbClient, taskId: string): Promise<void> {
  await db.delete(clarifySessions).where(eq(clarifySessions.taskId, taskId))
  // RFC-058 T12 dual-write — mirror cleanup on clarify_rounds so the unified
  // table doesn't accumulate orphaned rows after task delete.
  await db
    .delete(clarifyRounds)
    .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.kind, 'self')))
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

async function findClarifyNodeRunForShard(
  db: DbClient,
  taskId: string,
  clarifyNodeId: string,
  shardKey: string | null,
  iterationIndex: number,
): Promise<typeof nodeRuns.$inferSelect | undefined> {
  // RFC-074 PR-C: the clarify node_run no longer carries a clarifyIteration
  // counter, so this round's existing clarify run is located via the
  // clarify_sessions row that owns it — keyed by (clarifyNodeId,
  // sourceShardKey, iterationIndex), which still carries the round index. A
  // re-emit within the same round finds the prior session and reuses its node
  // run; a new round has no session yet and falls through to a fresh mint.
  const sessionRows = await db
    .select({ clarifyNodeRunId: clarifySessions.clarifyNodeRunId })
    .from(clarifySessions)
    .where(
      and(
        eq(clarifySessions.taskId, taskId),
        eq(clarifySessions.clarifyNodeId, clarifyNodeId),
        eq(clarifySessions.iterationIndex, iterationIndex),
        shardKey === null
          ? isNull(clarifySessions.sourceShardKey)
          : eq(clarifySessions.sourceShardKey, shardKey),
      ),
    )
    .orderBy(asc(clarifySessions.createdAt))
  const owningRunId = sessionRows[0]?.clarifyNodeRunId
  if (owningRunId === undefined) return undefined
  const runRows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, owningRunId)).limit(1)
  return runRows[0]
}

/** RFC-128 §7 — safe parse of a round's `answers_json` into a ClarifyAnswer[] for the
 *  per-question merge-write. Returns [] for NULL, malformed JSON, or a non-array payload
 *  (some fixtures seed a legacy '{}' placeholder; production seeds NULL). Keeping this
 *  tolerant means the merge boundary never throws on a virgin/legacy round (golden-lock:
 *  empty existing → merge returns the incoming subset unchanged). */
export function parseAnswersArray(json: string | null): ClarifyAnswer[] {
  if (json === null) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyAnswer[]) : []
  } catch {
    return []
  }
}

/**
 * Rebuild selectedOptionLabels from selectedOptionIndices + question.options.
 * Clients post both fields; only the indices are trusted. This defends
 * against clients trying to inject custom labels (e.g. for prompt injection
 * attacks) when the underlying question never offered that string.
 *
 * Additionally drops indices that point outside the question's options
 * array and drops answers whose questionId is unknown to the session
 * (silently — the agent's next-round prompt will simply not see them).
 *
 * RFC-128 §1/§7: this is a pure SUBSET sealer — it validates+normalises exactly the
 * answers passed in (whether the whole round or a single question) and returns them;
 * per-question merging into the round's `answers_json` is the caller's job (via
 * {@link mergeSealedAnswers}). A non-array payload throws `clarify-answers-not-array`
 * (runtime guard, kept). An EMPTY array is a no-op that returns `[]` (NOT an error —
 * the loop simply doesn't run); this is locked by rfc128-p0-whole-round-seal-net.
 */
export function sealAnswersServerSide(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
): ClarifyAnswer[] {
  if (!Array.isArray(answers)) {
    throw new ValidationError('clarify-answers-not-array', 'answers payload must be an array')
  }
  const byId = new Map(questions.map((q) => [q.id, q]))
  const sealed: ClarifyAnswer[] = []
  for (const ans of answers) {
    const parsed = ClarifyAnswerSchema.safeParse(ans)
    if (!parsed.success) {
      throw new ValidationError(
        'clarify-answer-malformed',
        `answer for question '${ans?.questionId}': ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      )
    }
    const a = parsed.data
    const q = byId.get(a.questionId)
    if (q === undefined) {
      // Unknown question id — defensive drop. We don't throw because a
      // future migration that adds id renames shouldn't break old drafts.
      log.warn('clarify answer references unknown question id', { questionId: a.questionId })
      continue
    }
    const indices = a.selectedOptionIndices.filter((i) => i >= 0 && i < q.options.length)
    const labels = indices.map((i) => q.options[i]?.label ?? '').filter((s) => s.length > 0)
    sealed.push({
      questionId: a.questionId,
      selectedOptionIndices: indices,
      selectedOptionLabels: labels,
      customText: a.customText,
    })
  }
  return sealed
}

function broadcastClarifyCreated(taskId: string, taskName: string, session: ClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify.created',
    nodeRunId: session.clarifyNodeRunId,
    clarifyNodeId: session.clarifyNodeId,
    sourceShardKey: session.sourceShardKey ?? null,
    iterationIndex: session.iterationIndex,
    session: sessionToSummary(session, taskName),
  })
}

function broadcastClarifyAnswered(
  taskId: string,
  session: ClarifySession,
  rerunNodeRunId: string,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify.answered',
    nodeRunId: session.clarifyNodeRunId,
    clarifyNodeId: session.clarifyNodeId,
    sourceShardKey: session.sourceShardKey ?? null,
    iterationIndex: session.iterationIndex,
    rerunNodeRunId,
    session,
  })
}

/**
 * RFC-128 P5-D — re-emit the legacy `clarify.answered` WS event for a (now-answered) SELF round so
 * OTHER clients invalidate clarify list/detail/pending-count + node-runs after a DEFERRED quick
 * answer (autoDispatchClarifyRound reuses the legacy quick path's notification, which it otherwise
 * bypasses). No-op unless the session exists AND is answered. `rerunNodeRunId` is the dispatched
 * self rerun (or '' when the auto-dispatch was deferred to manual — the invalidation still fires).
 */
export async function broadcastSelfClarifyAnsweredForRound(
  db: DbClient,
  clarifyNodeRunId: string,
  rerunNodeRunId: string,
): Promise<void> {
  const row = (
    await db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
      .orderBy(desc(clarifySessions.createdAt))
      .limit(1)
  )[0]
  if (row === undefined || row.status !== 'answered') return
  broadcastClarifyAnswered(row.taskId, rowToSession(row), rerunNodeRunId)
}

function rowToSession(row: typeof clarifySessions.$inferSelect): ClarifySession {
  const questions = JSON.parse(row.questionsJson) as ClarifyQuestion[]
  const out: ClarifySession = {
    id: row.id,
    taskId: row.taskId,
    sourceAgentNodeId: row.sourceAgentNodeId,
    sourceAgentNodeRunId: row.sourceAgentNodeRunId,
    sourceShardKey: row.sourceShardKey,
    clarifyNodeId: row.clarifyNodeId,
    clarifyNodeRunId: row.clarifyNodeRunId,
    iterationIndex: row.iterationIndex,
    questions,
    status: row.status as ClarifySessionStatus,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    answeredBy: row.answeredBy,
    // History views surface this; null until the user has submitted (or
    // pre-directive rows that predate the column).
    directive: row.directive === null ? null : (row.directive as ClarifyDirective),
  }
  if (row.answersJson !== null) {
    try {
      out.answers = JSON.parse(row.answersJson) as ClarifyAnswer[]
    } catch {
      /* ignore corrupt answers; surface as missing */
    }
  }
  if (row.truncationWarningsJson !== null) {
    try {
      out.truncationWarnings = JSON.parse(row.truncationWarningsJson) as ClarifyTruncationWarning[]
    } catch {
      /* ignore */
    }
  }
  return out
}

function rowToSummary(
  row: typeof clarifySessions.$inferSelect,
  taskName: string,
): ClarifySessionSummary {
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
    // RFC-037: required field; caller passes joined `tasks.name`.
    taskName,
    sourceAgentNodeId: row.sourceAgentNodeId,
    // Populated by listClarifySummaries (which has access to the task
    // snapshot); single-session paths leave this null and the frontend
    // falls back to `sourceAgentNodeId`.
    sourceAgentNodeTitle: null,
    sourceShardKey: row.sourceShardKey,
    clarifyNodeId: row.clarifyNodeId,
    // Same convention as sourceAgentNodeTitle — list path enriches from
    // snapshot, single-session paths leave null and the frontend falls
    // back to `clarifyNodeId`.
    clarifyNodeTitle: null,
    clarifyNodeRunId: row.clarifyNodeRunId,
    iterationIndex: row.iterationIndex,
    questionCount,
    status: row.status as ClarifySessionStatus,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

function sessionToSummary(session: ClarifySession, taskName: string): ClarifySessionSummary {
  return {
    id: session.id,
    taskId: session.taskId,
    // RFC-037: required field; caller resolves and passes `tasks.name`.
    taskName,
    sourceAgentNodeId: session.sourceAgentNodeId,
    sourceAgentNodeTitle: null,
    sourceShardKey: session.sourceShardKey ?? null,
    clarifyNodeId: session.clarifyNodeId,
    clarifyNodeTitle: session.clarifyNodeTitle ?? null,
    clarifyNodeRunId: session.clarifyNodeRunId,
    iterationIndex: session.iterationIndex,
    questionCount: session.questions.length,
    status: session.status,
    createdAt: session.createdAt,
    answeredAt: session.answeredAt ?? null,
  }
}

// ---------------------------------------------------------------------------
// definition-level helpers re-exported for runner.ts / scheduler.ts wiring.
// ---------------------------------------------------------------------------

/**
 * Find the clarify node wired to a given agent node by looking for an outbound
 * edge on the system port `__clarify__`. Returns undefined when the agent has
 * no clarify channel attached. Thin wrapper over shared/findClarifyNodeForAgent
 * so the backend can co-locate the lookup with its other clarify helpers.
 */
export function findClarifyNodeIdForAgent(
  definition: WorkflowDefinition,
  agentNodeId: string,
): string | undefined {
  return findClarifyNodeForAgent(definition, agentNodeId)
}

/** Returns the workflow node object for a clarify id, when present. */
export function findClarifyNode(
  definition: WorkflowDefinition,
  clarifyNodeId: string,
): WorkflowNode | undefined {
  return definition.nodes.find((n) => n.id === clarifyNodeId && n.kind === 'clarify')
}

/**
 * RFC-026: parse a task's stored workflowSnapshot JSON and pull out the clarify
 * node by id. Returns undefined when the snapshot is malformed or the id isn't
 * present (e.g. workflow was edited after task launch and the snapshot is
 * stale in a way that drops the clarify node — falls back to isolated then).
 *
 * Kept narrow on purpose: callers want `resolveClarifySessionMode` access at
 * REST-handler time WITHOUT pulling the whole definition into scope.
 */
export function resolveClarifyNodeFromTaskSnapshot(
  workflowSnapshotJson: string,
  clarifyNodeId: string,
): ClarifyNode | undefined {
  let snap: unknown
  try {
    snap = JSON.parse(workflowSnapshotJson)
  } catch {
    return undefined
  }
  const nodes = (snap as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return undefined
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const rec = n as { id?: unknown; kind?: unknown }
    if (rec.kind !== 'clarify') continue
    if (rec.id !== clarifyNodeId) continue
    return n as ClarifyNode
  }
  return undefined
}

// Constants re-export for tests / runner wire-ups so callers don't pull
// directly from shared in two places.
export { CLARIFY_INPUT_PORT_NAME, CLARIFY_SOURCE_PORT_NAME, ClarifyQuestionSchema }
