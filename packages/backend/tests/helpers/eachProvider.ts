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
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { getTableName, isTable } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'

import { createInMemoryDb, type DbClient, registerLegacyDaemonTestFixture } from '@/db/client'
import type { DatabaseConfig } from '@agent-workflow/shared'
import * as schema from '@/db/schema'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { isPostgresqlSerializationFailure } from '@/platform/persistence/postgresqlSerializationRetry'
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
  type InstrumentedPostgresqlDatabaseRuntime,
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
/**
 * 每个用例前的快照回滚预算。**必须显式给**：这个 `beforeEach` 做的是对一台真实
 * PostgreSQL 的整库快照恢复，而 bun 的默认 hook 预算是 5s——`beforeAll` / `afterAll`
 * 早就各自显式给了 60s / 90s，只有它一直吃默认值。CI 上 runner 一忙（同 job 里还并行着
 * 别的分片），一次回滚偶尔越过 5s，于是随机某个用例以
 * 「a beforeEach/afterEach hook timed out for this test」收场——与被测代码无关，
 * 2026-09-11 的 real-PostgreSQL 泳道就是这么红的（`rfc359-w14-legacy-mission-execution`）。
 * 判据不变（超时仍然会失败），变的只是预算与它实际要做的事相称。
 */
const POSTGRESQL_DATABASE_RESET_TIMEOUT_MS = 30_000

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

/** Application composition receives the actual selected mechanism, never a cast of the ORM client. */
export type ProviderApplicationBinding =
  | Readonly<{ provider: 'sqlite'; db: DbClient }>
  | Readonly<{
      provider: 'postgresql'
      db: PostgresqlDatabaseClient
      runtime: InstrumentedPostgresqlDatabaseRuntime
      databaseConfig: Extract<DatabaseConfig, { provider: 'postgresql' }>
    }>

export interface ProviderDatabaseHarness {
  /** provider-中立客户端：两个引擎上是同一套 drizzle query builder。 */
  readonly db: ProviderNeutralDatabase
  readonly session: DatabaseSession
  readonly capabilities: EngineCapabilities
  /** Bootstrap-only test composition; the runtime and client share the original recorded pool. */
  readonly applicationBinding: ProviderApplicationBinding
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
  readonly lifecycleDiagnostics?: Readonly<{ sourceFile: string }>
}

export interface ProviderHarnessLifecycleIdentity {
  readonly sourceFile: string
  readonly suite: string
}

export interface ProviderHarnessLifecycleRecord {
  readonly phase: string
  readonly state: 'enter' | 'fulfilled' | 'rejected'
  readonly atMs: number
  readonly errorCode?: string | number
}

export interface ProviderHarnessLifecycleEvent extends ProviderHarnessLifecycleIdentity {
  readonly groupId: number
  readonly operationId: string
  readonly kind: 'near-deadline' | 'rejected' | 'settled'
  readonly elapsedMs: number
  readonly events: readonly ProviderHarnessLifecycleRecord[]
}

export interface ProviderHarnessLifecyclePorts {
  now(): number
  schedule(callback: () => void, delayMs: number): { unref(): void; clear(): void }
  report(event: ProviderHarnessLifecycleEvent): void
}

export interface ProviderHarnessLifecyclePhase {
  run<T>(phase: string, operation: () => T): T
}

export interface ProviderHarnessLifecycleObserver {
  run<T>(phase: string, operation: (context: ProviderHarnessLifecyclePhase) => T): T
}

let providerHarnessLifecycleGroup = 0

/** Passive metadata only: the 4750ms observation threshold does not replace a hook timeout. */
export function createProviderHarnessLifecycleObserver(
  identity: ProviderHarnessLifecycleIdentity,
  ports: ProviderHarnessLifecyclePorts = {
    now: () => performance.now(),
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs)
      return {
        unref: () => {
          timer.unref()
        },
        clear: () => clearTimeout(timer),
      }
    },
    report: (event) => console.warn('[each-provider-lifecycle]', JSON.stringify(event)),
  },
): ProviderHarnessLifecycleObserver {
  const groupId = ++providerHarnessLifecycleGroup
  let invocation = 0
  const safely = (operation: () => void) => {
    try {
      operation()
    } catch {
      /* Observation cannot change the original operation. */
    }
  }
  const now = () => {
    try {
      return ports.now()
    } catch {
      return 0
    }
  }
  const codeOf = (error: unknown): string | number | undefined => {
    try {
      if (typeof error !== 'object' || error === null) return undefined
      const code: unknown = Reflect.get(error, 'code')
      return typeof code === 'string' || typeof code === 'number' ? code : undefined
    } catch {
      return undefined
    }
  }
  return {
    run<T>(phase: string, operation: (context: ProviderHarnessLifecyclePhase) => T): T {
      const operationId = `${groupId}:${++invocation}`
      const startedAt = now()
      const events: ProviderHarnessLifecycleRecord[] = []
      let reported = false
      let settled = false
      let timer: ReturnType<ProviderHarnessLifecyclePorts['schedule']> | undefined
      const record = (
        name: string,
        state: ProviderHarnessLifecycleRecord['state'],
        error?: unknown,
      ) => {
        safely(() => {
          if (events.length === 64) events.splice(1, 1)
          const errorCode = state === 'rejected' ? codeOf(error) : undefined
          events.push({
            phase: name,
            state,
            atMs: now(),
            ...(errorCode === undefined ? {} : { errorCode }),
          })
        })
      }
      const report = (kind: ProviderHarnessLifecycleEvent['kind']) => {
        reported = true
        safely(() =>
          ports.report({
            ...identity,
            groupId,
            operationId,
            kind,
            elapsedMs: Math.max(0, now() - startedAt),
            events: [...events],
          }),
        )
      }
      const finish = (
        name: string,
        root: boolean,
        state: 'fulfilled' | 'rejected',
        error?: unknown,
      ) => {
        record(name, state, error)
        if (!root) return
        settled = true
        safely(() => timer?.clear())
        if (state === 'rejected') report('rejected')
        else if (reported) report('settled')
      }
      const observe = <R>(name: string, root: boolean, original: () => R): R => {
        record(name, 'enter')
        let value: R
        try {
          value = original()
        } catch (error) {
          finish(name, root, 'rejected', error)
          throw error
        }
        // All observed async boundaries are native async-function Promises, never raw driver thenables.
        if (value instanceof Promise) {
          safely(() => {
            void value.then(
              () => {
                finish(name, root, 'fulfilled')
              },
              (error: unknown) => {
                finish(name, root, 'rejected', error)
              },
            )
          })
        } else finish(name, root, 'fulfilled')
        return value
      }
      safely(() => {
        timer = ports.schedule(() => {
          if (!settled) report('near-deadline')
        }, 4_750)
        try {
          timer.unref()
        } catch {
          safely(() => timer?.clear())
        }
      })
      const context: ProviderHarnessLifecyclePhase = {
        run: (name, original) => observe(name, false, original),
      }
      return observe(phase, true, () => operation(context))
    },
  }
}

function runProviderHarnessLifecycle<T>(
  observer: ProviderHarnessLifecycleObserver | undefined,
  phase: string,
  operation: (context?: ProviderHarnessLifecyclePhase) => T,
): T {
  return observer === undefined ? operation(undefined) : observer.run(phase, operation)
}

function runProviderHarnessLifecycleStep<T>(
  context: ProviderHarnessLifecyclePhase | undefined,
  phase: string,
  operation: () => T,
): T {
  return context === undefined ? operation() : context.run(phase, operation)
}

/** Bind an explicit caller without changing the original two-argument suite registrations. */
export function bindDescribeEachProviderLifecycle(
  diagnostics: Readonly<{ sourceFile: string }>,
): typeof describeEachProvider {
  return (name, body, options = {}) =>
    describeEachProvider(name, body, {
      ...options,
      lifecycleDiagnostics: diagnostics,
    })
}

interface HarnessState {
  db?: ProviderNeutralDatabase
  applicationBinding?: ProviderApplicationBinding
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
    get applicationBinding() {
      return current('applicationBinding')
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
    get applicationBinding() {
      return primary.applicationBinding
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
  state.applicationBinding = undefined
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
      else registerPostgresql(body, options, databaseCount, name)
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
        state.applicationBinding = Object.freeze({ provider: 'sqlite', db })
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

/**
 * RFC-359 —— 夹具复位的 `TRUNCATE` 要能扛住 `40P01`。
 *
 * 每文件一库消掉的是**跨文件**的争用；文件**内部**这一条还在：`createProviderHttpApplication`
 * 起的是真 HTTP 应用，维护 ticker 之类的后台作业会在用例之间继续读表。`TRUNCATE` 要在一条语句里
 * 拿下全部表的 AccessExclusiveLock，而后台读者手上已经攥着其中一张的 AccessShareLock 又要去拿
 * 另一张——锁序相反，PostgreSQL 判定 40P01 并挑一边杀掉。2026-09-11 CI ubuntu shard 6 实撞
 * （`tasks-multipart.test.ts`，两个 backend 在同一个库里对着 210529 / 210550 互等）。
 *
 * 40P01 是 PostgreSQL 明确要求调用方重试的错（同 40001，仓内 `retryPostgresqlSerialization`
 * 就是那一条的既有处置）。这里做**有界**重试：后台读者的那条语句最多跑到它自己结束，
 * 重试一次通常就拿得到锁。**不是「重跑就过了」**——被重试的是一条幂等的夹具 DDL，不是判据；
 * 次数用尽仍然原样抛出，红照样是红；非 40001/40P01 的错**一次都不重试**。
 *
 * 判据在 `tests/rfc359-w8-harness-truncate-retry.test.ts`（纯函数四条：一次成功 / 重试后成功 /
 * 非序列化错立即抛 / 预算耗尽照抛）。
 */
export async function retryOnPostgresqlSerializationFailure<T>(
  run: () => Promise<T>,
  options: {
    readonly maxAttempts: number
    readonly sleep: (ms: number) => Promise<void>
  },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= options.maxAttempts || !isPostgresqlSerializationFailure(error)) throw error
      await options.sleep(25 * attempt)
    }
  }
}

const HARNESS_TRUNCATE_ATTEMPTS = 4

async function truncateAll(raw: RawQuery, tables: readonly string[]): Promise<void> {
  const statement =
    `truncate table ${tables.map((table) => `"agent_workflow"."${table}"`).join(', ')} ` +
    `restart identity cascade`
  await retryOnPostgresqlSerializationFailure(async () => await raw(statement), {
    maxAttempts: HARNESS_TRUNCATE_ATTEMPTS,
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  })
}

async function resetToSnapshot(
  raw: RawQuery,
  snapshot: PostgresqlSchemaSnapshot,
  options: DescribeEachProviderOptions,
): Promise<void> {
  if (snapshot.tables.length === 0) return
  await truncateAll(raw, snapshot.tables)
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
  runtime: InstrumentedPostgresqlDatabaseRuntime,
  sinks: ReadonlySet<RecordedStatement[]>,
): InstrumentedPostgresqlDatabaseRuntime {
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
  return { ...runtime, providerPool: () => recordingPool } as InstrumentedPostgresqlDatabaseRuntime
}

async function closeQuietly(connection: PostgresqlHarnessDropConnection): Promise<void> {
  try {
    await connection.close({ timeout: 5 })
  } catch {
    // 关闭失败不改变调用方的结果；连接终会被服务端回收。
  }
}

/**
 * RFC-359 W8 —— **每个测试文件一个 PostgreSQL 数据库**。
 *
 * 症状（合一前）：CI 的 `[postgresql]` 分片间歇报 `40P01 deadlock detected`，现场永远是
 * 「一边等 AccessExclusiveLock、另一边等 AccessShareLock」——前者是本文件 `beforeEach` 的
 * `TRUNCATE`，后者是**上一个测试文件还没排空的读**。成因是文件边界的重叠：`bun test --isolate`
 * 一个文件一个进程、基本顺序跑，但上一个文件的 afterAll / 连接池排空与下一个文件的 beforeAll
 * 会短暂交叠，而整个 lane 此前**共用同一个库**。比锁更严重的是另一半：重叠期间
 * `TRUNCATE … CASCADE` 会把另一个文件正在用的行整表清掉。
 *
 * 处置：每个 `describeEachProvider` 注册面在 beforeAll 建一个自己的库、afterAll 删掉。
 * 三样东西因此**结构上**分开，不再需要任何互斥：
 *   · 数据（`TRUNCATE` 只影响自己的库）；
 *   · DDL 锁（AccessExclusiveLock 按库）；
 *   · advisory lock（PostgreSQL 的 advisory lock **按数据库**——2026-09-11 实测更正了
 *     此前「集群级」的记载，见 `docs/dev-gotchas.md`；迁移器的 schema 准备锁因此也不再跨文件争用）。
 *
 * 成本实测：`CREATE DATABASE` ~83ms，而**迁移开销不是增量**——harness 本来就在每个文件
 * `drop schema … cascade` + 跑一次完整迁移（PG-only 单断言文件端到端 1.57–1.69s，
 * SQLite-only 0.54–0.55s，差出来的 ~1.05s 就是那份已经在付的开销）。改成每文件一库只是把它
 * 跑在自己的库上。选型过程见 `docs/audit-backlog.md`。
 *
 * 泄漏：进程被 kill 时库会留下。名字带 pid，建库前先 `drop if exists` 同名库（pid 复用即自愈）；
 * CI 的 PG 服务每分片一个容器、每 job 全新，不会累积。本地清理见 audit-backlog 的一行命令。
 */
async function createPostgresqlFileDatabase(
  sourceUrl: string | undefined,
  ordinal: number,
): Promise<{ readonly url: string | undefined; readonly drop: () => Promise<void> }> {
  if (sourceUrl === undefined) return { url: undefined, drop: async () => undefined }
  const name = `aw_t_${String(process.pid)}_${String(ordinal)}`
  const admin = createPostgresqlHarnessDropConnection(sourceUrl)
  try {
    await admin.unsafe(`drop database if exists "${name}"`)
    await admin.unsafe(`create database "${name}"`)
  } finally {
    await closeQuietly(admin)
  }
  const url = new URL(sourceUrl)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
      const connection = createPostgresqlHarnessDropConnection(sourceUrl)
      try {
        // 本文件的连接此刻已经全关（本函数只在 closeAll 之后被调用），但别人的诊断连接
        // 可能还挂着；先踢掉再删，否则 `drop database` 会因「正在被访问」失败。
        await connection.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity ` +
            `where datname = '${name}' and pid <> pg_backend_pid()`,
        )
        await connection.unsafe(`drop database if exists "${name}"`)
      } finally {
        await closeQuietly(connection)
      }
    },
  }
}

interface PostgresqlHarnessDatabase {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly applicationBinding: Extract<ProviderApplicationBinding, { provider: 'postgresql' }>
  readonly client: PostgresqlDatabaseClient
  readonly raw: RawQuery
  readonly snapshot: PostgresqlSchemaSnapshot
  readonly sinks: Set<RecordedStatement[]>
  readonly dropObservation: PostgresqlDropObservation
  readonly createDropConnection: () => PostgresqlHarnessDropConnection
}

/** 每个真库都走原有的一次初始化：迁移、生成代、迁移种子与录制客户端。 */
async function createPostgresqlHarnessDatabase(
  urlEnv: (typeof POSTGRESQL_URL_ENVS)[number],
  env?: Readonly<Record<string, string | undefined>>,
  phase?: ProviderHarnessLifecyclePhase,
): Promise<PostgresqlHarnessDatabase> {
  const sinks = new Set<RecordedStatement[]>()
  const sourceUrl = (env ?? process.env)[urlEnv]
  const databaseConfig = {
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
  } satisfies Extract<DatabaseConfig, { provider: 'postgresql' }>
  const runtime = createPostgresqlDatabaseRuntime({
    config: databaseConfig,
    generationId: GENERATION_ID,
    ...(env === undefined ? {} : { env }),
  })
  try {
    const pool = runtime.providerPool()
    const query: RawQuery = async (text, parameters) =>
      parameters === undefined ? await pool.unsafe(text) : await pool.unsafe(text, [...parameters])
    // 与 rfc357 / rfc359 的真库用例同一套姿势：清干净、按基线迁移、自己登记一个活跃生成代
    // （客户端的业务写围栏按 runtime.generationId 核对 database_generations）。
    await runProviderHarnessLifecycleStep(phase, 'schema.drop-application', () =>
      query('drop schema if exists agent_workflow cascade'),
    )
    await runProviderHarnessLifecycleStep(phase, 'schema.drop-metadata', () =>
      query('drop schema if exists agent_workflow_meta cascade'),
    )
    await runProviderHarnessLifecycleStep(phase, 'schema.migrate', () =>
      migratePostgresqlSchema({ runtime }),
    )
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
    const applicationRuntime = recordingRuntime(runtime, sinks)
    const client = createPostgresqlDatabaseClient(applicationRuntime)
    // PostgreSQL 的迁移器只投影 DDL；迁移脚本里 INSERT 的种子行（committed_event_family_cutovers、
    // auth_login_policy、框架内置资源……）在生产上是随 RFC-349 逻辑复制从 SQLite 带过来的。
    // 这里做同一件事：把一个刚迁移完的 SQLite 内存库整表复制进来，两个引擎的「起点」才是同一个。
    await runProviderHarnessLifecycleStep(phase, 'fixture.seed', () =>
      seedFromSqliteSnapshot(client),
    )
    const snapshot = await runProviderHarnessLifecycleStep(phase, 'fixture.snapshot', () =>
      snapshotSchema(query),
    )
    return {
      runtime,
      applicationBinding: Object.freeze({
        provider: 'postgresql',
        db: client,
        runtime: applicationRuntime,
        databaseConfig,
      }),
      client,
      raw: query,
      snapshot,
      sinks,
      dropObservation: createPostgresqlDropObservation(sourceUrl),
      createDropConnection: () => createPostgresqlHarnessDropConnection(sourceUrl),
    }
  } catch (error) {
    try {
      await runProviderHarnessLifecycleStep(phase, 'setup.failure-close', () => runtime.close())
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'PostgreSQL harness setup and close failed')
    }
    throw error
  }
}

interface PostgresqlHarnessDropConnection {
  unsafe(statement: string): PromiseLike<unknown>
  close(options: { readonly timeout: number }): Promise<void>
}

/** Bun 1.4's pool idle timer also kills active DDL without socket activity.
 * DROP can wait for PostgreSQL's checkpointer, so it owns a connection that is
 * closed immediately after this statement instead of entering an idle pool.
 * Keep the existing connect/SQL/close budgets; business runtimes are unchanged. */
export function createPostgresqlHarnessDropConnection(
  sourceUrl: string | undefined,
  createConnection: (options: {
    readonly url: string
    readonly max: number
    readonly idleTimeout: number
    readonly connectionTimeout: number
  }) => PostgresqlHarnessDropConnection = (options) => new SQL(options),
): PostgresqlHarnessDropConnection {
  if (sourceUrl === undefined) throw new Error('PostgreSQL DROP connection URL is unavailable')
  const url = new URL(sourceUrl)
  url.searchParams.set('application_name', 'aw-each-provider-cleanup')
  url.searchParams.set('options', '-c statement_timeout=60000 -c lock_timeout=60000')
  return createConnection({
    url: url.toString(),
    max: 1,
    idleTimeout: 0,
    connectionTimeout: 10,
  })
}

interface PostgresqlDropObservationEvent {
  readonly databaseName: string
  readonly statement: string
  readonly elapsedMs: number
  readonly phase: 'started' | 'snapshot' | 'failed' | 'close-failed'
  readonly snapshot?: unknown
  readonly error?: unknown
}

interface PostgresqlDropObservation {
  schedule(onSlow: () => void): () => void
  start(input: { readonly databaseName: string; readonly statement: string }): {
    readonly result: Promise<unknown>
    close(): Promise<void>
  }
  report(event: PostgresqlDropObservationEvent): void
}

// A single read on an independent connection distinguishes a server-side
// CheckpointStart/CheckpointDone wait from a DROP absent from pg_stat_activity.
// These limits belong only to the observer; DROP has its own statement and close budgets.
function createPostgresqlDropObservation(sourceUrl: string | undefined): PostgresqlDropObservation {
  return {
    schedule(onSlow) {
      const timer = setTimeout(onSlow, 1_000)
      timer.unref()
      return () => clearTimeout(timer)
    },
    start({ databaseName, statement }) {
      if (sourceUrl === undefined) throw new Error('PostgreSQL observation URL is unavailable')
      const url = new URL(sourceUrl)
      url.searchParams.set('application_name', 'aw-each-provider-cleanup-observer')
      url.searchParams.set('options', '-c statement_timeout=1000 -c lock_timeout=1000')
      const observer = new SQL({
        url: url.toString(),
        max: 1,
        connectionTimeout: 1,
        idleTimeout: 1,
      })
      let cancelQuery = () => {}
      const result = (async () => {
        const query = observer.unsafe(
          `select clock_timestamp()::text as observed_at,
             exists(select 1 from pg_database where datname = $1) as target_database_exists,
             coalesce((select json_agg(activity) from (
               select pid, datname, backend_type, state, wait_event_type, wait_event,
                 pg_blocking_pids(pid) as blocked_by,
                 extract(epoch from (clock_timestamp() - query_start)) * 1000 as query_age_ms,
                 case when query = $2 then 'drop' else lower(split_part(ltrim(query), ' ', 1)) end
                   as statement,
                 query = $2 as is_observed_drop
               from pg_stat_activity
               where pid <> pg_backend_pid()
                 and (datname = current_database() or datname = $1 or backend_type = 'checkpointer')
               order by pid limit 100
             ) activity), '[]'::json) as activity`,
          [databaseName, statement],
        )
        cancelQuery = () => {
          void query.cancel() // result already observes this same query's settlement.
        }
        return await query
      })()
      return {
        result,
        async close() {
          try {
            cancelQuery()
          } finally {
            // Bun 1.4 pool.close({ timeout: 0 }) enters its graceful branch.
            // Cancel first and bound only this diagnostic pool's shutdown.
            await observer.close({ timeout: 1 })
          }
        },
      }
    },
    report(event) {
      console.warn(
        '[each-provider-cleanup-observation]',
        JSON.stringify({
          ...event,
          ...(event.error === undefined ? {} : { error: String(event.error) }),
        }),
      )
    },
  }
}

async function dropPostgresqlHarnessDatabase(
  database: {
    readonly raw: RawQuery
    readonly createDropConnection?: () => PostgresqlHarnessDropConnection
  },
  databaseName: string,
  observation: PostgresqlDropObservation | undefined,
): Promise<void> {
  const statement = `drop database if exists "${databaseName}"`
  const connection = database.createDropConnection?.()
  const errors: unknown[] = []
  const startedAt = performance.now()
  let stopped = false
  let observed: ReturnType<PostgresqlDropObservation['start']> | undefined
  const report = (event: Pick<PostgresqlDropObservationEvent, 'phase' | 'snapshot' | 'error'>) => {
    if (stopped) return
    try {
      observation?.report({
        databaseName,
        statement,
        elapsedMs: performance.now() - startedAt,
        ...event,
      })
    } catch {
      // A diagnostic sink must not change the DROP result.
    }
  }
  const closeObserver = () => {
    const resource = observed
    observed = undefined
    if (resource === undefined) return
    try {
      void resource.close().catch((error: unknown) => report({ phase: 'close-failed', error }))
    } catch (error) {
      report({ phase: 'close-failed', error })
    }
  }
  let cancelTimer = () => {}
  try {
    cancelTimer =
      observation?.schedule(() => {
        if (stopped) return
        report({ phase: 'started' })
        try {
          observed = observation.start({ databaseName, statement })
          void observed.result.then(
            (snapshot) => {
              report({ phase: 'snapshot', snapshot })
              closeObserver()
            },
            (error: unknown) => {
              report({ phase: 'failed', error })
              closeObserver()
            },
          )
        } catch (error) {
          report({ phase: 'failed', error })
          closeObserver()
        }
      }) ?? cancelTimer
  } catch (error) {
    report({ phase: 'failed', error })
  }
  try {
    if (connection === undefined) await database.raw(statement)
    else await connection.unsafe(statement)
  } catch (error) {
    errors.push(error)
  } finally {
    stopped = true
    try {
      cancelTimer()
    } catch {
      // The original operation has already settled.
    }
    closeObserver()
    if (connection !== undefined) {
      try {
        await connection.close({ timeout: 30 })
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, 'PostgreSQL harness DROP and close failed')
}

export async function closePostgresqlHarnessDatabases(
  databases: readonly {
    readonly runtime: Pick<PostgresqlDatabaseRuntime, 'close'>
    readonly raw: RawQuery
    readonly createDropConnection?: () => PostgresqlHarnessDropConnection
  }[],
  createdDatabaseNames: readonly string[],
  observation?: PostgresqlDropObservation,
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
        await dropPostgresqlHarnessDatabase(primary, name, observation)
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
  suite: string,
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
  const lifecycle =
    options.lifecycleDiagnostics === undefined
      ? undefined
      : createProviderHarnessLifecycleObserver({
          sourceFile: options.lifecycleDiagnostics.sourceFile,
          suite,
        })
  const states: HarnessState[] = Array.from({ length: databaseCount }, () => ({}))
  const databases: PostgresqlHarnessDatabase[] = []
  const createdDatabaseNames: string[] = []
  let providerBefore: ReturnType<typeof currentDatabaseSchemaProvider> | undefined
  let restoreProvider: (() => void) | undefined
  let initialization: Promise<void> | undefined
  let cleanup: Promise<void> | undefined
  let fileDatabase:
    | { readonly url: string | undefined; readonly drop: () => Promise<void> }
    | undefined
  let restoreUrlEnv: (() => void) | undefined
  const closeAll = () =>
    (cleanup ??= closePostgresqlHarnessDatabases(
      databases,
      createdDatabaseNames,
      databases[0]?.dropObservation,
    ))

  const initializeDatabases = (): Promise<void> =>
    runProviderHarnessLifecycle(lifecycle, 'beforeAll.setup', async (phase): Promise<void> => {
      providerBefore = currentDatabaseSchemaProvider()
      try {
        // 本文件自己的库：数据 / DDL 锁 / advisory lock 三样都随之与别的文件分开
        // （见 createPostgresqlFileDatabase 头注）。
        fileDatabase = await runProviderHarnessLifecycleStep(phase, 'database.create', () =>
          createPostgresqlFileDatabase(process.env[urlEnv], databaseCount),
        )
        const sourceUrl = fileDatabase.url
        // **把环境变量也指过去**：本仓有一批测试自己从 `process.env[urlEnv]` 建 PG runtime
        // （`rfc359-w8-logical-source-conformance` 等），它们默认「env 指的就是 harness 那个库」。
        // 合一前两者天然同一个库；改成每文件一库后必须显式对齐，否则那些测试会连到 base 库、
        // 看到一个空的 schema。`--isolate` 下一个文件一个进程，改 `process.env` 是文件级安全的；
        // afterAll 原样还原。
        if (sourceUrl !== undefined) {
          const before = process.env[urlEnv]
          process.env[urlEnv] = sourceUrl
          restoreUrlEnv = () => {
            if (before === undefined) delete process.env[urlEnv]
            else process.env[urlEnv] = before
          }
        }
        const primary = await runProviderHarnessLifecycleStep(phase, 'factory.prepare', () =>
          createPostgresqlHarnessDatabase(urlEnv, undefined, phase),
        )
        databases.push(primary)
        for (let index = 1; index < databaseCount; index += 1) {
          const name = `aw_each_provider_${randomUUID().replaceAll('-', '')}`
          await primary.raw(`create database "${name}"`)
          createdDatabaseNames.push(name)
          const url = new URL(sourceUrl!)
          url.pathname = `/${name}`
          databases.push(
            await createPostgresqlHarnessDatabase(urlEnv, { [urlEnv]: url.toString() }),
          )
        }
      } catch (error) {
        try {
          await runProviderHarnessLifecycleStep(phase, 'setup.cleanup', () => closeAll())
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'PostgreSQL harness setup cleanup failed')
        } finally {
          restoreUrlEnv?.()
          restoreUrlEnv = undefined
          await fileDatabase?.drop()
          fileDatabase = undefined
          if (providerBefore !== undefined) selectDatabaseSchemaProvider(providerBefore)
        }
        throw error
      }
    })
  const setupDatabases = () => (initialization ??= initializeDatabases())
  // 预算**无条件**给：`setupDatabases` 要现建一个 PostgreSQL 库并跑完整套迁移，本机实测到第一条
  // 用例约 1.5s，CI 上容器化的库加上同 job 的其它负载会更久。此前只有 `databaseCount !== 1` 才用
  // 这个常量，单库（绝大多数文件）反而吃 bun 的 5s 默认值——于是 real-PostgreSQL 泳道偶发
  // 「a beforeEach/afterEach hook timed out」，还记在一条 `(unnamed)` 用例头上（bun 把失败的
  // `beforeAll` 这样归属）。常量本身早就写着 60s，只是没用在最常见的那条路上。
  beforeAll(setupDatabases, databaseCount * POSTGRESQL_DATABASE_SETUP_TIMEOUT_MS)

  beforeEach(
    () =>
      runProviderHarnessLifecycle(lifecycle, 'beforeEach.reset', async (phase) => {
        if (databases.length !== databaseCount) {
          throw new Error('PostgreSQL harness 未完成装配（beforeAll 失败）')
        }
        restoreProvider = selectDatabaseSchemaProvider('postgresql')
        try {
          for (const [index, database] of databases.entries()) {
            const { client, raw, snapshot, sinks } = database
            await runProviderHarnessLifecycleStep(phase, 'fixture.reset', () =>
              resetToSnapshot(raw, snapshot, options),
            )
            if (options.bootstrap !== 'required') registerLegacyDaemonTestFixture(client)
            const state = states[index]!
            const query = raw
            state.db = client
            state.applicationBinding = database.applicationBinding
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
      }),
    databaseCount * POSTGRESQL_DATABASE_RESET_TIMEOUT_MS,
  )

  afterEach(() => {
    restoreProvider?.()
    restoreProvider = undefined
    databases.forEach(({ sinks }) => sinks.clear())
    states.forEach(clearState)
  })

  const cleanupDatabases = (): Promise<void> =>
    runProviderHarnessLifecycle(lifecycle, 'afterAll.cleanup', async (phase): Promise<void> => {
      try {
        // Hook 超时不取消初始化 Promise；等它收束，避免关闭主库后仍产生未登记的子 runtime。
        await runProviderHarnessLifecycleStep(phase, 'cleanup.wait-initialization', () =>
          initialization?.catch(() => undefined),
        )
        await runProviderHarnessLifecycleStep(phase, 'cleanup.close', () => closeAll())
      } finally {
        // **必须在 closeAll 之后**：`drop database` 要求库上没有连接，而 closeAll 才关掉
        // 本文件的全部 runtime（附加库也在那一步里由主库连接删掉）。
        await runProviderHarnessLifecycleStep(phase, 'database.drop', async () => {
          restoreUrlEnv?.()
          restoreUrlEnv = undefined
          await fileDatabase?.drop()
          fileDatabase = undefined
        })
        if (providerBefore !== undefined) selectDatabaseSchemaProvider(providerBefore)
      }
    })
  // 同上：拆库同样是真库操作，单库路径此前也吃 5s 默认值。
  afterAll(cleanupDatabases, databaseCount * POSTGRESQL_DATABASE_CLEANUP_TIMEOUT_MS)

  body(harnessView(states))
}
