// RFC-571 — `util/` 的八个通用原语归 platform（RFC-294 W9-D 后继）。
//
// 为什么存在：legacy 横向目录 `util/` 里有一批与业务无关、没有任何内部依赖的原语，RFC-294 design §2 与架构报告的归属表给它们的去向都是 platform。
// RFC-571 原样搬了八个，读者一次改指，旧位置不留转出。锁三件事：
// ① 八个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符（别名、相对路径、动态 import、`mock.module`）再解析到它们（判据带负对照）。
// ② 新位置的八个文件只取登记过的第三方库——不取模块、不取 `util/` 与其他 legacy 目录、不取文件系统与进程。
// ③ 每个文件导出的名字与搬迁前相同。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读八个新文件。各原语的行为由它们
// 既有的用例覆盖（`keyed-serial-queue`、`rfc271-zip-roundtrip`、`zip-fixed-mtime-timezone`、`zod4-contracts`、`rfc143` 的 semver 一条、
// `rfc284-microhelpers` 的 monotonic 一条等）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location (below `src`, no extension) → new location, with the names each file exported before the move. */
const MOVED: ReadonlyArray<readonly [string, string, readonly string[], readonly string[]]> = [
  ['util/semver', 'platform/contracts/semver', ['compareSemver', 'extractVersion'], []],
  ['util/time', 'platform/contracts/monotonicNow', ['monotonicNow'], []],
  ['util/keyedSerialQueue', 'platform/contracts/keyedSerialQueue', ['KeyedSerialQueue'], []],
  [
    'util/jsonDocument',
    'platform/http/jsonDocument',
    ['JsonDocument', 'jsonDocumentResponse', 'parseJsonDocument'],
    [],
  ],
  [
    'util/zodJsonSchema',
    'platform/operations/zodJsonSchema',
    ['toInputJsonSchema', 'withInputJsonSchema'],
    ['zod'],
  ],
  [
    'util/frontmatter',
    'platform/content/frontmatter',
    ['FrontmatterDoc', 'parseFrontmatter', 'stringifyFrontmatter'],
    ['yaml'],
  ],
  ['util/zip', 'platform/content/zip', ['ZipFile', 'encodeZip'], ['fflate']],
  ['util/version', 'platform/execution/version', ['BUILD_VERSION', 'appVersion'], []],
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

describe('RFC-571 —— 八个原语离开 util/', () => {
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
        "import { appVersion } from './util/version'\n" +
          "import { compareSemver } from '@/util/semver'\n" +
          "export { monotonicNow } from './util/time.ts'\n" +
          "const zip = await import('./util/zip')\n" +
          "const queue = require('./util/keyedSerialQueue')\n" +
          "mock.module('@/util/frontmatter', () => ({}))\n" +
          "type J = import('./util/jsonDocument').JsonDocument\n" +
          "import { toInputJsonSchema } from './platform/operations/zodJsonSchema'\n" +
          "import { z } from 'zod'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'util/version',
      'util/semver',
      'util/time',
      'util/zip',
      'util/keyedSerialQueue',
      'util/frontmatter',
      'util/jsonDocument',
    ])
    const fromTests = join(BACKEND, 'tests', 'helpers', 'probe.ts')
    expect(
      resolvedSpecifiers(
        fromTests,
        "import { encodeZip } from '../../src/util/zip'\n" +
          "import { encodeZip as next } from '../../src/platform/content/zip'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['util/zip'])
  })
})

describe('RFC-571 —— 新位置的文件仍是无依赖的原语', () => {
  test('只取登记过的第三方库：不取模块、util/ 与其他内部文件，不取文件系统与进程', () => {
    for (const [, next, , libraries] of MOVED)
      expect([next, rawSpecifiers(join(SRC, `${next}.ts`)).sort()]).toEqual([
        next,
        [...libraries].sort(),
      ])
  })

  test('导出的名字与搬迁前相同', () => {
    for (const [, next, names] of MOVED)
      expect([next, exportedNames(join(SRC, `${next}.ts`))]).toEqual([next, [...names].sort()])
  })
})
