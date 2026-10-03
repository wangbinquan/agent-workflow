import type { SQLWrapper } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import { drizzle, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy'
import type { ProviderNeutralDatabase } from '@/db/query'
import * as schema from '@/db/schema'
import type { PostgresqlReservedConnection } from './postgresqlRuntime'
import { assertPostgresqlBusinessStatement, compilePostgresqlSql } from './postgresqlSql'
const dialect = new SQLiteAsyncDialect()
/** A read-only ORM facade on the actual original reserved channel; no new reservation or writer marker. */
export function reportReadonlyPostgresqlClient(
  connection: PostgresqlReservedConnection,
  active: () => boolean,
  signal?: AbortSignal,
): ProviderNeutralDatabase {
  const check = (statement: string) => {
    if (!active()) throw new Error('Report snapshot already closed')
    signal?.throwIfAborted()
    if (assertPostgresqlBusinessStatement(statement) !== 'read')
      throw new Error('Report input only supports original reads')
  }
  const callback: AsyncRemoteCallback = async (statement, parameters, method) => {
    const compiled = compilePostgresqlSql(statement)
    check(compiled)
    const values = await connection.unsafe(compiled, parameters).values()
    return { rows: method === 'get' ? (values[0] as unknown[]) : (values as unknown[]) }
  }
  const base = drizzle(callback, { schema })
  const raw = async (query: SQLWrapper) => {
    const compiled = dialect.sqlToQuery(query.getSQL()),
      statement = compilePostgresqlSql(compiled.sql)
    check(statement)
    return await connection.unsafe(statement, compiled.params)
  }
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === '$provider') return 'postgresql'
      if (key === 'all') return raw
      if (key === 'get') return async (q: SQLWrapper) => (await raw(q))[0]
      if (key === 'values')
        return async (q: SQLWrapper) => {
          const query = dialect.sqlToQuery(q.getSQL()),
            statement = compilePostgresqlSql(query.sql)
          check(statement)
          return await connection.unsafe(statement, query.params).values()
        }
      if (key === 'run' || key === 'transaction')
        return () => {
          throw new Error('Report input only supports original reads')
        }
      return Reflect.get(target, key, receiver)
    },
  }) as ProviderNeutralDatabase
}
