// GET /api/config — return resolved config
// PUT /api/config — body is a partial patch; merged + validated + saved
// Both require token auth (mounted under /api/* in server.ts).

import type { Hono } from 'hono'
import { applyConfigPatch, loadConfig, previewConfigPatch } from '@/config'
import type { AppDeps } from '@/server'
import {
  getRuntime,
  invalidateInheritedRuntimeProbeReceipts,
  resolveAgentRuntime,
  resolveInternalAgentRuntime,
  type RuntimeProtocol,
  withRuntimeProbeConfigFence,
} from '@/services/runtimeRegistry'
import { ValidationError } from '@/util/errors'
import {
  assertAgentExecutionPolicy,
  assertResolvedExecutionPolicy,
} from '@/services/executionPolicy'
import { listAgents } from '@/services/agent'

export function mountConfigRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/config', (c) => {
    const cfg = loadConfig(deps.configPath)
    return c.json(cfg)
  })

  app.put('/api/config', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return withRuntimeProbeConfigFence(deps.configPath, async () => {
      const currentConfig = loadConfig(deps.configPath)
      const nextConfig = previewConfigPatch(deps.configPath, body)
      // RFC-118: re-pointing the default runtime must target an ENABLED runtime
      // (a disabled runtime stays in the list but can't be the default). Only checked
      // when the patch actually CHANGES defaultRuntime (keeping the current value is a
      // no-op — and the effective default is protected from being disabled anyway).
      if (typeof body.defaultRuntime === 'string' && body.defaultRuntime.length > 0) {
        const current = currentConfig.defaultRuntime
        if (body.defaultRuntime !== current) {
          const row = await getRuntime(deps.db, body.defaultRuntime)
          if (row !== null && !row.enabled) {
            throw new ValidationError(
              'runtime-disabled',
              `cannot make disabled runtime '${body.defaultRuntime}' the default; enable it first`,
            )
          }
        }
      }
      // RFC-224 system-agent profiles must never fall back to OpenCode's implicit
      // model. Validate the complete merged config, so an unrelated edit cannot
      // preserve a legacy-invalid internal-agent selection.
      for (const selection of [
        {
          runtimeName: nextConfig.memoryDistillRuntime,
          deprecatedModel: nextConfig.memoryDistillModel,
        },
        {
          runtimeName: nextConfig.commitPushRuntime,
          deprecatedModel: nextConfig.commitPushModel,
        },
        {
          runtimeName: nextConfig.mergeAgentRuntime,
          deprecatedModel: nextConfig.mergeAgentModel,
        },
      ]) {
        assertResolvedExecutionPolicy(
          await resolveInternalAgentRuntime(deps.db, {
            ...selection,
            defaultRuntime: nextConfig.defaultRuntime,
          }),
        )
      }
      // Switching the effective default is a fan-out policy change. Every agent
      // that inherits it is checked before the config file is written.
      if (nextConfig.defaultRuntime !== currentConfig.defaultRuntime) {
        const defaultRuntime = await resolveAgentRuntime(deps.db, null, nextConfig.defaultRuntime)
        assertResolvedExecutionPolicy(defaultRuntime)
        for (const agent of await listAgents(deps.db)) {
          if (agent.runtime === undefined) {
            await assertAgentExecutionPolicy(deps.db, agent, nextConfig.defaultRuntime)
          }
        }
      }
      const changedBinaryProtocols: RuntimeProtocol[] = []
      if (nextConfig.opencodePath !== currentConfig.opencodePath) {
        changedBinaryProtocols.push('opencode')
      }
      if (nextConfig.claudeCodePath !== currentConfig.claudeCodePath) {
        changedBinaryProtocols.push('claude-code')
      }
      // Invalidate first, then atomically replace config.json while holding the
      // same fence as probe finalization. A failed file write may discard a
      // valid display receipt, but can never leave a stale green one behind.
      await invalidateInheritedRuntimeProbeReceipts(deps.db, changedBinaryProtocols)
      const updated = applyConfigPatch(deps.configPath, body)
      return c.json(updated)
    })
  })
}
