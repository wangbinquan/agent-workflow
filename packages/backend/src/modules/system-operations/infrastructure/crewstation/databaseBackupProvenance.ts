import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { readRestoreReceipt } from './epoch2RestoreReceipt'
import { parseHostedBackupMarker } from './databaseBackupFormat'
/** Current backup archives include conversion metadata; preserved generation
 * lineage names every retained hosted source, including copies of restored DBs. */
export async function readHostedDatabaseBackupProvenance(
  runtime: PostgresqlDatabaseRuntime,
  _contract: Pick<LogicalSchemaContract, 'digest'>,
): Promise<readonly string[]> {
  const connection = runtime.providerPool(),
    references = new Set<string>(),
    seen = new Set<string>()
  let id: string | null = runtime.generationId
  while (id !== null) {
    if (seen.has(id)) throw new Error('hosted-backup-installation-lineage-cycle')
    seen.add(id)
    const rows = await connection.unsafe(
      'SELECT generation_id,source_generation_id,operation_id,role,state FROM agent_workflow_meta.generations WHERE generation_id=$1',
      [id],
    )
    const row = rows[0]
    if (!row || (id === runtime.generationId && row.state !== 'active'))
      throw new Error('hosted-backup-installation-provenance-missing')
    if (row.operation_id !== null) {
      const copy = await readRestoreReceipt<{ sourceGenerationId: string }>(
        connection,
        String(row.operation_id),
        'epoch2-copy',
      )
      const marker = copy && parseHostedBackupMarker(copy.sourceGenerationId)
      if (marker) references.add(marker)
    }
    if (row.role === 'converted' || row.source_generation_id === null) break
    id = String(row.source_generation_id)
  }
  return [...references].sort()
}
