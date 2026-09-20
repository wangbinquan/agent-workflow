// RFC-360: model discovery belongs to Runtime Management.
import type { Hono } from 'hono'
import { registerRoute } from '@/routes/registry'
import { parseBoolQuery } from '@/util/http'
import type { RuntimeModelQueries } from '@/modules/runtime-management/public/queries'

export type RuntimeRouteDependencies = RuntimeModelQueries

export function mountRuntimeRoutes(app: Hono, deps: RuntimeRouteDependencies): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/runtime/models',
      permissions: ['runtime:read'],
      tokenAccess: 'allow',
      summary: 'List models the selected runtime offers',
    },
    async (c) => {
      const result = await deps.list({
        runtime: c.req.query('runtime'),
        refresh: parseBoolQuery(c, 'refresh', { default: false }),
      })
      return result.kind === 'listed' ? c.json(result.models) : c.json(result.error, 502)
    },
  )
}
