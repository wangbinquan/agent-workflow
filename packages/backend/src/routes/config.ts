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
import { getRuntimeDriver } from '@/services/runtime'
import { getMcpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { Paths } from '@/util/paths'

/** RFC-237 — the intent builder admits only runtimes whose driver declares the
 *  'intent-read-v1' narrowed profile (capability gate, not a protocol-literal
 *  gate). `inherited` switches the message for the defaultRuntime-inheritance
 *  path (design-gate P2-3). */
function assertIntentRuntimeCapability(
  resolved: { name: string; protocol: Parameters<typeof getRuntimeDriver>[0] },
  selection: string,
  inherited: boolean,
): void {
  const driver = getRuntimeDriver(resolved.protocol)
  if (driver.narrowedSystemPermissionProfiles.includes('intent-read-v1')) return
  throw new ValidationError(
    'intent-runtime-unsupported',
    inherited
      ? `the intent builder inherits defaultRuntime '${selection}' (protocol '${resolved.protocol}'), which cannot enforce the intent-read-v1 permission profile; pick a default whose driver declares it or set intentBuilderRuntime explicitly`
      : `runtime '${selection}' (protocol '${resolved.protocol}') cannot enforce the intent-read-v1 permission profile; select a runtime whose driver declares it`,
  )
}

export function mountConfigRoutes(app: Hono, deps: AppDeps): void {
  const runtimeTests = getMcpRuntimeTestService({
    db: deps.db,
    configPath: deps.configPath,
    appHome: deps.mcpRuntimeTestDependencies?.appHome ?? Paths.root,
    containmentCoordinator: deps.containmentCoordinator,
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
        // RFC-224 system-agent profiles must never fall back to OpenCode's implicit
        // model. Validate the complete merged config, so an unrelated edit cannot
        // preserve a legacy-invalid internal-agent selection.
        for (const selection of [
          {
            runtimeName: nextConfig.memoryDistillRuntime,
            deprecatedModel: nextConfig.memoryDistillModel,
          },
          {
            // RFC-239 — change-narrative has no legacy model field.
            runtimeName: nextConfig.changeNarrativeRuntime,
            deprecatedModel: undefined,
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
        // RFC-234 §1.1 / RFC-237 — the intent builder is FAIL-CLOSED on runtime
        // capability: only runtimes whose driver declares the 'intent-read-v1'
        // narrowed profile are admissible. An explicit selection of anything
        // else is rejected HERE, at save time — there is no "configured but
        // degraded at run time" path.
        if (nextConfig.intentBuilderRuntime !== undefined) {
          const resolved = await resolveInternalAgentRuntime(deps.db, {
            runtimeName: nextConfig.intentBuilderRuntime,
            defaultRuntime: nextConfig.defaultRuntime,
          })
          assertResolvedExecutionPolicy(resolved)
          assertIntentRuntimeCapability(resolved, nextConfig.intentBuilderRuntime, false)
        } else if (
          typeof body === 'object' &&
          body !== null &&
          ('intentBuilderRuntime' in body || 'defaultRuntime' in body)
        ) {
          // RFC-237 (design-gate P2-3 + impl-gate P2) — the intent builder
          // inherits the default when unset; validate the EFFECTIVE inherited
          // runtime on EVERY patch that can change that inheritance: switching
          // defaultRuntime AND clearing the intentBuilderRuntime override (the
          // clear path leaves defaultRuntime untouched, so a default-change-only
          // check would persist an unlaunchable inherited config). Unrelated
          // patches skip the resolve so a legacy-bad stored default cannot block
          // orthogonal settings.
          const inherited = await resolveInternalAgentRuntime(deps.db, {
            runtimeName: null,
            defaultRuntime: nextConfig.defaultRuntime,
          })
          assertIntentRuntimeCapability(
            inherited,
            nextConfig.defaultRuntime ?? inherited.name,
            true,
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
        await runtimeTests.reconcileDurableIntents()
        // RFC-233 linearization point: once this response can be observed, every
        // future admission sees the saved mode generation. Existing immutable
        // admissions are intentionally not rewritten.
        deps.containmentCoordinator?.setMode(updated.sandboxMode)
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
