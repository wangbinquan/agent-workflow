import type { PostgresqlTransactionConnection } from './postgresqlRuntime'
import type { HistoryConnection } from './schema/history/connection'

/** The caller owns an exclusive native connection for this entire operation. */
export async function withNativeTransaction<T>(
  connection: Pick<HistoryConnection, 'execute'>,
  body: () => Promise<T>,
  begin = 'BEGIN',
): Promise<T> {
  await connection.execute(begin)
  try {
    const result = await body()
    await connection.execute('COMMIT')
    return result
  } catch (error) {
    await connection.execute('ROLLBACK')
    throw error
  }
}

/** Adapt one reserved native channel for history admission, including nested savepoints. */
export function nativeTransactionHandle(
  connection: Pick<PostgresqlTransactionConnection, 'unsafe'>,
): PostgresqlTransactionConnection {
  let nextSavepoint = 0
  const handle: PostgresqlTransactionConnection = {
    unsafe: (sql, values) => connection.unsafe(sql, values),
    async savepoint(body) {
      const name = `aw_migration_${++nextSavepoint}`
      await connection.unsafe(`SAVEPOINT ${name}`)
      try {
        const result = await body(handle)
        await connection.unsafe(`RELEASE SAVEPOINT ${name}`)
        return result
      } catch (error) {
        await connection.unsafe(`ROLLBACK TO SAVEPOINT ${name}`)
        await connection.unsafe(`RELEASE SAVEPOINT ${name}`)
        throw error
      }
    },
  }
  return handle
}
