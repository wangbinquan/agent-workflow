// RFC-574 — `util/paths` 与 `util/http` 归 platform（RFC-294 W9-D 后继）。
//
// 为什么存在：`util/` 里读者最少的两个大文件。RFC-574 把安装目录的位置（`util/paths.ts`）迁进 `platform/configuration/installationPaths.ts`，把
// HTTP 请求的解析（`util/http.ts`）迁进 `platform/http/requestParsing.ts`，读者一次改指，旧位置不留转出。前者用 `import.meta.dirname` 回到 backend
// 包根再找两条源码树里的迁移链，文件深了一层，层数跟着改了一处。锁四件事：
// ① 两个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符（别名、相对路径、动态 import、`mock.module`）再解析到它们（判据带负对照）。
// ② 新位置的两个文件只取登记过的依赖，不取模块。
// ③ 两个文件导出的名字与搬迁前相同。
// ④ `Paths.migrationsDir` 与 `Paths.postgresqlMigrationsDir` 解析到 `packages/backend/db/migrations` 与 `db/postgresql-migrations`，两处都有迁移日志；
//    安装目录跟随 `AGENT_WORKFLOW_HOME`。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读两个新文件；④ 跑真实的 `Paths`。
// 两个文件的其余行为由既有用例覆盖（`rfc284-safejson-convergence`、`flag-audit` 的布尔 query 用例、各路由的用例，以及源码树里开库的全部用例——
// 它们经 `resolveMigrationsFolder()` 取 `Paths.migrationsDir`）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { appHome, Paths } from '../src/platform/configuration/installationPaths'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location (below `src`, no extension) → new location, with the names each file exported before the move and its imports. */
const MOVED: ReadonlyArray<readonly [string, string, readonly string[], readonly string[]]> = [
  [
    'util/paths',
    'platform/configuration/installationPaths',
    ['Paths', 'appHome'],
    ['node:os', 'node:path'],
  ],
  [
    'util/http',
    'platform/http/requestParsing',
    ['parseBoolQuery', 'safeJsonOrEmpty', 'safeJsonOrThrowInvalid'],
    ['@/platform/errors/domainErrors', 'hono'],
  ],
]
const OLD = new Set(MOVED.map(([old]) => old))

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory()
      ? walk(path)
      : /\.(?:[cm]?tsx?|mjs)$/.test(name)
        ? [path]
        : []
  })
}

/**
 * Every module specifier a file names — imports, re-exports, `import('…')` (types and calls), `require('…')` and
 * `mock.module('…')` — resolved to a path below `src` without its extension (null when it leaves `src` or is a package).
 */
function resolvedSpecifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string) => {
    const bare = specifier.replace(/\.(?:[cm]?tsx?|[cm]?js)$/, '')
    const target = bare.startsWith('@/')
      ? join(SRC, bare.slice(2))
      : bare.startsWith('.')
        ? resolve(dirname(path), bare)
        : null
    if (target === null) return
    const below = slash(relative(SRC, target))
    if (!below.startsWith('..')) out.push(below)
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text)
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module' ||
          callee === 'import.meta.resolve') &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      )
        add(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Names a file exports with an `export` modifier (functions, classes, consts, interfaces, type aliases). */
function exportedNames(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  return source.statements
    .flatMap((statement) => {
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      )
        return statement.exportClause.elements.map((element) => element.name.text)
      const exported =
        ts.canHaveModifiers(statement) &&
        (ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
          false)
      if (!exported) return []
      if (ts.isVariableStatement(statement))
        return statement.declarationList.declarations.flatMap((declaration) =>
          ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
        )
      return (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
        statement.name !== undefined
        ? [statement.name.text]
        : []
    })
    .sort()
}

/** The raw module specifiers of a file's import and export declarations. */
function rawSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

describe('RFC-574 —— 两个文件离开 util/', () => {
  test('旧路径不存在，新路径存在', () => {
    for (const [old, next] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
    }
  })

  test('src / tests / scripts 的全部说明符不再解析到旧路径', () => {
    const files = [
      ...walk(SRC),
      ...walk(join(BACKEND, 'tests')),
      ...walk(join(BACKEND, 'scripts')),
      ...walk(join(REPO, 'scripts')),
    ]
    expect(files.length).toBeGreaterThanOrEqual(6000)
    expect(
      files.flatMap((path) =>
        resolvedSpecifiers(path, readFileSync(path, 'utf8'))
          .filter((target) => OLD.has(target))
          .map((target) => `${slash(relative(REPO, path))} -> ${target}`),
      ),
    ).toEqual([])
  }, 240_000)

  test('负对照：别名、相对路径、带扩展名、动态 import、require、mock.module 与 import 类型都会被认出；新路径与包名不算', () => {
    const fromSrcRoot = join(SRC, 'main.ts')
    expect(
      resolvedSpecifiers(
        fromSrcRoot,
        "import { Paths } from './util/paths'\n" +
          "import { parseBoolQuery } from '@/util/http'\n" +
          "export { appHome } from './util/paths.ts'\n" +
          "const http = await import('./util/http')\n" +
          "const paths = require('./util/paths')\n" +
          "mock.module('@/util/http', () => ({}))\n" +
          "type P = import('./util/paths').Paths\n" +
          "import { Paths as next } from './platform/configuration/installationPaths'\n" +
          "import { createLogger } from './platform/logging/logger'\n" +
          "import { Hono } from 'hono'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'util/paths',
      'util/http',
      'util/paths',
      'util/http',
      'util/paths',
      'util/http',
      'util/paths',
    ])
    const fromUtil = join(SRC, 'util', 'probe.ts')
    expect(
      resolvedSpecifiers(
        fromUtil,
        "import { appHome } from './paths'\n" +
          "import { appHome as next } from '../platform/configuration/installationPaths'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['util/paths'])
  })
})

describe('RFC-574 —— 新位置的文件', () => {
  test('只取登记过的依赖，不取模块', () => {
    for (const [, next, , specifiers] of MOVED) {
      const found = rawSpecifiers(join(SRC, `${next}.ts`)).sort()
      expect([next, found]).toEqual([next, [...specifiers].sort()])
      expect([next, found.filter((specifier) => specifier.includes('/modules/'))]).toEqual([
        next,
        [],
      ])
    }
  })

  test('导出的名字与搬迁前相同', () => {
    for (const [, next, names] of MOVED)
      expect([next, exportedNames(join(SRC, `${next}.ts`))]).toEqual([next, [...names].sort()])
  })
})

describe('RFC-574 —— 安装目录与两条迁移链的位置', () => {
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env.AGENT_WORKFLOW_HOME
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
  })

  test('两条迁移链解析到 backend 包根下的 db/，都有迁移日志', () => {
    expect(Paths.migrationsDir).toBe(join(BACKEND, 'db', 'migrations'))
    expect(Paths.postgresqlMigrationsDir).toBe(join(BACKEND, 'db', 'postgresql-migrations'))
    expect(existsSync(join(Paths.migrationsDir, 'meta', '_journal.json'))).toBe(true)
    expect(existsSync(join(Paths.postgresqlMigrationsDir, 'meta', '_journal.json'))).toBe(true)
  })

  test('安装目录与它下面的文件跟随 AGENT_WORKFLOW_HOME', () => {
    process.env.AGENT_WORKFLOW_HOME = join(BACKEND, 'probe-home')
    expect(appHome()).toBe(join(BACKEND, 'probe-home'))
    expect(Paths.root).toBe(join(BACKEND, 'probe-home'))
    expect(Paths.config).toBe(join(BACKEND, 'probe-home', 'config.json'))
    expect(Paths.daemonInfo).toBe(join(BACKEND, 'probe-home', '.daemon.info'))
    // The two migration chains are part of the source tree, not of the installation.
    expect(Paths.migrationsDir).toBe(join(BACKEND, 'db', 'migrations'))
  })
})
