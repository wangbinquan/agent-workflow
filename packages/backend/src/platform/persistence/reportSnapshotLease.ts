import type { PostgresqlReservedConnection } from './postgresqlRuntime'
import type { OriginalReportLease } from './reportSnapshotTypes'

const key = (lease: OriginalReportLease) => 'observation-report/' + lease.id
/** A long original reader cannot be reclaimed while this same reserved session is alive. */
export async function acquireOriginalReportLease(
  connection: PostgresqlReservedConnection,
  lease: OriginalReportLease,
) {
  const rows = await connection.unsafe(
    'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
    [key(lease)],
  )
  return rows[0]?.acquired === true
}
export async function assertOriginalReportLease(
  connection: PostgresqlReservedConnection,
  lease: OriginalReportLease,
) {
  const rows = await connection.unsafe(
    "SELECT id FROM observation_reports WHERE id=$1 AND owner=$2 AND generation=$3 AND state='building'",
    [lease.id, lease.owner, lease.generation],
  )
  if (rows.length !== 1) throw new Error('Original report build ownership changed')
}
/** Called after READ ONLY COMMIT and before unlocking; no nested pool reservation. */
export async function handoffOriginalReportLease(
  connection: PostgresqlReservedConnection,
  lease: OriginalReportLease,
) {
  const rows = await connection.unsafe(
    "UPDATE observation_reports SET lease_until=floor(extract(epoch from clock_timestamp())*1000)::bigint+45000,updated_at=floor(extract(epoch from clock_timestamp())*1000)::bigint WHERE id=$1 AND owner=$2 AND generation=$3 AND state='building' AND EXISTS(SELECT 1 FROM agent_workflow_meta.database_generations WHERE generation_id=$3 AND state='active') RETURNING id",
    [lease.id, lease.owner, lease.generation],
  )
  if (rows.length !== 1) throw new Error('Original report reader handoff ownership changed')
}
export async function releaseOriginalReportLease(
  connection: PostgresqlReservedConnection,
  lease: OriginalReportLease,
) {
  const rows = await connection.unsafe(
    'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS released',
    [key(lease)],
  )
  if (rows[0]?.released !== true)
    throw new Error('Original report reader session lock was not released')
}
