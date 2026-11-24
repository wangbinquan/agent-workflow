// RFC-563 — source-control 与 resource-catalog 用自己的形状声明任务代理的内容引用与资源材料（RFC-294 S9 第十八步）。
//
// 锁三件事：
// ① source-control 的生产文件不取 runtime-management；resource-catalog 取它的只剩指定 adapter 按类型取 `composition/required-ports`
//    （判据带负对照；MCP 诊断的两处由 RFC-564 销账）。
// ② 形状各归各家：resource-catalog 的端口文件声明内容引用、技能材料与插件材料；source-control 的工作区内容只声明自己读写的两个形状。
// ③ 编译期断言：这些形状仍能交给 runtime-management 的材料意图与 task-execution 的本机端口（bootstrap 交的就是它们）。
//
// 覆盖范围（C12）：① 覆盖 source-control 与 resource-catalog 的全部源码；② 只读点名的文件；③ 由 `tsc` 检查。运行期行为由既有的
// `rfc370-task-agent-family` 与 `rfc370-m2-native-material` 覆盖（本 RFC 只换类型的出处）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type {
  TaskAgentPluginMaterial,
  TaskAgentResourceMaterial,
  TaskAgentSkillMaterial,
} from '../src/modules/resource-catalog/application/ports/taskAgentMaterialReferences'
import type { createHostedNativePluginReader } from '../src/modules/resource-catalog/infrastructure/crewstation/crewstationNativePlugin'
import type { createLocalTaskAgentMaterialReferences } from '../src/modules/resource-catalog/infrastructure/local/taskAgentMaterialReferences'
import type { AgentMaterialIntent } from '../src/modules/runtime-management/public/participants'
import type { createLocalTaskAgentWorkspaceContents } from '../src/modules/source-control/infrastructure/local/taskAgentWorkspaceContents'
import type {
  NativeTaskAgentMaterialReferences,
  NativeTaskAgentWorkspaceContents,
} from '../src/modules/task-execution/infrastructure/local/nativeRunFamilyProviders'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const PROVIDER = 'runtime-management'
const read = (path: string) => readFileSync(join(MODULES, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Imports, re-exports, dynamic imports and `import('…')` types reaching runtime-management, as `<rest> (<type|value>)`. */
function providerEdges(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string, typeOnly: boolean) => {
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(path), specifier)
        : null
    if (target === null) return
    const rest = new RegExp(`^${PROVIDER}/(.+)$`).exec(slash(relative(MODULES, target)))?.[1]
    if (rest !== undefined) out.push(`${rest} (${typeOnly ? 'type' : 'value'})`)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      add(
        node.moduleSpecifier.text,
        clause?.isTypeOnly === true ||
          (clause !== undefined &&
            clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)),
      )
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text, node.isTypeOnly)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text, false)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text, true)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function contextEdges(context: string, files: readonly string[]): string[] {
  const root = join(MODULES, context)
  return [
    ...new Set(
      files.flatMap((path) =>
        providerEdges(path, readFileSync(path, 'utf8')).map(
          (edge) => `${slash(relative(root, path))} -> ${edge}`,
        ),
      ),
    ),
  ].sort()
}

const exportedNames = (path: string): string[] => {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [statement.name.text]
      : [],
  )
}

// Compile-time: the owners' shapes still fit the material intent and Task Execution's native ports.
type IntentInjection = AgentMaterialIntent['injection']
const skillsFit = (material: TaskAgentResourceMaterial): NonNullable<IntentInjection['skills']> =>
  material.skills
const pluginsFit = (material: TaskAgentResourceMaterial): NonNullable<IntentInjection['plugins']> =>
  material.plugins
const oneSkillFits = (
  skill: TaskAgentSkillMaterial,
): NonNullable<IntentInjection['skills']>[number] => skill
const onePluginFits = (
  plugin: TaskAgentPluginMaterial,
): NonNullable<IntentInjection['plugins']>[number] => plugin
const localReferencesFit = (
  selected: ReturnType<typeof createLocalTaskAgentMaterialReferences>,
): NativeTaskAgentMaterialReferences => selected
const workspaceContentsFit = (
  contents: ReturnType<typeof createLocalTaskAgentWorkspaceContents>,
): NativeTaskAgentWorkspaceContents => contents
const hostedReaderAcceptsIntentPlugin = (
  reader: ReturnType<typeof createHostedNativePluginReader>,
  plugin: NonNullable<IntentInjection['plugins']>[number],
) => reader(plugin)

describe('RFC-563 —— 两个 owner 不按名字取 runtime-management 的材料类型', () => {
  test('source-control 的全部源码不取 runtime-management', () => {
    const files = walk(join(MODULES, 'source-control'))
    expect(files.length).toBeGreaterThanOrEqual(150)
    expect(contextEdges('source-control', files)).toEqual([])
  }, 60_000)

  // RFC-564: the MCP diagnostics settled their two pairs as well — only the designated adapter is left.
  test('resource-catalog 取 runtime-management 的只剩指定 adapter', () => {
    const files = walk(join(MODULES, 'resource-catalog'))
    expect(files.length).toBeGreaterThanOrEqual(330)
    expect(contextEdges('resource-catalog', files)).toEqual([
      'application/adapters/runtime-management-adapter.ts -> composition/required-ports (type)',
    ])
  }, 60_000)

  test('负对照：public、内部文件、值导入、转出、相对路径、动态 import 与 import 类型都会被认出，别的 context 不算', () => {
    const at = join(MODULES, 'source-control', 'infrastructure', 'local', 'probe.ts')
    expect(
      providerEdges(
        at,
        "import type { A } from '@/modules/runtime-management/public/participants'\n" +
          "import { b } from '@/modules/runtime-management/composition/localAgentMaterial'\n" +
          "export type { C } from '../../../runtime-management/application/ports/agentMaterial'\n" +
          "const d = () => import('@/modules/runtime-management/public/types')\n" +
          "import { type E } from '@/modules/runtime-management/composition/required-ports'\n" +
          "type H = import('@/modules/runtime-management/public/types').RuntimeKind\n" +
          "import type { F } from '@/modules/task-execution/public/types'\n" +
          "import type { G } from '@agent-workflow/shared'\n",
      ),
    ).toEqual([
      'public/participants (type)',
      'composition/localAgentMaterial (value)',
      'application/ports/agentMaterial (type)',
      'public/types (value)',
      'composition/required-ports (type)',
      'public/types (type)',
    ])
  })
})

describe('RFC-563 —— 形状各归各家', () => {
  test('resource-catalog 的端口文件声明内容引用、技能材料与插件材料', () => {
    const path = 'resource-catalog/application/ports/taskAgentMaterialReferences.ts'
    expect(exportedNames(path)).toEqual([
      'TaskAgentInjectionSnapshot',
      'TaskAgentResourceContentReference',
      'TaskAgentSkillMaterial',
      'TaskAgentPluginMaterial',
      'TaskAgentResourceMaterial',
      'TaskAgentMaterialReferences',
    ])
    const text = read(path)
    expect(text).toContain("readonly owner: 'resource-catalog'")
    expect(text).toContain('readonly skills: readonly TaskAgentSkillMaterial[]')
    expect(text).toContain('readonly plugins: readonly TaskAgentPluginMaterial[]')
  })

  test('source-control 的工作区内容只声明自己读写的两个形状，且不转出它们', () => {
    const path = 'source-control/infrastructure/local/taskAgentWorkspaceContents.ts'
    const text = read(path)
    expect(text).toContain('interface WorkspaceContentReference {')
    expect(text).toContain("readonly owner: 'source-control'")
    expect(text).toContain('prepareMounts(): readonly IssuedMountReference[] {')
    expect(exportedNames(path)).toEqual([])
  })

  test('形状仍能交给材料意图与本机端口（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      skillsFit,
      pluginsFit,
      oneSkillFits,
      onePluginFits,
      localReferencesFit,
      workspaceContentsFit,
      hostedReaderAcceptsIntentPlugin,
    ])
      expect(typeof bind).toBe('function')
  })
})
