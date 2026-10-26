import type { PostgresqlReservedConnection } from '@/platform/persistence/postgresqlRuntime'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schemaContract'
export async function readRestoreReceipt<T>(
  connection: Pick<PostgresqlReservedConnection, 'unsafe'>,
  operation: string,
  unit: string,
): Promise<T | null> {
  const rows = await connection.unsafe(
    'SELECT record_json, record_digest FROM agent_workflow_meta.migration_records WHERE run_id=$1 AND unit_id=$2 AND ordinal=0',
    [operation, unit],
  )
  if (!rows.length) return null
  const value = JSON.parse(String(rows[0]!.record_json)) as T
  if (digestSchemaContract(value) !== rows[0]!.record_digest)
    throw new Error('hosted-restore-receipt-mismatch')
  return value
}
export async function writeRestoreReceipt(
  connection: Pick<PostgresqlReservedConnection, 'unsafe'>,
  operation: string,
  unit: string,
  value: unknown,
): Promise<void> {
  await connection.unsafe(
    "INSERT INTO agent_workflow_meta.migration_records (run_id,unit_id,ordinal,kind,table_name,record_json,record_digest) VALUES ($1,$2,0,'source-metadata',NULL,$3,$4) ON CONFLICT (run_id,unit_id,ordinal) DO UPDATE SET record_json=EXCLUDED.record_json,record_digest=EXCLUDED.record_digest",
    [operation, unit, canonicalSchemaJson(value), digestSchemaContract(value)],
  )
}
export interface HostedEpoch2RestoreReceipt {
  stage: 'finalized'
  generationId: string
  copyOperationId: string
  backupId: string
  logicalDigest: string
  completedAt: number
}
