// GET /health — public; no token required.
// Schema per design.md §4.2.2 row 1.

import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { sql } from 'drizzle-orm'
import { tasks } from '@/db/schema'
import { recoveryCountersSnapshot } from '@/services/recovery'

export interface IdentityAccessHealthDiagnostics {
  snapshot(): {
    readonly accessUpdate: Readonly<{
      success: number
      noOp: number
      conflict: number
      rejected: number
    }>
    readonly authorityReresolution: number
    readonly invalidStoredGrant: number
    readonly wsTargetedRefreshFailure: number
  }
}

export function mountHealthRoutes(
  app: Hono,
  deps: AppDeps,
  identityAccess: IdentityAccessHealthDiagnostics,
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/health',
      permissions: [],
      publicReason:
        'liveness probe; mounted before multiAuth and outside /api/* so it can answer before any identity exists',
      tokenAccess: 'allow',
      summary: 'Liveness probe',
    },
    async (c) => {
      let runningTasks = 0
      try {
        const rows = await deps.db
          .select({ n: sql<number>`count(*)` })
          .from(tasks)
          .where(sql`status = 'running'`)
        runningTasks = Number(rows[0]?.n ?? 0)
      } catch {
        // DB may be locked or in-flight migration; report 0 rather than failing
        // the health probe (which is used by `agent-workflow doctor` too).
      }

      return c.json({
        ok: true,
        opencodeVersion: deps.opencodeVersion,
        dbVersion: deps.dbVersion,
        uptime: Math.round(process.uptime()),
        runningTasks,
        // RFC-108 T3 (AR-11): since-boot counters of system recovery actions, so a
        // daemon that silently reaps orphans every restart is no longer invisible.
        recovery: recoveryCountersSnapshot(),
        // RFC-305 §9: since-boot access/authority diagnostics. Permission ids,
        // credentials and account profile fields never enter this public gauge.
        identityAccess: identityAccess.snapshot(),
      })
    },
  )
}
