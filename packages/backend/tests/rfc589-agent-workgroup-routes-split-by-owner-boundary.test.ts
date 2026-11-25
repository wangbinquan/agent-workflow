// RFC-589 — 代理与工作组路由按端点 owner 拆进 resource-catalog 与 task-execution 的 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/`
// 第十一批）。
//
// 为什么存在：`routes/agents.ts`、`routes/workgroups.ts` 迁入 resource-catalog 的 `inbound/http/{agentRoutes,workgroupRoutes}.ts`，各自的启动端点
// （`POST /api/agents/:id/tasks`、`POST /api/workgroups/:id/tasks`，鉴权点 `tasks:execute`）迁入 task-execution 的
// `inbound/http/{agentTaskLaunchRoutes,workgroupTaskLaunchRoutes}.ts`——DAG 上 task-execution → resource-catalog 是 offered-consumption，反方向只有
// required-implementation，资源目录的绑定不能再取 task-execution 的启动操作。锁四件事：
// ① 两个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 资源目录的两个绑定只取本模块；两个启动绑定只取本模块与 resource-catalog 的 `public/participants`、`public/queries`、`public/types`（判据带负对照）。
// ③ 两个启动端点只在启动绑定里注册，资源目录的绑定不再注册它们、也不再带 `taskLaunch`。
// ④ `server.ts` 从两个 composition 取四个挂载函数；`agents`、`workgroups` 两步各挂两个绑定，资源目录的在前（判据带负对照）。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② ③ 只读四个绑定；④ 只读 `server.ts`。
// 路由行为由既有用例覆盖（代理 / 工作组的目录、ACL、闭包与启动用例，`rfc243` 的启动调用面，`rfc247` 的启动鉴权一致性，`routes-inventory`）。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')

const OLD = new Set(['routes/agents', 'routes/workgroups'])
const AGENTS = 'modules/resource-catalog/inbound/http/agentRoutes'
const WORKGROUPS = 'modules/resource-catalog/inbound/http/workgroupRoutes'
const AGENT_LAUNCH = 'modules/task-execution/inbound/http/agentTaskLaunchRoutes'
const WORKGROUP_LAUNCH = 'modules/task-execution/inbound/http/workgroupTaskLaunchRoutes'
/** The resource-catalog entries a launch binding reads the agent / workgroup through. */
const LAUNCH_ENTRIES = [
  '@/modules/resource-catalog/public/participants',
  '@/modules/resource-catalog/public/queries',
  '@/modules/resource-catalog/public/types',
] as const
const read = (file: string) => readFileSync(join(SRC, `${file}.ts`), 'utf8')

/** One step body in `server.ts`'s mount table: from `<key>: (app: Hono) =>` to the next step. */
function step(text: string, key: string): string {
  const start = text.indexOf(`\n    ${key}: (app: Hono) =>`)
  if (start < 0) return ''
  const next = text.slice(start + 1).search(/\n {4}[A-Za-z]+: \(app: Hono\) =>/)
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next)
}

/** Whether `first(app` is called before `second(app` in a step body (both present). */
function mountsInOrder(body: string, first: string, second: string): boolean {
  const a = body.indexOf(`${first}(app`)
  const b = body.indexOf(`${second}(app`)
  return a >= 0 && b > a
}

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

describe('RFC-589 —— 两个绑定离开 routes/', () => {
  test('两个旧路径不存在，四个新文件存在，挂载函数还在', () => {
    expect(existsSync(join(SRC, 'routes', 'agents.ts'))).toBe(false)
    expect(existsSync(join(SRC, 'routes', 'workgroups.ts'))).toBe(false)
    for (const [file, mount] of [
      [AGENTS, 'mountAgentRoutes'],
      [WORKGROUPS, 'mountWorkgroupRoutes'],
      [AGENT_LAUNCH, 'mountAgentTaskLaunchRoutes'],
      [WORKGROUP_LAUNCH, 'mountWorkgroupTaskLaunchRoutes'],
    ] as const) {
      expect([file, existsSync(join(SRC, `${file}.ts`))]).toEqual([file, true])
      expect([file, offeredNames(`${file}.ts`, read(file)).includes(mount)]).toEqual([file, true])
    }
  })

  test('src / tests / scripts 的全部说明符不再解析到两个旧路径', () => {
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

  test('负对照：别名、相对路径、带扩展名、动态 import 与 import 类型都会被认出；新位置与同前缀的路由不算', () => {
    expect(
      resolvedSpecifiers(
        join(SRC, 'server.ts'),
        "import { mountAgentRoutes } from '@/routes/agents'\n" +
          "export { mountWorkgroupRoutes } from './routes/workgroups.ts'\n" +
          "const agents = await import('./routes/agents')\n" +
          "export type Probe = typeof import('@/routes/workgroups')\n" +
          `import { mountAgentRoutes as next } from './${AGENTS}'\n` +
          `import { mountAgentTaskLaunchRoutes } from './${AGENT_LAUNCH}'\n` +
          "import { mountWorkgroupTaskRoutes } from './routes/workgroupTasks'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/agents', 'routes/workgroups', 'routes/agents', 'routes/workgroups'])
  })
})

describe('RFC-589 —— 四个绑定只取本模块与登记过的入口', () => {
  test('资源目录的两个绑定只取 resource-catalog；两个启动绑定另取 resource-catalog 的三个 public 入口', () => {
    for (const file of [AGENTS, WORKGROUPS])
      expect([file, bindingLeaks('resource-catalog', [], `${file}.ts`, read(file))]).toEqual([
        file,
        [],
      ])
    for (const file of [AGENT_LAUNCH, WORKGROUP_LAUNCH])
      expect([
        file,
        bindingLeaks('task-execution', LAUNCH_ENTRIES, `${file}.ts`, read(file)),
      ]).toEqual([file, []])
  })

  test('负对照：资源目录的绑定取 task-execution、启动绑定取 resource-catalog 的内部都会被认出', () => {
    expect(
      bindingLeaks(
        'resource-catalog',
        [],
        `${AGENTS}.ts`,
        "import type { AgentQueries } from '@/modules/resource-catalog/public/queries'\n" +
          "import type { AgentRouteTaskLaunchOperations } from '@/modules/task-execution/public/commands'\n",
      ),
    ).toEqual([
      '@/modules/task-execution/public/commands (an unlisted module entry, or this module outside public)',
    ])
    expect(
      bindingLeaks(
        'task-execution',
        LAUNCH_ENTRIES,
        `${AGENT_LAUNCH}.ts`,
        "import type { AgentQueries } from '@/modules/resource-catalog/public/queries'\n" +
          "import { createAgentQueries } from '@/modules/resource-catalog/application/agents/agentQueries'\n",
      ),
    ).toEqual([
      '@/modules/resource-catalog/application/agents/agentQueries (an unlisted module entry, or this module outside public)',
    ])
  })
})

describe('RFC-589 —— 启动端点与挂载', () => {
  test('两个启动端点只在启动绑定里注册；资源目录的绑定不再带 taskLaunch', () => {
    for (const [owner, launch, path] of [
      [AGENTS, AGENT_LAUNCH, '/api/agents/:id/tasks'],
      [WORKGROUPS, WORKGROUP_LAUNCH, '/api/workgroups/:id/tasks'],
    ] as const) {
      expect([path, read(launch).includes(`path: '${path}'`)]).toEqual([path, true])
      expect([path, read(owner).includes(`path: '${path}'`)]).toEqual([path, false])
      expect([owner, read(owner).includes('taskLaunch')]).toEqual([owner, false])
    }
  })

  test('server.ts 从两个 composition 取四个挂载函数，两步里资源目录的绑定先挂', () => {
    const text = read('server')
    const block = (entry: string) =>
      text.match(new RegExp(`import \\{([^}]*)\\} from '@/modules/${entry}/composition'`))?.[1] ??
      ''
    for (const name of ['mountAgentRoutes', 'mountWorkgroupRoutes'])
      expect([name, block('resource-catalog').includes(name)]).toEqual([name, true])
    for (const name of ['mountAgentTaskLaunchRoutes', 'mountWorkgroupTaskLaunchRoutes'])
      expect([name, block('task-execution').includes(name)]).toEqual([name, true])
    expect(
      mountsInOrder(step(text, 'agents'), 'mountAgentRoutes', 'mountAgentTaskLaunchRoutes'),
    ).toBe(true)
    expect(
      mountsInOrder(
        step(text, 'workgroups'),
        'mountWorkgroupRoutes',
        'mountWorkgroupTaskLaunchRoutes',
      ),
    ).toBe(true)
  })

  test('负对照：少挂启动绑定、顺序反过来或挂到别的步骤都会被认出', () => {
    const table = (agents: string, workgroups: string) =>
      `\n    agents: (app: Hono) => {\n${agents}    },\n    mcps: (app: Hono) => x,\n    workgroups: (app: Hono) => {\n${workgroups}    },\n    resourcePackages: (app: Hono) => y,\n`
    const missing = table(
      '      mountAgentRoutes(app, a)\n',
      '      mountWorkgroupRoutes(app, w)\n      mountWorkgroupTaskLaunchRoutes(app, w)\n',
    )
    expect(
      mountsInOrder(step(missing, 'agents'), 'mountAgentRoutes', 'mountAgentTaskLaunchRoutes'),
    ).toBe(false)
    const reversed = table(
      '      mountAgentTaskLaunchRoutes(app, a)\n      mountAgentRoutes(app, a)\n',
      '      mountWorkgroupRoutes(app, w)\n      mountWorkgroupTaskLaunchRoutes(app, w)\n',
    )
    expect(
      mountsInOrder(step(reversed, 'agents'), 'mountAgentRoutes', 'mountAgentTaskLaunchRoutes'),
    ).toBe(false)
    const elsewhere = table(
      '      mountAgentRoutes(app, a)\n',
      '      mountWorkgroupRoutes(app, w)\n      mountWorkgroupTaskLaunchRoutes(app, w)\n      mountAgentTaskLaunchRoutes(app, a)\n',
    )
    expect(
      mountsInOrder(step(elsewhere, 'agents'), 'mountAgentRoutes', 'mountAgentTaskLaunchRoutes'),
    ).toBe(false)
    expect(
      mountsInOrder(
        step(elsewhere, 'workgroups'),
        'mountWorkgroupRoutes',
        'mountWorkgroupTaskLaunchRoutes',
      ),
    ).toBe(true)
  })
})
