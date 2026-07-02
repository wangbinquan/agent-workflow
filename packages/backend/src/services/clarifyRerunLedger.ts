// RFC-128 P5-BC — the SHARED clarify-rerun ledger oracle (RFC-132 ③: dispatched-only — the
// immediate quick-channel half was deleted with the legacy immediate mint). Consumers:
//   - taskQuestionDispatch.ts (dispatch precheck + in-tx recheck + borrow-conflict reject):
//     isDispatchedEntryConsumed / causeClassForEntry.
//   - clarifyAutoDispatch.ts (self-rollback preflight): hasOpenDispatchedEntryOnHome.
//   - clarifyQueue.ts / crossClarify.ts (derived aging): isTargetNodeConsumed.
//
// This module sits BELOW all of {clarify, crossClarify, taskQuestions, taskQuestionDispatch} in the
// dependency order (it imports only schema/shared), so any of them may import it.

import type { nodeRuns, taskQuestions } from '@/db/schema'
import { resolveHandlerRun, type RunLineageView } from '@agent-workflow/shared'

type NodeRunRow = typeof nodeRuns.$inferSelect
type TaskQuestionRow = typeof taskQuestions.$inferSelect

// RFC-128 P5-BC (§5.2.12 F3) — the rerun-cause class an entry's dispatch mints, derived from its
// 承接 role. A node_run carries ONE rerun_cause; entries of different classes on the same home are
// SEPARATE reruns (serialized, never collapsed). self/questioner causes are isClarifyRerun=TRUE
// (inline resume + directive gating); designer's cross-clarify-answer is FALSE (update mode).
export type CauseClass =
  | 'clarify-answer'
  | 'cross-clarify-questioner-rerun'
  | 'cross-clarify-answer'

/** RFC-133: single definition shared by the dispatch grouping/auto-split AND the queued-entry
 *  cause guard in isDispatchedEntryConsumed (moved here from taskQuestionDispatch's private copy). */
export function causeClassForEntry(e: Pick<TaskQuestionRow, 'roleKind'>): CauseClass {
  if (e.roleKind === 'self') return 'clarify-answer'
  if (e.roleKind === 'questioner') return 'cross-clarify-questioner-rerun'
  return 'cross-clarify-answer' // designer (incl. manual)
}

/** RFC-128 P5-BC — the two OPEN semantics the shared oracle serves. They agree on everything EXCEPT
 *  a done-NO-output continuation:
 *   - 'revivable' (BORROW — resolveImmediateBorrowForNode): open = NOT consumed. A continuation is
 *     consumed only when it finished done WITH output (markClarifyRoundsConsumedBy). A done-no-output
 *     continuation is NOT consumed → revivable → keeps borrowing the same handler (locked by the
 *     RFC-127 "done but emitted NO output → still open (keeps borrowing)" test).
 *   - 'in-flight' (DISPATCH GATE — findOpenImmediateLedgerHome): open = status !== 'done'. ONLY a
 *     `done` continuation is gate-closed — done (incl. done-no-output: it ASKED a follow-up round;
 *     runner.ts:1321 keeps status=done with no <workflow-output> port) SUCCEEDED and will not be
 *     re-run, so it cannot double-mint and must NOT block a fresh per-question dispatch (2026-07-01
 *     deadlock fix). A FAILED/canceled/interrupted continuation is NOT gate-closed: it is revivable
 *     (retry/resume re-runs it) and the borrow side still treats it as open, so releasing it would let
 *     dispatch mint a second same-home rerun → an irreversible multi-ledger conflict (Codex impl-gate).
 *     So in-flight diverges from revivable ONLY on done-no-output. */
export type LedgerOpenMode = 'revivable' | 'in-flight'

/** Is a dispatched entry CONSUMED? = its handler run (resolved through the same resolveHandlerRun
 *  lineage the read-side uses) has reached the terminal-success bar for `mode`. Running, GC'd
 *  anchor, and every NON-done terminal (failed/canceled/interrupted) → NOT consumed (still open —
 *  revivable via retry/resume) in EITHER mode.
 *
 *  QUEUED (trigger NULL — dispatched but not yet bound by any run's queue injection):
 *   - 'revivable' (borrow oracle): open, unconditionally (unchanged — the deferred rerun is still
 *     owed to this entry).
 *   - 'in-flight' (RFC-133, live-deadlock fix — task 01KWFZRQFPZFQQEM8JTCHQMGP5 "QMGP5"): open ⟺
 *     the entry's EFFECTIVE TARGET (override ?? default) owes a RUN OBLIGATION — it has a
 *     top-level run with `status !== 'done'` (same bar as openImmediateRounds' in-flight scan) —
 *     OR the caller is about to MINT a rerun of a DIFFERENT cause class there (`mintCause`,
 *     Codex design-gate P2: releasing a queued cross-cause entry would let the mint's queue
 *     injection bind it into that alien-cause rerun, collapsing causes §5.2.12 keeps serialized;
 *     a SAME-cause queued entry legitimately rides the mint, like q1+q2 in one batch).
 *     A target with NO runs at all (never-run downstream — its first natural run binds the queue)
 *     or only done runs (idle — the next mint binds it) has no obligation: blocking there is the
 *     circular-wait bug (the "wait for done+output" exit condition could never be satisfied).
 *
 *  `mode` also diverges on a done-NO-output handler (the SAME split as openImmediateRounds —
 *  2026-07-01 deadlock fix): a clarify handler that ASKS a follow-up round exits `done` with NO
 *  <workflow-output> port (runner.ts:1321), and that state is PERMANENT (a clarify-ask never
 *  becomes done+output).
 *   - 'in-flight' (dispatch gate / mint guard / park): done = consumed. A done handler has
 *     terminated and cannot double-mint, so it must NOT keep the home blocked — else a multi-round
 *     clarify chain DEAD-LOCKS (its round-N handler is done-no-output forever, and the gate's
 *     "dispatch after done+output" can never be satisfied → the next round can never dispatch).
 *   - 'revivable' (RFC-127 borrow oracle): done && hasOutput = consumed. A done-no-output handler
 *     has produced nothing → keeps borrowing the same handler (RFC-127 consumed→null tests). */
export function isDispatchedEntryConsumed(
  entry: Pick<
    TaskQuestionRow,
    'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind'
  >,
  runs: ReadonlyArray<NodeRunRow>,
  lineageViews: RunLineageView[],
  mode: LedgerOpenMode,
  /** in-flight only: the cause class the CALLER will mint on this entry's target in the current
   *  operation (dispatch frontier mint / quick-finalize continuation). undefined = no mint there
   *  (the entry just queues — pure run-obligation check). Ignored in 'revivable' mode. */
  mintCause?: CauseClass,
): boolean {
  if (entry.triggerRunId === null) {
    if (mode === 'revivable') return false // queued → open, unconditionally (borrow unchanged)
    const target = entry.overrideTargetNodeId ?? entry.defaultTargetNodeId
    if (target === null || target === '') return false // no target (data anomaly) → conservative
    if (mintCause !== undefined && causeClassForEntry(entry) !== mintCause) return false // (b)
    const hasRunObligation = runs.some(
      (r) =>
        r.nodeId === target &&
        r.parentNodeRunId === null &&
        r.status !== 'done' &&
        // RFC-132 ②a 缺口②:review supersede 把 done handler 翻 canceled(marker),该行已终结、
        // 不可 revival(RFC-095),不构成 run 义务——否则 review-iterate 后的下一次答复永久卡
        // in-flight(与 isTargetNodeConsumed 的 supersede 例外同判据)。
        !isReviewSupersededCanceled(r),
    )
    return !hasRunObligation // (a) no open run on the target → nothing in flight → consumed
  }
  const anchorRow = runs.find((r) => r.id === entry.triggerRunId)
  if (anchorRow === undefined) return false // anchor GC'd → treat as open (conservative)
  // RFC-132 ②a 缺口②:lineage 投影把 review-superseded canceled 行视作 done——它是「完成过又被
  // review 取代」的 handler(isTargetNodeConsumed :447 同判据),freshest 落在它上时该 entry 的
  // 义务已了结(in-flight: consumed;revivable: 按 hasOutput),不再永久挡 dispatch。
  const supersededIds = new Set(runs.filter((r) => isReviewSupersededCanceled(r)).map((r) => r.id))
  const projected =
    supersededIds.size === 0
      ? lineageViews
      : lineageViews.map((v) =>
          supersededIds.has(v.id) ? { ...v, status: 'done' as NodeRunRow['status'] } : v,
        )
  const hr = resolveHandlerRun({
    effectiveTargetNodeId: anchorRow.nodeId,
    iteration: anchorRow.iteration,
    loopIter: 0,
    triggerRunId: entry.triggerRunId,
    runs: projected,
  })
  if (hr === null || hr.status !== 'done') return false
  return mode === 'in-flight' ? true : hr.hasOutput
}

/** RFC-132 ②a 缺口② — review supersede 例外的单一判据(与 isTargetNodeConsumed :447 /
 *  dispatchFrontier.isReviewSupersededRow 同源):canceled + errorMessage 带 supersede marker。 */
function isReviewSupersededCanceled(r: Pick<NodeRunRow, 'status' | 'errorMessage'>): boolean {
  return (
    r.status === 'canceled' && r.errorMessage?.startsWith(REVIEW_SUPERSEDE_MARKER_PREFIX) === true
  )
}

/** The resolveHandlerRun lineage projection (the SAME shape findOpenDispatchTarget passes) so
 *  "consumed" is defined identically wherever isDispatchedEntryConsumed runs. */
function toLineageViews(
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): RunLineageView[] {
  return runs.map((r) => ({
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
}

/** RFC-128 P5-BC §5.2.14 (reciprocal in-flight check, PRECISE). Pure/sync — is there an OPEN
 *  (unconsumed) DISPATCHED entry of ANY deferred role (self/questioner/designer) whose EFFECTIVE
 *  TARGET (`override ?? default`, per findOpenDispatchTarget — RFC-131 T4 去借壳) is `homeNodeId`? This is the dispatch-side
 *  mirror the submit-side mint needs: a concurrent deferred dispatch of ANOTHER round's entry
 *  reassigned (RFC-127 借壳) to the cascade's home stamps it + mints a pending rerun on that home;
 *  without this the cascade mints a SECOND open ledger on the same (home, iteration).
 *
 *  ALL-ROLE (3rd-gate finding P2): a node carries at most ONE open rerun ledger — a self/questioner
 *  quick-finalize must NOT mint a `clarify-answer`/`cross-clarify-questioner-rerun` next to an EXISTING
 *  open dispatched DESIGNER (`cross-clarify-answer`) rerun on the same home, or the scheduler later
 *  sees multiple open ledgers for one node (mirrors assertNoInFlightDispatch, which spans any deferred
 *  role). Keyed on a DISPATCHED entry (NOT "any pending rerun"): a prior round's quick continuation
 *  has no dispatched entry → the legitimate sequential multi-round flow is not falsely rejected.
 *  Consumed dispatched entries are not a live conflict — this is a MINT GUARD, so it uses the
 *  'in-flight' consume bar: a done handler (incl. done-no-output — it asked a follow-up round) has
 *  terminated and cannot double-mint, so it must NOT block the next round's mint (else deadlock).
 *  The data-loss guard for a dispatched round is roundHasDispatchedSelfQuestioner (keys dispatched_at,
 *  incl. consumed), which runs BEFORE this check — so releasing done-no-output here is safe. */
export function hasOpenDispatchedEntryOnHome(
  homeNodeId: string,
  dispatchedEntries: ReadonlyArray<
    Pick<
      TaskQuestionRow,
      'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind'
    >
  >,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
  /** RFC-133: the cause class of the continuation the CALLER is about to mint on this home
   *  (quick-finalize self → 'clarify-answer', questioner → 'cross-clarify-questioner-rerun').
   *  A queued entry of a DIFFERENT cause must still block the mint (it would otherwise be
   *  bound into the alien-cause continuation — Codex design-gate P2). */
  mintCause: CauseClass,
): boolean {
  const onHome = dispatchedEntries.filter(
    (e) => (e.overrideTargetNodeId ?? e.defaultTargetNodeId) === homeNodeId,
  )
  if (onHome.length === 0) return false
  const lineageViews = toLineageViews(runs, outputRunIds)
  return onHome.some(
    (e) => !isDispatchedEntryConsumed(e, runs, lineageViews, 'in-flight', mintCause),
  )
}

/** RFC-131 — 派生式老化判据（取代 isQueueEntryRenderableForRun 的 window 消费 + isDispatchedEntryConsumed
 *  的 in-flight/revivable mode 分裂）。一个 target 队列里、承接 rerun 为 `sinceRunId`（问题的
 *  `trigger_run_id`）的问题是否「已被 target 产出老化」= 该 (target, iteration) 有一个 TOP-LEVEL run 处于
 *  `done` + 捕获 ≥1 <workflow-output>（正常输出走完），**且其 id ≥ `sinceRunId`**（承接 rerun 本身或其后
 *  的 rerun 产出——ULID 单调递增，id 序等价「问题被承接之后 target 产出了」）。
 *
 *  为什么用 trigger_run_id 的 id 序锚（而非 startedAt 时间锚、也非笼统「node 有过 done+output」）：
 *   - 笼统会误伤 round N+1（node 产出后再开新一轮反问，那批新问题不能被上次产出老化）；
 *   - startedAt 脆弱（mint 时为 null、runner spawn 才 set；时钟精度）；
 *   - trigger_run_id 是问题注入时绑定的承接 rerun（buildClarify*Context 绑），ULID 单调 → id 序 robust。
 *  关键：**不设 window 上界**——renderableForRun 的「下一 clarify rerun」上界会把 round 1 在 round 2 的
 *  rerun 里排除（正是多轮丢历史根因）；这里只要承接 rerun 或其后 target 产出过，就老化。
 *
 *  三态（RFC-131 §2 核心正确性）：
 *   - 承接 rerun（id ≥ sinceRunId）后 target `done`+output → TRUE：老化、定型、不再注入。
 *   - `done` 无 output（问了下一轮反问；runner.ts:1321 对 <workflow-clarify> 保持 done、不写 port）→
 *     FALSE：不老化，答案留队列、下一次 rerun 继续注入（修多轮丢历史轮 + 天然避免下发死锁）。
 *   - review reject/iterate supersede 后的 `canceled`+output（errorMessage 带 `superseded-by-review-` 前缀）→
 *     TRUE：design §74「第一次 done+output 即永久老化」——reject 把产出 run 翻 canceled 但保留 output，老化
 *     须存活，否则 reject 重做重注已答 clarify（验收4 bug）。RFC-119 prior-output 同样对 canceled 存活。
 *   - failed / 非-review-superseded canceled / interrupted / pending / running / awaiting_* → FALSE：未产出（revivable / 在飞）。
 *   - `sinceRunId === null`（问题尚未被任何 rerun 承接注入）→ FALSE：未处理、注入（首次绑定）。
 *
 *  派生式（读时按 run 状态 + id 序算、不落库）：单一事实源、崩溃 replay 一致、零 schema migration、
 *  幂等。fanout 子 run（parentNodeRunId 非 null）不作数——只看 top-level 产出。 */
// review reject/iterate supersede 把 done+output run 翻成 canceled 但保留 output（review.ts）。canonical
// 定义在 dispatchFrontier.REVIEW_SUPERSEDE_MARKER_PREFIX / isReviewSupersededRow；本模块是底层（文件头注释：
// 只 import schema/drizzle/freshness/shared），不 import dispatchFrontier（避免破底层原则 + 传递循环
// dispatchFrontier→wrapperProgress）。用同值常量 + source-text 测试锁（review-supersede-marker-parity）防漂移。
const REVIEW_SUPERSEDE_MARKER_PREFIX = 'superseded-by-review-'

export function isTargetNodeConsumed(
  targetNodeId: string,
  iteration: number,
  sinceRunId: string | null,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): boolean {
  if (sinceRunId === null) return false
  return runs.some(
    (r) =>
      r.nodeId === targetNodeId &&
      r.iteration === iteration &&
      r.parentNodeRunId === null &&
      // done+output 或 review reject/iterate supersede 后的 canceled+output（design §74「第一次 done+output
      // 即永久老化」：reject 把产出 run 翻 canceled 但保留 output，若不认它则 reject 重做会重注已答 clarify
      // ——验收4 bug）。failed / 非-review canceled / interrupted / pending / running+output 仍不老化（revivable / 在飞）。
      (r.status === 'done' ||
        (r.status === 'canceled' &&
          r.errorMessage?.startsWith(REVIEW_SUPERSEDE_MARKER_PREFIX) === true)) &&
      outputRunIds.has(r.id) &&
      r.id >= sinceRunId,
  )
}
