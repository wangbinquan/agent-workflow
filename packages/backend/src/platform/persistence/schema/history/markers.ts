// RFC-395 II-b R2: old-binary refusal receipts and first *committed business write* markers.
import { metaTableName } from './meta'
import { parameters, type HistoryConnection } from './connection'
import { unhandledDatabaseProvider, type DatabaseProvider } from '../../databaseProviders'

export const EPOCH2_SENTINEL = 'RFC395_SCHEMA_EPOCH_2_REQUIRES_TARGET_BINARY'
export function targetSentinelStatements(provider: DatabaseProvider): readonly string[] {
  switch (provider) {
    case 'sqlite':
      return [
        'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER)',
        // Earliest receipt, deliberately not a valid epoch-1 hash; even prefix admission refuses.
        `INSERT INTO "__drizzle_migrations" (id, hash, created_at) VALUES (-395, '${EPOCH2_SENTINEL}', -395) ON CONFLICT (id) DO NOTHING`,
      ]
    case 'postgresql':
      return [
        'CREATE SCHEMA IF NOT EXISTS "agent_workflow_meta"',
        'CREATE TABLE IF NOT EXISTS "agent_workflow_meta"."schema_migrations" (baseline_id TEXT PRIMARY KEY, contract_digest TEXT NOT NULL, plan_digest TEXT NOT NULL, applied_at BIGINT NOT NULL)',
        // Epoch-1 looks up 0000_rfc349_baseline_v1; this deliberately never supplies it.
        `INSERT INTO "agent_workflow_meta"."schema_migrations" (baseline_id, contract_digest, plan_digest, applied_at) VALUES ('${EPOCH2_SENTINEL}', '${EPOCH2_SENTINEL}', '${EPOCH2_SENTINEL}', 0) ON CONFLICT (baseline_id) DO NOTHING`,
      ]
    default:
      return unhandledDatabaseProvider(provider)
  }
}
export async function installTargetSentinel(connection: HistoryConnection): Promise<void> {
  for (const sql of targetSentinelStatements(connection.provider)) await connection.execute(sql)
}
export async function initializeFirstWriteMarker(
  connection: HistoryConnection,
  generationId: string,
): Promise<void> {
  await connection.execute(
    `INSERT INTO ${metaTableName(connection.provider, 'first_write')} (generation_id, first_live_write_at) VALUES (${parameters(connection, 1)}, NULL) ON CONFLICT (generation_id) DO NOTHING`,
    [generationId],
  )
}
export async function firstLiveWriteAt(
  connection: HistoryConnection,
  generationId: string,
): Promise<number | null> {
  const rows = await connection.execute(
    `SELECT first_live_write_at FROM ${metaTableName(connection.provider, 'first_write')} WHERE generation_id = ${parameters(connection, 1)}`,
    [generationId],
  )
  if (rows.length !== 1) throw new Error('generation-first-write-marker-missing')
  const value = rows[0]!.first_live_write_at
  return value === null ? null : Number(value)
}
/** Pass the caller's business transaction. Failed/rolled-back writes leave no marker. */
export async function markFirstLiveWrite(
  connection: HistoryConnection,
  generationId: string,
  now: number,
): Promise<void> {
  const placeholders = parameters(connection, 2).split(', ')
  await connection.execute(
    `UPDATE ${metaTableName(connection.provider, 'first_write')} SET first_live_write_at = ${placeholders[0]} WHERE generation_id = ${placeholders[1]} AND first_live_write_at IS NULL`,
    [now, generationId],
  )
  if ((await firstLiveWriteAt(connection, generationId)) === null)
    throw new Error('generation-first-write-not-recorded')
}
