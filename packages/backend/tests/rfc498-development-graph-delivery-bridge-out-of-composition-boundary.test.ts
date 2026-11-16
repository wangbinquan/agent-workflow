// RFC-498 — 开发自动化的图交付桥用例迁出 composition（RFC-294 S10 第五步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件里只在 `application/graph-development/deliveryBridge.ts` 声明；新文件只声明清单的名字、只交出其中两个。
// ② `composition/graphDeliveryBridge.ts` 不存在；`graphDevelopment.ts` 从新文件取 `createGraphDeliveryBridge`、恰好调用一次，字段恰好是
//    原来的 10 个加 `now: Date.now`；用例的时钟是必填输入（带负对照）。
// ③ 全部生产文件、用例与 e2e 不从旧位置取任何东西：命名 import、type-only、默认与副作用 import、re-export、命名空间成员与动态 import
//    都认，带负对照。
// ④ 新文件的依赖面是闭集：只取 shared、source-control 的 `public/types`、`@/util/gitRef` 与本模块 domain / application；开作用域恰好
//    一处、用 `withSelectedAutomationWorkspaceEffects`，不再出现 `withAutomationWorkspaceEffects`；不用进程全局（带负对照）。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ④ 读 `graphDevelopment.ts` 与新文件。
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

const DA = 'modules/development-automation'
const OLD = `${DA}/composition/graphDeliveryBridge`
const BRIDGE = `${DA}/application/graph-development/deliveryBridge`
const GRAPH_DEVELOPMENT = `${DA}/composition/graphDevelopment`

/** design §3: the names the new file declares — two offered, the rest private to it. */
const OFFERED = ['GraphMrHandoffResult', 'createGraphDeliveryBridge']
const PRIVATE = [
  'Candidate',
  'GraphMrDeliveryInput',
  'PublishedGraphCandidate',
  'GraphPublishedInput',
  'deliveryIssue',
  'publicationIdentity',
]
/** design D3: what `graphDevelopment.ts` hands the use case, in source order. */
const ASSEMBLY_FIELDS = [
  'appHome: input.appHome',
  'factory: input.workspace.factory',
  'sourceControl: input.workspace.sourceControl',
  'candidates: input.candidates',
  'workspacePersistence: createEmployeeWorkspacePersistence(input.db)',
  'platformPersistence: createEmployeePlatformWorkItemPersistence(input.db)',
  'store',
  'commands',
  'execution',
  'verification',
  'now: Date.now',
]
const mentionsOldLocation = (source: string) => /graphDeliveryBridge/.test(source)
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

/** Every call of `name` in the file, as parsed nodes. */
function callsOf(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}
/** `name: initializer` (whitespace removed) for each property of an object literal; spreads as `...expression`. */
function literalShape(file: ts.SourceFile, node: ts.Expression | undefined): string[] {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return ['<not an object literal>']
  return node.properties.map((property) =>
    ts.isSpreadAssignment(property)
      ? `...${property.expression.getText(file)}`
      : ts.isPropertyAssignment(property)
        ? `${property.name.getText(file)}: ${property.initializer.getText(file).replace(/\s+/g, '')}`
        : property.getText(file),
  )
}
/** Where the file's static imports of `name` come from (resolved under `src`; packages as written). */
function importedFrom(file: string, source: string, name: string): string[] {
  const from: string[] = []
  for (const statement of parse(file, source).statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => element.name.text === name)
    )
      from.push(
        resolveSpecifier(file, statement.moduleSpecifier.text) ?? statement.moduleSpecifier.text,
      )
  }
  return from
}
/** The first parameter's type-literal member `member` of the top-level function `fn`: optional or not, null when absent. */
function parameterMemberOptional(
  path: string,
  source: string,
  fn: string,
  member: string,
): boolean | null {
  const declaration = parse(path, source).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
  )
  const type = declaration?.parameters[0]?.type
  const found =
    type !== undefined && ts.isTypeLiteralNode(type)
      ? type.members.find((candidate) => candidate.name?.getText() === member)
      : undefined
  return found === undefined ? null : found.questionToken !== undefined
}
/** The first statement of the top-level function `fn`, whitespace collapsed. */
function firstStatementOf(path: string, source: string, fn: string): string | null {
  const file = parse(path, source)
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
  )
  const first = declaration?.body?.statements[0]
  return first === undefined ? null : first.getText(file).replace(/\s+/g, ' ')
}
/** How many identifiers named `name` the file has (declarations, calls and references alike). */
function identifierCount(path: string, source: string, name: string): number {
  let count = 0
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) count++
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return count
}

/**
 * `file -> old location: what` for everything a file still takes from the deleted file (design §4 ③): named import,
 * type-only, default and side-effect import, `export … from` and `export * from`, members of a namespace import (value
 * and type positions), and dynamic `import()` with its destructured names; specifiers resolve from the file.
 */
function takenFromOldLocation(file: string, source: string): string[] {
  const out: string[] = []
  const label = slash(relative(REPO, file))
  const fromOld = (specifier: string) => resolveSpecifier(file, specifier) === OLD
  const flag = (what: string) => out.push(`${label} -> ${OLD}: ${what}`)
  const namespaces = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      fromOld(node.moduleSpecifier.text)
    ) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        if (clause === undefined) flag('<side effect>')
        if (clause?.name !== undefined) flag('default')
        const bindings = clause?.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements) flag((element.propertyName ?? element.name).text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          namespaces.add(bindings.name.text)
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          flag((element.propertyName ?? element.name).text)
      else flag('*')
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      fromOld(node.arguments[0].text)
    )
      flag('import()')
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
        ts.isStringLiteral(call.arguments[0]) &&
        fromOld(call.arguments[0].text)
      )
        for (const element of node.name.elements)
          flag((element.propertyName ?? element.name).getText())
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      flag(node.name.text)
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && namespaces.has(node.left.text))
      flag(node.right.text)
    ts.forEachChild(node, visit)
  }
  // Namespace imports are statements at the top, so one pass sees the binding before its members.
  visit(parse(file, source))
  return out
}

const isShared = (specifier: string) =>
  specifier === '@agent-workflow/shared' || specifier.startsWith('@agent-workflow/shared/')
/** The closed dependency surface of the new file (design §4 ④). */
const SURFACE = (file: string, specifier: string): boolean => {
  if (['@/modules/source-control/public/types', '@/util/gitRef'].includes(specifier)) return true
  if (isShared(specifier)) return true
  const rel = resolveSpecifier(file, specifier)
  return (
    rel !== null && ['domain', 'application'].some((layer) => rel.startsWith(`${DA}/${layer}/`))
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
      (['process', 'Bun', 'globalThis'].includes(node.expression.text) ||
        (node.expression.text === 'Date' && node.name.text === 'now'))
    )
      findings.push(`${node.expression.text}.${node.name.text}`)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetch'
    )
      findings.push('fetch()')
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

describe('RFC-498 ① 清单里的名字只在新文件声明', () => {
  test(
    '全部生产文件里每个名字只在新文件声明（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const name of [...OFFERED, ...PRIVATE]) {
        const declaring = PRODUCTION.filter(
          (path) =>
            new RegExp(`\\b${name}\\b`).test(text(path)) &&
            declaredNames(path, text(path)).includes(name),
        )
          .map(srcPath)
          .sort()
        expect([name, declaring]).toEqual([name, [BRIDGE]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('新文件只声明清单的名字、只交出其中两个', () => {
    const path = sourceOf(BRIDGE)
    expect(declaredNames(path, text(path)).sort()).toEqual([...OFFERED, ...PRIVATE].sort())
    expect(offeredNames(path, text(path)).sort()).toEqual([...OFFERED].sort())
  })
})

describe('RFC-498 ② composition 不再有这个文件，装配直接取 application 的用例', () => {
  const graphPath = sourceOf(GRAPH_DEVELOPMENT)
  const bridgePath = sourceOf(BRIDGE)

  test('旧文件不存在；graphDevelopment.ts 从新文件取用例、恰好调用一次，字段是原来的 10 个加默认时钟', () => {
    expect(existsSync(sourceOf(OLD))).toBe(false)
    expect(existsSync(join(SRC, `${OLD}.tsx`))).toBe(false)
    expect(importedFrom(graphPath, text(graphPath), 'createGraphDeliveryBridge')).toEqual([BRIDGE])
    const file = parse(graphPath, text(graphPath))
    const calls = callsOf(file, 'createGraphDeliveryBridge')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.arguments).toHaveLength(1)
    expect(literalShape(file, calls[0]!.arguments[0])).toEqual(ASSEMBLY_FIELDS)
  })

  test('用例的时钟是必填输入，开头直接取它', () => {
    expect(
      parameterMemberOptional(bridgePath, text(bridgePath), 'createGraphDeliveryBridge', 'now'),
    ).toBe(false)
    expect(firstStatementOf(bridgePath, text(bridgePath), 'createGraphDeliveryBridge')).toBe(
      'const now = deps.now',
    )
  })

  test('负对照：可选或缺少的时钟、多传少传或换了次序、取自旧位置的 import 都会被认出', () => {
    const probe = join(SRC, `${DA}/composition/probe.ts`)
    const source = [
      `import { createGraphDeliveryBridge } from './graphDeliveryBridge'`,
      `import { createGraphDeliveryBridge as other } from '../application/graph-development/deliveryBridge'`,
      `export function createGraphDeliveryBridge(deps: { readonly now?: () => number }) { const now = deps.now ?? Date.now }`,
      `export function withoutClock(deps: { readonly appHome: string }) {}`,
      `createGraphDeliveryBridge({ factory: input.workspace.factory, appHome: input.appHome, extra: 1 })`,
    ].join('\n')
    expect(importedFrom(probe, source, 'createGraphDeliveryBridge')).toEqual([OLD])
    expect(parameterMemberOptional(probe, source, 'createGraphDeliveryBridge', 'now')).toBe(true)
    expect(parameterMemberOptional(probe, source, 'withoutClock', 'now')).toBeNull()
    expect(firstStatementOf(probe, source, 'createGraphDeliveryBridge')).toBe(
      'const now = deps.now ?? Date.now',
    )
    const file = parse(probe, source)
    expect(literalShape(file, callsOf(file, 'createGraphDeliveryBridge')[0]!.arguments[0])).toEqual(
      ['factory: input.workspace.factory', 'appHome: input.appHome', 'extra: 1'],
    )
    expect(literalShape(file, undefined)).toEqual(['<not an object literal>'])
  })
})

describe('RFC-498 ③ 没有文件从旧位置取任何东西', () => {
  test(
    '全部生产文件、用例（语料下限 2,500）与 e2e',
    () => {
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      expect(
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter((path) => mentionsOldLocation(text(path)))
          .flatMap((path) => takenFromOldLocation(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都会被认出，新位置不算', () => {
    const file = join(SRC, `${DA}/composition/probe.ts`)
    const source = [
      `import { createGraphDeliveryBridge } from './graphDeliveryBridge'`,
      `import type { GraphMrHandoffResult } from '@/${OLD}'`,
      `import bridge from '../composition/graphDeliveryBridge'`,
      `import './graphDeliveryBridge'`,
      `export { deliveryIssue } from '@/${OLD}'`,
      `export * from './graphDeliveryBridge'`,
      `import * as old from '@/${OLD}'`,
      `const create = old.createGraphDeliveryBridge`,
      `const result: old.GraphMrHandoffResult | undefined = undefined`,
      `const { publicationIdentity } = await import('./graphDeliveryBridge')`,
      `import { createGraphDeliveryBridge as moved, type GraphMrHandoffResult as Moved } from '@/${BRIDGE}'`,
      `const later = await import('@/${BRIDGE}')`,
    ].join('\n')
    const label = slash(relative(REPO, file))
    expect(takenFromOldLocation(file, source)).toEqual(
      [
        'createGraphDeliveryBridge',
        'GraphMrHandoffResult',
        'default',
        '<side effect>',
        'deliveryIssue',
        '*',
        'createGraphDeliveryBridge',
        'GraphMrHandoffResult',
        'publicationIdentity',
        'import()',
      ].map((what) => `${label} -> ${OLD}: ${what}`),
    )
  })
})

describe('RFC-498 ④ 新文件的依赖面是闭集、开作用域用选定的工厂、不用进程全局', () => {
  const bridgePath = sourceOf(BRIDGE)

  test('只取 shared、source-control 的 public/types、@/util/gitRef 与本模块 domain / application', () => {
    expect(purityFindings(bridgePath, text(bridgePath), SURFACE)).toEqual([])
  })

  test('开作用域恰好一处、用 withSelectedAutomationWorkspaceEffects，不再出现 withAutomationWorkspaceEffects', () => {
    const file = parse(bridgePath, text(bridgePath))
    expect(callsOf(file, 'withSelectedAutomationWorkspaceEffects')).toHaveLength(1)
    expect(identifierCount(bridgePath, text(bridgePath), 'withAutomationWorkspaceEffects')).toBe(0)
  })

  test('负对照：越界 import、旧的开作用域与进程全局都会被认出', () => {
    const file = join(SRC, `${DA}/application/graph-development/probe.ts`)
    const source = [
      `import { canonicalJson } from '@agent-workflow/shared'`,
      `import type { ChangeCandidateParticipant } from '@/modules/source-control/public/types'`,
      `import { stableGitRefComponent } from '@/util/gitRef'`,
      `import { createGraphMrCare } from './mrCare'`,
      `import type { GraphDesignStore } from '../ports/graphDesignStore'`,
      `import { graphDigest } from '../../domain/graph-development/model'`,
      `import { withSelectedAutomationWorkspaceEffects } from '../automationWorkspaceEffectLifetime'`,
      `import { withAutomationWorkspaceEffects } from '../../infrastructure/automationWorkspaceEffects'`,
      `import { createGraphDevelopment } from '../../composition/graphDevelopment'`,
      `import { evaluatePolicy } from '../../engine/policy/evaluatePolicy'`,
      `import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'`,
      `import { readFileSync } from 'node:fs'`,
      `export async function run() { await import('node:path'); const at = Date.now(); process.exit(at); await fetch('x'); await withAutomationWorkspaceEffects(f, b) }`,
      `const at = new Date(0).toISOString()`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE)).toEqual([
      'import ../../infrastructure/automationWorkspaceEffects',
      'import ../../composition/graphDevelopment',
      'import ../../engine/policy/evaluatePolicy',
      'import @/modules/source-control/public/participants',
      'import node:fs',
      'import() node:path',
      'Date.now',
      'process.exit',
      'fetch()',
    ])
    expect(identifierCount(file, source, 'withAutomationWorkspaceEffects')).toBe(2)
    expect(callsOf(parse(file, source), 'withSelectedAutomationWorkspaceEffects')).toHaveLength(0)
  })
})
