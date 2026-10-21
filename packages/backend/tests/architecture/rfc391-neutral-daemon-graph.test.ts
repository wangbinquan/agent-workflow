// RFC-391 / RFC-376: one application graph, one session graph and exactly one provider adapter table.
import { expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const PREFIX = 'packages/backend/src/'
const APPLICATION = PREFIX + 'bootstrap/daemonApplication.ts'
const SESSION = PREFIX + 'bootstrap/daemonSession.ts'
const ADAPTERS = PREFIX + 'bootstrap/daemonSessionAdapters.ts'
const FIELDS = [
  'open',
  'admitSelections',
  'core',
  'taskExecution',
  'afterCore',
  'maintenance',
  'scheduledBackup',
  'recoveryProofGeneration',
].sort()
const RETIRED = [
  'composeSqliteProviderSession',
  'composePostgresqlProviderSession',
  'composeDaemonProviderSession',
  'composePostgresqlDaemonApplication',
  'composePostgresqlApplication',
]
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isSatisfiesExpression(node) || ts.isAsExpression(node) ? unwrap(node.expression) : node
}
export function neutralDaemonViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  for (const [name, path] of [
    ['composeDaemonApplication', APPLICATION],
    ['composeDaemonSession', SESSION],
  ] as const) {
    const definitions: string[] = []
    for (const unit of units)
      walk(unit.source, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) definitions.push(unit.path)
      })
    if (definitions.length !== 1 || definitions[0] !== path) errors.push(`unique graph: ${name}`)
  }
  const lifecycle: string[] = []
  const tables: ts.ObjectLiteralExpression[] = []
  for (const unit of units) {
    if (unit.path === PREFIX + 'cli/postgresqlDaemonApplication.ts') errors.push('retired file')
    walk(unit.source, (node) => {
      if (ts.isFunctionDeclaration(node) && RETIRED.includes(node.name?.text ?? ''))
        errors.push('retired function')
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(unit.source) === 'composeDaemonLifecycle'
      )
        lifecycle.push(unit.path)
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(unit.source) === 'DAEMON_SESSION_ADAPTERS'
      ) {
        const value = node.initializer && unwrap(node.initializer)
        if (unit.path !== ADAPTERS || !value || !ts.isObjectLiteralExpression(value))
          errors.push('adapter table location')
        else tables.push(value)
      }
      if (
        [
          APPLICATION,
          SESSION,
          ADAPTERS,
          PREFIX + 'bootstrap/daemonHttpComposition.ts',
          PREFIX + 'bootstrap/developmentPurposeRoot.ts',
        ].includes(unit.path)
      ) {
        if (
          ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(node.operatorToken.kind) &&
          [node.left, node.right].some(
            (value) => ts.isStringLiteral(value) && ['sqlite', 'postgresql'].includes(value.text),
          )
        )
          errors.push('provider comparison')
        if (
          ts.isCaseClause(node) &&
          ts.isStringLiteral(node.expression) &&
          ['sqlite', 'postgresql'].includes(node.expression.text)
        )
          errors.push('provider comparison')
      }
      if (
        [PREFIX + 'cli/start.ts', PREFIX + 'cli/dev.ts'].includes(unit.path) &&
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /(?:^|\/)bootstrap\//.test(node.moduleSpecifier.text)
      )
        errors.push('CLI imports bootstrap')
    })
  }
  if (lifecycle.length !== 1 || lifecycle[0] !== SESSION) errors.push('unique lifecycle')
  if (tables.length !== 1) errors.push('unique adapter table')
  for (const table of tables) {
    if (
      table.properties
        .map((entry) => entry.name?.getText())
        .sort()
        .join(',') !== 'postgresql,sqlite'
    )
      errors.push('adapter providers')
    for (const entry of table.properties) {
      if (
        !ts.isPropertyAssignment(entry) ||
        !ts.isObjectLiteralExpression(entry.initializer) ||
        entry.initializer.properties
          .map((field) => field.name?.getText())
          .sort()
          .join(',') !== FIELDS.join(',')
      )
        errors.push('adapter fields')
    }
  }
  return errors
}
const unit = (path: string, text: string) => sourceUnit(path, text)
const valid = () => [
  unit(APPLICATION, 'export function composeDaemonApplication() {}'),
  unit(SESSION, 'export function composeDaemonSession() { composeDaemonLifecycle({}) }'),
  unit(
    ADAPTERS,
    `const DAEMON_SESSION_ADAPTERS = { sqlite: {${FIELDS.map((field) => `${field}: x`).join(',')}}, postgresql: {${FIELDS.map((field) => `${field}: x`).join(',')}} } satisfies Table`,
  ),
]
test('complete production corpus has one graph pair, one lifecycle and the exact adapter entries', () => {
  const units = backendUnits(resolve(import.meta.dir, '../../../..'))
  expect(units.length).toBeGreaterThanOrEqual(2000)
  expect(neutralDaemonViolations(units)).toEqual([])
  const application = units.find((unit) => unit.path === APPLICATION)!.text
  const session = units.find((unit) => unit.path === SESSION)!.text
  expect(application).toContain('DAEMON_BOOT_STEPS.find')
  expect(application).toContain('!declaration.providers.includes(provider)')
  expect(session).toContain(
    'snapshotMaintenanceTaskIds(runtime.taskExecutionModules.activeTaskIds)',
  )
  expect(session).toContain('...materializingSpaces.keys()')
}, 30_000)
test('compliant fixtures and every structural rejection use the same detector', () => {
  expect(neutralDaemonViolations(valid())).toEqual([])
  for (const [path, source, violation] of [
    [
      'other.ts',
      'function composeDaemonApplication() {}',
      'unique graph: composeDaemonApplication',
    ],
    ['other.ts', 'function composeDaemonSession() {}', 'unique graph: composeDaemonSession'],
    [PREFIX + 'cli/postgresqlDaemonApplication.ts', '', 'retired file'],
    [SESSION, 'function composeSqliteProviderSession() {}', 'retired function'],
    [APPLICATION, 'composeDaemonLifecycle({})', 'unique lifecycle'],
    [APPLICATION, "if (provider === 'sqlite') run()", 'provider comparison'],
    [ADAPTERS, "switch(provider) { case 'postgresql': run() }", 'provider comparison'],
    [PREFIX + 'cli/start.ts', "import type { X } from '@/bootstrap/x'", 'CLI imports bootstrap'],
    [PREFIX + 'cli/dev.ts', "import { X } from '../bootstrap/x'", 'CLI imports bootstrap'],
    ['other.ts', 'const DAEMON_SESSION_ADAPTERS = {}', 'adapter table location'],
  ])
    expect(neutralDaemonViolations([...valid(), unit(path!, source!)])).toContain(violation!)
  expect(neutralDaemonViolations([])).toContain('unique lifecycle')
  expect(neutralDaemonViolations([])).toContain('unique adapter table')
  expect(neutralDaemonViolations(valid().slice(0, 2))).toContain('unique adapter table')
  expect(
    neutralDaemonViolations([
      ...valid().slice(0, 2),
      unit(ADAPTERS, 'const DAEMON_SESSION_ADAPTERS = {sqlite: {open: x}}'),
    ]),
  ).toEqual(['adapter providers', 'adapter fields'])
})
