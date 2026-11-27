// RFC-583 — system-operations 的配置、文档与 PlantUML 路由归入模块 inbound，两个 HTTP 传输小工具归入 platform（RFC-294 W9-D：`routes/` → 模块
// `inbound/` 第八批）。
//
// 为什么存在：`config`、`docs`、`plantuml` 三个绑定迁进 `modules/system-operations/inbound/http/`，挂载函数经 `composition/routes.ts` 转出；
// `verifiedBodyLimit`、`publicOrigin` 两个传输工具迁进 `platform/http/`（`publicOrigin` 改取自己声明的中性配置形状，不再取 system-operations 的
// 配置查询）；`ApplicationConfigurationCommands` 在模块外只有配置绑定用，撤回 application。锁五件事：
// ① 五个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 三个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application / domain / public）；不取 `@/db` 与 `services/`
//    （判据带负对照）。
// ③ platform 的两个文件只取 Hono、shared 与 platform（判据带负对照）——platform 不依赖任何模块（RFC-294 design §3）。
// ④ `ApplicationConfigurationCommands` 不在 system-operations 的 public 面，只在 `application/applicationConfiguration.ts` 声明一次。
// ⑤ `server.ts` 从 `composition/routes` 取四个挂载函数，不直取模块的 inbound。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；②③ 只读迁走的五个文件；④ 读
// system-operations 的 public 目录与 backend 的 `src`；⑤ 只读 `server.ts`。路由行为由既有用例覆盖（`rfc349-config-route-provider-boundary`、
// `rfc370-route-configuration-query`、`rfc247-public-origin`、`rfc203-uniform-errors`、`rfc266-task-fanout-pools` 与 `routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { RFC583_RULE } from './helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')

const SRC = join(BACKEND, 'src')
const SO = 'modules/system-operations'
const slash = (path: string) => path.split('\\').join('/')

/** Old location → new location (below `src`, no extension), and names the new file still offers. */
const MOVED = RFC583_RULE.moved
const OLD = new Set<string>(RFC583_RULE.oldPaths)
const BINDINGS = MOVED.filter(([, next]) => next.startsWith(`${SO}/`)).map(([, next]) => next)
const PLATFORM = MOVED.filter(([, next]) => next.startsWith('platform/')).map(([, next]) => next)
const MOUNTS = [
  'mountConfigRoutes',
  'mountDocsRoutes',
  'mountPlantumlRoutes',
  'mountWellKnownRoutes',
]

// The independent public-surface/declaration guard still enumerates its own source scope.
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

/** Every specifier a file names, unresolved (declarations, `import('…')` types and calls, `require`, `mock.module`). */
function rawSpecifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      out.push(node.moduleSpecifier.text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      out.push(node.argument.literal.text)
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module') &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      )
        out.push(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Specifiers of a platform file (a path below `src`) that break ③: platform takes Hono, shared and platform only. */
function platformLeaks(path: string, text: string): string[] {
  return rawSpecifiers(path, text).filter((specifier) => {
    if (specifier === 'hono' || specifier.startsWith('hono/')) return false
    if (specifier === '@agent-workflow/shared') return false
    if (specifier.startsWith('@/platform/')) return false
    if (specifier.startsWith('.'))
      return !slash(relative(SRC, resolve(dirname(join(SRC, path)), specifier))).startsWith(
        'platform/',
      )
    return true
  })
}

describe('RFC-583 —— 五个文件离开 routes/', () => {
  test('旧路径不存在，新路径存在，导出的名字还在', () => {
    for (const [old, next, names] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
      const offered = offeredNames(`${next}.ts`, readFileSync(join(SRC, `${next}.ts`), 'utf8'))
      for (const name of names)
        expect([next, name, offered.includes(name)]).toEqual([next, name, true])
    }
  })

  // RFC-624: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、动态 import、mock.module 与 import 类型都会被认出；新路径与别的路由不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { mountConfigRoutes } from '@/routes/config'\n" +
          "export { mountDocsRoutes } from './routes/docs.ts'\n" +
          "const origin = await import('./routes/publicOrigin')\n" +
          "mock.module('@/routes/verifiedBodyLimit', () => ({}))\n" +
          "import { mountPlantumlRoutes as next } from './modules/system-operations/inbound/http/plantumlRoutes'\n" +
          "import { mountHealthRoutes } from './routes/health'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/config', 'routes/docs', 'routes/publicOrigin', 'routes/verifiedBodyLimit'])
    expect(
      resolvedSpecifiers(
        join(BACKEND, 'tests', 'helpers', 'probe.ts'),
        "export type Probe = typeof import('../../src/routes/plantuml')\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/plantuml'])
  })
})

describe('RFC-583 —— 绑定只取本模块，platform 的两个文件不取模块', () => {
  test('三个绑定对模块的 import 只取本模块', () => {
    for (const next of BINDINGS)
      expect([
        next,
        bindingLeaks(
          'system-operations',
          [],
          `${next}.ts`,
          readFileSync(join(SRC, `${next}.ts`), 'utf8'),
        ),
      ]).toEqual([next, []])
  })

  test('负对照：别的模块、本模块 infrastructure 或 composition、legacy 数据层与越出本模块的相对路径都会被认出', () => {
    expect(
      bindingLeaks(
        'system-operations',
        [],
        `${SO}/inbound/http/probe.ts`,
        "import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'\n" +
          "import type { ApplicationConfigurationCommands } from '../../application/applicationConfiguration'\n" +
          "import type { TaskStatusCountQueries } from '@/modules/task-execution/public/types'\n" +
          "import { compose } from '@/modules/system-operations/composition/routes'\n" +
          "import type { Store } from '../../infrastructure/local/fileApplicationConfiguration'\n" +
          "import { loadConfig } from '@/services/config'\n" +
          "import { openDb } from '@/db/client'\n",
      ),
    ).toEqual([
      '@/modules/task-execution/public/types (an unlisted module entry, or this module outside public)',
      '@/modules/system-operations/composition/routes (an unlisted module entry, or this module outside public)',
      "../../infrastructure/local/fileApplicationConfiguration (relative import outside this module's application / domain / public)",
      '@/services/config (legacy data or service layer)',
      '@/db/client (legacy data or service layer)',
    ])
  })

  test('platform 的两个文件只取 Hono、shared 与 platform', () => {
    for (const next of PLATFORM)
      expect([
        next,
        platformLeaks(`${next}.ts`, readFileSync(join(SRC, `${next}.ts`), 'utf8')),
      ]).toEqual([next, []])
  })

  test('负对照：模块的 public、legacy 横向目录与越出 platform 的相对路径都会被认出', () => {
    expect(
      platformLeaks(
        'platform/http/probe.ts',
        "import type { Context } from 'hono'\n" +
          "import { bodyLimit } from 'hono/body-limit'\n" +
          "import type { Config } from '@agent-workflow/shared'\n" +
          "import { DomainError } from '@/platform/errors/domainErrors'\n" +
          "import { renderPlantuml } from './plantuml'\n" +
          "import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'\n" +
          "import { registerRoute } from '@/routes/registry'\n" +
          "import { actorOf } from '@/auth/actor'\n" +
          "import type { TaskRef } from '../../modules/task-execution/public/types'\n" +
          "export type Probe = typeof import('@/services/config')\n",
      ),
    ).toEqual([
      '@/modules/system-operations/public/queries',
      '@/routes/registry',
      '@/auth/actor',
      '../../modules/task-execution/public/types',
      '@/services/config',
    ])
  })
})

describe('RFC-583 —— 撤回的配置命令端口与装配根', () => {
  test('ApplicationConfigurationCommands 不在 public 面，只在 application/applicationConfiguration.ts 声明一次', () => {
    const publicFiles = walk(join(SRC, SO, 'public'))
    expect(publicFiles.length).toBeGreaterThan(3)
    for (const path of publicFiles) {
      const text = readFileSync(path, 'utf8')
      expect([
        slash(relative(SRC, path)),
        offeredNames(path, text).includes('ApplicationConfigurationCommands'),
      ]).toEqual([slash(relative(SRC, path)), false])
    }
    const declaring = walk(SRC).filter((path) =>
      /\binterface ApplicationConfigurationCommands\b/.test(readFileSync(path, 'utf8')),
    )
    expect(declaring.map((path) => slash(relative(SRC, path)))).toEqual([
      `${SO}/application/applicationConfiguration.ts`,
    ])
  }, 120_000)

  test('负对照：public 文件里的声明与转出都会被认出', () => {
    expect(
      offeredNames(
        'commands.ts',
        'export interface ApplicationConfigurationCommands { read(): void }\n',
      ),
    ).toEqual(['ApplicationConfigurationCommands'])
    expect(
      offeredNames(
        'commands.ts',
        "export type { ApplicationConfigurationCommands } from '../application/applicationConfiguration'\n",
      ),
    ).toEqual(['ApplicationConfigurationCommands'])
  })

  test('server.ts 从 composition/routes 取四个挂载函数，不直取模块的 inbound', () => {
    const text = readFileSync(join(SRC, 'server.ts'), 'utf8')
    const source = ts.createSourceFile('server.ts', text, ts.ScriptTarget.Latest, true)
    const found: string[] = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue
      const specifier = statement.moduleSpecifier.text
      expect([specifier, specifier.startsWith(`@/${SO}/inbound/`)]).toEqual([specifier, false])
      const bindings = statement.importClause?.namedBindings
      if (
        specifier === `@/${SO}/composition/routes` &&
        bindings !== undefined &&
        ts.isNamedImports(bindings)
      )
        found.push(
          ...bindings.elements
            .map((element) => element.name.text)
            .filter((name) => MOUNTS.includes(name)),
        )
    }
    expect(found.sort()).toEqual([...MOUNTS].sort())
  })
})
