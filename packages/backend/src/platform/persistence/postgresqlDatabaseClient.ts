// RFC-349 — asynchronous Drizzle logical-query adapter backed by a real
// external PostgreSQL pool. Query builders use the provider-aware pgTable
// projection; this adapter only compiles bind markers and pins transactions to
// one reserved connection.

import type { SQL, SQLWrapper } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import {
  drizzle as createRemoteDatabase,
  type AsyncRemoteCallback,
  type SqliteRemoteDatabase,
  type SqliteRemoteResult,
} from 'drizzle-orm/sqlite-proxy'
import * as schema from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from './postgresqlRuntime'
import { assertPostgresqlBusinessStatement, compilePostgresqlSql } from './postgresqlSql'

export interface DatabaseMutationResult extends SqliteRemoteResult {
  readonly changes: number
}

export class PostgresqlGenerationFenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostgresqlGenerationFenceError'
  }
}

export type PostgresqlDatabaseClient = SqliteRemoteDatabase<typeof schema> & {
  readonly $provider: 'postgresql'
  readonly $generationId: string
}

interface CountedRows extends ReadonlyArray<Record<string, unknown>> {
  readonly count?: number
}

function mutationCount(rows: readonly Record<string, unknown>[]): number {
  const count = (rows as CountedRows).count
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? count
    : rows.length
}

async function markFirstGenerationWrite(
  connection: PostgresqlReservedConnection,
  runtime: PostgresqlDatabaseRuntime,
): Promise<void> {
  const rows = await connection.unsafe(
    'UPDATE "agent_workflow_meta"."database_generations" ' +
      'SET first_live_write_at = COALESCE(first_live_write_at, ' +
      'floor(extract(epoch from clock_timestamp()) * 1000)::bigint) ' +
      "WHERE generation_id = $1 AND state = 'active' RETURNING generation_id",
    [runtime.generationId],
  )
  if (rows.length !== 1) {
    throw new PostgresqlGenerationFenceError(
      'PostgreSQL business write rejected by the active database generation fence',
    )
  }
}

async function rollback(connection: PostgresqlReservedConnection): Promise<void> {
  try {
    await connection.unsafe('ROLLBACK')
  } catch {
    // Preserve the original statement or generation-fence failure.
  }
}

async function withWriteFence<T>(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly client: PostgresqlPool | PostgresqlReservedConnection
  readonly transactional: boolean
  readonly sql: string
  readonly execute: (client: PostgresqlPool | PostgresqlReservedConnection) => Promise<T>
}): Promise<T> {
  const operation = assertPostgresqlBusinessStatement(input.sql)
  if (operation !== 'write') return await input.execute(input.client)
  if (input.transactional) {
    await markFirstGenerationWrite(input.client as PostgresqlReservedConnection, input.runtime)
    return await input.execute(input.client)
  }
  const connection = await input.runtime.providerPool().reserve()
  try {
    await connection.unsafe('BEGIN')
    await markFirstGenerationWrite(connection, input.runtime)
    const result = await input.execute(connection)
    await connection.unsafe('COMMIT')
    return result
  } catch (error) {
    await rollback(connection)
    throw error
  } finally {
    connection.release()
  }
}

async function executeArrays(
  runtime: PostgresqlDatabaseRuntime,
  client: PostgresqlPool | PostgresqlReservedConnection,
  transactional: boolean,
  sql: string,
  parameters: readonly unknown[],
  method: 'run' | 'all' | 'values' | 'get',
): Promise<{ rows: unknown[]; changes?: number }> {
  const compiled = compilePostgresqlSql(sql)
  return await withWriteFence({
    runtime,
    client,
    transactional,
    sql: compiled,
    async execute(executor) {
      const pending: SqlRows = executor.unsafe(compiled, parameters)
      if (method === 'run') {
        const result = await pending
        return { rows: [], changes: mutationCount(result) }
      }
      const values = await pending.values()
      // sqlite-proxy's get mapper distinguishes no row by a falsy `rows`
      // value. An empty array is truthy and would be mapped into an object
      // whose selected fields are all undefined, turning every not-found read
      // into a false hit. Preserve the native first row, including undefined.
      if (method === 'get') return { rows: values[0] as unknown[] }
      return { rows: values as unknown[] }
    },
  })
}

function callbackFor(
  runtime: PostgresqlDatabaseRuntime,
  client: PostgresqlPool | PostgresqlReservedConnection,
  transactional: boolean,
): AsyncRemoteCallback {
  return (sql, parameters, method) =>
    executeArrays(runtime, client, transactional, sql, parameters, method)
}

const rawDialect = new SQLiteAsyncDialect()

function compileRaw(query: SQLWrapper): { sql: string; params: unknown[] } {
  const compiled = rawDialect.sqlToQuery(query.getSQL())
  return { sql: compilePostgresqlSql(compiled.sql), params: compiled.params }
}

async function rawRows(
  runtime: PostgresqlDatabaseRuntime,
  client: PostgresqlPool | PostgresqlReservedConnection,
  transactional: boolean,
  query: SQLWrapper,
): Promise<readonly Record<string, unknown>[]> {
  const compiled = compileRaw(query)
  return await withWriteFence({
    runtime,
    client,
    transactional,
    sql: compiled.sql,
    execute: async (executor) => await executor.unsafe(compiled.sql, compiled.params),
  })
}

type PostgresqlTransaction = Parameters<
  Parameters<SqliteRemoteDatabase<typeof schema>['transaction']>[0]
>[0]

function decorateDatabase<TDatabase extends object>(
  base: TDatabase,
  input: {
    readonly runtime: PostgresqlDatabaseRuntime
    readonly rawClient: PostgresqlPool | PostgresqlReservedConnection
    readonly transactional: boolean
  },
): TDatabase {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === '$provider') return 'postgresql'
      if (property === '$generationId') return input.runtime.generationId
      if (property === 'all') {
        return async <T>(query: SQLWrapper): Promise<T[]> =>
          (await rawRows(input.runtime, input.rawClient, input.transactional, query)) as T[]
      }
      if (property === 'get') {
        return async <T>(query: SQLWrapper): Promise<T | undefined> =>
          (await rawRows(input.runtime, input.rawClient, input.transactional, query))[0] as
            | T
            | undefined
      }
      if (property === 'values') {
        return async (query: SQLWrapper): Promise<readonly (readonly unknown[])[]> => {
          const compiled = compileRaw(query)
          return await withWriteFence({
            runtime: input.runtime,
            client: input.rawClient,
            transactional: input.transactional,
            sql: compiled.sql,
            execute: async (executor) =>
              await executor.unsafe(compiled.sql, compiled.params).values(),
          })
        }
      }
      if (property === 'run') {
        return async (query: SQL | SQLWrapper): Promise<DatabaseMutationResult> => {
          const rows = await rawRows(input.runtime, input.rawClient, input.transactional, query)
          return { rows: [], changes: mutationCount(rows) }
        }
      }
      if (property === 'transaction' && !input.transactional) {
        return async <T>(
          operation: (transaction: PostgresqlTransaction) => Promise<T> | T,
        ): Promise<T> => {
          const connection = await input.runtime.providerPool().reserve()
          const transactionBase = createRemoteDatabase(
            callbackFor(input.runtime, connection, true),
            { schema },
          )
          try {
            return await transactionBase.transaction(
              async (transaction) =>
                await operation(
                  decorateDatabase(transaction, {
                    runtime: input.runtime,
                    rawClient: connection,
                    transactional: true,
                  }),
                ),
            )
          } finally {
            connection.release()
          }
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

export function createPostgresqlDatabaseClient(
  runtime: PostgresqlDatabaseRuntime,
): PostgresqlDatabaseClient {
  selectDatabaseSchemaProvider('postgresql')
  const pool = runtime.providerPool()
  const base = createRemoteDatabase(callbackFor(runtime, pool, false), { schema })
  return decorateDatabase(base, {
    runtime,
    rawClient: pool,
    transactional: false,
  }) as PostgresqlDatabaseClient
}
