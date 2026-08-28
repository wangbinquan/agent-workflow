import type { MaintenanceStatus } from '@agent-workflow/shared'
import type { Hono } from 'hono'

import type { AppDeps } from '@/server'
import { loadConfig } from '@/config'
import { registerRoute } from '@/routes/registry'

export function mountMaintenanceRoutes(app: Hono, deps: AppDeps): void {
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
      return c.json(deps.maintenanceStatus?.() ?? fallback())
    },
  )
}
