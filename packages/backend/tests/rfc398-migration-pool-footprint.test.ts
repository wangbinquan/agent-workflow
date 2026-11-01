// RFC-398 — PostgreSQL connection footprint of the automatic upgrade.
//
// Why this exists: CI's PostgreSQL keeps the default max_connections=100, and the v0.18.19 L1
// matrix case failed there with 53300 "sorry, too many clients already" (CI run 41287820486,
// ubuntu shard 12) while a 400-connection local server hid it. Bun.SQL opens a pool's full `max`
// on first use, so every epoch-migration runtime (source, target, scratch, probe) took the online
// poolMax (16 by default) for each of its two pools although migration work holds one session at a
// time; the planner keeps several open together, about 60 server connections for the upgrade
// alone. A shared production server with other clients would refuse the upgrade the same way.
// These tests pin the caps and the real server footprint.
import { expect, test } from 'bun:test'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import {
  EPOCH_MIGRATION_POOL_MAX,
  postgresqlRuntimeFor,
} from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { probeConfiguredEpochSource } from '@/platform/persistence/epochSourceEvidence'
import type {
  PostgresqlPool,
  PostgresqlPoolOptions,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { describeRfc398Postgresql, rfc398Postgresql } from './helpers/rfc398Postgresql'

const env = { RFC398_POOL_URL: 'postgresql://db.example.test:5432/source' }

function capturePools(rows: Record<string, unknown>[] = []) {
  const options: PostgresqlPoolOptions[] = []
  let closed = 0
  const factory = (input: PostgresqlPoolOptions): PostgresqlPool => {
    options.push(input)
    return {
      async reserve() {
        throw new Error('This test must not reserve a PostgreSQL session')
      },
      unsafe() {
        const result = Promise.resolve(rows)
        return Object.assign(result, {
          values: async () => rows.map(Object.values),
        }) as unknown as SqlRows
      },
      async close() {
        closed += 1
      },
    }
  }
  return { options, factory, closed: () => closed }
}

test('epoch-migration runtimes cap both pools; a smaller configured poolMax is kept', async () => {
  for (const [poolMax, expected] of [
    [undefined, EPOCH_MIGRATION_POOL_MAX],
    [64, EPOCH_MIGRATION_POOL_MAX],
    [EPOCH_MIGRATION_POOL_MAX, EPOCH_MIGRATION_POOL_MAX],
    [2, 2],
  ] as const) {
    const capture = capturePools()
    const base =
      poolMax === undefined
        ? null
        : PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv: 'X', poolMax })
    const runtime = postgresqlRuntimeFor({
      profileRef: 'env:RFC398_POOL_URL',
      base,
      generationId: 'dbg_rfc398_pool',
      env,
      poolFactory: capture.factory,
    })
    try {
      // The online pool exists from construction; the migration wrapper creates its pool eagerly.
      expect(capture.options.map((o) => o.max)).toEqual([expected, expected])
    } finally {
      await runtime.close()
    }
  }
  // The default the cap guards against: an unconfigured installation's online poolMax.
  expect(
    PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv: 'X' }).poolMax,
  ).toBe(16)
})

test('the boot probe answers with a single-connection pool and closes it', async () => {
  for (const [rows, expected] of [
    [[{ found: 1 }], true],
    [[], false],
  ] as const) {
    const capture = capturePools([...rows])
    const answer = await probeConfiguredEpochSource({
      database: PostgresqlDatabaseConfigSchema.parse({
        provider: 'postgresql',
        urlEnv: 'RFC398_POOL_URL',
        poolMax: 32,
      }),
      env,
      poolFactory: capture.factory,
    })
    expect(answer).toBe(expected)
    expect(capture.options.length).toBeGreaterThan(0)
    expect(capture.options.every((o) => o.max === 1)).toBe(true)
    expect(capture.closed()).toBe(capture.options.length)
  }
})

describeRfc398Postgresql('RFC-398 migration pool footprint on a real server', () => {
  test('a migration runtime holds at most both capped pools, never the configured poolMax', async () => {
    const f = await rfc398Postgresql()
    try {
      const database = await f.create()
      const connections = async () =>
        Number(
          (
            await f.admin.unsafe(
              'SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
              [database.database],
            )
          )[0].n,
        )
      const runtime = postgresqlRuntimeFor({
        profileRef: 'env:RFC398_POOL_URL',
        base: null, // default configuration: poolMax 16
        generationId: 'dbg_rfc398_pool',
        env: { RFC398_POOL_URL: database.url },
      })
      try {
        await runtime.readiness() // online pool
        await runtime.providerPool().unsafe('SELECT 1') // migration pool
        const session = await runtime.providerPool().reserve()
        session.release()
        const open = await connections()
        expect(open).toBeGreaterThan(0)
        expect(open).toBeLessThanOrEqual(2 * EPOCH_MIGRATION_POOL_MAX)
      } finally {
        await runtime.close()
      }
    } finally {
      await f.close()
    }
  })
})
