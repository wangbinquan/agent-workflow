// RFC-493 — 纯逻辑归位：工作流静态校验与评审的锚点、决定策略迁出 infrastructure（RFC-294 S13）。
//
// 锁四件事（design §3 的清单即退出门）：
// ① 清单里 31 个名字在全部生产文件里只在新的 domain 文件声明（application 端口里早就有一个同名的不同类型
//    `WorkflowValidationCandidate`，逐个钉住）：resource-catalog `domain/workflowValidator.ts`（15 个）、
//    collaboration `domain/reviewCommentAnchor.ts`（7 个）、`domain/reviewDecisionPolicy.ts`（5 个）、`domain/reviewRounds.ts`（4 个）。
// ② 旧位置不声明、不转出它们：`infrastructure/legacy/workflow.validator.ts` 只交出三个读库的加载器入口；`infrastructure/review.ts`
//    也不再转出 shared 的 `findAllOccurrences`。
// ③ 全部生产文件与用例都不从旧位置取这些名字：import / export-from / type-only / 动态 import 的解构都认，带负对照（留在旧位置的
//    名字照常可取）。
// ④ 四个新文件是纯的：不取任何 infrastructure、IO 包与进程全局，没有 async 与 await。
//
// 覆盖范围（C12）：① ③ 读全部生产文件（语料下限 3,000）与全部用例（语料下限 2,500），先按名字或路径文本筛、再逐个解析 AST；② ④ 读
// 两个旧文件与四个新文件。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const SRC = join(BACKEND, 'src')
const TESTS = join(BACKEND, 'tests')
const slash = (path: string) => path.split('\\').join('/')
const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

const RC = 'modules/resource-catalog'
const CO = 'modules/collaboration'
const OLD_VALIDATOR = `${RC}/infrastructure/legacy/workflow.validator`
const OLD_REVIEW = `${CO}/infrastructure/review`
const MOVED: Readonly<Record<string, readonly string[]>> = {
  [`${RC}/domain/workflowValidator`]: [
    'ValidatorWorkflowRef',
    'WorkflowValidationCandidate',
    'ValidatorPluginResource',
    'ValidatorMcpResource',
    'ValidatorContext',
    'WorkflowValidationOverlayError',
    'withValidationOverlays',
    'WORKFLOW_VALIDATION_CONTEXT_DOMAIN_V1',
    'projectWorkflowValidationContext',
    'workflowValidationContextHashOf',
    'workflowDefinitionCandidateHashOf',
    'validateWorkflowDefinition',
    'validateWorkflowDef',
    'extractTemplateVars',
    'validateAgentClarifyMultiplicity',
  ],
  [`${CO}/domain/reviewCommentAnchor`]: [
    'OccurrenceRecomputeResult',
    'AnchorValidationError',
    'recomputeOccurrenceIndex',
    'canonicalizeAnchor',
    'anchorResolutionError',
    'assertResolvedAnchorConsistent',
    'resolveCommentAnchor',
  ],
  [`${CO}/domain/reviewDecisionPolicy`]: [
    'ReviewRerunPolicy',
    'ReviewDecisionPolicyBase',
    'ReviewDecisionPolicyOf',
    'ReviewDecisionPolicy',
    'REVIEW_DECISION_POLICY',
  ],
  [`${CO}/domain/reviewRounds`]: [
    'resolveReviewRoundMode',
    'RoundGroupRow',
    'DocVersionRound',
    'groupDocVersionRounds',
  ],
}
const NEW_FILES = Object.keys(MOVED)
/**
 * Unrelated declarations that share a moved name, pinned one by one: Resource Catalog's application port has its own
 * `WorkflowValidationCandidate` (the candidate the workflow operations hand in, with overlays) — a different type that
 * predates RFC-493.
 */
const HOMONYMS: Readonly<Record<string, readonly string[]>> = {
  WorkflowValidationCandidate: [`${RC}/application/workflows/ports`],
}
const VALIDATOR_NAMES = new Set(MOVED[`${RC}/domain/workflowValidator`])
const REVIEW_NAMES = new Set([
  ...NEW_FILES.filter((file) => file.startsWith(CO)).flatMap((file) => MOVED[file]!),
  'findAllOccurrences',
])
const LOADERS = [
  'buildWorkflowValidationContext',
  'loadWorkflowValidationContext',
  'validateWorkflowById',
]
/** The tests below read every production file and every test file; the first pays the cold read. */
const CORPUS_TIMEOUT = 30_000

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}
const PRODUCTION = walk(SRC)
const TEST_FILES = walk(TESTS)
const TEXTS = new Map<string, string>()
const text = (path: string) => {
  let content = TEXTS.get(path)
  if (content === undefined) TEXTS.set(path, (content = readFileSync(path, 'utf8')))
  return content
}
const srcPath = (abs: string) => slash(relative(SRC, abs)).replace(/\.tsx?$/, '')

/** Declared top-level names of a source text (function, class, interface, type alias, enum, const / let). */
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

/** Names a file offers: exported declarations plus `export { … }` / `export { … } from` clauses. */
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
 * `file -> old location: name` for every name taken from an old location (import, `export … from`, type-only, and the
 * destructured names of a dynamic `import()`), restricted to the moved names; specifiers resolve from the file.
 */
function takenFromOldLocations(file: string, source: string): string[] {
  const out: string[] = []
  const target = (specifier: string) => {
    const abs = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(file), specifier)
        : null
    if (abs === null) return null
    const rel = srcPath(abs)
    return rel === OLD_VALIDATOR || rel === OLD_REVIEW ? rel : null
  }
  const moved = (old: string, name: string) =>
    old === OLD_VALIDATOR ? VALIDATOR_NAMES.has(name) : REVIEW_NAMES.has(name)
  const label = slash(relative(BACKEND, file))
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
          if (moved(old, name)) out.push(`${label} -> ${old}: ${name}`)
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
            if (moved(old, name)) out.push(`${label} -> ${old}: ${name}`)
          }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(file, source))
  return out
}
const mentionsOldLocation = (source: string) =>
  source.includes('workflow.validator') ||
  /infrastructure\/review|['"]\.\.?\/review['"]/.test(source)

describe('RFC-493 ① 清单里的名字只在新的 domain 文件声明', () => {
  test(
    '全部生产文件里每个名字只声明一次，就在表里的新文件（语料下限 3,000）',
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

describe('RFC-493 ② 旧位置不声明、不转出', () => {
  const oldValidator = join(SRC, `${OLD_VALIDATOR}.ts`)
  const oldReview = join(SRC, `${OLD_REVIEW}.ts`)

  test('legacy/workflow.validator.ts 只交出三个加载器入口', () => {
    const source = text(oldValidator)
    expect(offeredNames(oldValidator, source).sort()).toEqual(LOADERS)
    for (const name of VALIDATOR_NAMES)
      expect([name, declaredNames(oldValidator, source).includes(name)]).toEqual([name, false])
  })

  test('review.ts 不声明、不转出清单里的名字与 findAllOccurrences', () => {
    const source = text(oldReview)
    const declared = new Set(declaredNames(oldReview, source))
    const offered = new Set(offeredNames(oldReview, source))
    for (const name of REVIEW_NAMES) {
      expect([name, declared.has(name)]).toEqual([name, false])
      expect([name, offered.has(name)]).toEqual([name, false])
    }
  })
})

describe('RFC-493 ③ 没有文件从旧位置取它们', () => {
  test(
    '全部生产文件与用例（语料下限 2,500）',
    () => {
      expect(TEST_FILES.length).toBeGreaterThanOrEqual(2500)
      expect(
        [...PRODUCTION, ...TEST_FILES]
          .filter((path) => mentionsOldLocation(text(path)))
          .flatMap((path) => takenFromOldLocations(path, text(path))),
      ).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('负对照：import、type-only、re-export 与动态 import 的解构都会被认出，留在旧位置的名字不算', () => {
    const file = join(SRC, `${RC}/infrastructure/probe.ts`)
    const source = [
      `import { validateWorkflowDef, loadWorkflowValidationContext } from '@/${OLD_VALIDATOR}'`,
      "import type { ValidatorContext } from './legacy/workflow.validator'",
      `export { REVIEW_DECISION_POLICY, dispatchReviewNode } from '@/${OLD_REVIEW}'`,
      `const { canonicalizeAnchor, getReviewDetail } = await import('../../collaboration/infrastructure/review')`,
      `import { findAllOccurrences } from '@/${OLD_REVIEW}'`,
      `import { validateWorkflowDef as ok } from '@/${RC}/domain/workflowValidator'`,
    ].join('\n')
    const label = slash(relative(BACKEND, file))
    expect(takenFromOldLocations(file, source)).toEqual([
      `${label} -> ${OLD_VALIDATOR}: validateWorkflowDef`,
      `${label} -> ${OLD_VALIDATOR}: ValidatorContext`,
      `${label} -> ${OLD_REVIEW}: REVIEW_DECISION_POLICY`,
      `${label} -> ${OLD_REVIEW}: canonicalizeAnchor`,
      `${label} -> ${OLD_REVIEW}: findAllOccurrences`,
    ])
    expect(mentionsOldLocation(source)).toBe(true)
  })
})

describe('RFC-493 ④ 新文件是纯的', () => {
  test('四个新文件不取 infrastructure、IO 包与进程全局，没有 async / await', () => {
    for (const file of NEW_FILES) {
      const path = join(SRC, `${file}.ts`)
      const source = parse(path, text(path))
      const findings: string[] = []
      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const specifier = node.moduleSpecifier.text
          if (
            /(?:^|\/)infrastructure(?:\/|$)|^(?:node:)?(?:fs|fs\/promises|child_process|path|process)$|^(?:drizzle-orm|hono|bun:sqlite)(?:\/|$)|^@\/(?:db|ws|routes|server|platform\/persistence)(?:\/|$)/.test(
              specifier,
            )
          )
            findings.push(`import ${specifier}`)
        }
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
      visit(source)
      expect([file, findings]).toEqual([file, []])
    }
  })
})
