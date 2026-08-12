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
  UPLOAD_INPUTS_DIR,
  isTurnEngineWorkgroupTask,
  RepairRequestSchema,
  rejectRetiredStartTaskKeys,
  StartTaskSchema,
  taskExecutionKind,
  TaskStatusSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { isWorkgroupTask } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { actorOf } from '@/auth/actor'
import { loadConfig } from '@/config'
import { tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import {
  assertCanReplaySourceTask,
  canViewTask,
  getTaskMembers,
  updateTaskMembers,
} from '@/services/taskCollab'
import { canViewResource } from '@/services/resourceAcl'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import {
  redactEventPayload,
  redactStdout,
  serializeTaskFor,
  workflowReadLensFor,
  shouldRedactFor,
} from '@/services/tokenRedaction'
import { deleteTask } from '@/services/taskDelete'
import { assertNotBuiltin } from '@/services/systemResources'
import { ForbiddenError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'
import {
  SyncWorkflowBodySchema,
  UpdateTaskMembersBodySchema,
  emptyWorkflowSyncDiff,
  type WorkflowSyncPreview,
} from '@agent-workflow/shared'
import {
  cancelTask,
  cleanupMaterializedSpace,
  computeWorkflowSyncPreview,
  getNodeRunEvents,
  getNodeRunStdout,
  getTask,
  getTaskDiff,
  getTaskNodeRuns,
  listTaskItems,
  listTasks,
  materializeSpace,
  prepareWorkflowTriggerLaunch,
  resumeTask,
  retryNode,
  syncTaskWorkflow,
} from '@/services/task'
// RFC-243 T2: task launches go through the unified executor facade — this
// route must not call startTask directly (source-text lock).
import { startExecution } from '@/services/execution/executor'
import { getTaskStructuralDiff } from '@/services/structuralDiff/service'
import { getTaskFileContent } from '@/services/worktreeFileContent'
import { getChangeNarrativeStatus, triggerChangeNarrative } from '@/services/changeNarrative'
import { getCallTargets } from '@/services/structuralDiff/callGraph/expandService'
import { getTaskFileSymbols } from '@/services/codeIntel/fileSymbols'
import { getCodeIntel } from '@/services/codeIntel/codeIntel'
import type { ResolvedDeepConfig } from '@/services/structuralDiff/deep/service'
import { structuralScopeSchema } from '@agent-workflow/shared'
import { applyUploadsToWorktree, validateUploadPlan } from '@/services/upload'
import {
  attachWorkspaceCleanupToMultipartError,
  bufferUploadParts,
  collectUploadInputDefs,
  parseMultipartLaunch,
  resolveUploadLimits,
} from '@/services/launchMultipart'
import { getSessionTree } from '@/services/sessionView'
import { getInventorySnapshot } from '@/services/runtime'
import { getStartupVerification } from '@/services/execution/startupVerificationRead'
import { listWorktreeDir, readWorktreeFile } from '@/services/worktreeFiles'
import { runLifecycleInvariants } from '@/services/lifecycleInvariants'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { buildStartTaskDeps, resolveSubagentLiveCapture } from '@/services/startTaskDeps'
import { assertWorkflowLaunchable } from '@/services/taskLaunchGate'
import { listRecoveryEventsForTask } from '@/services/recovery'
import { clearAutoRecoverySuspension, isAutoRecoverySuspended } from '@/services/recoveryBreaker'
import { applyRepairOption, listRepairOptionsForAlert } from '@/services/lifecycleRepair'
import { listOpenLifecycleAlertsForTask } from '@/services/taskAlerts'
import { getWorkflow } from '@/services/workflow'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import { tasksListBroadcaster, TASKS_LIST_CHANNEL } from '@/ws/broadcaster'
import { Paths } from '@/util/paths'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { listTaskOperationsPage } from '@/services/taskOperations'
import { safeJsonOrEmpty } from '@/util/http'

/** RFC-083: resolve deep-mode indexer path overrides + timeout from settings.
 *  Unreadable config → PATH lookup + default timeout. */
function resolveStructuralDeepConfig(configPath: string): ResolvedDeepConfig {
  try {
    const cfg = loadConfig(configPath)
    return {
      overrides: cfg.structuralDeepIndexers,
      timeoutMs: cfg.structuralDeepTimeoutMs ?? 120_000,
    }
  } catch {
    return { timeoutMs: 120_000 }
  }
}

function broadcastLifecycleAlertResolved(taskId: string): void {
  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
    type: 'lifecycle.alert.resolved',
    taskId,
  })
}

// RFC-159: `resolveSubagentLiveCapture` + the StartTaskDeps assembly
// (`buildStartTaskDeps`) live in @/services/startTaskDeps, shared with the
// scheduled-task scheduler so scheduled fires build deps identically to manual
// launches (live config, per-call). Imported below.

// RFC-103 T2 + RFC-108 T4: `resolveLaunchRuntimeConfig` (commit&push +
// maxConcurrentNodes + per-node timeout floor) lives in
// @/services/launchRuntimeConfig (imported above) so EVERY scheduler-kicking
// route — tasks (start/resume/retry/repair), fusions, parked clarify/review
// resume — threads the same runtime config from one source (Codex impl gate
// P2: the floor must reach all StartTaskDeps construction sites, not just the
// task routes). Call sites below are unchanged.

export function mountTaskRoutes(app: Hono, deps: AppDeps): void {
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
      const filters: Parameters<typeof listTasks>[1] = {}
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
        includeOwner ? await listTaskItems(deps.db, filters) : await listTasks(deps.db, filters),
      )
    },
  )

  // RFC-244 — static route must stay above the /api/tasks/:id visibility
  // middleware so the literal "page" is never interpreted as a task id.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/page',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List tasks (paged)',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await listTaskOperationsPage(deps.db, actor, {
          view: c.req.query('view'),
          q: c.req.query('q'),
          statuses: c.req.query('statuses'),
          subject: c.req.query('subject'),
          scope: c.req.query('scope'),
          origin: c.req.query('origin'),
          parent_id: c.req.query('parent_id'),
          cursor: c.req.query('cursor'),
          limit: c.req.query('limit'),
        }),
      )
    },
  )

  // RFC-036 visibility gate. All /api/tasks/:id/... reads require the actor
  // to be admin, owner, or a task_collaborators member. Mounted as middleware
  // so each downstream handler can assume the task is visible.
  app.use('/api/tasks/:id', async (c, next) => {
    // POST /api/tasks does not have :id; skip in that case.
    if (!c.req.param('id')) {
      await next()
      return
    }
    await visibilityCheck(c, deps)
    await next()
  })
  app.use('/api/tasks/:id/*', async (c, next) => {
    await visibilityCheck(c, deps)
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
      const task = await getTask(deps.db, id)
      if (task === null) {
        throw new NotFoundError('task-not-found', `task '${id}' not found`)
      }
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks',
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
        const task = await handleMultipartTaskStart(c.req.raw, deps, actorOf(c))
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
          throw new ValidationError(
            'start-task-path-retired',
            `RFC-165 retired path-mode launches; remove '${retired}' (use a file:// repoUrl for local repos)`,
          )
        }

        // RFC-248 H9（实现门 P1）：`sourceTaskId` 由调用方控制。重放前先确认
        // 他**看得见**那个任务——否则「能启动某工作流但看不见任务 X」的用户可以
        // 传 X 的 id，让服务端读出 X 冻结的仓库构成并按它物化，而且泄漏形式是
        // 「任务成功启动」，完全不像一次越权。不可见与不存在同形（都 404）。
        {
          const src = (bodyJson as { sourceTaskId?: unknown }).sourceTaskId
          if (typeof src === 'string' && src.length > 0) {
            await assertCanReplaySourceTask(deps.db, actorOf(c), src)
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
      // RFC-099 (D3) + RFC-104: the launcher must be able to use the WORKFLOW; the
      // referenced agent/skill/mcp/plugin closure is implicitly authorized. Invisible
      // and missing produce the identical 404; built-in → 403. Shared gate — the
      // multipart path and scheduled-task fires enforce the exact same policy.
      const startDeps = {
        ...buildStartTaskDeps(deps.db, deps.configPath, actor.user.id, deps.secretBox),
        // RFC-243 实现门 P0-1: closure freezing resolves call-node names inside
        // THIS actor's visibility.
        launchActor: actor,
      }
      await assertWorkflowLaunchable(deps.db, actor, parsed.data.workflowId)
      const task = await startExecution(
        deps.db,
        actor,
        {
          kind: 'workflow',
          refId: parsed.data.workflowId,
          invoker: { type: 'user' },
          payload: parsed.data,
        },
        startDeps,
      )
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))), 201)
    },
  )

  // RFC-099 (D10) — task members panel. Read open to anyone who can see the
  // task (the visibility middleware above already gated us); writes are
  // owner/admin only (enforced in updateTaskMembers).
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
      const rows = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
      const task = rows[0]
      if (!task) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return c.json(await getTaskMembers(deps.db, actorOf(c), task))
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
      const rows = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
      const task = rows[0]
      if (!task) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return c.json(await updateTaskMembers(deps.db, actorOf(c), task, parsed.data))
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
      const task = await cancelTask(deps.db, c.req.param('id'))
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))))
    },
  )

  // RFC-222 — admin-only hard delete of a terminal task. Route gate
  // tasks:delete is registered in server.ts; visibilityCheck (the /:id
  // middleware) has already confirmed the task exists + is admin-visible.
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
      const row = await deps.db
        .select({ name: tasksTable.name })
        .from(tasksTable)
        .where(eq(tasksTable.id, id))
        .limit(1)
      if (row[0] === undefined) throw new NotFoundError('task-not-found', `task '${id}' not found`)
      // RFC-222 (D5): type-to-confirm against the task's name (N-5 order — after
      // existence/authz, before the deleteTask business gates).
      assertDeleteConfirm(await readDeleteBody(c), row[0].name, 'task')
      captureDeleteSnapshot(c, actorOf(c), row[0])
      const result = await deleteTask(deps.db, id)
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
      return c.json(await getTaskNodeRuns(deps.db, c.req.param('id')))
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
      return c.json(await getTaskDiff(deps.db, c.req.param('id')))
    },
  )

  // RFC-083 — structural (semantic) diff overlay for the textual diff above.
  // `?scope=task|node` (+ `nodeRunId` for node scope); 'wrapper' → 422.
  // `?mode=deep` tries an external SCIP indexer for precise cross-file impact,
  // auto-falling back to the heuristic baseline when none is available.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/structural-diff',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Structural diff',
    },
    async (c) => {
      const scope = structuralScopeSchema.catch('task').parse(c.req.query('scope'))
      const nodeRunId = c.req.query('nodeRunId')
      const mode = c.req.query('mode') === 'deep' ? 'deep' : 'baseline'
      return c.json(
        await getTaskStructuralDiff(deps.db, c.req.param('id'), scope, nodeRunId, {
          mode,
          deepCfg: mode === 'deep' ? resolveStructuralDeepConfig(deps.configPath) : undefined,
        }),
      )
    },
  )

  // RFC-239 §3.2 — AI change narrative. GET follows the task-visibility
  // middleware (read = can see the task); POST additionally requires the
  // member gate (owner / collaborator / admin) inside the service. 404 body
  // means "not generated yet" — the frontend's button state.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/change-narrative',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Read the change narrative',
    },
    async (c) => {
      const scope = c.req.query('scope') ?? 'task'
      if (scope !== 'task') {
        throw new ValidationError('narrative-scope-invalid', `only scope=task is supported`)
      }
      const status = await getChangeNarrativeStatus(c.req.param('id'))
      if (status === null) {
        throw new NotFoundError('narrative-not-found', 'no narrative generated for this task yet')
      }
      return c.json(status)
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/change-narrative',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Generate the change narrative (model call)',
    },
    async (c) => {
      const body = (await safeJsonOrEmpty(c.req.raw)) as { scope?: string } | null
      const scope = body?.scope ?? 'task'
      if (scope !== 'task') {
        throw new ValidationError('narrative-scope-invalid', `only scope=task is supported`)
      }
      const id = c.req.param('id')
      const task = await getTask(deps.db, id)
      if (task === null) {
        throw new NotFoundError('task-not-found', `task '${id}' not found`)
      }
      const narrativeCfg = loadConfig(deps.configPath)
      const state = await triggerChangeNarrative(
        {
          db: deps.db,
          runtimeName: narrativeCfg.changeNarrativeRuntime ?? null,
          defaultRuntime: narrativeCfg.defaultRuntime ?? null,
        },
        task,
        actorOf(c),
      )
      return c.json(state, 202)
    },
  )

  // RFC-239 §3.5 — full-text file content (base|worktree side) for the
  // markdown rendered-diff view. Both sides answer a missing file with
  // 200 {exists:false}; a renamed file's base side is read via `basePath`
  // (the caller passes the structural diff's renamedFrom). Behind the same
  // /api/tasks/:id visibility middleware as every other task read.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/file-content',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Read a file from the diff',
    },
    async (c) => {
      const side = c.req.query('side')
      if (side !== 'base' && side !== 'worktree') {
        throw new ValidationError(
          'file-content-side-invalid',
          `side query param must be 'base' or 'worktree'`,
        )
      }
      const q: Parameters<typeof getTaskFileContent>[2] = {
        path: c.req.query('path') ?? '',
        side,
      }
      const basePath = c.req.query('basePath')
      if (basePath !== undefined && basePath !== '') q.basePath = basePath
      const repo = c.req.query('repo')
      if (repo !== undefined && repo !== '') q.repo = repo
      return c.json(await getTaskFileContent(deps.db, c.req.param('id'), q))
    },
  )

  // RFC-258 §2.1 — one file's symbol table (full-file anchor bar, baseline
  // engine lookup, graph→source resolution). Multi-repo selects by the wire
  // repo key ('.' = root, F-04); completeness is an honest 200 state (F-09).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/file-symbols',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'File symbol table',
    },
    async (c) => {
      const side = c.req.query('side') === 'base' ? 'base' : 'worktree'
      const q: Parameters<typeof getTaskFileSymbols>[2] = {
        path: c.req.query('path') ?? '',
        side,
      }
      const repo = c.req.query('repo')
      if (repo !== undefined && repo !== '') q.repo = repo
      return c.json(await getTaskFileSymbols(deps.db, c.req.param('id'), q))
    },
  )

  // RFC-258 §2.2 — identifier click resolution (definitions + references).
  // deep degrades per file to baseline with an honest reason (F-07); the base
  // side always resolves baseline (F-05).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/code-intel',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Resolve an identifier',
    },
    async (c) => {
      const q: Parameters<typeof getCodeIntel>[2] = {
        path: c.req.query('path') ?? '',
        side: c.req.query('side') === 'base' ? 'base' : 'worktree',
        line: Number(c.req.query('line') ?? 0),
        col: Number(c.req.query('col') ?? 0),
        name: c.req.query('name') ?? '',
        mode: c.req.query('mode') === 'deep' ? 'deep' : 'baseline',
      }
      const repo = c.req.query('repo')
      if (repo !== undefined && repo !== '') q.repo = repo
      return c.json(await getCodeIntel(deps.db, c.req.param('id'), q))
    },
  )

  // RFC-085 — lazy call-chain expansion: direct callees of one method (method+
  // constructor calls), source-ordered, best-effort resolved/external/unresolved.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/call-targets',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Call-node targets',
    },
    async (c) => {
      const methodRef = c.req.query('methodRef')
      if (methodRef === undefined || methodRef === '') {
        // RFC-203 T6: uniform error body (was a bare `{error: string}` the
        // shared decoder could not parse) + a call-target-specific code.
        throw new ValidationError(
          'call-target-method-required',
          'methodRef query param required for /call-targets',
        )
      }
      const targets = await getCallTargets(deps.db, c.req.param('id'), methodRef)
      return c.json({ targets })
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
      const alerts = await listOpenLifecycleAlertsForTask(deps.db, taskId)
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
      const taskId = c.req.param('id')
      const [events, suspended] = await Promise.all([
        listRecoveryEventsForTask(deps.db, taskId),
        isAutoRecoverySuspended(deps.db, taskId),
      ])
      return c.json({ events, suspended })
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
      await clearAutoRecoverySuspension(deps.db, c.req.param('id'))
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
      const taskId = c.req.param('id')
      const result = await runLifecycleInvariants({
        db: deps.db,
        scope: { taskId },
        onAlert: (row, transition) => {
          tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
            type: 'lifecycle.alert',
            taskId: row.taskId,
            rule: row.rule,
            severity: row.severity,
            transition,
          })
        },
        onResolved: broadcastLifecycleAlertResolved,
      })
      const invariantIds = new Set(result.openAlerts.map((a) => a.id))
      const allOpen = await listOpenLifecycleAlertsForTask(deps.db, taskId)
      const extra = allOpen
        .filter((a) => !invariantIds.has(a.id))
        .map((a) => ({
          id: a.id,
          taskId: a.taskId,
          rule: a.rule,
          severity: a.severity,
          detail: a.detail,
          detectedAt: a.detectedAt,
          resolvedAt: null,
        }))
      return c.json({ ...result, openAlerts: [...result.openAlerts, ...extra] })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/resume',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Resume a task',
    },
    async (c) => {
      await assertTaskWorkflowNotBuiltin(deps, c.req.param('id')) // RFC-104: no manual exec of built-ins
      const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
      const task = await resumeTask(deps.db, c.req.param('id'), {
        db: deps.db,
        configPath: deps.configPath,
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
        // RFC-103 T2: resume must thread commit&push + maxConcurrentNodes too.
        ...resolveLaunchRuntimeConfig(deps.configPath),
      })
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))))
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
      const task = await getTask(deps.db, id)
      if (task === null) throw new NotFoundError('task-not-found', `task '${id}' not found`)
      const notSyncable = (reason: WorkflowSyncPreview['reason']): WorkflowSyncPreview => ({
        syncable: false,
        reason,
        workflowId: task.workflowId,
        workflowName: task.workflowName,
        currentVersion: task.workflowVersion,
        latestVersion: null,
        differs: false,
        invalid: false,
        invalidIssues: [],
        diff: emptyWorkflowSyncDiff(),
      })
      const workflow = await getWorkflow(deps.db, task.workflowId)
      if (workflow === null) return c.json(notSyncable('workflow-deleted'))
      if (!(await canViewResource(deps.db, actorOf(c), 'workflow', workflow))) {
        return c.json(notSyncable('workflow-not-visible'))
      }
      return c.json(await computeWorkflowSyncPreview(deps.db, task, workflow, actorOf(c)))
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
      await assertTaskSyncable(deps, id) // RFC-104 builtin 403 / RFC-165 host 422
      const task = await getTask(deps.db, id)
      if (task === null) throw new NotFoundError('task-not-found', `task '${id}' not found`)
      const workflow = await getWorkflow(deps.db, task.workflowId)
      if (workflow === null) {
        throw new NotFoundError(
          'workflow-deleted',
          `workflow '${task.workflowId}' no longer exists`,
        )
      }
      if (!(await canViewResource(deps.db, actorOf(c), 'workflow', workflow))) {
        // 404-shaped (RFC-099 anti-probing) — same as an unknown workflow.
        throw new NotFoundError('workflow-not-visible', `workflow '${task.workflowId}' not found`)
      }
      const body = SyncWorkflowBodySchema.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) {
        throw new ValidationError('invalid-body', 'expectedVersion (number) required', {
          issues: body.error.issues,
        })
      }
      const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
      const updated = await syncTaskWorkflow(deps.db, id, {
        db: deps.db,
        expectedVersion: body.data.expectedVersion,
        launchActor: actorOf(c),
        configPath: deps.configPath,
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
        ...resolveLaunchRuntimeConfig(deps.configPath),
      })
      return c.json(serializeTaskFor(updated, workflowReadLensFor(actorOf(c))))
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
      const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
      const actor = actorOf(c)
      const result = await listRepairOptionsForAlert({
        db: deps.db,
        taskId: c.req.param('id'),
        alertId: c.req.param('alertId'),
        actorUserId: actor.user.id,
        appHome: Paths.root,
        deps: {
          db: deps.db,
          configPath: deps.configPath,
          ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
          // RFC-108 T4 (Codex design gate P2): a repair option may resumeAfterApply
          // → resumeTask(deps); thread the same runtime config (timeout floor +
          // commit&push + concurrency) so repair-kicked nodes are not unbounded.
          ...resolveLaunchRuntimeConfig(deps.configPath),
        },
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
      const bodyJson = (await c.req.json().catch(() => ({}))) as unknown
      const parsed = RepairRequestSchema.safeParse(bodyJson)
      if (!parsed.success) {
        throw new ValidationError(
          'confirm-required',
          'POST body must be `{ optionId: string, confirm: true }`',
          parsed.error.issues,
        )
      }
      const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
      const actor = actorOf(c)
      const result = await applyRepairOption({
        db: deps.db,
        taskId: c.req.param('id'),
        alertId: c.req.param('alertId'),
        optionId: parsed.data.optionId,
        actorUserId: actor.user.id,
        appHome: Paths.root,
        deps: {
          db: deps.db,
          configPath: deps.configPath,
          ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
          // RFC-108 T4 (Codex design gate P2): repair → resumeAfterApply →
          // resumeTask(deps) must carry the runtime config (timeout floor +
          // commit&push + concurrency), else auto/manual repairs kick unbounded nodes.
          ...resolveLaunchRuntimeConfig(deps.configPath),
        },
        onAlert: (row, transition) => {
          tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
            type: 'lifecycle.alert',
            taskId: row.taskId,
            rule: row.rule,
            severity: row.severity,
            transition,
          })
        },
        onResolved: broadcastLifecycleAlertResolved,
      })
      return c.json(result)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/nodes/:nodeRunId/retry',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Retry a node (rolls back to pre_snapshot, cascades downstream)',
    },
    async (c) => {
      await assertTaskWorkflowNotBuiltin(deps, c.req.param('id')) // RFC-104: no manual exec of built-ins
      // flag-audit W0：统一布尔解析（此前 `!== 'false'` 双重否定——任何拼错值静默当
      // true）。产品语义保留默认级联。
      const cascade = parseBoolQuery(c, 'cascade', { default: true })
      const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
      const task = await retryNode(deps.db, c.req.param('id'), c.req.param('nodeRunId'), {
        cascade,
        deps: {
          db: deps.db,
          configPath: deps.configPath,
          ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
          // RFC-103 T2: retry must thread commit&push + maxConcurrentNodes too.
          ...resolveLaunchRuntimeConfig(deps.configPath),
        },
      })
      return c.json(serializeTaskFor(task, workflowReadLensFor(actorOf(c))))
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
      const text = await getNodeRunStdout(deps.db, c.req.param('id'), c.req.param('nodeRunId'))
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
      const events = await getNodeRunEvents(
        deps.db,
        c.req.param('id'),
        c.req.param('nodeRunId'),
        opts,
      )
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
      return c.json(await getSessionTree(deps.db, c.req.param('id'), c.req.param('nodeRunId')))
    },
  )

  // RFC-029: Runtime inventory snapshot rendered at the top of the
  // NodeDetailDrawer's Session tab. The snapshot was written into
  // node_runs.inventory_snapshot_json by the runner after `child.exited`,
  // sourced from a file the framework-injected `aw-inventory-dump.mjs`
  // opencode plugin produced inside the per-run dir.
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
      return c.json(
        await getInventorySnapshot(deps.db, c.req.param('id'), c.req.param('nodeRunId')),
      )
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
        await getStartupVerification(deps.db, c.req.param('id'), c.req.param('nodeRunId')),
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
      const task = await getTask(deps.db, id)
      if (task === null) {
        throw new NotFoundError('task-not-found', `task '${id}' not found`)
      }
      if (task.worktreePath === '') {
        throw new NotFoundError('task-worktree-missing', `task '${id}' has no worktree`)
      }
      const rel = c.req.query('path') ?? ''
      const { entries, truncated } = await listWorktreeDir(task.worktreePath, rel)
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
      const task = await getTask(deps.db, id)
      if (task === null) {
        throw new NotFoundError('task-not-found', `task '${id}' not found`)
      }
      if (task.worktreePath === '') {
        throw new NotFoundError('task-worktree-missing', `task '${id}' has no worktree`)
      }
      const rel = c.req.query('path') ?? ''
      const result = await readWorktreeFile(task.worktreePath, rel)
      return c.json({ path: rel, ...result })
    },
  )
}

async function visibilityCheck(c: Context, deps: AppDeps): Promise<void> {
  const id = c.req.param('id')
  if (!id) return
  const rows = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1)
  const row = rows[0]
  if (!row) {
    // Let the per-route 404 handler fire; do not leak existence vs. forbidden.
    return
  }
  if (!(await canViewTask(deps.db, actorOf(c), row))) {
    throw new ForbiddenError('task-not-visible', `task '${id}' is not visible to this actor`)
  }
}

/**
 * RFC-104 + RFC-165 (F13-r3): lifecycle guard by EXECUTION KIND.
 * - 'agent' host tasks (RFC-165 single-agent launches): the synthesized
 *   snapshot is a REAL DAG run by the normal engine, so generic resume /
 *   node retry semantics hold → ALLOWED (this is the only carve-out from
 *   the builtin-workflow lock; the __agent_host__ FK anchor is builtin).
 * - TURN-ENGINE 'workgroup' host tasks (leader_worker / free_collab): generic
 *   resume/retry does not apply (the engine adopts only pending rows;
 *   recovery belongs to RFC-164's engine re-entry) → stays 403 via the
 *   builtin host row, explicitly LOCKED by tests.
 * - RFC-167 dynamic_workflow workgroup tasks (Codex impl-gate P1): every
 *   phase IS generically recoverable (generating re-enters the generate pass
 *   idempotently, awaiting_confirm re-parks, executing resumes the real DAG
 *   through runScope) — without this carve-out an executing dynamic task that
 *   failed or was interrupted had NO recovery endpoint at all → ALLOWED.
 * - plain workflow tasks whose workflow is builtin (fusion): 403 — only the
 *   fusion engine drives aw-skill-fusion; its own continuation + daemon
 *   recovery call the SERVICE directly, bypassing these user routes.
 * A null task returns so the route's own 404 still fires.
 */
async function assertTaskWorkflowNotBuiltin(deps: AppDeps, taskId: string): Promise<void> {
  const task = await getTask(deps.db, taskId)
  if (task === null) return
  if (taskExecutionKind(task) === 'agent') return
  if (isWorkgroupTask(task)) {
    const row = (
      await deps.db
        .select({ workgroupConfigJson: tasksTable.workgroupConfigJson })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .limit(1)
    )[0]
    if (
      !isTurnEngineWorkgroupTask({
        workgroupId: task.workgroupId,
        workgroupConfigJson: row?.workgroupConfigJson ?? null,
      })
    ) {
      return // dynamic_workflow — generically recoverable (see doc above)
    }
  }
  const wf = await getWorkflow(deps.db, task.workflowId)
  if (wf !== null) assertNotBuiltin('workflow', wf)
}

/**
 * RFC-165 (F13-r3): host tasks (agent / workgroup) freeze a SYNTHESIZED
 * snapshot — there is no authored workflow to sync from, so sync-workflow is
 * uniformly 422 for them (vs. the 403 builtin lock, which is about manual
 * execution). Plain builtin-workflow tasks (fusion) keep the 403.
 */
async function assertTaskSyncable(deps: AppDeps, taskId: string): Promise<void> {
  const task = await getTask(deps.db, taskId)
  if (task === null) return
  if (taskExecutionKind(task) !== 'workflow') {
    throw new ValidationError(
      'task-host-sync-unsupported',
      'agent/workgroup host tasks run a synthesized snapshot — there is no workflow to sync from',
    )
  }
  const wf = await getWorkflow(deps.db, task.workflowId)
  if (wf !== null) assertNotBuiltin('workflow', wf)
}

// RFC-218: the multipart parsing / defs / limits / cleanup-decoration skeleton
// moved to services/launchMultipart.ts so the agent launch route shares it.
// Re-exported for existing importers (rfc107 test suite).
export { attachWorkspaceCleanupToMultipartError } from '@/services/launchMultipart'

async function handleMultipartTaskStart(
  req: Request,
  deps: AppDeps,
  actor: ReturnType<typeof actorOf>,
) {
  // 1. Parse the form: JSON `payload` field + `files[<key>][]` parts (bytes
  // are NOT buffered yet — that waits for the defs membership check below).
  const { payloadJson, parts: uploadParts } = await parseMultipartLaunch(req)
  // RFC-099 (D6): reject payloads still carrying the removed assignments field.
  if (
    typeof payloadJson === 'object' &&
    payloadJson !== null &&
    Object.prototype.hasOwnProperty.call(payloadJson, 'assignments')
  ) {
    throw new ValidationError(
      'assignments-removed',
      'RFC-099 removed per-node assignments; task members answer reviews/clarifications now',
    )
  }
  // RFC-165 (F1): same raw-key gate as the JSON route (multipart payloads
  // are just as spoofable).
  {
    const retired = rejectRetiredStartTaskKeys(payloadJson)
    if (retired !== null) {
      throw new ValidationError(
        'start-task-path-retired',
        `RFC-165 retired path-mode launches; remove '${retired}' (use a file:// repoUrl for local repos)`,
      )
    }

    // RFC-248 H9（实现门 P1）：`sourceTaskId` 由调用方控制。重放前先确认
    // 他**看得见**那个任务——否则「能启动某工作流但看不见任务 X」的用户可以
    // 传 X 的 id，让服务端读出 X 冻结的仓库构成并按它物化，而且泄漏形式是
    // 「任务成功启动」，完全不像一次越权。不可见与不存在同形（都 404）。
    {
      const src = (payloadJson as { sourceTaskId?: unknown }).sourceTaskId
      if (typeof src === 'string' && src.length > 0) {
        await assertCanReplaySourceTask(deps.db, actor, src)
      }
    }
  }
  const parsed = StartTaskSchema.safeParse(payloadJson)
  if (!parsed.success) {
    throw new ValidationError('task-invalid', 'invalid task payload', {
      issues: parsed.error.issues,
    })
  }
  const startInput = parsed.data

  // 2. Resolve workflow → extract upload input declarations. RFC-099 (D3):
  // the launcher must be able to use the workflow; invisible == missing.
  const launchRuntime = resolveLaunchRuntimeConfig(deps.configPath)
  const workflow = await assertWorkflowLaunchable(deps.db, actor, startInput.workflowId)
  // RFC-199 G1: reject a stale launch guard against the SAME visible row we
  // just captured, before URL resolution can mint a cache row/worktree/branch.
  // startTask intentionally retains its own pre-materialize and final-tx
  // fences for races that occur after this route-level fast refusal.
  if (
    startInput.expectedWorkflowVersion !== undefined &&
    workflow.version !== startInput.expectedWorkflowVersion
  ) {
    throw new ConflictError(
      'workflow-version-mismatch',
      `workflow '${startInput.workflowId}' changed during launch (expected v${startInput.expectedWorkflowVersion}, now v${workflow.version})`,
      {
        expectedVersion: startInput.expectedWorkflowVersion,
        currentVersion: workflow.version,
      },
    )
  }
  const uploadDefs = collectUploadInputDefs(workflow.definition.inputs)

  // 3. Every bound part must target a declared upload input; only then are
  // bytes copied out of the form (impl-gate P2-4).
  const uploadFiles = await bufferUploadParts(uploadParts, uploadDefs)

  const routeLaunchDeps = {
    db: deps.db,
    actorUserId: actor.user.id,
    ...(deps.secretBox !== undefined ? { secretBox: deps.secretBox } : {}),
    configPath: deps.configPath,
    ...launchRuntime,
    launchActor: actor,
  }
  // RFC-292: freeze and scan root + call closure before repo resolution,
  // cloning, worktree creation or upload writes. startTask repeats this check
  // after the handoff to close the route/service race.
  const frozenClosureJson = await prepareWorkflowTriggerLaunch({
    deps: routeLaunchDeps,
    workflowId: workflow.id,
    definition: workflow.definition,
  })

  // 4. Materialize the space first so we have a real path to write into.
  const appHome = Paths.root
  // RFC-248 D12: RFC-066 的「多仓 + 上传」禁令已解除——上传物落到任务根下的
  // 固定目录 `.agent-workflow-inputs/`，不属于任何成员仓（见 applyUploadsToWorktree
  // 的 inputsSubdir）。原本这里与 services/task.ts 各有一道 422 门，两处一并删除。
  // RFC-107 (Codex design-gate F1): run the SAME static workflow validation
  // startTask runs (services/task.ts) BEFORE resolving/cloning the repo. JSON
  // launches validate before any repo resolution; the multipart path
  // materializes the worktree before startTask, so without this an
  // invalid-but-visible workflow with an upload input would clone + populate
  // the gitRepoCache (network + a cache row) and only THEN fail validation —
  // diverging from JSON URL mode. Refuse up front so a bad workflow never
  // triggers a clone. startTask validates again; validateWorkflowDef is a pure,
  // side-effect-free function so the double check is cheap.
  {
    const validation = validateWorkflowDef(
      workflow.definition,
      await buildWorkflowValidationContext(deps.db, {
        definition: workflow.definition,
        currentWorkflow: { id: workflow.id, name: workflow.name },
        frozenClosureJson,
      }),
    )
    if (!validation.ok) {
      const errors = validation.issues.filter((i) => (i.severity ?? 'error') === 'error')
      throw new ValidationError(
        'workflow-invalid',
        `workflow '${startInput.workflowId}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'}); fix issues before starting a task`,
        { issues: validation.issues },
      )
    }
  }
  // Upload paths do not exist in the payload yet; validate every other
  // authored input before materializing the workspace. validateUploadPlan
  // owns upload counts now, and startTask repeats the full map check after
  // applyUploadsToWorktree packs the server-written paths.
  assertWorkflowLaunchInputs(workflow.definition.inputs, startInput.inputs, {
    ignoreUploadInputs: true,
  })
  // RFC-107 (Codex impl-gate): validate the uploads (count / total + per-file
  // size / accept / min-max) BEFORE resolving or cloning the repo. Otherwise a
  // valid repoUrl + a bad upload would clone the repo and leave an orphan
  // worktree before applyUploadsToWorktree rejected it. The write phase re-runs
  // these checks; limits are resolved once and reused at step 5.
  const limits = resolveUploadLimits(deps.configPath)
  validateUploadPlan({ defs: uploadDefs, files: uploadFiles, limits })
  // RFC-165 (F3): resolve + materialize via the single tagged entry —
  // `materializeSpace` handles URL mode (clone into gitRepoCache), path mode
  // and scratch alike, resolving each source EXACTLY ONCE (RFC-107 D1-B is
  // internal to it) and carrying materialize failure in its `earlyError` arm
  // instead of throwing — so the failure handoff below mints ONE failed row
  // without re-resolving or re-materializing. Working branch + git identity
  // thread through exactly like the JSON path (RFC-107 F2/D5). A URL
  // clone/resolve failure still throws the same structured 4xx a JSON launch
  // would (no task row). scratch + uploads is a legal combination: the files
  // land in the fresh scratch repo.
  // RFC-248（实现门 P1）：预物化也要带上 `secretBox`。组成员一律按 `cachedRepoId`
  // 解析，私有仓的 URL 是**封存**的，没有 box 就解不开 ⇒
  // `cached-repo-credential-unavailable`。少了它，「私有仓组 + 上传」这条被 D12
  // 明确解禁的组合会必失败，而完全等价的 JSON 启动却能成功。
  const space = await materializeSpace(
    startInput,
    { db: deps.db, ...(deps.secretBox !== undefined ? { secretBox: deps.secretBox } : {}) },
    appHome,
  )
  const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
  if (space.earlyError !== null) {
    // Create a failed task row so the user sees the error. No files were
    // written (the workspace never fully existed; scratch already cleaned).
    const task = await startExecution(
      deps.db,
      actor,
      {
        kind: 'workflow',
        refId: startInput.workflowId,
        invoker: { type: 'user' },
        payload: startInput,
      },
      {
        db: deps.db,
        actorUserId: actor.user.id,
        ...(deps.secretBox !== undefined ? { secretBox: deps.secretBox } : {}),
        configPath: deps.configPath,
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
        // RFC-103 T2: multipart (upload) start must thread runtime config too.
        ...launchRuntime,
        materializedSpace: space,
        launchActor: actor,
      },
    )
    return task
  }

  // 5. Write uploads + pack paths back into inputs[] (limits resolved at step 4).
  let inputsOut: Record<string, string>
  try {
    const result = await applyUploadsToWorktree({
      worktreePath: space.worktreePath,
      // RFC-248 D12: 多仓任务的上传物落到任务根下的固定目录，不属于任何成员仓。
      // 单仓不传 ⇒ 路径与今天字节级一致。
      // RFC-248 D12（实现门 P1）：按**空间类型**判定，不看仓数。组空间即便只展平出
      // 一个成员（sparse / 非根挂载），上传物也必须落在任务根下的保留目录——
      // 用 `repos.length > 1` 会让那种组把上传物写进成员仓的工作树。
      // 单仓 / scratch 不传 ⇒ 路径与今天字节级一致。
      ...(space.kind === 'group' ? { inputsSubdir: UPLOAD_INPUTS_DIR } : {}),
      defs: uploadDefs,
      files: uploadFiles,
      limits,
    })
    inputsOut = { ...startInput.inputs }
    for (const [key, paths] of result.packedByKey.entries()) {
      inputsOut[key] = paths.join('\n')
    }
  } catch (err) {
    // No task row owns this materialization. Consume the same explicit cleanup
    // lease startTask uses (normal linked worktree, scratch, or future shapes),
    // rather than guessing ownership from `space.kind`.
    const cleanup = await cleanupMaterializedSpace(space)
    throw attachWorkspaceCleanupToMultipartError(err, cleanup)
  }

  // 6. Hand off ownership to the launch (via the RFC-243 executor facade —
  // same startTask underneath). Its outer wrapper now covers every pre-commit
  // error (including the initial exact-version guard), so this call
  // intentionally sits outside the upload-write catch above.
  return await startExecution(
    deps.db,
    actor,
    {
      kind: 'workflow',
      refId: startInput.workflowId,
      invoker: { type: 'user' },
      payload: { ...startInput, inputs: inputsOut },
    },
    {
      db: deps.db,
      actorUserId: actor.user.id,
      ...(deps.secretBox !== undefined ? { secretBox: deps.secretBox } : {}),
      configPath: deps.configPath,
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
      // RFC-103 T2: multipart (upload) start must thread runtime config too.
      ...launchRuntime,
      materializedSpace: space,
      launchActor: actor,
    },
  )
}
