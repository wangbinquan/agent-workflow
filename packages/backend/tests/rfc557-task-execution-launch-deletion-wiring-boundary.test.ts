// RFC-557 — 工作组启动资源面归 resource-catalog，本地删除选择由 bootstrap 装配（RFC-294 S9 第十二步）。
//
// 锁四件事：
// ① task-execution 的生产文件取 resource-catalog / source-control 的非 public 文件，只能是各自的指定 adapter
//    （`application/adapters/<context>-adapter.ts`），且只按类型取 `composition/required-ports`（判据带负对照）。
// ② 工作组启动资源面在 resource-catalog（实现、composition 与指定 adapter），task-execution 下没有它；端口经 task-execution 的
//    required-ports 交出；bootstrap 从 resource-catalog 的 composition 取。
// ③ `composeLocalTaskDeletionEffects` 收仓库参与者、原样放进删除效果，不再取 source-control；standalone bootstrap 交 git 参与者。
// ④ 目标 DAG 登记了这条虚线 required 边（`rfc294-design-parity` 另锁它与 RFC-294 design 的 Mermaid 一致）。
//
// 覆盖范围（C12）：① 覆盖 task-execution 的全部源码；② ③ ④ 只读点名的文件、常量与一个纯组合函数。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { TaskDeletionEffects } from '../src/modules/task-execution/application/ports/taskDeletionContentEffects'
import { composeLocalTaskDeletionEffects } from '../src/modules/task-execution/composition/taskDeletionEffects'
import { REQUIRED_CONTEXT_EDGES } from './architecture/rfc294Target'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const TE = join(MODULES, 'task-execution')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/**
 * Imports and re-exports reaching a non-public file of one of `owners`, as `<context>/<rest> (<type|value>)`.
 * `@/` resolves to `src/`; relative specifiers resolve against the file's directory.
 */
function internalImports(path: string, text: string, owners: readonly string[]): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement)
    if (!isImport && !ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue
    const target = specifier.text.startsWith('@/')
      ? join(SRC, specifier.text.slice(2))
      : specifier.text.startsWith('.')
        ? resolve(dirname(path), specifier.text)
        : null
    if (target === null) continue
    const match = /^([a-z-]+)\/(.+)$/.exec(slash(relative(MODULES, target)))
    if (match === null || !owners.includes(match[1]!) || /^public\/[a-z]+$/.test(match[2]!))
      continue
    const clause = isImport ? statement.importClause : undefined
    const typeOnly = isImport
      ? clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          clause?.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      : statement.isTypeOnly
    out.push(`${match[1]}/${match[2]} (${typeOnly ? 'type' : 'value'})`)
  }
  return out
}

describe('RFC-557 —— task-execution 只经指定 adapter 取 resource-catalog / source-control', () => {
  test('取它们非 public 文件的只有两个 adapter，且只按类型取 required-ports', () => {
    const files = walk(TE)
    expect(files.length).toBeGreaterThanOrEqual(700)
    const found = [
      ...new Set(
        files.flatMap((path) =>
          internalImports(path, readFileSync(path, 'utf8'), [
            'resource-catalog',
            'source-control',
          ]).map((edge) => `${slash(relative(TE, path))} -> ${edge}`),
        ),
      ),
    ].sort()
    expect(found).toEqual([
      'application/adapters/resource-catalog-adapter.ts -> resource-catalog/composition/required-ports (type)',
      'application/adapters/source-control-adapter.ts -> source-control/composition/required-ports (type)',
    ])
  }, 60_000)

  test('负对照：composition、legacy 与值导入都会被认出，public 与别的 context 不算', () => {
    const at = join(TE, 'infrastructure', 'probe.ts')
    expect(
      internalImports(
        at,
        "import { canViewResource } from '@/modules/resource-catalog/composition/resourceAcl'\n" +
          "import { getWorkgroupById } from '../../resource-catalog/infrastructure/legacy/workgroups'\n" +
          "import { createGitTaskDeletionRepositoryEffects } from '@/modules/source-control/composition'\n" +
          "import type { A } from '@/modules/source-control/composition/required-ports'\n" +
          "import type { B } from '@/modules/resource-catalog/public/participants'\n" +
          "import type { C } from '@/modules/integration/composition/required-ports'\n",
        ['resource-catalog', 'source-control'],
      ),
    ).toEqual([
      'resource-catalog/composition/resourceAcl (value)',
      'resource-catalog/infrastructure/legacy/workgroups (value)',
      'source-control/composition (value)',
      'source-control/composition/required-ports (type)',
    ])
  })
})

describe('RFC-557 —— 工作组启动资源面归 resource-catalog', () => {
  test('实现与 composition 在 resource-catalog，task-execution 下没有它们', () => {
    for (const path of [
      'modules/task-execution/infrastructure/workgroupLaunchResourceOperations.ts',
      'modules/task-execution/composition/workgroupLaunchResources.ts',
    ])
      expect(existsSync(join(SRC, path))).toBe(false)
    expect(
      read('modules/resource-catalog/infrastructure/workgroupLaunchResourceOperations.ts'),
    ).toContain(
      "import type { WorkgroupRouteLaunchResources } from '../application/adapters/task-execution-adapter'",
    )
    expect(read('modules/resource-catalog/composition/workgroupLaunchResources.ts')).toContain(
      'export function composeWorkgroupLaunchResourceOperations(',
    )
  })

  test('端口经 task-execution 的 required-ports 交出，resource-catalog 的 adapter 按类型取；bootstrap 从 resource-catalog 取', () => {
    expect(read('modules/task-execution/composition/required-ports.ts')).toContain(
      "export type { WorkgroupRouteLaunchResources } from '../application/ports/taskRouteLaunch'",
    )
    expect(
      read('modules/resource-catalog/application/adapters/task-execution-adapter.ts'),
    ).toContain(
      "export type { WorkgroupRouteLaunchResources } from '@/modules/task-execution/composition/required-ports'",
    )
    expect(read('bootstrap/daemonModules/taskExecution.ts')).toContain(
      "from '@/modules/resource-catalog/composition/workgroupLaunchResources'",
    )
  })

  test('目标 DAG 登记了 resource-catalog implements WorkgroupRouteLaunchResources → task-execution', () => {
    expect(REQUIRED_CONTEXT_EDGES).toContainEqual([
      'resource-catalog',
      'task-execution',
      'WorkgroupRouteLaunchResources',
    ])
  })
})

describe('RFC-557 —— 本地删除选择由 bootstrap 装配', () => {
  test('composeLocalTaskDeletionEffects 原样放进交来的仓库参与者，不再取 source-control', () => {
    const repositories = {
      marker: 'git participant',
    } as unknown as TaskDeletionEffects['repositories']
    const effects = composeLocalTaskDeletionEffects(repositories)
    expect(effects.repositories).toBe(repositories)
    expect(effects.content).toBeDefined()
    expect(Object.isFrozen(effects)).toBe(true)
    expect(read('modules/task-execution/composition/taskDeletionEffects.ts')).not.toContain(
      'source-control',
    )
  })

  test('standalone bootstrap 把 source-control 的 git 参与者交进去', () => {
    expect(read('bootstrap/standalone.ts')).toContain(
      'composeLocalTaskDeletionEffects(createGitTaskDeletionRepositoryEffects())',
    )
  })
})
