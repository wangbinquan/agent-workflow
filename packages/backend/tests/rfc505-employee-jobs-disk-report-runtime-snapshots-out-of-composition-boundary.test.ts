// RFC-505 — 数字员工的内建作业、PostgreSQL 磁盘报告与运行时选择快照迁出 composition（RFC-294 S10 第十二步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① 清单里交出的名字在全部生产文件、用例与 e2e 里只在各自的新位置声明；`nonNegativeInteger` 在 system-operations 与 platform/persistence
//    里只在新文件声明（collaboration 的三个同名私有函数不在本清单）；两个新文件恰好声明、交出清单列的名字，两个既有文件交出清单列的名字；
//    三个组合文件只声明并导出原有的四个装配入口。
// ② 三个组合文件没有 if / for / while / do / switch / try / throw 语句，各自从新位置取实现：`createBuiltinEmployeeJobs`、
//    `readPostgresqlStorageFootprint`、`reportMeasuredDiskReclaimable` 与 `createRuntimeSelectionSnapshotsInTx` 在生产代码里都只在各自的
//    组合文件调用一次，时钟以函数交出，磁盘报告的库用量取自 PostgreSQL 的那次读；组合文件不再发 SQL、不再建 `Map`（带负对照）。
// ③ 新代码的依赖面是闭集：digital-employee 的新文件只取 `@agent-workflow/shared`、本模块 domain 与 `application/ports`，不用进程全局；
//    runtime-management 的 `application/runtimeSelection.ts` 与 system-operations 的 `infrastructure/local/systemMaintenanceDisk.ts` 的
//    import 与此前相同、新函数不用进程全局；platform 的新文件只取同层的 PostgreSQL 运行时类型、不用进程全局（带负对照）。
//
// PostgreSQL 的那次读落在 `platform/persistence/`：provider 命名的文件只许住在那里（RFC-359 W5-T17 的账本只降不升），
// 报告的拼装不分引擎，留在 system-operations。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读三个组合文件与四个新位置。
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

const DE = 'modules/digital-employee'
const SO = 'modules/system-operations'
const RM = 'modules/runtime-management'
const JOBS = `${DE}/application/builtinEmployeeJobs`
const FOOTPRINT = 'platform/persistence/postgresqlStorageFootprint'
const DISK = `${SO}/infrastructure/local/systemMaintenanceDisk`
const SELECTION = `${RM}/application/runtimeSelection`

/** design §3: each new file, the names it declares and offers, and the names it declares without offering. */
const NEW_FILES: Readonly<
  Record<string, { readonly offered: readonly string[]; readonly internal: readonly string[] }>
> = {
  [JOBS]: {
    offered: ['BuiltinEmployeeJobsDependencies', 'createBuiltinEmployeeJobs'],
    internal: [],
  },
  [FOOTPRINT]: { offered: ['readPostgresqlStorageFootprint'], internal: ['nonNegativeInteger'] },
}
/** design §3: the existing files that now also declare and offer these names. */
const EXTENDED_FILES: Readonly<Record<string, readonly string[]>> = {
  [DISK]: ['reportMeasuredDiskReclaimable'],
  [SELECTION]: ['createRuntimeSelectionSnapshotsInTx'],
}
const LOCATIONS = [...Object.keys(NEW_FILES), ...Object.keys(EXTENDED_FILES)]
/** A private helper name also used by other modules: pinned inside these scopes only (design §3). */
const SCOPED: Readonly<Record<string, readonly string[]>> = {
  nonNegativeInteger: [SO, 'platform/persistence'],
}

/** design §3 / D3: each composition file, the entries it keeps, and what it takes from the new locations. */
const COMPOSITION: Readonly<
  Record<string, { readonly entries: readonly string[]; readonly takes: readonly string[] }>
> = {
  [`${DE}/composition/builtinJobTemplates`]: {
    entries: ['composeBuiltinEmployeeJobs'],
    takes: [`import ${JOBS}: createBuiltinEmployeeJobs`],
  },
  [`${SO}/composition/maintenanceDisk`]: {
    entries: [
      'composeSqliteMaintenanceDiskOperations',
      'composePostgresqlMaintenanceDiskOperations',
    ],
    takes: [
      `import ${FOOTPRINT}: readPostgresqlStorageFootprint`,
      `import ${DISK}: cleanupRetiredStores, reportDiskReclaimable, reportMeasuredDiskReclaimable`,
    ],
  },
  [`${RM}/composition/runtimeSelection`]: {
    entries: ['composeRuntimeSelectionParticipantInTx'],
    takes: [
      `import ${SELECTION}: createNodeRunRuntimeSelectionCapabilityInTx, createRuntimeSelectionParticipantInTx, createRuntimeSelectionSnapshotsInTx`,
    ],
  },
}
/** The single production call of each moved factory: its composition file and its arguments (whitespace removed). */
const CALLS: Readonly<Record<string, { readonly at: string; readonly args: readonly string[] }>> = {
  createBuiltinEmployeeJobs: {
    at: `${DE}/composition/builtinJobTemplates`,
    args: ['{store:createDigitalEmployeeAuthoringPersistence(db),publish,now:()=>Date.now(),}'],
  },
  readPostgresqlStorageFootprint: {
    at: `${SO}/composition/maintenanceDisk`,
    args: ['runtime'],
  },
  reportMeasuredDiskReclaimable: {
    at: `${SO}/composition/maintenanceDisk`,
    args: ['awaitreadPostgresqlStorageFootprint(runtime)', 'appHome'],
  },
  createRuntimeSelectionSnapshotsInTx: {
    at: `${RM}/composition/runtimeSelection`,
    args: ['assertTaskScope'],
  },
}
/** `application/runtimeSelection.ts`'s imports before RFC-505 (the new function adds none). */
const SELECTION_IMPORTS = [
  'import ulid: ulid',
  `import ${RM}/public/participants: FrozenRuntimeRef, NodeRunRuntimeSelectionCapabilityInTx, RuntimeSelectionParticipantInTx`,
  `import ${RM}/domain/runtimeProfile: ResolvedRuntime`,
]
/** `infrastructure/local/systemMaintenanceDisk.ts`'s imports before RFC-505 (the new function adds none). */
const DISK_IMPORTS = [
  'import platform/persistence/queryHelpers: rawRows',
  'import drizzle-orm: sql',
  'import node:fs: chmodSync, existsSync, readdirSync, rmSync, statSync',
  'import node:fs: Dirent',
  'import node:path: join',
  'import db/client: DbClient',
  `import ${SO}/public/types: MaintenanceDiskReport, ReclaimableDiskItem`,
  'import util/log: createLogger',
  'import platform/configuration/installationPaths: Paths',
]
/** The platform file takes only the PostgreSQL runtime type beside it. */
const FOOTPRINT_IMPORTS = [
  'import platform/persistence/postgresqlRuntime: PostgresqlDatabaseRuntime',
]
/** Edges whose source is one of the RFC-505 locations (other pre-existing edges of the same file are not on this RFC's list). */
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
/**
 * Control-flow statements anywhere in the file (design §3; stricter than the F13 line-start count), plus the two
 * shapes the moved code had: SQL sent through the provider pool, and a `new Map` of retained state.
 */
function implementationShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (ts.isPropertyAccessExpression(node) && ['unsafe', 'providerPool'].includes(node.name.text))
      out.push(`.${node.name.text}`)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Map'
    )
      out.push('new Map')
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

/** digital-employee's new application file: shared, the module's domain and its application ports only (design §4 ③). */
const JOBS_SURFACE = (file: string, specifier: string): boolean => {
  if (specifier === '@agent-workflow/shared') return true
  const rel = resolveSpecifier(file, specifier)
  return (
    rel !== null && [`${DE}/domain/`, `${DE}/application/ports/`].some((at) => rel.startsWith(at))
  )
}
const ANY_IMPORT = () => true

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

/** The text of a top-level function declaration of the file (an RFC-505 addition to an existing file). */
function functionText(path: string, source: string, name: string): string | undefined {
  const file = parse(path, source)
  return file.statements
    .find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    )
    ?.getText(file)
}

describe('RFC-505 ① 清单里的名字只在各自的新位置声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个交出的名字只在它的新位置声明，nonNegativeInteger 在 system-operations 与 platform/persistence 里只在新文件声明（语料下限 3,000 / 2,500）',
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
          .filter((path) => {
            const scopes = SCOPED[name]
            return (
              scopes === undefined ||
              scopes.some((scope) => path.startsWith(`packages/backend/src/${scope}/`))
            )
          })
          .sort()
      const listed: [string, string][] = [
        ...Object.entries(NEW_FILES).flatMap(([location, { offered, internal }]) =>
          [...offered, ...internal].map((name): [string, string] => [location, name]),
        ),
        ...Object.entries(EXTENDED_FILES).flatMap(([location, names]) =>
          names.map((name): [string, string] => [location, name]),
        ),
      ]
      expect(listed).toHaveLength(6)
      for (const [location, name] of listed)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('两个新文件恰好声明、交出清单列的名字；两个既有文件交出清单列的名字；三个组合文件只声明并导出原有的装配入口', () => {
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
    for (const [location, { entries }] of Object.entries(COMPOSITION)) {
      const path = sourceOf(location)
      expect([location, declaredNames(path, text(path)).sort()]).toEqual([
        location,
        [...entries].sort(),
      ])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...entries].sort(),
      ])
    }
  })
})

describe('RFC-505 ② composition 只装配', () => {
  test('三个组合文件没有控制流语句、不发 SQL、不建 Map，各自从新位置取实现', () => {
    for (const [location, { takes }] of Object.entries(COMPOSITION)) {
      const path = sourceOf(location)
      expect([location, implementationShapes(path, text(path))]).toEqual([location, []])
      expect([location, edgesToLocations(moduleEdges(path, text(path)))]).toEqual([
        location,
        [...takes],
      ])
    }
  })

  test(
    '迁出的四个函数在生产代码里都只在各自的组合文件调用一次，内建作业的时钟以函数交出，磁盘报告的库用量取自 PostgreSQL 的那次读',
    () => {
      for (const [name, { at, args }] of Object.entries(CALLS)) {
        expect([name, productionCallers(name)]).toEqual([name, [`${at} x1`]])
        const path = sourceOf(at)
        expect([name, callArguments(path, text(path), name)]).toEqual([name, [[...args]]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：控制流语句、SQL、Map、别处的 import 与多余的调用都会被认出', () => {
    const probe = join(SRC, `${SO}/composition/probe.ts`)
    const source = [
      `import { readPostgresqlStorageFootprint } from '@/platform/persistence/postgresqlStorageFootprint'`,
      `import { createBuiltinEmployeeJobs } from '@/${JOBS}'`,
      `import { Paths } from '@/platform/configuration/installationPaths'`,
      `export async function report(runtime: Runtime, kinds: readonly string[]) {`,
      `  if (kinds.length === 0) return`,
      `  for (const kind of kinds) void kind`,
      `  switch (kinds[0]) { default: break }`,
      `  try { await runtime.providerPool().unsafe('SELECT 1') } catch { throw new Error('x') }`,
      `  const retained = new Map<string, number>()`,
      `  void retained`,
      `}`,
      `reportMeasuredDiskReclaimable(await readPostgresqlStorageFootprint(runtime), appHome)`,
      `reportMeasuredDiskReclaimable(footprint, appHome)`,
    ].join('\n')
    expect(moduleEdges(probe, source)).toEqual([
      `import ${FOOTPRINT}: readPostgresqlStorageFootprint`,
      `import ${JOBS}: createBuiltinEmployeeJobs`,
      'import platform/configuration/installationPaths: Paths',
    ])
    // The location filter keeps edges into the RFC-505 locations and ignores the file's other edges.
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${FOOTPRINT}: readPostgresqlStorageFootprint`,
      `import ${JOBS}: createBuiltinEmployeeJobs`,
    ])
    expect(implementationShapes(probe, source)).toEqual([
      'if',
      'for-of',
      'switch',
      'try',
      '.unsafe',
      '.providerPool',
      'throw',
      'new Map',
    ])
    // A footprint taken from anywhere but the PostgreSQL read is a second call, not the pinned one.
    expect(callArguments(probe, source, 'reportMeasuredDiskReclaimable')).toEqual([
      ['awaitreadPostgresqlStorageFootprint(runtime)', 'appHome'],
      ['footprint', 'appHome'],
    ])
    // A clock taken once at assembly (a number) is not the function the design asks for.
    expect(
      callArguments(
        probe,
        `createBuiltinEmployeeJobs({ store: createDigitalEmployeeAuthoringPersistence(db), publish, now: Date.now() })`,
        'createBuiltinEmployeeJobs',
      ),
    ).not.toEqual([[...CALLS.createBuiltinEmployeeJobs!.args]])
  })
})

describe('RFC-505 ③ 新代码的依赖面是闭集、不用进程全局', () => {
  test('digital-employee 的新文件只取 shared、本模块 domain 与 application/ports；两个既有文件的 import 不变、新函数不用进程全局；platform 的新文件只取同层的 PostgreSQL 运行时类型、不用进程全局', () => {
    const jobs = sourceOf(JOBS)
    expect(purityFindings(jobs, text(jobs), JOBS_SURFACE, true)).toEqual([])
    for (const [location, imports, name] of [
      [SELECTION, SELECTION_IMPORTS, 'createRuntimeSelectionSnapshotsInTx'],
      [DISK, DISK_IMPORTS, 'reportMeasuredDiskReclaimable'],
    ] as const) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      const added = functionText(path, text(path), name)
      expect([name, added === undefined]).toEqual([name, false])
      expect([name, purityFindings(path, added!, ANY_IMPORT, true)]).toEqual([name, []])
    }
    const footprint = sourceOf(FOOTPRINT)
    expect(moduleEdges(footprint, text(footprint))).toEqual(FOOTPRINT_IMPORTS)
    expect(purityFindings(footprint, text(footprint), ANY_IMPORT, true)).toEqual([])
  })

  test('负对照：越界 import、多出的 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${DE}/application/probe.ts`)
    const source = [
      `import { canonicalJson } from '@agent-workflow/shared'`,
      `import { employeeJobTemplateContentSchema } from '../domain/model'`,
      `import type { DigitalEmployeeAuthoringPersistence } from './ports/authoringStore'`,
      `import { createDigitalEmployeeAuthoringPersistence } from '../infrastructure/authoringStore'`,
      `import { composeBuiltinEmployeeJobs } from '../composition/builtinJobTemplates'`,
      `import { AuthoringService } from './authoringService'`,
      `import { ulid } from 'ulid'`,
      `import { readFileSync } from 'node:fs'`,
      `export async function run() { await import('node:path'); const at = Date.now(); const env = process.env; await fetch('x'); Math.random(); randomUUID() }`,
    ].join('\n')
    expect(purityFindings(file, source, JOBS_SURFACE, true)).toEqual([
      'import ../infrastructure/authoringStore',
      'import ../composition/builtinJobTemplates',
      'import ./authoringService',
      'import ulid',
      'import node:fs',
      'import() node:path',
      'Date.now',
      'process.env',
      'fetch',
      'Math.random',
      'randomUUID',
    ])
    const selection = join(SRC, `${SELECTION}.ts`)
    const extended = `import { ulid } from 'ulid'\nexport function createRuntimeSelectionSnapshotsInTx() { return Date.now() }\nexport function other() { return 1 }`
    expect(
      purityFindings(
        selection,
        functionText(selection, extended, 'createRuntimeSelectionSnapshotsInTx')!,
        ANY_IMPORT,
        true,
      ),
    ).toEqual(['Date.now'])
    expect(functionText(selection, extended, 'missing')).toBeUndefined()
    // A platform file that also reaches into a module, or reads the clock, no longer matches its pins.
    const platform = join(SRC, 'platform/persistence/probe.ts')
    const platformSource = [
      `import type { PostgresqlDatabaseRuntime } from './postgresqlRuntime'`,
      `import { reportRetiredRuntimeStores } from '@/${DISK}'`,
      `export const at = () => Date.now()`,
    ].join('\n')
    expect(moduleEdges(platform, platformSource)).toEqual([
      ...FOOTPRINT_IMPORTS,
      `import ${DISK}: reportRetiredRuntimeStores`,
    ])
    expect(purityFindings(platform, platformSource, ANY_IMPORT, true)).toEqual(['Date.now'])
  })
})
