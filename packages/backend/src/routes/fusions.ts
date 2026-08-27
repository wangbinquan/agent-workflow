// RFC-101 — memory→skill fusion HTTP routes.
//
//   POST   /api/fusions                 launch a fusion (skill + memories + intent)
//   GET    /api/fusions?skillId=         list (own + admin-all)
//   GET    /api/fusions/:id              detail (owner / admin)
//   POST   /api/fusions/:id/approve      apply the proposed change
//   POST   /api/fusions/:id/reject       request changes + re-run
//   POST   /api/fusions/:id/cancel       cancel
//
// Authentication is the /api/* multiAuth gate; per-fusion authorization (skill
// write, memory manage, fusion ownership) is enforced in services/fusion.ts.

import { FusionStatusSchema, LaunchFusionSchema, RejectFusionSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { directTaskInitiatorFromActorSource } from '@/modules/task-execution/inbound/directTaskInitiator'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import {
  approveFusion,
  awaitingApprovalFusionOwners,
  cancelFusion,
  createFusion,
  getFusion,
  listFusionSummaries,
  rejectFusion,
  type FusionDeps,
} from '@/services/fusion'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { hasResourceAclBypass } from '@/services/resourceAcl'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'
import { safeJsonOrEmpty } from '@/util/http'

export function mountFusionRoutes(app: Hono, deps: AppDeps): void {
  function fusionDeps(): FusionDeps {
    // RFC-108 T4 (Codex impl gate P2): thread the per-node timeout floor so a
    // hung fusion agent is bounded like any other node. RFC-115: also thread
    // the global retry budget + default runtime (Codex F3) into the fusion task.
    const { defaultPerNodeTimeoutMs, defaultNodeRetries, sessionRestartBudget, defaultRuntime } =
      resolveLaunchRuntimeConfig(deps.configPath)
    return {
      db: deps.db,
      appHome: Paths.root,
      configPath: deps.configPath,
      ...(deps.repositoryPublicationTransport === undefined
        ? {}
        : { repositoryPublicationTransport: deps.repositoryPublicationTransport }),
      ...(defaultPerNodeTimeoutMs !== undefined ? { defaultPerNodeTimeoutMs } : {}),
      ...(defaultNodeRetries !== undefined ? { defaultNodeRetries } : {}),
      ...(sessionRestartBudget !== undefined ? { sessionRestartBudget } : {}),
      ...(defaultRuntime !== undefined ? { defaultRuntime } : {}),
    }
  }

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions',
      permissions: ['tasks:execute', 'skills:update'],
      tokenAccess: 'allow',
      summary: 'Launch a memory→skill fusion (runs an agent)',
    },
    async (c) => {
      const parsed = LaunchFusionSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('fusion-invalid', 'invalid fusion payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const fusion = await createFusion(
        parsed.data,
        fusionDeps(),
        actor,
        directTaskInitiatorFromActorSource(actor.source),
      )
      return c.json(fusion, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/fusions',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'List fusions',
    },
    async (c) => {
      const actor = actorOf(c)
      const skillId = c.req.query('skillId')
      // Validate ?status against the enum (no `as` cast — RFC-054 W1-7); an
      // unknown value is treated as "no status filter".
      const statusRaw = c.req.query('status')
      const statusParsed =
        statusRaw !== undefined ? FusionStatusSchema.safeParse(statusRaw) : undefined
      const status = statusParsed?.success === true ? statusParsed.data : undefined
      // listFusionSummaries pushes status/skillId into SQL and never reads the
      // proposedDiff, so the inbox's 15s poll stays cheap. Full diff: /:id.
      const all = await listFusionSummaries(fusionDeps(), {
        ...(skillId ? { skillId } : {}),
        ...(status ? { status } : {}),
      })
      const visible = hasResourceAclBypass(actor)
        ? all
        : all.filter((f) => f.ownerUserId === actor.user.id)
      return c.json(visible)
    },
  )

  // Left-nav inbox badge. Reconciles running fusions (lazy done-detection), so
  // a fusion whose engine task just finished is surfaced within one poll. MUST
  // precede '/api/fusions/:id' so 'pending-count' isn't captured as an id.
  // Uses a narrow (id, ownerUserId) projection — no diff read/parse per poll.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/fusions/pending-count',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Count of fusions awaiting approval',
    },
    async (c) => {
      const actor = actorOf(c)
      const owners = await awaitingApprovalFusionOwners(fusionDeps())
      const count = hasResourceAclBypass(actor)
        ? owners.length
        : owners.filter((o) => o.ownerUserId === actor.user.id).length
      return c.json({ count })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/fusions/:id',
      permissions: ['skills:read'],
      tokenAccess: 'allow',
      summary: 'Get one fusion',
    },
    async (c) => {
      const actor = actorOf(c)
      const fusion = await getFusion(fusionDeps(), c.req.param('id'))
      // RFC-099-style existence isolation: not-owner / not-found are identical.
      if (
        fusion === null ||
        (!hasResourceAclBypass(actor) && fusion.ownerUserId !== actor.user.id)
      ) {
        throw new NotFoundError('fusion-not-found', `fusion '${c.req.param('id')}' not found`)
      }
      return c.json(fusion)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions/:id/approve',
      permissions: ['skills:update', 'memory:update'],
      tokenAccess: 'allow',
      summary: 'Approve a fusion (bumps the skill version and fuses memory)',
    },
    async (c) => {
      return c.json(await approveFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions/:id/reject',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Reject a fusion and re-run it',
    },
    async (c) => {
      const parsed = RejectFusionSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('fusion-reject-invalid', 'invalid reject payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      return c.json(
        await rejectFusion(
          fusionDeps(),
          c.req.param('id'),
          parsed.data.feedback,
          actor,
          directTaskInitiatorFromActorSource(actor.source),
        ),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/fusions/:id/cancel',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Cancel a fusion',
    },
    async (c) => {
      return c.json(await cancelFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
    },
  )
}
