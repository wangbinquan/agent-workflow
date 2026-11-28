// RFC-621 — `auth/` 的两个中性原语离开 legacy 目录（RFC-294 W9-D 余项）。
//
// 为什么存在：`SYSTEM_USER_ID`（框架 built-in 的 owner、框架自发写入的主体 id，shared 的 ACL schema 注释里一直写着 `'__system__'`）迁入
// `@agent-workflow/shared`，`auth/actor.ts` 不再转出它；守护进程令牌文件（`generateToken` / `ensureTokenFile` / `rotateTokenFile`，唯一的生产读者是
// bootstrap）原样迁入 `platform/crypto/tokenFile.ts`，与静态加密盒的密钥文件同目录。读者一次改指，旧位置不留转出。锁四件事：
// ① 两个旧文件不在；shared 声明并导出 `SYSTEM_USER_ID = '__system__'`；令牌文件只取 node 内置。
// ② backend 的 `src`、`tests`、`scripts` 与仓库根的 `scripts`、`tests` 里没有文件再经任何写法取两个旧位置（语料下限 3,000）。
// ③ 单一来处：`auth/actor.ts` 不再转出 `SYSTEM_USER_ID`，backend 生产代码里没有第二处声明它。
// ④ 负对照（伪造源码）：别名、相对路径、动态 import 与 `mock.module` 都认得出，字符串里的路径不算；转出与重新声明都认得出。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import ts from 'typescript'
import * as shared from '@agent-workflow/shared'

import { RFC621_OLD as OLD } from './helpers/rfc624MigrationReferenceRules'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(?:[cm]?ts|mjs)$/.test(name) ? [path] : []
  })
}

/**
 * Every module specifier a file names on the syntax tree — imports, re-exports, `import('…')`, `require('…')` and
 * `mock.module('…')` — so specifiers quoted inside other strings (negative fixtures) never count.
 */
function specifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      out.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]!
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module') &&
        ts.isStringLiteralLike(first)
      )
        out.push(first.text)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return out
}

/** Specifiers of a file that reach one of the two old locations. */
function oldImports(path: string, text: string): string[] {
  return specifiers(path, text).filter((specifier) => {
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? normalize(join(dirname(path), specifier))
        : null
    if (target === null) return false
    const rel = relative(SRC, target)
      .replaceAll('\\', '/')
      .replace(/\.(?:ts|js|mjs)$/, '')
    return (OLD as readonly string[]).includes(rel)
  })
}

/** Where a file declares or re-exports `SYSTEM_USER_ID` (a variable, a function or an export specifier). */
function systemUserIdSites(path: string, text: string): string[] {
  if (!text.includes('SYSTEM_USER_ID') && !text.includes('\\u')) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'SYSTEM_USER_ID'
    )
      found.push('declares')
    if (ts.isExportSpecifier(node) && node.name.text === 'SYSTEM_USER_ID') found.push('re-exports')
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

describe('RFC-621 —— auth/ 的两个中性原语离开 legacy 目录', () => {
  test('旧文件不在；shared 声明并导出 SYSTEM_USER_ID；令牌文件只取 node 内置', () => {
    for (const old of OLD) expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
    expect(shared.SYSTEM_USER_ID).toBe('__system__')
    const declared = join(REPO, 'packages', 'shared', 'src', 'systemIdentity.ts')
    expect(systemUserIdSites(declared, readFileSync(declared, 'utf8'))).toEqual(['declares'])
    const tokenFile = join(SRC, 'platform', 'crypto', 'tokenFile.ts')
    const text = readFileSync(tokenFile, 'utf8')
    expect(
      specifiers(tokenFile, text).filter((specifier) => !specifier.startsWith('node:')),
    ).toEqual([])
    for (const name of [
      'export function generateToken(',
      'export function ensureTokenFile(',
      'export function rotateTokenFile(',
    ])
      expect([name, text.includes(name)]).toEqual([name, true])
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('单一来处：auth/actor 不再转出，backend 生产代码里没有第二处声明', () => {
    const production = walk(SRC)
    expect(production.length).toBeGreaterThanOrEqual(1500)
    const found = production.flatMap((path) =>
      systemUserIdSites(path, readFileSync(path, 'utf8')).map(
        (site) => `${relative(BACKEND, path)} ${site}`,
      ),
    )
    expect(found).toEqual([])
  }, 60_000)
})

describe('RFC-621 —— 负对照（伪造源码）', () => {
  test('判据认得出四种写法，字符串里的路径不算', () => {
    expect(
      oldImports(
        join(BACKEND, 'tests', 'probe.test.ts'),
        [
          "import { SYSTEM_USER_ID } from '@/auth/systemIdentity'",
          "import { ensureTokenFile } from '../src/auth/token'",
          "const later = await import('../src/auth/systemIdentity')",
          "mock.module('@/auth/token', () => ({}))",
          'const quoted = "import x from \'@/auth/token\'"',
          "import { tokenSnapshot } from '@/auth/tokenRedaction'",
        ].join('\n'),
      ),
    ).toEqual([
      '@/auth/systemIdentity',
      '../src/auth/token',
      '../src/auth/systemIdentity',
      '@/auth/token',
    ])
  })

  test('判据认得出转出与重新声明，近似名不算', () => {
    expect(
      systemUserIdSites(
        join(SRC, 'auth', 'probe.ts'),
        [
          "export { SYSTEM_USER_ID } from '@agent-workflow/shared'",
          "export const SYSTEM_USER_ID = '__system__'",
          'const SYSTEM_USER_ID_PREFIX = 1',
          "import { SYSTEM_USER_ID as owner } from '@agent-workflow/shared'",
        ].join('\n'),
      ),
    ).toEqual(['re-exports', 'declares'])
  })
})
