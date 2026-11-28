// RFC-592 — 两个只读 git 查询归 platform，协作的回滚经装配绑定交进来（RFC-294 W5 余项第四步）。
//
// 为什么存在：`util/git.ts` 的仓库语义下一步归 source-control，而 collaboration 与 runtime-management 到 source-control 都没有 DAG 边。
// `gitMetaDirsFor`（工作树的共享 / admin git 目录）与 `gitCommitExists`（对象在不在）只经通用运行器问 git 一句话，逐字迁入
// `platform/workspace/local/gitQueries.ts`；评审门的工作区回滚执行器要的 `rollbackToSnapshot` 作为 `TaskExecutionParticipantBindings` 的一项由装配根
// 给出（RFC-477 立的形状）。锁四件事：
// ① 两个查询只在新文件定义，`util/git.ts` 不再导出它们；新文件只取 platform（判据带负对照）。
// ② `src` / `tests` / `scripts` 里没有任何 import 从 `util/git` 取这两个名字（判据带负对照）。
// ③ collaboration 与 runtime-management 的源码里没有任何 import 取 `util/git`（判据带负对照）。
// ④ 执行器经绑定里的回滚函数回滚；`composeGateContinuationSupport` 把它传给执行器；装配根的绑定给出了实现。
//
// 覆盖范围（C12）：② 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；③ 覆盖两个模块目录；① ④ 只读相关文件。
// 行为由既有用例覆盖（评审回滚、`rfc281-workspace-boundary` 的沙箱放行、`rfc098` 的回滚前置检查）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const QUERIES = 'platform/workspace/local/gitQueries.ts'
const UTIL_GIT = 'util/git.ts'
const MOVED = ['gitCommitExists', 'gitMetaDirsFor'] as const
const read = (file: string) => readFileSync(join(SRC, file), 'utf8')

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

/**
 * `<file> -> <name>` for each name a file imports or re-exports from a specifier that resolves to util/git (a namespace
 * import or bare re-export is `*`). With `only`, just those names are reported.
 */
function utilGitImports(path: string, text: string, only?: readonly string[]): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement)
    if (
      (!isImport && !ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined
    )
      continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bare = statement.moduleSpecifier.text.replace(/\.(?:[cm]?tsx?|[cm]?js)$/, '')
    const target = bare.startsWith('@/')
      ? join(SRC, bare.slice(2))
      : bare.startsWith('.')
        ? resolve(dirname(path), bare)
        : null
    if (target === null || slash(relative(SRC, target)) !== 'util/git') continue
    const names: string[] = []
    const clause = isImport ? statement.importClause?.namedBindings : statement.exportClause
    if (clause !== undefined && (ts.isNamedImports(clause) || ts.isNamedExports(clause)))
      for (const element of clause.elements) names.push((element.propertyName ?? element.name).text)
    else names.push('*')
    for (const name of names)
      if (only === undefined || only.includes(name))
        out.push(`${slash(relative(REPO, path))} -> ${name}`)
  }
  return out
}

/** Module specifiers of the query file that leave platform. */
function queryLeaks(text: string): string[] {
  const source = ts.createSourceFile(QUERIES, text, ts.ScriptTarget.Latest, true)
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

describe('RFC-592 —— 两个查询在 platform', () => {
  test('两个查询只在新文件定义，util/git.ts 不再导出它们；新文件只取 platform', () => {
    expect(existsSync(join(SRC, QUERIES))).toBe(true)
    const queries = offeredNames(QUERIES, read(QUERIES))
    // RFC-593: util/git.ts itself moved into source-control (its old location no longer exists).
    const utilGit = existsSync(join(SRC, UTIL_GIT)) ? offeredNames(UTIL_GIT, read(UTIL_GIT)) : []
    for (const name of MOVED) {
      expect([name, queries.includes(name)]).toEqual([name, true])
      expect([name, utilGit.includes(name)]).toEqual([name, false])
    }
    expect(queryLeaks(read(QUERIES))).toEqual([])
  })

  test('负对照：新文件取模块或 util 会被认出', () => {
    expect(
      queryLeaks(
        "import { runGit } from '@/platform/execution/local/gitProcess'\n" +
          "import { classifyBaseRef } from '@/util/git'\n" +
          "import type { Probe } from '@/modules/source-control/public/types'\n",
      ),
    ).toEqual(['@/util/git', '@/modules/source-control/public/types'])
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名与转出都会被认出；别的名字与新位置不算', () => {
    expect(
      utilGitImports(
        join(BACKEND, 'tests', 'probe.test.ts'),
        "import { gitCommitExists, rollbackToSnapshot } from '@/util/git'\n" +
          "export { gitMetaDirsFor } from '../src/util/git.ts'\n" +
          "import { gitMetaDirsFor as dirs } from '@/platform/workspace/local/gitQueries'\n",
        MOVED,
      ),
    ).toEqual([
      'packages/backend/tests/probe.test.ts -> gitCommitExists',
      'packages/backend/tests/probe.test.ts -> gitMetaDirsFor',
    ])
  })
})

describe('RFC-592 —— collaboration 与 runtime-management 不取 util/git', () => {
  test('两个模块目录下没有任何 import 取 util/git', () => {
    const files = ['modules/collaboration', 'modules/runtime-management'].flatMap((root) =>
      walk(join(SRC, root)),
    )
    expect(files.length).toBeGreaterThanOrEqual(100)
    expect(
      files.flatMap((path) => {
        const text = readFileSync(path, 'utf8')
        if (!text.includes('git') && !text.includes('\\u') && !text.includes('\\x')) return []
        return utilGitImports(path, text)
      }),
    ).toEqual([])
  })

  test('负对照：任何名字或整个命名空间取自 util/git 都会被认出', () => {
    const probe = join(SRC, 'modules', 'collaboration', 'infrastructure', 'probe.ts')
    expect(
      utilGitImports(
        probe,
        "import { rollbackToSnapshot } from '@/util/git'\nimport * as git from '../../../util/git'\n",
      ),
    ).toEqual([
      'packages/backend/src/modules/collaboration/infrastructure/probe.ts -> rollbackToSnapshot',
      'packages/backend/src/modules/collaboration/infrastructure/probe.ts -> *',
    ])
  })
})

describe('RFC-592 —— 评审门的回滚经装配绑定', () => {
  test('执行器经绑定里的回滚函数回滚，composition 传给它，装配根的绑定给出实现', () => {
    expect(read('modules/collaboration/infrastructure/gateWorkspaceRollbackExecutor.ts')).toContain(
      'await this.rollbackWorkspaceToSnapshot(target.worktreePath, target.snapshot)',
    )
    expect(read('modules/collaboration/composition.ts')).toContain(
      'input.taskExecutionParticipants.rollbackWorkspaceToSnapshot,',
    )
    expect(
      read('modules/collaboration/infrastructure/taskExecutionParticipantBindings.ts'),
    ).toContain(
      'readonly rollbackWorkspaceToSnapshot: (worktreePath: string, snapshot: string) => Promise<void>',
    )
    expect(read('bootstrap/crossContextClosure.ts')).toContain(
      'rollbackWorkspaceToSnapshot: rollbackToSnapshot,',
    )
  })
})
