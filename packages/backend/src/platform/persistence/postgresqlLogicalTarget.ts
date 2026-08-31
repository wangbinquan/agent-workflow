// RFC-349 — operation-scoped PostgreSQL logical-copy target. A single reserved
// session owns the advisory lock for the entire prepare/copy/verify sequence;
// each chunk and its idempotency receipt commit in one target transaction.

import {
  canonicalSchemaJson,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from './schemaContract'
import {
  createLogicalTableChunk,
  decodeLogicalRow,
  encodeLogicalRow,
  type LogicalTableChunk,
} from './logicalDatabaseArtifact'
import type { PostgresqlDatabaseRuntime, PostgresqlReservedConnection } from './postgresqlRuntime'
import {
  POSTGRESQL_APPLICATION_SCHEMA,
  POSTGRESQL_BASELINE_ID,
  POSTGRESQL_METADATA_SCHEMA,
  type PostgresqlSchemaPlan,
} from './postgresqlSchema'

export class PostgresqlLogicalTargetError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-target-lock-held'
      | 'postgresql-target-not-empty'
      | 'postgresql-target-operation-mismatch'
      | 'postgresql-target-chunk-conflict'
      | 'postgresql-target-chunk-mismatch'
      | 'postgresql-target-schema-finalize'
      | 'postgresql-target-generation-fence',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlLogicalTargetError'
  }
}

export interface PostgresqlLogicalTarget {
  readonly provider: 'postgresql'
  readonly operationId: string
  prepare(now: number): Promise<void>
  copyChunk(table: LogicalTableContract, chunk: LogicalTableChunk, now: number): Promise<void>
  finalizeSchema(now: number): Promise<void>
  prepareGeneration(input: {
    readonly generationId: string
    readonly sourceGenerationId: string
  }): Promise<void>
  activateGeneration(generationId: string, now: number): Promise<void>
  firstLiveWriteAt(generationId: string): Promise<number | null>
  retireGenerationIfUnwritten(generationId: string): Promise<boolean>
  markFinalized(now: number): Promise<void>
  close(): Promise<void>
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`
const applicationTable = (table: string): string =>
  `${quote(POSTGRESQL_APPLICATION_SCHEMA)}.${quote(table)}`
const metadataTable = (table: string): string =>
  `${quote(POSTGRESQL_METADATA_SCHEMA)}.${quote(table)}`

function keyJson(row: LogicalTableChunk['payload']['rows'][number] | undefined): string | null {
  return row === undefined ? null : canonicalSchemaJson(row.key).trimEnd()
}

function keyIdentity(row: LogicalTableChunk['payload']['rows'][number]): string {
  return JSON.stringify(row.key)
}

async function rollback(connection: PostgresqlReservedConnection): Promise<void> {
  try {
    await connection.unsafe('ROLLBACK')
  } catch {
    // The original error remains authoritative.
  }
}

async function rowsForChunk(
  connection: PostgresqlReservedConnection,
  table: LogicalTableContract,
  chunk: LogicalTableChunk,
): Promise<readonly Record<string, unknown>[]> {
  if (chunk.payload.rows.length === 0) return []
  const parameters: unknown[] = []
  const predicates = chunk.payload.rows.map((row) => {
    const pieces = table.migrationKey.map((column, keyIndex) => {
      const logicalValue = row.key[keyIndex]!
      parameters.push(
        logicalValue.type === 'boolean'
          ? logicalValue.value
          : logicalValue.type === 'integer'
            ? BigInt(logicalValue.value)
            : logicalValue.type === 'real'
              ? Number(logicalValue.value)
              : logicalValue.type === 'text'
                ? logicalValue.value
                : logicalValue.type === 'bytes'
                  ? Buffer.from(logicalValue.value, 'base64')
                  : null,
      )
      return `${quote(column)} = $${parameters.length}`
    })
    return `(${pieces.join(' AND ')})`
  })
  const columns = table.columns.map((column) => quote(column.name)).join(', ')
  return await connection.unsafe(
    `SELECT ${columns} FROM ${applicationTable(table.id)} WHERE ${predicates.join(' OR ')}`,
    parameters,
  )
}

function assertTargetChunk(
  contract: LogicalSchemaContract,
  table: LogicalTableContract,
  source: LogicalTableChunk,
  targetRows: readonly Record<string, unknown>[],
): void {
  const byKey = new Map(
    targetRows.map((row) => {
      const encoded = encodeLogicalRow(table, row)
      return [keyIdentity(encoded), encoded] as const
    }),
  )
  const ordered = source.payload.rows.map((row) => byKey.get(keyIdentity(row)))
  if (ordered.some((row) => row === undefined) || byKey.size !== source.payload.rows.length) {
    throw new PostgresqlLogicalTargetError(
      'postgresql-target-chunk-mismatch',
      `PostgreSQL target row/key coverage differs for ${table.id} chunk ${source.payload.chunkIndex}`,
    )
  }
  const projected = createLogicalTableChunk({
    operationId: source.payload.operationId,
    contract,
    table,
    chunkIndex: source.payload.chunkIndex,
    rows: ordered as LogicalTableChunk['payload']['rows'],
  })
  if (projected.digest !== source.digest) {
    throw new PostgresqlLogicalTargetError(
      'postgresql-target-chunk-mismatch',
      `PostgreSQL target digest differs for ${table.id} chunk ${source.payload.chunkIndex}`,
    )
  }
}

export async function openPostgresqlLogicalTarget(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly operationId: string
  readonly sourceGenerationId: string
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
}): Promise<PostgresqlLogicalTarget> {
  if (input.plan.contractDigest !== input.contract.digest) {
    throw new PostgresqlLogicalTargetError(
      'postgresql-target-operation-mismatch',
      'PostgreSQL target plan and logical contract differ',
    )
  }
  const connection = await input.runtime.providerPool().reserve()
  const lockKey = `rfc349-copy:${input.operationId}`
  const lockRows = await connection.unsafe(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    [lockKey],
  )
  if (lockRows[0]?.acquired !== true) {
    connection.release()
    throw new PostgresqlLogicalTargetError(
      'postgresql-target-lock-held',
      'another process owns the PostgreSQL logical migration target',
    )
  }
  let closed = false

  const target: PostgresqlLogicalTarget = {
    provider: 'postgresql',
    operationId: input.operationId,
    async prepare(now) {
      const applicationTables = await connection.unsafe(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = $2 ORDER BY table_name',
        [POSTGRESQL_APPLICATION_SCHEMA, 'BASE TABLE'],
      )
      const metadataTables = await connection.unsafe(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = $2 ORDER BY table_name',
        [POSTGRESQL_METADATA_SCHEMA, 'BASE TABLE'],
      )
      const empty = applicationTables.length === 0 && metadataTables.length === 0
      if (!empty) {
        const operationTableExists = metadataTables.some(
          (row) => row.table_name === 'logical_copy_operations',
        )
        if (!operationTableExists) {
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-not-empty',
            'PostgreSQL target is not empty and is not an RFC-349 resumable target',
          )
        }
        const operations = await connection.unsafe(
          `SELECT source_generation_id, contract_digest, plan_digest FROM ${metadataTable('logical_copy_operations')} WHERE operation_id = $1`,
          [input.operationId],
        )
        const operation = operations[0]
        if (
          operation?.source_generation_id !== input.sourceGenerationId ||
          operation.contract_digest !== input.contract.digest ||
          operation.plan_digest !== input.plan.digest
        ) {
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-operation-mismatch',
            'PostgreSQL target belongs to another source, operation or schema plan',
          )
        }
        const actual = applicationTables.map((row) => String(row.table_name)).sort()
        const expected = input.contract.tables
          .filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT')
          .map((table) => table.id)
          .sort()
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-operation-mismatch',
            'PostgreSQL resumable target table roster differs from the logical contract',
          )
        }
        return
      }

      await connection.unsafe('BEGIN')
      try {
        for (const statement of input.plan.statements.filter(
          (statement) =>
            statement.kind === 'bootstrap' ||
            statement.kind === 'table' ||
            statement.kind === 'metadata',
        )) {
          await connection.unsafe(statement.sql)
        }
        await connection.unsafe(
          `INSERT INTO ${metadataTable('logical_copy_operations')} (operation_id, source_generation_id, contract_digest, plan_digest, stage, created_at, updated_at) VALUES ($1, $2, $3, $4, 'prepared', $5, $5)`,
          [
            input.operationId,
            input.sourceGenerationId,
            input.contract.digest,
            input.plan.digest,
            now,
          ],
        )
        await connection.unsafe('COMMIT')
      } catch (error) {
        await rollback(connection)
        throw error
      }
    },

    async copyChunk(table, chunk, now) {
      if (
        table.disposition === 'ARCHIVE_THEN_OMIT' ||
        chunk.payload.operationId !== input.operationId ||
        chunk.payload.table !== table.id ||
        chunk.payload.schemaDigest !== input.contract.digest
      ) {
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-operation-mismatch',
          `PostgreSQL target rejected an invalid chunk for ${table.id}`,
        )
      }
      await connection.unsafe('BEGIN')
      try {
        const existingRows = await connection.unsafe(
          `SELECT chunk_digest, row_count FROM ${metadataTable('logical_copy_chunks')} WHERE operation_id = $1 AND table_id = $2 AND chunk_index = $3`,
          [input.operationId, table.id, chunk.payload.chunkIndex],
        )
        const existing = existingRows[0]
        if (existing !== undefined) {
          if (
            existing.chunk_digest !== chunk.digest ||
            BigInt(String(existing.row_count)) !== BigInt(chunk.payload.rows.length)
          ) {
            throw new PostgresqlLogicalTargetError(
              'postgresql-target-chunk-conflict',
              `PostgreSQL target has a conflicting receipt for ${table.id} chunk ${chunk.payload.chunkIndex}`,
            )
          }
          assertTargetChunk(
            input.contract,
            table,
            chunk,
            await rowsForChunk(connection, table, chunk),
          )
          await connection.unsafe('COMMIT')
          return
        }

        if (chunk.payload.rows.length > 0) {
          const parameters: unknown[] = []
          const valueGroups = chunk.payload.rows.map((row) => {
            const decoded = decodeLogicalRow(table, row)
            return `(${table.columns
              .map((column) => {
                parameters.push(decoded[column.name])
                return `$${parameters.length}`
              })
              .join(', ')})`
          })
          await connection.unsafe(
            `INSERT INTO ${applicationTable(table.id)} (${table.columns.map((column) => quote(column.name)).join(', ')}) VALUES ${valueGroups.join(', ')} ON CONFLICT (${table.primaryKey.map(quote).join(', ')}) DO NOTHING`,
            parameters,
          )
        }
        assertTargetChunk(
          input.contract,
          table,
          chunk,
          await rowsForChunk(connection, table, chunk),
        )
        await connection.unsafe(
          `INSERT INTO ${metadataTable('logical_copy_chunks')} (operation_id, table_id, chunk_index, chunk_digest, row_count, first_key_json, last_key_json, committed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.operationId,
            table.id,
            chunk.payload.chunkIndex,
            chunk.digest,
            chunk.payload.rows.length,
            keyJson(chunk.payload.rows[0]),
            keyJson(chunk.payload.rows.at(-1)),
            now,
          ],
        )
        await connection.unsafe(
          `UPDATE ${metadataTable('logical_copy_operations')} SET stage = 'copying', updated_at = $2 WHERE operation_id = $1`,
          [input.operationId, now],
        )
        await connection.unsafe('COMMIT')
      } catch (error) {
        await rollback(connection)
        throw error
      }
    },

    async finalizeSchema(now) {
      await connection.unsafe('BEGIN')
      try {
        for (const table of input.contract.tables.filter(
          (candidate) => candidate.disposition !== 'ARCHIVE_THEN_OMIT',
        )) {
          for (const column of table.columns.filter((candidate) => candidate.identity)) {
            await connection.unsafe(
              `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX(${quote(column.name)}), 1), MAX(${quote(column.name)}) IS NOT NULL) FROM ${applicationTable(table.id)}`,
              [`${POSTGRESQL_APPLICATION_SCHEMA}.${table.id}`, column.name],
            )
          }
        }
        for (const statement of input.plan.statements.filter(
          (statement) => statement.kind === 'index' || statement.kind === 'constraint',
        )) {
          await connection.unsafe(statement.sql)
        }
        await connection.unsafe(
          `INSERT INTO ${metadataTable('schema_migrations')} (baseline_id, contract_digest, plan_digest, applied_at) VALUES ($1, $2, $3, $4)`,
          [POSTGRESQL_BASELINE_ID, input.contract.digest, input.plan.digest, now],
        )
        await connection.unsafe(
          `UPDATE ${metadataTable('logical_copy_operations')} SET stage = 'verified', updated_at = $2 WHERE operation_id = $1`,
          [input.operationId, now],
        )
        await connection.unsafe('COMMIT')
      } catch {
        await rollback(connection)
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-schema-finalize',
          'PostgreSQL target constraints, indexes or identities failed final verification',
        )
      }
    },

    async prepareGeneration(generation) {
      await connection.unsafe(
        `INSERT INTO ${metadataTable('database_generations')} (generation_id, operation_id, source_generation_id, contract_digest, state, activated_at, first_live_write_at) VALUES ($1, $2, $3, $4, 'prepared', NULL, NULL) ON CONFLICT (generation_id) DO NOTHING`,
        [
          generation.generationId,
          input.operationId,
          generation.sourceGenerationId,
          input.contract.digest,
        ],
      )
      const rows = await connection.unsafe(
        `SELECT operation_id, source_generation_id, contract_digest, state FROM ${metadataTable('database_generations')} WHERE generation_id = $1`,
        [generation.generationId],
      )
      const row = rows[0]
      if (
        row?.operation_id !== input.operationId ||
        row.source_generation_id !== generation.sourceGenerationId ||
        row.contract_digest !== input.contract.digest ||
        !['prepared', 'active'].includes(String(row.state))
      ) {
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-generation-fence',
          'PostgreSQL target generation identity conflicts with the cutover operation',
        )
      }
    },

    async activateGeneration(generationId, now) {
      const rows = await connection.unsafe(
        `UPDATE ${metadataTable('database_generations')} SET state = 'active', activated_at = COALESCE(activated_at, $2) WHERE generation_id = $1 AND operation_id = $3 AND state IN ('prepared', 'active') RETURNING generation_id`,
        [generationId, now, input.operationId],
      )
      if (rows.length !== 1) {
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-generation-fence',
          'PostgreSQL target generation could not be activated',
        )
      }
      await connection.unsafe(
        `UPDATE ${metadataTable('logical_copy_operations')} SET stage = 'activated', updated_at = $2 WHERE operation_id = $1`,
        [input.operationId, now],
      )
    },

    async firstLiveWriteAt(generationId) {
      const rows = await connection.unsafe(
        `SELECT state, first_live_write_at FROM ${metadataTable('database_generations')} WHERE generation_id = $1 AND operation_id = $2`,
        [generationId, input.operationId],
      )
      if (rows.length !== 1 || !['active', 'retired'].includes(String(rows[0]?.state))) {
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-generation-fence',
          'PostgreSQL target active/retired generation marker is missing',
        )
      }
      const value = rows[0]?.first_live_write_at
      return value === null || value === undefined ? null : Number(value)
    },

    async retireGenerationIfUnwritten(generationId) {
      const retired = await connection.unsafe(
        `UPDATE ${metadataTable('database_generations')} SET state = 'retired' WHERE generation_id = $1 AND operation_id = $2 AND state = 'active' AND first_live_write_at IS NULL RETURNING generation_id`,
        [generationId, input.operationId],
      )
      if (retired.length === 1) return true
      const rows = await connection.unsafe(
        `SELECT state, first_live_write_at FROM ${metadataTable('database_generations')} WHERE generation_id = $1 AND operation_id = $2`,
        [generationId, input.operationId],
      )
      return rows[0]?.state === 'retired' && rows[0]?.first_live_write_at == null
    },

    async markFinalized(now) {
      await connection.unsafe(
        `UPDATE ${metadataTable('logical_copy_operations')} SET stage = 'finalized', updated_at = $2 WHERE operation_id = $1 AND stage IN ('activated', 'finalized')`,
        [input.operationId, now],
      )
    },

    async close() {
      if (closed) return
      closed = true
      try {
        await connection.unsafe('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      } finally {
        connection.release()
      }
    },
  }
  return Object.freeze(target)
}
