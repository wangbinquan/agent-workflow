// RFC-526 — 任务执行的适配器回落改为必填注入（RFC-294 S12 第七步）。
//
// 锁四件事（design §3 的清单即退出门；回落本身由 RFC-521 门的登记锁住）：
// ① 选项的形状（语法树）：启动恢复、数字员工执行、操作配置、节点提示、端口工件、删除效果、provider 运行期、归档与运行生命周期的入参逐个钉
//    住；只为回落存在的选项与缺省参数不在；启动配置按调用方选的 `kind` 分支，不再按“没有选定查询”分支。
// ② 删去的 `select*` 在生产代码里不再出现、task-execution infrastructure 不再回头导入组合层的选择；bootstrap 不取 task-execution 的
//    infrastructure；本机操作配置只由 daemon 构造（语料下限 3,000）。
// ③ 装配处的显式构造逐处钉住：daemon 交给驱动入口的操作配置与会话的工作区存在性、单机部署的节点提示与端口工件、维护 worker 的归档内容与
//    工作区存在性、数字员工执行的任务取消与人审停靠的存在性。
// ④ 行为：启动配置两支各自只读调用方给的读取；本机操作配置每次读取时才读配置文件；没给操作配置就是没有配置。
// 均带负对照。
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createFileTaskOperationConfiguration } from '@/modules/task-execution/composition'
import { readCommitExcludePatterns } from '@/modules/task-execution/composition/commitPushBinding'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { freezeBinaryConfig } from '@/modules/task-execution/composition/runtimeConfigFreeze'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, source: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    })
}
const PRODUCTION = walk(SRC)
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (path: string) => slash(relative(SRC, path)).replace(/\.tsx?$/, '')
/** The corpus tests read every production file; the first read is cold. */
const CORPUS_TIMEOUT = 30_000
const squash = (value: string) => value.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '')

const at = (...parts: string[]) => join(SRC, ...parts)
const TE = (...parts: string[]) => at('modules', 'task-execution', ...parts)
const C = (name: string) => TE('composition', name)
const BOOT = C('bootRecovery.ts')
const EMPLOYEE = C('digitalEmployeeExecution.ts')
const COMMIT = C('commitPushBinding.ts')
const FREEZE = C('runtimeConfigFreeze.ts')
const FAMILY = C('localTaskAgentRunFamily.ts')
const LAUNCH = C('launchConfiguration.ts')
const PROMPTS = C('nodeRunPrompts.ts')
const ARTIFACTS = C('portArtifacts.ts')
const DELETION = C('taskDeletionEffects.ts')
const PROVIDER = C('providerRuntime.ts')
const RUN_SELECTION = C('localTaskRunSelection.ts')
const ARCHIVE = C('taskArchiveMaintenance.ts')
const PERSISTENCE = C('taskExecutionPersistence.ts')
const CANCELLATION = C('taskCancellation.ts')
const ROUTES = TE('infrastructure', 'taskRouteOperations.ts')
const DELETE = TE('infrastructure', 'taskDelete.ts')
const BINDINGS = at(
  'modules',
  'collaboration',
  'infrastructure',
  'taskExecutionParticipantBindings.ts',
)
const MECHANICS = at(
  'modules',
  'collaboration',
  'infrastructure',
  'collaborationRuntimeMechanics.ts',
)
const CLARIFY = at('modules', 'collaboration', 'infrastructure', 'clarify', 'service.ts')
const REVIEW = at('modules', 'collaboration', 'infrastructure', 'review.ts')
const PORT_ROUTE = at('modules', 'task-execution', 'inbound', 'http', 'portArtifactRoutes.ts')
const DAEMON_TE = at('bootstrap', 'daemonModules', 'taskExecution.ts')
const DAEMON_DE = at('bootstrap', 'daemonModules', 'digitalEmployee.ts')
const STANDALONE = at('bootstrap', 'standalone.ts')
const WORKER = at('bootstrap', 'maintenanceWorkerGraph.ts')
const HTTP = at('bootstrap', 'daemonHttpComposition.ts')
const SESSION = at('bootstrap', 'daemonSession.ts')

/** Property names and optionality of an interface, or of the first parameter's type literals of a function. */
function members(path: string, source: string, name: string): Map<string, boolean> {
  const file = parse(path, source)
  const result = new Map<string, boolean>()
  const take = (list: ts.NodeArray<ts.TypeElement>) => {
    for (const member of list)
      if (ts.isPropertySignature(member))
        result.set(member.name.getText(file), member.questionToken !== undefined)
  }
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) take(node.members)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      const type = node.parameters[0]?.type
      const literals: ts.TypeLiteralNode[] = []
      const collect = (part: ts.Node) => {
        if (ts.isTypeLiteralNode(part)) literals.push(part)
        else if (ts.isIntersectionTypeNode(part)) part.types.forEach(collect)
        else if (ts.isTypeReferenceNode(part) && part.typeName.getText(file) === 'Readonly')
          part.typeArguments?.forEach(collect)
      }
      if (type !== undefined) collect(type)
      for (const literal of literals) take(literal.members)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

/** Every declaration of a function `name`: its parameters as `name?=default`. */
function signatures(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const result: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      result.push(
        node.parameters.map(
          (parameter) =>
            parameter.name.getText(file) +
            (parameter.questionToken === undefined ? '' : '?') +
            (parameter.initializer === undefined ? '' : '=default'),
        ),
      )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

/** The type text (whitespace removed) of parameter `index` of every declaration of function `name`. */
function parameterTypes(path: string, source: string, name: string, index: number): string[] {
  const file = parse(path, source)
  const result: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      const type = node.parameters[index]?.type
      if (type !== undefined) result.push(squash(type.getText(file)))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

/** The argument texts (whitespace and trailing commas removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === name)
      calls.push(node.arguments.map((argument) => squash(argument.getText(file))))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

/** Module specifiers a file imports or re-exports. */
function specifiers(path: string, source: string): string[] {
  return parse(path, source).statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

/** Conditional expressions in a file whose condition tests a value against `undefined`. */
function undefinedBranches(path: string, source: string): string[] {
  const file = parse(path, source)
  const result: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isConditionalExpression(node) &&
      /===undefined|!==undefined/.test(squash(node.condition.getText(file)))
    )
      result.push(squash(node.condition.getText(file)))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

describe('RFC-526 ① 选项的形状', () => {
  test('启动恢复与数字员工执行：执行恢复工厂与程序工具源必填，只为回落存在的 appHome 不在', () => {
    expect([...members(BOOT, text(BOOT), 'runTaskExecutionBootRecovery')]).toEqual([
      ['recoveryEffects', false],
    ])
    const employee = members(EMPLOYEE, text(EMPLOYEE), 'DigitalEmployeeExecutionDependencies')
    expect([employee.get('programs'), employee.has('appHome')]).toEqual([false, false])
    // RFC-530: the always-overridden `tasks` default (and the three parameters only it used) left the ports.
    expect(
      signatures(EMPLOYEE, text(EMPLOYEE), 'composeDatabaseDigitalEmployeeExecutionPorts'),
    ).toEqual([['db']])
  })

  test('操作配置：提交排除模式与可执行文件冻结只取给的配置，`configPath` 不在', () => {
    expect(parameterTypes(COMMIT, text(COMMIT), 'readCommitExcludePatterns', 0)).toEqual([
      "Pick<TaskMechanicsState['opts'],'operationConfiguration'|'commitPushExcludePatterns'>",
    ])
    expect(signatures(FREEZE, text(FREEZE), 'freezeBinaryConfig')).toEqual([['configuration']])
    for (const path of [COMMIT, FREEZE, FAMILY]) expect(text(path)).not.toContain('configPath')
  })

  test('启动配置：三处读取按调用方选的 kind 分支，不再按“没有选定查询”分支', () => {
    expect(
      undefinedBranches(LAUNCH, text(LAUNCH)).filter((condition) =>
        condition.includes('selectedQueries'),
      ),
    ).toEqual([])
    // the local reader itself, and the runtime / start / drive reads and the preparation configuration
    expect(text(LAUNCH).match(/input\.kind === 'local-sync'/g)?.length).toBe(5)
  })

  test('节点提示、端口工件与删除效果：内容必填，内部的 select* 删去，public 的读取选择只收给的读取', () => {
    expect(signatures(PROMPTS, text(PROMPTS), 'composeNodeRunPromptOperations')).toEqual([
      ['content'],
    ])
    expect(signatures(PROMPTS, text(PROMPTS), 'selectNodeRunPromptOperations')).toEqual([])
    expect(signatures(ARTIFACTS, text(ARTIFACTS), 'composePortArtifactOperations')).toEqual([
      ['content'],
    ])
    expect(signatures(ARTIFACTS, text(ARTIFACTS), 'selectPortArtifactOperations')).toEqual([])
    expect(signatures(ARTIFACTS, text(ARTIFACTS), 'selectPortArtifactReader')).toEqual([
      ['selected'],
    ])
    expect(signatures(DELETION, text(DELETION), 'selectedTaskDeletionEffects')).toEqual([])
    const routes = members(ROUTES, text(ROUTES), 'TaskRouteOperationsDependencies')
    expect([routes.get('nodeRunPrompts'), routes.get('effects')]).toEqual([false, false])
    // The node-runs projection takes its prompt operations from its caller (the route operations give theirs).
    expect(members(ROUTES, text(ROUTES), 'taskNodeRunsProjection').get('nodeRunPrompts')).toBe(
      false,
    )
    expect(squash(text(DELETE))).toContain('effects:TaskDeletionEffects')
    expect(squash(text(DELETE))).not.toContain('effects?:TaskDeletionEffects')
  })

  test('provider 运行期、归档与运行生命周期：排除档案、归档与工作区存在性必填，缺省参数不在', () => {
    const provider = members(PROVIDER, text(PROVIDER), 'TaskExecutionProviderRuntimeDependencies')
    expect(provider.get('archive')).toBe(false)
    expect(squash(text(PROVIDER))).not.toContain(
      "Partial<Pick<TaskExecutionRuntimeParticipantsInput,'workspaceExcludeProfilesFor'>>",
    )
    expect(
      signatures(RUN_SELECTION, text(RUN_SELECTION), 'bindProviderTaskRunParticipantsInput'),
    ).toEqual([['input']])
    expect(
      signatures(ARCHIVE, text(ARCHIVE), 'createDrizzleTaskArchiveMaintenanceCommand'),
    ).toEqual([['db', 'collaboration', 'input']])
    expect(
      parameterTypes(ARCHIVE, text(ARCHIVE), 'createDrizzleTaskArchiveMaintenanceCommand', 2),
    ).toEqual([
      "{readonlycontent:TaskArchiveContentPortreadonlylocations?:TaskArchiveContentBinding['locations']}",
    ])
    expect(
      members(PERSISTENCE, text(PERSISTENCE), 'TaskExecutionPersistenceDependencies').get(
        'workspacePresence',
      ),
    ).toBe(false)
    expect(
      signatures(PERSISTENCE, text(PERSISTENCE), 'createTaskRuntimeLifecyclePersistence'),
    ).toEqual([['db', 'dependencies']])
    // RFC-530: the cancellation composer only tests used is a test helper now (composition/taskCancellation.ts is gone).
    expect(existsSync(CANCELLATION)).toBe(false)
  })

  test('collaboration 与路由：参与者绑定带工作区存在性，端口工件读取必填', () => {
    expect(
      members(BINDINGS, text(BINDINGS), 'TaskExecutionParticipantBindings').get(
        'workspacePresence',
      ),
    ).toBe(false)
    expect(squash(text(MECHANICS))).toContain(
      'portArtifactReaderFor:(appHome:string)=>PortArtifactReader',
    )
    expect(squash(text(MECHANICS))).not.toContain('portArtifactReaderFor?:')
    expect(squash(text(REVIEW))).toContain('portArtifactReader:PortArtifactReader')
    expect(squash(text(REVIEW))).not.toContain('portArtifactReader?:')
    expect(squash(text(PORT_ROUTE))).toContain('readonlyportArtifacts:PortArtifactReader')
  })

  test('负对照：可选成员、缺省参数与按 undefined 的分支都认得出', () => {
    const probe = join(SRC, 'probe.ts')
    const source = [
      'export interface P { readonly a?: string; readonly b: string }',
      'export function f(input: { readonly c: number } = { c: 1 }, d?: string) { return input }',
      'const g = (x?: string) => (x === undefined ? local() : x)',
    ].join('\n')
    expect([...members(probe, source, 'P')]).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(signatures(probe, source, 'f')).toEqual([['input=default', 'd?']])
    expect(undefinedBranches(probe, source)).toEqual(['x===undefined'])
  })
})

describe('RFC-526 ② 删去的名字与 bootstrap 的依赖', () => {
  test(
    '删去的 select* 在生产代码里不再出现；infrastructure 不回头导入组合层的选择；本机操作配置只由 daemon 构造（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      expect(
        PRODUCTION.filter((path) =>
          /\b(?:selectNodeRunPromptOperations|selectPortArtifactOperations|selectedTaskDeletionEffects)\b/.test(
            text(path),
          ),
        ).map(srcPath),
      ).toEqual([])
      const infrastructure = PRODUCTION.filter((path) =>
        srcPath(path).startsWith('modules/task-execution/infrastructure/'),
      )
      expect(
        infrastructure.flatMap((path) =>
          specifiers(path, text(path))
            .filter((spec) =>
              /\/composition\/(?:nodeRunPrompts|portArtifacts|taskDeletionEffects)$/.test(spec),
            )
            .map((spec) => `${srcPath(path)}: ${spec}`),
        ),
      ).toEqual([])
      expect(
        PRODUCTION.filter((path) => text(path).includes('createFileTaskOperationConfiguration('))
          .filter(
            (path) =>
              callArguments(path, text(path), 'createFileTaskOperationConfiguration').length > 0,
          )
          .map(srcPath),
      ).toEqual(['bootstrap/daemonModules/taskExecution'])
      const bootstrap = PRODUCTION.filter((path) => srcPath(path).startsWith('bootstrap/'))
      expect(bootstrap.length).toBeGreaterThan(20)
      expect(
        bootstrap.flatMap((path) =>
          specifiers(path, text(path))
            .filter((spec) => /task-execution\/infrastructure(\/|$)/.test(spec))
            .map((spec) => `${srcPath(path)}: ${spec}`),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：组合层选择的回头导入与 infrastructure 的 import 认得出', () => {
    const probe = join(SRC, 'modules', 'task-execution', 'infrastructure', 'probe.ts')
    const source = [
      "import { a } from '../composition/nodeRunPrompts'",
      "import { b } from '@/modules/task-execution/infrastructure/local/fileTaskOperationConfiguration'",
    ].join('\n')
    expect(specifiers(probe, source)).toEqual([
      '../composition/nodeRunPrompts',
      '@/modules/task-execution/infrastructure/local/fileTaskOperationConfiguration',
    ])
  })
})

describe('RFC-526 ③ 装配处的显式构造', () => {
  test('daemon：驱动入口带本机配置文件的操作配置；跨上下文闭包与数字员工执行取部署的工作区存在性', () => {
    const provider = callArguments(
      DAEMON_TE,
      text(DAEMON_TE),
      'composeTaskExecutionProviderRuntime',
    )
    expect(provider).toHaveLength(1)
    expect(provider[0]![0]).toContain(
      'operationConfiguration:createFileTaskOperationConfiguration(configPath)',
    )
    // RFC-534: the session's terminal workspace prune policy is the closure's fourth argument.
    expect(callArguments(DAEMON_TE, text(DAEMON_TE), 'composeCrossContextClosure')).toEqual([
      ['db', 'executionPermits', 'observation.workspacePresence', 'input.terminalWorkspacePrune'],
    ])
    // RFC-530: the daemon's task get / cancel are its routes; the ports take only the database.
    expect(
      callArguments(DAEMON_DE, text(DAEMON_DE), 'composeDatabaseDigitalEmployeeExecutionPorts'),
    ).toEqual([['db']])
    expect(callArguments(HTTP, text(HTTP), 'composeTaskExecutionParticipantBindings')).toEqual([
      [
        'taskExecutionProvider.executionPermits',
        'input.selections.workspacePresence',
        'taskExecutionProvider.terminalWorkspacePrune',
      ],
    ])
    expect(
      callArguments(SESSION, text(SESSION), 'composeTaskExecutionParticipantBindings'),
    ).toEqual([
      [
        'runtime.taskExecutionModules.executionPermits',
        'input.workspacePresence',
        'runtime.taskExecutionModules.terminalWorkspacePrune',
      ],
    ])
    for (const path of [CLARIFY, REVIEW]) {
      const parks = callArguments(path, text(path), 'parkPreparedHumanGate')
      expect(parks).toHaveLength(1)
      expect(parks[0]![0]).toContain(
        'workspacePresence:args.taskExecutionParticipants.workspacePresence',
      )
    }
  })

  test('单机部署：节点提示与端口工件用此前缺省的根目录显式构造', () => {
    const source = squash(text(STANDALONE))
    expect(source).toContain(
      "nodeRunPrompts:composeNodeRunPromptOperations(createFileNodeRunPromptContent(join(appHome,'runs')))",
    )
    expect(source).toContain(
      'portArtifacts:composePortArtifactOperations(createFilePortArtifactContent(appHome))',
    )
  })

  test('维护 worker：归档内容与工作区存在性显式给出本机实现（部署效果为 null 时；RFC-528：归档内容在单机 profile 的 worker 部分）', () => {
    expect(
      callArguments(WORKER, text(WORKER), 'createDrizzleTaskArchiveMaintenanceCommand'),
    ).toEqual([['client', 'closure.collaborationReads.archive', 'effects.taskArchive']])
    expect(squash(text(WORKER))).toContain(
      'taskArchive:selected?.taskArchive??standalone.taskArchive(scope)',
    )
    expect(squash(text(at('bootstrap', 'standaloneMaintenanceWorker.ts')))).toContain(
      'taskArchive:()=>({content:createFileTaskArchiveContent()})',
    )
    expect(squash(text(WORKER))).toContain(
      'constworkspacePresence=createFileWorkspacePresenceQueries()',
    )
    // RFC-534: the worker never prunes a terminal workspace (named policy, as its empty registration was).
    expect(callArguments(WORKER, text(WORKER), 'composeCrossContextClosure')).toEqual([
      [
        'client',
        'createExecutionPermitRegistry()',
        'workspacePresence',
        'neverPruneTerminalWorkspaces',
      ],
    ])
    const persistence = callArguments(WORKER, text(WORKER), 'createTaskExecutionPersistence')
    expect(persistence).toHaveLength(1)
    expect(persistence[0]![1]).toContain('workspacePresence')
  })
})

describe('RFC-526 ④ 行为', () => {
  test('启动配置：local-sync 每次读调用方的同步读取，selected 交出选定的查询与准备配置', () => {
    let reads = 0
    const local = composeTaskLaunchConfiguration({
      kind: 'local-sync',
      queries: {
        read: () => {
          reads += 1
          return DEFAULT_CONFIG
        },
      },
    })
    expect(reads).toBe(0)
    expect(local.selectedQueries).toBeUndefined()
    expect('preparationConfiguration' in local).toBe(false)
    local.runtime()
    const afterOne = reads
    expect(afterOne).toBeGreaterThan(0)
    local.runtime()
    expect(reads).toBeGreaterThan(afterOne)
    const queries = { read: async () => DEFAULT_CONFIG }
    const selected = composeTaskLaunchConfiguration({ kind: 'selected', queries })
    expect(selected.selectedQueries).toBe(queries)
    expect(selected.continuationQueries).toBe(queries)
    expect(typeof selected.preparationConfiguration?.read).toBe('function')
  })

  test('操作配置：本机配置文件的实现每次读取时才读文件；没给就是没有配置', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc526-config-'))
    try {
      const configPath = join(root, 'config.json')
      const configuration = createFileTaskOperationConfiguration(configPath)
      expect(existsSync(configPath)).toBe(false)
      writeFileSync(
        configPath,
        JSON.stringify({ ...DEFAULT_CONFIG, taskCommitExcludePatterns: ['first/**'] }),
      )
      expect(
        await readCommitExcludePatterns({
          operationConfiguration: configuration,
          commitPushExcludePatterns: [],
        }),
      ).toEqual(['first/**'])
      writeFileSync(
        configPath,
        JSON.stringify({ ...DEFAULT_CONFIG, taskCommitExcludePatterns: ['second/**'] }),
      )
      expect(
        await readCommitExcludePatterns({
          operationConfiguration: configuration,
          commitPushExcludePatterns: [],
        }),
      ).toEqual(['second/**'])
      expect(await readCommitExcludePatterns({ commitPushExcludePatterns: ['run/**'] })).toEqual([
        'run/**',
      ])
      expect(await freezeBinaryConfig(undefined)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
