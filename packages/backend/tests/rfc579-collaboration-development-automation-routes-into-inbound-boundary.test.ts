// RFC-579 — collaboration 与 development-automation 的路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第四批）。
//
// 为什么存在：七个路由原样迁进各自模块的 `inbound/http/`，挂载函数经各模块的 `composition.ts` 转出，`server.ts` 从那里取；只被这些路由用的 47 个
// public 转出（按架构报告的消费者表与 public 类型引用算到不动点）随之撤回，development-automation 的 `public/operations.ts` 整个删除。锁四件事：
// ① 七个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 七个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application / domain / public）与登记过的别的模块 public
//    （`taskClarifyDirective`：task-execution `public/types`；两个开发配置 / 任务路由：identity-access `public/participants`）；不取 `@/db` 与
//    `services/`（判据带负对照）。
// ③ collaboration 的三个 public 文件与 development-automation 的 `public/commands.ts` 不再转出撤回的 26 个符号，development-automation 的
//    `public/operations.ts` 不存在（另 21 个随它而去）。
// ④ `server.ts` 从两个模块的 composition 取七个挂载函数，不再取 `@/routes/` 下的这七个文件。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读七个绑定；③ 只读四个 public 文件；④ 只读
// `server.ts`。路由行为由既有用例覆盖（`rfc349-collaboration-route-operations`、`rfc442`、`rfc128-p5-d-autodispatch`、`rfc326-*`、`rfc372-*`、
// `rfc310-pr3-upload-security`、`rfc349-digital-development-provider-boundary` 与 `routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

/** Old location → new location (below `src`, no extension), owning module, mount function, other modules' public it may take. */
const MOVED: ReadonlyArray<readonly [string, string, string, string, readonly string[]]> = [
  [
    'routes/clarify',
    'modules/collaboration/inbound/http/clarifyRoutes',
    'collaboration',
    'mountClarifyRoutes',
    [],
  ],
  [
    'routes/reviews',
    'modules/collaboration/inbound/http/reviewRoutes',
    'collaboration',
    'mountReviewRoutes',
    [],
  ],
  [
    'routes/taskClarifyDirective',
    'modules/collaboration/inbound/http/taskClarifyDirectiveRoutes',
    'collaboration',
    'mountTaskClarifyDirectiveRoutes',
    ['@/modules/task-execution/public/types'],
  ],
  [
    'routes/taskQuestions',
    'modules/collaboration/inbound/http/taskQuestionRoutes',
    'collaboration',
    'mountTaskQuestionRoutes',
    [],
  ],
  [
    'routes/developmentConfig',
    'modules/development-automation/inbound/http/developmentConfigRoutes',
    'development-automation',
    'mountDevelopmentConfigRoutes',
    ['@/modules/identity-access/public/participants'],
  ],
  [
    'routes/developmentMissions',
    'modules/development-automation/inbound/http/developmentMissionRoutes',
    'development-automation',
    'mountDevelopmentMissionRoutes',
    ['@/modules/identity-access/public/participants'],
  ],
  [
    'routes/missionInputUploads',
    'modules/development-automation/inbound/http/missionInputUploadRoutes',
    'development-automation',
    'mountMissionInputUploadRoutes',
    [],
  ],
]
const OLD = new Set(MOVED.map(([old]) => old))

/** The public file (below `src`, no extension) and the names it no longer offers. */
const WITHDRAWN: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'modules/collaboration/public/participants',
    [
      'AddReviewCommentInput',
      'AddedReviewComment',
      'CollaborationRouteActor',
      'CollaborationRouteOperations',
      'ListClarifySummariesInput',
      'ListReviewSummariesInput',
      'ReassignTaskQuestionAction',
      'ReviewCommentWriteAuthority',
      'SaveClarifyDraftInput',
      'SaveClarifyDraftResult',
      'SealClarifyQuestionsInput',
      'SealClarifyQuestionsResult',
    ],
  ],
  [
    'modules/collaboration/public/types',
    [
      'DispatchTaskQuestionsCommandInput',
      'DispatchTaskQuestionsCommandResult',
      'GateDecisionReceipt',
      'HumanGateIdentity',
      'ReviewAccessDecision',
      'ReviewAnchorRequest',
      'ReviewGateDecision',
      'SubmitClarifyDecisionCommandInput',
      'SubmitClarifyDecisionCommandResult',
      'SubmitReviewDecisionCommandInput',
      'SubmitReviewDecisionCommandResult',
      'TASK_QUESTION_CONFLICT',
    ],
  ],
  ['modules/collaboration/public/queries', ['isAskingNodeInSnapshot']],
  ['modules/development-automation/public/commands', ['MissionInputUploadOperations']],
]
/** The public entry deleted outright: everything in it belonged to the routes. */
const DELETED_PUBLIC = 'modules/development-automation/public/operations'

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

describe('RFC-579 —— 七个绑定离开 routes/', () => {
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

  test('负对照：别名、相对路径、带扩展名、动态 import、mock.module 与 import 类型都会被认出；新路径与别的路由不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { mountClarifyRoutes } from '@/routes/clarify'\n" +
          "export { mountReviewRoutes } from './routes/reviews.ts'\n" +
          "const questions = await import('./routes/taskQuestions')\n" +
          "mock.module('@/routes/developmentConfig', () => ({}))\n" +
          "type Uploads = typeof import('./routes/missionInputUploads')\n" +
          "import { mountClarifyRoutes as next } from './modules/collaboration/inbound/http/clarifyRoutes'\n" +
          "import { mountTaskRoutes } from './routes/tasks'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'routes/clarify',
      'routes/reviews',
      'routes/taskQuestions',
      'routes/developmentConfig',
      'routes/missionInputUploads',
    ])
    expect(
      resolvedSpecifiers(
        join(BACKEND, 'tests', 'helpers', 'probe.ts'),
        "import { REVIEW_WRITE_BODY_MAX_BYTES } from '../../src/routes/reviews'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/reviews'])
  })
})

describe('RFC-579 —— 绑定只取本模块与登记过的别的模块 public', () => {
  test('七个绑定对模块的 import 只取本模块与登记过的入口', () => {
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
        'collaboration',
        ['@/modules/task-execution/public/types'],
        'modules/collaboration/inbound/http/probe.ts',
        "import type { CollaborationRouteOperations } from '../../application/ports/collaborationRouteOperations'\n" +
          "import { TASK_QUESTION_CONFLICT } from '../../domain/taskQuestionConflicts'\n" +
          "import type { ReviewActor } from '@/modules/collaboration/public/types'\n" +
          "import type { TaskClarifyDirectiveRouteOperations } from '@/modules/task-execution/public/types'\n" +
          "import type { MemoryScopeRef } from '@/modules/memory/public/types'\n" +
          "import { compose } from '@/modules/collaboration/composition'\n" +
          "import type { Store } from '../../infrastructure/review'\n" +
          "import { listReviews } from '@/services/review'\n" +
          "import { openDb } from '@/db/client'\n",
      ),
    ).toEqual([
      '@/modules/memory/public/types (an unlisted module entry, or this module outside public)',
      '@/modules/collaboration/composition (an unlisted module entry, or this module outside public)',
      "../../infrastructure/review (relative import outside this module's application / domain / public)",
      '@/services/review (legacy data or service layer)',
      '@/db/client (legacy data or service layer)',
    ])
  })
})

describe('RFC-579 —— public 面与装配根', () => {
  test('四个 public 文件不再转出撤回的 26 个符号，development-automation 的 public/operations 不存在', () => {
    let listed = 0
    for (const [file, names] of WITHDRAWN) {
      const offered = offeredNames(`${file}.ts`, readFileSync(join(SRC, `${file}.ts`), 'utf8'))
      expect([file, offered.length > 0]).toEqual([file, true])
      for (const name of names) {
        listed += 1
        expect([file, name, offered.includes(name)]).toEqual([file, name, false])
      }
    }
    expect(listed).toBe(26)
    expect([DELETED_PUBLIC, existsSync(join(SRC, `${DELETED_PUBLIC}.ts`))]).toEqual([
      DELETED_PUBLIC,
      false,
    ])
  })

  test('负对照：转出、type 转出、带 type 修饰的转出与声明都会被认出', () => {
    expect(
      offeredNames(
        'probe.ts',
        "export { isAskingNodeInSnapshot, type ReviewGateDecision } from '../domain/clarifyAskingNode'\n" +
          "export type { CollaborationRouteOperations } from '../application/ports/collaborationRouteOperations'\n" +
          'export const TASK_QUESTION_CONFLICT = {}\n' +
          'interface NotOffered { readonly id: string }\n',
      ),
    ).toEqual([
      'CollaborationRouteOperations',
      'ReviewGateDecision',
      'TASK_QUESTION_CONFLICT',
      'isAskingNodeInSnapshot',
    ])
  })

  test('server.ts 从两个模块的 composition 取七个挂载函数，不再取 @/routes/ 下的这七个文件', () => {
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
