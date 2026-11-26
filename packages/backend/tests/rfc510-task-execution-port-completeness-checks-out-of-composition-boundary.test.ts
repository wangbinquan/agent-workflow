// RFC-510 — 任务执行组合层的端口完整性核对迁出 composition（RFC-294 S10 第十七步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；两个新文件恰好声明、交出清单列的名字；7 个组合文件不再声明它们，转出的名字
//    不变。
// ② 7 个组合文件里不再有这 26 行核对：没有 `TypeError` 的构造，余下的控制流只是装配期选择与运行时绑定（逐个钉住）；新核对在生产代码里只在各自的
//    位置调用一次，实参逐字钉住（带负对照）。
// ③ 新代码的依赖面是闭集：两个新文件只取本模块的 `application/ports`，import 逐条钉住；7 个 application 文件都不取组合层、基础设施与 bootstrap，
//    不用进程全局（带负对照）。
// ④ 行为（直接调用新位置）：每个核对接受齐全的值、拒绝缺方法或缺字段的值并抛原文 `TypeError`，判断的先后不变。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读 7 个组合文件与 7 个新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { requireTaskLaunchConfigurationInput } from '@/modules/task-execution/application/launchConfiguration'
import {
  requireNodeRunPromptContentEffects,
  requireNodeRunPromptOperations,
} from '@/modules/task-execution/application/nodeRunPrompt'
import {
  requirePortArtifactContentEffects,
  requirePortArtifactOperations,
  requirePortArtifactReader,
} from '@/modules/task-execution/application/portArtifacts'
import { requirePortOutputValidationContent } from '@/modules/task-execution/application/portOutputValidation'
import {
  requireTaskDeletionContentEffects,
  requireTaskDeletionEffects,
} from '@/modules/task-execution/application/taskDeletionEffects'
import {
  requireTaskRunConfiguration,
  requireTaskRunDriveBinding,
  requireTaskRunRootSelection,
} from '@/modules/task-execution/application/taskRunSelection'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const TE = 'modules/task-execution'
const ARTIFACTS = `${TE}/application/portArtifacts`
const DELETION = `${TE}/application/taskDeletionEffects`
const PROMPTS = `${TE}/application/nodeRunPrompt`
const OUTPUT = `${TE}/application/portOutputValidation`
const RUNS = `${TE}/application/taskRunSelection`
const LAUNCH = `${TE}/application/launchConfiguration`
const RUN_PORTS = `${TE}/application/ports/taskRunSelection`
const root = (name: string) => `${TE}/composition/${name}`

/** design §3: every listed name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = [
  [ARTIFACTS, 'requirePortArtifactContentEffects'],
  [ARTIFACTS, 'requirePortArtifactOperations'],
  [ARTIFACTS, 'requirePortArtifactReader'],
  [DELETION, 'requireTaskDeletionContentEffects'],
  [DELETION, 'requireTaskDeletionEffects'],
  [PROMPTS, 'requireNodeRunPromptContentEffects'],
  [PROMPTS, 'requireNodeRunPromptOperations'],
  [RUNS, 'requireTaskRunRootSelection'],
  [RUNS, 'requireTaskRunConfiguration'],
  [RUNS, 'requireTaskRunDriveBinding'],
  [OUTPUT, 'requirePortOutputValidationContent'],
  [LAUNCH, 'requireTaskLaunchConfigurationInput'],
  [RUN_PORTS, 'TaskRunRootSelection'],
  [RUN_PORTS, 'TaskRunDriveBinding'],
  [RUN_PORTS, 'TaskRunRootBinding'],
]
/** design §3: the two new files declare and offer exactly these names. */
const NEW_FILES: Readonly<Record<string, readonly string[]>> = {
  [DELETION]: ['requireTaskDeletionContentEffects', 'requireTaskDeletionEffects'],
  // RFC-514 added the standalone configuration references (moved out of composition/localTaskRunSelection.ts).
  [RUNS]: [
    'createTaskRunConfigurationReferences',
    'requireTaskRunConfiguration',
    'requireTaskRunDriveBinding',
    'requireTaskRunRootSelection',
  ],
}
const LOCATIONS = [ARTIFACTS, DELETION, PROMPTS, OUTPUT, RUNS, LAUNCH, RUN_PORTS]
/** design D3: each composition file's offered names (unchanged), its control flow and its edges to the new locations. */
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
  [root('portArtifacts')]: {
    offers: [
      'archivePortArtifacts',
      'composePortArtifactOperations',
      'readPortArtifact',
      'createFilePortArtifactContent',
      'requirePortArtifactContentEffects',
      'requirePortArtifactOperations',
      'selectPortArtifactReader',
    ],
    shapes: [],
    takes: [
      // RFC-526: `selectPortArtifactOperations` is gone (its check now runs where the selection is used).
      `import ${ARTIFACTS}: archivePortArtifactPolicy, readPortArtifactPolicy, requirePortArtifactContentEffects, requirePortArtifactReader, runNativePortArtifactPolicy, runPortArtifactPolicy`,
      `export ${ARTIFACTS}: requirePortArtifactContentEffects, requirePortArtifactOperations`,
    ],
  },
  [root('taskDeletionEffects')]: {
    offers: ['composeLocalTaskDeletionEffects', 'requireTaskDeletionContentEffects'],
    shapes: [],
    // RFC-526: `selectedTaskDeletionEffects` is gone; its consumers check with the application's `requireTaskDeletionEffects`.
    takes: [`export ${DELETION}: requireTaskDeletionContentEffects`],
  },
  [root('nodeRunPrompts')]: {
    offers: [
      'PromptStorage',
      'composeLocalNodeRunPromptOperations',
      'composeNodeRunPromptOperations',
      'createFileNodeRunPromptContent',
      'nodeRunPromptRelPath',
      'readNodeRunPrompt',
      'requireNodeRunPromptContentEffects',
      'requireNodeRunPromptOperations',
      'storeNodeRunPrompt',
    ],
    shapes: [],
    takes: [
      // RFC-526: `selectNodeRunPromptOperations` is gone (its check now runs where the selection is used).
      `import ${PROMPTS}: readNodeRunPromptContent, requireNodeRunPromptContentEffects, storeNodeRunPromptContent`,
      `export ${PROMPTS}: requireNodeRunPromptContentEffects, requireNodeRunPromptOperations`,
    ],
  },
  [root('portOutputValidation')]: {
    offers: [
      'NODE_VALIDATE_IO',
      'composePortOutputContentValidation',
      'createNativePortOutputValidationContent',
      'resolveNativePortContentDetailed',
      'resolvePortContent',
      'resolvePortContentDetailed',
    ],
    shapes: [],
    takes: [
      `import ${OUTPUT}: bindPortOutputValidationEffects, portOutputValidationPolicy, requirePortOutputValidationContent`,
    ],
  },
  [root('taskRunSelection')]: {
    offers: [
      'TaskRunDriveBinding',
      'TaskRunRootBinding',
      'TaskRunRootSelection',
      'bindTaskRunRootSelection',
      'taskRunBindingPending',
    ],
    shapes: [],
    takes: [
      `import ${RUN_PORTS}: BoundTaskRunFamilies, TaskRunDriveBinding, TaskRunFamilyBinding, TaskRunRootBinding, TaskRunRootSelection`,
      `import ${RUNS}: requireTaskRunConfiguration, requireTaskRunRootSelection`,
      `export ${RUN_PORTS}: TaskRunDriveBinding, TaskRunRootBinding, TaskRunRootSelection`,
    ],
  },
  [root('launchConfiguration')]: {
    offers: ['composeTaskLaunchConfiguration', 'createFileTaskLaunchConfigurationQueries'],
    // The local start reads the native options only for a local-sync selection (runtime, not a check).
    shapes: ['if'],
    takes: [
      `import ${LAUNCH}: resolveTaskLaunchRuntimeConfiguration, resolveTaskLaunchRuntimeFromReader, resolveTaskStartLaunchConfiguration, resolveTaskSubagentLiveCapture, resolveTaskSubagentLiveCaptureFromReader, requireTaskLaunchConfigurationInput, TaskLaunchRuntimeConfiguration`,
    ],
  },
  [root('localTaskRunSelection')]: {
    offers: [
      'LocalTaskRunFamilyFactories',
      'ProviderTaskRunBindingSelection',
      'bindProviderTaskRunParticipantsInput',
      'composeLocalTaskRunSelection',
      'createLocalTaskRunConfigurationBridge',
    ],
    // The run-binding selection; RFC-514 moved the local configuration bridge's lookup (and its throw) to
    // application/taskRunSelection.ts as createTaskRunConfigurationReferences. RFC-527 moved the exclude-profile
    // selection, which only tests used, to tests/helpers/taskWorkspaceExcludeProfiles.ts. RFC-613 made the drive binding
    // required: the legacy direct arm (fixtures only) is tests/helpers/legacyTaskRunDriveBinding.ts, no branch is left.
    shapes: [],
    takes: [
      `import ${RUN_PORTS}: TaskRunContentNamespace, TaskRunFamilyBinding`,
      `import ${RUNS}: createTaskRunConfigurationReferences, requireTaskRunDriveBinding`,
    ],
  },
}
/** The production calls of every listed check (file and count) and the arguments of the single assembly call. */
const CALLS: Readonly<Record<string, readonly [readonly string[], readonly string[] | null]>> = {
  requirePortArtifactContentEffects: [[`${root('portArtifacts')} x1`], ['content']],
  // RFC-526: the operations `select*` is gone and the reader selection only checks the given reader; the prompt and
  // deletion checks now run where task-execution's infrastructure receives its required selections.
  requirePortArtifactOperations: [[], null],
  requirePortArtifactReader: [[`${root('portArtifacts')} x1`], ['selected']],
  requireTaskDeletionContentEffects: [
    [`${DELETION} x1`, `${TE}/infrastructure/taskDeleteRecovery x1`],
    null,
  ],
  requireTaskDeletionEffects: [
    [`${TE}/infrastructure/taskDelete x1`, `${TE}/infrastructure/taskDeleteRecovery x2`],
    null,
  ],
  requireNodeRunPromptContentEffects: [[`${root('nodeRunPrompts')} x1`], null],
  requireNodeRunPromptOperations: [
    [`${TE}/infrastructure/sessionTreeRead x1`, `${TE}/infrastructure/taskRouteOperations x2`],
    null,
  ],
  requireTaskRunRootSelection: [[`${root('taskRunSelection')} x1`], ['selected']],
  requireTaskRunConfiguration: [[`${root('taskRunSelection')} x1`], ['configuration']],
  // RFC-613: the provider runtime's binding is required; the single check takes the given one directly.
  requireTaskRunDriveBinding: [[`${root('localTaskRunSelection')} x1`], ['input.taskRunBinding']],
  requirePortOutputValidationContent: [[`${root('portOutputValidation')} x1`], ['content']],
  requireTaskLaunchConfigurationInput: [[`${root('launchConfiguration')} x1`], ['input']],
}
/** design §4 ③: the exact imports of the two new files. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [DELETION]: [
    `import ${TE}/application/ports/taskDeletionContentEffects: TaskDeletionContentEffects, TaskDeletionEffects`,
  ],
  // RFC-514: the configuration references take the drive request and family binding types.
  [RUNS]: [
    `import ${TE}/application/ports/taskExecutionTopology: TaskDriveRequest`,
    `import ${RUN_PORTS}: TaskRunConfigurationReference, TaskRunDriveBinding, TaskRunFamilyBinding, TaskRunRootSelection`,
  ],
}
/** The new files take only this module's ports. */
const PORTS_ONLY = (file: string, specifier: string): boolean =>
  (resolveSpecifier(file, specifier) ?? '').startsWith(`${TE}/application/ports/`)
/** No application file of this RFC takes the composition, infrastructure or bootstrap layers. */
const NOT_UPWARD = (file: string, specifier: string): boolean => {
  const resolved = resolveSpecifier(file, specifier) ?? specifier
  return !(
    resolved.startsWith(`${TE}/composition`) ||
    resolved.startsWith(`${TE}/infrastructure`) ||
    resolved.startsWith('bootstrap/')
  )
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

/** Control-flow statements anywhere in the file and every `new TypeError(…)` (design §4 ②). */
function checkShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'TypeError'
    )
      out.push('TypeError')
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return out
}

describe('RFC-510 ① 清单里的名字只在各自的位置声明', () => {
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
      expect(LISTED).toHaveLength(15)
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

describe('RFC-510 ② composition 只装配', () => {
  test('7 个组合文件里没有 TypeError 的构造，余下的控制流逐个钉住；从新位置取核对', () => {
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
        expect([name, callArguments(path, text(path), name)]).toEqual([name, [[...args]]])
      }
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：TypeError 的构造、多出的控制流、别处的 import 与多余的调用都会被认出', () => {
    const probe = join(SRC, `${TE}/composition/probe.ts`)
    const source = [
      `import { requireTaskRunDriveBinding } from '../application/taskRunSelection'`,
      `import { requirePortArtifactReader } from '@/${ARTIFACTS}'`,
      `export function compose(selected: never) {`,
      `  if (selected === null) throw new TypeError('Task provider requires a complete run binding')`,
      `  for (const item of [selected]) void item`,
      `  requireTaskRunDriveBinding(selected)`,
      `  requireTaskRunDriveBinding(selected)`,
      `  return requirePortArtifactReader(selected)`,
      `}`,
    ].join('\n')
    expect(edgesToLocations(moduleEdges(probe, source))).toEqual([
      `import ${RUNS}: requireTaskRunDriveBinding`,
      `import ${ARTIFACTS}: requirePortArtifactReader`,
    ])
    expect(checkShapes(probe, source)).toEqual(['if', 'throw', 'TypeError', 'for-of'])
    expect(callArguments(probe, source, 'requireTaskRunDriveBinding')).toEqual([
      ['selected'],
      ['selected'],
    ])
  })
})

describe('RFC-510 ③ 新代码的依赖面是闭集、不用进程全局', () => {
  test('两个新文件的 import 逐条钉住、只取本模块的端口；7 个 application 文件都不取组合层、基础设施与 bootstrap，不用进程全局', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect(purityFindings(path, text(path), PORTS_ONLY), location).toEqual([])
    }
    for (const location of LOCATIONS) {
      const path = sourceOf(location)
      expect(purityFindings(path, text(path), NOT_UPWARD), location).toEqual([])
    }
  })

  test('负对照：越界 import、多出的 import 与进程全局都会被认出', () => {
    const file = sourceOf(RUNS)
    const source = [
      `import type { TaskRunDriveBinding } from './ports/taskRunSelection'`,
      `import { bindTaskRunRootSelection } from '../composition/taskRunSelection'`,
      `import { createFileTaskDeletionContentEffects } from '../infrastructure/local/fileTaskDeletionContentEffects'`,
      `import { composeDaemonApplication } from '@/bootstrap/daemonApplication'`,
      `export async function run() { await import('node:fs'); const at = Date.now(); const env = process.env }`,
    ].join('\n')
    expect(purityFindings(file, source, NOT_UPWARD)).toEqual([
      'import ../composition/taskRunSelection',
      'import ../infrastructure/local/fileTaskDeletionContentEffects',
      'import @/bootstrap/daemonApplication',
      'Date.now',
      'process.env',
    ])
    expect(purityFindings(file, source, PORTS_ONLY)).toContain('import() node:fs')
    expect(moduleEdges(file, source)).not.toEqual(IMPORTS[RUNS])
  })
})

// ④ Behaviour, through the new locations.

const fn = () => undefined
const methods = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, fn]))
const ARTIFACT_EFFECTS = [
  'prepareArchive',
  'reference',
  'size',
  'copy',
  'readPrefix',
  'write',
  'linkTarget',
  'readArchive',
  'existsArchive',
  'readWorkspace',
  'existsWorkspace',
]

describe('RFC-510 ④ 端口完整性核对', () => {
  test('产物端口：内容收发 11 个方法、操作的 archive / read、只读读取器的 read，缺一就抛原文', () => {
    expect(() => requirePortArtifactContentEffects(methods(ARTIFACT_EFFECTS))).not.toThrow()
    for (const missing of ARTIFACT_EFFECTS) {
      const partial = methods(ARTIFACT_EFFECTS.filter((name) => name !== missing))
      expect(() => requirePortArtifactContentEffects(partial)).toThrow(
        new TypeError('Port artifacts require a complete content effects receiver'),
      )
    }
    for (const value of [null, 'x', methods(['archive'])])
      expect(() => requirePortArtifactOperations(value)).toThrow(
        new TypeError('Port artifacts require complete operations'),
      )
    expect(() => requirePortArtifactOperations(methods(['archive', 'read']))).not.toThrow()
    expect(() => requirePortArtifactReader(methods(['read']) as never)).not.toThrow()
    for (const value of [null, {}, { read: 'x' }])
      expect(() => requirePortArtifactReader(value as never)).toThrow(
        new TypeError('Port artifacts require a complete reader'),
      )
  })

  test('删除效果：先核对效果对象，再核对内容收发，最后核对仓库参与者', () => {
    const content = methods(['directories', 'removeIfPresent'])
    const repositories = methods(['removeWorktree', 'deleteSnapshotRefs'])
    expect(() => requireTaskDeletionEffects({ content, repositories } as never)).not.toThrow()
    expect(() => requireTaskDeletionEffects(null as never)).toThrow(
      new TypeError('Task deletion requires complete effects'),
    )
    expect(() =>
      requireTaskDeletionEffects({
        content: methods(['directories']),
        repositories: null,
      } as never),
    ).toThrow(new TypeError('Task deletion requires a complete content effects receiver'))
    expect(() =>
      requireTaskDeletionEffects({ content, repositories: methods(['removeWorktree']) } as never),
    ).toThrow(new TypeError('Task deletion requires a complete repository participant'))
    expect(() => requireTaskDeletionContentEffects(content)).not.toThrow()
    expect(() => requireTaskDeletionContentEffects(undefined)).toThrow(
      new TypeError('Task deletion requires a complete content effects receiver'),
    )
  })

  test('提示词端口：内容收发的 reference / write / read 与操作的 store / read', () => {
    expect(() =>
      requireNodeRunPromptContentEffects(methods(['reference', 'write', 'read'])),
    ).not.toThrow()
    expect(() => requireNodeRunPromptContentEffects(methods(['reference', 'write']))).toThrow(
      new TypeError('Node-run prompts require a complete content effects receiver'),
    )
    expect(() => requireNodeRunPromptOperations(methods(['store', 'read']))).not.toThrow()
    expect(() => requireNodeRunPromptOperations(methods(['store']))).toThrow(
      new TypeError('Node-run prompts require complete operations'),
    )
  })

  test('输出校验与启动配置：内容接收方的 resolve / readUtf8，读取器的种类与 read', () => {
    expect(() =>
      requirePortOutputValidationContent(methods(['resolve', 'readUtf8']) as never),
    ).not.toThrow()
    expect(() => requirePortOutputValidationContent(methods(['resolve']) as never)).toThrow(
      new TypeError('Port output validation requires a complete content receiver'),
    )
    for (const kind of ['local-sync', 'selected'])
      expect(() =>
        requireTaskLaunchConfigurationInput({ kind, queries: { read: fn } }),
      ).not.toThrow()
    for (const input of [
      { kind: 'other', queries: { read: fn } },
      { kind: 'selected', queries: null },
      { kind: 'local-sync', queries: undefined },
      { kind: 'selected', queries: {} as never },
    ])
      expect(() => requireTaskLaunchConfigurationInput(input)).toThrow(
        new TypeError('task-launch-configuration-incomplete'),
      )
  })

  test('运行选择：根选择的命名空间与两个运行族工厂、每次驱动的配置引用、选定的运行绑定', () => {
    const selection = {
      configurationFor: fn,
      runs: {
        contentNamespace: { kind: 'task-run-content-namespace', reference: {} },
        nodeRunPrompts: methods(['read', 'store']),
        portArtifacts: methods(['read', 'archive']),
        taskAgentRunsFor: fn,
        taskScriptRunsFor: fn,
      },
    }
    expect(() => requireTaskRunRootSelection(selection as never)).not.toThrow()
    for (const broken of [
      { ...selection, configurationFor: undefined },
      {
        ...selection,
        runs: { ...selection.runs, contentNamespace: { kind: 'other', reference: {} } },
      },
      { ...selection, runs: { ...selection.runs, taskScriptRunsFor: undefined } },
    ])
      expect(() => requireTaskRunRootSelection(broken as never)).toThrow(
        new TypeError('Task run selection requires complete content and execution families'),
      )
    expect(() =>
      requireTaskRunConfiguration({ kind: 'task-run-configuration', reference: {} } as never),
    ).not.toThrow()
    for (const configuration of [
      undefined,
      { kind: 'other', reference: {} },
      { kind: 'task-run-configuration', reference: null },
    ])
      expect(() => requireTaskRunConfiguration(configuration as never)).toThrow(
        new TypeError('Task run selection requires its configuration reference'),
      )
    expect(() => requireTaskRunDriveBinding({ bind: fn } as never)).not.toThrow()
    for (const binding of [null, {}, { bind: 'x' }])
      expect(() => requireTaskRunDriveBinding(binding as never)).toThrow(
        new TypeError('Task provider requires a complete run binding'),
      )
  })
})
