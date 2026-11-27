// RFC-571 — `util/` 的八个通用原语归 platform（RFC-294 W9-D 后继）。
//
// 为什么存在：legacy 横向目录 `util/` 里有一批与业务无关、没有任何内部依赖的原语，RFC-294 design §2 与架构报告的归属表给它们的去向都是 platform。
// RFC-571 原样搬了八个，读者一次改指，旧位置不留转出；当时因为读者里有身份认证与任务授权的文件而留下的 `inFlight` 与 `sqlChunk`，在 RFC-572
// 定下“这类文件只改 import 说明符一行”之后按同样的做法补迁，一并锁在这里（共十个）。锁三件事：
// ① 十个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符（别名、相对路径、动态 import、`mock.module`）再解析到它们（判据带负对照）。
// ② 新位置的十个文件只取登记过的第三方库——不取模块、不取 `util/` 与其他 legacy 目录、不取文件系统与进程。
// ③ 每个文件导出的名字与搬迁前相同。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读十个新文件。各原语的行为由它们
// 既有的用例覆盖（`keyed-serial-queue`、`rfc271-zip-roundtrip`、`zip-fixed-mtime-timezone`、`zod4-contracts`、`rfc143` 的 semver 一条、
// `rfc284-microhelpers` 的 monotonic 一条等）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { RFC571_RULE } from './helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')

const SRC = join(BACKEND, 'src')

/** Old location (below `src`, no extension) → new location, with the names each file exported before the move. */
const MOVED = RFC571_RULE.moved
const OLD = new Set<string>(RFC571_RULE.oldPaths)

/**
 * Every module specifier a file names — imports, re-exports, `import('…')` (types and calls), `require('…')` and
 * `mock.module('…')` — resolved to a path below `src` without its extension (null when it leaves `src` or is a package).
 */
function resolvedSpecifiers(path: string, text: string): string[] {
  return resolveMigrationSpecifiers(SRC, path, text)
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

describe('RFC-571 —— 十个原语离开 util/', () => {
  test('旧路径不存在，新路径存在', () => {
    for (const [old, next] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
    }
  })

  // RFC-624: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

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
          "import { chunkedAll } from '@/util/sqlChunk'\n" +
          "import { createInFlightCoalescer } from './util/inFlight'\n" +
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
      'util/sqlChunk',
      'util/inFlight',
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
