// RFC-616 §3 (design/RFC-616-process-metrics/design.md) — where process metrics
// sit in the target architecture.
//
// Process metrics are computed in `modules/run-observability` from facts five
// other contexts own. The shape that keeps that legal:
//   · the fact contracts are types in `platform/contracts/processFacts.ts`;
//   · each owner implements its contract in its own infrastructure and never
//     learns who consumes it;
//   · run-observability reads only its own tables and reaches the owners only
//     through those contracts, bound by bootstrap;
//   · the route registry records human operations through a sink it is handed,
//     so it still knows no module.
// Each rule has a negative fixture: a rule that cannot fail proves nothing.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, importEdges, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const SRC = 'packages/backend/src/'
const MODULE = SRC + 'modules/run-observability/'
const CONTRACT = SRC + 'platform/contracts/processFacts.ts'
const REGISTRY = SRC + 'routes/registry.ts'

const OWN_TABLES = new Set([
  'observationCalls',
  'observationCallModels',
  'observationPrices',
  'observationOperations',
  'observationInsightAnalyses',
])

/** The five fact implementations and the contract each one implements. */
const FACT_IMPLEMENTATIONS: Readonly<Record<string, readonly string[]>> = {
  [SRC + 'modules/task-execution/infrastructure/processTaskFacts.ts']: ['ProcessTaskFacts'],
  [SRC + 'modules/task-execution/infrastructure/processWorkgroupFacts.ts']: [
    'ProcessWorkgroupFacts',
  ],
  [SRC + 'modules/collaboration/infrastructure/processGateFacts.ts']: ['ProcessGateFacts'],
  [SRC + 'modules/digital-employee/infrastructure/processEmployeeFacts.ts']: [
    'ProcessEmployeeFacts',
  ],
  [SRC + 'modules/event-center/infrastructure/processSubjectEvents.ts']: ['ProcessSubjectEvents'],
}

/** Names destructured from `tablesOf(…)` anywhere in the unit. */
function tablesRead(unit: SourceUnit): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'tablesOf'
    )
      for (const element of node.name.elements)
        names.push((element.propertyName ?? element.name).getText(unit.source))
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return names
}

const foreignTables = (units: readonly SourceUnit[]): string[] =>
  units
    .filter((unit) => unit.path.startsWith(MODULE))
    .flatMap((unit) =>
      tablesRead(unit)
        .filter((name) => !OWN_TABLES.has(name))
        .map((name) => `${unit.path} reads ${name}`),
    )
    .sort()

const moduleImports = (unit: SourceUnit): string[] =>
  importEdges(unit)
    .map((edge) => edge.specifier)
    .filter((specifier) => specifier.startsWith('@/modules/'))

/** Imports of the consumer by the owners: an owner must not know run-observability exists. */
const consumerImports = (units: readonly SourceUnit[]): string[] =>
  units
    .filter((unit) => unit.path in FACT_IMPLEMENTATIONS)
    .flatMap((unit) =>
      moduleImports(unit)
        .filter((specifier) => specifier.startsWith('@/modules/run-observability/'))
        .map((specifier) => `${unit.path} -> ${specifier}`),
    )

/** Names imported from the platform contract by a unit. */
function contractNames(unit: SourceUnit): string[] {
  const names: string[] = []
  for (const statement of unit.source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@/platform/contracts/processFacts' ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue
    for (const element of statement.importClause.namedBindings.elements)
      names.push((element.propertyName ?? element.name).text)
  }
  return names
}

describe('RFC-616 process metrics boundaries', () => {
  const units = backendUnits(REPO_ROOT)
  const unitAt = (path: string) => units.find((unit) => unit.path === path)

  test('the scanned corpus is the backend source tree and holds every file named here', () => {
    expect(units.length).toBeGreaterThanOrEqual(2000)
    for (const path of [CONTRACT, REGISTRY, ...Object.keys(FACT_IMPLEMENTATIONS)])
      expect([path, unitAt(path) !== undefined]).toEqual([path, true])
    expect(
      units.filter((unit) => unit.path.startsWith(MODULE + 'domain/process/')).length,
    ).toBeGreaterThanOrEqual(10)
  })

  test('run observation reads its own five tables and no other', () => {
    expect(foreignTables(units)).toEqual([])
    // The process queries themselves never touch a table: they only talk to ports.
    const application = units.filter(
      (unit) =>
        unit.path.startsWith(MODULE + 'application/process/') ||
        unit.path.startsWith(MODULE + 'domain/process/'),
    )
    expect(application.length).toBeGreaterThanOrEqual(20)
    expect(
      application.filter((unit) => tablesRead(unit).length > 0).map((unit) => unit.path),
    ).toEqual([])
    expect(
      application
        .filter((unit) => importEdges(unit).some((edge) => edge.specifier === 'drizzle-orm'))
        .map((unit) => unit.path),
    ).toEqual([])
  })

  test('negative fixture: a read of a task table inside the module is caught', () => {
    const intruder = sourceUnit(
      MODULE + 'infrastructure/shortcut.ts',
      'export const read = (db: object) => { const { nodeRuns, observationCalls } = tablesOf(db); return [nodeRuns, observationCalls] }',
    )
    expect(foreignTables([intruder])).toEqual([`${intruder.path} reads nodeRuns`])
  })

  test('the contract is types and one constant, and depends on nothing in the backend', () => {
    const contract = unitAt(CONTRACT)!
    expect(importEdges(contract).map((edge) => [edge.specifier, edge.kind])).toEqual([
      ['@agent-workflow/shared', 'type'],
    ])
    const runtime = contract.source.statements.filter(
      (statement) =>
        !ts.isImportDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement),
    )
    expect(runtime.map((statement) => statement.getText(contract.source))).toEqual([
      'export const PROCESS_FACT_ID_BATCH = 500',
      "export const PROCESS_EMPLOYEE_CASE_SUBJECT = 'digital-employee.case'",
    ])
  })

  test('each owner implements its own contract and does not know the consumer', () => {
    expect(consumerImports(units)).toEqual([])
    for (const [path, contracts] of Object.entries(FACT_IMPLEMENTATIONS)) {
      const unit = unitAt(path)!
      for (const contract of contracts)
        expect([path, contractNames(unit).includes(contract)]).toEqual([path, true])
      // A fact implementation reads its own module's tables through the session; it runs no process.
      expect([path, unit.text.includes('Bun.spawn(')]).toEqual([path, false])
    }
  })

  test('negative fixture: an owner that imports the consumer is caught', () => {
    const path = Object.keys(FACT_IMPLEMENTATIONS)[0]!
    const leaking = sourceUnit(
      path,
      "import type { ProcessQueries } from '@/modules/run-observability/application/process/processQueries'\nexport type Leak = ProcessQueries",
    )
    expect(consumerImports([leaking])).toEqual([
      `${path} -> @/modules/run-observability/application/process/processQueries`,
    ])
  })

  test('only the insight runner crosses from task execution into run observation, through its public contract', () => {
    const crossing = units
      .filter(
        (unit) =>
          unit.path.startsWith(SRC + 'modules/') &&
          !unit.path.startsWith(MODULE) &&
          /process(Insight|Task|Workgroup|Gate|Employee|Subject)/.test(unit.path),
      )
      .flatMap((unit) =>
        moduleImports(unit)
          .filter((specifier) => specifier.startsWith('@/modules/run-observability/'))
          .map((specifier) => `${unit.path.slice(SRC.length)} -> ${specifier}`),
      )
    expect(crossing).toEqual([
      'modules/task-execution/infrastructure/processInsightGeneration.ts -> @/modules/run-observability/public/participants',
    ])
  })

  test('the route registry records operations through a sink and imports no module', () => {
    const registry = unitAt(REGISTRY)!
    expect(moduleImports(registry)).toEqual([])
    expect(registry.text).toContain('export function attachRouteOperationSink(')
    // The one binding of that sink is run observation's own assembly.
    expect(
      units
        .filter((unit) => /\battachRouteOperationSink\(/.test(unit.text) && unit.path !== REGISTRY)
        .map((unit) => unit.path),
    ).toEqual([MODULE + 'composition/runObservation.ts'])
  })

  test('negative fixture: a registry that imports the recorder is caught', () => {
    const coupled = sourceUnit(
      REGISTRY,
      "import { composeOperationRecorder } from '@/modules/run-observability/composition/processMetrics'\nexport const sink = composeOperationRecorder",
    )
    expect(moduleImports(coupled)).toEqual([
      '@/modules/run-observability/composition/processMetrics',
    ])
  })

  test('the metric engine is pure: no clock, no randomness, no I/O in domain/process', () => {
    const domain = units.filter((unit) => unit.path.startsWith(MODULE + 'domain/process/'))
    const impure = domain.flatMap((unit) =>
      ['Date.now(', 'new Date()', 'Math.random(', 'setTimeout(', 'process.env', 'await ']
        .filter((marker) => unit.text.includes(marker))
        .map((marker) => `${unit.path}: ${marker}`),
    )
    expect(impure).toEqual([])
    expect(
      domain
        .flatMap((unit) => importEdges(unit).map((edge) => edge.specifier))
        .filter(
          (specifier) =>
            !specifier.startsWith('.') &&
            specifier !== '@agent-workflow/shared' &&
            specifier !== '@/platform/contracts/processFacts',
        ),
    ).toEqual([])
  })
})
