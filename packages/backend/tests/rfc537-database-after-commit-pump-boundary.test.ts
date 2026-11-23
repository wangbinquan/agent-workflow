// RFC-537 — 已提交事件的即时投递泵随数据库句柄走（RFC-294 S12 第十八步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① `platform/events/committed/runtime.ts` 顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，在架构报告的模块级可变单例判据里为空；生产
//    代码不再引用删去的名字；每处 `publishCommittedEventsAfterCommit` 调用都带句柄与事件两个实参；daemon 会话把泵挂在它自己的库 `db` 上，且只在
//    `after-commit-event-pump` 句柄里挂（语料下限 3,000）。
// ② 行为：两个库各投各的；派生句柄（事务等）取到客户端挂的泵；空批次返回是否挂着泵、没挂泵返回 false、泵抛错只记告警；摘除只摘自己挂的；
//    没有句柄上下文的对象不能挂泵、投递得 false。
// ③ 两个引擎上的真库：两个独立的库各投各的，真事务句柄与客户端共用同一格。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  attachAfterCommitEventPump,
  publishCommittedEventsAfterCommit,
} from '@/platform/events/committed/runtime'
import type { AfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import { bindDatabaseHandle, inheritDatabaseHandle } from '@/platform/persistence/sessionTables'
import { persistenceSchemaBinding } from '@/bootstrap/persistenceSchema'
import { createSqliteCapabilities } from '@/platform/persistence/capabilities'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const RUNTIME = SRC + 'platform/events/committed/runtime.ts'
const SESSION = SRC + 'bootstrap/daemonSession.ts'
const CORPUS_TIMEOUT = 30_000
/** The process-level pump RFC-537 removed; production must not name it again. */
const REMOVED = ['registerAfterCommitEventPump', 'releaseAfterCommitEventPump', 'activePump']
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
const PUBLISH = 'publishCommittedEventsAfterCommit'
const ATTACH = 'attachAfterCommitEventPump'

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function calls(unit: SourceUnit, callee: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(unit.source) === callee)
      found.push(node)
  })
  return found
}
/** The nearest enclosing object-literal property `id: '<value>'` above the node, if any. */
function enclosingHandleId(node: ts.Node): string | undefined {
  for (let cursor = node.parent; cursor !== undefined; cursor = cursor.parent) {
    if (!ts.isObjectLiteralExpression(cursor)) continue
    for (const property of cursor.properties)
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'id' &&
        ts.isStringLiteral(property.initializer)
      )
        return property.initializer.text
  }
  return undefined
}

export function afterCommitPumpViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const runtime = units.find((unit) => unit.path === RUNTIME)
  if (runtime === undefined) errors.add('missing source: ' + RUNTIME)
  else {
    for (const statement of runtime.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(runtime.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:runtime.ts:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(runtime.source))
        )
          errors.add(`module-level collection:runtime.ts:${name}`)
      }
    }
    for (const entry of mutableSingletons([runtime]))
      errors.add(`mutable singleton:runtime.ts:${entry.symbol}`)
  }
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
    for (const call of calls(unit, PUBLISH))
      if (call.arguments.length !== 2)
        errors.add(`publish without its database:${unit.path}:${call.getText(unit.source)}`)
  }
  const session = units.find((unit) => unit.path === SESSION)
  if (session === undefined) errors.add('missing source: ' + SESSION)
  else {
    const attached = calls(session, ATTACH)
    if (
      attached.length !== 1 ||
      attached[0]!.arguments[0]?.getText(session.source) !== 'db' ||
      enclosingHandleId(attached[0]!) !== 'after-commit-event-pump'
    )
      errors.add('session:pump attach')
  }
  return [...errors].sort()
}

describe('RFC-537 ① 即时投递泵没有进程级状态；写方按提交所在的库投递；daemon 会话挂在自己的库上', () => {
  test(
    '真实语料：运行时没有模块级状态与登记函数，每处投递带句柄，daemon 会话只在泵句柄里把泵挂在 db 上',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(afterCommitPumpViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

/** A provider-bound handle without a real connection: the context is what the pump rides on. */
function boundHandle(): object {
  return bindDatabaseHandle(
    {},
    persistenceSchemaBinding.nativeTables.sqlite as never,
    createSqliteCapabilities(),
  )
}
function recordingPump(name: string, published: string[], fail = false): AfterCommitEventPump {
  return {
    async publishNow(eventRefs) {
      published.push(`${name}:${eventRefs.map((ref) => ref.eventId).join(',')}`)
      if (fail) throw new Error('rfc537 projection failure')
    },
    nudge() {},
  }
}
const ref = (eventId: string) => ({ eventId }) as unknown as CommittedEventRef

describe('RFC-537 ② 随句柄走的行为', () => {
  test('两个库各投各的；派生句柄取到客户端挂的泵；没挂泵的库得 false', async () => {
    const published: string[] = []
    const first = boundHandle()
    const second = boundHandle()
    const release = attachAfterCommitEventPump(first, recordingPump('first', published))
    try {
      expect(await publishCommittedEventsAfterCommit(first, [ref('e1')])).toBe(true)
      expect(await publishCommittedEventsAfterCommit(second, [ref('e2')])).toBe(false)
      const derived = inheritDatabaseHandle({}, first)
      expect(await publishCommittedEventsAfterCommit(derived, [ref('e3')])).toBe(true)
      expect(published).toEqual(['first:e1', 'first:e3'])
    } finally {
      release()
    }
    expect(await publishCommittedEventsAfterCommit(first, [ref('e4')])).toBe(false)
  })

  test('空批次报是否挂着泵；泵抛错只记告警；摘除只摘自己挂的', async () => {
    const published: string[] = []
    const handle = boundHandle()
    expect(await publishCommittedEventsAfterCommit(handle, [])).toBe(false)
    const releaseFailing = attachAfterCommitEventPump(handle, recordingPump('a', published, true))
    expect(await publishCommittedEventsAfterCommit(handle, [])).toBe(true)
    expect(await publishCommittedEventsAfterCommit(handle, [ref('e1')])).toBe(true)
    const releaseNext = attachAfterCommitEventPump(handle, recordingPump('b', published))
    releaseFailing()
    expect(await publishCommittedEventsAfterCommit(handle, [ref('e2')])).toBe(true)
    releaseNext()
    expect(await publishCommittedEventsAfterCommit(handle, [ref('e3')])).toBe(false)
    expect(published).toEqual(['a:e1', 'b:e2'])
  })

  test('没有句柄上下文的对象不能挂泵，投递得 false', async () => {
    expect(() => attachAfterCommitEventPump({}, recordingPump('x', []))).toThrow(
      'after-commit-event-pump-handle-unbound',
    )
    expect(await publishCommittedEventsAfterCommit({}, [ref('e1')])).toBe(false)
  })
})

describeEachProvider(
  'RFC-537 ③ 两个引擎上的真库',
  (harness) => {
    test('两个独立的库各投各的；真事务句柄与客户端共用同一格', async () => {
      const published: string[] = []
      const first = harness.db
      const second = harness.database(1).db
      const release = attachAfterCommitEventPump(first, recordingPump('first', published))
      try {
        await databaseSessionFor(first).transaction(async (tx) => {
          expect(await publishCommittedEventsAfterCommit(tx, [ref('in-transaction')])).toBe(true)
        })
        expect(await publishCommittedEventsAfterCommit(first, [ref('e1')])).toBe(true)
        expect(await publishCommittedEventsAfterCommit(second, [ref('e2')])).toBe(false)
        await databaseSessionFor(second).transaction(async (tx) => {
          expect(await publishCommittedEventsAfterCommit(tx, [ref('e3')])).toBe(false)
        })
        expect(published).toEqual(['first:in-transaction', 'first:e1'])
      } finally {
        release()
      }
      expect(await publishCommittedEventsAfterCommit(first, [ref('e4')])).toBe(false)
    })
  },
  { databaseCount: 2 },
)

describe('RFC-537 负对照', () => {
  const clean = [
    sourceUnit(
      RUNTIME,
      [
        `export function ${ATTACH}(handle, pump) { const slot = slotOf(handle); slot.pump = pump }`,
        `export async function ${PUBLISH}(handle, refs) { return slotOf(handle)?.pump !== undefined }`,
      ].join('\n'),
    ),
    sourceUnit(
      SESSION,
      `const factory = { id: 'after-commit-event-pump', start() { const detachPump = ${ATTACH}(db, committedEventPump) } }`,
    ),
    sourceUnit(
      SRC + 'modules/task-execution/infrastructure/writer.ts',
      `await ${PUBLISH}(db, refs)`,
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(afterCommitPumpViolations(clean)).toEqual([])
  })

  test('模块级的泵与登记函数、删去的名字、不带句柄的投递都会被认出', () => {
    expect(
      afterCommitPumpViolations(
        replace(
          RUNTIME,
          'let activePump = null\nexport function registerAfterCommitEventPump(pump) { activePump = pump }',
        ),
      ),
    ).toEqual([
      'module-level let:runtime.ts:activePump',
      'mutable singleton:runtime.ts:activePump',
      'mutable singleton:runtime.ts:registerAfterCommitEventPump',
      `removed name:${RUNTIME}:activePump`,
      `removed name:${RUNTIME}:registerAfterCommitEventPump`,
    ])
    expect(
      afterCommitPumpViolations(
        replace(SRC + 'modules/task-execution/infrastructure/writer.ts', `await ${PUBLISH}(refs)`),
      ),
    ).toEqual([
      `publish without its database:${SRC}modules/task-execution/infrastructure/writer.ts:${PUBLISH}(refs)`,
    ])
  })

  test('daemon 会话挂在别的句柄上、挂在泵句柄之外、挂了两次，都会被认出', () => {
    for (const text of [
      `const factory = { id: 'after-commit-event-pump', start() { ${ATTACH}(input.db, committedEventPump) } }`,
      `${ATTACH}(db, committedEventPump)\nconst factory = { id: 'after-commit-event-pump', start() {} }`,
      `const factory = { id: 'after-commit-event-pump', start() { ${ATTACH}(db, a); ${ATTACH}(db, b) } }`,
    ])
      expect(afterCommitPumpViolations(replace(SESSION, text))).toEqual(['session:pump attach'])
  })
})
