function isStandaloneWorkerEntry(unit: SourceUnit | undefined): boolean {
  if (unit?.path !== PREFIX + 'bootstrap/maintenanceWorkerEntries.ts') return false
  const statements = unit.source.statements
  if (statements.length !== 2) return false
  const declarations = statements.map((statement) => {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
      statement.declarationList.declarations.length !== 1
    )
      return undefined
    return { statement, declaration: statement.declarationList.declarations[0]! }
  })
  const flag = declarations[0],
    entry = declarations[1]
  return (
    flag !== undefined &&
    entry !== undefined &&
    flag.statement.modifiers?.length === 1 &&
    flag.statement.modifiers[0]?.kind === ts.SyntaxKind.DeclareKeyword &&
    flag.declaration.name.getText() === 'AW_COMPILED_BUILD' &&
    flag.declaration.initializer === undefined &&
    entry.statement.modifiers?.length === 1 &&
    entry.statement.modifiers[0]?.kind === ts.SyntaxKind.ExportKeyword &&
    entry.declaration.name.getText() === 'MAINTENANCE_WORKER_ENTRY' &&
    entry.declaration.initializer?.getText().replace(/\s+/g, '') ===
      "typeofAW_COMPILED_BUILD==='boolean'&&AW_COMPILED_BUILD?'./bootstrap/maintenanceWorker.ts':newURL('./maintenanceWorker.ts',import.meta.url).href"
  )
}

// RFC-389 — lock the Worker/runtime split, single neutral graph and all entry inventories.
// Negative fixtures prove that a main-thread root import, duplicated graph or path drift fails.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, BOOTSTRAP_FILES, importEdges, sourceUnit, type SourceUnit } from './census'
import { BINARY_ENTRIES, resolveImport } from './rfc294Gates'
import { binaryEntries } from './architectureReport'

const PREFIX = 'packages/backend/src/'
const ROOT_ENTRY = 'bootstrap/maintenanceWorker.ts'
const GRAPH = 'bootstrap/maintenanceWorkerGraph.ts'
const RUNTIME = 'platform/background/maintenanceWorkerRuntime.ts'
const ENTRIES = 'bootstrap/maintenanceWorkerEntries.ts'
const SYSTEM = 'platform/background/maintenanceSystemOperations.ts'
const FACTORIES = [
  'createMaintenanceRunStore',
  'composeIntegrationMaintenanceCommands',
  'composeWebhookDeliveryPersistenceFor',
  'createTaskExecutionPersistence',
  'createDrizzleTaskArchiveMaintenanceCommand',
  'composeWorkspacePreparationMaintenance',
  'createWorkerWorkspaceMaintenanceCommand',
  'composeRepositoryPreparation',
  'composeWorkspaceMaintenanceCommand',
  'createTokenCallAudit',
  'composePluginGenerationGcCommand',
  'createMaintenanceExecutionFence',
  'composeDevelopmentAutomationMaintenanceCommands',
  'composeDigitalEmployeeMaintenanceCommands',
  'composeIntentMaintenanceCommandsForDatabase',
  'createAtomicApplyRecovery',
  'composeIntentApplyRecoveryScene',
  'composeMaintenanceSystemOperations',
] as const
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function calls(node: ts.Node, name: string): ts.CallExpression[] {
  const result: ts.CallExpression[] = []
  walk(node, (child) => {
    if (ts.isCallExpression(child) && child.expression.getText() === name) result.push(child)
  })
  return result
}
function variable(unit: SourceUnit | undefined, name: string): ts.Expression | undefined {
  let result: ts.Expression | undefined
  if (unit)
    walk(unit.source, (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === name) result = node.initializer
    })
  return result
}
export function workerRootViolations(
  units: readonly SourceUnit[],
  build: string,
  binaries: readonly string[],
): string[] {
  const errors: string[] = []
  const paths = new Set(units.map((unit) => unit.path))
  const find = (name: string) => units.find((unit) => unit.path === PREFIX + name)
  for (const unit of units) {
    if (unit.path === PREFIX + 'platform/background/maintenanceWorker.ts')
      errors.push('retired platform root')
    if (unit.path.startsWith(PREFIX + 'platform/'))
      walk(unit.source, (node) => {
        if (ts.isStringLiteralLike(node) && node.text.includes('bootstrap/'))
          errors.push('platform contains bootstrap path')
      })
    for (const edge of importEdges(unit)) {
      const target = resolveImport(unit.path, edge.specifier, paths)
      if (
        target === PREFIX + ROOT_ENTRY &&
        unit.path !== PREFIX + 'bootstrap/maintenanceWorkerEntry.ts'
      )
        errors.push('main imports Worker root')
      if (
        [PREFIX + RUNTIME, PREFIX + SYSTEM].includes(unit.path) &&
        target.startsWith(PREFIX + 'modules/')
      )
        errors.push('mechanism imports module')
      if (
        unit.path.startsWith(PREFIX + 'platform/background/') &&
        target.includes('/modules/') &&
        target.includes('/composition')
      )
        errors.push('platform composes module')
    }
  }
  const graph = find(GRAPH)
  const body = variable(graph, 'composeMaintenanceWorkerGraph')
  if (!body || !ts.isArrowFunction(body)) errors.push('missing neutral graph')
  for (const name of FACTORIES) {
    if (!body || calls(body, name).length !== 1 || !graph || calls(graph.source, name).length !== 1)
      errors.push(`compose once: ${name}`)
  }
  if (body)
    walk(body, (node) => {
      if (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node))
        errors.push('branch in neutral graph')
      if (
        ts.isIdentifier(node) &&
        ['runRetentionSweepSlice', 'checkpointSqliteWal', 'setInterval', 'setTimeout'].includes(
          node.text,
        )
      )
        errors.push('mechanism in graph')
    })
  const table = variable(graph, 'MAINTENANCE_WORKER_ADAPTERS')
  if (
    !table ||
    !ts.isObjectLiteralExpression(table) ||
    table.properties
      .map((p) => p.name?.getText())
      .sort()
      .join(',') !== 'postgresql,sqlite'
  )
    errors.push('adapter table differs')
  if (graph)
    walk(graph.source, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(node.operatorToken.kind) &&
        [node.left, node.right].some(
          (part) => ts.isStringLiteral(part) && ['sqlite', 'postgresql'].includes(part.text),
        )
      )
        errors.push('provider name comparison')
    })
  if (!graph?.text.includes("'database' in request")) errors.push('missing shape selection')
  const root = find(ROOT_ENTRY)
  if (
    !root ||
    root.source.statements.filter((node) => !ts.isImportDeclaration(node)).length !== 1 ||
    calls(root.source, 'runMaintenanceWorker').length !== 1 ||
    !root.text.includes('composeGraph: composeMaintenanceWorkerGraph')
  )
    errors.push('entry is not thin')
  const entries = find(ENTRIES)
  if (!isStandaloneWorkerEntry(entries)) errors.push('standalone entry forms differ')
  if (
    !binaryEntries(build).includes(PREFIX + ROOT_ENTRY) ||
    !binaries.includes(PREFIX + ROOT_ENTRY) ||
    binaryEntries(build).includes(PREFIX + 'platform/background/maintenanceWorker.ts') ||
    binaries.includes(PREFIX + 'platform/background/maintenanceWorker.ts')
  )
    errors.push('binary entry drift')
  const start = find('bootstrap/daemonSession.ts')
  const supervisors = start ? calls(start.source, 'startMaintenanceWorkerSupervisor') : []
  if (
    supervisors.length !== 1 ||
    supervisors.some((call) => {
      const options = call.arguments[0]
      return (
        !options ||
        !ts.isObjectLiteralExpression(options) ||
        !options.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            p.name.getText() === 'workerEntry' &&
            p.initializer.getText() === 'MAINTENANCE_WORKER_ENTRY',
        )
      )
    }) ||
    !start ||
    !importEdges(start).some((edge) => edge.specifier === '@/bootstrap/maintenanceWorkerEntries')
  )
    errors.push('sessions do not pass entry')
  return errors
}
const REPO = resolve(import.meta.dir, '../../../..')
const UNITS = backendUnits(REPO)
const BUILD = readFileSync(resolve(REPO, 'scripts/build-binary.ts'), 'utf8')
function changed(path: string, change: (text: string) => string): SourceUnit[] {
  return UNITS.map((unit) =>
    unit.path === PREFIX + path ? sourceUnit(unit.path, change(unit.text)) : unit,
  )
}
describe('RFC-389 Worker composition structural locks', () => {
  test('a fully fabricated caller still rejects a Worker-root import through the production matcher', () => {
    expect(
      workerRootViolations(
        [
          sourceUnit(PREFIX + 'main.ts', "import './bootstrap/maintenanceWorker'"),
          sourceUnit(
            PREFIX + ROOT_ENTRY,
            'runMaintenanceWorker({ composeGraph: composeMaintenanceWorkerGraph })',
          ),
        ],
        "const mainEntry = join(backendSrc, 'main.ts')",
        [],
      ),
    ).toContain('main imports Worker root')
  })

  test('scans production sources and keeps entry/root/graph registered', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(2000)
    expect(workerRootViolations(UNITS, BUILD, BINARY_ENTRIES)).toEqual([])
    for (const path of [ROOT_ENTRY, GRAPH, ENTRIES])
      expect(BOOTSTRAP_FILES as readonly string[]).toContain(PREFIX + path)
    expect(BOOTSTRAP_FILES as readonly string[]).not.toContain(
      PREFIX + 'platform/background/maintenanceWorker.ts',
    )
  })
  test('rejects root imports, platform module construction and a bootstrap path', () => {
    const mutations = [
      ['main.ts', "import './bootstrap/maintenanceWorker'", 'main imports Worker root'],
      [
        RUNTIME,
        "import { compose } from '@/modules/intent/composition/maintenance'",
        'mechanism imports module',
      ],
      [
        'platform/background/newWorker.ts',
        "import { compose } from '@/modules/intent/composition/maintenance'",
        'platform composes module',
      ],
      [
        'platform/newPath.ts',
        "const entry = './bootstrap/maintenanceWorker.ts'",
        'platform contains bootstrap path',
      ],
    ] as const
    for (const [path, text, error] of mutations)
      expect(
        workerRootViolations([...UNITS, sourceUnit(PREFIX + path, text)], BUILD, BINARY_ENTRIES),
      ).toContain(error)
  }, 30_000)
  test('rejects duplicated factories, provider branches and missing adapter selection', () => {
    for (const name of FACTORIES)
      expect(
        workerRootViolations(
          changed(
            GRAPH,
            (text) =>
              text +
              `
${name}(input)`,
          ),
          BUILD,
          BINARY_ENTRIES,
        ),
      ).toContain(`compose once: ${name}`)
    expect(
      workerRootViolations(
        changed(GRAPH, (text) =>
          text.replace(
            'const adapter =',
            "if (input.provider === 'sqlite') return {}; const adapter =",
          ),
        ),
        BUILD,
        BINARY_ENTRIES,
      ),
    ).toContain('branch in neutral graph')
    expect(
      workerRootViolations(
        changed(GRAPH, (text) =>
          text.replace("'database' in request", "request.provider === 'postgresql'"),
        ),
        BUILD,
        BINARY_ENTRIES,
      ),
    ).toContain('provider name comparison')
  }, 30_000)
  test('rejects build/inventory/session entry drift and a side-effectful path module', () => {
    expect(
      workerRootViolations(
        UNITS,
        BUILD.replace("'bootstrap', 'maintenanceWorker.ts'", "'bootstrap', 'wrongWorker.ts'"),
        BINARY_ENTRIES,
      ),
    ).toContain('binary entry drift')
    expect(
      workerRootViolations(
        UNITS,
        BUILD,
        BINARY_ENTRIES.filter((path) => path !== PREFIX + ROOT_ENTRY),
      ),
    ).toContain('binary entry drift')
    expect(
      workerRootViolations(
        changed('bootstrap/daemonSession.ts', (text) =>
          text.replace('workerEntry: MAINTENANCE_WORKER_ENTRY', "workerEntry: './wrongWorker.ts'"),
        ),
        BUILD,
        BINARY_ENTRIES,
      ),
    ).toContain('sessions do not pass entry')
    expect(
      workerRootViolations(
        changed(ENTRIES, (text) => text + "\nimport './maintenanceWorker'"),
        BUILD,
        BINARY_ENTRIES,
      ),
    ).toContain('standalone entry forms differ')
  }, 30_000)
  test('keeps original counter keys, timings and lazy selected-effect fallbacks', () => {
    const runtime = UNITS.find((unit) => unit.path === PREFIX + RUNTIME)!
    for (const literal of [
      'LEASE_MS = 60 * 60 * 1_000',
      'IDLE_POLL_MS = 1_000',
      'HEARTBEAT_MS = 5_000',
      'MAX_BUSY_BACKOFF_MS = 30_000',
      'CLEANUP_COOLDOWN_MS = 25',
      'sqliteBusyDeferrals: busyDeferrals',
      'sqliteBusyDeferrals: 1',
      'postgresqlTransientDeferrals: 1',
      'workerFailures: 1',
      'workerSliceCount: 1',
      "timingCounters('dbStatement'",
      "timingCounters('dbTransaction'",
    ])
      expect(runtime.text).toContain(literal)
    const graph = UNITS.find((unit) => unit.path === PREFIX + GRAPH)!
    const fallback = calls(graph.source, 'createPluginGenerationFilesystemGcPort')
    expect(fallback).toHaveLength(1)
    expect(ts.isBinaryExpression(fallback[0]!.parent)).toBe(true)
    expect((fallback[0]!.parent as ts.BinaryExpression).operatorToken.kind).toBe(
      ts.SyntaxKind.QuestionQuestionToken,
    )
    expect(graph.text).toContain('objectPublications: workerEffects?.objectPublications')
  })
})
