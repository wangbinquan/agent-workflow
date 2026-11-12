// RFC-486 — 任务启动用例归 task-execution 的 application：`taskRouteLaunchOperations.ts` 按内容分层（RFC-294 W4-E1 余项）。
//
// 锁四件事：
// ① 旧文件 `infrastructure/taskRouteLaunchOperations.ts` 不存在；`application/launch/` 的文件不 import 任何模块的 `infrastructure/**`、
//    `inbound/**`，也不 import `@/db/schema`、drizzle、`sessionTables` 与提交后发布的 runtime（相对路径、别名与动态 import 都认，带负对照）；
//    根启动内核、两条启动臂与路由启动操作的依赖接口没有 `db` 与 `configPath` 成员，改收端口。
// ② 准入适配器在同一个可串行化事务里按原次序调用：守卫复核 → 活跃成员 → lane 准入 → 任务创建参与者 → 成员行 → 意图行 → 工作组状态 →
//    创建事件；返回投影在事务之前算出。
// ③ 工作组运行时配置的三个构建函数只在 `domain/` 声明一份；直接启动人由 composition 用 inbound 的函数装配（RFC-301）。
// ④ task-execution 的全部生产文件不取 integration 的 `ProtectedMrLaunchGuard`（带负对照）；`TaskLaunchGuard` 的成员集合钉住，经
//    `public/types` 交出；integration 的 `ProtectedMrLaunchGuard` 扩展它。
//
// 覆盖范围（C12）：① 读 `application/launch/` 的全部文件；④ 覆盖 task-execution 的全部生产文件；②③ 读指定文件。行为由既有的双引擎启动用例
// 兜住（根启动、单代理、工作组、启动参与者与路由启动操作的落库与返回投影）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', 'src')
const TE = 'modules/task-execution/'
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

/** Static and dynamic module specifiers of a file, relative ones resolved to `src`-relative paths. */
function specifiers(path: string, text: string): string[] {
  const out: string[] = []
  const add = (specifier: string) =>
    out.push(
      specifier.startsWith('.')
        ? slash(relative(SRC, resolve(dirname(join(SRC, path)), specifier)))
        : specifier.startsWith('@/')
          ? specifier.slice(2)
          : specifier,
    )
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, text))
  return out
}

const FORBIDDEN = (target: string) =>
  /^modules\/[^/]+\/(?:infrastructure|inbound)(?:\/|$)/.test(target) ||
  target === 'db/schema' ||
  target.startsWith('db/schema/') ||
  target === 'drizzle-orm' ||
  target.startsWith('drizzle-orm/') ||
  target === 'platform/persistence/sessionTables' ||
  target === 'platform/events/committed/runtime'

function forbiddenImports(path: string, text: string): string[] {
  return specifiers(path, text)
    .filter(FORBIDDEN)
    .map((target) => `${path} -> ${target}`)
}

function interfaceMembers(path: string, name: string): string[] {
  const sf = parse(path, read(path))
  const declaration = sf.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (declaration === undefined) throw new Error(`${path}: no interface ${name}`)
  return declaration.members
    .map((member) => (member.name !== undefined ? member.name.getText(sf) : ''))
    .filter((member) => member !== '')
}

/** Names a file imports from any specifier (named, aliased, type-only). */
function importedNames(path: string, text: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, text).statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        names.push((element.propertyName ?? element.name).text)
  }
  return names
}

const LAUNCH = `${TE}application/launch/`
const LAUNCH_FILES = walk(join(SRC, LAUNCH)).map((path) => slash(relative(SRC, path)))
const TE_PRODUCTION = walk(join(SRC, TE)).map((path) => slash(relative(SRC, path)))

describe('RFC-486 ① 启动用例在 application，不碰持久化与 inbound', () => {
  test('旧文件已删除，四个用例文件就位', () => {
    expect(existsSync(join(SRC, `${TE}infrastructure/taskRouteLaunchOperations.ts`))).toBe(false)
    for (const file of [
      'rootTaskLaunch.ts',
      'taskLaunchArms.ts',
      'taskRouteLaunchOperations.ts',
      'taskExecutionLaunchParticipant.ts',
    ])
      expect(LAUNCH_FILES).toContain(`${LAUNCH}${file}`)
  })

  test('application/launch 的全部文件不 import infrastructure、inbound、表与发布 runtime', () => {
    expect(LAUNCH_FILES.length).toBeGreaterThanOrEqual(5)
    expect(LAUNCH_FILES.flatMap((path) => forbiddenImports(path, read(path)))).toEqual([])
  })

  test('负对照：相对路径、别名、re-export 与动态 import 都会被认出', () => {
    const path = `${LAUNCH}probe.ts`
    const fixture = [
      "import { a } from '../../infrastructure/rootTaskAdmission'",
      "import type { B } from '@/modules/integration/infrastructure/x'",
      "export { c } from '../../inbound/directTaskInitiator'",
      "import { eq } from 'drizzle-orm'",
      "import { tablesOf } from '@/platform/persistence/sessionTables'",
      "import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'",
      "const later = () => import('../../infrastructure/taskAuthorization')",
      "import { launchTask } from './launchTask'",
      "import type { RootTaskAdmission } from '../ports/rootTaskAdmission'",
    ].join('\n')
    expect(forbiddenImports(path, fixture)).toEqual([
      `${path} -> ${TE}infrastructure/rootTaskAdmission`,
      `${path} -> modules/integration/infrastructure/x`,
      `${path} -> ${TE}inbound/directTaskInitiator`,
      `${path} -> drizzle-orm`,
      `${path} -> platform/persistence/sessionTables`,
      `${path} -> platform/events/committed/runtime`,
      `${path} -> ${TE}infrastructure/taskAuthorization`,
    ])
  })

  test('依赖接口不收 db 与 configPath，改收端口', () => {
    const root = interfaceMembers(`${LAUNCH}rootTaskLaunch.ts`, 'RootTaskLaunchDependencies')
    expect(root).not.toContain('db')
    expect(root).toEqual(
      expect.arrayContaining(['admission', 'uploads', 'directTaskInitiator', 'workspace']),
    )
    for (const name of ['AgentRouteLaunchDependencies', 'WorkgroupRouteLaunchDependencies']) {
      const members = interfaceMembers(`${LAUNCH}taskLaunchArms.ts`, name)
      expect(members, name).not.toContain('db')
      expect(members, name).not.toContain('configPath')
      expect(members, name).toContain('fileUploadLimits')
    }
    const route = interfaceMembers(
      `${LAUNCH}taskRouteLaunchOperations.ts`,
      'TaskRouteLaunchDependencies',
    )
    expect(route).not.toContain('db')
    expect(route).toContain('taskAuthorization')
  })
})

describe('RFC-486 ② 准入适配器：一个事务、原次序', () => {
  const text = read(`${TE}infrastructure/rootTaskAdmission.ts`)
  const body = text.slice(text.indexOf('export function createRootTaskAdmission('))
  const tx = body.slice(
    body.indexOf('withSerializableTaskExecution(dependencies.db, async (tx) =>'),
  )

  test('投影在事务之前，事务内的调用按原次序各出现一次', () => {
    expect(body.indexOf('const projection = projectLaunchedTask({')).toBeGreaterThan(-1)
    expect(body.indexOf('const projection = projectLaunchedTask({')).toBeLessThan(
      body.indexOf('withSerializableTaskExecution('),
    )
    const order = [
      'await guard?.verifyCanCommit()',
      'guard?.assertCanCommit()',
      'await activeTaskMembers(tx, {',
      'await preparedWorkspace.admit(tx)',
      'createTaskCreationParticipantInTx(',
      '.insert(taskCollaborators)',
      'await insertOne(tx, taskExecutionIntents, {',
      '.update(workgroupTaskState)',
      'return await appendTaskCreatedCommittedEvent(tx, {',
    ]
    const positions = order.map((marker) => {
      expect(tx.split(marker).length - 1, marker).toBe(1)
      return tx.indexOf(marker)
    })
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  test('提交后发布与原来同一个调用', () => {
    expect(body).toContain(
      'return await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])',
    )
  })
})

describe('RFC-486 ③ 纯规则进 domain，直接启动人由 composition 装配', () => {
  test('工作组运行时配置只在 domain 声明一份', () => {
    expect(existsSync(join(SRC, `${TE}infrastructure/workgroupRuntimeConfig.ts`))).toBe(false)
    const declaring = TE_PRODUCTION.filter((path) =>
      /export function buildWorkgroupRuntimeConfig\(/.test(read(path)),
    )
    expect(declaring).toEqual([`${TE}domain/workgroupRuntimeConfig.ts`])
  })

  test('composition 用 inbound 函数装配 directTaskInitiator', () => {
    const composition = read(`${TE}composition/taskRouteLaunch.ts`)
    expect(composition).toContain(
      "import { directTaskInitiatorFromActorSource } from '../inbound/directTaskInitiator'",
    )
    expect(composition).toContain(
      'directTaskInitiator: (actor: Actor) => directTaskInitiatorFromActorSource(actor.source)',
    )
    expect(read(`${LAUNCH}rootTaskLaunch.ts`)).toMatch(
      /rootLaunchMetadata\(\s*input\.actor,\s*input\.invoker,\s*dependencies\.directTaskInitiator,?\s*\)/,
    )
  })
})

describe('RFC-486 ④ 启动守卫由 task-execution 声明', () => {
  test('task-execution 的生产文件不取 ProtectedMrLaunchGuard', () => {
    expect(TE_PRODUCTION.length).toBeGreaterThanOrEqual(700)
    expect(
      TE_PRODUCTION.filter((path) =>
        importedNames(path, read(path)).includes('ProtectedMrLaunchGuard'),
      ),
    ).toEqual([])
  })

  test('负对照：命名、别名与仅类型的 import 都会被认出', () => {
    for (const fixture of [
      "import type { ProtectedMrLaunchGuard } from '@/modules/integration/public/participants'",
      "import { type ProtectedMrLaunchGuard as Guard } from '@/modules/integration/public/participants'",
      "import { other, ProtectedMrLaunchGuard } from '../../integration/public/participants'",
    ])
      expect(importedNames(`${TE}probe.ts`, fixture), fixture).toContain('ProtectedMrLaunchGuard')
  })

  test('TaskLaunchGuard 的成员集合钉住，经 public/types 交出，integration 的守卫扩展它', () => {
    expect(
      interfaceMembers(`${TE}application/ports/taskLaunchGuard.ts`, 'TaskLaunchGuard').sort(),
    ).toEqual(
      [
        'assertCanCommit',
        'failed',
        'launchSettled',
        'release',
        'signal',
        'snapshot',
        'taskCommitted',
        'verifyCanCommit',
      ].sort(),
    )
    expect(read(`${TE}public/types.ts`)).toContain(
      "export type { TaskLaunchGuard } from '@/modules/task-execution/application/ports/taskLaunchGuard'",
    )
    const integration = read('modules/integration/public/participants.ts')
    expect(integration).toContain(
      "import type { TaskLaunchGuard } from '@/modules/task-execution/public/types'",
    )
    expect(integration).toContain(
      'export interface ProtectedMrLaunchGuard extends TaskLaunchGuard {',
    )
  })
})
