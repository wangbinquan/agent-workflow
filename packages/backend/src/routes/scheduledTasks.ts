// RFC-159 — scheduled-task HTTP routes.
// GET    /api/scheduled-tasks       — list (owner + tasks:read:all admin see all)
// GET    /api/scheduled-tasks/:id   — one (invisible == 404)
// POST   /api/scheduled-tasks       — create (owner = actor; create-time launch gate)
// PUT    /api/scheduled-tasks/:id   — update (owner/admin)
// DELETE /api/scheduled-tasks/:id   — delete (owner/admin)
//
// Member-based-private like tasks (owner_user_id + tasks:read:all admin bypass),
// NOT the RFC-099 five-type ACL. Run history for a schedule = its launched tasks
// via GET /api/tasks?scheduledTaskId= (see routes/tasks.ts).
import {
  CreateScheduledTaskSchema,
  isResourceAdminRole,
  rejectRetiredStartTaskKeys,
  UpdateScheduledTaskSchema,
} from '@agent-workflow/shared'
import type { ScheduledTask } from '@agent-workflow/shared'
import type { Hono } from 'hono'

import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { buildScheduleLaunch } from '@/services/scheduleLaunch'
import {
  canViewScheduledTask,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  runScheduleNow,
  updateScheduledTask,
} from '@/services/scheduledTasks'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { loadConfig } from '@/config'

/** Write authority: owner or a resource admin (admin OR manager — RFC-222 D2). */
function requireWriteAccess(actor: Actor, row: ScheduledTask): void {
  if (row.ownerUserId === actor.user.id) return
  if (isResourceAdminRole(actor.user.role)) return
  throw new ForbiddenError('scheduled-task-forbidden', `not permitted to modify '${row.id}'`)
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

async function loadVisible(deps: AppDeps, actor: Actor, id: string): Promise<ScheduledTask> {
  const row = await getScheduledTask(deps.db, id)
  // Invisible == missing (same 404) so a non-owner can't probe existence.
  if (row === null || !canViewScheduledTask(actor, row)) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  return row
}

/** RFC-165 (N1-r3): the launch-arming operations gate. */
function requireLaunchPermission(actor: Actor): void {
  if (!actor.permissions.has('tasks:launch')) {
    throw new ForbiddenError('forbidden', 'missing permission: tasks:launch', {
      requiredPermission: 'tasks:launch',
    })
  }
}

export function mountScheduledTaskRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/scheduled-tasks', async (c) => {
    const actor = actorOf(c)
    const all = await listScheduledTasks(deps.db)
    return c.json(all.filter((row) => canViewScheduledTask(actor, row)))
  })

  app.get('/api/scheduled-tasks/:id', async (c) => {
    return c.json(await loadVisible(deps, actorOf(c), c.req.param('id')))
  })

  app.post('/api/scheduled-tasks', async (c) => {
    // RFC-165 (N1-r3): creating a schedule arms future launches — same
    // delegation as launching, so the same tasks:launch permission.
    requireLaunchPermission(actorOf(c))
    const rawBody = await safeJson(c.req.raw)
    // RFC-165 (F1): reject retired path-mode keys inside the stored payload
    // BEFORE parsing (non-strict zod would silently strip them and persist a
    // silently-degraded schedule).
    {
      const retired = rejectRetiredStartTaskKeys(
        (rawBody as { launchPayload?: unknown } | null)?.launchPayload ?? null,
      )
      if (retired !== null) {
        throw new ValidationError(
          'start-task-path-retired',
          `RFC-165 retired path-mode launches; remove '${retired}' from launchPayload (use a file:// repoUrl for local repos)`,
        )
      }
    }
    const parsed = CreateScheduledTaskSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('scheduled-task-invalid', 'invalid scheduled task', {
        issues: parsed.error.issues,
      })
    }
    const created = await createScheduledTask(deps.db, parsed.data, {
      actor: actorOf(c),
      defaultRuntime: loadConfig(deps.configPath).defaultRuntime,
    })
    return c.json(created, 201)
  })

  app.put('/api/scheduled-tasks/:id', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisible(deps, actor, c.req.param('id'))
    requireWriteAccess(actor, existing)
    const rawPatch = await safeJson(c.req.raw)
    {
      const retired = rejectRetiredStartTaskKeys(
        (rawPatch as { launchPayload?: unknown } | null)?.launchPayload ?? null,
      )
      if (retired !== null) {
        throw new ValidationError(
          'start-task-path-retired',
          `RFC-165 retired path-mode launches; remove '${retired}' from launchPayload (use a file:// repoUrl for local repos)`,
        )
      }
    }
    const parsed = UpdateScheduledTaskSchema.safeParse(rawPatch)
    if (!parsed.success) {
      throw new ValidationError('scheduled-task-invalid', 'invalid scheduled task patch', {
        issues: parsed.error.issues,
      })
    }
    const updated = await updateScheduledTask(deps.db, existing.id, parsed.data, {
      actor,
      defaultRuntime: loadConfig(deps.configPath).defaultRuntime,
    })
    return c.json(updated)
  })

  app.delete('/api/scheduled-tasks/:id', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisible(deps, actor, c.req.param('id'))
    requireWriteAccess(actor, existing)
    await deleteScheduledTask(deps.db, existing.id)
    return c.body(null, 204)
  })

  // T7 — manual "run now": fire immediately, independent of the schedule cadence
  // (does NOT touch next_run_at / last_* / streak). Owner/admin only. Works even on
  // a disabled schedule (manual override). Launch failures surface as HTTP errors.
  app.post('/api/scheduled-tasks/:id/run-now', async (c) => {
    // RFC-165 (N1-r3): run-now IS a launch.
    requireLaunchPermission(actorOf(c))
    const actor = actorOf(c)
    const existing = await loadVisible(deps, actor, c.req.param('id'))
    requireWriteAccess(actor, existing)
    const launch = deps.buildScheduleLaunch ?? buildScheduleLaunch(deps.db, deps.configPath)
    const result = await runScheduleNow(
      deps.db,
      existing.id,
      launch,
      loadConfig(deps.configPath).defaultRuntime,
    )
    return c.json(result, 201)
  })
}
