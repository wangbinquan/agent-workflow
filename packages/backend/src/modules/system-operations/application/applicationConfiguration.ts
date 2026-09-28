// RFC-370: settings validation and hot-apply ordering are storage independent.
import type { ApplicationConfigurationCommands } from '../public/commands'
import type {
  ApplicationConfigurationDependencies,
  ApplicationConfigurationPersistencePort,
} from './ports/applicationConfiguration'
import type { RuntimeKind } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

export function createApplicationConfiguration(
  deps: ApplicationConfigurationDependencies,
): ApplicationConfigurationCommands {
  const persistence: ApplicationConfigurationPersistencePort = deps.persistence
  return {
    async read() {
      return await persistence.load()
    },
    async update(body) {
      return deps.withRuntimeProbeConfigFence(async () => {
        const currentConfig = await persistence.load()
        const nextConfig = await persistence.previewPatch(body)
        const patch = body as { readonly defaultRuntime?: unknown }
        // RFC-118: re-pointing the default runtime must target an ENABLED runtime
        // (a disabled runtime stays in the list but can't be the default). Only checked
        // when the patch actually CHANGES defaultRuntime (keeping the current value is a
        // no-op — and the effective default is protected from being disabled anyway).
        if (typeof patch.defaultRuntime === 'string' && patch.defaultRuntime.length > 0) {
          await deps.runtimeRegistry.validateDefaultChange({
            previous: currentConfig.defaultRuntime,
            next: patch.defaultRuntime,
          })
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
        const changedBinaryProtocols: RuntimeKind[] = []
        if (nextConfig.opencodePath !== currentConfig.opencodePath) {
          changedBinaryProtocols.push('opencode')
        }
        if (nextConfig.claudeCodePath !== currentConfig.claudeCodePath) {
          changedBinaryProtocols.push('claude-code')
        }
        // Invalidate first, then commit the configuration while holding the
        // same fence as probe finalization. A failed configuration write may discard a
        // valid display receipt, but can never leave a stale green one behind.
        await deps.runtimeRegistry.invalidateInheritedRuntimeProbeReceipts(changedBinaryProtocols)
        const updated = await persistence.applyPatch(body)
        await deps.applied.notify(updated)
        if (updated.logLevel !== currentConfig.logLevel) {
          await deps.applied.setLogLevel(updated.logLevel)
        }
        await deps.runtimeTests.reconcileDurableIntents()
        // RFC-266 linearization point for the concurrency pools. Semaphore
        // supports live resize (growing drains the FIFO so queued nodes start
        // at once, shrinking never preempts an in-flight holder), but until now
        // the ONLY caller was runTask — so a saved value sat inert until the
        // next task launch, and with no launch in sight it never applied at
        // all. Resizing here makes all three knobs take effect on save, for
        // RUNNING tasks and for nodes already queued for a slot.
        //
        // AFTER persistence on purpose: a failed configuration write must not leave
        // the daemon admitting work at a capacity that was never persisted.
        // Bootstrap captures the provider/runtime-specific process-pool key
        // and exposes one closed command. Keeping the call after persistence
        // preserves the existing linearization point: a failed configuration write
        // can never change live admission capacity.
        await deps.concurrencyHotApply.apply({
          maxConcurrentNodes: updated.maxConcurrentNodes,
          maxConcurrentScriptNodes: updated.maxConcurrentScriptNodes,
          maxConcurrentCodeHostCalls: updated.maxConcurrentCodeHostCalls,
          multiProcessSubprocessConcurrency: updated.multiProcessSubprocessConcurrency,
          maxActiveChildTasks: updated.maxActiveChildTasks,
          maxInvocationDepth: updated.maxInvocationDepth,
        })
        return updated
      })
    },
  }
}
