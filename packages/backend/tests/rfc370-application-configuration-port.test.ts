// RFC-370: storage replacement must preserve Settings validation and the
// persistence-before-notification/reconciliation/concurrency ordering.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import {
  validateConfigurationPatch,
  mergeValidatedConfigurationPatch,
} from '@/platform/configuration/configurationValues'
import { composeApplicationConfiguration } from '@/modules/system-operations/composition'
import type { ApplicationConfigurationDependencies } from '@/modules/system-operations/application/ports/applicationConfiguration'

function fixture() {
  let stored = structuredClone(DEFAULT_CONFIG)
  const calls: string[] = []
  const defaults: Array<{ previous: string | null | undefined; next: string }> = []
  const invalidated: string[][] = []
  const applied: Config[] = []
  const dependencies: ApplicationConfigurationDependencies = {
    persistence: {
      async load() {
        return structuredClone(stored)
      },
      async previewPatch(body) {
        return mergeValidatedConfigurationPatch(stored, validateConfigurationPatch(body))
      },
      async applyPatch(body) {
        stored = mergeValidatedConfigurationPatch(stored, validateConfigurationPatch(body))
        calls.push('persist')
        return structuredClone(stored)
      },
    },
    async withRuntimeProbeConfigFence(action) {
      calls.push('fence-enter')
      try {
        return await action()
      } finally {
        calls.push('fence-exit')
      }
    },
    runtimeRegistry: {
      async validateDefaultChange(input) {
        defaults.push(input)
        calls.push('default')
      },
      async invalidateInheritedRuntimeProbeReceipts(protocols) {
        invalidated.push([...protocols])
        calls.push('invalidate')
        return protocols.length
      },
    },
    runtimeTests: {
      async reconcileDurableIntents() {
        calls.push('reconcile')
      },
    },
    concurrencyHotApply: {
      async apply(input) {
        expect(input.maxConcurrentNodes).toBe(stored.maxConcurrentNodes)
        calls.push('concurrency')
      },
    },
    applied: {
      async notify(config) {
        expect(config).toEqual(stored)
        applied.push(config)
        calls.push('notify')
      },
      async setLogLevel(level) {
        expect(level).toBe(stored.logLevel)
        calls.push('log')
      },
    },
  }
  return {
    dependencies,
    calls,
    defaults,
    invalidated,
    applied,
    application: composeApplicationConfiguration(dependencies),
  }
}

describe('RFC-370 settings application storage boundary', () => {
  test('asynchronous storage preserves the complete save and hot-apply order', async () => {
    const f = fixture()
    const updated = await f.application.update({
      defaultRuntime: 'new-runtime',
      opencodePath: '/new/opencode',
      maxConcurrentNodes: 7,
      logLevel: 'debug',
    })
    expect(updated).toMatchObject({ defaultRuntime: 'new-runtime', maxConcurrentNodes: 7 })
    expect(await f.application.read()).toEqual(updated)
    expect(f.defaults).toEqual([{ previous: DEFAULT_CONFIG.defaultRuntime, next: 'new-runtime' }])
    expect(f.invalidated).toEqual([['opencode']])
    expect(f.calls).toEqual([
      'fence-enter',
      'default',
      'invalidate',
      'persist',
      'notify',
      'log',
      'reconcile',
      'concurrency',
      'fence-exit',
    ])
  })

  test('no live setting changes while the persistence promise is unresolved', async () => {
    const f = fixture()
    let entered!: () => void
    let release!: () => void
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const allowed = new Promise<void>((resolve) => {
      release = resolve
    })
    const apply = f.dependencies.persistence.applyPatch
    f.dependencies.persistence.applyPatch = async (body) => {
      entered()
      await allowed
      return await apply(body)
    }
    const pending = f.application.update({ maxConcurrentNodes: 8 })
    try {
      await writing
      expect(f.calls).toEqual(['fence-enter', 'invalidate'])
      expect((await f.application.read()).maxConcurrentNodes).toBe(
        DEFAULT_CONFIG.maxConcurrentNodes,
      )
    } finally {
      release()
    }
    expect((await pending).maxConcurrentNodes).toBe(8)
    expect(f.calls).toEqual([
      'fence-enter',
      'invalidate',
      'persist',
      'notify',
      'reconcile',
      'concurrency',
      'fence-exit',
    ])
  })

  test('a failed write cannot notify, reconcile or resize live execution', async () => {
    const f = fixture()
    const failure = new Error('storage unavailable')
    f.dependencies.persistence.applyPatch = async () => {
      throw failure
    }
    await expect(f.application.update({ maxConcurrentNodes: 8 })).rejects.toBe(failure)
    expect(f.calls).toEqual(['fence-enter', 'invalidate', 'fence-exit'])
    expect(f.applied).toEqual([])
    expect((await f.application.read()).maxConcurrentNodes).toBe(DEFAULT_CONFIG.maxConcurrentNodes)
  })

  test('invalid retention is rejected before mutation or probe invalidation', async () => {
    const f = fixture()
    await expect(
      f.application.update({
        webhookDeliveryBodyRetentionDays: 20,
        webhookDeliveryRowRetentionDays: 10,
      }),
    ).rejects.toMatchObject({ code: 'webhook-retention-invalid' })
    expect(f.calls).toEqual(['fence-enter', 'fence-exit'])
    expect(f.applied).toEqual([])
  })

  test('default runtime rejection retains the stored config and all live settings', async () => {
    const f = fixture()
    const failure = new Error('runtime disabled')
    f.dependencies.runtimeRegistry.validateDefaultChange = async () => {
      throw failure
    }
    await expect(f.application.update({ defaultRuntime: 'disabled-runtime' })).rejects.toBe(failure)
    expect(f.calls).toEqual(['fence-enter', 'fence-exit'])
    expect(await f.application.read()).toEqual(DEFAULT_CONFIG)
  })
})
