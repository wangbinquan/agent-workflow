// RFC-545 — live 持久化 schema 由组合根显式交给 provider 构造（RFC-294 S12 第二十五步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① `platform/persistence/schema/tables.ts` 顶层没有 `let` 与集合，在架构报告的模块级可变单例判据里为空；删去的登记与读取函数在生产代码里
//    不出现（语料下限 3,000）；bootstrap 不再调登记函数。
// ② 行为：带 live 绑定的句柄 `tablesOf` 返回原生表集（继承句柄随之）；没有 live 绑定、或表集不是 live 里这个引擎的那一份，照旧报
//    “no epoch-2 table set”；bootstrap 的 live 绑定常量就是它导出的原生表集与行规则错误码。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  nativeTableSets,
  persistenceSchemaBinding,
  rowRuleCodes,
} from '@/bootstrap/persistenceSchema'
import {
  createPostgresqlCapabilities,
  createSqliteCapabilities,
} from '@/platform/persistence/capabilities'
import {
  bindDatabaseHandle,
  inheritDatabaseHandle,
  tablesOf,
} from '@/platform/persistence/sessionTables'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const TABLES = SRC + 'platform/persistence/schema/tables.ts'
const CORPUS_TIMEOUT = 30_000
/** The registration RFC-545 removed; production must not name it again. */
const REMOVED = ['liveBinding', 'registerPersistenceSchema']
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])

function identifiers(unit: SourceUnit): Set<string> {
  const names = new Set<string>()
  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node)) names.add(node.text)
    node.forEachChild(walk)
  }
  walk(unit.source)
  return names
}

export function liveSchemaRegistrationViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const tables = units.find((unit) => unit.path === TABLES)
  if (tables === undefined) errors.add('missing source: ' + TABLES)
  else {
    for (const statement of tables.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(tables.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(tables.source))
        )
          errors.add(`module-level collection:${name}`)
      }
    }
    for (const entry of mutableSingletons([tables])) errors.add(`mutable singleton:${entry.symbol}`)
  }
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    const names = identifiers(unit)
    for (const removed of REMOVED)
      if (names.has(removed)) errors.add(`names ${removed}: ${unit.path}`)
  }
  return [...errors].sort()
}

describe('RFC-545 ① live schema 不在模块级', () => {
  test(
    '真实语料：schema/tables.ts 没有模块级状态，生产代码不再登记 live schema',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(liveSchemaRegistrationViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-545 ② live 绑定随句柄交入', () => {
  test('bootstrap 的 live 绑定常量就是它导出的原生表集与行规则错误码，且冻结', () => {
    expect(persistenceSchemaBinding.nativeTables).toBe(nativeTableSets)
    expect(persistenceSchemaBinding.rowRuleCodes).toBe(rowRuleCodes)
    expect(Object.isFrozen(persistenceSchemaBinding)).toBe(true)
  })

  test('带 live 绑定的句柄取得原生表集，继承句柄随之；没有 live 绑定或表集不对照旧报错', () => {
    for (const engine of [createSqliteCapabilities(), createPostgresqlCapabilities()]) {
      const tables = nativeTableSets[engine.provider]
      const live = bindDatabaseHandle({}, tables, engine, persistenceSchemaBinding)
      expect(tablesOf(live)).toBe(tables)
      expect(tablesOf(inheritDatabaseHandle({}, live))).toBe(tables)
      const withoutLive = bindDatabaseHandle({}, tables, engine)
      expect(() => tablesOf(withoutLive)).toThrow('no epoch-2 table set')
      const other =
        engine.provider === 'sqlite' ? nativeTableSets.postgresql : nativeTableSets.sqlite
      const mismatched = bindDatabaseHandle({}, other as never, engine, persistenceSchemaBinding)
      expect(() => tablesOf(mismatched)).toThrow('no epoch-2 table set')
    }
  })
})

describe('RFC-545 负对照', () => {
  const clean = sourceUnit(
    TABLES,
    'export interface RuntimeSchemaBinding { readonly rowRuleCodes: ReadonlyMap<string, string> }\n',
  )

  test('伪造的干净语料没有违例', () => {
    expect(liveSchemaRegistrationViolations([clean])).toEqual([])
  })

  test('模块级登记与生产代码里的登记调用都会被认出', () => {
    expect(
      liveSchemaRegistrationViolations([
        sourceUnit(
          TABLES,
          'let liveBinding: object | undefined\nexport function registerPersistenceSchema(binding: object): void { liveBinding = binding }\n',
        ),
      ]),
    ).toEqual([
      `module-level let:liveBinding`,
      `mutable singleton:liveBinding`,
      `mutable singleton:registerPersistenceSchema`,
      `names liveBinding: ${TABLES}`,
      `names registerPersistenceSchema: ${TABLES}`,
    ])
    expect(
      liveSchemaRegistrationViolations([
        clean,
        sourceUnit(SRC + 'bootstrap/persistenceSchema.ts', 'registerPersistenceSchema({})\n'),
      ]),
    ).toEqual([`names registerPersistenceSchema: ${SRC}bootstrap/persistenceSchema.ts`])
  })
})
