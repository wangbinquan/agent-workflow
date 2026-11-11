// RFC-482 — collaboration 取 task-execution 的事务参与者与三个小查询改经装配期绑定（RFC-294 S9 第三步）。
//
// 锁六件事：
// ① task-execution 的 public 文件不导出 `createHumanGatePersistenceParticipantInTx`、`createConsumedInputsParticipantInTx`、
//    `createTaskClarifyDirectivePersistence`、`createTaskSubjectQueries`、`createRunSelectionReader` 与 `reselectRunInTx`（转出与本地声明、
//    值与类型都认；带正对照）。
// ② collaboration 的全部生产文件不从 task-execution 的任何入口取这六个名字（命名 import、命名空间成员与 re-export 都认；带负对照）。
// ③ `TaskExecutionParticipantBindings` 有五个工厂成员；bootstrap 的 `composeTaskExecutionParticipantBindings` 把它们取自 task-execution 的
//    composition。
// ④ 源码里不再声明 `reselectRunInTx`；collaboration 的 `infrastructure/taskClarifyDirective.ts` 不在。
// ⑤ `CollaborationRuntimeMechanics` 没有 `getNodeClarifyDirective`；task-execution 的两处引擎端口接持久化包的 `clarifyDirectives`，持久化包
//    用 `createTaskClarifyDirectivePersistence` 填它。
// ⑥ `TaskRunSelectionReads` 是只有方法签名的闭合接口，从 `public/types` 交出，表读取器 `extends` 它。
// 行为：持久化包的 `clarifyDirectives.get` 读到指令持久化写入的值，无行时为 undefined（双引擎）。
//
// 覆盖范围（C12）：① 覆盖 task-execution 的全部 public 文件；② 覆盖 collaboration 的全部生产文件；③～⑥ 读指定文件。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describeEachProvider } from './helpers/eachProvider'
import { freshTaskId, seedTask } from './helpers/questionDispatchFixture'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports } from './helpers/o2Closure'
import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { createTaskClarifyDirectivePersistence } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'

const SRC = resolve(import.meta.dir, '..', 'src')
const TE = 'modules/task-execution/'
const CO = 'modules/collaboration/'
const WITHDRAWN = [
  'createHumanGatePersistenceParticipantInTx',
  'createConsumedInputsParticipantInTx',
  'createTaskClarifyDirectivePersistence',
  'createTaskSubjectQueries',
  'createRunSelectionReader',
  'reselectRunInTx',
] as const
const FACTORIES = WITHDRAWN.filter((name) => name !== 'reselectRunInTx')
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

/** `file: name` for every withdrawn name a non-task-execution file takes from a task-execution entry. */
function withdrawnTakes(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const offenders: string[] = []
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
            if ((WITHDRAWN as readonly string[]).includes(imported))
              offenders.push(`${path}: ${imported}`)
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
          if ((WITHDRAWN as readonly string[]).includes(imported))
            offenders.push(`${path}: ${imported}`)
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        (WITHDRAWN as readonly string[]).includes(node.name.text)
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

function interfaceMembers(path: string, name: string): ts.TypeElement[] {
  const found = parse(path, read(path)).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (found === undefined) throw new Error(`interface ${name} not found in ${path}`)
  return [...found.members]
}
const memberName = (member: ts.TypeElement) =>
  member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    ? member.name.text
    : '?'

describe('RFC-482 —— task-execution 的 public 撤出六个符号', () => {
  test('task-execution 的 public 文件不导出这六个名字', () => {
    const publicFiles = walk(join(SRC, TE, 'public')).map((path) => slash(relative(SRC, path)))
    expect(publicFiles.length).toBeGreaterThanOrEqual(5)
    const exported = publicFiles.flatMap((path) =>
      exportedNames(path, read(path)).map((name) => ({ path, name })),
    )
    // 正对照：判据认得出本 RFC 新交出的接口与留在 public 的同族名字。
    expect(exported.some(({ name }) => name === 'TaskRunSelectionReads')).toBe(true)
    expect(exported.some(({ name }) => name === 'prepareConsumedInputs')).toBe(true)
    expect(exported.some(({ name }) => name === 'HumanGatePersistenceParticipantInTx')).toBe(true)
    expect(exported.filter(({ name }) => (WITHDRAWN as readonly string[]).includes(name))).toEqual(
      [],
    )
  })
})

describe('RFC-482 —— collaboration 改经绑定取这五个工厂', () => {
  test('collaboration 的全部生产文件不从 task-execution 的任何入口取这六个名字', () => {
    const files = productionFiles(CO)
    expect(files.length).toBeGreaterThanOrEqual(150)
    expect(withdrawnTakes(files)).toEqual([])
  })

  test('负对照：判据认得出命名 import、别名、相对路径、命名空间成员与 re-export', () => {
    const at = `${CO}infrastructure/probe.ts`
    expect(
      withdrawnTakes([
        {
          path: at,
          text: "import { createRunSelectionReader } from '@/modules/task-execution/public/queries'",
        },
        {
          path: at,
          text: "import { reselectRunInTx as again } from '@/modules/task-execution/public/participants'",
        },
        {
          path: at,
          text: "import { createTaskSubjectQueries } from '../../task-execution/composition'",
        },
        {
          path: at,
          text: "import * as TE from '@/modules/task-execution/public/participants'\nTE.createConsumedInputsParticipantInTx()",
        },
        {
          path: at,
          text: "export { createTaskClarifyDirectivePersistence } from '@/modules/task-execution/composition'",
        },
        {
          path: at,
          text: "import { createHumanGatePersistenceParticipantInTx } from '@/modules/collaboration/composition'",
        },
      ]),
    ).toEqual([
      `${at}: createRunSelectionReader`,
      `${at}: reselectRunInTx`,
      `${at}: createTaskSubjectQueries`,
      `${at}: createConsumedInputsParticipantInTx`,
      `${at}: createTaskClarifyDirectivePersistence`,
    ])
  })

  test('绑定有五个工厂成员，bootstrap 把它们取自 task-execution 的 composition', () => {
    const members = interfaceMembers(
      `${CO}infrastructure/taskExecutionParticipantBindings.ts`,
      'TaskExecutionParticipantBindings',
    ).map(memberName)
    for (const name of FACTORIES) expect(members, name).toContain(name)
    const closure = parse(
      'bootstrap/crossContextClosure.ts',
      read('bootstrap/crossContextClosure.ts'),
    )
    const fromComposition = closure.statements
      .filter(
        (statement): statement is ts.ImportDeclaration =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === '@/modules/task-execution/composition',
      )
      .flatMap((statement) => {
        const bindings = statement.importClause?.namedBindings
        return bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((element) => element.name.text)
          : []
      })
    for (const name of FACTORIES) expect(fromComposition, name).toContain(name)
    const composer = closure.statements.find(
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
  })
})

describe('RFC-482 —— 删除的空操作与转发', () => {
  test('源码里不再声明 reselectRunInTx；collaboration 的指令转发文件不在', () => {
    const declared = walk(SRC).flatMap((path) => {
      const rel = slash(relative(SRC, path))
      const source = parse(rel, readFileSync(path, 'utf8'))
      const names: string[] = []
      const visit = (node: ts.Node): void => {
        if (
          (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
          node.name !== undefined &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'reselectRunInTx'
        )
          names.push(rel)
        ts.forEachChild(node, visit)
      }
      visit(source)
      return names
    })
    expect(declared).toEqual([])
    expect(existsSync(join(SRC, CO, 'infrastructure', 'taskClarifyDirective.ts'))).toBe(false)
  })
})

describe('RFC-482 —— task-execution 的引擎直接读自己的指令表', () => {
  test('CollaborationRuntimeMechanics 没有 getNodeClarifyDirective，collaboration 的实现也不再提供', () => {
    const members = interfaceMembers(
      `${TE}application/ports/collaborationRuntimeMechanics.ts`,
      'CollaborationRuntimeMechanics',
    ).map(memberName)
    expect(members).toContain('isTaskClarifySuppressed') // 正对照：判据读得到这个端口的成员
    expect(members).not.toContain('getNodeClarifyDirective')
    expect(read(`${CO}infrastructure/collaborationRuntimeMechanics.ts`)).not.toContain(
      'getNodeClarifyDirective',
    )
  })

  test('两处引擎端口接持久化包的 clarifyDirectives，持久化包用 task-execution 的指令持久化填它', () => {
    for (const path of [
      `${TE}composition/agentNodeExecution.ts`,
      `${TE}composition/humanGateNodeExecution.ts`,
    ]) {
      const text = read(path)
      expect(text, path).toContain('return state.opts.persistence.clarifyDirectives')
      expect(text, path).not.toContain('getNodeClarifyDirective')
    }
    expect(read(`${TE}composition/taskExecutionPersistence.ts`)).toContain(
      'clarifyDirectives: createTaskClarifyDirectivePersistence(db),',
    )
    const persistence = interfaceMembers(
      `${TE}application/ports/taskExecutionPersistence.ts`,
      'TaskExecutionPersistence',
    ).map(memberName)
    expect(persistence).toContain('clarifyDirectives')
  })
})

describe('RFC-482 —— run selection 的闭合读取接口', () => {
  test('TaskRunSelectionReads 只有三个方法签名，从 public/types 交出，表读取器 extends 它', () => {
    const members = interfaceMembers(
      `${TE}application/ports/runSelection.ts`,
      'TaskRunSelectionReads',
    )
    expect(members.map((member) => ts.SyntaxKind[member.kind])).toEqual([
      'MethodSignature',
      'MethodSignature',
      'MethodSignature',
    ])
    expect(members.map(memberName).sort()).toEqual(['consumed', 'current', 'familyHistory'])
    expect(exportedNames(`${TE}public/types.ts`, read(`${TE}public/types.ts`))).toContain(
      'TaskRunSelectionReads',
    )
    const reader = parse(
      `${TE}infrastructure/runSelection/table/reader.ts`,
      read(`${TE}infrastructure/runSelection/table/reader.ts`),
    ).statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'TableRunSelectionReader',
    )
    const heritage = (reader?.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((type) => type.expression.getText()),
    )
    expect(heritage).toContain('TaskRunSelectionReads')
  })
})

describeEachProvider('RFC-482 —— 持久化包的指令读取', (harness) => {
  test('clarifyDirectives.get 读到指令持久化写入的值，无行时为 undefined', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const bundle = createTaskExecutionPersistence(db, {
      humanGateOpen: composeHumanGateOpenParticipantFactory(),
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    })
    expect(await bundle.clarifyDirectives.get(taskId, 'asker')).toBeUndefined()
    await createTaskClarifyDirectivePersistence(db).set(taskId, 'asker', 'stop', 'u1', null, 1)
    expect(await bundle.clarifyDirectives.get(taskId, 'asker')).toBe('stop')
    await createTaskClarifyDirectivePersistence(db).set(taskId, 'asker', 'continue', 'u1', null, 2)
    expect(await bundle.clarifyDirectives.get(taskId, 'asker')).toBe('continue')
  })
})
