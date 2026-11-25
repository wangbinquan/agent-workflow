// RFC-370: configuration HTTP transport delegates to the storage-neutral owner.
import type { Hono } from 'hono'
import { registerRoute } from '@/routes/registry'
import type { ApplicationConfigurationCommands } from '../../application/applicationConfiguration'

export interface ConfigRouteDependencies {
  readonly configuration: ApplicationConfigurationCommands
}

export function mountConfigRoutes(app: Hono, deps: ConfigRouteDependencies): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/config',
      permissions: ['settings:read'],
      tokenAccess: 'allow',
      summary: 'Read daemon configuration',
    },
    async (c) => c.json(await deps.configuration.read()),
  )
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/config',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Update daemon configuration',
    },
    async (c) => {
      const body = await c.req.json().catch(() => ({}))
      return c.json(await deps.configuration.update(body))
    },
  )
}
