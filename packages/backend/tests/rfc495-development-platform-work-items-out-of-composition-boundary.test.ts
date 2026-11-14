// RFC-495 — 开发自动化的平台工作项用例迁出 composition（RFC-294 S10 第二步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里 24 个名字在全部生产文件里只在 development-automation 的 `application/employeePlatformWorkItems.ts` 声明；早已存在的同名项
//    逐个钉住。
// ② `composition/digitalEmployeePlatformWorkItems.ts` 只声明组合输入类型、bootstrap 输入类型与两个装配函数，只交出其中三个；没有控制流
//    语句（语法树）；装配函数把输入连同选定的工作区效果、基线读取、证据存储、业务树摘要与默认时钟交给 application 的用例。
// ③ 全部生产文件、用例与 e2e 从 composition 文件只取三个组合名字：命名 import、type-only、re-export、命名空间成员与动态 import 的解构
//    都认，带负对照。
// ④ 新文件的依赖面是闭集：zod、shared、`@/util/hash`、`@/util/gitRef`、digital-employee 的 `public/types` 与本模块的 domain /
//    application；不取 infrastructure、composition、IO 包，不用进程全局（带负对照）。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ④ 读 composition 文件与新文件。
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
const COMPOSITION = `${DA}/composition/digitalEmployeePlatformWorkItems`
const NEW_FILE = `${DA}/application/employeePlatformWorkItems`
const MOVED = [
  'DevelopmentEmployeePlatformWorkItemsInput',
  'createDevelopmentEmployeePlatformWorkItems',
  'DevelopmentReactionPlan',
  'employeeUploadPlanSchema',
  'EmployeeUploadPlan',
  'recordedUploadDigest',
  'resolveEmployeeUploadPlan',
  'candidateStateSchema',
  'MergeRequestReviewThreadState',
  'conflictValidationSchema',
  'contextsOf',
  'isTargetAwarePipelinePlan',
  'usesMinimalToolContracts',
  'contextPatch',
  'pendingPipelinePatch',
  'reconcileStaleReviewSelection',
  'platformOutput',
  'reviewReplyMarker',
  'reviewMarkerToken',
  'contextSchema',
  'envelopeSchema',
  'issueSchema',
  'Context',
  'issueOf',
] as const
/** Unrelated declarations that share a moved name, pinned one by one (all predate RFC-495). */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  contextsOf: [`${DA}/composition/digitalEmployeeWorkspace`],
  usesMinimalToolContracts: [`${DA}/application/employeeTypePackage`],
}
const COMPOSITION_DECLARED = [
  'DevelopmentEmployeePlatformWorkItemsCompositionInput',
  'DevelopmentEmployeePlatformWorkItemsBootstrapInput',
  'composeDevelopmentEmployeePlatformWorkItemsFromPersistence',
  'composeDevelopmentEmployeePlatformWorkItems',
]
const COMPOSITION_OFFERED = new Set([
  'DevelopmentEmployeePlatformWorkItemsCompositionInput',
  'composeDevelopmentEmployeePlatformWorkItemsFromPersistence',
  'composeDevelopmentEmployeePlatformWorkItems',
])
/** What the assembly hands the use case on top of the composition input (design D3). */
const BOUND = [
  'automationWorkspaceEffects',
  'baselineFileReader',
  'evidenceStore',
  'businessTreeDigest',
  'now',
]
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
 * `file -> composition: name` for every name other than the three composition names taken from the composition file:
 * named import, type-only, `export … from`, members of a namespace import (value and type positions), and the
 * destructured names of a dynamic `import()`; specifiers resolve from the file.
 */
function takenFromComposition(file: string, source: string): string[] {
  const out: string[] = []
  const label = slash(relative(REPO, file))
  const isComposition = (specifier: string) => resolveSpecifier(file, specifier) === COMPOSITION
  const flag = (name: string) => {
    if (!COMPOSITION_OFFERED.has(name)) out.push(`${label} -> ${COMPOSITION}: ${name}`)
  }
  const namespaces = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isComposition(node.moduleSpecifier.text)
    ) {
      if (ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements) flag((element.propertyName ?? element.name).text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          namespaces.add(bindings.name.text)
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          flag((element.propertyName ?? element.name).text)
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
        ts.isStringLiteral(call.arguments[0]) &&
        isComposition(call.arguments[0].text)
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
const mentionsComposition = (source: string) => /digitalEmployeePlatformWorkItems/.test(source)

/** The closed dependency surface of the new file (design §4 ④). */
function allowedDependency(file: string, specifier: string): boolean {
  if (
    ['zod', '@/util/hash', '@/util/gitRef', '@/modules/digital-employee/public/types'].includes(
      specifier,
    )
  )
    return true
  if (specifier === '@agent-workflow/shared' || specifier.startsWith('@agent-workflow/shared/'))
    return true
  const rel = resolveSpecifier(file, specifier)
  return rel !== null && /^modules\/development-automation\/(?:domain|application)\//.test(rel)
}

/** Imports outside the closed surface and process globals, read from the syntax tree. */
function purityFindings(file: string, source: string): string[] {
  const findings: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !allowedDependency(file, node.moduleSpecifier.text)
    )
      findings.push(`import ${node.moduleSpecifier.text}`)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      !allowedDependency(file, node.arguments[0].text)
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

describe('RFC-495 ① 清单里的名字只在新的 application 文件声明', () => {
  test(
    '全部生产文件里每个名字只在新文件声明（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const name of MOVED) {
        const declaring = PRODUCTION.filter(
          (path) =>
            new RegExp(`\\b${name}\\b`).test(text(path)) &&
            declaredNames(path, text(path)).includes(name),
        )
          .map(srcPath)
          .sort()
        expect([name, declaring]).toEqual([name, [NEW_FILE, ...(HOMONYMS[name] ?? [])].sort()])
      }
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-495 ② composition 只留装配', () => {
  const path = join(SRC, `${COMPOSITION}.ts`)

  test('只声明组合输入类型、bootstrap 输入类型与两个装配函数，只交出其中三个', () => {
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

  test('装配函数把输入连同五个绑定交给 application 的用例，恰好一次', () => {
    const calls: ts.CallExpression[] = []
    const file = parse(path, text(path))
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createDevelopmentEmployeePlatformWorkItems'
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

describe('RFC-495 ③ 没有文件从 composition 取迁出的名字', () => {
  test(
    '全部生产文件、用例（语料下限 2,500）与 e2e',
    () => {
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      expect(
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter((path) => mentionsComposition(text(path)))
          .flatMap((path) => takenFromComposition(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：命名 import、type-only、re-export、命名空间成员与动态 import 的解构都会被认出，三个组合名字与新位置不算', () => {
    const file = join(SRC, 'bootstrap/daemonModules/probe.ts')
    const source = [
      `import { composeDevelopmentEmployeePlatformWorkItems, createDevelopmentEmployeePlatformWorkItems } from '@/${COMPOSITION}'`,
      `import type { DevelopmentEmployeePlatformWorkItemsCompositionInput, DevelopmentEmployeePlatformWorkItemsInput } from '@/${COMPOSITION}'`,
      `export { composeDevelopmentEmployeePlatformWorkItemsFromPersistence, DevelopmentReactionPlan } from '../../${COMPOSITION}'`,
      `import * as platform from '@/${COMPOSITION}'`,
      `const assembled = platform.composeDevelopmentEmployeePlatformWorkItems`,
      `const planned: platform.DevelopmentReactionPlan | undefined = undefined`,
      `const { resolveEmployeeUploadPlan } = await import('@/${COMPOSITION}')`,
      `import { createDevelopmentEmployeePlatformWorkItems as create } from '@/${NEW_FILE}'`,
    ].join('\n')
    const label = slash(relative(REPO, file))
    expect(takenFromComposition(file, source)).toEqual([
      `${label} -> ${COMPOSITION}: createDevelopmentEmployeePlatformWorkItems`,
      `${label} -> ${COMPOSITION}: DevelopmentEmployeePlatformWorkItemsInput`,
      `${label} -> ${COMPOSITION}: DevelopmentReactionPlan`,
      `${label} -> ${COMPOSITION}: DevelopmentReactionPlan`,
      `${label} -> ${COMPOSITION}: resolveEmployeeUploadPlan`,
    ])
  })
})

describe('RFC-495 ④ 新文件的依赖面是闭集、不用进程全局', () => {
  test('只取 zod、shared、@/util/hash、@/util/gitRef、digital-employee 的 public/types 与本模块 domain / application', () => {
    const path = join(SRC, `${NEW_FILE}.ts`)
    expect(purityFindings(path, text(path))).toEqual([])
  })

  test('负对照：越界 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${DA}/application/probe.ts`)
    const source = [
      `import { z } from 'zod'`,
      `import { utf16MinLength } from '@agent-workflow/shared'`,
      `import { sha256Hex } from '@/util/hash'`,
      `import type { EmployeeReactionRoundQueryPort } from '@/modules/digital-employee/public/types'`,
      `import { canonicalDigest } from '../domain/canonicalJson'`,
      `import { withSelectedAutomationWorkspaceEffects } from './automationWorkspaceEffectLifetime'`,
      `import { readFileSync } from 'node:fs'`,
      `import { EvidenceStore } from '../infrastructure/evidenceStore'`,
      `import { composeDevelopmentEmployeePlatformWorkItems } from '../composition/digitalEmployeePlatformWorkItems'`,
      `import type { EmployeeCase } from '@/modules/digital-employee/domain/model'`,
      `import { isLexicallyInsideForHost } from '@/util/platformExec'`,
      `export async function run() { await import('node:path'); const at = Date.now(); process.exit(at); await fetch('x') }`,
      `const at = new Date(0).toISOString()`,
    ].join('\n')
    expect(purityFindings(file, source)).toEqual([
      'import node:fs',
      'import ../infrastructure/evidenceStore',
      'import ../composition/digitalEmployeePlatformWorkItems',
      'import @/modules/digital-employee/domain/model',
      'import @/util/platformExec',
      'import() node:path',
      'Date.now',
      'process.exit',
      'fetch()',
    ])
  })
})
