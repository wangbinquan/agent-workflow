// RFC-001: live opencode probe + models list for the Settings → Runtime tab.
// Mounted under /api/* — token auth applied by server.ts.

import type { Hono } from 'hono'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import {
  MAX_OPENCODE_VERSION_EXCLUSIVE,
  MIN_OPENCODE_VERSION,
  probeOpencode,
} from '@/util/opencode'
import { listOpencodeModels } from '@/util/opencode-models'

export function mountRuntimeRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/runtime/opencode', async (c) => {
    const cfg = loadConfig(deps.configPath)
    const probe = await probeOpencode(cfg.opencodePath)
    return c.json({
      binary: probe.binary,
      version: probe.version,
      compatible: probe.compatible,
      incompatibleReason: probe.incompatibleReason,
      minVersion: MIN_OPENCODE_VERSION,
      maxVersionExclusive: MAX_OPENCODE_VERSION_EXCLUSIVE,
    })
  })

  app.get('/api/runtime/models', async (c) => {
    const cfg = loadConfig(deps.configPath)
    const refreshParam = c.req.query('refresh')
    const refresh = refreshParam === '1' || refreshParam === 'true'
    try {
      const result = await listOpencodeModels(cfg.opencodePath ?? 'opencode', { refresh })
      return c.json(result)
    } catch (err) {
      return c.json(
        { ok: false, code: 'opencode-models-failed', message: (err as Error).message },
        502,
      )
    }
  })
}
