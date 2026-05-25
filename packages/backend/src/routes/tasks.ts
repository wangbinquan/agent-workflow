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
import { tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import {
  canViewTask,
  ensureValidAssignments as ensureValidAssignmentsForRoute,
} from '@/services/taskCollab'
import { ForbiddenError } from '@/util/errors'
import {
  cancelTask,
  getTask,
  getTaskDiff,
  listTasks,
  materializeWorktree,
  resumeTask,
  retryNode,
  startTask,
} from '@/services/task'
import {
  getNodeRunEventsFromProjection as getNodeRunEvents,
  getNodeRunStdoutFromProjection as getNodeRunStdout,
  getTaskNodeRunsFromProjection as getTaskNodeRuns,
} from '@/services/taskRunsProjection'
import {
  getSuspensionById,
  listAllOpenSuspensions,
  listTaskSuspensions,
  resolveSuspension,
} from '@/services/suspensions'
import { listTaskTimeline } from '@/services/timeline'
import { SignalKindSchema, type SignalKind } from '@agent-workflow/shared'
import {
  applyUploadsToWorktree,
  DEFAULT_UPLOAD_LIMITS,
  type UploadFile,
  type UploadInputDef,
  type UploadLimits,
} from '@/services/upload'
import { getSessionTree } from '@/services/sessionView'
import { getInventorySnapshot } from '@/services/inventory'
import { runLifecycleInvariants } from '@/services/lifecycleInvariants'
// RFC-061 T10: lifecycleRepair removed. Routes that referenced repairs
// degrade to 410 Gone; PR-C will reintroduce equivalent UX via the
// suspensions projection.
const applyRepairOption = async (..._args: unknown[]): Promise<never> => {
  throw new Error('lifecycleRepair removed by RFC-061 T10')
}
const listRepairOptionsForAlert = (..._args: unknown[]): Array<{ id: string }> => []
import { listOpenLifecycleAlertsForTask } from '@/services/taskAlerts'
import { getWorkflow } from '@/services/workflow'
import { tasksListBroadcaster, TASKS_LIST_CHANNEL } from '@/ws/broadcaster'
import { Paths } from '@/util/paths'
import { NotFoundError, ValidationError } from '@/util/errors'

/**
 * Resolve the opencode subprocess command for the current config. When the
 * user sets `opencodePath` we pass it through to the runner so tasks spawn
 * the exact binary that was probed at daemon start. Without it, the runner
 * keeps falling back to a bare `['opencode']` PATH lookup.
 */
function resolveOpencodeCmd(configPath: string): string[] | undefined {
  try {
    const cfg = loadConfig(configPath)
    if (typeof cfg.opencodePath === 'string' && cfg.opencodePath.length > 0) {
      return [cfg.opencodePath]
    }
  } catch {
    // config unreadable — fall back to default PATH lookup
  }
  return undefined
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
      const task = await handleMultipartTaskStart(c.req.raw, deps, opencodeCmd)
      return c.json(task, 201)
    }

    const parsed = StartTaskSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('task-invalid', 'invalid task payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    // RFC-036: validate assignments against the workflow definition before
    // we materialize the worktree (avoid orphan worktrees on 422 paths).
    const assignments = parsed.data.assignments ?? []
    if (assignments.length > 0) {
      const { getWorkflow } = await import('@/services/workflow')
      const wf = await getWorkflow(deps.db, parsed.data.workflowId)
      if (wf) {
        ensureValidAssignmentsForRoute(wf.definition, assignments)
      }
    }
    const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
    const task = await startTask(parsed.data, {
      db: deps.db,
      actorUserId: actor.user.id,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
    })
    return c.json(task, 201)
  })

  app.patch('/api/tasks/:id/assignments/:nodeId', async (c) => {
    const actor = actorOf(c)
    const taskId = c.req.param('id')
    const nodeId = c.req.param('nodeId')
    const body = (await safeJson(c.req.raw)) as Record<string, unknown>
    const kind = typeof body.kind === 'string' ? body.kind : null
    const newUserId = typeof body.userId === 'string' ? body.userId : null
    if (kind !== 'reviewer' && kind !== 'clarify_target') {
      throw new ValidationError('invalid-assignment', `kind must be reviewer | clarify_target`)
    }
    if (!newUserId) {
      throw new ValidationError('invalid-assignment', `userId is required`)
    }
    // Only the task owner or an admin may PATCH assignments.
    const taskRows = await deps.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1)
    const task = taskRows[0]
    if (!task) throw new NotFoundError('task-not-found', `task ${taskId} not found`)
    const isAdmin = actor.permissions.has('tasks:read:all')
    if (!isAdmin && task.ownerUserId !== actor.user.id) {
      throw new ForbiddenError('forbidden', 'only task owner or admin can change assignments')
    }
    const { changeNodeAssignment } = await import('@/services/taskCollab')
    await changeNodeAssignment(deps.db, {
      taskId,
      nodeId,
      kind,
      newUserId,
      actorId: actor.user.id,
      now: Date.now(),
    })
    return c.json({ ok: true })
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

  // RFC-053 P-6: list currently-open lifecycle_alerts (invariant + stuck)
  // for this task. Powers the StuckTaskBanner — banners only render when
  // the response has at least one row. Empty list = healthy task = no
  // banner at all.
  app.get('/api/tasks/:id/alerts', async (c) => {
    const taskId = c.req.param('id')
    const alerts = await listOpenLifecycleAlertsForTask(deps.db, taskId)
    return c.json({ alerts })
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
      onAlert: (
        row: { taskId: string; rule: string; severity: 'error' | 'warning' },
        transition: 'new' | 'promoted',
      ) => {
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
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
    const task = await resumeTask(deps.db, c.req.param('id'), {
      db: deps.db,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
    })
    return c.json(task)
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
      },
      onAlert: (
        row: { taskId: string; rule: string; severity: 'error' | 'warning' },
        transition: 'new' | 'promoted',
      ) => {
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
    const cascadeRaw = c.req.query('cascade')
    const cascade = cascadeRaw === undefined ? true : cascadeRaw !== 'false'
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
    const task = await retryNode(deps.db, c.req.param('id'), c.req.param('nodeRunId'), {
      cascade,
      deps: {
        db: deps.db,
        ...(opencodeCmd ? { opencodeCmd } : {}),
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
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

  // RFC-061 follow-up — suspensions projection (open clarify / review /
  // retry-* signals). Replaces the deleted /api/clarify + /api/reviews
  // routes with a uniform shape keyed by SignalKind.
  //   GET  /api/tasks/:id/suspensions[?openOnly=true|false]
  //   GET  /api/suspensions/:id
  //   POST /api/suspensions/:id/resolve   body = SignalKind-specific
  app.get('/api/tasks/:id/suspensions', async (c) => {
    const openOnlyRaw = c.req.query('openOnly')
    const openOnly = openOnlyRaw === undefined || openOnlyRaw !== 'false'
    return c.json({ rows: await listTaskSuspensions(deps.db, c.req.param('id'), { openOnly }) })
  })

  // Cross-task open suspensions list — powers the global inbox drawer
  // (one place to see every clarify / review request across tasks).
  // GET /api/suspensions[?signalKind=K&limit=N]
  app.get('/api/suspensions', async (c) => {
    const signalKindRaw = c.req.query('signalKind')
    const limitRaw = c.req.query('limit')
    const opts: { signalKind?: SignalKind; limit?: number } = {}
    if (signalKindRaw !== undefined) {
      const parsed = SignalKindSchema.safeParse(signalKindRaw)
      if (!parsed.success) {
        throw new ValidationError(
          'suspensions-signalKind-invalid',
          `signalKind must be one of the closed SignalKind enum`,
        )
      }
      opts.signalKind = parsed.data
    }
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError('suspensions-limit-invalid', 'limit must be a positive number')
      }
      opts.limit = n
    }
    return c.json({ rows: await listAllOpenSuspensions(deps.db, opts) })
  })

  app.get('/api/suspensions/:id', async (c) => {
    return c.json(await getSuspensionById(deps.db, c.req.param('id')))
  })

  app.post('/api/suspensions/:id/resolve', async (c) => {
    const body = await safeJson(c.req.raw)
    const r = await resolveSuspension(deps.db, c.req.param('id'), body)
    return c.json(r)
  })

  // RFC-061 G9 — events timeline. Cheap pagination across the raw
  // events table for the deferred /tasks/:id/timeline view + any
  // observability surfacing.
  //   GET /api/tasks/:id/timeline[?afterId=:ulid&limit=:n&kind=:k]
  app.get('/api/tasks/:id/timeline', async (c) => {
    const afterId = c.req.query('afterId') ?? null
    const limitRaw = c.req.query('limit')
    const kindFilter = c.req.query('kind') ?? null
    let limit = 500
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError('timeline-limit-invalid', 'limit must be a positive number')
      }
      limit = Math.min(n, 2000)
    }
    return c.json(
      await listTaskTimeline(deps.db, c.req.param('id'), { afterId, limit, kindFilter }),
    )
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
  const parsed = StartTaskSchema.safeParse(payloadJson)
  if (!parsed.success) {
    throw new ValidationError('task-invalid', 'invalid task payload', {
      issues: parsed.error.issues,
    })
  }
  const startInput = parsed.data

  // 2. Resolve workflow → extract upload input declarations.
  const workflow = await getWorkflow(deps.db, startInput.workflowId)
  if (workflow === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${startInput.workflowId}' not found`)
  }
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
    uploadFiles.push({
      inputKey,
      filename: value.name === '' ? 'upload.bin' : value.name,
      declaredMime: value.type,
      bytes: buf,
    })
  }

  // 4. Materialize the worktree first so we have a real path to write into.
  const appHome = Paths.root
  const taskId = ulid()
  // RFC-024 NOTE: multipart upload path currently requires path-mode launch
  // (URL-mode uploads would need to resolve the cache before this point).
  // Refuse URL+upload combos with a clear 422 instead of silently dropping.
  if (startInput.repoUrl) {
    throw new ValidationError(
      'multipart-upload-requires-path-mode',
      'multipart uploads currently require launching with a local repoPath; URL launches are JSON-only',
    )
  }
  const wt = await materializeWorktree({
    repoPath: startInput.repoPath as string,
    baseBranch: startInput.baseBranch,
    taskId,
    appHome,
  })
  const subagentLiveCapture = resolveSubagentLiveCapture(deps.configPath)
  if (wt.earlyError !== null) {
    // Fall back to the original behavior: create a failed task row so the
    // user sees the error. No files were written (worktree never existed).
    const task = await startTask(startInput, {
      db: deps.db,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
    })
    return task
  }

  // 5. Write uploads + pack paths back into inputs[].
  const limits = resolveUploadLimits(deps.configPath)
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
        ...(opencodeCmd ? { opencodeCmd } : {}),
        ...(subagentLiveCapture !== undefined ? { subagentLiveCapture } : {}),
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
