// RFC-506 — 身份访问的改密用例与意图目录的演员绑定迁出 composition（RFC-294 S10 第十三步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里交出的名字在全部生产文件、用例与 e2e 里只在各自的新位置声明；新文件恰好声明、交出清单列的名字，既有文件交出清单列的名字；
//    两个组合文件只声明并导出原有的装配入口。
// ② 两个组合文件没有 if / for / while / do / switch / try / throw 语句，各自从新位置取实现：`createResetUserPassword` 与
//    `createIntentCatalogActorBinding` 在生产代码里都只在各自的组合文件调用一次，改密的系统用户 id 与认证运行时原样交入、时钟以函数
//    交出；组合文件不再建 `WeakMap`，`Date.now()` 只作为交出的函数体出现（带负对照）。
// ③ 新代码的依赖面是闭集：identity-access 的新文件只取 `@/util/errors` 的 `ValidationError`，不用进程全局；intent 的
//    `application/resourceCatalog.ts` 的 import 与此前相同、新函数不用进程全局（带负对照）。
// ④ 行为（直接调用新位置）：系统用户的改密被拒，且不哈希、不取时钟、不写、不撤销；普通用户先取一次时钟、哈希、写入，再以同一时刻撤销
//    会话，`force` 缺省 false、给 true 时透传，两次写的接收者仍是交入的认证运行时；演员绑定登记后取回、未登记的上下文抛
//    `intent-resource-catalog-context-not-bound`、两个绑定互不串台、方法作为函数值交出后照常工作。改密拒绝系统用户这一支此前只有
//    e2e（`e2e/identity-credentials.spec.ts` 经 HTTP）覆盖，后端用例这里直接锁住。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读两个组合文件与两个新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type { Actor } from '@/auth/actor'
import { createResetUserPassword } from '@/modules/identity-access/application/commands/resetUserPassword'
import type { QueryContext } from '@/modules/identity-access/public/participants'
import { createIntentCatalogActorBinding } from '@/modules/intent/application/resourceCatalog'
import { ValidationError } from '@/util/errors'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const IA = 'modules/identity-access'
const IN = 'modules/intent'
const RESET = `${IA}/application/commands/resetUserPassword`
const CATALOG = `${IN}/application/resourceCatalog`

/** design §3: each new file, the names it declares and offers, and the names it declares without offering. */
const NEW_FILES: Readonly<
  Record<string, { readonly offered: readonly string[]; readonly internal: readonly string[] }>
> = {
  [RESET]: { offered: ['ResetUserPasswordDependencies', 'createResetUserPassword'], internal: [] },
}
/** design §3: the existing file that now also declares and offers this name. */
const EXTENDED_FILES: Readonly<Record<string, readonly string[]>> = {
  [CATALOG]: ['createIntentCatalogActorBinding'],
}
const LOCATIONS = [...Object.keys(NEW_FILES), ...Object.keys(EXTENDED_FILES)]

/** design §3 / D3: each composition file, the entry it keeps, and what it takes from the new locations. */
const COMPOSITION: Readonly<
  Record<string, { readonly entries: readonly string[]; readonly takes: readonly string[] }>
> = {
  [`${IA}/composition/userOperations`]: {
    entries: ['composeIdentityUserOperations'],
    takes: [`import ${RESET}: createResetUserPassword`],
  },
  [`${IN}/composition/resourceCatalog`]: {
    entries: ['composeIntentResourceCatalogBinding'],
    takes: [
      `import ${CATALOG}: composeIntentResourceCatalogFor, createIntentCatalogActorBinding, IntentResourceCatalogFactoryDependencies`,
    ],
  },
}
/** The single production call of each moved factory: its composition file and its arguments (whitespace removed). */
const CALLS: Readonly<Record<string, { readonly at: string; readonly args: readonly string[] }>> = {
  createResetUserPassword: {
    at: `${IA}/composition/userOperations`,
    args: ['{systemUserId:SYSTEM_USER_ID,credentials:input.auth,hashPassword,now:()=>Date.now(),}'],
  },
  createIntentCatalogActorBinding: {
    at: `${IN}/composition/resourceCatalog`,
    args: [],
  },
}
/** The identity-access command takes the shared validation error and nothing else (design §4 ③). */
const RESET_IMPORTS = ['import util/errors: ValidationError']
const RESET_SURFACE = (_file: string, specifier: string): boolean => specifier === '@/util/errors'
/** `application/resourceCatalog.ts`'s imports before RFC-506 (the new function adds none). */
const CATALOG_IMPORTS = [
  'import @agent-workflow/shared: AclResourceType, FileNode',
  'import auth/actor: Actor',
  `import ${IA}/public/participants: DirectAuthenticatedAuthority, QueryContext`,
  'import modules/resource-catalog/public/queries: AgentQueries, McpQueries, PluginQueries, ResourceCatalogQuery, SkillFileQueries, SkillQueries, WorkflowQueries, WorkgroupQueries',
  'import modules/resource-catalog/public/types: AgentCatalogResource, GetAgentCatalogInput, GetMcpCatalogInput, GetPluginCatalogInput, GetSkillContentCatalogInput, GetWorkflowCatalogInput, GetWorkgroupCatalogInput, ListSkillFilesCatalogInput, McpCatalogResource, PluginCatalogResource, ReadSkillFileCatalogInput, ResourceCatalogCursor, ResourceSummary, SkillCatalogContent, WorkflowCatalogDetail, WorkgroupCatalogDetail',
  `import ${IN}/application/ports/intentPersistence: IntentContextResourceAuthorization, IntentContextResourceAuthorityPair`,
]
/** Edges whose source is one of the RFC-506 locations (other pre-existing edges of the same file are not on this RFC's list). */
const edgesToLocations = (edges: readonly string[]) =>
  edges.filter((edge) =>
    LOCATIONS.some((location) => edge.split(': ')[0]!.endsWith(` ${location}`)),
  )
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
const isClockRead = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'Date' &&
  node.expression.name.text === 'now'
/**
 * Control-flow statements anywhere in the file (design §3; stricter than the F13 line-start count), plus the two
 * shapes the moved code had: a `new WeakMap` of retained state, and a clock read that is not the body of a handed-over
 * `() => Date.now()`.
 */
function implementationShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'WeakMap'
    )
      out.push('new WeakMap')
    if (
      isClockRead(node) &&
      !(
        ts.isArrowFunction(node.parent) &&
        node.parent.body === node &&
        node.parent.parameters.length === 0
      )
    )
      out.push('Date.now()')
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return out
}

/** Production files that call `name`, each with its call count. */
function productionCallers(name: string): string[] {
  return PRODUCTION.filter((path) => text(path).includes(name))
    .map((path) => [srcPath(path), callArguments(path, text(path), name).length] as const)
    .filter(([, count]) => count > 0)
    .map(([path, count]) => `${path} x${count}`)
    .sort()
}

const ANY_IMPORT = () => true

/** Imports outside the surface and process globals, read from the syntax tree. */
function purityFindings(
  file: string,
  source: string,
  allowed: (file: string, specifier: string) => boolean,
  globals: boolean,
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
      globals &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (['process', 'Bun', 'globalThis', 'crypto'].includes(node.expression.text) ||
        (node.expression.text === 'Date' && node.name.text === 'now') ||
        (node.expression.text === 'Math' && node.name.text === 'random'))
    )
      findings.push(`${node.expression.text}.${node.name.text}`)
    if (globals && ts.isIdentifier(node) && ['randomUUID', 'fetch'].includes(node.text))
      findings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

/** The text of a top-level function declaration of the file (an RFC-506 addition to an existing file). */
function functionText(path: string, source: string, name: string): string | undefined {
  const file = parse(path, source)
  return file.statements
    .find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    )
    ?.getText(file)
}

describe('RFC-506 ① 清单里的名字只在各自的新位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个交出的名字只在它的新位置声明（语料下限 3,000 / 2,500）',
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
      const listed: [string, string][] = [
        ...Object.entries(NEW_FILES).flatMap(([location, { offered, internal }]) =>
          [...offered, ...internal].map((name): [string, string] => [location, name]),
        ),
        ...Object.entries(EXTENDED_FILES).flatMap(([location, names]) =>
          names.map((name): [string, string] => [location, name]),
        ),
      ]
      expect(listed).toHaveLength(3)
      for (const [location, name] of listed)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('新文件恰好声明、交出清单列的名字；既有文件交出清单列的名字；两个组合文件只声明并导出原有的装配入口', () => {
    for (const [location, { offered, internal }] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...offered, ...internal].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...offered].sort(),
      ])
    }
    for (const [location, names] of Object.entries(EXTENDED_FILES)) {
      const path = sourceOf(location)
      const offered = offeredNames(path, text(path))
      expect([location, names.filter((name) => !offered.includes(name))]).toEqual([location, []])
    }
    for (const [location, { entries }] of Object.entries(COMPOSITION)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...entries].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...entries].sort(),
      ])
    }
  })
})

describe('RFC-506 ② composition 只装配', () => {
  test('两个组合文件没有控制流语句、不建 WeakMap、不直接读时钟，各自从新位置取实现', () => {
    for (const [location, { takes }] of Object.entries(COMPOSITION)) {
      const path = sourceOf(location)
      expect([location, implementationShapes(path, text(path))]).toEqual([location, []])
      expect([location, edgesToLocations(moduleEdges(path, text(path)))]).toEqual([
        location,
        [...takes],
      ])
    }
  })

  test(
    '迁出的两个工厂在生产代码里都只在各自的组合文件调用一次；改密的系统用户 id 与认证运行时原样交入、时钟以函数交出',
    () => {
      for (const [name, { at, args }] of Object.entries(CALLS)) {
        expect([name, productionCallers(name)]).toEqual([name, [`${at} x1`]])
        const path = sourceOf(at)
        expect([name, callArguments(path, text(path), name)]).toEqual([name, [[...args]]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：控制流语句、WeakMap、直接读时钟、别处的 import 与多余的调用都会被认出', () => {
    const probe = join(SRC, `${IA}/composition/probe.ts`)
    const source = [
      `import { createResetUserPassword } from '@/${RESET}'`,
      `import { createIntentCatalogActorBinding } from '../../intent/application/resourceCatalog'`,
      `import { ulid } from 'ulid'`,
      `export async function reset(userId: string, kinds: readonly string[]) {`,
      `  if (userId === '__system__') throw new Error('x')`,
      `  for (const kind of kinds) void kind`,
      `  switch (kinds[0]) { default: break }`,
      `  try { void 0 } catch { void 1 }`,
      `  const actors = new WeakMap<object, string>()`,
      `  const now = Date.now()`,
      `  void [actors, now, () => Date.now()]`,
      `}`,
    ].join('\n')
    expect(moduleEdges(probe, source)).toEqual([
      `import ${RESET}: createResetUserPassword`,
      `import ${CATALOG}: createIntentCatalogActorBinding`,
      'import ulid: ulid',
    ])
    // The location filter keeps edges into the RFC-506 locations and ignores the file's other edges.
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${RESET}: createResetUserPassword`,
      `import ${CATALOG}: createIntentCatalogActorBinding`,
    ])
    // The handed-over `() => Date.now()` is not a finding; the bare read is.
    expect(implementationShapes(probe, source)).toEqual([
      'if',
      'throw',
      'for-of',
      'switch',
      'try',
      'new WeakMap',
      'Date.now()',
    ])
    // The pin tells the wired call apart from a literal system user id, a copied auth runtime and a clock taken once
    // at assembly (a number, not the function the design asks for); a second call is a second entry.
    const pinned = CALLS.createResetUserPassword!.args[0]!
    const variants = [
      pinned.replace('systemUserId:SYSTEM_USER_ID', "systemUserId:'__system__'"),
      pinned.replace('credentials:input.auth', 'credentials:{...input.auth}'),
      pinned.replace('now:()=>Date.now()', 'now:Date.now()'),
    ]
    expect(new Set([pinned, ...variants]).size).toBe(4)
    const calls = callArguments(
      probe,
      [pinned, ...variants].map((args) => `createResetUserPassword(${args})`).join('\n'),
      'createResetUserPassword',
    )
    expect(calls).toEqual([[pinned], ...variants.map((args) => [args])])
    for (const call of calls.slice(1)) expect(call).not.toEqual([pinned])
  })
})

describe('RFC-506 ③ 新代码的依赖面是闭集、不用进程全局', () => {
  test('identity-access 的新文件只取 `@/util/errors` 的 ValidationError、不用进程全局；intent 的 application 文件 import 不变、新函数不用进程全局', () => {
    const reset = sourceOf(RESET)
    expect(moduleEdges(reset, text(reset))).toEqual(RESET_IMPORTS)
    expect(purityFindings(reset, text(reset), RESET_SURFACE, true)).toEqual([])
    const catalog = sourceOf(CATALOG)
    expect(moduleEdges(catalog, text(catalog))).toEqual(CATALOG_IMPORTS)
    const added = functionText(catalog, text(catalog), 'createIntentCatalogActorBinding')
    expect(added === undefined).toBe(false)
    expect(purityFindings(catalog, added!, ANY_IMPORT, true)).toEqual([])
  })

  test('负对照：越界 import、多出的 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${IA}/application/commands/probe.ts`)
    const source = [
      `import { ValidationError } from '@/util/errors'`,
      `import { SYSTEM_USER_ID } from '@/auth/actor'`,
      `import type { AuthRuntime } from '@/auth/application/authRuntime'`,
      `import { hashPassword } from '@/auth/passwords'`,
      `import { composeIdentityUserOperations } from '../../composition/userOperations'`,
      `import { createUserAccessRepository } from '../../infrastructure/userAccessRepository'`,
      `import { ulid } from 'ulid'`,
      `export async function run() { await import('node:crypto'); const at = Date.now(); const env = process.env; await fetch('x'); Math.random(); randomUUID() }`,
    ].join('\n')
    expect(purityFindings(file, source, RESET_SURFACE, true)).toEqual([
      'import @/auth/actor',
      'import @/auth/application/authRuntime',
      'import @/auth/passwords',
      'import ../../composition/userOperations',
      'import ../../infrastructure/userAccessRepository',
      'import ulid',
      'import() node:crypto',
      'Date.now',
      'process.env',
      'fetch',
      'Math.random',
      'randomUUID',
    ])
    expect(moduleEdges(file, source)).not.toEqual(RESET_IMPORTS)
    const catalog = join(SRC, `${CATALOG}.ts`)
    const extended = `import { ulid } from 'ulid'\nexport function createIntentCatalogActorBinding() { return Date.now() }\nexport function other() { return 1 }`
    expect(
      purityFindings(
        catalog,
        functionText(catalog, extended, 'createIntentCatalogActorBinding')!,
        ANY_IMPORT,
        true,
      ),
    ).toEqual(['Date.now'])
    expect(functionText(catalog, extended, 'missing')).toBeUndefined()
    expect(moduleEdges(catalog, extended)).not.toEqual(CATALOG_IMPORTS)
  })
})

describe('RFC-506 ④ 迁出的用例与用例状态行为不变', () => {
  function recordingReset(systemUserId = '__system__') {
    const calls: string[] = []
    let clock = 100
    const reset = createResetUserPassword({
      systemUserId,
      credentials: {
        async writeLocalPasswordIfUnmanaged(input) {
          calls.push(`write ${JSON.stringify(input)}`)
        },
        async revokeAllSessionsForUser(userId, now) {
          calls.push(`revoke ${userId} ${now}`)
        },
      },
      hashPassword: async (plaintext) => {
        calls.push(`hash ${plaintext}`)
        return `hash(${plaintext})`
      },
      now: () => {
        clock += 1
        calls.push(`now ${clock}`)
        return clock
      },
    })
    return { calls, reset }
  }

  test('改密：系统用户被拒（ValidationError、码与文案不变），不哈希、不取时钟、不写、不撤销', async () => {
    const { calls, reset } = recordingReset()
    const error = await reset({ userId: '__system__', newPassword: 'pw', force: true }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({
      code: 'system-user-immutable',
      message: 'cannot reset password for __system__',
      status: 422,
    })
    expect(calls).toEqual([])
    // The guard compares against the id handed in, not a constant of its own.
    const other = recordingReset('root-of-this-install')
    await expect(
      other.reset({ userId: 'root-of-this-install', newPassword: 'pw' }),
    ).rejects.toThrow('cannot reset password for __system__')
    await other.reset({ userId: '__system__', newPassword: 'pw' })
    expect(other.calls.map((call) => call.split(' ')[0])).toEqual([
      'now',
      'hash',
      'write',
      'revoke',
    ])
  })

  test('改密：先取一次时钟、哈希、写入，再以同一时刻撤销；force 缺省 false、给 true 时透传', async () => {
    const { calls, reset } = recordingReset()
    await reset({ userId: 'u1', newPassword: 'first' })
    await reset({ userId: 'u2', newPassword: 'second', force: true })
    expect(calls).toEqual([
      'now 101',
      'hash first',
      'write {"userId":"u1","passwordHash":"hash(first)","forcePasswordChange":false,"activate":true,"updatedAt":101}',
      'revoke u1 101',
      'now 102',
      'hash second',
      'write {"userId":"u2","passwordHash":"hash(second)","forcePasswordChange":true,"activate":true,"updatedAt":102}',
      'revoke u2 102',
    ])
  })

  test('改密：两次写的接收者仍是交入的认证运行时；写入失败时不撤销', async () => {
    class Runtime {
      readonly seen: string[] = []
      failWrites = false
      async writeLocalPasswordIfUnmanaged(input: { readonly userId: string }) {
        if (this.failWrites) throw new Error('write-failed')
        this.seen.push(`write ${input.userId}`)
      }
      async revokeAllSessionsForUser(userId: string, now: number) {
        this.seen.push(`revoke ${userId} ${now}`)
      }
    }
    const runtime = new Runtime()
    const reset = createResetUserPassword({
      systemUserId: '__system__',
      credentials: runtime,
      hashPassword: async (plaintext) => plaintext,
      now: () => 7,
    })
    await reset({ userId: 'u1', newPassword: 'pw' })
    expect(runtime.seen).toEqual(['write u1', 'revoke u1 7'])
    runtime.failWrites = true
    await expect(reset({ userId: 'u2', newPassword: 'pw' })).rejects.toThrow('write-failed')
    expect(runtime.seen).toEqual(['write u1', 'revoke u1 7'])
  })

  test('演员绑定：登记后取回；未登记的上下文抛同一错误；两个绑定互不串台；方法作为函数值交出后照常工作', () => {
    const first = createIntentCatalogActorBinding()
    const second = createIntentCatalogActorBinding()
    const context = { authority: 'a' } as unknown as QueryContext
    const stranger = { authority: 'b' } as unknown as QueryContext
    const actor = { id: 'u1' } as unknown as Actor
    first.bind(context, actor)
    expect(first.resolveActor(context)).toBe(actor)
    const rejected = (() => {
      try {
        first.resolveActor(stranger)
      } catch (caught) {
        return caught
      }
      return undefined
    })()
    // A plain Error with the unchanged code as its message (not a domain error with a status).
    expect(Object.getPrototypeOf(rejected)).toBe(Error.prototype)
    expect((rejected as Error).message).toBe('intent-resource-catalog-context-not-bound')
    expect(() => second.resolveActor(context)).toThrow('intent-resource-catalog-context-not-bound')
    const { bind, resolveActor } = second
    const other = { id: 'u2' } as unknown as Actor
    bind(stranger, other)
    expect(resolveActor(stranger)).toBe(other)
    expect(first.resolveActor(context)).toBe(actor)
    expect(() => first.resolveActor(stranger)).toThrow('intent-resource-catalog-context-not-bound')
    expect(Object.isFrozen(first)).toBe(true)
  })
})
