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

import type { Context, Hono } from 'hono'
import { TaskQuestionPhaseSchema, type TaskActorRole } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import type { CollaborationRouteOperations } from '@/modules/collaboration/public/participants'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { TASK_QUESTION_CONFLICT } from '@/services/taskQuestionConflicts'

function requireQuestionOperations(
  operations: CollaborationRouteOperations | undefined,
): CollaborationRouteOperations['questions'] {
  if (operations === undefined) throw new Error('collaboration-route-operations-not-composed')
  return operations.questions
}

async function loadVisibleTask(
  operations: CollaborationRouteOperations,
  taskId: string,
  actor: Actor,
) {
  const access = await operations.access.resolveTask({ actor, taskId })
  if (access.task === null || !access.visible) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  return access
}

function requireActorRole(access: Awaited<ReturnType<typeof loadVisibleTask>>): TaskActorRole {
  if (access.actorRole !== null) return access.actorRole
  throw new ForbiddenError(
    'not-task-member',
    'only task members or an actor with the required global task authority can do this',
  )
}

/** Member-gated write entry: 404 if task invisible, 403 if not a member, 404 if
 *  the entry belongs to another task. Returns the role snapshot + actor. */
async function gateMemberEntry(
  c: Context,
  operations: CollaborationRouteOperations,
): Promise<{ entryId: string; role: TaskActorRole; actor: Actor }> {
  const taskId = c.req.param('id') ?? ''
  const entryId = c.req.param('entryId') ?? ''
  const actor = actorOf(c)
  const access = await loadVisibleTask(operations, taskId, actor)
  const role = requireActorRole(access)
  const entryTaskId = await operations.access.questionTaskId(entryId)
  if (entryTaskId !== taskId) {
    throw new NotFoundError(TASK_QUESTION_CONFLICT.notFound, `task question ${entryId} not found`)
  }
  return { entryId, role, actor }
}

export function mountTaskQuestionRoutes(app: Hono, operations: CollaborationRouteOperations): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/questions',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List task question entries',
    },
    async (c) => {
      const taskId = c.req.param('id')
      await loadVisibleTask(operations, taskId, actorOf(c))
      const sourceNodeId = c.req.query('sourceNodeId') || undefined
      // RFC-247 T3: validate rather than cast. The old `as TaskQuestionPhase`
      // let `?phase=bogus` through to the service, where it silently matched
      // nothing instead of being refused.
      const phaseRaw = c.req.query('phase')
      const phase =
        phaseRaw === undefined || phaseRaw === ''
          ? undefined
          : (() => {
              const parsed = TaskQuestionPhaseSchema.safeParse(phaseRaw)
              if (!parsed.success) {
                throw new ValidationError('invalid-filter', `invalid phase: ${phaseRaw}`)
              }
              return parsed.data
            })()
      return c.json(
        await requireQuestionOperations(operations).list({
          taskId,
          ...(sourceNodeId === undefined ? {} : { sourceNodeId }),
          ...(phase === undefined ? {} : { phase }),
        }),
      )
    },
  )

  // RFC-120 §15 — author a MANUAL question (自主新增/复制). Member-gated (任务成员；ACL
  // 同 reassign/stage). Body { title, body, targetNodeId? }: title+body required; if
  // targetNodeId is given it must be a workflow agent node and the row is created staged
  // (待下发) ready for batch-dispatch (§15.2), else 待指派. Dispatch + manual_body injection
  // reuse the §18 per-node queue (which requires a deferred-dispatch task). The creator is
  // recorded for audit only — NEVER enters a prompt (RFC-099 prompt-isolation).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/questions/manual',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Raise a manual question',
    },
    async (c) => {
      const taskId = c.req.param('id')
      const actor = actorOf(c)
      const access = await loadVisibleTask(operations, taskId, actor)
      const role = requireActorRole(access)
      const body = (await c.req.json().catch(() => ({}))) as {
        title?: unknown
        body?: unknown
        targetNodeId?: unknown
      }
      const title = typeof body.title === 'string' ? body.title : ''
      const instruction = typeof body.body === 'string' ? body.body : ''
      const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId : null
      const { id } = await requireQuestionOperations(operations).createManual({
        taskId,
        title,
        body: instruction,
        targetNodeId,
        actor: { userId: actor.user.id, role },
      })
      return c.json({ ok: true, id })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/questions/:entryId/confirm',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Confirm a question entry',
    },
    async (c) => {
      const { entryId, role, actor } = await gateMemberEntry(c, operations)
      await requireQuestionOperations(operations).confirm({
        entryId,
        actor: { userId: actor.user.id, role },
      })
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/questions/:entryId/reassign',
      permissions: ['tasks:update'],
      // RFC-329 —— was `never`, with no comment saying why. It was the only route
      // in this file closed to tokens (list / manual / confirm / stage / dispatch
      // are all `allow`), and RFC-247 D5's reason does not reach it: the four URL
      // shapes D5 closes are the ones that change owner / grants / visibility, and
      // this one changes `targetNodeId` — which designer node handles a question.
      // The answer boundary is unaffected: `gateMemberEntry` below still requires
      // task membership, and that check knows nothing about credential type.
      tokenAccess: 'allow',
      summary: 'Reassign a question entry',
    },
    async (c) => {
      const { entryId, role, actor } = await gateMemberEntry(c, operations)
      const body = (await c.req.json().catch(() => ({}))) as { targetNodeId?: unknown }
      const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId : ''
      if (!targetNodeId) {
        throw new ValidationError('target-node-required', 'targetNodeId is required')
      }
      // RFC-162: `action` tells the client what happened — 'added-designer' (a clarify question
      // gained an upstream/downstream designer handler), 'removed-designer' (back to single card),
      // or 'moved-manual' (a manual question re-targeted). The asker entry is always kept.
      const action = await requireQuestionOperations(operations).reassign({
        entryId,
        targetNodeId,
        actor: { userId: actor.user.id, role },
      })
      return c.json({ ok: true, action })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/questions/:entryId/stage',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Stage a question entry',
    },
    async (c) => {
      const { entryId, role, actor } = await gateMemberEntry(c, operations)
      const body = (await c.req.json().catch(() => ({}))) as { staged?: unknown }
      const staged = body.staged !== false // default true
      await requireQuestionOperations(operations).stage({
        entryId,
        staged,
        actor: { userId: actor.user.id, role },
      })
      return c.json({ ok: true })
    },
  )

  // RFC-120 T9 (model A) — batch-dispatch the chosen entries: mint the handler
  // reruns + stamp trigger_run_id (dispatchTaskQuestions) then resumeTask to
  // RELEASE the deferred park (the same resume the clarify route uses). Without
  // this route a deferred-dispatch task parks awaiting_human forever (Codex H2).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/questions/dispatch',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Dispatch staged questions (advances the task)',
    },
    async (c) => {
      const taskId = c.req.param('id')
      const actor = actorOf(c)
      const access = await loadVisibleTask(operations, taskId, actor)
      const role = requireActorRole(access)
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
      const result = await requireQuestionOperations(operations).dispatch({
        actor,
        actorRole: role,
        taskId,
        entryIds,
        ...(c.req.header('Idempotency-Key') === undefined
          ? {}
          : { idempotencyKey: c.req.header('Idempotency-Key')! }),
      })
      return c.json({
        ok: true,
        taskId: result.taskId,
        receipt: result.receipt,
        reruns: result.reruns,
        dispatchedEntryIds: result.dispatchedEntryIds,
        deferred: result.deferred,
      })
    },
  )
}
