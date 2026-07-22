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
  WorkflowDefinitionSchema,
  WorkflowNameSchema,
  WorkgroupRuntimeConfigSchema,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Hono } from 'hono'
import { z } from 'zod'
import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  clarifySessions,
  nodeRuns,
  tasks,
  workgroupAssignments,
  taskNodeClarifyDirectives,
  workgroupMessages,
  workgroupTaskState,
} from '@/db/schema'
import { DW_GATE_CAUSE, DW_MAX_REJECT_ROUNDS } from '@/services/dynamicWorkflowRunner'
import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'
import { validateDynamicWorkflowDef } from '@/services/orchestratorAgent'
import { assertNewRefsUsable, extractWorkflowAgentNames } from '@/services/resourceRefs'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import { emitTaskStatus, getTask, resumeDynamicWorkflowExecution } from '@/services/task'
import { canViewTask } from '@/services/taskCollab'
import { createWorkflow } from '@/services/workflow'
import {} from '@/services/workgroup/lifecycle'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '@/services/workgroup/constants'
import { gateViewOf, setDwState } from '@/services/workgroup/state'
import {
  buildWorkgroupTaskActions,
  ConfirmSchema,
  safeJson,
  safeMentions,
} from '@/services/workgroup/taskActions'
import { deriveMemberCurrentRuns, deriveWorkgroupRunHistory } from '@/services/workgroup/room'
import { deriveRoundsUsed, roundedModeOf } from '@/services/workgroup/rounds'
import { ConflictError, ValidationError } from '@/util/errors'

/** RFC-167 — POST .../dw-save-as-workflow body. */
const SaveAsWorkflowSchema = z.object({
  name: WorkflowNameSchema,
  description: z.string().max(4096).optional(),
})

/** RFC-054 W1-7: zod-parse instead of `as Record` for reading our own
 * task-owned config JSON (routes/*.ts may not `as`-cast). */
const JsonObjectSchema = z.record(z.string(), z.unknown())

export { isWorkgroupKickResumable, resolveMentions } from '@/services/workgroup/taskActions'

/**
 * 2026-07-21 —— 房间响应的 `pauseReason`：任务当前停在 awaiting_human 时读
 * workgroup_task_state.pause_reason（引擎在返回 awaiting_human 前写入，RFC-217
 * T2 出 JSON 槽），否则恒 null（读方门槛：陈值永不外泄，列无需清理）。纯函数
 * 导出供测试直锁——与 isWorkgroupKickResumable 同款先例。
 */
export function resolveRoomPauseReason(
  taskStatus: string,
  pauseReason: string | null,
): string | null {
  if (taskStatus !== 'awaiting_human') return null
  return pauseReason !== null && pauseReason.length > 0 ? pauseReason : null
}

export function mountWorkgroupTaskRoutes(app: Hono, deps: AppDeps): void {
  const actions = buildWorkgroupTaskActions({ db: deps.db, configPath: deps.configPath })
  const { loadVisibleWorkgroupTask, buildResumeDeps } = actions

  app.post('/api/workgroup-tasks/:taskId/messages', async (c) =>
    c.json(
      await actions.postRoomMessage(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw)),
      201,
    ),
  )

  app.post('/api/workgroup-tasks/:taskId/assignments/:id/deliver', async (c) =>
    c.json(
      await actions.deliverAssignment(
        actorOf(c),
        c.req.param('taskId'),
        c.req.param('id'),
        await safeJson(c.req.raw),
      ),
      201,
    ),
  )

  app.post('/api/workgroup-tasks/:taskId/confirm', async (c) =>
    c.json(await actions.confirmGate(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw))),
  )

  app.put('/api/workgroup-tasks/:taskId/config', async (c) =>
    c.json(
      await actions.updateTaskConfig(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw)),
    ),
  )

  app.post('/api/workgroup-tasks/:taskId/assignments/:id/cancel', async (c) => {
    await actions.cancelAssignment(actorOf(c), c.req.param('taskId'), c.req.param('id'))
    return c.body(null, 204)
  })
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
      if (
        gateStatusById.get(row.id) === 'awaiting_confirmation' &&
        row.status === 'awaiting_review'
      )
        gates++
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
    const { task, config, state } = await loadVisibleWorkgroupTask(actorOf(c), taskId)
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

  app.post('/api/workgroup-tasks/:taskId/dw-confirm', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { task, config, state } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = ConfirmSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workgroup-confirm-invalid', 'invalid confirm payload', {
        issues: parsed.error.issues,
      })
    }
    const dw = state.dwState
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
      config: WorkgroupRuntimeConfig
      dw: DwState
    }> {
      const fresh = await loadVisibleWorkgroupTask(actor, taskId)
      const freshDw = fresh.state.dwState
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
      return { config: fresh.config, dw: freshDw }
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
        dw: nextDw,
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
        },
        reason: 'dw-reject-exhausted',
      })
      // RFC-217 T2 — the checkpoint write follows the status CAS instead of
      // riding its extra-columns (dw now lives in workgroup_task_state). A
      // crash between the two leaves status=failed with phase stuck at
      // awaiting_confirm — benign: every dw gate requires status
      // awaiting_review, so nothing re-opens; the phase is display-only on a
      // terminal task.
      await setDwState(deps.db, taskId, nextDw)
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
    // RFC-217 T2: the write itself is setDwStateTx inside the claim tx.
    await resumeDynamicWorkflowExecution(deps.db, taskId, buildResumeDeps(), { dw: nextDw })
    return c.json({ decision: 'reject' })
  })

  // RFC-167 (design §3.2 另存) — persist the generated one-shot DAG as a
  // reusable workflows-table row. Available whenever a generated definition
  // exists (awaiting_confirm onward). Creating a NEW workflow is a new-refs
  // event (RFC-099 D15) — the same gate as POST /api/workflows.
  app.post('/api/workgroup-tasks/:taskId/dw-save-as-workflow', async (c) => {
    const taskId = c.req.param('taskId')
    const actor = actorOf(c)
    const { config, state } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = SaveAsWorkflowSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workgroup-save-as-invalid', 'invalid save-as-workflow body', {
        issues: parsed.error.issues,
      })
    }
    const dw = state.dwState
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
}
