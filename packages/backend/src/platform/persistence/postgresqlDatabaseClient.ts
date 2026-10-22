// RFC-395 I-b —— 原生 bun-sql 查询与事务；连接包装只分类语句，不改写 SQL。
import type { SQL as BunSQL } from 'bun'
import { getTableColumns, is, Placeholder, SQL, sql, type Table } from 'drizzle-orm'
import { drizzle, type BunSQLDatabase } from 'drizzle-orm/bun-sql'
import { nativeTableSets } from '@/db/schema'
import { createPostgresqlCapabilities } from './capabilities'
import { bindDatabaseHandle } from './sessionTables'
import { bindSingleInsert } from './singleInsert'
import { affectedRows } from './queryHelpers'
import type { PersistenceDb } from './persistenceDb'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  PostgresqlTransactionConnection,
  SqlRows,
} from './postgresqlRuntime'
import { assertPostgresqlBusinessStatement } from './postgresqlSql'

export class PostgresqlGenerationFenceError extends Error {
  constructor() {
    super('PostgreSQL business write rejected by the active database generation fence')
    this.name = 'PostgresqlGenerationFenceError'
  }
}
export type PostgresqlDatabaseClient = BunSQLDatabase<typeof nativeTableSets.postgresql> & {
  readonly $provider: 'postgresql'
  readonly $generationId: string
}
/** 部署写闸在同一条预留连接上、每笔事务首次写之前调用一次。 */
export interface PostgresqlDatabaseClientOptions {
  readonly beforeWrite?: (tx: PersistenceDb) => Promise<void>
}
type SqlClient = Pick<PostgresqlPool, 'unsafe'>
interface NativeClient extends SqlClient {
  begin<T>(body: (connection: NativeClient) => Promise<T>): Promise<T>
  savepoint<T>(body: (connection: NativeClient) => Promise<T>): Promise<T>
}
interface WriteState {
  beforeWrite?: Promise<void>
}
const markedGenerations = new WeakSet<PostgresqlDatabaseRuntime>()

// Bun.SQL 的 begin / savepoint 把回调返回的数组过一遍 Promise.all，写结果上的 `count` / `command`
// 随之丢失（事务外的单条写经下面的围栏事务回来，影响行数就成了 0）。值装箱跨过事务边界。
interface Boxed<T> {
  readonly value: T
}
const box = <T>(value: T): Boxed<T> => ({ value })
const unbox = <T>(boxed: Boxed<T>): T => boxed.value

async function assertActiveGeneration(
  connection: SqlClient,
  runtime: PostgresqlDatabaseRuntime,
): Promise<void> {
  const rows = await connection.unsafe(
    'SELECT generation_id FROM "agent_workflow_meta"."database_generations" ' +
      "WHERE generation_id = $1 AND state = 'active'",
    [runtime.generationId],
  )
  if (rows.length !== 1) throw new PostgresqlGenerationFenceError()
}

/** 只设置首次写标记；稳态不再 UPDATE 同一个元数据行，保持既有 SERIALIZABLE 行为。 */
async function markFirstGenerationWrite(
  connection: SqlClient,
  runtime: PostgresqlDatabaseRuntime,
): Promise<void> {
  if (markedGenerations.has(runtime)) return
  const rows = await connection.unsafe(
    'WITH marked AS (' +
      'UPDATE "agent_workflow_meta"."database_generations" ' +
      'SET first_live_write_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint ' +
      "WHERE generation_id = $1 AND state = 'active' AND first_live_write_at IS NULL RETURNING generation_id) " +
      'SELECT generation_id FROM marked UNION ALL ' +
      'SELECT generation_id FROM "agent_workflow_meta"."database_generations" ' +
      "WHERE generation_id = $1 AND state = 'active' AND first_live_write_at IS NOT NULL",
    [runtime.generationId],
  )
  if (rows.length === 1) markedGenerations.add(runtime)
}

/** 构造原生 SQL AST；省略的列由数据库 DEFAULT 求值，不解析/拼修 Drizzle 输出。 */
function fencedInsert(
  table: Table,
  value: Record<string, unknown>,
  generationId: string,
): SQL | undefined {
  const columns = getTableColumns(table)
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  if (
    entries.length === 0 ||
    entries.some(([name, item]) => !columns[name] || is(item, SQL) || is(item, Placeholder))
  )
    return undefined
  const names = entries.map(([name]) => sql.identifier(columns[name]!.name))
  const values = entries.map(([name, item]) => sql.param(item, columns[name]!))
  return sql`insert into ${table} (${sql.join(names, sql`, `)}) select ${sql.join(values, sql`, `)} where exists (select 1 from "agent_workflow_meta"."database_generations" where generation_id = ${generationId} and state = 'active')`
}

export function createPostgresqlDatabaseClient(
  runtime: PostgresqlDatabaseRuntime,
  options: PostgresqlDatabaseClientOptions = {},
): PostgresqlDatabaseClient {
  const pool = runtime.providerPool()
  const engine = createPostgresqlCapabilities()
  const schema = nativeTableSets.postgresql
  // BunSQL's public factory type requires the complete callable SQL class. Drizzle actually uses
  // unsafe/begin/savepoint; this is the single adapter boundary for that closed driver surface.
  const nativeDatabase = (client: SqlClient) =>
    bindDatabaseHandle(drizzle(client as unknown as BunSQL, { schema }), schema, engine)
  const beforeMutation = async (connection: SqlClient, state: WriteState): Promise<void> => {
    if (options.beforeWrite !== undefined) {
      state.beforeWrite ??= options.beforeWrite(nativeDatabase(connection))
      await state.beforeWrite
    }
    await markFirstGenerationWrite(connection, runtime)
    await assertActiveGeneration(connection, runtime)
  }
  const reservedTransaction = async <T>(
    body: (connection: PostgresqlTransactionConnection) => Promise<T>,
  ): Promise<T> => {
    // 先 reserve，再在这条连接上 begin；包含 begin 的池等待也进入 runtime 的 reserve 遥测。
    const connection: PostgresqlReservedConnection = await pool.reserve()
    try {
      return unbox(await connection.begin(async (transaction) => box(await body(transaction))))
    } finally {
      connection.release()
    }
  }
  const clientFor = (
    connection: SqlClient,
    transaction?: { connection: PostgresqlTransactionConnection; state: WriteState },
  ): NativeClient => {
    const client: NativeClient = {
      unsafe(statement, parameters): SqlRows {
        const operation = assertPostgresqlBusinessStatement(statement)
        if (operation !== 'write') return connection.unsafe(statement, parameters)
        const execute = async <T>(read: (executor: SqlClient) => Promise<T>): Promise<T> => {
          if (transaction) {
            await beforeMutation(connection, transaction.state)
            return await read(connection)
          }
          return await reservedTransaction(async (reserved) => {
            await beforeMutation(reserved, {})
            return await read(reserved)
          })
        }
        // Bun.SQL queries are lazy and Drizzle chooses either object rows or values. Preserve that
        // choice through the fence so selected columns still use Drizzle's native result codecs.
        return {
          then(onFulfilled, onRejected) {
            return execute(async (executor) => await executor.unsafe(statement, parameters)).then(
              onFulfilled,
              onRejected,
            )
          },
          values: () =>
            execute(async (executor) => await executor.unsafe(statement, parameters).values()),
        }
      },
      async begin(body) {
        return await reservedTransaction(
          async (reserved) => await body(clientFor(reserved, { connection: reserved, state: {} })),
        )
      },
      async savepoint(body) {
        if (!transaction) throw new Error('PostgreSQL savepoint requires a transaction')
        return unbox(
          await transaction.connection.savepoint(async (nested) =>
            box(await body(clientFor(nested, { connection: nested, state: transaction.state }))),
          ),
        )
      },
    }
    return bindDatabaseHandle(client, schema, engine)
  }
  const db = Object.assign(nativeDatabase(clientFor(pool)), {
    $provider: 'postgresql' as const,
    $generationId: runtime.generationId,
  })
  // 仅普通单行写走这一条原生构造路径；conflict / returning / 多行仍是原来的 builder。
  // 首写标记或部署写闸需要事务时，同样回到 native builder + 分类连接。
  const unfenced = nativeDatabase(pool)
  bindSingleInsert(db, async (table, value, fallback) => {
    if (!markedGenerations.has(runtime) || options.beforeWrite !== undefined)
      return await fallback()
    const query = fencedInsert(table, value, runtime.generationId)
    if (!query) return await fallback()
    const result = await unfenced.execute(query)
    if (affectedRows(result) !== 1) throw new PostgresqlGenerationFenceError()
    return { count: affectedRows(result) }
  })
  return db
}
