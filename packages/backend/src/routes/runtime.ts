// RFC-001 + RFC-111: live runtime probes + model lists for Settings → Runtime.
// Mounted under /api/* — token auth applied by server.ts.

import type { Hono } from 'hono'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { MIN_OPENCODE_VERSION, probeOpencode } from '@/util/opencode'
import { listOpencodeModels } from '@/util/opencode-models'
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from '@/services/runtime/claudeCode/probe'
import { listClaudeModels } from '@/services/runtime/claudeCode/models'

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
    })
  })

  // RFC-111: claude-code probe (soft — a missing/old claude only fails claude
  // nodes; opencode-only installs are unaffected, D10).
  app.get('/api/runtime/claude', async (c) => {
    const cfg = loadConfig(deps.configPath)
    const probe = await probeClaudeCode(cfg.claudeCodePath)
    return c.json({
      binary: probe.binary,
      version: probe.version,
      compatible: probe.compatible,
      incompatibleReason: probe.incompatibleReason,
      minVersion: MIN_CLAUDE_CODE_VERSION,
    })
  })

  app.get('/api/runtime/models', async (c) => {
    const cfg = loadConfig(deps.configPath)
    // RFC-111: ?runtime=claude returns the curated static claude model list;
    // default / ?runtime=opencode keeps the live `opencode models` behavior.
    if (c.req.query('runtime') === 'claude') {
      const models = listClaudeModels()
      return c.json({
        binary: cfg.claudeCodePath ?? 'claude',
        models: models.map((m) => ({
          id: m.id,
          provider: m.provider ?? 'anthropic',
          modelID: m.modelID ?? m.id,
          name: m.name,
        })),
        cached: true,
      })
    }
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
