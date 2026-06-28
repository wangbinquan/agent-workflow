// GET /api/config — return resolved config
// PUT /api/config — body is a partial patch; merged + validated + saved
// Both require token auth (mounted under /api/* in server.ts).

import type { Hono } from 'hono'
import { applyConfigPatch, loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { getRuntime } from '@/services/runtimeRegistry'
import { ValidationError } from '@/util/errors'

export function mountConfigRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/config', (c) => {
    const cfg = loadConfig(deps.configPath)
    return c.json(cfg)
  })

  app.put('/api/config', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    // RFC-118: re-pointing the default runtime must target an ENABLED runtime
    // (a disabled runtime stays in the list but can't be the default). Only checked
    // when the patch actually CHANGES defaultRuntime (keeping the current value is a
    // no-op — and the effective default is protected from being disabled anyway).
    if (typeof body.defaultRuntime === 'string' && body.defaultRuntime.length > 0) {
      const current = loadConfig(deps.configPath).defaultRuntime
      if (body.defaultRuntime !== current) {
        const row = await getRuntime(deps.db, body.defaultRuntime)
        if (row !== null && !row.enabled) {
          throw new ValidationError(
            'runtime-disabled',
            `cannot set disabled runtime '${body.defaultRuntime}' as the default; enable it first`,
          )
        }
      }
    }
    const updated = applyConfigPatch(deps.configPath, body)
    return c.json(updated)
  })
}
