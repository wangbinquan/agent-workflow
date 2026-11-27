// RFC-582 — task-execution 的端口产物与工作树文件路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第七批）。
//
// 为什么存在：两个路由原样迁进 `modules/task-execution/inbound/http/`，挂载函数经模块的 `composition.ts` 转出，`server.ts` 从那里取；它们取的本模块
// public 别处也在用，撤回 0 个。锁三件事：
// ① 两个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 两个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application / domain / public）与登记过的别的模块 public
//    （工作树文件路由：source-control `public/types`）；不取 `@/db` 与 `services/`（判据带负对照）。
// ③ `server.ts` 从 composition 取两个挂载函数，不再取 `@/routes/` 下的这两个文件。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读两个绑定；③ 只读 `server.ts`。路由
// 行为由既有用例覆盖（`rfc193-port-artifacts-api`、`rfc349-port-artifact-provider`、`rfc287-t14-empty-root-containment`、`worktree-files-acl`、
// `worktree-files-proxy`、`rfc370-v4-worktree-file-download` 与 `routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { RFC582_RULE } from './helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')

const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location → new location (below `src`, no extension), owning module, mount function, other modules' public it may take. */
const MOVED = RFC582_RULE.moved
const OLD = new Set<string>(RFC582_RULE.oldPaths)

/**
 * Every module specifier a file names — imports, re-exports, `import('…')` (types and calls), `require('…')` and
 * `mock.module('…')` — resolved to a path below `src` without its extension (null when it leaves `src` or is a package).
 */
function resolvedSpecifiers(path: string, text: string): string[] {
  return resolveMigrationSpecifiers(SRC, path, text)
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

/** Module imports of a binding of module `owner` (a path below `src`) that break ②, as `<specifier> (<why>)`. */
function bindingLeaks(
  owner: string,
  allowedOtherPublic: readonly string[],
  path: string,
  text: string,
): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    if (/^@\/(?:db|services)(?:\/|$)/.test(specifier)) {
      out.push(`${specifier} (legacy data or service layer)`)
      continue
    }
    if (specifier.startsWith('.')) {
      const target = slash(relative(SRC, resolve(dirname(join(SRC, path)), specifier)))
      if (
        !target.startsWith(`modules/${owner}/application/`) &&
        !target.startsWith(`modules/${owner}/domain/`) &&
        !target.startsWith(`modules/${owner}/public/`)
      )
        out.push(
          `${specifier} (relative import outside this module's application / domain / public)`,
        )
      continue
    }
    if (
      specifier.startsWith('@/modules/') &&
      !specifier.startsWith(`@/modules/${owner}/public/`) &&
      !allowedOtherPublic.includes(specifier)
    )
      out.push(`${specifier} (an unlisted module entry, or this module outside public)`)
  }
  return out
}

describe('RFC-582 —— 两个绑定离开 routes/', () => {
  test('旧路径不存在，新路径存在，挂载函数还在', () => {
    for (const [old, next, , mount] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
      expect([
        next,
        offeredNames(`${next}.ts`, readFileSync(join(SRC, `${next}.ts`), 'utf8')).includes(mount),
      ]).toEqual([next, true])
    }
  })

  // RFC-624: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、动态 import、mock.module 与 import 类型都会被认出；新路径与别的路由不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { mountPortArtifactRoutes } from '@/routes/port-artifacts'\n" +
          "export { mountWorktreeFilesRoutes } from './routes/worktree-files.ts'\n" +
          "const files = await import('./routes/worktree-files')\n" +
          "mock.module('@/routes/port-artifacts', () => ({}))\n" +
          "import { mountPortArtifactRoutes as next } from './modules/task-execution/inbound/http/portArtifactRoutes'\n" +
          "import { mountTaskRoutes } from './routes/tasks'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'routes/port-artifacts',
      'routes/worktree-files',
      'routes/worktree-files',
      'routes/port-artifacts',
    ])
    expect(
      resolvedSpecifiers(
        join(BACKEND, 'tests', 'helpers', 'probe.ts'),
        "import { mountWorktreeFilesRoutes } from '../../src/routes/worktree-files'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/worktree-files'])
  })
})

describe('RFC-582 —— 绑定只取本模块与登记过的别的模块 public', () => {
  test('两个绑定对模块的 import 只取本模块与登记过的入口', () => {
    for (const [, next, owner, , allowed] of MOVED)
      expect([
        next,
        bindingLeaks(owner, allowed, `${next}.ts`, readFileSync(join(SRC, `${next}.ts`), 'utf8')),
      ]).toEqual([next, []])
  })

  test('登记过的别的模块入口确实被取用（登记表不是空转）', () => {
    for (const [, next, , , allowed] of MOVED) {
      const text = readFileSync(join(SRC, `${next}.ts`), 'utf8')
      for (const specifier of allowed)
        expect([next, text.includes(`from '${specifier}'`)]).toEqual([next, true])
    }
  })

  test('负对照：未登记的别的模块、本模块 infrastructure 或 composition、legacy 数据层与越出本模块的相对路径都会被认出', () => {
    expect(
      bindingLeaks(
        'task-execution',
        ['@/modules/source-control/public/types'],
        'modules/task-execution/inbound/http/probe.ts',
        "import type { TaskRouteOperations } from '@/modules/task-execution/public/commands'\n" +
          "import type { RepositoryMirror } from '@/modules/source-control/public/types'\n" +
          "import type { MemoryOperations } from '@/modules/memory/public/operations'\n" +
          "import { compose } from '@/modules/task-execution/composition'\n" +
          "import type { Store } from '../../infrastructure/portArtifactStore'\n" +
          "import { readPortArtifact } from '@/services/portArtifacts'\n" +
          "import { openDb } from '@/db/client'\n",
      ),
    ).toEqual([
      '@/modules/memory/public/operations (an unlisted module entry, or this module outside public)',
      '@/modules/task-execution/composition (an unlisted module entry, or this module outside public)',
      "../../infrastructure/portArtifactStore (relative import outside this module's application / domain / public)",
      '@/services/portArtifacts (legacy data or service layer)',
      '@/db/client (legacy data or service layer)',
    ])
  })
})

describe('RFC-582 —— 装配根', () => {
  test('server.ts 从 composition 取两个挂载函数，不再取 @/routes/ 下的这两个文件', () => {
    const text = readFileSync(join(SRC, 'server.ts'), 'utf8')
    const source = ts.createSourceFile('server.ts', text, ts.ScriptTarget.Latest, true)
    const found: string[] = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue
      const specifier = statement.moduleSpecifier.text
      expect([specifier, OLD.has(specifier.replace(/^@\//, ''))]).toEqual([specifier, false])
      const bindings = statement.importClause?.namedBindings
      for (const [, , owner, mount] of MOVED)
        if (
          specifier === `@/modules/${owner}/composition` &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some((element) => element.name.text === mount)
        )
          found.push(mount)
    }
    expect(found.sort()).toEqual(MOVED.map(([, , , mount]) => mount).sort())
  })
})
