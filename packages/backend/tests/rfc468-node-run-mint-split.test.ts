// RFC-468 — 拆分 nodeRunMint：冻结运行时归 runtime-management、铸行入口归 task-execution（RFC-294 W9-D 第十五步）。
//
// 锁五件事：
// ① `services/nodeRunMint.ts` 不在；src / 用例 / 脚本零 import 它（census AST，静态、动态 import 与相对路径都认，带负对照）。
// ② 冻结运行时在 runtime-management：任务运行时绑定与冻结算法零取 task-execution、取 runtime-management 自己的窄端口；编译期锁
//    task-execution 的 `NodeRunRuntimePersistence` 可交给这个窄端口（组合层的交接不会漂移），两边的行记录类型双向相等。
// ③ 铸行入口：唯一定义在 task-execution `infrastructure/legacyNodeRunMint.ts`。RFC-478：模块外唯一的读者 `services/task.ts`（延后仓库
//    准备）迁进 task-execution 后改取定义处的 `mintNodeRun` / `nextRetryIndex`，`mintNodeRun` 随之撤出 `public/operations`。
// ④ `continuesClarifyLineage` 在 task-execution `domain/clarifyRules.ts`，agent 节点执行从那里取。
// ⑤ `schedulerMintCause` 全仓只有一个定义（task-execution `application/resolveSchedulerRunRow.ts`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type {
  FrozenNodeRunRuntimeRecord,
  NodeRunRuntimePersistence,
} from '@/modules/task-execution/application/ports/nodeRunRuntimePersistence'
import type {
  FrozenTaskRuntimeRecord,
  TaskRuntimeFreezePersistence,
} from '@/modules/runtime-management/application/ports/taskRuntimeFreezePersistence'
import * as taskExecutionOperations from '@/modules/task-execution/public/operations'
import { mintNodeRun } from '@/modules/task-execution/infrastructure/legacyNodeRunMint'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const RETIRED = 'services/nodeRunMint'
const BINDINGS = 'modules/runtime-management/infrastructure/local/taskAgentRuntimeBindings.ts'
const FREEZE = 'modules/runtime-management/infrastructure/local/frozenTaskRuntime.ts'
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

// Compile-time locks (tsc): Task Execution's persistence is what composition hands to Runtime Management's freeze, and
// both sides describe the same three frozen columns.
const handOver = (persistence: NodeRunRuntimePersistence): TaskRuntimeFreezePersistence =>
  persistence
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const recordsEqual: Equal<FrozenTaskRuntimeRecord, FrozenNodeRunRuntimeRecord> = true

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Resolve an import specifier to a `src/`-relative path stem (alias and relative forms), or null. */
function targetOf(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (!specifier.startsWith('.')) return null
  const rel = slash(relative(SRC, resolve(from, '..', specifier)))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

const importsOf = (files: readonly string[], target: string) =>
  files.flatMap((path) => {
    const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
    return importEdges(unit)
      .filter((edge) => targetOf(path, edge.specifier) === target)
      .map((edge) => `${slash(relative(REPO_ROOT, path))} -> ${edge.specifier}`)
  })

describe('RFC-468 —— nodeRunMint 不在、零引用', () => {
  test('services/nodeRunMint.ts 不在', () => {
    expect(existsSync(join(SRC, `${RETIRED}.ts`))).toBe(false)
  })

  test('src、用例与脚本零 import 它', () => {
    expect(importsOf(walk(SRC), RETIRED)).toEqual([])
    expect(importsOf(walk(TESTS), RETIRED)).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')), RETIRED)).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名、相对路径与动态 import', () => {
    const probe = join(TESTS, 'probe.test.ts')
    expect(targetOf(probe, '../src/services/nodeRunMint')).toBe(RETIRED)
    expect(targetOf(join(SRC, 'services', 'probe.ts'), './nodeRunMint')).toBe(RETIRED)
    expect(targetOf(probe, '@/services/nodeRunMint')).toBe(RETIRED)
    expect(targetOf(probe, '@/services/nodeRunMintExtra')).not.toBe(RETIRED)
    const unit = sourceUnit(
      'packages/backend/tests/probe.test.ts',
      "const { mintNodeRun } = await import('../src/services/nodeRunMint')\n" +
        "import { isClarifyRerunCause } from '@/services/nodeRunMint'\n",
    )
    expect(
      importEdges(unit)
        .map((edge) => edge.specifier)
        .sort(),
    ).toEqual(['../src/services/nodeRunMint', '@/services/nodeRunMint'])
  })
})

describe('RFC-468 —— 冻结运行时归 runtime-management', () => {
  test('绑定与冻结算法零取 task-execution，取 runtime-management 自己的窄端口', () => {
    for (const path of [BINDINGS, FREEZE]) {
      const unit = sourceUnit(`packages/backend/src/${path}`, read(path))
      const specifiers = importEdges(unit).map((edge) => edge.specifier)
      expect([
        path,
        specifiers.filter((specifier) => specifier.includes('task-execution')),
      ]).toEqual([path, []])
      expect(specifiers).toContain('../../application/ports/taskRuntimeFreezePersistence')
    }
    expect(read(BINDINGS)).toMatch(
      /import \{\s*frozenRuntimeOfSessionWith,\s*resolveFrozenRuntimeWith,\s*type FrozenRuntime,?\s*\} from '\.\/frozenTaskRuntime'/,
    )
    expect(read(BINDINGS)).toContain('readonly persistence: TaskRuntimeFreezePersistence')
    const freeze = read(FREEZE)
    expect(freeze).toContain('export async function resolveFrozenRuntimeWith(')
    expect(freeze).toContain('export async function frozenRuntimeOfSessionWith(')
    expect(freeze.split('persistence: TaskRuntimeFreezePersistence,').length - 1).toBe(2)
  })

  test('编译期：task-execution 的持久化可交给窄端口，两边的行记录类型相等', () => {
    expect(typeof handOver).toBe('function')
    expect(recordsEqual).toBe(true)
  })
})

describe('RFC-468 —— 铸行入口归 task-execution', () => {
  test('mintNodeRun 只有 infrastructure 那一个，已撤出 public/operations（RFC-478）', () => {
    expect(typeof mintNodeRun).toBe('function')
    expect('mintNodeRun' in taskExecutionOperations).toBe(false)
  })

  test('延后仓库准备取定义处的 mintNodeRun / nextRetryIndex（RFC-478：原 services/task.ts 经两个 public 入口取）', () => {
    const preparation = read(
      'modules/task-execution/infrastructure/deferredRepositoryPreparation.ts',
    )
    expect(preparation).toContain("import { mintNodeRun } from './legacyNodeRunMint'")
    expect(preparation).toContain("import { nextRetryIndex } from '../application/nextRetryIndex'")
    expect(preparation).not.toContain('@/modules/task-execution/public/')
    expect(preparation).not.toContain('@/services/nodeRunMint')
  })
})

describe('RFC-468 —— 判定归位、副本删除', () => {
  test('continuesClarifyLineage 在 domain/clarifyRules，agent 节点执行从那里取', () => {
    expect(read('modules/task-execution/domain/clarifyRules.ts')).toContain(
      'export function continuesClarifyLineage(',
    )
    expect(read('modules/task-execution/composition/agentNodeExecution.ts')).toMatch(
      /\n {2}continuesClarifyLineage,\n[^}]*\} from '\.\.\/domain\/clarifyRules'/,
    )
  })

  test('schedulerMintCause 全仓只有一个定义', () => {
    const definitions = walk(SRC)
      .filter((path) => /\bfunction schedulerMintCause\(/.test(readFileSync(path, 'utf8')))
      .map((path) => slash(relative(SRC, path)))
    expect(definitions).toEqual(['modules/task-execution/application/resolveSchedulerRunRow.ts'])
  })
})
