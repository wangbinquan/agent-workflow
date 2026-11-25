// RFC-561 — 两个跨 context 的聚合读用自己的端口点名来源：系统总览与 Intent 平台清单（RFC-294 S9 第十六步）。
//
// 锁五件事：
// ① system-operations 的生产文件取别的业务 context 的，只剩 identity-access 的 authority 类型入口与 `composition.ts` 取 source-control 的
//    备份准备参与者（留给后续）；总览聚合不再取任何 context（判据带负对照）。
// ② intent 的生产文件不取 development-automation 与 digital-employee 的任何文件（同一判据）。
// ③ 两份端口（system-operations 的 `systemOverviewSources.ts`、intent 的 `platformInventorySources.ts`）只取 shared、identity-access 的
//    public 与本模块。
// ④ 编译期断言：七个 owner 交出的对象可以赋给这些端口（bootstrap 交的就是它们）。
// ⑤ 失去模块外读者的类型撤出了各自的 public；integration 空出来的 `public/queries.ts` 已删除。
//
// 覆盖范围（C12）：① ② 覆盖 system-operations 与 intent 的全部源码；③ ⑤ 只读点名的文件；④ 由 `tsc` 检查。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { DevelopmentConfigOperations } from '../src/modules/development-automation/application/configOperations'
import type { DigitalEmployeePlatformInventoryParticipant } from '../src/modules/digital-employee/application/ports/platformInventory'
import type { IntegrationOverviewQueries } from '../src/modules/integration/application/ports/scheduledTaskPersistence'
import type {
  IntentDevelopmentConfigInventoryQueries,
  IntentDigitalEmployeeInventoryQueries,
} from '../src/modules/intent/application/ports/platformInventorySources'
import type { MemoryCatalogOperations } from '../src/modules/memory/public/operations'
import type { ResourceCatalogOverviewQuery } from '../src/modules/resource-catalog/application/resourceCatalogOverview'
import type { RepositoryWorkspaceOperations } from '../src/modules/source-control/composition'
import type {
  SystemOverviewMemorySource,
  SystemOverviewRepositorySource,
  SystemOverviewResourceSource,
  SystemOverviewScheduledTaskSource,
  SystemOverviewTaskSource,
} from '../src/modules/system-operations/application/ports/systemOverviewSources'
import type { TaskOverviewQuery } from '../src/modules/task-execution/application/ports/taskOverviewQuery'

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

interface ModuleSpecifier {
  readonly text: string
  readonly typeOnly: boolean
}

/** Module specifiers of imports, re-exports, dynamic imports and `import('…')` types, each with whether it is type-only. */
function moduleSpecifiers(path: string, text: string): ModuleSpecifier[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: ModuleSpecifier[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      out.push({
        text: node.moduleSpecifier.text,
        typeOnly:
          clause?.isTypeOnly === true ||
          (clause !== undefined &&
            clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)),
      })
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      out.push({ text: node.moduleSpecifier.text, typeOnly: node.isTypeOnly })
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      out.push({ text: node.arguments[0].text, typeOnly: false })
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      out.push({ text: node.argument.literal.text, typeOnly: true })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Edges from a file of `context` into another module, as `<other context>/<rest> (<type|value>)`. */
function foreignModuleEdges(context: string, path: string, text: string): string[] {
  return moduleSpecifiers(path, text).flatMap((specifier) => {
    const target = specifier.text.startsWith('@/')
      ? join(SRC, specifier.text.slice(2))
      : specifier.text.startsWith('.')
        ? resolve(dirname(path), specifier.text)
        : null
    if (target === null) return []
    const match = /^([a-z-]+)\/(.+)$/.exec(slash(relative(MODULES, target)))
    if (match === null || match[1] === context) return []
    return [`${match[1]}/${match[2]} (${specifier.typeOnly ? 'type' : 'value'})`]
  })
}

/** The identity-access authority edge every context may take: a type-only import of its public participants or types. */
const isAuthorityEdge = (edge: string) =>
  /^identity-access\/public\/(participants|types) \(type\)$/.test(edge)

function contextEdges(context: string, files: readonly string[]): string[] {
  const root = join(MODULES, context)
  return [
    ...new Set(
      files.flatMap((path) =>
        foreignModuleEdges(context, path, readFileSync(path, 'utf8')).map(
          (edge) => `${slash(relative(root, path))} -> ${edge}`,
        ),
      ),
    ),
  ].sort()
}

// Compile-time: what each owner hands over satisfies the aggregate's own port.
const resourceSource = (query: ResourceCatalogOverviewQuery): SystemOverviewResourceSource => query
const repositorySource = (
  queries: RepositoryWorkspaceOperations['overviewQueries'],
): SystemOverviewRepositorySource => queries
const scheduledTaskSource = (
  queries: IntegrationOverviewQueries,
): SystemOverviewScheduledTaskSource => queries
const memorySource = (catalog: MemoryCatalogOperations): SystemOverviewMemorySource => catalog
const taskSource = (query: TaskOverviewQuery): SystemOverviewTaskSource => query
const developmentConfigSource = (
  operations: DevelopmentConfigOperations,
): IntentDevelopmentConfigInventoryQueries => operations
const digitalEmployeeSource = (
  participant: DigitalEmployeePlatformInventoryParticipant,
): IntentDigitalEmployeeInventoryQueries => participant

describe('RFC-561 —— 两个聚合读不取来源 context', () => {
  test('system-operations 取别的业务 context 的只剩 composition.ts 的备份准备参与者（authority 类型入口除外）', () => {
    const files = walk(join(MODULES, 'system-operations'))
    expect(files.length).toBeGreaterThanOrEqual(150)
    const edges = contextEdges('system-operations', files)
    const authority = edges.filter((edge) => isAuthorityEdge(edge.split(' -> ')[1]!))
    expect(authority.length).toBeGreaterThan(0)
    expect(edges.filter((edge) => !authority.includes(edge))).toEqual([
      'composition.ts -> source-control/public/participants (type)',
    ])
  }, 60_000)

  test('intent 的全部源码不取 development-automation 与 digital-employee', () => {
    const files = walk(join(MODULES, 'intent'))
    expect(files.length).toBeGreaterThanOrEqual(80)
    const edges = contextEdges('intent', files)
    expect(edges.length).toBeGreaterThan(0)
    expect(
      edges.filter((edge) => /-> (development-automation|digital-employee)\//.test(edge)),
    ).toEqual([])
  }, 60_000)

  test('负对照：public、内部文件、转出、相对路径与动态 import 都会被认出，本模块与包不算', () => {
    const at = join(MODULES, 'intent', 'application', 'probe.ts')
    const found = foreignModuleEdges(
      'intent',
      at,
      "import type { A } from '@/modules/development-automation/public/operations'\n" +
        "import { type B } from '@/modules/digital-employee/public/participants'\n" +
        "import { c } from '@/modules/digital-employee/composition'\n" +
        "export type { D } from '../../development-automation/application/configOperations'\n" +
        "const e = () => import('@/modules/digital-employee/application/ports/platformInventory')\n" +
        "type K = import('@/modules/development-automation/public/types').DevelopmentPurpose\n" +
        "import type { F } from '@/modules/identity-access/public/participants'\n" +
        "import { g } from '@/modules/identity-access/public/participants'\n" +
        "import type { H } from './ports/platformInventorySources'\n" +
        "import type { I } from '@/modules/intent/public/types'\n" +
        "import type { J } from '@agent-workflow/shared'\n",
    )
    expect(found).toEqual([
      'development-automation/public/operations (type)',
      'digital-employee/public/participants (type)',
      'digital-employee/composition (value)',
      'development-automation/application/configOperations (type)',
      'digital-employee/application/ports/platformInventory (value)',
      'development-automation/public/types (type)',
      'identity-access/public/participants (type)',
      'identity-access/public/participants (value)',
    ])
    expect(found.filter((edge) => !isAuthorityEdge(edge))).toHaveLength(7)
  })
})

describe('RFC-561 —— 端口归聚合方', () => {
  test('两份端口只取 shared、identity-access 的 public 与本模块', () => {
    for (const [context, path] of [
      ['system-operations', 'system-operations/application/ports/systemOverviewSources.ts'],
      ['intent', 'intent/application/ports/platformInventorySources.ts'],
    ] as const) {
      const file = join(MODULES, path)
      const specifiers = moduleSpecifiers(file, read(path))
      expect(specifiers.length).toBeGreaterThan(0)
      expect(specifiers.every((specifier) => specifier.typeOnly)).toBe(true)
      expect(
        foreignModuleEdges(context, file, read(path)).filter((edge) => !isAuthorityEdge(edge)),
      ).toEqual([])
      expect(
        specifiers
          .map((specifier) => specifier.text)
          .filter((text) => !text.startsWith('.') && !text.startsWith('@/modules/')),
      ).toEqual(context === 'system-operations' ? ['@agent-workflow/shared'] : [])
    }
  })

  test('两个聚合从自己的端口取来源类型', () => {
    // RFC-576: the same import also brings `SystemOverviewAuthority`, which moved into that port with the overview route.
    expect(read('system-operations/application/overview.ts')).toMatch(
      /import type \{[^}]*\bSystemOverviewSources\b[^}]*\} from '\.\/ports\/systemOverviewSources'/,
    )
    expect(read('intent/application/platformInventoryParticipant.ts')).toContain(
      "} from './ports/platformInventorySources'",
    )
  })

  test('owner 交出的对象满足端口（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      resourceSource,
      repositorySource,
      scheduledTaskSource,
      memorySource,
      taskSource,
      developmentConfigSource,
      digitalEmployeeSource,
    ])
      expect(typeof bind).toBe('function')
  })
})

describe('RFC-561 —— 失去模块外读者的类型撤出 public', () => {
  test('四个来源 context 与 digital-employee 的 public 不再声明这些类型', () => {
    for (const [path, names] of [
      [
        'resource-catalog/public/queries.ts',
        ['ResourceCatalogOverviewQuery', 'ResourceCatalogOverviewCounts'],
      ],
      ['source-control/public/queries.ts', ['RepositoryOverviewQueries']],
      ['task-execution/public/queries.ts', ['TaskOverviewQuery']],
      [
        'digital-employee/public/participants.ts',
        [
          'DigitalEmployeePlatformInventoryParticipant',
          'DigitalEmployeePlatformInventoryResourceType',
          'DigitalEmployeePlatformInventoryRow',
        ],
      ],
    ] as const) {
      const text = read(path)
      expect(text.length).toBeGreaterThan(0)
      for (const name of names)
        expect([path, name, text.includes(name)]).toEqual([path, name, false])
    }
  })

  test('integration 空出来的 public/queries.ts 已删除；类型留在各自模块里', () => {
    expect(existsSync(join(MODULES, 'integration/public/queries.ts'))).toBe(false)
    expect(read('integration/application/ports/scheduledTaskPersistence.ts')).toContain(
      'export interface IntegrationOverviewQueries',
    )
    expect(read('resource-catalog/application/resourceCatalogOverview.ts')).toContain(
      'export interface ResourceCatalogOverviewQuery',
    )
    expect(read('task-execution/application/ports/taskOverviewQuery.ts')).toContain(
      'export interface TaskOverviewQuery',
    )
    expect(read('digital-employee/application/ports/platformInventory.ts')).toContain(
      'export interface DigitalEmployeePlatformInventoryParticipant',
    )
  })
})
