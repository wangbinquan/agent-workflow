// RFC-541 — 维护 Worker 的效果模块由各自的 Worker 入口交给运行时（RFC-294 S12 第二十二步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① `platform/background/maintenanceWorkerEffects.ts` 顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，在架构报告的模块级可变单例判据里
//    为空；生产代码不再引用删去的名字；单机根与托管根各调一次 `runMaintenanceWorker(`，托管根不 import 单机根，它交给效果作用域的加载器把
//    `aw:crewstation-maintenance` 映射到 `import('./crewstationMaintenance')`（语料下限 3,000）。
// ② 行为：效果作用域用交进来的加载器加载描述符的模块；没给加载器时按模块名 import。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { openMaintenanceWorkerEffectsScope } from '@/platform/background/maintenanceWorkerEffects'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const EFFECTS = SRC + 'platform/background/maintenanceWorkerEffects.ts'
const ROOT = SRC + 'bootstrap/maintenanceWorker.ts'
const HOSTED = SRC + 'bootstrap/maintenanceWorkerEntry.ts'
const CORPUS_TIMEOUT = 30_000
/** The Worker-wide registry RFC-541 removed; production must not name it again. */
const REMOVED = [
  'effectModules',
  'registerMaintenanceWorkerEffectModule',
  'importMaintenanceWorkerEffectModule',
]
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
const HOSTED_NAME = 'aw:crewstation-maintenance'

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function callCount(unit: SourceUnit, callee: string): number {
  let count = 0
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(unit.source) === callee) count += 1
  })
  return count
}
/** Whether the unit's `importModule` loader maps the hosted symbolic name to the CrewStation effects module. */
function mapsHostedModule(unit: SourceUnit): boolean {
  let maps = false
  walk(unit.source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'importModule'
    ) {
      const text = node.initializer.getText(unit.source).replace(/\s+/g, ' ')
      if (
        text.includes(`specifier === '${HOSTED_NAME}' ? import('./crewstationMaintenance')`) &&
        text.includes(': import(specifier)')
      )
        maps = true
    }
  })
  return maps
}

export function effectModuleViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const find = (path: string) => {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) errors.add('missing source: ' + path)
    return unit
  }
  const effects = find(EFFECTS)
  if (effects !== undefined) {
    for (const statement of effects.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(effects.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:maintenanceWorkerEffects.ts:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(effects.source))
        )
          errors.add(`module-level collection:maintenanceWorkerEffects.ts:${name}`)
      }
    }
    for (const entry of mutableSingletons([effects]))
      errors.add(`mutable singleton:maintenanceWorkerEffects.ts:${entry.symbol}`)
  }
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
  }
  for (const path of [ROOT, HOSTED]) {
    const unit = find(path)
    if (unit !== undefined && callCount(unit, 'runMaintenanceWorker') !== 1)
      errors.add(`root:${path.slice(path.lastIndexOf('/') + 1)} runs the Worker runtime once`)
  }
  const hosted = find(HOSTED)
  if (hosted !== undefined) {
    for (const statement of hosted.source.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === './maintenanceWorker'
      )
        errors.add('hosted:imports the standalone root')
    if (!mapsHostedModule(hosted))
      errors.add('hosted:loader does not map the hosted effects module')
  }
  return [...errors].sort()
}

describe('RFC-541 ① 效果模块没有 Worker 级登记；两个根各把加载器交给运行时', () => {
  test(
    '真实语料：平台效果文件没有模块级状态，删去的名字不在，两个根各调一次运行时，托管根映射自己的效果模块',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(effectModuleViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-541 ② 效果作用域的加载', () => {
  test('用交进来的加载器加载描述符的模块', async () => {
    const loaded: string[] = []
    const scope = openMaintenanceWorkerEffectsScope<{ readonly selected: true }>({
      selectEffects: () => ({ selected: true }),
      descriptor: {
        moduleSpecifier: HOSTED_NAME,
        exportName: 'createEffects',
        configurationJson: '{}',
        capabilities: [],
      },
      context: { appHome: 'fixture-home', instanceRef: 'fixture-instance' },
      importModule: async (specifier) => {
        loaded.push(specifier)
        return { createEffects: () => ({ dispose() {} }) }
      },
    })
    expect(await scope.ready).toEqual({ selected: true })
    await scope.dispose()
    expect(loaded).toEqual([HOSTED_NAME])
  })

  test('没给加载器时按模块名 import', async () => {
    const scope = openMaintenanceWorkerEffectsScope({
      selectEffects: () => ({}),
      descriptor: {
        moduleSpecifier: 'node:os',
        exportName: 'noSuchFactory',
        configurationJson: '{}',
        capabilities: [],
      },
      context: { appHome: 'fixture-home', instanceRef: 'fixture-instance' },
    })
    // `node:os` loads as an ordinary import, so what fails is the missing export, not the import.
    await expect(scope.ready).rejects.toThrow('maintenance-worker-effects-factory-missing')
    await scope.dispose()
  })
})

describe('RFC-541 负对照', () => {
  const clean = [
    sourceUnit(
      EFFECTS,
      'export function openMaintenanceWorkerEffectsScope(input) { const importer = input.importModule ?? ((s) => import(s)) }',
    ),
    sourceUnit(ROOT, 'runMaintenanceWorker({ composeGraph, openEffectsScope })'),
    sourceUnit(
      HOSTED,
      `runMaintenanceWorker({ composeGraph, openEffectsScope: (input) => open({ ...input, importModule: (specifier) => specifier === '${HOSTED_NAME}' ? import('./crewstationMaintenance') : import(specifier) }) })`,
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(effectModuleViolations(clean)).toEqual([])
  })

  test('模块级的登记表与删去的名字都会被认出', () => {
    expect(
      effectModuleViolations(
        replace(
          EFFECTS,
          'const effectModules = new Map()\nexport function registerMaintenanceWorkerEffectModule(s, load) { effectModules.set(s, load) }',
        ),
      ),
    ).toEqual([
      'module-level collection:maintenanceWorkerEffects.ts:effectModules',
      'mutable singleton:maintenanceWorkerEffects.ts:registerMaintenanceWorkerEffectModule',
      `removed name:${EFFECTS}:effectModules`,
      `removed name:${EFFECTS}:registerMaintenanceWorkerEffectModule`,
    ])
  })

  test('托管根 import 单机根、不映射自己的效果模块、不调运行时，都会被认出', () => {
    expect(
      effectModuleViolations(replace(HOSTED, "import './maintenanceWorker'\nregister()")),
    ).toEqual([
      'hosted:imports the standalone root',
      'hosted:loader does not map the hosted effects module',
      'root:maintenanceWorkerEntry.ts runs the Worker runtime once',
    ])
    expect(
      effectModuleViolations(
        replace(
          HOSTED,
          'runMaintenanceWorker({ composeGraph, openEffectsScope: (input) => open({ ...input, importModule: (specifier) => import(specifier) }) })',
        ),
      ),
    ).toEqual(['hosted:loader does not map the hosted effects module'])
  })
})
