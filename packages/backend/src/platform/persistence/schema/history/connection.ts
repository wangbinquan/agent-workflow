// RFC-395 II-b R2: only native engine operations, never a business query facade.
import type { Database } from 'bun:sqlite'
import type { PostgresqlTransactionConnection } from '../../postgresqlRuntime'
import { unhandledDatabaseProvider, type DatabaseProvider } from '../../databaseProviders'

export interface HistoryConnection {
  readonly provider: DatabaseProvider
  execute(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
}
export function sqliteHistoryConnection(database: Database): HistoryConnection {
  return {
    provider: 'sqlite',
    async execute(sql, values = []) {
      return database
        .query(sql)
        .all(...(values as (string | number | bigint | boolean | Uint8Array | null)[])) as Record<
        string,
        unknown
      >[]
    },
  }
}
export function postgresqlHistoryConnection(
  connection: Pick<PostgresqlTransactionConnection, 'unsafe'>,
): HistoryConnection {
  return {
    provider: 'postgresql',
    async execute(sql, values = []) {
      return await connection.unsafe(sql, values)
    },
  }
}
export function parameters(connection: HistoryConnection, count: number): string {
  switch (connection.provider) {
    case 'sqlite':
      return Array.from({ length: count }, () => '?').join(', ')
    case 'postgresql':
      return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ')
    default:
      return unhandledDatabaseProvider(connection.provider)
  }
}
