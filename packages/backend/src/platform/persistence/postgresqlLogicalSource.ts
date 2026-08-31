// RFC-349 — bounded, provider-neutral logical reads from a live PostgreSQL
// generation. One reserved REPEATABLE READ / READ ONLY transaction provides a
// cross-table snapshot; a separate pool probe keeps the live generation fence
// observable while a long backup or reverse migration is running.

import { sha256Hex } from '@/util/hash'
import {
  decodeLogicalValue,
  encodeLogicalRow,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
} from './logicalDatabaseArtifact'
import type { PostgresqlDatabaseRuntime, PostgresqlReservedConnection } from './postgresqlRuntime'
import { POSTGRESQL_APPLICATION_SCHEMA, POSTGRESQL_METADATA_SCHEMA } from './postgresqlSchema'
import type { LogicalSchemaContract, LogicalTableContract } from './schemaContract'

export interface PostgresqlLogicalSourceSnapshot {
  readonly databaseFingerprint: string
  readonly generationId: string
  readonly schemaDigest: string
  readonly totalRows: number
  readonly tableRows: Readonly<Record<string, number>>
}

export interface PostgresqlLogicalSource {
  readonly provider: 'postgresql'
  readonly generationId: string
  preflight(): Promise<PostgresqlLogicalSourceSnapshot>
  assertUnchanged(snapshot: PostgresqlLogicalSourceSnapshot): Promise<void>
  readChunk(
    table: LogicalTableContract,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ): Promise<readonly CanonicalLogicalRow[]>
  close(): Promise<void>
}

export class PostgresqlLogicalSourceError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-source-schema'
      | 'postgresql-source-generation'
      | 'postgresql-source-read'
      | 'postgresql-source-closed',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlLogicalSourceError'
  }
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`
const applicationTable = (table: string): string =>
  `${quote(POSTGRESQL_APPLICATION_SCHEMA)}.${quote(table)}`
const metadataTable = (table: string): string =>
  `${quote(POSTGRESQL_METADATA_SCHEMA)}.${quote(table)}`

function providerValue(value: CanonicalLogicalValue): unknown {
  const decoded = decodeLogicalValue(value)
  return typeof decoded === 'number' && value.type === 'integer' ? BigInt(value.value) : decoded
}

function safeCount(value: unknown, table: string): number {
  let parsed: bigint
  try {
    parsed = BigInt(String(value))
  } catch {
    throw new PostgresqlLogicalSourceError(
      'postgresql-source-read',
      `PostgreSQL source returned an invalid row count for ${table}`,
    )
  }
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PostgresqlLogicalSourceError(
      'postgresql-source-read',
      `PostgreSQL source row count exceeds the logical artifact limit for ${table}`,
    )
  }
  return Number(parsed)
}

async function rollback(connection: PostgresqlReservedConnection): Promise<void> {
  try {
    await connection.unsafe('ROLLBACK')
  } catch {
    // Releasing the reserved connection is the final snapshot cleanup.
  }
}

export async function openPostgresqlLogicalSource(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly generationId: string
  readonly contract: LogicalSchemaContract
}): Promise<PostgresqlLogicalSource> {
  const health = await input.runtime.readiness()
  const connection = await input.runtime.providerPool().reserve()
  let closed = false
  let snapshot: PostgresqlLogicalSourceSnapshot | undefined
  try {
    await connection.unsafe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  } catch (error) {
    connection.release()
    throw error
  }

  const readGeneration = async (
    query: (
      sql: string,
      parameters?: readonly unknown[],
    ) => PromiseLike<readonly Record<string, unknown>[]>,
  ): Promise<void> => {
    const rows = await query(
      `SELECT state, contract_digest FROM ${metadataTable('database_generations')} WHERE generation_id = $1`,
      [input.generationId],
    )
    if (
      rows.length !== 1 ||
      rows[0]?.state !== 'active' ||
      rows[0]?.contract_digest !== input.contract.digest
    ) {
      throw new PostgresqlLogicalSourceError(
        'postgresql-source-generation',
        'PostgreSQL logical source generation is not the active contract generation',
      )
    }
  }

  const source: PostgresqlLogicalSource = {
    provider: 'postgresql',
    generationId: input.generationId,
    async preflight() {
      if (closed) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-closed',
          'PostgreSQL logical source is closed',
        )
      }
      if (snapshot !== undefined) return snapshot
      const tableRows = await connection.unsafe(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = $2 ORDER BY table_name',
        [POSTGRESQL_APPLICATION_SCHEMA, 'BASE TABLE'],
      )
      const actual = tableRows.map((row) => String(row.table_name)).sort()
      const expected = input.contract.tables
        .filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT')
        .map((table) => table.providerTables.postgresql!)
        .sort()
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-schema',
          'PostgreSQL logical source table roster does not match the active contract',
        )
      }
      const migrations = await connection.unsafe(
        `SELECT contract_digest FROM ${metadataTable('schema_migrations')} ORDER BY applied_at DESC LIMIT 1`,
      )
      if (migrations.length !== 1 || migrations[0]?.contract_digest !== input.contract.digest) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-schema',
          'PostgreSQL logical source migration history does not match the contract',
        )
      }
      await readGeneration(connection.unsafe.bind(connection))
      const counts: Record<string, number> = {}
      let totalRows = 0
      for (const table of input.contract.tables.filter(
        (candidate) => candidate.disposition !== 'ARCHIVE_THEN_OMIT',
      )) {
        const rows = await connection.unsafe(
          `SELECT count(*) AS count FROM ${applicationTable(table.providerTables.postgresql!)}`,
        )
        const count = safeCount(rows[0]?.count, table.id)
        counts[table.id] = count
        totalRows += count
        if (!Number.isSafeInteger(totalRows)) {
          throw new PostgresqlLogicalSourceError(
            'postgresql-source-read',
            'PostgreSQL logical source total row count exceeds the artifact limit',
          )
        }
      }
      const stable = JSON.stringify({
        databaseFingerprint: health.databaseFingerprint,
        generationId: input.generationId,
        schemaDigest: input.contract.digest,
        tableRows: counts,
      })
      snapshot = Object.freeze({
        databaseFingerprint: `pg:${sha256Hex(stable).slice(0, 24)}`,
        generationId: input.generationId,
        schemaDigest: input.contract.digest,
        totalRows,
        tableRows: Object.freeze(counts),
      })
      return snapshot
    },

    async assertUnchanged(expected) {
      if (closed) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-closed',
          'PostgreSQL logical source is closed',
        )
      }
      if (
        snapshot === undefined ||
        expected !== snapshot ||
        expected.generationId !== input.generationId ||
        expected.schemaDigest !== input.contract.digest
      ) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-generation',
          'PostgreSQL logical source snapshot identity differs',
        )
      }
      await readGeneration(input.runtime.providerPool().unsafe.bind(input.runtime.providerPool()))
    },

    async readChunk(table, afterKey, limit) {
      if (closed) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-closed',
          'PostgreSQL logical source is closed',
        )
      }
      if (
        table.disposition === 'ARCHIVE_THEN_OMIT' ||
        table.providerTables.postgresql === undefined
      ) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-schema',
          `PostgreSQL active source does not contain archive-only table ${table.id}`,
        )
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-read',
          'PostgreSQL logical chunk limit must be between 1 and 10000',
        )
      }
      if (afterKey !== null && afterKey.length !== table.migrationKey.length) {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-read',
          `PostgreSQL logical cursor shape does not match ${table.id}`,
        )
      }
      const parameters = afterKey?.map(providerValue) ?? []
      const where =
        afterKey === null
          ? ''
          : ` WHERE (${table.migrationKey.map(quote).join(', ')}) > (${afterKey
              .map((_, index) => `$${index + 1}`)
              .join(', ')})`
      parameters.push(limit)
      let rows: readonly Record<string, unknown>[]
      try {
        rows = await connection.unsafe(
          `SELECT ${table.columns.map((column) => quote(column.name)).join(', ')} FROM ${applicationTable(
            table.providerTables.postgresql,
          )}${where} ORDER BY ${table.migrationKey.map(quote).join(', ')} LIMIT $${parameters.length}`,
          parameters,
        )
      } catch {
        throw new PostgresqlLogicalSourceError(
          'postgresql-source-read',
          `PostgreSQL logical read failed for ${table.id}`,
        )
      }
      return rows.map((row) => encodeLogicalRow(table, row))
    },

    async close() {
      if (closed) return
      closed = true
      try {
        await rollback(connection)
      } finally {
        connection.release()
      }
    },
  }
  return Object.freeze(source)
}
