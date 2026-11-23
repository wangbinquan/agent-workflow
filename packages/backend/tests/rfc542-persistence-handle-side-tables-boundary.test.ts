// RFC-542 — 行规则错误翻译与单行写入的按句柄侧表归各自的句柄（RFC-294 S12 第二十三步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① `platform/persistence/schema/rowRules.ts` 与 `platform/persistence/singleInsert.ts` 顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，在架构
//    报告的模块级可变单例判据里为空；生产代码不再引用删去的名字（语料下限 3,000）。
// ② 行为：两个库各记各的单行写入，派生对象、包着根库的代理与没登记的库走普通写入；同一会话只套一次行规则翻译（重复绑定不再包一层），
//    事务进入时套上。代理一条是 RFC-542 集中验证查出的本人缺陷的回归锁：最初按 `Object.hasOwn` 认根库，而代理的默认 trap 把属性读转发
//    给根库，包着根库的代理（测试里用它拦截 insert 或模拟写失败，如 `rfc359-w7-resource-limit-conformance` 的“audit sink is down”）
//    在已标记代际的 PostgreSQL 库上会拿到根库的围栏写入、绕过拦截（把修复前的写法放回去，那条用例的 PostgreSQL 一支就红）；按身份键的
//    旧表从不认代理。现在槽里记登记时的对象本身，只认它。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { bindSingleInsert, insertOne } from '@/platform/persistence/singleInsert'
import { bindSchemaRowRuleErrors } from '@/platform/persistence/schema/rowRules'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const ROW_RULES = SRC + 'platform/persistence/schema/rowRules.ts'
const SINGLE_INSERT = SRC + 'platform/persistence/singleInsert.ts'
const CORPUS_TIMEOUT = 30_000
/** The module registries RFC-542 removed; production must not name them again. */
const REMOVED = ['boundSessions', 'inserts']
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])

export function handleSideTableViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  for (const path of [ROW_RULES, SINGLE_INSERT]) {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) {
      errors.add('missing source: ' + path)
      continue
    }
    const file = path.slice(path.lastIndexOf('/') + 1)
    for (const statement of unit.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(unit.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:${file}:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(unit.source))
        )
          errors.add(`module-level collection:${file}:${name}`)
        if (REMOVED.includes(name)) errors.add(`removed name:${file}:${name}`)
      }
    }
    for (const entry of mutableSingletons([unit]))
      errors.add(`mutable singleton:${file}:${entry.symbol}`)
  }
  return [...errors].sort()
}

describe('RFC-542 ① 两张按句柄的侧表不在模块级', () => {
  test(
    '真实语料：行规则与单行写入两个文件没有模块级状态，删去的登记表名字不在',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(handleSideTableViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

type FakeTable = Parameters<typeof insertOne>[1]
const TABLE = {} as FakeTable
/** A fake handle whose ordinary insert records itself. */
function fakeDatabase(name: string, log: string[]) {
  return {
    insert: () => ({
      values: () => ({
        run: () => {
          log.push(`${name}:ordinary`)
          return { changes: 1 }
        },
      }),
    }),
  } as unknown as Parameters<typeof insertOne>[0]
}

describe('RFC-542 ② 侧表随对象走的行为', () => {
  test('两个库各记各的单行写入；派生对象、包着根库的代理与没登记的库走普通写入', async () => {
    const log: string[] = []
    const first = fakeDatabase('first', log)
    const second = fakeDatabase('second', log)
    const third = fakeDatabase('third', log)
    bindSingleInsert(first, async () => {
      log.push('first:fenced')
      return { count: 1 }
    })
    bindSingleInsert(second, async () => {
      log.push('second:fenced')
      return { count: 1 }
    })
    await insertOne(first, TABLE, {} as never)
    await insertOne(second, TABLE, {} as never)
    // A derived handle (a transaction is another object) keeps the ordinary insert of what it derives from.
    await insertOne(Object.create(first) as typeof first, TABLE, {} as never)
    // A proxy forwards property reads to the root, yet it is another object: it keeps the ordinary insert.
    await insertOne(new Proxy(first, {}), TABLE, {} as never)
    await insertOne(third, TABLE, {} as never)
    expect(log).toEqual([
      'first:fenced',
      'second:fenced',
      'first:ordinary',
      'first:ordinary',
      'third:ordinary',
    ])
  })

  test('拦截 insert 的代理照旧拦得住（不会被根库的围栏写入绕过）', () => {
    const root = fakeDatabase('root', [])
    bindSingleInsert(root, async () => ({ count: 1 }))
    const failing = new Proxy(root, {
      get(target, property) {
        if (property === 'insert')
          return () => {
            throw new Error('audit sink is down')
          }
        return Reflect.get(target, property) as unknown
      },
    })
    expect(() => insertOne(failing, TABLE, {} as never)).toThrow('audit sink is down')
  })

  test('同一会话只套一次行规则翻译；事务进入时给事务的会话套上', () => {
    const calls: string[] = []
    const txSession: Record<string, unknown> = { run: () => calls.push('tx:run') }
    const session: Record<string, unknown> = {
      run: () => calls.push('run'),
      transaction: (body: (tx: object) => unknown) => body({ session: txSession }),
    }
    const handle = { session }
    const codes = new Map<string, string>()
    bindSchemaRowRuleErrors(handle, codes)
    const wrapped = session.run
    bindSchemaRowRuleErrors(handle, codes)
    expect(session.run).toBe(wrapped)
    ;(session.run as () => unknown)()
    expect(calls).toEqual(['run'])
    const txRun = txSession.run
    ;(
      session.transaction as (
        body: (tx: { session: Record<string, unknown> }) => unknown,
      ) => unknown
    )((tx) => (tx.session.run as () => unknown)())
    expect(txSession.run).not.toBe(txRun)
    expect(calls).toEqual(['run', 'tx:run'])
  })
})

describe('RFC-542 负对照', () => {
  const clean = [
    sourceUnit(
      ROW_RULES,
      "const rowRulesBound = Symbol('bound')\nexport function bindSchemaRowRuleErrors(handle, codes) { Object.defineProperty(handle.session, rowRulesBound, { value: true }) }",
    ),
    sourceUnit(
      SINGLE_INSERT,
      "const singleInsertKey = Symbol('insert')\nexport function bindSingleInsert(db, insert) { Object.defineProperty(db, singleInsertKey, { value: insert }) }",
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(handleSideTableViolations(clean)).toEqual([])
  })

  test('模块级的登记表都会被认出', () => {
    expect(
      handleSideTableViolations(
        replace(
          ROW_RULES,
          'const boundSessions = new WeakSet()\nexport function bindSchemaRowRuleErrors(handle, codes) { boundSessions.add(handle.session) }',
        ),
      ),
    ).toEqual([
      'module-level collection:rowRules.ts:boundSessions',
      'mutable singleton:rowRules.ts:bindSchemaRowRuleErrors',
      'removed name:rowRules.ts:boundSessions',
    ])
    expect(
      handleSideTableViolations(
        replace(
          SINGLE_INSERT,
          'let inserts = new WeakMap()\nexport function bindSingleInsert(db, insert) { inserts.set(db, insert) }',
        ),
      ),
    ).toEqual([
      'module-level collection:singleInsert.ts:inserts',
      'module-level let:singleInsert.ts:inserts',
      'mutable singleton:singleInsert.ts:bindSingleInsert',
      'mutable singleton:singleInsert.ts:inserts',
      'removed name:singleInsert.ts:inserts',
    ])
  })
})
