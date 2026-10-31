// RFC-311 —— 语句录制器：性能防护用例的公共底座。
// RFC-397：另记派发与失败，避免成功视图掩盖事务重放；既有 statements 语义不变。
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
  /**
   * RFC-359 W6-T27 —— 绑定参数的**值**。SQLite 侧取计划可以用 NULL 占位（`params` 个数够了），
   * PostgreSQL 侧不行：`EXPLAIN` 的计划随参数值而变（`x = NULL` 恒不成立，会选出生产里
   * 根本不存在的计划）。双引擎的计划审计要拿真值去 EXPLAIN，所以值必须一起录下来。
   */
  readonly values: readonly unknown[]
}

export interface DispatchedStatement {
  readonly sql: string
  readonly values: readonly unknown[]
  failedWith?: string
}

/** Bun.SQL 的 SQLSTATE 在 errno，另一些驱动在 code；Drizzle 把原错误放在 cause。 */
export function statementFailureCode(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  let fallback: string | undefined
  for (let current = error; typeof current === 'object' && current !== null; ) {
    if (seen.has(current)) break
    seen.add(current)
    const detail = current as { errno?: unknown; code?: unknown; cause?: unknown }
    for (const code of [detail.errno, detail.code]) {
      if (typeof code !== 'string') continue
      if (/^[0-9A-Z]{5}$/.test(code)) return code
      fallback ??= code
    }
    current = detail.cause
  }
  return fallback
}

export interface StatementRecording {
  readonly dispatched: DispatchedStatement[]
  readonly statements: RecordedStatement[]
  /** 只保留 SELECT（EXPLAIN 只对读有意义）。 */
  selects(): RecordedStatement[]
  stop(): void
}

type TransactionInvoker = ((...args: unknown[]) => unknown) & {
  deferred: (...args: unknown[]) => unknown
  immediate: (...args: unknown[]) => unknown
  exclusive: (...args: unknown[]) => unknown
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
  const dispatched: DispatchedStatement[] = []
  const nativeBegins: DispatchedStatement[] = []
  const issue = <T>(sql: string, values: readonly unknown[], run: () => T): T => {
    const nativeBegin = nativeBegins.at(-1)
    const entry = nativeBegin && /^\s*begin\b/i.test(sql) ? nativeBegin : { sql, values }
    if (entry !== nativeBegin) dispatched.push(entry)
    try {
      return run()
    } catch (error) {
      entry.failedWith = statementFailureCode(error) ?? 'unknown'
      throw error
    }
  }
  const originals = new Map<string, unknown>()

  const recordTransaction = <T>(behavior: string, run: () => T): T => {
    const start = statements.length
    const begin = {
      sql: behavior === 'deferred' ? 'BEGIN' : `BEGIN ${behavior.toUpperCase()}`,
      params: 0,
      rows: 0,
      values: [] as readonly unknown[],
    }
    const ensureBegin = (): void => {
      if (!statements.slice(start).some((statement) => /^\s*begin\b/i.test(statement.sql))) {
        statements.splice(start, 0, begin)
      }
    }
    const dispatchedBegin: DispatchedStatement = { sql: begin.sql, values: [] }
    dispatched.push(dispatchedBegin)
    nativeBegins.push(dispatchedBegin)
    const dispatchStart = dispatched.length
    try {
      const result = run()
      if (!dispatched.slice(dispatchStart).some((s) => /^\s*commit\b/i.test(s.sql)))
        dispatched.push({ sql: 'COMMIT', values: [] })
      ensureBegin()
      if (!statements.slice(start).some((statement) => /^\s*commit\b/i.test(statement.sql))) {
        statements.push({ sql: 'COMMIT', params: 0, rows: 0, values: [] })
      }
      return result
    } catch (error) {
      if (!dispatched.slice(dispatchStart).some((s) => /^\s*rollback\b/i.test(s.sql)))
        dispatched.push({ sql: 'ROLLBACK', values: [] })
      ensureBegin()
      if (!statements.slice(start).some((statement) => /^\s*rollback\b/i.test(statement.sql))) {
        statements.push({ sql: 'ROLLBACK', params: 0, rows: 0, values: [] })
      }
      throw error
    } finally {
      nativeBegins.pop()
    }
  }

  const wrapStatement = (stmt: object, sql: string): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown
        if (typeof value !== 'function') return value
        const bound = (value as (...a: unknown[]) => unknown).bind(target)
        if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'values') {
          return (...args: unknown[]) => {
            const out = issue(sql, args, () => bound(...args))
            const rows = Array.isArray(out) ? out.length : out === undefined || out === null ? 0 : 1
            statements.push({ sql, params: countParams(args), rows, values: args })
            return out
          }
        }
        return bound
      },
    })

  for (const method of ['prepare', 'query'] as const) {
    const orig = (sqlite[method] as (...a: unknown[]) => object).bind(sqlite)
    originals.set(method, sqlite[method])
    ;(sqlite as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      try {
        return wrapStatement(orig(...args), String(args[0]))
      } catch (error) {
        // 编译失败没有 statement 可执行，但这次派发仍必须可见。
        dispatched.push({
          sql: String(args[0]),
          values: [],
          failedWith: statementFailureCode(error) ?? 'unknown',
        })
        throw error
      }
    }
  }
  const origExec = (sqlite.exec as (...a: unknown[]) => unknown).bind(sqlite)
  originals.set('exec', sqlite.exec)
  ;(sqlite as unknown as Record<string, unknown>).exec = (...args: unknown[]) => {
    statements.push({
      sql: String(args[0]),
      params: Math.max(0, args.length - 1),
      rows: 0,
      values: args.slice(1),
    })
    return issue(String(args[0]), args.slice(1), () => origExec(...args))
  }

  // Bun 1.4 executes Database.transaction() inside the native binding instead
  // of routing its BEGIN / COMMIT / ROLLBACK through the overridable exec()
  // method, while earlier runtimes do route those statements through exec().
  // Keep the recorder attached to the public transaction boundary, but add a
  // synthetic boundary only when the native path did not already expose one.
  const origTransaction = sqlite.transaction.bind(sqlite) as unknown as (
    callback: (...args: unknown[]) => unknown,
  ) => TransactionInvoker
  originals.set('transaction', sqlite.transaction)
  ;(sqlite as unknown as Record<string, unknown>).transaction = (
    callback: (...args: unknown[]) => unknown,
  ) => {
    const transaction = origTransaction(callback)
    return Object.assign(
      (...args: unknown[]) =>
        recordTransaction('deferred', () => Reflect.apply(transaction, undefined, args)),
      {
        deferred: (...args: unknown[]) =>
          recordTransaction('deferred', () =>
            Reflect.apply(transaction.deferred, transaction, args),
          ),
        immediate: (...args: unknown[]) =>
          recordTransaction('immediate', () =>
            Reflect.apply(transaction.immediate, transaction, args),
          ),
        exclusive: (...args: unknown[]) =>
          recordTransaction('exclusive', () =>
            Reflect.apply(transaction.exclusive, transaction, args),
          ),
      },
    )
  }

  return {
    dispatched,
    statements,
    selects: () => statements.filter((s) => /^[\s(]*select/i.test(s.sql)),
    stop: () => {
      for (const [k, v] of originals) (sqlite as unknown as Record<string, unknown>)[k] = v
    },
  }
}
