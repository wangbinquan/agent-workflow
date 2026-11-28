// RFC-629: unit & regression tests for cold-start persistence head loading, SQLite baseline
// serialization/hydration & cross-isolate byte cache, rfc294Gates indexed/cycle-safe analysis,
// Argon2id dummy/fixture password hash caching, `stop --timeout` validation, and isolated
// PostgreSQL gate slot execution.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  readSchemaHeadFile,
  runSchemaHistoryCommand,
  schemaHistoryFiles,
} from '@/platform/persistence/schema/history/artifacts'
import {
  hydrateSqliteBaseline,
  serializeSqliteBaseline,
} from '@/platform/persistence/sqlite/baseline'
import {
  DUMMY_ARGON2ID_HASH,
  HASH_OPTS,
  verifyPassword,
  verifyPasswordDummy,
} from '@/auth/passwords'
import { materializeTestFixtureBytes } from './helpers/testFixtureCache'
import { fixturePasswordHash } from './helpers/userFixture'
import { sourceUnit } from './architecture/census'
import { capabilityForgeViolations, resolveImport } from './architecture/rfc294Gates'
import {
  assertNoSkippedRealPostgresql,
  buildPostgresqlSlotEnv,
  parseRunPostgresqlGateArgs,
  rewritePostgresqlDatabaseUrl,
  runPostgresqlGate,
} from '../../../scripts/ci/run-postgresql-gate'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const EPOCH2_HISTORY_DIR = resolve(REPO_ROOT, 'packages/backend/db/schema-history/epoch2')

describe('RFC-629 T1 — persistenceHead cold-start & schema-history --check completeness', () => {
  test('readSchemaHeadFile reads only the latest head version and zero PG catalogs when major is omitted', () => {
    const realFiles = schemaHistoryFiles(EPOCH2_HISTORY_DIR)
    const contractFiles = Object.keys(realFiles)
      .filter((name) => name.endsWith('.contract.json'))
      .sort()
    expect(contractFiles.length).toBeGreaterThanOrEqual(2)
    const headStem = contractFiles.at(-1)!.slice(0, -'.contract.json'.length)

    // Point every historical file AND every PG catalog to a nonexistent sentinel path.
    // readSchemaHeadFile without postgresqlMajor must never open any of them.
    const poisonedFiles: Record<string, string> = {}
    for (const [name, fullPath] of Object.entries(realFiles)) {
      const isHeadCore =
        name === `${headStem}.contract.json` ||
        name === `${headStem}.sqlite-plan.json` ||
        name === `${headStem}.postgresql-plan.json`
      poisonedFiles[name] = isHeadCore ? fullPath : join(EPOCH2_HISTORY_DIR, '__DO_NOT_READ__.json')
    }

    const head = readSchemaHeadFile(poisonedFiles, undefined, EPOCH2_META_TABLES)
    expect(head.contract.digest).toBe(persistenceHead().contract.digest)
    expect(head.postgresqlCatalog).toBeUndefined()

    // Requesting a specific PostgreSQL major reads ONLY the head's catalog for that major.
    const headPg17Name = `${headStem}.postgresql-17-catalog.json`
    expect(realFiles[headPg17Name]).toBeDefined()
    const headWithPg17 = readSchemaHeadFile(
      { ...poisonedFiles, [headPg17Name]: realFiles[headPg17Name]! },
      17,
      EPOCH2_META_TABLES,
    )
    expect(headWithPg17.postgresqlCatalog?.postgresqlMajor).toBe(17)
    expect(headWithPg17.contract.digest).toBe(head.contract.digest)
  })

  test('runSchemaHistoryCommand --check still verifies every historical PG catalog and fails closed on corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc629-schema-history-'))
    try {
      cpSync(EPOCH2_HISTORY_DIR, dir, { recursive: true })
      // Clean copy passes full --check.
      expect(
        runSchemaHistoryCommand(['--check'], {
          registry: persistenceSchema,
          directory: dir,
          metaTables: EPOCH2_META_TABLES,
        }),
      ).toEqual([])

      // Corrupt an older historical PG catalog (version 0000); --check must reject it.
      const files = schemaHistoryFiles(dir)
      const oldestCatalogName = Object.keys(files)
        .filter((name) => /^0000_.*\.postgresql-\d+-catalog\.json$/.test(name))
        .sort()[0]
      expect(oldestCatalogName).toBeDefined()
      const catalogPath = files[oldestCatalogName!]!
      const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as { digest: string }
      parsed.digest = '0'.repeat(64)
      writeFileSync(catalogPath, JSON.stringify(parsed))

      expect(() =>
        runSchemaHistoryCommand(['--check'], {
          registry: persistenceSchema,
          directory: dir,
          metaTables: EPOCH2_META_TABLES,
        }),
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RFC-629 T1 — SQLite baseline hydration & cross-isolate byte cache', () => {
  test('hydrateSqliteBaseline produces isolated databases with stamped generationId, timestamps, FK enforcement, and bootstrap mode', () => {
    const head = persistenceHead()
    const definition = { head, metaTables: EPOCH2_META_TABLES }
    const serialized = serializeSqliteBaseline(definition)
    expect(serialized.byteLength).toBeGreaterThan(10_000)

    const readyDb = hydrateSqliteBaseline(definition, serialized, {
      now: 123_456,
      generationId: 'dbg_ready_1',
      bootstrap: 'ready',
    })
    const requiredDb = hydrateSqliteBaseline(definition, serialized, {
      now: 789_012,
      generationId: 'dbg_required_2',
      bootstrap: 'required',
    })
    try {
      expect(
        readyDb.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys,
      ).toBe(1)
      expect(
        readyDb
          .query<
            { generation_id: string; created_at: number },
            []
          >('SELECT generation_id, created_at FROM aw_meta_generations')
          .get(),
      ).toEqual({ generation_id: 'dbg_ready_1', created_at: 123_456 })
      expect(
        readyDb
          .query<
            { bootstrap_completed_at: number | null },
            []
          >("SELECT bootstrap_completed_at FROM auth_login_policy WHERE id = 'global'")
          .get()?.bootstrap_completed_at,
      ).toBe(0)

      expect(
        requiredDb
          .query<
            { generation_id: string; created_at: number },
            []
          >('SELECT generation_id, created_at FROM aw_meta_generations')
          .get(),
      ).toEqual({ generation_id: 'dbg_required_2', created_at: 789_012 })
      expect(
        requiredDb
          .query<
            { bootstrap_completed_at: number | null },
            []
          >("SELECT bootstrap_completed_at FROM auth_login_policy WHERE id = 'global'")
          .get()?.bootstrap_completed_at,
      ).toBeNull()
    } finally {
      readyDb.close()
      requiredDb.close()
    }
  })

  test('materializeTestFixtureBytes supports disabled/miss/hit states and fails closed on on-disk corruption', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'aw-rfc629-bytes-cache-'))
    try {
      let builds = 0
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

      const disabled = await materializeTestFixtureBytes({
        kind: 'rfc629-unit',
        inputs: { version: 1 },
        cacheRoot: null,
        buildBytes: async () => {
          builds++
          return payload
        },
      })
      expect(disabled.cache).toBe('disabled')
      expect([...disabled.bytes]).toEqual([...payload])
      expect(builds).toBe(1)

      const first = await materializeTestFixtureBytes({
        kind: 'rfc629-unit',
        inputs: { version: 1 },
        cacheRoot,
        buildBytes: async () => {
          builds++
          return payload
        },
      })
      expect(first.cache).toBe('miss')
      expect([...first.bytes]).toEqual([...payload])
      expect(builds).toBe(2)

      const second = await materializeTestFixtureBytes({
        kind: 'rfc629-unit',
        inputs: { version: 1 },
        cacheRoot,
        buildBytes: async () => {
          builds++
          return new Uint8Array([9])
        },
      })
      expect(second.cache).toBe('hit')
      expect(second.key).toBe(first.key)
      expect([...second.bytes]).toEqual([...payload])
      expect(builds).toBe(2)

      // Tamper with the cached bytes (same size, wrong digest) -> must fail closed.
      writeFileSync(
        join(cacheRoot, `rfc629-unit-${first.key}`, 'artifact'),
        new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8]),
      )
      await expect(
        materializeTestFixtureBytes({
          kind: 'rfc629-unit',
          inputs: { version: 1 },
          cacheRoot,
          buildBytes: async () => payload,
        }),
      ).rejects.toThrow('digest mismatch')
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })
})

describe('RFC-629 T2 — rfc294Gates generics & cycles, Argon2id cache, and stop --timeout validation', () => {
  test('capabilityForgeViolations catches generic-nested Promise<OwnedTaskTx> and cyclic type aliases without false negatives', () => {
    const owner = sourceUnit(
      'packages/backend/src/modules/task-execution/domain/ownership.ts',
      `
        declare const brand: unique symbol
        export type OwnedTaskTx = Readonly<{ readonly [brand]: true; readonly taskId: string }>
      `,
    )
    const genericForger = sourceUnit(
      'packages/backend/src/modules/review/application/forger.ts',
      `
        import type { OwnedTaskTx } from '@/modules/task-execution/domain/ownership'
        type Wrap<T> = Promise<T>
        export async function forgeAsync(): Wrap<OwnedTaskTx> {
          return {} as unknown as OwnedTaskTx
        }
      `,
    )
    const cyclicForger = sourceUnit(
      'packages/backend/src/modules/review/application/cyclicForger.ts',
      `
        import type { OwnedTaskTx } from '@/modules/task-execution/domain/ownership'
        type A = B | OwnedTaskTx
        type B = A
        type NeutralX = NeutralY
        type NeutralY = NeutralX
        export function forgeCyclic(): B {
          return {} as unknown as OwnedTaskTx
        }
        export function benignCyclic(): NeutralX {
          return {} as unknown as NeutralX
        }
      `,
    )
    const violations = capabilityForgeViolations([owner, genericForger, cyclicForger])
    expect(violations.some((entry) => entry.includes('forger.ts'))).toBe(true)
    expect(violations.some((entry) => entry.includes('cyclicForger.ts'))).toBe(true)
    expect(violations.some((entry) => entry.includes('benignCyclic'))).toBe(false)
    expect(
      resolveImport(
        'packages/backend/src/modules/review/application/forger.ts',
        '@/modules/task-execution/domain/ownership',
        new Set([owner.path]),
      ),
    ).toBe(owner.path)
  })

  test('DUMMY_ARGON2ID_HASH matches OWASP HASH_OPTS and fixturePasswordHash caches valid inputs while preserving length validation', async () => {
    expect(DUMMY_ARGON2ID_HASH).toContain(
      `$argon2id$v=19$m=${HASH_OPTS.memoryCost},t=${HASH_OPTS.timeCost},p=1$`,
    )
    expect(await verifyPassword('aw-constant-time-dummy-secret', DUMMY_ARGON2ID_HASH)).toBe(true)
    expect(await verifyPasswordDummy('any-password')).toBe(false)

    await expect(fixturePasswordHash('short')).rejects.toThrow('password too short')
    const hash1 = await fixturePasswordHash('rfc629-fixture-pass-123')
    const hash2 = await fixturePasswordHash('rfc629-fixture-pass-123')
    expect(hash1).toBe(hash2)
    expect(await verifyPassword('rfc629-fixture-pass-123', hash1)).toBe(true)
  })

  test('CLI `stop --timeout` rejects missing, zero, negative, and non-integer values with exit code 2', () => {
    for (const args of [
      ['stop', '--timeout'],
      ['stop', '--timeout', '0'],
      ['stop', '--timeout', '-5'],
      ['stop', '--timeout', 'abc'],
      ['stop', '--timeout=1.5'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['run', resolve(REPO_ROOT, 'packages/backend/src/main.ts'), ...args],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 10_000,
        },
      )
      expect(result.status, args.join(' ')).toBe(2)
      expect(result.stderr, args.join(' ')).toContain('--timeout')
    }
  })
})

describe('RFC-629 T5 — run-postgresql-gate.ts isolated slot databases and fail-closed skip check', () => {
  test('argument parser, URL rewriter, slot env builder, and skip guard fail closed on invalid inputs', () => {
    expect(parseRunPostgresqlGateArgs([])).toEqual({ concurrency: 3, logOut: undefined })
    expect(parseRunPostgresqlGateArgs(['--concurrency=4', '--log-out', 'out.log'])).toEqual({
      concurrency: 4,
      logOut: 'out.log',
    })
    for (const bad of [
      ['--concurrency=0'],
      ['--concurrency=9'],
      ['--concurrency=abc'],
      ['--bad'],
    ]) {
      expect(() => parseRunPostgresqlGateArgs(bad), bad.join(' ')).toThrow()
    }

    expect(
      rewritePostgresqlDatabaseUrl(
        'postgresql://postgres:postgres@127.0.0.1:5432/rfc357?sslmode=disable',
        'aw_pg_gate_123_0',
      ),
    ).toBe('postgresql://postgres:postgres@127.0.0.1:5432/aw_pg_gate_123_0?sslmode=disable')
    expect(() =>
      rewritePostgresqlDatabaseUrl('http://127.0.0.1:5432/rfc357', 'aw_pg_gate_1_0'),
    ).toThrow('protocol')
    expect(() =>
      rewritePostgresqlDatabaseUrl(
        'postgresql://postgres:postgres@127.0.0.1:5432/rfc357',
        'BAD-NAME',
      ),
    ).toThrow('database name')

    const slotUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/aw_pg_gate_1_0'
    const envWithout359 = buildPostgresqlSlotEnv(
      { AW_TEST_POSTGRESQL_URL: 'old', RFC357_DATABASE_URL: 'old' },
      slotUrl,
    )
    expect(envWithout359.AW_TEST_POSTGRESQL_URL).toBe(slotUrl)
    expect(envWithout359.RFC357_DATABASE_URL).toBe(slotUrl)
    expect(envWithout359.RFC359_DATABASE_URL).toBeUndefined()

    const envWith359 = buildPostgresqlSlotEnv(
      { AW_TEST_POSTGRESQL_URL: 'old', RFC359_DATABASE_URL: 'old359' },
      slotUrl,
    )
    expect(envWith359.RFC359_DATABASE_URL).toBe(slotUrl)

    expect(() => assertNoSkippedRealPostgresql('35 pass\n0 fail\n')).not.toThrow()
    expect(() => assertNoSkippedRealPostgresql('(skip) real PostgreSQL parity suite\n')).toThrow(
      'skipped',
    )
  })

  test('runPostgresqlGate provisions per-slot DBs, preserves deterministic order, and cleans up all slots even on worker failure', async () => {
    const provisioned: string[] = []
    const cleaned: string[] = []
    const seenUrls = new Map<string, string>()

    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']
    const run = await runPostgresqlGate({
      files,
      baseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/rfc357',
      concurrency: 2,
      repoRoot: REPO_ROOT,
      baseEnv: { PATH: process.env.PATH },
      provisionSlot: async (_baseUrl, dbName) => {
        provisioned.push(dbName)
      },
      cleanupSlot: async (_baseUrl, dbName) => {
        cleaned.push(dbName)
      },
      runFile: async (file, env) => {
        seenUrls.set(file, env.AW_TEST_POSTGRESQL_URL!)
        return { exitCode: file === 'c.test.ts' ? 1 : 0, output: `ran ${file}` }
      },
    })

    expect(provisioned).toHaveLength(2)
    expect(cleaned).toEqual(provisioned)
    expect(run.results.map((r) => r.file)).toEqual(files)
    expect(run.failedFiles).toEqual(['c.test.ts'])
    for (const file of files) {
      expect(seenUrls.get(file)).toMatch(/\/aw_pg_gate_\d+_[01]$/)
    }

    // Even when runFile throws unexpectedly, every provisioned slot DB is still cleaned up.
    const provisionedOnThrow: string[] = []
    const cleanedOnThrow: string[] = []
    await expect(
      runPostgresqlGate({
        files: ['a.test.ts', 'b.test.ts'],
        baseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/rfc357',
        concurrency: 2,
        repoRoot: REPO_ROOT,
        provisionSlot: async (_baseUrl, dbName) => {
          provisionedOnThrow.push(dbName)
        },
        cleanupSlot: async (_baseUrl, dbName) => {
          cleanedOnThrow.push(dbName)
        },
        runFile: async () => {
          throw new Error('simulated worker crash')
        },
      }),
    ).rejects.toThrow('simulated worker crash')
    expect(cleanedOnThrow).toEqual(provisionedOnThrow)
  })
})
