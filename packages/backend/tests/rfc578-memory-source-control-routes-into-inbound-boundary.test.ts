// RFC-578 — memory 与 source-control 的路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第三批）。
//
// 为什么存在：五个路由原样迁进各自模块的 `inbound/http/`，挂载函数经各模块的 `composition.ts` 转出，`server.ts` 从那里取；只被这些路由用的 13 个
// public 转出（按架构报告的消费者表与 public 类型引用算到不动点）随之撤回。锁四件事：
// ① 五个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 五个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application / domain / public）与登记过的别的模块 public
//    （记忆路由：resource-catalog `public/types`、identity-access `public/participants`）；不取 `@/db` 与 `services/`（判据带负对照）。
// ③ memory 与 source-control 的 `public/types.ts` 不再转出撤回的 13 个符号（读法带负对照）。
// ④ `server.ts` 从两个模块的 composition 取五个挂载函数，不再取 `@/routes/` 下的这五个文件。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读五个绑定；③ 只读两个 public 文件；④ 只读
// `server.ts`。路由行为由既有用例覆盖（`rfc352-memory-candidate-visibility`、`rfc349-memory-provider-boundary`、`rfc446`、`rfc447`、`rfc451`、
// `rfc370-v4-repository-mirrors` 与 `routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { RFC578_RULE } from './helpers/rfc624MigrationReferenceRules'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')

const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location → new location (below `src`, no extension), owning module, mount function, other modules' public it may take. */
const MOVED = RFC578_RULE.moved
const OLD = new Set<string>(RFC578_RULE.oldPaths)

/** The public file (below `src`, no extension) and the names it no longer offers. */
const WITHDRAWN: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'modules/memory/public/types',
    [
      'CandidateNarrowable',
      'CandidateVisibilityOptions',
      'isMemoryHiddenCandidate',
      'narrowCandidateRows',
    ],
  ],
  [
    'modules/source-control/public/types',
    [
      'CachedRepositoryOperations',
      'CachedRepositoryRefresh',
      'RepositoryGroupDeletion',
      'RepositoryGroupDraft',
      'RepositoryGroupPreview',
      'RepositoryGroups',
      'RepositoryMirrors',
      'RepositoryRefresh',
      'RepositoryRegistration',
    ],
  ],
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

describe('RFC-578 —— 五个绑定离开 routes/', () => {
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
        "import { mountMemoryRoutes } from '@/routes/memories'\n" +
          "export { mountRepoRoutes } from './routes/repos.ts'\n" +
          "const groups = await import('./routes/repoGroups')\n" +
          "mock.module('@/routes/cached-repos', () => ({}))\n" +
          "type Jobs = typeof import('./routes/memoryDistillJobs')\n" +
          "import { mountMemoryRoutes as next } from './modules/memory/inbound/http/memoryRoutes'\n" +
          "import { mountTaskRoutes } from './routes/tasks'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'routes/memories',
      'routes/repos',
      'routes/repoGroups',
      'routes/cached-repos',
      'routes/memoryDistillJobs',
    ])
    expect(
      resolvedSpecifiers(
        join(BACKEND, 'tests', 'helpers', 'probe.ts'),
        "import { mountRepoRoutes } from '../../src/routes/repos'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/repos'])
  })
})

describe('RFC-578 —— 绑定只取本模块与登记过的别的模块 public', () => {
  test('五个绑定对模块的 import 只取本模块与登记过的入口', () => {
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
        'memory',
        ['@/modules/resource-catalog/public/types'],
        'modules/memory/inbound/http/probe.ts',
        "import type { MemoryScopeRef } from '@/modules/memory/public/types'\n" +
          "import { isMemoryHiddenCandidate } from '../../domain/candidateVisibility'\n" +
          "import { hasResourceAclBypass } from '@/modules/resource-catalog/public/types'\n" +
          "import type { Task } from '@/modules/task-execution/public/types'\n" +
          "import { compose } from '@/modules/memory/composition'\n" +
          "import type { Store } from '../../infrastructure/store'\n" +
          "import { listMemories } from '@/services/memory'\n" +
          "import { openDb } from '@/db/client'\n",
      ),
    ).toEqual([
      '@/modules/task-execution/public/types (an unlisted module entry, or this module outside public)',
      '@/modules/memory/composition (an unlisted module entry, or this module outside public)',
      "../../infrastructure/store (relative import outside this module's application / domain / public)",
      '@/services/memory (legacy data or service layer)',
      '@/db/client (legacy data or service layer)',
    ])
  })
})

describe('RFC-578 —— public 面与装配根', () => {
  test('两个 public 文件不再转出撤回的 13 个符号', () => {
    let listed = 0
    for (const [file, names] of WITHDRAWN) {
      const offered = offeredNames(`${file}.ts`, readFileSync(join(SRC, `${file}.ts`), 'utf8'))
      expect([file, offered.length > 0]).toEqual([file, true])
      for (const name of names) {
        listed += 1
        expect([file, name, offered.includes(name)]).toEqual([file, name, false])
      }
    }
    expect(listed).toBe(13)
  })

  test('负对照：转出、type 转出、带 type 修饰的转出与声明都会被认出', () => {
    expect(
      offeredNames(
        'probe.ts',
        "export { isMemoryHiddenCandidate, type CandidateNarrowable } from '../domain/candidateVisibility'\n" +
          "export type { RepositoryGroups } from '../application/ports/repositoryGroups'\n" +
          'export interface MemoryScopeRef { readonly scopeType: string }\n' +
          'interface NotOffered { readonly id: string }\n',
      ),
    ).toEqual([
      'CandidateNarrowable',
      'MemoryScopeRef',
      'RepositoryGroups',
      'isMemoryHiddenCandidate',
    ])
  })

  test('server.ts 从两个模块的 composition 取五个挂载函数，不再取 @/routes/ 下的这五个文件', () => {
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
