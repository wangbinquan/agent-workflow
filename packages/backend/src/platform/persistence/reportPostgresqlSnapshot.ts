import { randomUUID } from 'node:crypto'
import type { PostgresqlDatabaseRuntime, PostgresqlReservedConnection } from './postgresqlRuntime'
import { compilePostgresqlSql } from './postgresqlSql'
import { reportReadonlyPostgresqlClient } from './reportReadonlyPostgresqlClient'
import { CREATE_REPORT_WORKING_TABLE, privateReportWorkspace } from './reportWorkspace'
import type { OriginalReportSnapshot, ReportSnapshotSession } from './reportSnapshotTypes'
async function cleanup(connection: PostgresqlReservedConnection, error: unknown) {
  try {
    await connection.unsafe('ROLLBACK')
    await connection.unsafe('DROP TABLE IF EXISTS pg_temp.aw_report_workspace')
  } catch (cleanupError) {
    throw new AggregateError(
      error === undefined ? [cleanupError] : [error, cleanupError],
      'Original report snapshot cleanup failed',
    )
  } finally {
    connection.release()
  }
}
/** TEMP setup precedes READ ONLY; the same original pool channel serves all reads and working rows. */
export function originalPostgresqlReportSnapshot(
  runtime: PostgresqlDatabaseRuntime,
): ReportSnapshotSession {
  return {
    async run<T>(
      work: (snapshot: OriginalReportSnapshot) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      signal?.throwIfAborted()
      const connection = await runtime.providerPool().reserve({ signal })
      let active = false,
        failure: unknown
      try {
        await connection.unsafe('BEGIN')
        await connection.unsafe(
          CREATE_REPORT_WORKING_TABLE.replaceAll('TEXT NOT NULL', 'TEXT COLLATE "C" NOT NULL') +
            ' ON COMMIT PRESERVE ROWS',
        )
        await connection.unsafe('COMMIT')
        await connection.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const identity = await connection.unsafe(
          "SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid, pg_current_snapshot()::text AS position, floor(extract(epoch from transaction_timestamp())*1000)::text AS as_of, (SELECT generation_id FROM agent_workflow_meta.database_generations WHERE generation_id=$1 AND state='active') AS generation_id",
          [runtime.generationId],
        )
        const source = identity[0],
          asOf = Number(source?.as_of)
        if (
          !source?.oid ||
          !source.position ||
          source.generation_id !== runtime.generationId ||
          !Number.isSafeInteger(asOf)
        )
          throw new Error('Original report source generation or snapshot missing')
        active = true
        const workspace = privateReportWorkspace(
          {
            all: async (statement, parameters) =>
              await connection.unsafe(compilePostgresqlSql(statement), parameters),
            run: async (statement, parameters) => {
              await connection.unsafe(compilePostgresqlSql(statement), parameters)
            },
          },
          () => active,
          signal,
        )
        const result = await work({
          executor: reportReadonlyPostgresqlClient(connection, () => active, signal),
          workspace,
          snapshotId: JSON.stringify([
            source.oid,
            source.position,
            runtime.generationId,
            randomUUID(),
          ]),
          generationId: runtime.generationId,
          asOf,
        })
        signal?.throwIfAborted()
        const current = await connection.unsafe('SELECT pg_current_snapshot()::text AS position')
        if (current[0]?.position !== source.position)
          throw new Error('Original report snapshot changed')
        await connection.unsafe('COMMIT')
        return result
      } catch (error) {
        failure = error
        throw error
      } finally {
        active = false
        await cleanup(connection, failure)
      }
    },
  }
}
