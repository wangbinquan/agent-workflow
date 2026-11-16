// RFC-500 — 集成的开发员工事件观察者迁出 composition（RFC-294 S10 第七步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在清单列的文件声明：观察者与它们的纯投影、游标只在
//    `application/developmentEventObservers.ts`，装配函数只在 `composition/digitalEmployeeEventObserver.ts`；改名前的两个 `compose…`
//    观察者不再有声明。两个文件只声明、只交出清单的名字。
// ② 装配文件只取 `node:crypto` 与新文件、没有控制流语句与回落，两个观察者与分派器各建恰好一次，时钟恰好两处 `Date.now`、激活标识
//    恰好一处 `randomUUID`；bootstrap 只从装配文件取装配函数、调用恰好一次，交部署选定的绑定与网关；三个用例的时钟与激活标识必填
//    （带负对照）。
// ③ 全部生产文件、用例与 e2e 不从旧位置取迁走的名字（那里只剩装配函数）：命名 import、type-only、默认与副作用 import、re-export、
//    命名空间成员与动态 import 都认，带负对照。
// ④ 新文件的依赖面是闭集：只取 shared、zod、`@/util/hash`、development-automation 的 `public/types` 与同目录的 `mrFacts` /
//    `mrEnsure`；不取 infrastructure、composition、IO 包，不用进程全局（带负对照）。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ④ 读装配文件、bootstrap 的 `daemonModules/integration.ts` 与新文件。
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

const INT = 'modules/integration'
const ASSEMBLY_FILE = `${INT}/composition/digitalEmployeeEventObserver`
const OBSERVERS = `${INT}/application/developmentEventObservers`
const BOOTSTRAP = 'bootstrap/daemonModules/integration'

/** design §3: what the new file declares — five offered, the rest private to it. */
const OFFERED = [
  'buildDevelopmentCodeHostFacts',
  'advanceDevelopmentCodeHostObserverCursor',
  'createDevelopmentCodeHostEventObserver',
  'createDevelopmentApprovalEventObserver',
  'createDevelopmentEmployeeEventObserver',
]
const PRIVATE = [
  'ObserverSource',
  'ObserverSubject',
  'splitMrSubject',
  'DevelopmentCodeHostFact',
  'CursorFactCode',
  'cursorFactCodeByEventType',
  'codeHostFactRevisionByEventType',
  'codeHostFactRevision',
  'observerCursorEntrySchema',
  'observerCursorSubjectSchema',
  'observerCursorSchema',
  'approvalObserverCursorSchema',
  'DevelopmentApprovalObservationGateway',
]
/** The one name the assembly file keeps; the two renamed observers have no declaration anywhere. */
const ASSEMBLY = 'composeDevelopmentEmployeeEventObserver'
const RETIRED = [
  'composeDevelopmentCodeHostEventObserver',
  'composeDevelopmentApprovalEventObserver',
]
/** design D3: the assembly's three constructions, whitespace removed. */
const CODE_HOST_FIELDS = ['binding: input.binding', 'now: Date.now', 'activationRef: randomUUID']
const APPROVAL_FIELDS = ['gateway: input.gateway', 'now: Date.now']
const DISPATCH_FIELDS = [
  'codeHost: createDevelopmentCodeHostEventObserver({binding:input.binding,now:Date.now,activationRef:randomUUID,})',
  'approval: createDevelopmentApprovalEventObserver({gateway:input.gateway,now:Date.now})',
]
const BOOTSTRAP_FIELDS = [
  'binding: input.developmentCodeHostBinding',
  'gateway: developmentApprovalGateway',
]
const mentionsOldLocation = (source: string) => /digitalEmployeeEventObserver/.test(source)
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
/** The single call of `name`'s object-literal argument, or a marker when the call count is not one. */
function onlyCallShape(file: ts.SourceFile, name: string): string[] {
  const calls = callsOf(file, name)
  if (calls.length !== 1) return [`<${calls.length} calls>`]
  return literalShape(file, calls[0]!.arguments.length === 1 ? calls[0]!.arguments[0] : undefined)
}
/** Every static import of the file as `specifier: names` (resolved under `src`; packages as written). */
function importsOf(file: string, source: string): string[] {
  const out: string[] = []
  for (const statement of parse(file, source).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const from =
      resolveSpecifier(file, statement.moduleSpecifier.text) ?? statement.moduleSpecifier.text
    const bindings = statement.importClause?.namedBindings
    const names =
      bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => element.name.text)
        : ['<other>']
    out.push(`${from}: ${names.join(', ')}`)
  }
  return out
}
/** Control-flow statements and fallback expressions anywhere in the file (design §3: the assembly has none). */
function controlFlow(path: string, source: string): string[] {
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isConditionalExpression(node)
    )
      found.push(ts.SyntaxKind[node.kind])
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    )
      found.push(ts.SyntaxKind[node.operatorToken.kind])
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return found
}
/** How many identifiers named `name` the file has (declarations, calls and references alike). */
function identifierCount(path: string, source: string, name: string): number {
  let count = 0
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) count++
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return count
}
/** How many `object.member` property accesses the file has. */
function memberCount(path: string, source: string, object: string, member: string): number {
  let count = 0
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === object &&
      node.name.text === member
    )
      count++
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return count
}
/** The first parameter's type-literal member `member` of the top-level function `fn`: optional or not, null when absent. */
function parameterMemberOptional(
  path: string,
  source: string,
  fn: string,
  member: string,
): boolean | null {
  const declaration = parse(path, source).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
  )
  const type = declaration?.parameters[0]?.type
  const found =
    type !== undefined && ts.isTypeLiteralNode(type)
      ? type.members.find((candidate) => candidate.name?.getText() === member)
      : undefined
  return found === undefined ? null : found.questionToken !== undefined
}
/** The first `count` statements of the top-level function `fn`, whitespace collapsed. */
function leadingStatementsOf(path: string, source: string, fn: string, count: number): string[] {
  const file = parse(path, source)
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === fn,
  )
  return (declaration?.body?.statements ?? [])
    .slice(0, count)
    .map((statement) => statement.getText(file).replace(/\s+/g, ' '))
}

/**
 * `file -> old location: what` for everything a file takes from the assembly file other than the assembly function
 * (design §4 ③): named import, type-only, default and side-effect import, `export … from` and `export * from`, members
 * of a namespace import (value and type positions), and dynamic `import()` with its destructured names; specifiers
 * resolve from the file. Any `import()` of the old location is flagged as such, since it can reach every name.
 */
function takenFromOldLocation(file: string, source: string): string[] {
  const out: string[] = []
  const label = corpusPath(file)
  const fromOld = (specifier: string) => resolveSpecifier(file, specifier) === ASSEMBLY_FILE
  const flag = (what: string) => {
    if (what !== ASSEMBLY) out.push(`${label} -> ${ASSEMBLY_FILE}: ${what}`)
  }
  const namespaces = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      fromOld(node.moduleSpecifier.text)
    ) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        if (clause === undefined) flag('<side effect>')
        if (clause?.name !== undefined) flag('default')
        const bindings = clause?.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements) flag((element.propertyName ?? element.name).text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          namespaces.add(bindings.name.text)
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          flag((element.propertyName ?? element.name).text)
      else flag('*')
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      fromOld(node.arguments[0].text)
    )
      flag('import()')
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
        fromOld(call.arguments[0].text)
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

const isShared = (specifier: string) =>
  specifier === '@agent-workflow/shared' || specifier.startsWith('@agent-workflow/shared/')
/** The closed dependency surface of the new file (design §4 ④). */
const SURFACE = (file: string, specifier: string): boolean => {
  if (['zod', '@/util/hash', '@/modules/development-automation/public/types'].includes(specifier))
    return true
  if (isShared(specifier)) return true
  const rel = resolveSpecifier(file, specifier)
  return rel !== null && [`${INT}/application/mrFacts`, `${INT}/application/mrEnsure`].includes(rel)
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

describe('RFC-500 ① 清单里的名字只在清单列的文件声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个名字只在清单列的文件声明，改名前的两个观察者没有声明（语料下限 3,000 / 2,500）',
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
      for (const name of [...OFFERED, ...PRIVATE])
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${OBSERVERS}.ts`]])
      expect([ASSEMBLY, declaring(ASSEMBLY)]).toEqual([
        ASSEMBLY,
        [`packages/backend/src/${ASSEMBLY_FILE}.ts`],
      ])
      for (const name of RETIRED) expect([name, declaring(name)]).toEqual([name, []])
    },
    CORPUS_TIMEOUT,
  )

  test('新文件只声明清单的名字、只交出其中五个；装配文件只声明并交出装配函数', () => {
    const observers = sourceOf(OBSERVERS)
    expect(declaredNames(observers, text(observers)).sort()).toEqual(
      [...OFFERED, ...PRIVATE].sort(),
    )
    expect(offeredNames(observers, text(observers)).sort()).toEqual([...OFFERED].sort())
    const assembly = sourceOf(ASSEMBLY_FILE)
    expect(declaredNames(assembly, text(assembly))).toEqual([ASSEMBLY])
    expect(offeredNames(assembly, text(assembly))).toEqual([ASSEMBLY])
  })
})

describe('RFC-500 ② composition 只装配，bootstrap 只调装配函数', () => {
  const assemblyPath = sourceOf(ASSEMBLY_FILE)
  const bootstrapPath = sourceOf(BOOTSTRAP)
  const observersPath = sourceOf(OBSERVERS)

  test('装配文件只取 node:crypto 与新文件，没有控制流与回落，三个构造各恰好一次、交进程时钟与 randomUUID', () => {
    const source = text(assemblyPath)
    expect(importsOf(assemblyPath, source)).toEqual([
      'node:crypto: randomUUID',
      `${OBSERVERS}: createDevelopmentApprovalEventObserver, createDevelopmentCodeHostEventObserver, createDevelopmentEmployeeEventObserver`,
    ])
    expect(controlFlow(assemblyPath, source)).toEqual([])
    const file = parse(assemblyPath, source)
    expect(onlyCallShape(file, 'createDevelopmentCodeHostEventObserver')).toEqual(CODE_HOST_FIELDS)
    expect(onlyCallShape(file, 'createDevelopmentApprovalEventObserver')).toEqual(APPROVAL_FIELDS)
    expect(onlyCallShape(file, 'createDevelopmentEmployeeEventObserver')).toEqual(DISPATCH_FIELDS)
    expect(memberCount(assemblyPath, source, 'Date', 'now')).toBe(2)
    expect(identifierCount(assemblyPath, source, 'randomUUID')).toBe(2) // the import and the one use
  })

  test('bootstrap 只从装配文件取装配函数、调用恰好一次，交部署选定的绑定与网关', () => {
    const source = text(bootstrapPath)
    expect(importsOf(bootstrapPath, source).filter((line) => line.startsWith(`${INT}/`))).toContain(
      `${ASSEMBLY_FILE}: ${ASSEMBLY}`,
    )
    expect(
      importsOf(bootstrapPath, source).filter((line) => line.startsWith(`${ASSEMBLY_FILE}:`)),
    ).toEqual([`${ASSEMBLY_FILE}: ${ASSEMBLY}`])
    expect(onlyCallShape(parse(bootstrapPath, source), ASSEMBLY)).toEqual(BOOTSTRAP_FIELDS)
    for (const name of [...RETIRED, ...OFFERED])
      expect([name, identifierCount(bootstrapPath, source, name)]).toEqual([name, 0])
  })

  test('三个用例的时钟与激活标识必填，开头直接取输入', () => {
    const source = text(observersPath)
    expect(
      [
        ['createDevelopmentCodeHostEventObserver', 'now'],
        ['createDevelopmentCodeHostEventObserver', 'activationRef'],
        ['createDevelopmentApprovalEventObserver', 'now'],
      ].map(([fn, member]) => parameterMemberOptional(observersPath, source, fn!, member!)),
    ).toEqual([false, false, false])
    expect(
      leadingStatementsOf(observersPath, source, 'createDevelopmentCodeHostEventObserver', 2),
    ).toEqual(['const now = input.now', 'const activationRef = input.activationRef'])
    expect(
      leadingStatementsOf(observersPath, source, 'createDevelopmentApprovalEventObserver', 1),
    ).toEqual(['const now = input.now'])
  })

  test('负对照：回落、控制流、多建一次、换了字段、可选的时钟与多余的 import 都会被认出', () => {
    const probe = join(SRC, `${INT}/composition/probe.ts`)
    const source = [
      `import { randomUUID } from 'node:crypto'`,
      `import { readFileSync } from 'node:fs'`,
      `import { createDevelopmentCodeHostEventObserver as other } from '../application/developmentEventObservers'`,
      `export function createDevelopmentCodeHostEventObserver(input: { readonly now?: () => number }) { const now = input.now ?? Date.now }`,
      `export function withoutClock(input: { readonly binding: string }) { if (input.binding) throw new Error('x') }`,
      `export function choose(flag: boolean) { return flag ? 1 : 2 }`,
      `createDevelopmentApprovalEventObserver({ gateway: input.gateway, now: Date.now })`,
      `createDevelopmentApprovalEventObserver({ now: Date.now, gateway: input.gateway })`,
      `createDevelopmentEmployeeEventObserver({ codeHost, approval, extra: 1 })`,
    ].join('\n')
    expect(importsOf(probe, source)).toEqual([
      'node:crypto: randomUUID',
      'node:fs: readFileSync',
      `${OBSERVERS}: other`,
    ])
    expect(controlFlow(probe, source)).toEqual([
      'QuestionQuestionToken',
      'IfStatement',
      'ThrowStatement',
      'ConditionalExpression',
    ])
    const file = parse(probe, source)
    expect(onlyCallShape(file, 'createDevelopmentApprovalEventObserver')).toEqual(['<2 calls>'])
    expect(onlyCallShape(file, 'createDevelopmentEmployeeEventObserver')).toEqual([
      'codeHost',
      'approval',
      'extra: 1',
    ])
    expect(literalShape(file, undefined)).toEqual(['<not an object literal>'])
    expect(
      parameterMemberOptional(probe, source, 'createDevelopmentCodeHostEventObserver', 'now'),
    ).toBe(true)
    expect(parameterMemberOptional(probe, source, 'withoutClock', 'now')).toBeNull()
    expect(leadingStatementsOf(probe, source, 'createDevelopmentCodeHostEventObserver', 2)).toEqual(
      ['const now = input.now ?? Date.now'],
    )
    expect(memberCount(probe, source, 'Date', 'now')).toBe(3)
  })
})

describe('RFC-500 ③ 没有文件从旧位置取迁走的名字', () => {
  test(
    '全部生产文件、用例（语料下限 2,500）与 e2e',
    () => {
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(E2E_FILES.length).toBeGreaterThan(0)
      expect(
        [...PRODUCTION, ...TEST_FILES, ...E2E_FILES]
          .filter((path) => mentionsOldLocation(text(path)))
          .flatMap((path) => takenFromOldLocation(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都会被认出，装配函数与新位置不算', () => {
    const file = join(SRC, `${INT}/composition/probe.ts`)
    const source = [
      `import { buildDevelopmentCodeHostFacts, ${ASSEMBLY} } from './digitalEmployeeEventObserver'`,
      `import type { composeDevelopmentCodeHostEventObserver } from '@/${ASSEMBLY_FILE}'`,
      `import observer from '../composition/digitalEmployeeEventObserver'`,
      `import './digitalEmployeeEventObserver'`,
      `export { composeDevelopmentApprovalEventObserver } from '@/${ASSEMBLY_FILE}'`,
      `export * from './digitalEmployeeEventObserver'`,
      `import * as old from '@/${ASSEMBLY_FILE}'`,
      `const advance = old.advanceDevelopmentCodeHostObserverCursor`,
      `const kept = old.${ASSEMBLY}`,
      `const facts: old.DevelopmentCodeHostFact | undefined = undefined`,
      `const { createDevelopmentApprovalEventObserver } = await import('./digitalEmployeeEventObserver')`,
      `import { buildDevelopmentCodeHostFacts as moved } from '@/${OBSERVERS}'`,
      `const later = await import('@/${OBSERVERS}')`,
    ].join('\n')
    const label = corpusPath(file)
    expect(takenFromOldLocation(file, source)).toEqual(
      [
        'buildDevelopmentCodeHostFacts',
        'composeDevelopmentCodeHostEventObserver',
        'default',
        '<side effect>',
        'composeDevelopmentApprovalEventObserver',
        '*',
        'advanceDevelopmentCodeHostObserverCursor',
        'DevelopmentCodeHostFact',
        'createDevelopmentApprovalEventObserver',
        'import()',
      ].map((what) => `${label} -> ${ASSEMBLY_FILE}: ${what}`),
    )
  })
})

describe('RFC-500 ④ 新文件的依赖面是闭集、不用进程全局', () => {
  const observersPath = sourceOf(OBSERVERS)

  test('只取 shared、zod、@/util/hash、development-automation 的 public/types 与同目录的 mrFacts / mrEnsure', () => {
    expect(purityFindings(observersPath, text(observersPath), SURFACE)).toEqual([])
  })

  test('负对照：越界 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${INT}/application/probe.ts`)
    const source = [
      `import { canonicalJson } from '@agent-workflow/shared'`,
      `import { z } from 'zod'`,
      `import { sha256Hex } from '@/util/hash'`,
      `import { decodeDevelopmentApprovalSubject } from '@/modules/development-automation/public/types'`,
      `import { collectMergeRequestFacts } from './mrFacts'`,
      `import type { MrEnsureConnectionDeps } from './mrEnsure'`,
      `import { randomUUID } from 'node:crypto'`,
      `import { createCodeHostAdapter } from '../infrastructure/codeHostAdapter'`,
      `import { composeDevelopmentEmployeeEventObserver } from '../composition/digitalEmployeeEventObserver'`,
      `import { matchRepoProvider } from '../domain/repositoryProviderMatch'`,
      `import type { DevelopmentDeliveryPort } from '@/modules/development-automation/application/ports/developmentDelivery'`,
      `export async function run() { await import('node:path'); const at = Date.now(); process.exit(at); await fetch('x'); Math.random(); crypto.getRandomValues(new Uint8Array(1)) }`,
      `const at = new Date(0).toISOString()`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE)).toEqual([
      'import node:crypto',
      'randomUUID',
      'import ../infrastructure/codeHostAdapter',
      'import ../composition/digitalEmployeeEventObserver',
      'import ../domain/repositoryProviderMatch',
      'import @/modules/development-automation/application/ports/developmentDelivery',
      'import() node:path',
      'Date.now',
      'process.exit',
      'fetch',
      'Math.random',
      'crypto.getRandomValues',
    ])
  })
})
