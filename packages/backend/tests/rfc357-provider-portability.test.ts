// RFC-357 —— 「同一份列表页查询在两个 provider 上跑」的**前提清单**，逐条可执行地钉住。
//
// 为什么这条测试存在：`docs/dev-gotchas.md` §「SQL 长得一样」证明不了「两个 provider 行为
// 一样」记着 RFC-349 的教训——假 pool 只断言渲染出的 SQL 文本，接上真库后连着暴出六个只在
// PostgreSQL 上成立的缺陷。RFC-357 敢让两个 provider 共用一份查询，靠的是一张**闭合的**
// 差异清单（`design.md §6`）；清单里每一条「这里不成立」都是一个前提，前提哪天变了必须先
// 红在前提上，而不是等用户报「列表少了几条」。
//
// 真库执行面由 `rfc357-postgresql-page.integration.test.ts` + CI 的 postgres lane 承担；
// 这个文件只负责前提与源码形状，普通跑批里就能跑。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { compilePostgresqlSql } from '@/platform/persistence/postgresqlSql'

const PAGE_DIR = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'task-execution',
  'infrastructure',
  'taskListPage',
)
const BASELINE = resolve(
  import.meta.dir,
  '..',
  'db',
  'postgresql-migrations',
  '0000_rfc349_baseline.sql',
)
const RUNTIME = resolve(
  import.meta.dir,
  '..',
  'src',
  'platform',
  'persistence',
  'postgresqlRuntime.ts',
)
const SCHEMA = resolve(import.meta.dir, '..', 'src', 'db', 'schema.ts')

function pageSource(): string {
  return readdirSync(PAGE_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()
    .map((entry) => readFileSync(resolve(PAGE_DIR, entry), 'utf8'))
    .join('\n')
}

describe('RFC-357 delta 1 — user search folds case on BOTH sides, so LIKE sensitivity cannot bite', () => {
  // 前提：SQLite 的 LIKE 对 ASCII 天生不敏感，PostgreSQL 的敏感。这条差异是真的；
  // 它在**这一页**不成立，只是因为查询两侧都显式 lower() 了。
  test('the premise: SQLite LIKE ignores ASCII case, so the fold is not what makes SQLite work', () => {
    const db = new Database(':memory:')
    db.run('create table t(a text)')
    db.run("insert into t(a) values ('Deploy Runbook')")
    expect(db.query("select count(*) as n from t where a like '%runbook%'").get()).toEqual({ n: 1 })
    db.close()
  })

  test('every user-search comparison lowers the column as well as the pattern', () => {
    const source = pageSource()
    // 模式本身在构造时就 toLocaleLowerCase 了。
    expect(source).toContain("escapeLike(filters.q.toLocaleLowerCase('en-US'))")
    // 每一处 `LIKE ${pattern}` 的左侧都必须裹在 lower(...) 里。
    const comparisons = source.match(/^\s*(?:OR )?(.+?) LIKE \$\{pattern\}/gmu) ?? []
    expect(comparisons.length).toBeGreaterThan(6)
    for (const comparison of comparisons) {
      expect(comparison).toContain('lower(')
    }
    // 反过来也要真的没有裸 LIKE：一处漏掉 lower() 就在 PostgreSQL 上静默少召回。
    expect(source).not.toMatch(/\$\{col\('[a-z_]+'\)\} LIKE/u)
  })
})

describe('RFC-357 delta 2/3 — raw-SQL numbers are normalised in the projection', () => {
  test('every numeric field the page emits goes through the finite-checked helper', () => {
    const projection = readFileSync(resolve(PAGE_DIR, 'projection.ts'), 'utf8')
    for (const field of [
      'started_at',
      'finished_at',
      'repo_count',
      'open_alert_count',
      'invocation_depth',
      'running_ms',
      'running_since',
      'qualifying_child_count',
      'matching_descendant_count',
      'branch_started_at',
    ]) {
      expect(projection).toContain(`'${field}'`)
    }
    // 归一必须是「抛而不是放行」——NaN 静默进页比红一次糟得多。
    expect(projection).toContain('if (!Number.isFinite(parsed))')
    const page = readFileSync(resolve(PAGE_DIR, 'page.ts'), 'utf8')
    expect(page).toContain('function facetCount(')
    expect(page).toContain('if (!Number.isFinite(parsed))')
  })
})

describe('RFC-357 delta 4 — the sort key cannot hit the NULL-ordering reversal', () => {
  // SQLite 的 DESC 把 NULL 排最后、PostgreSQL 排最前。排序键是 branch_started_at，
  // 它 NOT NULL DEFAULT 0，所以这条差异在本页不成立——但那是**前提**，钉住它。
  test('branch_started_at is NOT NULL, which is why ORDER BY … DESC is provider-agnostic here', () => {
    const schema = readFileSync(SCHEMA, 'utf8')
    expect(schema).toContain("branchStartedAt: integer('branch_started_at').notNull().default(0)")
  })
})

describe('RFC-357 delta 6 — the SQLite functions the query calls have PostgreSQL shims on the search path', () => {
  const baseline = readFileSync(BASELINE, 'utf8')

  test('json_valid / json_type / json_extract / instr are all created in the application schema', () => {
    for (const fn of ['json_valid', 'json_type', 'json_extract', 'instr']) {
      expect(baseline).toContain(`FUNCTION "agent_workflow".${fn}(`)
    }
  })

  test('the runtime puts that schema on the search path, so bare names resolve', () => {
    expect(readFileSync(RUNTIME, 'utf8')).toContain('search_path=agent_workflow,public')
  })

  test('the query calls exactly those four and no other SQLite-only function', () => {
    const source = pageSource()
    const called = new Set(
      [
        ...source.matchAll(
          /\b(json_valid|json_type|json_extract|instr|unixepoch|hex|randomblob)\s*\(/gu,
        ),
      ].map((match) => match[1]!),
    )
    expect([...called].sort()).toEqual(['instr', 'json_extract', 'json_type', 'json_valid'])
  })
})

describe('RFC-357 delta 7 — bind markers compile, and the row-value boundary survives it', () => {
  test('the SQLite placeholder compiler rewrites ? into $n without touching row values', () => {
    const compiled = compilePostgresqlSql(
      'SELECT * FROM t WHERE (t.branch_started_at, t.id) < (?, ?) ORDER BY t.branch_started_at DESC LIMIT ?',
    )
    expect(compiled).toContain('(t.branch_started_at, t.id) < ($1, $2)')
    expect(compiled).toContain('LIMIT $3')
  })
})

describe('RFC-357 — the closed delta list has no other provider branch hiding in the page', () => {
  test('the shared query carries no provider name and no dialect switch', () => {
    // `db.ts` / `postgresql.ts` / `sqlite.ts` 的头注释与装配会提到 provider 名字；
    // 真正共用的四个文件不许有。
    for (const entry of ['filters.ts', 'query.ts', 'projection.ts', 'page.ts']) {
      const text = readFileSync(resolve(PAGE_DIR, entry), 'utf8')
      const code = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
        .join('\n')
      expect(code).not.toMatch(/\$provider|'postgresql'|'sqlite'/u)
    }
    expect(pageSource()).not.toContain('PostgresqlSqlCompatibilityError')
  })
})
