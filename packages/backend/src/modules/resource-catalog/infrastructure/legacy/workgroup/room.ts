// RFC-179 / RFC-182 — workgroup room runtime visibility: derive the room's
// FULL execution history (`runHistory`, RFC-182 G5 single source) and each
// member's "current session run" (`memberRuns`, a projection of the history —
// running wins, else newest) from the task's host node_runs. Pure + read-only;
// the result NEVER feeds a prompt (design §11 prompt-isolation invariant) —
// it is room/UI rendering only.
//
// Run classification is by nodeId + shardKey SHAPE (RFC-182 design-gate P1 —
// NOT by rerun_cause: a clarify-answer host rerun keeps its shard lineage but
// carries `rerunCause='clarify-answer'`, and a cause-keyed classifier drops
// the resumed session from history AND memberRuns — the member looks idle
// while its resumed run executes):
//   __wg_leader__  (rerunCause≠wg-gate)      → leader-round
//   __wg_member__ + shardKey `msg:*`         → message-turn (msg:${memberId}:${maxMsgId})
//   __wg_member__ + shardKey ∈ assignment id → assignment
// `wg-gate` stays a cause-based EXCLUSION (the completion-gate holder run is
// not a leader thinking round — aligns with workgroupRunner.ts:361).

import {
  WorkgroupRuntimeConfigSchema,
  type WorkgroupRuntimeConfig,
  CANCELABLE_TASK_STATUSES,
} from '@agent-workflow/shared'
import { z } from 'zod'

const JsonObjectSchema = z.record(z.string(), z.unknown())

/**
 * RFC-329 —— one workgroup task that is waiting on a human, as seen by ONE actor.
 *
 * `pendingDeliveries` is per-actor (cards dispatched to the member ids this actor
 * holds in that room), while `awaitingConfirmation` is a property of the task
 * itself. A row can carry both at once, which is why the count derived from
 * these rows adds them rather than picking one.
 */
interface WorkgroupPendingRow {
  readonly taskId: string
  readonly name: string
  readonly status: string
  readonly gateStatus: string | null
  readonly awaitingConfirmation: boolean
  readonly pendingDeliveries: number
}
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  clarifyRounds,
  nodeRuns,
  taskNodeClarifyDirectives,
  tasks,
  workgroupAssignments,
  workgroupMessages,
  workgroupTaskState,
} from '@/db/schema'
import { visibleTaskIdsOf } from '@/services/taskAuthorization'
import { chunkedAll } from '@/util/sqlChunk'
import {
  deriveBudgetUsed,
  deriveMemberCurrentRuns,
  deriveWorkgroupRunHistory,
  parseStoredTemplateMetadata,
  roundedModeOf,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'
export {
  deriveMemberCurrentRuns,
  deriveWorkgroupRunHistory,
  type AssignmentLite,
  type HostRunLite,
  type MemberLite,
  type MessageLite,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'
import {
  gateViewOf,
  type WorkgroupTaskState,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroup/state'
import {
  resolveRoomPauseReason,
  safeMentions,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroup/taskActions'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from './constants'

// ---------------------------------------------------------------------------
// RFC-217 T4 — room aggregate + inbox pending-count (moved from routes; the
// projection primitives above stay pure, these two own the queries).
// ---------------------------------------------------------------------------

export function buildRoomReads(
  deps: { db: DbClient },
  core: {
    loadVisibleWorkgroupTask: (
      actor: Actor,
      taskId: string,
    ) => Promise<{
      task: {
        id: string
        ownerUserId: string | null
        status: string
        workgroupId: string | null
        workgroupConfigJson: string | null
      }
      config: WorkgroupRuntimeConfig
      raw: Record<string, unknown>
      state: WorkgroupTaskState
    }>
  },
) {
  const { loadVisibleWorkgroupTask } = core
  /**
   * RFC-329 —— 每一个「在等人」的工作组任务，逐行。
   *
   * `pendingCount` 以前就把这批行整个算了出来（可见性过滤、gate 判定、逐人待交付卡片），
   * 然后只返回三个数字。于是 `list_pending_gates` 想列出工作组门时无处可取——REST 上
   * 只有一个 badge 计数和一个单任务房间。这里把行拿回来，计数改由它派生：两个端点因此
   * 不可能对同一个 actor 给出不同的答案。
   */
  async function pendingRows(actor: Actor): Promise<WorkgroupPendingRow[]> {
    const rows = await deps.db
      .select({
        id: tasks.id,
        name: tasks.name,
        ownerUserId: tasks.ownerUserId,
        status: tasks.status,
        workgroupConfigJson: tasks.workgroupConfigJson,
      })
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.workgroupId),
          // RFC-317 T51（LC-06）—— 从转移表派生，不再内联手抄。
          inArray(tasks.status, [...CANCELABLE_TASK_STATUSES]),
        ),
      )
    // RFC-217 T2 — one batch read for every candidate's gate status (the old
    // per-row `$.gate` JSON poke is retired with the slot itself).
    const stateRows =
      rows.length > 0
        ? await deps.db
            .select({
              taskId: workgroupTaskState.taskId,
              gateStatus: workgroupTaskState.gateStatus,
            })
            .from(workgroupTaskState)
            .where(
              inArray(
                workgroupTaskState.taskId,
                rows.map((r) => r.id),
              ),
            )
        : []
    const gateStatusById = new Map(stateRows.map((r) => [r.taskId, r.gateStatus]))
    // RFC-311: the per-candidate canViewTask (one collaborator query each) and
    // per-candidate assignments query both ran on the 15s badge poll (audit
    // L1-5). Batch both: one visibility membership query, one dispatched-cards
    // query grouped in JS. The zod parse stays per-row — memberIds live inside
    // the config JSON and the candidate set is bounded by active workgroups.
    const visibleIds = await visibleTaskIdsOf(
      deps.db,
      actor,
      rows.map((r) => r.id),
    )
    const dispatchedByTask = new Map<string, (string | null)[]>()
    if (visibleIds.size > 0) {
      const cards = await chunkedAll([...visibleIds], (ids) =>
        deps.db
          .select({
            taskId: workgroupAssignments.taskId,
            assigneeMemberId: workgroupAssignments.assigneeMemberId,
          })
          .from(workgroupAssignments)
          .where(
            and(
              inArray(workgroupAssignments.taskId, ids),
              eq(workgroupAssignments.status, 'dispatched'),
            ),
          ),
      )
      for (const card of cards) {
        const bucket = dispatchedByTask.get(card.taskId)
        if (bucket === undefined) dispatchedByTask.set(card.taskId, [card.assigneeMemberId])
        else bucket.push(card.assigneeMemberId)
      }
    }
    const out: WorkgroupPendingRow[] = []
    for (const row of rows) {
      if (row.workgroupConfigJson === null) continue
      if (!visibleIds.has(row.id)) continue
      let raw: Record<string, unknown>
      try {
        raw = JsonObjectSchema.parse(JSON.parse(row.workgroupConfigJson))
      } catch {
        continue
      }
      const parsed = WorkgroupRuntimeConfigSchema.safeParse(raw)
      if (!parsed.success) continue
      const gateStatus = gateStatusById.get(row.id) ?? null
      const awaitingConfirmation =
        gateStatus === 'awaiting_confirmation' && row.status === 'awaiting_review'
      const myMemberIds = new Set(
        parsed.data.members
          .filter((m) => m.memberType === 'human' && m.userId === actor.user.id)
          .map((m) => m.id),
      )
      // A row with no membership for this actor still counts as a gate (that was
      // the pre-RFC-329 behaviour: `gates++` happened before the membership
      // check), it just contributes no deliveries.
      const pendingDeliveries =
        myMemberIds.size === 0
          ? 0
          : (dispatchedByTask.get(row.id) ?? []).filter(
              (assignee) => assignee !== null && myMemberIds.has(assignee),
            ).length
      if (!awaitingConfirmation && pendingDeliveries === 0) continue
      out.push({
        taskId: row.id,
        name: row.name,
        status: row.status,
        gateStatus,
        awaitingConfirmation,
        pendingDeliveries,
      })
    }
    return out
  }

  /**
   * The left-nav badge. Derived from `pendingRows` so the two can never disagree
   * — the shape is byte-identical to what it returned before RFC-329.
   */
  async function pendingCount(actor: Actor) {
    const rows = await pendingRows(actor)
    const gates = rows.filter((row) => row.awaitingConfirmation).length
    const deliveries = rows.reduce((sum, row) => sum + row.pendingDeliveries, 0)
    return { deliveries, gates, total: deliveries + gates }
  }

  async function roomAggregate(actor: Actor, taskId: string) {
    const { task, config, state } = await loadVisibleWorkgroupTask(actor, taskId)
    const [messages, assignments, hostRuns] = await Promise.all([
      deps.db
        .select()
        .from(workgroupMessages)
        .where(eq(workgroupMessages.taskId, taskId))
        .orderBy(asc(workgroupMessages.id)),
      deps.db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.taskId, taskId))
        .orderBy(asc(workgroupAssignments.id)),
      // RFC-179/182 — host runs (leader-round / assignment / message-turn) for
      // the runHistory + per-member currentRun derivation; read-only, never
      // enters a prompt. startedAt/finishedAt feed the turn cards' durations;
      // failureCode ONLY feeds the server-side `note` derivation (structured
      // column — RFC-145 forbids errorMessage machine reads; the protocol
      // strings never cross the wire — RFC-182 D11).
      deps.db
        .select({
          id: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          shardKey: nodeRuns.shardKey,
          status: nodeRuns.status,
          rerunCause: nodeRuns.rerunCause,
          startedAt: nodeRuns.startedAt,
          finishedAt: nodeRuns.finishedAt,
          failureCode: nodeRuns.failureCode,
          agentOverrideName: nodeRuns.agentOverrideName,
          agentOverrideId: nodeRuns.agentOverrideId,
          // RFC-209 —— 两个用途共用这一列：① 回合账本读数（右栏预算表 budgetUsed）；
          // ② leader 回合卡的轮序数（RFC-189 之后它才是权威，取代从消息 round 反推）。
          wgRound: nodeRuns.wgRound,
        })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            inArray(nodeRuns.nodeId, [WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID]),
          ),
        ),
    ])
    const assignmentsLite = assignments.map((a) => ({
      id: a.id,
      assigneeMemberId: a.assigneeMemberId,
    }))
    const messagesLite = messages.map((m) => ({
      id: m.id,
      mentionMemberIds: safeMentions(m.mentionsJson),
      authorMemberId: m.authorMemberId,
      round: m.round,
    }))
    // RFC-182 impl-gate P1 — open clarify parks: the asking host run's DB row
    // is `done` while the park lives on the intermediary clarify run, so the
    // derivation projects `awaiting_human` onto entries whose run has an OPEN
    // session (turn card / presence read「等待回答」instead of「完成/空闲」).
    const openClarify = await deps.db
      .select({ sourceRunId: clarifyRounds.askingNodeRunId })
      .from(clarifyRounds)
      .where(
        and(
          eq(clarifyRounds.kind, 'self'),
          eq(clarifyRounds.taskId, taskId),
          eq(clarifyRounds.status, 'awaiting_human'),
        ),
      )
    const openClarifySourceRunIds = new Set(openClarify.map((r) => r.sourceRunId))
    // RFC-182 G5 — the room's full execution history (ascending, single
    // source); RFC-179's memberRuns is its projection (running wins, else
    // newest) so the two can never drift.
    const runHistory = deriveWorkgroupRunHistory(
      config.members,
      config.leaderMemberId,
      hostRuns,
      assignmentsLite,
      messagesLite,
      { openClarifySourceRunIds },
    )
    const memberRuns = deriveMemberCurrentRuns(
      config.members,
      config.leaderMemberId,
      hostRuns,
      assignmentsLite,
      messagesLite,
      { openClarifySourceRunIds },
    )
    // RFC-209 —— 已用回合数：与 max_rounds 触顶判据**同源**（同一个 deriveBudgetUsed，
    // 且这里的 host-run 过滤条件与引擎 loadDbState 逐字相同），所以右栏预算表显示的
    // 数字就是真正决定任务生死的那个。零新查询——复用上面已经加载的 hostRuns。
    // dynamic_workflow 没有回合账本 ⇒ 0（UI 只在 free_collab 渲染）。
    const roundedMode = roundedModeOf(config.mode)
    const budgetUsed = roundedMode === null ? 0 : deriveBudgetUsed(roundedMode, hostRuns)
    // RFC-207 §3.7.5 — which askers a human has silenced. Stopping is a REVERSIBLE
    // state, not a one-way door: without surfacing it the room offers no way back
    // (the canvas toggle that ordinary tasks use does not exist for workgroups).
    // Keyed by asker (leader / asg:<id> / mem:<id>) so each can be resumed alone.
    const stopRows = await deps.db
      .select({
        nodeId: taskNodeClarifyDirectives.nodeId,
        shardKey: taskNodeClarifyDirectives.shardKey,
        directive: taskNodeClarifyDirectives.directive,
      })
      .from(taskNodeClarifyDirectives)
      .where(eq(taskNodeClarifyDirectives.taskId, taskId))
    const clarifyStops = stopRows
      .filter((r) => r.directive === 'stop' && r.shardKey !== '')
      .map((r) => ({ nodeId: r.nodeId, askerKey: r.shardKey }))

    return {
      taskId,
      taskStatus: task.status,
      config,
      clarifyStops,
      budgetUsed,
      // 2026-07-21 —— awaiting_human 的成因（引擎写入 wgPause 槽；见
      // workgroupRunner.writeWgPauseReason）。读方门槛：只在任务当前就停在
      // awaiting_human 时外泄，陈值（上次停机残留）永不出现——所以槽无需清理。
      // 前端据此把「预算触顶待处置」与「等待回答」区分开。
      pauseReason: resolveRoomPauseReason(task.status, state.pauseReason),
      // RFC-217 T2 — the wire shape stays the legacy boolean view; the stored
      // truth is workgroup_task_state.gate_status (gateViewOf derivation).
      gate: (() => {
        const v = gateViewOf(state)
        return {
          declaredDone: v.declaredDone,
          awaitingConfirmation: v.awaitingConfirmation,
          rejected: v.rejected,
          summary: v.summary ?? null,
        }
      })(),
      // RFC-167 PR-3 — the dynamic-workflow checkpoint (phase / generatedDef /
      // rejection bookkeeping). null for turn-engine tasks; served straight
      // from workgroup_task_state.
      dw: state.dwState,
      // RFC-217 T5（design §3）—— fc 无波次语义：round 对外显式 null（DB 仍存
      // 0；lw 原值直出）。前端据 null 跳过分隔线/回合徽记，而不是靠「恒 0 不
      // 触发水位线」的隐式巧合。
      messages: messages.map((m) => {
        const template = parseStoredTemplateMetadata(m.templateKey, m.templateParamsJson)
        return {
          id: m.id,
          round: roundedMode === 'free_collab' ? null : m.round,
          authorKind: m.authorKind,
          authorMemberId: m.authorMemberId,
          authorUserId: m.authorUserId,
          kind: m.kind,
          bodyMd: m.bodyMd,
          templateKey: template?.key ?? null,
          templateParams: template?.params ?? null,
          mentionMemberIds: safeMentions(m.mentionsJson),
          assignmentId: m.assignmentId,
          triggerMessageId: m.triggerMessageId,
          createdAt: m.createdAt,
        }
      }),
      assignments: assignments.map((a) => ({
        id: a.id,
        round: roundedMode === 'free_collab' ? null : a.round,
        source: a.source,
        createdByUserId: a.createdByUserId,
        assigneeMemberId: a.assigneeMemberId,
        title: a.title,
        briefMd: a.briefMd,
        status: a.status,
        nodeRunId: a.nodeRunId,
        resultMessageId: a.resultMessageId,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      // RFC-179 — { [memberId]: currentRun | null }; drives 点成员看 session + 执行中指示.
      memberRuns,
      // RFC-182 — 全量回合历史（升序）；回合卡 / 执行记录 / drawer 成员历轮的单一数据源。
      runHistory,
    }
  }

  return { pendingCount, pendingRows, roomAggregate }
}
