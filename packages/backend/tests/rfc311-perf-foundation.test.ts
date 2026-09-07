// RFC-311 PR-1 — foundation locks: migration 0180 indexes + tasks.branch_started_at
// backfill semantics + maintenance_state + capacity PRAGMAs + slow-statement
// telemetry.
//
// Why these locks exist: the production DB reached 2.2GB on a single
// synchronous bun:sqlite connection; every un-indexed periodic scan and every
// wide-column materialization froze the whole daemon (see
// design/RFC-311-database-performance-and-scalability/audit-2026-08-18.md).
// If a refactor turns any of these plans back into a full-table SCAN, this
// file is the tripwire.
//
// RFC-359 W6-T27 —— 这个文件锁的东西**大半是 SQLite 机制**（`PRAGMA index_list` /
// `EXPLAIN QUERY PLAN` / `openDb` 的容量 PRAGMA / bun:sqlite 的慢语句包装），它们在
// PostgreSQL 上没有对应物，硬套 `describeEachProvider` 只会得到「跑了但什么都没断言」的
// 双引擎剧场。真正**两个引擎都必须成立**的是第一条：迁移 0180 那批索引在当前引擎上确实
// 存在。它被单独拎成下面的 `describeEachProvider` 块——这正是 PostgreSQL 上曾经出事的地方：
// `tasks` 有五条索引只写在迁移 SQL 里、没进 drizzle 声明，于是 SQLite 上有、PG 上完全没有
// （PG 的 DDL 从 drizzle 投影），任务树 / 工作组查询在 PG 上没有索引可用而只是「慢」，不报错。
// 全量的索引对账（SQLite 的具名索引 PG 必须一条不少）在
// `rfc359-w6-t26-postgresql-plan-audit.test.ts`；这里锁的是 0180 这一批的逐条存在性。

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Database } from 'bun:sqlite'
import { createInMemoryDb, instrumentSlowStatements, openDb } from '../src/db/client'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { tasks, users, workflows } from '../src/db/schema'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface IndexListRow {
  name: string
  partial: number
}
interface QueryPlanRow {
  detail: string
}

function indexNames(db: ReturnType<typeof createInMemoryDb>, table: string): IndexListRow[] {
  return db.all<IndexListRow>(sql.raw(`PRAGMA index_list('${table}')`))
}

function plan(db: ReturnType<typeof createInMemoryDb>, query: string): string {
  return db
    .all<QueryPlanRow>(sql.raw(`EXPLAIN QUERY PLAN ${query}`))
    .map((row) => row.detail)
    .join('\n')
}

/**
 * 迁移 0180 建的索引，按表分组。两个引擎共用这一份清单——SQLite 从迁移脚本得到它们，
 * PostgreSQL 从 drizzle 声明投影得到，两条路必须落到同一个结果。
 */
const MIGRATION_0180_INDEXES: Record<string, readonly string[]> = {
  tasks: [
    'idx_tasks_branch_started_id',
    'idx_tasks_cached_repo',
    'idx_tasks_status_finished',
    'idx_tasks_source_agent',
    'idx_tasks_code_round',
  ],
  node_runs: ['idx_node_runs_status_active'],
  doc_versions: ['idx_doc_versions_pending_created'],
  memories: ['idx_memories_created'],
  skill_versions: ['idx_skill_versions_fusion'],
  code_findings: ['idx_code_findings_external_created'],
  code_work_items: ['idx_code_work_items_created'],
  code_work_rounds: ['idx_code_work_rounds_started'],
  code_ai_attempts: ['idx_code_ai_attempts_started'],
  code_artifacts: ['idx_code_artifacts_released'],
  development_missions: ['idx_development_missions_created', 'idx_development_missions_fenced'],
  development_mr_claims: ['idx_dev_mr_claims_lookup'],
  development_wake_hints: ['idx_dev_wake_hints_unconsumed'],
  development_deferred_wakes: ['idx_dev_deferred_wakes_due'],
  development_agent_attempts: ['idx_dev_agent_attempts_execution_ref'],
  development_effects: ['idx_dev_effects_prepared'],
}

/** 这些索引必须是 partial（谓词写在索引上），两个引擎同样要求。 */
const PARTIAL_0180_INDEXES = [
  'idx_doc_versions_pending_created',
  'idx_dev_deferred_wakes_due',
  'idx_dev_wake_hints_unconsumed',
  'idx_dev_effects_prepared',
  'idx_code_artifacts_released',
  'idx_code_findings_external_created',
] as const

/** 当前引擎上某张表的索引清单：名字 + 是不是 partial。表不存在时返回空。 */
async function listIndexes(
  harness: ProviderHarness,
  table: string,
): Promise<{ name: string; partial: boolean }[]> {
  const db: ProviderNeutralDatabase = harness.db
  if (harness.capabilities.provider === 'sqlite') {
    return (
      await db.all<{ name: string; partial: number }>(sql.raw(`PRAGMA index_list('${table}')`))
    ).map((row) => ({ name: row.name, partial: row.partial === 1 }))
  }
  const rows = await db.all<{ indexname: string; indexdef: string }>(
    sql.raw(
      `select indexname, indexdef from pg_indexes ` +
        `where schemaname = 'agent_workflow' and tablename = '${table}'`,
    ),
  )
  return rows.map((row) => ({ name: row.indexname, partial: / WHERE /i.test(row.indexdef) }))
}

describeEachProvider('migration 0180 — RFC-311 index batch（两个引擎都必须有）', (harness) => {
  test('every 0180 index exists on this engine, with the intended partial flags', async () => {
    const partials = new Set<string>()
    let checked = 0
    for (const [table, expected] of Object.entries(MIGRATION_0180_INDEXES)) {
      const present = await listIndexes(harness, table)
      // `code_artifacts` 一类按 RFC349_ARCHIVE_THEN_OMIT_TABLES 根本不投影到 PostgreSQL；
      // 表不在就跳过，但**表在就一条都不许少**。
      if (present.length === 0) continue
      const names = present.map((row) => row.name)
      checked += expected.length
      expect(names, `${table} 少了 0180 的索引`).toEqual(expect.arrayContaining([...expected]))
      for (const row of present) if (row.partial) partials.add(row.name)
    }
    // 失败关闭：扫描面下界，否则「没少索引」与「没扫到表」同形。
    expect(checked).toBeGreaterThanOrEqual(18)
    for (const name of PARTIAL_0180_INDEXES) {
      if (!partials.has(name) && name.startsWith('idx_code_')) continue // 归档表，PG 上不存在
      expect(partials.has(name), `${name} 应当是 partial index`).toBe(true)
    }
  }, 120_000)
})

describe('migration 0180 — RFC-311 index batch', () => {
  test('new indexes exist with the intended partial flags', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const byTable: Record<string, string[]> = {
      tasks: [
        'idx_tasks_branch_started_id',
        'idx_tasks_cached_repo',
        'idx_tasks_status_finished',
        'idx_tasks_source_agent',
        'idx_tasks_code_round',
      ],
      node_runs: ['idx_node_runs_status_active'],
      doc_versions: ['idx_doc_versions_pending_created'],
      memories: ['idx_memories_created'],
      skill_versions: ['idx_skill_versions_fusion'],
      code_findings: ['idx_code_findings_external_created'],
      code_work_items: ['idx_code_work_items_created'],
      code_work_rounds: ['idx_code_work_rounds_started'],
      code_ai_attempts: ['idx_code_ai_attempts_started'],
      code_artifacts: ['idx_code_artifacts_released'],
      development_missions: ['idx_development_missions_created', 'idx_development_missions_fenced'],
      development_mr_claims: ['idx_dev_mr_claims_lookup'],
      development_wake_hints: ['idx_dev_wake_hints_unconsumed'],
      development_deferred_wakes: ['idx_dev_deferred_wakes_due'],
      development_agent_attempts: ['idx_dev_agent_attempts_execution_ref'],
      development_effects: ['idx_dev_effects_prepared'],
    }
    for (const [table, expected] of Object.entries(byTable)) {
      const names = indexNames(db, table).map((row) => row.name)
      expect(names).toEqual(expect.arrayContaining(expected))
    }
    const partials = new Set(
      [
        ...indexNames(db, 'doc_versions'),
        ...indexNames(db, 'development_deferred_wakes'),
        ...indexNames(db, 'development_wake_hints'),
        ...indexNames(db, 'development_effects'),
        ...indexNames(db, 'code_artifacts'),
        ...indexNames(db, 'code_findings'),
      ]
        .filter((row) => row.partial === 1)
        .map((row) => row.name),
    )
    for (const name of [
      'idx_doc_versions_pending_created',
      'idx_dev_deferred_wakes_due',
      'idx_dev_wake_hints_unconsumed',
      'idx_dev_effects_prepared',
      'idx_code_artifacts_released',
      'idx_code_findings_external_created',
    ]) {
      expect(partials.has(name)).toBe(true)
    }
  })

  test('maintenance_state exists as a bare KV table', () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.run(sql`INSERT INTO maintenance_state (key, value, updated_at) VALUES ('probe', 'v1', 1)`)
    const rows = db.all<{ value: string }>(
      sql`SELECT value FROM maintenance_state WHERE key = 'probe'`,
    )
    expect(rows[0]?.value).toBe('v1')
  })

  test.each([
    [
      "SELECT id FROM node_runs WHERE status = 'running' AND started_at < 123",
      'idx_node_runs_status_active',
    ],
    [
      "SELECT count(*) FROM doc_versions WHERE decision = 'pending'",
      'idx_doc_versions_pending_created',
    ],
    ["SELECT id FROM tasks WHERE cached_repo_id = 'r1'", 'idx_tasks_cached_repo'],
    [
      "SELECT count(*) FROM tasks WHERE status = 'done' AND finished_at >= 42",
      'idx_tasks_status_finished',
    ],
    [
      'SELECT id FROM tasks ORDER BY branch_started_at DESC, id DESC LIMIT 50',
      'idx_tasks_branch_started_id',
    ],
    [
      "SELECT id FROM development_deferred_wakes WHERE state = 'armed' AND resume_at <= 99",
      'idx_dev_deferred_wakes_due',
    ],
  ] as const)('plan for %s uses %s', (query, index) => {
    const db = createInMemoryDb(MIGRATIONS)
    expect(plan(db, query)).toContain(index)
  })

  test('backfill statements in 0180 aggregate branch_started_at over each subtree', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = 1_788_278_400_000
    await db.insert(users).values({
      id: 'u1',
      username: 'u1',
      displayName: 'U1',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(workflows).values({
      id: 'wf1',
      name: 'wf',
      definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    })
    const row = (id: string, startedAt: number, parentTaskId?: string) => ({
      id,
      name: id,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: `/tmp/${id}`,
      worktreePath: `/tmp/wt-${id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'done' as const,
      inputs: '{}',
      startedAt,
      finishedAt: startedAt + 1,
      runningMs: 0,
      ownerUserId: 'u1',
      parentTaskId,
      invocationDepth: parentTaskId === undefined ? 0 : 1,
      launchOrigin: 'manual' as const,
      // Deliberately wrong so only the migration's own backfill can fix it.
      branchStartedAt: 0,
    })
    await db
      .insert(tasks)
      .values([row('r1', 100), row('c1', 200, 'r1'), row('c2', 300, 'c1'), row('r2', 500)])

    // Execute the exact backfill statements from the shipped migration file, so
    // this test breaks if someone edits 0180 into a different semantic.
    const migrationSql = readFileSync(join(MIGRATIONS, '0180_rfc311_perf_indexes.sql'), 'utf8')
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^--.*$/gm, '').trim())
      .filter(
        (statement) =>
          statement.includes('_rfc311_branch_backfill') ||
          statement.startsWith('UPDATE `tasks` SET `branch_started_at`'),
      )
    expect(statements.length).toBe(3)
    for (const statement of statements) db.run(sql.raw(statement))

    const got = await db
      .select({ id: tasks.id, branchStartedAt: tasks.branchStartedAt })
      .from(tasks)
    const byId = new Map(got.map((r) => [r.id, r.branchStartedAt]))
    expect(byId.get('r1')).toBe(300)
    expect(byId.get('c1')).toBe(300)
    expect(byId.get('c2')).toBe(300)
    expect(byId.get('r2')).toBe(500)
  })
})

// 实现门 P3-13:Proxy 的 get 陷阱若把 receiver 传给 Reflect.get,native class 的
// 取值器会抛「Cannot access invalid private field」——开了慢查询计时才炸,关掉不炸。
describe('RFC-311 slow-query proxy keeps native statement getters usable', () => {
  test('columnNames / paramsCount read through the wrapper', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const sqlite = (db as unknown as { $client: Database }).$client
    instrumentSlowStatements(sqlite, 50, () => {})
    const stmt = sqlite.query('SELECT 1 AS a, 2 AS b')
    expect(() => stmt.columnNames).not.toThrow()
    expect(stmt.columnNames).toEqual(['a', 'b'])
    expect(() => stmt.paramsCount).not.toThrow()
    expect(stmt.all()).toEqual([{ a: 1, b: 2 }])
  })
})

describe('RFC-311 capacity PRAGMAs (openDb)', () => {
  test('openDb applies cache/mmap/temp_store and they are configurable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc311-pragma-'))
    try {
      const db = openDb({
        path: join(dir, 'db.sqlite'),
        migrationsFolder: MIGRATIONS,
        pageCacheMib: 64,
        mmapMib: 32,
        slowQueryMs: 0,
      })
      const sqlite = db.$client
      const cache = sqlite.query('PRAGMA cache_size;').get() as { cache_size: number }
      expect(cache.cache_size).toBe(-64 * 1024)
      const temp = sqlite.query('PRAGMA temp_store;').get() as { temp_store: number }
      expect(temp.temp_store).toBe(2) // MEMORY
      const mmap = sqlite.query('PRAGMA mmap_size;').get() as { mmap_size: number }
      // Engine answers the request or 0 on unsupported filesystems — never
      // some other number.
      expect([32 * 1024 * 1024, 0]).toContain(mmap.mmap_size)
      db.$client.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RFC-311 slow-statement telemetry', () => {
  test('threshold 0 is a no-op and wrapped statements keep their results', () => {
    const sqlite = new Database(':memory:')
    const seen: string[] = []
    instrumentSlowStatements(sqlite, 0, (_ms, s) => seen.push(s))
    sqlite.exec('CREATE TABLE t (x INTEGER)')
    sqlite.exec('INSERT INTO t VALUES (7)')
    expect((sqlite.query('SELECT x FROM t').get() as { x: number }).x).toBe(7)
    expect(seen).toEqual([])
    sqlite.close()
  })

  test('slow statements reach the sink, fast ones stay quiet, results unchanged', () => {
    const sqlite = new Database(':memory:')
    const seen: { ms: number; sql: string }[] = []
    instrumentSlowStatements(sqlite, 1, (ms, s) => seen.push({ ms, sql: s }))
    sqlite.exec('CREATE TABLE t (x INTEGER)')
    // A recursive counter comfortably above 1ms, executed through prepare().
    const rows = sqlite
      .prepare(
        'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 300000) SELECT count(*) AS n FROM c',
      )
      .all() as { n: number }[]
    expect(rows[0]?.n).toBe(300_000)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    // 断的是「这条慢语句到没到 sink」，**不是**「它排第几」。原写法取 `seen[0]`，
    // 而 `exec()` 同样被计时（db/client.ts:137-139）——机器一忙，上面那句
    // `CREATE TABLE` 自己就超了 1ms 阈值、占住 seen[0]，断言当场红。
    // 2026-08-25 在 macOS shard 1/4 上实红一次（run 32793503221）；本机把阈值压到
    // 0.0000001 可确定性复现同一形态。顺序不是这条测试的判据，改成存在性。
    expect(seen.some((e) => e.sql.includes('WITH RECURSIVE'))).toBe(true)
    const before = seen.length
    sqlite.prepare('SELECT 1 AS one').get()
    // A point query must not trip a 1ms threshold under normal conditions;
    // tolerate scheduler noise by only asserting it did not add MANY entries.
    expect(seen.length - before).toBeLessThanOrEqual(1)
    sqlite.close()
  })

  test('long SQL text is clipped in the sink payload', () => {
    const sqlite = new Database(':memory:')
    const seen: string[] = []
    instrumentSlowStatements(sqlite, 0.0000001, (_ms, s) => seen.push(s))
    const padded = `SELECT 1 AS one /* ${'x'.repeat(500)} */`
    sqlite.prepare(padded).get()
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]!.length).toBeLessThanOrEqual(301)
    sqlite.close()
  })
})
