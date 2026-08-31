// RFC-349 T6 — doctor/storage maintenance dispatches to honest provider
// mechanisms. PostgreSQL observes its catalog/autovacuum and never receives a
// SQLite PRAGMA, WAL checkpoint, or VACUUM statement.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPostgresqlDatabaseOperationalAdapter,
  createSqliteDatabaseOperationalAdapter,
} from '@/platform/persistence/databaseOperationalAdapter'
import type { PostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'

const roots: string[] = []
const DIGEST = `sha256:${'d'.repeat(64)}`
const CONTRACT: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 0,
  activeTableCount: 0,
  archiveOnlyTableCount: 0,
  tables: [],
  digest: DIGEST,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rows(value: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

describe('RFC-349 database operational adapters', () => {
  test('SQLite owns quick_check and WAL checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-sqlite-operations-'))
    roots.push(root)
    const path = join(root, 'db.sqlite')
    const database = new Database(path)
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture (id TEXT PRIMARY KEY);')
    database.query('INSERT INTO fixture (id) VALUES (?)').run('one')
    database.close()

    const adapter = createSqliteDatabaseOperationalAdapter({
      path,
      generationId: 'dbg_sqlite_fixture_01',
    })
    const doctor = await adapter.doctor()
    expect(doctor).toMatchObject({ provider: 'sqlite', ok: true })
    expect(doctor.checks).toContainEqual({
      code: 'sqlite-quick-check',
      ok: true,
      message: 'quick_check ok',
    })
    expect(await adapter.runStorageMaintenance()).toMatchObject({
      provider: 'sqlite',
      mechanism: 'sqlite-wal-checkpoint',
      counters: { busy: 0 },
    })
  })

  test('PostgreSQL owns contract/catalog/autovacuum probes without SQLite SQL', async () => {
    const statements: string[] = []
    const pool = {
      unsafe(sql: string): SqlRows {
        statements.push(sql)
        if (sql.includes('pg_constraint')) {
          return rows([{ unvalidated_constraints: '0', invalid_indexes: '0' }])
        }
        if (sql.includes('pg_stat_user_tables')) {
          return rows([{ dead_rows: '12', autovacuum_runs: '3', autoanalyze_runs: '4' }])
        }
        throw new Error(`unexpected SQL: ${sql}`)
      },
    } as PostgresqlPool
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_postgresql_fixture_01',
      async health() {
        return {
          provider: 'postgresql' as const,
          generationId: 'dbg_postgresql_fixture_01',
          ok: true,
          latencyMs: 2.5,
          databaseFingerprint: 'pg:fixture',
          serverVersion: 'PostgreSQL fixture',
          errorCategory: null,
        }
      },
      providerPool() {
        return pool
      },
    } as PostgresqlDatabaseRuntime
    let closed = 0
    const source: PostgresqlLogicalSource = {
      provider: 'postgresql',
      generationId: runtime.generationId,
      async preflight() {
        return {
          databaseFingerprint: 'pg:logical',
          generationId: runtime.generationId,
          schemaDigest: CONTRACT.digest,
          totalRows: 42,
          tableRows: {},
        }
      },
      async assertUnchanged() {},
      async readChunk() {
        return []
      },
      async close() {
        closed += 1
      },
    }
    const adapter = createPostgresqlDatabaseOperationalAdapter({
      runtime,
      contract: CONTRACT,
      openLogicalSource: async () => source,
    })

    expect(await adapter.doctor()).toMatchObject({
      provider: 'postgresql',
      ok: true,
      metrics: { readinessMs: 2.5, activeRows: 42, invalidIndexes: 0 },
    })
    expect(await adapter.runStorageMaintenance()).toEqual({
      provider: 'postgresql',
      mechanism: 'postgresql-autovacuum-observation',
      counters: { deadRows: 12, autovacuumRuns: 3, autoanalyzeRuns: 4 },
    })
    expect(closed).toBe(1)
    expect(statements).toHaveLength(2)
    expect(statements.join('\n')).not.toMatch(/PRAGMA|wal_checkpoint|\bVACUUM\b/i)
  })
})
