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
import { timeoutSignal } from '@/util/timeoutSignal'

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

/**
 * Runtimes whose generation this process has already durably marked as
 * live-written. Keyed by the runtime rather than the generation id so a second
 * composition of the same generation (and every test fixture) starts clean.
 */
const markedGenerations = new WeakSet<PostgresqlDatabaseRuntime>()

/**
 * Per-transaction generation fence. A read: the row is only ever written by the
 * one-shot marker below and by generation retirement, so concurrent business
 * writes never conflict here — a serialization failure at this statement means
 * the generation really was retired underneath the transaction, which is
 * exactly what the fence exists to catch.
 */
async function assertActiveGeneration(
  connection: PostgresqlPool | PostgresqlReservedConnection,
  runtime: PostgresqlDatabaseRuntime,
): Promise<void> {
  const rows = await connection.unsafe(
    'SELECT generation_id FROM "agent_workflow_meta"."database_generations" ' +
      "WHERE generation_id = $1 AND state = 'active'",
    [runtime.generationId],
  )
  if (rows.length !== 1) {
    throw new PostgresqlGenerationFenceError(
      'PostgreSQL business write rejected by the active database generation fence',
    )
  }
}

/**
 * RFC-349 rollback horizon: record that the target generation has taken a live
 * business write. Two properties matter and neither survives the original
 * `SET first_live_write_at = COALESCE(first_live_write_at, now)` shape:
 *
 * - It must not be re-written once set. That statement wrote the same single
 *   row on *every* business statement, so any two concurrent SERIALIZABLE
 *   transactions — including the session touch every authenticated request
 *   performs — collided on it. The hosted evidence run failed with 38
 *   `could not serialize access due to concurrent update` in a 12-second phase,
 *   all of them 500s the caller never caused. `WHERE first_live_write_at IS
 *   NULL` makes the statement a no-op after the first success, so the steady
 *   state has no writer at all.
 * - The first writers must not collide either. Running it on its own pooled
 *   connection puts it at READ COMMITTED, where a loser re-evaluates the
 *   predicate after the winner commits, matches no row and returns quietly,
 *   instead of aborting a SERIALIZABLE business transaction.
 *
 * The marker therefore commits strictly *before* the business write it belongs
 * to rather than with it — a deliberate deviation from design §11.6's
 * "same transaction". It can only fail conservatively: the marker may outlive a
 * business transaction that rolled back, which closes the instant-rollback
 * horizon one write too early. The reverse — data committed on the target with
 * no marker — remains impossible.
 */
const MARKER_RESERVE_TIMEOUT_MS = 2_000

async function markFirstGenerationWrite(
  runtime: PostgresqlDatabaseRuntime,
  caller: PostgresqlPool | PostgresqlReservedConnection,
): Promise<void> {
  if (markedGenerations.has(runtime)) return
  // A connection of its own, never the pool's shared query path: a pooled
  // statement can land on a session another caller has already opened a
  // transaction on, and this write would then arrive before that transaction's
  // `SET TRANSACTION ISOLATION LEVEL`. But `poolMax` can be 1, and the caller
  // is already holding a connection while it waits here — so bound the wait and
  // fall back to the caller's own session rather than deadlocking. The fallback
  // only reintroduces the one-time race between the very first writers.
  let dedicated: PostgresqlReservedConnection | null = null
  const deadline = timeoutSignal(MARKER_RESERVE_TIMEOUT_MS)
  try {
    dedicated = await runtime.providerPool().reserve({ signal: deadline.signal })
  } catch {
    dedicated = null
  } finally {
    deadline.cancel()
  }
  try {
    const rows = await (dedicated ?? caller).unsafe(
      'WITH marked AS (' +
        'UPDATE "agent_workflow_meta"."database_generations" ' +
        'SET first_live_write_at = ' +
        'floor(extract(epoch from clock_timestamp()) * 1000)::bigint ' +
        "WHERE generation_id = $1 AND state = 'active' AND first_live_write_at IS NULL " +
        'RETURNING generation_id) ' +
        'SELECT generation_id FROM marked UNION ALL ' +
        'SELECT generation_id FROM "agent_workflow_meta"."database_generations" ' +
        "WHERE generation_id = $1 AND state = 'active' AND first_live_write_at IS NOT NULL",
      [runtime.generationId],
    )
    // One row means this generation is active and now carries a marker — set by
    // this statement or by an earlier writer. Either way the process never has
    // to run it again. Zero rows means the generation is not active;
    // `assertActiveGeneration` is the authority on that and rejects the write.
    if (rows.length === 1) markedGenerations.add(runtime)
  } finally {
    dedicated?.release()
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
    await markFirstGenerationWrite(input.runtime, input.client)
    await assertActiveGeneration(input.client, input.runtime)
    return await input.execute(input.client)
  }
  await markFirstGenerationWrite(input.runtime, input.client)
  const connection = await input.runtime.providerPool().reserve()
  try {
    await connection.unsafe('BEGIN')
    await assertActiveGeneration(connection, input.runtime)
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
