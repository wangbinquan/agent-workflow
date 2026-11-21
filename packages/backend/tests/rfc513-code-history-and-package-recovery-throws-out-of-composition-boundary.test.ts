// RFC-513 — 代码能力与资源目录组合层余下的 throw 迁出 composition（RFC-294 S10 第二十步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的名字在全部生产文件、用例与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字。
// ② code-capability 组合层的每个文件没有控制流、不构造错误；resource-catalog 的 `resourcePackageMaintenance.ts` 同样；两个名字在生产代码里只被
//    各自的组合文件调用一次，实参钉住（带负对照）。
// ③ 新文件的依赖面是闭集（import 逐条钉住），不用进程全局；增名字的 application 文件不取 infrastructure 与 composition（带负对照）。
// ④ 行为：未绑定读取器的两个操作以原文错误拒绝；互斥核对在两项都给时抛原文错误，其余情形放行。
//
// RFC-523：代码历史的读取器改为必填参数，未绑定读取器只剩用例在用，移到 `tests/helpers/codeHistory.ts`；这里不再锁它的位置、调用与依赖，
// ④ 的行为照旧（经测试助手），清单与新文件少它一项。
//
// 覆盖范围（C12）：① 与 ② 的调用方读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字文本筛、再逐个
// 解析 AST；② ③ 另读两个模块的组合文件与新位置。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { createUnboundCodeHistoryReader } from './helpers/codeHistory'
import { CodeHistoryReadError } from '@/modules/code-capability/domain/codeHistoryPackage'
import { requireExclusiveRecoverySelection } from '@/modules/resource-catalog/application/resourcePackageMaintenance'

const BACKEND = resolve(import.meta.dir, '..')
const REPO = resolve(BACKEND, '..', '..')
const SRC = join(BACKEND, 'src')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const CC = 'modules/code-capability'
const RC = 'modules/resource-catalog'
const MAINTENANCE = `${RC}/application/resourcePackageMaintenance`
const HISTORY_ROOT = `${CC}/composition/historyQueries`
const MAINTENANCE_ROOT = `${RC}/composition/resourcePackageMaintenance`
/** design §3: every listed name with the one file that declares it. */
const LISTED: readonly (readonly [string, string])[] = [
  [MAINTENANCE, 'requireExclusiveRecoverySelection'],
]
/** design §4 ③: the exact imports of the new file and of the file that gained a name. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [MAINTENANCE]: [
    'import platform/contracts/atomicApply: AtomicApplyRecoveryScene',
    `import ${RC}/public/queries: ResourcePackageApplyActivityQuery`,
    `import ${RC}/application/package/recoveryContentEffects: ResourcePackageRecoveryEffectsFactory`,
  ],
}
/** Each new location takes only its own module's domain, ports and application types (and the platform contract). */
const SAME_MODULE = (file: string, specifier: string): boolean => {
  const resolved = resolveSpecifier(file, specifier) ?? specifier
  const own = srcPath(file).split('/').slice(0, 2).join('/')
  return (
    resolved === 'platform/contracts/atomicApply' ||
    (resolved.startsWith(`${own}/`) &&
      !/\/(infrastructure|composition)\//.test(`${resolved}/`) &&
      !resolved.endsWith('/composition'))
  )
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

/** Control-flow statements anywhere in the file and every `new …Error(…)` (design §4 ②). */
function checkShapes(path: string, source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    const kind = CONTROL_FLOW.get(node.kind)
    if (kind !== undefined) out.push(kind)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.endsWith('Error')
    )
      out.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return out
}

describe('RFC-513 ① 清单里的名字只在各自的位置声明', () => {
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
      expect(LISTED).toHaveLength(1)
      for (const [location, name] of LISTED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${location}.ts`]])
    },
    CORPUS_TIMEOUT,
  )

  test('维护文件交出互斥核对；两个组合文件不声明清单里的名字', () => {
    const maintenance = sourceOf(MAINTENANCE)
    expect(offeredNames(maintenance, text(maintenance))).toContain(
      'requireExclusiveRecoverySelection',
    )
    const listed = new Set(LISTED.map(([, name]) => name))
    for (const root of [HISTORY_ROOT, MAINTENANCE_ROOT]) {
      const path = sourceOf(root)
      expect(
        declaredNames(path, text(path)).filter((name) => listed.has(name)),
        root,
      ).toEqual([])
    }
  })
})

describe('RFC-513 ② composition 只装配', () => {
  test('code-capability 组合层的每个文件与 resourcePackageMaintenance.ts 都没有控制流、不构造错误', () => {
    const dir = join(SRC, CC, 'composition')
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(dir, name))
    expect(files.length).toBeGreaterThanOrEqual(7)
    const found = [...files, join(SRC, CC, 'composition.ts'), sourceOf(MAINTENANCE_ROOT)].flatMap(
      (path) => checkShapes(path, text(path)).map((shape) => `${srcPath(path)}: ${shape}`),
    )
    expect(found).toEqual([])
  })

  test(
    '互斥核对在生产代码里只被维护 worker 的选择处调用一次，实参钉住（RFC-525：组合层不再收第二个选项）',
    () => {
      const worker = 'bootstrap/maintenanceWorkerGraph'
      expect(productionCallers('requireExclusiveRecoverySelection')).toEqual([`${worker} x1`])
      const graph = sourceOf(worker)
      expect(callArguments(graph, text(graph), 'requireExclusiveRecoverySelection')).toEqual([
        [
          // RFC-528: the worker's one selection (`selectWorkerEffects`) makes the check where it chooses.
          '{artifacts:selected?.resourcePackageRecovery,recoveryEffectsFactory:selected?.resourcePackageRecoveryContent,}',
        ],
      ])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：内联的读取器与核对会被认出', () => {
    const probe = join(SRC, CC, 'composition', 'probe.ts')
    const source = [
      `export const history = {`,
      `  rows: async () => { throw new CodeHistoryReadError('code-history-reader-unbound', 'x') },`,
      `}`,
      `export function compose(input: { a?: object; b?: object }) {`,
      `  if (input.a !== undefined && input.b !== undefined) throw new Error('x')`,
      `}`,
    ].join('\n')
    expect(checkShapes(probe, source)).toEqual([
      'throw',
      'CodeHistoryReadError',
      'if',
      'throw',
      'Error',
    ])
  })
})

describe('RFC-513 ③ 新位置的依赖面是闭集、不用进程全局', () => {
  test('import 逐条钉住；只取本模块的 domain、端口与 application 类型；不用进程全局', () => {
    for (const [location, imports] of Object.entries(IMPORTS)) {
      const path = sourceOf(location)
      expect([location, moduleEdges(path, text(path))]).toEqual([location, [...imports]])
      expect(purityFindings(path, text(path), SAME_MODULE), location).toEqual([])
    }
  })

  test('负对照：别的模块、基础设施、组合层与进程全局都会被认出', () => {
    // RFC-523: an application path in code-capability (the reader that used to live here moved to tests/helpers).
    const file = sourceOf(`${CC}/application/probe`)
    const source = [
      `import type { CodeHistoryReader } from './ports/historyReader'`,
      `import { createCodeHistoryPackageReader } from '../infrastructure/history/packageReader'`,
      `import { composeCodeHistoryQueries } from '../composition/historyQueries'`,
      `import type { PersistenceDb } from '@/platform/persistence/persistenceDb'`,
      `export const at = () => [Date.now(), process.env]`,
    ].join('\n')
    expect(purityFindings(file, source, SAME_MODULE)).toEqual([
      'import ../infrastructure/history/packageReader',
      'import ../composition/historyQueries',
      'import @/platform/persistence/persistenceDb',
      'Date.now',
      'process.env',
    ])
  })
})

describe('RFC-513 ④ 行为', () => {
  test('未绑定读取器的两个操作以原文错误拒绝，每次调用都新建读取器', async () => {
    const reader = createUnboundCodeHistoryReader()
    expect(createUnboundCodeHistoryReader()).not.toBe(reader)
    for (const read of [() => reader.rows('x' as never), () => reader.find('x' as never, 'id')]) {
      const error = await read().then(
        () => null,
        (rejected: unknown) => rejected,
      )
      expect(error).toBeInstanceOf(CodeHistoryReadError)
      expect({
        code: (error as CodeHistoryReadError).code,
        message: (error as Error).message,
      }).toEqual({
        code: 'code-history-reader-unbound',
        message: 'code-history-reader-unbound: installation binding required',
      })
    }
  })

  test('互斥核对：两项都给时抛原文错误；产物端口为空、缺省或只给其一时放行', () => {
    const artifacts = { recover: async () => undefined } as never
    const recoveryEffectsFactory = { bind: () => undefined } as never
    expect(() => requireExclusiveRecoverySelection({ artifacts, recoveryEffectsFactory })).toThrow(
      new Error('resource-package-recovery-selections-conflict'),
    )
    for (const input of [
      { artifacts: null as never, recoveryEffectsFactory },
      { recoveryEffectsFactory },
      { artifacts },
      {},
    ])
      expect(() => requireExclusiveRecoverySelection(input)).not.toThrow()
  })
})
