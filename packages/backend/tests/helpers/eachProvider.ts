// RFC-359 W5-T19e —— 双引擎测试 harness：**双引擎是缺省**（design.md §11.1）。
//
// `describeEachProvider(name, body)` 把 body 各跑一遍：SQLite 用内存库；PostgreSQL 用
// `AW_TEST_POSTGRESQL_URL`（回退 `RFC357_DATABASE_URL`）指向的真库。PostgreSQL 缺 URL
// **不是 skip 而是 fail**——「无库则跳过」正是 `design/dual-provider-parity-audit-2026-09-04.md`
// 里 12 条 P0 穿过全部验收的机制。本地只想跑 SQLite 时显式 `AW_TEST_PROVIDERS=sqlite`；
// Ubuntu CI 分片带 postgres 服务容器并保持双引擎；macOS 与 Windows 原生平台 lane
// 没有 PostgreSQL 服务，显式选择 sqlite。
//
// body 拿到的是 `DatabaseSession` + `EngineCapabilities` + provider-中立客户端，**拿不到
// provider 名**。测试要按引擎分叉时只能走 capabilities（例如 `isolation === 'exclusive'`）。
//
// 每个用例开始时库是「刚迁移完」的状态：SQLite 每次新建内存库；PostgreSQL 每个文件迁移一次，
// 每个用例前 TRUNCATE 全部业务表并把迁移种下的行原样种回（与 `createInMemoryDb` 的快照语义
// 对齐，含 auth_login_policy 的 bootstrap 标记）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getTableName, isTable } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'

import { createInMemoryDb } from '@/db/client'
import * as schema from '@/db/schema'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import {
  databaseSessionFor,
  type DatabaseSession,
} from '@/platform/persistence/databaseTransaction'
import {
  createPostgresqlDatabaseClient,
  type PostgresqlDatabaseClient,
} from '@/platform/persistence/postgresqlDatabaseClient'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import { MIGRATIONS } from '../migration-freeze'
import {
  recordStatements as recordSqliteStatements,
  type RecordedStatement,
  type StatementRecording,
} from './statementRecorder'

export type TestProvider = 'sqlite' | 'postgresql'

const DEFAULT_PROVIDERS: readonly TestProvider[] = ['sqlite', 'postgresql']
const POSTGRESQL_URL_ENVS = ['AW_TEST_POSTGRESQL_URL', 'RFC357_DATABASE_URL'] as const
const GENERATION_ID = 'dbg_each_provider_harness'
const OPERATION_ID = 'lcop_each_provider_harness'
// 仅新增多库 setup/cleanup 使用独立预算；默认单库 hook 与业务 test 的原超时不变。
const POSTGRESQL_DATABASE_SETUP_TIMEOUT_MS = 60_000
// 为 30s 连接池关闭配置与一次 60s 语句窗口预留顺序清理预算。
const POSTGRESQL_DATABASE_CLEANUP_TIMEOUT_MS = 90_000

/** 纯函数：从环境解析要跑的引擎集合。缺省两个都跑；只接受 sqlite / postgresql。 */
export function resolveTestProviders(
  env: Readonly<Record<string, string | undefined>>,
): readonly TestProvider[] {
  const raw = env['AW_TEST_PROVIDERS']
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PROVIDERS
  const out: TestProvider[] = []
  for (const part of raw.split(',')) {
    const name = part.trim()
    if (name.length === 0) continue
    if (name !== 'sqlite' && name !== 'postgresql') {
      throw new Error(`AW_TEST_PROVIDERS 只接受 sqlite / postgresql（逗号分隔），收到 '${name}'`)
    }
    if (!out.includes(name)) out.push(name)
  }
  if (out.length === 0) {
    throw new Error('AW_TEST_PROVIDERS 至少要列出一个引擎；不设它就是双引擎缺省')
  }
  return out
}

/** 持有 PostgreSQL URL 的环境变量**名**（runtime 按名读 URL，不接受裸 URL）。 */
export function resolvePostgresqlTestUrlEnv(
  env: Readonly<Record<string, string | undefined>>,
): (typeof POSTGRESQL_URL_ENVS)[number] | undefined {
  return POSTGRESQL_URL_ENVS.find((name) => (env[name] ?? '').length > 0)
}

export interface ProviderDatabaseHarness {
  /** provider-中立客户端：两个引擎上是同一套 drizzle query builder。 */
  readonly db: ProviderNeutralDatabase
  readonly session: DatabaseSession
  readonly capabilities: EngineCapabilities
  /** 仅测试夹具的 DDL：经本库 native/runtime 执行，不走业务客户端的 SQL 编译器。 */
  executeFixtureDdl(statement: string): Promise<void>
  /**
   * RFC-359 W6-T27 —— 录制其后**实际执行**的每条语句（含绑定参数与取回行数），两个引擎
   * 同一形状。SQLite 包 bun:sqlite 连接，PostgreSQL 包连接池，因此 drizzle 与裸 SQL
   * 两条路都抓得到。`stop()` 结束录制。
   *
   * 性能守卫靠它做「语句条数不随行数增长」「取回行数有界」这类**确定性**判据——
   * 那是比墙钟毫秒稳得多的性能形状信号（`docs/audit-backlog.md` §O(k²) 守卫那条）。
   */
  recordStatements(): StatementRecording
  /**
   * 取一条已录到的语句在**当前引擎**上的执行计划文本。
   * SQLite 渲染 `EXPLAIN QUERY PLAN`，PostgreSQL 渲染 `EXPLAIN`；两侧都带**真实绑定参数**
   * ——字面量 / NULL 占位下引擎会选出生产里根本不存在的计划（RFC-311 实测）。
   * 引擎解释不了的语句返回空串，调用方据此跳过而不是假装审计过。
   */
  explain(statement: RecordedStatement): Promise<string>
}

export interface ProviderHarness extends ProviderDatabaseHarness {
  /** 同一个所选 provider 的独立真库；原有端口始终指向第 0 库。 */
  database(index: number): ProviderDatabaseHarness
}

export interface DescribeEachProviderOptions {
  /** 同 `createInMemoryDb` 的 `bootstrap`：'required' 时不把 auth_login_policy 标成已 bootstrap。 */
  readonly bootstrap?: 'required'
  /** 在 setup 中创建的独立数据库数量；每个用例分别重置，默认 1。 */
  readonly databaseCount?: number
}

interface HarnessState {
  db?: ProviderNeutralDatabase
  session?: DatabaseSession
  record?: () => StatementRecording
  explain?: (statement: RecordedStatement) => Promise<string>
  fixtureDdl?: (statement: string) => Promise<void>
}

function databaseView(state: HarnessState): ProviderDatabaseHarness {
  const current = <K extends keyof HarnessState>(key: K): NonNullable<HarnessState[K]> => {
    const value = state[key]
    if (value === undefined) {
      throw new Error('ProviderHarness 只能在 test 体内读取（beforeEach 之后才有库）')
    }
    return value as NonNullable<HarnessState[K]>
  }
  return Object.freeze({
    get db() {
      return current('db')
    },
    get session() {
      return current('session')
    },
    get capabilities() {
      return current('session').engine
    },
    recordStatements: () => current('record')(),
    explain: async (statement: RecordedStatement) => await current('explain')(statement),
    executeFixtureDdl: async (statement: string) => await current('fixtureDdl')(statement),
  })
}

function harnessView(states: readonly HarnessState[]): ProviderHarness {
  const databases = states.map(databaseView)
  const primary = databases[0]!
  return Object.freeze({
    get db() {
      return primary.db
    },
    get session() {
      return primary.session
    },
    get capabilities() {
      return primary.capabilities
    },
    recordStatements: () => primary.recordStatements(),
    explain: async (statement: RecordedStatement) => await primary.explain(statement),
    executeFixtureDdl: async (statement: string) => await primary.executeFixtureDdl(statement),
    database(index: number) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= databases.length) {
        throw new RangeError(`ProviderHarness database index 必须在 0..${databases.length - 1}`)
      }
      return databases[index]!
    },
  })
}

function clearState(state: HarnessState): void {
  state.db = undefined
  state.session = undefined
  state.record = undefined
  state.explain = undefined
  state.fixtureDdl = undefined
}

/** SQLite 的计划文本：`EXPLAIN QUERY PLAN` 的 detail 列逐行拼起来。 */
function sqliteExplain(db: ProviderNeutralDatabase, statement: RecordedStatement): string {
  const raw = (
    db as unknown as {
      $client: {
        prepare(query: string): { all(...args: unknown[]): unknown[]; finalize(): void }
      }
    }
  ).$client
  try {
    const prepared = raw.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    try {
      const rows = prepared.all(...statement.values) as { detail: string }[]
      return rows.map((row) => row.detail).join('\n')
    } finally {
      // EXPLAIN 的句柄也必须释放，否则后续 DROP TABLE 会遇到 SQLITE_LOCKED。
      prepared.finalize()
    }
  } catch {
    // CTE 里的临时构造等 EXPLAIN 解释不了的语句：返回空串，调用方跳过。
    return ''
  }
}

/**
 * 同一段断言在每个引擎上各跑一遍。describe 名后缀 `[sqlite]` / `[postgresql]` 只出现在报告里，
 * body 本身看不见 provider。
 */
export function describeEachProvider(
  name: string,
  body: (harness: ProviderHarness) => void,
  options: DescribeEachProviderOptions = {},
): void {
  const databaseCount = options.databaseCount === undefined ? 1 : options.databaseCount
  if (!Number.isSafeInteger(databaseCount) || databaseCount < 1) {
    throw new RangeError('DescribeEachProviderOptions.databaseCount 必须是正安全整数')
  }
  for (const provider of resolveTestProviders(process.env)) {
    describe(`${name} [${provider}]`, () => {
      if (provider === 'sqlite') registerSqlite(body, options, databaseCount)
      else registerPostgresql(body, options, databaseCount)
    })
  }
}

function registerSqlite(
  body: (harness: ProviderHarness) => void,
  options: DescribeEachProviderOptions,
  databaseCount: number,
): void {
  const states: HarnessState[] = Array.from({ length: databaseCount }, () => ({}))
  let restoreProvider: (() => void) | undefined
  beforeEach(() => {
    // 进程级 schema 投影是全局的：显式选 sqlite，用完还原，不依赖 describe 的先后顺序。
    restoreProvider = selectDatabaseSchemaProvider('sqlite')
    try {
      for (const state of states) {
        const db = createInMemoryDb(
          MIGRATIONS,
          options.bootstrap === undefined ? {} : { bootstrap: options.bootstrap },
        )
        state.db = db
        state.session = databaseSessionFor(db)
        state.record = () => recordSqliteStatements((db as unknown as { $client: never }).$client)
        state.explain = async (statement) => sqliteExplain(db, statement)
        state.fixtureDdl = async (statement) => {
          ;(db as unknown as { $client: { exec(statement: string): void } }).$client.exec(statement)
        }
      }
    } catch (error) {
      restoreProvider?.()
      restoreProvider = undefined
      states.forEach(clearState)
      throw error
    }
  })
  afterEach(() => {
    restoreProvider?.()
    restoreProvider = undefined
    states.forEach(clearState)
  })
  body(harnessView(states))
}

interface PostgresqlSeed {
  readonly table: string
  /** 迁移刚种下的行，json 数组文本；每个用例前原样种回。 */
  readonly rowsJson: string
}

interface PostgresqlSchemaSnapshot {
  readonly tables: readonly string[]
  readonly seeds: readonly PostgresqlSeed[]
  readonly hasLoginPolicy: boolean
}

type RawQuery = (query: string, parameters?: readonly unknown[]) => Promise<unknown>

async function rows(raw: RawQuery, query: string): Promise<Record<string, unknown>[]> {
  return (await raw(query)) as Record<string, unknown>[]
}

async function snapshotSchema(raw: RawQuery): Promise<PostgresqlSchemaSnapshot> {
  const tables = (
    await rows(
      raw,
      "select tablename from pg_tables where schemaname = 'agent_workflow' order by tablename",
    )
  ).map((row) => String(row['tablename']))
  const seeds: PostgresqlSeed[] = []
  for (const table of tables) {
    const [row] = await rows(
      raw,
      `select coalesce(json_agg(t), '[]'::json)::text as rows_json from "agent_workflow"."${table}" t`,
    )
    const rowsJson = String(row?.['rows_json'] ?? '[]')
    if (rowsJson !== '[]') seeds.push({ table, rowsJson })
  }
  return {
    tables,
    seeds,
    hasLoginPolicy: tables.includes('auth_login_policy'),
  }
}

async function resetToSnapshot(
  raw: RawQuery,
  snapshot: PostgresqlSchemaSnapshot,
  options: DescribeEachProviderOptions,
): Promise<void> {
  if (snapshot.tables.length === 0) return
  await raw(
    `truncate table ${snapshot.tables
      .map((table) => `"agent_workflow"."${table}"`)
      .join(', ')} restart identity cascade`,
  )
  for (const seed of snapshot.seeds) {
    // 不走绑定参数：Bun.SQL 会把字符串参数按 json 类型二次序列化成 JSON 标量（"[...]"），
    // json_populate_recordset 收到的就不是数组。用带唯一标签的美元引号把数组文本内联进去。
    if (seed.rowsJson.includes('$aw_seed$')) {
      throw new Error(`seed rows for ${seed.table} contain the dollar-quote tag`)
    }
    await raw(
      `insert into "agent_workflow"."${seed.table}" ` +
        `select * from json_populate_recordset(null::"agent_workflow"."${seed.table}", ` +
        `$aw_seed$${seed.rowsJson}$aw_seed$::json)`,
    )
  }
  if (options.bootstrap !== 'required' && snapshot.hasLoginPolicy) {
    await raw(
      `update "agent_workflow"."auth_login_policy" ` +
        `set bootstrap_completed_at = coalesce(bootstrap_completed_at, 0) where id = 'global'`,
    )
  }
}

type SchemaTable = Parameters<typeof getTableConfig>[0]

/** 迁移刚种下的行：按外键拓扑顺序从 SQLite 内存库整表复制到 PostgreSQL。 */
async function seedFromSqliteSnapshot(target: ProviderNeutralDatabase): Promise<void> {
  const restoreForRead = selectDatabaseSchemaProvider('sqlite')
  const source = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
  const pending: Array<{
    name: string
    table: SchemaTable
    rows: Record<string, unknown>[]
    refs: string[]
  }> = []
  try {
    for (const candidate of Object.values(schema)) {
      if (!isTable(candidate)) continue
      const table = candidate as SchemaTable
      const rows = source.select().from(table).all() as Record<string, unknown>[]
      if (rows.length === 0) continue
      const refs = getTableConfig(table).foreignKeys.map((fk) =>
        getTableName(fk.reference().foreignTable),
      )
      pending.push({ name: getTableName(table), table, rows, refs })
    }
  } finally {
    restoreForRead()
  }
  const restoreForWrite = selectDatabaseSchemaProvider('postgresql')
  try {
    const seeded = new Set<string>()
    const names = new Set(pending.map((entry) => entry.name))
    while (pending.length > 0) {
      let progressed = false
      for (const entry of [...pending]) {
        const ready = entry.refs.every(
          (ref) => ref === entry.name || seeded.has(ref) || !names.has(ref),
        )
        if (!ready) continue
        for (let offset = 0; offset < entry.rows.length; offset += 200) {
          await target.insert(entry.table).values(entry.rows.slice(offset, offset + 200))
        }
        seeded.add(entry.name)
        pending.splice(pending.indexOf(entry), 1)
        progressed = true
      }
      if (!progressed) {
        throw new Error(
          `seed tables form a foreign-key cycle: ${pending.map((entry) => entry.name).join(', ')}`,
        )
      }
    }
  } finally {
    restoreForWrite()
  }
}

/** PostgreSQL 的计划文本：`EXPLAIN`，带**真实**绑定参数（NULL 占位会选出别的计划）。 */
async function postgresqlExplain(raw: RawQuery, statement: RecordedStatement): Promise<string> {
  try {
    const rows = (await raw(`EXPLAIN ${statement.sql}`, statement.values)) as Record<
      string,
      unknown
    >[]
    return rows.map((row) => String(row['QUERY PLAN'])).join('\n')
  } catch {
    // 引擎解释不了的语句：返回空串，调用方跳过而不是假装审计过。
    return ''
  }
}

/**
 * 把 runtime 的连接池换成带录制的那一个。录制的是**连接**（池 + 预留连接）而不是 drizzle，
 * 所以 query builder 与裸 SQL 两条路都抓得到——与 SQLite 侧 `recordStatements` 同一层。
 */
function recordingRuntime(
  runtime: PostgresqlDatabaseRuntime,
  sinks: ReadonlySet<RecordedStatement[]>,
): PostgresqlDatabaseRuntime {
  const pool = runtime.providerPool()
  const wrap =
    (original: (query: string, parameters?: readonly unknown[]) => never) =>
    (query: string, parameters?: readonly unknown[]) => {
      if (sinks.size === 0) return original(query, parameters)
      const pending = original(query, parameters) as unknown as PromiseLike<unknown> & {
        values(): Promise<readonly unknown[]>
      }
      const push = (rows: number): void => {
        for (const sink of sinks) {
          sink.push({
            sql: query,
            params: parameters?.length ?? 0,
            rows,
            values: parameters ?? [],
          })
        }
      }
      return {
        then: (onOk: (value: unknown) => unknown, onError?: (error: unknown) => unknown) =>
          pending.then((rows) => {
            push(Array.isArray(rows) ? rows.length : 0)
            return onOk(rows)
          }, onError),
        values: async () => {
          const rows = await pending.values()
          push(rows.length)
          return rows
        },
      } as never
    }
  const recordingPool = {
    ...pool,
    unsafe: wrap(pool.unsafe.bind(pool) as never),
    reserve: async (poolOptions?: { readonly signal?: AbortSignal }) => {
      const connection = await pool.reserve(poolOptions)
      return {
        ...connection,
        unsafe: wrap(connection.unsafe.bind(connection) as never),
        release: () => connection.release(),
      }
    },
    close: (closeOptions?: { readonly timeout?: number }) => pool.close(closeOptions),
  }
  return { ...runtime, providerPool: () => recordingPool } as PostgresqlDatabaseRuntime
}

interface PostgresqlHarnessDatabase {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly client: PostgresqlDatabaseClient
  readonly raw: RawQuery
  readonly snapshot: PostgresqlSchemaSnapshot
  readonly sinks: Set<RecordedStatement[]>
}

/** 每个真库都走原有的一次初始化：迁移、生成代、迁移种子与录制客户端。 */
async function createPostgresqlHarnessDatabase(
  urlEnv: (typeof POSTGRESQL_URL_ENVS)[number],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<PostgresqlHarnessDatabase> {
  const sinks = new Set<RecordedStatement[]>()
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv,
      // RFC-359 W6-T27 实撞：**并发扇出宽于 poolMax 时，排队的那条查询会挂死**。
      // 现场（本文件此前用 poolMax: 4）：`/api/overview` 的 `Promise.all` 一次发 13 条
      // count（9 条资源计数 + 内层 4 条任务状态计数），其中一条永远拿不到连接，一直挂到
      // 连接池的 idle timeout 才以 `ERR_POSTGRES_IDLE_TIMEOUT` 抛出——把 idleTimeoutMs
      // 从 30s 调到 10min，挂死时间就跟着变成 10min（错误文案里的时长是**设置值**，不是
      // 真实空闲时长）。同一段代码在 poolMax=16 下 12 轮全绿、每轮 4ms。
      // 这里取 16 —— 与生产默认（`shared/src/schemas/config.ts` 的 `poolMax.default(16)`）
      // 一致，harness 因此也更像生产。**注意这只是把 harness 挪出雷区，不是修复**：
      // 平台侧没有任何「取连接超时」上界，poolMax 被配小（schema 允许到 1）或将来出现更宽的
      // 扇出，生产上就会复现同一个挂死。
      poolMax: 16,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    },
    generationId: GENERATION_ID,
    ...(env === undefined ? {} : { env }),
  })
  try {
    const pool = runtime.providerPool()
    const query: RawQuery = async (text, parameters) =>
      parameters === undefined ? await pool.unsafe(text) : await pool.unsafe(text, [...parameters])
    // 与 rfc357 / rfc359 的真库用例同一套姿势：清干净、按基线迁移、自己登记一个活跃生成代
    // （客户端的业务写围栏按 runtime.generationId 核对 database_generations）。
    await query('drop schema if exists agent_workflow cascade')
    await query('drop schema if exists agent_workflow_meta cascade')
    await migratePostgresqlSchema({ runtime })
    await query(
      'insert into "agent_workflow_meta"."logical_copy_operations" ' +
        '(operation_id, source_generation_id, contract_digest, plan_digest, stage, created_at, updated_at) ' +
        `values ('${OPERATION_ID}', 'dbg_each_provider_source', 'digest', 'plan', 'prepared', 1, 1)`,
    )
    await query(
      'insert into "agent_workflow_meta"."database_generations" ' +
        '(generation_id, operation_id, source_generation_id, contract_digest, state, activated_at, first_live_write_at) ' +
        `values ('${GENERATION_ID}', '${OPERATION_ID}', 'dbg_each_provider_source', 'digest', 'active', 1, 1)`,
    )
    // createPostgresqlDatabaseClient 会把进程级投影切到 postgresql 且不还原；afterAll 统一还原。
    // 客户端拿到的是**带录制的**连接池：连接池对象是冻结的（Proxy 无法为不可写属性返回
    // 别的值），所以走对象字面量重建，而不是 Proxy。
    const client = createPostgresqlDatabaseClient(recordingRuntime(runtime, sinks))
    // PostgreSQL 的迁移器只投影 DDL；迁移脚本里 INSERT 的种子行（committed_event_family_cutovers、
    // auth_login_policy、框架内置资源……）在生产上是随 RFC-349 逻辑复制从 SQLite 带过来的。
    // 这里做同一件事：把一个刚迁移完的 SQLite 内存库整表复制进来，两个引擎的「起点」才是同一个。
    await seedFromSqliteSnapshot(client)
    const snapshot = await snapshotSchema(query)
    return { runtime, client, raw: query, snapshot, sinks }
  } catch (error) {
    try {
      await runtime.close()
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'PostgreSQL harness setup and close failed')
    }
    throw error
  }
}

export async function closePostgresqlHarnessDatabases(
  databases: readonly {
    readonly runtime: Pick<PostgresqlDatabaseRuntime, 'close'>
    readonly raw: RawQuery
  }[],
  createdDatabaseNames: readonly string[],
): Promise<void> {
  const errors: unknown[] = []
  for (const [index, database] of [...databases.entries()].slice(1).reverse()) {
    try {
      await database.runtime.close()
    } catch (error) {
      errors.push(
        new Error(`PostgreSQL harness cleanup: close additional runtime at index ${index}`, {
          cause: error,
        }),
      )
    }
  }
  const primary = databases[0]
  if (primary !== undefined) {
    // 这里只清理本次成功 CREATE 的附加库；主 URL 指向的库从不被 DROP。
    for (const name of [...createdDatabaseNames].reverse()) {
      try {
        await primary.raw(`drop database if exists "${name}"`)
      } catch (error) {
        errors.push(
          new Error(`PostgreSQL harness cleanup: drop additional database ${name}`, {
            cause: error,
          }),
        )
      }
    }
    try {
      await primary.runtime.close()
    } catch (error) {
      errors.push(new Error('PostgreSQL harness cleanup: close primary runtime', { cause: error }))
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'PostgreSQL harness cleanup failed')
}

function registerPostgresql(
  body: (harness: ProviderHarness) => void,
  options: DescribeEachProviderOptions,
  databaseCount: number,
): void {
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  if (urlEnv === undefined) {
    // 设计上的硬判据：缺库即红，不是 skip。
    test('PostgreSQL 未配置——双引擎是缺省，缺库即红', () => {
      throw new Error(
        '把 AW_TEST_POSTGRESQL_URL（或 RFC357_DATABASE_URL）指向一个可以被整个清空的 PostgreSQL 库；' +
          '只想跑 SQLite 时显式 AW_TEST_PROVIDERS=sqlite（Ubuntu CI 保持双引擎）',
      )
    })
    return
  }
  const states: HarnessState[] = Array.from({ length: databaseCount }, () => ({}))
  const databases: PostgresqlHarnessDatabase[] = []
  const createdDatabaseNames: string[] = []
  let providerBefore: ReturnType<typeof currentDatabaseSchemaProvider> | undefined
  let restoreProvider: (() => void) | undefined
  let initialization: Promise<void> | undefined
  let cleanup: Promise<void> | undefined
  const closeAll = () =>
    (cleanup ??= closePostgresqlHarnessDatabases(databases, createdDatabaseNames))

  const initializeDatabases = async (): Promise<void> => {
    providerBefore = currentDatabaseSchemaProvider()
    try {
      const sourceUrl = process.env[urlEnv]
      const primary = await createPostgresqlHarnessDatabase(urlEnv)
      databases.push(primary)
      for (let index = 1; index < databaseCount; index += 1) {
        const name = `aw_each_provider_${randomUUID().replaceAll('-', '')}`
        await primary.raw(`create database "${name}"`)
        createdDatabaseNames.push(name)
        const url = new URL(sourceUrl!)
        url.pathname = `/${name}`
        databases.push(await createPostgresqlHarnessDatabase(urlEnv, { [urlEnv]: url.toString() }))
      }
    } catch (error) {
      try {
        await closeAll()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'PostgreSQL harness setup cleanup failed')
      } finally {
        if (providerBefore !== undefined) selectDatabaseSchemaProvider(providerBefore)
      }
      throw error
    }
  }
  const setupDatabases = () => (initialization ??= initializeDatabases())
  if (databaseCount === 1) beforeAll(setupDatabases)
  else beforeAll(setupDatabases, databaseCount * POSTGRESQL_DATABASE_SETUP_TIMEOUT_MS)

  beforeEach(async () => {
    if (databases.length !== databaseCount) {
      throw new Error('PostgreSQL harness 未完成装配（beforeAll 失败）')
    }
    restoreProvider = selectDatabaseSchemaProvider('postgresql')
    try {
      for (const [index, database] of databases.entries()) {
        const { client, raw, snapshot, sinks } = database
        await resetToSnapshot(raw, snapshot, options)
        const state = states[index]!
        const query = raw
        state.db = client
        state.session = databaseSessionFor(client)
        state.record = () => {
          const statements: RecordedStatement[] = []
          sinks.add(statements)
          return {
            statements,
            selects: () => statements.filter((statement) => /^\s*select/i.test(statement.sql)),
            stop: () => sinks.delete(statements),
          }
        }
        state.explain = async (statement) => await postgresqlExplain(query, statement)
        state.fixtureDdl = async (statement) => {
          await query(statement)
        }
      }
    } catch (error) {
      restoreProvider?.()
      restoreProvider = undefined
      databases.forEach(({ sinks }) => sinks.clear())
      states.forEach(clearState)
      throw error
    }
  })

  afterEach(() => {
    restoreProvider?.()
    restoreProvider = undefined
    databases.forEach(({ sinks }) => sinks.clear())
    states.forEach(clearState)
  })

  const cleanupDatabases = async (): Promise<void> => {
    try {
      // Hook 超时不取消初始化 Promise；等它收束，避免关闭主库后仍产生未登记的子 runtime。
      await initialization?.catch(() => undefined)
      await closeAll()
    } finally {
      if (providerBefore !== undefined) selectDatabaseSchemaProvider(providerBefore)
    }
  }
  if (databaseCount === 1) afterAll(cleanupDatabases)
  else afterAll(cleanupDatabases, databaseCount * POSTGRESQL_DATABASE_CLEANUP_TIMEOUT_MS)

  body(harnessView(states))
}
