// RFC-359 —— 双引擎 harness 里**干真活的钩子**一律不许吃 bun 的 5s 默认预算。
//
// 由来：`describeEachProvider` 的两条泳道各自在 `beforeEach` 里做真活——PG 那侧是对一台真
// PostgreSQL 做整库快照恢复，SQLite 那侧是新建一个内存库并重放全部迁移。两者都会在 runner
// 一忙时偶尔越过 5s，于是随机某条用例以「a beforeEach/afterEach hook timed out for this test」
// 收场，**与被测代码无关**。同一类红出现过两次，两次都只修了当时那一侧：
//
//   · 2026-09-11：real-PostgreSQL 泳道（`rfc359-w14-legacy-mission-execution`）——PG 侧的
//     `beforeAll` / `beforeEach` / `afterAll` 补上显式预算；
//   · 2026-09-18：`Backend tests (macos-latest shard 4/6)`（`rfc258-file-symbols` 第一条用例，
//     5254.97ms）——SQLite 侧的 `beforeEach` 一直吃默认值，同一类红换个泳道又来一次。
//     成因不是「SQLite 建库慢」而是**进程内第一次**建库要付一次性成本：同进程连续六次
//     `createInMemoryDb(MIGRATIONS)`（73 个迁移）实测 354.0 / 3.0 / 2.7 / 2.8 / 2.9 / 2.7 ms，
//     首次贵两个数量级；`bun test --isolate` 每文件一个新进程，于是**每个文件的第一条用例**
//     都要付这一次。
//
// 所以判据不写成「某一侧记得加」，而写成**结构律**：钩子体里只要出现建库 / 恢复库 / 拆库这类
// 真活，就必须显式带上第二个参数（预算）。纯同步清理的 `afterEach` 不在其内——那是
// `rfc359-w39-provider-harness-lifecycle-diagnostics` 里写明的判断（不做 IO，给预算无意义），
// 本判据不许把它一并卷进来。将来新增泳道时忘了给预算，这条会当场红——不必等某个晚上某个
// 分片随机红一次才发现。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const HARNESS_PATH = 'packages/backend/tests/helpers/eachProvider.ts'
/** 一次真活（整库恢复 / 建库重放迁移）在繁忙 runner 上的合理上限；低于它等于没给预算。 */
const MINIMUM_HOOK_BUDGET_MS = 10_000
/**
 * 「干真活」的判据：钩子体里出现这些符号之一，就是在建库 / 恢复库 / 拆库 / 关连接。
 * 按符号而不是按钩子名分类——加一条新泳道时，名字可以随便起，活干没干骗不过去。
 */
const REAL_WORK_SYMBOLS = [
  'createInMemoryDb',
  'MIGRATIONS',
  'setupDatabases',
  'resetDatabases',
  'cleanupDatabases',
  'resetToSnapshot',
  'closeAll',
  'createPostgresqlFileDatabase',
  'createPostgresqlHarnessDatabase',
] as const

const HOOK_NAMES = ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const

interface HookRegistration {
  readonly hook: string
  readonly enclosing: string
  readonly argumentCount: number
  readonly realWork: readonly string[]
  readonly line: number
}

function harnessSource(): { source: string; ast: ts.SourceFile } {
  const source = readFileSync(resolve(ROOT, HARNESS_PATH), 'utf8')
  return {
    source,
    ast: ts.createSourceFile('eachProvider.ts', source, ts.ScriptTarget.Latest, true),
  }
}

/** 钩子注册点：所在函数、实参个数（1 = 吃默认预算）、体内出现的真活符号。 */
function hookRegistrations(ast: ts.SourceFile): HookRegistration[] {
  const out: HookRegistration[] = []
  const walk = (node: ts.Node, enclosing: string): void => {
    const nextEnclosing =
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name !== undefined
        ? node.name.text
        : enclosing
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (HOOK_NAMES as readonly string[]).includes(node.expression.text)
    ) {
      // 只看**第一个实参**（钩子体）：预算本身写成 `databaseCount * X_TIMEOUT_MS`，
      // 把它算进来会让每个带预算的钩子都「看起来在干真活」。
      const body = node.arguments[0]?.getText(ast) ?? ''
      out.push({
        hook: node.expression.text,
        enclosing: nextEnclosing,
        argumentCount: node.arguments.length,
        realWork: REAL_WORK_SYMBOLS.filter((symbol) =>
          new RegExp(`\\b${symbol}\\b`, 'u').test(body),
        ),
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      })
    }
    ts.forEachChild(node, (child) => walk(child, nextEnclosing))
  }
  walk(ast, '<module>')
  return out
}

describe('RFC-359 双引擎 harness 的钩子预算', () => {
  test('凡在钩子里建库 / 恢复库 / 拆库的，都显式带预算——没有一个吃 bun 的 5s 默认值', () => {
    const registrations = hookRegistrations(harnessSource().ast)
    const realWork = registrations.filter((entry) => entry.realWork.length > 0)
    // 语料非空：扫不到真活钩子就等于假绿（改了符号名 / 挪走了钩子都会打在这一格上）。
    expect(realWork.length).toBeGreaterThanOrEqual(4)
    const defaulted = realWork
      .filter((entry) => entry.argumentCount < 2)
      .map(
        (entry) =>
          `${HARNESS_PATH}:${entry.line} ${entry.enclosing} → ${entry.hook}() ` +
          `[${entry.realWork.join(',')}]`,
      )
    expect(defaulted).toEqual([])
  })

  test('两条泳道各自都有一个干真活的每用例钩子（别把某一侧整个漏掉）', () => {
    const perTest = hookRegistrations(harnessSource().ast).filter(
      (entry) => entry.hook === 'beforeEach' && entry.realWork.length > 0,
    )
    expect(perTest.map((entry) => entry.enclosing).sort()).toEqual([
      'registerPostgresql',
      'registerSqlite',
    ])
  })

  test('纯同步清理的 afterEach 不在判据内（W39 写明的判断，不许被这条守卫卷进来）', () => {
    const cleanups = hookRegistrations(harnessSource().ast).filter(
      (entry) =>
        entry.hook === 'afterEach' &&
        (entry.enclosing === 'registerSqlite' || entry.enclosing === 'registerPostgresql'),
    )
    expect(cleanups.length).toBe(2)
    expect(cleanups.map((entry) => entry.realWork)).toEqual([[], []])
  })

  test('预算常量不许小到没意义（把 30_000 改成 100 这条就红）', () => {
    const { source } = harnessSource()
    const budgets = [...source.matchAll(/const (\w*_TIMEOUT_MS) = ([\d_]+)\n/gu)].map(
      ([, name, value]) => ({ name: name!, ms: Number(value!.replaceAll('_', '')) }),
    )
    expect(budgets.map((entry) => entry.name).sort()).toEqual([
      'POSTGRESQL_DATABASE_CLEANUP_TIMEOUT_MS',
      'POSTGRESQL_DATABASE_RESET_TIMEOUT_MS',
      'POSTGRESQL_DATABASE_SETUP_TIMEOUT_MS',
      'SQLITE_DATABASE_RESET_TIMEOUT_MS',
    ])
    const tooSmall = budgets
      .filter((entry) => entry.ms < MINIMUM_HOOK_BUDGET_MS)
      .map((entry) => `${entry.name}=${entry.ms}ms`)
    expect(tooSmall).toEqual([])
  })
})
