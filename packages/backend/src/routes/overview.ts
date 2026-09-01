// RFC-190 — GET /api/overview: aggregate per-actor-visible resource counts +
// 7-day task stats for the homepage capability portal. Read-only; sits behind
// the global /api/* multiAuth only (no coarse permission gate) — per-key
// permission granularity is expressed as nulls by services/overview.ts.
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'
import type { SystemOverviewQuery } from '@/modules/system-operations/public/queries'
import { directRequestAuthority } from '@/routes/operationAuthority'

export interface OverviewRouteAuthorization {
  readonly directAuthority: DirectAuthorityBinding
}

export type OverviewRouteQuery = SystemOverviewQuery

export function mountOverviewRoutes(
  app: Hono,
  authorization: OverviewRouteAuthorization,
  query: OverviewRouteQuery,
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
        await query.execute({
          actor,
          authority: directRequestAuthority(authorization.directAuthority, actor),
        }),
      )
    },
  )
}
