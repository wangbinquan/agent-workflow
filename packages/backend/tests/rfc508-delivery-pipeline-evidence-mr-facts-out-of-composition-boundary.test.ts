// RFC-508 — 开发自动化的流水线证据端口与 MR 事实采集迁出 composition（RFC-294 S10 第十五步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里交出的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；两个新文件恰好声明、交出清单列的名字；两个组合文件只声明并导出
//    原有的装配入口，`pipelineEvidence.ts` 转出旧实现的两个名字不变。
// ② 两个组合文件没有 if / for / while / do / switch / try / throw 语句，也不再用迁走的代码要的暂存核对、摘要、投影与哈希；`Date.now` 只在
//    交给采集的时钟里出现一次；三个新入口在生产代码里都只在组合文件调用一次、实参逐字钉住；四个装配入口交出的对象字段不变（带负对照）。
// ③ 新代码的依赖面是闭集：两个新文件只取本模块的 domain、application（含 ports）与 `@/util/hash`，import 逐条钉住，不用进程全局；
//    新端口类型所在的 `reconcilerPorts.ts` 不取 integration（带负对照）。
// ④ 行为（直接调用新位置，端口用内存替身）：暂存工厂的核对、collect / trigger / rerun 的暂存生命周期与返回字段、MR 事实读取的映射、
//    MR 事实采集的四条错误与成功时的摘要、投影和线程摘要。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读两个组合文件、两个新位置与 `reconcilerPorts.ts`。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import {
  createDevelopmentMrFacts,
  createDevelopmentMrFactsCollector,
} from '@/modules/development-automation/application/developmentMrFacts'
import type {
  DevelopmentMrFactsSnapshot,
  DevelopmentMrFactsSourcePort,
} from '@/modules/development-automation/application/ports/developmentDelivery'
import type {
  EvidenceStagingFactory,
  EvidenceStagingLease,
  PipelineStagingFactories,
} from '@/modules/development-automation/application/ports/evidenceStaging'
import type { SelectedPipelineEvidenceRunnerPort } from '@/modules/development-automation/application/ports/reconcilerPorts'
import { createSelectedPipelineEvidence } from '@/modules/development-automation/application/selectedPipelineEvidence'
import { canonicalDigest } from '@/modules/development-automation/domain/canonicalJson'
import { projectMrCells } from '@/modules/development-automation/domain/mrFacts'
import { sha256Hex } from '@/util/hash'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const DA = 'modules/development-automation'
const PIPELINE = `${DA}/application/selectedPipelineEvidence`
const MR_FACTS = `${DA}/application/developmentMrFacts`
const PORTS = `${DA}/application/ports/reconcilerPorts`
const PIPELINE_ROOT = `${DA}/composition/pipelineEvidence`
const DELIVERY_ROOT = `${DA}/composition/developmentDelivery`

/** design §3: each new file and the names it declares and offers. */
const NEW_FILES: Readonly<Record<string, readonly string[]>> = {
  [PIPELINE]: ['createSelectedPipelineEvidence'],
  [MR_FACTS]: [
    'DevelopmentMrFactsCollectorDependencies',
    'DevelopmentMrFactsDependencies',
    'createDevelopmentMrFacts',
    'createDevelopmentMrFactsCollector',
  ],
}
/** design §3: every listed name with the one file that declares it (the port joins an existing file). */
const LISTED: readonly (readonly [string, string])[] = [
  ...Object.entries(NEW_FILES).flatMap(([location, names]) =>
    names.map((name) => [location, name] as const),
  ),
  [PORTS, 'SelectedPipelineEvidenceRunnerPort'],
]
const LOCATIONS = Object.keys(NEW_FILES)
/** design §3 / D4: what each composition file declares, offers and takes from the new locations. */
const ROOTS: Readonly<
  Record<
    string,
    {
      readonly declares: readonly string[]
      readonly offers: readonly string[]
      readonly takes: readonly string[]
    }
  >
> = {
  [PIPELINE_ROOT]: {
    declares: ['composeSelectedDevelopmentPipelineEvidence'],
    offers: [
      'LegacyPipelineEvidencePort',
      'composeLegacyDevelopmentPipelineEvidence',
      'composeSelectedDevelopmentPipelineEvidence',
    ],
    takes: [`import ${PIPELINE}: createSelectedPipelineEvidence`],
  },
  [DELIVERY_ROOT]: {
    // `composeDevelopmentPipelineDeps` is two overload signatures plus the implementation.
    declares: [
      'PipelineEvidenceExecution',
      'composeDevelopmentDeliveryDeps',
      'composeDevelopmentMrFactsCollector',
      'composeDevelopmentPipelineDeps',
      'composeDevelopmentPipelineDeps',
      'composeDevelopmentPipelineDeps',
    ],
    offers: [
      'composeDevelopmentDeliveryDeps',
      'composeDevelopmentMrFactsCollector',
      'composeDevelopmentPipelineDeps',
      'composeDevelopmentPipelineDeps',
      'composeDevelopmentPipelineDeps',
    ],
    takes: [`import ${MR_FACTS}: createDevelopmentMrFacts, createDevelopmentMrFactsCollector`],
  },
}
/** The single production call of each moved entry: where it is and its arguments (whitespace removed). */
const CALLS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  createSelectedPipelineEvidence: [PIPELINE_ROOT, ['runner', 'staging']],
  createDevelopmentMrFacts: [DELIVERY_ROOT, ['{mrFacts:deps.mrFacts}']],
  createDevelopmentMrFactsCollector: [
    DELIVERY_ROOT,
    ['{provider:deps.provider,mrFacts:deps.mrFacts,now:()=>Date.now(),}'],
  ],
}
/** The object each assembly entry returns: members in order with their initializer texts (whitespace removed). */
const RETURNS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  composeSelectedDevelopmentPipelineEvidence: [
    ['pipelineEvidence', 'createSelectedPipelineEvidence(runner,staging)'],
  ],
  composeDevelopmentDeliveryDeps: [
    ['repoRemote', '<shorthand>'],
    ['mrEffects', 'deps.mrEffects'],
    ['mrFacts', '<shorthand>'],
    [
      'pipelineEvidence',
      'composeDevelopmentPipelineDeps(provider.pipeline,deps.staging).pipelineEvidence',
    ],
  ],
  composeDevelopmentMrFactsCollector: [
    [
      'mergeRequestFacts',
      'createDevelopmentMrFactsCollector({provider:deps.provider,mrFacts:deps.mrFacts,now:()=>Date.now(),})',
    ],
  ],
}
/** design §4 ③: the exact imports of the two new files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [PIPELINE]: [
    `import ${DA}/application/ports/evidenceStaging: PipelineStagingFactories`,
    `import ${PORTS}: PipelineEvidencePort, SelectedPipelineEvidenceRunnerPort`,
    `import ${DA}/application/evidenceStaging: assertEvidenceStagingFactory, assertEvidenceStagingLease`,
  ],
  [MR_FACTS]: [
    `import ${DA}/domain/canonicalJson: canonicalDigest`,
    `import ${DA}/domain/mrFacts: projectMrCells`,
    `import ${DA}/application/ports/developmentDelivery: DevelopmentMrFactsSourcePort`,
    `import ${PORTS}: MergeRequestFactsCollectorPort`,
    'import util/hash: sha256Hex',
  ],
}
/** The allowed surface: this module's domain and application (ports included), and the hash helper. */
const SURFACE = (file: string, specifier: string): boolean => {
  const resolved = resolveSpecifier(file, specifier)
  return (
    resolved !== null &&
    (resolved === 'util/hash' ||
      resolved.startsWith(`${DA}/domain/`) ||
      resolved.startsWith(`${DA}/application/`))
  )
}
/** The port file may take anything it took before, but nothing from integration (design D2). */
const NOT_INTEGRATION = (file: string, specifier: string): boolean =>
  !(resolveSpecifier(file, specifier) ?? specifier).startsWith('modules/integration')
/** Edges whose source is one of the new locations (the files' other edges are not on this RFC's list). */
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
/** The helpers the moved code used; none may remain in the composition files (design §4 ②). */
const MOVED_HELPERS = [
  'assertEvidenceStagingFactory',
  'assertEvidenceStagingLease',
  'canonicalDigest',
  'projectMrCells',
  'sha256Hex',
]
/**
 * Control-flow statements anywhere in the file (design §3; stricter than the F13 line-start count), any identifier the
 * moved code needed (the staging checks, the digest, the cell projection, the hash) and every `Date.now` read.
 */
function implementationShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (ts.isIdentifier(node) && MOVED_HELPERS.includes(node.text)) out.push(node.text)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      node.name.text === 'now'
    )
      out.push('Date.now')
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

/** The object literal returned at the top level of function `name`: members in order with initializer texts. */
function returnedMembers(path: string, source: string, name: string): [string, string][] {
  const file = parse(path, source)
  const out: [string, string][][] = []
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== name || !statement.body)
      continue
    for (const inner of statement.body.statements)
      if (
        ts.isReturnStatement(inner) &&
        inner.expression !== undefined &&
        ts.isObjectLiteralExpression(inner.expression)
      )
        out.push(
          inner.expression.properties.map((property): [string, string] => [
            property.name !== undefined && ts.isIdentifier(property.name)
              ? property.name.text
              : '?',
            ts.isPropertyAssignment(property)
              ? property.initializer.getText(file).replace(/\s+/g, '')
              : ts.isShorthandPropertyAssignment(property)
                ? '<shorthand>'
                : '<method>',
          ]),
        )
  }
  return out.length === 1 ? out[0]! : []
}

describe('RFC-508 ① 清单里的名字只在各自的位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个交出的名字只在它的位置声明（语料下限 3,000 / 2,500）',
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
      expect(LISTED).toHaveLength(6)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('两个新文件恰好声明、交出清单列的名字；两个组合文件只声明并导出原有的装配入口，转出的名字不变', () => {
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
    for (const [location, root] of Object.entries(ROOTS)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...root.declares].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...root.offers].sort(),
      ])
    }
    const ports = sourceOf(PORTS)
    expect(offeredNames(ports, text(ports))).toContain('SelectedPipelineEvidenceRunnerPort')
  })
})

describe('RFC-508 ② composition 只装配', () => {
  test('两个组合文件没有控制流语句、不再用迁走的代码要的名字，时钟只交给采集一次；从新位置取实现，交出的对象字段不变', () => {
    expect(implementationShapes(sourceOf(PIPELINE_ROOT), text(sourceOf(PIPELINE_ROOT)))).toEqual([])
    expect(implementationShapes(sourceOf(DELIVERY_ROOT), text(sourceOf(DELIVERY_ROOT)))).toEqual([
      'Date.now',
    ])
    for (const [location, root] of Object.entries(ROOTS)) {
      const path = sourceOf(location)
      expect([location, edgesToLocations(moduleEdges(path, text(path)))]).toEqual([
        location,
        [...root.takes],
      ])
    }
    for (const [name, members] of Object.entries(RETURNS)) {
      const location =
        name === 'composeSelectedDevelopmentPipelineEvidence' ? PIPELINE_ROOT : DELIVERY_ROOT
      const path = sourceOf(location)
      expect([name, returnedMembers(path, text(path), name)]).toEqual([
        name,
        members.map(([member, initializer]) => [member, initializer]),
      ])
    }
  })

  test(
    '三个新入口在生产代码里都只在组合文件调用一次，实参逐字钉住',
    () => {
      for (const [name, [location, args]] of Object.entries(CALLS)) {
        expect([name, productionCallers(name)]).toEqual([name, [`${location} x1`]])
        const path = sourceOf(location)
        expect([name, callArguments(path, text(path), name)]).toEqual([name, [[...args]]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：控制流语句、迁走的名字、多读的时钟、别处的 import、改动的字段与多余的调用都会被认出', () => {
    const probe = join(SRC, `${DA}/composition/probe.ts`)
    const source = [
      `import { createSelectedPipelineEvidence } from '../application/selectedPipelineEvidence'`,
      `import { createDevelopmentMrFacts } from '@/${MR_FACTS}'`,
      `import { assertEvidenceStagingLease } from '../application/evidenceStaging'`,
      `import { canonicalDigest } from '../domain/canonicalJson'`,
      `export function compose(runner: never, staging: never, deps: { mrFacts: never }) {`,
      `  for (const factory of [staging]) if (!factory) throw new Error('x')`,
      `  while (deps) break`,
      `  switch (deps) { default: break }`,
      `  try { void Date.now() } finally { void canonicalDigest }`,
      `  void [assertEvidenceStagingLease, Date.now()]`,
      `  return { pipelineEvidence: createSelectedPipelineEvidence(staging, runner), mrFacts: createDevelopmentMrFacts(deps), async extra() { return createDevelopmentMrFacts(deps) } }`,
      `}`,
    ].join('\n')
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${PIPELINE}: createSelectedPipelineEvidence`,
      `import ${MR_FACTS}: createDevelopmentMrFacts`,
    ])
    expect(implementationShapes(probe, source)).toEqual([
      'assertEvidenceStagingLease',
      'canonicalDigest',
      'for-of',
      'if',
      'throw',
      'while',
      'switch',
      'try',
      'Date.now',
      'canonicalDigest',
      'assertEvidenceStagingLease',
      'Date.now',
    ])
    expect(returnedMembers(probe, source, 'compose')).toEqual([
      ['pipelineEvidence', 'createSelectedPipelineEvidence(staging,runner)'],
      ['mrFacts', 'createDevelopmentMrFacts(deps)'],
      ['extra', '<method>'],
    ])
    expect(callArguments(probe, source, 'createDevelopmentMrFacts')).toHaveLength(2)
    expect(callArguments(probe, source, 'createSelectedPipelineEvidence')).toEqual([
      ['staging', 'runner'],
    ])
    // The pinned wiring tells the clock apart from a captured time and from a detached source.
    const pinned = CALLS.createDevelopmentMrFactsCollector![1][0]!
    for (const variant of [
      pinned.replace('now:()=>Date.now()', 'now:Date.now'),
      pinned.replace('mrFacts:deps.mrFacts', 'mrFacts:deps'),
    ])
      expect(variant).not.toBe(pinned)
  })
})

describe('RFC-508 ③ 新代码的依赖面是闭集、不用进程全局', () => {
  test('两个新文件的 import 逐条与清单相同，都在允许的面内，不用进程全局；端口文件不取 integration', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect([location, purityFindings(path, text(path), SURFACE, true)]).toEqual([location, []])
    }
    const ports = sourceOf(PORTS)
    expect(purityFindings(ports, text(ports), NOT_INTEGRATION, false)).toEqual([])
  })

  test('负对照：越界 import、多出的 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${MR_FACTS}.ts`)
    const source = [
      `import { canonicalDigest } from '../domain/canonicalJson'`,
      `import type { MergeRequestFactsCollectorPort } from './ports/reconcilerPorts'`,
      `import { sha256Hex } from '@/util/hash'`,
      `import type { SelectedPipelineEvidenceExecution } from '@/modules/integration/public/participants'`,
      `import type { DevelopmentDeliveryProvider } from '../infrastructure/developmentDeliveryProvider'`,
      `import { composeDevelopmentDeliveryDeps } from '../composition/developmentDelivery'`,
      `import { readFileSync } from 'node:fs'`,
      `import type { PersistenceDb } from '@/platform/persistence/persistenceDb'`,
      `export async function run() { await import('node:child_process'); const at = Date.now(); const env = process.env; await fetch('x'); Math.random() }`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE, true)).toEqual([
      'import @/modules/integration/public/participants',
      'import ../infrastructure/developmentDeliveryProvider',
      'import ../composition/developmentDelivery',
      'import node:fs',
      'import @/platform/persistence/persistenceDb',
      'import() node:child_process',
      'Date.now',
      'process.env',
      'fetch',
      'Math.random',
    ])
    expect(moduleEdges(file, source)).not.toEqual(IMPORTS[MR_FACTS])
    expect(purityFindings(sourceOf(PORTS), source, NOT_INTEGRATION, false)).toEqual([
      'import @/modules/integration/public/participants',
    ])
  })
})

// ④ Behaviour, through the new locations with in-memory ports.

type Lease = EvidenceStagingLease & { readonly name: string }

function stagingFixture(
  options: {
    readonly asyncCreate?: boolean
    readonly asyncClose?: boolean
    readonly foreign?: 'collect' | 'trigger' | 'rerun'
  } = {},
) {
  const log: string[] = []
  const factory = (name: 'collect' | 'trigger' | 'rerun'): EvidenceStagingFactory => {
    const namespace = { kind: 'evidence-staging-namespace' as const, reference: { name } }
    const leaseNamespace =
      options.foreign === name
        ? { kind: 'evidence-staging-namespace' as const, reference: { name: 'other' } }
        : namespace
    const lease = (): Lease => ({
      name,
      reference: {
        kind: 'evidence-staging',
        namespace: leaseNamespace,
        reference: { lease: name },
      },
      writeText: () => undefined,
      importTree: () => ({}) as never,
      putDocument: () => ({ sha256: 'a'.repeat(64), bytes: 0 }),
      close: () => {
        log.push(`close ${name}`)
        if (!options.asyncClose) return undefined
        return Promise.resolve().then(() => {
          log.push(`closed ${name}`)
        })
      },
    })
    return {
      namespace,
      create: () => {
        log.push(`create ${name}`)
        return (options.asyncCreate ? Promise.resolve(lease()) : lease()) as never
      },
    } as EvidenceStagingFactory
  }
  const staging: PipelineStagingFactories = {
    collect: factory('collect'),
    trigger: factory('trigger'),
    rerun: factory('rerun'),
  }
  return { staging, log }
}

const FAILURE = { code: 'adapter-failed' } as never
const ENVELOPE = { providerKey: 'ci' } as never
const BUDGET = { maxFiles: 1, maxFileBytes: 2, maxTotalBytes: 3 }
const COLLECT_INPUT = {
  adapterBindingRef: 'binding@1',
  headSha: 'a'.repeat(40),
  targetSha: 'b'.repeat(40),
  gateKeys: ['build'],
}
const TRIGGER_INPUT = {
  adapterBindingRef: 'binding@1',
  headSha: 'a'.repeat(40),
  gateKeys: ['build'],
  idempotencyKey: 'key-1',
}
const RERUN_INPUT = {
  adapterBindingRef: 'binding@1',
  runRef: 'run-1',
  gateKey: 'build',
  headSha: 'a'.repeat(40),
  idempotencyKey: 'key-2',
}

function runnerFixture(
  log: string[],
  outcome: 'ok' | 'failed' | 'throws',
): SelectedPipelineEvidenceRunnerPort {
  const answer = async <T>(name: string, input: { readonly staging: unknown }, ok: T) => {
    log.push(`${name} ${JSON.stringify((input.staging as { reference: unknown }).reference)}`)
    if (outcome === 'throws') throw new Error(`${name}-boom`)
    return outcome === 'ok' ? ok : { ok: false as const, failure: FAILURE }
  }
  return {
    collect: (input) =>
      answer('collect', input, { ok: true as const, envelope: ENVELOPE, outputBudget: BUDGET }),
    trigger: (input) =>
      answer('trigger', input, {
        ok: true as const,
        envelope: { runRef: 'run-9', providerReceiptRef: 'receipt-9', adopted: true },
      }),
    rerun: (input) =>
      answer('rerun', input, {
        ok: true as const,
        envelope: { runRef: 'run-1', attempt: 2, providerReceiptRef: 'receipt-2' },
      }),
  }
}

describe('RFC-508 ④ 流水线证据端口（选定实现）', () => {
  test('三个暂存工厂在创建时逐个核对，任一不合格就抛', () => {
    const { staging, log } = stagingFixture()
    expect(() => createSelectedPipelineEvidence(runnerFixture(log, 'ok'), staging)).not.toThrow()
    for (const name of ['collect', 'trigger', 'rerun'] as const)
      expect(() =>
        createSelectedPipelineEvidence(runnerFixture(log, 'ok'), {
          ...staging,
          [name]: { namespace: staging[name].namespace } as never,
        }),
      ).toThrow('evidence-staging-factory-incomplete')
    expect(log).toEqual([])
  })

  test('collect 成功时交出原 envelope、暂存与输出预算，不关闭暂存；cleanup 关闭它', async () => {
    const { staging, log } = stagingFixture({ asyncCreate: true })
    const port = createSelectedPipelineEvidence(runnerFixture(log, 'ok'), staging)
    const out = await port.collect(COLLECT_INPUT)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.envelope).toBe(ENVELOPE)
    expect(out.outputBudget).toBe(BUDGET)
    expect((out.staging as Lease).name).toBe('collect')
    expect(log).toEqual(['create collect', 'collect {"lease":"collect"}'])
    await out.cleanup()
    expect(log).toEqual(['create collect', 'collect {"lease":"collect"}', 'close collect'])
  })

  test('collect 失败时先关闭暂存（等异步关闭完成）再返回原失败', async () => {
    const { staging, log } = stagingFixture({ asyncClose: true })
    const port = createSelectedPipelineEvidence(runnerFixture(log, 'failed'), staging)
    const out = await port.collect(COLLECT_INPUT)
    log.push('returned')
    expect(out).toEqual({ ok: false, failure: FAILURE })
    expect(log).toEqual([
      'create collect',
      'collect {"lease":"collect"}',
      'close collect',
      'closed collect',
      'returned',
    ])
  })

  test('暂存不属于该工厂的命名空间时抛错，不调用执行面', async () => {
    for (const name of ['collect', 'trigger', 'rerun'] as const) {
      const { staging, log } = stagingFixture({ foreign: name })
      const port = createSelectedPipelineEvidence(runnerFixture(log, 'ok'), staging)
      const call =
        name === 'collect'
          ? port.collect(COLLECT_INPUT)
          : name === 'trigger'
            ? port.trigger(TRIGGER_INPUT)
            : port.rerun(RERUN_INPUT)
      await expect(call).rejects.toThrow('evidence-staging-namespace-mismatch')
      expect(log).toEqual([`create ${name}`])
    }
  })

  test('trigger 与 rerun 成功时返回 envelope 对应的字段，并关闭暂存一次', async () => {
    const { staging, log } = stagingFixture({ asyncCreate: true, asyncClose: true })
    const port = createSelectedPipelineEvidence(runnerFixture(log, 'ok'), staging)
    expect(await port.trigger(TRIGGER_INPUT)).toEqual({
      ok: true,
      runRef: 'run-9',
      providerReceiptRef: 'receipt-9',
      adopted: true,
    })
    expect(await port.rerun(RERUN_INPUT)).toEqual({
      ok: true,
      runRef: 'run-1',
      attempt: 2,
      providerReceiptRef: 'receipt-2',
    })
    expect(log).toEqual([
      'create trigger',
      'trigger {"lease":"trigger"}',
      'close trigger',
      'closed trigger',
      'create rerun',
      'rerun {"lease":"rerun"}',
      'close rerun',
      'closed rerun',
    ])
  })

  test('trigger 与 rerun 失败时返回原失败，执行面抛错时原样抛出；两种情况都关闭暂存一次', async () => {
    const failed = stagingFixture()
    const port = createSelectedPipelineEvidence(runnerFixture(failed.log, 'failed'), failed.staging)
    expect(await port.trigger(TRIGGER_INPUT)).toEqual({ ok: false, failure: FAILURE })
    expect(await port.rerun(RERUN_INPUT)).toEqual({ ok: false, failure: FAILURE })
    expect(failed.log.filter((line) => line.startsWith('close'))).toEqual([
      'close trigger',
      'close rerun',
    ])
    const thrown = stagingFixture({ asyncClose: true })
    const throwing = createSelectedPipelineEvidence(
      runnerFixture(thrown.log, 'throws'),
      thrown.staging,
    )
    await expect(throwing.trigger(TRIGGER_INPUT)).rejects.toThrow('trigger-boom')
    await expect(throwing.rerun(RERUN_INPUT)).rejects.toThrow('rerun-boom')
    expect(thrown.log.filter((line) => line.startsWith('close'))).toEqual([
      'close trigger',
      'closed trigger',
      'close rerun',
      'closed rerun',
    ])
  })
})

const thread = (
  threadRef: string,
  authorClass: 'human' | 'bot' | 'self',
  resolved: boolean,
  lastBody: string,
) => ({
  threadRef,
  revision: `${threadRef}@1`,
  authorClass,
  resolved,
  lastBody,
  path: resolved ? null : 'src/a.ts',
  messages: [
    {
      messageRef: `${threadRef}-m1`,
      parentMessageRef: null,
      authorClass,
      body: lastBody,
      path: null,
      createdAt: null,
    },
  ],
})
const SNAPSHOT: DevelopmentMrFactsSnapshot = {
  mrRef: '7',
  headSha: 'c'.repeat(40),
  targetSha: 'd'.repeat(40),
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  mergeableState: 'mergeable',
  approvalHold: null,
  mergedCommitSha: null,
  mergedAt: null,
  threads: [
    thread('t1', 'human', false, 'please rename'),
    thread('t2', 'human', true, 'done'),
    thread('t3', 'self', false, 'bot reply'),
    thread('t4', 'bot', false, 'lint'),
  ],
}

function sourceFixture(
  answer: Awaited<ReturnType<DevelopmentMrFactsSourcePort['collect']>>,
): DevelopmentMrFactsSourcePort & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    collect: async (repositoryId, mrRef, options) => {
      calls.push(`${repositoryId} ${mrRef} ${options.selfMarker}`)
      return answer
    },
  }
}

describe('RFC-508 ④ MR 事实读取', () => {
  test('失败原样返回', async () => {
    const failure = { ok: false as const, code: 'code-host-connection-missing', detail: 'none' }
    const source = sourceFixture(failure)
    expect(await createDevelopmentMrFacts({ mrFacts: source }).collect('repo-1', '7', 'm1')).toBe(
      failure,
    )
    expect(source.calls).toEqual(['repo-1 7 m1'])
  })

  test('成功时映射快照，未解决计数不含已解决与自己的线程，线程正文取最后一条', async () => {
    const source = sourceFixture({ ok: true, snapshot: SNAPSHOT })
    const out = await createDevelopmentMrFacts({ mrFacts: source }).collect('repo-1', '7', 'm1')
    expect(out).toEqual({
      ok: true,
      snapshot: {
        state: 'opened',
        headSha: SNAPSHOT.headSha,
        targetSha: SNAPSHOT.targetSha,
        targetBranch: 'main',
        draft: false,
        mergeableState: 'mergeable',
        approvalHold: null,
        mergedCommitSha: null,
        unresolvedReviewCount: 2,
        reviewThreads: SNAPSHOT.threads.map((item) => ({
          threadRef: item.threadRef,
          revision: item.revision,
          authorClass: item.authorClass,
          resolved: item.resolved,
          body: item.lastBody,
          path: item.path,
          messages: item.messages,
        })),
      },
    })
  })
})

describe('RFC-508 ④ MR 事实采集', () => {
  const NOW = 1_700_000_000_000
  const collector = (
    source: DevelopmentMrFactsSourcePort,
    target: { readonly repositoryId: string; readonly mrIid: string } | null = {
      repositoryId: 'repo-1',
      mrIid: '7',
    },
  ) => {
    const reads: string[] = []
    let clock = 0
    const port = createDevelopmentMrFactsCollector({
      provider: {
        readMrFactTarget: async (input) => {
          reads.push(`${input.missionId} ${input.mrClaimId}`)
          return target
        },
      },
      mrFacts: source,
      now: () => {
        clock += 1
        return NOW
      },
    })
    return { port, reads, clockReads: () => clock }
  }

  test('四条错误文案逐字不变', async () => {
    const ok = sourceFixture({ ok: true, snapshot: SNAPSHOT })
    await expect(collector(ok).port.collect({ missionId: 'm1', mrClaimId: null })).rejects.toThrow(
      /^mission m1 has no MR claim to collect facts for$/,
    )
    await expect(
      collector(ok, null).port.collect({ missionId: 'm1', mrClaimId: 'c1' }),
    ).rejects.toThrow(/^mr claim c1 or mission not found$/)
    const missing = sourceFixture({ ok: false, code: 'code-host-connection-missing', detail: 'x' })
    await expect(
      collector(missing).port.collect({ missionId: 'm1', mrClaimId: 'c1' }),
    ).rejects.toThrow(/^no code-host binding for repository repo-1$/)
    const other = sourceFixture({ ok: false, code: 'rate-limited', detail: 'retry later' })
    await expect(
      collector(other).port.collect({ missionId: 'm1', mrClaimId: 'c1' }),
    ).rejects.toThrow(/^mr facts collect failed: rate-limited: retry later$/)
  })

  test('成功时快照摘要、按同一时钟投影的事实格与线程摘要和此前相同', async () => {
    const source = sourceFixture({ ok: true, snapshot: SNAPSHOT })
    const { port, reads, clockReads } = collector(source)
    const out = await port.collect({ missionId: 'm1', mrClaimId: 'c1' })
    const snapshotRef = canonicalDigest(SNAPSHOT)
    expect(reads).toEqual(['m1 c1'])
    expect(source.calls).toEqual(['repo-1 7 m1'])
    expect(clockReads()).toBe(1)
    expect(out).toEqual({
      cells: projectMrCells({ ...SNAPSHOT, headSha: SNAPSHOT.headSha! }, 0, snapshotRef, NOW),
      snapshotRef,
      headSha: SNAPSHOT.headSha,
      targetSha: SNAPSHOT.targetSha,
      threads: SNAPSHOT.threads.map((item) => ({
        threadRef: item.threadRef,
        revision: item.revision,
        authorClass: item.authorClass,
        resolved: item.resolved,
        bodyDigest: sha256Hex(item.lastBody),
        body: item.lastBody,
        path: item.path,
      })),
    })
    expect(Object.keys(out.cells).length).toBeGreaterThan(0)
  })

  test('没有头提交时事实格为空，摘要仍取整个快照', async () => {
    const headless = { ...SNAPSHOT, headSha: null }
    const out = await collector(sourceFixture({ ok: true, snapshot: headless })).port.collect({
      missionId: 'm1',
      mrClaimId: 'c1',
    })
    expect(out.cells).toEqual({})
    expect(out.snapshotRef).toBe(canonicalDigest(headless))
    expect(out.headSha).toBeNull()
  })
})
