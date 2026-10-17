// RFC-370 — prove born-hosted provenance from the active generation and its
// installed operation. A migrated SQLite database cannot pass by lacking archive
// files. A database restored from a hosted backup names that backup, which is
// then retained (never pruned) for the lifetime of the restored generation.
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { POSTGRESQL_METADATA_SCHEMA } from '@/platform/persistence/postgresqlSchema'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { parseHostedBackupMarker } from './databaseBackupFormat'

export async function readHostedDatabaseBackupProvenance(
  runtime: PostgresqlDatabaseRuntime,
  contract: Pick<LogicalSchemaContract, 'digest'>,
): Promise<readonly string[]> {
  const rows = await runtime
    .providerPool()
    .unsafe(
      `SELECT g.source_generation_id AS generation_source, o.source_generation_id AS operation_source FROM "${POSTGRESQL_METADATA_SCHEMA}".database_generations g JOIN "${POSTGRESQL_METADATA_SCHEMA}".logical_copy_operations o ON o.operation_id = g.operation_id WHERE g.generation_id = $1 AND g.state = 'active' AND g.contract_digest = $2 AND o.contract_digest = g.contract_digest AND o.stage IN ('activated', 'finalized')`,
      [runtime.generationId, contract.digest],
    )
  if (rows.length !== 1 || rows[0]!.generation_source !== rows[0]!.operation_source)
    throw new Error('hosted-backup-installation-provenance-missing')
  const source = rows[0]!.generation_source
  if (source === 'hosted-installation') return []
  const restored = parseHostedBackupMarker(source)
  if (restored === null) throw new Error('hosted-backup-legacy-archive-required')
  return [restored]
}
