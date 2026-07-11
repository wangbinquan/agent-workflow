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
  WorkflowDefinitionSchema,
  WorkflowNameSchema,
  WorkgroupRuntimeConfigSchema,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { z } from 'zod'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { nodeRuns, tasks, workgroupAssignments, workgroupMessages } from '@/db/schema'
import { DW_GATE_CAUSE, DW_MAX_REJECT_ROUNDS } from '@/services/dynamicWorkflowRunner'
import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'
import { validateDynamicWorkflowDef } from '@/services/orchestratorAgent'
import { assertNewRefsUsable, extractWorkflowAgentNames } from '@/services/resourceRefs'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import {
  emitTaskStatus,
  getTask,
  resumeDynamicWorkflowExecution,
  resumeTask,
} from '@/services/task'
import { canViewTask } from '@/services/taskCollab'
import { createWorkflow } from '@/services/workflow'
import { advanceMemberCursor, casAssignmentStatus } from '@/services/workgroupLifecycle'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
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
  maxRounds: z.number().int().positive().max(500).optional(),
  completionGate: z.boolean().optional(),
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
    const [messages, assignments] = await Promise.all([
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
    ])
    const gateRaw = JsonObjectSchema.parse(raw.gate ?? {})
    return c.json({
      taskId,
      taskStatus: task.status,
      config,
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

    // 1. dispatch one assignment per mentioned member (决策 #14 — human @ is
    //    a DIRECT dispatch, same rank as a leader dispatch).
    const assignmentIds: string[] = []
    for (const member of mentioned) {
      const id = ulid()
      await deps.db.insert(workgroupAssignments).values({
        id,
        taskId,
        round: 0,
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
    await deps.db.insert(workgroupMessages).values({
      id: messageId,
      taskId,
      round: 0,
      authorKind: 'human',
      authorUserId: actor.user.id,
      kind: mentioned.length > 0 ? 'dispatch' : 'chat',
      bodyMd: body,
      mentionsJson: JSON.stringify(mentioned.map((m) => m.id)),
      assignmentId: assignmentIds[0] ?? null,
      createdAt: now,
    })
    broadcastWg(taskId, {
      type: 'wg.message.created',
      messageId,
      kind: mentioned.length > 0 ? 'dispatch' : 'chat',
    })

    // 3. a parked task re-wakes (leader-idle / clarify-or-delivery parking —
    //    the engine re-derives; leader sees the message as new-content).
    if (task.status === 'awaiting_human') kickResume(taskId)
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
    await deps.db.insert(workgroupMessages).values({
      id: deliveryId,
      taskId,
      round: row.round,
      authorKind: 'human',
      authorMemberId: member.id,
      authorUserId: actor.user.id,
      kind: 'delivery',
      bodyMd,
      mentionsJson: '[]',
      assignmentId,
      createdAt: Date.now(),
    })
    const flipped = await casAssignmentStatus(deps.db, assignmentId, 'dispatched', 'delivered', {
      resultMessageId: deliveryId,
    })
    if (!flipped) {
      throw new ConflictError(
        'workgroup-delivery-conflict',
        `assignment is '${row.status}' — only dispatched human cards accept delivery`,
      )
    }
    broadcastWg(taskId, { type: 'wg.message.created', messageId: deliveryId, kind: 'delivery' })
    if (task.status === 'awaiting_human') kickResume(taskId)
    return c.json({ messageId: deliveryId }, 201)
  })

  // PR-5 (design §8.2) — completion-gate decision. Task members only (same
  // answer boundary); approve finishes, reject re-wakes the leader with the
  // comment as a high-priority injection item.
  app.post('/api/workgroup-tasks/:taskId/confirm', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { task, raw } = await loadVisibleWorkgroupTask(actor, taskId)
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
    const nextGate = approve
      ? { ...gateRaw, awaitingConfirmation: false, approved: true, rejected: false }
      : {
          ...gateRaw,
          awaitingConfirmation: false,
          approved: false,
          declaredDone: false,
          rejected: true,
          rejectedComment: parsed.data.comment ?? '',
        }
    await deps.db
      .update(tasks)
      .set({ workgroupConfigJson: JSON.stringify({ ...raw, gate: nextGate }) })
      .where(eq(tasks.id, taskId))
    // close the gate holder run (invariant row) — awaiting_review → done
    const holder = (
      await deps.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.rerunCause, 'wg-gate')))
    ).filter((r) => r.status === 'awaiting_review')
    for (const h of holder) {
      await setNodeRunStatus({
        db: deps.db,
        nodeRunId: h.id,
        to: 'done',
        allowedFrom: ['awaiting_review'],
        reason: approve ? 'wg-gate-approved' : 'wg-gate-rejected',
      })
    }
    await deps.db.insert(workgroupMessages).values({
      id: ulid(),
      taskId,
      round: 0,
      authorKind: 'human',
      authorUserId: actor.user.id,
      kind: 'system',
      bodyMd: approve
        ? 'completion gate APPROVED'
        : `completion gate REJECTED: ${parsed.data.comment ?? ''}`,
      mentionsJson: '[]',
      createdAt: Date.now(),
    })
    broadcastWg(taskId, { type: 'wg.gate.updated', awaitingConfirmation: false })
    // re-enter the engine from awaiting_review (approve → finishes; reject →
    // leader wakes with gate-rejected).
    kickResume(taskId)
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
    const changes: string[] = []
    let members = [...config.members]

    if (patch.removeMemberIds !== undefined && patch.removeMemberIds.length > 0) {
      const removing = new Set(patch.removeMemberIds)
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
      // non-terminal cards of removed members: lw cancel; fc back to open.
      const rows = await deps.db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.taskId, taskId))
      for (const a of rows) {
        if (a.assigneeMemberId === null || !removing.has(a.assigneeMemberId)) continue
        if (a.status === 'open' || a.status === 'dispatched' || a.status === 'awaiting_human') {
          if (config.mode === 'free_collab' && a.status !== 'open') {
            const reopened =
              a.status === 'dispatched' &&
              (await casAssignmentStatus(deps.db, a.id, 'dispatched', 'failed').catch(() => false))
            if (reopened) {
              await casAssignmentStatus(deps.db, a.id, 'failed', 'open', {
                assigneeMemberId: null,
                nodeRunId: null,
              }).catch(() => false)
            }
          } else {
            await casAssignmentStatus(deps.db, a.id, a.status, 'canceled').catch(() => false)
          }
        }
      }
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
        if (m.memberType === 'human' && !m.userId) {
          throw new ValidationError('workgroup-config-invalid', 'human member requires userId')
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
          await advanceMemberCursor(deps.db, taskId, id, maxMsg)
        }
      }
    }

    const nextConfig = {
      ...raw,
      members,
      ...(patch.switches !== undefined ? { switches: patch.switches } : {}),
      ...(patch.maxRounds !== undefined ? { maxRounds: patch.maxRounds } : {}),
      ...(patch.completionGate !== undefined ? { completionGate: patch.completionGate } : {}),
    }
    if (patch.switches !== undefined) changes.push('switches updated')
    if (patch.maxRounds !== undefined) changes.push(`maxRounds → ${patch.maxRounds}`)
    if (patch.completionGate !== undefined) changes.push(`completionGate → ${patch.completionGate}`)
    if (changes.length === 0) {
      throw new ValidationError('workgroup-config-empty', 'nothing to change')
    }
    await deps.db
      .update(tasks)
      .set({ workgroupConfigJson: JSON.stringify(nextConfig) })
      .where(eq(tasks.id, taskId))
    const msgId = ulid()
    await deps.db.insert(workgroupMessages).values({
      id: msgId,
      taskId,
      round: 0,
      authorKind: 'human',
      authorUserId: actor.user.id,
      kind: 'system',
      bodyMd: `config updated: ${changes.join('; ')}`,
      mentionsJson: '[]',
      createdAt: Date.now(),
    })
    broadcastWg(taskId, { type: 'wg.message.created', messageId: msgId, kind: 'system' })
    if (task.status === 'awaiting_human') kickResume(taskId)
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
    await deps.db.insert(workgroupMessages).values({
      id: ulid(),
      taskId,
      round: row.round,
      authorKind: 'system',
      kind: 'system',
      bodyMd: `assignment '${row.title}' canceled by a task member`,
      mentionsJson: '[]',
      assignmentId,
      createdAt: Date.now(),
    })
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
