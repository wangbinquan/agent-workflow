import type { DatabaseRuntimeTelemetry, MaintenanceStatus } from '@agent-workflow/shared'
import type { Hono } from 'hono'

import { loadConfig } from '@/config'
import { registerRoute } from '@/routes/registry'

export interface MaintenanceRouteDependencies {
  readonly configPath: string
  readonly maintenanceStatus?: () => MaintenanceStatus
  readonly databaseTelemetry?: () => DatabaseRuntimeTelemetry
}

export function mountMaintenanceRoutes(app: Hono, deps: MaintenanceRouteDependencies): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/maintenance/status',
      permissions: ['settings:read'],
      tokenAccess: 'allow',
      summary: 'Read maintenance worker and schedule status',
    },
    (c) => {
      const fallback = (): MaintenanceStatus => ({
        version: 1,
        worker: {
          state: 'degraded',
          lastHeartbeatAt: null,
          error: 'maintenance-service-not-composed',
        },
        schedule: loadConfig(deps.configPath).maintenanceSchedule,
        nextRunAt: null,
        active: null,
        last: null,
        backlog: [],
      })
      const status = deps.maintenanceStatus?.() ?? fallback()
      const database = deps.databaseTelemetry?.()
      return c.json(database === undefined ? status : { ...status, database })
    },
  )
}
