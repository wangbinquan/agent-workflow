// RFC-190 — GET /api/overview: aggregate per-actor-visible resource counts +
// 7-day task stats for the homepage capability portal. Read-only; sits behind
// the global /api/* multiAuth only (no coarse permission gate) — per-key
// permission granularity is expressed as nulls by services/overview.ts.
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { buildOverview } from '@/services/overview'

export function mountOverviewRoutes(app: Hono, deps: AppDeps): void {
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
      return c.json(await buildOverview(deps.db, actorOf(c)))
    },
  )
}
