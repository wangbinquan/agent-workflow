// RFC-395 II-pre：锁定测试专用入口与 GC 副本的删除，保留生产启动、历史读取和共享进程租约。
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const BACKEND = resolve(import.meta.dir, '..')
const RETIRED_IDENTIFIERS = new Set([
  'startTaskWithLocalRepo',
  'startTask',
  'startTaskImpl',
  'StartTaskDeps',
  'getTaskNodeRuns',
  'PreCreatedWorktree',
  'WorkflowLaunchCommitHookEvent',
  'resolveTaskGitCommitIdentity',
  'rootLaunchOriginFromDeps',
  'convergeIntentApplyJournal',
  'codeRoundLaunch',
])
const RETIRED_MODULES = [
  '@/services/gc',
  '@/platform/persistence/sqlite/systemWorkspaceGc',
  '@/services/users',
  '@/modules/identity-access/composition/legacyUserService',
  '@/modules/identity-access/infrastructure/legacyUserService',
]

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesIn(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

function isRetiredModule(specifier: string): boolean {
  const normalized = specifier.replace(/^(?:\.\.\/)+src\//, '@/').replace(/\.ts$/, '')
  return RETIRED_MODULES.includes(normalized)
}

function retiredReferences(text: string): string[] {
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && RETIRED_IDENTIFIERS.has(node.text)) found.push(node.text)
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRetiredModule(node.moduleSpecifier.text)
    )
      found.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      isRetiredModule(node.arguments[0].text)
    )
      found.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const readSource = (path: string): string => readFileSync(join(BACKEND, 'src', path), 'utf8')

describe('RFC-395 II-pre deletion locks', () => {
  test('src and tests have no executable references to the retired admission, projection or facade', () => {
    const files = [...filesIn(join(BACKEND, 'src')), ...filesIn(join(BACKEND, 'tests'))]
    expect(files.length).toBeGreaterThan(1000)
    expect(
      files.flatMap((file) =>
        retiredReferences(readFileSync(file, 'utf8')).map(
          (name) => `${relative(BACKEND, file)}: ${name}`,
        ),
      ),
    ).toEqual([])
  }, 20_000)

  test('the AST scanner catches imports, declarations, type references and property calls but ignores historical prose', () => {
    expect(
      retiredReferences(
        "import { startTask } from '@/services/task'; const deps: StartTaskDeps = {}; api.startTaskWithLocalRepo(deps); export { materializingSpaces } from '@/services/gc'",
      ),
    ).toEqual(['startTask', 'StartTaskDeps', 'startTaskWithLocalRepo', '@/services/gc'])
    expect(
      retiredReferences(
        "import('../src/services/users'); export * from '@/modules/identity-access/composition/legacyUserService'; import type { SearchInput } from '@/modules/identity-access/infrastructure/legacyUserService'",
      ),
    ).toEqual([
      '../src/services/users',
      '@/modules/identity-access/composition/legacyUserService',
      '@/modules/identity-access/infrastructure/legacyUserService',
    ])
    expect(retiredReferences("// startTask()\nconst historical = 'getTaskNodeRuns';")).toEqual([])
  })

  test('the GC and user compatibility modules stay deleted; the process lease is a platform leaf', () => {
    for (const path of [
      'services/gc.ts',
      'platform/persistence/sqlite/systemWorkspaceGc.ts',
      'services/users.ts',
      'modules/identity-access/composition/legacyUserService.ts',
      'modules/identity-access/infrastructure/legacyUserService.ts',
    ])
      expect(existsSync(join(BACKEND, 'src', path))).toBe(false)
    const lease = readSource('platform/workspace/materializingSpaces.ts')
    expect(lease).toContain('export const materializingSpaces = new Map')
    expect(lease).not.toMatch(/\bimport\b/)
    expect(readSource('modules/source-control/application/workspaceMaintenance.ts')).toContain(
      'createWorkspaceMaintenanceCommand',
    )
  })

  test('only the production convergence and live bundle contracts remain', () => {
    expect(readSource('modules/intent/infrastructure/intentApplyEngine.ts')).not.toMatch(
      /\bconverge\s*\(/,
    )
    expect(readSource('modules/intent/infrastructure/intentApplyRecovery.ts')).toContain(
      'createIntentApplyRecoveryScene',
    )
    expect(readSource('platform/atomic-apply/convergence.ts')).toContain(
      'decideAtomicApplyConverge',
    )
    const bundle = readSource('services/bundle/provider.ts')
    for (const name of [
      'BundleApplyState',
      'StagedSkillVersionLike',
      'BundleArtifact',
      'BundleApplyProvider',
      'BundlePendingSeams',
      'pendingSeamsFor',
      'BundleApplyInput',
      'opAction',
    ])
      expect(bundle).not.toMatch(new RegExp(`\\b${name}\\b`))
    for (const name of ['opSlug', 'planBundleOps', 'resourceTypeOfOp', 'BundleReceipt'])
      expect(bundle).toContain(name)
  })
})
