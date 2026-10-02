// RFC-370: bootstrap must bind live queries and Settings commands to the same
// storage receiver, and a save must wait for that binding's hot-apply ACK.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import type { ApplicationConfigurationDependencies } from '@/modules/system-operations/application/ports/applicationConfiguration'
import {
  mergeValidatedConfigurationPatch,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function commandEffects(calls: string[]) {
  return {
    runtimeRegistry: {
      async validateDefaultChange() {},
      async invalidateInheritedRuntimeProbeReceipts() {
        calls.push('invalidate')
        return 0
      },
    },
    async withRuntimeProbeConfigFence<T>(operation: () => Promise<T>): Promise<T> {
      return await operation()
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
}

describe('RFC-370 selected configuration binding', () => {
  test('queries and commands keep the same live storage receiver without a path', async () => {
    class Storage {
      current = structuredClone(DEFAULT_CONFIG)
      reads = 0
      previews = 0
      writes = 0
      async load() {
        expect<unknown>(this).toBe(storage)
        this.reads += 1
        return structuredClone(this.current)
      }
      async previewPatch(patch: unknown) {
        expect<unknown>(this).toBe(storage)
        this.previews += 1
        return mergeValidatedConfigurationPatch(this.current, validateConfigurationPatch(patch))
      }
      async applyPatch(patch: unknown) {
        expect<unknown>(this).toBe(storage)
        this.writes += 1
        this.current = await this.previewPatch(patch)
        return structuredClone(this.current)
      }
    }
    const storage = new Storage()
    const binding = composeApplicationConfigurationBinding({
      kind: 'selected',
      persistence: storage,
      notificationKey: 'rfc370-logical-settings',
    })
    const commands = binding.composeCommands(commandEffects([]))
    expect(binding.notificationKey).toBe('rfc370-logical-settings')
    expect(await binding.queries.read()).toEqual(DEFAULT_CONFIG)
    storage.current = { ...storage.current, publicBaseUrl: 'https://live.example' }
    expect((await commands.read()).publicBaseUrl).toBe('https://live.example')
    await commands.update({ mcpSurfaceEnabled: false })
    expect(await binding.queries.read()).toMatchObject({
      publicBaseUrl: 'https://live.example',
      mcpSurfaceEnabled: false,
    })
    expect(storage.writes).toBe(1)
    expect(storage.previews).toBe(2)
    expect(storage.reads).toBe(4)
  })

  test('the selected logical notification waits before reconciliation and pool resize', async () => {
    let current: Config = structuredClone(DEFAULT_CONFIG)
    const calls: string[] = []
    const entered = barrier()
    const release = barrier()
    const key = 'rfc370-held-binding-apply'
    const binding = composeApplicationConfigurationBinding({
      kind: 'selected',
      notificationKey: key,
      persistence: {
        load: () => structuredClone(current),
        previewPatch: (patch) =>
          mergeValidatedConfigurationPatch(current, validateConfigurationPatch(patch)),
        applyPatch(patch) {
          current = mergeValidatedConfigurationPatch(current, validateConfigurationPatch(patch))
          calls.push('persist')
          return structuredClone(current)
        },
      },
    })
    const unregister = registerConfigAppliedListener(key, async (config) => {
      expect(config).toEqual(current)
      calls.push('notify-enter')
      entered.resolve()
      await release.promise
      calls.push('notify-ack')
    })
    let settled = false
    const pending = binding.composeCommands(commandEffects(calls)).update({ maxConcurrentNodes: 7 })
    const completion = pending.then((config) => {
      settled = true
      return config
    })
    try {
      await Promise.race([
        entered.promise,
        completion.then(() => {
          throw new Error('save returned before the selected hot-apply listener')
        }),
      ])
      expect((await binding.queries.read()).maxConcurrentNodes).toBe(7)
      expect(calls).toEqual(['invalidate', 'persist', 'notify-enter'])
      expect(settled).toBe(false)
      release.resolve()
      expect((await completion).maxConcurrentNodes).toBe(7)
      expect(calls).toEqual([
        'invalidate',
        'persist',
        'notify-enter',
        'notify-ack',
        'reconcile',
        'concurrency',
      ])
    } finally {
      release.resolve()
      await completion
      unregister()
    }
  })

  test('selected load and write failures propagate without changing or notifying settings', async () => {
    const readFailure = new Error('selected read unavailable')
    const writeFailure = new Error('selected write unavailable')
    const calls: string[] = []
    let failingRead = true
    const binding = composeApplicationConfigurationBinding({
      kind: 'selected',
      notificationKey: 'rfc370-binding-errors',
      persistence: {
        async load() {
          if (failingRead) throw readFailure
          return structuredClone(DEFAULT_CONFIG)
        },
        previewPatch: (patch) =>
          mergeValidatedConfigurationPatch(DEFAULT_CONFIG, validateConfigurationPatch(patch)),
        async applyPatch() {
          throw writeFailure
        },
      },
    })
    const unregister = registerConfigAppliedListener(binding.notificationKey, () => {
      calls.push('notify')
    })
    const commands = binding.composeCommands(commandEffects(calls))
    try {
      await expect(Promise.resolve(binding.queries.read())).rejects.toBe(readFailure)
      await expect(commands.read()).rejects.toBe(readFailure)
      failingRead = false
      await expect(commands.update({ maxConcurrentNodes: 7 })).rejects.toBe(writeFailure)
      expect(calls).toEqual(['invalidate'])
      expect(await binding.queries.read()).toEqual(DEFAULT_CONFIG)
    } finally {
      unregister()
    }
  })

  test('the legacy read-only override retains its identity while Settings uses the file adapter', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-config-binding-'))
    const path = join(home, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({ ...DEFAULT_CONFIG, publicBaseUrl: 'https://file.example' }),
    )
    const queries = {
      read: () => ({ ...structuredClone(DEFAULT_CONFIG), publicBaseUrl: 'https://query.example' }),
    }
    try {
      const binding = composeApplicationConfigurationBinding({
        kind: 'file',
        configPath: path,
        queries,
      })
      expect(binding.queries).toBe(queries)
      expect(binding.notificationKey).toBe(path)
      const commands = binding.composeCommands(commandEffects([]))
      expect((await commands.read()).publicBaseUrl).toBe('https://file.example')
      expect((await binding.queries.read()).publicBaseUrl).toBe('https://query.example')
      expect(
        (await commands.update({ publicBaseUrl: 'https://updated-file.example' })).publicBaseUrl,
      ).toBe('https://updated-file.example')
      expect((await binding.queries.read()).publicBaseUrl).toBe('https://query.example')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
