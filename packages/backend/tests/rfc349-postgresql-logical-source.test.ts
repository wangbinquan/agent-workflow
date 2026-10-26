// BF-D9: live epoch-2 native admission, drift refusal and lossless snapshot reads.
// RFC-349 T6 — PostgreSQL logical backup reads one repeatable, read-only
// snapshot, keeps the live generation fence observable, and refuses requests
// for archived tables absent from the active PostgreSQL schema.

import { withNativeTransactions } from './helpers/nativeTransactions'
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
import { logicalSchemaContract as CONTRACT } from '@/bootstrap/persistenceSchema'
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'
import { SchemaHistoryError } from '@/platform/persistence/schema/history/types'
import type { LogicalTableContract } from '@/platform/persistence/schemaContract'

const GENERATION_ID = 'dbg_postgresql_live_01'
const ACTIVE = CONTRACT.tables.find((table) => table.id === 'doc_versions')!
const ARCHIVE: LogicalTableContract = {
  ...ACTIVE,
  id: 'code_artifacts',
  disposition: 'ARCHIVE_THEN_OMIT',
  providerTables: { sqlite: 'code_artifacts' },
}
function documentRow(id: string, counter: bigint, enabled: boolean, byte: number) {
  return {
    ...Object.fromEntries(
      ACTIVE.columns.map((column) => [
        column.name,
        column.nullable
          ? null
          : (column.enumValues[0] ??
            (['integer', 'epoch-milliseconds'].includes(column.logicalCodec)
              ? 0n
              : column.logicalCodec === 'boolean'
                ? false
                : column.logicalCodec === 'opaque-bytes'
                  ? Buffer.alloc(0)
                  : column.logicalCodec.includes('json')
                    ? '{}'
                    : 'fixture')),
      ]),
    ),
    id,
    review_iteration: counter,
    selection_stale: enabled,
    content_inline_bytes: Buffer.from([byte]),
  }
}

function rows(value: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

function fixture(
  options: {
    applicationTables?: readonly string[]
    receiptMismatch?: boolean
    physicalDrift?: boolean
  } = {},
) {
  const applicationTables =
    options.applicationTables ?? CONTRACT.tables.map((table) => table.providerTables.postgresql!)
  const head = persistenceHead()
  const catalog = persistencePostgresqlCatalogs()[0]!
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
    if (sql.includes("table_name = 'schema_history'")) return rows([{ present: 1 }])
    if (sql.includes('FROM "agent_workflow_meta"."schema_history"'))
      return rows([
        {
          version: head.contract.version,
          contract_digest: options.receiptMismatch
            ? 'wrong-receipt'
            : head.contract.contract.digest,
          sqlite_plan_digest: head.sqlite.digest,
          postgresql_plan_digest: head.postgresql.digest,
          applied_at: 1,
          artifact_json: JSON.stringify(head),
        },
      ])
    if (sql.includes("current_setting('server_version_num')"))
      return rows([{ version: catalog.postgresqlMajor * 10000 }])
    if (sql.includes("SELECT 'relation' AS kind"))
      return rows(
        (options.physicalDrift ? catalog.catalog.slice(1) : catalog.catalog).map((entry) => ({
          ...entry,
        })),
      )
    if (sql.includes('information_schema.tables')) {
      return rows(applicationTables.map((table_name) => ({ table_name })))
    }
    if (sql.includes('"agent_workflow_meta"."generations"')) {
      return rows([{ state: 'active', contract_digest: head.contract.contract.digest }])
    }
    if (sql.includes('count(*)'))
      return rows([{ count: sql.includes('"doc_versions"') ? '2' : '0' }])
    if (sql.startsWith('SELECT') && sql.includes('FROM "agent_workflow"."doc_versions"')) {
      const all = [
        documentRow('row-1', 9_007_199_254_740_993n, true, 1),
        documentRow('row-2', 2n, false, 2),
      ]
      return rows(parameters?.[0] === 'row-1' ? all.slice(1) : all)
    }
    return rows([])
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe(sql, parameters) {
      return answer('snapshot', sql, parameters)
    },
    release() {
      releases += 1
    },
  })
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
      tableRows: Object.fromEntries(
        CONTRACT.tables.map((table) => [table.id, table.id === ACTIVE.id ? 2 : 0]),
      ),
    })
    expect(snapshot.databaseFingerprint).toMatch(/^pg:[a-f0-9]{24}$/)

    const first = await source.readChunk(ACTIVE, null, 10)
    expect(first).toHaveLength(2)
    expect(
      first[0]?.values[ACTIVE.columns.findIndex((column) => column.name === 'review_iteration')],
    ).toEqual({ type: 'integer', value: '9007199254740993' })
    expect(
      first[0]?.values[ACTIVE.columns.findIndex((column) => column.name === 'selection_stale')],
    ).toEqual({ type: 'boolean', value: true })
    expect(
      first[0]?.values[
        ACTIVE.columns.findIndex((column) => column.name === 'content_inline_bytes')
      ],
    ).toEqual({ type: 'bytes', value: 'AQ==' })
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
    const fake = fixture({ applicationTables: ['unexpected_rows'] })
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

for (const defect of ['receiptMismatch', 'physicalDrift'] as const)
  test(`BF-D9 native admission rejects ${defect} before a row census or snapshot is returned`, async () => {
    const fake = fixture({ [defect]: true })
    const source = await openPostgresqlLogicalSource({
      runtime: fake.runtime,
      generationId: GENERATION_ID,
      contract: CONTRACT,
    })
    try {
      await expect(source.preflight()).rejects.toBeInstanceOf(SchemaHistoryError)
      expect(fake.queries.some(({ sql }) => sql.includes('count(*)'))).toBeFalse()
      expect(fake.queries.some(({ sql }) => sql.includes('schema_history'))).toBeTrue()
      expect(
        fake.queries.some(({ sql }) =>
          /schema_migrations|schema_contract|database_generations/.test(sql),
        ),
      ).toBeFalse()
    } finally {
      await source.close()
    }
    expect(fake.releases).toBe(1)
  })
