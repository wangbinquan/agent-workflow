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
import { compilePostgresqlSql } from '@/platform/persistence/postgresqlSql'

const backendRoot = resolve(import.meta.dir, '..')
const read = (path: string): string => readFileSync(resolve(backendRoot, path), 'utf8')

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

  test('the memory search uses ilike on PostgreSQL and like on SQLite', () => {
    const postgresql = read(
      'src/modules/memory/infrastructure/postgresqlMemoryCatalogOperations.ts',
    )
    const sqlite = read('src/modules/memory/infrastructure/sqliteMemoryCatalog.ts')

    expect(postgresql).toContain('ilike(memories.title, term)')
    expect(postgresql).toContain('ilike(memories.bodyMd, term)')
    expect(
      postgresql.match(PLAIN_LIKE),
      '记忆搜索回到 like ⇒ 切 PostgreSQL 后大小写不同的搜索词静默少召回',
    ).toBeNull()
    // SQLite 侧保持 like：它本来就不敏感，换 ilike 反而是 PostgreSQL-only 语法。
    expect(sqlite).toContain('like(memories.title, term)')
  })

  test('the digital-employee case search uses ilike on PostgreSQL and like on SQLite', () => {
    const postgresql = read('src/modules/digital-employee/infrastructure/postgresqlRuntimeStore.ts')
    const sqlite = read('src/modules/digital-employee/infrastructure/sqliteRuntimeStore.ts')

    for (const column of [
      'employeeCases.name',
      'employeeCases.id',
      'employeeCases.employeeId',
      'employeeCases.blockReason',
      'employeeContextRecords.stateJson',
    ]) {
      expect(postgresql, `${column} 的案件搜索回到 like`).toContain(`ilike(${column}, term)`)
      expect(sqlite).toContain(`like(${column}, term)`)
    }
    expect(
      postgresql.match(PLAIN_LIKE),
      '案件搜索回到 like ⇒ 切 PostgreSQL 后大小写不同的搜索词静默少召回',
    ).toBeNull()
  })

  test('the three deliberate exact-case matches stay `like`', () => {
    // 见文件头的说明：它们的模式来自代码常量或存下来的 id，大小写敏感才是对的。
    expect(
      read('src/modules/resource-catalog/infrastructure/postgresqlPluginRepository.ts'),
    ).toContain('like(agents.plugins,')
    expect(
      read('src/modules/resource-catalog/infrastructure/postgresqlMcpRepository.ts'),
    ).toContain('like(agents.mcp,')
    expect(read('src/platform/events/committed/postgresqlPersistence.ts')).toContain(
      "like(committedEventDeliveries.consumerId, 'event-center.%')",
    )
  })
})
