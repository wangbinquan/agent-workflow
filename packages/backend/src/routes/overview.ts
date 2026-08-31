// RFC-190 — GET /api/overview: aggregate per-actor-visible resource counts +
// 7-day task stats for the homepage capability portal. Read-only; sits behind
// the global /api/* multiAuth only (no coarse permission gate) — per-key
// permission granularity is expressed as nulls by services/overview.ts.
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { buildOverview } from '@/services/overview'
import type { MemoryResourceScopeAuthorization } from '@/services/memory'
import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'
import { directRequestAuthority } from '@/routes/operationAuthority'

export interface OverviewRouteAuthorization {
  readonly directAuthority: DirectAuthorityBinding
  readonly resourceScopeAuthorization: MemoryResourceScopeAuthorization
}

export function mountOverviewRoutes(
  app: Hono,
  deps: AppDeps,
  authorization: OverviewRouteAuthorization,
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/overview',
      permissions: [],
      publicReason:
        'no single coarse point: each aggregate key is independently permission-gated and nulls unauthorized counts. Identity is still required because this path is not in multiAuth PUBLIC_PATH_PREFIXES.',
      tokenAccess: 'allow',
      summary: 'Home page aggregate counters',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await buildOverview(deps.db, {
          actor,
          authority: directRequestAuthority(authorization.directAuthority, actor),
          authorization: authorization.resourceScopeAuthorization,
        }),
      )
    },
  )
}
