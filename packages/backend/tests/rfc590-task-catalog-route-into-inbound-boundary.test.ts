// RFC-590 — 任务目录路由归入 task-catalog 的 inbound，模块不再有 public 面（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第十二批）。
//
// 为什么存在：`routes/taskCatalog.ts` 迁入 task-catalog 的 `inbound/http/taskCatalogRoutes.ts`；它是 task-catalog public 面唯一的消费者，迁入之后
// `TaskCatalogQueries` 与两个参数类型撤回（定义在 `application/ports/taskCatalogQueries.ts`），`public/` 删掉——task-catalog 只由装配根经 composition
// 取用（`rfc317-module-boundary` 的 R3 按 RFC-590 改准的判据放行）。锁四件事：
// ① 旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它（判据带负对照）。
// ② 绑定只取本模块（判据带负对照）。
// ③ task-catalog 没有 `public/`，`src` 里没有任何说明符解析到 `modules/task-catalog/public/**`；装配根经 composition 取用它。
// ④ `server.ts` 从 task-catalog 的 composition 取挂载函数。
//
// 覆盖范围（C12）：① ③ 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读绑定；④ 只读 `server.ts`。
// 路由行为由既有用例覆盖（`rfc310-task-catalog`、`routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const BINDING = 'modules/task-catalog/inbound/http/taskCatalogRoutes'
const read = (file: string) => readFileSync(join(SRC, `${file}.ts`), 'utf8')

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

describe('RFC-590 —— 绑定离开 routes/', () => {
  test('旧路径不存在，新绑定存在，挂载函数还在', () => {
    expect(existsSync(join(SRC, 'routes', 'taskCatalog.ts'))).toBe(false)
    expect(existsSync(join(SRC, `${BINDING}.ts`))).toBe(true)
    expect(offeredNames(`${BINDING}.ts`, read(BINDING))).toContain('mountTaskCatalogRoutes')
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、动态 import 与 import 类型都会被认出；新位置与同前缀的路由不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { mountTaskCatalogRoutes } from '@/routes/taskCatalog'\n" +
          "export { mountTaskCatalogRoutes as m } from './routes/taskCatalog.ts'\n" +
          "const catalog = await import('./routes/taskCatalog')\n" +
          "export type Probe = typeof import('@/modules/task-catalog/public/queries')\n" +
          `import { mountTaskCatalogRoutes as next } from './${BINDING}'\n` +
          "import { mountTaskRoutes } from './modules/task-execution/inbound/http/taskRoutes'\n",
      ).filter(
        (target) =>
          target === 'routes/taskCatalog' || target.startsWith('modules/task-catalog/public/'),
      ),
    ).toEqual([
      'routes/taskCatalog',
      'routes/taskCatalog',
      'routes/taskCatalog',
      'modules/task-catalog/public/queries',
    ])
  })
})

describe('RFC-590 —— 绑定与模块形状', () => {
  test('绑定只取 task-catalog 本模块', () => {
    expect(bindingLeaks('task-catalog', [], `${BINDING}.ts`, read(BINDING))).toEqual([])
  })

  test('负对照：绑定取别的模块会被认出', () => {
    expect(
      bindingLeaks(
        'task-catalog',
        [],
        `${BINDING}.ts`,
        "import type { TaskRouteOperations } from '@/modules/task-execution/public/commands'\n",
      ),
    ).toEqual([
      '@/modules/task-execution/public/commands (an unlisted module entry, or this module outside public)',
    ])
  })

  test('task-catalog 没有 public/；装配根经 composition 取用它', () => {
    expect(existsSync(join(SRC, 'modules', 'task-catalog', 'public'))).toBe(false)
    const roots = [join(SRC, 'server.ts'), join(SRC, 'bootstrap', 'daemonHttpComposition.ts')]
    for (const root of roots)
      expect([
        slash(relative(SRC, root)),
        resolvedSpecifiers(root, readFileSync(root, 'utf8')).includes(
          'modules/task-catalog/composition',
        ),
      ]).toEqual([slash(relative(SRC, root)), true])
  })

  test('server.ts 从 task-catalog 的 composition 取挂载函数', () => {
    expect(read('server')).toContain(
      "import { mountTaskCatalogRoutes } from '@/modules/task-catalog/composition'",
    )
    expect(read('server')).toContain(
      'taskCatalog: (app: Hono) => mountTaskCatalogRoutes(app, input.taskExecution.catalog)',
    )
  })
})
