// RFC-591 — git 进程运行器归 platform（RFC-294 W5 余项第三步：`util/git` 拆成通用运行器与仓库语义）。
//
// 为什么存在：`runGit`、`nonInteractiveGitEnv`、`GitRunResult` 与两个退出码逐字迁入 `platform/execution/local/gitProcess.ts`——它是厂商命令行
// 客户端（加固参数、非交互环境、超时 / 取消时杀进程组），不是仓库语义；platform 自己也要跑 git，而 platform 不依赖模块。`util/git.ts` 留下仓库
// 语义，下一步整体归 source-control。锁四件事：
// ① 五个名字只在新文件定义，`util/git.ts` 不再导出它们。
// ② `src` / `tests` / `scripts` 里没有任何 import 从 `util/git` 取这五个名字（判据带负对照）。
// ③ 新文件只取 platform，不取任何模块（判据带负对照；RFC-617 起加固参数 `gitHardening` 也在 platform，原来对 `util/gitHardening` 的放行随之删去）。
// ④ 运行器的几处要害仍在新文件里（加固参数、非交互环境、进程组杀法、两个退出码），`util/git.ts` 里不再有 `Bun.spawn`。
//
// 覆盖范围（C12）：② 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；① ③ ④ 只读两个文件。运行器的行为由既有
// 用例覆盖（`git.test.ts`、`git-noninteractive-env`、`rfc208` / `rfc287` 的超时与取消、`rfc252` 的加固、`rfc284-git-twin-textlock`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { RFC591_MOVED_NAMES as MOVED } from './helpers/rfc624MigrationReferenceRules'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const RUNNER = 'platform/execution/local/gitProcess.ts'
const UTIL_GIT = 'util/git.ts'
const read = (file: string) => readFileSync(join(SRC, file), 'utf8')

/** `<file> imports <name> from util/git` for every named import (or re-export) of a moved name whose specifier resolves to util/git. */
function utilGitImportsOfMoved(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement)
    const isExport = ts.isExportDeclaration(statement)
    if ((!isImport && !isExport) || statement.moduleSpecifier === undefined) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bare = statement.moduleSpecifier.text.replace(/\.(?:[cm]?tsx?|[cm]?js)$/, '')
    const target = bare.startsWith('@/')
      ? join(SRC, bare.slice(2))
      : bare.startsWith('.')
        ? resolve(dirname(path), bare)
        : null
    if (target === null || slash(relative(SRC, target)) !== 'util/git') continue
    const names: string[] = []
    if (isImport) {
      const bindings = statement.importClause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          names.push((element.propertyName ?? element.name).text)
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push('*')
    } else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements)
        names.push((element.propertyName ?? element.name).text)
    } else names.push('*')
    for (const name of names)
      if ((MOVED as readonly string[]).includes(name))
        out.push(`${slash(relative(REPO, path))} -> ${name}`)
  }
  return out
}

/** Module specifiers of the runner that leave platform (RFC-617 moved `gitHardening` into platform). */
function runnerLeaks(text: string): string[] {
  const source = ts.createSourceFile(RUNNER, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith('@/') &&
    !statement.moduleSpecifier.text.startsWith('@/platform/')
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

/** Names a file offers: `export { … } [from]`, `export type { … } [from]` and `export` declarations. */
function offeredNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
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

describe('RFC-591 —— 运行器在 platform', () => {
  test('五个名字只在新文件定义，util/git.ts 不再导出它们', () => {
    expect(existsSync(join(SRC, RUNNER))).toBe(true)
    const runner = offeredNames(RUNNER, read(RUNNER))
    // RFC-593: util/git.ts itself moved into source-control (its old location no longer exists).
    const utilGit = existsSync(join(SRC, UTIL_GIT)) ? offeredNames(UTIL_GIT, read(UTIL_GIT)) : []
    for (const name of MOVED) {
      expect([name, runner.includes(name)]).toEqual([name, true])
      expect([name, utilGit.includes(name)]).toEqual([name, false])
    }
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、type import 与转出都会被认出；别的名字与新位置不算', () => {
    expect(
      utilGitImportsOfMoved(
        join(BACKEND, 'tests', 'probe.test.ts'),
        "import { runGit, listBranches } from '@/util/git'\n" +
          "import type { GitRunResult } from '../src/util/git.ts'\n" +
          "export { nonInteractiveGitEnv } from '../src/util/git'\n" +
          "import { GIT_TIMEOUT_EXIT_CODE } from '@/platform/execution/local/gitProcess'\n" +
          "import { classifyBaseRef } from '@/util/git'\n",
      ),
    ).toEqual([
      'packages/backend/tests/probe.test.ts -> runGit',
      'packages/backend/tests/probe.test.ts -> GitRunResult',
      'packages/backend/tests/probe.test.ts -> nonInteractiveGitEnv',
    ])
  })
})

describe('RFC-591 —— 运行器只取 platform 与加固参数', () => {
  test('新文件只 import platform', () => {
    expect(runnerLeaks(read(RUNNER))).toEqual([])
  })

  test('负对照：取模块、取 util 都会被认出', () => {
    expect(
      runnerLeaks(
        "import { hardenGitArgs } from '@/platform/execution/local/gitHardening'\n" +
          "import type { Probe } from '@/modules/source-control/public/types'\n" +
          "import { classifyBaseRef } from '@/util/git'\n",
      ),
    ).toEqual(['@/modules/source-control/public/types', '@/util/git'])
  })

  test('运行器的要害在新文件里，util/git.ts 不再 spawn', () => {
    const runner = read(RUNNER)
    for (const anchor of [
      "cmd: ['git', ...hardenGitArgs(['-C', cwd, ...args])],",
      'opts?.env === undefined ? nonInteractiveGitEnv() : { ...nonInteractiveGitEnv(), ...opts.env },',
      "process.kill(-proc.pid, 'SIGKILL')",
      'export const GIT_TIMEOUT_EXIT_CODE = 124',
      'export const GIT_ABORTED_EXIT_CODE = 125',
      "GIT_TERMINAL_PROMPT: '0',",
    ])
      expect([anchor, runner.includes(anchor)]).toEqual([anchor, true])
    // RFC-593: the repository semantics (formerly util/git.ts) live in source-control now; they still never spawn git.
    expect(read('modules/source-control/infrastructure/local/gitRepository.ts')).not.toMatch(
      /\bBun\.spawn\(/,
    )
  })
})
