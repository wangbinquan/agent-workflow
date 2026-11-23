// RFC-549 — schema 历史运行时由组合根显式交给 platform（RFC-294 S12 第二十八步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① `platform/persistence/schema/history/runtime.ts` 顶层没有 `let`，模块级可变单例判据为空；删去的登记与读取函数在生产代码里不出现；
//    bootstrap 的替换口在生产代码里只有定义、没有调用（语料下限 3,000）。
// ② 行为：`runtimeHistoryAdmission` 按交入的历史给出 head、元数据表与目录缓存；bootstrap 的绑定带着二进制自己的历史；替换口换过之后绑定
//    读到新的 head、`next` 收到的是被替换的来源，复原后回到原来的；句柄的 live 绑定带着历史；Worker 的初始化消息必须带元数据表。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { persistenceHead, persistenceHistory } from '@/bootstrap/persistenceHead'
import {
  persistenceSchemaBinding,
  substitutePersistenceSchemaHistory,
} from '@/bootstrap/persistenceSchema'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import {
  HistoryCatalogCache,
  postgresqlCatalogLoader,
} from '@/platform/persistence/schema/history/catalog'
import {
  runtimeHistoryAdmission,
  type SchemaHistoryRuntime,
} from '@/platform/persistence/schema/history/runtime'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'
import { bindDatabaseHandle, liveSchemaOf } from '@/platform/persistence/sessionTables'
import {
  SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
  SqliteLogicalSourceWorkerRequestSchema,
} from '@/platform/persistence/sqliteLogicalSourceProtocol'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const RUNTIME = SRC + 'platform/persistence/schema/history/runtime.ts'
const BOOTSTRAP = SRC + 'bootstrap/persistenceSchema.ts'
const SEAM = 'substitutePersistenceSchemaHistory'
const CORPUS_TIMEOUT = 30_000
/** The registration RFC-549 removed; production must not name it again. */
const REMOVED = ['registerSchemaHistoryRuntime', 'schemaHistoryRuntime']

export function schemaHistoryRuntimeViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const runtime = units.find((unit) => unit.path === RUNTIME)
  if (runtime === undefined) errors.add('missing source: ' + RUNTIME)
  else {
    for (const statement of runtime.source.statements)
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
        for (const declaration of statement.declarationList.declarations)
          errors.add(`module-level let:${declaration.name.getText(runtime.source)}`)
    for (const entry of mutableSingletons([runtime]))
      errors.add(`mutable singleton:${entry.symbol}`)
  }
  let seamDeclared = false
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    const walk = (node: ts.Node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`names ${node.text}: ${unit.path}`)
      if (ts.isFunctionDeclaration(node) && node.name?.text === SEAM && unit.path === BOOTSTRAP)
        seamDeclared = true
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === SEAM
      )
        errors.add(`calls ${SEAM}: ${unit.path}`)
      node.forEachChild(walk)
    }
    walk(unit.source)
  }
  if (!seamDeclared) errors.add(`${SEAM} is not declared in ${BOOTSTRAP}`)
  return [...errors].sort()
}

describe('RFC-549 ① schema 历史不在 platform 的模块级', () => {
  test(
    '真实语料：runtime.ts 没有模块级状态，删去的名字不出现，替换口只在 bootstrap 定义、生产代码不调用',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(schemaHistoryRuntimeViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-549 ② 历史由调用方交入', () => {
  test('准入按交入的历史给出 head、元数据表与目录缓存；不带目录缓存时按 head 的目录现建一份', () => {
    const head = persistenceHead()
    const cache = new HistoryCatalogCache(postgresqlCatalogLoader([]))
    const admission = runtimeHistoryAdmission({
      head: () => head,
      metaTables: [],
      catalogCache: () => cache,
    })
    expect(admission.binary).toBe(head)
    expect(admission.metaTables).toEqual([])
    expect(admission.catalogCache).toBe(cache)
    const fallback = runtimeHistoryAdmission({ head: () => head, metaTables: EPOCH2_META_TABLES })
    expect(fallback.metaTables).toBe(EPOCH2_META_TABLES)
    expect(fallback.catalogCache).toBeInstanceOf(HistoryCatalogCache)
  })

  test('bootstrap 的绑定带着二进制自己的历史', () => {
    const history = persistenceSchemaBinding.history
    expect(history.head()).toEqual(persistenceHead())
    expect(history.history?.()).toEqual(persistenceHistory())
    expect(history.metaTables).toBe(EPOCH2_META_TABLES)
    expect(history.catalogCache?.()).toBeInstanceOf(HistoryCatalogCache)
  })

  test('替换口：换过之后绑定读到新的 head，next 收到被替换的来源，没给的照旧，复原后回到原来的', () => {
    const before = persistenceSchemaBinding.history.head()
    const successor = {
      ...before,
      contract: { ...before.contract, version: before.contract.version + 1 },
    } as HistoryVersion
    let replaced: SchemaHistoryRuntime | undefined
    const restore = substitutePersistenceSchemaHistory((previous) => {
      replaced = previous
      return { head: () => successor }
    })
    try {
      expect(persistenceSchemaBinding.history.head()).toBe(successor)
      expect(replaced?.head()).toEqual(before)
      expect(persistenceSchemaBinding.history.metaTables).toBe(EPOCH2_META_TABLES)
    } finally {
      restore()
    }
    expect(persistenceSchemaBinding.history.head()).toEqual(before)
  })

  test('句柄的 live 绑定带着历史；没有 live 绑定的句柄报错', () => {
    const live = bindDatabaseHandle({}, {} as never, {} as never, persistenceSchemaBinding)
    expect(liveSchemaOf(live).history).toBe(persistenceSchemaBinding.history)
    const epoch1 = bindDatabaseHandle({}, {} as never, {} as never, null)
    expect(() => liveSchemaOf(epoch1)).toThrow('no live schema binding')
  })

  test('Worker 的初始化消息必须带元数据表', () => {
    const init = {
      version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
      requestId: 'sls_1',
      type: 'init',
      path: '/tmp/source.sqlite',
      expectedSchemaDigest: `sha256:${'a'.repeat(64)}`,
      contract: {},
    }
    expect(SqliteLogicalSourceWorkerRequestSchema.safeParse(init).success).toBe(false)
    expect(
      SqliteLogicalSourceWorkerRequestSchema.safeParse({
        ...init,
        metaTables: 'aw_meta_generations',
      }).success,
    ).toBe(false)
    expect(
      SqliteLogicalSourceWorkerRequestSchema.safeParse({ ...init, metaTables: [] }).success,
    ).toBe(true)
  })
})

describe('RFC-549 负对照', () => {
  const clean = [
    sourceUnit(RUNTIME, 'export function runtimeHistoryAdmission() {}\n'),
    sourceUnit(BOOTSTRAP, `export function ${SEAM}() {}\n`),
  ]

  test('伪造的干净语料没有违例', () => {
    expect(schemaHistoryRuntimeViolations(clean)).toEqual([])
  })

  test('模块级登记、读取函数与生产代码调用替换口都会被认出', () => {
    const units = [
      sourceUnit(
        RUNTIME,
        'let binding = undefined\nexport function registerSchemaHistoryRuntime(value) { binding = value }\n',
      ),
      clean[1]!,
      sourceUnit(SRC + 'db/client.ts', `${SEAM}(() => ({}))\nschemaHistoryRuntime().head()\n`),
    ]
    expect(schemaHistoryRuntimeViolations(units)).toEqual([
      `calls ${SEAM}: ${SRC}db/client.ts`,
      'module-level let:binding',
      'mutable singleton:binding',
      'mutable singleton:registerSchemaHistoryRuntime',
      `names registerSchemaHistoryRuntime: ${RUNTIME}`,
      `names schemaHistoryRuntime: ${SRC}db/client.ts`,
    ])
  })

  test('替换口不在 bootstrap 也会被认出', () => {
    expect(schemaHistoryRuntimeViolations([clean[0]!])).toEqual([
      `${SEAM} is not declared in ${BOOTSTRAP}`,
    ])
  })
})
