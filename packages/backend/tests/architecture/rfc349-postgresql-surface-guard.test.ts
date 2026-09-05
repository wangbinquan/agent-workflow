// RFC-349 陷阱守卫的**语料完整性**守卫。
//
// 事故形态（2026-09-04 实测）
// --------------------------
// RFC-349 给 PostgreSQL 落了三条陷阱守卫（NULL 排序 / 聚合投影 / 搜索大小写），判据都写得
// 扎实，但语料是 `readdirSync` + `entry.startsWith('postgresql')`——**把「会在 PG 上执行 SQL」
// 等同于「文件名带 postgresql 前缀」**。按类型重新算一遍执行面，前缀判据漏掉 27 个文件：
//
//   · 双 provider **共用一份实现**、PG 侧只是具名工厂转调它的（RFC-350 的
//     `taskIdleTimeoutPersistence.ts`，db 形参是 `BaseSQLiteDatabase<'sync' | 'async', …>`）；
//   · 直接吃 `PostgresqlDatabaseClient` / PG 事务、却按领域命名的
//     （`retentionSweeper.ts` / `employeePlatformWorkItemPersistence.ts` …）。
//
// 语料放宽后当场抓到 `retentionSweeper.ts` 两处裸 `count(*)`（已按守卫既有约定登记解码人）。
//
// 更糟的是这三条守卫**自己不在守卫网里**：文件名里没有 `GUARD_FILE_NAME_PATTERN` 的任何
// 关键词，也不在 `tests/architecture/` 下，于是 `guardTestFiles` 看不见它们
// ——`rfc317-guard-corpus-floor`（扫语料的守卫必须自证语料下限）与
// `rfc317-guard-negative-fixture`（守卫必须有负样本）两张网都罩不到。语料哪天变空，它们会
// **永久静默绿**，正是 RFC-317 T13 立意要防的那种假绿。
//
// 本文件把那个洞补上：它在 `tests/architecture/` 下（目录即声明），替共享语料承担下限、
// 负样本与「三条守卫确实在用共享语料」的两向钉死。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { classifyPostgresqlSurfaceFile, postgresqlExecutionSurface } from './postgresqlSurface'

const SRC_ROOT = resolve(import.meta.dir, '..', '..', 'src')
const TESTS_ROOT = resolve(import.meta.dir, '..')

/** 共用同一份语料的陷阱守卫。改了名字要同步这里——否则钉死就成了空断言。 */
/** 注释里出现「旧判据」是**历史说明**，不是回归。判据只看代码。 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/.*$/gmu, '$1')
}

const TRAP_GUARDS = [
  'rfc349-null-ordering-parity.test.ts',
  'rfc349-postgresql-numeric-projection.test.ts',
  'rfc349-provider-search-case-parity.test.ts',
] as const

describe('RFC-349 PostgreSQL 执行面语料', () => {
  test('语料下限：判据失效时先红在语料上，而不是安静地扫出空集合', () => {
    const surface = postgresqlExecutionSurface(SRC_ROOT)
    // RFC-359 W4 把每对 provider 孪生合成一份中立实现（中立句柄已纳入判据，2026-09-05 实测 265）：语料
    // 总数在 W4 期间「两份变一份」单调收敛到约 180，塌掉则只剩个位数——下限 100 守的是后者。
    expect(
      surface.length,
      'PG 执行面塌了 ⇒ 三条陷阱守卫会因为「没有语料」而全部假绿',
    ).toBeGreaterThanOrEqual(100)
    // 类型可达这一路必须非空——它现在承载全部中立实现；命名前缀那一路随 W4 归零（W5-T17 棘轮到 0），
    // 不再设下限。
    expect(surface.filter((file) => file.reason === 'typed-handle').length).toBeGreaterThanOrEqual(
      20,
    )
  })

  test('语料严格覆盖旧的命名前缀集合 —— 不允许悄悄收窄回去', () => {
    const surface = postgresqlExecutionSurface(SRC_ROOT)
    const covered = new Set(surface.map((file) => file.path))
    const missing = surface
      .filter((file) => file.reason === 'named-adapter')
      .map((file) => file.path)
      .filter((path) => !covered.has(path))
    expect(missing, '命名前缀命中的文件反而不在语料里 ⇒ 归类逻辑自相矛盾').toEqual([])
  })

  test('三条陷阱守卫确实消费共享语料，而不是各自再走一遍文件名前缀', () => {
    for (const guard of TRAP_GUARDS) {
      const text = withoutComments(readFileSync(resolve(TESTS_ROOT, guard), 'utf8'))
      expect(text, `${guard} 不再消费共享语料`).toContain('postgresqlExecutionSurface(')
      expect(
        text.includes("startsWith('postgresql')"),
        `${guard} 又退回了「文件名前缀即语料」的判据 ⇒ 共用实现与按领域命名的 PG 代码重新逃逸`,
      ).toBe(false)
    }
  })

  test('negative fixture：捏造的源码能证明判据两个方向都真的在判', () => {
    // 命名前缀命中，与内容无关。
    expect(classifyPostgresqlSurfaceFile('postgresqlFooRepository.ts', '')).toBe('named-adapter')
    // 拿到 PG 客户端 + 建了 SQL ⇒ 类型可达命中。
    expect(
      classifyPostgresqlSurfaceFile(
        'retentionSweeper.ts',
        "import type { PostgresqlDatabaseClient } from '@/x'\nconst r = db.select().from(t)",
      ),
    ).toBe('typed-handle')
    // 双 provider 共用句柄同样命中——这正是前缀判据漏掉的那一类。
    expect(
      classifyPostgresqlSurfaceFile(
        'taskIdleTimeoutPersistence.ts',
        "type Db = BaseSQLiteDatabase<'sync' | 'async', unknown, S>\nconst r = db.select().from(t)",
      ),
    ).toBe('typed-handle')
    // 只有类型没有 SQL（纯端口 / 纯组合）不进语料，避免把噪声塞给三条判据。
    expect(
      classifyPostgresqlSurfaceFile(
        'ports.ts',
        "import type { PostgresqlDatabaseClient } from '@/x'\nexport interface P { db: PostgresqlDatabaseClient }",
      ),
    ).toBeNull()
    // 只有 SQL 没有 PG 句柄（SQLite 专属实现）也不进——它们按 SQLite 语义判才对。
    expect(
      classifyPostgresqlSurfaceFile('sqliteFooRepository.ts', 'const r = db.select().from(t)'),
    ).toBeNull()
  })
})
