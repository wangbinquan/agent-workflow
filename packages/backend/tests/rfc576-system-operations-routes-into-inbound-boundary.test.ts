// RFC-576 — system-operations 的七个路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第一批）。
//
// 为什么存在：七个 system-operations 的 HTTP 绑定（备份、还原、数据库迁移、系统总览、守护进程运行信息、维护状态、磁盘回收）原样迁进
// `modules/system-operations/inbound/http/`，`composition/routes.ts` 只转出挂载函数，`server.ts` 从那里取。锁四件事：
// ① 七个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符（别名、相对路径、动态 import、`mock.module`）再解析到它们（判据带负对照）。
// ② 七个绑定对模块的 import 全部是 `import type`：别名只取本模块 public 与 identity-access 的 `public/participants`，相对路径只取本模块的
//    application / domain / public（绑定在模块里面，三个只被它们消费的合同随之从 public 撤回 application）；不取 `@/db`、`services/`、本模块的
//    infrastructure / composition 与别的模块的内部（判据带负对照）。
// ③ `composition/routes.ts` 只有转出，且只转出这七个挂载函数。
// ④ `server.ts` 从 `composition/routes` 取这七个挂载函数，不再取 `@/routes/` 下的这七个文件。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读七个绑定；③ 只读
// `composition/routes.ts`；④ 只读 `server.ts`。路由行为由既有用例覆盖（`rfc213-restore-route`、`rfc349-database-migration-operations`、
// `rfc390-maintenance-status`、`daemon-info-route`、`rfc346-system-operations-contracts` 等）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const SO = 'modules/system-operations'
const slash = (path: string) => path.split('\\').join('/')

/** Old location (below `src`, no extension) → new location, with the mount function each exports. */
const MOVED: ReadonlyArray<readonly [string, string, string]> = [
  ['routes/backup', `${SO}/inbound/http/backupRoutes`, 'mountBackupRoutes'],
  ['routes/restore', `${SO}/inbound/http/restoreRoutes`, 'mountRestoreRoutes'],
  [
    'routes/databaseMigrations',
    `${SO}/inbound/http/databaseMigrationRoutes`,
    'mountDatabaseMigrationRoutes',
  ],
  ['routes/overview', `${SO}/inbound/http/overviewRoutes`, 'mountOverviewRoutes'],
  ['routes/daemon', `${SO}/inbound/http/daemonRoutes`, 'mountDaemonRoutes'],
  ['routes/maintenance', `${SO}/inbound/http/maintenanceRoutes`, 'mountMaintenanceRoutes'],
  [
    'routes/maintenanceDisk',
    `${SO}/inbound/http/maintenanceDiskRoutes`,
    'mountMaintenanceDiskRoutes',
  ],
]
const OLD = new Set(MOVED.map(([old]) => old))
/** RFC-583 added the configuration, API documentation and PlantUML bindings to the same route composition. */
const LATER_MOUNTS = [
  'mountConfigRoutes',
  'mountDocsRoutes',
  'mountPlantumlRoutes',
  'mountWellKnownRoutes',
] as const

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

/** Module imports of a binding (a path below `src`) that break ②, as `<specifier> (<why>)`. */
function bindingLeaks(path: string, text: string): string[] {
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
      if (!/^modules\/system-operations\/(?:application|domain|public)\//.test(target))
        out.push(
          `${specifier} (relative import outside this module's application / domain / public)`,
        )
      continue
    }
    if (!specifier.startsWith('@/modules/')) continue
    const clause = statement.importClause
    const typeOnly =
      clause !== undefined &&
      (clause.isTypeOnly ||
        (clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)))
    if (!typeOnly) out.push(`${specifier} (value import)`)
    if (
      !/^@\/modules\/system-operations\/public\/[a-z]+$/.test(specifier) &&
      specifier !== '@/modules/identity-access/public/participants'
    )
      out.push(`${specifier} (outside the allowed public surfaces)`)
  }
  return out
}

describe('RFC-576 —— 七个绑定离开 routes/', () => {
  test('旧路径不存在，新路径存在，挂载函数还在', () => {
    for (const [old, next, mount] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
      expect([next, exportedNames(join(SRC, `${next}.ts`)).includes(mount)]).toEqual([next, true])
    }
  })

  test('src / tests / scripts 的全部说明符不再解析到旧路径', () => {
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
          .filter((target) => OLD.has(target))
          .map((target) => `${slash(relative(REPO, path))} -> ${target}`),
      ),
    ).toEqual([])
  }, 240_000)

  test('负对照：别名、相对路径、带扩展名、动态 import、mock.module 都会被认出；新路径与同前缀的其他路由不算', () => {
    const fromSrcRoot = join(SRC, 'server.ts')
    expect(
      resolvedSpecifiers(
        fromSrcRoot,
        "import { mountBackupRoutes } from './routes/backup'\n" +
          "import { mountRestoreRoutes } from '@/routes/restore'\n" +
          "export { mountDaemonRoutes } from './routes/daemon.ts'\n" +
          "const migrations = await import('./routes/databaseMigrations')\n" +
          "mock.module('@/routes/maintenanceDisk', () => ({}))\n" +
          "import { mountBackupRoutes as next } from './modules/system-operations/inbound/http/backupRoutes'\n" +
          "import { mountTaskRoutes } from './routes/tasks'\n" +
          "import { registerRoute } from '@/routes/registry'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'routes/backup',
      'routes/restore',
      'routes/daemon',
      'routes/databaseMigrations',
      'routes/maintenanceDisk',
    ])
  })
})

describe('RFC-576 —— 绑定只取本模块与授权的 public 类型', () => {
  test('七个绑定对模块的 import 全部是 import type，只取允许的 public 面', () => {
    for (const [, next] of MOVED)
      expect([
        next,
        bindingLeaks(`${next}.ts`, readFileSync(join(SRC, `${next}.ts`), 'utf8')),
      ]).toEqual([next, []])
  })

  test('负对照：值 import、取模块内部、取别的模块、legacy 的数据层与越出本模块的相对路径都会被认出', () => {
    expect(
      bindingLeaks(
        `${SO}/inbound/http/probe.ts`,
        "import { createSystemOperations } from '@/modules/system-operations/public/commands'\n" +
          "import type { X } from '@/modules/system-operations/infrastructure/local/x'\n" +
          "import type { Task } from '@/modules/task-execution/public/types'\n" +
          "import { openDb } from '@/db/client'\n" +
          "import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'\n" +
          "import { type SystemOverviewQuery } from '@/modules/system-operations/public/queries'\n" +
          "import type { SystemOverviewQuery as Q } from '../../application/overview'\n" +
          "import type { Store } from '../../infrastructure/store'\n" +
          "import type { Other } from '../../../task-execution/public/types'\n",
      ),
    ).toEqual([
      '@/modules/system-operations/public/commands (value import)',
      '@/modules/system-operations/infrastructure/local/x (outside the allowed public surfaces)',
      '@/modules/task-execution/public/types (outside the allowed public surfaces)',
      '@/db/client (legacy data or service layer)',
      "../../infrastructure/store (relative import outside this module's application / domain / public)",
      "../../../task-execution/public/types (relative import outside this module's application / domain / public)",
    ])
  })
})

describe('RFC-576 —— 装配根经 composition 取挂载函数', () => {
  test('composition/routes.ts 只有转出，且只转出这七个挂载函数（加 RFC-583 的四个）', () => {
    const path = join(SRC, SO, 'composition', 'routes.ts')
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const names: string[] = []
    for (const statement of source.statements) {
      expect(ts.isExportDeclaration(statement)).toBe(true)
      if (!ts.isExportDeclaration(statement)) continue
      expect(
        (statement.moduleSpecifier as ts.StringLiteral).text.startsWith('../inbound/http/'),
      ).toBe(true)
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause))
        names.push(...statement.exportClause.elements.map((element) => element.name.text))
    }
    expect(names.sort()).toEqual([...MOVED.map(([, , mount]) => mount), ...LATER_MOUNTS].sort())
  })

  test('server.ts 从 composition/routes 取七个挂载函数（加 RFC-583 的四个），不再取 @/routes/ 下的这七个文件', () => {
    const text = readFileSync(join(SRC, 'server.ts'), 'utf8')
    const source = ts.createSourceFile('server.ts', text, ts.ScriptTarget.Latest, true)
    const fromComposition: string[] = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue
      const specifier = statement.moduleSpecifier.text
      expect(OLD.has(specifier.replace(/^@\//, ''))).toBe(false)
      const bindings = statement.importClause?.namedBindings
      if (
        specifier === `@/${SO}/composition/routes` &&
        bindings !== undefined &&
        ts.isNamedImports(bindings)
      )
        fromComposition.push(...bindings.elements.map((element) => element.name.text))
    }
    expect(fromComposition.sort()).toEqual(
      [...MOVED.map(([, , mount]) => mount), ...LATER_MOUNTS].sort(),
    )
  })
})
