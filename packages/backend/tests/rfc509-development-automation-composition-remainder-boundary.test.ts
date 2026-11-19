// RFC-509 — 开发自动化组合层的非 RFC-370 余项迁出 composition（RFC-294 S10 第十六步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；四个新文件恰好声明、交出清单列的名字，两个既有文件交出新增的名字；6 个
//    组合文件只声明并导出原有的装配入口、转出原有的名字（`activityOperations.ts` 运行时只导出装配入口）。
// ② 6 个组合文件的形状：控制流只剩 `evidenceStaging.ts` 的一处选定或本地选择；不再用迁走的代码要的 zod、JSON、上下文 schema 与核对函数；
//    `ulid` 与 `Date.now` 只在交给终态唤醒的两个函数里各一次；新入口在生产代码里只在各自的组合文件调用一次、实参逐字钉住（带负对照）。
// ③ 新代码的依赖面是闭集：四个新文件只取本模块的 domain、application（含 ports）、zod 与 digital-employee 的 public types；两个既有文件的
//    import 逐条钉住；都不用进程全局（带负对照）。
// ④ 行为（直接调用新位置，端口用内存替身）：活动周期的先后次序、终态唤醒、选定内容核对、案例详情投影、作业模板、类型包与编解码。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读 6 个组合文件与 6 个新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import {
  createDevelopmentActivityWorkerCycle,
  type DevelopmentActivityWorker,
} from '@/modules/development-automation/application/activityOperations'
import {
  createDevelopmentEmployeeCaseDetailProjection,
  projectDevelopmentEmployeeCaseDetail,
} from '@/modules/development-automation/application/employeeCaseDetailProjection'
import { mergeRequestLifecycleDescriptor } from '@/modules/development-automation/application/employeeTypePackage'
import { selectedRequirementMaterializerContent } from '@/modules/development-automation/application/evidenceStaging'
import { createMissionExecutionTerminalObserver } from '@/modules/development-automation/application/executionTerminalObserver'
import {
  buildGraphDeliveryJobs,
  GRAPH_MR_JOB_ID,
  GRAPH_MR_PIPELINE_JOB_ID,
} from '@/modules/development-automation/application/graph-development/deliveryJobs'
import {
  createGraphDeliveryLifecycleRuntimeCodec,
  createGraphDeliveryLifecycleTypePackage,
  GRAPH_DELIVERY_EMPLOYEE_TYPE,
  type GraphDeliveryLifecycleRuntimeCodec,
} from '@/modules/development-automation/application/graph-development/deliveryLifecycle'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type { EvidenceStagingFactory } from '@/modules/development-automation/application/ports/evidenceStaging'
import * as activityRoot from '@/modules/development-automation/composition/activityOperations'
import type {
  EmployeeCaseDetailProjectionInputV1,
  EmployeeTypePackageRegistration,
} from '@/modules/digital-employee/public/types'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const DA = 'modules/development-automation'
const LIFECYCLE = `${DA}/application/graph-development/deliveryLifecycle`
const JOBS = `${DA}/application/graph-development/deliveryJobs`
const PROJECTION = `${DA}/application/employeeCaseDetailProjection`
const OBSERVER = `${DA}/application/executionTerminalObserver`
const ACTIVITY = `${DA}/application/activityOperations`
const STAGING = `${DA}/application/evidenceStaging`
const LIFECYCLE_ROOT = `${DA}/composition/graphDeliveryLifecycle`
const JOB_ROOT = `${DA}/composition/graphDeliveryJob`
const ACTIVITY_ROOT = `${DA}/composition/activityOperations`
const STAGING_ROOT = `${DA}/composition/evidenceStaging`
const PROJECTION_ROOT = `${DA}/composition/employeeCaseDetailProjection`
const OBSERVER_ROOT = `${DA}/composition/executionTerminalObserver`

/** design §3: each new file with every top-level name it declares and the names it offers. */
const NEW_FILES: Readonly<
  Record<string, { readonly declares: readonly string[]; readonly offers: readonly string[] }>
> = {
  [LIFECYCLE]: {
    declares: [
      'RuntimeCodec',
      'recordSchema',
      'coreDescriptorSchema',
      'GRAPH_DELIVERY_EMPLOYEE_TYPE',
      'GraphDeliveryLifecycleRuntimeCodec',
      'createGraphDeliveryLifecycleTypePackage',
      'typeRefSchema',
      'initialRequestSchema',
      'launchSchema',
      'createGraphDeliveryLifecycleRuntimeCodec',
    ],
    offers: [
      'GRAPH_DELIVERY_EMPLOYEE_TYPE',
      'GraphDeliveryLifecycleRuntimeCodec',
      'createGraphDeliveryLifecycleTypePackage',
      'createGraphDeliveryLifecycleRuntimeCodec',
    ],
  },
  [JOBS]: {
    declares: [
      'GRAPH_MR_JOB_ID',
      'GRAPH_MR_PIPELINE_JOB_ID',
      'exactRef',
      'routeSchema',
      'catalogToolSchema',
      'buildGraphDeliveryJobs',
    ],
    offers: ['GRAPH_MR_JOB_ID', 'GRAPH_MR_PIPELINE_JOB_ID', 'buildGraphDeliveryJobs'],
  },
  [PROJECTION]: {
    declares: [
      'DetailContext',
      'latestContext',
      'parseVersionOneContext',
      'unknownInput',
      'projectDevelopmentEmployeeCaseDetail',
      'createDevelopmentEmployeeCaseDetailProjection',
    ],
    offers: [
      'projectDevelopmentEmployeeCaseDetail',
      'createDevelopmentEmployeeCaseDetailProjection',
    ],
  },
  [OBSERVER]: {
    declares: [
      'DevelopmentMissionExecutionTerminalObserver',
      'DevelopmentMissionExecutionTerminalObserverDependencies',
      'createMissionExecutionTerminalObserver',
    ],
    offers: [
      'DevelopmentMissionExecutionTerminalObserver',
      'DevelopmentMissionExecutionTerminalObserverDependencies',
      'createMissionExecutionTerminalObserver',
    ],
  },
}
/** design §3: the names the two existing application files gain. */
const JOINED: Readonly<Record<string, readonly string[]>> = {
  [ACTIVITY]: ['DevelopmentActivityWorker', 'createDevelopmentActivityWorkerCycle'],
  [STAGING]: ['selectedRequirementMaterializerContent'],
}
/**
 * Every listed name with the one file that declares it. `typeRefSchema` is left out: digital-employee declares a
 * schema of the same name of its own.
 */
const LISTED: readonly (readonly [string, string])[] = [
  ...Object.entries(NEW_FILES).flatMap(([location, file]) =>
    file.declares
      .filter((name) => name !== 'typeRefSchema')
      .map((name) => [location, name] as const),
  ),
  ...Object.entries(JOINED).flatMap(([location, names]) =>
    names.map((name) => [location, name] as const),
  ),
]
const LOCATIONS = [...Object.keys(NEW_FILES), ...Object.keys(JOINED)]
/** design §3 / D4: what each composition file declares, offers and takes from the new locations. */
const ROOTS: Readonly<
  Record<
    string,
    {
      readonly declares: readonly string[]
      readonly offers: readonly string[]
      readonly takes: readonly string[]
      readonly shapes: readonly string[]
    }
  >
> = {
  [LIFECYCLE_ROOT]: {
    declares: [
      'composeGraphDeliveryLifecycleTypePackage',
      'composeGraphDeliveryLifecycleRuntimeCodec',
    ],
    offers: [
      'GRAPH_DELIVERY_EMPLOYEE_TYPE',
      'composeGraphDeliveryLifecycleTypePackage',
      'composeGraphDeliveryLifecycleRuntimeCodec',
    ],
    takes: [
      `import ${LIFECYCLE}: createGraphDeliveryLifecycleRuntimeCodec, createGraphDeliveryLifecycleTypePackage, GraphDeliveryLifecycleRuntimeCodec`,
      `export ${LIFECYCLE}: GRAPH_DELIVERY_EMPLOYEE_TYPE`,
    ],
    shapes: [],
  },
  [JOB_ROOT]: {
    declares: [],
    offers: ['buildGraphDeliveryJobs', 'GRAPH_MR_JOB_ID', 'GRAPH_MR_PIPELINE_JOB_ID'],
    takes: [`export ${JOBS}: buildGraphDeliveryJobs, GRAPH_MR_JOB_ID, GRAPH_MR_PIPELINE_JOB_ID`],
    shapes: [],
  },
  [ACTIVITY_ROOT]: {
    declares: ['composeDevelopmentActivityOperations'],
    offers: ['DevelopmentActivityWorker', 'composeDevelopmentActivityOperations'],
    takes: [
      `import ${ACTIVITY}: createDevelopmentActivityWorkerCycle, DevelopmentActivityWorker`,
      `export ${ACTIVITY}: DevelopmentActivityWorker`,
    ],
    shapes: [],
  },
  [STAGING_ROOT]: {
    declares: ['composeRequirementMaterializerContent'],
    offers: [
      'createLocalEvidenceArtifactPort',
      'createLocalGraphDevelopmentArtifactPort',
      'createLocalEvidenceStagingFactory',
      'createLocalEvidenceStagingNamespace',
      'LocalEvidenceStagingNamespace',
      'EvidenceStagingFactory',
      'EvidenceStagingLease',
      'EvidenceStagingNamespace',
      'EvidenceStagingReference',
      'composeRequirementMaterializerContent',
      'createFileEvidenceDocumentCommands',
      'createFileEvidenceDocumentCommandsOnFirstWrite',
    ],
    takes: [`import ${STAGING}: selectedRequirementMaterializerContent`],
    // The assembly-time choice between the selected and the local content (design D2).
    shapes: ['if'],
  },
  [PROJECTION_ROOT]: {
    declares: ['composeDevelopmentEmployeeCaseDetailProjection'],
    offers: [
      'projectDevelopmentEmployeeCaseDetail',
      'composeDevelopmentEmployeeCaseDetailProjection',
    ],
    takes: [
      `import ${PROJECTION}: createDevelopmentEmployeeCaseDetailProjection`,
      `export ${PROJECTION}: projectDevelopmentEmployeeCaseDetail`,
    ],
    shapes: [],
  },
  [OBSERVER_ROOT]: {
    declares: ['createDevelopmentMissionExecutionTerminalObserver'],
    offers: [
      'DevelopmentMissionExecutionTerminalObserver',
      'createDevelopmentMissionExecutionTerminalObserver',
    ],
    takes: [
      `import ${OBSERVER}: createMissionExecutionTerminalObserver, DevelopmentMissionExecutionTerminalObserver`,
      `export ${OBSERVER}: DevelopmentMissionExecutionTerminalObserver`,
    ],
    // The id and the clock handed to the wake, once each (design D4).
    shapes: ['ulid()', 'Date.now'],
  },
}
/** The single production call of each new entry: where it is and its arguments (whitespace removed). */
const CALLS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  createGraphDeliveryLifecycleTypePackage: [
    LIFECYCLE_ROOT,
    ['core', 'developmentEmployeeTypePackage'],
  ],
  createGraphDeliveryLifecycleRuntimeCodec: [LIFECYCLE_ROOT, ['core']],
  createDevelopmentActivityWorkerCycle: [ACTIVITY_ROOT, ['worker']],
  selectedRequirementMaterializerContent: [
    STAGING_ROOT,
    ['{staging:input.staging,documentCommands:input.documentCommands,}'],
  ],
  createDevelopmentEmployeeCaseDetailProjection: [PROJECTION_ROOT, ['workspaces']],
  createMissionExecutionTerminalObserver: [
    OBSERVER_ROOT,
    [
      '{store:createMissionPersistence(deps.db),missionIdOfExecutionRef:(executionRef)=>missionIdOfExecutionRef(deps.db,executionRef),drive:deps.drive,newId:()=>ulid(),now:()=>Date.now(),}',
    ],
  ],
}
/** The assembly entries that are a single `return <new entry>(…)` (design D4). */
const SINGLE_RETURN: Readonly<Record<string, readonly [string, string]>> = {
  composeGraphDeliveryLifecycleTypePackage: [
    LIFECYCLE_ROOT,
    'createGraphDeliveryLifecycleTypePackage',
  ],
  composeGraphDeliveryLifecycleRuntimeCodec: [
    LIFECYCLE_ROOT,
    'createGraphDeliveryLifecycleRuntimeCodec',
  ],
  composeDevelopmentActivityOperations: [ACTIVITY_ROOT, 'createDevelopmentActivityWorkerCycle'],
  composeDevelopmentEmployeeCaseDetailProjection: [
    PROJECTION_ROOT,
    'createDevelopmentEmployeeCaseDetailProjection',
  ],
  createDevelopmentMissionExecutionTerminalObserver: [
    OBSERVER_ROOT,
    'createMissionExecutionTerminalObserver',
  ],
}
/** design §4 ③: the exact imports of the four new files and the two joined files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [LIFECYCLE]: [
    'import zod: z',
    'import modules/digital-employee/public/types: EmployeeTypeCollaborationCodec, EmployeeTypeContextCodec, EmployeeTypePackageRegistration, EmployeeTypeReactionCodec',
    `import ${DA}/domain/mergeRequestLifecycle: isMergeRequestLifecycleWorkItem`,
    `import ${DA}/application/employeeTypePackage: issueHandlingContextSchema, mergeRequestLifecycleDescriptor, mergeRequestLifecycleRuntimeCodec`,
  ],
  [JOBS]: [
    'import zod: z',
    'import modules/digital-employee/public/types: DigitalEmployeePlatformToolCatalogParticipant',
    `import ${LIFECYCLE}: GRAPH_DELIVERY_EMPLOYEE_TYPE`,
  ],
  [PROJECTION]: [
    'import modules/digital-employee/public/types: EmployeeCaseDetailProjectionInputV1, EmployeeCaseDetailProjectionParticipant, EmployeeCaseDetailInputProjection',
    `import ${DA}/application/employeeWorkspace: DevelopmentEmployeeCaseWorkspaceDetailReader, DevelopmentEmployeeCaseWorkspaceDetailRow`,
    `import ${DA}/application/employeeTypePackage: changeCandidateContextSchema, issueHandlingContextSchema, mergeRequestContextSchema`,
  ],
  [OBSERVER]: [`import ${DA}/application/ports/missionStore: MissionPersistence`],
  [ACTIVITY]: [
    'import zod: z',
    'import modules/identity-access/public/participants: DirectAuthenticatedAuthority',
    'import platform/operations/definitions: defineCommandOperation',
  ],
  [STAGING]: [
    `import ${DA}/application/evidenceDocumentCommands: EvidenceDocumentCommands`,
    `import ${DA}/application/ports/evidenceStaging: EvidenceStagingFactory, EvidenceStagingLease, EvidenceStagingNamespace`,
  ],
}
/** The allowed surface of the four new files: zod, digital-employee's public types, this module's domain and application. */
const SURFACE = (file: string, specifier: string): boolean => {
  if (specifier === 'zod') return true
  const resolved = resolveSpecifier(file, specifier)
  return (
    resolved !== null &&
    (resolved === 'modules/digital-employee/public/types' ||
      resolved.startsWith(`${DA}/domain/`) ||
      resolved.startsWith(`${DA}/application/`))
  )
}
/** The two joined files keep their pinned imports; only process globals are checked there. */
const ANY = () => true
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
/** The names the moved code used; none may remain in the composition files (design §4 ②). */
const MOVED_HELPERS = [
  'z',
  'JSON',
  'isMergeRequestLifecycleWorkItem',
  'issueHandlingContextSchema',
  'mergeRequestLifecycleDescriptor',
  'mergeRequestLifecycleRuntimeCodec',
  'changeCandidateContextSchema',
  'mergeRequestContextSchema',
  'assertEvidenceStagingFactory',
]
/**
 * Control-flow statements anywhere in the file (design §3; stricter than the F13 line-start count), any identifier the
 * moved code needed, every `ulid()` call and every `Date.now` read.
 */
function implementationShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (ts.isIdentifier(node) && MOVED_HELPERS.includes(node.text)) out.push(node.text)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'ulid'
    )
      out.push('ulid()')
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
    if (ts.isIdentifier(node) && ['randomUUID', 'fetch', 'ulid'].includes(node.text))
      findings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

/** The statements of top-level function `name`: `return <callee>(…)` for a single call return, else the statement count. */
function entryBody(path: string, source: string, name: string): string {
  const file = parse(path, source)
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== name || !statement.body)
      continue
    const body = statement.body.statements
    const only = body[0]
    if (
      body.length === 1 &&
      only !== undefined &&
      ts.isReturnStatement(only) &&
      only.expression !== undefined &&
      ts.isCallExpression(only.expression) &&
      ts.isIdentifier(only.expression.expression)
    )
      return `return ${only.expression.expression.text}(…)`
    return `${body.length} statements`
  }
  return 'missing'
}

describe('RFC-509 ① 清单里的名字只在各自的位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个清单名字只在它的位置声明（语料下限 3,000 / 2,500）',
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
      expect(LISTED).toHaveLength(27)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('新文件恰好声明、交出清单列的名字；既有文件交出新增的名字；组合文件只声明并导出原有的装配入口，转出的名字不变', () => {
    for (const [location, file] of Object.entries(NEW_FILES)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...file.declares].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...file.offers].sort(),
      ])
    }
    for (const [location, names] of Object.entries(JOINED)) {
      const path = sourceOf(location)
      expect([location, offeredNames(path, text(path))]).toEqual([
        location,
        expect.arrayContaining([...names]),
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
    // The worker interface is a type re-export; at runtime the file still offers only the assembly entry.
    expect(Object.keys(activityRoot).sort()).toEqual(['composeDevelopmentActivityOperations'])
  })
})

describe('RFC-509 ② composition 只装配', () => {
  test('6 个组合文件的形状：控制流只剩一处装配期选择，不再用迁走的代码要的名字，id 与时钟各交出一次；从新位置取实现', () => {
    for (const [location, root] of Object.entries(ROOTS)) {
      const path = sourceOf(location)
      expect([location, implementationShapes(path, text(path))]).toEqual([
        location,
        [...root.shapes],
      ])
      expect([location, edgesToLocations(moduleEdges(path, text(path)))]).toEqual([
        location,
        [...root.takes],
      ])
    }
    for (const [name, [location, callee]] of Object.entries(SINGLE_RETURN)) {
      const path = sourceOf(location)
      expect([name, entryBody(path, text(path), name)]).toEqual([name, `return ${callee}(…)`])
    }
  })

  test(
    '新入口在生产代码里都只在各自的组合文件调用一次，实参逐字钉住',
    () => {
      for (const [name, [location, args]] of Object.entries(CALLS)) {
        expect([name, productionCallers(name)]).toEqual([name, [`${location} x1`]])
        const path = sourceOf(location)
        expect([name, callArguments(path, text(path), name)]).toEqual([name, [[...args]]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：控制流语句、迁走的名字、多出的 id 与时钟、别处的 import、多语句的入口与多余的调用都会被认出', () => {
    const probe = join(SRC, `${DA}/composition/probe.ts`)
    const source = [
      `import { z } from 'zod'`,
      `import { ulid } from 'ulid'`,
      `import { createMissionExecutionTerminalObserver } from '../application/executionTerminalObserver'`,
      `import { createDevelopmentActivityWorkerCycle } from '@/${ACTIVITY}'`,
      `import { assertEvidenceStagingFactory } from '../application/evidenceStaging'`,
      `export function compose(worker: never, deps: { staging?: never }) {`,
      `  for (const item of [deps]) if (!item) throw new Error('x')`,
      `  while (deps) break`,
      `  switch (deps) { default: break }`,
      `  try { void JSON.parse('{}') } finally { void z }`,
      `  void [assertEvidenceStagingFactory, ulid(), Date.now(), Date.now()]`,
      `  createDevelopmentActivityWorkerCycle(worker)`,
      `  return createMissionExecutionTerminalObserver(deps as never)`,
      `}`,
      `export function single(worker: never) {`,
      `  return createDevelopmentActivityWorkerCycle(worker)`,
      `}`,
    ].join('\n')
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${OBSERVER}: createMissionExecutionTerminalObserver`,
      `import ${ACTIVITY}: createDevelopmentActivityWorkerCycle`,
      `import ${STAGING}: assertEvidenceStagingFactory`,
    ])
    expect(implementationShapes(probe, source)).toEqual([
      'z',
      'assertEvidenceStagingFactory',
      'for-of',
      'if',
      'throw',
      'while',
      'switch',
      'try',
      'JSON',
      'z',
      'assertEvidenceStagingFactory',
      'ulid()',
      'Date.now',
      'Date.now',
    ])
    expect(entryBody(probe, source, 'compose')).toBe('7 statements')
    expect(entryBody(probe, source, 'single')).toBe(
      'return createDevelopmentActivityWorkerCycle(…)',
    )
    expect(entryBody(probe, source, 'absent')).toBe('missing')
    expect(callArguments(probe, source, 'createDevelopmentActivityWorkerCycle')).toEqual([
      ['worker'],
      ['worker'],
    ])
    // The pinned wiring tells the id and clock functions apart from captured values.
    const pinned = CALLS.createMissionExecutionTerminalObserver![1][0]!
    for (const variant of [
      pinned.replace('newId:()=>ulid()', 'newId:()=>id'),
      pinned.replace('now:()=>Date.now()', 'now:()=>at'),
    ])
      expect(variant).not.toBe(pinned)
  })
})

describe('RFC-509 ③ 新代码的依赖面是闭集、不用进程全局', () => {
  test('新文件与既有文件的 import 逐条与清单相同；新文件都在允许的面内；都不用进程全局', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      const allowed = location in NEW_FILES ? SURFACE : ANY
      expect([location, purityFindings(path, text(path), allowed)]).toEqual([location, []])
    }
  })

  test('负对照：越界 import、多出的 import 与进程全局都会被认出', () => {
    const file = sourceOf(OBSERVER)
    const source = [
      `import type { MissionPersistence } from './ports/missionStore'`,
      `import { z } from 'zod'`,
      `import { ulid } from 'ulid'`,
      `import { createMissionPersistence } from '../infrastructure/missionStore'`,
      `import { developmentEmployeeTypePackage } from '../composition/employeeTypePackage'`,
      `import type { PersistenceDb } from '@/platform/persistence/persistenceDb'`,
      `import type { SelectedPipelineEvidenceExecution } from '@/modules/integration/public/participants'`,
      `export async function run() { await import('node:fs'); const at = Date.now(); const id = ulid(); const env = process.env; await fetch('x'); Math.random() }`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE)).toEqual([
      'import ulid',
      'ulid',
      'import ../infrastructure/missionStore',
      'import ../composition/employeeTypePackage',
      'import @/platform/persistence/persistenceDb',
      'import @/modules/integration/public/participants',
      'import() node:fs',
      'Date.now',
      'ulid',
      'process.env',
      'fetch',
      'Math.random',
    ])
    expect(moduleEdges(file, source)).not.toEqual(IMPORTS[OBSERVER])
  })
})

// ④ Behaviour, through the new locations with in-memory ports.

describe('RFC-509 ④ 活动周期', () => {
  type Answers = {
    channel?: 'completed' | 'idle'
    outbox?: 'completed' | 'retried' | 'idle'
    dispatch?: 'launched' | 'retried' | 'settled' | 'idle'
    delivery?: boolean
    reaction?: string | null
    execution?: 'completed' | 'retried' | 'failed' | 'pending' | 'idle'
  }
  const worker = (answers: Answers, log: string[]): DevelopmentActivityWorker => ({
    async publishOneChannelResult() {
      log.push('channel')
      return answers.channel ?? 'idle'
    },
    async runOneOutbox() {
      log.push('outbox')
      return answers.outbox ?? 'idle'
    },
    async dispatchOneReaction() {
      log.push('dispatch')
      return answers.dispatch ?? 'idle'
    },
    async pumpOneDelivery() {
      log.push('delivery')
      return answers.delivery ?? false
    },
    async planOneReaction() {
      log.push('reaction')
      return answers.reaction ?? null
    },
    async inspectOneExecution() {
      log.push('execution')
      return answers.execution ?? 'idle'
    },
  })

  test('第一个不空闲的活动胜出，后面的不再问；全部空闲时返回执行巡检的结果', async () => {
    const cases: readonly [Answers, unknown, readonly string[]][] = [
      [{ channel: 'completed' }, { activity: 'channel', state: 'completed' }, ['channel']],
      [{ outbox: 'retried' }, { activity: 'outbox', state: 'retried' }, ['channel', 'outbox']],
      [
        { dispatch: 'launched', outbox: 'idle' },
        { activity: 'dispatch', state: 'launched' },
        ['channel', 'outbox', 'dispatch'],
      ],
      [
        { delivery: true },
        { activity: 'delivery', state: 'completed' },
        ['channel', 'outbox', 'dispatch', 'delivery'],
      ],
      [
        { reaction: 'round-7' },
        { activity: 'reaction', state: 'round-7' },
        ['channel', 'outbox', 'dispatch', 'delivery', 'reaction'],
      ],
      [
        { execution: 'pending' },
        { activity: 'execution', state: 'pending' },
        ['channel', 'outbox', 'dispatch', 'delivery', 'reaction', 'execution'],
      ],
      [
        {},
        { activity: 'execution', state: 'idle' },
        ['channel', 'outbox', 'dispatch', 'delivery', 'reaction', 'execution'],
      ],
    ]
    for (const [answers, result, calls] of cases) {
      const log: string[] = []
      const operations = createDevelopmentActivityWorkerCycle(worker(answers, log))
      expect(Object.isFrozen(operations)).toBe(true)
      expect(await operations.runOneWorkerCycle()).toEqual(result as never)
      expect(log).toEqual([...calls])
    }
  })
})

describe('RFC-509 ④ 执行终态唤醒', () => {
  const observerFixture = (missionId: string | null, drive: 'ok' | 'rejects') => {
    const log: unknown[] = []
    let n = 0
    const observer = createMissionExecutionTerminalObserver({
      store: {
        async recordWakeHint(input) {
          log.push(['record', input])
          return { accepted: true }
        },
      },
      missionIdOfExecutionRef: async (executionRef) => {
        log.push(['lookup', executionRef])
        return missionId
      },
      drive: async (id) => {
        log.push(['drive', id])
        if (drive === 'rejects') throw new Error('drive-boom')
        return 'driven'
      },
      newId: () => `id-${++n}`,
      now: () => 1_000 + n,
    })
    return { observer, log }
  }

  test('找不到所属 mission 时不记唤醒提示、不驱动', async () => {
    const { observer, log } = observerFixture(null, 'ok')
    expect(await observer.agent('exec-1')).toBeUndefined()
    expect(log).toEqual([['lookup', 'exec-1']])
  })

  test('记一条唤醒提示（id 与时刻取自装配传入的函数）再驱动；agent 与 script 的投递键前缀不同', async () => {
    const { observer, log } = observerFixture('mission-1', 'ok')
    await observer.agent('exec-1')
    await observer.script('exec-2')
    expect(log).toEqual([
      ['lookup', 'exec-1'],
      [
        'record',
        {
          id: 'id-1',
          missionId: 'mission-1',
          source: 'agent-execution',
          deliveryKey: 'agent-exec:exec-1',
          now: 1_001,
        },
      ],
      ['drive', 'mission-1'],
      ['lookup', 'exec-2'],
      [
        'record',
        {
          id: 'id-2',
          missionId: 'mission-1',
          source: 'agent-execution',
          deliveryKey: 'script-exec:exec-2',
          now: 1_002,
        },
      ],
      ['drive', 'mission-1'],
    ])
    expect(Object.isFrozen(observer)).toBe(true)
  })

  test('驱动失败不外抛', async () => {
    const { observer, log } = observerFixture('mission-1', 'rejects')
    expect(await observer.agent('exec-1')).toBeUndefined()
    expect(log[log.length - 1]).toEqual(['drive', 'mission-1'])
  })
})

describe('RFC-509 ④ 选定内容核对', () => {
  const staging = {
    namespace: { kind: 'evidence-staging-namespace', reference: { name: 'requirement' } },
    create: () => undefined,
  } as unknown as EvidenceStagingFactory
  const documentCommands = { writeDocument: () => undefined } as unknown as EvidenceDocumentCommands

  test('暂存工厂合格、文档写入器在场时原样交出', () => {
    const content = selectedRequirementMaterializerContent({ staging, documentCommands })
    expect(content.staging).toBe(staging)
    expect(content.documentCommands).toBe(documentCommands)
  })

  test('缺文档写入器或它没有 writeDocument 时抛原文错误；暂存工厂不合格时先抛暂存的错误', () => {
    for (const commands of [undefined, {} as EvidenceDocumentCommands])
      expect(() =>
        selectedRequirementMaterializerContent({ staging, documentCommands: commands }),
      ).toThrow(/^requirement-selected-content-incomplete:documentCommands$/)
    expect(() =>
      selectedRequirementMaterializerContent({
        staging: { namespace: null } as unknown as EvidenceStagingFactory,
        documentCommands: undefined,
      }),
    ).toThrow(/^evidence-staging-factory-incomplete$/)
  })
})

describe('RFC-509 ④ 案例详情投影', () => {
  type Context = EmployeeCaseDetailProjectionInputV1['contexts'][number]
  const snapshot = (
    launchOrigin: EmployeeCaseDetailProjectionInputV1['case']['launchOrigin'],
    contexts: readonly Context[],
  ): EmployeeCaseDetailProjectionInputV1 => ({
    schemaVersion: 1,
    case: {
      id: 'case-509',
      typeRef: { typeId: 'development', revision: 10 },
      launchOrigin,
      primaryContextId: 'context-issue',
    },
    contexts,
    rounds: [],
  })
  const context = (
    id: string,
    typeId: string,
    stateJson: string,
    updatedAt: number,
    schemaVersion = 1,
  ): Context => ({ id, typeId, schemaVersion, stateJson, artifactRefs: [], updatedAt })
  const issue = (body: string) =>
    JSON.stringify({
      status: 'active',
      subjectRef: 'repo-1:issue-42',
      repositoryRef: 'repo-1',
      request: {
        kind: 'body',
        body,
        externalId: null,
        uploads: [],
        executionOptions: {},
      },
      materialArtifactRefs: [],
      deliveryContent: null,
    })
  const unknown = (source: string) => ({
    source,
    ingressRef: null,
    kind: 'unknown',
    subjectRef: null,
    repositoryRef: null,
    body: null,
    externalId: null,
    uploads: [],
    executionOptions: {},
    advancedOptions: {},
  })

  test('没有议题上下文时输入为未知，工作区、变更候选与交付留空', () => {
    expect(
      projectDevelopmentEmployeeCaseDetail({ snapshot: snapshot('api', []), workspace: null }),
    ).toEqual({
      schemaVersion: 1,
      input: unknown('api'),
      workspace: null,
      changeCandidate: null,
      delivery: null,
    } as never)
  })

  test('取同类型里最新的上下文；只认 1 版；状态解析失败时该部分留空而不是整个案例不可读', () => {
    const latest = projectDevelopmentEmployeeCaseDetail({
      snapshot: snapshot('event', [
        context('old', 'development.issue-handling', issue('old body'), 1),
        context('new', 'development.issue-handling', issue('new body'), 2),
      ]),
      workspace: null,
    })
    expect(latest.input).toMatchObject({
      source: 'event',
      ingressRef: 'issue',
      kind: 'event',
      body: 'new body',
    })
    for (const contexts of [
      [context('v2', 'development.issue-handling', issue('x'), 1, 2)],
      [context('bad', 'development.issue-handling', '{not json', 1)],
      [context('shape', 'development.issue-handling', JSON.stringify({ status: 'active' }), 1)],
    ])
      expect(
        projectDevelopmentEmployeeCaseDetail({
          snapshot: snapshot('api', contexts),
          workspace: null,
        }).input,
      ).toEqual(unknown('api') as never)
  })

  test('参与者解析输入、按案例读工作区，交出与直接投影相同的 JSON', async () => {
    const reads: string[] = []
    const participant = createDevelopmentEmployeeCaseDetailProjection({
      async getByCaseId(caseId) {
        reads.push(caseId)
        return null
      },
    })
    const input = snapshot('api', [context('new', 'development.issue-handling', issue('body'), 2)])
    expect(participant.typeId).toBe('development')
    expect(await participant.projectJson(JSON.stringify(input))).toBe(
      JSON.stringify(projectDevelopmentEmployeeCaseDetail({ snapshot: input, workspace: null })),
    )
    expect(reads).toEqual(['case-509'])
  })
})

describe('RFC-509 ④ 内建作业模板', () => {
  const tool = (id: string, workItemRef: string, extra: Record<string, unknown> = {}) => ({
    id,
    publishedRevision: 3,
    selection: 'selectable',
    content: { typeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE, workItemRef, ...extra },
  })
  const catalog = (tools: readonly ReturnType<typeof tool>[], log: string[] = []) => ({
    listJson(typeRefJson: string, workItemRef: string) {
      log.push(`${typeRefJson} ${workItemRef}`)
      return JSON.stringify(tools.filter((entry) => entry.content.workItemRef === workItemRef))
    },
  })
  const DEFAULTS = [
    'design-and-clarify',
    'review-design',
    'implement-change',
    'repair-feedback',
    'repair-conflict',
  ]
  const route = { routeRef: 'build', displayName: 'Build', description: '', fallback: true }
  const complete = [
    ...DEFAULTS.map((workItemRef) => tool(`tool-${workItemRef}`, workItemRef)),
    tool('tool-classify', 'classify-pipeline', { dispatchRouteDefinitions: [route] }),
    tool('tool-repair', 'repair-pipeline', {
      acceptedDispatchRoutes: [{ classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] }],
    }),
  ]

  test('缺工具、分类器没有恰好一条兜底路由、某条路由没有修复者时各抛原文错误', () => {
    expect(() => buildGraphDeliveryJobs({ catalog: catalog([]) })).toThrow(
      /^graph-mr-job-tool-missing:design-and-clarify$/,
    )
    const hidden = { ...tool('tool-hidden', 'design-and-clarify'), selection: 'hidden' }
    expect(() => buildGraphDeliveryJobs({ catalog: catalog([hidden]) })).toThrow(
      /^graph-mr-job-tool-missing:design-and-clarify$/,
    )
    const noRoutes = complete.map((entry) =>
      entry.id === 'tool-classify' ? tool('tool-classify', 'classify-pipeline') : entry,
    )
    expect(() => buildGraphDeliveryJobs({ catalog: catalog(noRoutes) })).toThrow(
      /^graph-mr-job-classifier-routes-missing$/,
    )
    const noRepairer = complete.filter((entry) => entry.id !== 'tool-repair')
    expect(() => buildGraphDeliveryJobs({ catalog: catalog(noRepairer) })).toThrow(
      /^graph-mr-job-repair-route-missing:build$/,
    )
  })

  test('没有流水线连接时留一项待配置；有连接时交出适配器绑定且没有待配置项', () => {
    const log: string[] = []
    const draft = buildGraphDeliveryJobs({ catalog: catalog(complete, log) })
    expect(log[0]).toBe(`${JSON.stringify(GRAPH_DELIVERY_EMPLOYEE_TYPE)} design-and-clarify`)
    expect(draft.defaultJob.id).toBe(GRAPH_MR_JOB_ID)
    expect(draft.pipelineJobDraft.id).toBe(GRAPH_MR_PIPELINE_JOB_ID)
    expect(draft.defaultJob.content.defaultToolBindings).toEqual(
      DEFAULTS.map((workItemRef) => ({
        workItemRef,
        slotRef: 'default',
        registrationRef: { id: `tool-${workItemRef}`, revision: 3 },
      })),
    )
    expect(draft.pipelineJobDraft.content.orderedDispatchConfigurations).toEqual([
      {
        classifierWorkItemRef: 'classify-pipeline',
        routes: [
          {
            ...route,
            destinationWorkItemRef: 'repair-pipeline',
            registrationRef: { id: 'tool-repair', revision: 3 },
          },
        ],
      },
    ])
    expect(draft.pipelineJobDraft.content.defaultAdapterBindings).toEqual([])
    expect(draft.requiredConfiguration).toEqual([
      {
        laneId: 'care-pipeline',
        slotRef: 'primary',
        purpose: 'pipeline-gate',
        label: '企业流水线连接',
        href: draft.configurationHref,
      },
    ])
    const adapterRef = { id: 'adapter-ci', revision: 4 }
    const connected = buildGraphDeliveryJobs({
      catalog: catalog(complete),
      pipelineAdapterRef: adapterRef,
    })
    expect(connected.pipelineJobDraft.content.defaultAdapterBindings).toEqual([
      { laneId: 'care-pipeline', slotRef: 'primary', adapterRef },
    ])
    expect(connected.requiredConfiguration).toEqual([])
  })
})

describe('RFC-509 ④ graph@2 类型包与编解码', () => {
  const descriptor = (workItems: readonly Record<string, unknown>[]) =>
    JSON.stringify({
      typeRef: { typeId: 'graph-development', revision: 1 },
      workIntakeAuthoring: {
        advancedOptions: [{ optionRef: 'publication-branch' }, { optionRef: 'other' }],
      },
      workContracts: [{ contract: 'core' }],
      authoringManifest: { lifecycleRegions: [{ region: 'core' }], workItems },
      contextTypes: [],
      eventSources: [],
      eventTypes: [],
      attentionRules: [],
      reactionRules: [],
      invocationContracts: [],
    })
  const registration = (
    workItems: readonly Record<string, unknown>[],
    log: string[],
  ): EmployeeTypePackageRegistration => ({
    descriptorJson: descriptor(workItems),
    parseWorkScopeJson: (json) => json,
    summarizeWorkScopeJson: () => 'summary',
    validateContractFixtureJson(json) {
      log.push(`core ${json}`)
      return 'core-ok'
    },
  })
  const DELIVER = {
    workItemRef: 'deliver-result',
    regionId: 'core-region',
    responsibilityLaneId: 'core-lane',
  }

  test('graph@1 没有交付工作项时抛原文错误', () => {
    const development = { validateContractFixtureJson: () => 'development-ok' }
    expect(() =>
      createGraphDeliveryLifecycleTypePackage(registration([], []), development),
    ).toThrow(/^graph-delivery-work-item-missing$/)
  })

  test('并入 MR 生命周期：类型版本、交付工作项的后继、共享交付工作项的区域与次序；契约夹具按前缀交给图或开发登记对象', () => {
    const log: string[] = []
    const development: Pick<EmployeeTypePackageRegistration, 'validateContractFixtureJson'> = {
      validateContractFixtureJson(json) {
        log.push(`${this === development ? 'development' : 'detached'} ${json}`)
        return 'development-ok'
      },
    }
    const core = registration([DELIVER], log)
    const composed = createGraphDeliveryLifecycleTypePackage(core, development)
    const parsed = JSON.parse(composed.descriptorJson) as {
      typeRef: unknown
      workContracts: unknown[]
      workIntakeAuthoring: { advancedOptions: { optionRef: string; label?: unknown }[] }
      authoringManifest: { workItems: Record<string, unknown>[] }
    }
    expect(parsed.typeRef).toEqual(GRAPH_DELIVERY_EMPLOYEE_TYPE)
    expect(parsed.workContracts).toEqual([
      { contract: 'core' },
      ...mergeRequestLifecycleDescriptor.workContracts,
    ])
    expect(
      parsed.workIntakeAuthoring.advancedOptions.map((option) => option.label ?? null),
    ).toEqual([{ 'zh-CN': 'MR 源分支', 'en-US': 'MR source branch' }, null])
    expect(parsed.authoringManifest.workItems).toEqual([
      { ...DELIVER, nextWorkItemRefs: ['publish-mr', 'observe-mr'] },
      ...mergeRequestLifecycleDescriptor.workItems.map((item) =>
        item.regionId === 'delivery'
          ? {
              ...item,
              regionId: 'core-region',
              responsibilityLaneId: 'core-lane',
              order: item.order + 100,
            }
          : item,
      ),
    ])
    expect(composed.parseWorkScopeJson).toBe(core.parseWorkScopeJson)
    const graphFixture = JSON.stringify({ contract: { contractId: 'graph-development.design' } })
    const otherFixture = JSON.stringify({ contract: { contractId: 'development.publish' } })
    expect(composed.validateContractFixtureJson(graphFixture)).toBe('core-ok')
    expect(composed.validateContractFixtureJson(otherFixture)).toBe('development-ok')
    expect(log).toEqual([`core ${graphFixture}`, `development ${otherFixture}`])
  })

  const codec = (log: string[]): GraphDeliveryLifecycleRuntimeCodec => ({
    typeId: 'graph-development',
    buildInitialCaseJson() {
      log.push('core.buildInitialCaseJson')
      return JSON.stringify({
        primaryContextTypeId: 'graph-development.design',
        primaryContextJson: JSON.stringify({ request: { body: 'x' } }),
        extra: 1,
      })
    },
    validateContextJson(typeId, json) {
      log.push(`core.validateContextJson ${typeId}`)
      return json
    },
    resolveAttentionSubjectsJson: () => '[]',
    selectReactionToolSlotJson: () => 'core-slot',
    assembleReactionInputJson: () => 'core-input',
    validateReactionOutputJson: () => 'core-output',
    resolveReactionSettlementJson: () => JSON.stringify({ settled: 'core' }),
    buildInvokedCaseJson: () => 'core-invoked',
    buildInvocationStartedOutputJson: () => 'core-started',
    buildInvocationResultOutputJson: () => 'core-result',
  })

  test('graph@2 的新案例给主上下文的请求记 MR 交付；更早的版本原样交给图', () => {
    const log: string[] = []
    const runtime = createGraphDeliveryLifecycleRuntimeCodec(codec(log))
    const older = JSON.stringify({ employeeTypeRef: { typeId: 'graph-development', revision: 1 } })
    expect(runtime.buildInitialCaseJson(older)).toBe(codec([]).buildInitialCaseJson(older))
    const current = JSON.stringify({ employeeTypeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE })
    const launch = JSON.parse(runtime.buildInitialCaseJson(current)) as {
      primaryContextJson: string
      extra: number
    }
    expect(JSON.parse(launch.primaryContextJson)).toEqual({
      request: { body: 'x', deliveryMode: 'merge-request' },
    })
    expect(launch.extra).toBe(1)
    expect(log).toEqual([
      'core.buildInitialCaseJson',
      'core.buildInitialCaseJson',
      'core.validateContextJson graph-development.design',
    ])
    expect(runtime.typeId).toBe('graph-development')
    expect(
      runtime.selectReactionToolSlotJson(JSON.stringify({ workItemRef: 'review-design' })),
    ).toBe('core-slot')
  })

  test('交付结算在 MR 已发布且是 MR 交付时转去看护；任一条件不满足时原样交出', () => {
    const runtime = createGraphDeliveryLifecycleRuntimeCodec(codec([]))
    const settlement = (candidateStatus: string, allowed: readonly string[]) =>
      JSON.stringify({
        workItemRef: 'deliver-result',
        allowedNextWorkItemRefs: allowed,
        outputJson: JSON.stringify({
          status: 'ok',
          contextPatches: [
            {
              contextTypeId: 'development.change-candidate',
              stateJson: JSON.stringify({ status: candidateStatus }),
            },
            {
              contextTypeId: 'graph-development.design',
              stateJson: JSON.stringify({ request: { deliveryMode: 'merge-request' } }),
            },
          ],
        }),
      })
    expect(
      JSON.parse(runtime.resolveReactionSettlementJson(settlement('published', ['observe-mr']))),
    ).toEqual({
      settled: 'core',
      nextWorkItemRef: 'observe-mr',
      caseState: 'active',
    })
    for (const json of [
      settlement('draft', ['observe-mr']),
      settlement('published', ['publish-mr']),
    ])
      expect(runtime.resolveReactionSettlementJson(json)).toBe(JSON.stringify({ settled: 'core' }))
  })
})
