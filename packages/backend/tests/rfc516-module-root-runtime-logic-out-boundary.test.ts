// RFC-516 — 模块根装配文件的运行期逻辑迁出（一）：事件中心、身份访问与源码控制（RFC-294 S10 第二十三步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；两个新文件恰好声明、交出清单列的名字；三个模块根不再声明它们。
// ② 三个模块根 `composition.ts` 没有循环、switch、`try`、`throw` 与错误的构造；名字在生产代码里只被预期的模块根调用（实参钉住，带负对照）。
// ③ 两个新文件的依赖面是闭集（import 逐条钉住），不用进程全局（带负对照）。
// ④ 行为：缺省观察者以原文错误拒绝；在线状态登记表只为会话来源开连接、释放幂等、关停释放全部；投影收敛逐行同步、移除缺失的提供方；
//    员工案例操作宿主的核对。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读三个模块根与新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { createUnavailableEventObserverProgram } from '@/modules/event-center/application/unavailableObserverProgram'
import { RuntimePresenceConnections } from '@/modules/identity-access/application/runtimePresenceConnections'
import { requireEmployeeCaseWorkspaceOperations } from '@/modules/source-control/application/employeeCaseWorkspace'
import {
  buildRepositoryTransportConnectionProjection,
  reconcileRepositoryTransportConnectionProjections,
} from '@/modules/source-control/application/repositoryTransportConnectionProjection'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const OBSERVER = 'modules/event-center/application/unavailableObserverProgram'
const PRESENCE = 'modules/identity-access/application/runtimePresenceConnections'
const PROJECTION = 'modules/source-control/application/repositoryTransportConnectionProjection'
const CASE = 'modules/source-control/application/employeeCaseWorkspace'
const ROOTS = ['event-center', 'identity-access', 'source-control'].map(
  (module) => `modules/${module}/composition`,
)
/** design §3: every listed name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = [
  [OBSERVER, 'createUnavailableEventObserverProgram'],
  [PRESENCE, 'RuntimePresenceConnections'],
  [PROJECTION, 'reconcileRepositoryTransportConnectionProjections'],
  [CASE, 'requireEmployeeCaseWorkspaceOperations'],
]
const NEW_FILES: Readonly<Record<string, readonly string[]>> = {
  [OBSERVER]: ['createUnavailableEventObserverProgram'],
  [PRESENCE]: ['RuntimePresenceConnections'],
}
/** design §4 ③: the exact imports of the two new files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [OBSERVER]: ['import modules/event-center/composition/required-ports: EventObserverProgramPort'],
  [PRESENCE]: [
    'import modules/identity-access/public/participants: PresenceConnectionTracker, PresenceLease',
    'import modules/identity-access/application/commands/trackUserPresence: TrackUserPresence',
    'import modules/identity-access/application/operationContext: DirectAuthorityRuntime',
  ],
}
/** A new file takes only its own module (its required-port types included), never infrastructure or other composition. */
const SAME_MODULE = (file: string, specifier: string): boolean => {
  const resolved = resolveSpecifier(file, specifier) ?? specifier
  const own = srcPath(file).split('/').slice(0, 2).join('/')
  return (
    resolved.startsWith(`${own}/`) &&
    !/\/infrastructure\//.test(`${resolved}/`) &&
    (!/\/composition(\/|$)/.test(resolved) || resolved === `${own}/composition/required-ports`)
  )
}
/** The production calls of every listed function (file and count) and the arguments at the module roots. */
const CALLS: Readonly<
  Record<string, readonly [readonly string[], readonly (readonly string[])[] | null]>
> = {
  createUnavailableEventObserverProgram: [['modules/event-center/composition x1'], [[]]],
  reconcileRepositoryTransportConnectionProjections: [['bootstrap/daemonApplication x1'], null],
  requireEmployeeCaseWorkspaceOperations: [
    ['modules/source-control/composition x1'],
    [['selected']],
  ],
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

/** What design §3 forbids in the three module roots (branches stay: they are assembly-time selections). */
const forbidden = (path: string) => checkShapes(path, text(path)).filter((shape) => shape !== 'if')

describe('RFC-516 ① 清单里的名字只在各自的位置声明', () => {
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

  test('两个新文件恰好声明、交出清单列的名字；三个模块根不声明它们，source-control 仍转出收敛', () => {
    for (const [location, names] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path))]).toEqual([location, [...names]])
      expect([location, offeredNames(path, text(path))]).toEqual([location, [...names]])
    }
    const listed = new Set(LISTED.map(([, name]) => name))
    for (const root of ROOTS) {
      const path = sourceOf(root)
      expect(
        declaredNames(path, text(path)).filter((name) => listed.has(name)),
        root,
      ).toEqual([])
    }
    const sourceControl = sourceOf('modules/source-control/composition')
    expect(offeredNames(sourceControl, text(sourceControl))).toContain(
      'reconcileRepositoryTransportConnectionProjections',
    )
  })
})

describe('RFC-516 ② 模块根只装配', () => {
  test('三个模块根没有循环、switch、try、throw 与错误的构造', () => {
    expect(
      ROOTS.flatMap((root) => forbidden(sourceOf(root)).map((shape) => `${root}: ${shape}`)),
    ).toEqual([])
  })

  test(
    '名字在生产代码里只被预期的模块根调用，实参钉住；identity-access 从新位置取登记表',
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
      const identity = sourceOf('modules/identity-access/composition')
      expect(moduleEdges(identity, text(identity))).toContain(
        `import ${PRESENCE}: RuntimePresenceConnections`,
      )
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：模块根里的循环、try、throw 与错误的构造都会被认出，分支不算', () => {
    const probe = join(SRC, 'modules', 'probe', 'composition.ts')
    const source = [
      `export async function reconcile(rows: string[], sync: (row: string) => Promise<void>) {`,
      `  for (const row of rows) await sync(row)`,
      `  if (rows.length === 0) throw new Error('employee-case-workspace-effects-incomplete')`,
      `  try { await sync('x') } finally { void 0 }`,
      `}`,
    ].join('\n')
    expect(checkShapes(probe, source).filter((shape) => shape !== 'if')).toEqual([
      'for-of',
      'throw',
      'Error',
      'try',
    ])
  })
})

describe('RFC-516 ③ 新文件的依赖面是闭集、不用进程全局', () => {
  test('import 逐条钉住；只取本模块（含它的 required-ports 类型）；不用进程全局', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect(purityFindings(path, text(path), SAME_MODULE), location).toEqual([])
    }
  })

  test('负对照：基础设施、别的组合文件、别的模块与进程全局都会被认出', () => {
    const file = sourceOf(PRESENCE)
    const source = [
      `import type { PresenceLease } from '../public/participants'`,
      `import { createInMemoryPresence } from '../infrastructure/inMemoryPresence'`,
      `import { composeIdentityAccess } from '../composition'`,
      `import type { PersistenceDb } from '@/platform/persistence/persistenceDb'`,
      `export const at = () => [Date.now(), process.env, createInMemoryPresence, composeIdentityAccess]`,
    ].join('\n')
    expect(purityFindings(file, source, SAME_MODULE)).toEqual([
      'import ../infrastructure/inMemoryPresence',
      'import ../composition',
      'import @/platform/persistence/persistenceDb',
      'Date.now',
      'process.env',
    ])
  })
})

describe('RFC-516 ④ 行为', () => {
  test('缺省观察者：带与不带观察者程序引用都以原文错误拒绝', async () => {
    const observer = createUnavailableEventObserverProgram()
    for (const [source, id] of [
      [{ observerProgramRef: { id: 'program-1' }, sourceRef: { id: 'source-1' } }, 'program-1'],
      [{ sourceRef: { id: 'source-2' } }, 'source-2'],
    ] as const) {
      const error = await observer.run({ source } as never).then(
        () => null,
        (rejected: unknown) => rejected,
      )
      expect((error as Error).message).toBe(`observer program unavailable: ${id}`)
    }
  })

  test('在线状态登记表：只为会话来源开连接；释放幂等；关停释放全部活着的连接', () => {
    const calls: string[] = []
    const direct = {
      legacyProjectionForAuthority: (authority: {
        readonly source: string
        readonly userId: string
      }) => authority,
    }
    const tracker = {
      opened: (userId: string) => void calls.push(`opened ${userId}`),
      closed: (userId: string) => void calls.push(`closed ${userId}`),
    }
    const connections = new RuntimePresenceConnections(direct as never, tracker as never)
    expect(connections.open({ source: 'pat', userId: 'u0' } as never)).toBeNull()
    const first = connections.open({ source: 'session', userId: 'u1' } as never)!
    connections.open({ source: 'session', userId: 'u2' } as never)
    first.release()
    first.release()
    connections.shutdown()
    connections.shutdown()
    expect(calls).toEqual(['opened u1', 'opened u2', 'closed u1', 'closed u2'])
  })

  test('投影收敛：逐行同步，移除没有配置行的提供方', async () => {
    const row = {
      provider: 'gitlab',
      connectionGeneration: 'generation-1',
      baseUrl: 'https://gitlab.example.com',
      rejectUnauthorized: true,
      repositoryUrlPrefixesJson: '[]',
      transportMappingsJson: '[]',
      tokenEnc: 'enc',
      tokenHint: 'hint',
      lastTestJson: null,
      updatedAt: 1,
      updatedBy: null,
    } as const
    const calls: unknown[] = []
    await reconcileRepositoryTransportConnectionProjections(
      { listConfiguredConnections: async () => [row] } as never,
      {
        synchronize: async (input) => void calls.push(['synchronize', input]),
        removeConnection: async (provider) => (calls.push(['remove', provider]), true),
      },
    )
    expect(calls).toEqual([
      ['synchronize', buildRepositoryTransportConnectionProjection(row)],
      ['remove', 'github'],
    ])
  })

  test('员工案例操作宿主：操作齐全时放行，缺操作或操作为空时抛原文错误', () => {
    const operations = Object.fromEntries(
      [
        'materialize',
        'rematerialize',
        'fetchRemoteHead',
        'checkpoint',
        'restore',
        'discard',
        'resolveBaseline',
        'importCommit',
      ].map((name) => [name, () => undefined]),
    )
    expect(() => requireEmployeeCaseWorkspaceOperations({ operations } as never)).not.toThrow()
    const { importCommit: _importCommit, ...missing } = operations
    for (const host of [{ operations: missing }, { operations: null }])
      expect(() => requireEmployeeCaseWorkspaceOperations(host as never)).toThrow(
        new Error('employee-case-workspace-effects-incomplete'),
      )
  })
})
