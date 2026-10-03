import type { PostgresqlReservedConnection } from './postgresqlRuntime'
import type { OriginalReportLease } from './reportSnapshotTypes'
import { releaseOriginalReportLease } from './reportSnapshotLease'

/** Never return an unconfirmed transaction, TEMP or session lock to the reusable original pool. */
export async function cleanupOriginalPostgresqlReport(
  connection: PostgresqlReservedConnection,
  failure: unknown,
  lease?: OriginalReportLease,
) {
  const errors: unknown[] = []
  try {
    await connection.unsafe('ROLLBACK')
  } catch (error) {
    errors.push(error)
  }
  try {
    await connection.unsafe('DROP TABLE IF EXISTS pg_temp.aw_report_workspace')
  } catch (error) {
    errors.push(error)
  }
  if (lease)
    try {
      await releaseOriginalReportLease(connection, lease)
    } catch (error) {
      errors.push(error)
    }
  if (errors.length) {
    try {
      if (!connection.close)
        throw new Error('Original reserved channel cannot be physically discarded')
      await connection.close({ timeout: 0 })
      // ReservedSQL.close physically removes this channel; release rejects after close.
    } catch (error) {
      errors.push(error)
    }
    throw new AggregateError(
      failure === undefined ? errors : [failure, ...errors],
      'Original report snapshot cleanup failed',
    )
  }
  connection.release()
}
