// RFC-502 — 集成的开发适配器配置、代码托管交付、审批网关与工具连接目录迁出 composition（RFC-294 S10 第九步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里交出的名字与端口接口在全部生产文件、用例与 e2e 里只在各自的新文件声明（`identityView` 另有 development-automation 的那一份，
//    逐个钉住）；改名前的四个 `compose…` 名字没有声明；每个新文件恰好声明、交出清单列的名字。
// ② 四个组合文件只声明、交出允许的装配入口，没有 if / for / while / do / switch / try / throw 语句；各自从新文件取工厂；
//    `approvalGateway.ts` 恰好调用投影两次（两条装配各一次）；工具连接 store 从端口文件取接口、自己不声明不转出；bootstrap 从四个组合
//    文件取装配入口照旧（带负对照）。
// ③ 全部生产文件、用例与 e2e 从四个组合文件只取允许的装配入口：命名 import、type-only、默认与副作用 import、re-export、命名空间成员与
//    动态 import 都认，带负对照。
// ④ 新文件的依赖面是闭集：只取 shared、`@/platform/errors/domainErrors`、`@/platform/contracts/hash`、`@/auth/actor`、resource-catalog 的 `public/queries` 与本模块
//    domain / application；不取 infrastructure、composition、IO 包，不用进程全局（带负对照）。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ④ 读四个组合文件、工具连接 store、bootstrap 的三个文件与新文件。
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

const INT = 'modules/integration'
const APP = `${INT}/application`
const COMP = `${INT}/composition`
const STORE = `${INT}/infrastructure/developmentToolConnectionStore`
const PORT = `${APP}/ports/developmentToolConnectionStore`

/** design §3: each new file, the names it declares and offers, and the names it declares without offering. */
const NEW_FILES: Readonly<
  Record<string, { readonly offered: readonly string[]; readonly internal: readonly string[] }>
> = {
  [`${APP}/developmentAdapterConfigOperations`]: {
    offered: [
      'DevelopmentAdapterAccess',
      'DevelopmentAdapterGrantReads',
      'DevelopmentAdapterConfigOperationsDeps',
      'createDevelopmentAdapterConfigOperations',
      'DevelopmentAdapterConfigOperations',
    ],
    internal: [
      'AdapterCreateInput',
      'AdapterReviseInput',
      'identityView',
      'DevelopmentAdapterAccessRow',
    ],
  },
  [`${APP}/developmentCodeHostDelivery`]: {
    offered: [
      'RepoCodeHostBindingResolver',
      'DevelopmentMrEffects',
      'createDevelopmentMrEffects',
      'DevelopmentCodeHostConnections',
      'createDevelopmentCodeHostBinding',
      'createDevelopmentMrFactsSource',
      'createRepositoryCodeHostClaimKeys',
    ],
    internal: [],
  },
  [`${APP}/developmentApprovalGateway`]: {
    offered: ['createDevelopmentApprovalGateway'],
    internal: [],
  },
  [`${APP}/developmentToolConnectionCatalog`]: {
    offered: ['createDevelopmentToolConnectionCatalog'],
    internal: [],
  },
  [PORT]: { offered: ['DevelopmentToolConnectionStore'], internal: [] },
}
/** Declarations that share a moved name and predate RFC-502, pinned one by one. */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  identityView: ['modules/development-automation/application/configOperationHandlers'],
}
/** design §3: the assembly entry points each composition file still declares and offers. */
const KEPT: Readonly<Record<string, readonly string[]>> = {
  [`${COMP}/developmentAdapterConfigOperations`]: [
    'DevelopmentAdapterConfigCompositionInput',
    'composeDevelopmentAdapterConfigOperationsFor',
  ],
  [`${COMP}/codeHostEffects`]: ['composeDevelopmentCodeHostDelivery'],
  [`${COMP}/approvalGateway`]: [
    'composeApprovalGatewayRunnerFor',
    'composeSelectedApprovalGatewayRunnerFor',
  ],
  [`${COMP}/digitalEmployeeToolConnections`]: ['composeDevelopmentToolConnectionCatalog'],
}
/** The import each composition file takes its factory through (design D3). */
const TAKES: Readonly<Record<string, string>> = {
  [`${COMP}/developmentAdapterConfigOperations`]: `import ${APP}/developmentAdapterConfigOperations: createDevelopmentAdapterConfigOperations, DevelopmentAdapterAccess, DevelopmentAdapterGrantReads`,
  [`${COMP}/codeHostEffects`]: `import ${APP}/developmentCodeHostDelivery: createDevelopmentCodeHostBinding, createDevelopmentMrEffects, createDevelopmentMrFactsSource, createRepositoryCodeHostClaimKeys`,
  [`${COMP}/approvalGateway`]: `import ${APP}/developmentApprovalGateway: createDevelopmentApprovalGateway`,
  [`${COMP}/digitalEmployeeToolConnections`]: `import ${APP}/developmentToolConnectionCatalog: createDevelopmentToolConnectionCatalog`,
}
const RETIRED = [
  'composeDevelopmentMrEffects',
  'composeDevelopmentCodeHostBinding',
  'composeDevelopmentMrFactsSource',
  'composeRepositoryCodeHostClaimKeys',
]
/** Bootstrap takes the same entry points from the four composition files as before (design D3). */
const BOOTSTRAP_EDGES: Readonly<Record<string, readonly string[]>> = {
  'bootstrap/daemonModules/resourceCatalog': [
    `import ${COMP}/developmentAdapterConfigOperations: composeDevelopmentAdapterConfigOperationsFor`,
  ],
  'bootstrap/daemonModules/repositoryCredentials': [
    `import ${COMP}/codeHostEffects: composeDevelopmentCodeHostDelivery`,
  ],
  'bootstrap/daemonModules/integration': [
    `import ${COMP}/approvalGateway: composeSelectedApprovalGatewayRunnerFor`,
    `import ${COMP}/digitalEmployeeToolConnections: composeDevelopmentToolConnectionCatalog`,
  ],
}
const mentionsOldLocation = (source: string) =>
  /developmentAdapterConfigOperations|codeHostEffects|approvalGateway|digitalEmployeeToolConnections/.test(
    source,
  )
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

/**
 * `file -> composition file: what` for everything a file takes from the four composition files beyond their entry points
 * (design §4 ③): named import, type-only, default and side-effect import, `export … from` and `export * from`, members of a
 * namespace import (value and type positions), and dynamic `import()` with its destructured names; specifiers resolve from
 * the file.
 */
function takenBeyondEntryPoints(file: string, source: string): string[] {
  const out: string[] = []
  const label = corpusPath(file)
  const location = (specifier: string) => {
    const resolved = resolveSpecifier(file, specifier)
    return resolved !== null && resolved in KEPT ? resolved : null
  }
  const flag = (from: string, what: string) => {
    if (!KEPT[from]!.includes(what)) out.push(`${label} -> ${from}: ${what}`)
  }
  const namespaces = new Map<string, string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const from = location(node.moduleSpecifier.text)
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
      const from = location(node.arguments[0].text)
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
        const from = location(call.arguments[0].text)
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

const isShared = (specifier: string) =>
  specifier === '@agent-workflow/shared' || specifier.startsWith('@agent-workflow/shared/')
/** The closed dependency surface of the new files (design §4 ④). */
const SURFACE = (file: string, specifier: string): boolean => {
  if (
    [
      '@/platform/errors/domainErrors',
      '@/platform/contracts/hash',
      '@/auth/actor',
      '@/modules/resource-catalog/public/queries',
    ].includes(specifier)
  )
    return true
  if (isShared(specifier)) return true
  const rel = resolveSpecifier(file, specifier)
  return (
    rel !== null && ['domain', 'application'].some((layer) => rel.startsWith(`${INT}/${layer}/`))
  )
}

/** Imports outside the surface and process globals, read from the syntax tree. */
function purityFindings(
  file: string,
  source: string,
  allowed: (file: string, specifier: string) => boolean,
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
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (['process', 'Bun', 'globalThis', 'crypto'].includes(node.expression.text) ||
        (node.expression.text === 'Date' && node.name.text === 'now') ||
        (node.expression.text === 'Math' && node.name.text === 'random'))
    )
      findings.push(`${node.expression.text}.${node.name.text}`)
    if (ts.isIdentifier(node) && ['randomUUID', 'fetch'].includes(node.text))
      findings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

describe('RFC-502 ① 清单里的名字只在各自的新文件声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个名字只在它的新文件声明，改名前的四个名字没有声明（语料下限 3,000 / 2,500）',
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
      for (const [location, { offered, internal }] of Object.entries(NEW_FILES))
        for (const name of [...offered, ...internal])
          expect([name, declaring(name)]).toEqual([
            name,
            [location, ...(HOMONYMS[name] ?? [])]
              .map((at) => `packages/backend/src/${at}.ts`)
              .sort(),
          ])
      for (const name of RETIRED) expect([name, declaring(name)]).toEqual([name, []])
    },
    CORPUS_TIMEOUT,
  )

  test('每个新文件恰好声明、交出清单列的名字', () => {
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
  })
})

describe('RFC-502 ② composition 只装配', () => {
  test('四个组合文件只声明、交出装配入口，没有控制流语句，各自从新文件取工厂', () => {
    for (const [location, kept] of Object.entries(KEPT)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...kept].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...kept].sort(),
      ])
      expect([location, controlFlow(path, text(path))]).toEqual([location, []])
      expect(moduleEdges(path, text(path))).toContain(TAKES[location]!)
    }
  })

  test('审批的两条装配各把自己的执行适配器交给同一份投影', () => {
    const path = sourceOf(`${COMP}/approvalGateway`)
    const calls = callArguments(path, text(path), 'createDevelopmentApprovalGateway')
    expect(calls).toHaveLength(2)
    expect(calls.map((args) => [args.length, args[0]!.split('(')[0]])).toEqual([
      [1, 'createApprovalExecutionAdapter'],
      [1, 'createSelectedApprovalExecutionAdapter'],
    ])
  })

  test('工具连接 store 从端口文件取接口，自己不声明不转出', () => {
    const path = sourceOf(STORE)
    expect(declaredNames(path, text(path))).not.toContain('DevelopmentToolConnectionStore')
    expect(offeredNames(path, text(path))).not.toContain('DevelopmentToolConnectionStore')
    expect(moduleEdges(path, text(path))).toContain(
      `import ${PORT}: DevelopmentToolConnectionStore`,
    )
  })

  test('bootstrap 从四个组合文件取的装配入口照旧', () => {
    for (const [location, expected] of Object.entries(BOOTSTRAP_EDGES)) {
      const path = sourceOf(location)
      expect([
        location,
        moduleEdges(path, text(path)).filter((edge) =>
          Object.keys(KEPT).some((kept) => edge.startsWith(`import ${kept}: `)),
        ),
      ]).toEqual([location, [...expected]])
    }
  })

  test('负对照：控制流语句、多出的声明与别处取来的工厂都会被认出', () => {
    const probe = join(SRC, `${COMP}/probe.ts`)
    const source = [
      `import { createDevelopmentMrEffects } from '../application/developmentCodeHostDelivery'`,
      `import { createDevelopmentMrEffects as old } from './codeHostEffects'`,
      `function gateway() { return old }`,
      `export const catalog = 1`,
      `export function composeProbe(a: number, b: number[], o: object) {`,
      `  if (a) a++`,
      `  for (let i = 0; i < a; i++) a--`,
      `  for (const x of b) a += x`,
      `  for (const k in o) a += k.length`,
      `  while (a > 0) a--`,
      `  do a++; while (a < 0)`,
      `  switch (a) { default: break }`,
      `  try { a++ } catch { a-- }`,
      `  const kept = a > 0 ? a : (b[0] ?? 0) && a`,
      `  throw new Error(String(kept))`,
      `}`,
    ].join('\n')
    expect(controlFlow(probe, source)).toEqual([
      'if',
      'for',
      'for-of',
      'for-in',
      'while',
      'do',
      'switch',
      'try',
      'throw',
    ])
    expect(declaredNames(probe, source)).toEqual(['gateway', 'catalog', 'composeProbe'])
    expect(offeredNames(probe, source)).toEqual(['catalog', 'composeProbe'])
    expect(moduleEdges(probe, source)).toEqual([
      `import ${APP}/developmentCodeHostDelivery: createDevelopmentMrEffects`,
      `import ${COMP}/codeHostEffects: createDevelopmentMrEffects`,
    ])
    expect(
      callArguments(
        probe,
        'createDevelopmentApprovalGateway(x(1), y)',
        'createDevelopmentApprovalGateway',
      ),
    ).toEqual([['x(1)', 'y']])
  })
})

describe('RFC-502 ③ 从四个组合文件只取装配入口', () => {
  test(
    '全部生产文件、用例（语料下限 2,500）与 e2e',
    () => {
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      expect(
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter((path) => mentionsOldLocation(text(path)))
          .flatMap((path) => takenBeyondEntryPoints(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都会被认出，入口与新位置不算', () => {
    const file = join(SRC, `${COMP}/probe.ts`)
    const source = [
      `import { composeDevelopmentToolConnectionCatalog } from './digitalEmployeeToolConnections'`,
      `import { createDevelopmentMrEffects } from './codeHostEffects'`,
      `import type { DevelopmentAdapterAccess } from '@/${COMP}/developmentAdapterConfigOperations'`,
      `import gatewayDefault from '../composition/approvalGateway'`,
      `import './approvalGateway'`,
      `export { composeDevelopmentCodeHostDelivery } from './codeHostEffects'`,
      `export * from './codeHostEffects'`,
      `import * as tools from './digitalEmployeeToolConnections'`,
      `const entry = tools.composeDevelopmentToolConnectionCatalog`,
      `const inner: typeof tools.catalog | undefined = undefined`,
      `const { gateway: g } = await import('./approvalGateway')`,
      `import { createDevelopmentApprovalGateway } from '@/${APP}/developmentApprovalGateway'`,
      `const later = await import('@/${APP}/developmentToolConnectionCatalog')`,
    ].join('\n')
    const label = corpusPath(file)
    expect(takenBeyondEntryPoints(file, source)).toEqual(
      [
        `${COMP}/codeHostEffects: createDevelopmentMrEffects`,
        `${COMP}/developmentAdapterConfigOperations: DevelopmentAdapterAccess`,
        `${COMP}/approvalGateway: default`,
        `${COMP}/approvalGateway: <side effect>`,
        `${COMP}/codeHostEffects: *`,
        `${COMP}/digitalEmployeeToolConnections: catalog`,
        `${COMP}/approvalGateway: gateway`,
        `${COMP}/approvalGateway: import()`,
      ].map((what) => `${label} -> ${what}`),
    )
  })
})

describe('RFC-502 ④ 新文件的依赖面是闭集、不用进程全局', () => {
  test('只取 shared、@/platform/errors/domainErrors、@/platform/contracts/hash、@/auth/actor、resource-catalog 的 public/queries 与本模块 domain / application', () => {
    for (const location of Object.keys(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, purityFindings(path, text(path), SURFACE)]).toEqual([location, []])
    }
  })

  test('负对照：越界 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${APP}/probe.ts`)
    const source = [
      `import type { ResourceAccess } from '@agent-workflow/shared'`,
      `import { ValidationError } from '@/platform/errors/domainErrors'`,
      `import { sha256Hex } from '@/platform/contracts/hash'`,
      `import type { Actor } from '@/auth/actor'`,
      `import { isVisibleToAudienceSnapshot } from '@/modules/resource-catalog/public/queries'`,
      `import { ensureMergeRequest } from './mrEnsure'`,
      `import { matchRepoProvider } from '../domain/repositoryProviderMatch'`,
      `import { createDevelopmentAdapterStore } from '../infrastructure/developmentAdapterStore'`,
      `import { composeDevelopmentCodeHostDelivery } from '../composition/codeHostEffects'`,
      `import type { ResourceRef } from '@/modules/resource-catalog/public/types'`,
      `import type { PersistenceDb } from '@/platform/persistence/persistenceDb'`,
      `import { readFileSync } from 'node:fs'`,
      `export async function run() { await import('node:path'); const at = Date.now(); const env = process.env; await fetch('x'); Math.random() }`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE)).toEqual([
      'import ../infrastructure/developmentAdapterStore',
      'import ../composition/codeHostEffects',
      'import @/modules/resource-catalog/public/types',
      'import @/platform/persistence/persistenceDb',
      'import node:fs',
      'import() node:path',
      'Date.now',
      'process.env',
      'fetch',
      'Math.random',
    ])
  })
})
