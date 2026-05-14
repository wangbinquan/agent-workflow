// GET /api/config — return resolved config
// PUT /api/config — body is a partial patch; merged + validated + saved
// Both require token auth (mounted under /api/* in server.ts).

import type { Hono } from 'hono'
import { applyConfigPatch, loadConfig } from '@/config'
import type { AppDeps } from '@/server'

export function mountConfigRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/config', (c) => {
    const cfg = loadConfig(deps.configPath)
    return c.json(cfg)
  })

  app.put('/api/config', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const updated = applyConfigPatch(deps.configPath, body)
    return c.json(updated)
  })
}
