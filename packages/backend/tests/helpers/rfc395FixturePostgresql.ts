// RFC-395 CI: fixture ownership includes timed-out queries and reserved migration sessions.
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type PostgresqlReservedConnection,
  type PostgresqlTransactionConnection,
  type SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

export interface FixtureDatabase {
  readonly name: string
  readonly url: string
  drop(): Promise<void>
}

/** Clone only an owned, disconnected fixture. No server-wide template or shared database is changed. */
export async function createRfc395FixtureDatabase(
  sourceUrl: string,
  template?: FixtureDatabase,
): Promise<FixtureDatabase> {
  const url = new URL(sourceUrl)
  const prefix = url.pathname
    .slice(1)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .slice(0, 16)
  const name = `${prefix}_r395_${randomUUID().replaceAll('-', '')}`
  const adminUrl = new URL(sourceUrl)
  adminUrl.searchParams.set(
    'options',
    `${adminUrl.searchParams.get('options') ?? ''} -c statement_timeout=30000 -c lock_timeout=30000`.trim(),
  )
  const admin = new SQL(adminUrl.toString(), { max: 1, idleTimeout: 0, connectionTimeout: 10 })
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template.name}"` : ''}`)
  } finally {
    await admin.close({ timeout: 5 })
  }
  url.pathname = `/${name}`
  let dropped = false
  return {
    name,
    url: url.toString(),
    async drop() {
      if (dropped) return
      const connection = new SQL(adminUrl.toString(), {
        max: 1,
        idleTimeout: 0,
        connectionTimeout: 10,
      })
      try {
        await connection.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        dropped = true
      } finally {
        await connection.close({ timeout: 5 })
      }
    },
  }
}

/** Bun's test timeout does not cancel the test Promise. Close its physical sessions before DDL cleanup. */
export function createRfc395FixtureRuntime(
  input: Parameters<typeof createPostgresqlDatabaseRuntime>[0],
): ReturnType<typeof createPostgresqlDatabaseRuntime> & { cancelQueries(): Promise<void> } {
  const cancellations: (() => Promise<void>)[] = []
  const runtime = createPostgresqlDatabaseRuntime({
    ...input,
    poolFactory(options): PostgresqlPool {
      const applicationName = `aw_r395_${randomUUID().replaceAll('-', '')}`
      const url = new URL(options.url)
      url.searchParams.set(
        'options',
        `${url.searchParams.get('options') ?? ''} -c application_name=${applicationName}`.trim(),
      )
      const physicalOptions = { ...options, url: url.toString() }
      const physical =
        input.poolFactory?.(physicalOptions) ??
        (new SQL(physicalOptions) as unknown as PostgresqlPool)
      const reservations = new Set<PostgresqlReservedConnection>()
      const queries = new Map<SqlRows, Promise<unknown>>()
      const cancelQueries = async () => {
        if (!queries.size) return
        // Server cancellation avoids Bun's reserved-query cancel/close rejection race.
        // The unique application name limits this to sessions created by this fixture pool.
        const control = new SQL(options.url, { max: 1, idleTimeout: 0, connectionTimeout: 10 })
        try {
          await control.unsafe(
            "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND pid <> pg_backend_pid()",
            [applicationName],
          )
        } finally {
          await control.close({ timeout: 1 })
        }
      }

      cancellations.push(cancelQueries)
      // Closing the client sockets does not wait for the server: a backend releases its session
      // advisory locks only when it exits (CI 40439161080 shard 14 still saw the migrator lock
      // right after close). Return only after this pool's sessions are gone.
      let opened = false
      const awaitSessionsExit = async () => {
        if (!opened) return
        const control = new SQL(options.url, { max: 1, idleTimeout: 0, connectionTimeout: 10 })
        const sessions =
          'FROM pg_stat_activity WHERE application_name=$1 AND pid <> pg_backend_pid()'
        try {
          for (let attempt = 1; attempt <= 250; attempt += 1) {
            if ((await control.unsafe(`SELECT pid ${sessions}`, [applicationName])).length === 0)
              return
            if (attempt === 50)
              await control.unsafe(`SELECT pg_terminate_backend(pid) ${sessions}`, [
                applicationName,
              ])
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          throw new Error(`RFC-395 fixture sessions did not exit: ${applicationName}`)
        } catch (error) {
          // The database is already gone, and with it every session.
          if ((error as { errno?: unknown }).errno === '3D000') return
          throw error
        } finally {
          await control.close({ timeout: 1 })
        }
      }
      let closing: Promise<void> | undefined
      const assertOpen = () => {
        if (closing) throw new Error('RFC-395 fixture connection is closed')
      }
      const track = (query: SqlRows): SqlRows => {
        // Attach before returning: Bun cancellation can happen before a PromiseLike is assimilated.
        const result = new Promise<readonly Record<string, unknown>[]>((resolve, reject) => {
          query.then(resolve, reject)
        })
        const settled = result.then(
          () => queries.delete(query),
          () => queries.delete(query),
        )
        queries.set(query, settled)
        return Object.assign(result, { values: async () => (await result).map(Object.values) })
      }

      const transaction = (
        connection: PostgresqlTransactionConnection,
      ): PostgresqlTransactionConnection => ({
        unsafe(sql, values) {
          assertOpen()
          return track(connection.unsafe(sql, values))
        },
        savepoint: (body) => connection.savepoint((nested) => body(transaction(nested))),
      })
      return {
        unsafe(sql, values) {
          assertOpen()
          opened = true
          return track(physical.unsafe(sql, values))
        },
        async reserve(options) {
          assertOpen()
          opened = true
          const connection = await physical.reserve(options)
          if (closing) {
            await connection.close?.({ timeout: 1 })
            connection.release()
            throw new Error('RFC-395 fixture closed during reservation')
          }
          let released = false
          const release = () => {
            if (released) return
            released = true
            reservations.delete(owned)
            connection.release()
          }
          const unsafe: PostgresqlReservedConnection['unsafe'] = (sql, values) => {
            assertOpen()
            return track(connection.unsafe(sql, values))
          }
          const begin: PostgresqlReservedConnection['begin'] = (body) => {
            assertOpen()
            return connection.begin((nested) => body(transaction(nested)))
          }
          const close: NonNullable<PostgresqlReservedConnection['close']> = async (options) => {
            try {
              await connection.close?.(options)
            } finally {
              release()
            }
          }
          // Instrument the real reserved driver object; retain its native capabilities and session.
          const owned = new Proxy(connection, {
            get(target, key) {
              if (key === 'unsafe') return unsafe
              if (key === 'begin') return begin
              if (key === 'release') return release
              if (key === 'close') return close
              const value: unknown = Reflect.get(target, key, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          reservations.add(owned)
          return owned
        },
        close() {
          return (closing ??= Promise.resolve().then(async () => {
            await cancelQueries()
            // Return every reservation before closing its owning pool. Closing ReservedSQL
            // individually can race its pending query/reconnect path in Bun.
            const results = await Promise.allSettled(
              [...reservations].map(async (connection) => {
                connection.release()
              }),
            )
            await physical.close({ timeout: 1 })
            await Promise.all(queries.values())
            await awaitSessionsExit()
            const errors = results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason as unknown] : [],
            )
            if (errors.length) throw new AggregateError(errors, 'RFC-395 fixture session cleanup')
          }))
        },
      }
    },
  })
  let closing: Promise<void> | undefined
  return {
    ...runtime,
    close: () => (closing ??= runtime.close()),
    cancelQueries: async () => {
      await Promise.all(cancellations.map((cancel) => cancel()))
    },
  }
}
