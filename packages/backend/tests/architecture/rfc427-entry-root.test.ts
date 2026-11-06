// RFC-427: the entry root parses arguments, selects the deployment and dispatches (RFC-294 S2c exit gate). This lock
// pins that shape: `main.ts` imports only `cli/`, `bootstrap/` and a short list of entry-level helpers (each with its
// reason), declares no functions beyond its argument helpers and `main`, and `bootstrap/deployment.ts` reads the
// deployment mode only inside `selectDeployment`. Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const MAIN = PREFIX + 'main.ts'
const DEPLOYMENT = PREFIX + 'bootstrap/deployment.ts'
/** What `main.ts` may import besides `cli/` and `bootstrap/`, and why. */
const ENTRY_IMPORTS: Readonly<Record<string, string>> = {
  './platform/execution/local/managedProcessLauncher':
    'the process launcher runs before any assembly (RFC-328; RFC-457 dropped the services/ facade in between)',
  './util/version': 'the `version` command',
  './util/log': 'the startup failure log',
  './util/paths': 'the application home handed to the legacy epoch command',
  './util/gitCredentialLease': 'the git credential-helper protocol (RFC-254 T20)',
}
const MAIN_FUNCTIONS = ['isE2eBuild', 'main', 'readFlag', 'readPortFlag']
const UNITS = backendUnits(ROOT)

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function specifiers(source: ts.SourceFile): string[] {
  const found: string[] = []
  walk(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteralLike(argument)) found.push(argument.text)
    }
  })
  return found
}

function enclosingFunction(node: ts.Node): string {
  for (let owner = node.parent; owner !== undefined; owner = owner.parent)
    if (ts.isFunctionDeclaration(owner)) return owner.name?.text ?? '<anonymous>'
  return '<module>'
}

export function entryRootViolations(units: readonly SourceUnit[]): string[] {
  const found = new Set<string>()
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const main = byPath.get(MAIN)
  if (main === undefined) found.add('main-missing')
  else {
    for (const specifier of specifiers(main.source)) {
      const relative = specifier.startsWith('@/') ? './' + specifier.slice(2) : specifier
      if (
        !relative.startsWith('./cli/') &&
        !relative.startsWith('./bootstrap/') &&
        !(relative in ENTRY_IMPORTS)
      )
        found.add('main-import:' + specifier)
    }
    const functions = main.source.statements
      .filter(ts.isFunctionDeclaration)
      .map((node) => node.name?.text ?? '<anonymous>')
      .sort()
    if (functions.join(',') !== MAIN_FUNCTIONS.join(','))
      found.add('main-functions:' + functions.join(','))
  }
  const deployment = byPath.get(DEPLOYMENT)
  if (deployment !== undefined) {
    const readers: string[] = []
    walk(deployment.source, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'readDeploymentMode'
      )
        readers.push(enclosingFunction(node))
    })
    if (readers.sort().join(',') !== 'selectDeployment')
      found.add('deployment-mode-reads:' + readers.join(','))
  }
  return [...found].sort()
}

test('live corpus: the entry root only parses, selects and dispatches', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(entryRootViolations(UNITS)).toEqual([])
})

test('negative fixtures over the corpus: each way back is reported', () => {
  const replace = (path: string, edit: (text: string) => string) =>
    UNITS.map((unit) => (unit.path === path ? sourceUnit(path, edit(unit.text)) : unit))
  expect(
    entryRootViolations(
      replace(
        MAIN,
        (text) =>
          "import { createIdentityAccessRuntime } from './modules/identity-access/composition'\n" +
          text,
      ),
    ),
  ).toEqual(['main-import:./modules/identity-access/composition'])
  expect(
    entryRootViolations(
      replace(
        MAIN,
        (text) => text + '\nasync function composeUserCommandBootstrap() {\n  return null\n}\n',
      ),
    ),
  ).toEqual(['main-functions:composeUserCommandBootstrap,isE2eBuild,main,readFlag,readPortFlag'])
  expect(
    entryRootViolations(
      replace(
        DEPLOYMENT,
        (text) =>
          text +
          '\nexport function migrateForDeployment(env: Record<string, string>) {\n  return readDeploymentMode(env)\n}\n',
      ),
    ),
  ).toEqual(['deployment-mode-reads:migrateForDeployment,selectDeployment'])
})

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) => entryRootViolations([sourceUnit(path, text)])
  expect(
    only(MAIN, "const { x } = await import('../services/task')\nasync function main() {}"),
  ).toContain('main-import:../services/task')
  expect(only(MAIN, 'function compose() {}')).toContain('main-functions:compose')
  expect(
    only(DEPLOYMENT, 'export function migrateFor(env: object) { return readDeploymentMode(env) }'),
  ).toContain('deployment-mode-reads:migrateFor')
})
