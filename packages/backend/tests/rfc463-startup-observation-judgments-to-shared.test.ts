// RFC-463 — 启动核验与清单观测的判定进 shared、空运行参数归 runtime-management（RFC-294 W9-D 第十步）。
//
// 锁四件事：
// ① `services/execution/startupVerification.ts` 与 `inventoryObservation.ts` 已删除，shared 里的新文件都在；`src/`、用例、仓库根
//    `tests/` 与脚本零 import 旧路径（census AST，带负对照）。
// ② 迁出的判定在后端与 shared 的源码里只有 shared 一处定义，shared 入口导出的就是它；`EMPTY_RUNTIME_PROFILE` 只在 runtime-management
//    `public/types` 定义，`services/execution/agentInjection` 不再导出它。
// ③ task-execution 的 `taskAgentRun` 不再取 `services/execution/`（`R2` 少 4 条）。
// ④ 判定读到的驱动能力就是 runtime-management 能力声明里的那两个字段：编译期双向锁住联合类型，能力声明可赋给 shared 的结构类型。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as shared from '@agent-workflow/shared'
import type {
  StartupObservationCapabilities,
  StartupObservationSource,
} from '@agent-workflow/shared'
import * as startupVerification from '../../shared/src/startupVerification'
import * as inventoryObservation from '../../shared/src/inventoryObservation'
import * as agentInjection from '@/modules/runtime-management/infrastructure/drivers/agentInjection'
import { EMPTY_RUNTIME_PROFILE } from '@/modules/runtime-management/public/types'
import type { RuntimeDriverCapabilities } from '@/modules/runtime-management/public/participants'
import { getRuntimeDriver } from '@/modules/runtime-management/infrastructure/drivers'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(REPO_ROOT, 'packages', 'shared', 'src')
const TESTS = resolve(import.meta.dir)
const DELETED = [
  'services/execution/startupVerification',
  'services/execution/inventoryObservation',
]
const STARTUP_VERIFICATION_FUNCTIONS = [
  'declaredHasContent',
  'verifyStartup',
  'observationFromInventory',
  'observationForVerification',
  'observationFromClaudeInit',
] as const

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

const slash = (path: string) => path.split('\\').join('/')

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) target = slash(relative(SRC, resolve(from, '..', specifier)))
  else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function specifiersOf(path: string): string[] {
  const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

function importsOfDeleted(files: readonly string[]): string[] {
  return files.flatMap((path) =>
    specifiersOf(path)
      .map((specifier) => targetOf(path, specifier))
      .filter((target): target is string => target !== null && DELETED.includes(target))
      .map((target) => `${slash(relative(REPO_ROOT, path))} -> ${target}`),
  )
}

describe('RFC-463 —— 两个判定文件迁出 services/', () => {
  test('旧文件不在了，shared 里的新文件都在', () => {
    for (const from of DELETED)
      expect([from, existsSync(join(SRC, `${from}.ts`))]).toEqual([from, false])
    expect(existsSync(join(SHARED_SRC, 'startupVerification.ts'))).toBe(true)
    expect(existsSync(join(SHARED_SRC, 'inventoryObservation.ts'))).toBe(true)
  })

  test('src/、用例、仓库根 tests/ 与脚本里零 import 旧路径', () => {
    expect(importsOfDeleted(walk(SRC))).toEqual([])
    expect(importsOfDeleted(walk(TESTS))).toEqual([])
    expect(importsOfDeleted(walk(join(REPO_ROOT, 'tests')))).toEqual([])
    expect(importsOfDeleted(walk(join(REPO_ROOT, 'scripts')))).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径', () => {
    const probe = join(SRC, 'services', 'execution', 'probe.ts')
    expect(
      DELETED.includes(targetOf(probe, '@/services/execution/startupVerification') ?? ''),
    ).toBe(true)
    expect(DELETED.includes(targetOf(probe, './inventoryObservation') ?? '')).toBe(true)
    expect(DELETED.includes(targetOf(probe, './inventoryObservationExtra') ?? '')).toBe(false)
  })
})

describe('RFC-463 —— 判定只在 shared、空运行参数只在 runtime-management', () => {
  const corpus = [...walk(SRC), ...walk(SHARED_SRC)].map((path) => ({
    path: slash(relative(REPO_ROOT, path)),
    text: readFileSync(path, 'utf8'),
  }))
  const definers = (pattern: string) =>
    corpus.filter((file) => new RegExp(pattern).test(file.text)).map((file) => file.path)

  test('每个判定在后端与 shared 源码里只有一处定义', () => {
    for (const name of STARTUP_VERIFICATION_FUNCTIONS)
      expect([name, definers(`export\\s+(async\\s+)?function\\s+${name}\\b`)]).toEqual([
        name,
        ['packages/shared/src/startupVerification.ts'],
      ])
    expect(definers('export\\s+function\\s+buildRuntimeInventoryObservation\\b')).toEqual([
      'packages/shared/src/inventoryObservation.ts',
    ])
    expect(definers('export\\s+interface\\s+ClaudeInitObservation\\b')).toEqual([
      'packages/shared/src/startupVerification.ts',
    ])
  })

  test('shared 入口导出的就是 shared 里那一份', () => {
    for (const name of STARTUP_VERIFICATION_FUNCTIONS)
      expect([name, shared[name] === startupVerification[name]]).toEqual([name, true])
    expect(shared.buildRuntimeInventoryObservation).toBe(
      inventoryObservation.buildRuntimeInventoryObservation,
    )
  })

  test('EMPTY_RUNTIME_PROFILE 只在 runtime-management public/types 定义，agentInjection 不再导出', () => {
    expect(definers('export\\s+const\\s+EMPTY_RUNTIME_PROFILE\\b')).toEqual([
      'packages/backend/src/modules/runtime-management/public/types.ts',
    ])
    expect('EMPTY_RUNTIME_PROFILE' in agentInjection).toBe(false)
    expect(EMPTY_RUNTIME_PROFILE).toEqual({
      model: null,
      variant: null,
      temperature: null,
      steps: null,
      maxSteps: null,
      isSandbox: false,
    })
  })
})

describe('RFC-463 —— 消费方改取', () => {
  test('taskAgentRun 不再取 services/execution/', () => {
    const run = specifiersOf(join(SRC, 'modules/task-execution/application/taskAgentRun.ts'))
    expect(run.filter((specifier) => specifier.startsWith('@/services/execution/'))).toEqual([])
    expect(run).toContain('@/modules/runtime-management/public/types')
  })

  test('负对照：判据认得出经 services/execution/ 取的写法', () => {
    const probe = sourceUnit(
      'packages/backend/src/modules/task-execution/application/probe.ts',
      "import { verifyStartup } from '@/services/execution/startupVerification'\n",
    )
    expect(importEdges(probe).map((edge) => edge.specifier)).toEqual([
      '@/services/execution/startupVerification',
    ])
  })
})

describe('RFC-463 —— 判定读到的驱动能力就是能力声明里的两个字段', () => {
  test('联合类型双向相等，能力声明可赋给 shared 的结构类型（编译期）', () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const same: Same<RuntimeDriverCapabilities['startupObservation'], StartupObservationSource> =
      true
    const freshRun: Same<
      RuntimeDriverCapabilities['observationRequiresFreshRun'],
      StartupObservationCapabilities['observationRequiresFreshRun']
    > = true
    expect([same, freshRun]).toEqual([true, true])
  })

  test('两个运行时的能力声明直接喂给 shared 判定', async () => {
    for (const kind of ['opencode', 'claude-code'] as const) {
      const capabilities: StartupObservationCapabilities = getRuntimeDriver(kind).capabilities
      const observation = await shared.observationForVerification(capabilities, {
        claudeInit: null,
        loadSnapshot: () => null,
      })
      expect([kind, observation.state]).toEqual([kind, 'unavailable'])
    }
  })
})
