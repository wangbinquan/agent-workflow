import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import {
  withNativeTransaction,
  nativeTransactionHandle,
} from '@/platform/persistence/nativeTransaction'
import { restoreEpochMetadata, type EpochMetadataSnapshot } from './schema/history/metadataSnapshot'
import {
  canonicalSchemaJson,
  digestSchemaContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from './schemaContract'
import {
  decodeLogicalRow,
  encodeLogicalRow,
  type LogicalTableChunk,
} from './logicalDatabaseArtifact'
import { createPostgresqlCapabilities } from './capabilities'
import type { PostgresqlDatabaseRuntime } from './postgresqlRuntime'
import type { PostgresqlSchemaPlan } from './postgresqlSchema'
import type { LogicalTargetTableVerification } from './logicalDatabaseRestore'
import { schemaHistoryRuntime, runtimeHistoryAdmission } from './schema/history/runtime'
import { installConversionHistoryHead } from './schema/history/apply'
import { postgresqlHistoryConnection } from './schema/history/connection'
import { admitHistory } from './schema/history/admission'
import { initializeFirstWriteMarker, firstLiveWriteAt } from './schema/history/markers'
import {
  PostgresqlLogicalTargetInvariantError,
  verifyPostgresqlLogicalTargetBusinessInvariants,
  verifyPostgresqlLogicalTargetIdentitySequences,
} from './postgresqlLogicalTargetInvariants'
export class PostgresqlLogicalTargetError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-target-lock-held'
      | 'postgresql-target-not-empty'
      | 'postgresql-target-operation-mismatch'
      | 'postgresql-target-chunk-conflict'
      | 'postgresql-target-chunk-mismatch'
      | 'postgresql-target-schema-finalize'
      | 'postgresql-target-verification'
      // The violated invariant rides in the CODE, not only in the message: the
      // durable failure record is a closed shape whose only free field is a
      // `detailCode` slug (same idiom as `SqliteLogicalSourceMutationCode`), so a
      // bare `postgresql-target-verification` leaves the operator nothing to act
      // on.
      | `postgresql-target-verification.${string}`
      | 'postgresql-target-generation-fence',
    message: string,
    // Carrying the provider failure lets `classifyDatabaseMigrationFailure` walk
    // the chain and read the real PostgreSQL code instead of guessing from ours.
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'PostgresqlLogicalTargetError'
  }
}

export interface PostgresqlLogicalTarget {
  readonly provider: 'postgresql'
  readonly operationId: string
  restoreMetadata?(snapshot: EpochMetadataSnapshot): Promise<void>
  prepare(now: number): Promise<void>
  copyChunk(table: LogicalTableContract, chunk: LogicalTableChunk, now: number): Promise<void>
  finalizeSchema(
    now: number,
    expectedTables: readonly LogicalTargetTableVerification[],
  ): Promise<void>
  prepareGeneration(input: {
    readonly generationId: string
    readonly sourceGenerationId: string
  }): Promise<void>
  activateGeneration(generationId: string, now: number): Promise<void>
  assertReady(generationId: string): Promise<void>
  firstLiveWriteAt(generationId: string): Promise<number | null>
  retireGenerationIfUnwritten(generationId: string): Promise<boolean>
  markFinalized(now: number): Promise<void>
  close(): Promise<void>
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const tableName = (table: string) => `"agent_workflow".${quote(table)}`
const meta = (table: string) => `"agent_workflow_meta".${quote(table)}`

export async function openPostgresqlLogicalTarget(input: {
  runtime: PostgresqlDatabaseRuntime
  operationId: string
  sourceGenerationId: string
  headContract: LogicalSchemaContract
  contract: LogicalSchemaContract
  plan: PostgresqlSchemaPlan
  verifyMigrationHistory?: (plan: PostgresqlSchemaPlan) => Promise<void>
}): Promise<PostgresqlLogicalTarget> {
  const binding = schemaHistoryRuntime()
  const head = binding.head()
  if (
    input.contract.digest !== input.headContract.digest ||
    input.plan.digest !== head.postgresql.digest
  )
    throw new PostgresqlLogicalTargetError(
      'postgresql-target-operation-mismatch',
      'copy requires the live epoch-2 contract and native head',
    )
  await input.verifyMigrationHistory?.(input.plan)
  const connection = await input.runtime.providerPool().reserve()
  // Offline copying has its own lifetime; online request budgets cannot cut off
  // a long index build or an idle interval between streamed chunks.
  try {
    await connection.unsafe(
      "SELECT set_config('statement_timeout', '0', false), set_config('idle_in_transaction_session_timeout', '0', false)",
    )
  } catch (error) {
    connection.release()
    throw error
  }
  const lockKey = `epoch2-copy:${input.operationId}`
  const lock = await connection.unsafe(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    [lockKey],
  )
  if (lock[0]?.acquired !== true) {
    connection.release()
    throw new PostgresqlLogicalTargetError('postgresql-target-lock-held', 'copy target is busy')
  }
  const run = input.operationId
  let closed = false
  const tx = async <T>(body: () => Promise<T>): Promise<T> => {
    await connection.unsafe('BEGIN')
    try {
      const result = await body()
      await connection.unsafe('COMMIT')
      return result
    } catch (error) {
      try {
        await connection.unsafe('ROLLBACK')
      } catch {
        /* A disconnected session is already aborted; retain the original fault. */
      }
      throw error
    }
  }
  let installedSourceGenerationId: string | undefined
  type State = {
    installedSourceGenerationId?: string
    sourceGenerationId: string
    contractDigest: string
    planDigest: string
    stage: 'prepared' | 'verified' | 'activated' | 'finalized'
  }
  const state = async (): Promise<State | null> => {
    const rows = await connection.unsafe(
      `SELECT record_json, record_digest FROM ${meta('migration_records')} WHERE run_id=$1 AND unit_id='epoch2-copy' AND ordinal=0`,
      [run],
    )
    if (!rows[0]) return null
    const value = JSON.parse(String(rows[0].record_json)) as State
    if (
      digestSchemaContract(value) !== rows[0].record_digest ||
      value.sourceGenerationId !== input.sourceGenerationId ||
      value.contractDigest !== input.contract.digest ||
      value.planDigest !== input.plan.digest
    )
      throw new PostgresqlLogicalTargetError(
        'postgresql-target-operation-mismatch',
        'copy binding changed',
      )
    return value
  }
  const setState = async (stage: State['stage']) => {
    const lineage = installedSourceGenerationId ?? (await state())?.installedSourceGenerationId
    const value: State = {
      ...(lineage ? { installedSourceGenerationId: lineage } : {}),
      sourceGenerationId: input.sourceGenerationId,
      contractDigest: input.contract.digest,
      planDigest: input.plan.digest,
      stage,
    }
    await connection.unsafe(
      `INSERT INTO ${meta('migration_records')} (run_id,unit_id,ordinal,kind,table_name,record_json,record_digest) VALUES ($1,'epoch2-copy',0,'source-metadata',NULL,$2,$3) ON CONFLICT (run_id,unit_id,ordinal) DO UPDATE SET record_json=EXCLUDED.record_json,record_digest=EXCLUDED.record_digest`,
      [run, canonicalSchemaJson(value), digestSchemaContract(value)],
    )
  }
  // A chunk is written and read back in batches, never row by row: every statement is a network
  // round trip. Per-row statements took the weekly provider move from 255-359 s (epoch 1) to 708 s
  // and then past its 30 min deadline (postgresql-evidence runs 40893688180, 40909853901). Batches
  // follow the engine's multi-row budget for the columns each row binds.
  const batches = <T>(rows: readonly T[], columnsPerRow: number): T[][] => {
    const size = createPostgresqlCapabilities().batchInsertMax(columnsPerRow)
    const result: T[][] = []
    for (let offset = 0; offset < rows.length; offset += size)
      result.push(rows.slice(offset, offset + size))
    return result
  }
  const insertRows = async (table: LogicalTableContract, chunk: LogicalTableChunk) => {
    for (const batch of batches(chunk.payload.rows, table.columns.length)) {
      const parameters: unknown[] = []
      const values = batch.map((row) => {
        const decoded = decodeLogicalRow(table, row)
        return `(${table.columns
          .map((c) => {
            parameters.push(decoded[c.name])
            return `$${parameters.length}`
          })
          .join(',')})`
      })
      await connection.unsafe(
        `INSERT INTO ${tableName(table.providerTables.postgresql!)} (${table.columns.map((c) => quote(c.name)).join(',')}) VALUES ${values.join(',')}`,
        parameters,
      )
    }
  }
  const assertRows = async (table: LogicalTableContract, chunk: LogicalTableChunk) => {
    const mismatch = () =>
      new PostgresqlLogicalTargetError(
        'postgresql-target-chunk-mismatch',
        `${table.id}/${chunk.payload.chunkIndex}`,
      )
    const expected = new Map(
      chunk.payload.rows.map((row) => [canonicalSchemaJson(row.key), canonicalSchemaJson(row)]),
    )
    const matched = new Set<string>()
    for (const batch of batches(chunk.payload.rows, table.migrationKey.length)) {
      const parameters: unknown[] = []
      const predicates = batch.map((row) => {
        const decoded = decodeLogicalRow(table, row)
        return `(${table.migrationKey
          .map((key) => {
            parameters.push(decoded[key])
            return `${quote(key)}=$${parameters.length}`
          })
          .join(' AND ')})`
      })
      const rows = await connection.unsafe(
        `SELECT ${table.columns.map((c) => quote(c.name)).join(',')} FROM ${tableName(table.providerTables.postgresql!)} WHERE ${predicates.join(' OR ')}`,
        parameters,
      )
      // Each source row must come back exactly once and unchanged.
      for (const target of rows) {
        const encoded = encodeLogicalRow(table, target)
        const key = canonicalSchemaJson(encoded.key)
        if (matched.has(key) || expected.get(key) !== canonicalSchemaJson(encoded)) throw mismatch()
        matched.add(key)
      }
    }
    if (matched.size !== chunk.payload.rows.length) throw mismatch()
  }
  const target: PostgresqlLogicalTarget = {
    provider: 'postgresql',
    operationId: input.operationId,
    async restoreMetadata(snapshot) {
      const active =
        snapshot.payload.tables
          .find((table) => table.name === 'generations')
          ?.rows.filter((row) => row.state === 'active') ?? []
      if (active.length !== 1) throw new Error('epoch2-source-generation-missing')
      installedSourceGenerationId = String(active[0]!.generation_id)
      await tx(async () => {
        await restoreEpochMetadata(postgresqlHistoryConnection(connection), snapshot)
        await setState((await state())?.stage ?? 'prepared')
      })
    },
    async prepare(now) {
      const tables = await connection.unsafe(
        "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN ('agent_workflow','agent_workflow_meta') AND table_type='BASE TABLE'",
      )
      if (tables.length) {
        if (
          !tables.some(
            (row) =>
              row.table_schema === 'agent_workflow_meta' && row.table_name === 'migration_records',
          ) ||
          !(await state())
        )
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-not-empty',
            'target is not owned by this copy',
          )
        return
      }
      await tx(async () => {
        await installConversionHistoryHead(postgresqlHistoryConnection(connection), {
          version: head,
          metaTables: binding.metaTables,
          generationId: input.runtime.generationId,
          now: () => now,
        })
        await setState('prepared')
      })
    },
    async copyChunk(table, chunk, now) {
      if (
        chunk.payload.operationId !== run ||
        chunk.payload.schemaDigest !== input.contract.digest ||
        chunk.payload.table !== table.id
      )
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-operation-mismatch',
          'copy chunk binding differs',
        )
      const unitId = `${table.id}:${chunk.payload.chunkIndex}`
      await tx(async () => {
        if ((await state())?.stage !== 'prepared')
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-operation-mismatch',
            'copy is already finalized',
          )
        const previous = await connection.unsafe(
          `SELECT receipt_digest FROM ${meta('migration_units')} WHERE run_id=$1 AND unit_id=$2`,
          [run, unitId],
        )
        if (previous[0]) {
          if (previous[0].receipt_digest !== chunk.digest)
            throw new PostgresqlLogicalTargetError('postgresql-target-chunk-conflict', unitId)
          await assertRows(table, chunk)
          return
        }
        await insertRows(table, chunk)
        await assertRows(table, chunk)
        await connection.unsafe(
          `INSERT INTO ${meta('migration_units')} (run_id,unit_id,rule_id,rule_version,unit_json,receipt_json,receipt_digest,outcome,rows_written,committed_at) VALUES ($1,$2,'epoch2/logical-copy',1,$3,$4,$5,'committed',$6,$7)`,
          [
            run,
            unitId,
            canonicalSchemaJson({ table: table.id, chunk: chunk.payload.chunkIndex }),
            canonicalSchemaJson({ digest: chunk.digest, rows: chunk.payload.rows.length }),
            chunk.digest,
            chunk.payload.rows.length,
            now,
          ],
        )
      })
    },
    async finalizeSchema(_now, expectedTables) {
      try {
        const current = await state()
        if (!current)
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-operation-mismatch',
            'copy state missing',
          )
        await tx(async () => {
          if (expectedTables.length !== input.contract.tables.length)
            throw new PostgresqlLogicalTargetError(
              'postgresql-target-verification',
              'table roster incomplete',
            )
          const expectedByTable = new Map(expectedTables.map((table) => [table.table, table]))
          if (expectedByTable.size !== expectedTables.length)
            throw new PostgresqlLogicalTargetError(
              'postgresql-target-verification',
              'duplicate table coverage',
            )
          const receipts = await connection.unsafe(
            `SELECT unit_json,rows_written FROM ${meta('migration_units')} WHERE run_id=$1 AND rule_id='epoch2/logical-copy'`,
            [run],
          )
          const active = new Set(input.contract.tables.map((table) => table.id))
          const coverage = new Map<string, { chunks: number; rows: number }>()
          for (const receipt of receipts) {
            const unit = JSON.parse(String(receipt.unit_json)) as { table: string }
            if (!active.has(unit.table))
              throw new PostgresqlLogicalTargetError(
                'postgresql-target-verification',
                `receipt outside active roster: ${unit.table}`,
              )
            const count = Number(receipt.rows_written)
            if (!Number.isSafeInteger(count) || count < 0)
              throw new PostgresqlLogicalTargetError(
                'postgresql-target-verification',
                `invalid receipt row count: ${unit.table}`,
              )
            const entry = coverage.get(unit.table) ?? { chunks: 0, rows: 0 }
            entry.chunks += 1
            entry.rows += count
            coverage.set(unit.table, entry)
          }
          for (const table of input.contract.tables) {
            const expected = expectedByTable.get(table.id)
            const count = await connection.unsafe(
              `SELECT COUNT(*) AS count FROM ${tableName(table.providerTables.postgresql!)}`,
            )
            const own = coverage.get(table.id) ?? { chunks: 0, rows: 0 }
            if (
              !expected ||
              Number(count[0]?.count) !== expected.rowCount ||
              own.chunks !== expected.chunkCount ||
              own.rows !== expected.rowCount
            )
              throw new PostgresqlLogicalTargetError('postgresql-target-verification', table.id)
            for (const column of table.columns.filter((column) => column.identity))
              await connection.unsafe(
                `SELECT setval(pg_get_serial_sequence($1,$2),COALESCE(MAX(${quote(column.name)}),1),MAX(${quote(column.name)}) IS NOT NULL) FROM ${tableName(table.providerTables.postgresql!)}`,
                [`agent_workflow.${table.providerTables.postgresql!}`, column.name],
              )
          }
          await verifyPostgresqlLogicalTargetBusinessInvariants({
            connection,
            contract: input.contract,
          })
          await verifyPostgresqlLogicalTargetIdentitySequences({
            connection,
            contract: input.contract,
          })
          if (current.stage === 'prepared') {
            for (const statement of head.postgresql.head.filter(
              (statement) =>
                statement.kind === 'constraint' && statement.logicalId.includes(':fk:'),
            ))
              await connection.unsafe(statement.sql)
            await setState('verified')
          }
        })
        // Admission on the same reserved connection avoids a second pool slot.
        await admitHistory(
          postgresqlHistorySession({
            reserve: async () => ({
              unsafe: (sql, values) => connection.unsafe(sql, values),
              begin: (body) =>
                withNativeTransaction(postgresqlHistoryConnection(connection), () =>
                  body(nativeTransactionHandle(connection)),
                ),
              release() {},
            }),
          }),
          runtimeHistoryAdmission(),
        )
        for (const table of input.contract.tables)
          await connection.unsafe(`ANALYZE ${tableName(table.providerTables.postgresql!)}`)
      } catch (error) {
        if (error instanceof PostgresqlLogicalTargetInvariantError)
          throw new PostgresqlLogicalTargetError(
            `postgresql-target-verification.${error.invariant}`,
            error.message,
            { cause: error },
          )
        if (error instanceof PostgresqlLogicalTargetError) throw error
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-schema-finalize',
          'PostgreSQL target constraints, indexes or identities failed final verification',
          { cause: error },
        )
      }
    },
    async prepareGeneration(generation) {
      await connection.unsafe(
        `INSERT INTO ${meta('generations')} (generation_id,schema_epoch,role,state,provider,operation_id,source_generation_id,contract_digest,plan_digest,created_at) VALUES ($1,2,'installed','prepared','postgresql',$2,$3,$4,$5,$6) ON CONFLICT (generation_id) DO NOTHING`,
        [
          generation.generationId,
          run,
          installedSourceGenerationId ??
            (await state())?.installedSourceGenerationId ??
            generation.sourceGenerationId,
          head.contract.contract.digest,
          head.postgresql.digest,
          Date.now(),
        ],
      )
      await initializeFirstWriteMarker(
        postgresqlHistoryConnection(connection),
        generation.generationId,
      )
    },
    async activateGeneration(generationId, now) {
      await tx(async () => {
        if (!['verified', 'activated'].includes((await state())?.stage ?? ''))
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-generation-fence',
            'copy not verified',
          )
        const rows = await connection.unsafe(
          `UPDATE ${meta('generations')} SET state='active',activated_at=COALESCE(activated_at,$2) WHERE generation_id=$1 AND operation_id=$3 AND state IN ('prepared','active') RETURNING generation_id`,
          [generationId, now, run],
        )
        if (rows.length !== 1)
          throw new PostgresqlLogicalTargetError(
            'postgresql-target-generation-fence',
            'generation not prepared',
          )
        await setState('activated')
      })
    },
    async assertReady(generationId) {
      const rows = await connection.unsafe(
        `SELECT generation_id FROM ${meta('generations')} WHERE generation_id=$1 AND state='active'`,
        [generationId],
      )
      if (rows.length !== 1 || !['activated', 'finalized'].includes((await state())?.stage ?? ''))
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-generation-fence',
          'target not active',
        )
    },
    firstLiveWriteAt: (generationId) =>
      firstLiveWriteAt(postgresqlHistoryConnection(connection), generationId),
    async retireGenerationIfUnwritten(generationId) {
      return tx(async () => {
        const rows = await connection.unsafe(
          `SELECT state FROM ${meta('generations')} WHERE generation_id=$1 FOR UPDATE`,
          [generationId],
        )
        if (
          rows.length !== 1 ||
          (await firstLiveWriteAt(postgresqlHistoryConnection(connection), generationId)) !== null
        )
          return false
        await connection.unsafe(
          `UPDATE ${meta('generations')} SET state='retired',retired_at=$2 WHERE generation_id=$1`,
          [generationId, Date.now()],
        )
        return true
      })
    },
    async markFinalized() {
      if (!['activated', 'finalized'].includes((await state())?.stage ?? ''))
        throw new PostgresqlLogicalTargetError(
          'postgresql-target-generation-fence',
          'target is not active',
        )
      await setState('finalized')
    },
    async close() {
      if (closed) return
      closed = true
      try {
        await connection.unsafe('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey])
      } finally {
        connection.release()
      }
    },
  }
  return target
}
