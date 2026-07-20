// RFC-164 PR-4 — workgroup room endpoints (task-scoped; design §7).
// GET  /api/workgroup-tasks/:taskId/room                    — room aggregate
// POST /api/workgroup-tasks/:taskId/messages                — human speaks
// POST /api/workgroup-tasks/:taskId/assignments/:id/cancel  — cancel a card
//
// Visibility = task membership (canViewTask), the same boundary as clarify
// answering (RFC-099 D20 — group tasks are member-private like every task).
// Room events ride the EXISTING per-task WS channel as wg.* frames.
//
// Human message semantics (决策 #14): "@member" tokens = direct dispatch
// (one assignment per mentioned member, card notes source=human); a message
// with no mentions lands on the blackboard and re-wakes a leader-idle task
// (design §8.3 — resumeTask kicks the engine; leader picks it up as
// new-content).

import type { DwState, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import {
  parseDwState,
  WORKGROUP_MAX_ROUNDS_LIMIT,
  WorkflowDefinitionSchema,
  WorkflowNameSchema,
  WorkgroupRuntimeConfigSchema,
  workgroupHasHumanMember,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { z } from 'zod'
import { actorOf, SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  agents,
  clarifySessions,
  nodeRuns,
  taskCollaborators,
  tasks,
  users,
  workgroupAssignments,
  workgroupMemberCursors,
  taskNodeClarifyDirectives,
  workgroupMessages,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { DW_GATE_CAUSE, DW_MAX_REJECT_ROUNDS } from '@/services/dynamicWorkflowRunner'
import { setNodeRunStatus, setNodeRunStatusTx, setTaskStatus } from '@/services/lifecycle'
import { validateDynamicWorkflowDef } from '@/services/orchestratorAgent'
import { assertNewRefsUsable, extractWorkflowAgentNames } from '@/services/resourceRefs'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import {
  emitTaskStatus,
  getTask,
  resumeDynamicWorkflowExecution,
  resumeTask,
  resumeTaskWithAtomicSideEffects,
} from '@/services/task'
import { canViewTask } from '@/services/taskCollab'
import { createWorkflow } from '@/services/workflow'
import {
  casAssignmentStatus,
  casAssignmentStatusTx,
  dismissOpenClarifyParksForAutonomous,
} from '@/services/workgroupLifecycle'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '@/services/workgroupLaunch'
import { buildRoomMessageRow } from '@/services/workgroupMessages'
import { deriveMemberCurrentRuns, deriveWorkgroupRunHistory } from '@/services/workgroupRoom'
import {
  deriveRoundsUsed,
  resolveRoomMessageRound,
  roundedModeOf,
} from '@/services/workgroupRounds'
import { Paths } from '@/util/paths'
import { resolveOpencodeCmd } from '@/util/opencode'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('workgroup-room')

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

const ConfirmSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(65536).optional(),
  })
  .refine((d) => d.decision !== 'reject' || (d.comment !== undefined && d.comment.length > 0), {
    message: 'reject requires a comment',
  })

/** RFC-167 — POST .../dw-save-as-workflow body. */
const SaveAsWorkflowSchema = z.object({
  name: WorkflowNameSchema,
  description: z.string().max(4096).optional(),
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

interface WorkgroupTaskRow {
  id: string
  ownerUserId: string | null
  status: string
  workgroupId: string | null
  workgroupConfigJson: string | null
}

/**
 * RFC-187 F2 (audit §5 F2) — states a room message / delivery / config-patch may
 * re-drive. `awaiting_human` (parked) was already covered; `interrupted` is the gap: a
 * task reaped mid-run by orphan-reaping (WITHOUT a daemon restart) had its just-inserted
 * dispatched assignment left as a black hole. resumeTask drives both (RFC-186 P0-B added
 * interrupted); running/terminal states are deliberately left alone (no double-drive).
 */
export function isWorkgroupKickResumable(status: string | undefined): boolean {
  return status === 'awaiting_human' || status === 'interrupted'
}

export function mountWorkgroupTaskRoutes(app: Hono, deps: AppDeps): void {
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
      row.workgroupId === null ||
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
    return { task: row, config: parsed.data, raw }
  }

  // PR-5 — inbox third source: my pending human-deliveries + confirmable
  // completion gates across non-terminal workgroup tasks I can view.
  app.get('/api/workgroup-tasks/pending-count', async (c) => {
    const actor = actorOf(c)
    const rows = await deps.db
      .select({
        id: tasks.id,
        ownerUserId: tasks.ownerUserId,
        status: tasks.status,
        workgroupConfigJson: tasks.workgroupConfigJson,
      })
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.workgroupId),
          inArray(tasks.status, ['pending', 'running', 'awaiting_review', 'awaiting_human']),
        ),
      )
    let deliveries = 0
    let gates = 0
    for (const row of rows) {
      if (row.workgroupConfigJson === null) continue
      if (!(await canViewTask(deps.db, actor, row))) continue
      let raw: Record<string, unknown>
      try {
        raw = JsonObjectSchema.parse(JSON.parse(row.workgroupConfigJson))
      } catch {
        continue
      }
      const parsed = WorkgroupRuntimeConfigSchema.safeParse(raw)
      if (!parsed.success) continue
      const gateRaw = JsonObjectSchema.parse(raw.gate ?? {})
      if (gateRaw.awaitingConfirmation === true && row.status === 'awaiting_review') gates++
      const myMemberIds = new Set(
        parsed.data.members
          .filter((m) => m.memberType === 'human' && m.userId === actor.user.id)
          .map((m) => m.id),
      )
      if (myMemberIds.size === 0) continue
      const cards = await deps.db
        .select({ assigneeMemberId: workgroupAssignments.assigneeMemberId })
        .from(workgroupAssignments)
        .where(
          and(
            eq(workgroupAssignments.taskId, row.id),
            eq(workgroupAssignments.status, 'dispatched'),
          ),
        )
      deliveries += cards.filter(
        (c2) => c2.assigneeMemberId !== null && myMemberIds.has(c2.assigneeMemberId),
      ).length
    }
    return c.json({ deliveries, gates, total: deliveries + gates })
  })

  app.get('/api/workgroup-tasks/:taskId/room', async (c) => {
    const taskId = c.req.param('taskId')
    const { task, config, raw } = await loadVisibleWorkgroupTask(actorOf(c), taskId)
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
          // RFC-209 —— 两个用途共用这一列：① 回合账本读数（右栏预算表 roundsUsed）；
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
      round: m.round,
    }))
    // RFC-182 impl-gate P1 — open clarify parks: the asking host run's DB row
    // is `done` while the park lives on the intermediary clarify run, so the
    // derivation projects `awaiting_human` onto entries whose run has an OPEN
    // session (turn card / presence read「等待回答」instead of「完成/空闲」).
    const openClarify = await deps.db
      .select({ sourceRunId: clarifySessions.sourceAgentNodeRunId })
      .from(clarifySessions)
      .where(and(eq(clarifySessions.taskId, taskId), eq(clarifySessions.status, 'awaiting_human')))
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
    const gateRaw = JsonObjectSchema.parse(raw.gate ?? {})
    // RFC-209 —— 已用回合数：与 max_rounds 触顶判据**同源**（同一个 deriveRoundsUsed，
    // 且这里的 host-run 过滤条件与引擎 loadDbState 逐字相同），所以右栏预算表显示的
    // 数字就是真正决定任务生死的那个。零新查询——复用上面已经加载的 hostRuns。
    // dynamic_workflow 没有回合账本 ⇒ 0（UI 只在 free_collab 渲染）。
    const roundedMode = roundedModeOf(config.mode)
    const roundsUsed = roundedMode === null ? 0 : deriveRoundsUsed(roundedMode, hostRuns)
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

    return c.json({
      taskId,
      taskStatus: task.status,
      config,
      clarifyStops,
      roundsUsed,
      gate: {
        declaredDone: gateRaw.declaredDone === true,
        awaitingConfirmation: gateRaw.awaitingConfirmation === true,
        rejected: gateRaw.rejected === true,
        summary: typeof gateRaw.summary === 'string' ? gateRaw.summary : null,
      },
      // RFC-167 PR-3 — the dynamic-workflow state slot (phase / generatedDef /
      // rejection bookkeeping). null for turn-engine tasks (and for a corrupt
      // slot); the confirm-gate UI and the phase-driven tab default read it.
      dw: parseDwState(raw.dw),
      messages: messages.map((m) => ({
        id: m.id,
        round: m.round,
        authorKind: m.authorKind,
        authorMemberId: m.authorMemberId,
        authorUserId: m.authorUserId,
        kind: m.kind,
        bodyMd: m.bodyMd,
        mentionMemberIds: safeMentions(m.mentionsJson),
        assignmentId: m.assignmentId,
        createdAt: m.createdAt,
      })),
      assignments: assignments.map((a) => ({
        id: a.id,
        round: a.round,
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
    })
  })

  app.post('/api/workgroup-tasks/:taskId/messages', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { task, config } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = PostMessageSchema.safeParse(await safeJson(c.req.raw))
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
    return c.json({ messageId, assignmentIds }, 201)
  })

  // PR-5 (拍板 #16) — human member delivery, both shapes normalized into one
  // 'delivery' message; the assignment flips dispatched→delivered and the
  // engine consumes it on the next leader turn (delivered→done).
  app.post('/api/workgroup-tasks/:taskId/assignments/:id/deliver', async (c) => {
    const taskId = c.req.param('taskId')
    const assignmentId = c.req.param('id')
    const actor = actorOf(c)
    const { task, config } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = DeliverSchema.safeParse(await safeJson(c.req.raw))
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
    return c.json({ messageId: deliveryId }, 201)
  })

  // PR-5 (design §8.2) — completion-gate decision. Task members only (same
  // answer boundary); approve finishes, reject re-wakes the leader with the
  // comment as a high-priority injection item.
  app.post('/api/workgroup-tasks/:taskId/confirm', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { task, raw, config } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = ConfirmSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workgroup-confirm-invalid', 'invalid confirm payload', {
        issues: parsed.error.issues,
      })
    }
    const gateRaw = JsonObjectSchema.parse(raw.gate ?? {})
    if (gateRaw.awaitingConfirmation !== true || task.status !== 'awaiting_review') {
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
      const fresh = tx
        .select({ workgroupConfigJson: tasks.workgroupConfigJson })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
        .get()
      const freshRaw = JsonObjectSchema.parse(JSON.parse(fresh?.workgroupConfigJson ?? '{}'))
      const freshGate = JsonObjectSchema.parse(freshRaw.gate ?? {})
      if (freshGate.awaitingConfirmation !== true) {
        throw new ConflictError(
          'workgroup-gate-not-open',
          'the completion gate is not awaiting confirmation',
        )
      }
      const nextGate = approve
        ? { ...freshGate, awaitingConfirmation: false, approved: true, rejected: false }
        : {
            ...freshGate,
            awaitingConfirmation: false,
            approved: false,
            declaredDone: false,
            rejected: true,
            rejectedComment: parsed.data.comment ?? '',
          }
      tx.update(tasks)
        .set({ workgroupConfigJson: JSON.stringify({ ...freshRaw, gate: nextGate }) })
        .where(eq(tasks.id, taskId))
        .run()

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
    return c.json({ decision: parsed.data.decision })
  })

  // RFC-167 (design §3.2) — dynamic-workflow confirm gate. Task members only
  // (same 404-shaped boundary as every workgroup-task endpoint). approve swaps
  // the generated DAG into workflow_snapshot + flips dw.phase='executing'
  // ATOMICALLY inside the resume ownership CAS (resumeDynamicWorkflowExecution)
  // and the resumed runTask executes it via runScope; reject (comment required)
  // re-enters the generate engine with the feedback injected, bounded by
  // DW_MAX_REJECT_ROUNDS.
  app.post('/api/workgroup-tasks/:taskId/dw-confirm', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { task, config, raw } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = ConfirmSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workgroup-confirm-invalid', 'invalid confirm payload', {
        issues: parsed.error.issues,
      })
    }
    const dw = parseDwState(raw.dw)
    if (
      config.mode !== 'dynamic_workflow' ||
      dw === null ||
      dw.phase !== 'awaiting_confirm' ||
      task.status !== 'awaiting_review'
    ) {
      throw new ConflictError(
        'workgroup-dw-gate-not-open',
        'the dynamic workflow confirm gate is not awaiting confirmation',
      )
    }

    // Codex impl-gate P1 (re-review): the entry snapshot above only serves the
    // fast gate check — every decision below re-loads the config row and
    // re-verifies the gate RIGHT BEFORE composing durable state, so a
    // concurrent PUT config (member/switch edit) landing mid-handler is
    // neither validated against nor overwritten. The residual fresh-read→CAS
    // microsecond window is a documented v1 residual (same posture as
    // consumeTasksAdd's same-instant insert race).
    async function freshGateView(): Promise<{
      raw: Record<string, unknown>
      config: WorkgroupRuntimeConfig
      dw: DwState
    }> {
      const fresh = await loadVisibleWorkgroupTask(actor, taskId)
      const freshDw = parseDwState(fresh.raw.dw)
      if (
        fresh.config.mode !== 'dynamic_workflow' ||
        freshDw === null ||
        freshDw.phase !== 'awaiting_confirm' ||
        fresh.task.status !== 'awaiting_review'
      ) {
        throw new ConflictError(
          'workgroup-dw-gate-not-open',
          'the dynamic workflow confirm gate is not awaiting confirmation',
        )
      }
      return { raw: fresh.raw, config: fresh.config, dw: freshDw }
    }

    // Close the gate holder run(s) first (wg-confirm ordering precedent): the
    // decision is durable human input; a subsequently lost resume race leaves
    // the task re-parkable (the generate engine re-mints a holder on re-entry).
    const holders = (
      await deps.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.rerunCause, DW_GATE_CAUSE)))
    ).filter((r) => r.status === 'awaiting_review')

    if (parsed.data.decision === 'approve') {
      // Codex impl-gate P2: members / agents may have changed between
      // generation and this approval (mid-run config edits, agent deletion) —
      // re-run BOTH validation layers against the CURRENT context so a stale
      // proposal is refused here instead of failing (or silently escaping the
      // pool) at execution time. Reject-with-feedback regenerates against the
      // current pool. The long context load runs first; the fresh view comes
      // after it so the validated pool is the composed pool.
      const layer1Ctx = await buildWorkflowValidationContext(deps.db)
      const fresh = await freshGateView()
      const generated = WorkflowDefinitionSchema.safeParse(fresh.dw.generatedDef)
      if (!generated.success) {
        throw new ConflictError(
          'dw-generated-def-invalid',
          'the stored generated workflow is unreadable — reject with feedback to regenerate',
        )
      }
      const poolNames = fresh.config.members.flatMap((m) =>
        m.memberType === 'agent' && m.agentName !== null ? [m.agentName] : [],
      )
      const layer1 = validateWorkflowDef(generated.data, layer1Ctx)
      const layer2 = validateDynamicWorkflowDef(generated.data, poolNames)
      const staleIssues = [...layer1.issues, ...layer2.issues].filter(
        (i) => (i.severity ?? 'error') === 'error',
      )
      if (staleIssues.length > 0) {
        throw new ConflictError(
          'dw-generated-def-stale',
          'the generated workflow no longer validates against the current agent pool — reject with feedback to regenerate',
          { issues: staleIssues },
        )
      }
      for (const h of holders) {
        await setNodeRunStatus({
          db: deps.db,
          nodeRunId: h.id,
          to: 'done',
          allowedFrom: ['awaiting_review'],
          reason: 'dw-gate-approved',
        })
      }
      const { rejectionComment: _consumed, ...dwRest } = fresh.dw
      const nextDw: DwState = { ...dwRest, phase: 'executing' }
      await resumeDynamicWorkflowExecution(deps.db, taskId, buildResumeDeps(), {
        workflowSnapshot: JSON.stringify(generated.data),
        workgroupConfigJson: JSON.stringify({ ...fresh.raw, dw: nextDw }),
      })
      return c.json({ decision: 'approve' })
    }

    // reject — ConfirmSchema guarantees a non-empty comment.
    const comment = parsed.data.comment ?? ''
    const fresh = await freshGateView()
    for (const h of holders) {
      await setNodeRunStatus({
        db: deps.db,
        nodeRunId: h.id,
        to: 'done',
        allowedFrom: ['awaiting_review'],
        reason: 'dw-gate-rejected',
      })
    }
    const rejectRounds = fresh.dw.rejectRounds + 1
    if (rejectRounds >= DW_MAX_REJECT_ROUNDS) {
      // Hard cap (design §8): repeated rejection is a signal the orchestrator
      // cannot satisfy the human — fail the task instead of looping forever.
      // The dw slot rides the SAME status CAS (extra whitelist) so a lost
      // race can't leave rounds counted on a task that never flipped.
      const nextDw: DwState = {
        ...fresh.dw,
        phase: 'rejected',
        rejectRounds,
        rejectionComment: comment,
      }
      await setTaskStatus({
        db: deps.db,
        taskId,
        to: 'failed',
        allowedFrom: ['awaiting_review'],
        extra: {
          finishedAt: Date.now(),
          errorSummary: 'dw-reject-exhausted',
          errorMessage: `dynamic workflow rejected ${rejectRounds} time(s) — DW_MAX_REJECT_ROUNDS reached`,
          workgroupConfigJson: JSON.stringify({ ...fresh.raw, dw: nextDw }),
        },
        reason: 'dw-reject-exhausted',
      })
      const failed = await getTask(deps.db, taskId)
      if (failed !== null) emitTaskStatus(failed)
      return c.json({ decision: 'reject', exhausted: true })
    }
    const { generatedDef: _dropped, ...dwRest } = fresh.dw
    const nextDw: DwState = {
      ...dwRest,
      phase: 'generating',
      generateAttempts: 0,
      rejectRounds,
      rejectionComment: comment,
    }
    // Codex impl-gate P1: the phase reset rides the resume ownership CAS —
    // NOT a separate write + fire-and-forget kick. A failed resume (lost CAS,
    // 410 worktree preflight) therefore leaves phase='awaiting_confirm' and
    // the gate re-triable, instead of stranding an awaiting_review task whose
    // phase already moved (generic /resume refuses turn-engine workgroup
    // tasks, so that stranding had no recovery path). The already-closed
    // holder is benign: the gate check reads (phase, status), and the
    // generate engine re-mints a holder on its awaiting_confirm branch.
    await resumeDynamicWorkflowExecution(deps.db, taskId, buildResumeDeps(), {
      workgroupConfigJson: JSON.stringify({ ...fresh.raw, dw: nextDw }),
    })
    return c.json({ decision: 'reject' })
  })

  // RFC-167 (design §3.2 另存) — persist the generated one-shot DAG as a
  // reusable workflows-table row. Available whenever a generated definition
  // exists (awaiting_confirm onward). Creating a NEW workflow is a new-refs
  // event (RFC-099 D15) — the same gate as POST /api/workflows.
  app.post('/api/workgroup-tasks/:taskId/dw-save-as-workflow', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { config, raw } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = SaveAsWorkflowSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workgroup-save-as-invalid', 'invalid save-as-workflow body', {
        issues: parsed.error.issues,
      })
    }
    const dw = parseDwState(raw.dw)
    if (config.mode !== 'dynamic_workflow' || dw === null || dw.generatedDef === undefined) {
      throw new ConflictError(
        'dw-no-generated-workflow',
        'this task has no generated workflow to save',
      )
    }
    const generated = WorkflowDefinitionSchema.safeParse(dw.generatedDef)
    if (!generated.success) {
      throw new ConflictError(
        'dw-generated-def-invalid',
        'the stored generated workflow is unreadable',
      )
    }
    await assertNewRefsUsable(deps.db, actor, [
      { type: 'agent', names: [...extractWorkflowAgentNames(generated.data)] },
    ])
    const created = await createWorkflow(
      deps.db,
      {
        name: parsed.data.name,
        description: parsed.data.description ?? '',
        definition: generated.data,
      },
      { ownerUserId: actor.user.id },
    )
    return c.json({ id: created.id, name: created.name }, 201)
  })

  // PR-5 (design §8.4) — mid-run config edits on the TASK COPY (the resource
  // row is untouched; mode/leader/repo are immutable). Joining members get a
  // cursor at the current max message id = join-no-history (msghub 语义).
  app.put('/api/workgroup-tasks/:taskId/config', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { task, config, raw } = await loadVisibleWorkgroupTask(actor, taskId)
    if (task.status === 'done' || task.status === 'failed' || task.status === 'canceled') {
      throw new ConflictError('workgroup-task-terminal', 'cannot edit a finished workgroup task')
    }
    const parsed = ConfigPatchSchema.safeParse(await safeJson(c.req.raw))
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
    return c.json({ changes })
  })

  app.post('/api/workgroup-tasks/:taskId/assignments/:id/cancel', async (c) => {
    const taskId = c.req.param('taskId')
    const assignmentId = c.req.param('id')
    const actor = actorOf(c)
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
    return c.body(null, 204)
  })
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

function safeMentions(json: string): string[] {
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

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
