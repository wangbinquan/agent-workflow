// RFC-593 — `util/git` 的仓库语义整体归 source-control（RFC-294 W5 余项第五步，`util/git` 收口）。
//
// 为什么存在：`util/git.ts` 整份迁入 `modules/source-control/infrastructure/local/gitRepository.ts`（通用运行器与两个只读查询在 RFC-591 / RFC-592 已进
// platform）；task-execution 与装配根要的 4 个名字经 source-control 的 `public/participants` 取。锁四件事：
// ① 旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它（判据带负对照）。
// ② source-control 之外的生产文件不直接取新文件，只经 `public/participants`（判据带负对照）。
// ③ `public/participants` 转出了那 4 个名字。
// ④ 新文件只取 platform、shared、node 内置与本模块 domain（判据带负对照）。
//
// 覆盖范围（C12）：① ② 覆盖 backend 的 `src`（② 只看生产文件）、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；③ ④ 只读两个文件。
// 行为由既有用例覆盖（`git.test.ts`、快照 / 回滚 / 子模块 / 工作树一族、`rfc377` 的叶子锁）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const GIT = 'modules/source-control/infrastructure/local/gitRepository'
const PARTICIPANTS = 'modules/source-control/public/participants'
const OFFERED = ['rollbackToSnapshot', 'worktreeFilesChanged'] as const
const read = (file: string) => readFileSync(join(SRC, `${file}.ts`), 'utf8')

/** Module specifiers of the git repository file that leave platform, shared, node and the module's own domain. */
function gitLeaks(text: string): string[] {
  const source = ts.createSourceFile(`${GIT}.ts`, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    !statement.moduleSpecifier.text.startsWith('node:') &&
    statement.moduleSpecifier.text !== '@agent-workflow/shared' &&
    !statement.moduleSpecifier.text.startsWith('@/platform/') &&
    !statement.moduleSpecifier.text.startsWith('../../domain/')
      ? [statement.moduleSpecifier.text]
      : [],
  )
}

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

describe('RFC-593 —— util/git 归 source-control', () => {
  test('旧路径不存在，新文件存在；src / tests / scripts 的全部说明符不再解析到旧路径', () => {
    expect(existsSync(join(SRC, 'util', 'git.ts'))).toBe(false)
    expect(existsSync(join(SRC, `${GIT}.ts`))).toBe(true)
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
          .filter((target) => target === 'util/git')
          .map((target) => `${slash(relative(REPO, path))} -> ${target}`),
      ),
    ).toEqual([])
  }, 240_000)

  test('负对照：别名、相对路径、带扩展名、动态 import 与 import 类型都会被认出；同前缀的 util 文件与新位置不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { runGit } from '@/util/git'\n" +
          "export { listBranches } from './util/git.ts'\n" +
          "const git = await import('./util/git')\n" +
          "export type Probe = typeof import('@/util/git')\n" +
          "import { hardenGitArgs } from '@/util/gitHardening'\n" +
          `import { listBranches as next } from './${GIT}'\n`,
      ).filter((target) => target === 'util/git'),
    ).toEqual(['util/git', 'util/git', 'util/git', 'util/git'])
  })

  test('source-control 之外的生产文件只经 public/participants 取', () => {
    const outside = walk(SRC).filter(
      (path) => !slash(relative(SRC, path)).startsWith('modules/source-control/'),
    )
    expect(outside.length).toBeGreaterThanOrEqual(2000)
    expect(
      outside.flatMap((path) =>
        resolvedSpecifiers(path, readFileSync(path, 'utf8'))
          .filter((target) => target === GIT)
          .map(() => slash(relative(SRC, path))),
      ),
    ).toEqual([])
  })

  test('负对照：task-execution 直接取新文件会被认出', () => {
    const probe = join(SRC, 'modules', 'task-execution', 'infrastructure', 'probe.ts')
    expect(
      resolvedSpecifiers(
        probe,
        `import { rollbackToSnapshot } from '@/${GIT}'\n` +
          `import { worktreeFilesChanged } from '@/${PARTICIPANTS}'\n`,
      ).filter((target) => target === GIT),
    ).toEqual([GIT])
  })

  test('public/participants 转出那 4 个名字', () => {
    const offered = offeredNames(`${PARTICIPANTS}.ts`, read(PARTICIPANTS))
    for (const name of OFFERED) expect([name, offered.includes(name)]).toEqual([name, true])
  })

  test('新文件只取 platform、shared、node 内置与本模块 domain；负对照：取别的模块或 util 会被认出', () => {
    expect(gitLeaks(read(GIT))).toEqual([])
    expect(
      gitLeaks(
        "import { runGit } from '@/platform/execution/local/gitProcess'\n" +
          "import { hardenGitArgs } from '@/util/gitHardening'\n" +
          "import type { Task } from '@/modules/task-execution/public/types'\n",
      ),
    ).toEqual(['@/util/gitHardening', '@/modules/task-execution/public/types'])
  })
})
