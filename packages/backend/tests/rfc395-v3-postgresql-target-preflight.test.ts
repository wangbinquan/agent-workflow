// RFC-395 V3-F: independently provisioned PostgreSQL targets must be admissible before load.
import { expect, test } from 'bun:test'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import {
  preflightPostgresqlConversionTarget,
  classifyExternalTarget,
  postgresqlRuntimeFor,
  openPostgresqlScratch,
  migrationPostgresqlRuntime,
} from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { createExternalTargetPreflight } from '@/platform/persistence/migration/target/preflightAdapter'
import {
  availableDiskBytes,
  assertDiskBudget,
} from '@/platform/persistence/migration/freeze/diskBudget'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import { tmpdir } from 'node:os'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'

test('PostgreSQL profiles use explicit environment names and local capacity is measured', () => {
  expect(() =>
    postgresqlRuntimeFor({
      profileRef: 'postgresql://wrong',
      base: null,
      generationId: 'dbg_v3_test',
      env: {},
    }),
  ).toThrow('postgresql-profile-reference-invalid')
  expect(() =>
    postgresqlRuntimeFor({
      profileRef: 'env:V3_MISSING',
      base: null,
      generationId: 'dbg_v3_test',
      env: {},
    }),
  ).toThrow('V3_MISSING')
  expect(availableDiskBytes(tmpdir())).toBeGreaterThan(0)
  expect(assertDiskBudget({ path: tmpdir(), requiredBytes: 0 })).toBeGreaterThan(0)
  expect(() => assertDiskBudget({ path: tmpdir(), requiredBytes: -1 })).toThrow(
    'disk-budget-invalid',
  )
  expect(() =>
    assertDiskBudget({ path: tmpdir(), requiredBytes: Number.MAX_SAFE_INTEGER }),
  ).toThrow('disk-budget-insufficient')
})

describeV3Providers('RFC-395 V3 PostgreSQL target preflight', (h) => {
  if (h.targetProvider !== 'postgresql') return
  const input = async () => ({
    runtime: h.runtime,
    profileRef: 'env:V3_TARGET',
    sourceFingerprint: null,
    supportedMajors: [(await h.catalog()).postgresqlMajor],
  })
  test('real empty target reports fingerprint, locale, privilege and catalog major without writing schemas', async () => {
    const result = await preflightPostgresqlConversionTarget(await input())
    expect(result.blocks).toEqual([])
    expect(result).toMatchObject({
      provider: 'postgresql',
      empty: true,
      encoding: 'UTF8',
      canCreate: true,
      availableBytes: null,
    })
    const locale = (
      await h.runtime
        .providerPool()
        .unsafe('SELECT datcollate FROM pg_database WHERE datname=current_database()')
    )[0]!.datcollate
    expect(result.collation).toBe(String(locale))
    expect(result.fingerprint).toMatch(/^pg:/)
    const second = await preflightPostgresqlConversionTarget(await input())
    expect(second).toEqual(result)
  })
  for (const occupied of [
    'CREATE SCHEMA agent_workflow',
    'CREATE SCHEMA agent_workflow_meta',
    'CREATE TABLE public.foreign_table(id integer)',
  ])
    test(`non-empty target refused: ${occupied}`, async () => {
      await h.runtime.providerPool().unsafe(occupied)
      try {
        const result = await preflightPostgresqlConversionTarget(await input())
        expect(result.empty).toBe(false)
        expect(result.blocks.map((block) => block.code)).toContain('postgresql-target-not-empty')
      } finally {
        if (occupied.includes('public.foreign_table'))
          await h.runtime.providerPool().unsafe('DROP TABLE public.foreign_table')
      }
    })
  test('same physical database, unsupported server major and unknown/insufficient capacity are separate blocks', async () => {
    const base = await input()
    const sourceFingerprint = (await h.runtime.readiness()).databaseFingerprint
    const result = await preflightPostgresqlConversionTarget({
      ...base,
      sourceFingerprint,
      supportedMajors: [],
      requiredBytes: 1,
    })
    expect(result.blocks.map((block) => block.code)).toEqual([
      'postgresql-target-is-source',
      'postgresql-target-major-unsupported',
      'postgresql-target-capacity-unproven',
    ])
    expect(
      (
        await preflightPostgresqlConversionTarget({ ...base, availableBytes: 1, requiredBytes: 2 })
      ).blocks.map((block) => block.code),
    ).toEqual(['postgresql-target-capacity-insufficient'])
  })
  test('scratch ignores target catalog/capacity checks and closes its real connection', async () => {
    const base = await input()
    const scratch = await openPostgresqlScratch({
      ...base,
      supportedMajors: [],
      requiredBytes: Number.MAX_SAFE_INTEGER,
      availableBytes: 0,
      requireEmpty: true,
    })
    await scratch.close()
    expect((await h.runtime.health()).errorCategory).toBe('closed')
  })
  test('reserved migration sessions survive an online idle timeout and long statements, retaining lock_timeout', async () => {
    const url = new URL(process.env[resolvePostgresqlTestUrlEnv(process.env)!]!)
    url.pathname = String(
      (await h.runtime.providerPool().unsafe('SELECT current_database() AS name'))[0]!.name,
    )
    const online = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({
        provider: 'postgresql',
        urlEnv: 'V3_ONLINE_URL',
        poolMax: 3,
        statementTimeoutMs: 100,
        idleTimeoutMs: 1000,
      }),
      generationId: h.generationId,
      env: { V3_ONLINE_URL: url.toString() },
    })
    const initial = await online.providerPool().reserve()
    try {
      expect(
        (
          await initial.unsafe(
            "SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('lock_timeout') AS lock",
          )
        )[0],
      ).toMatchObject({ statement: '100ms', idle: '1s', lock: '100ms' })
    } finally {
      initial.release()
    }
    const connection = await migrationPostgresqlRuntime(online).providerPool().reserve()
    const target = openConversionTarget({ runtime: online })
    const targetPid = (await target.execute('SELECT pg_backend_pid() AS pid'))[0]!.pid
    const lease = await online.acquireMigrationAdvisoryLock('dbm_pgxb_idle_regression')
    expect(lease).not.toBeNull()
    try {
      await connection.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await Bun.sleep(2100)
      const facts = await connection.unsafe(
        "SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('lock_timeout') AS lock, pg_sleep(0.15)",
      )
      expect(facts[0]).toMatchObject({ statement: '0', idle: '0', lock: '100ms' })
      await connection.unsafe('ROLLBACK')
      await target.transaction(async (tx) => {
        const resumed = await tx.execute(
          "SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('lock_timeout') AS lock, pg_sleep(0.15)",
        )
        expect(resumed[0]).toMatchObject({
          pid: targetPid,
          statement: '0',
          idle: '0',
          lock: '100ms',
        })
      })
      // Migration overrides must not leak into the online pool or readiness.
      expect((await online.health()).ok).toBe(true)
      expect(
        (
          await online
            .providerPool()
            .unsafe(
              "SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('lock_timeout') AS lock",
            )
        )[0],
      ).toMatchObject({ statement: '100ms', idle: '1s', lock: '100ms' })
    } finally {
      await lease?.release()
      await target.close()
      connection.release()
      await online.close()
    }
  })
  test('adapter closes its real owned runtime and does not alter config', async () => {
    const adapter = createExternalTargetPreflight({
      runtime: () => h.runtime,
      catalogArtifacts: [await h.catalog()],
    })
    const result = await adapter.preflight({
      provider: 'postgresql',
      location: { kind: 'postgresql-target', profileRef: 'env:V3_TARGET' },
      sourceFingerprint: null,
    })
    expect(result.blocks).toEqual([])
    expect((await h.runtime.health()).errorCategory).toBe('closed')
    await expect(
      adapter.preflight({
        provider: 'sqlite',
        location: { kind: 'sqlite-file', relativePath: 'db.sqlite' },
        sourceFingerprint: null,
      }),
    ).rejects.toThrow('postgresql-target-location-required')
  })
  test('scratch refuses its physical source and closes the real runtime on failure', async () => {
    const base = await input()
    const sourceFingerprint = (await h.runtime.readiness()).databaseFingerprint
    await expect(
      openPostgresqlScratch({ ...base, sourceFingerprint, requireEmpty: false }),
    ).rejects.toThrow('postgresql-scratch-is-source')
    expect((await h.runtime.health()).errorCategory).toBe('closed')
  })
})

const facts = { version: 170000, encoding: 'UTF8', collation: 'C', has_c: true, can_create: true }
const requirements = {
  profileRef: 'env:V3_TARGET',
  sourceFingerprint: null,
  supportedMajors: [17],
  fingerprint: 'pg:fixture',
  occupied: 0,
}
test('target fact classification refuses missing CREATE, non-UTF8 and unavailable C collation', () => {
  const result = classifyExternalTarget({
    ...requirements,
    facts: {
      ...facts,
      encoding: 'LATIN1',
      collation: 'en_US.UTF8',
      has_c: false,
      can_create: false,
    },
  })
  expect(result.blocks.map((block) => block.code)).toEqual([
    'postgresql-target-encoding',
    'postgresql-target-collation',
    'postgresql-target-create-required',
  ])
})
test('target fact classification accepts a default locale when C is available', () => {
  expect(
    classifyExternalTarget({ ...requirements, facts: { ...facts, collation: 'en_US.utf8' } })
      .blocks,
  ).toEqual([])
})
