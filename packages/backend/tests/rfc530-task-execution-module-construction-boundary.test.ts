// RFC-530 — 任务执行模块不在 import 期构造（RFC-294 S12 第十一步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① 生产代码里没有模块级的 `new TaskExecutionModule(` / `new ProviderTaskExecutionModule(`（只在函数体里构造），删去与移走的名字不再作为标识符
//    出现（语料下限 3,000）。
// ② SQLite 的执行绑定按交入的代次构造执行模块，每次一份，认领走这一份。
// ③ 负对照（只喂伪造的源码，不碰真实语料）。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { composeProcessTaskExecutionBinding } from '@/modules/task-execution/composition/taskExecutionBinding'

const REPO = resolve(import.meta.dir, '../../..')
const CORPUS_TIMEOUT = 30_000
const MODULE_CLASSES = new Set(['TaskExecutionModule', 'ProviderTaskExecutionModule'])
/** The import-time instance and the test-only entry points that read it (now in tests/helpers). */
const REMOVED = new Set([
  'taskExecutionModule',
  'createTaskExecutionTestModule',
  'composeTaskCancellation',
  'activeTaskDriverController',
  'isTaskDriverActive',
  'awaitTaskDriverReleasedSettled',
  'awaitTaskDriverIdle',
  'createDatabaseTaskDriverLifecyclePort',
])

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function insideFunction(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current)) return true
    // Class fields and constructors are built per instance, not at import time.
    if (
      ts.isPropertyDeclaration(current) &&
      !ts.getModifiers(current)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
    )
      return true
  }
  return false
}

export function moduleConstructionViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  for (const unit of units) {
    walk(unit.source, (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        MODULE_CLASSES.has(node.expression.text) &&
        !insideFunction(node)
      )
        errors.add(`import-time construction:${unit.path}`)
      if (ts.isIdentifier(node) && REMOVED.has(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
  }
  return [...errors].sort()
}

const UNITS = backendUnits(REPO)

describe('RFC-530 ① 不在 import 期构造执行模块', () => {
  test(
    '生产代码里执行模块只在函数体里构造；删去与移走的名字不在生产代码里',
    () => {
      expect(UNITS.length).toBeGreaterThanOrEqual(3000)
      expect(moduleConstructionViolations(UNITS)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-530 ② SQLite 的执行绑定在绑定时构造', () => {
  test('按交入的代次构造，每次一份；认领走这一份', async () => {
    const db = {} as never
    const first = composeProcessTaskExecutionBinding({ db, daemonGeneration: 'rfc530-generation' })
    const second = composeProcessTaskExecutionBinding({ db, daemonGeneration: 'rfc530-generation' })
    expect(first.module).not.toBe(second.module)
    expect(first.module.runtimeRegistry).not.toBe(second.module.runtimeRegistry)
    expect(first.module.daemonGeneration).toBe('rfc530-generation')
    expect(first.legacyConnection).toBe(db)
    const calls: unknown[] = []
    ;(first.module as unknown as { claim: (input: unknown) => Promise<unknown> }).claim = async (
      input,
    ) => {
      calls.push(input)
      return 'claimed'
    }
    expect(await first.claim('intent-1')).toBe('claimed' as never)
    expect(calls).toEqual([{ db, intentId: 'intent-1' }])
  })

  // Regression for the singleton's latent defect: session close disposes (one-way seals) the execution module, and the
  // SQLite binding used to hand every session the process-level instance — so after a provider switch closed a SQLite
  // session, a SQLite session opened later in the same process got the sealed module and every claim was refused.
  test('关停一个会话只封存它自己的模块；之后的绑定拿到未封存的闸门', async () => {
    const db = {} as never
    const closed = composeProcessTaskExecutionBinding({ db, daemonGeneration: 'rfc530-generation' })
    await closed.module.dispose('rfc530-provider-switch')
    expect(closed.module.claimGate.isSealed).toBe(true)
    const next = composeProcessTaskExecutionBinding({ db, daemonGeneration: 'rfc530-generation' })
    expect(next.module.claimGate.isSealed).toBe(false)
    expect(next.module.claimGate.isPaused).toBe(false)
  })
})

describe('RFC-530 ③ 负对照', () => {
  test('模块级的构造与删去的名字会被认出；函数体与实例字段里的构造不算', () => {
    const unit = (text: string) => sourceUnit('packages/backend/src/modules/x/composition.ts', text)
    expect(
      moduleConstructionViolations([
        unit('export const m = new TaskExecutionModule(DAEMON_GENERATION)'),
      ]),
    ).toEqual(['import-time construction:packages/backend/src/modules/x/composition.ts'])
    expect(
      moduleConstructionViolations([
        unit('const p = new ProviderTaskExecutionModule(g, persistence)'),
      ]),
    ).toEqual(['import-time construction:packages/backend/src/modules/x/composition.ts'])
    expect(
      moduleConstructionViolations([
        unit('export function make(g: string) { return new TaskExecutionModule(g) }'),
        unit('class Holder { readonly module = new TaskExecutionModule("g") }'),
      ]),
    ).toEqual([])
    expect(
      moduleConstructionViolations([unit('taskExecutionModule.runtimeRegistry.hasTask(id)')]),
    ).toEqual(['removed name:packages/backend/src/modules/x/composition.ts:taskExecutionModule'])
  })
})
