// RFC-588 — 任务路由按端点 owner 拆进 task-execution 与 workspace-insight 的 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第十批）。
//
// 为什么存在：`routes/tasks.ts` 迁入 task-execution 的 `inbound/http/taskRoutes.ts`，其中结构化 diff、变更叙述、文件内容 / 符号、代码智能与调用目标
// 七个端点迁入 workspace-insight 的 `inbound/http/taskWorkspaceInsightRoutes.ts`（DAG 只有 workspace-insight → task-execution）。可见性中间件留在
// 任务路由里，`server.ts` 的 `tasks` 一步先挂任务路由、再挂工作区洞察绑定（Hono 按注册顺序组链，反过来七个端点就绕过可见性检查）。锁四件事：
// ① 旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它（判据带负对照）。
// ② 两个绑定对模块的 import 只取本模块与登记过的入口（工作区洞察绑定：task-execution 的 `public/commands`）（判据带负对照）。
// ③ 七个端点只在工作区洞察绑定里注册；可见性中间件只在任务路由里注册。
// ④ `server.ts` 从两个 composition 取挂载函数，`tasks` 一步里任务路由先于工作区洞察绑定挂载（判据带负对照）。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读两个绑定；④ 只读 `server.ts`。
// 路由行为由既有用例覆盖（`tasks.test.ts`、`change-narrative`、`structural-diff-*`、`rfc370-v16-code-review-services`、`rfc285` 的可见性用例与
// `routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { resolveMigrationSpecifiers } from './helpers/rfc624MigrationSpecifiers'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const TASKS = 'modules/task-execution/inbound/http/taskRoutes'
const INSIGHT = 'modules/workspace-insight/inbound/http/taskWorkspaceInsightRoutes'
/** The seven workspace-insight endpoints. */
const INSIGHT_PATHS = [
  '/api/tasks/:id/structural-diff',
  '/api/tasks/:id/change-narrative',
  '/api/tasks/:id/file-content',
  '/api/tasks/:id/file-symbols',
  '/api/tasks/:id/code-intel',
  '/api/tasks/:id/call-targets',
] as const

/** The `tasks` step body in `server.ts`: the arrow function after `tasks: (app: Hono) =>`. */
function tasksStep(text: string): string {
  const start = text.indexOf('tasks: (app: Hono) =>')
  if (start < 0) return ''
  const end = text.indexOf('\n    taskCatalog:', start)
  return text.slice(start, end < 0 ? undefined : end)
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

describe('RFC-588 —— 任务路由离开 routes/', () => {
  test('旧路径不存在，两个新文件存在，挂载函数还在', () => {
    expect(existsSync(join(SRC, 'routes', 'tasks.ts'))).toBe(false)
    for (const [file, mount] of [
      [TASKS, 'mountTaskRoutes'],
      [INSIGHT, 'mountTaskWorkspaceInsightRoutes'],
    ] as const) {
      expect([file, existsSync(join(SRC, `${file}.ts`))]).toEqual([file, true])
      expect([
        file,
        offeredNames(`${file}.ts`, readFileSync(join(SRC, `${file}.ts`), 'utf8')).includes(mount),
      ]).toEqual([file, true])
    }
  })

  // RFC-629: this rule's full-corpus scan is registered in architecture/rfc624-migration-reference-guard.test.ts.

  test('负对照：别名、相对路径、带扩展名、动态 import 与 import 类型都会被认出；新位置与同前缀的路由不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { mountTaskRoutes } from '@/routes/tasks'\n" +
          "export { mountTaskRoutes as m } from './routes/tasks.ts'\n" +
          "const tasks = await import('./routes/tasks')\n" +
          "export type Probe = typeof import('@/routes/tasks')\n" +
          `import { mountTaskRoutes as next } from './${TASKS}'\n` +
          "import { mountTaskCatalogRoutes } from './routes/taskCatalog'\n",
      ).filter((target) => target === 'routes/tasks'),
    ).toEqual(['routes/tasks', 'routes/tasks', 'routes/tasks', 'routes/tasks'])
  })
})

describe('RFC-588 —— 两个绑定只取本模块与登记过的入口', () => {
  test('任务路由只取 task-execution；工作区洞察绑定另取 task-execution 的 public/commands', () => {
    expect(
      bindingLeaks(
        'task-execution',
        [],
        `${TASKS}.ts`,
        readFileSync(join(SRC, `${TASKS}.ts`), 'utf8'),
      ),
    ).toEqual([])
    expect(
      bindingLeaks(
        'workspace-insight',
        ['@/modules/task-execution/public/commands'],
        `${INSIGHT}.ts`,
        readFileSync(join(SRC, `${INSIGHT}.ts`), 'utf8'),
      ),
    ).toEqual([])
  })

  test('负对照：任务路由取 workspace-insight 或 system-operations 的 public 会被认出', () => {
    expect(
      bindingLeaks(
        'task-execution',
        [],
        `${TASKS}.ts`,
        "import type { TaskRouteOperations } from '@/modules/task-execution/public/commands'\n" +
          "import type { TaskWorkspaceInsight } from '@/modules/workspace-insight/public/types'\n" +
          "import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'\n",
      ),
    ).toEqual([
      '@/modules/workspace-insight/public/types (an unlisted module entry, or this module outside public)',
      '@/modules/system-operations/public/queries (an unlisted module entry, or this module outside public)',
    ])
  })
})

describe('RFC-588 —— 端点、中间件与挂载顺序', () => {
  test('七个端点只在工作区洞察绑定里注册；可见性中间件只在任务路由里注册', () => {
    const tasks = readFileSync(join(SRC, `${TASKS}.ts`), 'utf8')
    const insight = readFileSync(join(SRC, `${INSIGHT}.ts`), 'utf8')
    for (const path of INSIGHT_PATHS) {
      expect([path, insight.includes(`path: '${path}'`)]).toEqual([path, true])
      expect([path, tasks.includes(`path: '${path}'`)]).toEqual([path, false])
    }
    expect(tasks).toContain("registerRouteMiddleware(app, '/api/tasks/:id/*'")
    expect(insight).not.toContain('registerRouteMiddleware(')
    expect(insight).not.toContain('app.use(')
  })

  test('server.ts 从两个 composition 取挂载函数，tasks 一步里任务路由先挂', () => {
    const text = readFileSync(join(SRC, 'server.ts'), 'utf8')
    expect(text).toMatch(
      /\bmountTaskRoutes,\n[\s\S]*?\} from '@\/modules\/task-execution\/composition'/,
    )
    expect(text).toContain(
      "import { mountTaskWorkspaceInsightRoutes } from '@/modules/workspace-insight/composition'",
    )
    const step = tasksStep(text)
    const first = step.indexOf('mountTaskRoutes(app')
    const second = step.indexOf('mountTaskWorkspaceInsightRoutes(app')
    expect([first >= 0, second > first]).toEqual([true, true])
  })

  test('负对照：顺序反过来或少挂一个都会被认出', () => {
    const reversed = tasksStep(
      'tasks: (app: Hono) => {\n      mountTaskWorkspaceInsightRoutes(app, x)\n      mountTaskRoutes(app, x)\n    },\n    taskCatalog: (app: Hono) => y,',
    )
    expect(
      reversed.indexOf('mountTaskWorkspaceInsightRoutes(app') >
        reversed.indexOf('mountTaskRoutes(app'),
    ).toBe(false)
    const missing = tasksStep(
      'tasks: (app: Hono) => mountTaskRoutes(app, x),\n    taskCatalog: (app: Hono) => y,',
    )
    expect(missing.indexOf('mountTaskWorkspaceInsightRoutes(app')).toBe(-1)
  })
})
