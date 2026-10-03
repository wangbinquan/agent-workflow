import type { SQLWrapper } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import { drizzle, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy'
import type { ProviderNeutralDatabase } from '@/db/query'
import * as schema from '@/db/schema'
import type { OriginalReportReadChannel } from './reportSnapshotTypes'

/** A Worker ORM facade; its reads still execute on the one original snapshot channel. */
export function reportReadonlyChannelClient(
  channel: OriginalReportReadChannel,
): ProviderNeutralDatabase {
  const dialect = new SQLiteAsyncDialect()
  const callback: AsyncRemoteCallback = async (statement, parameters, method) => {
    const rows = await channel.values(statement, parameters)
    return { rows: method === 'get' ? (rows[0] as unknown[]) : (rows as unknown[]) }
  }
  const base = drizzle(callback, { schema })
  const raw = async (query: SQLWrapper) => {
    const statement = dialect.sqlToQuery(query.getSQL())
    return channel.objects(statement.sql, statement.params)
  }
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === '$provider') return 'postgresql'
      if (key === 'all') return raw
      if (key === 'get') return async (query: SQLWrapper) => (await raw(query))[0]
      if (key === 'values')
        return async (query: SQLWrapper) => {
          const statement = dialect.sqlToQuery(query.getSQL())
          return channel.values(statement.sql, statement.params)
        }
      if (key === 'run' || key === 'transaction')
        return () => {
          throw new Error('Report input only supports original reads')
        }
      return Reflect.get(target, key, receiver)
    },
  }) as ProviderNeutralDatabase
}
