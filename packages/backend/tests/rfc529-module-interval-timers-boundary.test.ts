// RFC-529 — 业务模块的周期定时器改走平台定时原语（RFC-294 S12 第十步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① 生产代码里直接调全局 `setInterval` / `clearInterval`（标识符或 `globalThis.` 取的）的文件与清单逐条相等：平台定时原语与
//    `platform/background` 的 4 个既有文件（语料下限 3,000）；每处 `startInterval` 的 owner 是字符串字面量；业务模块不声明
//    `ReturnType<typeof setInterval>`。
// ② 原语的行为：就是 `setInterval(tick, everyMs)`，`stop` 调一次 `clearInterval` 且幂等，`unref` 转给句柄，owner 原样交出。
// ③ 负对照。
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { startInterval } from '@/platform/background/intervalTimer'

const REPO = resolve(import.meta.dir, '../../..')
const PREFIX = 'packages/backend/src/'
const CORPUS_TIMEOUT = 30_000
/** The files that may call the global interval timers directly. */
const DIRECT_TIMER_FILES = [
  'platform/background/intervalTimer.ts',
  'platform/background/maintenanceService.ts',
  'platform/background/maintenanceTicker.ts',
  'platform/background/maintenanceWorkerRuntime.ts',
  'platform/background/providerBackupScheduler.ts',
].map((path) => PREFIX + path)
const GLOBAL_TIMERS = new Set(['setInterval', 'clearInterval'])

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function isGlobalTimerCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return GLOBAL_TIMERS.has(callee.text)
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'globalThis' &&
    GLOBAL_TIMERS.has(callee.name.text)
  )
}

export function intervalTimerViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  for (const unit of units) {
    const allowed = DIRECT_TIMER_FILES.includes(unit.path)
    const inModule = unit.path.startsWith(PREFIX + 'modules/')
    walk(unit.source, (node) => {
      if (isGlobalTimerCall(node) && !allowed) errors.add(`direct timer:${unit.path}`)
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'startInterval'
      ) {
        const input = node.arguments[0]
        const owner =
          input !== undefined && ts.isObjectLiteralExpression(input)
            ? input.properties.find(
                (property): property is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(property) &&
                  property.name.getText(unit.source) === 'owner',
              )
            : undefined
        if (owner === undefined || !ts.isStringLiteral(owner.initializer))
          errors.add(`owner not literal:${unit.path}`)
      }
      if (
        inModule &&
        ts.isTypeQueryNode(node) &&
        ts.isIdentifier(node.exprName) &&
        GLOBAL_TIMERS.has(node.exprName.text)
      )
        errors.add(`timer handle type:${unit.path}`)
    })
  }
  for (const path of DIRECT_TIMER_FILES)
    if (!units.some((unit) => unit.path === path)) errors.add(`missing listed file:${path}`)
  return [...errors].sort()
}

const UNITS = backendUnits(REPO)

describe('RFC-529 ① 直接全局定时器只在平台定时原语', () => {
  test(
    '生产代码里直接调全局 setInterval / clearInterval 的只剩清单里的文件；owner 是字面量；业务模块不声明定时器句柄类型',
    () => {
      expect(UNITS.length).toBeGreaterThanOrEqual(3000)
      expect(intervalTimerViolations(UNITS)).toEqual([])
      const direct = UNITS.filter((unit) => {
        let found = false
        walk(unit.source, (node) => {
          if (isGlobalTimerCall(node)) found = true
        })
        return found
      }).map((unit) => unit.path)
      expect(direct.sort()).toEqual([...DIRECT_TIMER_FILES].sort())
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-529 ② 平台定时原语', () => {
  const restore: Array<() => void> = []
  afterEach(() => {
    while (restore.length > 0) restore.pop()!()
  })

  test('就是 setInterval(tick, everyMs)；stop 只清一次；unref 转给句柄；owner 原样交出', () => {
    let unrefs = 0
    const handle = { unref: () => (unrefs += 1) }
    const set = spyOn(globalThis, 'setInterval').mockImplementation(
      (() => handle) as unknown as typeof setInterval,
    )
    const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    restore.push(
      () => set.mockRestore(),
      () => clear.mockRestore(),
    )
    const tick = () => undefined
    const timer = startInterval({ owner: 'test.owner', everyMs: 250, tick })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]).toEqual([tick, 250] as never)
    expect(timer.owner).toBe('test.owner')
    timer.unref()
    expect(unrefs).toBe(1)
    timer.stop()
    timer.stop()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear.mock.calls[0]).toEqual([handle] as never)
    // After stop the handle is released: unref does nothing.
    timer.unref()
    expect(unrefs).toBe(1)
  })
})

describe('RFC-529 ③ 负对照', () => {
  test('业务模块里直接调全局定时器、经 globalThis 取、owner 不是字面量、声明定时器句柄类型、清单里的文件缺失都会被认出；端口方法名不算', () => {
    // Empty stand-ins for the listed platform files keep every fixture off the real corpus.
    const placeholders = DIRECT_TIMER_FILES.map((path) => sourceUnit(path, ''))
    const only = (path: string, text: string) =>
      intervalTimerViolations([sourceUnit(PREFIX + path, text), ...placeholders])
    expect(only('modules/x/infrastructure/a.ts', 'setInterval(() => {}, 5)')).toEqual([
      `direct timer:${PREFIX}modules/x/infrastructure/a.ts`,
    ])
    expect(only('modules/x/infrastructure/b.ts', 'globalThis.clearInterval(h)')).toEqual([
      `direct timer:${PREFIX}modules/x/infrastructure/b.ts`,
    ])
    expect(
      only('modules/x/infrastructure/c.ts', 'startInterval({ owner: name, everyMs: 1, tick })'),
    ).toEqual([`owner not literal:${PREFIX}modules/x/infrastructure/c.ts`])
    expect(
      only('modules/x/infrastructure/d.ts', 'let h: ReturnType<typeof setInterval> | null = null'),
    ).toEqual([`timer handle type:${PREFIX}modules/x/infrastructure/d.ts`])
    expect(
      only(
        'modules/x/infrastructure/e.ts',
        'const effects = { setInterval(callback, delay) { return startInterval({ owner: "x", everyMs: delay, tick: callback }) } }',
      ),
    ).toEqual([])
    expect(intervalTimerViolations(placeholders.slice(1))).toEqual([
      `missing listed file:${DIRECT_TIMER_FILES[0]}`,
    ])
  })
})
