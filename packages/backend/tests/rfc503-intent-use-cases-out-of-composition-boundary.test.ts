// RFC-503 — 意图的平台清单、图校验与维护命令迁出 composition（RFC-294 S10 第十步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的新文件声明（`optionalText` 另有 identity-access 的那一份，钉住）；改名前的三个名字
//    没有声明；每个新文件恰好声明、交出清单列的名字。
// ② `composition/platformInventory.ts` 与 `composition/graphValidation.ts` 不存在；`maintenance.ts` 与 `dispatch.ts` 没有 if / for / while / do /
//    switch / try / throw 语句，`maintenance.ts` 从新文件取工厂；intent 的 `composition.ts` 从新文件转出两个工厂，bootstrap 只经它取、各调用
//    一次（带负对照）。
// ③ 全部生产文件、用例与 e2e 不从两个删除的位置取任何东西：命名 import、type-only、默认与副作用 import、re-export、命名空间成员与动态
//    import 都认，带负对照。
// ④ 新文件的依赖面是闭集：只取 `@/auth/actor`、两个外域（identity-access、resource-catalog）的 `public` 类型入口与本模块
//    domain / application / public；不取 infrastructure、composition、IO 包，不用进程全局（带负对照）。RFC-561 起不含
//    development-automation 与 digital-employee 的 public：平台清单改用 Intent 自己的端口点名这两个来源。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ④ 读 `maintenance.ts`、`dispatch.ts`、intent 的 `composition.ts`、bootstrap 的 `daemonModules/intent.ts` 与新文件。
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

const IN = 'modules/intent'
const APP = `${IN}/application`
const COMP = `${IN}/composition`
/** `composition.ts` itself (the same path without the directory suffix). */
const MODULE_COMPOSITION = COMP
const BOOTSTRAP = 'bootstrap/daemonModules/intent'
const DELETED = [`${COMP}/platformInventory`, `${COMP}/graphValidation`]
const ASSEMBLY_ONLY = [`${COMP}/maintenance`, `${COMP}/dispatch`]

/** design §3: each new file, the names it declares and offers, and the names it declares without offering. */
const NEW_FILES: Readonly<
  Record<string, { readonly offered: readonly string[]; readonly internal: readonly string[] }>
> = {
  [`${APP}/platformInventoryParticipant`]: {
    offered: [
      'IntentCapabilityTemplateInventoryQueries',
      'IntentPlatformInventoryParticipantDependencies',
      'createIntentPlatformInventoryParticipant',
    ],
    internal: ['publishState', 'optionalText', 'sortRows', 'developmentRows'],
  },
  [`${APP}/workflowGraphValidationProvider`]: {
    offered: ['createIntentWorkflowGraphValidation'],
    internal: [],
  },
  [`${APP}/maintenanceCommands`]: {
    offered: [
      'IntentMaintenanceLog',
      'IntentMaintenanceCommandDependencies',
      'createIntentMaintenanceCommands',
    ],
    internal: [],
  },
}
/** Declarations that share a moved name and predate RFC-503, pinned one by one. */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  optionalText: ['modules/identity-access/infrastructure/crewstation/crewStationIdentityToken'],
}
const RETIRED = [
  'composeIntentPlatformInventoryParticipant',
  'composeIntentWorkflowGraphValidation',
  'IntentPlatformInventoryCompositionDependencies',
]
const MAINTENANCE_TAKES = `import ${APP}/maintenanceCommands: createIntentMaintenanceCommands, IntentMaintenanceLog`
const REEXPORTS = [
  `export ${APP}/platformInventoryParticipant: createIntentPlatformInventoryParticipant`,
  `export ${APP}/workflowGraphValidationProvider: createIntentWorkflowGraphValidation`,
]
const FACTORIES = [
  'createIntentPlatformInventoryParticipant',
  'createIntentWorkflowGraphValidation',
]
/**
 * The re-exports that come from the three new files. composition.ts already re-exported
 * `application/maintenanceJobs` before RFC-503, and that line is not on this RFC's list;
 * `maintenanceCommands` stays behind `composition/maintenance.ts`, so a re-export of it shows up here.
 */
const reexportsFromNewFiles = (edges: readonly string[]) =>
  edges.filter((edge) =>
    Object.keys(NEW_FILES).some((location) => edge.startsWith(`export ${location}:`)),
  )
const mentionsOldLocation = (source: string) => /platformInventory|graphValidation/.test(source)
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
 * `file -> old location: what` for everything a file still takes from the two deleted files (design §4 ③): named import,
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

/** The closed dependency surface of the new files (design §4 ④). */
const SURFACE = (file: string, specifier: string): boolean => {
  if (
    [
      '@/auth/actor',
      // RFC-561: the platform inventory names Development Automation and Digital Employee through Intent's own ports, so
      // their public entries left this surface.
      '@/modules/identity-access/public/participants',
      '@/modules/resource-catalog/public/queries',
      '@/modules/resource-catalog/public/participants',
    ].includes(specifier)
  )
    return true
  const rel = resolveSpecifier(file, specifier)
  return (
    rel !== null &&
    ['domain', 'application', 'public'].some((layer) => rel.startsWith(`${IN}/${layer}/`))
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

describe('RFC-503 ① 清单里的名字只在各自的新文件声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个名字只在它的新文件声明，改名前的三个名字没有声明（语料下限 3,000 / 2,500）',
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

describe('RFC-503 ② composition 只装配', () => {
  test('两个组合文件不存在；maintenance.ts 与 dispatch.ts 没有控制流语句，maintenance.ts 从新文件取工厂', () => {
    for (const location of DELETED) {
      expect([location, existsSync(sourceOf(location))]).toEqual([location, false])
      expect([location, existsSync(join(SRC, `${location}.tsx`))]).toEqual([location, false])
    }
    for (const location of ASSEMBLY_ONLY) {
      const path = sourceOf(location)
      expect([location, controlFlow(path, text(path))]).toEqual([location, []])
    }
    const maintenance = sourceOf(`${COMP}/maintenance`)
    expect(moduleEdges(maintenance, text(maintenance))).toContain(MAINTENANCE_TAKES)
  })

  test('intent 的 composition.ts 从新文件转出两个工厂；bootstrap 只经它取、各调用一次', () => {
    const composition = sourceOf(MODULE_COMPOSITION)
    expect(reexportsFromNewFiles(moduleEdges(composition, text(composition)))).toEqual(REEXPORTS)
    const bootstrap = sourceOf(BOOTSTRAP)
    expect(
      moduleEdges(bootstrap, text(bootstrap)).filter((edge) =>
        FACTORIES.some((name) => edge.includes(name)),
      ),
    ).toEqual([`import ${MODULE_COMPOSITION}: ${FACTORIES.join(', ')}`])
    for (const name of FACTORIES)
      expect([name, callArguments(bootstrap, text(bootstrap), name).length]).toEqual([name, 1])
  })

  test('负对照：控制流语句、别处的转出与多余的调用都会被认出', () => {
    const probe = join(SRC, `${COMP}/probe.ts`)
    const source = [
      `import { createIntentMaintenanceCommands, type IntentMaintenanceLog } from '../application/maintenanceCommands'`,
      `export { createIntentWorkflowGraphValidation } from '../application/workflowGraphValidationProvider'`,
      `import { createIntentPlatformInventoryParticipant } from './platformInventory'`,
      `export async function resume(ids: readonly string[]) {`,
      `  if (ids.length === 0) return`,
      `  for (const id of ids) await Promise.resolve(id)`,
      `  try { void createIntentMaintenanceCommands } catch { throw new Error('x') }`,
      `}`,
      `createIntentPlatformInventoryParticipant(a)`,
      `createIntentPlatformInventoryParticipant(b)`,
      `export { createIntentMaintenanceJobHandlers } from '../application/maintenanceJobs'`,
      `export { createIntentMaintenanceCommands } from '../application/maintenanceCommands'`,
    ].join('\n')
    expect(moduleEdges(probe, source)).toEqual([
      MAINTENANCE_TAKES,
      `export ${APP}/workflowGraphValidationProvider: createIntentWorkflowGraphValidation`,
      `import ${COMP}/platformInventory: createIntentPlatformInventoryParticipant`,
      `export ${APP}/maintenanceJobs: createIntentMaintenanceJobHandlers`,
      `export ${APP}/maintenanceCommands: createIntentMaintenanceCommands`,
    ])
    // The re-export filter keeps re-exports from the new files (including an extra one) and
    // ignores composition.ts's re-exports that predate RFC-503.
    expect(reexportsFromNewFiles(moduleEdges(probe, source))).toEqual([
      `export ${APP}/workflowGraphValidationProvider: createIntentWorkflowGraphValidation`,
      `export ${APP}/maintenanceCommands: createIntentMaintenanceCommands`,
    ])
    expect(controlFlow(probe, source)).toEqual(['if', 'for-of', 'try', 'throw'])
    expect(callArguments(probe, source, 'createIntentPlatformInventoryParticipant')).toEqual([
      ['a'],
      ['b'],
    ])
  })
})

describe('RFC-503 ③ 没有文件从两个删除的位置取任何东西', () => {
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

  test('负对照：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都会被认出，新位置与同名的消费方文件不算', () => {
    const file = join(SRC, `${COMP}/probe.ts`)
    const source = [
      `import { composeIntentPlatformInventoryParticipant } from './platformInventory'`,
      `import type { IntentCapabilityTemplateInventoryQueries } from '@/${COMP}/platformInventory'`,
      `import graph from '../composition/graphValidation'`,
      `import './graphValidation'`,
      `export { composeIntentWorkflowGraphValidation } from '@/${COMP}/graphValidation'`,
      `export * from './platformInventory'`,
      `import * as old from '@/${COMP}/graphValidation'`,
      `const validation = old.composeIntentWorkflowGraphValidation`,
      `const typed: typeof old.composeIntentWorkflowGraphValidation | undefined = undefined`,
      `const { composeIntentPlatformInventoryParticipant: participant } = await import('./platformInventory')`,
      `import { createIntentWorkflowGraphValidation } from '@/${APP}/workflowGraphValidationProvider'`,
      `import { renderPlatformInventoryFile } from '../application/platformInventory'`,
      `const later = await import('@/${APP}/platformInventoryParticipant')`,
    ].join('\n')
    const label = corpusPath(file)
    expect(takenFromOldLocations(file, source)).toEqual(
      [
        `${COMP}/platformInventory: composeIntentPlatformInventoryParticipant`,
        `${COMP}/platformInventory: IntentCapabilityTemplateInventoryQueries`,
        `${COMP}/graphValidation: default`,
        `${COMP}/graphValidation: <side effect>`,
        `${COMP}/graphValidation: composeIntentWorkflowGraphValidation`,
        `${COMP}/platformInventory: *`,
        `${COMP}/graphValidation: composeIntentWorkflowGraphValidation`,
        `${COMP}/graphValidation: composeIntentWorkflowGraphValidation`,
        `${COMP}/platformInventory: composeIntentPlatformInventoryParticipant`,
        `${COMP}/platformInventory: import()`,
      ].map((what) => `${label} -> ${what}`),
    )
  })
})

describe('RFC-503 ④ 新文件的依赖面是闭集、不用进程全局', () => {
  test('只取 @/auth/actor、两个外域的 public 类型入口与本模块 domain / application / public', () => {
    for (const location of Object.keys(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, purityFindings(path, text(path), SURFACE)]).toEqual([location, []])
    }
  })

  test('负对照：越界 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${APP}/probe.ts`)
    const source = [
      `import type { Actor } from '@/auth/actor'`,
      `import type { DevelopmentConfigOperations } from '@/modules/development-automation/public/operations'`,
      `import type { WorkflowQueries } from '@/modules/resource-catalog/public/queries'`,
      `import type { IntentMaintenanceCommands } from '../public/commands'`,
      `import type { PlatformOnlyResourceType } from '../domain/teaching/platformMap'`,
      `import type { IntentScratchStore } from './ports/intentScratchStore'`,
      `import { createIntentPersistence } from '../infrastructure/intentPersistence'`,
      `import { composeIntentMaintenanceCommands } from '../composition/maintenance'`,
      `import { createResourceCatalog } from '@/modules/resource-catalog/composition'`,
      `import type { Raw } from '@/modules/development-automation/application/configOperations'`,
      `import { readFileSync } from 'node:fs'`,
      `export async function run() { await import('node:path'); const at = Date.now(); const env = process.env; await fetch('x'); Math.random() }`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE)).toEqual([
      'import @/modules/development-automation/public/operations',
      'import ../infrastructure/intentPersistence',
      'import ../composition/maintenance',
      'import @/modules/resource-catalog/composition',
      'import @/modules/development-automation/application/configOperations',
      'import node:fs',
      'import() node:path',
      'Date.now',
      'process.env',
      'fetch',
      'Math.random',
    ])
  })
})
