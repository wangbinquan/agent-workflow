import type {
  PostgresqlDatabaseRuntime,
  PostgresqlReservedConnection,
} from '@/platform/persistence/postgresqlRuntime'
import { encodeLogicalRow } from '@/platform/persistence/logicalDatabaseArtifact'
import {
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import {
  POSTGRESQL_APPLICATION_SCHEMA,
  POSTGRESQL_METADATA_SCHEMA,
} from '@/platform/persistence/postgresqlSchema'
import {
  hostedRestoreCopyOperationId,
  parseHostedBackupMarker,
  parseHostedBackupReference,
} from './databaseBackupFormat'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const metadata = (name: string) => `${quote(POSTGRESQL_METADATA_SCHEMA)}.${quote(name)}`

/** Hash the finalized rows after owner restore normalization. Bounded keyset
 * reads use the same logical codec as backup, inside the caller's transaction. */
export async function restoredDatabaseDigests(
  connection: PostgresqlReservedConnection,
  contract: LogicalSchemaContract,
) {
  const result: { table: string; digest: string; rows: number }[] = []
  for (const table of contract.tables) {
    if (table.disposition === 'ARCHIVE_THEN_OMIT' || !table.providerTables.postgresql) continue
    const hash = createSha256DigestBuilder()
    let after: unknown[] | null = null,
      count = 0
    for (;;) {
      const params = [...(after ?? []), 500]
      const where: string = after
        ? ` WHERE (${table.migrationKey.map(quote).join(',')}) > (${after.map((_, i) => `$${i + 1}`).join(',')})`
        : ''
      const rows = await connection.unsafe(
        `SELECT ${table.columns.map((c) => quote(c.name)).join(',')} FROM ${quote(POSTGRESQL_APPLICATION_SCHEMA)}.${quote(table.providerTables.postgresql)}${where} ORDER BY ${table.migrationKey.map(quote).join(',')} LIMIT $${params.length}`,
        params,
      )
      for (const row of rows) {
        hash.update(canonicalSchemaJson(encodeLogicalRow(table, row)))
        hash.update('\n')
      }
      count += rows.length
      if (rows.length < 500) break
      after = table.migrationKey.map((key) => rows.at(-1)![key])
    }
    result.push({ table: table.id, digest: `sha256:${hash.digestHex()}`, rows: count })
  }
  return result
}

export async function recordRestoredDatabaseDigests(
  connection: PostgresqlReservedConnection,
  contract: LogicalSchemaContract,
  operationId: string,
  now: number,
) {
  for (const table of await restoredDatabaseDigests(connection, contract))
    await connection.unsafe(
      `INSERT INTO ${metadata('logical_copy_chunks')} (operation_id, table_id, chunk_index, chunk_digest, row_count, first_key_json, last_key_json, committed_at) VALUES ($1,$2,0,$3,$4,NULL,NULL,$5)`,
      [operationId, table.table, table.digest, table.rows, now],
    )
}

/** An independent verification Job observes the committed final state. It
 * cannot repair, migrate, or bless a partial target while verifying it. */
export async function verifyRestoredDatabaseDigests(
  connection: PostgresqlReservedConnection,
  contract: LogicalSchemaContract,
  operationId: string,
) {
  const expected = await connection.unsafe(
    `SELECT table_id,chunk_digest,row_count FROM ${metadata('logical_copy_chunks')} WHERE operation_id=$1 AND chunk_index=0 ORDER BY table_id`,
    [operationId],
  )
  const actual = await restoredDatabaseDigests(connection, contract)
  if (
    expected.length !== actual.length ||
    actual.some((table) => {
      const row = expected.find((entry) => entry.table_id === table.table)
      return !row || row.chunk_digest !== table.digest || Number(row.row_count) !== table.rows
    })
  )
    throw new Error('hosted-restore-finalized-content-changed')
}

/** The CS RFC-042 verify Job (`agent-workflow verify-database-restore`): the
 * platform generation must be exactly the finalized restore of this reference,
 * untouched by live traffic, and every restored table must still hash to the
 * digest the restore recorded after owner normalization. No archive download. */
export async function verifyHostedDatabaseRestore(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly reference: string
  readonly contract: LogicalSchemaContract
  readonly generation: { readonly generationId: string; readonly operationId: string }
}) {
  const object = parseHostedBackupReference(input.reference)
  const connection = await input.runtime.providerPool().reserve()
  try {
    await connection.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const rows = await connection.unsafe(
      `SELECT g.source_generation_id FROM ${metadata('database_generations')} g JOIN ${metadata('logical_copy_operations')} r ON r.operation_id = $1 AND r.source_generation_id = g.source_generation_id JOIN ${metadata('logical_copy_operations')} o ON o.operation_id = g.operation_id AND o.source_generation_id = g.source_generation_id WHERE g.generation_id = $2 AND g.operation_id = $3 AND g.contract_digest = $4 AND g.state = 'active' AND g.first_live_write_at IS NULL AND r.stage = 'finalized'`,
      [
        hostedRestoreCopyOperationId(object),
        input.generation.generationId,
        input.generation.operationId,
        input.contract.digest,
      ],
    )
    if (rows.length !== 1 || parseHostedBackupMarker(rows[0]!.source_generation_id) === null)
      throw new Error('hosted-restore-finalization-not-confirmed')
    await verifyRestoredDatabaseDigests(connection, input.contract, input.generation.operationId)
    await connection.unsafe('COMMIT')
  } finally {
    await Promise.resolve(connection.unsafe('ROLLBACK')).catch(() => undefined)
    connection.release()
  }
  return {
    version: 1,
    backupReferenceDigest: sha256Hex(input.reference),
    schemaDigest: input.contract.digest,
    complete: true,
    autoResumeSuspended: true,
  } as const
}
