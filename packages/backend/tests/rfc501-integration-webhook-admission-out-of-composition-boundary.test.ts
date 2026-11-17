// RFC-501 — 集成的 webhook 启动准入与触发器校验迁出 composition（RFC-294 S10 第八步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里的三个名字在全部生产文件、用例与 e2e 里只在 `application/webhookAdmission.ts` 声明；改名前的两个 `compose…` 工厂没有声明。
// ② `composition/webhookAdmission.ts` 不存在；`infrastructure/webhookDispatchRuntime.ts` 不再声明转手的 `createWebhookLaunchAdmission`、
//    不取任何 composition；`composition/webhookDispatch.ts` 从新文件取启动准入；integration `composition.ts` 从新文件转出校验器工厂，
//    bootstrap 只经它取、恰好调用一次（带负对照）。
// ③ 全部生产文件、用例与 e2e 不从旧位置取任何东西：命名 import、type-only、默认与副作用 import、re-export、命名空间成员与动态 import
//    都认，带负对照。
// ④ 新文件的依赖面是闭集：只取 shared、`@/util/errors`、`@/auth/actor`、resource-catalog 的 `public` 与本模块 domain / application；
//    不取 infrastructure、composition、IO 包，不用进程全局（带负对照）。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ④ 读 `webhookDispatchRuntime.ts`、`webhookDispatch.ts`、`composition.ts`、bootstrap 的 `daemonModules/integration.ts` 与新文件。
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
const OLD = `${INT}/composition/webhookAdmission`
const ADMISSION = `${INT}/application/webhookAdmission`
const RUNTIME = `${INT}/infrastructure/webhookDispatchRuntime`
const DISPATCH = `${INT}/composition/webhookDispatch`
const MODULE_COMPOSITION = `${INT}/composition`
const BOOTSTRAP = 'bootstrap/daemonModules/integration'

/** design §3: the new file declares and offers exactly these. */
const OFFERED = [
  'createWebhookLaunchAdmission',
  'assertWebhookTriggerSaveable',
  'createWebhookTriggerValidation',
]
const RETIRED = ['composeWebhookLaunchAdmission', 'composeWebhookTriggerValidation']
const BOOTSTRAP_ARGUMENTS = ['input.scheduledTaskRuntime.operations', 'input.configuration']
const mentionsOldLocation = (source: string) => /webhookAdmission/.test(source)
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
const takesComposition = (edge: string) =>
  /^(import|export) modules\/[^/:]+\/composition\b/.test(edge)

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

/**
 * `file -> old location: what` for everything a file still takes from the deleted file (design §4 ③): named import,
 * type-only, default and side-effect import, `export … from` and `export * from`, members of a namespace import (value
 * and type positions), and dynamic `import()` with its destructured names; specifiers resolve from the file.
 */
function takenFromOldLocation(file: string, source: string): string[] {
  const out: string[] = []
  const label = corpusPath(file)
  const fromOld = (specifier: string) => resolveSpecifier(file, specifier) === OLD
  const flag = (what: string) => out.push(`${label} -> ${OLD}: ${what}`)
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
  if (
    [
      '@/util/errors',
      '@/auth/actor',
      '@/modules/resource-catalog/public/types',
      '@/modules/resource-catalog/public/queries',
    ].includes(specifier)
  )
    return true
  if (isShared(specifier)) return true
  const rel = resolveSpecifier(file, specifier)
  return (
    rel !== null && ['domain', 'application'].some((layer) => rel.startsWith(`${INT}/${layer}/`))
  )
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

describe('RFC-501 ① 清单里的名字只在新文件声明', () => {
  test(
    '全部生产文件、用例与 e2e 里每个名字只在新文件声明，改名前的两个工厂没有声明（语料下限 3,000 / 2,500）',
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
      for (const name of OFFERED)
        expect([name, declaring(name)]).toEqual([name, [`packages/backend/src/${ADMISSION}.ts`]])
      for (const name of RETIRED) expect([name, declaring(name)]).toEqual([name, []])
    },
    CORPUS_TIMEOUT,
  )

  test('新文件只声明并交出清单的三个名字', () => {
    const path = sourceOf(ADMISSION)
    expect(declaredNames(path, text(path)).sort()).toEqual([...OFFERED].sort())
    expect(offeredNames(path, text(path)).sort()).toEqual([...OFFERED].sort())
  })
})

describe('RFC-501 ② composition 不再有这个文件，infrastructure 不再取 composition', () => {
  test('旧文件不存在；派发运行时不再转手启动准入、不取 composition；派发的装配直接从新文件取', () => {
    expect(existsSync(sourceOf(OLD))).toBe(false)
    expect(existsSync(join(SRC, `${OLD}.tsx`))).toBe(false)
    const runtime = sourceOf(RUNTIME)
    expect(declaredNames(runtime, text(runtime))).not.toContain('createWebhookLaunchAdmission')
    expect(moduleEdges(runtime, text(runtime)).filter(takesComposition)).toEqual([])
    const dispatch = sourceOf(DISPATCH)
    expect(
      moduleEdges(dispatch, text(dispatch)).filter((edge) =>
        edge.includes('createWebhookLaunchAdmission'),
      ),
    ).toEqual([`import ${ADMISSION}: createWebhookLaunchAdmission`])
  })

  test('integration 的 composition.ts 从新文件转出校验器工厂；bootstrap 只经它取、恰好调用一次', () => {
    const composition = sourceOf(MODULE_COMPOSITION)
    expect(
      moduleEdges(composition, text(composition)).filter((edge) =>
        edge.startsWith(`export ${ADMISSION}:`),
      ),
    ).toEqual([`export ${ADMISSION}: createWebhookTriggerValidation`])
    const bootstrap = sourceOf(BOOTSTRAP)
    const edges = moduleEdges(bootstrap, text(bootstrap)).filter((edge) =>
      edge.includes('createWebhookTriggerValidation'),
    )
    expect(edges).toHaveLength(1)
    expect(edges[0]!.startsWith(`import ${MODULE_COMPOSITION}: `)).toBe(true)
    expect(callArguments(bootstrap, text(bootstrap), 'createWebhookTriggerValidation')).toEqual([
      BOOTSTRAP_ARGUMENTS,
    ])
  })

  test('负对照：取 composition 的边、留在 infrastructure 的转手、别处的转出与多余的调用都会被认出', () => {
    const probe = join(SRC, `${INT}/infrastructure/probe.ts`)
    const source = [
      `import { createWebhookLaunchAdmission as moved } from '../application/webhookAdmission'`,
      `import { composeWebhookDispatchCore } from '../composition/webhookDispatch'`,
      `import { createEventCenter } from '@/modules/event-center/composition'`,
      `export { createWebhookTriggerValidation } from '../composition'`,
      `export function createWebhookLaunchAdmission() { return moved }`,
      `createWebhookTriggerValidation(input.scheduledTaskRuntime.operations, input.configuration)`,
      `createWebhookTriggerValidation(other)`,
    ].join('\n')
    expect(moduleEdges(probe, source)).toEqual([
      `import ${ADMISSION}: createWebhookLaunchAdmission`,
      `import ${DISPATCH}: composeWebhookDispatchCore`,
      'import modules/event-center/composition: createEventCenter',
      `export ${MODULE_COMPOSITION}: createWebhookTriggerValidation`,
    ])
    expect(moduleEdges(probe, source).filter(takesComposition)).toEqual([
      `import ${DISPATCH}: composeWebhookDispatchCore`,
      'import modules/event-center/composition: createEventCenter',
      `export ${MODULE_COMPOSITION}: createWebhookTriggerValidation`,
    ])
    expect(declaredNames(probe, source)).toContain('createWebhookLaunchAdmission')
    expect(callArguments(probe, source, 'createWebhookTriggerValidation')).toEqual([
      BOOTSTRAP_ARGUMENTS,
      ['other'],
    ])
  })
})

describe('RFC-501 ③ 没有文件从旧位置取任何东西', () => {
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

  test('负对照：命名、type-only、默认与副作用 import、re-export、命名空间成员与动态 import 都会被认出，新位置不算', () => {
    const file = join(SRC, `${INT}/composition/probe.ts`)
    const source = [
      `import { assertWebhookTriggerSaveable } from './webhookAdmission'`,
      `import type { composeWebhookTriggerValidation } from '@/${OLD}'`,
      `import admission from '../composition/webhookAdmission'`,
      `import './webhookAdmission'`,
      `export { composeWebhookLaunchAdmission } from '@/${OLD}'`,
      `export * from './webhookAdmission'`,
      `import * as old from '@/${OLD}'`,
      `const launch = old.composeWebhookLaunchAdmission`,
      `const saveable: typeof old.assertWebhookTriggerSaveable | undefined = undefined`,
      `const { composeWebhookTriggerValidation: validation } = await import('./webhookAdmission')`,
      `import { createWebhookTriggerValidation } from '@/${ADMISSION}'`,
      `const later = await import('@/${ADMISSION}')`,
    ].join('\n')
    const label = corpusPath(file)
    expect(takenFromOldLocation(file, source)).toEqual(
      [
        'assertWebhookTriggerSaveable',
        'composeWebhookTriggerValidation',
        'default',
        '<side effect>',
        'composeWebhookLaunchAdmission',
        '*',
        'composeWebhookLaunchAdmission',
        'assertWebhookTriggerSaveable',
        'composeWebhookTriggerValidation',
        'import()',
      ].map((what) => `${label} -> ${OLD}: ${what}`),
    )
  })
})

describe('RFC-501 ④ 新文件的依赖面是闭集、不用进程全局', () => {
  const admissionPath = sourceOf(ADMISSION)

  test('只取 shared、@/util/errors、@/auth/actor、resource-catalog 的 public 与本模块 domain / application', () => {
    expect(purityFindings(admissionPath, text(admissionPath), SURFACE)).toEqual([])
  })

  test('负对照：越界 import 与进程全局都会被认出', () => {
    const file = join(SRC, `${INT}/application/probe.ts`)
    const source = [
      `import { webhookPayloadTemplateSchemaFor } from '@agent-workflow/shared'`,
      `import { ValidationError } from '@/util/errors'`,
      `import type { Actor } from '@/auth/actor'`,
      `import { assertTriggerPreflight } from '@/modules/resource-catalog/public/queries'`,
      `import { renderWebhookLaunch } from './webhookDispatch'`,
      `import { staticTriggerIssues } from '../domain/webhookTriggerValidation'`,
      `import { createWebhookDispatchPersistence } from '../infrastructure/webhookDispatchPersistence'`,
      `import { composeWebhookDispatchCore } from '../composition/webhookDispatch'`,
      `import { createResourceCatalog } from '@/modules/resource-catalog/composition'`,
      `import { readFileSync } from 'node:fs'`,
      `export async function run() { await import('node:path'); const at = Date.now(); process.exit(at); await fetch('x'); Math.random() }`,
    ].join('\n')
    expect(purityFindings(file, source, SURFACE)).toEqual([
      'import ../infrastructure/webhookDispatchPersistence',
      'import ../composition/webhookDispatch',
      'import @/modules/resource-catalog/composition',
      'import node:fs',
      'import() node:path',
      'Date.now',
      'process.exit',
      'fetch',
      'Math.random',
    ])
  })
})
