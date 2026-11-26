// Settings storage is an external effect; all validation, listener delivery and
// downstream command ordering below run through the real composition binding.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import type { ApplicationConfigurationDependencies } from '@/modules/system-operations/application/ports/applicationConfiguration'
import {
  mergeValidatedConfigurationPatch,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'

function fixture(key: string) {
  let current = structuredClone(DEFAULT_CONFIG)
  const calls: string[] = []
  const counts = { reads: 0, previews: 0, writes: 0 }
  const binding = composeApplicationConfigurationBinding({
    kind: 'selected',
    notificationKey: key,
    persistence: {
      load() {
        counts.reads += 1
        return structuredClone(current)
      },
      previewPatch(patch) {
        counts.previews += 1
        return mergeValidatedConfigurationPatch(current, validateConfigurationPatch(patch))
      },
      applyPatch(patch) {
        counts.writes += 1
        current = mergeValidatedConfigurationPatch(current, validateConfigurationPatch(patch))
        calls.push('persist')
        return structuredClone(current)
      },
    },
  })
  const effects = {
    runtimeRegistry: {
      async validateDefaultChange() {
        calls.push('validate-default')
      },
      async invalidateInheritedRuntimeProbeReceipts() {
        calls.push('invalidate')
        return 0
      },
    },
    async withRuntimeProbeConfigFence<T>(operation: () => Promise<T>): Promise<T> {
      return operation()
    },
    runtimeTests: {
      async reconcileDurableIntents() {
        calls.push('reconcile')
      },
    },
    concurrencyHotApply: {
      apply() {
        calls.push('concurrency')
      },
    },
  } satisfies Omit<ApplicationConfigurationDependencies, 'persistence' | 'applied'>
  return { binding, effects, calls, counts }
}

describe('module contract — system-operations configuration binding', () => {
  test('synchronous and asynchronous listener failures are isolated while later listeners and hot apply still finish', async () => {
    const { binding, effects, calls, counts } = fixture('module-contract-listener-errors')
    const receipts: Config[] = []
    const unregister = [
      binding.listeners.register(() => {
        calls.push('sync-listener')
        throw new Error('fixture synchronous consumer unavailable')
      }),
      binding.listeners.register(async () => {
        calls.push('async-listener')
        throw new Error('fixture asynchronous consumer unavailable')
      }),
      binding.listeners.register((config) => {
        calls.push('healthy-listener')
        receipts.push(config)
      }),
    ]
    try {
      const result = await binding.composeCommands(effects).update({ maxConcurrentNodes: 7 })
      expect(result.maxConcurrentNodes).toBe(7)
      expect(receipts).toEqual([result])
      expect(calls).toEqual([
        'invalidate',
        'persist',
        'sync-listener',
        'async-listener',
        'healthy-listener',
        'reconcile',
        'concurrency',
      ])
      expect(counts).toEqual({ reads: 1, previews: 1, writes: 1 })
      expect(await binding.queries.read()).toEqual(result)
    } finally {
      for (const stop of unregister) stop()
    }
  })

  test('independent bindings with the same descriptive key do not share listeners, and unsubscribe is repeatable', async () => {
    const first = fixture('module-contract-shared-label')
    const second = fixture('module-contract-shared-label')
    let firstNotifications = 0
    let secondNotifications = 0
    const stopFirst = first.binding.listeners.register(() => {
      firstNotifications += 1
    })
    const stopSecond = second.binding.listeners.register(() => {
      secondNotifications += 1
    })
    try {
      await first.binding.composeCommands(first.effects).update({ maxConcurrentNodes: 7 })
      expect([firstNotifications, secondNotifications]).toEqual([1, 0])
      expect(await second.binding.queries.read()).toEqual(DEFAULT_CONFIG)
      stopFirst()
      stopFirst()
      await first.binding.composeCommands(first.effects).update({ maxConcurrentNodes: 8 })
      await second.binding.composeCommands(second.effects).update({ maxConcurrentNodes: 9 })
      expect([firstNotifications, secondNotifications]).toEqual([1, 1])
      expect((await first.binding.queries.read()).maxConcurrentNodes).toBe(8)
      expect((await second.binding.queries.read()).maxConcurrentNodes).toBe(9)
    } finally {
      stopFirst()
      stopSecond()
    }
  })

  test('a reconciliation failure preserves the committed value, prevents later hot apply, and retries only on a new command', async () => {
    const { binding, effects, calls, counts } = fixture('module-contract-reconcile-error')
    const failure = new Error('fixture runtime reconciliation unavailable')
    let failing = true
    const commands = binding.composeCommands({
      ...effects,
      runtimeTests: {
        async reconcileDurableIntents() {
          calls.push('reconcile')
          if (failing) throw failure
        },
      },
    })
    await expect(commands.update({ maxConcurrentNodes: 7 })).rejects.toBe(failure)
    expect(calls).toEqual(['invalidate', 'persist', 'reconcile'])
    expect(counts).toEqual({ reads: 1, previews: 1, writes: 1 })
    expect((await binding.queries.read()).maxConcurrentNodes).toBe(7)
    failing = false
    calls.length = 0
    expect((await commands.update({ maxConcurrentNodes: 7 })).maxConcurrentNodes).toBe(7)
    expect(calls).toEqual(['invalidate', 'persist', 'reconcile', 'concurrency'])
    expect(counts.writes).toBe(2)
  })

  test('body retention cannot exceed row retention, while their equality is accepted without extra persistence calls', async () => {
    const { binding, effects, calls, counts } = fixture('module-contract-retention-boundary')
    const commands = binding.composeCommands(effects)
    await expect(
      commands.update({ webhookDeliveryBodyRetentionDays: 8, webhookDeliveryRowRetentionDays: 7 }),
    ).rejects.toMatchObject({ code: 'webhook-retention-invalid' })
    expect(calls).toEqual([])
    expect(counts).toEqual({ reads: 1, previews: 1, writes: 0 })
    expect(await binding.queries.read()).toEqual(DEFAULT_CONFIG)
    expect(
      await commands.update({
        webhookDeliveryBodyRetentionDays: 7,
        webhookDeliveryRowRetentionDays: 7,
      }),
    ).toMatchObject({ webhookDeliveryBodyRetentionDays: 7, webhookDeliveryRowRetentionDays: 7 })
    expect(calls).toEqual(['invalidate', 'persist', 'reconcile', 'concurrency'])
    expect(counts.writes).toBe(1)
  })
})
