// RFC-467 — 注入预言一族迁入用例树、资源快照策略束只留外部策略（RFC-294 W9-D 第十四步）。
//
// 锁三件事：
// ① RFC-349 的注入解析行为预言与只有它在用的 `services/agentDeps` / `mcpClosure` / `pluginClosure` 不在 src、在 `tests/helpers/`，两个
//    技能转出（`services/skillBootVerify`、`services/skillIdentityPaths`）不在；src / 用例 / 脚本零 import 这六个原路径（census AST，别名与
//    相对路径都认，带负对照）；预言改取同目录 helper 与 resource-catalog 定义处。
// ② bootstrap 注入的策略束只剩 4 个外部策略字段（对象键逐个相等），不再取任何模块文件。
// ③ resource-catalog 的端口同样只剩这 4 个字段，适配器直接取 resource-catalog 自己的 `assertNotBuiltin` 与 `isSkillInjectableThisBoot`。
// ④ 唯一的模块外读者随预言迁走的 `validateAgentDependencies` 退出 resource-catalog `public/queries`（RFC-294 design §3.3）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import * as resourceCatalogQueries from '@/modules/resource-catalog/public/queries'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const TESTS = resolve(import.meta.dir)
const HELPERS = join(TESTS, 'helpers')
const RETIRED: readonly string[] = [
  'services/agentDeps',
  'services/mcpClosure',
  'services/pluginClosure',
  'services/skillBootVerify',
  'services/skillIdentityPaths',
  'modules/task-execution/infrastructure/legacyTaskExecutionInjectionResolver',
]
const MOVED = ['agentDeps', 'mcpClosure', 'pluginClosure', 'legacyTaskExecutionInjectionResolver']
const EXTERNAL_POLICY = [
  'findManagedInjectionNameConflict',
  'formatManagedInjectionNameConflict',
  'pickCallTarget',
  'pluginDisabledErrorCode',
]
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

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
  const absolute = resolve(from, '..', specifier)
  const rel = slash(relative(SRC, absolute))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

const importsOf = (files: readonly string[], targets: readonly string[]) =>
  files.flatMap((path) => {
    const unit = sourceUnit(slash(relative(REPO_ROOT, path)), readFileSync(path, 'utf8'))
    return importEdges(unit)
      .map((edge) => targetOf(path, edge.specifier))
      .filter((target): target is string => target !== null)
      .filter((target) => targets.includes(target))
      .map((target) => `${slash(relative(REPO_ROOT, path))} -> ${target}`)
  })

describe('RFC-467 —— 预言一族离开生产树', () => {
  test('六个原文件不在 src，预言与三个实现在 tests/helpers/', () => {
    for (const path of RETIRED)
      expect([path, existsSync(join(SRC, `${path}.ts`))]).toEqual([path, false])
    for (const name of MOVED)
      expect([name, existsSync(join(HELPERS, `${name}.ts`))]).toEqual([name, true])
  })

  test('src、用例与脚本零 import 六个原路径', () => {
    expect(importsOf(walk(SRC), RETIRED)).toEqual([])
    expect(importsOf(walk(TESTS), RETIRED)).toEqual([])
    expect(importsOf(walk(resolve(REPO_ROOT, 'scripts')), RETIRED)).toEqual([])
  }, 60_000)

  test('负对照：判据认得出别名与相对路径', () => {
    const probe = join(SRC, 'modules', 'task-execution', 'infrastructure', 'probe.ts')
    expect(targetOf(probe, '@/services/agentDeps')).toBe('services/agentDeps')
    expect(targetOf(probe, './legacyTaskExecutionInjectionResolver')).toBe(
      'modules/task-execution/infrastructure/legacyTaskExecutionInjectionResolver',
    )
    expect(targetOf(probe, '../../../services/mcpClosure')).toBe('services/mcpClosure')
    expect(targetOf(probe, '../../../services/mcpClosureExtra')).toBe('services/mcpClosureExtra')
    const unit = sourceUnit(
      'packages/backend/src/modules/task-execution/infrastructure/probe.ts',
      "import { isSkillInjectableThisBoot } from '@/services/skillBootVerify'\n",
    )
    expect(importEdges(unit).map((edge) => edge.specifier)).toEqual(['@/services/skillBootVerify'])
  })

  test('预言改取同目录 helper 与 resource-catalog 定义处', () => {
    const oracle = readFileSync(join(HELPERS, 'legacyTaskExecutionInjectionResolver.ts'), 'utf8')
    for (const anchor of [
      "from './agentDeps'",
      "from './mcpClosure'",
      "from './pluginClosure'",
      "from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'",
      "from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'",
      "import { mcpFromPersistenceRow } from '@/modules/resource-catalog/infrastructure/mcpPersistence'",
      "import { pluginFromPersistenceRow } from '@/modules/resource-catalog/infrastructure/pluginPersistence'",
    ])
      expect([anchor, oracle.includes(anchor)]).toEqual([anchor, true])
    expect(oracle).not.toContain('taskExecutionResourceDependencies')
  })
})

describe('RFC-467 —— 策略束只留外部策略', () => {
  test('bootstrap 注入的策略束只剩 4 个外部策略字段，不取任何模块文件', () => {
    expect(Object.keys(taskExecutionResourceDependencies).sort()).toEqual(EXTERNAL_POLICY)
    expect(read('services/execution/taskExecutionResourceDependencies.ts')).not.toContain(
      '@/modules/',
    )
  })

  test('resource-catalog 端口只剩这 4 个字段，适配器直接取自己的两个判定', () => {
    const adapter = read(
      'modules/resource-catalog/infrastructure/aggregateAdapters/taskExecutionResourceSnapshots.ts',
    )
    const start = adapter.indexOf('export interface TaskExecutionResourceDependencies {')
    expect(start).toBeGreaterThan(0)
    const port = adapter.slice(start, adapter.indexOf('\n}\n', start))
    expect([...port.matchAll(/^ {2}readonly (\w+)/gm)].map((match) => match[1]).sort()).toEqual(
      EXTERNAL_POLICY,
    )
    expect(adapter).toContain("import { assertNotBuiltin } from '../../domain/systemResources'")
    expect(adapter).toContain(
      "import { isSkillInjectableThisBoot } from '../legacy/skillBootVerify'",
    )
    expect(adapter).toContain("    assertNotBuiltin('workflow', row)\n")
    expect(adapter).toContain(
      "if (!isSkillInjectableThisBoot({ id: row.id, sourceKind: 'managed' })) {",
    )
    expect(adapter).not.toMatch(
      /dependencies\.(?:assertNotBuiltin|isSkillInjectableThisBoot|skillFilesRel)\b/,
    )
  })
})

describe('RFC-467 —— 失去模块外读者的 public 符号收回', () => {
  test('validateAgentDependencies 退出 resource-catalog public/queries，resource-catalog 自己的 agent 应用直接取', () => {
    expect(Object.keys(resourceCatalogQueries)).not.toContain('validateAgentDependencies')
    expect(read('modules/resource-catalog/application/agents/agentApplication.ts')).toContain(
      "from './agentDependencyValidation'",
    )
  })
})
