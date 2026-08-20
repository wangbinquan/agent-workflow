// RFC-311 —— 语句录制器：性能防护用例的公共底座。
//
// 为什么不手写 EXPLAIN 断言：仓里既有的计划断言都把 SQL **字面量抄进测试**
// （`EXPLAIN QUERY PLAN SELECT * FROM cached_repos …`）。那种写法只能锁住抄进去的
// 那一条，实现改了形状测试照样绿，而且抄错一个字就变成断言一条**生产里不存在**的
// 查询。录制器反过来：让被测代码正常跑，把它**实际执行**的每条语句连同绑定参数
// 抓下来，再逐条审计。新加的查询自动进入审计面，不需要有人记得补断言。
//
// 实现形状照抄 `src/db/client.ts` 的 `instrumentSlowStatements`（bun:sqlite 没有
// query hook，只能包 `prepare` / `query` / `exec` 三个入口），包括那条踩过的坑：
// 取值时不能把 receiver 传给 native getter，否则读一次 `columnNames` 就炸。

import type { Database } from 'bun:sqlite'

export interface RecordedStatement {
  readonly sql: string
  /** 绑定参数个数——SQLite 有 32766 的硬上限，无界 `IN (…)` 会在生产上直接抛。 */
  readonly params: number
  /**
   * 这条语句**取回了多少行**。查询形状对了不代表体量对了：一条走索引、只发一次的
   * `SELECT` 照样可以把整张表搬进内存（旧的 `listMissionSummaries` 就是），而它在
   * 只看计划的判据下完全干净。行数是唯一能把「无界结果集」这一类抓出来的信号。
   */
  readonly rows: number
}

export interface StatementRecording {
  readonly statements: RecordedStatement[]
  /** 只保留 SELECT（EXPLAIN 只对读有意义）。 */
  selects(): RecordedStatement[]
  stop(): void
}

function countParams(args: unknown[]): number {
  if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !Array.isArray(args[0])
  )
    return Object.keys(args[0] as Record<string, unknown>).length
  return args.length
}

/**
 * 包住一个 bun:sqlite 连接，录制其后执行的每条语句。`stop()` 还原。
 * 注意它包的是**连接**而不是 drizzle，所以 drizzle 与裸 SQL 两条路都抓得到。
 */
export function recordStatements(sqlite: Database): StatementRecording {
  const statements: RecordedStatement[] = []
  const originals = new Map<string, unknown>()

  const wrapStatement = (stmt: object, sql: string): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown
        if (typeof value !== 'function') return value
        const bound = (value as (...a: unknown[]) => unknown).bind(target)
        if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'values') {
          return (...args: unknown[]) => {
            const out = bound(...args)
            const rows = Array.isArray(out) ? out.length : out === undefined || out === null ? 0 : 1
            statements.push({ sql, params: countParams(args), rows })
            return out
          }
        }
        return bound
      },
    })

  for (const method of ['prepare', 'query'] as const) {
    const orig = (sqlite[method] as (...a: unknown[]) => object).bind(sqlite)
    originals.set(method, sqlite[method])
    ;(sqlite as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      wrapStatement(orig(...args), String(args[0]))
  }
  const origExec = (sqlite.exec as (...a: unknown[]) => unknown).bind(sqlite)
  originals.set('exec', sqlite.exec)
  ;(sqlite as unknown as Record<string, unknown>).exec = (...args: unknown[]) => {
    statements.push({ sql: String(args[0]), params: Math.max(0, args.length - 1), rows: 0 })
    return origExec(...args)
  }

  return {
    statements,
    selects: () => statements.filter((s) => /^\s*select/i.test(s.sql)),
    stop: () => {
      for (const [k, v] of originals) (sqlite as unknown as Record<string, unknown>)[k] = v
    },
  }
}
