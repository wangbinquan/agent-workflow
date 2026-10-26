// Raw runtime configuration now belongs to B's approval-bound environment.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { initializeRuntimeRegistryBoot } from '@/modules/runtime-management/composition/runtimeRegistry'
import { runtimeConfigEnvironment } from '@/modules/runtime-management/infrastructure/migration/runtimeConfigRule'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
test('ordinary boot only seeds current builtins', async () => {
  const events: string[] = []
  await initializeRuntimeRegistryBoot({
    operations: {
      async seedBuiltinRuntimes() {
        events.push('seed')
      },
    },
    onRecoverableFailure(error) {
      throw error
    },
  })
  expect(events).toEqual(['seed'])
  expect(
    readFileSync(new URL('../src/bootstrap/daemonApplication.ts', import.meta.url), 'utf8'),
  ).not.toContain('runtimeLegacyConfiguration')
})
test('converter awaits the selected original raw receiver and does not parse fallback config', async () => {
  let release!: (text: string) => void
  const pending = new Promise<string>((resolve) => {
    release = resolve
  })
  const source = {
    readText() {
      expect(this).toBe(source)
      return pending
    },
  }
  const input = {
    root: { root: '/original-source' },
    source: {
      preflight: { tables: [{ table: 'runtimes' }], expectedAbsent: [] },
      reader: {
        async readChunk() {
          return { decodedRows: [], rows: [], lastKey: null }
        },
      },
    },
  } as unknown as BootUpgradeCaptureInput
  let settled = false
  const capture = runtimeConfigEnvironment(async () =>
    new TextEncoder().encode(await source.readText()),
  )
    .capture(input)
    .then((value) => {
      settled = true
      return value
    })
  await Promise.resolve()
  expect(settled).toBe(false)
  release('{"defaultModel":"selected-legacy-model"}')
  const result = await capture
  expect(JSON.stringify(result)).toContain('selected-legacy-model')
})
