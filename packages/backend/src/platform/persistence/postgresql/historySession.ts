import type { PostgresqlPool } from '../postgresqlRuntime'
import { withNativeTransaction } from '../nativeTransaction'
import { postgresqlHistoryConnection, type HistoryConnection } from '../schema/history/connection'
import { collectPostgresqlHistoryCatalog } from './historyCatalog'
import type { HistorySession } from '../schema/history/session'
export async function postgresqlHistoryTransaction<T>(
  pool: Pick<PostgresqlPool, 'reserve'>,
  body: (connection: HistoryConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.reserve()
  try {
    // Empty-generation DDL has no admitted ORM session; lock and schema creation share this connection.
    const native = postgresqlHistoryConnection(connection)
    return await withNativeTransaction(native, async () => {
      await connection.unsafe('SELECT pg_advisory_xact_lock(395, 2)')
      await connection.unsafe('SET LOCAL search_path TO agent_workflow, public')
      return await body(native)
    })
  } finally {
    connection.release()
  }
}

export function postgresqlHistorySession(pool: Pick<PostgresqlPool, 'reserve'>): HistorySession {
  return {
    transaction: (body) => postgresqlHistoryTransaction(pool, body),
    async read(body) {
      const connection = await pool.reserve()
      const native = postgresqlHistoryConnection(connection)
      try {
        return await withNativeTransaction(native, async () => {
          await connection.unsafe('SET LOCAL search_path TO agent_workflow, public')
          return body(native, () => collectPostgresqlHistoryCatalog(native))
        })
      } finally {
        connection.release()
      }
    },
  }
}
