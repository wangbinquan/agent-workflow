// RFC-120 — REST endpoints for the task question list / 任务中心.
//
//   GET  /api/tasks/:id/questions                       list (filter: sourceNodeId / phase)
//   POST /api/tasks/:id/questions/manual                §15 新增/复制手动问题 {title,body,targetNodeId?}
//   POST /api/tasks/:id/questions/:entryId/confirm      已处理待确认 → 完成
//   POST /api/tasks/:id/questions/:entryId/reassign     改派 designer handler {targetNodeId}
//   POST /api/tasks/:id/questions/:entryId/stage        拖入/出「待下发」{staged}
//   POST /api/tasks/:id/questions/dispatch              批量下发 {entryIds} → release gate
//
// Auth: token middleware applies via createApp's app.use('/api/*', ...).
// Read inherits task visibility (canViewTask → 404 mirrors task routes); writes
// require task membership (requireTaskMember → 403). The entry must belong to the
// task in the path (cross-task entryId → 404).

import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { TaskActorRole, TaskQuestionPhase } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
// RFC-143 PR-5: resolveOpencodeCmd deduped to util/opencode (was 5 route-local copies).
import { resolveOpencodeCmd } from '@/util/opencode'
import { taskQuestions, tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import {
  confirmTaskQuestion,
  createManualTaskQuestion,
  listTaskQuestions,
  reassignTaskQuestion,
  stageTaskQuestion,
} from '@/services/taskQuestions'
import { dispatchTaskQuestions } from '@/services/taskQuestionDispatch'
import { canViewTask, requireTaskMember } from '@/services/taskCollab'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { resumeTask } from '@/services/task'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('task-questions-route')

async function loadVisibleTask(deps: AppDeps, taskId: string, actor: Actor) {
  const [t] = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
  if (!t || !(await canViewTask(deps.db, actor, t))) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  return t
}

/** Member-gated write entry: 404 if task invisible, 403 if not a member, 404 if
 *  the entry belongs to another task. Returns the role snapshot + actor. */
async function gateMemberEntry(
  c: Context,
  deps: AppDeps,
): Promise<{ entryId: string; role: TaskActorRole; actor: Actor }> {
  const taskId = c.req.param('id') ?? ''
  const entryId = c.req.param('entryId') ?? ''
  const actor = actorOf(c)
  const task = await loadVisibleTask(deps, taskId, actor)
  const role = await requireTaskMember(deps.db, actor, task)
  const [e] = await deps.db
    .select({ taskId: taskQuestions.taskId })
    .from(taskQuestions)
    .where(eq(taskQuestions.id, entryId))
    .limit(1)
  if (!e || e.taskId !== taskId) {
    throw new NotFoundError('task-question-not-found', `task question ${entryId} not found`)
  }
  return { entryId, role, actor }
}

export function mountTaskQuestionRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks/:id/questions', async (c) => {
    const taskId = c.req.param('id')
    await loadVisibleTask(deps, taskId, actorOf(c))
    const sourceNodeId = c.req.query('sourceNodeId') || undefined
    const phase = (c.req.query('phase') as TaskQuestionPhase | undefined) || undefined
    return c.json(await listTaskQuestions(deps.db, taskId, { sourceNodeId, phase }))
  })

  // RFC-120 §15 — author a MANUAL question (自主新增/复制). Member-gated (任务成员；ACL
  // 同 reassign/stage). Body { title, body, targetNodeId? }: title+body required; if
  // targetNodeId is given it must be a workflow agent node and the row is created staged
  // (待下发) ready for batch-dispatch (§15.2), else 待指派. Dispatch + manual_body injection
  // reuse the §18 per-node queue (which requires a deferred-dispatch task). The creator is
  // recorded for audit only — NEVER enters a prompt (RFC-099 prompt-isolation).
  app.post('/api/tasks/:id/questions/manual', async (c) => {
    const taskId = c.req.param('id')
    const actor = actorOf(c)
    const task = await loadVisibleTask(deps, taskId, actor)
    const role = await requireTaskMember(deps.db, actor, task)
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown
      body?: unknown
      targetNodeId?: unknown
    }
    const title = typeof body.title === 'string' ? body.title : ''
    const instruction = typeof body.body === 'string' ? body.body : ''
    const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId : null
    const { id } = await createManualTaskQuestion(
      deps.db,
      taskId,
      { title, body: instruction, targetNodeId },
      { userId: actor.user.id, role },
    )
    return c.json({ ok: true, id })
  })

  app.post('/api/tasks/:id/questions/:entryId/confirm', async (c) => {
    const { entryId, role, actor } = await gateMemberEntry(c, deps)
    await confirmTaskQuestion(deps.db, entryId, { userId: actor.user.id, role })
    return c.json({ ok: true })
  })

  app.post('/api/tasks/:id/questions/:entryId/reassign', async (c) => {
    const { entryId, role, actor } = await gateMemberEntry(c, deps)
    const body = (await c.req.json().catch(() => ({}))) as { targetNodeId?: unknown }
    const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId : ''
    if (!targetNodeId) {
      throw new ValidationError('target-node-required', 'targetNodeId is required')
    }
    // RFC-138: `action` tells the client what actually happened — 'override' (regular
    // re-target) vs 'collapsed-to-questioner' (cross designer entry re-targeted to its
    // round's asking node ⇒ scope flipped, entry deleted). Additive, back-compatible.
    const action = await reassignTaskQuestion(deps.db, entryId, targetNodeId, {
      userId: actor.user.id,
      role,
    })
    return c.json({ ok: true, action })
  })

  app.post('/api/tasks/:id/questions/:entryId/stage', async (c) => {
    const { entryId, role, actor } = await gateMemberEntry(c, deps)
    const body = (await c.req.json().catch(() => ({}))) as { staged?: unknown }
    const staged = body.staged !== false // default true
    await stageTaskQuestion(deps.db, entryId, staged, { userId: actor.user.id, role })
    return c.json({ ok: true })
  })

  // RFC-120 T9 (model A) — batch-dispatch the chosen entries: mint the handler
  // reruns + stamp trigger_run_id (dispatchTaskQuestions) then resumeTask to
  // RELEASE the deferred park (the same resume the clarify route uses). Without
  // this route a deferred-dispatch task parks awaiting_human forever (Codex H2).
  app.post('/api/tasks/:id/questions/dispatch', async (c) => {
    const taskId = c.req.param('id')
    const actor = actorOf(c)
    const task = await loadVisibleTask(deps, taskId, actor)
    const role = await requireTaskMember(deps.db, actor, task)
    // RFC-132 PR-D' 步骤1 (T8 flag 停读): 统一模型下所有任务都是 deferred-dispatch——
    // batch-dispatch 恒适用（旧 deferred-only 门移除；dispatchTaskQuestions 仍防御性去重）。
    const body = (await c.req.json().catch(() => ({}))) as { entryIds?: unknown }
    const entryIds = Array.isArray(body.entryIds)
      ? body.entryIds.filter((x): x is string => typeof x === 'string')
      : []
    if (entryIds.length === 0) {
      throw new ValidationError(
        'entry-ids-required',
        'entryIds (a non-empty array of task_question ids) is required',
      )
    }
    const result = await dispatchTaskQuestions(deps.db, taskId, entryIds, {
      userId: actor.user.id,
      role,
    })
    // Release the gate: re-enter scheduling so the minted reruns dispatch and the
    // task leaves awaiting_human. Best-effort, mirroring the clarify route. NB: a
    // TERMINAL task (done/canceled) is already rejected by dispatchTaskQuestions'
    // status pre-check ABOVE (nothing minted), so `task-not-resumable` here is ONLY
    // the benign live-scheduler race (a `running` deferred task — the live loop picks
    // up the freshly-minted rerun); it is logged at info, not surfaced as an error.
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const resumeDeps: Parameters<typeof resumeTask>[2] = {
      db: deps.db,
      appHome: Paths.root,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...resolveLaunchRuntimeConfig(deps.configPath),
    }
    void resumeTask(deps.db, taskId, resumeDeps).catch((err) => {
      if (err instanceof ConflictError && err.code === 'task-not-resumable') {
        log.info('task-questions dispatch resume deferred', { taskId })
        return
      }
      log.warn('task-questions dispatch resume threw', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return c.json({ ok: true, reruns: result.reruns })
  })
}
