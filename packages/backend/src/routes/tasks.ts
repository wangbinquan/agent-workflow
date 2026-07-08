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
  StartTaskSchema,
  TaskStatusSchema,
  UploadInputSchema,
  type WorkflowInput,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { actorOf } from '@/auth/actor'
import { loadConfig } from '@/config'
// RFC-143 PR-5: resolveOpencodeCmd deduped to util/opencode (was 5 route-local copies).
import { resolveOpencodeCmd } from '@/util/opencode'
import { tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import { canViewTask, getTaskMembers, updateTaskMembers } from '@/services/taskCollab'
import { canViewResource } from '@/services/resourceAcl'
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
  computeWorkflowSyncPreview,
  getNodeRunEvents,
  getNodeRunStdout,
  getTask,
  getTaskDiff,
  getTaskNodeRuns,
  listTasks,
  materializeWorktree,
  normalizeStartTaskRepos,
  resolveRepoSourceSingle,
  type ResolvedRepoSource,
  resumeTask,
  retryNode,
  startTask,
  syncTaskWorkflow,
} from '@/services/task'
import { getTaskStructuralDiff } from '@/services/structuralDiff/service'
import { getCallTargets } from '@/services/structuralDiff/callGraph/expandService'
import type { ResolvedDeepConfig } from '@/services/structuralDiff/deep/service'
import { structuralScopeSchema } from '@agent-workflow/shared'
import {
  applyUploadsToWorktree,
  DEFAULT_UPLOAD_LIMITS,
  type UploadFile,
  type UploadInputDef,
  type UploadLimits,
  validateUploadPlan,
} from '@/services/upload'
import { getSessionTree } from '@/services/sessionView'
import { getInventorySnapshot } from '@/services/inventory'
import { listWorktreeDir, readWorktreeFile } from '@/services/worktreeFiles'
import { runLifecycleInvariants } from '@/services/lifecycleInvariants'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { listRecoveryEventsForTask } from '@/services/recovery'
import { clearAutoRecoverySuspension, isAutoRecoverySuspended } from '@/services/recoveryBreaker'
import { applyRepairOption, listRepairOptionsForAlert } from '@/services/lifecycleRepair'
import { listOpenLifecycleAlertsForTask } from '@/services/taskAlerts'
import { getWorkflow } from '@/services/workflow'
import { validateWorkflowDef } from '@/services/workflow.validator'
import { listAgents } from '@/services/agent'
import { listSkills } from '@/services/skill'
import { tasksListBroadcaster, TASKS_LIST_CHANNEL } from '@/ws/broadcaster'
import { Paths } from '@/util/paths'
import { NotFoundError, ValidationError } from '@/util/errors'

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

/**
 * RFC-048: forward the configured subagent live-capture cadence to the
 * scheduler/runner. Reading the config here (instead of inside the runner)
 * keeps the runner pure and lets the operator flip `pollMs = 0` to disable
 * live polling without restarting the daemon — the next task pulls the
 * updated value.
 */
function resolveSubagentLiveCapture(
  configPath: string,
): { pollMs: number; consecutiveFailureLimit: number } | undefined {
  try {
    const cfg = loadConfig(configPath)
    return cfg.subagentLiveCapture
  } catch {
    return undefined
  }
}

// RFC-103 T2 + RFC-108 T4: `resolveLaunchRuntimeConfig` (commit&push +
// maxConcurrentNodes + per-node timeout floor) lives in
// @/services/launchRuntimeConfig (imported above) so EVERY scheduler-kicking
// route — tasks (start/resume/retry/repair), fusions, parked clarify/review
// resume — threads the same runtime config from one source (Codex impl gate
// P2: the floor must reach all StartTaskDeps construction sites, not just the
// task routes). Call sites below are unchanged.

export function mountTaskRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks', async (c) => {
    const actor = actorOf(c)
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
    return c.json(await listTasks(deps.db, filters))
  })

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

  app.get('/api/tasks/:id', async (c) => {
    const id = c.req.param('id')
    const task = await getTask(deps.db, id)
    if (task === null) {
      throw new NotFoundError('task-not-found', `task '${id}' not found`)
    }
    return c.json(task)
  })

  app.post('/api/tasks', async (c) => {
    const ct = c.req.header('content-type') ?? ''
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)

    // RFC-020: multipart branch handles launcher uploads. payload field is
    // JSON-encoded StartTask; files[<inputKey>][] fields are the binary
    // contents bound to `kind: 'upload'` inputs.
    if (ct.toLowerCase().startsWith('multipart/form-data')) {
      const task = await handleMultipartTaskStart(c.req.raw, deps, opencodeCmd, actorOf(c))
      return c.json(task, 201)
    }

    const bodyJson = await safeJson(c.req.raw)
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
    const parsed = StartTaskSchema.safeParse(bodyJson)
    if (!parsed.success) {
      throw new ValidationError('task-invalid', 'invalid task payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    // RFC-099 (D3): launching requires the WORKFLOW to be usable by the
    // launcher; the referenced agent/skill/mcp/plugin closure is implicitly
    // authorized. Invisible and missing produce the identical 404.
    {
      const wf = await getWorkflow(deps.db, parsed.data.workflowId)
      if (wf === null || !(await canViewResource(deps.db, actor, 'workflow', wf))) {
        throw new NotFoundError(
          'workflow-not-found',
          `workflow '${parsed.data.workflowId}' not found`,
        )
      }
      // RFC-104: built-in workflows cannot be launched manually — only the
      // fusion engine drives aw-skill-fusion, via the service layer (which is
      // intentionally not guarded). 403 here, not 404 (the row IS visible).
      assertNotBuiltin('workflow', wf)
    }
    const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
    const task = await startTask(parsed.data, {
      db: deps.db,
      actorUserId: actor.user.id,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
      // RFC-103 T2: commit&push + maxConcurrentNodes from settings (all entries).
      ...resolveLaunchRuntimeConfig(deps.configPath),
    })
    return c.json(task, 201)
  })

  // RFC-099 (D10) — task members panel. Read open to anyone who can see the
  // task (the visibility middleware above already gated us); writes are
  // owner/admin only (enforced in updateTaskMembers).
  app.get('/api/tasks/:id/members', async (c) => {
    const taskId = c.req.param('id')
    const rows = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
    const task = rows[0]
    if (!task) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
    return c.json(await getTaskMembers(deps.db, actorOf(c), task))
  })

  app.put('/api/tasks/:id/members', async (c) => {
    const taskId = c.req.param('id')
    const parsed = UpdateTaskMembersBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('members-invalid', 'invalid members payload', {
        issues: parsed.error.issues,
      })
    }
    const rows = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
    const task = rows[0]
    if (!task) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
    return c.json(await updateTaskMembers(deps.db, actorOf(c), task, parsed.data))
  })

  app.post('/api/tasks/:id/cancel', async (c) => {
    const task = await cancelTask(deps.db, c.req.param('id'))
    return c.json(task)
  })

  app.get('/api/tasks/:id/node-runs', async (c) => {
    return c.json(await getTaskNodeRuns(deps.db, c.req.param('id')))
  })

  app.get('/api/tasks/:id/diff', async (c) => {
    return c.json(await getTaskDiff(deps.db, c.req.param('id')))
  })

  // RFC-083 — structural (semantic) diff overlay for the textual diff above.
  // `?scope=task|node` (+ `nodeRunId` for node scope); 'wrapper' → 422.
  // `?mode=deep` tries an external SCIP indexer for precise cross-file impact,
  // auto-falling back to the heuristic baseline when none is available.
  app.get('/api/tasks/:id/structural-diff', async (c) => {
    const scope = structuralScopeSchema.catch('task').parse(c.req.query('scope'))
    const nodeRunId = c.req.query('nodeRunId')
    const mode = c.req.query('mode') === 'deep' ? 'deep' : 'baseline'
    return c.json(
      await getTaskStructuralDiff(deps.db, c.req.param('id'), scope, nodeRunId, {
        mode,
        deepCfg: mode === 'deep' ? resolveStructuralDeepConfig(deps.configPath) : undefined,
      }),
    )
  })

  // RFC-085 — lazy call-chain expansion: direct callees of one method (method+
  // constructor calls), source-ordered, best-effort resolved/external/unresolved.
  app.get('/api/tasks/:id/call-targets', async (c) => {
    const methodRef = c.req.query('methodRef')
    if (methodRef === undefined || methodRef === '') {
      return c.json({ error: 'methodRef query param required' }, 422)
    }
    const targets = await getCallTargets(deps.db, c.req.param('id'), methodRef)
    return c.json({ targets })
  })

  // RFC-053 P-6: list currently-open lifecycle_alerts (invariant + stuck)
  // for this task. Powers the StuckTaskBanner — banners only render when
  // the response has at least one row. Empty list = healthy task = no
  // banner at all.
  app.get('/api/tasks/:id/alerts', async (c) => {
    const taskId = c.req.param('id')
    const alerts = await listOpenLifecycleAlertsForTask(deps.db, taskId)
    return c.json({ alerts })
  })

  // RFC-108 T3 (AR-11): per-task system-recovery audit trail (boot-reap /
  // shutdown-flip / limit-cancel / snapshot-lost / live-child-survived / …).
  // Behind the same /api/tasks/:id visibility middleware mounted above.
  app.get('/api/tasks/:id/recovery-events', async (c) => {
    const taskId = c.req.param('id')
    const [events, suspended] = await Promise.all([
      listRecoveryEventsForTask(deps.db, taskId),
      isAutoRecoverySuspended(deps.db, taskId),
    ])
    return c.json({ events, suspended })
  })

  // RFC-108 T11 (AR-09): human one-click clear of an auto-recovery quarantine
  // (a task that crash-looped past the breaker threshold). Behind the same
  // /api/tasks/:id visibility middleware (owner / collaborator / admin).
  app.post('/api/tasks/:id/clear-recovery-suspension', async (c) => {
    await clearAutoRecoverySuspension(deps.db, c.req.param('id'))
    return c.json({ ok: true })
  })

  // RFC-053 P-3: on-demand invariant scan for the diagnose panel. Reads
  // live (not the cached lifecycle_alerts table) so a stuck-task report
  // reflects the current DB state without waiting for the next hourly tick.
  // RFC-057: after the live invariant scan, also merge in any open
  // stuck-rule rows (S1..S4) from the table. The stuck-task detector has
  // a 30-min freshness gate and runs on its own 5-min cadence, so the
  // live scan alone misses those — leaving the banner saying "open
  // alerts" while the panel says "no findings".
  app.post('/api/tasks/:id/diagnose', async (c) => {
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
  })

  app.post('/api/tasks/:id/resume', async (c) => {
    await assertTaskWorkflowNotBuiltin(deps, c.req.param('id')) // RFC-104: no manual exec of built-ins
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
    const task = await resumeTask(deps.db, c.req.param('id'), {
      db: deps.db,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
      // RFC-103 T2: resume must thread commit&push + maxConcurrentNodes too.
      ...resolveLaunchRuntimeConfig(deps.configPath),
    })
    return c.json(task)
  })

  // RFC-109 — preview the delta between the task's frozen workflow snapshot and
  // the latest definition of its workflow (drives the "workflow updated" banner
  // + confirm dialog). Read-only; visibilityCheck already gates task membership,
  // and the workflow must be visible (RFC-099, 404-shaped to avoid probing).
  app.get('/api/tasks/:id/workflow-sync-preview', async (c) => {
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
    return c.json(await computeWorkflowSyncPreview(deps.db, task, workflow))
  })

  // RFC-109 — apply the sync: swap the task's snapshot to the latest definition
  // (recording its version) and continue from the breakpoint. Built-in guard
  // (RFC-104) + workflow visibility (RFC-099) mirror launch; the service owns
  // the version-TOCTOU / invalid / noop / wrapper-blocker / status gates.
  app.post('/api/tasks/:id/sync-workflow', async (c) => {
    const id = c.req.param('id')
    await assertTaskWorkflowNotBuiltin(deps, id) // RFC-104: no manual exec of built-ins
    const task = await getTask(deps.db, id)
    if (task === null) throw new NotFoundError('task-not-found', `task '${id}' not found`)
    const workflow = await getWorkflow(deps.db, task.workflowId)
    if (workflow === null) {
      throw new NotFoundError('workflow-deleted', `workflow '${task.workflowId}' no longer exists`)
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
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
    const updated = await syncTaskWorkflow(deps.db, id, {
      db: deps.db,
      expectedVersion: body.data.expectedVersion,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
      ...resolveLaunchRuntimeConfig(deps.configPath),
    })
    return c.json(updated)
  })

  // RFC-057: Diagnose-Panel repair options.
  app.get('/api/tasks/:id/alerts/:alertId/repair-options', async (c) => {
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
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
        ...(opencodeCmd ? { opencodeCmd } : {}),
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
        // RFC-108 T4 (Codex design gate P2): a repair option may resumeAfterApply
        // → resumeTask(deps); thread the same runtime config (timeout floor +
        // commit&push + concurrency) so repair-kicked nodes are not unbounded.
        ...resolveLaunchRuntimeConfig(deps.configPath),
      },
    })
    return c.json(result)
  })

  app.post('/api/tasks/:id/alerts/:alertId/repair', async (c) => {
    const bodyJson = (await c.req.json().catch(() => ({}))) as unknown
    const parsed = RepairRequestSchema.safeParse(bodyJson)
    if (!parsed.success) {
      throw new ValidationError(
        'confirm-required',
        'POST body must be `{ optionId: string, confirm: true }`',
        parsed.error.issues,
      )
    }
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
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
        ...(opencodeCmd ? { opencodeCmd } : {}),
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
    })
    return c.json(result)
  })

  app.post('/api/tasks/:id/nodes/:nodeRunId/retry', async (c) => {
    await assertTaskWorkflowNotBuiltin(deps, c.req.param('id')) // RFC-104: no manual exec of built-ins
    // flag-audit W0：统一布尔解析（此前 `!== 'false'` 双重否定——任何拼错值静默当
    // true）。产品语义保留默认级联。
    const cascade = parseBoolQuery(c, 'cascade', { default: true })
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
    const task = await retryNode(deps.db, c.req.param('id'), c.req.param('nodeRunId'), {
      cascade,
      deps: {
        db: deps.db,
        ...(opencodeCmd ? { opencodeCmd } : {}),
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
        // RFC-103 T2: retry must thread commit&push + maxConcurrentNodes too.
        ...resolveLaunchRuntimeConfig(deps.configPath),
      },
    })
    return c.json(task)
  })

  app.get('/api/tasks/:id/nodes/:nodeRunId/stdout', async (c) => {
    const text = await getNodeRunStdout(deps.db, c.req.param('id'), c.req.param('nodeRunId'))
    return c.text(text)
  })

  app.get('/api/tasks/:id/node-runs/:nodeRunId/events', async (c) => {
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
    return c.json(
      await getNodeRunEvents(deps.db, c.req.param('id'), c.req.param('nodeRunId'), opts),
    )
  })

  // RFC-027: Session-tree view consumed by the NodeDetailDrawer's
  // Session tab. Reads the persisted events for one node_run and
  // reassembles a normalized conversation tree (user / assistant text
  // / tool_use / subagent-call, with recursive children for any task
  // tool whose child sessionID was captured into node_run_events by
  // sessionCapture).
  app.get('/api/tasks/:id/node-runs/:nodeRunId/session', async (c) => {
    return c.json(await getSessionTree(deps.db, c.req.param('id'), c.req.param('nodeRunId')))
  })

  // RFC-029: Runtime inventory snapshot rendered at the top of the
  // NodeDetailDrawer's Session tab. The snapshot was written into
  // node_runs.inventory_snapshot_json by the runner after `child.exited`,
  // sourced from a file the framework-injected `aw-inventory-dump.mjs`
  // opencode plugin produced inside the per-run dir.
  app.get('/api/tasks/:id/node-runs/:nodeRunId/inventory', async (c) => {
    return c.json(await getInventorySnapshot(deps.db, c.req.param('id'), c.req.param('nodeRunId')))
  })

  // RFC-065 — task detail page "工作目录" tab.
  //
  // List one directory's direct children (lazy load). `path` query param is
  // relative to the task's worktreePath; empty string = root.
  app.get('/api/tasks/:id/worktree-tree', async (c) => {
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
  })

  // RFC-065 — read one worktree file's text content. Server enforces the
  // 2 MiB cap; oversized returns `{oversized:true, content:''}` with the
  // real size so the UI can render an "too large" hint.
  app.get('/api/tasks/:id/worktree-file', async (c) => {
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
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
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
 * RFC-104: refuse manual resume/retry of a task whose workflow is a built-in.
 * Built-in workflows cannot be manually executed; only the fusion engine drives
 * aw-skill-fusion, and its own continuation (clarify / review → resumeTask) plus
 * daemon recovery (lifecycleRepair) call the SERVICE directly, bypassing these
 * user-facing routes. A null task returns so the route's own 404 still fires.
 */
async function assertTaskWorkflowNotBuiltin(deps: AppDeps, taskId: string): Promise<void> {
  const task = await getTask(deps.db, taskId)
  if (task === null) return
  const wf = await getWorkflow(deps.db, task.workflowId)
  if (wf !== null) assertNotBuiltin('workflow', wf)
}

/**
 * RFC-020: read `uploadLimits` from settings, falling back to defaults. Kept
 * narrow so the multipart handler stays declarative.
 */
function resolveUploadLimits(configPath: string): UploadLimits {
  try {
    const cfg = loadConfig(configPath)
    const u = cfg.uploadLimits
    if (u !== undefined) {
      return {
        perFile: u.perFile,
        perRequest: u.perRequest,
        perCount: u.perCount,
      }
    }
  } catch {
    // unreadable config → defaults
  }
  return { ...DEFAULT_UPLOAD_LIMITS }
}

/**
 * Extract upload-kind input declarations from a workflow definition. Each
 * one must pass UploadInputSchema (strict-on-write) — anything that snuck
 * through the workflow save path with a bad targetDir is rejected here too.
 */
function collectUploadInputDefs(inputs: readonly WorkflowInput[]): Map<string, UploadInputDef> {
  const out = new Map<string, UploadInputDef>()
  for (const inp of inputs) {
    if (inp.kind !== 'upload') continue
    const parsed = UploadInputSchema.safeParse(inp)
    if (!parsed.success) {
      throw new ValidationError(
        'upload-input-invalid',
        `workflow input '${inp.key}' (kind=upload) is malformed`,
        { issues: parsed.error.issues },
      )
    }
    const def: UploadInputDef = {
      key: parsed.data.key,
      targetDir: parsed.data.targetDir,
    }
    if (parsed.data.accept !== undefined) def.accept = parsed.data.accept
    if (parsed.data.maxFileSize !== undefined) def.maxFileSize = parsed.data.maxFileSize
    if (parsed.data.minCount !== undefined) def.minCount = parsed.data.minCount
    if (parsed.data.maxCount !== undefined) def.maxCount = parsed.data.maxCount
    out.set(def.key, def)
  }
  return out
}

/** Match `files[<key>][]` field names; allowed keys mirror WorkflowInput.key. */
const UPLOAD_FIELD_RE = /^files\[([A-Za-z0-9_-]+)\]\[\]$/

async function handleMultipartTaskStart(
  req: Request,
  deps: AppDeps,
  opencodeCmd: string[] | undefined,
  actor: ReturnType<typeof actorOf>,
) {
  let form: Awaited<ReturnType<typeof req.formData>>
  try {
    form = await req.formData()
  } catch (err) {
    throw new ValidationError(
      'task-multipart-invalid',
      `failed to parse multipart body: ${(err as Error).message}`,
    )
  }

  // 1. Pull JSON payload out of the `payload` field.
  const payloadField = form.get('payload')
  if (payloadField === null) {
    throw new ValidationError(
      'task-multipart-payload-missing',
      'multipart body must include a "payload" field with the StartTask JSON',
    )
  }
  let payloadText: string
  if (typeof payloadField === 'string') {
    payloadText = payloadField
  } else {
    payloadText = await payloadField.text()
  }
  let payloadJson: unknown
  try {
    payloadJson = JSON.parse(payloadText)
  } catch (err) {
    throw new ValidationError(
      'task-multipart-payload-invalid',
      `payload field is not valid JSON: ${(err as Error).message}`,
    )
  }
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
  const parsed = StartTaskSchema.safeParse(payloadJson)
  if (!parsed.success) {
    throw new ValidationError('task-invalid', 'invalid task payload', {
      issues: parsed.error.issues,
    })
  }
  const startInput = parsed.data

  // 2. Resolve workflow → extract upload input declarations. RFC-099 (D3):
  // the launcher must be able to use the workflow; invisible == missing.
  const workflow = await getWorkflow(deps.db, startInput.workflowId)
  if (workflow === null || !(await canViewResource(deps.db, actor, 'workflow', workflow))) {
    throw new NotFoundError('workflow-not-found', `workflow '${startInput.workflowId}' not found`)
  }
  // RFC-104: built-in workflows cannot be launched manually (multipart path).
  assertNotBuiltin('workflow', workflow)
  const uploadDefs = collectUploadInputDefs(workflow.definition.inputs)

  // 3. Walk multipart fields, bind each file blob to its inputKey.
  const uploadFiles: UploadFile[] = []
  // Cast: bun's undici FormData type narrows to [string, string]; the real
  // value can be a File too — that's what we actually receive at runtime.
  const entries = form.entries() as unknown as Iterable<[string, string | File]>
  for (const [fieldName, value] of entries) {
    if (fieldName === 'payload') continue
    const m = UPLOAD_FIELD_RE.exec(fieldName)
    if (m === null) {
      throw new ValidationError(
        'task-multipart-unknown-field',
        `unexpected multipart field '${fieldName}'; expected 'payload' or 'files[<key>][]'`,
      )
    }
    const inputKey = m[1]!
    if (!uploadDefs.has(inputKey)) {
      throw new ValidationError(
        'task-multipart-unknown-input',
        `multipart files target unknown upload input '${inputKey}'`,
      )
    }
    if (typeof value === 'string') {
      throw new ValidationError(
        'task-multipart-string-not-file',
        `field '${fieldName}' must carry a file, got string`,
      )
    }
    const buf = new Uint8Array(await value.arrayBuffer())
    // bun parses a part whose Content-Disposition carries `filename=""` (a
    // browser Blob that was never named) as a File whose `.name` is `undefined`,
    // NOT ''. Treat both empty and missing names as unnamed so we don't hand a
    // non-string filename to sanitizeFilename (which would crash on `.replace`).
    uploadFiles.push({
      inputKey,
      filename: value.name ? value.name : 'upload.bin',
      declaredMime: value.type,
      bytes: buf,
    })
  }

  // 4. Materialize the worktree first so we have a real path to write into.
  const appHome = Paths.root
  const taskId = ulid()
  // RFC-066: multi-repo + multipart uploads is not supported in v1. The
  // upload pipeline writes files into a single worktree; with N sibling
  // worktrees there's no obvious target. Gate at the route so the caller
  // sees a structured 422 instead of a misleading downstream error. The
  // mirror gate in `services/task.ts` startTask catches direct callers
  // that bypass this route.
  if (Array.isArray(startInput.repos) && startInput.repos.length > 1) {
    throw new ValidationError(
      'multi-repo-upload-unsupported',
      'multipart upload inputs are not supported in multi-repo tasks (v1)',
      { repoCount: startInput.repos.length },
    )
  }
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
    const validation = validateWorkflowDef(workflow.definition, {
      agents: await listAgents(deps.db),
      skills: await listSkills(deps.db),
    })
    if (!validation.ok) {
      const errors = validation.issues.filter((i) => (i.severity ?? 'error') === 'error')
      throw new ValidationError(
        'workflow-invalid',
        `workflow '${startInput.workflowId}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'}); fix issues before starting a task`,
        { issues: validation.issues },
      )
    }
  }
  // RFC-107 (Codex impl-gate): validate the uploads (count / total + per-file
  // size / accept / min-max) BEFORE resolving or cloning the repo. Otherwise a
  // valid repoUrl + a bad upload would clone the repo and leave an orphan
  // worktree before applyUploadsToWorktree rejected it. The write phase re-runs
  // these checks; limits are resolved once and reused at step 5.
  const limits = resolveUploadLimits(deps.configPath)
  validateUploadPlan({ defs: uploadDefs, files: uploadFiles, limits })
  // RFC-107: resolve the (single) repo source BEFORE materializing the worktree.
  // resolveRepoSourceSingle handles BOTH path mode (repoPath passes through) and
  // URL mode (clones into the gitRepoCache and returns the local cache path) —
  // so URL + upload now works. A URL clone/resolve failure throws the SAME
  // structured error a JSON URL-mode launch would (parity); it propagates as a
  // 4xx and no task row is created. The resolved source is threaded into
  // startTask via `preResolvedSource` so the URL is resolved EXACTLY ONCE
  // (RFC-107 D1-B) on both the success and the materialize-failure handoff.
  // `normalizeStartTaskRepos` reuses startTask's own legacy/v2 body normalization
  // (the multi-repo>1 case was rejected above, so [0] is the single repo).
  const multipartSpec = normalizeStartTaskRepos(startInput)[0]!
  const resolvedSource: ResolvedRepoSource = await resolveRepoSourceSingle(
    multipartSpec,
    startInput,
    {
      db: deps.db,
      appHome,
    },
  )
  // RFC-107 (Codex design-gate F2 / D5): thread the working branch + git identity
  // into materializeWorktree exactly like the JSON single-repo path
  // (services/task.ts) so an upload launch with a working branch actually checks
  // it out instead of silently persisting workingBranch while running on the
  // default `agent-workflow/{taskId}` isolation branch.
  const wt = await materializeWorktree({
    repoPath: resolvedSource.repoPath,
    baseBranch: resolvedSource.baseBranch,
    taskId,
    appHome,
    // Normalize null → undefined to match materializeWorktree's `workingBranch?:
    // string` contract (null/unset → default isolation branch; a string → check
    // it out). Same observable behavior as the JSON single-repo path.
    workingBranch: startInput.workingBranch ?? undefined,
    gitUserName: startInput.gitUserName ?? null,
    gitUserEmail: startInput.gitUserEmail ?? null,
  })
  const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
  if (wt.earlyError !== null) {
    // Fall back to the original behavior: create a failed task row so the
    // user sees the error. No files were written (worktree never existed).
    const task = await startTask(startInput, {
      db: deps.db,
      actorUserId: actor.user.id,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
      // RFC-103 T2: multipart (upload) start must thread runtime config too.
      ...resolveLaunchRuntimeConfig(deps.configPath),
      // RFC-107 (D1-B): reuse the route's already-resolved source so the
      // materialize-failure path does NOT re-resolve (no second clone/fetch).
      preResolvedSource: resolvedSource,
    })
    return task
  }

  // 5. Write uploads + pack paths back into inputs[] (limits resolved at step 4).
  try {
    const result = await applyUploadsToWorktree({
      worktreePath: wt.worktreePath,
      defs: uploadDefs,
      files: uploadFiles,
      limits,
    })
    const inputsOut: Record<string, string> = { ...startInput.inputs }
    for (const [key, paths] of result.packedByKey.entries()) {
      inputsOut[key] = paths.join('\n')
    }
    // 6. Hand off to startTask with the pre-created worktree.
    return await startTask(
      { ...startInput, inputs: inputsOut },
      {
        db: deps.db,
        actorUserId: actor.user.id,
        ...(opencodeCmd ? { opencodeCmd } : {}),
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
        // RFC-103 T2: multipart (upload) start must thread runtime config too.
        ...resolveLaunchRuntimeConfig(deps.configPath),
        // RFC-107 (D1-B): reuse the route's already-resolved source so startTask
        // does not resolve the URL a second time (resolve exactly once).
        preResolvedSource: resolvedSource,
        preCreatedWorktree: {
          taskId,
          worktreePath: wt.worktreePath,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
        },
      },
    )
  } catch (err) {
    // Upload write failed (limits, accept, or fs error). Throw a structured
    // error; the worktree directory stays on disk but no task row is
    // created, matching the "createWorktree failed" semantics.
    if (err instanceof ValidationError) throw err
    throw new ValidationError(
      'task-upload-failed',
      `failed to land uploads into worktree: ${(err as Error).message}`,
    )
  }
}
