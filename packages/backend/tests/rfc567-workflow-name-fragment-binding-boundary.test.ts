// RFC-567 — 工作流名片段撤出 resource-catalog 的 public，由 bootstrap 交给 task-execution 的任务读模型（RFC-294 S9 第二十二步）。
//
// 为什么存在：RFC-294 plan S9 的退出门点名四个 SQL 片段“不再从任何 `public/*` 导出”。前三个（task-execution 的 `nodeRunStatusCondition`、
// `taskGateOpenCondition`、`taskGateVisibleCondition`）由 RFC-483 撤出；最后一个是 resource-catalog 的 `workflowNameExpression`——签名带着持久化
// 句柄与 drizzle 类型，task-execution 的五处读模型把它拼进自己的任务行语句。RFC-567 把它撤出 public，由装配根交出、bootstrap 交入。锁四件事：
// ① 全部模块的 public 文件不导出这四个片段（带正对照）；resource-catalog 的装配根交出 `workflowNameExpression`。
// ② 全部模块的源码不从 resource-catalog 取它——不论经 public、装配根还是内部文件（判据带负对照）。
// ③ task-execution 的五处读模型用入参里的片段；bootstrap 从 resource-catalog 的装配根取并交入，交给 collaboration 的徽标条件用它绑定。
// ④ 编译期断言：resource-catalog 的实现就是 task-execution 声明的片段类型，各入参收得下它；绑定后的徽标条件就是 collaboration 的绑定里那一格。
//
// 覆盖范围（C12）：① 覆盖全部模块的 public 文件；② 覆盖全部模块的源码；③ 只读点名的文件；④ 由 `tsc` 检查。片段与绑定后条件的行为由
// `rfc395-a7-owner-queries` 覆盖（两种数据库）；五处读模型的结果由既有的列表页对拍、任务列表路由、WS 投影与徽标计数用例覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { TaskExecutionParticipantBindings } from '../src/modules/collaboration/infrastructure/taskExecutionParticipantBindings'
import type { workflowNameExpression } from '../src/modules/resource-catalog/infrastructure/executionResourceQueries'
import type { TaskExecutionProviderRuntimeDependencies } from '../src/modules/task-execution/composition/providerRuntime'
import type { composeTaskExecutionCatalogSources } from '../src/modules/task-execution/infrastructure/taskCatalogSources'
import type { bindTaskGateOpenCondition } from '../src/modules/task-execution/infrastructure/taskGateQueries'
import type { createDatabaseTaskLifecycleWsProjection } from '../src/modules/task-execution/infrastructure/taskLifecycleWsProjection'
import type { createDatabaseTaskListPage } from '../src/modules/task-execution/infrastructure/taskListPage'
import type { WorkflowNameExpression } from '../src/modules/task-execution/infrastructure/taskRepositorySql'
import type { TaskRouteOperationsDependencies } from '../src/modules/task-execution/infrastructure/taskRouteOperations'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const OWNER = 'resource-catalog'
const FRAGMENT = 'workflowNameExpression'
/** The four SQL fragments the S9 exit gate names (RFC-294 plan). */
const S9_FRAGMENTS = [
  'nodeRunStatusCondition',
  'taskGateOpenCondition',
  'taskGateVisibleCondition',
  FRAGMENT,
]
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Names a file exports: declarations with `export`, and `export { … }` lists (with or without a source). */
function exportedNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      return statement.exportClause.elements.map((element) => element.name.text)
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    if (!exported) return []
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
      )
    return (ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
      ? [statement.name.text]
      : []
  })
}

/**
 * Where a file takes the fragment from resource-catalog, as `<rest>`: named imports, re-exports and `import('…').Name`
 * types whose module resolves into the owner's directory.
 */
function fragmentTakes(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string, name: string) => {
    if (name !== FRAGMENT) return
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(path), specifier)
        : null
    if (target === null) return
    const rest = new RegExp(`^${OWNER}/(.+)$`).exec(slash(relative(MODULES, target)))?.[1]
    if (rest !== undefined) out.push(rest)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          add(node.moduleSpecifier.text, (element.propertyName ?? element.name).text)
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    )
      for (const element of node.exportClause.elements)
        add(node.moduleSpecifier.text, (element.propertyName ?? element.name).text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal) &&
      node.qualifier !== undefined
    )
      add(
        node.argument.literal.text,
        ts.isIdentifier(node.qualifier) ? node.qualifier.text : node.qualifier.right.text,
      )
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function namesImportedFrom(path: string, specifier: string): string[] {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== specifier
    )
      return []
    const bindings = statement.importClause?.namedBindings
    return bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
      : []
  })
}

// Compile-time: Resource Catalog's implementation is the fragment type Task Execution declares, every input takes it, and
// the bound gate-open condition is the member collaboration's bindings read.
type OwnerFragment = typeof workflowNameExpression
const ownerFragmentIsTheDeclaredType = (fragment: OwnerFragment): WorkflowNameExpression => fragment
const declaredTypeIsTheOwnerFragment = (fragment: WorkflowNameExpression): OwnerFragment => fragment
const providerRuntimeTakesIt = (
  fragment: OwnerFragment,
): TaskExecutionProviderRuntimeDependencies['workflowName'] => fragment
const routeOperationsTakeIt = (
  fragment: OwnerFragment,
): TaskRouteOperationsDependencies['workflowName'] => fragment
const listPageTakesIt = (
  fragment: OwnerFragment,
): Parameters<typeof createDatabaseTaskListPage>[2] => fragment
const catalogSourcesTakeIt = (
  fragment: OwnerFragment,
): Parameters<typeof composeTaskExecutionCatalogSources>[2] => fragment
const lifecycleProjectionTakesIt = (
  fragment: OwnerFragment,
): Parameters<typeof createDatabaseTaskLifecycleWsProjection>[1] => fragment
const gateConditionBinderTakesIt = (
  fragment: OwnerFragment,
): Parameters<typeof bindTaskGateOpenCondition>[0] => fragment
const boundConditionIsCollaborationsMember = (
  condition: ReturnType<typeof bindTaskGateOpenCondition>,
): TaskExecutionParticipantBindings['taskGateOpenCondition'] => condition

describe('RFC-567 —— S9 退出门点名的四个 SQL 片段不从任何 public 导出', () => {
  test('全部模块的 public 文件不导出它们；resource-catalog 的装配根交出工作流名片段', () => {
    const files = readdirSync(MODULES).flatMap((name) => walk(join(MODULES, name, 'public')))
    expect(files.length).toBeGreaterThanOrEqual(55)
    expect(
      files.flatMap((path) =>
        exportedNames(path, readFileSync(path, 'utf8'))
          .filter((name) => S9_FRAGMENTS.includes(name))
          .map((name) => `${slash(relative(MODULES, path))}#${name}`),
      ),
    ).toEqual([])
    const composition = `modules/${OWNER}/composition.ts`
    expect(exportedNames(composition, read(composition))).toContain(FRAGMENT)
  })

  test('正对照：同一读法看得见 resource-catalog 的 public 仍交出的查询工厂与闭合读类型', () => {
    const path = `modules/${OWNER}/public/queries.ts`
    const kept = exportedNames(path, read(path))
    for (const name of [
      'createAgentExecutionQueries',
      'createWorkflowExecutionQueries',
      'AgentExecutionQueries',
      'WorkflowExecutionQueries',
    ])
      expect([name, kept.includes(name)]).toEqual([name, true])
  })
})

describe('RFC-567 —— 模块之间不再取这个片段', () => {
  test('全部模块的源码不从 resource-catalog 取它（owner 自己除外）', () => {
    const files = walk(MODULES)
    expect(files.length).toBeGreaterThanOrEqual(2500)
    expect(
      files.flatMap((path) => {
        const from = slash(relative(MODULES, path))
        if (from.startsWith(`${OWNER}/`)) return []
        return fragmentTakes(path, readFileSync(path, 'utf8')).map((rest) => `${from} <- ${rest}`)
      }),
    ).toEqual([])
  }, 120_000)

  test('负对照：经 public、装配根、内部文件、转出、相对路径与 import 类型取都会被认出；别的名字与别的模块不算', () => {
    const at = join(MODULES, 'task-execution', 'infrastructure', 'probe.ts')
    expect(
      fragmentTakes(
        at,
        "import { workflowNameExpression } from '@/modules/resource-catalog/public/queries'\n" +
          "import { workflowNameExpression as name } from '@/modules/resource-catalog/composition'\n" +
          "import { workflowNameExpression } from '../../resource-catalog/infrastructure/executionResourceQueries'\n" +
          "export { workflowNameExpression } from '@/modules/resource-catalog/infrastructure/executionResourceQueries'\n" +
          "type F = import('@/modules/resource-catalog/public/queries').workflowNameExpression\n" +
          "import { createWorkflowExecutionQueries } from '@/modules/resource-catalog/public/queries'\n" +
          "import { workflowNameExpression } from '@/modules/source-control/composition'\n" +
          "import type { WorkflowNameExpression } from './taskRepositorySql'\n",
      ),
    ).toEqual([
      'public/queries',
      'composition',
      'infrastructure/executionResourceQueries',
      'infrastructure/executionResourceQueries',
      'public/queries',
    ])
  })
})

describe('RFC-567 —— 片段经入参到达 task-execution 的读模型', () => {
  test('五处读模型用入参里的片段，不再点名 resource-catalog 的函数', () => {
    const TE = 'modules/task-execution/infrastructure/'
    const expected: ReadonlyArray<readonly [string, string, number]> = [
      [`${TE}taskListPage/query.ts`, 'workflowName(db, sql`t.workflow_id`)', 3],
      [`${TE}taskListPage/filters.ts`, "workflowName(db, col('workflow_id')),", 1],
      [`${TE}taskRouteOperations.ts`, 'workflowName(db, taskReadColumns(db).workflowId),', 1],
      [
        `${TE}taskLifecycleWsProjection.ts`,
        'workflowName: workflowName(db, taskReadColumns(db).workflowId),',
        1,
      ],
      [`${TE}taskGateQueries.ts`, 'workflowName(db, taskReadColumns(db).workflowId),', 1],
    ]
    for (const [path, fragment, count] of expected) {
      const text = read(path)
      expect([path, fragment, text.split(fragment).length - 1]).toEqual([path, fragment, count])
      expect([path, text.includes(FRAGMENT)]).toEqual([path, false])
    }
    expect(read(`${TE}taskRepositorySql.ts`)).toContain('export type WorkflowNameExpression = (')
    expect(read(`${TE}taskGateQueries.ts`)).toContain('export function bindTaskGateOpenCondition(')
  })

  test('bootstrap 从 resource-catalog 的装配根取片段并交入', () => {
    const composition = `@/modules/${OWNER}/composition`
    const sites: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        'bootstrap/daemonModules/taskExecution.ts',
        ['    workflowName: workflowNameExpression,', '      workflowNameExpression,'],
      ],
      [
        'bootstrap/crossContextClosure.ts',
        ['    taskGateOpenCondition: bindTaskGateOpenCondition(workflowNameExpression),'],
      ],
    ]
    for (const [path, lines] of sites) {
      expect([path, namesImportedFrom(path, composition).includes(FRAGMENT)]).toEqual([path, true])
      const present = read(path).split('\n')
      for (const line of lines)
        expect([path, line, present.includes(line)]).toEqual([path, line, true])
    }
  })

  test('片段与各入参的类型对得上（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      ownerFragmentIsTheDeclaredType,
      declaredTypeIsTheOwnerFragment,
      providerRuntimeTakesIt,
      routeOperationsTakeIt,
      listPageTakesIt,
      catalogSourcesTakeIt,
      lifecycleProjectionTakesIt,
      gateConditionBinderTakesIt,
      boundConditionIsCollaborationsMember,
    ])
      expect(typeof bind).toBe('function')
  })
})
