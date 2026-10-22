// RFC-395 I-b: unit fakes expose the same begin/savepoint calls used by native drizzle bun-sql.
import type {
  PostgresqlReservedConnection,
  PostgresqlTransactionConnection,
} from '@/platform/persistence/postgresqlRuntime'

export function withNativeTransactions(
  connection: Pick<PostgresqlReservedConnection, 'unsafe' | 'release'>,
): PostgresqlReservedConnection {
  let savepointId = 0
  const transaction: PostgresqlTransactionConnection = {
    unsafe: connection.unsafe.bind(connection),
    async savepoint(body) {
      const name = `fixture_savepoint_${++savepointId}`
      await connection.unsafe(`SAVEPOINT ${name}`)
      try {
        const result = await body(transaction)
        await connection.unsafe(`RELEASE SAVEPOINT ${name}`)
        return result
      } catch (error) {
        await connection.unsafe(`ROLLBACK TO SAVEPOINT ${name}`)
        throw error
      }
    },
  }
  return Object.assign(connection, {
    async begin<T>(body: (client: PostgresqlTransactionConnection) => Promise<T>): Promise<T> {
      await connection.unsafe('BEGIN')
      try {
        const value = await body(transaction)
        await connection.unsafe('COMMIT')
        return value
      } catch (error) {
        try {
          await connection.unsafe('ROLLBACK')
        } catch {
          /* Preserve the original failure. */
        }
        throw error
      }
    },
  })
}
