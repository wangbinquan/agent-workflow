// RFC-577 — execution-contract 与 integration 的路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第二批）。
//
// 为什么存在：两个只有一个路由的模块，路由原样迁进各自的 `inbound/http/`，挂载函数经各模块的 `composition.ts` 转出，`server.ts` 从那里取；只被这些
// 路由用的 public 转出随之撤回。锁四件事：
// ① 两个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 两个绑定对模块的 import 只取本模块：别名只到本模块 public，相对路径只到本模块 application / domain / public；不取 `@/db`、`services/` 与别的模块
//    （判据带负对照）。
// ③ 两个 public 入口不再转出被撤回的符号；integration 也不再转出只被本模块用的三个端口类型。
// ④ `server.ts` 从两个模块的 composition 取两个挂载函数，不再取 `@/routes/` 下的这两个文件。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读两个绑定；③ 只读两个 public 文件；④ 只读
// `server.ts`。路由行为由既有用例覆盖（`rfc450-code-host-family-into-integration`、执行合同的路由用例与 `routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { RFC577_RULE } from './helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')

const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location → new location, owning module, mount function, and the public file plus the name it no longer offers. */
const MOVED = RFC577_RULE.moved
const OLD = new Set<string>(RFC577_RULE.oldPaths)

/**
 * Every module specifier a file names — imports, re-exports, `import('…')` (types and calls), `require('…')` and
 * `mock.module('…')` — resolved to a path below `src` without its extension (null when it leaves `src` or is a package).
 */
function resolvedSpecifiers(path: string, text: string): string[] {
  return resolveMigrationSpecifiers(SRC, path, text)
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

/** Module imports of a binding of module `owner` (a path below `src`) that break ②, as `<specifier> (<why>)`. */
function bindingLeaks(owner: string, path: string, text: string): string[] {
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
    if (specifier.startsWith('@/modules/') && !specifier.startsWith(`@/modules/${owner}/public/`))
      out.push(`${specifier} (another module, or this module outside public)`)
  }
  return out
}

/** Names a public file offers (`export { … } from`, `export type { … } from` and declarations). */
function offeredNames(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements)
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      out.push(...statement.exportClause.elements.map((element) => element.name.text))
  return [...out, ...exportedNames(path)].sort()
}

describe('RFC-577 —— 两个绑定离开 routes/', () => {
  test('旧路径不存在，新路径存在，挂载函数还在', () => {
    for (const [old, next, , mount] of MOVED) {
      expect([old, existsSync(join(SRC, `${old}.ts`))]).toEqual([old, false])
      expect([next, existsSync(join(SRC, `${next}.ts`))]).toEqual([next, true])
      expect([next, exportedNames(join(SRC, `${next}.ts`)).includes(mount)]).toEqual([next, true])
    }
  })

  // RFC-624: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名与动态 import 都会被认出；新路径与别的路由不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { mountCodeHostRoutes } from '@/routes/codeHosts'\n" +
          "export { mountExecutionContractRoutes } from './routes/executionContracts.ts'\n" +
          "const routes = await import('./routes/codeHosts')\n" +
          "import { mountCodeHostRoutes as next } from './modules/integration/inbound/http/codeHostRoutes'\n" +
          "import { mountTaskRoutes } from './routes/tasks'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/codeHosts', 'routes/executionContracts', 'routes/codeHosts'])
  })
})

describe('RFC-577 —— 绑定只取本模块', () => {
  test('两个绑定对模块的 import 只取本模块', () => {
    for (const [, next, owner] of MOVED)
      expect([
        next,
        bindingLeaks(owner, `${next}.ts`, readFileSync(join(SRC, `${next}.ts`), 'utf8')),
      ]).toEqual([next, []])
  })

  test('负对照：取别的模块、本模块的 infrastructure 或 composition、legacy 的数据层与越出本模块的相对路径都会被认出', () => {
    expect(
      bindingLeaks(
        'integration',
        'modules/integration/inbound/http/probe.ts',
        "import type { CodeHostConnectionCredential } from '@/modules/integration/public/types'\n" +
          "import type { Probe } from '../../application/ports/codeHostConnections'\n" +
          "import type { Task } from '@/modules/task-execution/public/types'\n" +
          "import { compose } from '@/modules/integration/composition'\n" +
          "import type { Store } from '../../infrastructure/store'\n" +
          "import { openDb } from '@/db/client'\n",
      ),
    ).toEqual([
      '@/modules/task-execution/public/types (another module, or this module outside public)',
      '@/modules/integration/composition (another module, or this module outside public)',
      "../../infrastructure/store (relative import outside this module's application / domain / public)",
      '@/db/client (legacy data or service layer)',
    ])
  })
})

describe('RFC-577 —— public 面与装配根', () => {
  test('两个 public 入口不再转出被撤回的符号，integration 也不再转出三个只被本模块用的端口类型', () => {
    for (const [, , , , publicFile, withdrawn] of MOVED)
      expect([publicFile, offeredNames(join(SRC, `${publicFile}.ts`)).includes(withdrawn)]).toEqual(
        [publicFile, false],
      )
    const integrationTypes = offeredNames(join(SRC, 'modules', 'integration', 'public', 'types.ts'))
    for (const name of [
      'CodeHostConnectionMutationConfirmation',
      'CodeHostConnectionTestDraft',
      'CodeHostConnectionUpsertInput',
    ])
      expect([name, integrationTypes.includes(name)]).toEqual([name, false])
  })

  test('server.ts 从两个模块的 composition 取两个挂载函数，不再取 @/routes/ 下的这两个文件', () => {
    const text = readFileSync(join(SRC, 'server.ts'), 'utf8')
    const source = ts.createSourceFile('server.ts', text, ts.ScriptTarget.Latest, true)
    const found: string[] = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue
      const specifier = statement.moduleSpecifier.text
      expect(OLD.has(specifier.replace(/^@\//, ''))).toBe(false)
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
