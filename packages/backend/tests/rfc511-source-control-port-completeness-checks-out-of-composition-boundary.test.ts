// RFC-511 — 源码控制组合层的端口完整性核对迁出 composition（RFC-294 S10 第十八步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；两个新文件恰好声明、交出清单列的名字；7 个组合文件不再声明它们，转出的名字
//    不变。
// ② 7 个组合文件里不再有这 28 行核对：没有 `TypeError` / `Error` 的构造，余下的控制流只是装配期选择（逐个钉住）；每个核对在生产代码里的调用方
//    与实参钉住（带负对照）。
// ③ 新代码的依赖面是闭集：两个新文件只取本模块的 `application/ports` 与 public participants 的类型，import 逐条钉住；不用进程全局（带负对照）。
// ④ 行为（直接调用新位置）：每个核对接受齐全的值、拒绝缺方法或缺字段的值并抛原文错误；候选效果工厂区分操作宿主与分步工厂。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读 7 个组合文件与新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { requireConflictMergeWorkspaceEffects } from '@/modules/source-control/application/conflictMerge'
import { requireRepositoryCandidateEffectsFactory } from '@/modules/source-control/application/repositoryCandidateEffects'
import {
  requireIsolationWorkspaceFactory,
  requireIsolationWorkspaceScope,
  requireRepositoryGitWorkspaceFactory,
  requireRepositoryGitWorkspaceScope,
  requireRepositoryWorkspaceReadQueries,
  requireWorkspaceExcludeParticipant,
  requireWorkspaceUploadContent,
  requireWorkspaceUploadContentFactory,
} from '@/modules/source-control/application/workspacePorts'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const SC = 'modules/source-control'
const PORTS = `${SC}/application/workspacePorts`
const CANDIDATE = `${SC}/application/repositoryCandidateEffects`
const MERGE = `${SC}/application/conflictMerge`
const root = (name: string) => `${SC}/composition/${name}`
const PORT_NAMES = [
  'requireIsolationWorkspaceScope',
  'requireIsolationWorkspaceFactory',
  'requireRepositoryGitWorkspaceScope',
  'requireRepositoryGitWorkspaceFactory',
  'requireWorkspaceUploadContent',
  'requireWorkspaceUploadContentFactory',
  // RFC-527: `requireWorkspaceExcludeProfileFactory` left with the exclude-profile selection (no caller).
  'requireWorkspaceExcludeParticipant',
  'requireRepositoryWorkspaceReadQueries',
]

/** design §3: every listed name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = [
  ...PORT_NAMES.map((name) => [PORTS, name] as const),
  [CANDIDATE, 'requireRepositoryCandidateEffectsFactory'],
  [MERGE, 'requireConflictMergeWorkspaceEffects'],
]
/** design §3: the two new files declare and offer exactly these names. */
const NEW_FILES: Readonly<Record<string, readonly string[]>> = {
  [PORTS]: PORT_NAMES,
  [CANDIDATE]: ['requireRepositoryCandidateEffectsFactory'],
}
const LOCATIONS = [PORTS, CANDIDATE, MERGE]
/**
 * design D2: each composition file's offered names (unchanged; RFC-527 adds the two local factories the bindings used to build),
 * its control flow and its edges to the new locations.
 */
const ROOTS: Readonly<
  Record<
    string,
    {
      readonly offers: readonly string[]
      readonly shapes: readonly string[]
      readonly takes: readonly string[]
    }
  >
> = {
  [root('isolationWorkspaces')]: {
    offers: ['requireIsolationWorkspaceScope', 'selectIsolationWorkspaceFactory'],
    shapes: [],
    takes: [
      `import ${PORTS}: requireIsolationWorkspaceFactory`,
      `export ${PORTS}: requireIsolationWorkspaceScope`,
    ],
  },
  [root('repositoryGitWorkspaces')]: {
    offers: [
      'bindRepositoryGitSubworkspace',
      'bindRepositoryGitWorkspace',
      'requireRepositoryGitWorkspaceScope',
      'selectRepositoryGitWorkspaceFactory',
    ],
    shapes: [],
    takes: [
      `import ${PORTS}: requireRepositoryGitWorkspaceFactory, requireRepositoryGitWorkspaceScope`,
      `export ${PORTS}: requireRepositoryGitWorkspaceScope`,
    ],
  },
  [root('workspaceUploads')]: {
    offers: ['requireWorkspaceUploadContent', 'selectWorkspaceUploadContentFactory'],
    shapes: [],
    takes: [
      `import ${PORTS}: requireWorkspaceUploadContentFactory`,
      `export ${PORTS}: requireWorkspaceUploadContent`,
    ],
  },
  [root('workspaceExcludeProfiles')]: {
    offers: ['bindWorkspaceExcludeProfile', 'composeLocalWorkspaceExcludeProfiles'],
    shapes: [],
    takes: [`import ${PORTS}: requireWorkspaceExcludeParticipant`],
  },
  [root('repositoryWorkspaceReadQueries')]: {
    offers: ['selectRepositoryWorkspaceReadQueries'],
    shapes: [],
    takes: [`import ${PORTS}: requireRepositoryWorkspaceReadQueries`],
  },
  [root('conflictMerge')]: {
    // RFC-527: the effects are required; the composition hands out the local ones for standalone.
    offers: ['bindConflictMergeParticipant', 'createFileConflictMergeWorkspaceEffects'],
    shapes: [],
    takes: [
      `import ${MERGE}: discardConflictMergeWorkspace, finishConflictMerge, inspectConflictMerge, prepareConflictMerge, requireConflictMergeWorkspaceEffects`,
    ],
  },
  [root('repositoryCandidate')]: {
    offers: [
      'bindCandidateDeliveryParticipant',
      'bindChangeCandidateParticipant',
      'createLocalRepositoryCandidateEffects',
    ],
    // RFC-527: each binding branches once on host or steps (the selection is required).
    shapes: ['if', 'if'],
    takes: [`import ${CANDIDATE}: requireRepositoryCandidateEffectsFactory`],
  },
}
/** The production calls of every listed check (file and count) and the arguments at the assembly call sites. */
const CALLS: Readonly<
  Record<string, readonly [readonly string[], readonly (readonly string[])[] | null]>
> = {
  requireIsolationWorkspaceScope: [
    [
      'modules/task-execution/infrastructure/executionWorkspaceSession x1',
      'modules/task-execution/infrastructure/isolationWorkspaceView x1',
    ],
    null,
  ],
  // RFC-527: the selection helpers check the caller's required selection as given.
  requireIsolationWorkspaceFactory: [[`${root('isolationWorkspaces')} x1`], [['selected']]],
  requireRepositoryGitWorkspaceScope: [
    [
      `${root('repositoryCommit')} x1`,
      `${root('repositoryGitWorkspaces')} x2`,
      `${root('workspaceChangePublication')} x1`,
    ],
    null,
  ],
  requireRepositoryGitWorkspaceFactory: [[`${root('repositoryGitWorkspaces')} x1`], [['selected']]],
  requireWorkspaceUploadContent: [['modules/task-execution/application/workspaceUploads x1'], null],
  requireWorkspaceUploadContentFactory: [[`${root('workspaceUploads')} x1`], [['selected']]],
  requireWorkspaceExcludeParticipant: [
    [`${root('workspaceExcludeProfiles')} x1`],
    [['participant']],
  ],
  requireRepositoryWorkspaceReadQueries: [
    [`${root('repositoryWorkspaceReadQueries')} x1`],
    [['selected']],
  ],
  requireConflictMergeWorkspaceEffects: [[`${root('conflictMerge')} x1`], [['effects']]],
  requireRepositoryCandidateEffectsFactory: [
    [`${root('repositoryCandidate')} x2`],
    [['selected'], ['selected']],
  ],
}
/** design §4 ③: the exact imports of the two new files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [PORTS]: [
    `import ${SC}/public/participants: WorkspaceExcludeParticipant`,
    `import ${SC}/application/ports/isolationWorkspace: IsolationWorkspaceFactory, IsolationWorkspaceScope`,
    `import ${SC}/application/ports/repositoryGitWorkspace: RepositoryGitWorkspaceFactory, RepositoryGitWorkspaceScope`,
    `import ${SC}/application/ports/repositoryWorkspaceReadQueries: RepositoryWorkspaceReadQueries`,
    `import ${SC}/application/ports/workspaceUploadContent: WorkspaceUploadContent, WorkspaceUploadContentFactory`,
  ],
  [CANDIDATE]: [
    `import ${SC}/application/ports/repositoryCandidateOperations: isRepositoryCandidateOperationHost, RepositoryCandidateEffectsFactory, RepositoryCandidateOperationHost`,
  ],
}
/** The new files take only this module's ports and its public participant types. */
const PORTS_OR_PUBLIC = (file: string, specifier: string): boolean => {
  const resolved = resolveSpecifier(file, specifier) ?? ''
  return resolved.startsWith(`${SC}/application/ports/`) || resolved === `${SC}/public/participants`
}
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

/** Control-flow statements anywhere in the file and every `new TypeError(…)` / `new Error(…)` (design §4 ②). */
function checkShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['TypeError', 'Error'].includes(node.expression.text)
    )
      out.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return out
}

describe('RFC-511 ① 清单里的名字只在各自的位置声明', () => {
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
      // RFC-527: 11 → 10 (`requireWorkspaceExcludeProfileFactory` left with its selection).
      expect(LISTED).toHaveLength(10)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('两个新文件恰好声明、交出清单列的名字；7 个组合文件不声明清单里的名字，转出的名字不变', () => {
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
    const listed = new Set(LISTED.map(([, name]) => name))
    for (const [location, rootFile] of Object.entries(ROOTS)) {
      const path = sourceOf(location)
      expect(
        declaredNames(path, text(path)).filter((name) => listed.has(name)),
        location,
      ).toEqual([])
      expect([location, offeredNames(path, text(path)).sort()]).toEqual([
        location,
        [...rootFile.offers].sort(),
      ])
    }
  })
})

describe('RFC-511 ② composition 只装配', () => {
  test('7 个组合文件里没有错误的构造，余下的控制流逐个钉住；从新位置取核对', () => {
    for (const [location, rootFile] of Object.entries(ROOTS)) {
      const path = sourceOf(location)
      expect([location, checkShapes(path, text(path))]).toEqual([location, [...rootFile.shapes]])
      expect([location, edgesToLocations(moduleEdges(path, text(path)))]).toEqual([
        location,
        [...rootFile.takes],
      ])
    }
  })

  test(
    '每个核对在生产代码里的调用方与次数钉住，装配处的实参逐字钉住',
    () => {
      for (const [name, [callers, args]] of Object.entries(CALLS)) {
        expect([name, productionCallers(name)]).toEqual([name, [...callers].sort()])
        if (args === null) continue
        const location = callers[0]!.split(' ')[0]!
        const path = sourceOf(location)
        expect([name, callArguments(path, text(path), name)]).toEqual([
          name,
          args.map((row) => [...row]),
        ])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：错误的构造、多出的控制流、别处的 import 与多余的调用都会被认出', () => {
    const probe = join(SRC, `${SC}/composition/probe.ts`)
    const source = [
      `import { requireIsolationWorkspaceFactory } from '../application/workspacePorts'`,
      `import { requireRepositoryCandidateEffectsFactory } from '@/${CANDIDATE}'`,
      `export function compose(factory: never) {`,
      `  if (factory === null) throw new TypeError('Isolation requires a complete workspace factory')`,
      `  if (factory === undefined) throw new Error('repository-candidate-effects-incomplete')`,
      `  requireIsolationWorkspaceFactory(factory)`,
      `  requireIsolationWorkspaceFactory(factory)`,
      `  return requireRepositoryCandidateEffectsFactory(factory)`,
      `}`,
    ].join('\n')
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${PORTS}: requireIsolationWorkspaceFactory`,
      `import ${CANDIDATE}: requireRepositoryCandidateEffectsFactory`,
    ])
    expect(checkShapes(probe, source)).toEqual(['if', 'throw', 'TypeError', 'if', 'throw', 'Error'])
    expect(callArguments(probe, source, 'requireIsolationWorkspaceFactory')).toEqual([
      ['factory'],
      ['factory'],
    ])
  })
})

describe('RFC-511 ③ 新代码的依赖面是闭集、不用进程全局', () => {
  test('两个新文件的 import 逐条钉住、只取本模块的端口与 public participants 的类型；冲突合并文件不取组合层与基础设施；都不用进程全局', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect(purityFindings(path, text(path), PORTS_OR_PUBLIC), location).toEqual([])
    }
    const merge = sourceOf(MERGE)
    expect(
      moduleEdges(merge, text(merge)).filter((edge) =>
        /^import modules\/source-control\/(composition|infrastructure)/.test(edge),
      ),
    ).toEqual([])
  })

  test('负对照：越界 import、多出的 import 与进程全局都会被认出', () => {
    const file = sourceOf(PORTS)
    const source = [
      `import type { IsolationWorkspaceScope } from './ports/isolationWorkspace'`,
      `import { selectIsolationWorkspaceFactory } from '../composition/isolationWorkspaces'`,
      `import { createLocalIsolationWorkspaceFactory } from '../infrastructure/local/localIsolationWorkspace'`,
      `import type { TaskRunDriveBinding } from '@/modules/task-execution/application/ports/taskRunSelection'`,
      `export async function run() { await import('node:fs'); const at = Date.now(); const env = process.env }`,
    ].join('\n')
    expect(purityFindings(file, source, PORTS_OR_PUBLIC)).toEqual([
      'import ../composition/isolationWorkspaces',
      'import ../infrastructure/local/localIsolationWorkspace',
      'import @/modules/task-execution/application/ports/taskRunSelection',
      'import() node:fs',
      'Date.now',
      'process.env',
    ])
    expect(moduleEdges(file, source)).not.toEqual(IMPORTS[PORTS])
  })
})

// ④ Behaviour, through the new locations.

const fn = () => undefined
const methods = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, fn]))
const ISOLATION_SCOPE = [
  'recoverKey',
  'chooseGeneration',
  'create',
  'restore',
  'head',
  'submodulePresence',
  'changedFiles',
  'blobHashes',
  'snapshot',
  'merge',
  'undoShard',
  'discard',
  'resolveConflict',
  'completeHumanConflict',
]
const GIT_SCOPE = [
  'run',
  'hasSubmodules',
  'effectiveSubmodules',
  'withPreviewIndex',
  'subrepository',
]
const UPLOAD_CONTENT = ['prepareTarget', 'file', 'entry', 'read', 'remove', 'write']
const READ_QUERIES = ['exists', 'isGitWorkTree', 'gitDiffSnapshot', 'worktreeDiff', 'isolationRoot']
const MERGE_EFFECTS = [
  'allocate',
  'cloneBaseline',
  'run',
  'installPlatformExclude',
  'readConflictFile',
  'mergeHeadExists',
  'discard',
]
const without = (names: readonly string[], missing: string) =>
  methods(names.filter((name) => name !== missing))

describe('RFC-511 ④ 端口完整性核对', () => {
  test('隔离工作区：作用域的 14 个方法与工厂的 bind', () => {
    // RFC-570: the two receiver checks take the port types, like the factory checks; the stand-ins are cast.
    expect(() => requireIsolationWorkspaceScope(methods(ISOLATION_SCOPE) as never)).not.toThrow()
    for (const missing of ISOLATION_SCOPE)
      expect(() =>
        requireIsolationWorkspaceScope(without(ISOLATION_SCOPE, missing) as never),
      ).toThrow(new TypeError('Isolation requires a complete workspace scope'))
    expect(() => requireIsolationWorkspaceFactory({ bind: fn } as never)).not.toThrow()
    for (const factory of [null, {}, { bind: 'x' }])
      expect(() => requireIsolationWorkspaceFactory(factory as never)).toThrow(
        new TypeError('Isolation requires a complete workspace factory'),
      )
  })

  test('仓库 Git 工作区：作用域的 workspaceRef 与 5 个方法、工厂的 bind', () => {
    const scope = { workspaceRef: '/work', ...methods(GIT_SCOPE) }
    expect(() => requireRepositoryGitWorkspaceScope(scope)).not.toThrow()
    expect(() => requireRepositoryGitWorkspaceScope({ ...scope, workspaceRef: 1 })).toThrow(
      new TypeError('Repository Git requires a complete workspace scope'),
    )
    for (const missing of GIT_SCOPE)
      expect(() =>
        requireRepositoryGitWorkspaceScope({
          workspaceRef: '/work',
          ...without(GIT_SCOPE, missing),
        }),
      ).toThrow(new TypeError('Repository Git requires a complete workspace scope'))
    expect(() => requireRepositoryGitWorkspaceFactory({ bind: fn } as never)).not.toThrow()
    expect(() => requireRepositoryGitWorkspaceFactory(null as never)).toThrow(
      new TypeError('Repository Git requires a complete workspace factory'),
    )
  })

  test('上传内容：内容收发的 6 个方法与工厂的 bind', () => {
    expect(() => requireWorkspaceUploadContent(methods(UPLOAD_CONTENT) as never)).not.toThrow()
    for (const missing of UPLOAD_CONTENT)
      expect(() =>
        requireWorkspaceUploadContent(without(UPLOAD_CONTENT, missing) as never),
      ).toThrow(new TypeError('Workspace uploads require a complete content receiver'))
    expect(() => requireWorkspaceUploadContentFactory({ bind: fn } as never)).not.toThrow()
    expect(() => requireWorkspaceUploadContentFactory({} as never)).toThrow(
      new TypeError('Workspace uploads require a complete content factory'),
    )
  })

  // RFC-527: the exclude-profile factory check left with its selection (no caller); the participant check stays.
  test('排除配置与只读查询：参与者的 ensure 与 5 个查询方法', () => {
    expect(() => requireWorkspaceExcludeParticipant({ ensure: fn } as never)).not.toThrow()
    for (const participant of [null, {}, { ensure: 1 }])
      expect(() => requireWorkspaceExcludeParticipant(participant as never)).toThrow(
        new TypeError('Workspace exclude requires a complete profile participant'),
      )
    expect(() =>
      requireRepositoryWorkspaceReadQueries(methods(READ_QUERIES) as never),
    ).not.toThrow()
    for (const missing of READ_QUERIES)
      expect(() =>
        requireRepositoryWorkspaceReadQueries(without(READ_QUERIES, missing) as never),
      ).toThrow(new TypeError('Repository workspace reads require a complete query implementation'))
  })

  // RFC-527: the selection is required — an absent one no longer passes.
  test('冲突合并效果：没给就抛，7 个方法缺一就抛', () => {
    expect(() => requireConflictMergeWorkspaceEffects(undefined as never)).toThrow(
      new Error('conflict-merge-workspace-effects-incomplete'),
    )
    expect(() =>
      requireConflictMergeWorkspaceEffects(methods(MERGE_EFFECTS) as never),
    ).not.toThrow()
    for (const selected of [null, without(MERGE_EFFECTS, 'mergeHeadExists')])
      expect(() => requireConflictMergeWorkspaceEffects(selected as never)).toThrow(
        new Error('conflict-merge-workspace-effects-incomplete'),
      )
  })

  // RFC-527: the selection is required — an absent one no longer passes.
  test('候选效果工厂：没给就抛；操作宿主要四个操作，分步工厂要 acquire', () => {
    expect(() => requireRepositoryCandidateEffectsFactory(undefined as never)).toThrow(
      new Error('repository-candidate-effects-incomplete'),
    )
    const operations = methods(['derive', 'stage', 'commit', 'push'])
    expect(() => requireRepositoryCandidateEffectsFactory({ operations } as never)).not.toThrow()
    expect(() => requireRepositoryCandidateEffectsFactory({ acquire: fn } as never)).not.toThrow()
    for (const selected of [
      null,
      'x',
      { operations: null },
      { operations: methods(['derive', 'stage', 'commit']) },
      { acquire: 'x' },
    ])
      expect(() => requireRepositoryCandidateEffectsFactory(selected as never)).toThrow(
        new Error('repository-candidate-effects-incomplete'),
      )
  })
})
