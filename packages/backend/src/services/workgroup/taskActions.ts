// RFC-217 T4 — workgroup task-room WRITE orchestration, moved verbatim out of
// routes/workgroupTasks.ts (366-line config PUT included). The route layer is
// transport only (params + status codes); every business step — membership
// gate, assignment state machine, room message rows, WS frames, resume kicks —
// lives here. G2 locks the room-table writes to this module.

import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import {
  workgroupHasHumanMember,
  WORKGROUP_MAX_ROUNDS_LIMIT,
  WorkgroupRuntimeConfigSchema,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  nodeRuns,
  taskCollaborators,
  tasks,
  users,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { isWorkgroupTask } from '@agent-workflow/shared'
import { setNodeRunStatusTx } from '@/services/lifecycle'
import { resumeTask, resumeTaskWithAtomicSideEffects } from '@/services/task'
import { canViewTask } from '@/services/taskCollab'
import { assertNewRefsUsable } from '@/services/resourceRefs'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { resolveOpencodeCmd } from '@/util/opencode'
import { Paths } from '@/util/paths'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import { WG_LEADER_NODE_ID } from '@/services/workgroup/constants'
import {
  casAssignmentStatusTx,
  casAssignmentStatus,
  dismissOpenClarifyParksForAutonomous,
} from '@/services/workgroup/lifecycle'
import {
  casGateStatusTx,
  loadWorkgroupTaskState,
  type WorkgroupTaskState,
} from '@/services/workgroup/state'
import { buildRoomMessageRow } from '@/services/workgroup/messages'
import { resolveRoomMessageRound } from '@/services/workgroup/rounds'

const log = createLogger('workgroup-room')

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

export const ConfirmSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(65536).optional(),
  })
  .refine((d) => d.decision !== 'reject' || (d.comment !== undefined && d.comment.length > 0), {
    message: 'reject requires a comment',
  })

/** PR-5 中途改配置白名单（design §8.4：mode/leader/repo 不可改）。 */
const ConfigPatchSchema = z.object({
  switches: z
    .object({
      shareOutputs: z.boolean(),
      directMessages: z.boolean(),
      blackboard: z.boolean(),
    })
    .optional(),
  maxRounds: z.number().int().positive().max(WORKGROUP_MAX_ROUNDS_LIMIT).optional(),
  completionGate: z.boolean().optional(),
  // RFC-207 — mid-run ask-back budget, same live-pickup channel as maxRounds
  // (the engine reloads the task config every pass).
  clarifyBudget: z.number().int().min(0).max(50).optional(),
  // RFC-185 D4 — mid-run fan-out toggle, same live-pickup channel. No flip
  // compensation needed: turning OFF lets in-flight instances finish; the
  // leader simply stops being invited to fan out from its next turn.
  fanOut: z.boolean().optional(),
  addMembers: z
    .array(
      z.object({
        memberType: z.enum(['agent', 'human']),
        agentName: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
        displayName: z.string().trim().min(1).max(64),
        roleDesc: z.string().max(2048).default(''),
      }),
    )
    .max(16)
    .optional(),
  removeMemberIds: z.array(z.string().min(1)).max(64).optional(),
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

  async function updateTaskConfig(actor: Actor, taskId: string, rawBody: unknown) {
    const { task, config, raw } = await loadVisibleWorkgroupTask(actor, taskId)
    if (task.status === 'done' || task.status === 'failed' || task.status === 'canceled') {
      throw new ConflictError('workgroup-task-terminal', 'cannot edit a finished workgroup task')
    }
    const parsed = ConfigPatchSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('workgroup-config-invalid', 'invalid config patch', {
        issues: parsed.error.issues,
      })
    }
    const patch = parsed.data
    const addedAgentNames = [
      ...new Set(
        (patch.addMembers ?? []).flatMap((member) =>
          member.memberType === 'agent' && member.agentName ? [member.agentName] : [],
        ),
      ),
    ]
    if (addedAgentNames.length > 0) {
      // Mid-run membership is a new reference just like editing a workgroup
      // resource: reject private agents before the existence check so the
      // response cannot be used to distinguish a hidden row from a typo.
      await assertNewRefsUsable(deps.db, actor, [{ type: 'agent', names: addedAgentNames }])
      const existing = new Set(
        (
          await deps.db
            .select({ name: agents.name })
            .from(agents)
            .where(inArray(agents.name, addedAgentNames))
        ).map((row) => row.name),
      )
      const missing = addedAgentNames.filter((name) => !existing.has(name))
      if (missing.length > 0) {
        throw new ValidationError(
          'workgroup-config-agent-missing',
          `agent member(s) do not exist: ${missing.join(', ')}`,
          { missingAgentNames: missing },
        )
      }
    }
    const changes: string[] = []
    let members = [...config.members]
    // RFC-207 §3.4 — snapshot BEFORE any add/remove: the dismissal below fires
    // only on the >0 → 0 transition, never on a roster that never had humans.
    const hadHumanMember = workgroupHasHumanMember(config.members)
    // RFC-099 audit (2026-07-15): human members added mid-run must also become
    // task_collaborators — canViewTask / room access key off that table, so
    // without this a joiner is "added but can't get in" (launch does this via
    // the T24 union in workgroupLaunch.ts; the mid-run path had missed it).
    const newHumanUserIds: string[] = []
    let removingMemberIds: Set<string> | null = null
    const joinCursors: Array<{ memberId: string; messageId: string }> = []
    const assignmentUpdates: Array<{ assignmentId: string; status: string }> = []

    if (patch.removeMemberIds !== undefined && patch.removeMemberIds.length > 0) {
      const removing = new Set(patch.removeMemberIds)
      removingMemberIds = removing
      if (config.leaderMemberId !== null && removing.has(config.leaderMemberId)) {
        throw new ValidationError('workgroup-config-leader-immutable', 'cannot remove the leader')
      }
      const removed = members.filter((m) => removing.has(m.id))
      members = members.filter((m) => !removing.has(m.id))
      if (members.filter((m) => m.memberType === 'agent').length === 0) {
        throw new ValidationError(
          'workgroup-config-no-agents',
          'removing these members would leave no agent member',
        )
      }
      for (const m of removed) changes.push(`removed @${m.displayName}`)
    }

    if (patch.addMembers !== undefined && patch.addMembers.length > 0) {
      const names = new Set(members.map((m) => m.displayName))
      const maxMsg = (
        await deps.db
          .select({ id: workgroupMessages.id })
          .from(workgroupMessages)
          .where(eq(workgroupMessages.taskId, taskId))
          .orderBy(asc(workgroupMessages.id))
      ).at(-1)?.id
      for (const m of patch.addMembers) {
        if (names.has(m.displayName)) {
          throw new ValidationError(
            'workgroup-config-duplicate-member',
            `displayName '${m.displayName}' already exists in the group`,
          )
        }
        if (m.memberType === 'agent' && !m.agentName) {
          throw new ValidationError('workgroup-config-invalid', 'agent member requires agentName')
        }
        if (m.memberType === 'human') {
          if (!m.userId) {
            throw new ValidationError('workgroup-config-invalid', 'human member requires userId')
          }
          if (m.userId === SYSTEM_USER_ID) {
            throw new ValidationError(
              'workgroup-config-invalid',
              'cannot add the system user as a member',
            )
          }
          // Owner is already a member via ownerUserId (no collaborator row for
          // them); everyone else joins task_collaborators below.
          if (m.userId !== task.ownerUserId && !newHumanUserIds.includes(m.userId)) {
            newHumanUserIds.push(m.userId)
          }
        }
        const id = ulid()
        members.push({
          id,
          memberType: m.memberType,
          agentName: m.memberType === 'agent' ? (m.agentName ?? null) : null,
          userId: m.memberType === 'human' ? (m.userId ?? null) : null,
          displayName: m.displayName,
          roleDesc: m.roleDesc,
        })
        names.add(m.displayName)
        changes.push(`added @${m.displayName} (${m.memberType})`)
        // join-no-history: cursor starts AT the current room tail (msghub 语义).
        if (maxMsg !== undefined) {
          joinCursors.push({ memberId: id, messageId: maxMsg })
        }
      }
      // RFC-099 audit: new human members must be active users before they ride
      // into task_collaborators below (same rule launch enforces via T24; also
      // rejects the system user, handled per-member above).
      if (newHumanUserIds.length > 0) {
        const urows = await deps.db
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(inArray(users.id, newHumanUserIds))
        const active = new Set(urows.filter((r) => r.status === 'active').map((r) => r.id))
        for (const uid of newHumanUserIds) {
          if (!active.has(uid)) {
            throw new ValidationError(
              'workgroup-config-invalid',
              `human member '${uid}' is not an active user`,
            )
          }
        }
      }
    }

    if (patch.switches !== undefined) changes.push('switches updated')
    if (patch.maxRounds !== undefined) changes.push(`maxRounds → ${patch.maxRounds}`)
    if (patch.completionGate !== undefined) changes.push(`completionGate → ${patch.completionGate}`)
    if (patch.clarifyBudget !== undefined) changes.push(`clarifyBudget → ${patch.clarifyBudget}`)
    if (patch.fanOut !== undefined) changes.push(`fanOut → ${patch.fanOut}`)
    if (changes.length === 0) {
      throw new ValidationError('workgroup-config-empty', 'nothing to change')
    }
    // Codex T6 impl-gate P2 — merge into a FRESH row inside one sync
    // transaction: `raw` was read before the addMembers awaits above, so a
    // whole-JSON write from it could clobber a concurrent writer (the engine's
    // persistGate — now also reload-and-merge — or another PATCH). Only this
    // handler's own keys ride on top of the fresh base.
    dbTxSync(deps.db, (tx) => {
      const fresh = tx
        .select({ workgroupConfigJson: tasks.workgroupConfigJson })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
      let base: Record<string, unknown> = raw
      if (fresh?.workgroupConfigJson != null) {
        try {
          base = JsonObjectSchema.parse(JSON.parse(fresh.workgroupConfigJson))
        } catch {
          // unreadable fresh JSON — fall back to the handler's earlier read
        }
      }
      const freshConfig = WorkgroupRuntimeConfigSchema.safeParse(base)
      if (!freshConfig.success) {
        throw new ConflictError(
          'workgroup-config-conflict',
          'the workgroup config changed into an unreadable state while editing',
        )
      }
      // Membership operations were validated against the entry snapshot. If
      // another editor changed the roster during the async ACL/user checks,
      // refuse this write instead of replacing their fresh members wholesale.
      if (JSON.stringify(freshConfig.data.members) !== JSON.stringify(config.members)) {
        throw new ConflictError(
          'workgroup-config-conflict',
          'the workgroup roster changed while editing; reload and retry',
        )
      }
      const nextConfig = {
        ...base,
        members,
        ...(patch.switches !== undefined ? { switches: patch.switches } : {}),
        ...(patch.maxRounds !== undefined ? { maxRounds: patch.maxRounds } : {}),
        ...(patch.completionGate !== undefined ? { completionGate: patch.completionGate } : {}),
        ...(patch.clarifyBudget !== undefined ? { clarifyBudget: patch.clarifyBudget } : {}),
        ...(patch.fanOut !== undefined ? { fanOut: patch.fanOut } : {}),
      }
      tx.update(tasks)
        .set({ workgroupConfigJson: JSON.stringify(nextConfig) })
        .where(eq(tasks.id, taskId))
        .run()
      // RFC-099 audit: mirror new human members into task_collaborators in the
      // SAME tx as the config write, so membership and room access stay atomic.
      // onConflictDoNothing dedupes against an existing owner/collaborator row.
      if (newHumanUserIds.length > 0) {
        tx.insert(taskCollaborators)
          .values(
            newHumanUserIds.map((uid) => ({
              taskId,
              userId: uid,
              role: 'collaborator' as const,
              addedBy: actor.user.id,
              addedAt: Date.now(),
            })),
          )
          .onConflictDoNothing()
          .run()
      }

      // Every roster side effect lands in the SAME transaction as the fresh
      // config row. A later validation error / crash can no longer return 422
      // after canceling cards or advancing a joiner's cursor.
      if (removingMemberIds !== null && removingMemberIds.size > 0) {
        const rows = tx
          .select()
          .from(workgroupAssignments)
          .where(eq(workgroupAssignments.taskId, taskId))
          .all()
        for (const assignment of rows) {
          if (
            assignment.assigneeMemberId === null ||
            !removingMemberIds.has(assignment.assigneeMemberId)
          ) {
            continue
          }
          if (
            assignment.status !== 'open' &&
            assignment.status !== 'dispatched' &&
            assignment.status !== 'awaiting_human' &&
            assignment.status !== 'running'
          ) {
            continue
          }
          if (assignment.status === 'running') {
            throw new ConflictError(
              'workgroup-member-running',
              `member '${assignment.assigneeMemberId}' still owns a running assignment`,
            )
          }
          if (config.mode === 'free_collab') {
            if (assignment.status === 'dispatched') {
              if (!casAssignmentStatusTx(tx, assignment.id, 'dispatched', 'failed')) {
                throw new ConflictError(
                  'workgroup-config-conflict',
                  `assignment '${assignment.id}' changed while editing the roster`,
                )
              }
              if (
                !casAssignmentStatusTx(tx, assignment.id, 'failed', 'open', {
                  assigneeMemberId: null,
                  nodeRunId: null,
                })
              ) {
                throw new ConflictError(
                  'workgroup-config-conflict',
                  `assignment '${assignment.id}' changed while editing the roster`,
                )
              }
              assignmentUpdates.push({ assignmentId: assignment.id, status: 'open' })
            } else if (assignment.status === 'awaiting_human') {
              if (
                !casAssignmentStatusTx(tx, assignment.id, 'awaiting_human', 'open', {
                  assigneeMemberId: null,
                  nodeRunId: null,
                })
              ) {
                throw new ConflictError(
                  'workgroup-config-conflict',
                  `assignment '${assignment.id}' changed while editing the roster`,
                )
              }
              assignmentUpdates.push({ assignmentId: assignment.id, status: 'open' })
            }
          } else if (assignment.status !== 'open') {
            if (!casAssignmentStatusTx(tx, assignment.id, assignment.status, 'canceled')) {
              throw new ConflictError(
                'workgroup-config-conflict',
                `assignment '${assignment.id}' changed while editing the roster`,
              )
            }
            assignmentUpdates.push({ assignmentId: assignment.id, status: 'canceled' })
          } else if (casAssignmentStatusTx(tx, assignment.id, 'open', 'canceled')) {
            assignmentUpdates.push({ assignmentId: assignment.id, status: 'canceled' })
          }
        }
      }
      for (const cursor of joinCursors) {
        tx.insert(workgroupMemberCursors)
          .values({
            taskId,
            memberId: cursor.memberId,
            lastConsumedMessageId: cursor.messageId,
            updatedAt: Date.now(),
          })
          .onConflictDoNothing()
          .run()
      }
    })
    for (const update of assignmentUpdates) {
      broadcastWg(taskId, {
        type: 'wg.assignment.updated',
        assignmentId: update.assignmentId,
        status: update.status,
      })
    }
    // RFC-207 §3.4 (inherits RFC-181 A2, design-gate P0) — losing the LAST human
    // member dismisses in-flight clarify parks, so removing the humans works on a
    // task that is ALREADY parked on questions (session+round+park-run canceled,
    // worker cards requeued, stale answers rejected via the canceled round).
    // Rosters that still hold a human are natural no-ops. dynamic_workflow is
    // excluded (impl-gate P2): it has no turn engine, the roster predicate is
    // mode-inert there, and this must not sweep a generated node's ordinary
    // clarify park.
    if (hadHumanMember && !workgroupHasHumanMember(members) && config.mode !== 'dynamic_workflow') {
      const dismissed = await dismissOpenClarifyParksForAutonomous(deps.db, taskId, config.mode)
      if (dismissed.dismissedSessions > 0) {
        changes.push(
          `dismissed ${dismissed.dismissedSessions} open clarify session(s) (no human member left)`,
        )
        // Impl-gate P2 — the `task.status === 'awaiting_human'` gate further
        // down reads the row loaded BEFORE this dismissal, and the engine may
        // commit running→awaiting_human from its pre-dismissal snapshot a
        // beat later. Re-read fresh now and once more shortly after, so a
        // park landing right behind the dismissal still gets resumed
        // (kickResume no-ops on non-resumable states).
        const kickIfParked = async (): Promise<void> => {
          const fresh = (
            await deps.db
              .select({ status: tasks.status })
              .from(tasks)
              .where(eq(tasks.id, taskId))
              .limit(1)
          )[0]
          kickResumeIfResumable(taskId, fresh?.status)
        }
        await kickIfParked()
        const lateKick = setTimeout(() => void kickIfParked(), 2500)
        lateKick.unref?.()
      }
    }
    const msgId = ulid()
    await deps.db.insert(workgroupMessages).values(
      buildRoomMessageRow({
        id: msgId,
        taskId,
        round: await resolveRoomMessageRound(deps.db, taskId, config.mode),
        authorKind: 'human',
        authorUserId: actor.user.id,
        kind: 'system',
        bodyMd: `config updated: ${changes.join('; ')}`,
        createdAt: Date.now(),
      }),
    )
    broadcastWg(taskId, { type: 'wg.message.created', messageId: msgId, kind: 'system' })
    kickResumeIfResumable(taskId, task.status)
    return { changes }
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
    updateTaskConfig,
    cancelAssignment,
  }
}

function broadcastWg(
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
