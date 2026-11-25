// GET    /api/tasks                       list (filters via query)
// POST   /api/tasks                       start task; scheduler kicks off in background
// GET    /api/tasks/:id                    full task incl. workflowSnapshot + inputs
// POST   /api/tasks/:id/cancel             abort in-flight task
// GET    /api/tasks/:id/node-runs          per-node run rows + captured outputs
// GET    /api/tasks/:id/diff               cumulative git diff in the worktree
// GET    /api/tasks/:id/alerts             RFC-053 P-6 open lifecycle alerts
// POST   /api/tasks/:id/diagnose           RFC-053 P-3 live invariant scan
//
// Resume / single-node retry land in M3 (P-3-08, P-3-09).

import {
  RepairRequestSchema,
  ReplaceReviewNodeReviewersBodySchema,
  rejectRetiredStartTaskKeys,
  StartTaskSchema,
  TaskStatusSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { registerRoute, registerRouteMiddleware } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/platform/http/deleteSnapshot'
import { assertDeleteConfirm, readDeleteBody } from '@/platform/http/deleteConfirm'
import {
  redactEventPayload,
  redactStdout,
  serializeTaskFor,
  workflowReadLensFor,
  shouldRedactFor,
} from '@/auth/tokenRedaction'
import { parseBoolQuery } from '@/platform/http/requestParsing'
import { SyncWorkflowBodySchema, UpdateTaskMembersBodySchema } from '@agent-workflow/shared'
import type { TaskWorkspaceQueries } from '../../application/ports/taskWorkspaceQueries'
import { tasksListBroadcaster, TASKS_LIST_CHANNEL } from '@/ws/broadcaster'
import { NotFoundError, ValidationError } from '@/platform/errors/domainErrors'
import { safeJsonOrEmpty } from '@/platform/http/requestParsing'
import type {
  TaskLifecycleAlertNotices,
  TaskRouteListFilters,
  TaskRouteLifecycleAlertNotice,
} from '@/modules/task-execution/public/types'
import type { TaskDiagnostics } from '../../application/ports/taskDiagnostics'
import type { TaskRouteOperations } from '@/modules/task-execution/public/commands'

function broadcastLifecycleAlert(
  row: TaskRouteLifecycleAlertNotice,
  transition: 'new' | 'promoted',
): void {
  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
    type: 'lifecycle.alert',
    taskId: row.taskId,
    rule: row.rule,
    severity: row.severity,
    transition,
  })
}

function broadcastLifecycleAlertResolved(taskId: string): void {
  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
    type: 'lifecycle.alert.resolved',
    taskId,
  })
}

/** RFC-452: where a diagnose pass reports alert changes; RFC-569: the repair path passes the same object. */
const LIFECYCLE_ALERT_NOTICES: TaskLifecycleAlertNotices = Object.freeze({
  alert: broadcastLifecycleAlert,
  resolved: broadcastLifecycleAlertResolved,
})

export interface TaskRouteDependencies {
  readonly workspaceQueries: TaskWorkspaceQueries
  readonly operations: TaskRouteOperations
  /** RFC-452: alerts, recovery audit, diagnose and the node-run session / inventory / startup reads. */
  readonly diagnostics: TaskDiagnostics
  // RFC-588: the structural diff, change narrative, file content / symbols, code intel and call targets moved to
  // workspace-insight's binding (`mountTaskWorkspaceInsightRoutes`), mounted right after this one.
}

export function mountTaskRoutes(app: Hono, deps: TaskRouteDependencies): void {
  // Keep direct dispatcher/tests fail-closed even though production callers
  // are statically required to supply the complete selected-provider bundle.
  if (deps.workspaceQueries === undefined) throw new Error('task-workspace-queries-not-composed')
  if (deps.operations === undefined) {
    throw new Error('task-route-operations-not-composed')
  }
  if (deps.diagnostics === undefined) {
    throw new Error('task-diagnostics-not-composed')
  }
  const { operations, diagnostics } = deps
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List tasks (legacy shape)',
    },
    async (c) => {
      const actor = actorOf(c)
      const includeOwner = parseBoolQuery(c, 'include_owner', { default: false })
      // The legacy homepage feed shares the same generic catalog boundary as
      // the task-catalog route: durable internal executions stay out of public
      // pagination without any execution-kind-specific branch.
      const filters: {
        -readonly [Key in keyof TaskRouteListFilters]?: TaskRouteListFilters[Key]
      } = { catalogVisibility: 'public' }
      const status = c.req.query('status')
      if (status !== undefined) {
        const parsed = TaskStatusSchema.safeParse(status)
        if (!parsed.success) {
          throw new ValidationError('task-filter-invalid', `unknown status: ${status}`)
        }
        filters.status = parsed.data
      }
      const workflowId = c.req.query('workflow_id') ?? c.req.query('workflowId')
      if (workflowId !== undefined && workflowId !== '') filters.workflowId = workflowId
      const repoPath = c.req.query('repo_path') ?? c.req.query('repoPath')
      if (repoPath !== undefined && repoPath !== '') filters.repoPath = repoPath
      // RFC-159: a scheduled task's run history = its launched tasks.
      const scheduledTaskId = c.req.query('scheduled_task_id') ?? c.req.query('scheduledTaskId')
      if (scheduledTaskId !== undefined && scheduledTaskId !== '')
        filters.scheduledTaskId = scheduledTaskId
      // RFC-243 §8 (PR-5 flip): the list is TOP-LEVEL BY DEFAULT — child
      // executions appear only via include_children=true (flat, with parent
      // badges) or the parent_id children query. Landed together with the
      // nesting UI so awaiting children are never invisible-but-unreachable.
      const includeChildren = c.req.query('include_children')
      const parentId = c.req.query('parent_id') ?? c.req.query('parentId')
      if (parentId !== undefined && parentId !== '') {
        // 实现门 P1-1: a children query IS a child listing — combining it with
        // the top-level default would AND `parent_task_id IS NULL` with
        // `parent_task_id = X` (always empty).
        filters.parentTaskId = parentId
      } else if (includeChildren !== 'true') {
        filters.topLevelOnly = true
      }
      const limit = c.req.query('limit')
      if (limit !== undefined) {
        const n = Number(limit)
        if (!Number.isFinite(n) || n <= 0) {
          throw new ValidationError('task-filter-invalid', `limit must be a positive number`)
        }
        filters.limit = Math.min(n, 500)
      }
      // RFC-036 visibility filter. Admin default scope=all; regular user
      // default scope=mine. Explicit ?scope=mine|shared|all wins. Asking for
      // 'all' without tasks:read:all collapses to 'mine'.
      const rawScope = c.req.query('scope')
      const scope: 'mine' | 'shared' | 'all' =
        rawScope === 'shared'
          ? 'shared'
          : rawScope === 'all'
            ? 'all'
            : rawScope === 'mine'
              ? 'mine'
              : actor.permissions.has('tasks:read:all')
                ? 'all'
                : 'mine'
      if (scope !== 'all') {
        filters.visibility = { actorUserId: actor.user.id, scope }
      } else if (!actor.permissions.has('tasks:read:all')) {
        filters.visibility = { actorUserId: actor.user.id, scope: 'mine' }
      }
      return c.json(
        includeOwner ? await operations.listItems(filters) : await operations.list(filters),
      )
    },
  )

  // RFC-036 visibility gate. All /api/tasks/:id/... reads require the actor
  // to be admin, owner, or a task_collaborators member. Mounted as middleware
  // so each downstream handler can assume the task is visible.
  registerRouteMiddleware(app, '/api/tasks/:id', async (c, next) => {
    // POST /api/tasks does not have :id; skip in that case.
    if (!c.req.param('id')) {
      await next()
      return
    }
    await operations.assertVisible(actorOf(c), c.req.param('id'))
    await next()
  })
  registerRouteMiddleware(app, '/api/tasks/:id/*', async (c, next) => {
    await operations.assertVisible(actorOf(c), c.req.param('id'))
    await next()
  })

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Get one task',
    },
    async (c) => {
      const id = c.req.param('id')
      const task = await operations.get(id)
      if (task === null) {
        throw new NotFoundError('task-not-found', `task '${id}' not found`)
      }
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))))
    },
  )

  // RFC-340 — full-replace reviewer sets for every frozen review node. This
  // remains a task-owner/admin configuration surface; assignments themselves
  // do not make a user a task member.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/reviewers',
      permissions: ['tasks:read'],
      tokenAccess: 'never',
      summary: 'List review-node reviewer assignments',
    },
    async (c) => {
      return c.json(await operations.getReviewers(actorOf(c), c.req.param('id')))
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/tasks/:id/reviewers',
      permissions: ['tasks:update'],
      tokenAccess: 'never',
      summary: 'Replace review-node reviewer assignments',
    },
    async (c) => {
      const parsed = ReplaceReviewNodeReviewersBodySchema.safeParse(
        await safeJsonOrEmpty(c.req.raw),
      )
      if (!parsed.success) {
        throw new ValidationError(
          'review-reviewers-invalid',
          'invalid review-node reviewer payload',
          { issues: parsed.error.issues },
        )
      }
      return c.json(await operations.replaceReviewers(actorOf(c), c.req.param('id'), parsed.data))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks',
      executionGroup: 'task',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Launch a task',
    },
    async (c) => {
      const ct = c.req.header('content-type') ?? ''
      // RFC-020: multipart branch handles launcher uploads. payload field is
      // JSON-encoded StartTask; files[<inputKey>][] fields are the binary
      // contents bound to `kind: 'upload'` inputs.
      if (ct.toLowerCase().startsWith('multipart/form-data')) {
        const task = await operations.launchMultipart(c.req.raw, actorOf(c))
        return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))), 201)
      }

      const bodyJson = await safeJsonOrEmpty(c.req.raw)
      // RFC-099 (D6): the per-node assignments field is gone. Reject payloads
      // still carrying it with a structured 422 instead of silently stripping,
      // so automation callers notice the breaking change.
      if (
        typeof bodyJson === 'object' &&
        bodyJson !== null &&
        Object.prototype.hasOwnProperty.call(bodyJson, 'assignments')
      ) {
        throw new ValidationError(
          'assignments-removed',
          'RFC-099 removed per-node assignments; task members answer reviews/clarifications now',
        )
      }
      // RFC-165 (F1): non-strict zod SILENTLY STRIPS retired path-mode keys, so
      // a mixed body like {scratch:true, repoPath} would silently degrade to a
      // scratch launch. Reject the raw keys before parsing (assignments-removed
      // precedent above).
      {
        const retired = rejectRetiredStartTaskKeys(bodyJson)
        if (retired !== null) {
          const clientOwnedGitIdentity = retired === 'gitUserName' || retired === 'gitUserEmail'
          throw new ValidationError(
            clientOwnedGitIdentity ? 'task-git-identity-client-owned' : 'start-task-path-retired',
            clientOwnedGitIdentity
              ? `RFC-320 derives Git commit identity from the task creator; remove '${retired}'`
              : `RFC-165 retired path-mode launches; remove '${retired}' (push the repo to a real remote and register it, then launch by cachedRepoId)`,
          )
        }

        // RFC-248 H9（实现门 P1）：`sourceTaskId` 由调用方控制。重放前先确认
        // 他**看得见**那个任务——否则「能启动某工作流但看不见任务 X」的用户可以
        // 传 X 的 id，让服务端读出 X 冻结的仓库构成并按它物化，而且泄漏形式是
        // 「任务成功启动」，完全不像一次越权。不可见与不存在同形（都 404）。
        {
          const src = (bodyJson as { sourceTaskId?: unknown }).sourceTaskId
          if (typeof src === 'string' && src.length > 0) {
            await operations.assertReplayVisible(actorOf(c), src)
          }
        }
      }
      const parsed = StartTaskSchema.safeParse(bodyJson)
      if (!parsed.success) {
        throw new ValidationError('task-invalid', 'invalid task payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const task = await operations.launchWorkflow(actor, parsed.data)
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))), 201)
    },
  )

  // RFC-099 (D10) — task members panel. Read open to anyone who can see the
  // task (the visibility middleware above already gated us); writes are
  // owner or `resource-acl:bypass` only (enforced in updateTaskMembers).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/members',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List task members',
    },
    async (c) => {
      const taskId = c.req.param('id')
      return c.json(await operations.getMembers(actorOf(c), taskId))
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/tasks/:id/members',
      permissions: ['tasks:update'],
      tokenAccess: 'never',
      summary: 'Replace task members',
    },
    async (c) => {
      const taskId = c.req.param('id')
      const parsed = UpdateTaskMembersBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('members-invalid', 'invalid members payload', {
          issues: parsed.error.issues,
        })
      }
      return c.json(await operations.replaceMembers(actorOf(c), taskId, parsed.data))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/cancel',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Cancel a task',
    },
    async (c) => {
      // RFC-324 —— 观察者看得见任务，但推动任务是成员的事。
      await operations.requireOperator(actorOf(c), c.req.param('id'))
      const task = await operations.cancel(c.req.param('id'))
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))))
    },
  )

  // RFC-222/RFC-305 — `tasks:delete` hard delete of a terminal task. Route gate
  // tasks:delete is registered in server.ts; visibilityCheck (the /:id
  // middleware) has already confirmed the task exists + is visible to this actor.
  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/tasks/:id',
      permissions: ['tasks:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a task',
    },
    async (c) => {
      const id = c.req.param('id')
      const task = await operations.get(id)
      if (task === null) throw new NotFoundError('task-not-found', `task '${id}' not found`)
      // RFC-222 (D5): type-to-confirm against the task's name (N-5 order — after
      // existence/authz, before the deleteTask business gates).
      assertDeleteConfirm(await readDeleteBody(c), task.name, 'task')
      captureDeleteSnapshot(c, actorOf(c), { name: task.name })
      const result = await operations.delete(id)
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/node-runs',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List node runs',
    },
    async (c) => {
      return c.json(await operations.nodeRuns(c.req.param('id')))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/diff',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Task worktree diff',
    },
    async (c) => {
      return c.json(await operations.diff(c.req.param('id')))
    },
  )

  // RFC-053 P-6: list currently-open lifecycle_alerts (invariant + stuck)
  // for this task. Powers the StuckTaskBanner — banners only render when
  // the response has at least one row. Empty list = healthy task = no
  // banner at all.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/alerts',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List task alerts',
    },
    async (c) => {
      const taskId = c.req.param('id')
      const alerts = await diagnostics.openAlerts(taskId)
      return c.json({ alerts })
    },
  )

  // RFC-108 T3 (AR-11): per-task system-recovery audit trail (boot-reap /
  // shutdown-flip / limit-cancel / snapshot-lost / live-child-survived / …).
  // Behind the same /api/tasks/:id visibility middleware mounted above.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/recovery-events',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List recovery events',
    },
    async (c) => {
      return c.json(await diagnostics.recoveryHistory(c.req.param('id')))
    },
  )

  // RFC-108 T11 (AR-09): human one-click clear of an auto-recovery quarantine
  // (a task that crash-looped past the breaker threshold). Behind the same
  // /api/tasks/:id visibility middleware (owner / collaborator / admin).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/clear-recovery-suspension',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Clear recovery suspension',
    },
    async (c) => {
      // RFC-324 —— 观察者看得见任务，但推动任务是成员的事。
      await operations.requireOperator(actorOf(c), c.req.param('id'))
      await diagnostics.clearRecoverySuspension(c.req.param('id'))
      return c.json({ ok: true })
    },
  )

  // RFC-053 P-3: on-demand invariant scan for the diagnose panel. Reads
  // live (not the cached lifecycle_alerts table) so a stuck-task report
  // reflects the current DB state without waiting for the next hourly tick.
  // RFC-057: after the live invariant scan, also merge in any open
  // stuck-rule rows (S1..S4) from the table. The stuck-task detector has
  // a 30-min freshness gate and runs on its own 5-min cadence, so the
  // live scan alone misses those — leaving the banner saying "open
  // alerts" while the panel says "no findings".
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/diagnose',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Run diagnosis',
    },
    async (c) => {
      // RFC-324 —— 观察者看得见任务，但推动任务是成员的事。
      await operations.requireOperator(actorOf(c), c.req.param('id'))
      return c.json(await diagnostics.diagnose(c.req.param('id'), LIFECYCLE_ALERT_NOTICES))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/resume',
      executionGroup: 'task',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Resume a task',
    },
    async (c) => {
      // RFC-324 —— 观察者看得见任务，但推动任务是成员的事。
      await operations.requireOperator(actorOf(c), c.req.param('id'))
      await operations.assertManualExecutionAllowed(actorOf(c), c.req.param('id'))
      const actor = actorOf(c)
      const task = await operations.resume({ actor, taskId: c.req.param('id') })
      return c.json(serializeTaskFor(task, workflowReadLensFor(actor)))
    },
  )

  // RFC-109 — preview the delta between the task's frozen workflow snapshot and
  // the latest definition of its workflow (drives the "workflow updated" banner
  // + confirm dialog). Read-only; visibilityCheck already gates task membership,
  // and the workflow must be visible (RFC-099, 404-shaped to avoid probing).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/workflow-sync-preview',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Preview a workflow sync',
    },
    async (c) => {
      const id = c.req.param('id')
      return c.json(await operations.workflowSyncPreview(actorOf(c), id))
    },
  )

  // RFC-109 — apply the sync: swap the task's snapshot to the latest definition
  // (recording its version) and continue from the breakpoint. Built-in guard
  // (RFC-104) + workflow visibility (RFC-099) mirror launch; the service owns
  // the version-TOCTOU / invalid / noop / wrapper-blocker / status gates.
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/sync-workflow',
      permissions: ['tasks:update'],
      tokenAccess: 'allow',
      summary: 'Sync the task to its workflow definition',
    },
    async (c) => {
      const id = c.req.param('id')
      const actor = actorOf(c)
      const body = SyncWorkflowBodySchema.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) {
        throw new ValidationError('invalid-body', 'expectedVersion (number) required', {
          issues: body.error.issues,
        })
      }
      const updated = await operations.syncWorkflow({
        actor,
        taskId: id,
        expectedVersion: body.data.expectedVersion,
      })
      return c.json(serializeTaskFor(updated, workflowReadLensFor(actor)))
    },
  )

  // RFC-057: Diagnose-Panel repair options.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/alerts/:alertId/repair-options',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Repair options for an alert',
    },
    async (c) => {
      const actor = actorOf(c)
      const result = await operations.repairOptions({
        actor,
        taskId: c.req.param('id'),
        alertId: c.req.param('alertId'),
      })
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/alerts/:alertId/repair',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Apply an alert repair',
    },
    async (c) => {
      // RFC-324 —— 观察者看得见任务，但推动任务是成员的事。
      await operations.requireOperator(actorOf(c), c.req.param('id'))
      const bodyJson = (await c.req.json().catch(() => ({}))) as unknown
      const parsed = RepairRequestSchema.safeParse(bodyJson)
      if (!parsed.success) {
        throw new ValidationError(
          'confirm-required',
          'POST body must be `{ optionId: string, confirm: true }`',
          parsed.error.issues,
        )
      }
      const actor = actorOf(c)
      const result = await operations.applyRepair({
        actor,
        taskId: c.req.param('id'),
        alertId: c.req.param('alertId'),
        optionId: parsed.data.optionId,
        // RFC-569: the same notices object the diagnose route passes.
        notices: LIFECYCLE_ALERT_NOTICES,
      })
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/nodes/:nodeRunId/retry',
      executionGroup: 'task',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Retry a node (rolls back to pre_snapshot, cascades downstream)',
    },
    async (c) => {
      // RFC-324 —— 观察者看得见任务，但推动任务是成员的事。
      await operations.requireOperator(actorOf(c), c.req.param('id'))
      await operations.assertManualExecutionAllowed(actorOf(c), c.req.param('id'))
      const actor = actorOf(c)
      // flag-audit W0：统一布尔解析（此前 `!== 'false'` 双重否定——任何拼错值静默当
      // true）。产品语义保留默认级联。
      const cascade = parseBoolQuery(c, 'cascade', { default: true })
      const task = await operations.retry({
        actor,
        taskId: c.req.param('id'),
        nodeRunId: c.req.param('nodeRunId'),
        cascade,
      })
      return c.json(serializeTaskFor(task, workflowReadLensFor(actor)))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/nodes/:nodeRunId/stdout',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Node run stdout',
    },
    async (c) => {
      const text = await operations.stdout(c.req.param('id'), c.req.param('nodeRunId'))
      // RFC-247 AC-39 — agent stdout is free-form text the platform cannot
      // classify, so this is best-effort by nature. It is still worth doing on
      // the token channel: a node that echoed a key is one `get_task` away from
      // that key landing in a model's context. A human owner reading their own
      // run's output keeps it verbatim — that is what they are debugging with.
      const actor = actorOf(c)
      return c.text(shouldRedactFor(actor.source) ? redactStdout(text) : text)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/node-runs/:nodeRunId/events',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Node run events',
    },
    async (c) => {
      const sinceRaw = c.req.query('since')
      const limitRaw = c.req.query('limit')
      const opts: { since?: number; limit?: number } = {}
      if (sinceRaw !== undefined) {
        const n = Number(sinceRaw)
        if (!Number.isFinite(n) || n < 0) {
          throw new ValidationError('events-since-invalid', `since must be a non-negative number`)
        }
        opts.since = n
      }
      if (limitRaw !== undefined) {
        const n = Number(limitRaw)
        if (!Number.isFinite(n) || n <= 0) {
          throw new ValidationError('events-limit-invalid', `limit must be a positive number`)
        }
        opts.limit = n
      }
      // RFC-247 AC-39 family — these rows are the same bytes the stdout route
      // already redacts, reached through a different door. A redaction that
      // covers one door is one the caller routes around without trying.
      const eventsActor = actorOf(c)
      const events = await operations.events(c.req.param('id'), c.req.param('nodeRunId'), opts)
      return c.json({
        ...events,
        events: events.events.map((e) => ({
          ...e,
          payload: redactEventPayload(e.payload, eventsActor.source),
        })),
      })
    },
  )

  // RFC-027: Session-tree view consumed by the NodeDetailDrawer's
  // Session tab. Reads the persisted events for one node_run and
  // reassembles a normalized conversation tree (user / assistant text
  // / tool_use / subagent-call, with recursive children for any task
  // tool whose child sessionID was captured into node_run_events by
  // sessionCapture).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/node-runs/:nodeRunId/session',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Node run session view',
    },
    async (c) => {
      return c.json(await diagnostics.sessionTree(c.req.param('id'), c.req.param('nodeRunId')))
    },
  )

  // Runtime inventory rendered at the top of the NodeDetailDrawer's Session tab:
  // what the child process actually loaded this run.
  //
  // RFC-297 made this read end runtime-agnostic. It was RFC-029's opencode-only
  // path — it read `node_runs.inventory_snapshot_json`, which only the injected
  // `aw-inventory-dump.mjs` opencode plugin ever fills, so on Claude Code it
  // found NULL and rendered "no inventory file (the plugin may have failed to
  // load)" — blaming a plugin that runtime does not even have. The service now
  // sources each runtime from its own observation (claude: the `system/init`
  // report kept in the startup-verification record) and returns one shape plus
  // the driver's static declaration, so the frontend picks columns off the
  // declaration instead of knowing runtime names.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/node-runs/:nodeRunId/inventory',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Node run resolved inventory',
    },
    async (c) => {
      return c.json(await diagnostics.runtimeInventory(c.req.param('id'), c.req.param('nodeRunId')))
    },
  )

  // RFC-280 T3: startup verification record — the platform's declared-injection
  // manifest × the runtime's startup report × the diff, written by the runner
  // at settle. Rendered as the node-detail warning banner ("MCP rag-search did
  // not come up; the node ran without its tools").
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/node-runs/:nodeRunId/startup-verification',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Node run startup verification',
    },
    async (c) => {
      return c.json(
        await diagnostics.startupVerification(c.req.param('id'), c.req.param('nodeRunId')),
      )
    },
  )

  // RFC-065 — task detail page "工作目录" tab.
  //
  // List one directory's direct children (lazy load). `path` query param is
  // relative to the task's worktreePath; empty string = root.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/worktree-tree',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Worktree file tree',
    },
    async (c) => {
      const id = c.req.param('id')
      const rel = c.req.query('path') ?? ''
      const { entries, truncated } = await deps.workspaceQueries.listDisplay(id, rel)
      return c.json({ path: rel, entries, truncated })
    },
  )

  // RFC-065 — read one worktree file's text content. Server enforces the
  // 2 MiB cap; oversized returns `{oversized:true, content:''}` with the
  // real size so the UI can render an "too large" hint.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/worktree-file',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Read a worktree file',
    },
    async (c) => {
      const id = c.req.param('id')
      const rel = c.req.query('path') ?? ''
      const result = await deps.workspaceQueries.readDisplay(id, rel)
      return c.json({ path: rel, ...result })
    },
  )
}
