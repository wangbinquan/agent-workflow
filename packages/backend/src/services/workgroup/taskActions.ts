// RFC-217 T4 — workgroup task-room WRITE orchestration, moved verbatim out of
// routes/workgroupTasks.ts (366-line config PUT included). The route layer is
// transport only (params + status codes); every business step — membership
// gate, assignment state machine, room message rows, WS frames, resume kicks —
// lives here. G2 locks the room-table writes to this module.

import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { WorkgroupRuntimeConfigSchema } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import { type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { WorkflowNameSchema } from '@agent-workflow/shared'
import { nodeRuns, tasks, workgroupAssignments, workgroupMessages } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { isWorkgroupTask } from '@agent-workflow/shared'
import { setNodeRunStatusTx } from '@/services/lifecycle'
import { resumeTask, resumeTaskWithAtomicSideEffects } from '@/services/task'
import { canViewTask } from '@/services/taskCollab'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { resolveOpencodeCmd } from '@/util/opencode'
import { Paths } from '@/util/paths'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import { WG_LEADER_NODE_ID } from '@/services/workgroup/constants'
import { casAssignmentStatusTx, casAssignmentStatus } from '@/services/workgroup/lifecycle'
import {
  casGateStatusTx,
  loadWorkgroupTaskState,
  type WorkgroupTaskState,
} from '@/services/workgroup/state'
import { buildRoomMessageRow } from '@/services/workgroup/messages'
import { resolveRoomMessageRound } from '@/services/workgroup/rounds'

const log = createLogger('workgroup-room')

/**
 * 2026-07-21 —— 房间响应的 pauseReason 读方门槛（RFC-217 T4 随房间聚合迁入）。
 */
export function resolveRoomPauseReason(
  taskStatus: string,
  pauseReason: string | null,
): string | null {
  if (taskStatus !== 'awaiting_human') return null
  return pauseReason !== null && pauseReason.length > 0 ? pauseReason : null
}

/**
 * RFC-187 F2 — states a room message / delivery / config-patch may re-drive
 * (moved with the write orchestration; routes re-export for its test lock).
 */
export function isWorkgroupKickResumable(status: string | undefined): boolean {
  return status === 'awaiting_human' || status === 'interrupted'
}

interface WorkgroupTaskRow {
  id: string
  ownerUserId: string | null
  status: string
  workgroupId: string | null
  workgroupConfigJson: string | null
}

/** RFC-054 W1-7: zod-parse instead of `as Record` for reading our own
 * task-owned config JSON (routes/*.ts may not `as`-cast). */
const JsonObjectSchema = z.record(z.string(), z.unknown())

const PostMessageSchema = z.object({
  body: z.string().trim().min(1).max(65536),
})

/** PR-5 双形态交付（拍板 #16）：聊天正文 或 结构化 {summary, detail}。 */
const DeliverSchema = z
  .object({
    body: z.string().trim().min(1).max(65536).optional(),
    summary: z.string().trim().min(1).max(16384).optional(),
    detail: z.string().max(65536).optional(),
  })
  .refine((d) => d.body !== undefined || d.summary !== undefined, {
    message: 'body or summary is required',
  })

/** RFC-167 — POST .../dw-save-as-workflow body. */
export const SaveAsWorkflowSchema = z.object({
  name: WorkflowNameSchema,
  description: z.string().max(4096).optional(),
})

export const ConfirmSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(65536).optional(),
  })
  .refine((d) => d.decision !== 'reject' || (d.comment !== undefined && d.comment.length > 0), {
    message: 'reject requires a comment',
  })

export interface WorkgroupTaskActionDeps {
  db: DbClient
  configPath: string
}

export function buildWorkgroupTaskActions(deps: WorkgroupTaskActionDeps) {
  function buildResumeDeps(): Parameters<typeof resumeTask>[2] {
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    return {
      db: deps.db,
      appHome: Paths.root,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...resolveLaunchRuntimeConfig(deps.configPath),
    }
  }
  function kickResume(taskId: string): void {
    void resumeTask(deps.db, taskId, buildResumeDeps()).catch((err: unknown) => {
      if (err instanceof ConflictError && err.code === 'task-not-resumable') return
      log.warn('workgroup resume failed', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
  // RFC-187 F2 — kick a message/delivery/patch-woken task iff it's in a resumable state
  // (parked or live-interrupted); running/terminal states no-op. See isWorkgroupKickResumable.
  function kickResumeIfResumable(taskId: string, status: string | undefined): void {
    if (isWorkgroupKickResumable(status)) kickResume(taskId)
  }

  // Task-membership gate; missing / invisible / non-workgroup all 404 the
  // same way (existence must not leak, D1).
  async function loadVisibleWorkgroupTask(
    actor: Actor,
    taskId: string,
  ): Promise<{
    task: WorkgroupTaskRow
    config: WorkgroupRuntimeConfig
    raw: Record<string, unknown>
    state: WorkgroupTaskState
  }> {
    const row = (
      await deps.db
        .select({
          id: tasks.id,
          ownerUserId: tasks.ownerUserId,
          status: tasks.status,
          workgroupId: tasks.workgroupId,
          workgroupConfigJson: tasks.workgroupConfigJson,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    if (
      row === undefined ||
      !isWorkgroupTask(row) ||
      row.workgroupConfigJson === null ||
      !(await canViewTask(deps.db, actor, row))
    ) {
      throw new NotFoundError('workgroup-task-not-found', `workgroup task '${taskId}' not found`)
    }
    let raw: Record<string, unknown>
    try {
      raw = JsonObjectSchema.parse(JSON.parse(row.workgroupConfigJson))
    } catch {
      throw new NotFoundError('workgroup-task-not-found', `workgroup task '${taskId}' not found`)
    }
    const parsed = WorkgroupRuntimeConfigSchema.safeParse(raw)
    if (!parsed.success) {
      throw new NotFoundError('workgroup-task-not-found', `workgroup task '${taskId}' not found`)
    }
    // RFC-217 T2 — gate/dw/pause ride workgroup_task_state, loaded once here.
    const state = await loadWorkgroupTaskState(deps.db, taskId)
    return { task: row, config: parsed.data, raw, state }
  }

  // PR-5 — inbox third source: my pending human-deliveries + confirmable
  // completion gates across non-terminal workgroup tasks I can view.

  async function postRoomMessage(actor: Actor, taskId: string, rawBody: unknown) {
    const { task, config } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = PostMessageSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('workgroup-message-invalid', 'invalid message payload', {
        issues: parsed.error.issues,
      })
    }
    if (task.status === 'done' || task.status === 'failed' || task.status === 'canceled') {
      throw new ConflictError('workgroup-task-terminal', 'cannot message a finished workgroup task')
    }
    const body = parsed.data.body
    const mentioned = resolveMentions(body, config)
    const now = Date.now()
    // RFC-209 —— 人在房间里说的话属于**正在进行的那一轮**，不再硬编码 round 0（那会在
    // 消息流中间插一条「第 0 回合」分隔线，把讨论劈成三段）。lw 取写入时刻账本读数、
    // fc 恒 0（该模式无回合）。派单卡与消息共用同一个值。
    const round = await resolveRoomMessageRound(deps.db, taskId, config.mode)

    // 1. dispatch one assignment per mentioned member (决策 #14 — human @ is
    //    a DIRECT dispatch, same rank as a leader dispatch).
    const assignmentIds: string[] = []
    for (const member of mentioned) {
      const id = ulid()
      await deps.db.insert(workgroupAssignments).values({
        id,
        taskId,
        round,
        source: 'human',
        createdByUserId: actor.user.id,
        assigneeMemberId: member.id,
        title: firstLine(body),
        briefMd: body,
        status: 'dispatched',
        createdAt: now,
        updatedAt: now,
      })
      assignmentIds.push(id)
      broadcastWg(taskId, {
        type: 'wg.assignment.updated',
        assignmentId: id,
        status: 'dispatched',
      })
    }

    // 2. the message row itself (audit column carries the user id; prompts
    //    only ever see displayName slices — design §11).
    const messageId = ulid()
    await deps.db.insert(workgroupMessages).values(
      buildRoomMessageRow({
        id: messageId,
        taskId,
        round,
        authorKind: 'human',
        authorUserId: actor.user.id,
        kind: mentioned.length > 0 ? 'dispatch' : 'chat',
        bodyMd: body,
        mentionMemberIds: mentioned.map((m) => m.id),
        assignmentId: assignmentIds[0] ?? null,
        createdAt: now,
      }),
    )
    broadcastWg(taskId, {
      type: 'wg.message.created',
      messageId,
      kind: mentioned.length > 0 ? 'dispatch' : 'chat',
    })

    // 3. a parked task re-wakes (leader-idle / clarify-or-delivery parking —
    //    the engine re-derives; leader sees the message as new-content).
    kickResumeIfResumable(taskId, task.status)
    return { messageId, assignmentIds }
  }

  async function deliverAssignment(
    actor: Actor,
    taskId: string,
    assignmentId: string,
    rawBody: unknown,
  ) {
    const { task, config } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = DeliverSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('workgroup-delivery-invalid', 'invalid delivery payload', {
        issues: parsed.error.issues,
      })
    }
    const row = (
      await deps.db
        .select()
        .from(workgroupAssignments)
        .where(
          and(eq(workgroupAssignments.id, assignmentId), eq(workgroupAssignments.taskId, taskId)),
        )
        .limit(1)
    )[0]
    if (row === undefined) {
      throw new NotFoundError('workgroup-assignment-not-found', 'assignment not found')
    }
    const member = config.members.find((m) => m.id === row.assigneeMemberId)
    if (member === undefined || member.memberType !== 'human') {
      throw new ValidationError(
        'workgroup-delivery-not-human',
        'only human-member assignments accept deliveries',
      )
    }
    // Any task member may deliver on the card (the assignee alias is a group
    // construct; the answer boundary is task membership — same as clarify).
    const bodyMd =
      parsed.data.body ??
      `${parsed.data.summary ?? ''}${parsed.data.detail ? `\n\n${parsed.data.detail}` : ''}`
    const deliveryId = ulid()
    const delivered = dbTxSync(deps.db, (tx) => {
      const flipped = casAssignmentStatusTx(tx, assignmentId, 'dispatched', 'delivered', {
        resultMessageId: deliveryId,
      })
      if (!flipped) return false
      tx.insert(workgroupMessages)
        .values(
          buildRoomMessageRow({
            id: deliveryId,
            taskId,
            // 派单卡族：交付回答的是**哪一轮的派单**，恒取 assignment.round（RFC-209 D13）。
            round: row.round,
            authorKind: 'human',
            authorMemberId: member.id,
            authorUserId: actor.user.id,
            kind: 'delivery',
            bodyMd,
            assignmentId,
            createdAt: Date.now(),
          }),
        )
        .run()
      return true
    })
    if (!delivered) {
      throw new ConflictError(
        'workgroup-delivery-conflict',
        `assignment is '${row.status}' — only dispatched human cards accept delivery`,
      )
    }
    broadcastWg(taskId, {
      type: 'wg.assignment.updated',
      assignmentId,
      status: 'delivered',
    })
    broadcastWg(taskId, { type: 'wg.message.created', messageId: deliveryId, kind: 'delivery' })
    kickResumeIfResumable(taskId, task.status)
    return { messageId: deliveryId }
  }

  async function confirmGate(actor: Actor, taskId: string, rawBody: unknown) {
    const { task, config, state } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = ConfirmSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('workgroup-confirm-invalid', 'invalid confirm payload', {
        issues: parsed.error.issues,
      })
    }
    if (state.gateStatus !== 'awaiting_confirmation' || task.status !== 'awaiting_review') {
      throw new ConflictError(
        'workgroup-gate-not-open',
        'the completion gate is not awaiting confirmation',
      )
    }
    const approve = parsed.data.decision === 'approve'
    const messageId = ulid()
    const closedHolderIds: string[] = []
    // RFC-209 —— 事务回调是**同步**的（不能 await），所以回合号在事务外先解析好、
    // 捕获进闭包。解析与 insert 之间账本可能前进一格，标签落在前一轮——由前端的单调
    // 守卫吸收，记为可接受残余（design §6）。
    const gateRound = await resolveRoomMessageRound(deps.db, taskId, config.mode)
    await resumeTaskWithAtomicSideEffects(deps.db, taskId, buildResumeDeps(), (tx, transition) => {
      if (transition.from !== 'awaiting_review') {
        throw new ConflictError(
          'workgroup-gate-not-open',
          'the completion gate is not awaiting confirmation',
        )
      }
      // RFC-217 T2 — the CAS IS the fresh re-check: it only lands from
      // awaiting_confirmation, so a concurrent decision (or a raced engine
      // transition) surfaces as gate-not-open instead of a silent overwrite.
      const landed = casGateStatusTx(tx, taskId, {
        from: ['awaiting_confirmation'],
        to: approve ? 'approved' : 'rejected',
        ...(approve ? {} : { rejectedComment: parsed.data.comment ?? '' }),
      })
      if (!landed) {
        throw new ConflictError(
          'workgroup-gate-not-open',
          'the completion gate is not awaiting confirmation',
        )
      }

      const holders = tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            eq(nodeRuns.rerunCause, 'wg-gate'),
            eq(nodeRuns.status, 'awaiting_review'),
          ),
        )
        .all()
      for (const holder of holders) {
        setNodeRunStatusTx({
          tx,
          nodeRunId: holder.id,
          to: 'done',
          allowedFrom: ['awaiting_review'],
          reason: approve ? 'wg-gate-approved' : 'wg-gate-rejected',
        })
        closedHolderIds.push(holder.id)
      }
      tx.insert(workgroupMessages)
        .values(
          buildRoomMessageRow({
            id: messageId,
            taskId,
            round: gateRound,
            authorKind: 'human',
            authorUserId: actor.user.id,
            kind: 'system',
            bodyMd: approve
              ? 'completion gate APPROVED'
              : `completion gate REJECTED: ${parsed.data.comment ?? ''}`,
            createdAt: Date.now(),
          }),
        )
        .run()
    })
    // Every frame follows the transaction that made it true. Scheduler work may
    // already be re-entering, but it can only observe the fully committed gate.
    for (const holderId of closedHolderIds) {
      taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
        id: -1,
        type: 'node.status',
        nodeRunId: holderId,
        nodeId: WG_LEADER_NODE_ID,
        status: 'done',
      })
    }
    broadcastWg(taskId, { type: 'wg.message.created', messageId, kind: 'system' })
    broadcastWg(taskId, { type: 'wg.gate.updated', awaitingConfirmation: false })
    return { decision: parsed.data.decision }
  }

  async function cancelAssignment(actor: Actor, taskId: string, assignmentId: string) {
    const { config } = await loadVisibleWorkgroupTask(actor, taskId)
    const row = (
      await deps.db
        .select()
        .from(workgroupAssignments)
        .where(
          and(eq(workgroupAssignments.id, assignmentId), eq(workgroupAssignments.taskId, taskId)),
        )
        .limit(1)
    )[0]
    if (row === undefined) {
      throw new NotFoundError('workgroup-assignment-not-found', 'assignment not found')
    }
    const canceled =
      (await casAssignmentStatus(deps.db, assignmentId, 'open', 'canceled').catch(() => false)) ||
      (await casAssignmentStatus(deps.db, assignmentId, 'dispatched', 'canceled').catch(
        () => false,
      ))
    if (!canceled) {
      throw new ConflictError(
        'workgroup-assignment-not-cancelable',
        `assignment is '${row.status}' — only open/dispatched cards can be canceled`,
      )
    }
    const cancelMsgId = ulid()
    await deps.db.insert(workgroupMessages).values(
      buildRoomMessageRow({
        id: cancelMsgId,
        taskId,
        // 派单卡族：取消说的是**哪一轮的派单**被取消，恒取 assignment.round（RFC-209 D13）。
        round: row.round,
        authorKind: 'system',
        kind: 'system',
        bodyMd: `assignment '${row.title}' canceled by a task member`,
        assignmentId,
        createdAt: Date.now(),
      }),
    )
    // Keep concurrent viewers' rooms live: the acting client refreshes via its
    // own mutation onSuccess, but another task member watching only learns of
    // the cancellation (card → 'canceled' + the system note) through these
    // frames — otherwise their room stays stale until the 15s poll / F5.
    // Mirrors the dual broadcast the human @-dispatch path fires.
    broadcastWg(taskId, { type: 'wg.assignment.updated', assignmentId, status: 'canceled' })
    broadcastWg(taskId, { type: 'wg.message.created', messageId: cancelMsgId, kind: 'system' })
    void config
  }

  return {
    loadVisibleWorkgroupTask,
    kickResume,
    kickResumeIfResumable,
    buildResumeDeps,
    postRoomMessage,
    deliverAssignment,
    confirmGate,
    cancelAssignment,
  }
}

export function broadcastWg(
  taskId: string,
  msg:
    | { type: 'wg.message.created'; messageId: string; kind: string }
    | { type: 'wg.assignment.updated'; assignmentId: string; status: string }
    | { type: 'wg.gate.updated'; awaitingConfirmation: boolean },
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), { id: -1, ...msg })
}

export function safeMentions(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function firstLine(body: string): string {
  const line = body.split('\n')[0]?.trim() ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}…` : line.length > 0 ? line : '(untitled)'
}

/** Resolve "@displayName" tokens against the roster (dedup, order-stable). */
export function resolveMentions(
  body: string,
  config: WorkgroupRuntimeConfig,
): Array<{ id: string; displayName: string }> {
  const byName = new Map(config.members.map((m) => [m.displayName, m]))
  const out = new Map<string, { id: string; displayName: string }>()
  for (const match of body.matchAll(/@([^\s@,]+)/g)) {
    const token = match[1] ?? ''
    const member = byName.get(token)
    if (member !== undefined && !out.has(member.id)) {
      out.set(member.id, { id: member.id, displayName: member.displayName })
    }
  }
  return [...out.values()]
}

export async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
