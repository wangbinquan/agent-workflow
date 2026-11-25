// RFC-496 — 开发自动化的员工工作区用例迁出 composition（RFC-294 S10 第三步）。
//
// 锁五件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件里只在清单列的文件声明：工作区用例在 `application/employeeWorkspace.ts`，受保护目录快照与工作区校验在
//    `application/protectedSnapshot.ts`、`application/workspaceValidator.ts`，git 元数据前缀在 `domain/gitMetadataOwnership.ts`；早已存在的
//    同名项与 infrastructure 的三个包装逐个钉住。
// ② `composition/digitalEmployeeWorkspace.ts` 只声明组合输入类型、bootstrap 输入类型、两个装配函数与读侧的数据库绑定，只交出其中三个；
//    没有控制流语句（语法树）；装配函数把输入连同选定的工作区效果与默认时钟交给 application 的用例，恰好一次。
// ③ infrastructure 的两个快照 / 校验文件只声明三个包装、只另外转出 `taskImageWorkspace` 要用的三个名字，没有控制流语句；每个包装只是把
//    工厂（远端树操作时原样、否则先选本机实现）交给 application 的同名函数。
// ④ 全部生产文件、用例与 e2e 不从旧位置取迁出的名字：composition 文件只给三个组合名字，两个 infrastructure 文件只给包装与转出，
//    `attemptSupport.ts` 不再给三组常量；命名 import、type-only、re-export、命名空间成员与动态 import 的解构都认，带负对照。
// ⑤ 新文件的依赖面是闭集：三个 application 文件只取 zod、shared、`@/platform/contracts/hash`、`@/util/gitRef`、digital-employee 的 `public/types` 与本
//    模块的 domain / application；domain 文件没有 import；都不用进程全局（带负对照）。
//
// 覆盖范围（C12）：① ④ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ③ ⑤ 读 composition 文件、两个 infrastructure 文件与四个新文件。
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
const COMPOSITION = `${DA}/composition/digitalEmployeeWorkspace`
const WORKSPACE = `${DA}/application/employeeWorkspace`
const SNAPSHOT = `${DA}/application/protectedSnapshot`
const VALIDATOR = `${DA}/application/workspaceValidator`
const GIT_METADATA = `${DA}/domain/gitMetadataOwnership`
const INFRA_SNAPSHOT = `${DA}/infrastructure/protectedSnapshot`
const INFRA_VALIDATOR = `${DA}/infrastructure/workspaceValidator`
const ATTEMPT_SUPPORT = `${DA}/infrastructure/attemptSupport`

const GIT_METADATA_NAMES = [
  'PLATFORM_OWNED_GIT_METADATA_PREFIXES',
  'RUNTIME_OWNED_GIT_METADATA_PREFIXES',
  'GIT_METADATA_SKIP_PREFIXES',
]
/** design §3: where each moved name is declared now. */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  [WORKSPACE]: [
    'DevelopmentEmployeeWorkspaceInput',
    'DevelopmentEmployeeWorkspaceParticipant',
    'createDevelopmentEmployeeWorkspace',
    'DevelopmentEmployeeCaseWorkspaceDetailRow',
    'DevelopmentEmployeeCaseWorkspaceDetailReader',
    'createEmployeeCaseWorkspaceDetailReader',
    'workspacePolicySchema',
    'planSchema',
    'attemptSchema',
    'issueContextSchema',
    'inputEnvelopeSchema',
    'contextRecordSchema',
    'mergeRequestContextSchema',
    'SerializedPreState',
    'serializeProtected',
    'reviveProtected',
    'rootsOf',
    'skipPrefixes',
    'FrozenPlatformArtifactRef',
    'REQUIREMENT_ARTIFACT_PREFIX',
    'PIPELINE_ARTIFACT_PREFIX',
    'parseFrozenPlatformArtifactRef',
    'frozenPlatformArtifactRefs',
    'requirePlainDirectory',
    'requirePlainDirectoryPath',
    'ensurePlainDirectoryPath',
    'copyFrozenPlatformEntry',
    'hydrateFrozenPlatformArtifacts',
    'hasImplementationPlanReview',
    'preStateWithFrozenPlatformArtifacts',
    'contextsOf',
    'resolveIssue',
    'resolveMergeRequest',
    'businessDelta',
    'businessChangedPaths',
    'directoryContainsFile',
    'changedWorkspaceValidationSchema',
    'RepositoryPreparationPort',
  ],
  [SNAPSHOT]: [
    'ProtectedRootSnapshot',
    'SnapshotViolation',
    'protectedRootSnapshotDigest',
    'walk',
    'readProtectedRootSnapshot',
    'diffProtectedRoots',
    'SerializedProtectedRootSnapshot',
    'serializeProtectedRootSnapshot',
    'reviveProtectedRootSnapshot',
    'snapshotProtectedRoots',
  ],
  [VALIDATOR]: [
    'readBusinessTreeSnapshot',
    'businessTreeSnapshotDigest',
    'BoundaryViolationCode',
    'WorkspaceValidationOutcome',
    'WorkspaceValidationInput',
    'within',
    'boundary',
    'validateWorkspaceOutcomeInScope',
    'businessTreeSnapshot',
    'SerializedWorkspaceValidationInput',
    'serializeWorkspaceValidationInput',
    'reviveWorkspaceValidationInput',
    'validateWorkspaceOutcome',
  ],
  [GIT_METADATA]: GIT_METADATA_NAMES,
}
/** Declarations that share a moved name, pinned one by one: unrelated ones that predate RFC-496, and the three wrappers. */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  planSchema: ['modules/task-execution/application/digitalEmployeeExecution'],
  attemptSchema: ['modules/task-execution/application/digitalEmployeeExecution'],
  inputEnvelopeSchema: ['modules/task-execution/application/digitalEmployeeExecution'],
  RepositoryPreparationPort: ['modules/task-execution/application/ports/taskEngine'],
  contextRecordSchema: [`${DA}/application/digitalEmployeeToolContractProjectionV2`],
  mergeRequestContextSchema: [`${DA}/application/employeeTypePackage`],
  contextsOf: [`${DA}/application/employeePlatformWorkItems`],
  SerializedPreState: [ATTEMPT_SUPPORT],
  serializeProtected: [ATTEMPT_SUPPORT],
  reviveProtected: [ATTEMPT_SUPPORT],
  snapshotProtectedRoots: [INFRA_SNAPSHOT],
  businessTreeSnapshot: [INFRA_VALIDATOR],
  validateWorkspaceOutcome: [INFRA_VALIDATOR],
}
const COMPOSITION_DECLARED = [
  'DevelopmentEmployeeWorkspaceCompositionInput',
  'DevelopmentEmployeeWorkspaceBootstrapInput',
  'composeDevelopmentEmployeeWorkspaceFromPersistence',
  'composeDevelopmentEmployeeWorkspace',
  'createDevelopmentEmployeeCaseWorkspaceDetailReader',
]
const COMPOSITION_OFFERED = [
  'DevelopmentEmployeeWorkspaceCompositionInput',
  'composeDevelopmentEmployeeWorkspace',
  'createDevelopmentEmployeeCaseWorkspaceDetailReader',
]
/** What the assembly hands the use case on top of the composition input (design D5). */
const BOUND = ['automationWorkspaceEffects', 'now']
/** design D3: the wrappers each infrastructure file keeps and the names it still hands `taskImageWorkspace`. */
interface Adapter {
  readonly application: string
  readonly wrappers: readonly string[]
  readonly forwarded: readonly string[]
}
const SNAPSHOT_ADAPTER: Adapter = {
  application: SNAPSHOT,
  wrappers: ['snapshotProtectedRoots'],
  forwarded: ['serializeProtectedRootSnapshot'],
}
const VALIDATOR_ADAPTER: Adapter = {
  application: VALIDATOR,
  wrappers: ['businessTreeSnapshot', 'validateWorkspaceOutcome'],
  forwarded: ['reviveWorkspaceValidationInput', 'SerializedWorkspaceValidationInput'],
}
const ADAPTERS: readonly (readonly [string, Adapter])[] = [
  [INFRA_SNAPSHOT, SNAPSHOT_ADAPTER],
  [INFRA_VALIDATOR, VALIDATOR_ADAPTER],
]
/** The one argument each wrapper adds: the factory as given for a remote volume, otherwise the selected one. */
const SELECTION =
  'factory?.treeOperations===undefined?selectedAutomationWorkspaceEffects(factory):factory'
/** design §2 ④: what an old location may still give; anything else taken from it is a finding. */
const OLD_LOCATIONS: Readonly<Record<string, (name: string) => boolean>> = {
  [COMPOSITION]: (name) => COMPOSITION_OFFERED.includes(name),
  [INFRA_SNAPSHOT]: (name) =>
    [...SNAPSHOT_ADAPTER.wrappers, ...SNAPSHOT_ADAPTER.forwarded].includes(name),
  [INFRA_VALIDATOR]: (name) =>
    [...VALIDATOR_ADAPTER.wrappers, ...VALIDATOR_ADAPTER.forwarded].includes(name),
  [ATTEMPT_SUPPORT]: (name) => !GIT_METADATA_NAMES.includes(name),
}
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

const CONTROL_FLOW = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.ThrowStatement,
])
function controlFlowStatements(path: string, source: string): string[] {
  const found: string[] = []
  const file = parse(path, source)
  const visit = (node: ts.Node) => {
    if (CONTROL_FLOW.has(node.kind))
      found.push(
        `${ts.SyntaxKind[node.kind]}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`,
      )
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * `file -> old location: name` for every name an old location may no longer give (design §2 ④): named import,
 * type-only, `export … from`, members of a namespace import (value and type positions), and the destructured names of
 * a dynamic `import()`; specifiers resolve from the file.
 */
function takenFromOldLocations(file: string, source: string): string[] {
  const out: string[] = []
  const label = slash(relative(REPO, file))
  const locationOf = (specifier: string) => {
    const rel = resolveSpecifier(file, specifier)
    return rel !== null && rel in OLD_LOCATIONS ? rel : null
  }
  const flag = (location: string, name: string) => {
    if (!OLD_LOCATIONS[location]!(name)) out.push(`${label} -> ${location}: ${name}`)
  }
  const namespaces = new Map<string, string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const location = locationOf(node.moduleSpecifier.text)
      if (location !== null && ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements)
            flag(location, (element.propertyName ?? element.name).text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          namespaces.set(bindings.name.text, location)
      } else if (
        location !== null &&
        ts.isExportDeclaration(node) &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      )
        for (const element of node.exportClause.elements)
          flag(location, (element.propertyName ?? element.name).text)
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
        const location = locationOf(call.arguments[0].text)
        if (location !== null)
          for (const element of node.name.elements)
            flag(location, (element.propertyName ?? element.name).getText())
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
const mentionsOldLocation = (source: string) =>
  /digitalEmployeeWorkspace|protectedSnapshot|workspaceValidator|attemptSupport/.test(source)

/** The closed dependency surface of the application files (design §4 ⑤). */
function allowedDependency(file: string, specifier: string): boolean {
  if (
    [
      'zod',
      '@/platform/contracts/hash',
      '@/util/gitRef',
      '@/modules/digital-employee/public/types',
    ].includes(specifier)
  )
    return true
  if (specifier === '@agent-workflow/shared' || specifier.startsWith('@agent-workflow/shared/'))
    return true
  const rel = resolveSpecifier(file, specifier)
  return rel !== null && /^modules\/development-automation\/(?:domain|application)\//.test(rel)
}

/** Imports outside the given surface and process globals, read from the syntax tree. */
function purityFindings(
  file: string,
  source: string,
  allowed: (file: string, specifier: string) => boolean = allowedDependency,
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
const noImports = () => false

/**
 * Each wrapper's whole body: `return <alias>(…)`, where `<alias>` imports the application function of the same name
 * and the last argument is the selection (design D3). Returns one line per wrapper.
 */
function wrapperShapes(path: string, source: string, application: string): string[] {
  const file = parse(path, source)
  const aliases = new Map<string, string>()
  for (const statement of file.statements)
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolveSpecifier(path, statement.moduleSpecifier.text) === application &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const element of statement.importClause.namedBindings.elements)
        aliases.set(element.name.text, (element.propertyName ?? element.name).text)
  const shapes: string[] = []
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue
    const only = statement.body?.statements.length === 1 ? statement.body.statements[0] : undefined
    const call =
      only !== undefined &&
      ts.isReturnStatement(only) &&
      only.expression !== undefined &&
      ts.isCallExpression(only.expression)
        ? only.expression
        : undefined
    const callee =
      call !== undefined && ts.isIdentifier(call.expression) ? call.expression.text : ''
    const last =
      call === undefined
        ? undefined
        : call.arguments[call.arguments.length - 1]?.getText(file).replace(/\s+/g, '')
    shapes.push(`${statement.name.text} -> ${aliases.get(callee) ?? '?'} | ${last ?? '?'}`)
  }
  return shapes.sort()
}

describe('RFC-496 ① 清单里的名字只在清单列的文件声明', () => {
  test(
    '全部生产文件里每个名字只在新文件声明（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const [location, names] of Object.entries(MOVED))
        for (const name of names) {
          const declaring = PRODUCTION.filter(
            (path) =>
              new RegExp(`\\b${name}\\b`).test(text(path)) &&
              declaredNames(path, text(path)).includes(name),
          )
            .map(srcPath)
            .sort()
          expect([name, declaring]).toEqual([name, [location, ...(HOMONYMS[name] ?? [])].sort()])
        }
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-496 ② composition 只留装配', () => {
  const path = sourceOf(COMPOSITION)

  test('只声明组合输入类型、bootstrap 输入类型、两个装配函数与读侧的数据库绑定，只交出其中三个', () => {
    expect(declaredNames(path, text(path)).sort()).toEqual([...COMPOSITION_DECLARED].sort())
    expect(offeredNames(path, text(path)).sort()).toEqual([...COMPOSITION_OFFERED].sort())
  })

  test('没有 if / for / while / do / switch / try / throw', () => {
    expect(controlFlowStatements(path, text(path))).toEqual([])
    expect(controlFlowStatements('probe.ts', 'if (a) for (const b of c) throw b')).toEqual([
      'IfStatement:1',
      'ForOfStatement:1',
      'ThrowStatement:1',
    ])
  })

  test('装配函数把输入连同选定的工作区效果与默认时钟交给 application 的用例，恰好一次', () => {
    const calls: ts.CallExpression[] = []
    const file = parse(path, text(path))
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createDevelopmentEmployeeWorkspace'
      )
        calls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    const properties = (argument as ts.ObjectLiteralExpression).properties
    expect(
      properties.filter(ts.isSpreadAssignment).map((spread) => spread.expression.getText(file)),
    ).toEqual(['input'])
    expect(
      properties
        .filter((property) => !ts.isSpreadAssignment(property))
        .map((property) => property.name!.getText(file))
        .sort(),
    ).toEqual([...BOUND].sort())
  })
})

describe('RFC-496 ③ infrastructure 的快照 / 校验文件只留包装与转出', () => {
  for (const [location, adapter] of ADAPTERS) {
    const path = sourceOf(location)

    test(`${location}：只声明包装、只另外转出 taskImageWorkspace 要用的名字，没有控制流`, () => {
      expect(declaredNames(path, text(path)).sort()).toEqual([...adapter.wrappers].sort())
      expect(offeredNames(path, text(path)).sort()).toEqual(
        [...adapter.wrappers, ...adapter.forwarded].sort(),
      )
      expect(controlFlowStatements(path, text(path))).toEqual([])
    })

    test(`${location}：每个包装只把工厂交给 application 的同名函数`, () => {
      expect(wrapperShapes(path, text(path), adapter.application)).toEqual(
        adapter.wrappers.map((name) => `${name} -> ${name} | ${SELECTION}`).sort(),
      )
    })
  }

  test('负对照：多一条语句、换了被调函数或不选实现都会被认出', () => {
    const file = join(SRC, `${DA}/infrastructure/probe.ts`)
    const source = [
      `import { snapshotProtectedRoots as selected, diffProtectedRoots } from '../application/protectedSnapshot'`,
      `export async function snapshotProtectedRoots(r, o, factory) { return selected(r, o, factory?.treeOperations === undefined ? selectedAutomationWorkspaceEffects(factory) : factory) }`,
      `export async function businessTreeSnapshot(root, factory) { return selected(root, factory) }`,
      `export async function validateWorkspaceOutcome(input, factory) { const f = factory; return selected(input, f) }`,
      `export function diff(a, b) { return diffProtectedRoots(a, b) }`,
    ].join('\n')
    expect(wrapperShapes(file, source, SNAPSHOT)).toEqual([
      'businessTreeSnapshot -> snapshotProtectedRoots | factory',
      'diff -> diffProtectedRoots | b',
      `snapshotProtectedRoots -> snapshotProtectedRoots | ${SELECTION}`,
      'validateWorkspaceOutcome -> ? | ?',
    ])
  })
})

describe('RFC-496 ④ 没有文件从旧位置取迁出的名字', () => {
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

  test('负对照：命名 import、type-only、re-export、命名空间成员与动态 import 的解构都会被认出，留下的名字与新位置不算', () => {
    const file = join(SRC, 'bootstrap/daemonModules/probe.ts')
    const source = [
      `import { composeDevelopmentEmployeeWorkspace, createDevelopmentEmployeeWorkspace } from '@/${COMPOSITION}'`,
      `import type { DevelopmentEmployeeWorkspaceCompositionInput, DevelopmentEmployeeCaseWorkspaceDetailRow } from '@/${COMPOSITION}'`,
      `export { createDevelopmentEmployeeCaseWorkspaceDetailReader, contextsOf } from '../../${COMPOSITION}'`,
      `import { snapshotProtectedRoots, serializeProtectedRootSnapshot, readProtectedRootSnapshot } from '@/${INFRA_SNAPSHOT}'`,
      `import { businessTreeSnapshot, type SerializedWorkspaceValidationInput, type WorkspaceValidationInput } from '@/${INFRA_VALIDATOR}'`,
      `import { createWorkspaceValidationAdapter, GIT_METADATA_SKIP_PREFIXES } from '@/${ATTEMPT_SUPPORT}'`,
      `import * as validator from '@/${INFRA_VALIDATOR}'`,
      `const outcome = validator.validateWorkspaceOutcome`,
      `const scoped: validator.WorkspaceValidationOutcome | undefined = undefined`,
      `const { businessTreeSnapshotDigest } = await import('@/${INFRA_VALIDATOR}')`,
      `import { createDevelopmentEmployeeWorkspace as create } from '@/${WORKSPACE}'`,
      `import { readProtectedRootSnapshot as read } from '@/${SNAPSHOT}'`,
      `import { GIT_METADATA_SKIP_PREFIXES as skips } from '@/${GIT_METADATA}'`,
    ].join('\n')
    const label = slash(relative(REPO, file))
    expect(takenFromOldLocations(file, source)).toEqual([
      `${label} -> ${COMPOSITION}: createDevelopmentEmployeeWorkspace`,
      `${label} -> ${COMPOSITION}: DevelopmentEmployeeCaseWorkspaceDetailRow`,
      `${label} -> ${COMPOSITION}: contextsOf`,
      `${label} -> ${INFRA_SNAPSHOT}: readProtectedRootSnapshot`,
      `${label} -> ${INFRA_VALIDATOR}: WorkspaceValidationInput`,
      `${label} -> ${ATTEMPT_SUPPORT}: GIT_METADATA_SKIP_PREFIXES`,
      `${label} -> ${INFRA_VALIDATOR}: WorkspaceValidationOutcome`,
      `${label} -> ${INFRA_VALIDATOR}: businessTreeSnapshotDigest`,
    ])
  })
})

describe('RFC-496 ⑤ 新文件的依赖面是闭集、不用进程全局', () => {
  test('三个 application 文件只取 zod、shared、@/platform/contracts/hash、@/util/gitRef、digital-employee 的 public/types 与本模块 domain / application', () => {
    for (const location of [WORKSPACE, SNAPSHOT, VALIDATOR]) {
      const path = sourceOf(location)
      expect([location, purityFindings(path, text(path))]).toEqual([location, []])
    }
  })

  test('domain 文件没有 import、不用进程全局', () => {
    const path = sourceOf(GIT_METADATA)
    expect(purityFindings(path, text(path), noImports)).toEqual([])
  })

  test('负对照：越界 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${DA}/application/probe.ts`)
    const source = [
      `import { z } from 'zod'`,
      `import { utf16MinLength } from '@agent-workflow/shared'`,
      `import { sha256Hex } from '@/platform/contracts/hash'`,
      `import type { EmployeeReactionRoundQueryPort } from '@/modules/digital-employee/public/types'`,
      `import { GIT_METADATA_SKIP_PREFIXES } from '../domain/gitMetadataOwnership'`,
      `import { withSelectedAutomationWorkspaceEffects } from './automationWorkspaceEffectLifetime'`,
      `import { readFileSync } from 'node:fs'`,
      `import { selectedAutomationWorkspaceEffects } from '../infrastructure/automationWorkspaceEffects'`,
      `import { composeDevelopmentEmployeeWorkspace } from '../composition/digitalEmployeeWorkspace'`,
      `import type { EmployeeCase } from '@/modules/digital-employee/domain/model'`,
      `import { isLexicallyInsideForHost } from '@/platform/execution/local/platformExec'`,
      `export async function run() { await import('node:path'); const at = Date.now(); process.exit(at); await fetch('x') }`,
      `const at = new Date(0).toISOString()`,
    ].join('\n')
    expect(purityFindings(file, source)).toEqual([
      'import node:fs',
      'import ../infrastructure/automationWorkspaceEffects',
      'import ../composition/digitalEmployeeWorkspace',
      'import @/modules/digital-employee/domain/model',
      'import @/platform/execution/local/platformExec',
      'import() node:path',
      'Date.now',
      'process.exit',
      'fetch()',
    ])
    const domain = join(SRC, `${DA}/domain/probe.ts`)
    expect(
      purityFindings(
        domain,
        `import { z } from 'zod'\nexport const at = globalThis.Date\nexport const RULES = ['x'] as const`,
        noImports,
      ),
    ).toEqual(['import zod', 'globalThis.Date'])
  })
})
