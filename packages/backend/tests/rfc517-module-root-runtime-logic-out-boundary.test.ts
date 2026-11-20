// RFC-517 — 模块根装配文件的运行期逻辑迁出（二）：数字员工、系统运维与任务执行（RFC-294 S10 第二十四步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；六个新文件恰好声明、交出清单列的名字；三个模块根不再声明它们，只照旧转出。
// ② 三个模块根 `composition.ts` 没有循环、switch、`try`、`throw` 与错误的构造；新名字在生产代码里只被预期的文件调用（实参钉住，带负对照）。
// ③ 六个新文件的依赖面是闭集（import 逐条钉住）并服从 RFC-294 design §3 的层次：application 不取 infrastructure 与 composition（本模块
//    required-ports 的类型除外），infrastructure 不取 composition，别的模块只取 public；进程全局只有任务执行模块原有的 `Date.now` 与 `ulid`
//    （带负对照）。
// ④ 行为：平台清单参与者、员工定义视图、文件库启动准备、schema 计划核对、暂存还原后的工件释放、任务执行模块的认领 / 暂停 / 销毁与关停控制器。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读三个模块根与新位置。
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { composeDigitalEmployeePlatformInventoryParticipant } from '@/modules/digital-employee/application/platformInventoryParticipant'
import { createEmployeeDefinitionViewProjection } from '@/modules/digital-employee/application/employeeDefinitionView'
import { requireSchemaPlanForContract } from '@/modules/system-operations/application/schemaPlanAdmission'
import { releaseArtifactAfterStageRestore } from '@/modules/system-operations/application/stageRestoreArtifactRelease'
import { prepareFileDatabaseProviderForBoot } from '@/modules/system-operations/infrastructure/local/fileDatabaseProviderBoot'
import {
  ProviderTaskExecutionModule,
  TaskExecutionModule,
  createTaskExecutionShutdownController,
} from '@/modules/task-execution/infrastructure/taskExecutionModule'
import { acquireLock } from '@/util/lock'
import { removeTempDirSync } from './fixtures/tempDir'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const PLATFORM = 'modules/digital-employee/application/platformInventoryParticipant'
const VIEW = 'modules/digital-employee/application/employeeDefinitionView'
const BOOT = 'modules/system-operations/infrastructure/local/fileDatabaseProviderBoot'
const PLAN = 'modules/system-operations/application/schemaPlanAdmission'
const STAGE = 'modules/system-operations/application/stageRestoreArtifactRelease'
const MODULE = 'modules/task-execution/infrastructure/taskExecutionModule'
const ROOTS = ['digital-employee', 'system-operations', 'task-execution'].map(
  (module) => `modules/${module}/composition`,
)
/** design §3: the six new files with the names each declares (in order) and offers. */
const NEW_FILES: Readonly<
  Record<string, { declared: readonly string[]; offered: readonly string[] }>
> = {
  [PLATFORM]: {
    declared: [
      'DigitalEmployeePlatformInventoryAclRow',
      'DigitalEmployeePlatformInventoryAccess',
      'inventoryText',
      'sortInventoryRows',
      'composeDigitalEmployeePlatformInventoryParticipant',
    ],
    offered: [
      'DigitalEmployeePlatformInventoryAccess',
      'composeDigitalEmployeePlatformInventoryParticipant',
    ],
  },
  [VIEW]: {
    declared: ['createEmployeeDefinitionViewProjection'],
    offered: ['createEmployeeDefinitionViewProjection'],
  },
  [BOOT]: {
    declared: [
      'FileDatabaseBootPreparation',
      'PreparedFileDatabase',
      'prepareFileDatabaseProviderForBoot',
    ],
    offered: [
      'FileDatabaseBootPreparation',
      'PreparedFileDatabase',
      'prepareFileDatabaseProviderForBoot',
    ],
  },
  [PLAN]: {
    declared: ['requireSchemaPlanForContract'],
    offered: ['requireSchemaPlanForContract'],
  },
  [STAGE]: {
    declared: ['releaseArtifactAfterStageRestore'],
    offered: ['releaseArtifactAfterStageRestore'],
  },
  [MODULE]: {
    declared: [
      'DEFAULT_OWNERSHIP_LEASE_MS',
      'DEFAULT_OWNERSHIP_HEARTBEAT_MS',
      'ClaimedTaskExecution',
      'TaskExecutionModule',
      'ProviderTaskExecutionModule',
      'createTaskExecutionShutdownController',
    ],
    offered: [
      'DEFAULT_OWNERSHIP_LEASE_MS',
      'DEFAULT_OWNERSHIP_HEARTBEAT_MS',
      'ClaimedTaskExecution',
      'TaskExecutionModule',
      'ProviderTaskExecutionModule',
      'createTaskExecutionShutdownController',
    ],
  },
}
/** design §3: every listed name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = Object.entries(NEW_FILES).flatMap(
  ([location, { declared }]) => declared.map((name) => [location, name] as const),
)
/** design D2: the module roots still offer the moved names their consumers import from them. */
const ROOT_OFFERS: Readonly<Record<string, readonly string[]>> = {
  'modules/digital-employee/composition': NEW_FILES[PLATFORM]!.offered,
  'modules/task-execution/composition': NEW_FILES[MODULE]!.offered,
}
/** design D2: how each module root (and the one infrastructure consumer) takes the new places. */
const ROOT_EDGES: Readonly<Record<string, readonly string[]>> = {
  'modules/digital-employee/composition': [
    `import ${VIEW}: createEmployeeDefinitionViewProjection`,
    `export ${PLATFORM}: composeDigitalEmployeePlatformInventoryParticipant, DigitalEmployeePlatformInventoryAccess`,
  ],
  'modules/system-operations/composition': [
    `import ${BOOT}: prepareFileDatabaseProviderForBoot, FileDatabaseBootPreparation, PreparedFileDatabase`,
    `import ${PLAN}: requireSchemaPlanForContract`,
    `import ${STAGE}: releaseArtifactAfterStageRestore`,
  ],
  'modules/task-execution/composition': [
    `import ${MODULE}: ProviderTaskExecutionModule, TaskExecutionModule`,
    `export ${MODULE}: DEFAULT_OWNERSHIP_HEARTBEAT_MS, DEFAULT_OWNERSHIP_LEASE_MS, ProviderTaskExecutionModule, TaskExecutionModule, createTaskExecutionShutdownController, ClaimedTaskExecution`,
  ],
  'modules/task-execution/infrastructure/childTaskLifecycleParticipant': [
    `import ${MODULE}: ProviderTaskExecutionModule`,
  ],
}
/** design §4 ③: the exact imports of the six new files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [PLATFORM]: [
    'import modules/identity-access/public/participants: DirectAuthenticatedAuthority',
    'import modules/digital-employee/public/participants: DigitalEmployeePlatformInventoryParticipant, DigitalEmployeePlatformInventoryResourceType, DigitalEmployeePlatformInventoryRow',
    'import modules/digital-employee/application/ports/digitalEmployeeModule: DigitalEmployeeQueries, ToolRegistrationView',
  ],
  [VIEW]: [
    'import modules/digital-employee/application/authoringService: DigitalEmployeeAuthoringService',
    'import modules/digital-employee/application/ports/authoringStore: DigitalEmployeeAuthoringPersistence',
    'import modules/digital-employee/application/ports/digitalEmployeeModule: EmployeeDefinitionView',
  ],
  [BOOT]: [
    'import node:path: dirname',
    'import platform/persistence/databaseProviderRuntime: prepareEpoch2DatabaseProviderRuntime',
    'import util/lock: acquireLock',
    'import modules/system-operations/application/ports/databaseConfiguration: DatabaseConfigurationPort',
    'import modules/system-operations/infrastructure/databaseSchemaUpgradeCoordinator: prepareDatabaseSchemaUpgrade, DatabaseSchemaUpgradeOptions',
    'import modules/system-operations/infrastructure/epochSwitch/bootAdmission: admitEpochBoot',
    'import modules/system-operations/infrastructure/local/epoch2ProviderMoveRecovery: recoverEpoch2ProviderMove',
  ],
  [PLAN]: [],
  [STAGE]: [
    'import modules/system-operations/public/commands: StageRestoreCommand',
    'import modules/system-operations/public/types: RestoreArtifactRef',
  ],
  [MODULE]: [
    'import ulid: ulid',
    'import platform/persistence/persistenceDb: PersistenceDb',
    'import modules/task-execution/application/ports/taskExecutionPersistence: TaskExecutionPersistence',
    'import modules/task-execution/application/ports/taskExecutionShutdownOperations: TaskExecutionShutdownController',
    'import modules/task-execution/application/ports/taskOwnershipPersistence: TaskOwnershipPersistence',
    'import modules/task-execution/application/taskClaimGate: TaskClaimGate',
    'import modules/task-execution/domain/executionIntent: TaskExecutionIntentKind',
    'import modules/task-execution/domain/ownership: createWorkerIdentity, ClaimAttachPermit, OwnershipToken',
    'import modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry: InMemoryTaskRuntimeRegistry, RuntimeStopTicket',
    'import modules/task-execution/infrastructure/taskOwnershipPersistence: DrizzleTaskOwnershipPersistence',
  ],
}
/** design §4 ③: the only process globals of the new files — the task execution module's moved claim defaults. */
const GLOBALS: Readonly<Record<string, readonly string[]>> = { [MODULE]: ['Date.now', 'ulid'] }
/** The production calls of each new function (file and count) and the arguments where they are pinned. */
const CALLS: Readonly<
  Record<string, readonly [readonly string[], readonly (readonly string[])[] | null]>
> = {
  composeDigitalEmployeePlatformInventoryParticipant: [
    ['bootstrap/daemonModules/digitalEmployee x1'],
    null,
  ],
  createEmployeeDefinitionViewProjection: [
    ['modules/digital-employee/composition x1'],
    [['store']],
  ],
  prepareFileDatabaseProviderForBoot: [['modules/system-operations/composition x1'], [['input']]],
  requireSchemaPlanForContract: [
    ['modules/system-operations/composition x1'],
    [['plan', 'contract']],
  ],
  releaseArtifactAfterStageRestore: [
    ['modules/system-operations/composition x1'],
    [['application.commands.stageRestore', 'deps.artifacts']],
  ],
  createTaskExecutionShutdownController: [
    ['bootstrap/daemonSession x1'],
    [['runtime.taskExecution.executionModule']],
  ],
  inventoryText: [[`${PLATFORM} x3`], null],
  sortInventoryRows: [[`${PLATFORM} x1`], null],
}
/** The tests below read every production file, test and e2e file; the first pays the cold read. */
const CORPUS_TIMEOUT = 30_000

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}
const PRODUCTION = walk(SRC)
const TEST_FILES = walk(join(BACKEND, 'tests'))
const E2E_FILES = walk(join(REPO, 'e2e'))
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (abs: string) => slash(relative(SRC, abs)).replace(/\.tsx?$/, '')
const corpusPath = (abs: string) => slash(relative(REPO, abs))
const sourceOf = (location: string) => join(SRC, `${location}.ts`)
/** `@/…` and relative specifiers as a path under `src` without extension; packages yield null. */
const resolveSpecifier = (file: string, specifier: string) =>
  specifier.startsWith('@/')
    ? srcPath(join(SRC, specifier.slice(2)))
    : specifier.startsWith('.')
      ? srcPath(resolve(dirname(file), specifier))
      : null

function declaredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name.text)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
  }
  return names
}

function offeredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exported) names.push(...declaredNames(path, statement.getFullText()))
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) names.push(element.name.text)
  }
  return names
}

/** Every static import or re-export of the file as `kind specifier: names` (resolved under `src`; packages as written). */
function moduleEdges(file: string, source: string): string[] {
  const out: string[] = []
  for (const statement of parse(file, source).statements) {
    if (
      !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const from =
      resolveSpecifier(file, statement.moduleSpecifier.text) ?? statement.moduleSpecifier.text
    let names = ['<other>']
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings))
        names = bindings.elements.map((element) => (element.propertyName ?? element.name).text)
    } else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause))
      names = statement.exportClause.elements.map(
        (element) => (element.propertyName ?? element.name).text,
      )
    out.push(
      `${ts.isImportDeclaration(statement) ? 'import' : 'export'} ${from}: ${names.join(', ')}`,
    )
  }
  return out
}

/** The argument texts (whitespace removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(node.arguments.map((argument) => argument.getText(file).replace(/\s+/g, '')))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

const CONTROL_FLOW = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.IfStatement, 'if'],
  [ts.SyntaxKind.ForStatement, 'for'],
  [ts.SyntaxKind.ForInStatement, 'for-in'],
  [ts.SyntaxKind.ForOfStatement, 'for-of'],
  [ts.SyntaxKind.WhileStatement, 'while'],
  [ts.SyntaxKind.DoStatement, 'do'],
  [ts.SyntaxKind.SwitchStatement, 'switch'],
  [ts.SyntaxKind.TryStatement, 'try'],
  [ts.SyntaxKind.ThrowStatement, 'throw'],
])
/** Production files that call `name`, each with its call count. */
function productionCallers(name: string): string[] {
  return PRODUCTION.filter((path) => text(path).includes(name))
    .map((path) => [srcPath(path), callArguments(path, text(path), name).length] as const)
    .filter(([, count]) => count > 0)
    .map(([path, count]) => `${path} x${count}`)
    .sort()
}

/** Control-flow statements anywhere in the file and every `new …Error(…)` (design §4 ②). */
function checkShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.endsWith('Error')
    )
      out.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return out
}

/** What design §3 forbids in the three module roots (branches stay: they are assembly-time selections). */
const forbidden = (path: string) => checkShapes(path, text(path)).filter((shape) => shape !== 'if')

/** RFC-294 design §3 imports a new file may not take, read from the syntax tree (packages and `platform` / `util` pass). */
function layerFindings(file: string, source: string): string[] {
  const parts = srcPath(file).split('/')
  const own = parts.slice(0, 2).join('/')
  const layer = parts[2]
  const allowed = (specifier: string) => {
    const resolved = resolveSpecifier(file, specifier)
    if (resolved === null || !resolved.startsWith('modules/')) return true
    if (!resolved.startsWith(`${own}/`)) return /^modules\/[^/]+\/public\//.test(resolved)
    if (/\/composition(\/|$)/.test(resolved))
      return layer === 'application' && resolved === `${own}/composition/required-ports`
    return layer !== 'application' || !resolved.includes('/infrastructure/')
  }
  const findings: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !allowed(node.moduleSpecifier.text)
    )
      findings.push(`import ${node.moduleSpecifier.text}`)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      !allowed(node.arguments[0].text)
    )
      findings.push(`import() ${node.arguments[0].text}`)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

/** Process globals the file reaches (the clock, randomness, ids, the process and the runtime), each once. */
function processGlobals(file: string, source: string): string[] {
  const found = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (['process', 'Bun', 'globalThis', 'crypto'].includes(node.expression.text) ||
        (node.expression.text === 'Date' && node.name.text === 'now') ||
        (node.expression.text === 'Math' && node.name.text === 'random'))
    )
      found.add(`${node.expression.text}.${node.name.text}`)
    if (ts.isIdentifier(node) && ['randomUUID', 'fetch', 'ulid'].includes(node.text))
      found.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return [...found].sort()
}

describe('RFC-517 ① 清单里的名字只在各自的位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个清单名字只在它的位置声明（语料下限 3,000 / 2,500）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      const declaring = (name: string) =>
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter(
            (path) =>
              new RegExp(`\\b${name}\\b`).test(text(path)) &&
              declaredNames(path, text(path)).includes(name),
          )
          .map(corpusPath)
          .sort()
      expect(LISTED).toHaveLength(17)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('六个新文件恰好声明、交出清单列的名字；三个模块根不声明它们，只照旧转出', () => {
    for (const [location, { declared, offered }] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path))]).toEqual([location, [...declared]])
      expect([location, offeredNames(path, text(path))]).toEqual([location, [...offered]])
    }
    const listed = new Set(LISTED.map(([, name]) => name))
    for (const root of ROOTS) {
      const path = sourceOf(root)
      expect(
        declaredNames(path, text(path)).filter((name) => listed.has(name)),
        root,
      ).toEqual([])
    }
    for (const [root, names] of Object.entries(ROOT_OFFERS)) {
      const offered = offeredNames(sourceOf(root), text(sourceOf(root)))
      for (const name of names) expect([root, offered.includes(name)]).toEqual([root, true])
    }
  })
})

describe('RFC-517 ② 模块根只装配', () => {
  test('三个模块根没有循环、switch、try、throw 与错误的构造', () => {
    expect(
      ROOTS.flatMap((root) => forbidden(sourceOf(root)).map((shape) => `${root}: ${shape}`)),
    ).toEqual([])
  })

  test(
    '新名字在生产代码里只被预期的文件调用，实参钉住；模块根与唯一的基础设施消费者从新位置取',
    () => {
      for (const [name, [callers, args]] of Object.entries(CALLS)) {
        expect([name, productionCallers(name)]).toEqual([name, [...callers]])
        if (args === null) continue
        const location = callers[0]!.split(' ')[0]!
        const path = sourceOf(location)
        expect([name, callArguments(path, text(path), name)]).toEqual([
          name,
          args.map((row) => [...row]),
        ])
      }
      for (const [location, edges] of Object.entries(ROOT_EDGES)) {
        const path = sourceOf(location)
        const actual = moduleEdges(path, text(path))
        for (const edge of edges)
          expect([location, actual.includes(edge)]).toEqual([location, true])
      }
      const participant = sourceOf(
        'modules/task-execution/infrastructure/childTaskLifecycleParticipant',
      )
      expect(
        moduleEdges(participant, text(participant)).filter((edge) =>
          /^import modules\/task-execution\/composition(:|$)/.test(edge),
        ),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：模块根里的循环、try、throw 与错误的构造都会被认出，分支不算', () => {
    const probe = join(SRC, 'modules', 'probe', 'composition.ts')
    const source = [
      `export async function claim(gate: { enter(): string; leave(p: string): void }, run: () => Promise<void>) {`,
      `  const permit = gate.enter()`,
      `  if (permit.length === 0) throw new Error('task execution module pause requires a reason')`,
      `  try { await run() } catch (error) { gate.leave(permit); throw error }`,
      `  for (const key of ['en', 'zh']) void key`,
      `}`,
    ].join('\n')
    expect(checkShapes(probe, source).filter((shape) => shape !== 'if')).toEqual([
      'throw',
      'Error',
      'try',
      'throw',
      'for-of',
    ])
  })
})

describe('RFC-517 ③ 新文件的依赖面是闭集并服从层次', () => {
  test('import 逐条钉住；application 不取 infrastructure 与 composition，infrastructure 不取 composition；进程全局只有原有的', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect([location, layerFindings(path, text(path))]).toEqual([location, []])
      expect([location, processGlobals(path, text(path))]).toEqual([
        location,
        [...(GLOBALS[location] ?? [])],
      ])
    }
  })

  test('负对照：越层、别的模块内部、组合文件与进程全局都会被认出；本模块 required-ports 只放给 application', () => {
    const application = sourceOf(VIEW)
    const applicationSource = [
      `import type { A } from '../infrastructure/authoringStore'`,
      `import { b } from '../composition'`,
      `import type { C } from '../composition/required-ports'`,
      `import type { D } from '@/modules/identity-access/application/operationContext'`,
      `import type { E } from '@/modules/identity-access/public/participants'`,
      `export const at = () => [Date.now(), process.env, b]`,
    ].join('\n')
    expect(layerFindings(application, applicationSource)).toEqual([
      'import ../infrastructure/authoringStore',
      'import ../composition',
      'import @/modules/identity-access/application/operationContext',
    ])
    expect(processGlobals(application, applicationSource)).toEqual(['Date.now', 'process.env'])
    const infrastructure = sourceOf(MODULE)
    expect(
      layerFindings(
        infrastructure,
        [
          `import { a } from '../composition'`,
          `import type { B } from '../composition/required-ports'`,
          `import { TaskClaimGate } from '../application/taskClaimGate'`,
          `import { c } from '@/modules/source-control/infrastructure/workspace'`,
          `export const at = () => import('../composition/taskEngineApplication')`,
        ].join('\n'),
      ),
    ).toEqual([
      'import ../composition',
      'import ../composition/required-ports',
      'import @/modules/source-control/infrastructure/workspace',
      'import() ../composition/taskEngineApplication',
    ])
  })
})

describe('RFC-517 ④ 行为', () => {
  test('平台清单参与者：按授权面过滤、按语言取文本、按名字与 id 排序，工具按 id 去重', async () => {
    const typeRef = { typeId: 'dev', revision: 2 }
    const filtered: unknown[] = []
    const row = (id: string, extra: Record<string, unknown>) => ({
      id,
      typeRef,
      ownerUserId: 'u',
      visibility: 'public',
      ...extra,
    })
    const participant = composeDigitalEmployeePlatformInventoryParticipant({
      queries: {
        listEmployees: async () => [
          row('e2', { name: 'beta' }),
          row('e1', { name: 'alpha' }),
          row('e0', { name: 'hidden', ownerUserId: 'x', visibility: 'private' }),
        ],
        listTypes: async () => [
          {
            typeRef,
            authoringManifest: { workItems: [{ workItemRef: 'w1' }, { workItemRef: 'w2' }] },
          },
        ],
        listJobTemplates: async () => [
          row('j2', { name: 'job', draft: { description: '' } }),
          row('j1', { name: 'job', draft: { description: { 'zh-CN': '中文', en: 'English' } } }),
        ],
        listTools: async (_typeRef: unknown, workItemRef: string) => [
          row('shared', {
            workItemRef: 'w1',
            origin: 'platform',
            content: { displayName: { en: 'Shared' }, description: null },
          }),
          row(`only-${workItemRef}`, {
            workItemRef,
            origin: 'custom',
            content: { displayName: '', description: 'custom text' },
          }),
        ],
      } as never,
      access: {
        async filterVisibleRows(
          authority: { readonly userId: string },
          type: string,
          rows: readonly {
            readonly id: string
            readonly ownerUserId: string | null
            readonly visibility: string
          }[],
        ) {
          filtered.push([type, rows.map((item) => item.id)])
          return rows.filter(
            (item) => item.visibility === 'public' || item.ownerUserId === authority.userId,
          )
        },
      } as never,
    })
    const authority = { source: 'session', userId: 'u' } as never
    expect(await participant.listVisibleRows('employee_definition', authority)).toEqual([
      { id: 'e1', name: 'alpha', description: 'type dev@2' },
      { id: 'e2', name: 'beta', description: 'type dev@2' },
    ])
    expect(await participant.listVisibleRows('employee_job_template', authority)).toEqual([
      { id: 'j1', name: 'job', description: 'English' },
      { id: 'j2', name: 'job', description: 'type dev@2' },
    ])
    expect(await participant.listVisibleRows('employee_tool', authority)).toEqual([
      { id: 'only-w1', name: 'only-w1', description: 'custom text (w1)' },
      { id: 'only-w2', name: 'only-w2', description: 'custom text (w2)' },
      { id: 'shared', name: 'Shared', description: 'platform tool (w1)' },
    ])
    expect(filtered).toEqual([
      ['employee_definition', ['e2', 'e1', 'e0']],
      ['employee_job_template', ['j2', 'j1']],
      ['employee_tool', ['shared', 'only-w1', 'only-w2']],
    ])
  })

  test('员工定义视图：版本、工作范围与岗位版本缺一即抛原文错误；齐全时记下每个绑定的来源', async () => {
    const binding = (laneId: string, slotRef: string) => ({
      laneId,
      slotRef,
      adapterRef: `${laneId}/${slotRef}`,
    })
    const record = {
      id: 'emp-1',
      name: 'Employee',
      typeRef: { typeId: 'dev', revision: 1 },
      configuration: {
        jobTemplateRef: { id: 'job', revision: 3 },
        adapterOverrides: [binding('l1', 's1')],
      },
      currentRevision: 2,
      ownerUserId: 'u',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 2,
    }
    const revision = {
      content: {
        workScopeRef: { id: 'scope', revision: 1 },
        exactAdapterBindings: [binding('l1', 's1'), binding('l2', 's2')],
      },
    }
    const reads: unknown[] = []
    const store = (overrides: Record<string, unknown> = {}) =>
      ({
        async getEmployeeDefinitionRevision(ref: unknown) {
          reads.push(['definition', ref])
          return revision
        },
        async getWorkScopeRevision(ref: unknown) {
          reads.push(['scope', ref])
          return { encodedScope: 'scope-document' }
        },
        async getJobTemplateRevision(ref: unknown) {
          reads.push(['job', ref])
          return { content: { defaultAdapterBindings: [binding('l2', 's2')] } }
        },
        ...overrides,
      }) as never
    const view: unknown = await createEmployeeDefinitionViewProjection(store())(record as never)
    expect(view).toEqual({
      id: 'emp-1',
      name: 'Employee',
      typeRef: record.typeRef,
      configuration: record.configuration,
      revision: 2,
      definition: revision.content,
      inheritedAdapterBindings: [binding('l2', 's2')],
      adapterBindingSources: [
        { ...binding('l1', 's1'), source: 'employee-override' },
        { ...binding('l2', 's2'), source: 'job-default' },
      ],
      workScope: 'scope-document',
      ownerUserId: 'u',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 2,
    })
    expect(reads).toEqual([
      ['definition', { id: 'emp-1', revision: 2 }],
      ['scope', revision.content.workScopeRef],
      ['job', record.configuration.jobTemplateRef],
    ])
    const missing = async () => null
    for (const [overrides, input, message] of [
      [{}, { ...record, currentRevision: null }, 'employee has no current revision: emp-1'],
      [{ getEmployeeDefinitionRevision: missing }, record, 'employee revision is missing: emp-1'],
      [{ getWorkScopeRevision: missing }, record, 'employee work scope is missing: emp-1'],
      [{ getJobTemplateRevision: missing }, record, 'employee job revision is missing: emp-1'],
    ] as const)
      await expect(
        createEmployeeDefinitionViewProjection(store(overrides))(input as never),
      ).rejects.toThrow(message)
  })

  test('schema 计划核对：计划属于契约时放行，不属于时抛原文错误', () => {
    expect(() =>
      requireSchemaPlanForContract({ contractDigest: 'd1' } as never, { digest: 'd1' } as never),
    ).not.toThrow()
    expect(() =>
      requireSchemaPlanForContract({ contractDigest: 'd1' } as never, { digest: 'd2' } as never),
    ).toThrow('postgresql-system-operations-schema-plan-mismatch')
  })

  test('暂存还原：无论成败都释放这次上传的工件，结果与错误照传', async () => {
    const released: unknown[] = []
    const artifacts = { release: (ref: never) => void released.push(ref) }
    const staged = releaseArtifactAfterStageRestore(
      {
        execute: async (_context: unknown, input: { artifactRef: string }) => ({
          staged: input.artifactRef,
        }),
      } as never,
      artifacts,
    )
    expect(Object.isFrozen(staged)).toBe(true)
    const result: unknown = await staged.execute(
      {} as never,
      { artifactRef: 'artifact-1' } as never,
    )
    expect(result).toEqual({
      staged: 'artifact-1',
    })
    const failing = releaseArtifactAfterStageRestore(
      {
        execute: async () => {
          throw new Error('rfc517-stage-failed')
        },
      } as never,
      artifacts,
    )
    await expect(
      failing.execute({} as never, { artifactRef: 'artifact-2' } as never),
    ).rejects.toThrow('rfc517-stage-failed')
    expect(released).toEqual(['artifact-1', 'artifact-2'])
  })

  test('文件库启动准备：新装成功与失败之后升级锁都不再被占', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc517-boot-'))
    try {
      const lockPath = join(home, '.daemon.lock')
      const input = (dir: string) => ({
        config: { provider: 'sqlite' as const },
        contract: logicalSchemaContract,
        sqlitePath: join(dir, 'db.sqlite'),
        generationPointerPath: join(dir, 'database-generation.json'),
        operationsRoot: join(dir, 'database-migrations'),
        lockPath,
        sqliteOptions: {},
        backupOnMigration: false,
      })
      const prepared = await prepareFileDatabaseProviderForBoot(input(home))
      try {
        expect(prepared.runtime.provider).toBe('sqlite')
      } finally {
        await prepared.runtime.close()
      }
      acquireLock(lockPath).release()
      const broken = join(home, 'broken')
      mkdirSync(broken)
      writeFileSync(join(broken, 'database-generation.json'), 'not a generation pointer')
      await expect(prepareFileDatabaseProviderForBoot(input(broken))).rejects.toThrow()
      acquireLock(lockPath).release()
    } finally {
      removeTempDirSync(home)
    }
  })

  test('任务执行模块：认领失败时退还许可并重抛；暂停与销毁缺理由时拒绝；销毁后不再认领', async () => {
    const failing = new ProviderTaskExecutionModule('rfc517-provider', {
      ownership: {
        claimPendingIntent: async () => {
          throw new Error('rfc517-claim-failed')
        },
      },
    } as never)
    await expect(failing.claimPersisted({ intentId: 'intent-1' })).rejects.toThrow(
      'rfc517-claim-failed',
    )
    expect(() => failing.resetForTesting()).not.toThrow()
    const module = new TaskExecutionModule('rfc517-module')
    await expect(module.pause('')).rejects.toThrow('task execution module pause requires a reason')
    await expect(module.dispose('')).rejects.toThrow(
      'task execution module disposal requires a reason',
    )
    expect(await module.pause('freeze')).toEqual([])
    expect(module.claimGate.isPaused).toBe(true)
    module.resume()
    expect(module.claimGate.isPaused).toBe(false)
    expect(await module.dispose('stop')).toEqual([])
    expect(module.claimGate.isSealed).toBe(true)
    await expect(module.claim({ db: {} as never, intentId: 'intent-2' })).rejects.toThrow(
      'task execution admission is sealed for daemon shutdown',
    )
  })

  test('关停控制器：无预算时直接中止，有预算时等销毁完成；都封闭模块并交回仍活着的任务', async () => {
    for (const budgetMs of [0, 50]) {
      const module = new TaskExecutionModule(`rfc517-shutdown-${budgetMs}`)
      const controller = createTaskExecutionShutdownController(module)
      expect(await controller.shutdownActive('rfc517-stop', budgetMs)).toEqual([])
      expect([budgetMs, module.claimGate.isSealed]).toEqual([budgetMs, true])
    }
  })
})
