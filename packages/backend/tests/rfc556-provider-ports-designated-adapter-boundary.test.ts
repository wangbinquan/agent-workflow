// RFC-556 — provider 实现别的 context 的端口一律经指定 adapter（RFC-294 S9 第十一步）。
//
// 锁三件事：
// ① task-execution 取 integration / task-catalog / runtime-management、resource-catalog 取 integration / runtime-management 的非 public 文件，
//    只能是各自的指定 adapter（`application/adapters/<consumer>-adapter.ts`），且只按类型取 `composition/required-ports`（判据带负对照）。
// ② 两个 consumer 的 required-ports 交出端口；adapter 转出或声明 provider 用的类型，provider 的 infrastructure 从 adapter 取；
//    integration 的 webhook 分发装配不再转出这个端口。
// ③ 目标 DAG 登记了两条新的虚线 required 边（`rfc294-design-parity` 另锁它们与 RFC-294 design 的 Mermaid 一致），
//    task-catalog 的那条照旧在。
//
// 覆盖范围（C12）：① 覆盖 task-execution 与 resource-catalog 的全部源码；② ③ 只读点名的文件与常量。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { REQUIRED_CONTEXT_EDGES } from './architecture/rfc294Target'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/**
 * Imports and re-exports reaching a non-public file of one of `consumers`, as `<context>/<rest> (<type|value>)`.
 * `@/` resolves to `src/`; relative specifiers resolve against the file's directory.
 */
function internalImports(path: string, text: string, consumers: readonly string[]): string[] {
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
    if (match === null || !consumers.includes(match[1]!) || /^public\/[a-z]+$/.test(match[2]!))
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

/** Names a module file imports from `specifier` (named imports, with or without `type`). */
function importedNames(path: string, specifier: string): string[] {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === specifier &&
    statement.importClause?.namedBindings !== undefined &&
    ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements.map((element) => element.name.text)
      : [],
  )
}

function providerEdges(provider: string, consumers: readonly string[]): string[] {
  const root = join(MODULES, provider)
  const files = walk(root)
  expect(files.length).toBeGreaterThanOrEqual(300)
  return [
    ...new Set(
      files.flatMap((path) =>
        internalImports(path, readFileSync(path, 'utf8'), consumers).map(
          (edge) => `${slash(relative(root, path))} -> ${edge}`,
        ),
      ),
    ),
  ].sort()
}

describe('RFC-556 —— provider 只经指定 adapter 取 consumer 的 required-ports', () => {
  test('task-execution 取 integration / task-catalog / runtime-management 的非 public 文件只有三个 adapter，且只按类型', () => {
    expect(
      providerEdges('task-execution', ['integration', 'task-catalog', 'runtime-management']),
    ).toEqual([
      'application/adapters/integration-adapter.ts -> integration/composition/required-ports (type)',
      'application/adapters/runtime-management-adapter.ts -> runtime-management/composition/required-ports (type)',
      'application/adapters/task-catalog-adapter.ts -> task-catalog/composition/required-ports (type)',
    ])
  }, 60_000)

  test('resource-catalog 取 integration / runtime-management 的非 public 文件只有两个 adapter，且只按类型', () => {
    expect(providerEdges('resource-catalog', ['integration', 'runtime-management'])).toEqual([
      'application/adapters/integration-adapter.ts -> integration/composition/required-ports (type)',
      'application/adapters/runtime-management-adapter.ts -> runtime-management/composition/required-ports (type)',
    ])
  }, 60_000)

  test('负对照：内部文件、值导入、转出与相对路径都会被认出，public 与别的 context 不算', () => {
    const at = join(MODULES, 'task-execution', 'infrastructure', 'probe.ts')
    expect(
      internalImports(
        at,
        "import type { A } from '@/modules/integration/application/ports/webhookExecution'\n" +
          "import { B } from '@/modules/task-catalog/composition/required-ports'\n" +
          "import { type C } from '@/modules/runtime-management/composition/required-ports'\n" +
          "export type { D } from '@/modules/runtime-management/composition/required-ports'\n" +
          "import { E } from '../../task-catalog/application/catalog'\n" +
          "import type { F } from '@/modules/integration/public/participants'\n" +
          "import type { G } from '@/modules/source-control/composition/required-ports'\n",
        ['integration', 'task-catalog', 'runtime-management'],
      ),
    ).toEqual([
      'integration/application/ports/webhookExecution (type)',
      'task-catalog/composition/required-ports (value)',
      'runtime-management/composition/required-ports (type)',
      'runtime-management/composition/required-ports (type)',
      'task-catalog/application/catalog (value)',
    ])
  })
})

describe('RFC-556 —— 端口与 adapter', () => {
  test('两个 consumer 的 required-ports 按类型交出端口；webhook 分发装配不再转出它', () => {
    expect(read('integration/composition/required-ports.ts')).toContain(
      "export type { WebhookTaskExecutionParticipant } from '../application/ports/webhookExecution'",
    )
    expect(read('runtime-management/composition/required-ports.ts')).toContain(
      "export type { RuntimeProfileUsageReader } from '../application/ports/runtimeProfileParticipants'",
    )
    expect(read('integration/composition/webhookDispatch.ts')).not.toContain(
      'WebhookTaskExecutionParticipant',
    )
  })

  test('adapter 转出或声明 provider 用的类型，provider 的 infrastructure 从 adapter 取', () => {
    expect(read('task-execution/application/adapters/task-catalog-adapter.ts')).toContain(
      'export type { TaskCatalogSource }',
    )
    for (const file of ['taskCatalogSources.ts', 'taskExecutionCatalogSources.ts'])
      expect(
        importedNames(
          `task-execution/infrastructure/${file}`,
          '../application/adapters/task-catalog-adapter',
        ),
      ).toContain('TaskCatalogSource')
    expect(read('task-execution/application/adapters/integration-adapter.ts')).toContain(
      'export type TaskExecutionTriggerParticipant = WebhookTaskExecutionParticipant<',
    )
    expect(read('task-execution/infrastructure/taskExecutionTrigger.ts')).toContain(
      "import type { TaskExecutionTriggerParticipant } from '../application/adapters/integration-adapter'",
    )
    expect(read('resource-catalog/application/adapters/runtime-management-adapter.ts')).toContain(
      "export type { RuntimeProfileUsageReader } from '@/modules/runtime-management/composition/required-ports'",
    )
    expect(
      read('resource-catalog/infrastructure/adapters/runtimeProfileParticipants.ts'),
    ).toContain(
      "import type { RuntimeProfileUsageReader } from '../../application/adapters/runtime-management-adapter'",
    )
  })

  test('目标 DAG 登记了两条新的虚线边，task-catalog 的那条照旧在', () => {
    const declared: ReadonlyArray<readonly string[]> = REQUIRED_CONTEXT_EDGES
    for (const edge of [
      ['task-execution', 'integration', 'WebhookTaskExecutionParticipant'],
      ['resource-catalog', 'runtime-management', 'RuntimeProfileUsageReader'],
      ['task-execution', 'task-catalog', 'TaskCatalogSource'],
    ])
      expect(declared).toContainEqual(edge)
  })
})
