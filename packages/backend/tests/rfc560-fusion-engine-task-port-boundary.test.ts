// RFC-560 — knowledge-evolution 的 fusion 引擎任务端口经 required-ports 交给 task-execution（RFC-294 S9 第十五步）。
//
// 锁四件事：
// ① task-execution 的生产文件取 knowledge-evolution 的，只剩指定 adapter（`application/adapters/knowledge-evolution-adapter.ts`）
//    按类型取 `composition/required-ports`（目标 DAG 没有 task-execution → knowledge-evolution 的 offered 边；判据带负对照）。
// ② 端口归 knowledge-evolution 的 `application/ports/fusionEngineTasks.ts`，required-ports 只交出实现方要的两个类型；public 不再声明它们。
// ③ 失去外部消费方的 fusion 值类型挪进 knowledge-evolution 的 domain，空出来的 `public/types.ts` 删除。
// ④ 目标 DAG 登记了这条虚线 required 边（`rfc294-design-parity` 另锁它与 RFC-294 design 的 Mermaid 一致）。
//
// 覆盖范围（C12）：① 覆盖 task-execution 的全部源码；② ③ ④ 只读点名的文件与常量。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { REQUIRED_CONTEXT_EDGES } from './architecture/rfc294Target'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const TE = join(MODULES, 'task-execution')
const KE = 'knowledge-evolution'
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Imports and re-exports reaching any knowledge-evolution file, as `<rest> (<type|value>)`. */
function knowledgeEvolutionImports(path: string, text: string): string[] {
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
    const rest = new RegExp(`^${KE}/(.+)$`).exec(slash(relative(MODULES, target)))?.[1]
    if (rest === undefined) continue
    const clause = isImport ? statement.importClause : undefined
    const typeOnly = isImport
      ? clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          clause?.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      : statement.isTypeOnly
    out.push(`${rest} (${typeOnly ? 'type' : 'value'})`)
  }
  return out
}

const namedExports = (path: string): string[] => {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ? [statement.name.text]
        : []
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      return statement.exportClause.elements.map((element) => element.name.text)
    return []
  })
}

describe('RFC-560 —— task-execution 只经指定 adapter 取 knowledge-evolution', () => {
  test('task-execution 全部源码里只剩 knowledge-evolution adapter 按类型取 required-ports', () => {
    const files = walk(TE)
    expect(files.length).toBeGreaterThanOrEqual(700)
    const found = [
      ...new Set(
        files.flatMap((path) =>
          knowledgeEvolutionImports(path, readFileSync(path, 'utf8')).map(
            (edge) => `${slash(relative(TE, path))} -> ${edge}`,
          ),
        ),
      ),
    ].sort()
    expect(found).toEqual([
      'application/adapters/knowledge-evolution-adapter.ts -> composition/required-ports (type)',
    ])
  }, 60_000)

  test('负对照：public、内部文件、值导入与相对路径都会被认出，别的 context 不算', () => {
    const at = join(TE, 'infrastructure', 'probe.ts')
    expect(
      knowledgeEvolutionImports(
        at,
        "import type { A } from '@/modules/knowledge-evolution/public/participants'\n" +
          "import { B } from '@/modules/knowledge-evolution/composition/required-ports'\n" +
          "export type { C } from '../../knowledge-evolution/application/ports/fusionEngineTasks'\n" +
          "import type { D } from '@/modules/memory/public/types'\n",
      ),
    ).toEqual([
      'public/participants (type)',
      'composition/required-ports (value)',
      'application/ports/fusionEngineTasks (type)',
    ])
  })
})

describe('RFC-560 —— 端口归 knowledge-evolution 的 application/ports', () => {
  test('端口声明在 fusionEngineTasks.ts；required-ports 只交出实现方要的两个；public 不再声明它们', () => {
    expect(namedExports(`${KE}/application/ports/fusionEngineTasks.ts`)).toEqual(
      expect.arrayContaining([
        'FusionWorkspaceSeed',
        'FusionEngineTaskResult',
        'FusionEngineTaskRecord',
        'FusionEngineTaskLaunch',
        'FusionEngineTaskOperations',
      ]),
    )
    expect(namedExports(`${KE}/composition/required-ports.ts`).sort()).toEqual([
      'FusionEngineTaskLaunch',
      'FusionEngineTaskOperations',
    ])
    const publicNames = namedExports(`${KE}/public/participants.ts`)
    expect(publicNames.length).toBeGreaterThan(0)
    for (const name of [
      'FusionEngineTaskLaunch',
      'FusionEngineTaskOperations',
      'FusionEngineTaskRecord',
    ])
      expect(publicNames).not.toContain(name)
    expect(
      namedExports('task-execution/application/adapters/knowledge-evolution-adapter.ts').sort(),
    ).toEqual(['FusionEngineTaskLaunch', 'FusionEngineTaskOperations'])
  })

  test('fusion 值类型在 domain，空出来的 public/types.ts 已删除', () => {
    expect(existsSync(join(MODULES, KE, 'public/types.ts'))).toBe(false)
    expect(namedExports(`${KE}/domain/fusionTree.ts`).sort()).toEqual([
      'FusionResultManifestRead',
      'FusionTreeFile',
    ])
  })

  test('目标 DAG 登记了 task-execution implements FusionEngineTaskOperations → knowledge-evolution', () => {
    expect(REQUIRED_CONTEXT_EDGES).toContainEqual([
      'task-execution',
      'knowledge-evolution',
      'FusionEngineTaskOperations',
    ])
  })
})
