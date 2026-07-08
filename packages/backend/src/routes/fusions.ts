// RFC-101 — memory→skill fusion HTTP routes.
//
//   POST   /api/fusions                 launch a fusion (skill + memories + intent)
//   GET    /api/fusions?skillName=       list (own + admin-all)
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
import type { AppDeps } from '@/server'
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
// RFC-143 PR-5: resolveOpencodeCmd deduped to util/opencode (was 5 route-local copies).
import { resolveOpencodeCmd } from '@/util/opencode'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { isAdminActor } from '@/services/resourceAcl'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'

export function mountFusionRoutes(app: Hono, deps: AppDeps): void {
  function fusionDeps(): FusionDeps {
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    // RFC-108 T4 (Codex impl gate P2): thread the per-node timeout floor so a
    // hung fusion agent is bounded like any other node. RFC-115: also thread
    // the global retry budget + default runtime (Codex F3) into the fusion task.
    const { defaultPerNodeTimeoutMs, defaultNodeRetries, defaultRuntime } =
      resolveLaunchRuntimeConfig(deps.configPath)
    return {
      db: deps.db,
      appHome: Paths.root,
      ...(opencodeCmd ? { opencodeCmd } : {}),
      ...(defaultPerNodeTimeoutMs !== undefined ? { defaultPerNodeTimeoutMs } : {}),
      ...(defaultNodeRetries !== undefined ? { defaultNodeRetries } : {}),
      ...(defaultRuntime !== undefined ? { defaultRuntime } : {}),
    }
  }

  app.post('/api/fusions', async (c) => {
    const parsed = LaunchFusionSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('fusion-invalid', 'invalid fusion payload', {
        issues: parsed.error.issues,
      })
    }
    const fusion = await createFusion(parsed.data, fusionDeps(), actorOf(c))
    return c.json(fusion, 201)
  })

  app.get('/api/fusions', async (c) => {
    const actor = actorOf(c)
    const skillName = c.req.query('skillName')
    // Validate ?status against the enum (no `as` cast — RFC-054 W1-7); an
    // unknown value is treated as "no status filter".
    const statusRaw = c.req.query('status')
    const statusParsed =
      statusRaw !== undefined ? FusionStatusSchema.safeParse(statusRaw) : undefined
    const status = statusParsed?.success === true ? statusParsed.data : undefined
    // listFusionSummaries pushes status/skillName into SQL and never reads the
    // proposedDiff, so the inbox's 15s poll stays cheap. Full diff: /:id.
    const all = await listFusionSummaries(fusionDeps(), {
      ...(skillName ? { skillName } : {}),
      ...(status ? { status } : {}),
    })
    const visible = isAdminActor(actor) ? all : all.filter((f) => f.ownerUserId === actor.user.id)
    return c.json(visible)
  })

  // Left-nav inbox badge. Reconciles running fusions (lazy done-detection), so
  // a fusion whose engine task just finished is surfaced within one poll. MUST
  // precede '/api/fusions/:id' so 'pending-count' isn't captured as an id.
  // Uses a narrow (id, ownerUserId) projection — no diff read/parse per poll.
  app.get('/api/fusions/pending-count', async (c) => {
    const actor = actorOf(c)
    const owners = await awaitingApprovalFusionOwners(fusionDeps())
    const count = isAdminActor(actor)
      ? owners.length
      : owners.filter((o) => o.ownerUserId === actor.user.id).length
    return c.json({ count })
  })

  app.get('/api/fusions/:id', async (c) => {
    const actor = actorOf(c)
    const fusion = await getFusion(fusionDeps(), c.req.param('id'))
    // RFC-099-style existence isolation: not-owner / not-found are identical.
    if (fusion === null || (!isAdminActor(actor) && fusion.ownerUserId !== actor.user.id)) {
      throw new NotFoundError('fusion-not-found', `fusion '${c.req.param('id')}' not found`)
    }
    return c.json(fusion)
  })

  app.post('/api/fusions/:id/approve', async (c) => {
    return c.json(await approveFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
  })

  app.post('/api/fusions/:id/reject', async (c) => {
    const parsed = RejectFusionSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('fusion-reject-invalid', 'invalid reject payload', {
        issues: parsed.error.issues,
      })
    }
    return c.json(
      await rejectFusion(fusionDeps(), c.req.param('id'), parsed.data.feedback, actorOf(c)),
    )
  })

  app.post('/api/fusions/:id/cancel', async (c) => {
    return c.json(await cancelFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
