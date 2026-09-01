// RFC-349 hosted compiled PostgreSQL evidence exposed that daemon boot seeded
// built-in runtimes only after the SQLite branch had already been selected.
// This locks one provider-neutral ordered boot contract for every provider.

import { describe, expect, test } from 'bun:test'

import { initializeRuntimeRegistryBoot } from '@/platform/runtime-registry/composition'

function operations(events: string[]) {
  return {
    async seedBuiltinRuntimes() {
      events.push('seed')
    },
    async migrateConfigIntoBuiltins(config: {
      readonly opencodePath?: string | null
      readonly claudeCodePath?: string | null
    }) {
      events.push(`migrate:${config.opencodePath ?? 'default'}`)
    },
    async assertConfigDefaultsMigrated(configPath: string) {
      events.push(`assert:${configPath}`)
    },
  }
}

describe('RFC-349 provider-neutral runtime registry boot', () => {
  test('seeds, backfills and then runs the fail-loud migration guard', async () => {
    const events: string[] = []

    await initializeRuntimeRegistryBoot({
      operations: operations(events),
      config: { opencodePath: '/runtime/opencode' },
      configPath: '/app/config.json',
      onRecoverableFailure() {
        events.push('recoverable')
      },
    })

    expect(events).toEqual(['seed', 'migrate:/runtime/opencode', 'assert:/app/config.json'])
  })

  test('reports seed/backfill failures but never swallows the data-loss guard', async () => {
    const events: string[] = []
    const seedFailure = new Error('seed-failed')
    const guardFailure = new Error('guard-failed')
    const bootOperations = operations(events)
    bootOperations.seedBuiltinRuntimes = async () => {
      events.push('seed')
      throw seedFailure
    }
    bootOperations.assertConfigDefaultsMigrated = async (configPath: string) => {
      events.push(`assert:${configPath}`)
      throw guardFailure
    }

    await expect(
      initializeRuntimeRegistryBoot({
        operations: bootOperations,
        config: {},
        configPath: '/app/config.json',
        onRecoverableFailure(error) {
          expect(error).toBe(seedFailure)
          events.push('recoverable')
        },
      }),
    ).rejects.toBe(guardFailure)

    expect(events).toEqual(['seed', 'recoverable', 'assert:/app/config.json'])
  })
})
