// GET /health — public; no token required.
// Schema per design.md §4.2.2 row 1.

import type { Hono } from 'hono'
import { registerRoute } from '@/routes/registry'
import type { HealthDatabaseReadModel } from '@/modules/system-operations/public/queries'
import { recoveryCountersSnapshot } from '@/services/recovery'

export interface HealthRouteDependencies {
  readonly opencodeVersion: string | null
  readonly dbVersion: number
}

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
  deps: HealthRouteDependencies,
  identityAccess: IdentityAccessHealthDiagnostics,
  database: HealthDatabaseReadModel,
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
        runningTasks = await database.countRunningTasks()
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
