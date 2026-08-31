import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import {
  classifyDatabaseMigrationFailure,
  createDatabaseMigrationRunner,
  type DatabaseMigrationAdmissionPort,
} from '@/modules/system-operations/application/databaseMigrationRunner'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import {
  encodeLogicalRow,
  type CanonicalLogicalRow,
} from '@/platform/persistence/logicalDatabaseArtifact'
import { readDatabaseGeneration } from '@/platform/persistence/generationStore'
import type { PostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import type {
  SqliteLogicalSource,
  SqliteLogicalSourceSnapshot,
} from '@/platform/persistence/sqliteLogicalSource'

const roots: string[] = []
const DIGEST = `sha256:${'a'.repeat(64)}`
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`

function column(name: string, codec: LogicalColumnContract['logicalCodec']): LogicalColumnContract {
  return {
    name,
    logicalCodec: codec,
    nullable: false,
    primary: name === 'id',
    hasDefault: false,
    defaultKind: 'none',
    defaultValue: null,
    providerDefault: { sqlite: null, postgresql: null },
    identity: false,
    uniqueName: null,
    enumValues: [],
    providerType: { sqlite: 'text', postgresql: 'text' },
  }
}

const TABLE: LogicalTableContract = {
  id: 'fixture_rows',
  schemaSymbol: 'fixtureRows',
  ownerContext: 'system-operations',
  disposition: 'KEEP',
  sourceTable: 'fixture_rows',
  providerTables: { sqlite: 'fixture_rows', postgresql: 'fixture_rows' },
  migrationKey: ['id'],
  columns: [column('id', 'text-identity'), column('value', 'text')],
  primaryKey: ['id'],
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  retention: { class: 'owner-managed-business', owner: 'system-operations', rule: 'fixture' },
  consumers: {
    productionReader: 'owner-required',
    productionWriter: 'owner-required-or-immutable',
    backgroundRecoveryDiagnostic: 'owner-reviewed',
    evidence: 'fixture',
  },
  rationale: 'fixture',
}

const CONTRACT: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 1,
  activeTableCount: 1,
  archiveOnlyTableCount: 0,
  tables: [TABLE],
  digest: DIGEST,
}

const SOURCE_ROWS: readonly CanonicalLogicalRow[] = [
  encodeLogicalRow(TABLE, { id: 'a', value: 'one' }),
  encodeLogicalRow(TABLE, { id: 'b', value: 'two' }),
]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(
  options: {
    failFirstChunk?: boolean
    firstLiveWriteAt?: number | null
    cancelAfterFirstChunk?: boolean
    failAt?: 'target-activation' | 'target-readiness' | 'admission-activation' | 'admission-open'
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-runner-'))
  roots.push(root)
  const migrationsDir = join(root, 'database-migrations')
  const store = createFileDatabaseMigrationStore({ root: migrationsDir })
  const controlPlane = createDatabaseMigrationControlPlane({
    store,
    newOperationId: () => 'dbm_operation_01',
    newOwnerId: () => 'dbo_owner_0001',
  })
  const sourceSnapshot: SqliteLogicalSourceSnapshot = {
    databaseFingerprint: 'sqlite:fixture',
    dataVersion: 1,
    pageCount: 1,
    pageSize: 4096,
    fileBytes: 4096,
    totalRows: 2,
    tableRows: { fixture_rows: 2 },
  }
  const source: SqliteLogicalSource = {
    provider: 'sqlite',
    path: join(root, 'db.sqlite'),
    preflight: async () => sourceSnapshot,
    assertUnchanged: async () => undefined,
    readChunk: async (_table, afterKey) => (afterKey === null ? SOURCE_ROWS : []),
    close: async () => undefined,
  }
  const calls: string[] = []
  let failFirstChunk = options.failFirstChunk === true
  const target: PostgresqlLogicalTarget = {
    provider: 'postgresql',
    operationId: 'dbm_operation_01',
    prepare: async () => {
      calls.push('target:prepare')
    },
    copyChunk: async (_table, chunk) => {
      calls.push(`target:chunk:${chunk.payload.chunkIndex}`)
      if (options.cancelAfterFirstChunk === true) {
        controlPlane.requestCancel('dbm_operation_01', 5)
      }
      if (failFirstChunk) {
        failFirstChunk = false
        throw Object.assign(new Error('temporary target outage'), { code: 'target-unreachable' })
      }
    },
    finalizeSchema: async () => {
      calls.push('target:verify')
    },
    prepareGeneration: async () => {
      calls.push('target:generation-prepared')
    },
    activateGeneration: async () => {
      calls.push('target:active')
      if (options.failAt === 'target-activation') {
        throw Object.assign(new Error('target activation failed'), {
          code: 'target-activation-failed',
        })
      }
    },
    firstLiveWriteAt: async () => options.firstLiveWriteAt ?? null,
    retireGenerationIfUnwritten: async () => {
      calls.push('target:retired')
      return options.firstLiveWriteAt == null
    },
    markFinalized: async () => {
      calls.push('target:finalized')
    },
    close: async () => undefined,
  }
  const runtime = {
    provider: 'postgresql',
    generationId: 'dbg_target_0001',
    health: async () => ({
      provider: 'postgresql',
      generationId: 'dbg_target_0001',
      ok: true,
      latencyMs: 1,
      databaseFingerprint: 'pg:fixture',
      serverVersion: 'PostgreSQL 17',
      errorCategory: null,
    }),
    readiness: async () => {
      if (options.failAt === 'target-readiness') {
        throw Object.assign(new Error('target readiness failed'), {
          code: 'target-readiness-failed',
        })
      }
      return {
        provider: 'postgresql',
        generationId: 'dbg_target_0001',
        ok: true as const,
        latencyMs: 1,
        databaseFingerprint: 'pg:fixture',
        serverVersion: 'PostgreSQL 17',
        errorCategory: null,
      }
    },
    acquireMigrationAdvisoryLock: async () => null,
    providerPool: () => {
      throw new Error('not used by runner fixture')
    },
    close: async () => undefined,
  } satisfies PostgresqlDatabaseRuntime
  const admission: DatabaseMigrationAdmissionPort = {
    freezeAndDrain: async () => {
      calls.push('admission:frozen')
    },
    reopenSqlite: async () => {
      calls.push('admission:sqlite')
    },
    activatePostgresql: async () => {
      calls.push('admission:postgresql')
      if (options.failAt === 'admission-activation') {
        throw Object.assign(new Error('admission activation failed'), {
          code: 'admission-activation-failed',
        })
      }
    },
    openPostgresqlAdmission: async () => {
      calls.push('admission:open')
      if (options.failAt === 'admission-open') {
        throw Object.assign(new Error('admission open failed'), {
          code: 'admission-open-failed',
        })
      }
    },
  }
  controlPlane.start({
    idempotencyKey: 'start-operation-01',
    sourceGenerationId: 'dbg_source_0001',
    sourceSchemaDigest: DIGEST,
    sourceDatabaseFingerprint: sourceSnapshot.databaseFingerprint,
    target: {
      provider: 'postgresql',
      urlEnv: 'RFC349_DATABASE_URL',
      poolMax: 4,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
    },
    tableCounts: { source: 1, active: 1, archiveOnly: 0 },
    ownerLeaseMs: 60_000,
    now: 1,
  })
  let clock = 10
  const runner = createDatabaseMigrationRunner({
    controlPlane,
    source,
    sourceSnapshot,
    target,
    targetRuntime: runtime,
    contract: CONTRACT,
    admission,
    safetyBackup: {
      create: async () => ({ path: join(root, 'backup.sqlite'), digest: PLAN_DIGEST }),
    },
    operationRoot: (operationId) => join(migrationsDir, operationId),
    generationPointerPath: join(root, 'database-generation.json'),
    chunkRows: 10,
    now: () => ++clock,
    preflightTarget: async () => ({ databaseFingerprint: 'pg:fixture' }),
  })
  return { root, migrationsDir, controlPlane, runner, calls }
}

describe('RFC-349 database migration runner', () => {
  test('classifies connection/socket failures as retryable target outages', () => {
    expect(
      classifyDatabaseMigrationFailure(
        Object.assign(new Error('redacted connection failure'), {
          code: 'FailedToOpenSocket',
        }),
      ),
    ).toEqual({
      category: 'target-unreachable',
      detailCode: 'failedtoopensocket',
      retryable: true,
    })
  })

  test('one action runs all safe phases, writes a verified pointer and leaves finalize explicit', async () => {
    const fixture = harness()
    const status = await fixture.runner.run('dbm_operation_01')
    expect(status.phase).toBe('accepting-writes')
    expect(status.progress).toMatchObject({ tablesCompleted: 1, rowsCopied: 2 })
    expect(fixture.calls).toEqual([
      'admission:frozen',
      'target:prepare',
      'target:chunk:0',
      'target:verify',
      'target:generation-prepared',
      'target:active',
      'admission:postgresql',
      'admission:open',
    ])
    expect(
      readDatabaseGeneration({
        pointerPath: join(fixture.root, 'database-generation.json'),
        migrationsDir: fixture.migrationsDir,
        expectedSchemaDigest: DIGEST,
      }).payload.provider,
    ).toBe('postgresql')
    expect(
      existsSync(join(fixture.migrationsDir, 'dbm_operation_01', 'logical-manifest.json')),
    ).toBe(true)
    expect((await fixture.runner.finalize('dbm_operation_01')).phase).toBe('finalized')
    expect(fixture.calls.at(-1)).toBe('target:finalized')
  })

  test('a transient chunk failure keeps SQLite live and explicit resume reuses the operation', async () => {
    const fixture = harness({ failFirstChunk: true })
    await expect(fixture.runner.run('dbm_operation_01')).rejects.toThrow('temporary target outage')
    expect(fixture.controlPlane.get('dbm_operation_01')).toMatchObject({
      phase: 'copying',
      failure: { category: 'target-unreachable', retryable: true },
    })
    expect(fixture.calls).toContain('admission:sqlite')

    const resumed = await fixture.runner.run('dbm_operation_01', { resumeFailed: true })
    expect(resumed.phase).toBe('accepting-writes')
    expect(fixture.calls.filter((call) => call === 'target:chunk:0')).toHaveLength(2)
  })

  test('a requested cancellation settles at a checkpoint without touching the target', async () => {
    const fixture = harness()
    fixture.controlPlane.requestCancel('dbm_operation_01', 2)
    const status = await fixture.runner.run('dbm_operation_01')
    expect(status.failure).toMatchObject({ category: 'cancelled', retryable: true })
    expect(fixture.calls).toEqual(['admission:sqlite'])
  })

  test('an in-flight cancellation stops at the next copied chunk boundary', async () => {
    const fixture = harness({ cancelAfterFirstChunk: true })
    const status = await fixture.runner.run('dbm_operation_01')
    expect(status.failure).toMatchObject({ category: 'cancelled', retryable: true })
    expect(status.progress).toMatchObject({ tablesCompleted: 0, rowsCopied: 0 })
    expect(fixture.calls).toEqual([
      'admission:frozen',
      'target:prepare',
      'target:chunk:0',
      'admission:sqlite',
    ])
  })

  for (const [failAt, failedPhase] of [
    ['target-activation', 'switched'],
    ['target-readiness', 'switched'],
    ['admission-activation', 'health-checked'],
    ['admission-open', 'accepting-writes'],
  ] as const) {
    test(`${failAt} failure before a live write atomically restores SQLite`, async () => {
      const fixture = harness({ failAt })
      await expect(fixture.runner.run('dbm_operation_01')).rejects.toThrow('failed')

      const status = fixture.controlPlane.get('dbm_operation_01')
      expect(status).toMatchObject({
        phase: failedPhase,
        failure: { phase: failedPhase },
        firstLiveWriteAt: null,
        rolledBackAt: expect.any(Number),
        rollback: { eligible: false, reason: 'operation-rolled-back' },
      })
      expect(fixture.calls).toContain('target:retired')
      expect(fixture.calls.at(-1)).toBe('admission:sqlite')
      expect(
        readDatabaseGeneration({
          pointerPath: join(fixture.root, 'database-generation.json'),
          migrationsDir: fixture.migrationsDir,
          expectedSchemaDigest: DIGEST,
        }).payload,
      ).toMatchObject({ provider: 'sqlite', generationId: 'dbg_source_0001' })
      expect(
        existsSync(join(fixture.migrationsDir, 'dbm_operation_01', 'rollback-receipt.json')),
      ).toBe(true)
    })
  }

  test('a target live write wins the recovery CAS and permanently blocks stale SQLite fallback', async () => {
    const fixture = harness({ failAt: 'target-readiness', firstLiveWriteAt: 99 })
    await expect(fixture.runner.run('dbm_operation_01')).rejects.toThrow('target readiness failed')

    expect(fixture.controlPlane.get('dbm_operation_01')).toMatchObject({
      phase: 'switched',
      failure: { phase: 'switched' },
      firstLiveWriteAt: 99,
      rolledBackAt: null,
      rollback: { eligible: false, reason: 'reverse-migration-required' },
    })
    expect(fixture.calls).not.toContain('admission:sqlite')
    expect(
      readDatabaseGeneration({
        pointerPath: join(fixture.root, 'database-generation.json'),
        migrationsDir: fixture.migrationsDir,
        expectedSchemaDigest: DIGEST,
      }).payload.provider,
    ).toBe('postgresql')
  })

  test('instant rollback retires an unwritten target and atomically restores SQLite', async () => {
    const fixture = harness()
    await fixture.runner.run('dbm_operation_01')
    const status = await fixture.runner.rollback('dbm_operation_01')
    expect(status).toMatchObject({
      phase: 'accepting-writes',
      rolledBackAt: expect.any(Number),
      rollback: { eligible: false, reason: 'operation-rolled-back' },
    })
    expect(fixture.calls.slice(-3)).toEqual([
      'admission:frozen',
      'target:retired',
      'admission:sqlite',
    ])
    expect(
      readDatabaseGeneration({
        pointerPath: join(fixture.root, 'database-generation.json'),
        migrationsDir: fixture.migrationsDir,
        expectedSchemaDigest: DIGEST,
      }).payload,
    ).toMatchObject({ provider: 'sqlite', generationId: 'dbg_source_0001' })
    expect(
      existsSync(join(fixture.migrationsDir, 'dbm_operation_01', 'rollback-receipt.json')),
    ).toBe(true)
    expect(await fixture.runner.rollback('dbm_operation_01')).toEqual(status)
    await expect(fixture.runner.finalize('dbm_operation_01')).rejects.toThrow(
      'rolled-back database migration',
    )
  })

  test('rollback loses the generation CAS after a live write and reopens PostgreSQL', async () => {
    const fixture = harness({ firstLiveWriteAt: 99 })
    await fixture.runner.run('dbm_operation_01')
    await expect(fixture.runner.rollback('dbm_operation_01')).rejects.toThrow(
      'reverse-migration-required',
    )
    expect(fixture.calls.at(-1)).toBe('admission:open')
    expect(
      readDatabaseGeneration({
        pointerPath: join(fixture.root, 'database-generation.json'),
        migrationsDir: fixture.migrationsDir,
        expectedSchemaDigest: DIGEST,
      }).payload.provider,
    ).toBe('postgresql')
  })
})
