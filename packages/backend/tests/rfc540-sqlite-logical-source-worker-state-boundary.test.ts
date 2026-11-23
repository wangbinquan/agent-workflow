// RFC-540 — SQLite 逻辑源 Worker 的状态归每个 Worker 的处理器（RFC-294 S12 第二十一步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① Worker 入口 `platform/persistence/sqliteLogicalSourceWorker.ts` 与处理器 `sqliteLogicalSourceWorkerHandler.ts` 顶层没有 `let` 与
//    `new Map / Set / WeakMap / WeakSet`，在架构报告的模块级可变单例判据里为空；入口只调一次 `createSqliteLogicalSourceWorkerHandler(`，
//    `self.onmessage` 把消息体交给它（语料下限 3,000）。
// ② 行为：两个处理器在进程内各自初始化、互不相通（一个初始化后另一个仍拒绝读取）；重复初始化与未知表照旧回 `failure`；关闭后回 `closed`、
//    调 `io.close()`，再读被拒。
// 负对照只喂伪造的源码，不碰真实语料。
import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { createFrozenEpoch1Db } from './migration-freeze'
import { buildFrozenEpoch1LogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION } from '@/platform/persistence/sqliteLogicalSourceProtocol'
import type { SqliteLogicalSourceWorkerEvent } from '@/platform/persistence/sqliteLogicalSourceProtocol'
import { createSqliteLogicalSourceWorkerHandler } from '@/platform/persistence/sqliteLogicalSourceWorkerHandler'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const ENTRY = SRC + 'platform/persistence/sqliteLogicalSourceWorker.ts'
const HANDLER = SRC + 'platform/persistence/sqliteLogicalSourceWorkerHandler.ts'
const CORPUS_TIMEOUT = 30_000
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
const FACTORY = 'createSqliteLogicalSourceWorkerHandler'

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

export function workerStateViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const find = (path: string) => {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) errors.add('missing source: ' + path)
    return unit
  }
  for (const path of [ENTRY, HANDLER]) {
    const unit = find(path)
    if (unit === undefined) continue
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
      }
    }
    for (const entry of mutableSingletons([unit]))
      errors.add(`mutable singleton:${file}:${entry.symbol}`)
  }
  const entry = find(ENTRY)
  if (entry !== undefined) {
    let built = 0
    let delegates = false
    walk(entry.source, (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(entry.source) === FACTORY) built += 1
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText(entry.source) === 'self.onmessage' &&
        node.right.getText(entry.source).includes('handler.handle(event.data)')
      )
        delegates = true
    })
    if (built !== 1) errors.add(`entry:handlers built ${String(built)}`)
    if (!delegates) errors.add('entry:onmessage does not delegate to the handler')
  }
  return [...errors].sort()
}

describe('RFC-540 ① Worker 的状态不在模块级；入口只建一个处理器', () => {
  test(
    '真实语料：入口与处理器文件没有模块级状态，入口只建一个处理器并把消息交给它',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(workerStateViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixturePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc540-source-'))
  roots.push(root)
  const path = join(root, 'db.sqlite')
  const sqlite = (createFrozenEpoch1Db() as unknown as { $client: Database }).$client
  writeFileSync(path, sqlite.serialize())
  sqlite.close()
  return path
}
function recordingHandler() {
  const events: SqliteLogicalSourceWorkerEvent[] = []
  let closed = 0
  const handler = createSqliteLogicalSourceWorkerHandler({
    emit: (event) => events.push(event),
    close: () => {
      closed += 1
    },
  })
  return { handler, events, closed: () => closed }
}
const base = (requestId: string) => ({ version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION, requestId })
const kinds = (events: readonly SqliteLogicalSourceWorkerEvent[]) =>
  events.map((event) =>
    event.type === 'failure' ? `failure:${(event as { message: string }).message}` : event.type,
  )

describe('RFC-540 ② 处理器各管各的状态', () => {
  test('两个处理器互不相通；重复初始化与未知表回 failure；关闭后再读被拒', async () => {
    const contract = buildFrozenEpoch1LogicalSchemaContract()
    const path = fixturePath()
    const first = recordingHandler()
    const second = recordingHandler()
    await first.handler.handle({
      ...base('sls_1'),
      type: 'init',
      path,
      contract,
      expectedSchemaDigest: contract.digest,
      // RFC-549: the epoch-1 fixture has no meta tables; the init message must say so.
      metaTables: [],
    })
    await second.handler.handle({ ...base('sls_2'), type: 'preflight' })
    await first.handler.handle({ ...base('sls_3'), type: 'preflight' })
    await first.handler.handle({
      ...base('sls_4'),
      type: 'init',
      path,
      contract,
      expectedSchemaDigest: contract.digest,
      metaTables: [],
    })
    await first.handler.handle({
      ...base('sls_5'),
      type: 'read-chunk',
      tableId: 'no_such_table',
      afterKey: null,
      limit: 1,
    })
    await first.handler.handle({ ...base('sls_6'), type: 'close' })
    await first.handler.handle({ ...base('sls_7'), type: 'preflight' })
    expect(kinds(second.events)).toEqual([
      'failure:SQLite logical-source Worker is not initialized',
    ])
    expect(kinds(first.events)).toEqual([
      'ready',
      'snapshot',
      'failure:SQLite logical-source Worker was initialized twice',
      'failure:unknown logical table no_such_table',
      'closed',
      'failure:SQLite logical-source Worker is not initialized',
    ])
    expect(first.events.map((event) => event.requestId)).toEqual([
      'sls_1',
      'sls_3',
      'sls_4',
      'sls_5',
      'sls_6',
      'sls_7',
    ])
    expect([first.closed(), second.closed()]).toEqual([1, 0])
  })
})

describe('RFC-540 负对照', () => {
  const clean = [
    sourceUnit(
      ENTRY,
      `const handler = ${FACTORY}({ emit, close })\nself.onmessage = async (event) => { await handler.handle(event.data) }`,
    ),
    sourceUnit(
      HANDLER,
      `export function ${FACTORY}(io) { let source = null; return { handle: async (data) => io.emit(data) } }`,
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(workerStateViolations(clean)).toEqual([])
  })

  test('模块级的状态、两个处理器与不经处理器的 onmessage 都会被认出', () => {
    expect(
      workerStateViolations(
        replace(
          ENTRY,
          `let source = null\nconst handler = ${FACTORY}({ emit, close })\nself.onmessage = async (event) => { await handler.handle(event.data) }`,
        ),
      ),
    ).toEqual([
      'module-level let:sqliteLogicalSourceWorker.ts:source',
      'mutable singleton:sqliteLogicalSourceWorker.ts:source',
    ])
    expect(
      workerStateViolations(
        replace(
          HANDLER,
          `let contract = null\nexport function ${FACTORY}(io) { return { handle: async () => {} } }`,
        ),
      ),
    ).toEqual([
      'module-level let:sqliteLogicalSourceWorkerHandler.ts:contract',
      'mutable singleton:sqliteLogicalSourceWorkerHandler.ts:contract',
    ])
    expect(
      workerStateViolations(
        replace(
          ENTRY,
          `const a = ${FACTORY}({ emit, close })\nconst handler = ${FACTORY}({ emit, close })\nself.onmessage = async (event) => { await handler.handle(event.data) }`,
        ),
      ),
    ).toEqual(['entry:handlers built 2'])
    expect(
      workerStateViolations(
        replace(
          ENTRY,
          `const handler = ${FACTORY}({ emit, close })\nself.onmessage = async (event) => {}`,
        ),
      ),
    ).toEqual(['entry:onmessage does not delegate to the handler'])
  })
})
