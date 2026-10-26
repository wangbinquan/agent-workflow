import {
  readRestoreReceipt,
  writeRestoreReceipt,
  type HostedEpoch2RestoreReceipt,
} from './epoch2RestoreReceipt'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlReservedConnection,
} from '@/platform/persistence/postgresqlRuntime'
import { encodeLogicalRow } from '@/platform/persistence/logicalDatabaseArtifact'
import {
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import { POSTGRESQL_APPLICATION_SCHEMA } from '@/platform/persistence/postgresqlSchema'
import { hostedRestoreCopyOperationId, parseHostedBackupReference } from './databaseBackupFormat'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Hash the finalized rows after owner restore normalization. Bounded keyset
 * reads use the same logical codec as backup, inside the caller's transaction. */
export async function restoredDatabaseDigests(
  connection: Pick<PostgresqlReservedConnection, 'unsafe'>,
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
  connection: Pick<PostgresqlReservedConnection, 'unsafe'>,
  contract: LogicalSchemaContract,
  operationId: string,
  now: number,
) {
  await writeRestoreReceipt(connection, operationId, 'hosted-restore-tables', {
    tables: await restoredDatabaseDigests(connection, contract),
    recordedAt: now,
  })
}

/** An independent verification Job observes the committed final state. It
 * cannot repair, migrate, or bless a partial target while verifying it. */
export async function verifyRestoredDatabaseDigests(
  connection: Pick<PostgresqlReservedConnection, 'unsafe'>,
  contract: LogicalSchemaContract,
  operationId: string,
) {
  const receipt = await readRestoreReceipt<{
    tables: { table: string; digest: string; rows: number }[]
  }>(connection, operationId, 'hosted-restore-tables')
  const expected = receipt?.tables ?? []
  const actual = await restoredDatabaseDigests(connection, contract)
  if (
    expected.length !== actual.length ||
    actual.some((table) => {
      const row = expected.find((entry) => entry.table === table.table)
      return !row || row.digest !== table.digest || row.rows !== table.rows
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
    const receipt = await readRestoreReceipt<HostedEpoch2RestoreReceipt>(
      connection,
      input.generation.operationId,
      'hosted-restore',
    )
    const rows = await connection.unsafe(
      "SELECT g.generation_id FROM agent_workflow_meta.generations g JOIN agent_workflow_meta.first_write w USING (generation_id) WHERE g.generation_id=$1 AND g.state='active' AND w.first_live_write_at IS NULL",
      [input.generation.generationId],
    )
    if (
      rows.length !== 1 ||
      !receipt ||
      receipt.stage !== 'finalized' ||
      receipt.generationId !== input.generation.generationId ||
      receipt.logicalDigest !== input.contract.digest ||
      receipt.copyOperationId !== hostedRestoreCopyOperationId(object)
    )
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
