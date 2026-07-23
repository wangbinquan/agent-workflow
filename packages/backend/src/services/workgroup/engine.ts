// RFC-164 PR-3 — the workgroup round engine (design §4).
//
// runTask branches HERE for tasks with workgroup_id (never into
// runScope/deriveFrontier). The engine is completion-driven orchestration
// over durable rows only:
//
//   loop: re-read tables → deriveWakeSet (pure) → drive wake items through
//   hooks.runHostNode → persist envelope effects (assignments / messages /
//   cursors / gate) → race in-flight turns → …until decideWorkgroupOutcome
//   picks a terminal.
//
// EVERYTHING mechanical (frozen runtime, iso worktree + merge-back, spawn,
// clarify session creation, broadcasts) lives behind `WorkgroupEngineHooks`,
// implemented by the scheduler (buildWorkgroupHooks) — the engine never
// imports scheduler.ts (module-cycle ban; binary-build memory) and tests
// drive it with fake hooks (no subprocesses).
//
// Restart safety (design §4.3): no in-memory state survives — wake judgments
// are cursor-based (workgroup_member_cursors) and pending host-node rows
// minted before a crash (incl. clarify-answer reruns) are ADOPTED on the next
// pass instead of re-minted.

import {
  parseBatchShardKey,
  parseMsgShardKey,
  workgroupHasHumanMember,
  resolveCompletionGate,
  type RerunCause,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import type { nodeRuns } from '@/db/schema'
import { isClarifyRerunCause, mintNodeRun } from '@/services/nodeRunMint'
import { ensureWorkgroupTaskStateRow, setPauseReason } from '@/services/workgroup/state'
import {
  casAssignmentStatus,
  dismissOpenClarifyParksForAutonomous,
} from '@/services/workgroup/lifecycle'
import {
  decideWorkgroupOutcome,
  deriveWakeSet,
  isReadonlyAgentPermission,
  WG_NUDGE_BODY,
  type WakeInput,
  type WakeItem,
} from '@/services/workgroup/wake'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '@/services/workgroup/constants'
import type { Logger } from '@/util/log'

// ---------------------------------------------------------------------------
// public contract (scheduler-facing)
// ---------------------------------------------------------------------------

export type {
  WorkgroupHostRunRequest,
  WorkgroupHostRunResult,
  WorkgroupEngineHooks,
} from '@/services/workgroup/hooks'
import type { WorkgroupEngineHooks } from '@/services/workgroup/hooks'

export interface WorkgroupEngineArgs {
  db: DbClient
  taskId: string
  log: Logger
  signal?: AbortSignal
  hooks: WorkgroupEngineHooks
  /** INTERNAL (set by the engine loop): registers freshly-minted host rows so
   *  the adoption pass never re-drives them. Tests need not provide it. */
  registerMint?: (nodeRunId: string) => void
}

export interface WorkgroupEngineResult {
  kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  detail?: { summary: string; message: string; nodeId?: string }
}

export { followupForFailure, wgFollowupNotice } from '@/services/workgroup/turnExecution'
import { loadDbState, type EngineDbState } from '@/services/workgroup/state'
import { postMessage } from '@/services/workgroup/messages'
import {
  deriveLeaderClarifyPark,
  driveLeaderTurn,
  isLeaderWrapUpContinuation,
  openCompletionGate,
  warnIfZeroDeltaDone,
} from '@/services/workgroup/strategies/leaderWorker'
import { driveBatchTurn } from '@/services/workgroup/strategies/freeCollab'
import { driveAssignmentTurn, driveMessageTurn } from '@/services/workgroup/memberTurns'
import { settleCardAfterFailure } from '@/services/workgroup/lifecycle'
import { countBudgetUsed, roundMode } from '@/services/workgroup/rounds'

/**
 * RFC-186 PR-2 (audit §4 F1 / §5 F1) — the reconcile action for a `running`
 * assignment found on engine (re)entry, from its LATEST worker host-run status.
 * A daemon restart reaps a mid-run worker `node_run` to `interrupted` but leaves
 * the assignment `running`; adoption only re-drives `pending` rows, so the
 * assignment is never re-driven AND blocks the leader barrier (a `running`
 * assignment counts as in-flight) → the task wedges `awaiting_human` forever.
 */
export function decideAssignmentReconcile(
  latestWorkerRunStatus: string | undefined,
): 'done' | 'redispatch' | 'none' {
  // Interrupted before the worker run was even minted → re-dispatch.
  if (latestWorkerRunStatus === undefined) return 'redispatch'
  // Finished + merged before the crash → the work is durable; just close the card.
  if (latestWorkerRunStatus === 'done') return 'done'
  // A live driver still owns it (fresh engine shouldn't see this) → leave it.
  if (latestWorkerRunStatus === 'pending' || latestWorkerRunStatus === 'running') return 'none'
  // interrupted / failed / canceled mid-run → re-dispatch for a clean re-run.
  return 'redispatch'
}

/**
 * RFC-187 T13 / Codex P1-7① — is this host row an answered-clarify continuation that a
 * daemon restart killed BEFORE it ever ran? The answer commits (session→answered) and
 * mints a PENDING continuation row, then `resumeTask` is fire-and-forget; a crash in that
 * window has the boot reaper flip the pending row to `interrupted` while the TASK stays
 * `awaiting_human` (the reaper only reaps pending/running TASKS). auto-resume then only
 * scans `interrupted` tasks and adoption only takes `pending` rows — so the answered
 * continuation was wedged forever with no path back (the human's answer silently lost).
 * `interrupted` is terminal (no transition out), so recovery = re-mint, exactly like the
 * DAG's revival of a terminal row.
 */
export function isKilledClarifyContinuation(row: {
  status: string
  rerunCause: string | null
}): boolean {
  return row.status === 'interrupted' && isClarifyRerunCause(row.rerunCause)
}

/**
 * RFC-187 T13 — re-mint every host row {@link isKilledClarifyContinuation} identifies, so
 * the normal pending-adoption drives it (the Q&A is re-derived from the answered session,
 * so the fresh row carries the human's answer). Idempotent: after the re-mint the freshest
 * row for that (nodeId, shardKey) is `pending`, not `interrupted`, so a second pass is a
 * no-op. Only the FRESHEST row per (nodeId, shardKey) is revived — an older interrupted
 * continuation that a later row already superseded must stay history.
 */
async function reviveKilledClarifyContinuations(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  log: Logger,
): Promise<void> {
  const groups = new Map<string, Array<typeof nodeRuns.$inferSelect>>()
  for (const r of state.hostRuns) {
    const key = `${r.nodeId}\x00${r.shardKey ?? ''}`
    const g = groups.get(key)
    if (g === undefined) groups.set(key, [r])
    else g.push(r)
  }
  let revived = 0
  for (const g of groups.values()) {
    // hostRuns are loaded id-ascending, so the last entry is the freshest.
    const latest = g[g.length - 1]
    if (latest === undefined || !isKilledClarifyContinuation(latest)) continue
    await mintNodeRun(db, {
      taskId,
      nodeId: latest.nodeId,
      status: 'pending',
      // keep the clarify lineage cause: it is what re-injects the answered Q&A.
      cause: latest.rerunCause as RerunCause,
      retryIndex: Math.max(...g.map((r) => r.retryIndex)) + 1,
      iteration: latest.iteration,
      inheritFrom: latest,
      overrides: { startedAt: null, shardKey: latest.shardKey },
    })
    revived++
  }
  if (revived > 0) {
    log.info('workgroup revived clarify continuations killed by a restart', { taskId, revived })
  }
}

/** Apply {@link decideAssignmentReconcile} to every `running` assignment ONCE at
 *  engine (re)entry so a resumed task makes progress instead of re-parking. */
/**
 * 2026-07-21 —— fc 新认领的只读成员集（见 WakeInput.readonlyMemberIds）。
 * 每 pass 查一次 agents 表（roster ≤64、fc pass 频率低）；agent 行缺失/
 * permission 解析失败一律按可写处理（保守——误判只读会让成员永远领不到卡）。
 */
async function deriveReadonlyMemberIds(
  db: DbClient,
  config: WorkgroupRuntimeConfig,
): Promise<ReadonlySet<string>> {
  // RFC-223 (PR-3a): resolve members by the CANONICAL agentId frozen at launch
  // (rename/ABA-safe). The R4-1 quarantine sentinel resolves to no agent row →
  // treated as writable (conservative — mislabeling a readonly member would
  // starve it of cards forever). Name-only legacy members fail closed.
  const agentMembers = config.members.filter((m) => m.memberType === 'agent')
  if (agentMembers.length === 0) return new Set()
  const memberHasId = (m: (typeof agentMembers)[number]) =>
    typeof m.agentId === 'string' && m.agentId.length > 0
  const ids = [...new Set(agentMembers.filter(memberHasId).map((m) => m.agentId as string))]
  if (ids.length === 0) return new Set()
  const rows = await db
    .select({ id: agents.id, permission: agents.permission })
    .from(agents)
    .where(inArray(agents.id, ids))
  const roIds = new Set<string>()
  for (const r of rows) {
    try {
      if (isReadonlyAgentPermission(JSON.parse(r.permission))) {
        roIds.add(r.id)
      }
    } catch {
      // 坏 JSON ⇒ 当可写
    }
  }
  return new Set(
    agentMembers.filter((m) => memberHasId(m) && roIds.has(m.agentId as string)).map((m) => m.id),
  )
}

/**
 * 2026-07-21 —— awaiting_human 成因（RFC-217 T2：workgroup_task_state.pause_reason
 * 键，gate/dw 槽的同款存放处）。scheduler 的 awaiting_human 分支丢弃 detail
 * （它同时服务普通任务 clarify，不该带工作组语义），所以引擎在返回前自己落
 * 成因，房间 API 借此把「预算触顶待处置」和「等待回答」区分开——此前前端把
 * 一切 awaiting_human 渲染成「等待回答」，wrap-up 停机被用户误读为有问题要答。
 *
 * 用 `json_set` 做单键原子更新（不整体读改写），不碰 gate/dw 等兄弟键。
 * 不清理：房间 API 只在 task.status === 'awaiting_human' 时读它（读方门槛），
 * 陈值永不外泄。PUT /config 的全量 JSON 覆写理论上可能吞掉一次并发写入——
 * 后果只是横幅缺失一次，可接受。
 */
async function reconcileRunningAssignments(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  log: Logger,
): Promise<void> {
  let count = 0
  for (const a of state.assignments) {
    if (a.status !== 'running') continue
    // RFC-215 §3.4 — match by the card's OWN nodeRunId (it always points at the
    // freshest run driving the card, incl. protocol-retry re-mints), not by
    // `shardKey === a.id`: a batch shard encodes ALL its card ids, so the old
    // equality never matched and every crashed batch card was mis-judged
    // `redispatch` — re-running work whose host row already finished `done`
    // (design gate ①P1-2/②F4/③F1). nodeRunId works for single-card rows too.
    const byShard = state.hostRuns.filter(
      (r) => r.nodeId === WG_MEMBER_NODE_ID && r.shardKey === a.id,
    )
    const latest =
      a.nodeRunId !== null
        ? state.hostRuns.find((r) => r.nodeId === WG_MEMBER_NODE_ID && r.id === a.nodeRunId)
        : byShard[byShard.length - 1] // running-without-run defensive fallback (pre-batch rows)
    const action = decideAssignmentReconcile(latest?.status)
    if (action === 'done') {
      if (await casAssignmentStatus(db, a.id, 'running', 'done')) count++
    } else if (action === 'redispatch') {
      if (await casAssignmentStatus(db, a.id, 'running', 'dispatched')) count++
    }
  }
  if (count > 0) log.info('workgroup reconciled running assignments on resume', { taskId, count })
}

// ---------------------------------------------------------------------------
// durable state I/O
// ---------------------------------------------------------------------------

// RFC-186 Phase 3 (audit §3-4): room slicing / cursor advance assume message ids
// order lexically (workgroupContext.ts), but plain `ulid()` has a random suffix,
// so two posts in the SAME millisecond can order out of insertion order — and at
// a cursor boundary a later-inserted lower-ULID row can be treated as consumed
// and skip a re-wake. A monotonic factory guarantees strictly increasing ids
// within this engine instance (one instance per task, runTask CAS).

// ---------------------------------------------------------------------------
// round counting (durable — derived from node_runs each pass)
// ---------------------------------------------------------------------------

// RFC-209 — 推导本体搬到 services/workgroup/rounds.ts（回合账本单一事实源），
// 引擎 / 写入侧 / 房间聚合三方读同一个数。口径未变：lw = max(wg_round) + NULL 尾巴、
// fc = 成员 run 行计数；唯一新增是「已被取代的被杀反问续跑行」排除（RFC-209 T7，
// 修的是同一逻辑回合被数两次）。

// ---------------------------------------------------------------------------
// prompt composition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

export async function runWorkgroupEngine(
  args: WorkgroupEngineArgs,
): Promise<WorkgroupEngineResult> {
  await ensureWorkgroupTaskStateRow(args.db, args.taskId)
  const { db, taskId, log } = args

  // In-flight turns keyed by a stable wake-item key. Values resolve when the
  // turn (incl. envelope effects) has been fully persisted.
  const inflight = new Map<string, Promise<void>>()
  // node_run ids MINTED BY THIS ENGINE INSTANCE. Adoption (below) exists for
  // rows created OUTSIDE the loop — clarify-answer reruns, crash recovery —
  // and must never re-drive a row a live driver just minted (the fake-hook
  // test harness surfaces this instantly; real runNode also has a pending→
  // running gap wide enough to race a fast turn completion).
  const mintedHere = new Set<string>()
  // Fatal turn errors (leader unresolvable / persistent protocol violation)
  // fail the TASK on the next pass instead of hot-looping the same wake item.
  let fatalError: { summary: string; message: string } | null = null
  const reportFatal = (summary: string, message: string): void => {
    if (fatalError === null) fatalError = { summary, message }
  }
  const inflightMeta = {
    leaderRunning: false,
    runningAssignmentIds: new Set<string>(),
    messageTurnMemberIds: new Set<string>(),
    // RFC-215 §2.1 — fc 任务轨 in-flight 成员（批 drive / 领养批行）。lw 不读它
    // （合并占用走卡状态腿），故 assignment item 不维护。
    taskTurnMemberIds: new Set<string>(),
  }

  // RFC-176: seed the goal into the room as an opening directive, ONCE, before
  // the first turn — so the leader's initial turn has actionable "new activity"
  // (not just a passive header) and the goal is visible in the room. Idempotent:
  // runTask CAS ⇒ single engine instance, and the empty-room guard means a
  // daemon restart (message already persisted) never re-seeds. leader_worker →
  // directed to the leader (chat + mention ⇒ non-public ⇒ workers never see it);
  // free_collab → public blackboard (every member decomposes it).
  {
    const seed = await loadDbState(db, taskId)
    if (
      seed !== null &&
      seed.config.mode !== 'dynamic_workflow' &&
      countBudgetUsed(seed) === 0 &&
      seed.messages.length === 0 &&
      seed.config.goal.trim().length > 0
    ) {
      const leaderId = seed.config.leaderMemberId
      const directed = seed.config.mode === 'leader_worker' && leaderId !== null
      await postMessage(db, taskId, roundMode(seed.config), {
        // RFC-209 — 前奏：开场目标先于任何回合，显式 0（countBudgetUsed(seed)===0 已由上面的守卫保证同值）。
        round: 0,
        authorKind: 'system',
        kind: 'chat',
        bodyMd: seed.config.goal.trim(),
        mentionMemberIds: directed ? [leaderId] : [],
      })
    }
  }

  // RFC-186 PR-2 — ONCE at engine (re)entry, unwedge any `running` assignment
  // whose worker node_run is already terminal (daemon-restart mid-worker-run):
  // adoption is pending-only, so without this the assignment blocks the leader
  // barrier forever and the resumed task just re-parks (audit §4/§5 F1).
  {
    const rec = await loadDbState(db, taskId)
    if (rec !== null) {
      await reconcileRunningAssignments(db, taskId, rec, log)
      // RFC-187 T13 (Codex P1-7①) — and revive any answered-clarify continuation the
      // restart killed while it was still pending; the loop's next loadDbState picks the
      // fresh pending row up through the normal adoption.
      await reviveKilledClarifyContinuations(db, taskId, rec, log)
      // RFC-187 T13 (Codex P1-7②) — an autonomous group must never sit on an open clarify,
      // but RFC-181 A2's dismissal runs OUTSIDE the config-PATCH transaction: a crash
      // between "autonomous=true committed" and "dismiss" leaves exactly that combination,
      // and (with F3) the engine would then park the task awaiting_human for an answer
      // autonomous mode promises never to ask for. Re-assert the invariant at entry instead
      // of assuming it impossible. No-op in the overwhelming common case (no open session).
      if (
        !workgroupHasHumanMember(rec.config.members) &&
        rec.config.mode !== 'dynamic_workflow' &&
        rec.clarifySessions.some((s) => s.status === 'awaiting_human')
      ) {
        const dismissed = await dismissOpenClarifyParksForAutonomous(db, taskId, rec.config.mode)
        if (dismissed.dismissedSessions > 0) {
          log.info('workgroup dismissed open clarify parks on autonomous re-entry', {
            taskId,
            dismissed: dismissed.dismissedSessions,
          })
        }
      }
    }
  }

  for (;;) {
    if (args.signal?.aborted === true) {
      await Promise.allSettled(inflight.values())
      return { kind: 'canceled' }
    }

    args.registerMint = (id: string) => mintedHere.add(id)
    if (fatalError !== null) {
      await Promise.allSettled(inflight.values())
      return { kind: 'failed', detail: fatalError }
    }

    const state = await loadDbState(db, taskId)
    if (state === null) {
      return {
        kind: 'failed',
        detail: {
          summary: 'workgroup config missing or invalid',
          message: 'workgroup_config_json unreadable',
        },
      }
    }

    // Adopt pending host rows minted outside this loop (clarify-answer
    // reruns, crash recovery) so they are driven instead of duplicated.
    const adoptable = state.hostRuns.filter(
      (r) => r.status === 'pending' && !inflight.has(`run:${r.id}`) && !mintedHere.has(r.id),
    )
    for (const row of adoptable) {
      const key = `run:${row.id}`
      // RFC-215 §3.1 — 领养行的 in-flight 登记与 markInflight 对称：批行解析出
      // 全部卡 id + 成员（parseBatchShardKey 单一编解码）；`msg:` 行补登记消息轨
      // 成员（设计门 ②F9-2：此前漏登记 ⇒ 领养消息回合在飞时同成员可被派第二个
      // 消息回合、双推游标）。
      const markAdopted = (on: boolean): void => {
        if (row.nodeId === WG_LEADER_NODE_ID) {
          inflightMeta.leaderRunning = on
          return
        }
        const shard = row.shardKey
        if (shard === null) return
        const setOp = <T>(s: Set<T>, v: T): void => void (on ? s.add(v) : s.delete(v))
        const parsedMsg = parseMsgShardKey(shard)
        if (parsedMsg !== null) {
          setOp(inflightMeta.messageTurnMemberIds, parsedMsg.memberId)
          return
        }
        const batch = parseBatchShardKey(shard)
        if (batch !== null) {
          for (const id of batch.assignmentIds) setOp(inflightMeta.runningAssignmentIds, id)
          setOp(inflightMeta.taskTurnMemberIds, batch.memberId)
          return
        }
        setOp(inflightMeta.runningAssignmentIds, shard)
        const assignee = state.assignments.find((a) => a.id === shard)?.assigneeMemberId
        if (assignee != null) setOp(inflightMeta.taskTurnMemberIds, assignee)
      }
      inflight.set(
        key,
        driveAdoptedRun(args, state, row)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            args.log.error('adopted workgroup run threw', { rowId: row.id, error: message })
            if (row.nodeId === WG_LEADER_NODE_ID) {
              reportFatal('workgroup leader turn failed', message)
            }
          })
          .finally(() => {
            inflight.delete(key)
            markAdopted(false)
          }),
      )
      markAdopted(true)
    }

    // RFC-187 F3 — a leader-host run parked on a clarify resumes via an adopted
    // clarify-answer rerun, never a fresh wake. Derived from the `__wg_clarify__`
    // rows (the old check on `hostRuns` for `__wg_leader__`+awaiting_human was dead:
    // leader runs go `done` and clarify parks land on `__wg_clarify__`, which
    // `hostRuns` didn't even load). Kept OUT of `leaderRunning` so the outcome is a
    // proper `leader-clarify` park, not a generic `running`.
    const leaderClarifyParked = deriveLeaderClarifyPark(state.clarifySessions)
    // 2026-07-21 —— 只在 fc 下取只读成员集（lw 由 leader 点名派单，不代领）。
    const readonlyMemberIds =
      state.config.mode === 'free_collab'
        ? await deriveReadonlyMemberIds(db, state.config)
        : undefined
    const wakeInput: WakeInput = {
      config: state.config,
      assignments: state.assignments,
      messages: state.messages,
      cursors: state.cursors,
      inFlight: {
        leaderRunning: inflightMeta.leaderRunning,
        runningAssignmentIds: inflightMeta.runningAssignmentIds,
        messageTurnMemberIds: inflightMeta.messageTurnMemberIds,
        taskTurnMemberIds: inflightMeta.taskTurnMemberIds,
      },
      leaderClarifyParked,
      ...(readonlyMemberIds !== undefined ? { readonlyMemberIds } : {}),
      budgetUsed: countBudgetUsed(state),
      gate: {
        declaredDone: state.gate.declaredDone,
        awaitingConfirmation: state.gate.awaitingConfirmation,
        rejected: state.gate.rejected,
      },
    }
    const wake = deriveWakeSet(wakeInput)

    for (const item of wake.items) {
      const key = wakeKey(item)
      if (inflight.has(key)) continue
      markInflight(inflightMeta, item, true)
      inflight.set(
        key,
        driveWakeItem(args, state, item, reportFatal).finally(() => {
          inflight.delete(key)
          markInflight(inflightMeta, item, false)
        }),
      )
    }

    if (inflight.size === 0) {
      const outcome = decideWorkgroupOutcome(wakeInput, wake)
      switch (outcome.kind) {
        case 'running':
          // Nothing driveable yet nothing terminal — should not happen; avoid
          // a hot loop by treating it as a human-parking stall.
          log.warn('workgroup engine: running outcome with empty in-flight set', { taskId })
          await setPauseReason(db, taskId, 'engine-stall')
          return { kind: 'awaiting_human' }
        case 'done': {
          if (state.config.mode === 'free_collab') {
            const doneCards = state.assignments.filter((a) => a.status === 'done')
            const lines = doneCards.map((a) => {
              const result =
                a.resultMessageId !== null
                  ? state.messages.find((m) => m.id === a.resultMessageId)?.bodyMd
                  : null
              return `- ${a.title}${result ? `: ${result}` : ''}`
            })
            await postMessage(db, taskId, roundMode(state.config), {
              authorKind: 'system',
              kind: 'decision',
              bodyMd:
                lines.length > 0
                  ? `free-collab converged — ${doneCards.length} task(s) done:\n${lines.join('\n')}`
                  : 'free-collab converged with no completed tasks',
            })
          }
          await cancelLeftovers(db, taskId, state)
          if (state.config.mode === 'leader_worker' && !state.gate.declaredDone) {
            // unreachable by construction (done implies declaredDone in lw)
            log.warn('workgroup engine: lw done without declaration', { taskId })
          }
          if (
            resolveCompletionGate(state.config.members, state.config.completionGate) &&
            !state.gate.approved &&
            !state.gate.awaitingConfirmation
          ) {
            await openCompletionGate(args, state)
            return {
              kind: 'awaiting_review',
              detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
            }
          }
          // RFC-187 §4 — the task is truly completing (done, no gate): flag a
          // zero-canonical-delta done so a silent empty deliverable isn't mistaken
          // for success.
          await warnIfZeroDeltaDone(args, state)
          return { kind: 'ok' }
        }
        case 'awaiting_gate': {
          if (state.gate.approved) {
            await warnIfZeroDeltaDone(args, state)
            return { kind: 'ok' } // PR-5 confirm approved
          }
          if (!state.gate.awaitingConfirmation) {
            await openCompletionGate(args, state)
          }
          return {
            kind: 'awaiting_review',
            detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
          }
        }
        case 'leader-nudge': {
          // RFC-180: an autonomous idle leader — drop a directed system nudge and
          // loop; the leader wakes on it as new content. countTrailingNudges caps
          // consecutive no-progress nudges (WG_AUTONOMOUS_NUDGE_LIMIT), and the
          // leader must actually run between nudges, so this can't hot-loop.
          const leaderId = state.config.leaderMemberId
          await postMessage(db, taskId, roundMode(state.config), {
            authorKind: 'system',
            kind: 'nudge',
            bodyMd: WG_NUDGE_BODY,
            mentionMemberIds: leaderId !== null ? [leaderId] : [],
          })
          continue
        }
        case 'awaiting_human':
          // 2026-07-21 —— scheduler 的 awaiting_human 分支丢弃 detail（它同时
          // 服务普通任务 clarify），成因经 pause_reason 列落库给房间 API。
          await setPauseReason(db, taskId, outcome.reason)
          return {
            kind: 'awaiting_human',
            detail: {
              // RFC-187 F8 — distinct summary per reason so telemetry/room don't
              // mislabel a leader blocked on a clarify as an idle leader.
              summary:
                outcome.reason === 'leader-idle'
                  ? 'workgroup idle — waiting for human input'
                  : outcome.reason === 'leader-clarify'
                    ? 'workgroup leader is waiting on a human answer to its clarify'
                    : outcome.reason === 'max-rounds-wrapup'
                      ? 'workgroup hit max_rounds with completed work — review the deliverable'
                      : 'workgroup waiting on clarify answers / human delivery',
              message: outcome.reason,
            },
          }
        case 'failed': {
          const summary =
            outcome.reason === 'max-rounds'
              ? `workgroup hit max_rounds (${state.config.maxRounds})`
              : 'free_collab deadlock: open tasks but no claimable agent member'
          await postMessage(db, taskId, roundMode(state.config), {
            authorKind: 'system',
            kind: 'system',
            bodyMd: summary,
          })
          await cancelLeftovers(db, taskId, state)
          return { kind: 'failed', detail: { summary, message: outcome.reason } }
        }
      }
    }

    await Promise.race(inflight.values())
  }
}

function wakeKey(item: WakeItem): string {
  switch (item.kind) {
    case 'leader':
      return 'leader'
    case 'assignment':
      return `assignment:${item.assignmentId}`
    case 'message_turn':
      return `msg:${item.memberId}`
    case 'fc_initial':
      return `fc-init:${item.memberId}`
    case 'fc_claim':
      // RFC-215 §3.1 — 成员维互斥：同成员至多一个 in-flight 批。
      return `claim:${item.memberId}`
  }
}

function markInflight(
  meta: {
    leaderRunning: boolean
    runningAssignmentIds: Set<string>
    messageTurnMemberIds: Set<string>
    taskTurnMemberIds: Set<string>
  },
  item: WakeItem,
  on: boolean,
): void {
  switch (item.kind) {
    case 'leader':
      meta.leaderRunning = on
      break
    case 'assignment':
      if (on) meta.runningAssignmentIds.add(item.assignmentId)
      else meta.runningAssignmentIds.delete(item.assignmentId)
      break
    case 'fc_claim':
      // RFC-215 §3.1 — 批内全部卡 + 成员一起登记（wake 的恢复判定/配对排除都读）。
      for (const id of item.assignmentIds) {
        if (on) meta.runningAssignmentIds.add(id)
        else meta.runningAssignmentIds.delete(id)
      }
      if (on) meta.taskTurnMemberIds.add(item.memberId)
      else meta.taskTurnMemberIds.delete(item.memberId)
      break
    case 'message_turn':
    case 'fc_initial':
      if (on) meta.messageTurnMemberIds.add(item.memberId)
      else meta.messageTurnMemberIds.delete(item.memberId)
      break
  }
}

async function cancelLeftovers(db: DbClient, taskId: string, state: EngineDbState): Promise<void> {
  for (const a of state.assignments) {
    if (
      a.status === 'open' ||
      a.status === 'dispatched' ||
      a.status === 'awaiting_human' ||
      a.status === 'delivered'
    ) {
      await casAssignmentStatus(db, a.id, a.status, 'canceled')
    }
  }
}

// ---------------------------------------------------------------------------
// turn drivers
// ---------------------------------------------------------------------------

async function driveWakeItem(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  item: WakeItem,
  reportFatal: (summary: string, message: string) => void,
): Promise<void> {
  const { db, taskId, log } = args
  try {
    switch (item.kind) {
      case 'leader':
        await driveLeaderTurn(args, state, undefined, item.reason === 'wrap-up')
        return
      case 'assignment': {
        const assignment = state.assignments.find((a) => a.id === item.assignmentId)
        if (assignment === undefined || assignment.assigneeMemberId === null) return
        await driveAssignmentTurn(args, state, assignment)
        return
      }
      case 'fc_claim': {
        await driveBatchTurn(args, state, item.memberId, item.assignmentIds)
        return
      }
      case 'message_turn':
      case 'fc_initial':
        await driveMessageTurn(args, state, item.memberId, item.kind === 'fc_initial')
        return
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('workgroup turn threw', { taskId, item: wakeKey(item), error: message })
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `internal error driving ${wakeKey(item)}: ${message}`,
    })
    // Convergence on throw: a leader failure is unrecoverable by the loop
    // (the same wake condition would re-fire forever) → fail the task; an
    // assignment turn that threw BEFORE reaching its own failure handling
    // (e.g. mint error) must move the row off dispatched/running or the wake
    // pass would re-derive and re-throw it forever (the 2026-07-10 hang).
    if (item.kind === 'leader') {
      reportFatal('workgroup leader turn failed', message)
    } else if (item.kind === 'assignment') {
      await settleCardAfterFailure(db, state, item.assignmentId)
    } else if (item.kind === 'fc_claim') {
      // RFC-215 §3.2-8 — 批量收口：单卡 CAS 只收一张会让其余卡留 failed 终态假收敛
      // （fc openOrActive=false ⇒ 任务假 done，设计门 ①P2-7/③F8-1）。逐卡 failed 后
      // 预算内回 open，与 driveBatchTurn 的失败路径共享同一收尾。
      for (const id of item.assignmentIds) {
        await settleCardAfterFailure(db, state, id)
      }
    }
  }
}

/** Drive a pending host row that already exists (clarify-answer rerun / crash). */
async function driveAdoptedRun(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  row: typeof nodeRuns.$inferSelect,
): Promise<void> {
  const { db, log } = args
  if (row.nodeId === WG_LEADER_NODE_ID) {
    // RFC-187 §3-7 (Codex impl-gate P1) — a wrap-up round that asked a human resumes
    // HERE (clarify-answer rerun), and the wake item's `reason:'wrap-up'` is gone. Without
    // re-deriving it the continuation loses the FINAL directive AND the dispatch-ban, so a
    // leader answering with `continue + wg_assignments` dispatches work past the cap that
    // no later round can aggregate. A leader continuation at/past the cap IS a wrap-up by
    // construction (the cap only ever grants the one grace round), so re-derive from state.
    await driveLeaderTurn(args, state, row.id, isLeaderWrapUpContinuation(state))
    return
  }
  const shardKey = row.shardKey
  const adoptedMsg = shardKey === null ? null : parseMsgShardKey(shardKey)
  if (shardKey === null || adoptedMsg !== null) {
    // adopted message turn — re-drive with the member parsed from the key
    if (adoptedMsg !== null) await driveMessageTurn(args, state, adoptedMsg.memberId, false, row.id)
    return
  }
  // RFC-215 §3.1/§3.4 — adopted batch row (clarify-answer rerun on a batch
  // shard): rebuild the batch from the key itself (memberId + card ids are
  // both encoded — no DB back-reference that a requeue could null out).
  const batch = parseBatchShardKey(shardKey)
  if (batch !== null) {
    await driveBatchTurn(args, state, batch.memberId, batch.assignmentIds, row.id)
    return
  }
  const assignment = state.assignments.find((a) => a.id === shardKey)
  if (assignment === undefined) {
    log.warn('adopted member run without assignment — cancelling row', { rowId: row.id })
    return
  }
  // clarify-answer rerun: assignment parked awaiting_human → back to running.
  let drivenStatus = assignment.status
  if (assignment.status === 'awaiting_human') {
    await casAssignmentStatus(db, assignment.id, 'awaiting_human', 'running', {
      nodeRunId: row.id,
    })
    drivenStatus = 'running'
  }
  // RFC-186 Phase 3 (audit §3-5 / F5): pass the assignment's TRUE status rather
  // than force 'running'. A crash between mintNodeRun and the dispatched→running
  // CAS leaves the row `dispatched`; forcing 'running' here made driveAssignmentTurn
  // skip its own dispatched→running CAS, so the DB stayed `dispatched`, the closing
  // running→done CAS matched 0 rows, and the assignment re-ran (duplicate). With the
  // real status, driveAssignmentTurn CASes dispatched→running itself.
  await driveAssignmentTurn(args, state, { ...assignment, status: drivenStatus }, row.id)
}
