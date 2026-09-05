// RFC-349 回归防护 —— 用户输入的搜索词在两个 provider 上必须同样大小写不敏感。
//
// 为什么这条测试存在（2026-09-03，对着真 PostgreSQL 实测）：
// **SQLite 的 `LIKE` 对 ASCII 天生大小写不敏感**（`'Hello World' LIKE '%hello%'` 为真），
// 而 **PostgreSQL 的 `LIKE` 是大小写敏感的**。两个 provider 的适配器此前都写的是
// `like(col, '%' + 用户输入 + '%')`，于是同一次搜索在切到 PostgreSQL 之后**静默少召回**：
//
//   insert into memories (title, body_md) values ('Deploy Runbook', 'Body about MEMORY')
//   select count(*) where title like  '%runbook%'  →  0     ← PostgreSQL
//   select count(*) where title ilike '%runbook%'  →  1
//   同一行同一条件在 SQLite 上是 1
//
// 受影响的是**用户敲进去的搜索框**：记忆列表 `?search=`、数字员工案件列表 `?q=`。
// 修法是 PostgreSQL 侧改用 `ilike`（SQLite 侧保持 `like`，它本来就不敏感）。
//
// **有三处 `like` 是故意留着的**，别顺手一起改：
//   1. `postgresqlPluginRepository` / `postgresqlMcpRepository` 的 `%"<id>"%` —— 模式由
//      存下来的 id 原样拼出，大小写敏感才是对的；改成 ilike 等于把 SQLite 那边「只差
//      大小写的两个 id 会互相误命中」的毛病搬过来。
//   2. `postgresqlPersistence` 的 `event-center.%` —— consumer id 是代码常量、全小写，
//      两个 provider 结果相同。
//   3. `postgresqlNodeExecutionPersistence` 的 `notLike(payload, '[rfc%')` —— 前缀是代码
//      常量、全小写；模型自己吐出的 `[RFC…` 在 PostgreSQL 上会被正确计入，SQLite 反而漏。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { ilike } from 'drizzle-orm'

import * as schema from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { postgresqlExecutionSurface } from './architecture/postgresqlSurface'
import { compilePostgresqlSql } from '@/platform/persistence/postgresqlSql'

const backendRoot = resolve(import.meta.dir, '..')
const read = (path: string): string => readFileSync(resolve(backendRoot, path), 'utf8')

/**
 * `文件相对 src 的路径 -> 被匹配的列 -> 为什么这里大小写敏感才是对的`。
 *
 * 这三类模式都不是用户输入：前两条按代码写死的 JSON 片段找引用（id 是 ULID，大小写
 * 由生成器决定），第三条按平台自己的常量前缀过滤消费者。改成 ilike 反而会误召回。
 */
const DELIBERATE_EXACT_CASE: Record<string, Record<string, string>> = {
  'modules/task-execution/infrastructure/effectQuiescence.ts': {
    'nodeRuns.errorMessage':
      "按运行时写死的机器标记 '%child-unkillable%' 找无法回收子进程的证据；标记是常量，精确匹配才对",
  },
  'modules/resource-catalog/infrastructure/mcpRepository.ts': {
    'agents.mcp': '按 `%"<mcpId>"%` 在 JSON 数组文本里找引用，id 是 ULID，精确匹配才对',
  },
  'modules/resource-catalog/infrastructure/pluginRepository.ts': {
    'agents.plugins': '同上，按 `%"<pluginId>"%` 找引用',
  },
  'platform/events/committed/postgresqlPersistence.ts': {
    'committedEventDeliveries.consumerId': "按平台常量前缀 'event-center.%' 过滤消费者",
  },
}

/** `like(` but not `ilike(` / `notLike(`. */
const PLAIN_LIKE = /(?<![A-Za-z])like\(/gu

describe('RFC-349 user search stays case-insensitive on both providers', () => {
  test('the premise: SQLite LIKE ignores ASCII case', () => {
    const db = new Database(':memory:')
    db.run('create table t(a text)')
    db.run("insert into t values ('Deploy Runbook')")
    const row = db
      .query<{ c: number }, []>("select count(*) c from t where a like '%runbook%'")
      .get()
    expect(row?.c, 'SQLite 的 LIKE 不再大小写不敏感了 ⇒ 本条防护的前提变了，先确认再改判据').toBe(1)
    db.close()
  })

  test('ilike survives the SQLite dialect and the PostgreSQL bind compiler', () => {
    const restore = selectDatabaseSchemaProvider('postgresql')
    try {
      const db = drizzle(async () => ({ rows: [] }), { schema })
      const { sql } = db
        .select({ id: schema.memories.id })
        .from(schema.memories)
        .where(ilike(schema.memories.title, '%x%'))
        .toSQL()
      // 业务语句由 SQLite dialect 渲染、再由 compilePostgresqlSql 换绑定符；ilike 必须
      // 原样穿过这两步，否则「改成 ilike」只是改了源码没改上线行为。
      expect(sql).toContain(' ilike ?')
      expect(compilePostgresqlSql(sql)).toContain(' ilike $1')
    } finally {
      restore()
    }
  })

  test('the memory search goes through the engine capability on both providers', () => {
    // RFC-359 W4-D4：目录只有一份实现——大小写不敏感由能力矩阵表达（SQLite `like` / PostgreSQL `ilike`），
    // 通配符按能力矩阵转义；源码里不许再出现裸 like / ilike。
    const catalog = read('src/modules/memory/infrastructure/memoryCatalogOperations.ts')

    expect(catalog).toContain('engine.likeCaseInsensitive(memories.title, pattern, escape)')
    expect(catalog).toContain('engine.likeCaseInsensitive(memories.bodyMd, pattern, escape)')
    expect(catalog).toContain('engine.likeEscape(filter.search)')
    expect(
      catalog.match(PLAIN_LIKE),
      '记忆搜索回到裸 like ⇒ PostgreSQL 上大小写不同的搜索词静默少召回',
    ).toBeNull()
    expect(catalog).not.toContain('ilike(')
  })

  test('the digital-employee case search goes through the engine capability on both providers', () => {
    // RFC-359 W4-D7b：运行时案件存储只有一份实现——大小写不敏感与通配符转义都走能力矩阵。
    const runtime = read('src/modules/digital-employee/infrastructure/runtimeStore.ts')

    for (const column of [
      'employeeCases.name',
      'employeeCases.id',
      'employeeCases.employeeId',
      'employeeCases.blockReason',
      'employeeContextRecords.stateJson',
    ]) {
      expect(runtime, `${column} 的案件搜索回到裸 like`).toContain(
        `engine.likeCaseInsensitive(${column}, pattern, escape)`,
      )
    }
    expect(runtime).toContain('engine.likeEscape(input.q)')
    expect(
      runtime.match(PLAIN_LIKE),
      '案件搜索回到裸 like ⇒ PostgreSQL 上大小写不同的搜索词静默少召回',
    ).toBeNull()
    expect(runtime).not.toContain('ilike(')
  })

  test('every plain `like` on the PostgreSQL execution surface is deliberate', () => {
    // 初版只点名了当时那三处，是**点状夹具不是扫描器**：新写一处面向用户输入的
    // `like(` 不会让任何断言变红，而它在 PostgreSQL 上就是静默少召回。改成扫描整个
    // PG 执行面（语料判据见 `architecture/postgresqlSurface.ts`），每一处裸 like 都必须
    // 在下面写明「为什么大小写敏感才是对的」；写不出理由的就该改 ilike。
    const surface = postgresqlExecutionSurface(resolve(backendRoot, 'src'))
    // RFC-359 W4 把每对 provider 孪生合成一份中立实现（中立句柄已纳入判据，2026-09-05 实测 265）：语料
    // 总数在 W4 期间「两份变一份」单调收敛到约 180，塌掉则只剩个位数——下限 100 守的是后者。
    expect(surface.length, 'PG 执行面语料为空 ⇒ 判据失效（扫描根写错？）').toBeGreaterThanOrEqual(
      100,
    )

    const unexplained: string[] = []
    const stale = new Map<string, Set<string>>(
      Object.entries(DELIBERATE_EXACT_CASE).map(([file, reasons]) => [
        file,
        new Set(Object.keys(reasons)),
      ]),
    )
    for (const file of surface) {
      for (const match of file.text.matchAll(/(?:^|[^i\w])like\(\s*([\w.]+)/gu)) {
        const column = match[1]!
        if (DELIBERATE_EXACT_CASE[file.path]?.[column] !== undefined) {
          stale.get(file.path)?.delete(column)
          continue
        }
        const line = file.text.slice(0, match.index).split('\n').length
        unexplained.push(`${file.path}:${line} like(${column})`)
      }
    }

    expect(
      unexplained,
      'PG 执行面上出现了没有写明理由的裸 like ⇒ PostgreSQL 的 LIKE 大小写敏感，' +
        '面向用户输入的匹配会静默少召回。改用 ilike，或在 DELIBERATE_EXACT_CASE 里写清为什么',
    ).toEqual([])
    expect(
      [...stale].flatMap(([file, columns]) => [...columns].map((column) => `${file}#${column}`)),
      '这些「有意精确匹配」的登记已经没有对应的 like 了 ⇒ 删掉，别留着当免死金牌',
    ).toEqual([])
  })
})
