// RFC-565 — 任务知识、触发与仓库身份的读由 bootstrap 交入：裸句柄的读撤出 task-execution 与 source-control 的 public（RFC-294 S9 第二十步）。
//
// 为什么存在：七个 owner 的读（`createTaskKnowledgeQueries`、`createTaskTriggerQueries`、`listNodeEventContents`、片段
// `nonTerminalTaskExists`；`existingRepositoryIds`、片段 `repositoryExistsExpression`、`readHostedWorkspaceOwnerForBusinessTask`）原先从
// public 交出，签名里带着持久化句柄与 drizzle 类型，消费方拿自己的句柄去造别的 context 的读。RFC-565 把它们撤出 public，改由 bootstrap 在根
// 句柄上建好后交入。锁四件事：
// ① 两个 owner 的 public 文件不再导出这些名字（带正对照）；装配根交出 bootstrap 要用的六个名字。
// ② 全部模块的源码不从别的 context 取这些名字——不论经 public、装配根还是内部文件（判据带负对照）。
// ③ 消费方的读来自构造入参；bootstrap 从两个装配根取实现、在根句柄上建好再交入；`TaskKnowledgeQueries` 的方法集合逐个钉住。
// ④ 编译期断言：owner 的实现交得进消费方的入参（任务知识读、触发读、两个片段、仓库身份读、托管工作区归属读）。
// ⑤ 这些读在装配期构造时不碰句柄（bootstrap 现在装配时就建好它们；此前消费方调用时才现造），句柄只在方法运行时用到。
//
// 覆盖范围（C12）：② 覆盖全部模块的源码；① ③ 只读点名的文件；④ 由 `tsc` 检查。读的行为由 `rfc395-a7-owner-queries`（两种数据库）覆盖，
// 消费方的行为由既有的记忆注入 / 蒸馏、Webhook 派发 / 投递 / 保留清理与托管恢复用例覆盖（本 RFC 只换“谁来构造”）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { WebhookDispatchTaskTriggers } from '../src/modules/integration/composition/webhookDispatch'
import type {
  createWebhookFireRetentionPhase,
  NonTerminalTaskExists,
} from '../src/modules/integration/infrastructure/retentionPhase'
import type { createWebhookTerminalWorkspaceAttributionQueries } from '../src/modules/integration/infrastructure/terminalWorkspaceAttribution'
import type { createWebhookDeliveryQueries } from '../src/modules/integration/infrastructure/webhookDeliveryQueries'
import type { MemoryDistillTaskKnowledge } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import type {
  MemoryInjectionTaskKnowledge,
  RepositoryIdentityReads,
} from '../src/modules/memory/infrastructure/memoryInjectionReadStore'
import { createHostedWorkspaceOwnerQueries } from '../src/modules/source-control/infrastructure/crewstation/workspaceOwnership'
import {
  createRepositoryIdentityQueries,
  repositoryExistsExpression,
} from '../src/modules/source-control/infrastructure/repositoryIdentityQueries'
import type { createHostedRecoverySelection } from '../src/modules/task-execution/infrastructure/crewstation/hostedRecoverySelection'
import type { nonTerminalTaskExists } from '../src/modules/task-execution/infrastructure/nonTerminalTaskExists'
import {
  createTaskKnowledgeQueries,
  type RepositoryExistsExpression,
} from '../src/modules/task-execution/infrastructure/taskKnowledgeQueries'
import { createTaskTriggerQueries } from '../src/modules/task-execution/infrastructure/taskTriggerQueries'

const SRC = resolve(import.meta.dir, '..', 'src')
const MODULES = join(SRC, 'modules')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

/** The reads that left the two owners' public, and the bound reads their compositions hand to bootstrap. */
const WITHDRAWN: Readonly<Record<string, readonly string[]>> = {
  'task-execution': [
    'createTaskKnowledgeQueries',
    'createTaskTriggerQueries',
    'listNodeEventContents',
    'nonTerminalTaskExists',
    'NodeEventContent',
  ],
  'source-control': [
    'existingRepositoryIds',
    'repositoryExistsExpression',
    'readHostedWorkspaceOwnerForBusinessTask',
  ],
}
const HANDED: Readonly<Record<string, readonly string[]>> = {
  'task-execution': [
    'createTaskKnowledgeQueries',
    'createTaskTriggerQueries',
    'nonTerminalTaskExists',
  ],
  'source-control': [
    'createRepositoryIdentityQueries',
    'repositoryExistsExpression',
    'createHostedWorkspaceOwnerQueries',
  ],
}
const OWNED = new Map(
  Object.keys(WITHDRAWN).flatMap((owner) =>
    [...WITHDRAWN[owner]!, ...HANDED[owner]!].map((name) => [name, owner] as const),
  ),
)

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
 * The owned names a file takes from another context, as `<name> <- <owner>/<rest>`: named imports, re-exports and
 * `import('…').Name` types whose module resolves into the owner's directory. `context` is the importing file's context.
 */
function foreignTakes(path: string, text: string, context: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string, name: string) => {
    const owner = OWNED.get(name)
    if (owner === undefined || owner === context) return
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(path), specifier)
        : null
    if (target === null) return
    const rest = new RegExp(`^${owner}/(.+)$`).exec(slash(relative(MODULES, target)))?.[1]
    if (rest !== undefined) out.push(`${name} <- ${owner}/${rest}`)
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

// Compile-time: what bootstrap takes from the two owners' compositions fits what the consumers declare as inputs.
type TaskKnowledge = ReturnType<typeof createTaskKnowledgeQueries>
type TaskTriggers = ReturnType<typeof createTaskTriggerQueries>
const knowledgeFitsInjection = (queries: TaskKnowledge): MemoryInjectionTaskKnowledge => queries
const knowledgeFitsDistillation = (queries: TaskKnowledge): MemoryDistillTaskKnowledge => queries
const repositoriesFit = (
  queries: ReturnType<typeof createRepositoryIdentityQueries>,
): RepositoryIdentityReads => queries
const repositoryFragmentFits = (
  fragment: typeof repositoryExistsExpression,
): RepositoryExistsExpression => fragment
const retentionFragmentFits = (fragment: typeof nonTerminalTaskExists): NonTerminalTaskExists =>
  fragment
const retentionPhaseTakesFragment = (
  fragment: typeof nonTerminalTaskExists,
): Parameters<typeof createWebhookFireRetentionPhase>[1] => fragment
const triggersFitDispatch = (queries: TaskTriggers): WebhookDispatchTaskTriggers => queries
const triggersFitDelivery = (
  queries: TaskTriggers,
): Parameters<typeof createWebhookDeliveryQueries>[1] => queries
const triggersFitAttribution = (
  queries: TaskTriggers,
): Parameters<typeof createWebhookTerminalWorkspaceAttributionQueries>[0] => queries
const workspaceOwnersFit = (
  queries: ReturnType<typeof createHostedWorkspaceOwnerQueries>,
): Parameters<typeof createHostedRecoverySelection>[0]['workspaceOwners'] => queries

describe('RFC-565 —— 裸句柄的读撤出两个 owner 的 public', () => {
  test('public 文件不导出这些名字，装配根交出 bootstrap 要用的名字', () => {
    for (const owner of Object.keys(WITHDRAWN)) {
      const files = walk(join(MODULES, owner, 'public'))
      expect(files.length).toBeGreaterThanOrEqual(5)
      const exported = files.flatMap((path) => exportedNames(path, readFileSync(path, 'utf8')))
      expect(exported.filter((name) => WITHDRAWN[owner]!.includes(name))).toEqual([])
      const composition = `modules/${owner}/composition.ts`
      const handed = exportedNames(composition, read(composition))
      for (const name of HANDED[owner]!)
        expect([owner, name, handed.includes(name)]).toEqual([owner, name, true])
    }
  })

  test('正对照：同一读法看得见仍留在 public 的闭合读类型与别的符号', () => {
    const queries = 'modules/task-execution/public/queries.ts'
    const kept = exportedNames(queries, read(queries))
    for (const name of [
      'TaskKnowledgeQueries',
      'TaskTriggerQueries',
      'TaskDistillationEvent',
      'TaskDistillationScope',
      'TaskTerminalWorkspace',
    ])
      expect([name, kept.includes(name)]).toEqual([name, true])
    const sourceControl = [
      ['modules/source-control/public/queries.ts', 'selectRepositoryWorkspaceReadQueries'],
      ['modules/source-control/public/participants.ts', 'hostedWorkspaceOwnerFromReference'],
    ] as const
    for (const [path, name] of sourceControl)
      expect([name, exportedNames(path, read(path)).includes(name)]).toEqual([name, true])
  })
})

describe('RFC-565 —— 模块之间不再互取这些读', () => {
  test('全部模块的源码不从别的 context 取这些名字', () => {
    const files = walk(MODULES)
    expect(files.length).toBeGreaterThanOrEqual(2500)
    expect(
      files.flatMap((path) => {
        const from = slash(relative(MODULES, path))
        return foreignTakes(path, readFileSync(path, 'utf8'), from.split('/')[0]!).map(
          (take) => `${from}: ${take}`,
        )
      }),
    ).toEqual([])
  }, 120_000)

  test('负对照：经 public、装配根、内部文件、转出、相对路径与 import 类型取都会被认出；owner 自己取与别的名字不算', () => {
    const at = join(MODULES, 'memory', 'infrastructure', 'probe.ts')
    const probe =
      "import { createTaskKnowledgeQueries } from '@/modules/task-execution/public/queries'\n" +
      "import { createTaskTriggerQueries as triggers } from '@/modules/task-execution/composition'\n" +
      "import { listNodeEventContents } from '../../task-execution/infrastructure/nodeEventQueries'\n" +
      "export { nonTerminalTaskExists } from '@/modules/task-execution/infrastructure/nonTerminalTaskExists'\n" +
      "import { existingRepositoryIds, createRepositoryIdentityQueries } from '@/modules/source-control/composition'\n" +
      "type R = import('@/modules/source-control/public/participants').readHostedWorkspaceOwnerForBusinessTask\n" +
      "import type { TaskKnowledgeQueries } from '@/modules/task-execution/public/queries'\n" +
      "import { repositoryExistsExpression } from '@/platform/persistence/sessionTables'\n"
    expect(foreignTakes(at, probe, 'memory')).toEqual([
      'createTaskKnowledgeQueries <- task-execution/public/queries',
      'createTaskTriggerQueries <- task-execution/composition',
      'listNodeEventContents <- task-execution/infrastructure/nodeEventQueries',
      'nonTerminalTaskExists <- task-execution/infrastructure/nonTerminalTaskExists',
      'existingRepositoryIds <- source-control/composition',
      'createRepositoryIdentityQueries <- source-control/composition',
      'readHostedWorkspaceOwnerForBusinessTask <- source-control/public/participants',
    ])
    const inside = join(MODULES, 'task-execution', 'infrastructure', 'probe.ts')
    expect(
      foreignTakes(
        inside,
        "import { listNodeEventContents } from './nodeEventQueries'\n" +
          "import { createTaskTriggerQueries } from '@/modules/task-execution/infrastructure/taskTriggerQueries'\n" +
          "import { repositoryExistsExpression } from '@/modules/source-control/composition'\n",
        'task-execution',
      ),
    ).toEqual(['repositoryExistsExpression <- source-control/composition'])
  })
})

describe('RFC-565 —— 读来自构造入参，bootstrap 在根句柄上建好再交入', () => {
  test('消费方文件里读的来处是入参', () => {
    const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        'modules/memory/infrastructure/memoryInjectionReadStore.ts',
        [
          'private readonly taskKnowledge: MemoryInjectionTaskKnowledge,',
          'private readonly repositories: RepositoryIdentityReads,',
          'return this.taskKnowledge.injectionContext(taskId)',
          'return this.taskKnowledge.repositoryIds(taskId)',
          'return this.repositories.existingIds(repositoryIds)',
        ],
      ],
      [
        'modules/memory/infrastructure/memoryDistillWorkStore.ts',
        [
          'private readonly taskKnowledge: MemoryDistillTaskKnowledge,',
          'return this.taskKnowledge.distillationScope(taskId)',
          'return this.taskKnowledge.distillationSources(ids)',
          'return this.taskKnowledge.distillationEvents(ids)',
        ],
      ],
      [
        'modules/integration/infrastructure/webhookDispatchPersistence.ts',
        ['return taskTriggers.findByOrigin(input)', 'return taskTriggers.status(latest.taskId)'],
      ],
      [
        'modules/integration/infrastructure/webhookDeliveryQueries.ts',
        ['const taskRows = await taskTriggers.terminalWorkspaces(taskIds)'],
      ],
      [
        'modules/integration/infrastructure/terminalWorkspaceAttribution.ts',
        ['return taskTriggers.workspaceAttribution(taskId)'],
      ],
      [
        'modules/integration/infrastructure/retentionPhase.ts',
        [
          'export type NonTerminalTaskExists = (db: PersistenceDb, taskIdColumn: AnyColumn) => SQL',
          'nonTerminalTaskExists(db, webhookTriggerFires.taskId)',
        ],
      ],
      [
        'modules/task-execution/infrastructure/taskKnowledgeQueries.ts',
        [
          'cachedRepoExists: repositoryExists(db, taskReadColumns(db).cachedRepoId),',
          'return listNodeEventContents(db, nodeRunIds)',
        ],
      ],
      [
        'modules/task-execution/infrastructure/crewstation/hostedRecoverySelection.ts',
        ['const owner = await input.workspaceOwners.forBusinessTask(businessTaskId)'],
      ],
    ]
    for (const [path, lines] of expected) {
      const text = read(path)
      for (const line of lines)
        expect([path, line, text.includes(line)]).toEqual([path, line, true])
    }
  })

  test('bootstrap 从两个装配根取实现，建在根句柄上', () => {
    const taskExecution = '@/modules/task-execution/composition'
    const sourceControl = '@/modules/source-control/composition'
    const sites: ReadonlyArray<readonly [string, string, readonly string[], readonly string[]]> = [
      [
        'bootstrap/daemonModules/memory.ts',
        taskExecution,
        ['createTaskKnowledgeQueries'],
        [
          'const taskKnowledge = createTaskKnowledgeQueries(input.db, repositoryExistsExpression)',
          'createRepositoryIdentityQueries(input.db),',
        ],
      ],
      [
        'bootstrap/daemonModules/memory.ts',
        sourceControl,
        ['createRepositoryIdentityQueries', 'repositoryExistsExpression'],
        [],
      ],
      [
        'bootstrap/daemonModules/integration.ts',
        taskExecution,
        ['createTaskTriggerQueries'],
        [
          'const taskTriggers = createTaskTriggerQueries(input.db)',
          'composeWebhookDeliveryRuntimeFor(input.db, taskTriggers)',
        ],
      ],
      [
        'bootstrap/daemonApplication.ts',
        taskExecution,
        ['createTaskTriggerQueries'],
        ['taskTriggers: createTaskTriggerQueries(input.db),'],
      ],
      [
        'bootstrap/retentionSweepPhases.ts',
        taskExecution,
        ['nonTerminalTaskExists'],
        ['createWebhookFireRetentionPhase(db, nonTerminalTaskExists),'],
      ],
      [
        'bootstrap/crewstation.ts',
        sourceControl,
        ['createHostedWorkspaceOwnerQueries'],
        ['workspaceOwners: createHostedWorkspaceOwnerQueries(db),'],
      ],
    ]
    for (const [path, specifier, names, lines] of sites) {
      const imported = namesImportedFrom(path, specifier)
      for (const name of names)
        expect([path, name, imported.includes(name)]).toEqual([path, name, true])
      const text = read(path)
      for (const line of lines)
        expect([path, line, text.includes(line)]).toEqual([path, line, true])
    }
  })

  test('TaskKnowledgeQueries 的方法集合逐个钉住（蒸馏的事件正文并入其中）', () => {
    const path = 'modules/task-execution/application/ports/taskKnowledgeQueries.ts'
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
    const declaration = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'TaskKnowledgeQueries',
    )
    expect(declaration).toBeDefined()
    expect(declaration!.members.every((member) => ts.isMethodSignature(member))).toBe(true)
    expect(declaration!.members.map((member) => member.name?.getText(source))).toEqual([
      'injectionContext',
      'repositoryIds',
      'distillationScope',
      'distillationSources',
      'distillationEvents',
    ])
  })

  test('装配期构造这些读不碰句柄：没有绑定会话的句柄也能建，调用时才报错', async () => {
    const unbound = {} as never
    const knowledge = createTaskKnowledgeQueries(unbound, repositoryExistsExpression)
    const triggers = createTaskTriggerQueries(unbound)
    const repositories = createRepositoryIdentityQueries(unbound)
    const owners = createHostedWorkspaceOwnerQueries(unbound)
    for (const built of [knowledge, triggers, repositories, owners])
      expect(typeof built).toBe('object')
    const message = 'Native persistence handle has no session table set'
    await expect(knowledge.injectionContext('task')).rejects.toThrow(message)
    await expect(knowledge.distillationEvents(['run'])).rejects.toThrow(message)
    for (const call of [
      () => triggers.frozenContext('task'),
      () => triggers.workspaceAttribution('task'),
      () => triggers.findByOrigin({ fireId: 'fire' }),
      () => triggers.status('task'),
      () => triggers.terminalWorkspaces(['task']),
    ])
      await expect(call()).rejects.toThrow(message)
    await expect(repositories.existingIds(['repository'])).rejects.toThrow(message)
    await expect(owners.forBusinessTask('business-task')).rejects.toThrow(message)
    // The empty inputs answer without a handle, as before.
    expect(await triggers.terminalWorkspaces([])).toEqual([])
    expect(await repositories.existingIds([])).toEqual([])
    expect(await knowledge.distillationEvents([])).toEqual([])
  })

  test('owner 的实现交得进消费方的入参（编译期由 tsc 检查，这里留运行期锚点）', () => {
    for (const bind of [
      knowledgeFitsInjection,
      knowledgeFitsDistillation,
      repositoriesFit,
      repositoryFragmentFits,
      retentionFragmentFits,
      retentionPhaseTakesFragment,
      triggersFitDispatch,
      triggersFitDelivery,
      triggersFitAttribution,
      workspaceOwnersFit,
    ])
      expect(typeof bind).toBe('function')
  })
})
