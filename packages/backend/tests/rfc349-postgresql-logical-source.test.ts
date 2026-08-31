// RFC-349 T6 — PostgreSQL logical backup reads one repeatable, read-only
// snapshot, keeps the live generation fence observable, and never pretends the
// six archive-only tables are present in the active PostgreSQL schema.

import { describe, expect, test } from 'bun:test'
import {
  openPostgresqlLogicalSource,
  PostgresqlLogicalSourceError,
} from '@/platform/persistence/postgresqlLogicalSource'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const SCHEMA_DIGEST = `sha256:${'d'.repeat(64)}`
const GENERATION_ID = 'dbg_postgresql_live_01'

function column(
  name: string,
  logicalCodec: LogicalColumnContract['logicalCodec'],
): LogicalColumnContract {
  return {
    name,
    logicalCodec,
    nullable: false,
    primary: name === 'id',
    hasDefault: false,
    defaultKind: 'none',
    defaultValue: null,
    providerDefault: { sqlite: null, postgresql: null },
    identity: false,
    uniqueName: null,
    enumValues: [],
    providerType: {
      sqlite: logicalCodec === 'opaque-bytes' ? 'blob' : 'text',
      postgresql: logicalCodec === 'opaque-bytes' ? 'bytea' : 'text',
    },
  }
}

function table(id: string, disposition: LogicalTableContract['disposition']): LogicalTableContract {
  return {
    id,
    schemaSymbol: id,
    ownerContext: 'system-operations',
    disposition,
    sourceTable: id,
    providerTables:
      disposition === 'ARCHIVE_THEN_OMIT' ? { sqlite: id } : { sqlite: id, postgresql: id },
    migrationKey: ['id'],
    columns: [
      column('id', 'text-identity'),
      column('counter', 'integer'),
      column('enabled', 'boolean'),
      column('bytes', 'opaque-bytes'),
    ],
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
}

const ACTIVE = table('active_rows', 'KEEP')
const ARCHIVE = table('code_artifacts', 'ARCHIVE_THEN_OMIT')
const CONTRACT: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 2,
  activeTableCount: 1,
  archiveOnlyTableCount: 1,
  tables: [ACTIVE, ARCHIVE],
  digest: SCHEMA_DIGEST,
}

function rows(value: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

function fixture(applicationTables: readonly string[] = [ACTIVE.id]) {
  const queries: Array<{
    scope: 'snapshot' | 'live'
    sql: string
    parameters?: readonly unknown[]
  }> = []
  let releases = 0
  const answer = (
    scope: 'snapshot' | 'live',
    sql: string,
    parameters?: readonly unknown[],
  ): SqlRows => {
    queries.push({ scope, sql, parameters })
    if (sql.includes('information_schema.tables')) {
      return rows(applicationTables.map((table_name) => ({ table_name })))
    }
    if (sql.includes('schema_migrations')) return rows([{ contract_digest: CONTRACT.digest }])
    if (sql.includes('database_generations')) {
      return rows([{ state: 'active', contract_digest: CONTRACT.digest }])
    }
    if (sql.includes('count(*)')) return rows([{ count: '2' }])
    if (sql.startsWith('SELECT "id"')) {
      const all = [
        { id: 'row-1', counter: 9_007_199_254_740_993n, enabled: true, bytes: Buffer.from([1]) },
        { id: 'row-2', counter: 2n, enabled: false, bytes: Buffer.from([2]) },
      ]
      return rows(parameters?.[0] === 'row-1' ? all.slice(1) : all)
    }
    return rows([])
  }
  const connection: PostgresqlReservedConnection = {
    unsafe(sql, parameters) {
      return answer('snapshot', sql, parameters)
    },
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe(sql, parameters) {
      return answer('live', sql, parameters)
    },
    async close() {},
  }
  const runtime = {
    provider: 'postgresql',
    generationId: GENERATION_ID,
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      return {
        provider: 'postgresql' as const,
        generationId: GENERATION_ID,
        ok: true as const,
        latencyMs: 1,
        databaseFingerprint: 'pg:0123456789abcdef01234567',
        serverVersion: 'PostgreSQL 17',
        errorCategory: null,
      }
    },
    async acquireMigrationAdvisoryLock() {
      return null
    },
    providerPool() {
      return pool
    },
    async close() {},
  } as PostgresqlDatabaseRuntime
  return {
    runtime,
    queries,
    get releases() {
      return releases
    },
  }
}

describe('RFC-349 PostgreSQL logical source', () => {
  test('reads lossless active rows from one repeatable snapshot and checks the live fence', async () => {
    const fake = fixture()
    const source = await openPostgresqlLogicalSource({
      runtime: fake.runtime,
      generationId: GENERATION_ID,
      contract: CONTRACT,
    })
    const snapshot = await source.preflight()
    expect(snapshot).toMatchObject({
      generationId: GENERATION_ID,
      schemaDigest: CONTRACT.digest,
      totalRows: 2,
      tableRows: { active_rows: 2 },
    })
    expect(snapshot.databaseFingerprint).toMatch(/^pg:[a-f0-9]{24}$/)

    const first = await source.readChunk(ACTIVE, null, 10)
    expect(first).toHaveLength(2)
    expect(first[0]?.values[1]).toEqual({ type: 'integer', value: '9007199254740993' })
    expect(first[0]?.values[2]).toEqual({ type: 'boolean', value: true })
    expect(first[0]?.values[3]).toEqual({ type: 'bytes', value: 'AQ==' })
    expect(await source.readChunk(ACTIVE, first[0]!.key, 10)).toHaveLength(1)
    expect(fake.queries.find((query) => query.sql.includes('LIMIT $2'))?.parameters).toEqual([
      'row-1',
      10,
    ])

    await source.assertUnchanged(snapshot)
    expect(fake.queries.some((query) => query.scope === 'live')).toBe(true)
    await expect(source.readChunk(ARCHIVE, null, 10)).rejects.toThrow('archive-only')
    await source.close()
    expect(fake.releases).toBe(1)
    expect(fake.queries.at(-1)?.sql).toBe('ROLLBACK')
  })

  test('rejects schema drift before returning a backup snapshot', async () => {
    const fake = fixture(['unexpected_rows'])
    const source = await openPostgresqlLogicalSource({
      runtime: fake.runtime,
      generationId: GENERATION_ID,
      contract: CONTRACT,
    })
    await expect(source.preflight()).rejects.toBeInstanceOf(PostgresqlLogicalSourceError)
    await source.close()
    expect(fake.releases).toBe(1)
  })
})
