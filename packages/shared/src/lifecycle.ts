// RFC-053 PR-B P-1 — node_run.status state machine.
//
// Codifies the lifecycle of a `node_runs` row as an explicit (status, event)
// → status transition table. Every site that writes `node_runs.status` is
// supposed to go through `transitionNodeRunStatus()` (backend) or call
// `nextNodeRunStatus()` directly (pure / tests). Illegal transitions throw
// at the service layer, never reach the DB.
//
// New status or new event? Add it to the union here and the `switch` in
// `nextNodeRunStatus` will fail at compile time (`never` exhaustiveness)
// until you fill in the transition.

// ---------------------------------------------------------------------------
// Status universe — re-export from schemas/task (the DB-authoritative one).
// ---------------------------------------------------------------------------

import { NODE_RUN_STATUS, type NodeRunStatus, TASK_STATUS, type TaskStatus } from './schemas/task'

/** Terminal statuses: once a row reaches one of these, no out-transition is legal. */
export const TERMINAL_NODE_RUN_STATUSES = [
  'done',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
  'exhausted',
] as const satisfies readonly NodeRunStatus[]

export function isTerminalNodeRunStatus(s: NodeRunStatus): boolean {
  return (TERMINAL_NODE_RUN_STATUSES as readonly NodeRunStatus[]).includes(s)
}

// ---------------------------------------------------------------------------
// Events: each one identifies a specific business transition.
// ---------------------------------------------------------------------------

export type NodeRunTransitionEvent =
  // runner lifecycle
  | { kind: 'mark-running' } // pending → running
  | { kind: 'mark-done' } // running → done
  | { kind: 'mark-failed'; reason?: string } // pending|running|awaiting_* → failed
  | { kind: 'mark-canceled'; reason?: string } // any non-terminal → canceled
  | { kind: 'mark-interrupted' } // any non-terminal → interrupted
  // review flow
  | { kind: 'park-review' } // pending|running → awaiting_review
  | { kind: 'approve-review' } // awaiting_review → done
  | { kind: 'iterate-review' } // awaiting_review → pending
  | { kind: 'reject-review' } // awaiting_review → pending
  // clarify flow
  | { kind: 'park-human' } // pending|running → awaiting_human
  | { kind: 'resume-clarify' } // awaiting_human → done (clarify run closes when answers land)
  // supersede / fan-out / loop
  | { kind: 'cancel-by-supersede'; reason: string } // pending|running|awaiting_* → canceled
  | { kind: 'mark-skipped'; reason?: string } // pending → skipped
  | { kind: 'mark-exhausted' } // running → exhausted

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class IllegalNodeRunTransition extends Error {
  readonly code = 'illegal-node-run-transition' as const
  constructor(
    readonly from: NodeRunStatus,
    readonly eventKind: NodeRunTransitionEvent['kind'],
    extra?: string,
  ) {
    super(
      `illegal node_run transition: from='${from}' via event='${eventKind}'${extra ? ` (${extra})` : ''}`,
    )
  }
}

// ---------------------------------------------------------------------------
// The transition function — single source of truth.
// ---------------------------------------------------------------------------

/**
 * Compute the next status for `cur` under event `ev`. Throws
 * IllegalNodeRunTransition if the transition is not allowed.
 *
 * All terminal `cur` values throw immediately — terminals have no
 * out-transitions. If a path needs to "rewrite" a terminal row (e.g.,
 * fixup scripts), use the lower-level `setNodeRunStatus({ allowedFrom })`
 * helper with an explicit allowlist.
 */
export function nextNodeRunStatus(cur: NodeRunStatus, ev: NodeRunTransitionEvent): NodeRunStatus {
  if (isTerminalNodeRunStatus(cur)) {
    throw new IllegalNodeRunTransition(cur, ev.kind, 'cur is terminal')
  }
  switch (ev.kind) {
    case 'mark-running':
      if (cur === 'pending') return 'running'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-done':
      if (cur === 'running') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-failed':
      if (
        cur === 'pending' ||
        cur === 'running' ||
        cur === 'awaiting_review' ||
        cur === 'awaiting_human'
      ) {
        return 'failed'
      }
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-canceled':
      // Anything non-terminal can be canceled (user-initiated abort, shutdown).
      return 'canceled'
    case 'mark-interrupted':
      // Daemon restart reaping — any non-terminal row.
      return 'interrupted'
    case 'park-review':
      if (cur === 'pending' || cur === 'running') return 'awaiting_review'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'approve-review':
      if (cur === 'awaiting_review') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'iterate-review':
    case 'reject-review':
      if (cur === 'awaiting_review') return 'pending'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'park-human':
      if (cur === 'pending' || cur === 'running') return 'awaiting_human'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'resume-clarify':
      // clarify node_run goes done when the user submits answers — the
      // SOURCE agent gets a fresh node_run separately (mint, not transition).
      if (cur === 'awaiting_human') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'cancel-by-supersede':
      if (
        cur === 'pending' ||
        cur === 'running' ||
        cur === 'awaiting_review' ||
        cur === 'awaiting_human'
      ) {
        return 'canceled'
      }
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-skipped':
      if (cur === 'pending') return 'skipped'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-exhausted':
      if (cur === 'running') return 'exhausted'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    default: {
      // exhaustiveness — adding a new NodeRunTransitionEvent kind without handling it
      // here is a compile error.
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalNodeRunTransition(
        cur,
        (ev as NodeRunTransitionEvent).kind,
        'unhandled event',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: the set of statuses from which an event is allowed.
// ---------------------------------------------------------------------------

/**
 * Returns the set of `from` statuses for which `nextNodeRunStatus(from, ev)`
 * does NOT throw. Useful for the lower-level `setNodeRunStatus()` helper and
 * for tests.
 */
export function allowedFromStatusesForEvent(ev: NodeRunTransitionEvent): readonly NodeRunStatus[] {
  const allowed: NodeRunStatus[] = []
  for (const s of NODE_RUN_STATUS) {
    if (isTerminalNodeRunStatus(s)) continue
    try {
      nextNodeRunStatus(s, ev)
      allowed.push(s)
    } catch {
      // not allowed from this status
    }
  }
  return allowed
}

// ===========================================================================
// RFC-108 T1/T2 (AR-12 / AR-19 / 01-LIFE-01) — task.status state machine.
//
// node_run has had `nextNodeRunStatus` (transition-table SSOT) since RFC-053,
// but task-level was CAS-only (RFC-097) with `allowedFrom` hand-copied at ~20
// call sites (01-LIFE-01/02 drift). This adds the SYMMETRIC oracle so any new
// recovery status write (auto-resume, etc.) routes through one table instead
// of a fresh hand-written `allowedFrom`. Per the Codex audit cross-check this
// lands as a NON-disruptive two-step: introduce the oracle + an event-path
// wrapper that NEW callers use; the existing call sites keep their explicit
// `allowedFrom` and migrate incrementally (no big-bang churn).
//
// New task status or event? The `switch` below fails compilation (`never`)
// until you fill it in.
// ===========================================================================

/** Terminal task statuses — once reached, only resume/retry may move out (and
 *  only via the `allowTerminal` escape hatch held by resume/retry/repair). */
export const TERMINAL_TASK_STATUSES = [
  'done',
  'failed',
  'canceled',
  'interrupted',
] as const satisfies readonly TaskStatus[]

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(s)
}

/** RFC-075 — synthetic node_id prefix marking a framework commit&push node_run.
 *  flag-audit W0: was two independent literals（backend services/commitPush.ts
 *  写、frontend tasks.detail.tsx 过滤），现在双端共用一处。 */
export const COMMIT_PUSH_NODE_PREFIX = '__commit_push__'

/**
 * RFC-287 G7 —— 标记「仓库准备」这一步的合成 node_run 的 node_id。
 *
 * 与 `__commit_push__` 同一先例：它不是工作流里的节点，而是框架自己的一步，但
 * 用户必须能在时间线上看到它——G7 把仓库准备挪到任务行落库之后，如果这一步不
 * 可见，用户看到的就是一个「pending 了很久然后 failed」的任务，不知道卡在克隆、
 * 更不知道该重试什么。有了这一行，「重试准备仓库」就能复用既有的 retryNode，
 * 不必为它造第二套重试语义。
 *
 * 与 commit&push 不同的是它**不带后缀**：仓库准备是任务级的一次性步骤，不像
 * commit&push 那样按 agent 节点、按仓分裂。
 */
export const REPO_PREP_NODE_ID = '__repo_prep__'

/** flag-audit W0（§4.3）— the `tasks.error_summary` marker orphan reaping stamps
 *  on daemon-restart interruptions. MACHINE-READ CONTRACT: autoResume's boot
 *  pass selects candidates by exact equality on this value, so a wording tweak
 *  at the write site would silently disable boot auto-resume. Both sides now
 *  import this constant instead of carrying independent string literals. */
export const DAEMON_RESTART_ERROR_SUMMARY = 'daemon-restart'

/** RFC-202 T4 — the AbortController reason a graceful daemon shutdown tags
 *  its aborts with (`controller.abort(DAEMON_SHUTDOWN_ABORT_REASON)`). The
 *  scheduler's abort checkpoints branch on exact equality: shutdown-tagged
 *  aborts land `interrupted` + DAEMON_RESTART_ERROR_SUMMARY (resumable /
 *  auto-resumable) instead of `canceled by user`. A user cancel aborts with
 *  NO argument (signal.reason is then a DOMException), so that path is
 *  untouched by this constant. */
export const DAEMON_SHUTDOWN_ABORT_REASON = 'daemon-shutdown'

/** Task-level transition events (business transitions). Mirrors the node_run
 *  ADT. Targets are fixed per event (independent of the source within the
 *  event's allowed-from set), so `targetForTaskEvent` is total. */
export type TaskTransitionEvent =
  | { kind: 'claim' } // pending → running (scheduler picks up)
  | { kind: 'complete' } // running → done
  | { kind: 'park-review' } // pending|running → awaiting_review
  | { kind: 'park-human' } // pending|running → awaiting_human
  | { kind: 'unpark' } // awaiting_* → running (gate answered, work continues)
  | { kind: 'fail'; reason?: string } // pending|running|awaiting_* → failed
  | { kind: 'cancel'; reason?: string } // pending|running|awaiting_* → canceled
  | { kind: 'interrupt' } // pending|running → interrupted (reaper / shutdown)
  | { kind: 'resume' } // failed|interrupted|awaiting_* → pending (resumeTask / auto-resume)
  | { kind: 'retry' } // done|failed|canceled|interrupted → pending (retryNode)
  | { kind: 'sync-workflow' } // RFC-109: any non-active → pending (syncTaskWorkflow); = resume ∪ retry

export class IllegalTaskTransition extends Error {
  readonly code = 'illegal-task-transition' as const
  constructor(
    readonly from: TaskStatus,
    readonly eventKind: TaskTransitionEvent['kind'],
    extra?: string,
  ) {
    super(
      `illegal task transition: from='${from}' via event='${eventKind}'${extra ? ` (${extra})` : ''}`,
    )
  }
}

/** The fixed target status an event drives toward (does not depend on source). */
export function targetForTaskEvent(ev: TaskTransitionEvent): TaskStatus {
  switch (ev.kind) {
    case 'claim':
    case 'unpark':
      return 'running'
    case 'complete':
      return 'done'
    case 'park-review':
      return 'awaiting_review'
    case 'park-human':
      return 'awaiting_human'
    case 'fail':
      return 'failed'
    case 'cancel':
      return 'canceled'
    case 'interrupt':
      return 'interrupted'
    case 'resume':
    case 'retry':
    case 'sync-workflow':
      return 'pending'
    default: {
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalTaskTransition(
        'pending',
        (ev as TaskTransitionEvent).kind,
        'unhandled event',
      )
    }
  }
}

/**
 * Canonical (status, event) → status table for tasks — the single source of
 * truth for "is this task transition legal at all". Callers that need a
 * NARROWER allowed-from (e.g. scheduler cancel only from `running` because it
 * already holds the claim) may still pass an explicit subset; this oracle is
 * the superset. Throws IllegalTaskTransition for illegal pairs.
 */
export function nextTaskStatus(cur: TaskStatus, ev: TaskTransitionEvent): TaskStatus {
  const ok = (froms: readonly TaskStatus[]): TaskStatus => {
    if (froms.includes(cur)) return targetForTaskEvent(ev)
    throw new IllegalTaskTransition(cur, ev.kind)
  }
  switch (ev.kind) {
    case 'claim':
      return ok(['pending'])
    case 'complete':
      return ok(['running'])
    case 'park-review':
    case 'park-human':
      return ok(['pending', 'running'])
    case 'unpark':
      return ok(['awaiting_review', 'awaiting_human'])
    case 'fail':
      return ok(['pending', 'running', 'awaiting_review', 'awaiting_human'])
    case 'cancel':
      return ok(['pending', 'running', 'awaiting_review', 'awaiting_human'])
    case 'interrupt':
      return ok(['pending', 'running'])
    case 'resume':
      // resume reanimates a parked or terminal-but-recoverable task.
      return ok(['failed', 'interrupted', 'awaiting_review', 'awaiting_human'])
    case 'retry':
      // single-node retry can re-open any terminal task.
      return ok(['done', 'failed', 'canceled', 'interrupted'])
    case 'sync-workflow':
      // RFC-109: re-point a non-active task at the latest workflow definition
      // and continue. Spans every non-active status = resume ∪ retry.
      return ok(['failed', 'interrupted', 'done', 'canceled', 'awaiting_review', 'awaiting_human'])
    default: {
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalTaskTransition(cur, (ev as TaskTransitionEvent).kind, 'unhandled event')
    }
  }
}

/** The set of `from` statuses for which `nextTaskStatus(from, ev)` is legal. */
export function allowedFromForTaskEvent(ev: TaskTransitionEvent): readonly TaskStatus[] {
  const allowed: TaskStatus[] = []
  for (const s of TASK_STATUS) {
    try {
      nextTaskStatus(s, ev)
      allowed.push(s)
    } catch {
      // not allowed from this status
    }
  }
  return allowed
}

/**
 * RFC-317 T50（findings LC-05）—— 任务**工作区**处于哪一阶段。
 *
 * 这个判断此前被手写了**三份，三份互不相同**，而其中两份的注释还各自声称
 * 「判据与 assertWorktreePresentForResume 同源」：
 *
 *   ① `services/task.ts assertWorktreePresentForResume`
 *      `worktreePath === '' && workspaceState === 'available' && 有 __repo_prep__ 行`
 *   ② `services/autoResume.ts`      `worktreePath === '' && workspacePrunedAt === null`
 *   ③ `services/stuckTaskDetector.ts` 同 ②
 *
 * 两处分歧、后果各不相同：
 *   · ②③ 不看 `workspacePruningAt`——正在打墓碑的任务会被它们当成「还在准备仓库」；
 *   · ②③ 不要求存在 `__repo_prep__` 行。于是一条**存量**物化失败的任务行
 *     （空路径、无墓碑、也从来没有过准备行——迁移 0034 回填过空路径的 task_repos，
 *     迁移 0085 新增墓碑列时不回填）在三处得到三种结论：`task.ts` 判它「不是准备中」
 *     → 落到 `existsSync('')` → 410「被 worktree GC 回收了」（归因错误但至少有个说法）；
 *     `autoResume` 把它路由去 `retryRepoPrep()`——**而 AC-11 的重试入口对它根本不存在**，
 *     等于把人指向一扇不存在的门；`stuckTaskDetector` 则把它的 S4 告警静音 45 分钟。
 *
 * 统一到 ① 的判据：它是三者里唯一考虑过存量行的。**这会改变 ②③ 对存量行的行为**
 * ——那正是本次要修的 bug，不是附带损伤。
 *
 * 保持**纯函数**：`hasRepoPrepRow` 由调用方查库后传进来，本函数不碰 DB，
 * 于是它能被 shared 持有、能被前端复用、也能被逐条断言。
 */
export type TaskWorkspacePhase = 'preparing' | 'available' | 'pruning' | 'pruned'

export function taskWorkspacePhase(row: {
  readonly worktreePath: string
  readonly workspacePruningAt: number | null
  readonly workspacePrunedAt: number | null
  /** 该任务是否已落下 `__repo_prep__` 的 node_run 行。 */
  readonly hasRepoPrepRow: boolean
}): TaskWorkspacePhase {
  // 墓碑优先：已打/正在打墓碑就是回收路径，与有没有准备行无关。
  if (row.workspacePrunedAt !== null) return 'pruned'
  if (row.workspacePruningAt !== null) return 'pruning'
  // 空路径 + 无墓碑 + **确有准备行** = RFC-287 G7 的准备阶段。
  // 少了最后一条，存量物化失败行会被谎报成「准备未完成」并劝人去重试准备。
  if (row.worktreePath === '' && row.hasRepoPrepRow) return 'preparing'
  return 'available'
}

// ---------------------------------------------------------------------------
// RFC-317 T51（findings LC-06）—— 从转移表**派生**的状态集合。
// ---------------------------------------------------------------------------
//
// 这三个集合此前是**六份手抄的字面量数组**，散在 services/task.ts、
// task-execution 的两个文件、services/restore.ts、services/worktreeBackup.ts
// 与 stuckTaskDetector.ts 里。代价是实测过的：
//
//   · 加第五个 TaskStatus 是一次六处人肉扫荡，编译器一句话都不会说——那些数组是
//     字面量类型、仅仅「可赋值给 TaskStatus[]」，没有任何东西强制它们覆盖全集。
//     实证：往 TASK_STATUS 里加 'paused' 再跑 typecheck + 全量测试，一条不红，
//     而 cancelTask / restore 挂起 / worktree 备份 / 来源终止 / 卡死检测**全都会
//     静默忽略** paused 任务。
//   · 更糟的是**同名反义**：restore.ts 与 worktreeBackup.ts 各有一个
//     `NON_TERMINAL_TASK_STATUSES`，里面**含** `interrupted`；而本文件的
//     `TERMINAL_TASK_STATUSES` 把 `interrupted` 算作终态。同一个名字，隔两个文件
//     意思正好相反，读代码的人无从判断哪个是对的。
//
// 下面三个各自说清自己是什么，并且**都从表里算出来**（`interrupted` 那一条是显式
// 的并集，不是抄写——见其注释）。

/**
 * 可取消的任务状态 = `cancel` 事件的 allowed-from。
 *
 * 今天它恰好也等于「非终态」，但两者**不是同一个概念**：前者问「现在能不能取消」，
 * 后者问「还会不会再动」。将来若出现一个非终态但不可取消的状态（例如某种不可中断的
 * 收尾阶段），这里会自动跟着 `cancel` 走，而不需要谁记得去改。
 */
export const CANCELABLE_TASK_STATUSES: readonly TaskStatus[] = allowedFromForTaskEvent({
  kind: 'cancel',
})

/** 可被 resume 复活的任务状态 = `resume` 事件的 allowed-from。 */
export const RESUMABLE_TASK_STATUSES: readonly TaskStatus[] = allowedFromForTaskEvent({
  kind: 'resume',
})

/**
 * 可能仍占着一份**活工作区**的任务状态 = 可取消集 ∪ `{'interrupted'}`。
 *
 * `interrupted` 为什么在里面：它是唯一一个「已经是终态、却从没走过任何收尾」的状态
 * ——daemon 在任务跑到一半时死了，进程没被回收、工作区原样躺在磁盘上。备份与
 * restore 后的自动恢复挂起都必须把它算进来，否则会漏掉正是最需要处理的那一批。
 *
 * 这条并集是**显式声明**而不是从某个事件派生：转移表回答的是「状态之间怎么走」，
 * 回答不了「磁盘上还有没有东西」。把它写成显式并集，至少让「为什么多这一个」有处可读，
 * 而不是像此前那样躺在两个同名反义的字面量数组里。
 */
export const LIVE_WORKTREE_TASK_STATUSES: readonly TaskStatus[] = [
  ...CANCELABLE_TASK_STATUSES,
  'interrupted',
]

// ===========================================================================
// RFC-144 — node_runs.merge_state state machine (the third lifecycle).
//
// merge_state is the RFC-130 iso lifecycle: has this run's isolated delta
// reached the task-canonical worktree? It is DB-internal (never serialized to
// the API/frontend), so the value universe lives here rather than in
// schemas/task. NULL is a real state (non-isolated / passthrough / legacy
// rows; every mint is born NULL) — the machine's domain is MergeState | null.
//
// New merge state or event? The switches below fail compilation (`never`)
// until you fill them in.
// ===========================================================================

export const MERGE_STATES = [
  'isolating',
  'pending-merge',
  'merged',
  'conflict-human',
  'merge-failed',
  'abandoned',
] as const

export type MergeState = (typeof MERGE_STATES)[number]

/** Column is nullable: NULL = never entered isolation (passthrough/legacy). */
export type MergeStateOrNull = MergeState | null

/** Terminal merge states: once reached, no out-transition is legal.
 *  `abandoned` (RFC-144) means "this row was superseded by a fresher run;
 *  its delta will never reach canonical" — the invariant is
 *  abandoned ⇔ a fresher sibling generation exists.
 *  `merged` is deliberately NOT terminal (Codex impl-gate P2): wrapper rows
 *  are multi-generation — a crash inside mergeBackWrapperIso gets its
 *  pending-merge replayed to 'merged' at the next entry, then the SAME row is
 *  revived (findResumableWrapperRun) and isolates again via
 *  `reenter-isolation`. merged is a per-generation settled point, guarded by
 *  every other event's from-set (only reenter-isolation may leave it), and it
 *  is NOT in the abandon from-set (fanout undo needs merged history intact). */
export const TERMINAL_MERGE_STATES = [
  'merge-failed',
  'abandoned',
] as const satisfies readonly MergeState[]

export function isTerminalMergeState(s: MergeStateOrNull): boolean {
  return s !== null && (TERMINAL_MERGE_STATES as readonly MergeState[]).includes(s)
}

/** The single source for deriveFrontier's settled gate (RFC-130 D15): a done
 *  row counts as completed iff its delta is in canonical (merged) or it never
 *  isolated at all (NULL). Everything else gates downstream out.
 *  Param is widened to the raw column surface (`string | null`, undefined from
 *  plain test rows normalizes to null) so drizzle rows pass without casts —
 *  the merge_state column itself is untyped text. */
export const SETTLED_MERGE_STATES = [null, 'merged'] as const satisfies readonly MergeStateOrNull[]

export function isMergeStateSettled(s: string | null | undefined): boolean {
  return (s ?? null) === null || s === 'merged'
}

/** merge_state transition events. `via` distinguishes the live dispatch path
 *  from the resume-replay path (same edge, audit-only payload); `reason` is
 *  diagnostic passthrough — payloads never affect the computed target. */
export type MergeStateTransitionEvent =
  // iso lifecycle (§段① / §段②)
  | { kind: 'begin-isolation' } // NULL|isolating → isolating (persistIsoBase; self-edge = same-row shard/agg re-dispatch re-stamps a FRESH iso)
  | { kind: 'mark-pending-merge' } // isolating → pending-merge (persistIsoNodeTree)
  // merge-back outcomes (§段③, live + resume replay)
  | { kind: 'mark-merged'; via?: 'live' | 'replay' } // pending-merge → merged
  | { kind: 'park-conflict-human'; via?: 'live' | 'replay' } // pending-merge → conflict-human
  | { kind: 'mark-merge-failed'; reason?: string } // isolating|pending-merge → merge-failed
  // human conflict resolution completes on resume (§6.3)
  | { kind: 'complete-human-resolution' } // conflict-human → merged
  // same-row wrapper revival opens a NEW isolation generation (Codex impl-gate P2)
  | { kind: 'reenter-isolation' } // merged|conflict-human → isolating (createOrRebuildWrapperIso on a revived wrapper row)
  // readonly script success (RFC-253 D8 / RFC-276 regression fix): the iso copy
  // is discarded BY DESIGN — the generation settles with zero delta. Target is
  // 'merged' (the per-generation settled point): observationally identical to a
  // merge-back whose delta is empty, and deliberately NOT routed through
  // pending-merge — that would open a crash window where the entry replay
  // merges a readonly node's writes into canonical.
  | { kind: 'discard-readonly' } // isolating → merged (no bytes reach canonical)
  // supersede (RFC-144): a fresher generation replaces this row
  | { kind: 'abandon'; reason: string } // isolating|pending-merge|conflict-human → abandoned

export class IllegalMergeStateTransition extends Error {
  readonly code = 'illegal-merge-state-transition' as const
  constructor(
    readonly from: MergeStateOrNull,
    readonly eventKind: MergeStateTransitionEvent['kind'],
    extra?: string,
  ) {
    super(
      `illegal merge_state transition: from='${from ?? 'NULL'}' via event='${eventKind}'${extra ? ` (${extra})` : ''}`,
    )
  }
}

/** The fixed target merge_state an event drives toward (total function). */
export function targetForMergeEvent(ev: MergeStateTransitionEvent): MergeState {
  switch (ev.kind) {
    case 'begin-isolation':
    case 'reenter-isolation':
      return 'isolating'
    case 'mark-pending-merge':
      return 'pending-merge'
    case 'mark-merged':
    case 'complete-human-resolution':
    case 'discard-readonly':
      return 'merged'
    case 'park-conflict-human':
      return 'conflict-human'
    case 'mark-merge-failed':
      return 'merge-failed'
    case 'abandon':
      return 'abandoned'
    default: {
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalMergeStateTransition(
        null,
        (ev as MergeStateTransitionEvent).kind,
        'unhandled event',
      )
    }
  }
}

/**
 * Canonical (merge_state, event) → merge_state table — the single source of
 * truth for merge-state transition legality. Throws IllegalMergeStateTransition
 * for illegal pairs. Terminal `cur` values throw immediately (no escape hatch:
 * unlike status there is no fixup-script path; a terminal rewrite is a bug).
 */
export function nextMergeState(cur: MergeStateOrNull, ev: MergeStateTransitionEvent): MergeState {
  if (isTerminalMergeState(cur)) {
    throw new IllegalMergeStateTransition(cur, ev.kind, 'cur is terminal')
  }
  const ok = (froms: readonly MergeStateOrNull[]): MergeState => {
    if (froms.includes(cur ?? null)) return targetForMergeEvent(ev)
    throw new IllegalMergeStateTransition(cur, ev.kind)
  }
  switch (ev.kind) {
    case 'begin-isolation':
      // Freshly-minted (NULL) rows enter isolation; passthrough rows stay
      // NULL forever (persistIsoBase early-returns before ever emitting this).
      // The isolating self-edge is the same-row re-dispatch (fanout-shard /
      // fanout-aggregator resume resets an interrupted child to pending and
      // re-runs it in place): persistIsoBase re-stamps the row with the FRESH
      // iso's base columns — refusing it would fail valid crash recovery.
      return ok([null, 'isolating'])
    case 'mark-pending-merge':
      return ok(['isolating'])
    case 'mark-merged':
      return ok(['pending-merge'])
    case 'park-conflict-human':
      return ok(['pending-merge'])
    case 'mark-merge-failed':
      // The merge-back try block covers snapshot-pin (isolating) AND the
      // three-way merge (pending-merge) — a throw in EITHER phase must land
      // merge-failed so the frontier fails the scope loudly instead of the
      // done+isolating row wedging in the blocked bucket.
      return ok(['isolating', 'pending-merge'])
    case 'complete-human-resolution':
      return ok(['conflict-human'])
    case 'discard-readonly':
      // Readonly script success only: the run isolated (isolating), produced
      // its ports, and its policy says the file delta never merges back. The
      // generation settles directly — isolating → merged with no
      // pending-merge stop (no replay may ever materialize this delta).
      return ok(['isolating'])
    case 'reenter-isolation':
      // Same-row wrapper revival (Codex impl-gate P2): a wrapper row whose
      // prior generation already settled (crash inside mergeBackWrapperIso →
      // entry replay flipped it 'merged'; or canceled while parked
      // 'conflict-human') is revived in place (findResumableWrapperRun) and
      // must isolate AGAIN for its next generation. Fired only from
      // createOrRebuildWrapperIso; isolating/NULL rows never emit it.
      return ok(['merged', 'conflict-human'])
    case 'abandon':
      // Every in-flight state may be superseded. NULL is deliberately NOT
      // abandonable: a non-isolated row has no delta to orphan, and keeping
      // NULL rows NULL preserves the RFC-130 golden-lock.
      return ok(['isolating', 'pending-merge', 'conflict-human'])
    default: {
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalMergeStateTransition(
        cur,
        (ev as MergeStateTransitionEvent).kind,
        'unhandled event',
      )
    }
  }
}

/** The set of `from` states for which `nextMergeState(from, ev)` is legal. */
export function allowedFromForMergeEvent(
  ev: MergeStateTransitionEvent,
): readonly MergeStateOrNull[] {
  const allowed: MergeStateOrNull[] = []
  for (const s of [null, ...MERGE_STATES] as readonly MergeStateOrNull[]) {
    try {
      nextMergeState(s, ev)
      allowed.push(s)
    } catch {
      // not allowed from this state
    }
  }
  return allowed
}
