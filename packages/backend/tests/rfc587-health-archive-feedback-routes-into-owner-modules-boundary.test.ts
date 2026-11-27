// RFC-587 — 健康探测、任务归档与任务反馈三个路由按 owner 归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第九批）。
//
// 为什么存在：`routes/health.ts` → system-operations、`routes/taskArchive.ts` → task-execution、`routes/taskFeedback.ts` → collaboration 的
// `inbound/http/`；原来取别的模块的三处改为本绑定声明的窄形状或本模块已有的端口类型（不新增 DAG 边）；只被这些绑定用的四个 public 符号撤回模块
// 内部。锁四件事：
// ① 三个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 三个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application / domain / public），不取 `@/db` 与 `services/`
//    （判据带负对照）。
// ③ 撤回的四个名字不在 collaboration / task-execution 的 public 面上。
// ④ `server.ts` 从三个模块的 composition 取三个挂载函数，不直取任何模块的 inbound。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读三个绑定；③ 只读两个模块的
// public 文件；④ 只读 `server.ts`。路由行为由既有用例覆盖（`rfc398-health-database`、`rfc370-m0-hosted-control-plane`、`rfc311-task-archive`、
// `task-feedback-service`、`rfc445` 与 `routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { RFC587_RULE } from './helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')

const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location → new location (below `src`, no extension), owning module, mount function, the composition entry. */
const MOVED = RFC587_RULE.moved
const OLD = new Set<string>(RFC587_RULE.oldPaths)
/** The withdrawn public names: [public file below src, name]. */
const WITHDRAWN: ReadonlyArray<readonly [string, string]> = [
  ['modules/collaboration/public/commands.ts', 'createTaskFeedback'],
  ['modules/collaboration/public/queries.ts', 'canViewTaskFeedback'],
  ['modules/collaboration/public/queries.ts', 'listTaskFeedback'],
  ['modules/task-execution/public/commands.ts', 'TaskArchiveMaintenanceCommand'],
]

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

describe('RFC-587 —— 三个绑定离开 routes/', () => {
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
        "import { mountHealthRoutes } from '@/routes/health'\n" +
          "export { mountTaskArchiveRoutes } from './routes/taskArchive.ts'\n" +
          "const feedback = await import('./routes/taskFeedback')\n" +
          "mock.module('@/routes/health', () => ({}))\n" +
          "import { mountHealthRoutes as next } from './modules/system-operations/inbound/http/healthRoutes'\n" +
          "import { mountTaskRoutes } from './routes/tasks'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/health', 'routes/taskArchive', 'routes/taskFeedback', 'routes/health'])
    expect(
      resolvedSpecifiers(
        join(BACKEND, 'tests', 'helpers', 'probe.ts'),
        "export type Probe = typeof import('../../src/routes/taskFeedback')\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/taskFeedback'])
  })
})

describe('RFC-587 —— 绑定只取本模块', () => {
  test('三个绑定对模块的 import 只取本模块', () => {
    for (const [, next, owner] of MOVED)
      expect([
        next,
        bindingLeaks(owner, [], `${next}.ts`, readFileSync(join(SRC, `${next}.ts`), 'utf8')),
      ]).toEqual([next, []])
  })

  test('负对照：别的模块的 public（原来取的那三处）、本模块 infrastructure、legacy 数据层与越出本模块的相对路径都会被认出', () => {
    expect(
      bindingLeaks(
        'collaboration',
        [],
        'modules/collaboration/inbound/http/probe.ts',
        "import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'\n" +
          "import { createTaskFeedback } from '../../application/taskFeedbackOperations'\n" +
          "import type { MemoryOperations } from '@/modules/memory/public/operations'\n" +
          "import type { TaskStatusCountQueries } from '@/modules/task-execution/public/types'\n" +
          "import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'\n" +
          "import type { Store } from '../../infrastructure/drizzleTaskFeedbackStore'\n" +
          "import { openDb } from '@/db/client'\n",
      ),
    ).toEqual([
      '@/modules/memory/public/operations (an unlisted module entry, or this module outside public)',
      '@/modules/task-execution/public/types (an unlisted module entry, or this module outside public)',
      '@/modules/system-operations/public/queries (an unlisted module entry, or this module outside public)',
      "../../infrastructure/drizzleTaskFeedbackStore (relative import outside this module's application / domain / public)",
      '@/db/client (legacy data or service layer)',
    ])
  })
})

describe('RFC-587 —— 撤回的 public 名字与装配根', () => {
  test('四个撤回的名字不在 public 面上', () => {
    for (const [file, name] of WITHDRAWN) {
      const offered = offeredNames(file, readFileSync(join(SRC, file), 'utf8'))
      expect([file, name, offered.includes(name)]).toEqual([file, name, false])
    }
  })

  test('负对照：声明与转出都会被认出', () => {
    expect(offeredNames('commands.ts', 'export function createTaskFeedback() {}\n')).toEqual([
      'createTaskFeedback',
    ])
    expect(
      offeredNames(
        'commands.ts',
        "export type { TaskArchiveMaintenanceCommand } from '../application/ports/taskArchiveMaintenanceCommand'\n",
      ),
    ).toEqual(['TaskArchiveMaintenanceCommand'])
  })

  test('server.ts 从三个 composition 取三个挂载函数，不直取任何模块的 inbound', () => {
    const text = readFileSync(join(SRC, 'server.ts'), 'utf8')
    const source = ts.createSourceFile('server.ts', text, ts.ScriptTarget.Latest, true)
    const found: string[] = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue
      const specifier = statement.moduleSpecifier.text
      expect([specifier, /^@\/modules\/[^/]+\/inbound\//.test(specifier)]).toEqual([
        specifier,
        false,
      ])
      const bindings = statement.importClause?.namedBindings
      for (const [, , , mount, entry] of MOVED)
        if (
          specifier === entry &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some((element) => element.name.text === mount)
        )
          found.push(mount)
    }
    expect(found.sort()).toEqual(MOVED.map(([, , , mount]) => mount).sort())
  })
})
