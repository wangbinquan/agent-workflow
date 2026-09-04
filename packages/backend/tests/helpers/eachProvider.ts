// RFC-359 W5-T19e —— 双引擎测试 harness：**双引擎是缺省**（design.md §11.1）。
//
// `describeEachProvider(name, body)` 把 body 各跑一遍：SQLite 用内存库；PostgreSQL 用
// `AW_TEST_POSTGRESQL_URL`（回退 `RFC357_DATABASE_URL`）指向的真库。PostgreSQL 缺 URL
// **不是 skip 而是 fail**——「无库则跳过」正是 `design/dual-provider-parity-audit-2026-09-04.md`
// 里 12 条 P0 穿过全部验收的机制。本地只想跑 SQLite 时显式 `AW_TEST_PROVIDERS=sqlite`；
// CI 永远不设它（ubuntu 分片带 postgres 服务容器；macOS runner 起不了服务容器，是唯一的
// 显式 sqlite-only lane）。
//
// body 拿到的是 `DatabaseSession` + `EngineCapabilities` + provider-中立客户端，**拿不到
// provider 名**。测试要按引擎分叉时只能走 capabilities（例如 `isolation === 'exclusive'`）。
//
// 每个用例开始时库是「刚迁移完」的状态：SQLite 每次新建内存库；PostgreSQL 每个文件迁移一次，
// 每个用例前 TRUNCATE 全部业务表并把迁移种下的行原样种回（与 `createInMemoryDb` 的快照语义
// 对齐，含 auth_login_policy 的 bootstrap 标记）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'bun:test'
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

export type TestProvider = 'sqlite' | 'postgresql'

const DEFAULT_PROVIDERS: readonly TestProvider[] = ['sqlite', 'postgresql']
const POSTGRESQL_URL_ENVS = ['AW_TEST_POSTGRESQL_URL', 'RFC357_DATABASE_URL'] as const
const GENERATION_ID = 'dbg_each_provider_harness'
const OPERATION_ID = 'lcop_each_provider_harness'

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

export interface ProviderHarness {
  /** provider-中立客户端：两个引擎上是同一套 drizzle query builder。 */
  readonly db: ProviderNeutralDatabase
  readonly session: DatabaseSession
  readonly capabilities: EngineCapabilities
}

export interface DescribeEachProviderOptions {
  /** 同 `createInMemoryDb` 的 `bootstrap`：'required' 时不把 auth_login_policy 标成已 bootstrap。 */
  readonly bootstrap?: 'required'
}

interface HarnessState {
  db?: ProviderNeutralDatabase
  session?: DatabaseSession
}

function harnessView(state: HarnessState): ProviderHarness {
  const current = <K extends 'db' | 'session'>(key: K): NonNullable<HarnessState[K]> => {
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
  })
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
  for (const provider of resolveTestProviders(process.env)) {
    describe(`${name} [${provider}]`, () => {
      if (provider === 'sqlite') registerSqlite(body, options)
      else registerPostgresql(body, options)
    })
  }
}

function registerSqlite(
  body: (harness: ProviderHarness) => void,
  options: DescribeEachProviderOptions,
): void {
  const state: HarnessState = {}
  let restoreProvider: (() => void) | undefined
  beforeEach(() => {
    // 进程级 schema 投影是全局的：显式选 sqlite，用完还原，不依赖 describe 的先后顺序。
    restoreProvider = selectDatabaseSchemaProvider('sqlite')
    const db = createInMemoryDb(
      MIGRATIONS,
      options.bootstrap === undefined ? {} : { bootstrap: options.bootstrap },
    )
    state.db = db
    state.session = databaseSessionFor(db)
  })
  afterEach(() => {
    restoreProvider?.()
    restoreProvider = undefined
    state.db = undefined
    state.session = undefined
  })
  body(harnessView(state))
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

function registerPostgresql(
  body: (harness: ProviderHarness) => void,
  options: DescribeEachProviderOptions,
): void {
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  if (urlEnv === undefined) {
    // 设计上的硬判据：缺库即红，不是 skip。
    test('PostgreSQL 未配置——双引擎是缺省，缺库即红', () => {
      throw new Error(
        '把 AW_TEST_POSTGRESQL_URL（或 RFC357_DATABASE_URL）指向一个可以被整个清空的 PostgreSQL 库；' +
          '只想跑 SQLite 时显式 AW_TEST_PROVIDERS=sqlite（CI 从不这么设）',
      )
    })
    return
  }
  const state: HarnessState = {}
  let runtime: PostgresqlDatabaseRuntime | undefined
  let client: PostgresqlDatabaseClient | undefined
  let raw: RawQuery | undefined
  let snapshot: PostgresqlSchemaSnapshot | undefined
  let providerBefore: ReturnType<typeof currentDatabaseSchemaProvider> | undefined
  let restoreProvider: (() => void) | undefined

  beforeAll(async () => {
    providerBefore = currentDatabaseSchemaProvider()
    runtime = createPostgresqlDatabaseRuntime({
      config: {
        provider: 'postgresql',
        urlEnv,
        poolMax: 4,
        connectTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
        idleTimeoutMs: 30_000,
      },
      generationId: GENERATION_ID,
    })
    const pool = runtime.providerPool()
    const query: RawQuery = async (text, parameters) =>
      parameters === undefined ? await pool.unsafe(text) : await pool.unsafe(text, [...parameters])
    raw = query
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
    client = createPostgresqlDatabaseClient(runtime)
    // PostgreSQL 的迁移器只投影 DDL；迁移脚本里 INSERT 的种子行（committed_event_family_cutovers、
    // auth_login_policy、框架内置资源……）在生产上是随 RFC-349 逻辑复制从 SQLite 带过来的。
    // 这里做同一件事：把一个刚迁移完的 SQLite 内存库整表复制进来，两个引擎的「起点」才是同一个。
    await seedFromSqliteSnapshot(client)
    snapshot = await snapshotSchema(query)
  })

  beforeEach(async () => {
    if (client === undefined || raw === undefined || snapshot === undefined) {
      throw new Error('PostgreSQL harness 未完成装配（beforeAll 失败）')
    }
    restoreProvider = selectDatabaseSchemaProvider('postgresql')
    await resetToSnapshot(raw, snapshot, options)
    state.db = client
    state.session = databaseSessionFor(client)
  })

  afterEach(() => {
    restoreProvider?.()
    restoreProvider = undefined
    state.db = undefined
    state.session = undefined
  })

  afterAll(async () => {
    try {
      await runtime?.close()
    } finally {
      if (providerBefore !== undefined) selectDatabaseSchemaProvider(providerBefore)
    }
  })

  body(harnessView(state))
}
