// RFC-629: AST-backed invariants locking the frontend cross-package contract test list,
// E2E isolation from backend `*.test.ts`/`*.spec.ts` files, and OS-core E2E spec integrity.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'
import { OS_CORE_E2E_SPECS } from '../../../../scripts/ci/e2e-shards'
import { FRONTEND_CROSS_PACKAGE_TESTS } from '../../../../scripts/ci/run-frontend-contract-tests'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

function walkFiles(
  dir: string,
  predicate: (name: string) => boolean,
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue
      }
      walkFiles(full, predicate, out)
    } else if (entry.isFile() && predicate(entry.name)) {
      out.push(relative(REPO_ROOT, full).replaceAll('\\', '/'))
    }
  }
  return out
}

const FRONTEND_TEST_FILES = walkFiles(resolve(REPO_ROOT, 'packages/frontend'), (name) =>
  /\.test\.tsx?$/.test(name),
).sort((a, b) => a.localeCompare(b))

const E2E_SOURCE_FILES = walkFiles(resolve(REPO_ROOT, 'e2e'), (name) =>
  /\.[cm]?tsx?$/.test(name),
).sort((a, b) => a.localeCompare(b))

function isOutsideFrontendAndShared(repoRelPath: string): boolean {
  const normalized = posix.normalize(repoRelPath).replace(/^\/+/, '')
  if (!normalized || normalized === '.' || normalized.startsWith('..')) return true
  if (normalized === 'packages/frontend' || normalized.startsWith('packages/frontend/'))
    return false
  if (normalized === 'packages/shared' || normalized.startsWith('packages/shared/')) return false
  return true
}

function isFrontendLocalRepoPath(repoRelPath: string): boolean {
  const normalized = posix.normalize(repoRelPath)
  return normalized.startsWith('packages/frontend/')
}

interface PathHelperWrapper {
  readonly paramName: string
  readonly base: string
}

/**
 * Pure AST analyzer for one frontend test or local helper file.
 * Resolves static/dynamic imports, `new URL(..., import.meta.url)`, `const` path bindings
 * derived from `import.meta.dirname`/`import.meta.url`/`__dirname`/`process.cwd()`, simple
 * single-arg path wrapper helpers, and `path.resolve`/`path.join`/`fs.*` calls.
 */
export function analyzeFrontendSource(
  relPath: string,
  sourceText: string,
): { crossPackage: string[]; localImports: string[] } {
  const source = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const fileDir = posix.dirname(relPath)
  const crossPackage = new Set<string>()
  const localImports = new Set<string>()
  const pathBindings = new Map<string, string>()
  const stringBindings = new Map<string, string>()
  const pathHelpers = new Map<string, PathHelperWrapper>()

  const unwrap = (node: ts.Expression): ts.Expression => {
    while (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      node = node.expression
    }
    return node
  }

  const evalString = (expr: ts.Expression): string | null => {
    const node = unwrap(expr)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isIdentifier(node)) return stringBindings.get(node.text) ?? null
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text
      for (const span of node.templateSpans) {
        const part = evalString(span.expression)
        if (part === null) return null
        out += part + span.literal.text
      }
      return out
    }
    return null
  }

  const isImportMetaProp = (expr: ts.Expression, prop: string): boolean => {
    const node = unwrap(expr)
    return (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.name.text === prop
    )
  }

  const isCallOfName = (call: ts.CallExpression, names: ReadonlySet<string>): boolean => {
    if (ts.isIdentifier(call.expression)) return names.has(call.expression.text)
    if (ts.isPropertyAccessExpression(call.expression)) return names.has(call.expression.name.text)
    return false
  }

  const evalPath = (expr: ts.Expression): string | null => {
    const node = unwrap(expr)
    if (ts.isIdentifier(node)) {
      if (node.text === '__dirname') return fileDir
      if (node.text === '__filename') return relPath
      return pathBindings.get(node.text) ?? null
    }
    if (isImportMetaProp(node, 'dirname') || isImportMetaProp(node, 'dir')) return fileDir
    if (isImportMetaProp(node, 'filename')) return relPath
    if (ts.isCallExpression(node)) {
      // process.cwd() in vitest runs from packages/frontend
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'process' &&
        node.expression.name.text === 'cwd'
      ) {
        return 'packages/frontend'
      }
      if (isCallOfName(node, new Set(['fileURLToPath'])) && node.arguments.length === 1) {
        const arg = unwrap(node.arguments[0]!)
        if (isImportMetaProp(arg, 'url')) return relPath
        if (
          ts.isNewExpression(arg) &&
          ts.isIdentifier(arg.expression) &&
          arg.expression.text === 'URL' &&
          arg.arguments &&
          arg.arguments.length === 2 &&
          isImportMetaProp(arg.arguments[1]!, 'url')
        ) {
          const target = evalString(arg.arguments[0]!)
          return target === null ? null : posix.normalize(posix.join(fileDir, target))
        }
      }
      if (isCallOfName(node, new Set(['dirname'])) && node.arguments.length === 1) {
        const inner = evalPath(node.arguments[0]!)
        return inner === null ? null : posix.dirname(inner)
      }
      if (isCallOfName(node, new Set(['resolve', 'join'])) && node.arguments.length >= 1) {
        const firstPath = evalPath(node.arguments[0]!)
        if (firstPath !== null) {
          const rest: string[] = []
          for (const arg of node.arguments.slice(1)) {
            const segment = evalString(arg)
            if (segment === null) return null
            rest.push(segment)
          }
          return posix.normalize(posix.join(firstPath, ...rest))
        }
      }
      if (ts.isIdentifier(node.expression)) {
        const helper = pathHelpers.get(node.expression.text)
        if (helper && node.arguments.length === 1) {
          const arg = evalString(node.arguments[0]!)
          if (arg !== null) return posix.normalize(posix.join(helper.base, arg))
        }
      }
    }
    return null
  }

  const recordSpecifier = (specifier: string) => {
    if (specifier === '@/util/hash') {
      crossPackage.add(`import:${specifier}`)
      return
    }
    if (specifier.startsWith('@/')) {
      localImports.add(`packages/frontend/src/${specifier.slice(2)}`)
      return
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = posix.normalize(posix.join(fileDir, specifier))
      if (isFrontendLocalRepoPath(target)) {
        localImports.add(target)
      } else if (isOutsideFrontendAndShared(target)) {
        crossPackage.add(`import:${target}`)
      }
    }
  }

  const FS_CALLEES = new Set([
    'readFileSync',
    'readFile',
    'readdirSync',
    'readdir',
    'existsSync',
    'statSync',
    'lstatSync',
  ])

  const recordPathHelper = (
    name: string,
    params: readonly ts.ParameterDeclaration[],
    bodyExpr: ts.Expression | undefined,
  ) => {
    if (!bodyExpr || params.length !== 1 || !ts.isIdentifier(params[0]!.name)) return
    const paramName = params[0]!.name.text
    let call = unwrap(bodyExpr)
    // Unwrap `readFileSync(resolve(repoRoot, p), 'utf8')` style helper wrappers as well.
    if (ts.isCallExpression(call) && isCallOfName(call, FS_CALLEES) && call.arguments.length >= 1) {
      call = unwrap(call.arguments[0]!)
    }
    if (
      ts.isCallExpression(call) &&
      isCallOfName(call, new Set(['resolve', 'join'])) &&
      call.arguments.length >= 2
    ) {
      const lastArg = unwrap(call.arguments[call.arguments.length - 1]!)
      if (!ts.isIdentifier(lastArg) || lastArg.text !== paramName) return
      const base = evalPath(call.arguments[0]!)
      if (base === null) return
      const middle: string[] = []
      for (const arg of call.arguments.slice(1, -1)) {
        const seg = evalString(arg)
        if (seg === null) return
        middle.push(seg)
      }
      pathHelpers.set(name, { paramName, base: posix.normalize(posix.join(base, ...middle)) })
    }
  }

  // Pass 1: collect top-level & local const path/string bindings and simple path wrapper helpers.
  const collectBindings = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer)
      const str = evalString(init)
      if (str !== null) stringBindings.set(node.name.text, str)
      const resolved = evalPath(init)
      if (resolved !== null) pathBindings.set(node.name.text, resolved)
      if (ts.isArrowFunction(init)) {
        const bodyExpr = ts.isBlock(init.body)
          ? init.body.statements.find(ts.isReturnStatement)?.expression
          : init.body
        recordPathHelper(node.name.text, init.parameters, bodyExpr)
      }
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const ret = node.body.statements.find(ts.isReturnStatement)?.expression
      recordPathHelper(node.name.text, node.parameters, ret)
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(source)

  // Pass 2: inspect imports, `new URL(..., import.meta.url)`, and path/fs calls.
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      recordSpecifier(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      recordSpecifier(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
        const spec = evalString(node.arguments[0]!)
        if (spec !== null) recordSpecifier(spec)
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length >= 1
      ) {
        const spec = evalString(node.arguments[0]!)
        if (spec !== null) recordSpecifier(spec)
      } else if (isCallOfName(node, new Set(['resolve', 'join'])) && node.arguments.length >= 2) {
        const resolved = evalPath(node)
        if (resolved !== null && isOutsideFrontendAndShared(resolved)) {
          // Ignore bare repository root references (`resolve(import.meta.dirname, '../../..')` = '.')
          // that only define a base constant without referencing a file/dir outside frontend+shared.
          if (resolved !== '.' && resolved !== 'packages') {
            crossPackage.add(`path:${resolved}`)
          }
        }
      } else if (isCallOfName(node, FS_CALLEES) && node.arguments.length >= 1) {
        const target = evalPath(node.arguments[0]!)
        if (target !== null && isOutsideFrontendAndShared(target)) {
          crossPackage.add(`fs:${target}`)
        }
      } else if (ts.isIdentifier(node.expression) && pathHelpers.has(node.expression.text)) {
        const resolved = evalPath(node)
        if (resolved !== null && isOutsideFrontendAndShared(resolved)) {
          crossPackage.add(`helper:${resolved}`)
        }
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments &&
      node.arguments.length === 2 &&
      isImportMetaProp(node.arguments[1]!, 'url')
    ) {
      const spec = evalString(node.arguments[0]!)
      if (spec !== null) {
        const resolved = posix.normalize(posix.join(fileDir, spec))
        if (isOutsideFrontendAndShared(resolved)) {
          crossPackage.add(`url:${resolved}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  return {
    crossPackage: [...crossPackage].sort((a, b) => a.localeCompare(b)),
    localImports: [...localImports].sort((a, b) => a.localeCompare(b)),
  }
}

export function collectTransitiveCrossPackageRefs(
  entryRelPath: string,
  readSource: (repoRelPath: string) => { resolvedPath: string; text: string } | null,
  analysisCache?: Map<string, { crossPackage: string[]; localImports: string[] }>,
): string[] {
  const visited = new Set<string>()
  const findings = new Set<string>()
  const queue = [entryRelPath]
  while (queue.length > 0) {
    const current = queue.pop()!
    const loaded = readSource(current)
    if (!loaded || visited.has(loaded.resolvedPath)) continue
    visited.add(loaded.resolvedPath)
    let result = analysisCache?.get(loaded.resolvedPath)
    if (!result) {
      result = analyzeFrontendSource(loaded.resolvedPath, loaded.text)
      analysisCache?.set(loaded.resolvedPath, result)
    }
    for (const ref of result.crossPackage) findings.add(`${loaded.resolvedPath} -> ${ref}`)
    for (const next of result.localImports) {
      if (!visited.has(next)) queue.push(next)
    }
  }
  return [...findings].sort((a, b) => a.localeCompare(b))
}

const BACKEND_TEST_FILE_REF = /(?:^|\/)packages\/backend\/tests\/.*\.(?:test|spec)(?:\.[cm]?tsx?)?$/

/**
 * Pure AST analyzer ensuring no `e2e/` file imports or reads a backend `*.test.*` or `*.spec.*`
 * file, keeping `isBackendTestOnlyPath()` (`run_e2e=false`) airtight.
 */
export function findE2eBackendTestReferences(relPath: string, sourceText: string): string[] {
  const source = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const fileDir = posix.dirname(relPath)
  const hits = new Set<string>()

  const checkLiteral = (raw: string) => {
    const normalized = raw.startsWith('.')
      ? posix.normalize(posix.join(fileDir, raw))
      : raw.replaceAll('\\', '/')
    if (BACKEND_TEST_FILE_REF.test(normalized)) {
      hits.add(`${relPath}: ${normalized}`)
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      checkLiteral(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkLiteral(node.moduleSpecifier.text)
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkLiteral(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...hits].sort((a, b) => a.localeCompare(b))
}

function resolveFrontendLocalFile(
  repoRelPath: string,
): { resolvedPath: string; text: string } | null {
  const candidates = [
    repoRelPath,
    `${repoRelPath}.ts`,
    `${repoRelPath}.tsx`,
    `${repoRelPath}.js`,
    `${repoRelPath}/index.ts`,
    `${repoRelPath}/index.tsx`,
  ]
  for (const candidate of candidates) {
    if (!isFrontendLocalRepoPath(candidate)) continue
    const abs = resolve(REPO_ROOT, candidate)
    if (existsSync(abs) && statSync(abs).isFile()) {
      return { resolvedPath: candidate, text: readFileSync(abs, 'utf8') }
    }
  }
  return null
}

describe('RFC-629 CI optimization structural invariants', () => {
  test('corpus floors remain non-empty across frontend tests and e2e sources', () => {
    expect(FRONTEND_TEST_FILES.length).toBeGreaterThanOrEqual(500)
    expect(E2E_SOURCE_FILES.length).toBeGreaterThanOrEqual(100)
  })

  test('FRONTEND_CROSS_PACKAGE_TESTS matches the exact AST-detected set across packages/frontend/{tests,src} and local helpers', () => {
    const analysisCache = new Map<string, { crossPackage: string[]; localImports: string[] }>()
    const resolvedCache = new Map<string, { resolvedPath: string; text: string } | null>()
    const cachedResolve = (p: string) => {
      if (resolvedCache.has(p)) return resolvedCache.get(p)!
      const loaded = resolveFrontendLocalFile(p)
      resolvedCache.set(p, loaded)
      return loaded
    }
    const detected: string[] = []
    for (const relPath of FRONTEND_TEST_FILES) {
      const refs = collectTransitiveCrossPackageRefs(relPath, cachedResolve, analysisCache)
      if (refs.length > 0) {
        detected.push(relPath.replace(/^packages\/frontend\//, ''))
      }
    }
    detected.sort((a, b) => a.localeCompare(b))
    const expected = [...FRONTEND_CROSS_PACKAGE_TESTS].sort((a, b) => a.localeCompare(b))
    expect(
      detected,
      'Any frontend test touching backend/e2e/docs/scripts/root files must be registered in scripts/ci/run-frontend-contract-tests.ts',
    ).toEqual(expected)
    for (const rel of FRONTEND_CROSS_PACKAGE_TESTS) {
      expect(existsSync(resolve(REPO_ROOT, 'packages/frontend', rel)), rel).toBe(true)
    }
  }, 30_000)

  test('no e2e/ file imports or reads any packages/backend/tests/**/*.test.* or *.spec.* file', () => {
    const offenders: string[] = []
    for (const relPath of E2E_SOURCE_FILES) {
      const text = readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
      offenders.push(...findE2eBackendTestReferences(relPath, text))
    }
    expect(offenders).toEqual([])
  })

  test('OS_CORE_E2E_SPECS (19 specs) all exist on disk, are unique, and contain zero @nightly-only specs', () => {
    expect(OS_CORE_E2E_SPECS).toHaveLength(19)
    expect(new Set(OS_CORE_E2E_SPECS).size).toBe(19)
    const missing: string[] = []
    const nightlyTagged: string[] = []
    for (const spec of OS_CORE_E2E_SPECS) {
      const abs = resolve(REPO_ROOT, spec)
      if (!existsSync(abs)) {
        missing.push(spec)
        continue
      }
      const text = readFileSync(abs, 'utf8')
      if (/tag:\s*(?:\[\s*)?['"]@nightly['"]/.test(text)) {
        nightlyTagged.push(spec)
      }
    }
    expect(missing).toEqual([])
    expect(nightlyTagged).toEqual([])
  })
})

describe('RFC-629 CI optimization invariants — negative fixtures', () => {
  test('detects forged cross-package imports, @/util/hash, repo-root fs reads, and helper-mediated backend reads', () => {
    const forgedImport = `
import { describe, test } from 'vitest'
import { schema } from '../../backend/src/db/schema'
describe('forged', () => { test('x', () => void schema) })
`
    expect(
      analyzeFrontendSource('packages/frontend/tests/forged-import.test.ts', forgedImport)
        .crossPackage,
    ).toEqual(['import:packages/backend/src/db/schema'])

    const forgedHashAlias = `
import { hashString } from '@/util/hash'
export const value = hashString('abc')
`
    expect(
      analyzeFrontendSource('packages/frontend/tests/forged-hash.test.ts', forgedHashAlias)
        .crossPackage,
    ).toEqual(['import:@/util/hash'])

    const forgedFsRead = `
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const REPO_ROOT = resolve(import.meta.dirname, '../../..')
export const src = readFileSync(resolve(REPO_ROOT, 'packages/backend/src/main.ts'), 'utf8')
`
    expect(
      analyzeFrontendSource('packages/frontend/tests/forged-fs.test.ts', forgedFsRead).crossPackage,
    ).toContain('path:packages/backend/src/main.ts')

    const files = new Map<string, string>([
      [
        'packages/frontend/tests/forged-entry.test.ts',
        `import { readBackend } from './helpers/forgedHelper'\nexport const x = readBackend()\n`,
      ],
      [
        'packages/frontend/tests/helpers/forgedHelper.ts',
        `import { readFileSync } from 'node:fs'\nimport { resolve } from 'node:path'\nconst ROOT = resolve(import.meta.dirname, '../../../..')\nexport const readBackend = () => readFileSync(resolve(ROOT, 'packages/backend/src/server.ts'), 'utf8')\n`,
      ],
    ])
    const transitive = collectTransitiveCrossPackageRefs(
      'packages/frontend/tests/forged-entry.test.ts',
      (p) => {
        const key = files.has(p) ? p : `${p}.ts`
        const text = files.get(key)
        return text === undefined ? null : { resolvedPath: key, text }
      },
    )
    expect(transitive.some((hit) => hit.includes('packages/backend/src/server.ts'))).toBe(true)
  })

  test('does not false-positive on UI path strings, internal worker URLs, or packages/shared imports', () => {
    const cleanFrontend = `
import { resolve } from 'node:path'
import type { Task } from '@agent-workflow/shared'
export const docsUrl = '/docs/api/v1'
export const workerUrl = new URL('../../../lib/clarify/mindmap/layout.worker.ts', import.meta.url)
const FRONTEND_FILE = resolve(import.meta.dirname, '../src/App.tsx')
export type Sample = Task
export { FRONTEND_FILE }
`
    expect(
      analyzeFrontendSource(
        'packages/frontend/src/components/clarify/mindmap/MindmapCanvas.test.tsx',
        cleanFrontend,
      ).crossPackage,
    ).toEqual([])
  })

  test('detects forged e2e/ import of a backend test file (with or without extension) while allowing backend test helpers', () => {
    const forgedE2e = `
import { test } from '@playwright/test'
import '../packages/backend/tests/tasks.test.ts'
import '../packages/backend/tests/auth.test'
test('forged', async () => {})
`
    expect(findE2eBackendTestReferences('e2e/forged.spec.ts', forgedE2e)).toEqual([
      'e2e/forged.spec.ts: packages/backend/tests/auth.test',
      'e2e/forged.spec.ts: packages/backend/tests/tasks.test.ts',
    ])

    const cleanE2e = `
import { test } from '@playwright/test'
import { helper } from '../packages/backend/tests/helpers/fixture'
test('clean', async () => { void helper })
`
    expect(findE2eBackendTestReferences('e2e/clean.spec.ts', cleanE2e)).toEqual([])
  })
})
