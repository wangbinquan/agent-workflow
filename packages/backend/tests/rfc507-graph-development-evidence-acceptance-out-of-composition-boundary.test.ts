// RFC-507 — 开发自动化的图开发执行端口、证据与验收迁出 composition（RFC-294 S10 第十四步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里交出的名字在全部生产文件、用例与 e2e 里只在各自的新位置声明；两个新文件恰好声明、交出清单列的名字；
//    `graphDevelopment.ts` 只声明并导出原有的装配入口与类型，转出的五个名字不变。
// ② `graphDevelopment.ts` 没有 if / for / while / do / switch / try / throw 语句，也不再用迁走的代码要的
//    `GraphEvidenceBindingSchema`、`staleGraphReads`、`repositoryMaterializationCommit`、`graphDigest` 与 zod；三个新入口在生产代码里都只在
//    该文件调用一次，晚建的执行消费、员工工作区与交付桥以转发函数交入；交给路由的对象字段名与次序不变，迁走的六个成员取自证据验收用例
//    （带负对照）。
// ③ 新代码的依赖面是闭集：两个新文件只取 shared、zod、本模块的 domain 与 application（含 ports）、source-control 的 public 类型，
//    import 逐条钉住，不用进程全局（带负对照）。
// ④ 行为（直接调用新位置，端口用内存替身）：材料核对、目标分支与续作基线、档案摘要表、验收的拒绝与幂等、当前证据目标的清理、请求验证与
//    带内容的档案列表。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读 `graphDevelopment.ts` 与两个新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { canonicalJson, type GraphEvidenceBinding } from '@agent-workflow/shared'
import {
  createGraphDesignExecution,
  type GraphDesignExecutionDependencies,
} from '@/modules/development-automation/application/graph-development/designExecution'
import {
  createGraphEvidenceAcceptance,
  listGraphVerificationProfileContents,
} from '@/modules/development-automation/application/graph-development/evidenceAcceptance'
import { GRAPH_CONTEXT_TYPE } from '@/modules/development-automation/application/graph-development/employeeType'
import { graphDigest } from '@/modules/development-automation/domain/graph-development/model'
import { bookingDesign } from './helpers/graphDesign'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const DA = 'modules/development-automation'
const EXECUTION = `${DA}/application/graph-development/designExecution`
const ACCEPTANCE = `${DA}/application/graph-development/evidenceAcceptance`
const GRAPH = `${DA}/composition/graphDevelopment`

/** design §3: each new file and the names it declares and offers. */
const NEW_FILES: Readonly<Record<string, readonly string[]>> = {
  [EXECUTION]: ['GraphDesignExecutionDependencies', 'createGraphDesignExecution'],
  [ACCEPTANCE]: [
    'GraphEvidenceAcceptanceDependencies',
    'createGraphEvidenceAcceptance',
    'listGraphVerificationProfileContents',
  ],
}
const LOCATIONS = Object.keys(NEW_FILES)
/** design §3 / D3: what the composition file declares, offers and takes from the new locations. */
const GRAPH_DECLARES = ['GraphDevelopment', 'composeGraphDevelopment']
const GRAPH_OFFERS = [
  ...GRAPH_DECLARES,
  'createGraphCaseIntake',
  'graphEmployeeRuntimeCodec',
  'graphEmployeeTypePackage',
  'graphExecutionContractRegistrations',
  'isGraphPlan',
]
const GRAPH_TAKES = [
  `import ${EXECUTION}: createGraphDesignExecution`,
  `import ${ACCEPTANCE}: createGraphEvidenceAcceptance, listGraphVerificationProfileContents`,
]
/** The single production call of each moved entry: its arguments (whitespace removed). */
const CALLS: Readonly<Record<string, readonly string[]>> = {
  createGraphDesignExecution: [
    '{executions:input.executions,readCase:input.readCase,artifacts,humanSources:(caseId,sources)=>consumption.humanSources(caseId,sources),reviewReceipt:(request)=>consumption.reviewReceipt(request),resolveBaseline:(repositoryId,targetBranch)=>workspace.resolveBaseline(repositoryId,targetBranch),continuationWorkspace:(designId)=>care.continuationWorkspace(designId),}',
  ],
  createGraphEvidenceAcceptance: [
    '{store,artifacts,commands,queries,profiles,cases:input.cases,candidates:input.candidates,verification:input.verification,continuationWorkspace:(designId)=>care.continuationWorkspace(designId),workspaceState:(designId)=>workspace.state(designId),changed:input.changed,}',
  ],
  listGraphVerificationProfileContents: ['profiles'],
}
/** The `graph` object's members in HEAD order, and the six now taken from the evidence and acceptance use case. */
const GRAPH_MEMBERS = [
  'mountRoutes',
  'commands',
  'queries',
  'planning',
  'workspace',
  'care',
  'platformWorkItems',
  'detailProjection',
  'progress',
  'recover',
  'basis',
  'evidence',
  'verificationProfiles',
  'reviewLimitations',
  'accept',
  'requestVerification',
  'exportBasis',
]
const FROM_ACCEPTANCE = [
  'basis',
  'evidence',
  'verificationProfiles',
  'accept',
  'requestVerification',
  'exportBasis',
]
/** design §4 ③: the exact imports of the two new files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [EXECUTION]: [
    'import zod: z',
    'import @agent-workflow/shared: GraphSource, RepositoryContentBaseline',
    `import ${DA}/domain/graph-development/model: graphDigest`,
    `import ${DA}/application/ports/graphDesignArtifacts: GraphDesignArtifacts`,
    `import ${DA}/application/ports/graphDesignExecution: GraphDesignExecutionPort`,
    `import ${DA}/application/ports/graphHostFacts: GraphExecutionFacts`,
    `import ${DA}/application/graph-development/employeeCodec: GraphEmployeeContextSchema`,
    `import ${DA}/application/graph-development/employeeType: GRAPH_CONTEXT_TYPE`,
  ],
  [ACCEPTANCE]: [
    'import @agent-workflow/shared: canonicalJson, GraphEvidenceBindingSchema, repositoryMaterializationCommit, GraphImplementationBasis',
    'import modules/source-control/public/types: CandidateDeliveryParticipant, ChangeCandidateParticipant',
    `import ${DA}/domain/graph-development/model: staleGraphReads`,
    `import ${DA}/application/ports/configResourceStore: VerificationProfilePersistence`,
    `import ${DA}/application/ports/graphDesignArtifacts: GraphDesignArtifacts`,
    `import ${DA}/application/ports/graphDesignExecution: GraphDesignCasePort`,
    `import ${DA}/application/ports/graphDesignStore: GraphDesignStore`,
    `import ${DA}/application/ports/verificationCommandEffects: VerificationCommandEffectsFactory`,
    `import ${DA}/application/graph-development/designCommands: GraphDesignCommands`,
    `import ${DA}/application/graph-development/designQueries: GraphDesignQueries`,
    `import ${DA}/application/graph-development/verification: GraphVerificationWorkspace`,
  ],
}
/** The allowed surface: shared, zod, this module's domain and application (ports included), source-control's public types. */
const SURFACE = (file: string, specifier: string): boolean => {
  if (
    ['@agent-workflow/shared', 'zod', '@/modules/source-control/public/types'].includes(specifier)
  )
    return true
  const resolved = resolveSpecifier(file, specifier)
  return (
    resolved !== null &&
    (resolved.startsWith(`${DA}/domain/`) || resolved.startsWith(`${DA}/application/`))
  )
}
/** Edges whose source is one of the RFC-507 locations (the file's other edges are not on this RFC's list). */
const edgesToLocations = (edges: readonly string[]) =>
  edges.filter((edge) =>
    LOCATIONS.some((location) => edge.split(': ')[0]!.endsWith(` ${location}`)),
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
/** The graph helpers the moved code used; none may remain in the composition file (design §4 ②). */
const MOVED_HELPERS = [
  'GraphEvidenceBindingSchema',
  'staleGraphReads',
  'repositoryMaterializationCommit',
  'graphDigest',
  'z',
]
/**
 * Control-flow statements anywhere in the file (design §3; stricter than the F13 line-start count), plus any identifier
 * the moved code needed (a schema parse, the stale-read check, the materialization commit, the digest or zod).
 */
function implementationShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (ts.isIdentifier(node) && MOVED_HELPERS.includes(node.text)) out.push(node.text)
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

/** The `graph` object literal of `composeGraphDevelopment`: each member with its initializer text (methods as `<method>`). */
function graphMembers(path: string, source: string): [string, string][] {
  const file = parse(path, source)
  let members: [string, string][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'graph' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      members = node.initializer.properties.map((property): [string, string] => [
        property.name !== undefined && ts.isIdentifier(property.name) ? property.name.text : '?',
        ts.isPropertyAssignment(property)
          ? property.initializer.getText(file).replace(/\s+/g, '')
          : ts.isShorthandPropertyAssignment(property)
            ? '<shorthand>'
            : '<method>',
      ])
    ts.forEachChild(node, visit)
  }
  visit(file)
  return members
}

describe('RFC-507 ① 清单里的名字只在各自的新位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个交出的名字只在它的新位置声明（语料下限 3,000 / 2,500）',
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
      const listed = Object.entries(NEW_FILES).flatMap(([location, names]) =>
        names.map((name): [string, string] => [location, name]),
      )
      expect(listed).toHaveLength(5)
      for (const [location, name] of listed)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('两个新文件恰好声明、交出清单列的名字；组合文件只声明并导出原有的装配入口与类型，转出的五个名字不变', () => {
    for (const [location, names] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...names].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...names].sort(),
      ])
    }
    const graph = sourceOf(GRAPH)
    expect(declaredNames(graph, text(graph)).sort()).toEqual([...GRAPH_DECLARES].sort())
    expect(offeredNames(graph, text(graph)).sort()).toEqual([...GRAPH_OFFERS].sort())
  })
})

describe('RFC-507 ② composition 只装配', () => {
  test('组合文件没有控制流语句、不再用迁走的代码要的名字，从两个新位置取实现；交出的对象字段与次序不变', () => {
    const graph = sourceOf(GRAPH)
    expect(implementationShapes(graph, text(graph))).toEqual([])
    expect(edgesToLocations(moduleEdges(graph, text(graph)))).toEqual(GRAPH_TAKES)
    const members = graphMembers(graph, text(graph))
    expect(members.map(([name]) => name)).toEqual(GRAPH_MEMBERS)
    for (const name of FROM_ACCEPTANCE)
      expect([name, members.find(([member]) => member === name)?.[1]]).toEqual([
        name,
        `acceptance.${name}`,
      ])
    const review = members.find(([name]) => name === 'reviewLimitations')![1]
    expect(review).toContain('latestVerification:acceptance.latestVerification,')
    expect(review).toContain('currentEvidenceTarget:acceptance.currentEvidenceTarget,')
  })

  test(
    '三个新入口在生产代码里都只在组合文件调用一次，晚建的对象以转发函数交入',
    () => {
      for (const [name, args] of Object.entries(CALLS)) {
        expect([name, productionCallers(name)]).toEqual([name, [`${GRAPH} x1`]])
        const path = sourceOf(GRAPH)
        expect([name, callArguments(path, text(path), name)]).toEqual([name, [[...args]]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：控制流语句、迁走的名字、别处的 import、改动的字段与多余的调用都会被认出', () => {
    const probe = join(SRC, `${DA}/composition/probe.ts`)
    const source = [
      `import { z } from 'zod'`,
      `import { createGraphDesignExecution } from '../application/graph-development/designExecution'`,
      `import { createGraphEvidenceAcceptance } from '@/${ACCEPTANCE}'`,
      `import { staleGraphReads } from '../domain/graph-development/model'`,
      `export async function compose(files: readonly string[]) {`,
      `  for (const file of files) if (!file) throw new Error('x')`,
      `  while (files.length) break`,
      `  switch (files[0]) { default: break }`,
      `  try { void 0 } finally { void 1 }`,
      `  void [z.string(), staleGraphReads]`,
      `  const acceptance = createGraphEvidenceAcceptance({} as never)`,
      `  const graph = { basis: acceptance.basis, async evidence() { return 1 }, accept: () => acceptance.accept }`,
      `  return [graph, createGraphDesignExecution({} as never), createGraphDesignExecution({} as never)]`,
      `}`,
    ].join('\n')
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${EXECUTION}: createGraphDesignExecution`,
      `import ${ACCEPTANCE}: createGraphEvidenceAcceptance`,
    ])
    expect(implementationShapes(probe, source)).toEqual([
      'z',
      'staleGraphReads',
      'for-of',
      'if',
      'throw',
      'while',
      'switch',
      'try',
      'z',
      'staleGraphReads',
    ])
    expect(graphMembers(probe, source)).toEqual([
      ['basis', 'acceptance.basis'],
      ['evidence', '<method>'],
      ['accept', '()=>acceptance.accept'],
    ])
    expect(callArguments(probe, source, 'createGraphDesignExecution')).toHaveLength(2)
    // The pinned wiring tells a forwarding function apart from a detached method and from an object taken too early.
    const pinned = CALLS.createGraphDesignExecution![0]!
    const variants = [
      pinned.replace(
        'humanSources:(caseId,sources)=>consumption.humanSources(caseId,sources)',
        'humanSources:consumption.humanSources',
      ),
      pinned.replace(
        'continuationWorkspace:(designId)=>care.continuationWorkspace(designId)',
        'continuationWorkspace:care.continuationWorkspace',
      ),
    ]
    for (const variant of variants) expect(variant).not.toBe(pinned)
  })
})

describe('RFC-507 ③ 新代码的依赖面是闭集、不用进程全局', () => {
  test('两个新文件的 import 逐条与清单相同，都在允许的面内，不用进程全局', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect([location, purityFindings(path, text(path), SURFACE, true)]).toEqual([location, []])
    }
  })

  test('负对照：越界 import、多出的 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${EXECUTION}.ts`)
    const source = [
      `import { z } from 'zod'`,
      `import { graphDigest } from '../../domain/graph-development/model'`,
      `import type { GraphDesignStore } from '../ports/graphDesignStore'`,
      `import { createGraphDesignStore } from '../../infrastructure/graph-development/designStore'`,
      `import { composeGraphDevelopment } from '../../composition/graphDevelopment'`,
      `import { readFileSync } from 'node:fs'`,
      `import type { PersistenceDb } from '@/platform/persistence/persistenceDb'`,
      `import type { CandidateDeliveryParticipant } from '@/modules/source-control/public/participants'`,
      `export async function run() { await import('node:child_process'); const at = Date.now(); const env = process.env; await fetch('x'); Math.random() }`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE, true)).toEqual([
      'import ../../infrastructure/graph-development/designStore',
      'import ../../composition/graphDevelopment',
      'import node:fs',
      'import @/platform/persistence/persistenceDb',
      'import @/modules/source-control/public/participants',
      'import() node:child_process',
      'Date.now',
      'process.env',
      'fetch',
      'Math.random',
    ])
    expect(moduleEdges(file, source)).not.toEqual(IMPORTS[EXECUTION])
  })
})

const TREE = 'c'.repeat(40)
const OTHER_TREE = 'd'.repeat(40)
const BASIS_DIGEST = 'b'.repeat(64)
const ENVIRONMENT = 'e'.repeat(64)
const BASELINE = { kind: 'commit', commitSha: 'a'.repeat(40) } as const
const GRAPH_WORK = {
  caseId: 'case-1',
  designId: 'design-1',
  repositoryId: 'repo-1',
  request: { body: 'b', kind: 'body', targetBranch: 'feature/x', uploads: [] },
  consumedRevision: 0,
  basisId: null,
  basisDigest: null,
  reviewReceiptId: null,
  reviewDecision: null,
  candidateRef: null,
  candidateTreeOid: null,
  evidenceIds: [],
  result: 'designing',
}

function execution(overrides: Partial<GraphDesignExecutionDependencies> = {}) {
  const calls: string[] = []
  const port = createGraphDesignExecution({
    executions: { read: async () => null } as never,
    readCase: async () => ({ projectionJson: JSON.stringify({ contexts: [] }) }),
    artifacts: { files: async () => [] } as never,
    humanSources: async (caseId, sources) => {
      calls.push(`human ${caseId} ${sources.length}`)
      return sources
    },
    reviewReceipt: async (request) => {
      calls.push(`receipt ${request.executionRef}`)
      return null
    },
    resolveBaseline: async (repositoryId, targetBranch) => {
      calls.push(`baseline ${repositoryId} ${targetBranch}`)
      return { baseline: { contentBaseline: BASELINE as never } }
    },
    continuationWorkspace: async (designId) => {
      calls.push(`continuation ${designId}`)
      return null
    },
    ...overrides,
  })
  return { port, calls }
}

const verificationRecord = (treeOid = TREE) => ({
  kind: 'verification',
  status: 'completed',
  createdAt: 3,
  payloadJson: JSON.stringify({
    basisId: 'basis-1',
    basisDigest: BASIS_DIGEST,
    implementationRoundRef: 'round-1',
    candidate: { treeOid },
    environmentDigest: ENVIRONMENT,
    profileDigests: {},
  }),
})
const evidenceLink = (profileRef: GraphEvidenceBinding['profileRef']): GraphEvidenceBinding => ({
  id: 'execution',
  kind: 'execution',
  basisDigest: BASIS_DIGEST,
  obligationIds: ['o1'],
  readSet: [],
  candidateTreeOid: TREE,
  commitSha: null,
  profileRef,
  environmentDigest: ENVIRONMENT,
  executionRef: 'run',
  artifactRef: 'report',
  artifactDigest: 'f'.repeat(64),
  ci: null,
  result: 'passed',
  summary: '执行通过',
  limitations: [],
  recordedAt: 1,
})

function acceptanceHarness(
  options: {
    records?: readonly unknown[]
    links?: readonly unknown[]
    record?: unknown
    stage?: () => unknown
    environment?: () => Promise<{ digest: string }>
    continuation?: () => Promise<unknown>
  } = {},
) {
  const calls: string[] = []
  let target: unknown
  const document = bookingDesign()
  const basis = {
    id: 'basis-1',
    digest: BASIS_DIGEST,
    readSet: [],
    obligationIds: ['o1', 'o2'],
    files: [{ path: 'design.md', digest: 'x' }],
    document: {
      caseId: 'case-1',
      obligations: [
        { id: 'o1', verification: { kind: 'manual' } },
        { id: 'o2', verification: { kind: 'automated' } },
      ],
    },
  }
  const acceptance = createGraphEvidenceAcceptance({
    store: {
      records: async () => options.records ?? [],
      links: async () => options.links ?? [],
      insertLink: async (link: { id: string }) => {
        calls.push(`link ${link.id}`)
      },
    },
    artifacts: {
      put: async (files: readonly { path: string; content: string }[]) => {
        calls.push(`put ${files.map((file) => `${file.path}=${file.content}`).join(',')}`)
        return { artifactRef: 'artifact-1', digest: 'f'.repeat(64) }
      },
    },
    commands: {
      basis: async () => ({ basis }),
      document: async () => ({ ...document, caseId: 'case-1' }),
      beginRecord: async () => options.record ?? { status: 'running', createdAt: 7 },
      finishRecord: async (_record: unknown, status: string) => {
        calls.push(`finish ${status}`)
      },
    },
    queries: {
      evidence: async (_id: string, value: unknown) => {
        target = value
        return { items: ['projected'] }
      },
    },
    profiles: {
      list: async () => [
        { id: 'p1', name: 'P1', publishedRevision: 2, archivedAt: null },
        { id: 'p2', name: 'P2', publishedRevision: 1, archivedAt: 5 },
        { id: 'p3', name: 'P3', publishedRevision: null, archivedAt: null },
      ],
      getRevision: async (id: string, revision: number) => ({
        revision,
        contentDigest: `${id}@${revision}`,
        contentJson: '{"steps":1}',
      }),
    },
    cases: {
      requestWork: async (request: { kind: string; payloadRef: unknown }) => {
        calls.push(`work ${request.kind}`)
        return { request }
      },
    },
    candidates: {
      stage: async (input: { baselineRepoPath: string; baselineSha: string }) => {
        calls.push(`stage ${input.baselineRepoPath} ${input.baselineSha}`)
        return options.stage
          ? options.stage()
          : { ok: true, treeOid: TREE, cleanup: async () => void calls.push('cleanup') }
      },
    },
    verification: {
      environment: async () =>
        options.environment ? options.environment() : { digest: ENVIRONMENT },
    },
    continuationWorkspace: async () => (options.continuation ? options.continuation() : null),
    workspaceState: async () => ({
      baselineRepoPath: '/repo',
      baseline: BASELINE,
      workspacePath: '/work',
    }),
    changed: (caseId: string) => {
      calls.push(`changed ${caseId}`)
    },
  } as never)
  return { acceptance, calls, target: () => target }
}

const ACCEPT_REQUEST = {
  requestId: 'r1',
  basisId: 'basis-1',
  candidateTreeOid: TREE,
  obligationIds: ['o1'],
  result: 'passed' as const,
  comment: 'ok',
}

describe('RFC-507 ④ 迁出的用例行为不变', () => {
  test('执行端口：材料全部可读时不抛，缺文件或摘要不符时抛原错误', async () => {
    const files = [
      { path: 'a.md', content: 'A' },
      { path: 'b.md', content: 'B' },
    ]
    const { port } = execution({ artifacts: { files: async () => files } as never })
    const basis = (expected: readonly { path: string; digest: string }[]) =>
      ({ files: expected }) as never
    const request = (expected: readonly { path: string; digest: string }[]) => ({
      caseId: 'case-1',
      basis: basis(expected),
      artifact: {} as never,
    })
    await port.assertMaterialsReadable(
      request([
        { path: 'a.md', digest: graphDigest('A') },
        { path: 'b.md', digest: graphDigest('B') },
      ]),
    )
    await expect(
      port.assertMaterialsReadable(request([{ path: 'a.md', digest: graphDigest('B') }])),
    ).rejects.toThrow('graph-material-unreadable:a.md')
    await expect(
      port.assertMaterialsReadable(
        request([
          { path: 'a.md', digest: graphDigest('A') },
          { path: 'c.md', digest: graphDigest('C') },
        ]),
      ),
    ).rejects.toThrow('graph-material-unreadable:c.md')
  })

  test('执行端口：目标分支取自图上下文、没有上下文时为 null；续作基线没有时为 null；产物与转发照旧', async () => {
    const withContext = execution({
      readCase: async () => ({
        projectionJson: JSON.stringify({
          contexts: [
            { typeId: 'other', stateJson: '{}' },
            { typeId: GRAPH_CONTEXT_TYPE, stateJson: JSON.stringify(GRAPH_WORK) },
          ],
        }),
      }),
    })
    expect(
      await withContext.port.resolveRepositoryBaseline({
        caseId: 'case-1',
        repositoryId: 'repo-1',
      }),
    ).toEqual(BASELINE as never)
    const without = execution()
    await without.port.resolveRepositoryBaseline({ caseId: 'case-1', repositoryId: 'repo-2' })
    expect([...withContext.calls, ...without.calls]).toEqual([
      'baseline repo-1 feature/x',
      'baseline repo-2 null',
    ])
    expect(
      await without.port.resolveImplementationBaseline!({
        caseId: 'case-1',
        designId: 'design-1',
        repositoryId: 'repo-1',
      }),
    ).toBeNull()
    const continued = execution({
      continuationWorkspace: async () => ({ baseline: BASELINE as never }),
    })
    expect(
      await continued.port.resolveImplementationBaseline!({
        caseId: 'case-1',
        designId: 'design-1',
        repositoryId: 'repo-1',
      }),
    ).toEqual(BASELINE as never)
    expect(await without.port.committedArtifacts({ caseId: 'case-1', executionRef: 'x' })).toEqual(
      [],
    )
    const facts = execution({
      executions: {
        read: async () => ({
          taskId: 'task-1',
          artifacts: [{ nodeRunId: 'n1', portName: 'out', digest: 'd1', content: 'C' }],
        }),
      } as never,
    })
    expect(await facts.port.committedArtifacts({ caseId: 'case-1', executionRef: 'x' })).toEqual([
      { taskId: 'task-1', nodeRunId: 'n1', outputPort: 'out', digest: 'd1', content: 'C' },
    ])
    await facts.port.humanSources({ caseId: 'case-1', sources: [] })
    await facts.port.reviewReceipt({ caseId: 'case-1', executionRef: 'run-1', basisDigest: 'x' })
    expect(facts.calls).toEqual(['human case-1 0', 'receipt run-1'])
  })

  test('证据：档案摘要表含已发布档案的两种键与证据钉住的修订，归档与未发布的不进表；读不到当前目标时照样投影', async () => {
    const links = [
      {
        id: 'delivery:1',
        kind: 'delivery',
        payloadJson: JSON.stringify({ commitSha: 'a'.repeat(40) }),
      },
      {
        id: 'execution',
        kind: 'evidence',
        payloadJson: canonicalJson(evidenceLink({ id: 'p9', revision: 4, digest: '9'.repeat(64) })),
      },
    ]
    const fresh = acceptanceHarness({ links })
    expect(await fresh.acceptance.evidence('design-1')).toEqual({
      items: ['projected'],
      candidate: null,
    } as never)
    expect(fresh.target()).toEqual({
      basisDigest: null,
      candidateTreeOid: null,
      profileDigests: { p1: 'p1@2', 'p1@2': 'p1@2', 'p9@4': 'p9@4' },
      environmentDigest: null,
      commitSha: 'a'.repeat(40),
    })
    // No verification yet: the current target is not read at all.
    expect(fresh.calls).toEqual([])
    const unreadable = acceptanceHarness({
      links,
      records: [verificationRecord()],
      continuation: async () => {
        throw new Error('graph-mr-workspace-missing')
      },
    })
    expect(await unreadable.acceptance.evidence('design-1')).toMatchObject({ candidate: null })
    expect(unreadable.target()).toMatchObject({
      basisDigest: BASIS_DIGEST,
      candidateTreeOid: null,
      commitSha: 'a'.repeat(40),
    })
  })

  test('验收：候选不符与义务无效各抛原错误、不写；同一请求已完成时返回原载荷；成功时写产物与链接、结束记录并通知', async () => {
    const stale = acceptanceHarness({ records: [verificationRecord()] })
    await expect(
      stale.acceptance.accept(
        'design-1',
        { ...ACCEPT_REQUEST, candidateTreeOid: OTHER_TREE },
        'u1',
      ),
    ).rejects.toThrow('graph-acceptance-candidate-mismatch')
    const missing = acceptanceHarness()
    await expect(missing.acceptance.accept('design-1', ACCEPT_REQUEST, 'u1')).rejects.toThrow(
      'graph-acceptance-candidate-mismatch',
    )
    for (const obligationIds of [[], ['o2'], ['o3']]) {
      const invalid = acceptanceHarness({ records: [verificationRecord()] })
      await expect(
        invalid.acceptance.accept('design-1', { ...ACCEPT_REQUEST, obligationIds }, 'u1'),
      ).rejects.toThrow('graph-acceptance-obligation-invalid')
      expect(
        invalid.calls.filter((call) => !call.startsWith('stage') && call !== 'cleanup'),
      ).toEqual([])
    }
    const done = acceptanceHarness({
      records: [verificationRecord()],
      record: { status: 'completed', payloadJson: '{"done":true}' },
    })
    expect(await done.acceptance.accept('design-1', ACCEPT_REQUEST, 'u1')).toEqual({ done: true })
    expect(done.calls).toEqual(['stage /repo ' + 'a'.repeat(40), 'cleanup'])
    const accepted = acceptanceHarness({ records: [verificationRecord()] })
    const evidence = (await accepted.acceptance.accept('design-1', ACCEPT_REQUEST, 'u1')) as {
      id: string
      artifactRef: string
      recordedAt: number
    }
    expect([evidence.id, evidence.artifactRef, evidence.recordedAt]).toEqual([
      'acceptance:r1',
      'artifact-1',
      7,
    ])
    expect(accepted.calls).toEqual([
      'stage /repo ' + 'a'.repeat(40),
      'cleanup',
      `put acceptance.json=${canonicalJson({ ...ACCEPT_REQUEST, actorUserId: 'u1', recordedAt: 7 })}`,
      'link acceptance:r1',
      'finish completed',
      'changed case-1',
    ])
  })

  test('当前证据目标：暂存成功时清理一次（读环境摘要抛错也一样），暂存失败不清理；续作给出远端头', async () => {
    const ok = acceptanceHarness()
    expect(await ok.acceptance.currentEvidenceTarget('design-1')).toEqual({
      candidateTreeOid: TREE,
      commitSha: null,
      environmentDigest: ENVIRONMENT,
    })
    expect(ok.calls).toEqual(['stage /repo ' + 'a'.repeat(40), 'cleanup'])
    const broken = acceptanceHarness({
      environment: async () => {
        throw new Error('environment-unreadable')
      },
    })
    await expect(broken.acceptance.currentEvidenceTarget('design-1')).rejects.toThrow(
      'environment-unreadable',
    )
    expect(broken.calls).toEqual(['stage /repo ' + 'a'.repeat(40), 'cleanup'])
    const unstaged = acceptanceHarness({ stage: () => ({ ok: false }) })
    expect(await unstaged.acceptance.currentEvidenceTarget('design-1')).toMatchObject({
      candidateTreeOid: null,
    })
    expect(unstaged.calls).toEqual(['stage /repo ' + 'a'.repeat(40)])
    const continued = acceptanceHarness({
      continuation: async () => ({
        baselineRepoPath: '/mr',
        baseline: { kind: 'commit', commitSha: '1'.repeat(40) },
        workspacePath: '/mr-work',
        remoteHeadSha: '2'.repeat(40),
      }),
    })
    expect(await continued.acceptance.currentEvidenceTarget('design-1')).toMatchObject({
      commitSha: '2'.repeat(40),
    })
    expect(continued.calls[0]).toBe('stage /mr ' + '1'.repeat(40))
  })

  test('请求验证与档案列表：请求产物与验证工作照旧；两种列表只列已发布、未归档的档案', async () => {
    const { acceptance, calls } = acceptanceHarness()
    expect(await acceptance.requestVerification('design-1', 'req-1')).toMatchObject({
      request: {
        kind: 'verification',
        caseId: 'case-1',
        requestId: 'req-1',
        withdrawReview: false,
      },
    })
    expect(calls).toEqual([
      `put request.json=${canonicalJson({ requestId: 'req-1', designId: 'design-1' })}`,
      'work verification',
    ])
    expect(await acceptance.verificationProfiles()).toEqual([
      { id: 'p1', name: 'P1', revision: 2, digest: 'p1@2' },
    ])
    expect(await acceptance.exportBasis('design-1', 'basis-1')).toEqual([
      { path: 'design.md', digest: 'x' },
    ] as never)
    const profiles = {
      list: async () => [
        { id: 'p1', name: 'P1', publishedRevision: 2, archivedAt: null },
        { id: 'p2', name: 'P2', publishedRevision: 1, archivedAt: 5 },
      ],
      getRevision: async (id: string, revision: number) => ({
        revision,
        contentDigest: `${id}@${revision}`,
        contentJson: '{"steps":1}',
      }),
    }
    expect(await listGraphVerificationProfileContents(profiles as never)).toEqual([
      { id: 'p1', name: 'P1', revision: 2, digest: 'p1@2', content: { steps: 1 } },
    ])
  })
})
