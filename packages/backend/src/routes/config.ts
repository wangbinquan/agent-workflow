// GET /api/config — return resolved config
// PUT /api/config — body is a partial patch; merged + validated + saved
// Both require token auth (mounted under /api/* in server.ts).

import type { Hono } from 'hono'
import { applyConfigPatch, loadConfig, previewConfigPatch } from '@/config'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import {
  getRuntime,
  invalidateInheritedRuntimeProbeReceipts,
  type RuntimeProtocol,
  withRuntimeProbeConfigFence,
} from '@/services/runtimeRegistry'
import { ValidationError } from '@/util/errors'
import { getMcpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { Paths } from '@/util/paths'
import { notifyConfigApplied } from '@/services/configAppliedListeners'
import { configureLogger } from '@/util/log'

export function mountConfigRoutes(app: Hono, deps: AppDeps): void {
  const runtimeTests = getMcpRuntimeTestService({
    db: deps.db,
    configPath: deps.configPath,
    appHome: deps.mcpRuntimeTestDependencies?.appHome ?? Paths.root,
    runFn: deps.mcpRuntimeTestDependencies?.runFn,
    now: deps.mcpRuntimeTestDependencies?.now,
    capacity: deps.mcpRuntimeTestDependencies?.capacity,
  })
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/config',
      permissions: ['settings:read'],
      tokenAccess: 'allow',
      summary: 'Read daemon configuration',
    },
    (c) => {
      return c.json(loadConfig(deps.configPath))
    },
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
        // RFC-261 (D9'): body 置空窗口不得长于整行保留窗口——行先删的话 body 段
        // 永远空转，这是自相矛盾的意图，挡在保存门（运行期对手改 config 的畸形
        // 组合保持无害容忍，见 deliveryStore.gcDeliveries）。校验合并后的完整
        // config，无关 PUT 也过闸。
        if (
          nextConfig.webhookDeliveryBodyRetentionDays > nextConfig.webhookDeliveryRowRetentionDays
        ) {
          throw new ValidationError(
            'webhook-retention-invalid',
            `webhookDeliveryBodyRetentionDays (${nextConfig.webhookDeliveryBodyRetentionDays}) must not exceed webhookDeliveryRowRetentionDays (${nextConfig.webhookDeliveryRowRetentionDays})`,
          )
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
        // RFC-255: seal new credentials, carry preserved ones over, and reject
        // an id that would re-point a built-in catalog provider.
        //
        // Gated on the patch actually CARRYING customProviders. The merged
        // config always contains the stored entries, whose keys are already
        // sealed — running the gate over those would treat each sealed value as
        // fresh plaintext and seal it a second time, so an unrelated settings
        // change (a log level, a theme) would silently corrupt every gateway
        // credential on the box.
        const updated = applyConfigPatch(deps.configPath, body)
        notifyConfigApplied(deps.configPath, updated)
        if (updated.logLevel !== currentConfig.logLevel) {
          configureLogger({ level: updated.logLevel })
        }
        await runtimeTests.reconcileDurableIntents()
        // RFC-266 linearization point for the concurrency pools. Semaphore
        // supports live resize (growing drains the FIFO so queued nodes start
        // at once, shrinking never preempts an in-flight holder), but until now
        // the ONLY caller was runTask — so a saved value sat inert until the
        // next task launch, and with no launch in sight it never applied at
        // all. Resizing here makes all three knobs take effect on save, for
        // RUNNING tasks and for nodes already queued for a slot.
        //
        // AFTER applyConfigPatch on purpose: a failed file write must not leave
        // the daemon admitting work at a capacity that was never persisted.
        // `deps.db` is the same DbClient object the scheduler holds (one openDb
        // in cli/start.ts feeds both createApp and buildStartTaskDeps), so the
        // WeakMap keying reaches the very limiters runTask uses.
        resizeAllNodePools(deps.db, {
          agent: updated.maxConcurrentNodes,
          script: updated.maxConcurrentScriptNodes,
          // RFC-269 — the third pool hot-applies on the same linearization point.
          'code-host': updated.maxConcurrentCodeHostCalls,
        })
        resizeAllTaskFanoutSems(updated.multiProcessSubprocessConcurrency)
        return c.json(updated)
      })
    },
  )
}
