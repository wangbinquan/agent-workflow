// RFC-580 — resource-catalog 的工作流、工作组任务房间与资源包路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第五批）。
//
// 为什么存在：三个路由原样迁进 `modules/resource-catalog/inbound/http/`，挂载函数经模块的 `composition.ts` 转出，`server.ts` 从那里取；只被这些
// 路由用的 22 个 public 声明（按架构报告的消费者表与 public 类型引用算到不动点）逐字移进 application / domain。锁四件事：
// ① 三个旧路径不存在；`src` / `tests` / `scripts` 里没有任何说明符再解析到它们（判据带负对照）。
// ② 三个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application / domain / public）与登记过的别的模块 public
//    （资源包路由：identity-access `public/participants`）；不取 `@/db` 与 `services/`（判据带负对照）。
// ③ resource-catalog 的四个 public 文件不再导出这 22 个名字；两个新的 application 文件与 `domain/resourceKinds.ts` 声明了它们。
// ④ `server.ts` 从 composition 取三个挂载函数，不再取 `@/routes/` 下的这三个文件。
//
// 覆盖范围（C12）：① 覆盖 backend 的 `src`、`tests`、`scripts` 与仓库根 `scripts` 的全部 TS / MJS 文件；② 只读三个绑定；③ 只读四个 public 文件与
// 三个落位文件；④ 只读 `server.ts`。路由行为由既有用例覆盖（`rfc345-resource-catalog-contracts`、`rfc199`、`rfc209`、`rfc271-*`、`rfc187`、`rfc164`、
// `wg-readonly-claim-and-pause-reason` 与 `routes-inventory`）。
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
    'routes/workflows',
    'modules/resource-catalog/inbound/http/workflowRoutes',
    'resource-catalog',
    'mountWorkflowRoutes',
    [],
  ],
  [
    'routes/workgroupTasks',
    'modules/resource-catalog/inbound/http/workgroupTaskRoutes',
    'resource-catalog',
    'mountWorkgroupTaskRoutes',
    [],
  ],
  [
    'routes/resourcePackages',
    'modules/resource-catalog/inbound/http/resourcePackageRoutes',
    'resource-catalog',
    'registerResourcePackageRoutes',
    ['@/modules/identity-access/public/participants'],
  ],
]
const OLD = new Set(MOVED.map(([old]) => old))

const RC = 'modules/resource-catalog'
/** Where each withdrawn declaration lives now (below `src`, no extension), with the public file it left. */
const RELOCATED: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  [
    `${RC}/application/workflows/operationContracts`,
    `${RC}/public/types`,
    [
      'CopyWorkflowCatalogInput',
      'CreateWorkflowCatalogInput',
      'DeleteWorkflowCatalogInput',
      'DeleteWorkflowCatalogReceipt',
      'UpdateWorkflowCatalogInput',
      'UpdateWorkflowCatalogReceipt',
    ],
  ],
  [
    `${RC}/application/workflows/operationContracts`,
    `${RC}/public/operations`,
    ['WorkflowOperationDescriptors'],
  ],
  [
    `${RC}/application/workgroups/taskRoomContracts`,
    `${RC}/public/types`,
    [
      'WorkgroupTaskAssignmentRef',
      'WorkgroupTaskAssignmentSubmission',
      'WorkgroupTaskConfigReceipt',
      'WorkgroupTaskDecisionReceipt',
      'WorkgroupTaskDeliveryReceipt',
      'WorkgroupTaskJsonDocument',
      'WorkgroupTaskJsonSubmission',
      'WorkgroupTaskMessageReceipt',
      'WorkgroupTaskRef',
      'WorkgroupTaskSubmission',
      'WorkgroupTaskWorkflowReceipt',
    ],
  ],
  [
    `${RC}/application/workgroups/taskRoomContracts`,
    `${RC}/public/operations`,
    ['WorkgroupTaskRoomModule'],
  ],
  [
    `${RC}/application/workgroups/taskRoomContracts`,
    `${RC}/public/commands`,
    ['WorkgroupTaskRoomCommands'],
  ],
  [
    `${RC}/application/workgroups/taskRoomContracts`,
    `${RC}/public/queries`,
    ['WorkgroupTaskRoomQueries'],
  ],
  [`${RC}/domain/resourceKinds`, `${RC}/public/types`, ['PackageResourceKind']],
]

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

describe('RFC-580 —— 三个绑定离开 routes/', () => {
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
        "import { mountWorkflowRoutes } from '@/routes/workflows'\n" +
          "export { mountWorkgroupTaskRoutes } from './routes/workgroupTasks.ts'\n" +
          "const packages = await import('./routes/resourcePackages')\n" +
          "mock.module('@/routes/workflows', () => ({}))\n" +
          "type Room = typeof import('./routes/workgroupTasks')\n" +
          "import { mountWorkflowRoutes as next } from './modules/resource-catalog/inbound/http/workflowRoutes'\n" +
          "import { mountWorkgroupRoutes } from './routes/workgroups'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual([
      'routes/workflows',
      'routes/workgroupTasks',
      'routes/resourcePackages',
      'routes/workflows',
      'routes/workgroupTasks',
    ])
    expect(
      resolvedSpecifiers(
        join(BACKEND, 'tests', 'helpers', 'probe.ts'),
        "import { resolveMentions } from '../../src/routes/workgroupTasks'\n",
      ).filter((target) => OLD.has(target)),
    ).toEqual(['routes/workgroupTasks'])
  })
})

describe('RFC-580 —— 绑定只取本模块与登记过的别的模块 public', () => {
  test('三个绑定对模块的 import 只取本模块与登记过的入口', () => {
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
        'resource-catalog',
        ['@/modules/identity-access/public/participants'],
        'modules/resource-catalog/inbound/http/probe.ts',
        "import type { WorkflowOperationDescriptors } from '../../application/workflows/operationContracts'\n" +
          "import type { PackageResourceKind } from '../../domain/resourceKinds'\n" +
          "import type { WorkflowQueries } from '@/modules/resource-catalog/public/queries'\n" +
          "import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'\n" +
          "import type { WorkgroupRouteTaskLaunchOperations } from '@/modules/task-execution/public/commands'\n" +
          "import { compose } from '@/modules/resource-catalog/composition'\n" +
          "import type { Store } from '../../infrastructure/workgroupRepository'\n" +
          "import { listWorkflows } from '@/services/workflow'\n" +
          "import { openDb } from '@/db/client'\n",
      ),
    ).toEqual([
      '@/modules/task-execution/public/commands (an unlisted module entry, or this module outside public)',
      '@/modules/resource-catalog/composition (an unlisted module entry, or this module outside public)',
      "../../infrastructure/workgroupRepository (relative import outside this module's application / domain / public)",
      '@/services/workflow (legacy data or service layer)',
      '@/db/client (legacy data or service layer)',
    ])
  })
})

describe('RFC-580 —— public 面、落位与装配根', () => {
  test('四个 public 文件不再导出这 22 个名字，落位文件声明了它们', () => {
    let listed = 0
    for (const [home, publicFile, names] of RELOCATED) {
      const offered = offeredNames(
        `${publicFile}.ts`,
        readFileSync(join(SRC, `${publicFile}.ts`), 'utf8'),
      )
      const declared = offeredNames(`${home}.ts`, readFileSync(join(SRC, `${home}.ts`), 'utf8'))
      expect([publicFile, offered.length > 0]).toEqual([publicFile, true])
      for (const name of names) {
        listed += 1
        expect([publicFile, name, offered.includes(name)]).toEqual([publicFile, name, false])
        expect([home, name, declared.includes(name)]).toEqual([home, name, true])
      }
    }
    expect(listed).toBe(22)
  })

  test('负对照：转出、type 转出、带 type 修饰的转出与声明都会被认出', () => {
    expect(
      offeredNames(
        'probe.ts',
        "export { type WorkgroupTaskRef } from '../application/workgroups/taskRoomContracts'\n" +
          "export type { PackageResourceKind } from '../domain/resourceKinds'\n" +
          'export interface WorkflowOperationDescriptors { readonly list: unknown }\n' +
          'interface NotOffered { readonly id: string }\n',
      ),
    ).toEqual(['PackageResourceKind', 'WorkflowOperationDescriptors', 'WorkgroupTaskRef'])
  })

  test('server.ts 从 composition 取三个挂载函数，不再取 @/routes/ 下的这三个文件', () => {
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
