// RFC-536 — 配置生效监听、执行可用性与事务观察不再挂进程级登记（RFC-294 S12 第十七步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① 配置生效监听与执行可用性两个文件顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，三个文件（另加事务观察）在架构报告的模块级可变
//    单例判据里为空；生产代码不再引用删去的名字；应用配置绑定只建一组监听、保存只通知这一组；daemon 会话在这一组上登记镜像刷新、把同一组交给
//    维护服务（语料下限 3,000）。
// ② 行为：两组监听互不通知、注销后不再通知、异步监听被等完、抛错的监听不挡后面的；两份应用配置绑定即使键相同也各通知各的；两个 app 各读
//    各的读取器、重复绑定被拒、未绑定的两种结局；两个对象各报各的事务耗时。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { createConfigAppliedListeners } from '@/platform/configuration/configAppliedListeners'
import {
  assertExecutionAvailable,
  attachExecutionAvailability,
  readExecutionStatus,
} from '@/platform/http/executionAvailability'
import { attachTransactionObserver, observeDbTransaction } from '@/db/transactionScope'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import type { ApplicationConfigurationDependencies } from '@/modules/system-operations/application/ports/applicationConfiguration'
import {
  mergeValidatedConfigurationPatch,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const LISTENERS = SRC + 'platform/configuration/configAppliedListeners.ts'
const AVAILABILITY = SRC + 'platform/http/executionAvailability.ts'
const TRANSACTIONS = SRC + 'db/transactionScope.ts'
const BINDING = SRC + 'modules/system-operations/composition/applicationConfiguration.ts'
const SESSION = SRC + 'bootstrap/daemonSession.ts'
/** Files that must hold no module-level collection at all (the transaction scope keeps its unrelated frames). */
const COLLECTION_FREE = [LISTENERS, AVAILABILITY]
const SINGLETON_FREE = [LISTENERS, AVAILABILITY, TRANSACTIONS]
const CORPUS_TIMEOUT = 30_000
/** The process-level registries RFC-536 removed; production must not name them again. */
const REMOVED = [
  'registerConfigAppliedListener',
  'notifyConfigApplied',
  'listenersByPath',
  'bindExecutionAvailability',
  'bindTransactionObserver',
  'transactionObservers',
]
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
const SESSION_LISTENERS = 'input.applicationConfiguration.listeners'

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
const short = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function calls(unit: SourceUnit, callee: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(unit.source) === callee)
      found.push(node)
  })
  return found
}
/** The initializer text of `prop` in the first object-literal argument of the call. */
function propertyOf(call: ts.CallExpression, prop: string, unit: SourceUnit): string | undefined {
  const arg = call.arguments.find(ts.isObjectLiteralExpression)
  for (const property of arg?.properties ?? []) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === prop)
      return property.name.text
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === prop
    )
      return property.initializer.getText(unit.source)
  }
  return undefined
}

export function platformRegistrationViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const unitOf = (path: string) => {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) errors.add('missing source: ' + path)
    return unit
  }
  for (const path of COLLECTION_FREE) {
    const unit = unitOf(path)
    if (unit === undefined) continue
    for (const statement of unit.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(unit.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:${short(path)}:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(unit.source))
        )
          errors.add(`module-level collection:${short(path)}:${name}`)
      }
    }
  }
  for (const path of SINGLETON_FREE) unitOf(path)
  for (const entry of mutableSingletons(units.filter((unit) => SINGLETON_FREE.includes(unit.path))))
    errors.add(`mutable singleton:${short(entry.file)}:${entry.symbol}`)
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
  }
  const binding = unitOf(BINDING)
  if (binding !== undefined) {
    if (calls(binding, 'createConfigAppliedListeners').length !== 1)
      errors.add('binding:listener sets')
    if (calls(binding, 'listeners.notify').length !== 1) errors.add('binding:notify')
  }
  const session = unitOf(SESSION)
  if (session !== undefined) {
    const maintenance = calls(session, 'createMaintenanceService')
    if (
      maintenance.length !== 1 ||
      propertyOf(maintenance[0]!, 'configApplied', session) !== SESSION_LISTENERS
    )
      errors.add('session:maintenance listeners')
    if (calls(session, `${SESSION_LISTENERS}.register`).length !== 1)
      errors.add('session:refresh listener')
  }
  return [...errors].sort()
}

describe('RFC-536 ① 三处登记没有进程级状态；应用配置的那一组监听交给全部登记方', () => {
  test(
    '真实语料：没有模块级集合与登记函数，删去的名字不在，保存只通知绑定自己的那一组，daemon 会话与维护服务登记在那一组上',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(platformRegistrationViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

function commandEffects() {
  return {
    runtimeRegistry: {
      async validateDefaultChange() {},
      async invalidateInheritedRuntimeProbeReceipts() {
        return 0
      },
    },
    async withRuntimeProbeConfigFence<T>(operation: () => Promise<T>): Promise<T> {
      return await operation()
    },
    runtimeTests: {
      async reconcileDurableIntents() {},
    },
    concurrencyHotApply: {
      apply() {},
    },
  } satisfies Omit<ApplicationConfigurationDependencies, 'persistence' | 'applied'>
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('RFC-536 ② 随实例与对象走的行为', () => {
  test('两组配置生效监听互不通知；注销后不再通知；异步监听被等完；抛错的监听不挡后面的', async () => {
    const own = createConfigAppliedListeners('rfc536-own')
    const other = createConfigAppliedListeners('rfc536-own')
    const seen: string[] = []
    const held = barrier()
    const offOther = other.register(() => {
      seen.push('other')
    })
    const offThrow = own.register(() => {
      throw new Error('rfc536 listener failure')
    })
    const offAsync = own.register(async () => {
      await held.promise
      seen.push('async')
    })
    const offSync = own.register(() => {
      seen.push('sync')
    })
    const pending = own.notify(DEFAULT_CONFIG)
    expect(pending).toBeInstanceOf(Promise)
    expect(seen).toEqual(['sync'])
    held.resolve()
    await pending
    expect(seen).toEqual(['sync', 'async'])
    for (const off of [offThrow, offAsync, offSync, offOther]) off()
    expect(own.notify(DEFAULT_CONFIG)).toBeUndefined()
    expect(other.notify(DEFAULT_CONFIG)).toBeUndefined()
    expect(seen).toEqual(['sync', 'async'])
  })

  test('两份应用配置绑定即使键相同，保存也只通知各自的那一组', async () => {
    let current: Config = structuredClone(DEFAULT_CONFIG)
    const persistence = {
      load: () => structuredClone(current),
      previewPatch: (patch: unknown) =>
        mergeValidatedConfigurationPatch(current, validateConfigurationPatch(patch)),
      applyPatch(patch: unknown) {
        current = mergeValidatedConfigurationPatch(current, validateConfigurationPatch(patch))
        return structuredClone(current)
      },
    }
    const bind = () =>
      composeApplicationConfigurationBinding({
        kind: 'selected',
        notificationKey: 'rfc536-shared-key',
        persistence,
      })
    const first = bind()
    const second = bind()
    const notified: string[] = []
    const offFirst = first.listeners.register(() => {
      notified.push('first')
    })
    const offSecond = second.listeners.register(() => {
      notified.push('second')
    })
    try {
      await first.composeCommands(commandEffects()).update({ maxConcurrentNodes: 5 })
      expect(notified).toEqual(['first'])
      await second.composeCommands(commandEffects()).update({ maxConcurrentNodes: 6 })
      expect(notified).toEqual(['first', 'second'])
    } finally {
      offFirst()
      offSecond()
    }
  })

  test('执行状态读取器记在 app 上：两个 app 各读各的，重复绑定被拒，未绑定时状态查询报错而门控放行', () => {
    const standby = { mode: 'standby', state: 'standby' } as never
    const active = { mode: 'active', state: 'active' } as never
    const a = {}
    const b = {}
    attachExecutionAvailability(a, () => standby)
    attachExecutionAvailability(b, () => active)
    expect(readExecutionStatus(a)).toBe(standby)
    expect(readExecutionStatus(b)).toBe(active)
    expect(Object.keys(a)).toEqual([])
    expect(() => attachExecutionAvailability(a, () => active)).toThrow(
      'execution-availability-already-bound',
    )
    const unbound = {}
    expect(() => readExecutionStatus(unbound)).toThrow('execution-availability-unbound')
    expect(() => assertExecutionAvailable(unbound, 'task')).not.toThrow()
    expect(() => assertExecutionAvailable(Object.create(a) as object, 'task')).not.toThrow()
  })

  test('事务观察者记在客户端上：两个客户端各报各的，没挂观察者的客户端什么都不做', () => {
    const first: number[] = []
    const second: number[] = []
    const a = {}
    const b = {}
    attachTransactionObserver(a, (ms) => first.push(ms))
    attachTransactionObserver(b, (ms) => second.push(ms))
    observeDbTransaction(a, 12)
    observeDbTransaction(b, 34)
    observeDbTransaction({}, 56)
    expect(first).toEqual([12])
    expect(second).toEqual([34])
    expect(Object.keys(a)).toEqual([])
  })
})

describe('RFC-536 负对照', () => {
  const clean = [
    sourceUnit(
      LISTENERS,
      'export function createConfigAppliedListeners(key) { const listeners = new Set() }',
    ),
    sourceUnit(AVAILABILITY, "const EXECUTION_STATUS_READER = Symbol('execution-status-reader')"),
    sourceUnit(
      TRANSACTIONS,
      'const openDepth = new WeakMap()\nexport function holdsExplicitTransaction() {}',
    ),
    sourceUnit(
      BINDING,
      [
        'const listeners = createConfigAppliedListeners(notificationKey)',
        'const applied = { notify: (config) => listeners.notify(config) }',
      ].join('\n'),
    ),
    sourceUnit(
      SESSION,
      [
        'createMaintenanceService({ appHome, configApplied: input.applicationConfiguration.listeners })',
        'const off = input.applicationConfiguration.listeners.register(() => ticker.reconfigure())',
      ].join('\n'),
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(platformRegistrationViolations(clean)).toEqual([])
  })

  test('模块级表、写模块状态的登记函数与删去的名字都会被认出', () => {
    expect(
      platformRegistrationViolations(
        replace(
          LISTENERS,
          'const listenersByPath = new Map()\nexport function registerConfigAppliedListener(p, l) { listenersByPath.set(p, l) }',
        ),
      ),
    ).toEqual([
      'module-level collection:configAppliedListeners.ts:listenersByPath',
      'mutable singleton:configAppliedListeners.ts:registerConfigAppliedListener',
      `removed name:${LISTENERS}:listenersByPath`,
      `removed name:${LISTENERS}:registerConfigAppliedListener`,
    ])
    expect(
      platformRegistrationViolations(
        replace(
          AVAILABILITY,
          'const readers = new WeakMap()\nexport function bindExecutionAvailability(app, read) { readers.set(app, read) }',
        ),
      ),
    ).toEqual([
      'module-level collection:executionAvailability.ts:readers',
      'mutable singleton:executionAvailability.ts:bindExecutionAvailability',
      `removed name:${AVAILABILITY}:bindExecutionAvailability`,
    ])
    expect(
      platformRegistrationViolations(
        replace(
          TRANSACTIONS,
          'const transactionObservers = new WeakMap()\nexport function bindTransactionObserver(c, o) { transactionObservers.set(c, o) }',
        ),
      ),
    ).toEqual([
      'mutable singleton:transactionScope.ts:bindTransactionObserver',
      `removed name:${TRANSACTIONS}:bindTransactionObserver`,
      `removed name:${TRANSACTIONS}:transactionObservers`,
    ])
  })

  test('绑定多建一组、通知走了别处，会话不把那一组交给维护服务或不在上面登记，都会被认出', () => {
    expect(
      platformRegistrationViolations(
        replace(
          BINDING,
          [
            'const listeners = createConfigAppliedListeners(notificationKey)',
            'const spare = createConfigAppliedListeners(notificationKey)',
            'const applied = { notify: (config) => spare.notify(config) }',
          ].join('\n'),
        ),
      ),
    ).toEqual(['binding:listener sets', 'binding:notify'])
    expect(
      platformRegistrationViolations(
        replace(
          SESSION,
          [
            'createMaintenanceService({ appHome, configApplied: createConfigAppliedListeners(key) })',
            'const off = createConfigAppliedListeners(key).register(() => ticker.reconfigure())',
          ].join('\n'),
        ),
      ),
    ).toEqual(['session:maintenance listeners', 'session:refresh listener'])
  })
})
