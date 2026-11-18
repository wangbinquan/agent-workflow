// RFC-504 — 资源目录的内建工作流、资源包暂存、任务房协作、意图上下文授权与 MCP 测试失效迁出 composition（RFC-294 S10 第十一步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的新位置声明（design §3 列的同名类型钉在原处）；改名前的四个名字没有声明；三个新文件
//    恰好声明、交出清单列的名字，三个既有文件交出清单列的名字。
// ② `composition/builtinWorkflowCatalog.ts` 不存在；四个组合文件没有 if / for / while / do / switch / try / throw 语句，各自从新位置取实现与
//    转出；resource-catalog 的 `composition.ts` 从新位置只转出 `createBuiltinWorkflowCatalog`，生产代码里只有 bootstrap 的
//    `daemonModules/digitalEmployee.ts` 经它取、调用一次；任务房的两个工厂在生产代码里只有 `daemonHttpComposition.ts` 各调用一次；内建工作流
//    目录仍经工作流写入参与者建行（带负对照）。
// ③ 全部生产文件、用例与 e2e 不从删除的位置取任何东西：命名 import、type-only、默认与副作用 import、re-export、命名空间成员与动态 import
//    都认，带负对照。
// ④ application 的新代码依赖面是闭集：两个新文件与两个既有文件只取 `@agent-workflow/shared`、`@/auth/actor`、`@/util/errors`、`@/util/hash`、
//    identity-access 的 `public/participants` 与本模块 domain / application / public，不用进程全局；infrastructure 的两个文件不取任何
//    composition（带负对照）。
//
// 覆盖范围（C12）：① ③ 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、
// 再逐个解析 AST；② ④ 另读四个组合文件、resource-catalog 的 `composition.ts`、bootstrap 的两个文件与新位置。前端（`packages/frontend`）
// 不在语料内：它那份同名的 `ResourcePackageExportFence` 是 HTTP 客户端自己的类型。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const RC = 'modules/resource-catalog'
const APP = `${RC}/application`
const INFRA = `${RC}/infrastructure`
const COMP = `${RC}/composition`
/** `composition.ts` itself (the same path without the directory suffix). */
const MODULE_COMPOSITION = COMP
const DELETED = [`${COMP}/builtinWorkflowCatalog`]
const ASSEMBLY_ONLY = [
  `${COMP}/intentContextAuthorization`,
  `${COMP}/mcpOperations`,
  `${COMP}/resourcePackageOperations`,
  `${COMP}/workgroupTaskRoom`,
]

/** design §3: each new file, the names it declares and offers, and the names it declares without offering. */
const NEW_FILES: Readonly<
  Record<string, { readonly offered: readonly string[]; readonly internal: readonly string[] }>
> = {
  [`${APP}/package/stagedExecution`]: {
    offered: [
      'ResourcePackageExportFence',
      'ResourcePackageInspectExecutionInput',
      'ResourcePackageApplyExecutionInput',
      'ResourcePackageExportExecutionInput',
      'ResourcePackageExecutionAdapter',
      'ResourcePackageTransport',
      'createResourcePackageStagedExecution',
    ],
    internal: ['StagedResourcePackageInput'],
  },
  [`${APP}/workgroups/taskRoomCollaborators`]: {
    offered: [
      'createWorkgroupTaskRoomActiveUsers',
      'WorkgroupTaskRoomWorkflowCreation',
      'createWorkgroupTaskRoomDynamicWorkflow',
    ],
    internal: [],
  },
  [`${INFRA}/builtinWorkflowCatalog`]: { offered: ['createBuiltinWorkflowCatalog'], internal: [] },
}
/** design §3: existing files that now also declare and offer these names. */
const EXTENDED_FILES: Readonly<Record<string, readonly string[]>> = {
  [`${APP}/workgroups/ports`]: [
    'WorkgroupTaskRoomActiveUserDirectory',
    'WorkgroupTaskRoomDynamicWorkflowOperations',
  ],
  [`${APP}/participants/intentContextResourceAuthorization`]: [
    'IntentContextResourceAuthorityPair',
    'createIntentContextCurrentAuthorityResolver',
  ],
  [`${INFRA}/mcpRuntimeTestTransitions`]: ['mcpAclRuntimeTestLifecycle'],
}
const LOCATIONS = [...Object.keys(NEW_FILES), ...Object.keys(EXTENDED_FILES)]
/** Declarations that share a moved name and predate RFC-504, pinned one by one (design §3). */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  ResourcePackageExportFence: [`${COMP}/resourcePackageExecution`, 'routes/resourcePackages'],
  ResourcePackageExecutionAdapter: [`${COMP}/resourcePackageExecution`],
  ResourcePackageInspectExecutionInput: [`${COMP}/resourcePackageExecution`],
  ResourcePackageApplyExecutionInput: [`${COMP}/resourcePackageExecution`],
  ResourcePackageExportExecutionInput: [`${COMP}/resourcePackageExecution`],
  IntentContextResourceAuthorityPair: ['modules/intent/application/ports/intentPersistence'],
}
const RETIRED = [
  'composeBuiltinWorkflowCatalog',
  'composeWorkgroupTaskRoomActiveUsers',
  'composeWorkgroupTaskRoomDynamicWorkflow',
  'currentAuthorityResolver',
]
/** design §3 / D3: what each remaining composition file takes from (or re-exports out of) the new locations. */
const TAKES: Readonly<Record<string, readonly string[]>> = {
  [`${COMP}/intentContextAuthorization`]: [
    `import ${APP}/participants/intentContextResourceAuthorization: createIntentContextCurrentAuthorityResolver, createIntentContextResourceAuthorizationSession, IntentContextResourceAuthorityPair`,
  ],
  [`${COMP}/mcpOperations`]: [
    `export ${INFRA}/mcpRuntimeTestTransitions: mcpAclRuntimeTestLifecycle`,
  ],
  [`${COMP}/resourcePackageOperations`]: [
    `import ${APP}/package/stagedExecution: createResourcePackageStagedExecution, ResourcePackageExecutionAdapter, ResourcePackageTransport`,
    `export ${APP}/package/stagedExecution: ResourcePackageExecutionAdapter, ResourcePackageTransport`,
  ],
  [`${COMP}/workgroupTaskRoom`]: [
    `export ${APP}/workgroups/taskRoomCollaborators: createWorkgroupTaskRoomActiveUsers, createWorkgroupTaskRoomDynamicWorkflow`,
  ],
}
const MODULE_REEXPORTS = [`export ${INFRA}/builtinWorkflowCatalog: createBuiltinWorkflowCatalog`]
/** The production caller of each moved factory (each calls it exactly once). */
const PRODUCTION_CALLERS: Readonly<Record<string, string>> = {
  createBuiltinWorkflowCatalog: 'bootstrap/daemonModules/digitalEmployee',
  createWorkgroupTaskRoomActiveUsers: 'bootstrap/daemonHttpComposition',
  createWorkgroupTaskRoomDynamicWorkflow: 'bootstrap/daemonHttpComposition',
}
const BOOTSTRAP_TAKES: Readonly<Record<string, string>> = {
  'bootstrap/daemonModules/digitalEmployee': `import ${MODULE_COMPOSITION}: createBuiltinWorkflowCatalog`,
  'bootstrap/daemonHttpComposition': `import ${COMP}/workgroupTaskRoom: composeWorkgroupTaskRoom, createWorkgroupTaskRoomActiveUsers, createWorkgroupTaskRoomDynamicWorkflow`,
}
/** Edges whose source is one of the RFC-504 locations (other pre-existing edges of the same file are not on this RFC's list). */
const edgesToLocations = (edges: readonly string[]) =>
  edges.filter((edge) =>
    LOCATIONS.some((location) => edge.split(': ')[0]!.endsWith(` ${location}`)),
  )
const mentionsOldLocation = (source: string) => /builtinWorkflowCatalog/.test(source)
/** The tests below read every production file, test and e2e file; the first pays the cold read. */
const CORPUS_TIMEOUT = 30_000

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}
const PRODUCTION = walk(SRC)
const TEST_FILES = walk(join(BACKEND, 'tests'))
const E2E_FILES = walk(join(REPO, 'e2e'))
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (abs: string) => slash(relative(SRC, abs)).replace(/\.tsx?$/, '')
const corpusPath = (abs: string) => slash(relative(REPO, abs))
const sourceOf = (location: string) => join(SRC, `${location}.ts`)
/** `@/…` and relative specifiers as a path under `src` without extension; packages yield null. */
const resolveSpecifier = (file: string, specifier: string) =>
  specifier.startsWith('@/')
    ? srcPath(join(SRC, specifier.slice(2)))
    : specifier.startsWith('.')
      ? srcPath(resolve(dirname(file), specifier))
      : null

function declaredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name.text)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
  }
  return names
}

function offeredNames(path: string, source: string): string[] {
  const names: string[] = []
  for (const statement of parse(path, source).statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exported) names.push(...declaredNames(path, statement.getFullText()))
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) names.push(element.name.text)
  }
  return names
}

/** Every static import or re-export of the file as `kind specifier: names` (resolved under `src`; packages as written). */
function moduleEdges(file: string, source: string): string[] {
  const out: string[] = []
  for (const statement of parse(file, source).statements) {
    if (
      !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const from =
      resolveSpecifier(file, statement.moduleSpecifier.text) ?? statement.moduleSpecifier.text
    let names = ['<other>']
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings !== undefined && ts.isNamedImports(bindings))
        names = bindings.elements.map((element) => (element.propertyName ?? element.name).text)
    } else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause))
      names = statement.exportClause.elements.map(
        (element) => (element.propertyName ?? element.name).text,
      )
    out.push(
      `${ts.isImportDeclaration(statement) ? 'import' : 'export'} ${from}: ${names.join(', ')}`,
    )
  }
  return out
}

/** The argument texts (whitespace removed) of every call of `name` in the file. */
function callArguments(path: string, source: string, name: string): string[][] {
  const file = parse(path, source)
  const calls: string[][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(node.arguments.map((argument) => argument.getText(file).replace(/\s+/g, '')))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

const CONTROL_FLOW = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.IfStatement, 'if'],
  [ts.SyntaxKind.ForStatement, 'for'],
  [ts.SyntaxKind.ForInStatement, 'for-in'],
  [ts.SyntaxKind.ForOfStatement, 'for-of'],
  [ts.SyntaxKind.WhileStatement, 'while'],
  [ts.SyntaxKind.DoStatement, 'do'],
  [ts.SyntaxKind.SwitchStatement, 'switch'],
  [ts.SyntaxKind.TryStatement, 'try'],
  [ts.SyntaxKind.ThrowStatement, 'throw'],
])
/** Control-flow statements anywhere in the file (design §3; stricter than the F13 line-start count). */
function controlFlow(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return out
}

/** Production files that call `name`, each with its call count. */
function productionCallers(name: string): string[] {
  return PRODUCTION.filter((path) => text(path).includes(name))
    .map((path) => [srcPath(path), callArguments(path, text(path), name).length] as const)
    .filter(([, count]) => count > 0)
    .map(([path, count]) => `${path} x${count}`)
    .sort()
}

/**
 * `file -> old location: what` for everything a file still takes from the deleted file (design §4 ③): named import,
 * type-only, default and side-effect import, `export … from` and `export * from`, members of a namespace import (value
 * and type positions), and dynamic `import()` with its destructured names; specifiers resolve from the file.
 */
function takenFromOldLocations(file: string, source: string): string[] {
  const out: string[] = []
  const label = corpusPath(file)
  const oldOf = (specifier: string) => {
    const resolved = resolveSpecifier(file, specifier)
    return resolved !== null && DELETED.includes(resolved) ? resolved : null
  }
  const flag = (from: string, what: string) => out.push(`${label} -> ${from}: ${what}`)
  const namespaces = new Map<string, string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const from = oldOf(node.moduleSpecifier.text)
      if (from !== null) {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause
          if (clause === undefined) flag(from, '<side effect>')
          if (clause?.name !== undefined) flag(from, 'default')
          const bindings = clause?.namedBindings
          if (bindings !== undefined && ts.isNamedImports(bindings))
            for (const element of bindings.elements)
              flag(from, (element.propertyName ?? element.name).text)
          if (bindings !== undefined && ts.isNamespaceImport(bindings))
            namespaces.set(bindings.name.text, from)
        } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause))
          for (const element of node.exportClause.elements)
            flag(from, (element.propertyName ?? element.name).text)
        else flag(from, '*')
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const from = oldOf(node.arguments[0].text)
      if (from !== null) flag(from, 'import()')
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      let call: ts.Expression = node.initializer
      if (ts.isAwaitExpression(call)) call = call.expression
      if (
        ts.isCallExpression(call) &&
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        call.arguments[0] !== undefined &&
        ts.isStringLiteral(call.arguments[0])
      ) {
        const from = oldOf(call.arguments[0].text)
        if (from !== null)
          for (const element of node.name.elements)
            flag(from, (element.propertyName ?? element.name).getText())
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      flag(namespaces.get(node.expression.text)!, node.name.text)
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && namespaces.has(node.left.text))
      flag(namespaces.get(node.left.text)!, node.right.text)
    ts.forEachChild(node, visit)
  }
  // Namespace imports are statements at the top, so one pass sees the binding before its members.
  visit(parse(file, source))
  return out
}

/** The application files whose dependency surface is closed (design §4 ④). */
const APPLICATION_FILES = [
  `${APP}/package/stagedExecution`,
  `${APP}/workgroups/taskRoomCollaborators`,
  `${APP}/workgroups/ports`,
  `${APP}/participants/intentContextResourceAuthorization`,
]
const INFRASTRUCTURE_FILES = [
  `${INFRA}/builtinWorkflowCatalog`,
  `${INFRA}/mcpRuntimeTestTransitions`,
]
const APPLICATION_SURFACE = (file: string, specifier: string): boolean => {
  if (
    [
      '@agent-workflow/shared',
      '@/auth/actor',
      '@/util/errors',
      '@/util/hash',
      '@/modules/identity-access/public/participants',
    ].includes(specifier)
  )
    return true
  const rel = resolveSpecifier(file, specifier)
  return (
    rel !== null &&
    ['domain', 'application', 'public'].some((layer) => rel.startsWith(`${RC}/${layer}/`))
  )
}
/** Infrastructure may take anything but a module's composition. */
const NOT_COMPOSITION = (file: string, specifier: string): boolean => {
  const rel = resolveSpecifier(file, specifier)
  return rel === null || !/^modules\/[^/]+\/composition(\/|$)/.test(rel)
}

/** Imports outside the surface and process globals, read from the syntax tree. */
function purityFindings(
  file: string,
  source: string,
  allowed: (file: string, specifier: string) => boolean,
  globals: boolean,
): string[] {
  const findings: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !allowed(file, node.moduleSpecifier.text)
    )
      findings.push(`import ${node.moduleSpecifier.text}`)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      !allowed(file, node.arguments[0].text)
    )
      findings.push(`import() ${node.arguments[0].text}`)
    if (
      globals &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (['process', 'Bun', 'globalThis', 'crypto'].includes(node.expression.text) ||
        (node.expression.text === 'Date' && node.name.text === 'now') ||
        (node.expression.text === 'Math' && node.name.text === 'random'))
    )
      findings.push(`${node.expression.text}.${node.name.text}`)
    if (globals && ts.isIdentifier(node) && ['randomUUID', 'fetch'].includes(node.text))
      findings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

describe('RFC-504 ① 清单里的名字只在各自的新位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个名字只在它的新位置声明（同名类型钉在原处），改名前的四个名字没有声明（语料下限 3,000 / 2,500）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      const declaring = (name: string) =>
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter(
            (path) =>
              new RegExp(`\\b${name}\\b`).test(text(path)) &&
              declaredNames(path, text(path)).includes(name),
          )
          .map(corpusPath)
          .sort()
      const listed: [string, string][] = [
        ...Object.entries(NEW_FILES).flatMap(([location, { offered, internal }]) =>
          [...offered, ...internal].map((name): [string, string] => [location, name]),
        ),
        ...Object.entries(EXTENDED_FILES).flatMap(([location, names]) =>
          names.map((name): [string, string] => [location, name]),
        ),
      ]
      expect(listed).toHaveLength(17)
      for (const [location, name] of listed)
        expect([name, declaring(name)]).toEqual([
          name,
          [location, ...(HOMONYMS[name] ?? [])].map((at) => `packages/backend/src/${at}.ts`).sort(),
        ])
      for (const name of RETIRED) expect([name, declaring(name)]).toEqual([name, []])
    },
    CORPUS_TIMEOUT,
  )

  test('三个新文件恰好声明、交出清单列的名字；三个既有文件交出清单列的名字', () => {
    for (const [location, { offered, internal }] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...offered, ...internal].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...offered].sort(),
      ])
    }
    for (const [location, names] of Object.entries(EXTENDED_FILES)) {
      const path = sourceOf(location)
      const offered = offeredNames(path, text(path))
      expect([location, names.filter((name) => !offered.includes(name))]).toEqual([location, []])
    }
  })
})

describe('RFC-504 ② composition 只装配', () => {
  test('删除的组合文件不存在；四个组合文件没有控制流语句，各自从新位置取实现与转出', () => {
    for (const location of DELETED) {
      expect([location, existsSync(sourceOf(location))]).toEqual([location, false])
      expect([location, existsSync(join(SRC, `${location}.tsx`))]).toEqual([location, false])
    }
    for (const location of ASSEMBLY_ONLY) {
      const path = sourceOf(location)
      expect([location, controlFlow(path, text(path))]).toEqual([location, []])
      expect([location, edgesToLocations(moduleEdges(path, text(path)))]).toEqual([
        location,
        [...(TAKES[location] ?? [])],
      ])
    }
  })

  test(
    'resource-catalog 的 composition.ts 从新位置只转出内建工作流目录；三个工厂在生产代码里各只有一处调用、bootstrap 经装配入口取',
    () => {
      const composition = sourceOf(MODULE_COMPOSITION)
      expect(edgesToLocations(moduleEdges(composition, text(composition)))).toEqual(
        MODULE_REEXPORTS,
      )
      for (const [name, caller] of Object.entries(PRODUCTION_CALLERS))
        expect([name, productionCallers(name)]).toEqual([name, [`${caller} x1`]])
      for (const [bootstrap, edge] of Object.entries(BOOTSTRAP_TAKES)) {
        const path = sourceOf(bootstrap)
        expect([
          bootstrap,
          moduleEdges(path, text(path)).filter((candidate) =>
            Object.keys(PRODUCTION_CALLERS).some((name) => candidate.includes(name)),
          ),
        ]).toEqual([bootstrap, [edge]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('内建工作流目录仍在一笔资源目录事务里经工作流写入参与者建行，并在提交后广播', () => {
    const path = sourceOf(`${INFRA}/builtinWorkflowCatalog`)
    expect(callArguments(path, text(path), 'runResourceCatalogTransaction')).toHaveLength(1)
    expect(callArguments(path, text(path), 'createWorkflowMutationParticipant')).toEqual([
      ['transaction'],
    ])
    expect(callArguments(path, text(path), 'broadcastWorkflowCreated')).toEqual([
      ['workflowDetailOf(created)'],
    ])
  })

  test('负对照：控制流语句、别处与多余的转出、多余的调用都会被认出', () => {
    const probe = join(SRC, `${COMP}/probe.ts`)
    const source = [
      `import { createResourcePackageStagedExecution } from '../application/package/stagedExecution'`,
      `export { createWorkgroupTaskRoomActiveUsers } from '../application/workgroups/taskRoomCollaborators'`,
      `import { createMcpApplication } from '../application/mcps/mcpApplication'`,
      `export function pick(kind: string, ids: readonly string[]) {`,
      `  if (kind === 'mcp') return`,
      `  for (const id of ids) void id`,
      `  switch (kind) { default: break }`,
      `  try { void createMcpApplication } catch { throw new Error('x') }`,
      `}`,
      `createResourcePackageStagedExecution(a)`,
      `createResourcePackageStagedExecution(b)`,
      `export { createBuiltinWorkflowCatalog } from '../infrastructure/builtinWorkflowCatalog'`,
    ].join('\n')
    expect(moduleEdges(probe, source)).toEqual([
      `import ${APP}/package/stagedExecution: createResourcePackageStagedExecution`,
      `export ${APP}/workgroups/taskRoomCollaborators: createWorkgroupTaskRoomActiveUsers`,
      `import ${APP}/mcps/mcpApplication: createMcpApplication`,
      `export ${INFRA}/builtinWorkflowCatalog: createBuiltinWorkflowCatalog`,
    ])
    // The location filter keeps edges into the RFC-504 locations and ignores the file's other edges.
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${APP}/package/stagedExecution: createResourcePackageStagedExecution`,
      `export ${APP}/workgroups/taskRoomCollaborators: createWorkgroupTaskRoomActiveUsers`,
      `export ${INFRA}/builtinWorkflowCatalog: createBuiltinWorkflowCatalog`,
    ])
    expect(controlFlow(probe, source)).toEqual(['if', 'for-of', 'switch', 'try', 'throw'])
    expect(callArguments(probe, source, 'createResourcePackageStagedExecution')).toEqual([
      ['a'],
      ['b'],
    ])
  })
})

describe('RFC-504 ③ 没有文件从删除的位置取任何东西', () => {
  test(
    '全部生产文件、用例（语料下限 2,500）与 e2e',
    () => {
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      expect(
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter((path) => mentionsOldLocation(text(path)))
          .flatMap((path) => takenFromOldLocations(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都会被认出，新位置不算', () => {
    const file = join(SRC, `${COMP}/probe.ts`)
    const source = [
      `import { composeBuiltinWorkflowCatalog } from './builtinWorkflowCatalog'`,
      `import type { composeBuiltinWorkflowCatalog as Ensure } from '@/${COMP}/builtinWorkflowCatalog'`,
      `import catalog from '../composition/builtinWorkflowCatalog'`,
      `import './builtinWorkflowCatalog'`,
      `export { composeBuiltinWorkflowCatalog } from '@/${COMP}/builtinWorkflowCatalog'`,
      `export * from './builtinWorkflowCatalog'`,
      `import * as old from '@/${COMP}/builtinWorkflowCatalog'`,
      `const ensure = old.composeBuiltinWorkflowCatalog`,
      `const typed: typeof old.composeBuiltinWorkflowCatalog | undefined = undefined`,
      `const { composeBuiltinWorkflowCatalog: late } = await import('./builtinWorkflowCatalog')`,
      `import { createBuiltinWorkflowCatalog } from '../infrastructure/builtinWorkflowCatalog'`,
      `const moved = await import('@/${INFRA}/builtinWorkflowCatalog')`,
    ].join('\n')
    const label = corpusPath(file)
    expect(takenFromOldLocations(file, source)).toEqual(
      [
        `${COMP}/builtinWorkflowCatalog: composeBuiltinWorkflowCatalog`,
        `${COMP}/builtinWorkflowCatalog: composeBuiltinWorkflowCatalog`,
        `${COMP}/builtinWorkflowCatalog: default`,
        `${COMP}/builtinWorkflowCatalog: <side effect>`,
        `${COMP}/builtinWorkflowCatalog: composeBuiltinWorkflowCatalog`,
        `${COMP}/builtinWorkflowCatalog: *`,
        `${COMP}/builtinWorkflowCatalog: composeBuiltinWorkflowCatalog`,
        `${COMP}/builtinWorkflowCatalog: composeBuiltinWorkflowCatalog`,
        `${COMP}/builtinWorkflowCatalog: composeBuiltinWorkflowCatalog`,
        `${COMP}/builtinWorkflowCatalog: import()`,
      ].map((what) => `${label} -> ${what}`),
    )
  })
})

describe('RFC-504 ④ 新代码的依赖面是闭集、不用进程全局', () => {
  test('application 的四个文件只取 shared、@/auth/actor、@/util/errors、@/util/hash、identity-access 的 public/participants 与本模块 domain / application / public；infrastructure 的两个文件不取 composition', () => {
    for (const location of APPLICATION_FILES) {
      const path = sourceOf(location)
      expect([location, purityFindings(path, text(path), APPLICATION_SURFACE, true)]).toEqual([
        location,
        [],
      ])
    }
    for (const location of INFRASTRUCTURE_FILES) {
      const path = sourceOf(location)
      expect([location, purityFindings(path, text(path), NOT_COMPOSITION, false)]).toEqual([
        location,
        [],
      ])
    }
  })

  test('负对照：越界 import、取 composition 与进程全局都会被认出', () => {
    const file = join(SRC, `${APP}/package/probe.ts`)
    const source = [
      `import type { Actor } from '@/auth/actor'`,
      `import type { CommandContext } from '@/modules/identity-access/public/participants'`,
      `import { sha256Hex } from '@/util/hash'`,
      `import { ConflictError } from '@/util/errors'`,
      `import { canonicalJson } from '@agent-workflow/shared'`,
      `import type { ResourcePackageExecutionPort } from './ports'`,
      `import { PACKAGE_RESOURCE_KINDS } from '../../domain/resourceKinds'`,
      `import type { PackageResourceRef } from '../../public/types'`,
      `import { ulid } from 'ulid'`,
      `import { runResourceCatalogTransaction } from '../../infrastructure/resourceCatalogTransaction'`,
      `import { composeResourcePackageOperations } from '../../composition/resourcePackageOperations'`,
      `import type { UserDirectory } from '@/modules/identity-access/application/users'`,
      `import { readFileSync } from 'node:fs'`,
      `export async function run() { await import('node:path'); const at = Date.now(); const env = process.env; await fetch('x'); Math.random(); randomUUID() }`,
    ].join('\n')
    expect(purityFindings(file, source, APPLICATION_SURFACE, true)).toEqual([
      'import ulid',
      'import ../../infrastructure/resourceCatalogTransaction',
      'import ../../composition/resourcePackageOperations',
      'import @/modules/identity-access/application/users',
      'import node:fs',
      'import() node:path',
      'Date.now',
      'process.env',
      'fetch',
      'Math.random',
      'randomUUID',
    ])
    const infra = join(SRC, `${INFRA}/probe.ts`)
    const infraSource = [
      `import { tablesOf } from '@/platform/persistence/sessionTables'`,
      `import { and } from 'drizzle-orm'`,
      `import { createWorkflowMutationParticipant } from './workflowMutationParticipant'`,
      `import { composeMcpCatalog } from '../composition/mcpOperations'`,
      `import { createResourceCatalogMaintenanceJobHandlers } from '@/modules/resource-catalog/composition'`,
      `import { composeWorkgroupTaskRoomTaskParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'`,
      `export const now = () => Date.now()`,
    ].join('\n')
    expect(purityFindings(infra, infraSource, NOT_COMPOSITION, false)).toEqual([
      'import ../composition/mcpOperations',
      'import @/modules/resource-catalog/composition',
      'import @/modules/task-execution/composition/workgroupTaskRoomTask',
    ])
  })
})
