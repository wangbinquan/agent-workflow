// RFC-575 — `util/errors`、`util/hash` 与 `util/log` 归 platform（RFC-294 W9-D 后继）。
//
// 为什么存在：`util/` 里读者最多的三个基础原语。RFC-575 把 `DomainError` 一族与它的 HTTP 映射迁进 `platform/errors/domainErrors.ts`，把摘要原语
// 迁进 `platform/contracts/hash.ts`，把结构化日志迁进新目录 `platform/logging/logger.ts`，读者一次改指，旧位置不留转出。之后 `util/` 只剩
// git、凭据、文件信任、Windows ACL、OIDC、脱敏与安全路径一族。锁四件事：
// ① 三个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符（别名、相对路径、动态 import、`mock.module`）再解析到它们（判据带负对照）。
// ② 新位置的三个文件只取登记过的依赖，不取模块。
// ③ 三个文件导出的名字与搬迁前相同。
// ④ `util/` 里只剩那一族的 10 个文件（清单钉住；之后每个把文件移出 `util/` 的 RFC 同步这一条）。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读三个新文件；④ 只读 `util/` 目录。
// 三个文件的行为由既有用例覆盖（`log.test`、`rfc284-microhelpers` 的 hash 一条、`rfc285-b5-stale-code-unification`、各路由的错误映射用例等）。
// W9-C 的语义改造（domain / application 错误去 HTTP status、经 `publicError.ts` 映射）不在 RFC-575。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { RFC575_RULE } from './helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')

const SRC = join(BACKEND, 'src')

/** Old location (below `src`, no extension) → new location, with the names each file exported before the move and its imports. */
const MOVED = RFC575_RULE.moved
const OLD = new Set<string>(RFC575_RULE.oldPaths)
/** What `util/` still holds after RFC-575 — nothing since RFC-619 (`util/` is gone). */

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

describe('RFC-575 —— 三个基础原语离开 util/', () => {
  test('旧路径不存在，新路径存在', () => {
    for (const [old, next] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
    }
  })

  // RFC-624: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、动态 import、require、mock.module 与 import 类型都会被认出；新路径、余下的 util 文件与包名不算', () => {
    const fromSrcRoot = join(SRC, 'main.ts')
    expect(
      resolvedSpecifiers(
        fromSrcRoot,
        "import { ValidationError } from './util/errors'\n" +
          "import { sha256Hex } from '@/util/hash'\n" +
          "export { createLogger } from './util/log.ts'\n" +
          "const errors = await import('./util/errors')\n" +
          "const hash = require('./util/hash')\n" +
          "mock.module('@/util/log', () => ({}))\n" +
          "type L = import('./util/log').Logger\n" +
          "import { ValidationError as next } from './platform/errors/domainErrors'\n" +
          "import { runGit } from './util/git'\n" +
          "import { Hono } from 'hono'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'util/errors',
      'util/hash',
      'util/log',
      'util/errors',
      'util/hash',
      'util/log',
      'util/log',
    ])
    const fromUtil = join(SRC, 'util', 'probe.ts')
    expect(
      resolvedSpecifiers(
        fromUtil,
        "import { sha256Hex } from './hash'\n" +
          "import { sha256Hex as next } from '../platform/contracts/hash'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['util/hash'])
  })
})

describe('RFC-575 —— 新位置的文件', () => {
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

// RFC-624: the independent util/ inventory test also lives in the shared scanner suite.
