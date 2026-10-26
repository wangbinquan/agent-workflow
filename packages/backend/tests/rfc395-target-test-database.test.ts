import { frozenTablesOf as frozenProviderTablesOf } from '@/platform/persistence/migration/epoch1/tables'
// RFC-395 II-b M-a: target fixtures and frozen migration inputs keep separate schema identities.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { nativeTableSets, persistenceSchema, schemaContract } from '@/bootstrap/persistenceSchema'
import { allowsLegacyDaemonTestAccess } from '@/db/client'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { decodeRawValue, rawExec, rawRows } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { compileInstallSeeds } from '@/platform/persistence/schema/seeds'
import { SchemaRowRuleError } from '@/platform/persistence/schema/rowRules'
import { EPOCH2_SENTINEL } from '@/platform/persistence/schema/history/markers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { createTestDb } from './helpers/testDatabase'
import type { CreateTestDbOptions, TestDatabase } from './helpers/testDatabaseTypes'
import {
  describeEachProvider,
  resolvePostgresqlTestUrlEnv,
  resolveTestProviders,
} from './helpers/eachProvider'
import { nativeQueryFixture } from './helpers/nativeQueryFixture'
import {
  createFrozenEpoch1Db,
  freezeAt,
  FROZEN_MIGRATIONS,
  frozenTablesOf,
  frozenTableSets,
  readFrozenMigrationFiles,
} from './migration-freeze'

const NOW = 1_792_800_000_000
const tableRows = (db: PersistenceDb, table: string) =>
  rawRows(db, sql.raw(`SELECT * FROM ${table}`))
const audit = {
  id: 'test-audit',
  targetUserId: '__system__',
  actorKind: 'system' as const,
  operationId: 'test-operation',
  beforeRole: 'guest' as const,
  afterRole: 'user' as const,
  addedPermissionsJson: '[]',
  removedPermissionsJson: '[]',
  accessRevision: 1,
  createdAt: NOW,
}

for (const provider of resolveTestProviders(process.env)) {
  describe(`RFC-395 target test database [${provider}]`, () => {
    let fixture: TestDatabase
    const options = (): CreateTestDbOptions =>
      provider === 'sqlite'
        ? { provider, now: NOW }
        : {
            provider,
            now: NOW,
            urlEnv: resolvePostgresqlTestUrlEnv(process.env) ?? 'AW_TEST_POSTGRESQL_URL',
          }
    beforeEach(async () => {
      fixture = await createTestDb(options())
    }, 60_000)
    afterEach(async () => {
      await fixture?.close()
    }, 90_000)

    test('installs the compiled target head, exactly 21 migration-meta tables and the old-binary sentinel', async () => {
      expect(fixture.provider).toBe(provider)
      expect(fixture.baseline).toMatchObject({
        schemaEpoch: 2,
        seeds: 'install-only',
        binding: 'epoch-2',
      })
      expect(fixture.baseline.head.contract.contract.digest).toBe(schemaContract.digest)
      expect(EPOCH2_META_TABLES.map((table) => table.name)).toEqual([
        ...fixture.baseline.metaTables,
      ])
      expect(fixture.baseline.metaTables).toHaveLength(21)
      const meta = await rawRows<{ name: string }>(
        fixture.db,
        sql.raw(
          provider === 'sqlite'
            ? "SELECT substr(name, 9) AS name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'aw_meta_*' ORDER BY name"
            : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'agent_workflow_meta' AND table_name <> 'schema_migrations' ORDER BY table_name",
        ),
      )
      expect(meta.map((row) => row.name)).toEqual([...fixture.baseline.metaTables].sort())
      const history = await tableRows(fixture.db, metaTableName(provider, 'schema_history'))
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ contract_digest: schemaContract.digest })
      expect(JSON.parse(String(history[0]!.artifact_json))).toEqual(fixture.baseline.head)
      expect(Number(history[0]!.applied_at)).toBe(NOW)
      const sentinel = await tableRows(
        fixture.db,
        provider === 'sqlite'
          ? '__drizzle_migrations'
          : '"agent_workflow_meta"."schema_migrations"',
      )
      expect(sentinel).toHaveLength(1)
      expect(sentinel[0]![provider === 'sqlite' ? 'hash' : 'baseline_id']).toBe(EPOCH2_SENTINEL)
      const physical = await rawRows<{ name: string }>(
        fixture.db,
        sql.raw(
          provider === 'sqlite'
            ? "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'aw_meta_*' AND name <> '__drizzle_migrations' ORDER BY name"
            : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'agent_workflow' ORDER BY table_name",
        ),
      )
      expect(physical.map((row) => row.name)).toEqual(
        persistenceSchema.tables.map((table) => table.id).sort(),
      )
    })

    test('uses install-only seed values and preserves the bootstrap-required option', async () => {
      expect(allowsLegacyDaemonTestAccess(fixture.db)).toBe(true)
      const { authLoginPolicy } = tablesOf(fixture.db)
      expect((await fixture.db.select().from(authLoginPolicy))[0]!.bootstrapCompletedAt).toBe(0)
      const fresh = await createTestDb({ ...options(), bootstrap: 'required' })
      try {
        expect(allowsLegacyDaemonTestAccess(fresh.db)).toBe(false)
        const expected = compileInstallSeeds(persistenceSchema, {
          path: 'test-baseline',
          installedAt: NOW,
        }).rows
        for (const name of new Set(expected.map((seed) => seed.table))) {
          const definition = persistenceSchema.tables.find((table) => table.id === name)!
          const rows = await tableRows(
            fresh.db,
            provider === 'sqlite' ? `"${name}"` : `"agent_workflow"."${name}"`,
          )
          const decoded = rows.map((row) =>
            Object.fromEntries(
              Object.values(definition.columns).map((column) => [
                column.name,
                decodeRawValue(column.codec, row[column.name], column.name),
              ]),
            ),
          )
          const wanted = expected.filter((seed) => seed.table === name).map((seed) => seed.values)
          expect(decoded).toHaveLength(wanted.length)
          expect(decoded).toEqual(expect.arrayContaining(wanted))
        }
        await fresh.reset()
        expect(
          (await fresh.db.select().from(tablesOf(fresh.db).authLoginPolicy))[0]!
            .bootstrapCompletedAt,
        ).toBeNull()
      } finally {
        await fresh.close()
      }
    })

    test('binds the single accessor in committed, nested and snapshot transactions', async () => {
      expect(tablesOf(fixture.db)).toBe(nativeTableSets[provider])
      expect(fixture.session).toBe(databaseSessionFor(fixture.db))
      await fixture.session.transaction(async (tx) => {
        expect(engineOf(tx)).toBe(fixture.capabilities)
        expect(tablesOf(tx)).toBe(tablesOf(fixture.db))
        expect(tablesOf(tx)).toBe(nativeTableSets[provider])
        const { tasks, taskExecutionGenerations } = tablesOf(tx)
        await tx
          .insert(tasks)
          .values({ id: 'target-task', name: 'target', status: 'pending', startedAt: NOW })
        await tx
          .insert(taskExecutionGenerations)
          .values({ taskId: 'target-task', generationSeq: 0, cause: 'created', createdAt: NOW })
        await fixture.session.transaction(async (nested) => {
          expect(nested).toBe(tx)
        })
      })
      const rows = await fixture.session.snapshotRead(async (tx) => {
        expect(tablesOf(tx)).toBe(tablesOf(fixture.db))
        return await tx.select().from(tablesOf(tx).taskExecutionGenerations)
      })
      expect(rows).toMatchObject([{ taskId: 'target-task', generationSeq: 0 }])
    })

    test('rolls back target writes and carries bindings through a retried transaction', async () => {
      let attempts = 0
      await fixture.session.serializable(async (tx) => {
        attempts++
        expect(tablesOf(tx)).toBe(tablesOf(fixture.db))
        expect(tablesOf(tx)).toBe(nativeTableSets[provider])
        await tx
          .insert(tablesOf(tx).tasks)
          .values({ id: 'retry-task', name: 'retry', status: 'pending', startedAt: NOW })
        if (attempts === 1)
          throw Object.assign(new Error('fixture contention'), {
            code: provider === 'sqlite' ? 'SQLITE_BUSY' : '40001',
          })
      })
      expect(attempts).toBe(2)
      await expect(
        fixture.session.transaction(async (tx) => {
          await tx
            .insert(tablesOf(tx).tasks)
            .values({ id: 'rolled-back', name: 'rollback', status: 'pending', startedAt: NOW })
          throw new Error('rollback marker')
        }),
      ).rejects.toThrow('rollback marker')
      expect(
        (await fixture.db.select().from(tablesOf(fixture.db).tasks)).map((row) => row.id),
      ).toEqual(['retry-task'])
    })

    test('translates row-rule failures on root and retried transaction handles', async () => {
      const { userAccessAudit } = tablesOf(fixture.db)
      await fixture.db.insert(userAccessAudit).values(audit)
      await expect(
        (async () => {
          await fixture.db.delete(userAccessAudit).where(eq(userAccessAudit.id, audit.id))
        })(),
      ).rejects.toBeInstanceOf(SchemaRowRuleError)
      let attempts = 0
      await expect(
        fixture.session.serializable(async (tx) => {
          attempts++
          if (attempts === 1)
            throw Object.assign(new Error('fixture contention'), {
              code: provider === 'sqlite' ? 'SQLITE_BUSY' : '40001',
            })
          const table = tablesOf(tx).userAccessAudit
          await tx.update(table).set({ afterRole: 'admin' }).where(eq(table.id, audit.id))
        }),
      ).rejects.toMatchObject({
        code: 'user_access_audit_append_only',
        tableId: 'user_access_audit',
      })
      expect(attempts).toBe(2)
      expect((await fixture.db.select().from(userAccessAudit))[0]!.afterRole).toBe('user')
    })

    test('reset removes business, append-only and meta state and reinstalls identical head/seeds', async () => {
      const head = fixture.baseline.head
      const before = await tableRows(fixture.db, metaTableName(provider, 'generations'))
      await fixture.db.insert(tablesOf(fixture.db).userAccessAudit).values(audit)
      await fixture.db.delete(tablesOf(fixture.db).authLoginPolicy)
      await rawExec(
        fixture.db,
        sql.raw(
          `INSERT INTO ${metaTableName(provider, 'schema_transform_receipts')} (receipt_id, edge_digest, applied_at) VALUES ('test-transform', 'digest', 1)`,
        ),
      )
      await rawExec(
        fixture.db,
        sql.raw(`UPDATE ${metaTableName(provider, 'first_write')} SET first_live_write_at = 1`),
      )
      await fixture.reset()
      expect(fixture.baseline.head).toBe(head)
      expect(await fixture.db.select().from(tablesOf(fixture.db).userAccessAudit)).toEqual([])
      expect(
        await tableRows(fixture.db, metaTableName(provider, 'schema_transform_receipts')),
      ).toEqual([])
      expect(await tableRows(fixture.db, metaTableName(provider, 'generations'))).toEqual(before)
      expect(
        (await tableRows(fixture.db, metaTableName(provider, 'first_write')))[0]!
          .first_live_write_at,
      ).toBeNull()
      expect(
        (await fixture.db.select().from(tablesOf(fixture.db).authLoginPolicy))[0]!
          .bootstrapCompletedAt,
      ).toBe(0)
    })

    test('close is idempotent and prevents reset and further queries', async () => {
      await fixture.close()
      await fixture.close()
      await expect(fixture.reset()).rejects.toThrow('Test database is closed')
      await expect(
        (async () => {
          await fixture.db.select().from(tablesOf(fixture.db).users)
        })(),
      ).rejects.toBeDefined()
    })
  })
}

describeEachProvider('RFC-395 eachProvider target baseline', (harness) => {
  test('uses target tables and records the actual installed-engine queries', async () => {
    const { tasks } = tablesOf(harness.db)
    expect(Object.hasOwn(tasks, 'workflowId')).toBe(false)
    const recording = harness.recordStatements()
    try {
      await harness.session.transaction(async (tx) => {
        await tx
          .insert(tablesOf(tx).tasks)
          .values({ id: 'harness-task', name: 'harness', status: 'pending', startedAt: NOW })
      })
      expect((await harness.db.select().from(tasks)).map((row) => row.id)).toEqual(['harness-task'])
      expect(recording.selects().length).toBeGreaterThan(0)
    } finally {
      recording.stop()
    }
    const receipts = metaTableName(harness.capabilities.provider, 'schema_transform_receipts')
    await rawExec(
      harness.db,
      sql.raw(
        `INSERT INTO ${receipts} (receipt_id, edge_digest, applied_at) VALUES ('harness-reset', 'digest', 1)`,
      ),
    )
    await harness.restoreFixture()
    expect(await harness.db.select().from(tablesOf(harness.db).tasks)).toEqual([])
    expect(await tableRows(harness.db, receipts)).toEqual([])
  })
})

describeEachProvider(
  'RFC-395 explicit frozen source fixture',
  (harness) => {
    test('binds the frozen source on both providers, including transaction handles', async () => {
      const expected = frozenTableSets[harness.capabilities.provider]
      expect(frozenProviderTablesOf(harness.db)).toBe(expected)
      expect(() => tablesOf(harness.db)).toThrow(
        'Native persistence handle has no epoch-2 table set',
      )
      await harness.session.transaction(async (tx) => {
        expect(frozenProviderTablesOf(tx)).toBe(expected)
        expect(() => tablesOf(tx)).toThrow('Native persistence handle has no epoch-2 table set')
        expect(await rawRows(tx, sql`SELECT id FROM users WHERE id = '__system__'`)).toEqual([
          { id: '__system__' },
        ])
      })
      await harness.restoreFixture()
      expect(frozenProviderTablesOf(harness.db)).toBe(expected)
      expect(await rawRows(harness.db, sql`SELECT id FROM users WHERE id = '__system__'`)).toEqual([
        { id: '__system__' },
      ])
    })
  },
  { sqliteMigrationsFolder: FROZEN_MIGRATIONS },
)

describe('RFC-395 fixture boundaries', () => {
  test('default factory is SQLite and a missing PostgreSQL URL is an error', async () => {
    const fixture = await createTestDb()
    try {
      expect(fixture.provider).toBe('sqlite')
    } finally {
      await fixture.close()
    }
    await expect(
      createTestDb({
        provider: 'postgresql',
        urlEnv: `AW_MISSING_TEST_URL_${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow('PostgreSQL test database URL is missing:')
  })

  test('SQLite file fixtures retain the installed head after close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-target-test-file-'))
    const filename = join(root, 'database.sqlite')
    try {
      const fixture = await createTestDb({ provider: 'sqlite', filename, now: NOW })
      const digest = fixture.baseline.head.contract.contract.digest
      await fixture.close()
      const raw = new Database(filename, { readonly: true })
      try {
        expect(raw.query('SELECT contract_digest FROM aw_meta_schema_history').all()).toEqual([
          { contract_digest: digest },
        ])
      } finally {
        raw.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('compile-only native query fixtures expose target storage on both providers', () => {
    for (const provider of ['sqlite', 'postgresql'] as const) {
      const fixture = nativeQueryFixture(provider)
      expect(fixture.tables).toBe(tablesOf(fixture.db))
      expect(fixture.tables).toBe(nativeTableSets[provider])
      expect(Object.hasOwn(fixture.tables.tasks, 'workflowId')).toBe(false)
    }
  })

  test('frozen source head and prefix hashes include the U-3 plain-text permission contract', async () => {
    const history = await loadFrozenEpoch1History()
    expect(history.postgresql.head.contract.digest).toBe(frozenEpoch1Contract.digest)
    expect(history.sqlite).toEqual(readFrozenMigrationFiles(FROZEN_MIGRATIONS))
    const grants = frozenEpoch1Contract.tables.find(
      (table) => table.id === 'user_permission_grants',
    )!
    expect(grants.columns.find((column) => column.name === 'permission')!.logicalCodec).toBe(
      'text-identity',
    )
    const db = createFrozenEpoch1Db()
    try {
      expect(Object.hasOwn(frozenTablesOf(db).tasks, 'workflowId')).toBe(true)
      expect(() => tablesOf(db)).toThrow('Native persistence handle has no epoch-2 table set')
      expect(db.$client.query('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({
        count: history.sqlite.length,
      })
    } finally {
      db.$client.close()
    }
    const prefix = freezeAt(1)
    try {
      expect(readFrozenMigrationFiles(prefix)).toHaveLength(2)
      const path = join(prefix, `${history.sqliteTags[0]}.sql`)
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n-- changed fixture\n`)
      expect(() => readFrozenMigrationFiles(prefix)).toThrow(
        'Historical fixture changed frozen migration bytes:',
      )
    } finally {
      rmSync(prefix, { recursive: true, force: true })
    }
    expect(() => freezeAt(history.sqlite.length)).toThrow(RangeError)
  })
})
