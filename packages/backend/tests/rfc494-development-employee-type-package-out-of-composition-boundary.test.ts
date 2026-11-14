// RFC-494 — 开发自动化的员工类型包合同与编解码迁出 composition（RFC-294 S10 第一步）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里 18 个名字在全部生产文件里只在 development-automation 新的 application 文件声明：`application/employeeTypePackage.ts`
//    （15 个）、`application/digitalEmployeeToolContractRegistrationsV2.ts`（2 个）、`application/legacyDevelopmentProgramUpgrade.ts`
//    （1 个）；早已存在的同名项逐个钉住。
// ② `composition/employeeTypePackage.ts` 交出的恰好是登记对象与给 bootstrap 的三个转出，不声明清单里的名字；迁走的两个文件不存在。
// ③ 全部生产文件、用例与 e2e 都不从旧位置取清单里的名字：import / export-from / type-only / 动态 import 的解构都认，带负对照；登记对象
//    照常可取，只有 bootstrap 的装配根经 composition 取那三个转出。
// ④ 三个新文件的依赖面是闭集：zod、shared、`@/util/gitRef`、其他模块 public 的精确入口与本模块的 domain / application；不取
//    infrastructure、composition、IO 包与进程全局，没有 async 与 await（带负对照）。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）、全部用例（语料下限 2,500）与仓库根的 e2e，先按名字或路径文本筛、再逐个解析
// AST；② ④ 读 composition 的登记文件与三个新文件。
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
const OLD_COMPOSITION = `${DA}/composition/employeeTypePackage`
const DELETED = [
  `${DA}/composition/digitalEmployeeToolContractsV2`,
  `${DA}/composition/legacyDevelopmentProgramUpgrade`,
]
const MOVED: Readonly<Record<string, readonly string[]>> = {
  [`${DA}/application/employeeTypePackage`]: [
    'developmentExecutionContractRegistrations',
    'developmentImplicitAgentContractDeclarations',
    'mergeRequestLifecycleDescriptor',
    'issueHandlingContextSchema',
    'mergeRequestContextSchema',
    'changeCandidateContextSchema',
    'pipelineContextSchema',
    'problemSetContextSchema',
    'reviewResolutionContextSchema',
    'approvalContextSchema',
    'developmentEmployeeRuntimeCodec',
    'mergeRequestLifecycleRuntimeCodec',
    'runtimePackage',
    'WorkContract',
    'ToolImplementation',
  ],
  [`${DA}/application/digitalEmployeeToolContractRegistrationsV2`]: [
    'developmentWorkContractsV2',
    'developmentExecutionContractRegistrationsV2',
  ],
  [`${DA}/application/legacyDevelopmentProgramUpgrade`]: ['upgradeLegacyDevelopmentProgram'],
}
const NEW_FILES = Object.keys(MOVED)
const MOVED_NAMES = new Set(Object.values(MOVED).flat())
/** Bootstrap enters the module through its composition: the three values it wires stay offered there. */
const BOOTSTRAP_ENTRY = new Set([
  'developmentEmployeeRuntimeCodec',
  'developmentExecutionContractRegistrations',
  'developmentImplicitAgentContractDeclarations',
])
const REGISTRATION = 'developmentEmployeeTypePackage'
/** Unrelated declarations that share a moved name, pinned one by one (all predate RFC-494). */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  mergeRequestContextSchema: [`${DA}/composition/digitalEmployeeWorkspace`],
  WorkContract: ['modules/digital-employee/domain/model'],
  ToolImplementation: ['modules/digital-employee/domain/model'],
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

/**
 * `file -> old location: name` for every moved name taken from an old location (import, `export … from`, type-only, and
 * the destructured names of a dynamic `import()`); specifiers resolve from the file. Bootstrap may take the three
 * bootstrap-entry names from the composition file.
 */
function takenFromOldLocations(file: string, source: string): string[] {
  const out: string[] = []
  const bootstrap = slash(file).includes('/packages/backend/src/bootstrap/')
  const target = (specifier: string) => {
    const rel = resolveSpecifier(file, specifier)
    return rel !== null && (rel === OLD_COMPOSITION || DELETED.includes(rel)) ? rel : null
  }
  const flagged = (old: string, name: string) =>
    DELETED.includes(old)
      ? true
      : MOVED_NAMES.has(name) && !(bootstrap && BOOTSTRAP_ENTRY.has(name))
  const label = slash(relative(REPO, file))
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const old = target(node.moduleSpecifier.text)
      if (old !== null) {
        const elements = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings !== undefined &&
            ts.isNamedImports(node.importClause.namedBindings)
            ? node.importClause.namedBindings.elements
            : []
          : node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
            : []
        for (const element of elements) {
          const name = (element.propertyName ?? element.name).text
          if (flagged(old, name)) out.push(`${label} -> ${old}: ${name}`)
        }
      }
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
        const old = target(call.arguments[0].text)
        if (old !== null)
          for (const element of node.name.elements) {
            const name = (element.propertyName ?? element.name).getText()
            if (flagged(old, name)) out.push(`${label} -> ${old}: ${name}`)
          }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return out
}
const mentionsOldLocation = (source: string) =>
  /employeeTypePackage|digitalEmployeeToolContractsV2|legacyDevelopmentProgramUpgrade/.test(source)

/** The closed dependency surface of the new files (design §3 ④). */
function allowedDependency(file: string, specifier: string): boolean {
  if (specifier === 'zod' || specifier === '@/util/gitRef') return true
  if (specifier === '@agent-workflow/shared' || specifier.startsWith('@agent-workflow/shared/'))
    return true
  if (
    /^@\/modules\/(?!development-automation\/)[^/]+\/public\/(?:commands|queries|participants|events|types|operations)$/.test(
      specifier,
    )
  )
    return true
  const rel = resolveSpecifier(file, specifier)
  return rel !== null && /^modules\/development-automation\/(?:domain|application)\//.test(rel)
}

/** Imports outside the closed surface, `async` / `await`, and `process` / `Bun` globals, read from the syntax tree. */
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
    if (ts.isAwaitExpression(node)) findings.push('await')
    if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    )
      findings.push('async')
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['process', 'Bun'].includes(node.expression.text)
    )
      findings.push(`${node.expression.text}.${node.name.text}`)
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return findings
}

describe('RFC-494 ① 清单里的名字只在新的 application 文件声明', () => {
  test(
    '全部生产文件里每个名字只在表里的新文件声明（语料下限 3,000）',
    () => {
      expect(PRODUCTION.length).toBeGreaterThanOrEqual(3000)
      for (const [file, names] of Object.entries(MOVED))
        for (const name of names) {
          const declaring = PRODUCTION.filter(
            (path) =>
              new RegExp(`\\b${name}\\b`).test(text(path)) &&
              declaredNames(path, text(path)).includes(name),
          )
            .map(srcPath)
            .sort()
          expect([name, declaring]).toEqual([name, [file, ...(HOMONYMS[name] ?? [])].sort()])
        }
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-494 ② composition 只留登记对象与给 bootstrap 的转出', () => {
  test('composition/employeeTypePackage.ts 交出的恰好是登记对象与三个转出，不声明清单里的名字', () => {
    const path = join(SRC, `${OLD_COMPOSITION}.ts`)
    expect(offeredNames(path, text(path)).sort()).toEqual([REGISTRATION, ...BOOTSTRAP_ENTRY].sort())
    expect(declaredNames(path, text(path))).toEqual([REGISTRATION])
  })

  test('迁走的两个文件不存在', () => {
    for (const file of DELETED)
      expect([file, existsSync(join(SRC, `${file}.ts`))]).toEqual([file, false])
  })
})

describe('RFC-494 ③ 没有文件从旧位置取它们', () => {
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

  test('负对照：import、type-only、re-export 与动态 import 的解构都会被认出，登记对象、新位置与 bootstrap 的转出不算', () => {
    const file = join(SRC, `${DA}/composition/probe.ts`)
    const source = [
      `import { developmentEmployeeTypePackage, developmentEmployeeRuntimeCodec } from './employeeTypePackage'`,
      `import type { WorkContract } from '@/${OLD_COMPOSITION}'`,
      `export { developmentWorkContractsV2 } from './digitalEmployeeToolContractsV2'`,
      `const { developmentExecutionContractRegistrationsV2 } = await import('./digitalEmployeeToolContractsV2')`,
      `import { upgradeLegacyDevelopmentProgram as up } from '@/${DA}/composition/legacyDevelopmentProgramUpgrade'`,
      `import { runtimePackage } from '@/${DA}/application/employeeTypePackage'`,
      `import { projectDevelopmentToolResultV2 } from '../application/digitalEmployeeToolContractProjectionV2'`,
    ].join('\n')
    const label = slash(relative(REPO, file))
    expect(takenFromOldLocations(file, source)).toEqual([
      `${label} -> ${OLD_COMPOSITION}: developmentEmployeeRuntimeCodec`,
      `${label} -> ${OLD_COMPOSITION}: WorkContract`,
      `${label} -> ${DELETED[0]}: developmentWorkContractsV2`,
      `${label} -> ${DELETED[0]}: developmentExecutionContractRegistrationsV2`,
      `${label} -> ${DELETED[1]}: upgradeLegacyDevelopmentProgram`,
    ])
    const bootstrapFile = join(SRC, 'bootstrap/daemonModules/probe.ts')
    expect(
      takenFromOldLocations(
        bootstrapFile,
        `import { developmentEmployeeRuntimeCodec, mergeRequestContextSchema } from '@/${OLD_COMPOSITION}'`,
      ),
    ).toEqual([
      `${slash(relative(REPO, bootstrapFile))} -> ${OLD_COMPOSITION}: mergeRequestContextSchema`,
    ])
  })
})

describe('RFC-494 ④ 新文件的依赖面是闭集、没有 effect', () => {
  test('三个新文件只取 zod、shared、@/util/gitRef、其他模块 public 精确入口与本模块 domain / application', () => {
    for (const file of NEW_FILES) {
      const path = join(SRC, `${file}.ts`)
      expect([file, purityFindings(path, text(path))]).toEqual([file, []])
    }
  })

  test('负对照：越界 import、async / await 与进程全局都会被认出，模板字符串里的 import 文本不算', () => {
    const file = join(SRC, `${DA}/application/probe.ts`)
    const source = [
      `import { z } from 'zod'`,
      `import { utf16MinLength } from '@agent-workflow/shared'`,
      `import type { ExecutionContractRegistration } from '@/modules/execution-contract/public/types'`,
      `import { isMergeRequestLifecycleWorkItem } from '../domain/mergeRequestLifecycle'`,
      `import { projectDevelopmentToolInputV2 } from './digitalEmployeeToolContractProjectionV2'`,
      `import { readFileSync } from 'node:fs'`,
      `import { model } from '@/modules/digital-employee/domain/model'`,
      `import { adapter } from '../infrastructure/automationWorkspaceEffects'`,
      `import { developmentEmployeeTypePackage } from '../composition/employeeTypePackage'`,
      `import { isLexicallyInsideForHost } from '@/util/platformExec'`,
      'const wrapper = `import { spawnSync } from "node:child_process"`',
      `export async function run() { await import('node:path'); process.exit(1) }`,
    ].join('\n')
    expect(purityFindings(file, source)).toEqual([
      'import node:fs',
      'import @/modules/digital-employee/domain/model',
      'import ../infrastructure/automationWorkspaceEffects',
      'import ../composition/employeeTypePackage',
      'import @/util/platformExec',
      'async',
      'await',
      'import() node:path',
      'process.exit',
    ])
  })
})
