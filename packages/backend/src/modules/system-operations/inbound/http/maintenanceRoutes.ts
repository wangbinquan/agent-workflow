import type { DatabaseRuntimeTelemetry, MaintenanceStatus } from '@agent-workflow/shared'
import type { Hono } from 'hono'

import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { registerRoute } from '@/routes/registry'

export interface MaintenanceRouteDependencies {
  readonly configuration: ApplicationConfigurationQueries
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
    async (c) => {
      const fallback = async (): Promise<MaintenanceStatus> => ({
        version: 1,
        worker: {
          state: 'degraded',
          lastHeartbeatAt: null,
          error: 'maintenance-service-not-composed',
        },
        schedule: (await deps.configuration.read()).maintenanceSchedule,
        nextRunAt: null,
        active: null,
        last: null,
        backlog: [],
      })
      const status = deps.maintenanceStatus?.() ?? (await fallback())
      const database = deps.databaseTelemetry?.()
      return c.json(database === undefined ? status : { ...status, database })
    },
  )
}
