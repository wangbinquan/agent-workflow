// RFC-190 — GET /api/overview: aggregate per-actor-visible resource counts +
// 7-day task stats for the homepage capability portal. Read-only; sits behind
// the global /api/* multiAuth only (no coarse permission gate) — per-key
// permission granularity is expressed as nulls by services/overview.ts.
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { buildOverview } from '@/services/overview'

export function mountOverviewRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/overview', async (c) => {
    return c.json(await buildOverview(deps.db, actorOf(c)))
  })
}
