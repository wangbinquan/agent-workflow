// RFC-128 P5-D — quick-channel seal + AUTODISPATCH (the final P5 phase).
//
// RFC-132 (universal deferred model) UPDATE: the per-task `deferred_question_dispatch` flag and the
// legacy immediate-mint path are DELETED — every task takes the deferred path, and this module is
// THE single per-question delivery entry for ALL clarify answers (RFC-125 single delivery path,
// never a second path). The API body's `defer` only decides AUTO vs MANUAL triggering of the SAME
// per-question dispatch:
//
//   • Quick channel (defer=false) → autoDispatchClarifyRound: seal the round (the SAME
//     control-channel sealRoundQuestions the defer=true path uses) then AUTO-trigger the SAME
//     dispatchTaskQuestions the board's 批量下发 uses (readiness + rerun-cause + auto-split +
//     in-flight gate all reused).
//   • Manual control channel (defer=true, centralized-answer pane P4) → seal + leave the entry
//     STAGED; the user dispatches it explicitly later (P5-BC, unchanged).
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
import { resolveClarifyNodeFromTaskSnapshot } from '@/services/clarify/service'
import { hasOpenDispatchedEntryOnHome } from '@/services/clarifyRerunLedger'
import { sealRoundQuestions } from '@/services/clarifySeal'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'
import { buildFrozenAttributionSet } from '@/services/clarifyRounds'
import { loadRollbackTarget, rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import {
  dispatchDeferredTaskQuestions,
  dispatchTaskQuestions,
  type DispatchTaskQuestionsResult,
} from '@/services/taskQuestionDispatch'
import { loadSealedQuestionIds } from '@/services/taskQuestions'
import { getTaskQuestionWriteSem, getTaskWriteSem } from '@/services/taskWriteLocks'
import { ConflictError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { TASK_QUESTION_CONFLICT } from '@/services/taskQuestionConflicts'
import {
  resolveClarifySessionMode,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
  type TaskActorRole,
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
  TASK_QUESTION_CONFLICT.nodeDispatchInFlight, // releases when the in-flight rerun reaches done+output
  TASK_QUESTION_CONFLICT.targetChanged, // a concurrent reassign — re-plan against the new target
])

/** RFC-132 PR-B (§6 designer 切自动下发) — the ConflictError codes the DESIGNER auto-dispatch swallows
 *  as a PARK (the designer entries stay sealed-undispatched until a later sibling answer / board
 *  dispatch mints the rerun). Adds TASK_QUESTION_CONFLICT.designerNotReady (multi-source readiness — sibling
 *  cross-clarify rounds still awaiting an answer) to the shared recoverable set; everything else
 *  (multi-target / unsafe frontier / terminal task) is RETHROWN.
 *  RFC-140 W2: exported — the scheduler-tick auto-redispatch of auto-split-deferred entries uses the
 *  SAME retryable set (one definition, no fork): whitelisted → keep the marker, retry next tick;
 *  anything else → clear the marker + WARN (back to the manual board track, never silent-spin). */
export const DESIGNER_DEFERRABLE_CONFLICTS: ReadonlySet<string> = new Set([
  ...RECOVERABLE_DISPATCH_CONFLICTS,
  TASK_QUESTION_CONFLICT.designerNotReady, // sibling cross-clarify round(s) still awaiting an answer
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

/** RFC-172b (T6): entry → shard resolver for a SHARDED (workgroup member) self home. Manual → null;
 *  clarify-derived → its round's asking_shard_key. Mirrors taskQuestionDispatch.resolveEntryShardKeys
 *  (inlined to avoid a module-init import cycle — clarifyAutoDispatch is a leaf consumer). Only built
 *  for a member self run; a null-shard home skips it (see selfHomeHasOpenLedger). */
async function buildDispatchedEntryShardResolver(
  db: DbClient,
  entries: ReadonlyArray<Pick<typeof taskQuestions.$inferSelect, 'originNodeRunId' | 'sourceKind'>>,
): Promise<(e: { originNodeRunId: string; sourceKind: string }) => string | null> {
  const origins = Array.from(
    new Set(entries.filter((e) => e.sourceKind !== 'manual').map((e) => e.originNodeRunId)),
  )
  const shardByOrigin = new Map<string, string | null>()
  if (origins.length > 0) {
    const rounds = await db
      .select({ origin: clarifyRounds.intermediaryNodeRunId, shard: clarifyRounds.askingShardKey })
      .from(clarifyRounds)
      .where(inArray(clarifyRounds.intermediaryNodeRunId, origins))
    for (const r of rounds) shardByOrigin.set(r.origin, r.shard)
  }
  return (e) => (e.sourceKind === 'manual' ? null : (shardByOrigin.get(e.originNodeRunId) ?? null))
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
  /** RFC-172b (T6, S4): the shard of the self run being rolled back (workgroup member = assignment
   *  id; leader / ordinary self = null). A SIBLING member's open ledger on the shared `__wg_member__`
   *  no longer blocks THIS member's rollback. null = ordinary home (shard-blind, golden-lock). */
  selfShardKey: string | null,
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
      originNodeRunId: taskQuestions.originNodeRunId,
      triggerRunId: taskQuestions.triggerRunId,
      defaultTargetNodeId: taskQuestions.defaultTargetNodeId,
      overrideTargetNodeId: taskQuestions.overrideTargetNodeId,
      roleKind: taskQuestions.roleKind,
      sourceKind: taskQuestions.sourceKind,
    })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        // RFC-162: 'echo' role deleted; self/questioner/designer are the whole deferred set.
        inArray(taskQuestions.roleKind, ['self', 'questioner', 'designer']),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  // RFC-172b (T6): only a SHARDED (workgroup member) self run needs shard scoping — a sibling
  // member's ledger on the shared `__wg_member__` must not block this member's rollback. A null-shard
  // self home (leader / ordinary node) stays fully node-wide (pass undefined) → byte-identical to
  // today, and skips the clarify_rounds join entirely.
  const shardOfEntry =
    selfShardKey === null
      ? undefined
      : await buildDispatchedEntryShardResolver(db, dispatchedEntries)
  if (
    dispatchedEntries.length > 0 &&
    // RFC-133: this preflight guards the SELF rollback+dispatch — its mint is 'clarify-answer'.
    hasOpenDispatchedEntryOnHome(
      homeNodeId,
      dispatchedEntries,
      runs,
      outputRunIds,
      'clarify-answer',
      selfShardKey === null ? undefined : selfShardKey,
      shardOfEntry,
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
  /** RFC-023 optimistic lock — the round iteration the client believes it is answering. When set
   *  and != the round's current iteration, reject (clarify-iteration-mismatch), mirroring the
   *  immediate path (submitClarifyAnswers / submitCrossClarifyAnswers); the /clarify page always
   *  sends it. */
  ifMatchIteration?: number
  /** Audit-only actor; NEVER enters a prompt (RFC-099). */
  actor: { userId: string; role: TaskActorRole }
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
/** RFC-217 T9 (§8.3 拆函数) — steps 3/3b: whole-round finalize seal (+ the
 *  RFC-041 distill enqueue and the RFC-099 attribution freeze). Throws on a
 *  partial seal; returns the sealed question ids. */
async function sealRoundAsWholeFinalize(
  db: DbClient,
  args: AutoDispatchClarifyRoundArgs,
  round: {
    id: string
    kind: 'self' | 'cross'
    taskId: string
    questionsJson: string
  },
  originNodeRunId: string,
): Promise<{ sealedQuestionIds: string[]; roundFullySealed: boolean }> {
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
  const sealResult = await sealRoundQuestions({
    db,
    originNodeRunId,
    answers: sealAnswers,
    ...(args.directive !== undefined ? { directive: args.directive } : {}),
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

  return { sealedQuestionIds, roundFullySealed }
}

/** RFC-217 T9 (§8.3 拆函数) — step 7: the CROSS round's designer-scoped
 *  auto-dispatch (aggregate sibling rounds → same board dispatch path; park
 *  等齐 on DESIGNER_DEFERRABLE_CONFLICTS). No-op for kind='self'. */
async function dispatchSealedDesignerEntries(
  db: DbClient,
  args: AutoDispatchClarifyRoundArgs,
  round: { kind: 'self' | 'cross'; taskId: string },
  originNodeRunId: string,
): Promise<DispatchTaskQuestionsResult> {
  // 7. RFC-132 PR-B (§6 designer 切自动下发) — a CROSS round's DESIGNER-scoped entries (sealed in
  //    step 3) are aggregated to their effective target designer(s) and auto-dispatched via the SAME
  //    dispatchTaskQuestions the board uses, replacing the legacy submitCrossClarifyAnswers →
  //    triggerDesignerRerun immediate mint. Multi-source readiness (assertDesignerReady inside
  //    dispatchTaskQuestions) rejects with TASK_QUESTION_CONFLICT.designerNotReady until EVERY sibling
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
      // RFC-162 (Codex impl-gate P1) — a designer that COEXISTS with an undispatched asker
      // (self/questioner) for the same (round, question) must NOT be quick-dispatched in
      // isolation: its asker was parked above (step 4), so dispatching the designer alone here
      // would run the upstream + cascade the asker's node while the asker ENTRY lingers
      // undispatched (a later board dispatch would then redundantly re-mint it). Such a designer
      // rides the §18 park with its asker until the board's UNIFIED computeUpstreamFrontier
      // dispatches both together. (Every RFC-162 clarify designer is reassign-created and thus
      // has a coexisting asker — so this quick designer auto-dispatch is effectively board-only
      // now; kept + gated rather than removed for defense.)
      const undispatchedAskerKeys = new Set(
        (
          await db
            .select({
              originNodeRunId: taskQuestions.originNodeRunId,
              questionId: taskQuestions.questionId,
            })
            .from(taskQuestions)
            .where(
              and(
                eq(taskQuestions.taskId, round.taskId),
                inArray(taskQuestions.roleKind, ['self', 'questioner']),
                isNull(taskQuestions.dispatchedAt),
              ),
            )
        ).map((a) => `${a.originNodeRunId}:${a.questionId}`),
      )
      const designerCandidates = allDesigner.filter((e) =>
        targetDesignerNodes.has(e.overrideTargetNodeId ?? e.defaultTargetNodeId ?? ''),
      )
      // RFC-162 (Codex re-review P2) — skip the WHOLE target designer node if ANY of its sibling
      // rounds is blocked (its asker still undispatched, parked in step 4). Filtering per-row and
      // dispatching only the UNBLOCKED siblings would let assertDesignerReady pass on a PARTIAL
      // multi-source batch → mint the designer WITHOUT the parked round's feedback, then a second
      // rerun later — instead of the intended single aggregated batch. Park the whole target; the
      // board's UNIFIED dispatch mints it once, with every sibling's feedback, when all are ready.
      const blockedTargets = new Set(
        designerCandidates
          .filter((e) => undispatchedAskerKeys.has(`${e.originNodeRunId}:${e.questionId}`))
          .map((e) => e.overrideTargetNodeId ?? e.defaultTargetNodeId ?? ''),
      )
      const designerEntryIds = designerCandidates
        .filter((e) => !blockedTargets.has(e.overrideTargetNodeId ?? e.defaultTargetNodeId ?? ''))
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
  return designerDispatch
}

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

  const { sealedQuestionIds, roundFullySealed } = await sealRoundAsWholeFinalize(
    db,
    args,
    round,
    originNodeRunId,
  )

  // 4. Collect the round's SELF/QUESTIONER entries to auto-dispatch (sealed, not yet dispatched,
  //    still open). Designer entries are intentionally excluded (see the module header). The dispatch
  //    re-applies the same `dispatched_at IS NULL` + `confirmation='open'` filter under lock B, so
  //    this read is just the candidate set.
  const askerRows = await db
    .select({ id: taskQuestions.id, questionId: taskQuestions.questionId })
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
  // RFC-162 (Codex impl-gate P1) — a question with a COEXISTING undispatched designer (added via a
  // pre-submit 改派 on the asker-anchored picker) must NOT quick-dispatch its asker in isolation.
  // The quick path splits self/questioner (step 5) from designer (step 7) into two frontier
  // computations, so an asker DOWNSTREAM of its newly-added upstream designer would be minted
  // directly here — out of order with (and not cascading from) the true upstream frontier. Park
  // such askers instead: they + their designer sibling ride the §18 park until the board's UNIFIED
  // dispatchTaskQuestions computes ONE computeUpstreamFrontier over both (upstream designer starts,
  // the asker cascades). Questions with no designer sibling (the common case) auto-dispatch as before.
  const designerQuestionIds = new Set(
    (
      await db
        .select({ questionId: taskQuestions.questionId })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.originNodeRunId, originNodeRunId),
            eq(taskQuestions.roleKind, 'designer'),
            isNull(taskQuestions.dispatchedAt),
          ),
        )
    ).map((d) => d.questionId),
  )
  const entryIds = askerRows.filter((e) => !designerQuestionIds.has(e.questionId)).map((e) => e.id)

  // 5. RFC-098 B1 worktree rollback for SELF-clarify ISOLATED reruns (Codex round-4 [high]). The
  //    legacy quick path (submitClarifyAnswers) resets the worktree to the asking run's pre_snapshot
  //    before the self continuation, so an isolated rerun starts from the clean pre-question tree
  //    (RFC-023 forbids clarify-time writes, so usually a no-op, but B1 errs safe). The deferred quick
  //    channel preserves this for the self path; dispatchTaskQuestions never rolls back. CROSS
  //    (questioner) reruns do NOT roll back — submitCrossClarifyAnswers has no rollback — so this is
  //    self-only. resolveSelfRollbackRun returns the asking run iff a rollback is due (self + isolated
  //    + a snapshot + a worktree), else null.
  //    RFC-162 (Codex re-review P2, accepted limitation): when EVERY self entry of the round was
  //    parked above (all reassigned to a designer) `entryIds` is empty ⇒ no quick self continuation
  //    runs now ⇒ no rollback now (resetting the tree before the parked designer runs would be
  //    wrong). Such a reassigned self is board-dispatched, which by design does NOT roll back — for
  //    the primary UPSTREAM-designer case that is CORRECT (the asker must see the designer's
  //    revision, not reset to pre-question); the DOWNSTREAM-designer case loses the (usually no-op,
  //    RFC-023) rollback, consistent with every other board-dispatched self continuation.
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
        if (
          claimed.length > 0 ||
          // RFC-172b (T6): scope the open-ledger preflight to this member's shard.
          (await selfHomeHasOpenLedger(db, round.taskId, selfRun.nodeId, selfRun.shardKey ?? null))
        ) {
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
        dispatchDeferredReason = TASK_QUESTION_CONFLICT.nodeDispatchInFlight
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

  const designerDispatch = await dispatchSealedDesignerEntries(db, args, round, originNodeRunId)
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

/** RFC-140 W2 — the scheduler-tick auto-redispatch of auto-split-DEFERRED task questions.
 *
 *  Selection: entries whose `auto_dispatch_deferred_at` is set (the user clicked batch dispatch;
 *  only the RFC-128 §5.2.13 cause auto-split queued them) AND still undispatched AND still staged
 *  (belt-and-braces: stage/unstage clears the marker, so an orphaned marker without staged_at is
 *  audit residue that must never fire).
 *
 *  Execution: ONE full-set dispatchTaskQuestions call — NEVER split per home (Codex design-gate
 *  round 3 P1: the upstream frontier is computed from the WHOLE affected set; per-home singleton
 *  calls would mint a DAG-downstream home directly against stale inputs instead of leaving it to
 *  the scheduler cascade). Nested defers (3 cause classes) keep their markers and converge over
 *  subsequent ticks (≤2 redispatch rounds — CAUSE_PRIORITY is a total order).
 *
 *  Failure: DESIGNER_DEFERRABLE_CONFLICTS (the ONE shared retryable set — in-flight /
 *  target-changed / designer-not-ready) → keep the markers, retry next tick (idempotent; ticks
 *  fire on every node-run completion). Any other ConflictError is NON-recoverable (terminal task /
 *  unparseable snapshot / unsafe frontier / multi-target / unsealed): clear ALL selected markers +
 *  WARN — back to the manual board track (the board shows the same real error on the next manual
 *  dispatch attempt). The full-set-vs-per-home coupling makes this a deliberate connect-and-clear:
 *  "rather back to manual than a wrong frontier" (design §3.2). Non-Conflict errors rethrow.
 *
 *  Runs OUTSIDE lock B (dispatchTaskQuestions acquires it internally — non-reentrant). Callers:
 *  the runTask tick top (scheduler.ts), pre-deriveFrontier, so a freshly-released home (its
 *  in-flight rerun just completed) redispatches on the very tick that completion triggers. */
export async function autoDispatchDeferredQuestions(db: DbClient, taskId: string): Promise<void> {
  // Codex impl-gate P2: TASK_QUESTION_CONFLICT.targetChanged resolves by RE-PLANNING, not by waiting —
  // and this tick may be the LAST one (the scope can go quiescent right after), which would
  // strand the marker until a manual dispatch. Retry the re-plan immediately, bounded (the
  // conflict needs a concurrent reassign per attempt; 3 attempts is already adversarial).
  for (let attempt = 0; ; attempt++) {
    try {
      // Selection happens INSIDE the dispatch's lock-B holding (Codex impl-gate P1 — a
      // pre-selected id list would race a concurrent unstage: dispatch filters on neither the
      // marker nor staged, so a withdrawn entry's stale id would still dispatch).
      const res = await dispatchDeferredTaskQuestions(db, taskId, SYSTEM_DISPATCH_ACTOR, {
        // Non-recoverable → clear THIS attempt's markers inside the dispatch's own lock holding
        // (post-hoc task-wide clearing would race a queued user dispatch's fresh markers).
        clearMarkersOn: (code) => !DESIGNER_DEFERRABLE_CONFLICTS.has(code),
      })
      if (res.dispatchedEntryIds.length > 0 || res.reruns.length > 0) {
        log.info('auto-redispatched deferred task questions', {
          taskId,
          dispatchedEntryCount: res.dispatchedEntryIds.length,
          stillDeferredCount: res.deferred.length,
          rerunCount: res.reruns.length,
        })
      }
      return
    } catch (err) {
      if (err instanceof ConflictError && err.code === TASK_QUESTION_CONFLICT.targetChanged) {
        if (attempt < 2) continue // immediate bounded re-plan (see above)
        log.debug('deferred auto-redispatch target kept changing — waiting for the next tick', {
          taskId,
        })
        return
      }
      if (err instanceof ConflictError && DESIGNER_DEFERRABLE_CONFLICTS.has(err.code)) {
        log.debug('deferred auto-redispatch retryable — waiting for the next tick', {
          taskId,
          reason: err.code,
        })
        return
      }
      if (err instanceof ConflictError) {
        // Markers already cleared inside the dispatch's lock holding (clearMarkersOn above).
        log.warn(
          'deferred auto-redispatch hit a NON-recoverable conflict — markers cleared, back to the manual board track',
          { taskId, reason: err.code },
        )
        return
      }
      throw err
    }
  }
}

/** RFC-140 W2 — the audit actor for scheduler-initiated redispatch ('__system__' precedent:
 *  daemon-token callers, task.ts). Audit-only; never enters an agent prompt (RFC-099). */
const SYSTEM_DISPATCH_ACTOR = { userId: '__system__', role: 'admin' } as const
