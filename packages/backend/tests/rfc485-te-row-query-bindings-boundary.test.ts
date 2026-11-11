// RFC-485 — collaboration 与 memory 取 task-execution 的三个行形状查询工厂改经装配期注入（RFC-294 S9 第四步）。
//
// 锁五件事：
// ① task-execution 的 public 文件不导出 `createNodeRunQueries`、`createTaskGateQueries`、`createNodeOutputQueries` 与只经它们可达的全量接口名
//    `NodeRunQueries`、`NodeOutputQueries`、`NodeOutputContent`（转出与本地声明、值与类型都认；带正对照）；`TaskGateQueries` 只从 `public/types`
//    交出。
// ② collaboration 与 memory 的全部生产文件不从 task-execution 的任何入口取这三个工厂（命名 import、别名、相对路径、命名空间成员与 re-export
//    都认；带负对照）。
// ③ `TaskExecutionParticipantBindings` 有这三个成员，bootstrap 的 `composeTaskExecutionParticipantBindings` 取自 task-execution 的 composition；
//    memory 的装配输入有两个读取端口，bootstrap 的 memory 模块用 task-execution 的 composition 工厂建它们。
// ④ `TaskNodeRunReads`、`TaskNodeOutputReads` 是只有方法签名的闭合接口（方法集合逐个钉住），从 `public/types` 交出，`NodeRunQueries` /
//    `NodeOutputQueries` extends 它们。
// ⑤ 开门参与者的 node-run 读取由 task-execution 按事务交入（`HumanGateOpenParticipantScope.inTransaction` 的参与者有 `nodeRuns`）。
// 行为：经绑定构造的 task-gate 读取与 task-execution composition 直接构造的读到相同的任务上下文（双引擎）。
//
// 覆盖范围（C12）：① 覆盖 task-execution 的全部 public 文件；② 覆盖 collaboration 与 memory 的全部生产文件；③～⑤ 读指定文件。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describeEachProvider } from './helpers/eachProvider'
import { freshTaskId, seedTask } from './helpers/questionDispatchFixture'
import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import { createTaskGateQueries } from '@/modules/task-execution/composition'

const SRC = resolve(import.meta.dir, '..', 'src')
const TE = 'modules/task-execution/'
const CO = 'modules/collaboration/'
const ME = 'modules/memory/'
const FACTORIES = [
  'createNodeRunQueries',
  'createTaskGateQueries',
  'createNodeOutputQueries',
] as const
const WITHDRAWN_TYPES = ['NodeRunQueries', 'NodeOutputQueries', 'NodeOutputContent'] as const
const NODE_RUN_READS = [
  'humanGateProjection',
  'latestHistoryPerNode',
  'list',
  'listDispatchFacts',
  'listFields',
  'listHistory',
  'listHistoryDispatchFacts',
  'listHistoryFields',
  'listWithCheckpoints',
  'read',
  'readFields',
  'readWithCheckpoints',
]
const NODE_OUTPUT_READS = ['listActiveContents', 'listPorts', 'readPort', 'runsWithOutput']
const slash = (path: string) => path.split('\\').join('/')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** Every name a module exports: local declarations, `export { a as b }`, re-exports (value and type). */
function exportedNames(path: string, text: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, text).statements) {
    const exported = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements) names.push(element.name.text)
    } else if (
      exported &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text)
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
    }
  }
  return names
}

/** Resolve a specifier to a `src/`-relative stem (alias and relative forms), or null. */
function targetOf(fromSrcRelative: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return specifier.slice(2).replace(/\.[cm]?tsx?$/, '')
  if (!specifier.startsWith('.')) return null
  const rel = slash(relative(SRC, resolve(SRC, fromSrcRelative, '..', specifier)))
  return rel.startsWith('..') ? null : rel.replace(/\.[cm]?tsx?$/, '')
}

/** `file: name` for every factory a non-task-execution file takes from a task-execution entry. */
function factoryTakes(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const offenders: string[] = []
  const isFactory = (name: string) => (FACTORIES as readonly string[]).includes(name)
  for (const { path, text } of files) {
    const source = parse(path, text)
    const namespaces = new Set<string>()
    const fromTe = (specifier: ts.Expression | undefined) =>
      specifier !== undefined &&
      ts.isStringLiteral(specifier) &&
      (targetOf(path, specifier.text)?.startsWith(TE) ?? false)
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && fromTe(statement.moduleSpecifier)) {
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text
            if (isFactory(imported)) offenders.push(`${path}: ${imported}`)
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      }
      if (
        ts.isExportDeclaration(statement) &&
        fromTe(statement.moduleSpecifier) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (isFactory(imported)) offenders.push(`${path}: ${imported}`)
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        isFactory(node.name.text)
      )
        offenders.push(`${path}: ${node.name.text}`)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return offenders
}

const productionFiles = (dir: string) =>
  walk(join(SRC, dir)).map((path) => ({
    path: slash(relative(SRC, path)),
    text: readFileSync(path, 'utf8'),
  }))

function interfaceDeclaration(path: string, name: string): ts.InterfaceDeclaration {
  const found = parse(path, read(path)).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (found === undefined) throw new Error(`interface ${name} not found in ${path}`)
  return found
}
const memberName = (member: ts.TypeElement) =>
  member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    ? member.name.text
    : '?'
const namesImportedFrom = (path: string, specifier: string) =>
  parse(path, read(path))
    .statements.filter(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === specifier,
    )
    .flatMap((statement) => {
      const bindings = statement.importClause?.namedBindings
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => element.name.text)
        : []
    })

describe('RFC-485 —— task-execution 的 public 撤出三个工厂', () => {
  test('task-execution 的 public 文件不导出三个工厂与只经它们可达的全量接口名', () => {
    const publicFiles = walk(join(SRC, TE, 'public')).map((path) => slash(relative(SRC, path)))
    expect(publicFiles.length).toBeGreaterThanOrEqual(5)
    const exported = publicFiles.flatMap((path) =>
      exportedNames(path, read(path)).map((name) => ({ path, name })),
    )
    // 正对照：判据认得出新交出的闭合接口与留在 public 的行形状类型。
    for (const name of ['TaskNodeRunReads', 'TaskNodeOutputReads', 'NodeRunFactSnapshot'])
      expect(
        exported.some((entry) => entry.name === name),
        name,
      ).toBe(true)
    expect(
      exported.filter(({ name }) =>
        [...FACTORIES, ...WITHDRAWN_TYPES].includes(name as (typeof FACTORIES)[number]),
      ),
    ).toEqual([])
    expect(
      exported.filter(({ name }) => name === 'TaskGateQueries').map(({ path }) => path),
    ).toEqual([`${TE}public/types.ts`])
  })
})

describe('RFC-485 —— collaboration 与 memory 改经装配期注入', () => {
  test('collaboration 与 memory 的全部生产文件不从 task-execution 的任何入口取这三个工厂', () => {
    const collaboration = productionFiles(CO)
    const memory = productionFiles(ME)
    expect(collaboration.length).toBeGreaterThanOrEqual(150)
    expect(memory.length).toBeGreaterThanOrEqual(20)
    expect(factoryTakes([...collaboration, ...memory])).toEqual([])
  })

  test('负对照：判据认得出命名 import、别名、相对路径、命名空间成员与 re-export', () => {
    const at = `${ME}infrastructure/probe.ts`
    expect(
      factoryTakes([
        {
          path: at,
          text: "import { createNodeRunQueries } from '@/modules/task-execution/public/queries'",
        },
        {
          path: at,
          text: "import { createTaskGateQueries as gates } from '@/modules/task-execution/composition'",
        },
        {
          path: at,
          text: "import { createNodeOutputQueries } from '../../task-execution/infrastructure/nodeOutputQueries'",
        },
        {
          path: at,
          text: "import * as TE from '@/modules/task-execution/composition'\nTE.createNodeRunQueries(db)",
        },
        {
          path: at,
          text: "export { createTaskGateQueries } from '@/modules/task-execution/infrastructure/taskGateQueries'",
        },
        {
          path: at,
          text: "import { createNodeRunQueries } from '@/modules/collaboration/composition'",
        },
      ]),
    ).toEqual([
      `${at}: createNodeRunQueries`,
      `${at}: createTaskGateQueries`,
      `${at}: createNodeOutputQueries`,
      `${at}: createNodeRunQueries`,
      `${at}: createTaskGateQueries`,
    ])
  })

  test('绑定有三个成员、取自 task-execution 的 composition；memory 的装配输入有两个读取端口', () => {
    const members = interfaceDeclaration(
      `${CO}infrastructure/taskExecutionParticipantBindings.ts`,
      'TaskExecutionParticipantBindings',
    ).members.map(memberName)
    for (const name of FACTORIES) expect(members, name).toContain(name)
    const closure = 'bootstrap/crossContextClosure.ts'
    const fromComposition = namesImportedFrom(closure, '@/modules/task-execution/composition')
    for (const name of FACTORIES) expect(fromComposition, name).toContain(name)
    const composer = parse(closure, read(closure)).statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === 'composeTaskExecutionParticipantBindings',
    )
    expect(composer).toBeDefined()
    const handed: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isShorthandPropertyAssignment(node)) handed.push(node.name.text)
      ts.forEachChild(node, visit)
    }
    visit(composer!)
    for (const name of FACTORIES) expect(handed, name).toContain(name)

    const options = interfaceDeclaration(`${ME}composition.ts`, 'ComposeMemoryOperationsOptions')
    const optionTypes = Object.fromEntries(
      options.members
        .filter(ts.isPropertySignature)
        .map((member) => [memberName(member), member.type?.getText() ?? '']),
    )
    expect(optionTypes.taskNodeRuns).toBe('TaskNodeRunReads')
    expect(optionTypes.taskNodeOutputs).toBe('TaskNodeOutputReads')
    const memoryModule = 'bootstrap/daemonModules/memory.ts'
    expect(namesImportedFrom(memoryModule, '@/modules/task-execution/composition')).toEqual(
      expect.arrayContaining(['createNodeRunQueries', 'createNodeOutputQueries']),
    )
  })
})

describe('RFC-485 —— 只交出模块外用到的读取', () => {
  test('两个闭合读取接口只有方法签名、方法集合逐个钉住，全量接口 extends 它们，从 public/types 交出', () => {
    for (const [path, closed, full, methods] of [
      [
        `${TE}application/ports/nodeRunQueries.ts`,
        'TaskNodeRunReads',
        'NodeRunQueries',
        NODE_RUN_READS,
      ],
      [
        `${TE}application/ports/nodeOutputQueries.ts`,
        'TaskNodeOutputReads',
        'NodeOutputQueries',
        NODE_OUTPUT_READS,
      ],
    ] as const) {
      const reads = interfaceDeclaration(path, closed)
      expect(reads.heritageClauses ?? [], closed).toEqual([])
      expect(
        reads.members.every((member) => ts.isMethodSignature(member)),
        closed,
      ).toBe(true)
      expect(reads.members.map(memberName).sort(), closed).toEqual([...methods].sort())
      const heritage = (interfaceDeclaration(path, full).heritageClauses ?? []).flatMap((clause) =>
        clause.types.map((type) => type.expression.getText()),
      )
      expect(heritage, full).toEqual([closed])
    }
    const types = exportedNames(`${TE}public/types.ts`, read(`${TE}public/types.ts`))
    for (const name of ['TaskNodeRunReads', 'TaskNodeOutputReads', 'TaskGateQueries'])
      expect(types, name).toContain(name)
  })

  test('开门参与者的 node-run 读取由 task-execution 按事务交入', () => {
    const scope = interfaceDeclaration(
      `${TE}application/ports/humanGateOpenFactory.ts`,
      'HumanGateOpenParticipantScope',
    )
    expect(scope.getText()).toContain('readonly nodeRuns: TaskNodeRunReads')
    expect(read(`${TE}infrastructure/humanGateTaskLifecyclePersistence.ts`)).toContain(
      'nodeRuns: createNodeRunQueries(tx),',
    )
    const participant = read(`${CO}infrastructure/humanGateOpenParticipant.ts`)
    expect(participant).toContain('private readonly nodeRuns: TaskNodeRunReads')
    expect(participant).not.toContain('createNodeRunQueries')
  })
})

describeEachProvider('RFC-485 —— 经绑定的读取', (harness) => {
  test('经绑定构造的 task-gate 读取与 composition 直接构造的读到相同的任务上下文', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const viaBindings = await taskExecutionParticipants
      .createTaskGateQueries(db)
      .listContexts([taskId])
    const direct = await createTaskGateQueries(db).listContexts([taskId])
    expect(viaBindings.map((row) => row.id)).toEqual([taskId])
    expect(viaBindings).toEqual(direct)
  })
})
