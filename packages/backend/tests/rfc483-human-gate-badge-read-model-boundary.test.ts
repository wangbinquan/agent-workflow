// RFC-483 — 评审与澄清徽标的联合投影归 collaboration 读模型：task-execution 的三个 SQL 条件片段撤出 public（RFC-294 S9 第五步）。
//
// 锁四件事：
// ① task-execution 的 public 文件不导出 `nodeRunStatusCondition`、`taskGateOpenCondition`、`taskGateVisibleCondition`（转出与本地声明、
//    值与类型都认；带正对照）。
// ② collaboration 的全部生产文件不从 task-execution 的任何入口取这三个片段（命名 import、别名、相对路径、命名空间成员与 re-export 都认；
//    带负对照）——徽标读模型只经装配期绑定取谓词。
// ③ `TaskExecutionParticipantBindings` 有这三个成员，bootstrap 的 `composeTaskExecutionParticipantBindings` 取自 task-execution 的
//    composition。
// ④ 徽标读模型端口只有 DTO 签名（不出现 drizzle、`PersistenceDb`、`SQL`、`AnyColumn`）；查看者判定在 application；两个路由操作经
//    application 的徽标用例计数。
// 行为：查看者判定的三种形态；双引擎下经 application 用例与绑定的读模型计出的数与 RFC-359 AC-11 的预算用例同一份语料相同。
//
// 覆盖范围（C12）：① 覆盖 task-execution 的全部 public 文件；② 覆盖 collaboration 的全部生产文件；③④ 读指定文件。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'
import { clarifyRoundFixture, nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import {
  countAwaitingClarifyBadge,
  countPendingReviewBadge,
  humanGateBadgeViewer,
} from '@/modules/collaboration/application/humanGateBadges'
import type { HumanGateBadgeReadModel } from '@/modules/collaboration/application/ports/humanGateBadgeReadModel'
import { countAwaitingClarifyRounds } from '@/modules/collaboration/infrastructure/clarifyRounds'
import { countPendingReviews } from '@/modules/collaboration/infrastructure/review'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

const SRC = resolve(import.meta.dir, '..', 'src')
const TE = 'modules/task-execution/'
const CO = 'modules/collaboration/'
const CONDITIONS = [
  'nodeRunStatusCondition',
  'taskGateOpenCondition',
  'taskGateVisibleCondition',
] as const
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

/** `file: name` for every condition a non-task-execution file takes from a task-execution entry. */
function conditionTakes(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const offenders: string[] = []
  const isCondition = (name: string) => (CONDITIONS as readonly string[]).includes(name)
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
            if (isCondition(imported)) offenders.push(`${path}: ${imported}`)
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
          if (isCondition(imported)) offenders.push(`${path}: ${imported}`)
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        isCondition(node.name.text)
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

describe('RFC-483 —— task-execution 的 public 撤出三个 SQL 条件片段', () => {
  test('task-execution 的 public 文件不导出三个片段', () => {
    const publicFiles = walk(join(SRC, TE, 'public')).map((path) => slash(relative(SRC, path)))
    expect(publicFiles.length).toBeGreaterThanOrEqual(5)
    const exported = publicFiles.flatMap((path) =>
      exportedNames(path, read(path)).map((name) => ({ path, name })),
    )
    // 正对照：判据认得出留在 public 的另一个片段（integration 那一对的债，S9 后续）与 task gate 的上下文类型。
    for (const name of ['nonTerminalTaskExists', 'TaskGateContext', 'TaskGateQueries'])
      expect(
        exported.some((entry) => entry.name === name),
        name,
      ).toBe(true)
    expect(exported.filter(({ name }) => (CONDITIONS as readonly string[]).includes(name))).toEqual(
      [],
    )
    const composition = exportedNames(`${TE}composition.ts`, read(`${TE}composition.ts`))
    for (const name of CONDITIONS) expect(composition, name).toContain(name)
  })
})

describe('RFC-483 —— 徽标读模型只经装配期绑定取谓词', () => {
  test('collaboration 的全部生产文件不从 task-execution 的任何入口取三个片段', () => {
    const collaboration = productionFiles(CO)
    expect(collaboration.length).toBeGreaterThanOrEqual(150)
    expect(conditionTakes(collaboration)).toEqual([])
    for (const path of [`${CO}infrastructure/review.ts`, `${CO}infrastructure/clarifyRounds.ts`]) {
      const text = read(path)
      for (const name of ['taskGateOpenCondition', 'taskGateVisibleCondition'])
        expect(text, `${path}: ${name}`).toContain(`taskScope.${name}(`)
    }
    expect(read(`${CO}infrastructure/review.ts`)).toContain('taskScope.nodeRunStatusCondition(')
  })

  test('负对照：判据认得出命名 import、别名、相对路径、命名空间成员与 re-export', () => {
    const at = `${CO}infrastructure/probe.ts`
    expect(
      conditionTakes([
        {
          path: at,
          text: "import { taskGateOpenCondition } from '@/modules/task-execution/public/queries'",
        },
        {
          path: at,
          text: "import { taskGateVisibleCondition as visible } from '@/modules/task-execution/composition'",
        },
        {
          path: at,
          text: "import { nodeRunStatusCondition } from '../../task-execution/infrastructure/nodeRunQueries'",
        },
        {
          path: at,
          text: "import * as TE from '@/modules/task-execution/composition'\nTE.taskGateOpenCondition(db, col)",
        },
        {
          path: at,
          text: "export { taskGateVisibleCondition } from '@/modules/task-execution/infrastructure/taskGateQueries'",
        },
        {
          path: at,
          text: "import { taskGateOpenCondition } from '@/modules/collaboration/composition'",
        },
      ]),
    ).toEqual([
      `${at}: taskGateOpenCondition`,
      `${at}: taskGateVisibleCondition`,
      `${at}: nodeRunStatusCondition`,
      `${at}: taskGateOpenCondition`,
      `${at}: taskGateVisibleCondition`,
    ])
  })

  test('绑定有三个成员、取自 task-execution 的 composition', () => {
    const members = interfaceDeclaration(
      `${CO}infrastructure/taskExecutionParticipantBindings.ts`,
      'TaskExecutionParticipantBindings',
    ).members.map(memberName)
    for (const name of CONDITIONS) expect(members, name).toContain(name)
    const closure = 'bootstrap/crossContextClosure.ts'
    const fromComposition = namesImportedFrom(closure, '@/modules/task-execution/composition')
    for (const name of CONDITIONS) expect(fromComposition, name).toContain(name)
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
    for (const name of CONDITIONS) expect(handed, name).toContain(name)
  })
})

describe('RFC-483 —— 查看者判定在 application，读模型端口只收 DTO', () => {
  test('读模型端口没有持久化与 drizzle 类型；两个路由操作经 application 的徽标用例计数', () => {
    const port = `${CO}application/ports/humanGateBadgeReadModel.ts`
    const source = parse(port, read(port))
    expect(source.statements.filter(ts.isImportDeclaration)).toEqual([])
    // 只看代码（注释里可以说「一条 SQL 语句」）：签名里不出现持久化句柄与 drizzle 类型。
    const code = ts.createPrinter({ removeComments: true }).printFile(source)
    expect(code).toContain('countPendingReviews(viewer: HumanGateBadgeViewer): Promise<number>')
    for (const token of ['SQL', 'AnyColumn', 'PersistenceDb', 'drizzle'])
      expect(code, token).not.toMatch(new RegExp(`\\b${token}\\b`))
    expect(interfaceDeclaration(port, 'HumanGateBadgeReadModel').members.map(memberName)).toEqual([
      'countPendingReviews',
      'countAwaitingClarifyRounds',
    ])
    const useCases = exportedNames(
      `${CO}application/humanGateBadges.ts`,
      read(`${CO}application/humanGateBadges.ts`),
    )
    expect(useCases).toEqual(
      expect.arrayContaining([
        'humanGateBadgeViewer',
        'countPendingReviewBadge',
        'countAwaitingClarifyBadge',
      ]),
    )
    const routes = read(`${CO}infrastructure/collaborationRouteOperations.ts`)
    expect(routes).toContain(
      'countPending: async (actor) => await countPendingReviewBadge(badges, actor),',
    )
    expect(routes).toContain(
      'countPending: async (actor) => await countAwaitingClarifyBadge(badges, actor),',
    )
    // 规则判定（`tasks:read:all`）不再写在两个计数旁边。
    for (const path of [`${CO}infrastructure/review.ts`, `${CO}infrastructure/clarifyRounds.ts`]) {
      const text = read(path)
      const start = text.indexOf(
        path.endsWith('review.ts')
          ? 'export async function countPendingReviews('
          : 'export async function countAwaitingClarifyRounds(',
      )
      expect(start, path).toBeGreaterThan(-1)
      const end = text.indexOf('\nexport ', start + 1)
      expect(text.slice(start, end === -1 ? undefined : end), path).not.toContain('tasks:read:all')
    }
  })

  test('查看者判定的三种形态', () => {
    expect(humanGateBadgeViewer()).toEqual({ kind: 'all-tasks' })
    expect(humanGateBadgeViewer(actorOf('root', 'admin'))).toEqual({ kind: 'all-tasks' })
    expect(humanGateBadgeViewer(actorOf('alice'))).toEqual({ kind: 'task-member', userId: 'alice' })
  })
})

function actorOf(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

const NOW = 1_788_278_400_000

async function addTask(
  db: PersistenceDb,
  id: string,
  ownerUserId: string,
  status: 'awaiting_human' | 'canceled',
): Promise<void> {
  await taskFixture(db, {
    id,
    name: id,
    workflowId: 'wf',
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: NOW,
    ownerUserId,
  })
}

async function addRound(
  db: PersistenceDb,
  taskId: string,
  status: 'awaiting_human' | 'answered',
): Promise<void> {
  const runId = ulid()
  await nodeRunFixture(db, {
    id: runId,
    taskId,
    nodeId: 'ask',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: NOW,
  })
  await clarifyRoundFixture(db, {
    id: ulid(),
    taskId,
    kind: 'self',
    askingNodeId: 'ask',
    askingNodeRunId: runId,
    intermediaryNodeId: 'ask',
    intermediaryNodeRunId: runId,
    questions: '[]',
    status,
  })
}

/** 与 `rfc359-w57-clarify-badge-round-trip-budget` 同一份语料：属主 / 协作者可见、他人不可见、终态任务丢弃、已答不计。 */
async function seed(db: PersistenceDb): Promise<void> {
  const { users, taskCollaborators } = tablesOf(db)
  await db.insert(users).values(
    ['admin', 'alice', 'bob', 'carol'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: id === 'admin' ? ('admin' as const) : ('user' as const),
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
  await workflowFixture(db, {
    id: 'wf',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
  await addTask(db, 'c-live', 'alice', 'awaiting_human')
  await addRound(db, 'c-live', 'awaiting_human')
  await addRound(db, 'c-live', 'answered')
  await insertOne(db, taskCollaborators, {
    taskId: 'c-live',
    userId: 'carol',
    role: 'collaborator',
    addedBy: 'alice',
    addedAt: NOW,
  })
  await addTask(db, 'c-done', 'alice', 'canceled')
  await addRound(db, 'c-done', 'awaiting_human')
  await addTask(db, 'c-bob', 'bob', 'awaiting_human')
  await addRound(db, 'c-bob', 'awaiting_human')
}

describeEachProvider('RFC-483 —— 经 application 用例与绑定的徽标读模型', (harness) => {
  test('澄清徽标：看全部任务的数全部、属主与协作者各数到自己那条、无关用户数不到；评审徽标在无待审时为 0', async () => {
    const db = harness.db
    await seed(db)
    const badges: HumanGateBadgeReadModel = {
      countPendingReviews: (viewer) => countPendingReviews(db, taskExecutionParticipants, viewer),
      countAwaitingClarifyRounds: (viewer) =>
        countAwaitingClarifyRounds(db, taskExecutionParticipants, viewer),
    }
    expect(await countAwaitingClarifyBadge(badges, actorOf('admin', 'admin'))).toBe(2)
    expect(await countAwaitingClarifyBadge(badges, actorOf('alice'))).toBe(1)
    expect(await countAwaitingClarifyBadge(badges, actorOf('carol'))).toBe(1)
    expect(await countAwaitingClarifyBadge(badges, actorOf('bob'))).toBe(1)
    expect(await countPendingReviewBadge(badges)).toBe(0)
    expect(await countPendingReviewBadge(badges, actorOf('alice'))).toBe(0)
  })
})
