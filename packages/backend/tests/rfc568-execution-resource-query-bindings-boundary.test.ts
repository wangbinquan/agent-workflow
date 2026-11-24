// RFC-568 — resource-catalog 的两个执行资源查询工厂撤出 public，由 bootstrap 交给消费方（RFC-294 S9 第二十三步）。
//
// 为什么存在：`createAgentExecutionQueries(db)` 与 `createWorkflowExecutionQueries(db)` 原先从 resource-catalog 的 public 交出，入参是持久化句柄
// （public 合同不该带它）。读它们的是 task-execution 的七处、intent 与 knowledge-evolution 各一处。RFC-568 把工厂撤出 public，改由 bootstrap
// 从 resource-catalog 的装配根取、作为工厂引用交入——每个调用点照旧把自己手里的句柄传进去，事务里的读仍在事务里。锁四件事：
// ① resource-catalog 的 public 文件不导出两个工厂（带正对照）；装配根交出它们。
// ② 全部模块的源码不从 resource-catalog 取它们——不论经 public、装配根还是内部文件（判据带负对照；owner 自己除外）。
// ③ 九处消费方用入参里的工厂，传的还是原来那个句柄（两处事务句柄逐字钉住）；应用层的动作执行器只经执行环境读脚本定义；bootstrap 从装配根取。
// ④ 编译期断言：owner 的工厂交得进每个消费方声明的入参；绑定后的任务主体查询工厂就是 collaboration 的绑定里那一格。
//
// 覆盖范围（C12）：② 覆盖全部模块的源码；① ③ 只读点名的文件；④ 由 `tsc` 检查。动作执行环境新增的那一个读（脚本定义）在这里有行为用例；两个
// 工厂的结果由 `rfc395-a7-owner-queries` 覆盖（两种数据库），九处消费方的结果由既有用例覆盖。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { TaskExecutionParticipantBindings } from '../src/modules/collaboration/infrastructure/taskExecutionParticipantBindings'
import type { IntentAgentQueriesFactory } from '../src/modules/intent/infrastructure/intentSqlPersistence'
import type { FusionWorkflowQueriesFactory } from '../src/modules/knowledge-evolution/infrastructure/fusionRepository'
import type {
  createAgentExecutionQueries,
  createWorkflowExecutionQueries,
} from '../src/modules/resource-catalog/infrastructure/executionResourceQueries'
import {
  createActionExecutionEnvironment,
  type ActionExecutionEnvironmentDependencies,
} from '../src/modules/task-execution/composition/actionExecutionEnvironment'
import type { TaskExecutionProviderRuntimeDependencies } from '../src/modules/task-execution/composition/providerRuntime'
import type { bindTaskSubjectQueries } from '../src/modules/task-execution/composition/taskSubjectQueries'
import type { ChildExecutionLaunchDependencies } from '../src/modules/task-execution/infrastructure/childExecutionLaunchOperations'
import type { DeferredRepositoryPreparationDependencies } from '../src/modules/task-execution/infrastructure/deferredRepositoryPreparation'
import type {
  AgentExecutionQueriesFactory,
  WorkflowExecutionQueriesFactory,
} from '../src/modules/task-execution/infrastructure/executionResourceReads'
import type { TaskRouteOperationsDependencies } from '../src/modules/task-execution/infrastructure/taskRouteOperations'
import type { WorkgroupTurnsDependencies } from '../src/modules/task-execution/infrastructure/workgroupTurnsPersistence'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const OWNER = 'resource-catalog'
const AGENTS = 'createAgentExecutionQueries'
const WORKFLOWS = 'createWorkflowExecutionQueries'
const FACTORIES = [AGENTS, WORKFLOWS]
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
 * The factories a file takes from resource-catalog, as `<name> <- <rest>`: named imports, re-exports and
 * `import('…').Name` types whose module resolves into the owner's directory.
 */
function factoryTakes(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string, name: string) => {
    if (!FACTORIES.includes(name)) return
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(path), specifier)
        : null
    if (target === null) return
    const rest = new RegExp(`^${OWNER}/(.+)$`).exec(slash(relative(MODULES, target)))?.[1]
    if (rest !== undefined) out.push(`${name} <- ${rest}`)
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

// Compile-time: Resource Catalog's factories reach every input the consumers declare.
type OwnerAgents = typeof createAgentExecutionQueries
type OwnerWorkflows = typeof createWorkflowExecutionQueries
const agentsAreTheDeclaredFactory = (factory: OwnerAgents): AgentExecutionQueriesFactory => factory
const workflowsAreTheDeclaredFactory = (factory: OwnerWorkflows): WorkflowExecutionQueriesFactory =>
  factory
const routeOperationsTakeWorkflows = (
  factory: OwnerWorkflows,
): TaskRouteOperationsDependencies['createWorkflowExecutionQueries'] => factory
const providerRuntimeTakesWorkflows = (
  factory: OwnerWorkflows,
): TaskExecutionProviderRuntimeDependencies['createWorkflowExecutionQueries'] => factory
const childLaunchTakesWorkflows = (
  factory: OwnerWorkflows,
): ChildExecutionLaunchDependencies['createWorkflowExecutionQueries'] => factory
const deferredPreparationTakesWorkflows = (
  factory: OwnerWorkflows,
): DeferredRepositoryPreparationDependencies['createWorkflowExecutionQueries'] => factory
const actionEnvironmentTakesWorkflows = (
  factory: OwnerWorkflows,
): ActionExecutionEnvironmentDependencies['createWorkflowExecutionQueries'] => factory
const workgroupTurnsTakeAgents = (
  factory: OwnerAgents,
): WorkgroupTurnsDependencies['createAgentExecutionQueries'] => factory
const intentTakesAgents = (factory: OwnerAgents): IntentAgentQueriesFactory => factory
const fusionTakesWorkflows = (factory: OwnerWorkflows): FusionWorkflowQueriesFactory => factory
const boundSubjectQueriesAreCollaborationsMember = (
  bound: ReturnType<typeof bindTaskSubjectQueries>,
): TaskExecutionParticipantBindings['createTaskSubjectQueries'] => bound

describe('RFC-568 —— 两个查询工厂撤出 resource-catalog 的 public', () => {
  test('public 文件不导出它们，装配根交出', () => {
    const files = walk(join(MODULES, OWNER, 'public'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    const exported = files.flatMap((path) => exportedNames(path, readFileSync(path, 'utf8')))
    expect(exported.filter((name) => FACTORIES.includes(name))).toEqual([])
    const composition = `modules/${OWNER}/composition.ts`
    const handed = exportedNames(composition, read(composition))
    for (const name of FACTORIES) expect([name, handed.includes(name)]).toEqual([name, true])
  })

  test('正对照：同一读法看得见仍留在 public 的闭合读类型', () => {
    const path = `modules/${OWNER}/public/queries.ts`
    const kept = exportedNames(path, read(path))
    for (const name of ['AgentExecutionQueries', 'WorkflowExecutionQueries'])
      expect([name, kept.includes(name)]).toEqual([name, true])
  })
})

describe('RFC-568 —— 模块之间不再取这两个工厂', () => {
  test('全部模块的源码不从 resource-catalog 取它们（owner 自己除外）', () => {
    const files = walk(MODULES)
    expect(files.length).toBeGreaterThanOrEqual(2500)
    expect(
      files.flatMap((path) => {
        const from = slash(relative(MODULES, path))
        if (from.startsWith(`${OWNER}/`)) return []
        return factoryTakes(path, readFileSync(path, 'utf8')).map((take) => `${from}: ${take}`)
      }),
    ).toEqual([])
  }, 120_000)

  test('负对照：经 public、装配根、内部文件、转出、相对路径与 import 类型取都会被认出；别的名字与别的模块不算', () => {
    const at = join(MODULES, 'task-execution', 'infrastructure', 'probe.ts')
    expect(
      factoryTakes(
        at,
        "import { createAgentExecutionQueries } from '@/modules/resource-catalog/public/queries'\n" +
          "import { createWorkflowExecutionQueries as workflows } from '@/modules/resource-catalog/composition'\n" +
          "import { createAgentExecutionQueries } from '../../resource-catalog/infrastructure/executionResourceQueries'\n" +
          "export { createWorkflowExecutionQueries } from '@/modules/resource-catalog/infrastructure/executionResourceQueries'\n" +
          "type F = import('@/modules/resource-catalog/public/queries').createAgentExecutionQueries\n" +
          "import type { WorkflowExecutionQueries } from '@/modules/resource-catalog/public/queries'\n" +
          "import { createWorkflowExecutionQueries } from '@/modules/source-control/composition'\n" +
          "import type { WorkflowExecutionQueriesFactory } from './executionResourceReads'\n",
      ),
    ).toEqual([
      'createAgentExecutionQueries <- public/queries',
      'createWorkflowExecutionQueries <- composition',
      'createAgentExecutionQueries <- infrastructure/executionResourceQueries',
      'createWorkflowExecutionQueries <- infrastructure/executionResourceQueries',
      'createAgentExecutionQueries <- public/queries',
    ])
  })
})

describe('RFC-568 —— 工厂经入参到达消费方，调用点传的还是原来的句柄', () => {
  test('九处消费方用入参里的工厂；两处事务里的读仍传事务句柄', () => {
    const TE = 'modules/task-execution/'
    const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        `${TE}infrastructure/taskRouteOperations.ts`,
        [
          '    .createWorkflowExecutionQueries(source.db)',
          '      .createWorkflowExecutionQueries(dependencies.db)',
        ],
      ],
      [
        `${TE}infrastructure/fusionEngineTaskOperations.ts`,
        ['    .createWorkflowExecutionQueries(dependencies.db)'],
      ],
      [
        `${TE}infrastructure/childExecutionLaunchOperations.ts`,
        ['          .createWorkflowExecutionQueries(tx)'],
      ],
      [
        `${TE}infrastructure/taskSubjectQueries.ts`,
        ['          : await this.createWorkflowExecutionQueries(this.db).summaries(workflowIds)'],
      ],
      [
        `${TE}infrastructure/workgroupTurnsPersistence.ts`,
        [
          '  const hydratedAgents = await createAgentExecutionQueries(transaction).readMany(agentIds)',
          '            dependencies.createAgentExecutionQueries,',
        ],
      ],
      [
        `${TE}infrastructure/dynamicWorkflowPersistence.ts`,
        ['    return this.createAgentExecutionQueries(this.db).read(agentId)'],
      ],
      [
        `${TE}composition/actionExecutionEnvironment.ts`,
        [
          '      (await deps.createWorkflowExecutionQueries(deps.db).documents([workflowId], true))[0]',
        ],
      ],
      [
        'modules/intent/infrastructure/intentSqlPersistence.ts',
        ['    return this.createAgentExecutionQueries(this.database).portNames(ids)'],
      ],
      [
        'modules/knowledge-evolution/infrastructure/fusionRepository.ts',
        ['        .createWorkflowExecutionQueries(db)'],
      ],
    ]
    for (const [path, lines] of expected) {
      const present = read(path).split('\n')
      for (const line of lines)
        expect([path, line, present.includes(line)]).toEqual([path, line, true])
    }
  })

  test('应用层的动作执行器只经执行环境读脚本定义，不碰工厂', () => {
    const runners = read('modules/task-execution/application/actionExecutionRunners.ts')
    expect(runners).toContain(
      'const storedDefinition = await env.catalogWorkflowDefinition(parsedRef.workflowId)',
    )
    expect(FACTORIES.filter((name) => runners.includes(name))).toEqual([])
    expect(read('modules/task-execution/application/ports/actionExecution.ts')).toContain(
      'catalogWorkflowDefinition(workflowId: string): Promise<string | null>',
    )
  })

  test('执行环境的脚本定义读：只取目录里的工作流、建在环境自己的句柄上、取第一行的定义，没有则为 null', async () => {
    const DB = { handle: 'environment' }
    const calls: unknown[] = []
    let rows: readonly { readonly definition: string }[] = []
    const dependencies = {
      db: DB,
      createWorkflowExecutionQueries: (db: unknown) => ({
        documents: async (ids: readonly string[], catalogOnly?: boolean) => {
          calls.push([db, ids, catalogOnly])
          return rows
        },
      }),
      agents: { get: async () => null },
      readModels: { executionOutcome: {}, statusProjection: {} },
      terminalWatch: { watch: async () => undefined },
    } as unknown as ActionExecutionEnvironmentDependencies
    const environment = createActionExecutionEnvironment(dependencies)
    // Nothing is read while the environment is built.
    expect(calls).toEqual([])
    expect(await environment.catalogWorkflowDefinition('workflow-1')).toBeNull()
    rows = [{ definition: '{"nodes":[]}' }, { definition: 'second' }]
    expect(await environment.catalogWorkflowDefinition('workflow-2')).toBe('{"nodes":[]}')
    rows = [{ definition: '' }]
    expect(await environment.catalogWorkflowDefinition('workflow-3')).toBe('')
    expect(calls).toEqual([
      [DB, ['workflow-1'], true],
      [DB, ['workflow-2'], true],
      [DB, ['workflow-3'], true],
    ])
  })

  test('bootstrap 从 resource-catalog 的装配根取工厂并交入', () => {
    const composition = `@/modules/${OWNER}/composition`
    const sites: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
      [
        'bootstrap/daemonModules/taskExecution.ts',
        [AGENTS, WORKFLOWS],
        [
          '    createWorkflowExecutionQueries,',
          '        createAgentExecutionQueries,',
          '        persistence: composeDynamicWorkflowPersistence(db, createAgentExecutionQueries),',
        ],
      ],
      [
        'bootstrap/daemonModules/developmentAutomation.ts',
        [WORKFLOWS],
        ['      createWorkflowExecutionQueries,'],
      ],
      [
        'bootstrap/crossContextClosure.ts',
        [WORKFLOWS],
        ['    createTaskSubjectQueries: bindTaskSubjectQueries(createWorkflowExecutionQueries),'],
      ],
      ['bootstrap/daemonModules/intent.ts', [AGENTS], ['    createAgentExecutionQueries,']],
      ['bootstrap/maintenanceWorkerGraph.ts', [AGENTS], ['    createAgentExecutionQueries,']],
      ['bootstrap/daemonModules/fusion.ts', [WORKFLOWS], ['    createWorkflowExecutionQueries,']],
      [
        'bootstrap/daemonHttpComposition.ts',
        [AGENTS],
        ['    createAgentExecutionQueries(input.db),'],
      ],
    ]
    for (const [path, names, lines] of sites) {
      const imported = namesImportedFrom(path, composition)
      for (const name of names)
        expect([path, name, imported.includes(name)]).toEqual([path, name, true])
      const present = read(path).split('\n')
      for (const line of lines)
        expect([path, line, present.includes(line)]).toEqual([path, line, true])
    }
  })

  test('owner 的工厂交得进每个消费方的入参（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      agentsAreTheDeclaredFactory,
      workflowsAreTheDeclaredFactory,
      routeOperationsTakeWorkflows,
      providerRuntimeTakesWorkflows,
      childLaunchTakesWorkflows,
      deferredPreparationTakesWorkflows,
      actionEnvironmentTakesWorkflows,
      workgroupTurnsTakeAgents,
      intentTakesAgents,
      fusionTakesWorkflows,
      boundSubjectQueriesAreCollaborationsMember,
    ])
      expect(typeof bind).toBe('function')
  })
})
