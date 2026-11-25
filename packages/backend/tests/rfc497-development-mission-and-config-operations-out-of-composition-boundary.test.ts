// RFC-497 — 开发自动化的 mission 与配置操作用例迁出 composition（RFC-294 S10 第四步）。
//
// 锁五件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件里只在清单列的文件声明：mission 用例在 `application/missionOperationHandlers.ts`，它用的参与方端口在
//    `application/ports/developmentMissionAutomation.ts`，配置用例在 `application/configOperationHandlers.ts`；早已存在的同名项逐个钉住，
//    `log`、`Actor` 这类通用名只核对新文件。
// ② 两个 composition 文件只声明、交出与转出 design §3 列的名字，没有控制流语句（语法树）；装配函数恰好一次调用 application 的用例：
//    mission 一侧按原次序绑定 7 个持久化，交出按 `persistence.repositories` 与 `deps.repositoryBaselines` 建的基线解析与默认时钟；配置
//    一侧交出 `deps.now ?? Date.now`。
// ③ `composition.ts` 的 `DevelopmentAutomationModule` 继承端口、只声明其余 6 个成员；端口恰好声明 mission 用例用到的 10 个成员。
// ④ 全部生产文件、用例与 e2e 不从旧位置取迁出的名字：两个 composition 文件只给 design §3 列的名字；命名 import、type-only、re-export、
//    命名空间成员与动态 import 的解构都认，带负对照。
// ⑤ 新文件的依赖面是闭集：mission 用例只取 zod、`ulid`、shared、`@/platform/errors/domainErrors`、`@/platform/logging/logger` 与本模块 domain / application；配置用例只取
//    `ulid`、shared、`@/platform/errors/domainErrors`、identity-access 的 `public/participants` 与本模块 domain / application / engine；端口只取本模块
//    application；都不用进程全局（带负对照）。
//
// 覆盖范围（C12）：① ④ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ③ ⑤ 读两个 composition 文件、`composition.ts` 与三个新文件。
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
const MISSION_COMPOSITION = `${DA}/composition/missionOperations`
const CONFIG_COMPOSITION = `${DA}/composition/configOperations`
const MODULE_COMPOSITION = `${DA}/composition`
const MISSION = `${DA}/application/missionOperationHandlers`
const AUTOMATION_PORT = `${DA}/application/ports/developmentMissionAutomation`
const CONFIG = `${DA}/application/configOperationHandlers`

/** design §3: where each moved name is declared now. */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  [MISSION]: [
    'DevelopmentMissionOperationsInput',
    'DevelopmentMissionOperationPersistence',
    'createDevelopmentMissionOperations',
    'MissionCursorSchema',
    'MissionViewSchema',
    'RawMissionStatusesSchema',
    'MissionStatusesSchema',
    'refreshFailureError',
    'encodeMissionCursor',
    'decodeMissionCursor',
  ],
  [AUTOMATION_PORT]: ['DevelopmentMissionAutomation'],
  [CONFIG]: [
    'DevelopmentConfigAccessRow',
    'DevelopmentConfigResourceAccess',
    'DevelopmentConfigOperationsInput',
    'createDevelopmentConfigOperations',
    'identityView',
    'requireVisible',
    'requireEditable',
    'requireGovernable',
    'invalidDraft',
  ],
}
/** Moved private names that many unrelated files also declare: checked in the new files only (② keeps them out of composition). */
const GENERIC: Readonly<Record<string, readonly string[]>> = {
  [MISSION]: ['log'],
  [CONFIG]: ['Actor'],
}
/** Declarations that share a moved name and predate RFC-497, pinned one by one. */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  // RFC-502 moved integration's copy with its configuration operations into application.
  identityView: ['modules/integration/application/developmentAdapterConfigOperations'],
}
const MISSION_COMPOSITION_NAMES = [
  'DevelopmentMissionOperationCompositionOptions',
  'createLegacyMissionAdmissionsEnabledQuery',
  'DevelopmentMissionOperationCompositionDeps',
  'composeDevelopmentMissionOperations',
]
const CONFIG_COMPOSITION_NAMES = [
  'DevelopmentConfigCompositionDependencies',
  'composeDevelopmentConfigOperationsFromPersistence',
  'composeDevelopmentConfigOperationsFor',
  'composeDevelopmentConfigOperations',
]
/** The one type the configuration composition forwards for bootstrap (design D5). */
const CONFIG_FORWARDED = ['DevelopmentConfigResourceAccess']
/** design D5: the Mission assembly binds these persistence ports, in this order. */
const MISSION_PERSISTENCE = [
  'uploads',
  'snapshots',
  'missions',
  'repositories',
  'readModels',
  'cutover',
  'migration',
]
/** design D2 / D5: what the Mission assembly hands the use case. */
const MISSION_PASSED = [
  'mrEffects',
  'repositoryClaimKeys',
  'admissionLookup',
  'automation',
  'legacyAdmissionsEnabled',
]
/** design D3: the participant members the Mission operations use, and the ones the participant adds. */
const PORT_MEMBERS = [
  'materializer',
  'evidenceContents',
  'evidenceDownloads',
  'collaboration',
  'drive',
  'confirmNoChange',
  'submitAnswers',
  'handoff',
  'attachMr',
  'resume',
]
const MODULE_MEMBERS = [
  'evidence',
  'reconcile',
  'sweepWakes',
  'sweepUploads',
  'sweepRetention',
  'recover',
]
/** design §2 ④: what an old location may still give; anything else taken from it is a finding. */
const OLD_LOCATIONS: Readonly<Record<string, (name: string) => boolean>> = {
  [MISSION_COMPOSITION]: (name) => MISSION_COMPOSITION_NAMES.includes(name),
  [CONFIG_COMPOSITION]: (name) => [...CONFIG_COMPOSITION_NAMES, ...CONFIG_FORWARDED].includes(name),
}
const mentionsOldLocation = (source: string) => /missionOperations|configOperations/.test(source)
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

/** Member names of a top-level interface, in source order, and the names it extends. */
function interfaceShape(path: string, source: string, name: string) {
  const declaration = parse(path, source).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  return {
    extends: (declaration?.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((type) => type.expression.getText()),
    ),
    members: (declaration?.members ?? []).map((member) => member.name?.getText() ?? '?'),
  }
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

const isShared = (specifier: string) =>
  specifier === '@agent-workflow/shared' || specifier.startsWith('@agent-workflow/shared/')
const ownLayer =
  (layers: readonly string[]) =>
  (file: string, specifier: string): boolean => {
    const rel = resolveSpecifier(file, specifier)
    return rel !== null && layers.some((layer) => rel.startsWith(`${DA}/${layer}/`))
  }
/** The closed dependency surface of each new file (design §4 ⑤). */
const SURFACES: Readonly<Record<string, (file: string, specifier: string) => boolean>> = {
  [MISSION]: (file, specifier) =>
    ['zod', 'ulid', '@/platform/errors/domainErrors', '@/platform/logging/logger'].includes(
      specifier,
    ) ||
    isShared(specifier) ||
    ownLayer(['domain', 'application'])(file, specifier),
  [CONFIG]: (file, specifier) =>
    [
      'ulid',
      '@/platform/errors/domainErrors',
      '@/modules/identity-access/public/participants',
    ].includes(specifier) ||
    isShared(specifier) ||
    ownLayer(['domain', 'application', 'engine'])(file, specifier),
  [AUTOMATION_PORT]: ownLayer(['application']),
}

/** Imports outside the given surface and process globals, read from the syntax tree. */
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

describe('RFC-497 ① 清单里的名字只在清单列的文件声明', () => {
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

  test('通用名只核对新文件：在新文件声明', () => {
    for (const [location, names] of Object.entries(GENERIC)) {
      const path = sourceOf(location)
      expect([
        location,
        names.filter((name) => !declaredNames(path, text(path)).includes(name)),
      ]).toEqual([location, []])
    }
  })
})

describe('RFC-497 ② composition 只留装配', () => {
  const missionPath = sourceOf(MISSION_COMPOSITION)
  const configPath = sourceOf(CONFIG_COMPOSITION)

  test('两个文件只声明、交出与转出 design §3 列的名字', () => {
    expect(declaredNames(missionPath, text(missionPath)).sort()).toEqual(
      [...MISSION_COMPOSITION_NAMES].sort(),
    )
    expect(offeredNames(missionPath, text(missionPath)).sort()).toEqual(
      [...MISSION_COMPOSITION_NAMES].sort(),
    )
    expect(declaredNames(configPath, text(configPath)).sort()).toEqual(
      [...CONFIG_COMPOSITION_NAMES].sort(),
    )
    expect(offeredNames(configPath, text(configPath)).sort()).toEqual(
      [...CONFIG_COMPOSITION_NAMES, ...CONFIG_FORWARDED].sort(),
    )
  })

  test('没有 if / for / while / do / switch / try / throw', () => {
    expect(controlFlowStatements(missionPath, text(missionPath))).toEqual([])
    expect(controlFlowStatements(configPath, text(configPath))).toEqual([])
    expect(controlFlowStatements('probe.ts', 'if (a) for (const b of c) throw b')).toEqual([
      'IfStatement:1',
      'ForOfStatement:1',
      'ThrowStatement:1',
    ])
  })

  test('mission 装配按原次序绑定 7 个持久化，连同基线解析与默认时钟交给 application 的用例，恰好一次', () => {
    const file = parse(missionPath, text(missionPath))
    const calls = callsOf(file, 'createDevelopmentMissionOperations')
    expect(calls).toHaveLength(1)
    expect(literalShape(file, calls[0]!.arguments[0])).toEqual([
      ...MISSION_PASSED.map((name) => `${name}: deps.${name}`),
      'resolveBaseline: createRepositoryBaselineResolverFromLocations(persistence.repositories,deps.repositoryBaselines,)',
      'now: Date.now',
    ])
    expect(calls[0]!.arguments.map((argument) => argument.getText(file)).slice(1)).toEqual([
      'persistence',
    ])
    const binding = file.statements
      .filter(ts.isFunctionDeclaration)
      .find((statement) => statement.name?.text === 'composeDevelopmentMissionOperations')
      ?.body?.statements.find(ts.isVariableStatement)?.declarationList.declarations[0]
    expect(binding?.name.getText(file)).toBe('persistence')
    expect(literalShape(file, binding?.initializer).map((entry) => entry.split(':')[0])).toEqual(
      MISSION_PERSISTENCE,
    )
    expect(callsOf(file, 'createRepositoryBaselineResolverFromLocations')).toHaveLength(1)
  })

  test('配置装配把组合依赖连同默认时钟交给 application 的用例，恰好一次', () => {
    const file = parse(configPath, text(configPath))
    const calls = callsOf(file, 'createDevelopmentConfigOperations')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.arguments).toHaveLength(1)
    expect(literalShape(file, calls[0]!.arguments[0])).toEqual([
      '...deps',
      'now: deps.now??Date.now',
    ])
  })

  test('负对照：多传、少传或换了次序都会被认出', () => {
    const file = parse(
      'probe.ts',
      'const persistence = { snapshots: a, uploads: b }\ncreate({ ...deps, now: Date.now, extra: 1 })',
    )
    const create = callsOf(file, 'create')
    expect(literalShape(file, create[0]!.arguments[0])).toEqual([
      '...deps',
      'now: Date.now',
      'extra: 1',
    ])
    const binding = file.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!
    expect(literalShape(file, binding.initializer).map((entry) => entry.split(':')[0])).toEqual([
      'snapshots',
      'uploads',
    ])
    expect(literalShape(file, undefined)).toEqual(['<not an object literal>'])
  })
})

describe('RFC-497 ③ 模块参与方继承 mission 用例的端口', () => {
  test('DevelopmentAutomationModule 继承端口、只声明其余 6 个成员；端口恰好声明 10 个成员', () => {
    const module = sourceOf(MODULE_COMPOSITION)
    expect(interfaceShape(module, text(module), 'DevelopmentAutomationModule')).toEqual({
      extends: ['DevelopmentMissionAutomation'],
      members: MODULE_MEMBERS,
    })
    const port = sourceOf(AUTOMATION_PORT)
    expect(interfaceShape(port, text(port), 'DevelopmentMissionAutomation')).toEqual({
      extends: [],
      members: PORT_MEMBERS,
    })
  })

  test('负对照：没有继承或重复声明端口成员会被认出', () => {
    expect(
      interfaceShape(
        'probe.ts',
        'export interface DevelopmentAutomationModule { readonly materializer: X; reconcile(): void }',
        'DevelopmentAutomationModule',
      ),
    ).toEqual({ extends: [], members: ['materializer', 'reconcile'] })
  })
})

describe('RFC-497 ④ 没有文件从旧位置取迁出的名字', () => {
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
      `import { composeDevelopmentMissionOperations, createDevelopmentMissionOperations } from '@/${MISSION_COMPOSITION}'`,
      `import type { DevelopmentMissionOperationCompositionOptions, DevelopmentMissionOperationsInput } from '@/${MISSION_COMPOSITION}'`,
      `export { createLegacyMissionAdmissionsEnabledQuery, encodeMissionCursor } from '../../${MISSION_COMPOSITION}'`,
      `import { composeDevelopmentConfigOperationsFor, type DevelopmentConfigResourceAccess, type DevelopmentConfigAccessRow } from '@/${CONFIG_COMPOSITION}'`,
      `import * as config from '@/${CONFIG_COMPOSITION}'`,
      `const create = config.createDevelopmentConfigOperations`,
      `const input: config.DevelopmentConfigOperationsInput | undefined = undefined`,
      `const { requireEditable } = await import('@/${CONFIG_COMPOSITION}')`,
      `import { createDevelopmentMissionOperations as mission } from '@/${MISSION}'`,
      `import { createDevelopmentConfigOperations as configure } from '@/${CONFIG}'`,
      `import type { DevelopmentMissionAutomation } from '@/${AUTOMATION_PORT}'`,
    ].join('\n')
    const label = slash(relative(REPO, file))
    expect(takenFromOldLocations(file, source)).toEqual([
      `${label} -> ${MISSION_COMPOSITION}: createDevelopmentMissionOperations`,
      `${label} -> ${MISSION_COMPOSITION}: DevelopmentMissionOperationsInput`,
      `${label} -> ${MISSION_COMPOSITION}: encodeMissionCursor`,
      `${label} -> ${CONFIG_COMPOSITION}: DevelopmentConfigAccessRow`,
      `${label} -> ${CONFIG_COMPOSITION}: createDevelopmentConfigOperations`,
      `${label} -> ${CONFIG_COMPOSITION}: DevelopmentConfigOperationsInput`,
      `${label} -> ${CONFIG_COMPOSITION}: requireEditable`,
    ])
  })
})

describe('RFC-497 ⑤ 新文件的依赖面是闭集、不用进程全局', () => {
  test('mission 用例、配置用例与端口各自只取自己的依赖面', () => {
    for (const [location, allowed] of Object.entries(SURFACES)) {
      const path = sourceOf(location)
      expect([location, purityFindings(path, text(path), allowed)]).toEqual([location, []])
    }
  })

  test('负对照：越界 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${DA}/application/probe.ts`)
    const source = [
      `import { z } from 'zod'`,
      `import { ulid } from 'ulid'`,
      `import { DIGITAL_EMPLOYEE_MISSION_STATUSES } from '@agent-workflow/shared'`,
      `import { ConflictError } from '@/platform/errors/domainErrors'`,
      `import { createLogger } from '@/platform/logging/logger'`,
      `import { launchMission } from './commands/launchMission'`,
      `import { projectMissionJourney } from '../domain/journeyProjection'`,
      `import { evaluatePolicy } from '../engine/policy/evaluatePolicy'`,
      `import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'`,
      `import { readFileSync } from 'node:fs'`,
      `import { createRepositoryBaselineResolverFromLocations } from '../infrastructure/gitBaselineReader'`,
      `import type { DevelopmentAutomationModule } from '../composition'`,
      `import { composeDevelopmentConfigOperationsFor } from '../composition/configOperations'`,
      `import { isLexicallyInsideForHost } from '@/platform/execution/local/platformExec'`,
      `export async function run() { await import('node:path'); const at = Date.now(); process.exit(at); await fetch('x') }`,
      `const at = new Date(0).toISOString()`,
    ].join('\n')
    const globals = ['import() node:path', 'Date.now', 'process.exit', 'fetch()']
    const outside = [
      'import node:fs',
      'import ../infrastructure/gitBaselineReader',
      'import ../composition',
      'import ../composition/configOperations',
      'import @/platform/execution/local/platformExec',
    ]
    expect(purityFindings(file, source, SURFACES[MISSION]!)).toEqual([
      'import ../engine/policy/evaluatePolicy',
      'import @/modules/identity-access/public/participants',
      ...outside,
      ...globals,
    ])
    expect(purityFindings(file, source, SURFACES[CONFIG]!)).toEqual([
      'import zod',
      'import @/platform/logging/logger',
      ...outside,
      ...globals,
    ])
    expect(purityFindings(file, source, SURFACES[AUTOMATION_PORT]!)).toEqual([
      'import zod',
      'import ulid',
      'import @agent-workflow/shared',
      'import @/platform/errors/domainErrors',
      'import @/platform/logging/logger',
      'import ../domain/journeyProjection',
      'import ../engine/policy/evaluatePolicy',
      'import @/modules/identity-access/public/participants',
      ...outside,
      ...globals,
    ])
  })
})
