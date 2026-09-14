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
 * business write, in the same transaction as that write (design §11.6).
 *
 * The statement must not re-write the row once it is set. The original shape,
 * `SET first_live_write_at = COALESCE(first_live_write_at, now)`, wrote the same
 * single row on *every* business statement, so any two concurrent SERIALIZABLE
 * transactions — including the session touch every authenticated request
 * performs — collided on it: the hosted evidence run failed with 38
 * `could not serialize access due to concurrent update` in a 12-second phase,
 * none of them caused by the caller. `WHERE first_live_write_at IS NULL` makes
 * the statement a no-op after the first success, so the steady state has no
 * writer at all and cannot conflict. The first writers of a fresh generation
 * still race each other once; that is an ordinary serialization failure and the
 * caller's retry (see each adapter's `serializable` helper) settles it.
 *
 * It deliberately runs on the connection it is handed, never on a nested
 * reservation: reserving a second connection while the caller already holds one
 * is a measured pooling hazard — 132 failures in 42k iterations of a standalone
 * Bun.SQL reproduction, surfacing as
 * `SET TRANSACTION ISOLATION LEVEL must be called before any query` on an
 * unrelated transaction.
 */
async function markFirstGenerationWrite(
  connection: PostgresqlPool | PostgresqlReservedConnection,
  runtime: PostgresqlDatabaseRuntime,
): Promise<void> {
  if (markedGenerations.has(runtime)) return
  const rows = await connection.unsafe(
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
  // this statement or by an earlier writer. Either way the process never has to
  // run it again. Zero rows means the generation is not active;
  // `assertActiveGeneration` is the authority on that and rejects the write.
  if (rows.length === 1) markedGenerations.add(runtime)
}

/**
 * RFC-359 AC-11 —— 把世代围栏折进 INSERT 自己，于是这笔写只要**一个往返**。
 *
 * # 为什么值得
 *
 * 非事务单语句写原本要四个往返：`BEGIN` / 围栏 `SELECT` / 写 / `COMMIT`（见下面的
 * `withWriteFence`）。每个认证请求固定带一笔这样的写（PAT 调用审计），它虽然是
 * `void` 派发、不挡响应，但**占着一条 reserve 出来的池连接四个往返**，于是挡住后面的请求。
 * 实测（本机 Docker PG，`/api/reviews/pending-count`，40 次）：
 * 关掉这笔审计写，p95 从 **18.11ms 掉到 5.57ms**（−69%），而 SQLite 侧只从 3.76 掉到 3.06。
 * 「fire-and-forget 所以不要紧」是错的——它不占延迟，占的是并发度。
 *
 * # 语义逐字不变
 *
 * 围栏要的是「世代不活跃就不许写」，且判定与写必须原子。
 * `INSERT … SELECT … WHERE EXISTS (世代活跃)` 单语句本身就是原子的：活跃则插 1 行、
 * 不活跃则插 0 行，`changes === 0` 与围栏失败**一一对应**（普通 `VALUES` 插入必然影响 1 行，
 * 不存在「合法地插了 0 行」这种情况）。因此这里不需要显式事务。
 *
 * # 只吃最窄的那一类，其余原路走
 *
 * 必须整条命中 `insert into T (列…) values ($1…$n)`：单行、每个值都是裸占位符、
 * 没有 `on conflict`、没有 `returning`、没有子查询。凡有一条不符就返回 `null`，
 * 调用方回到原来的四往返路径——**不猜、不改写复杂 SQL**。
 */
const SINGLE_ROW_INSERT = /^insert into ((?:"[^"]+"\.)?"[^"]+") \(([^()]+)\) values \(([^()]+)\)$/i

function foldGenerationFenceIntoInsert(sql: string, parameterCount: number): string | null {
  const matched = SINGLE_ROW_INSERT.exec(sql.trim())
  if (matched === null) return null
  const [, table, columns, values] = matched
  if (table === undefined || columns === undefined || values === undefined) return null
  // 每个值只允许两种写法：裸占位符 `$k`，或 drizzle 为未赋值列内联的字面 `null`。
  // `default` / 表达式 / 函数调用 / 子查询一律不折——它们的求值时机与类型推导都另说。
  const placeholders = values.split(',').map((part) => part.trim())
  let seen = 0
  for (const part of placeholders) {
    if (part.toLowerCase() === 'null') continue
    seen += 1
    if (part !== `$${String(seen)}`) return null
  }
  // 占位符必须恰好覆盖全部实参，且按 `$1..$n` 顺序出现；数量对不上说明这条 SQL 不是
  // 我们以为的形状（例如参数被复用），一律不折。
  if (seen !== parameterCount) return null
  const fence = `$${String(parameterCount + 1)}`
  return (
    `insert into ${table} (${columns}) select ${placeholders.join(', ')} ` +
    `where exists (select 1 from "agent_workflow_meta"."database_generations" ` +
    `where generation_id = ${fence} and state = 'active')`
  )
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
    await markFirstGenerationWrite(input.client, input.runtime)
    await assertActiveGeneration(input.client, input.runtime)
    return await input.execute(input.client)
  }
  const connection = await input.runtime.providerPool().reserve()
  try {
    await connection.unsafe('BEGIN')
    await markFirstGenerationWrite(connection, input.runtime)
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
  // RFC-359 AC-11 —— 围栏内联的快路径。四个前置条件缺一不可：
  // ① 非事务（事务里本就不额外开 BEGIN/COMMIT，折了也省不下）；
  // ② `run`（只要 `changes`；带 `returning` 的形状根本进不了 `foldGenerationFenceIntoInsert`）；
  // ③ 本进程已经给这一代记过首次写——否则 `markFirstGenerationWrite` 还得与写同事务，省不掉；
  // ④ SQL 命中最窄的单行 INSERT。
  if (!transactional && method === 'run' && markedGenerations.has(runtime)) {
    if (assertPostgresqlBusinessStatement(compiled) === 'write') {
      const folded = foldGenerationFenceIntoInsert(compiled, parameters.length)
      if (folded !== null) {
        const result = await client.unsafe(folded, [...parameters, runtime.generationId])
        const changes = mutationCount(result)
        // 普通单行 INSERT 必然影响 1 行，所以 0 行只可能是 `WHERE EXISTS` 那一支没过。
        if (changes === 0) {
          throw new PostgresqlGenerationFenceError(
            'PostgreSQL business write rejected by the active database generation fence',
          )
        }
        return { rows: [], changes }
      }
    }
  }
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
