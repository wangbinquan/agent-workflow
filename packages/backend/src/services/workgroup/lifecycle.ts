// RFC-164 PR-2 — workgroup assignment status machine (design §1.4).
//
// Pure transition table + assert helper, mirroring services/lifecycle.ts
// style (single source of truth; illegal transitions throw instead of
// silently writing). The DB CAS wrapper lands together with migration B in
// this PR (casAssignmentStatus) — engine code (PR-3) must go through it, not
// through raw UPDATEs.
//
//   open ──claim──▶ dispatched ──▶ running ──▶ done | failed
//                        │             │──▶ awaiting_human ──▶ running
//                        └─(human)──▶ delivered ──▶ done
//   failed ──▶ open        (fc re-open, bounded by defaultNodeRetries — §4.3)
//   awaiting_human ──▶ dispatched | open   (RFC-181 A2 autonomous-toggle requeue:
//       lw re-dispatches to the same member; fc recycles the card to the pool)
//   any non-terminal ──▶ canceled

import type { WorkgroupAssignmentStatus } from '@agent-workflow/shared'
import {
  parseMsgShardKey,
  parseBatchShardKey,
  resolveClarifyBudget,
  wgClarifyAskerKey,
  workgroupHasHumanMember,
} from '@agent-workflow/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  clarifyRounds,
  clarifySessions,
  nodeRuns,
  tasks,
  workgroupAssignments,
  workgroupMemberCursors,
} from '@/db/schema'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import { getNodeClarifyDirective } from '../taskClarifyDirective'
import { WG_LEADER_NODE_ID } from './constants'
import { ulid } from 'ulid'
import { KeyedSerialQueue } from '@/util/keyedSerialQueue'
import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  normalizeWgTaskTitle,
  parseWgTasksAddPort,
} from '@agent-workflow/shared'
import type { EngineDbState } from '@/services/workgroup/state'
import { roundMode } from '@/services/workgroup/rounds'
import { memberDisplayName } from '@/services/workgroup/context'
import { postMessage } from '@/services/workgroup/messages'
import { resolveMessageRound } from '@/services/workgroup/rounds'

export const WORKGROUP_ASSIGNMENT_TRANSITIONS: Record<
  WorkgroupAssignmentStatus,
  readonly WorkgroupAssignmentStatus[]
> = {
  open: ['dispatched', 'canceled'],
  dispatched: ['running', 'delivered', 'failed', 'canceled'],
  // 'dispatched': RFC-215 §3.4 — reconcileRunningAssignments 的 redispatch 腿
  // （daemon 崩溃后 host 行 interrupted，失驱的 running 卡打回 dispatched 重配）。
  // RFC-186 写下该 CAS 时表里从没有这条边：单卡时代一进 redispatch 分支即抛
  // IllegalWorkgroupAssignmentTransition 炸掉整个引擎重入（RFC-215 批恢复矩阵
  // 测试首次实锤；此前无 DB 级崩溃恢复测试覆盖到这条腿）。
  running: ['done', 'failed', 'awaiting_human', 'canceled', 'dispatched'],
  // 'dispatched'/'open': RFC-181 A2 — flipping autonomous ON dismisses an
  // in-flight clarify park and requeues the card (lw → same member; fc → pool).
  awaiting_human: ['running', 'failed', 'canceled', 'dispatched', 'open'],
  delivered: ['done', 'canceled'],
  done: [],
  // fc re-open path (design §4.3); lw retries mint NEW assignments instead.
  failed: ['open'],
  canceled: [],
}

export const WORKGROUP_ASSIGNMENT_TERMINAL: ReadonlySet<WorkgroupAssignmentStatus> = new Set([
  'done',
  'canceled',
])

export class IllegalWorkgroupAssignmentTransition extends Error {
  constructor(
    public readonly from: WorkgroupAssignmentStatus,
    public readonly to: WorkgroupAssignmentStatus,
  ) {
    super(`illegal workgroup assignment transition ${from} → ${to}`)
    this.name = 'IllegalWorkgroupAssignmentTransition'
  }
}

export function canTransitionAssignment(
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
): boolean {
  return WORKGROUP_ASSIGNMENT_TRANSITIONS[from].includes(to)
}

export function assertAssignmentTransition(
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
): void {
  if (!canTransitionAssignment(from, to)) {
    throw new IllegalWorkgroupAssignmentTransition(from, to)
  }
}

/**
 * RFC-217 T6 — non-status run-pointer refresh (protocol retries re-point the
 * card at the newest attempt row). Kept here so `update(workgroupAssignments)`
 * has ONE owning module (write-side single source; the D4 drift family).
 */
export async function repointAssignmentRun(
  db: DbClient,
  assignmentId: string,
  nodeRunId: string,
): Promise<void> {
  await db
    .update(workgroupAssignments)
    .set({ nodeRunId, updatedAt: Date.now() })
    .where(eq(workgroupAssignments.id, assignmentId))
}

/**
 * Compare-and-set an assignment's status: the UPDATE only lands when the row
 * is still in `from` (concurrent engine/HTTP writers race safely — the loser
 * gets `false` and re-reads). Illegal (from → to) pairs throw regardless.
 * Optional `set` piggybacks column writes (nodeRunId, assignee, result link)
 * onto the same guarded UPDATE.
 */
export async function casAssignmentStatus(
  db: DbClient,
  assignmentId: string,
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
  set: Partial<typeof workgroupAssignments.$inferInsert> = {},
  opts: {
    /**
     * RFC-215 §3.2-2 — 认领即计数：open→dispatched 落地的同一条守卫 UPDATE 里
     * SQL 自增 attempt_count。必须走表达式（快照+1 有丢增窗口——同 pass 另一
     * drive 让卡走完 claim→failed→open 后，陈旧快照会覆盖真值）。
     */
    bumpAttempt?: boolean
  } = {},
): Promise<boolean> {
  assertAssignmentTransition(from, to)
  const rows = await db
    .update(workgroupAssignments)
    .set({
      ...set,
      status: to,
      updatedAt: Date.now(),
      ...(opts.bumpAttempt === true
        ? { attemptCount: sql`${workgroupAssignments.attemptCount} + 1` }
        : {}),
    })
    .where(and(eq(workgroupAssignments.id, assignmentId), eq(workgroupAssignments.status, from)))
    .returning({ taskId: workgroupAssignments.taskId })
  const landed = rows.length > 0
  if (landed && rows[0] !== undefined) {
    // Single broadcast point for every assignment status flip (engine, room
    // routes, PR-5 delivery/confirm all ride it) — room cards update live.
    taskBroadcaster.broadcast(TASK_CHANNEL(rows[0].taskId), {
      id: -1,
      type: 'wg.assignment.updated',
      assignmentId,
      status: to,
    })
  }
  return landed
}

/**
 * Transactional companion of casAssignmentStatus. The caller owns the outer
 * dbTxSync transaction and broadcasts only after commit. This is required for
 * operations such as human delivery and roster edits where the assignment
 * transition and its companion message/config rows form one business fact.
 */
export function casAssignmentStatusTx(
  tx: DbTxSync,
  assignmentId: string,
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
  set: Partial<typeof workgroupAssignments.$inferInsert> = {},
): boolean {
  assertAssignmentTransition(from, to)
  const updated = tx
    .update(workgroupAssignments)
    .set({ ...set, status: to, updatedAt: Date.now() })
    .where(and(eq(workgroupAssignments.id, assignmentId), eq(workgroupAssignments.status, from)))
    .returning({ id: workgroupAssignments.id })
    .all()
  return updated.length > 0
}

/**
 * Advance a member's consumption cursor to `messageId` — monotonic (a stale
 * writer can never move it backwards), UPSERT on first touch. Engine calls
 * this in the same transaction that mints the member's run (design §1.6).
 */
export async function advanceMemberCursor(
  db: DbClient,
  taskId: string,
  memberId: string,
  messageId: string,
): Promise<void> {
  await db
    .insert(workgroupMemberCursors)
    .values({ taskId, memberId, lastConsumedMessageId: messageId, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [workgroupMemberCursors.taskId, workgroupMemberCursors.memberId],
      set: {
        lastConsumedMessageId: sql`max(${workgroupMemberCursors.lastConsumedMessageId}, excluded.last_consumed_message_id)`,
        updatedAt: Date.now(),
      },
    })
}

/**
 * RFC-181 C — envelope-time suppression oracle: read the task's CURRENT
 * frozen-config `autonomous` (per-task PATCH can flip it mid-run, RFC-181 A).
 * The workgroup hook consults this right before opening a clarify session so
 * a run dispatched with ask-back allowed cannot park the task after the
 * launcher toggled autonomous ON (design-gate P1-①).
 */
/**
 * RFC-207 — is ask-back suppressed for this task, i.e. does its FROZEN roster
 * hold no human member? Read live from `tasks.workgroup_config_json` (the copy
 * the engine and the mid-run config PATCH share), so removing the last human
 * takes effect on the very next check rather than the next launch.
 *
 * Missing / unparseable config ⇒ NOT suppressed. An unreadable snapshot is an
 * anomaly, and letting a question through so a human can look is the safe
 * failure — the same direction the RFC-180 predecessor took.
 */
export async function isTaskClarifySuppressed(
  db: DbClient,
  taskId: string,
  /** RFC-207 — when given, the per-asker ask-back budget is enforced too. */
  nodeId?: string,
  shardKey?: string | null,
): Promise<boolean> {
  const row = (
    await db
      .select({ cfg: tasks.workgroupConfigJson })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (row === undefined || row.cfg === null) return false
  try {
    const parsed = JSON.parse(row.cfg) as { members?: unknown; clarifyBudget?: number }
    if (!Array.isArray(parsed.members)) return false
    const members = parsed.members.filter(
      (m): m is { memberType: 'agent' | 'human' } =>
        typeof m === 'object' && m !== null && 'memberType' in m,
    )
    if (!workgroupHasHumanMember(members)) return true
    // A stubborn agent must not out-ask its budget by emitting anyway, so the
    // envelope gate enforces the same ceiling the invite gate used.
    if (nodeId === undefined) return false
    const budget = resolveClarifyBudget({ clarifyBudget: parsed.clarifyBudget })
    if (budget <= 0) return true
    const askerKey = wgClarifyAskerKey(nodeId, shardKey ?? null, WG_LEADER_NODE_ID)
    if ((await getNodeClarifyDirective(db, taskId, nodeId, askerKey)) === 'stop') return true
    const asked = await countWgClarifyAsks(db, taskId, askerKey)
    return asked >= budget
  } catch {
    return false
  }
}

export interface AutonomousDismissalResult {
  dismissedSessions: number
  canceledParkRuns: Array<{ nodeRunId: string; nodeId: string }>
  requeuedAssignments: Array<{ id: string; to: WorkgroupAssignmentStatus }>
}

/**
 * RFC-181 A2 — flipping `autonomous` false→true dismisses every in-flight
 * clarify park of the task so the engine can actually move on (without this,
 * the toggle is a no-op for a task that is ALREADY ping-ponging questions —
 * the very scenario the switch exists for).
 *
 * ONE dbTxSync transaction (mirrors clarifySeal's atomic pattern): sessions
 * are re-read INSIDE the transaction and all writes commit together, so a
 * concurrent answer submission serializes against the dismissal — the loser's
 * CAS misses and the stale answer is rejected by the session-status guard on
 * the answer route. Broadcasts fire after commit (never inside).
 *
 * Per open session: session row → canceled; its park-carrier clarify run
 * (`clarifyNodeRunId`, status awaiting_human) → canceled; when the source
 * shard is an assignment (worker park), the card requeues via the A2 edges
 * (lw awaiting_human→dispatched same member / fc →open recycled to the pool).
 * Leader / message-turn sessions (shard null / `msg:*`) have no card to
 * requeue — the resumed engine's autonomous idle-nudge re-wakes the leader.
 */
export async function dismissOpenClarifyParksForAutonomous(
  db: DbClient,
  taskId: string,
  mode?: string,
): Promise<AutonomousDismissalResult> {
  const result: AutonomousDismissalResult = {
    dismissedSessions: 0,
    canceledParkRuns: [],
    requeuedAssignments: [],
  }
  // Callers that hold the parsed config pass mode; the workgroup hook's
  // post-create compensation path (impl-gate P1-③) omits it — resolve from
  // the task's frozen config (requeue target only matters for worker parks,
  // which cannot exist in that window, so a fallback default is safe).
  const resolvedMode =
    mode ??
    (await (async () => {
      const row = (
        await db
          .select({ cfg: tasks.workgroupConfigJson })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
      )[0]
      if (row === undefined || row.cfg === null) return 'leader_worker'
      try {
        const parsed = JSON.parse(row.cfg) as { mode?: unknown }
        return typeof parsed.mode === 'string' ? parsed.mode : 'leader_worker'
      } catch {
        return 'leader_worker'
      }
    })())
  dbTxSync(db, (tx) => {
    const open = tx
      .select()
      .from(clarifySessions)
      .where(and(eq(clarifySessions.taskId, taskId), eq(clarifySessions.status, 'awaiting_human')))
      .all()
    for (const s of open) {
      tx.update(clarifySessions)
        .set({ status: 'canceled' })
        .where(and(eq(clarifySessions.id, s.id), eq(clarifySessions.status, 'awaiting_human')))
        .run()
      result.dismissedSessions++
      // Park-carrier clarify run → canceled in the SAME transaction (the
      // asking host run already closed as done/failed — RFC-181 design §2.1a).
      // rfc053-allow-direct-status-write -- RFC-181 A2 atomic dismissal (guarded
      // awaiting_human-only UPDATE inside dbTxSync; async lifecycle helpers
      // cannot join a sync transaction).
      const parked = tx
        .update(nodeRuns)
        .set({
          status: 'canceled',
          finishedAt: Date.now(),
          errorMessage: 'wg-clarify-disabled',
        })
        .where(and(eq(nodeRuns.id, s.clarifyNodeRunId), eq(nodeRuns.status, 'awaiting_human')))
        .returning({ id: nodeRuns.id })
        .all()
      if (parked.length > 0) {
        result.canceledParkRuns.push({ nodeRunId: s.clarifyNodeRunId, nodeId: s.clarifyNodeId })
      }
      // Impl-gate P1-② — the AUTHORITATIVE clarify round row (RFC-058 dual
      // write): /api/clarify, drafts and sealRoundQuestions all read
      // clarify_rounds, so canceling only the legacy session row would leave
      // the question answerable — a stale answer could still seal the round
      // and mint a continuation. Same tx, same awaiting_human-only guard.
      tx.update(clarifyRounds)
        .set({ status: 'canceled' })
        .where(
          and(
            eq(clarifyRounds.taskId, taskId),
            eq(clarifyRounds.intermediaryNodeRunId, s.clarifyNodeRunId),
            eq(clarifyRounds.status, 'awaiting_human'),
          ),
        )
        .run()
      const shard = s.sourceShardKey
      if (shard !== null && parseMsgShardKey(shard) === null) {
        // RFC-215 §9 — 批 run 的 park 卡是一组：shardKey 编入整批卡 id，单卡等值
        // 匹配对 `batch:` 键恒 0 行（设计门 ①P1-3/②F2：整批永滞留 awaiting_human）。
        const batch = parseBatchShardKey(shard)
        const cardIds = batch !== null ? batch.assignmentIds : [shard]
        const to: WorkgroupAssignmentStatus = resolvedMode === 'free_collab' ? 'open' : 'dispatched'
        assertAssignmentTransition('awaiting_human', to)
        const requeued = tx
          .update(workgroupAssignments)
          .set({
            status: to,
            nodeRunId: null,
            ...(resolvedMode === 'free_collab' ? { assigneeMemberId: null } : {}),
            updatedAt: Date.now(),
          })
          .where(
            and(
              inArray(workgroupAssignments.id, cardIds),
              eq(workgroupAssignments.taskId, taskId),
              eq(workgroupAssignments.status, 'awaiting_human'),
            ),
          )
          .returning({ id: workgroupAssignments.id })
          .all()
        for (const r of requeued) result.requeuedAssignments.push({ id: r.id, to })
      }
    }
  })
  for (const r of result.canceledParkRuns) {
    taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
      id: -1,
      type: 'node.status',
      nodeRunId: r.nodeRunId,
      nodeId: r.nodeId,
      status: 'canceled',
    })
  }
  for (const a of result.requeuedAssignments) {
    taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
      id: -1,
      type: 'wg.assignment.updated',
      assignmentId: a.id,
      status: a.to,
    })
  }
  return result
}

/**
 * RFC-207 §3.6 — how many times this ONE asker has already asked the humans.
 *
 * Counted from `clarify_sessions` (the real record of questions asked), NOT from
 * the run generations `priorDoneGenerationsForRun` returns: that counts every
 * completed top-level run at the node, and the workgroup LEADER runs once per
 * ordinary round — so after a few plain rounds it would report a budget already
 * spent and reject the leader's very first question.
 *
 * Askers are identified by {@link wgClarifyAskerKey}, so a member woken by many
 * different messages stays ONE asker instead of minting a fresh budget each time.
 */
export async function countWgClarifyAsks(
  db: DbClient,
  taskId: string,
  askerKey: string,
): Promise<number> {
  const rows = await db
    .select({ nodeId: clarifySessions.sourceAgentNodeId, shard: clarifySessions.sourceShardKey })
    .from(clarifySessions)
    .where(eq(clarifySessions.taskId, taskId))
  return rows.filter((r) => wgClarifyAskerKey(r.nodeId, r.shard, WG_LEADER_NODE_ID) === askerKey)
    .length
}

/**
 * RFC-207 §1.3 / §3.7.2 — may this asker ask a human right now? THE single
 * resolution point: the dispatch side feeds it to the prompt renderer AND to
 * `clarifyEnabled`, and the envelope side negates it. Resolving it twice is how
 * a prompt ends up inviting a question the runner then rejects.
 */
export async function resolveWgClarifyAllowed(
  db: DbClient,
  taskId: string,
  members: ReadonlyArray<{ memberType: 'agent' | 'human' }>,
  clarifyBudget: number | undefined,
  nodeId: string,
  shardKey: string | null,
): Promise<boolean> {
  if (!workgroupHasHumanMember(members)) return false
  const budget = resolveClarifyBudget({ clarifyBudget })
  if (budget <= 0) return false
  const askerKey = wgClarifyAskerKey(nodeId, shardKey, WG_LEADER_NODE_ID)
  // A human explicitly told THIS asker to stop — that outranks any leftover budget.
  if ((await getNodeClarifyDirective(db, taskId, nodeId, askerKey)) === 'stop') return false
  const asked = await countWgClarifyAsks(db, taskId, askerKey)
  return asked < budget
}

// ---------------------------------------------------------------------------
// RFC-217 T3 — wg_tasks_add consumption (moved verbatim from runner.ts): fc
// card creation with normalized-title dedup, serialized per task.
// ---------------------------------------------------------------------------

// Per-task serialization for tasks_add consumption: two member turns
// finishing in the same tick would otherwise interleave their dedup read
// and insert (TOCTOU). One engine instance per task is guaranteed by the
// runTask CAS claim, so an in-process chain fully closes the race.
const tasksAddQueue = new KeyedSerialQueue<string>()
function serializeTasksAdd<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  return tasksAddQueue.run(taskId, fn)
}

/**
 * PR-6 (design §7.3) — consume a member's wg_tasks_add: normalized-title
 * dedup against every non-canceled card; dropped duplicates get a system
 * note instead of failing the run. Returns how many landed. Serialized
 * per task (see serializeTasksAdd).
 */
export async function consumeTasksAdd(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  authorMemberId: string,
  raw: string | undefined,
): Promise<number> {
  if (raw === undefined || state.config.mode !== 'free_collab') return 0
  return serializeTasksAdd(taskId, () =>
    consumeTasksAddInner(db, taskId, state, authorMemberId, raw),
  )
}

async function consumeTasksAddInner(
  db: DbClient,
  taskId: string,
  state: EngineDbState,
  authorMemberId: string,
  raw: string,
): Promise<number> {
  const parsed = parseWgTasksAddPort(raw)
  if (!parsed.ok) {
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `wg_tasks_add from @${memberDisplayName(state.config, authorMemberId)} rejected: ${parsed.errors.join('; ')}`,
    })
    return 0
  }
  // RFC-209 — 解析一次，本次消费产出的所有卡与消息共用（同一批产出必须同回合号）。
  const cardRound = await resolveMessageRound(db, taskId, roundMode(state.config))
  // LIVE read (not the turn-start snapshot): concurrent initial turns must
  // see each other's just-landed cards or the dedup guard is a no-op
  // (fc-debug 2026-07-10: dup card claimed 4×). A same-instant insert race
  // remains theoretically possible and is documented as v1 residual.
  const liveRows = await db
    .select({ dedupKey: workgroupAssignments.dedupKey, status: workgroupAssignments.status })
    .from(workgroupAssignments)
    .where(eq(workgroupAssignments.taskId, taskId))
  const existing = new Set(
    liveRows
      .filter((a) => a.status !== 'canceled' && a.dedupKey !== null)
      .map((a) => a.dedupKey as string),
  )
  let added = 0
  let dropped = 0
  for (const item of parsed.value) {
    const key = normalizeWgTaskTitle(item.title)
    if (existing.has(key)) {
      dropped++
      continue
    }
    existing.add(key)
    const id = ulid()
    await db.insert(workgroupAssignments).values({
      id,
      taskId,
      // RFC-209 — 卡的回合号取写入时刻的解析值（`consumeTasksAdd` 只在 fc 下进来，
      // 故恒 0：自由协作没有回合语义，此前这里写的是**过期快照**里的成员 run 累计数）。
      round: cardRound,
      source: 'self_claim',
      assigneeMemberId: null,
      title: item.title,
      briefMd: item.brief,
      status: 'open',
      dedupKey: key,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'member',
      authorMemberId,
      kind: 'dispatch',
      bodyMd: `+ task: ${item.title}`,
      assignmentId: id,
    })
    added++
  }
  if (dropped > 0) {
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `${dropped} duplicate task(s) from @${memberDisplayName(state.config, authorMemberId)} dropped (title dedup)`,
    })
  }
  return added
}

/**
 * RFC-215 §3.2/§3.5 — 卡失败收尾的单一子例程（drive throw / run 失败 / 漏报耗尽
 * 共用，禁 fork）：dispatched/running → failed，fc 下预算内（attempt_count <
 * DEFAULT_PROTOCOL_RETRY_BUDGET）再 failed → open 重新入池。lw 卡停在 failed
 * （leader 下轮决策重派/放弃，RFC-164 §4.3 原语义）。
 */
export async function settleCardAfterFailure(
  db: DbClient,
  state: EngineDbState,
  assignmentId: string,
): Promise<void> {
  const failedFromDispatched = await casAssignmentStatus(
    db,
    assignmentId,
    'dispatched',
    'failed',
  ).catch(() => false)
  if (!failedFromDispatched) {
    const failedFromRunning = await casAssignmentStatus(
      db,
      assignmentId,
      'running',
      'failed',
    ).catch(() => false)
    if (!failedFromRunning) return // already terminal / moved on — nothing to reopen
  }
  if (state.config.mode !== 'free_collab') return
  const row = (
    await db
      .select({ attemptCount: workgroupAssignments.attemptCount })
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.id, assignmentId))
  )[0]
  if (row !== undefined && row.attemptCount < DEFAULT_PROTOCOL_RETRY_BUDGET) {
    await casAssignmentStatus(db, assignmentId, 'failed', 'open', {
      assigneeMemberId: null,
      nodeRunId: null,
    }).catch(() => false)
  }
}
