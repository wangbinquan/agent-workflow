// RFC-514 — 任务执行组合层余下的 try / throw 迁出 composition（RFC-294 S10 第二十一步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；两个新文件恰好声明、交出清单列的名字。
// ② task-execution `composition/` 目录的每个文件没有 `try` / `throw`、不构造错误；四个名字在生产代码里只被预期的组合文件调用，实参钉住（带负
//    对照）。
// ③ 两个新文件的依赖面是闭集（import 逐条钉住），不用进程全局（带负对照）。
// ④ 行为：驱动在执行上下文里（或外）跑控制面，端口在控制面启动时才构造，成功、抛错与端口构造抛错时都回收两项登记；三处 fail-closed 的接受、
//    拒绝与原文错误。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读 task-execution `composition/` 目录的全部文件与新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { cancelAndReadTask } from '@/modules/task-execution/application/digitalEmployeeExecution'
import { requireDynamicWorkflowOperations } from '@/modules/task-execution/application/dynamicWorkflowOperations'
import { createTaskRunConfigurationReferences } from '@/modules/task-execution/application/taskRunSelection'
import { driveTaskRun } from '@/modules/task-execution/engine/task/driveTaskRun'
import { NotFoundError } from '@/util/errors'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const TE = 'modules/task-execution'
const DRIVE = `${TE}/engine/task/driveTaskRun`
const DW_OPS = `${TE}/application/dynamicWorkflowOperations`
const RUN_SELECTION = `${TE}/application/taskRunSelection`
const EMPLOYEE = `${TE}/application/digitalEmployeeExecution`
const root = (name: string) => `${TE}/composition/${name}`
/** design §3: every listed name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = [
  [DRIVE, 'driveTaskRun'],
  [DW_OPS, 'requireDynamicWorkflowOperations'],
  [RUN_SELECTION, 'createTaskRunConfigurationReferences'],
  [EMPLOYEE, 'cancelAndReadTask'],
]
const NEW_FILES: Readonly<Record<string, readonly string[]>> = {
  [DRIVE]: ['driveTaskRun'],
  [DW_OPS]: ['requireDynamicWorkflowOperations'],
}
/** design §4 ③: the exact imports of the two new files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [DRIVE]: [
    `import ${TE}/application/ports/taskRun: TaskRunPorts`,
    `import ${TE}/application/ports/taskExecutionPermits: TaskExecutionPermitRegistry`,
    `import ${TE}/application/ports/taskExecutionTopology: TaskExecutionContextRef`,
    `import ${TE}/application/taskExecutionContext: runWithTaskExecutionContext`,
    `import ${TE}/engine/task/runTask: runTask`,
  ],
  [DW_OPS]: [],
}
/** The new files take only this module's engine and application code (no infrastructure, no composition). */
const SAME_MODULE = (file: string, specifier: string): boolean => {
  const resolved = resolveSpecifier(file, specifier) ?? specifier
  return (
    resolved.startsWith(`${TE}/`) &&
    !/\/(infrastructure|composition)\//.test(`${resolved}/`) &&
    !resolved.endsWith('/composition')
  )
}
/** The production calls of every listed name (file and count) and, where short, the arguments (RFC-530: task routes). */
const CALLS: Readonly<
  Record<string, readonly [readonly string[], readonly (readonly string[])[] | null]>
> = {
  driveTaskRun: [[`${root('taskEngineApplication')} x1`], null],
  requireDynamicWorkflowOperations: [
    [`${root('taskEngineApplication')} x1`],
    [['opts.dynamicWorkflow']],
  ],
  createTaskRunConfigurationReferences: [[`${root('localTaskRunSelection')} x1`], [[]]],
  cancelAndReadTask: [[`${TE}/infrastructure/taskRouteOperations x1`], null],
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

/** Imports outside the surface and process globals, read from the syntax tree. */
function purityFindings(
  file: string,
  source: string,
  allowed: (file: string, specifier: string) => boolean,
): string[] {
  const findings: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !allowed(file, node.moduleSpecifier.text)
    )
      findings.push(`import ${node.moduleSpecifier.text}`)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      !allowed(file, node.arguments[0].text)
    )
      findings.push(`import() ${node.arguments[0].text}`)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (['process', 'Bun', 'globalThis', 'crypto'].includes(node.expression.text) ||
        (node.expression.text === 'Date' && node.name.text === 'now') ||
        (node.expression.text === 'Math' && node.name.text === 'random'))
    )
      findings.push(`${node.expression.text}.${node.name.text}`)
    if (ts.isIdentifier(node) && ['randomUUID', 'fetch', 'ulid'].includes(node.text))
      findings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
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

/** What design §3 forbids in the composition directory (branches stay: they are assembly-time selections). */
const forbidden = (path: string) =>
  checkShapes(path, text(path)).filter(
    (shape) => shape === 'try' || shape === 'throw' || shape.endsWith('Error'),
  )

describe('RFC-514 ① 清单里的名字只在各自的位置声明', () => {
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
      expect(LISTED).toHaveLength(4)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('两个新文件恰好声明、交出清单列的名字；增名字的两个文件交出它们', () => {
    for (const [location, names] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path))]).toEqual([location, [...names]])
      expect([location, offeredNames(path, text(path))]).toEqual([location, [...names]])
    }
    for (const [location, name] of [
      [RUN_SELECTION, 'createTaskRunConfigurationReferences'],
      [EMPLOYEE, 'cancelAndReadTask'],
    ] as const) {
      const path = sourceOf(location)
      expect(offeredNames(path, text(path))).toContain(name)
    }
  })
})

describe('RFC-514 ② composition 只装配', () => {
  test('task-execution composition/ 目录的每个文件没有 try / throw、不构造错误', () => {
    const dir = join(SRC, TE, 'composition')
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(dir, name))
    expect(files.length).toBeGreaterThanOrEqual(90)
    const found = files.flatMap((path) =>
      forbidden(path).map((shape) => `${srcPath(path)}: ${shape}`),
    )
    expect(found).toEqual([])
  })

  test(
    '四个名字在生产代码里只被预期的组合文件调用，短实参钉住',
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
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：组合层里的 try、throw 与错误的构造都会被认出，分支不算', () => {
    const probe = join(SRC, TE, 'composition', 'probe.ts')
    const source = [
      `export async function drive(run: () => Promise<void>, gc: () => void, x?: object) {`,
      `  if (x === undefined) throw new Error('dynamic-workflow-operations-not-composed')`,
      `  try { await run() } finally { gc() }`,
      `}`,
    ].join('\n')
    expect(checkShapes(probe, source)).toEqual(['if', 'throw', 'Error', 'try'])
    expect(
      checkShapes(probe, source).filter(
        (shape) => shape === 'try' || shape === 'throw' || shape.endsWith('Error'),
      ),
    ).toEqual(['throw', 'Error', 'try'])
  })
})

describe('RFC-514 ③ 新文件的依赖面是闭集、不用进程全局', () => {
  test('import 逐条钉住；只取本模块的 engine 与 application；不用进程全局', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect(purityFindings(path, text(path), SAME_MODULE), location).toEqual([])
    }
  })

  test('负对照：基础设施、组合层、别的模块与进程全局都会被认出', () => {
    const file = sourceOf(DRIVE)
    const source = [
      `import { runTask } from './runTask'`,
      `import { withTaskReviewMutationLock } from '../../infrastructure/reviewMutationQueue'`,
      `import { createTaskRunPorts } from '../../composition/taskEngineApplication'`,
      `import type { PersistenceDb } from '@/platform/persistence/persistenceDb'`,
      `export const at = () => [Date.now(), process.env, runTask, withTaskReviewMutationLock, createTaskRunPorts]`,
    ].join('\n')
    expect(purityFindings(file, source, SAME_MODULE)).toEqual([
      'import ../../infrastructure/reviewMutationQueue',
      'import ../../composition/taskEngineApplication',
      'import @/platform/persistence/persistenceDb',
      'Date.now',
      'process.env',
    ])
  })
})

// ④ Behaviour, through the new locations.

function permits(calls: string[]) {
  return {
    gcTaskWriteSem: (taskId: string) => void calls.push(`gc write ${taskId}`),
    gcTaskFanoutSem: (taskId: string) => void calls.push(`gc fanout ${taskId}`),
  }
}
/** Ports on which the control plane finds no task and returns (engine/task/runTask.ts). */
function missingTaskPorts(calls: string[]) {
  return {
    taskId: 'task-1',
    log: { error: (message: string) => void calls.push(`log ${message}`) },
    persistence: {
      drive: {
        load: async (taskId: string) => {
          calls.push(`load ${taskId}`)
          return null
        },
      },
    },
  } as never
}
const rejection = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (error: unknown) => error,
  )

describe('RFC-514 ④ 驱动', () => {
  test('不带执行上下文：端口在控制面启动时才构造，跑完回收两项登记', async () => {
    const calls: string[] = []
    const drive = driveTaskRun({
      taskId: 'task-1',
      executionContext: undefined,
      executionPermits: permits(calls),
      ports: () => {
        calls.push('ports')
        return missingTaskPorts(calls)
      },
    })
    await drive
    expect(calls).toEqual([
      'ports',
      'load task-1',
      'log runTask: task not found',
      'gc write task-1',
      'gc fanout task-1',
    ])
  })

  test('带执行上下文：先核对上下文；不受信的上下文原样拒绝、不构造端口，仍回收两项登记', async () => {
    const calls: string[] = []
    const error = await rejection(() =>
      driveTaskRun({
        taskId: 'task-2',
        executionContext: { token: {} } as never,
        executionPermits: permits(calls),
        ports: () => {
          calls.push('ports')
          return missingTaskPorts(calls)
        },
      }),
    )
    expect((error as Error).message).toBe('untrusted-task-execution-context')
    expect(calls).toEqual(['gc write task-2', 'gc fanout task-2'])
  })

  test('端口构造抛错时原样拒绝，仍回收两项登记', async () => {
    const calls: string[] = []
    const thrown = new Error('ports-failed')
    const error = await rejection(() =>
      driveTaskRun({
        taskId: 'task-3',
        executionContext: undefined,
        executionPermits: permits(calls),
        ports: () => {
          throw thrown
        },
      }),
    )
    expect(error).toBe(thrown)
    expect(calls).toEqual(['gc write task-3', 'gc fanout task-3'])
  })
})

describe('RFC-514 ④ 三处 fail-closed', () => {
  test('动态工作流操作：交入的原样返回，缺省时抛原文错误', () => {
    const operations = { persistence: {}, validation: {} }
    expect(requireDynamicWorkflowOperations(operations)).toBe(operations)
    expect(() => requireDynamicWorkflowOperations(undefined)).toThrow(
      new Error('dynamic-workflow-operations-not-composed'),
    )
  })

  test('配置引用：每次登记一个新的冻结引用、找回原请求；未登记的引用与别的登记表都找不回', () => {
    const references = createTaskRunConfigurationReferences()
    const request = { taskId: 'task-1' } as never
    const configuration = references.configurationFor(request)
    expect(configuration.kind).toBe('task-run-configuration')
    expect(Object.isFrozen(configuration)).toBe(true)
    expect(Object.isFrozen(configuration.reference)).toBe(true)
    expect(references.configurationFor(request).reference).not.toBe(configuration.reference)
    expect(references.requestFor({ configuration } as never)).toBe(request)
    for (const unknown of [
      { configuration: { kind: 'task-run-configuration', reference: Object.freeze({}) } },
      { configuration },
    ]) {
      const owner =
        unknown.configuration === configuration
          ? createTaskRunConfigurationReferences()
          : references
      expect(() => owner.requestFor(unknown as never)).toThrow(
        new Error('local-task-run-configuration-unavailable'),
      )
    }
  })

  test('取消后读回：先取消、再读；读到即返回，读不到是 404；取消失败时不读', async () => {
    const calls: string[] = []
    const steps = (found: boolean) => ({
      cancel: async (taskId: string) => void calls.push(`cancel ${taskId}`),
      read: async (taskId: string) => (calls.push(`read ${taskId}`), found ? { id: taskId } : null),
    })
    expect(await cancelAndReadTask(steps(true), 'task-1')).toEqual({ id: 'task-1' })
    const missing = await rejection(() => cancelAndReadTask(steps(false), 'task-2'))
    expect(missing).toBeInstanceOf(NotFoundError)
    expect({
      code: (missing as NotFoundError).code,
      status: (missing as NotFoundError).status,
      message: (missing as Error).message,
    }).toEqual({ code: 'task-not-found', status: 404, message: "task 'task-2' not found" })
    const failure = new Error('cancel-failed')
    const failed = await rejection(() =>
      cancelAndReadTask(
        {
          cancel: async () => {
            throw failure
          },
          read: async () => (calls.push('read after failure'), null),
        },
        'task-3',
      ),
    )
    expect(failed).toBe(failure)
    expect(calls).toEqual(['cancel task-1', 'read task-1', 'cancel task-2', 'read task-2'])
  })
})
