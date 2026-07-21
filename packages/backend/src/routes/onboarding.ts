// RFC-211 — guided onboarding sandbox routes.
// GET    /api/onboarding/runs                   — this user's runs + progress
// POST   /api/onboarding/runs                   — start (or resume) a track
// PATCH  /api/onboarding/runs/:id               — progress bookkeeping
// POST   /api/onboarding/runs/:id/provision     — "帮我建"
// POST   /api/onboarding/runs/:id/adopt         — "我自己来" (server-side registration)
// GET    /api/onboarding/examples               — cleanup preview (?scope=all ⇒ admin)
// DELETE /api/onboarding/examples               — one-click cleanup
//
// AUTHORIZATION IS HAND-ROLLED HERE, ON PURPOSE.
// `/api/onboarding/*` sits outside every prefix gate in server.ts, so calling
// the resource services from here would bypass BOTH the method-level permission
// gate (agents:write / skills:write / workflows:write) AND the route-level
// owner check that the real DELETE endpoints perform — the services themselves
// do not check ownership. Each handler therefore re-states both layers
// explicitly. Skipping that would turn "example = true" into a universal delete
// primitive for anyone's resources.
//
// No new permission point is introduced: the four snapshot assertions over
// PERMISSIONS / ROLE_PERMISSIONS make every addition a cross-cutting change,
// and everything needed here already exists (per-resource writes for the guide,
// role-based admin for the instance-wide sweep).

import {
  AdoptOnboardingResourceSchema,
  PatchOnboardingRunSchema,
  ProvisionOnboardingStepSchema,
  StartOnboardingRunSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { ensurePermission } from '@/auth/permissions'
import type { AppDeps } from '@/server'
import { Paths } from '@/util/paths'
import { ForbiddenError, ValidationError } from '@/util/errors'
import type { SkillFsOptions } from '@/services/skill'
import { cleanupExamples, collectExamples } from '@/services/exampleCleanup'
import {
  adoptResource,
  listRuns,
  patchRun,
  provisionStep,
  releaseArtifact,
  startRun,
  type OnboardingLauncher,
} from '@/services/onboarding'
import { startAgentTask } from '@/services/agentLaunch'
import { startTask } from '@/services/task'
import { startWorkgroupTask } from '@/services/workgroupLaunch'
import { assertWorkflowLaunchable } from '@/services/taskLaunchGate'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { resolveOpencodeCmd } from '@/util/opencode'
import type { Actor } from '@/auth/actor'
import {
  StartAgentTaskSchema,
  StartTaskSchema,
  StartWorkgroupTaskSchema,
} from '@agent-workflow/shared'

export function mountOnboardingRoutes(app: Hono, deps: AppDeps): void {
  const skillFs: SkillFsOptions = { appHome: Paths.root }

  app.get('/api/onboarding/runs', async (c) => {
    return c.json(await listRuns(deps.db, actorOf(c)))
  })

  app.post('/api/onboarding/runs', async (c) => {
    const parsed = StartOnboardingRunSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('onboarding-run-invalid', 'invalid onboarding run payload', {
        issues: parsed.error.issues,
      })
    }
    return c.json(await startRun(deps.db, actorOf(c), parsed.data.track), 201)
  })

  app.patch('/api/onboarding/runs/:id', async (c) => {
    const parsed = PatchOnboardingRunSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('onboarding-run-invalid', 'invalid onboarding run payload', {
        issues: parsed.error.issues,
      })
    }
    return c.json(await patchRun(deps.db, actorOf(c), c.req.param('id'), parsed.data))
  })

  app.post('/api/onboarding/runs/:id/provision', async (c) => {
    const parsed = ProvisionOnboardingStepSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('onboarding-step-invalid', 'invalid onboarding step payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    // Building the example creates real agents/skills/workflows, so it demands
    // the same write permissions the normal create endpoints demand.
    ensurePermission(c, 'agents:write')
    if (parsed.data.step.startsWith('skill.')) ensurePermission(c, 'skills:write')
    if (parsed.data.step.startsWith('workflow.')) ensurePermission(c, 'workflows:write')
    // A `.run` step launches a real scratch task; it needs the launch permission
    // (and the launcher below performs the launch through the normal services).
    if (parsed.data.step.endsWith('.run')) ensurePermission(c, 'tasks:launch')
    return c.json(
      await provisionStep(deps.db, actor, c.req.param('id'), parsed.data.step, {
        skillFs,
        launcher: buildOnboardingLauncher(deps, actor),
      }),
    )
  })

  app.post('/api/onboarding/runs/:id/adopt', async (c) => {
    const parsed = AdoptOnboardingResourceSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('onboarding-adopt-invalid', 'invalid adoption payload', {
        issues: parsed.error.issues,
      })
    }
    return c.json(await adoptResource(deps.db, actorOf(c), c.req.param('id'), parsed.data))
  })

  // Un-adopt. Without it a mis-click in the adopt picker would permanently
  // enrol a real resource into a destructive sweep — there is no other write
  // path anywhere that clears `example`.
  app.delete('/api/onboarding/runs/:id/artifacts/:artifactId', async (c) => {
    return c.json(
      await releaseArtifact(deps.db, actorOf(c), c.req.param('id'), c.req.param('artifactId')),
    )
  })

  app.get('/api/onboarding/examples', async (c) => {
    const actor = actorOf(c)
    const scope = c.req.query('scope') === 'all' ? 'all' : 'mine'
    if (scope === 'all') requireAdminActor(actor)
    return c.json(await collectExamples(deps.db, actor, scope))
  })

  app.delete('/api/onboarding/examples', async (c) => {
    const actor = actorOf(c)
    const scope = c.req.query('scope') === 'all' ? 'all' : 'mine'
    // Keyed off the user ROLE rather than a permission point: most permission
    // points are part of the ordinary user baseline, so gating on one of those
    // would make this "admin only" a no-op for everybody.
    if (scope === 'all') requireAdminActor(actor)
    // Cleanup deletes agents, skills and workflows, so require the same writes
    // the individual DELETE endpoints require. Ownership itself is enforced in
    // SQL by collectExamples (see its comment on why ACL alone is not enough).
    ensurePermission(c, 'agents:write')
    ensurePermission(c, 'skills:write')
    ensurePermission(c, 'workflows:write')
    return c.json(await cleanupExamples(deps.db, actor, scope, { skillFs }))
  })
}

function requireAdminActor(actor: { user: { role: string } }): void {
  if (actor.user.role !== 'admin') {
    throw new ForbiddenError('forbidden', 'admin only')
  }
}

/**
 * The `.run` steps launch through the SAME services the real launch endpoints
 * use — every one forced to `scratch: true` (no repo, no repos:write needed) and
 * routed through the ordinary launch gate. Kept at the route edge so the
 * onboarding service never has to import the task subsystem.
 */
function buildOnboardingLauncher(deps: AppDeps, actor: Actor): OnboardingLauncher {
  const startDeps = () =>
    buildStartTaskDeps(
      deps.db,
      deps.configPath,
      actor.user.id,
      resolveOpencodeCmd(deps.configPath),
      deps.secretBox,
    )
  return {
    async launchAgent(agentName, taskName, description) {
      const input = StartAgentTaskSchema.parse({ name: taskName, description, scratch: true })
      const task = await startAgentTask(deps.db, actor, agentName, input, startDeps())
      return { id: task.id, name: task.name }
    },
    async launchWorkflow(workflowId, taskName, inputs) {
      // Same gate the POST /api/tasks handler runs: visible + not built-in.
      await assertWorkflowLaunchable(deps.db, actor, workflowId)
      const input = StartTaskSchema.parse({ workflowId, name: taskName, inputs, scratch: true })
      const task = await startTask(input, startDeps())
      return { id: task.id, name: task.name }
    },
    async launchWorkgroup(workgroupName, taskName, goal) {
      const input = StartWorkgroupTaskSchema.parse({ name: taskName, goal, scratch: true })
      const task = await startWorkgroupTask(deps.db, actor, workgroupName, input, startDeps())
      return { id: task.id, name: task.name }
    },
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}
