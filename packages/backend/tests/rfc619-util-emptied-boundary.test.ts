// RFC-619 — `util/` 清空（RFC-294 W9-D 余项：design §2.2“`util/` 中的通用原语归 `platform/`”）。
//
// 为什么存在：`util/` 最后三个文件按 owner 归位，目录随之消失——
// - git 凭据租约 `gitCredentialLease.ts` 与单二进制额外打包的凭据助手入口 `gitCredentialHelper.ts` 迁入 `platform/execution/local/`，与 git 运行器、
//   加固参数和另一个额外入口 `managedProcessLauncherEntry.ts` 同目录：bootstrap、入口 `main.ts` 与 source-control 都用它，放进模块会让前两者深引模块内部；
// - OIDC 回调失败页 `oidcResponse.ts` 迁到唯一读者 `routes/oidc-auth.ts` 旁边：放进 identity-access 会成为 legacy 层取模块内部的新边（RFC-317 R1 禁止），
//   它随 OIDC 路由一族整体迁入 identity-access。
// 唯一的代码改动是租约在源码运行时找 `main.ts` 的相对路径（目录深了两层）。锁五件事：
// ① `util/` 下没有任何源码文件（目录随之消失），三个文件在新位置。
// ② backend 的 `src`、`tests`、`scripts` 与仓库根的 `scripts`、`tests` 里没有文件再经任何写法取 `util/` 下的路径（语料下限 3,000）。
// ③ 单二进制构建脚本的凭据助手入口是新位置，架构门的 `BINARY_ENTRIES` 与之一致，都不再含 `util/`。
// ④ 源码运行时（非内嵌）凭据助手命令里的入口就是 `src/main.ts`，且该文件存在——相对路径错一层这里就红。
// ⑤ 负对照：别名、相对路径与 `mock.module` 三种写法都认得出，字符串里的路径不算；命令解析认得出入口位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import ts from 'typescript'
import { gitCredentialHelperValue } from '@/platform/execution/local/gitCredentialLease'
import { binaryEntries } from './architecture/architectureReport'
import { BINARY_ENTRIES } from './architecture/rfc294Gates'
import { RFC619_MOVED as MOVED } from './helpers/rfc624MigrationReferenceRules'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')

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

/** Specifiers of a file that resolve below `src/util/`. */
function utilImports(path: string, text: string): string[] {
  return specifiers(path, text).filter((specifier) => {
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? normalize(join(dirname(path), specifier))
        : null
    return target !== null && relative(SRC, target).replaceAll('\\', '/').startsWith('util/')
  })
}

/** The argv of a `!'a' 'b' …` git credential helper value, unquoted. */
function helperArgv(value: string): string[] {
  expect(value.startsWith('!')).toBe(true)
  return [...value.slice(1).matchAll(/'((?:[^']|'"'"')*)'/g)].map((match) =>
    match[1]!.replaceAll(`'"'"'`, "'"),
  )
}

describe('RFC-619 —— util/ 清空', () => {
  test('三个旧文件不在、新文件在（递归空目录与全仓引用扫描见 rfc624-migration-reference-guard）', () => {
    for (const [old, next] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
    }
  })

  // RFC-629: this rule's full-corpus scan and recursive `src/util` check are registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('单二进制的凭据助手入口在新位置，架构门的入口清单与构建脚本一致', () => {
    const helper = 'packages/backend/src/platform/execution/local/gitCredentialHelper.ts'
    const built = binaryEntries(readFileSync(join(REPO, 'scripts', 'build-binary.ts'), 'utf8'))
    expect(built).toContain(helper)
    expect([...BINARY_ENTRIES]).toContain(helper)
    expect(built.filter((entry) => entry.includes('/src/util/'))).toEqual([])
    expect(BINARY_ENTRIES.filter((entry) => entry.includes('/src/util/'))).toEqual([])
  })

  test('源码运行时凭据助手命令里的入口就是存在的 src/main.ts', () => {
    const argv = helperArgv(gitCredentialHelperValue())
    expect(argv[1]).toBe('run')
    expect(argv[2]).toBe(join(SRC, 'main.ts'))
    expect(existsSync(argv[2]!)).toBe(true)
    expect(argv.at(-1)).toBe('__git-credential')
  })
})

describe('RFC-619 —— 负对照（伪造源码）', () => {
  test('判据认得出别名、相对路径与 mock.module 三种写法，字符串里的路径不算', () => {
    expect(
      utilImports(
        join(BACKEND, 'tests', 'probe.test.ts'),
        [
          "import { leaseGitCredential } from '@/util/gitCredentialLease'",
          "import { friendly } from '../src/util/oidcResponse'",
          "mock.module('@/util/gitCredentialHelper', () => ({}))",
          'const quoted = "import x from \'@/util/gitCredentialLease\'"',
          "import { runGit } from '@/platform/execution/local/gitProcess'",
          "import { u } from '@/utility/x'",
        ].join('\n'),
      ),
    ).toEqual([
      '@/util/gitCredentialLease',
      '../src/util/oidcResponse',
      '@/util/gitCredentialHelper',
    ])
  })

  test('命令解析认得出入口位置，包括带空格与单引号的路径', () => {
    expect(
      helperArgv(`!'/opt/bun' 'run' '/home/a b/it'"'"'s/src/main.ts' '__git-credential'`),
    ).toEqual(['/opt/bun', 'run', "/home/a b/it's/src/main.ts", '__git-credential'])
  })
})
