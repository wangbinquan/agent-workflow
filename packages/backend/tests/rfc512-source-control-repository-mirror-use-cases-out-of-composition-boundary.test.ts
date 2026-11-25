// RFC-512 — 源码控制的已登记仓库读取与远端登记用例迁出 composition（RFC-294 S10 第十九步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字；端口文件在原有的名字之外只多两个（RFC-527
//    另加显式的登记方式）；组合文件只声明、只交出两个装配入口（RFC-527：本机与托管各一，由 bootstrap 按部署选择选一支）。
// ② 组合文件不再选择（RFC-527）：没有控制流、没有错误的构造；两个工厂各被它调用一次；它不再从共享包与 `@/util` 取东西（带负对照）。
// ③ 新文件的依赖面是闭集：import 逐条钉住；不用进程全局，时钟由装配注入（带负对照）。
// ④ 行为（直接调用两个工厂，effect 用记录调用的替身）：单机的未知 id、读失败的错误改写、非领域错误原样抛、读的是镜像目录；托管的地址拆不开、
//    登记的地址不合法、登记与刷新的 effect 次序、`created` 两种取值、刷新投影的缺省值。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读组合文件与新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { gitUrlCacheKeyWith, parseGitUrl } from '@agent-workflow/shared'
import {
  createLocalRepositoryMirrors,
  createRemoteRepositoryMirrors,
  readRegisteredRepository,
} from '@/modules/source-control/application/repositoryMirrors'
import type { CachedRepositoryRecord } from '@/modules/source-control/ports/repositoryWorkspaceStore'
import type { RepositoryMirrorRegistration } from '@/modules/source-control/application/ports/repositoryMirrors'
import { DomainError, NotFoundError, ValidationError } from '@/platform/errors/domainErrors'
import { sha1Hex } from '@/platform/contracts/hash'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const SC = 'modules/source-control'
const APP = `${SC}/application/repositoryMirrors`
const PORT = `${SC}/application/ports/repositoryMirrors`
const ROOT_FILE = `${SC}/composition/repositoryMirrors`
const APP_NAMES = [
  'readRegisteredRepository',
  'createLocalRepositoryMirrors',
  'createRemoteRepositoryMirrors',
]
const PORT_NEW = ['RepositoryDirectoryReads', 'RepositoryMirrorCache']
/** RFC-527: the registration kind the mirrors state explicitly. */
const PORT_RFC527 = ['RepositoryMirrorRegistration']
/** The port file's names before RFC-512 (kept). */
const PORT_KEPT = [
  'RepositoryMirrors',
  'RepositoryRefresh',
  'RepositoryRegistration',
  'RepositoryRemoteEffects',
  'RepositoryRemoteFacts',
]
/** design §3: every listed name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = [
  ...APP_NAMES.map((name) => [APP, name] as const),
  ...PORT_NEW.map((name) => [PORT, name] as const),
]
/** design §4 ③: the exact imports of the new file. */
const APP_IMPORTS = [
  'import @agent-workflow/shared: gitUrlCacheKeyWith, parseGitUrl',
  'import platform/errors/domainErrors: DomainError, NotFoundError, ValidationError',
  'import platform/contracts/hash: sha1Hex',
  `import ${SC}/ports/repositoryWorkspaceStore: CachedRepositoryRecord, RepositoryWorkspaceStore`,
  `import ${PORT}: RepositoryDirectoryReads, RepositoryMirrorCache, RepositoryMirrors, RepositoryRemoteEffects`,
]
const APP_ALLOWED = new Set([
  '@agent-workflow/shared',
  'platform/errors/domainErrors',
  'platform/contracts/hash',
  `${SC}/ports/repositoryWorkspaceStore`,
  PORT,
])
const allowedForApp = (file: string, specifier: string): boolean =>
  APP_ALLOWED.has(resolveSpecifier(file, specifier) ?? specifier)
/** design §3: what the composition file may no longer take (the use cases' own vocabulary). */
// RFC-575: the error family and the digest helpers moved from util/ into platform.
const LEFT_COMPOSITION =
  /^import (@agent-workflow\/shared|platform\/errors\/domainErrors|platform\/contracts\/hash):/
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

/** RFC-527: the registration of a remote mirror (the hosted factory states its kind). */
function remoteOf(mirrors: { readonly registration: RepositoryMirrorRegistration }) {
  const registration = mirrors.registration
  if (registration.kind !== 'remote') throw new Error('expected a remote registration')
  return registration
}

describe('RFC-512 ① 清单里的名字只在各自的位置声明', () => {
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
      expect(LISTED).toHaveLength(5)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('新文件恰好声明、交出三个工厂；端口文件只多两个名字；组合文件只声明、只交出装配入口', () => {
    const app = sourceOf(APP)
    expect(declaredNames(app, text(app)).sort()).toEqual([...APP_NAMES].sort())
    expect(offeredNames(app, text(app)).sort()).toEqual([...APP_NAMES].sort())
    const port = sourceOf(PORT)
    expect(declaredNames(port, text(port)).sort()).toEqual(
      [...PORT_KEPT, ...PORT_NEW, ...PORT_RFC527].sort(),
    )
    expect(offeredNames(port, text(port)).sort()).toEqual(
      [...PORT_KEPT, ...PORT_NEW, ...PORT_RFC527].sort(),
    )
    const root = sourceOf(ROOT_FILE)
    expect(declaredNames(root, text(root))).toEqual([
      'composeLocalRepositoryMirrors',
      'composeRemoteRepositoryMirrors',
    ])
    expect(offeredNames(root, text(root))).toEqual([
      'composeLocalRepositoryMirrors',
      'composeRemoteRepositoryMirrors',
    ])
  })
})

describe('RFC-512 ② composition 只装配', () => {
  test('组合文件没有控制流（RFC-527：bootstrap 选一支）、没有错误的构造；从新位置取两个工厂，不再取用例的词汇', () => {
    const root = sourceOf(ROOT_FILE)
    expect(checkShapes(root, text(root))).toEqual([])
    const edges = moduleEdges(root, text(root))
    expect(edges.filter((edge) => edge.startsWith(`import ${APP}:`))).toEqual([
      `import ${APP}: createLocalRepositoryMirrors, createRemoteRepositoryMirrors`,
    ])
    expect(edges.filter((edge) => LEFT_COMPOSITION.test(edge))).toEqual([])
  })

  test(
    '两个工厂在生产代码里只被组合文件各调用一次；读已登记仓库只在两个工厂里',
    () => {
      expect(productionCallers('createLocalRepositoryMirrors')).toEqual([`${ROOT_FILE} x1`])
      expect(productionCallers('createRemoteRepositoryMirrors')).toEqual([`${ROOT_FILE} x1`])
      expect(productionCallers('readRegisteredRepository')).toEqual([`${APP} x2`])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：多出的控制流、错误的构造与用例的词汇都会被认出', () => {
    const probe = join(SRC, `${SC}/composition/probe.ts`)
    const source = [
      `import { parseGitUrl } from '@agent-workflow/shared'`,
      `import { NotFoundError } from '@/platform/errors/domainErrors'`,
      `import { createLocalRepositoryMirrors } from '../application/repositoryMirrors'`,
      `export function compose(row: unknown) {`,
      `  if (row === null) throw new NotFoundError('cached-repo-not-found', 'x')`,
      `  try { return parseGitUrl('x') } catch { return createLocalRepositoryMirrors(row as never) }`,
      `}`,
    ].join('\n')
    expect(checkShapes(probe, source)).toEqual(['if', 'throw', 'NotFoundError', 'try'])
    expect(moduleEdges(probe, source).filter((edge) => LEFT_COMPOSITION.test(edge))).toEqual([
      'import @agent-workflow/shared: parseGitUrl',
      'import platform/errors/domainErrors: NotFoundError',
    ])
  })
})

describe('RFC-512 ③ 新文件的依赖面是闭集、不用进程全局', () => {
  test('import 逐条钉住；只取地址解析、错误、散列与本模块的端口；不用进程全局', () => {
    const app = sourceOf(APP)
    expect(moduleEdges(app, text(app))).toEqual(APP_IMPORTS)
    expect(purityFindings(app, text(app), allowedForApp)).toEqual([])
  })

  test('负对照：基础设施、旧服务层与进程全局都会被认出', () => {
    const file = sourceOf(APP)
    const source = [
      `import { sha1Hex } from '@/platform/contracts/hash'`,
      `import { rowToCached } from '../infrastructure/local/repositoryMirrorCache'`,
      `import { unsealRepoUrl } from '@/services/repoCredentials'`,
      `export function run() { return [Date.now(), process.env, rowToCached, unsealRepoUrl, sha1Hex] }`,
    ].join('\n')
    expect(purityFindings(file, source, allowedForApp)).toEqual([
      'import ../infrastructure/local/repositoryMirrorCache',
      'import @/services/repoCredentials',
      'Date.now',
      'process.env',
    ])
  })
})

// ④ Behaviour, through the new factories with recording effects.

const URL = 'https://example.com/acme/widget.git'
const record = (patch: Partial<CachedRepositoryRecord> = {}): CachedRepositoryRecord => ({
  id: 'repo-1',
  urlHash: 'hash',
  urlEnc: 'sealed',
  urlRedacted: 'https://example.com/acme/widget.git',
  localPath: '/mirrors/secret-token-slug',
  defaultBranch: null,
  lastFetchedAt: 0,
  createdAt: 0,
  hasSubmodules: null,
  lastSubmoduleSyncOk: null,
  lastSubmoduleSyncError: null,
  lastAutoRefreshAt: null,
  ...patch,
})
const refsOf = (marker: string) => ({ marker }) as never
/** The fields a domain error carries to the wire. */
const fields = (error: unknown) => {
  const domain = error as DomainError
  return {
    code: domain.code,
    status: domain.status,
    message: domain.message,
    details: domain.details,
  }
}
const caught = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

function localFixture(read: (path: string) => Promise<unknown>) {
  const calls: string[] = []
  const known = { refs: async () => refsOf('known'), files: async () => refsOf('known') }
  const mirrors = createLocalRepositoryMirrors({
    store: {
      findCachedRepoById: async (id: string) => {
        calls.push(`find ${id}`)
        return id === 'repo-1' ? record() : null
      },
    },
    reads: {
      refs: async (path: string) => {
        calls.push(`refs ${path}`)
        return (await read(path)) as never
      },
      files: async (path: string) => {
        calls.push(`files ${path}`)
        return (await read(path)) as never
      },
    },
    local: known as never,
  })
  return { mirrors, calls, known }
}

describe('RFC-512 ④ 单机：已登记仓库在镜像目录上读', () => {
  test('读的是镜像目录，结果原样交出；`local` 是装配给的已登记目录读取', async () => {
    const { mirrors, calls, known } = localFixture(async (path) => refsOf(path))
    expect(await mirrors.refs('repo-1')).toEqual(refsOf('/mirrors/secret-token-slug'))
    expect(await mirrors.files('repo-1')).toEqual(refsOf('/mirrors/secret-token-slug'))
    expect(calls).toEqual([
      'find repo-1',
      'refs /mirrors/secret-token-slug',
      'find repo-1',
      'files /mirrors/secret-token-slug',
    ])
    expect(mirrors.local).toBe(known as never)
    expect(mirrors.registration).toEqual({ kind: 'mirror-cache' })
  })

  test('未知 id 是 404，不读镜像目录', async () => {
    const { mirrors, calls } = localFixture(async () => refsOf('x'))
    const error = await caught(() => mirrors.refs('repo-9'))
    expect(error).toBeInstanceOf(NotFoundError)
    expect(fields(error)).toEqual({
      code: 'cached-repo-not-found',
      status: 404,
      message: 'cached repo repo-9 not found',
      details: undefined,
    })
    expect(calls).toEqual(['find repo-9'])
  })

  test('读失败的领域错误按仓库 id 改写（码与状态不变，文案不带镜像目录）；其他错误原样抛', async () => {
    const failing = localFixture(async () => {
      throw new DomainError('git-failed', 'git failed in /mirrors/secret-token-slug', 502)
    })
    const rewritten = await caught(() => failing.mirrors.files('repo-1'))
    expect(rewritten).toBeInstanceOf(DomainError)
    expect(fields(rewritten)).toEqual({
      code: 'git-failed',
      status: 502,
      message: "cached repo 'repo-1': git-failed",
      details: undefined,
    })
    expect(String((rewritten as Error).message)).not.toContain('/mirrors/')
    const plain = new TypeError('boom')
    const other = localFixture(async () => {
      throw plain
    })
    expect(await caught(() => other.mirrors.refs('repo-1'))).toBe(plain)
  })

  test('readRegisteredRepository 只读一次存储', async () => {
    const seen: string[] = []
    const row = await readRegisteredRepository(
      { findCachedRepoById: async (id) => (seen.push(id), record({ id })) },
      'repo-2',
    )
    expect(row.id).toBe('repo-2')
    expect(seen).toEqual(['repo-2'])
  })
})

function remoteFixture(
  options: {
    readonly unsealed?: string | null
    readonly existing?: boolean
    readonly row?: Partial<CachedRepositoryRecord>
  } = {},
) {
  const calls: string[] = []
  let clock = 1_000
  const rows = new Map<string, CachedRepositoryRecord>([['repo-1', record(options.row)]])
  const mirrors = createRemoteRepositoryMirrors({
    store: {
      findCachedRepoById: async (id: string) => {
        calls.push(`find ${id}`)
        return rows.get(id) ?? null
      },
      findCachedRepoByHash: async (hash: string) => {
        calls.push(`findByHash ${hash}`)
        return options.existing === true ? record() : null
      },
      updateCachedRepo: async (id: string, patch: object) => {
        calls.push(`update ${id} ${JSON.stringify(patch)}`)
        const current = rows.get(id) ?? record({ id })
        rows.set(id, { ...current, ...patch })
      },
      cachedRepoReferenceCount: async (id: string) => {
        calls.push(`count ${id}`)
        return 3
      },
    } as never,
    remote: {
      refs: async (url: string) => (calls.push(`remote.refs ${url}`), refsOf(url)),
      files: async (url: string) => (calls.push(`remote.files ${url}`), refsOf(url)),
      verify: async (url: string) => (calls.push(`verify ${url}`), { defaultBranch: 'main' }),
    },
    cache: {
      unsealUrl: (row) => (
        calls.push(`unseal ${row.id}`),
        options.unsealed === undefined ? URL : options.unsealed
      ),
      ensureIdentity: async (url) => (calls.push(`identity ${url}`), { cachedRepoId: 'repo-7' }),
      invalidateFacets: () => {
        calls.push('invalidate')
      },
      project: (row, count) =>
        (calls.push(`project ${row.id} ${count}`), { id: row.id, count }) as never,
    },
    now: () => (clock += 1),
  })
  return { mirrors, calls }
}

describe('RFC-512 ④ 托管：远端读取、登记与刷新', () => {
  test('refs / files 拆出远端地址后在远端读；地址拆不开是 409，带脱敏地址，不碰远端', async () => {
    const ok = remoteFixture()
    expect(await ok.mirrors.refs('repo-1')).toEqual(refsOf(URL))
    expect(await ok.mirrors.files('repo-1')).toEqual(refsOf(URL))
    expect(ok.calls).toEqual([
      'find repo-1',
      'unseal repo-1',
      `remote.refs ${URL}`,
      'find repo-1',
      'unseal repo-1',
      `remote.files ${URL}`,
    ])
    expect(ok.mirrors.local).toBeUndefined()
    const sealed = remoteFixture({ unsealed: null })
    const error = await caught(() => sealed.mirrors.refs('repo-1'))
    expect(error).toBeInstanceOf(DomainError)
    expect(fields(error)).toEqual({
      code: 'repo-url-unavailable',
      status: 409,
      message:
        "cached repo 'repo-1' has no readable URL (sealed with a different secret.key?), so its remote cannot be read",
      details: { url: 'https://example.com/acme/widget.git' },
    })
    expect(sealed.calls).toEqual(['find repo-1', 'unseal repo-1'])
    const missing = remoteFixture()
    expect(await caught(() => missing.mirrors.files('repo-9'))).toBeInstanceOf(NotFoundError)
  })

  test('登记：地址不合法是 422、不核验；合法地址先核验、再查旧行、记身份行、记核验结果并作废切面缓存', async () => {
    const invalid = remoteFixture()
    const error = await caught(() => remoteOf(invalid.mirrors).register(''))
    expect(error).toBeInstanceOf(ValidationError)
    expect(fields(error)).toEqual({
      code: 'repo-url-invalid',
      status: 422,
      message: 'unsupported or malformed Git URL',
      details: undefined,
    })
    expect(invalid.calls).toEqual([])
    const hash = gitUrlCacheKeyWith(parseGitUrl(URL)!, sha1Hex).hash
    const fresh = remoteFixture()
    expect(await remoteOf(fresh.mirrors).register(URL)).toEqual({
      cachedRepoId: 'repo-7',
      created: true,
    })
    expect(fresh.calls).toEqual([
      `verify ${URL}`,
      `findByHash ${hash}`,
      `identity ${URL}`,
      'update repo-7 {"defaultBranch":"main","lastFetchedAt":1001}',
      'invalidate',
    ])
    const again = remoteFixture({ existing: true })
    expect(await remoteOf(again.mirrors).register(URL)).toEqual({
      cachedRepoId: 'repo-7',
      created: false,
    })
  })

  test('刷新：再核验一次、记结果、重读并投影；子模块字段缺省为通过、无错误、无子模块', async () => {
    const plain = remoteFixture()
    // The projection is the recording stand-in's `{ id, count }`, not a wire row.
    const refreshed: unknown = await remoteOf(plain.mirrors).refresh('repo-1')
    expect(refreshed).toEqual({
      item: { id: 'repo-1', count: 3 },
      fetchOk: true,
      fetchError: null,
      submoduleSyncOk: true,
      submoduleSyncError: null,
      hasSubmodules: false,
    })
    expect(plain.calls).toEqual([
      'find repo-1',
      'unseal repo-1',
      `verify ${URL}`,
      'update repo-1 {"defaultBranch":"main","lastFetchedAt":1001}',
      'invalidate',
      'find repo-1',
      'count repo-1',
      'project repo-1 3',
    ])
    const recorded = remoteFixture({
      row: {
        hasSubmodules: true,
        lastSubmoduleSyncOk: false,
        lastSubmoduleSyncError: 'sub failed',
      },
    })
    expect(await remoteOf(recorded.mirrors).refresh('repo-1')).toMatchObject({
      submoduleSyncOk: false,
      submoduleSyncError: 'sub failed',
      hasSubmodules: true,
    })
    expect(await caught(() => remoteOf(recorded.mirrors).refresh('repo-9'))).toBeInstanceOf(
      NotFoundError,
    )
  })
})
