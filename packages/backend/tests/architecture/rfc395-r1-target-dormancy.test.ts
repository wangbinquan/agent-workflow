// RFC-395 activation: one live registry/accessor, with frozen source ownership and destinations audited.
import { describe, expect, test } from 'bun:test'
import { resolve, posix, relative } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import ts from 'typescript'
import roster from '@/bootstrap/targetSchemaRoster.json'
import destinations from '@/bootstrap/targetColumnDestinations.json'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { frozenEpoch1Registry } from '@/platform/persistence/migration/epoch1/definitions'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import type { TableDefinition } from '@/platform/persistence/schema/contribution'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const retiredNames = new Set([
  'targetPersistenceSchema',
  'targetNativeTableSets',
  'targetSchemaContract',
  'targetRowRuleCodes',
  'targetSqlitePlan',
  'targetPostgresqlPlan',
  'targetTablesOf',
  'bindTargetDatabaseHandle',
  'bindTargetPersistenceTables',
  'TargetPersistenceTables',
  'TargetNativeTableSets',
  'TargetSchemaBinding',
])
function activationViolations(unit: SourceUnit): string[] {
  const path = unit.path.replace(/^packages\/backend\/src\//, '')
  const violations = new Set<string>()
  const checkPath = (specifier: string) => {
    const resolved = (
      specifier.startsWith('@/')
        ? specifier.slice(2)
        : specifier.startsWith('.')
          ? posix.normalize(posix.join(posix.dirname(path), specifier))
          : specifier
    )
      .replace(/\.ts$/, '')
      .replace(/^packages\/backend\/src\//, '')
    if (
      resolved === 'bootstrap/targetPersistenceSchema' ||
      /(?:composition|persistence)\/targetSchema$/.test(resolved) ||
      resolved === 'platform/persistence/schema/targetTables'
    )
      violations.add('retired schema entry')
  }
  checkPath(path)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && retiredNames.has(node.text)) violations.add('retired live symbol')
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      checkPath(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      checkPath(node.arguments[0].text)
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      retiredNames.has(node.argumentExpression.text)
    )
      violations.add('retired live symbol')
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return [...violations].sort()
}
function rosterViolations(
  tables: readonly { id: string; owner: string }[],
  rows: readonly { table: string; owner: string; sources: readonly string[] }[],
): string[] {
  const out: string[] = []
  if (new Set(rows.map((row) => row.table)).size !== rows.length) out.push('duplicate roster table')
  for (const table of tables)
    if (!rows.some((row) => row.table === table.id && row.owner === table.owner))
      out.push(`missing/wrong owner: ${table.id}`)
  for (const row of rows)
    if (!tables.some((table) => table.id === row.table))
      out.push(`unregistered target: ${row.table}`)
  return out
}

interface Destination {
  table: string | null
  column: string
  mutability: string
  conversion?: string
  companion?: string
}
function destinationViolations(
  mapping: Readonly<Record<string, Readonly<Record<string, Destination>>>>,
): string[] {
  const source = new Map<string, TableDefinition>(
    frozenEpoch1Registry.tables.map((table) => [table.id, table]),
  )
  const target = new Map<string, TableDefinition>(
    persistenceSchema.tables.map((table) => [table.id, table]),
  )
  const reshaped = new Set(
    [
      ...roster.filter((row) => row.definition === 'target').flatMap((row) => row.sources),
      ...frozenEpoch1Registry.tables
        .filter((table) => canonicalSchemaJson(target.get(table.id)) !== canonicalSchemaJson(table))
        .map((table) => table.id),
    ].filter((name) => source.has(name)),
  )
  const violations: string[] = []
  for (const name of reshaped) {
    const columns = Object.values(source.get(name)!.columns)
      .map((column) => column.name)
      .sort()
    const entries = mapping[name] ?? {}
    if (JSON.stringify(Object.keys(entries).sort()) !== JSON.stringify(columns))
      violations.push(`source coverage: ${name}`)
    for (const [column, destination] of Object.entries(entries)) {
      if (
        !destination ||
        Array.isArray(destination) ||
        !['immutable', 'CAS-mutable', 'derived'].includes(destination.mutability)
      ) {
        violations.push(`one tagged destination: ${name}.${column}`)
        continue
      }
      if (destination.table === null) {
        if (
          !destination.conversion ||
          (name !== 'employee_os_writer_state' &&
            !['tasks.repo_count', 'committed_event_family_cutovers.mode'].includes(
              `${name}.${column}`,
            ))
        )
          violations.push(`undeclared derivation: ${name}.${column}`)
      } else if (
        !Object.values(target.get(destination.table)?.columns ?? {}).some(
          (c) => c.name === destination.column,
        )
      )
        violations.push(`unknown destination: ${name}.${column}`)
      if (destination.companion) {
        const [table, field] = destination.companion.split('.')
        if (!Object.values(target.get(table!)?.columns ?? {}).some((c) => c.name === field))
          violations.push(`unknown companion: ${name}.${column}`)
      }
    }
  }
  return violations
}
function activationCorpus(): SourceUnit[] {
  const units = packageSrcUnits(ROOT, 'backend')
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.[cm]?tsx?$/.test(entry.name))
        units.push(
          sourceUnit(relative(ROOT, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')),
        )
    }
  }
  for (const directory of ['packages/backend/tests', 'packages/backend/scripts', 'scripts', 'e2e'])
    walk(resolve(ROOT, directory))
  return units
}
describe('RFC-395 II-b R1 activated schema boundary', () => {
  test('the complete source, test and script corpus has one live registry and no retired accessor or registry', () => {
    const units = activationCorpus()
    expect(units.length).toBeGreaterThan(1000)
    expect(
      units.flatMap((unit) =>
        activationViolations(unit).map((reason) => `${unit.path}: ${reason}`),
      ),
    ).toEqual([])
    expect(
      units.find((unit) => unit.path.endsWith('/bootstrap/persistenceSchema.ts')),
    ).toBeDefined()
    expect(
      units.find((unit) => unit.path.endsWith('/bootstrap/targetPersistenceSchema.ts')),
    ).toBeUndefined()
    expect(
      units.some((unit) => /\/(?:composition|persistence)\/targetSchema\.ts$/.test(unit.path)),
    ).toBe(false)
    expect(
      units.find((unit) => unit.path.endsWith('/platform/persistence/schema/targetTables.ts')),
    ).toBeUndefined()
  })
  test('negative controls reject aliases, relative/dynamic imports, re-exports and retired accessors', () => {
    for (const [path, relative] of [
      ['packages/backend/src/modules/example/store.ts', '../../bootstrap/targetPersistenceSchema'],
      ['packages/backend/src/bootstrap/example.ts', './targetPersistenceSchema'],
    ] as const) {
      for (const source of [
        "import { targetPersistenceSchema as schema } from '@/bootstrap/targetPersistenceSchema'",
        `import type { targetPersistenceSchema } from '${relative}'`,
      ])
        expect(activationViolations(sourceUnit(path, source))).toEqual([
          'retired live symbol',
          'retired schema entry',
        ])
      for (const source of [
        "export * from '@/bootstrap/targetPersistenceSchema'",
        "const schema = import('@/bootstrap/targetPersistenceSchema')",
        "const schema = require('@/bootstrap/targetPersistenceSchema')",
        "export * from '@/modules/example/composition/targetSchema'",
      ])
        expect(activationViolations(sourceUnit(path, source))).toEqual(['retired schema entry'])
      for (const source of [
        "import { targetTablesOf as tables } from '@/platform/persistence/sessionTables'",
        "import type { TargetPersistenceTables } from '@/platform/persistence/sessionTables'",
        "import * as session from '@/platform/persistence/sessionTables'; session.targetTablesOf(db)",
        "session['targetTablesOf'](db)",
      ])
        expect(activationViolations(sourceUnit(path, source))).toEqual(['retired live symbol'])
      expect(
        activationViolations(
          sourceUnit(
            path,
            "import { tablesOf } from '@/platform/persistence/sessionTables'; tablesOf(db)",
          ),
        ),
      ).toEqual([])
    }
  })
  test('target roster is exact and negative controls reject omission, duplication and wrong ownership', () => {
    expect(roster.length).toBeGreaterThan(200)
    expect(rosterViolations(persistenceSchema.tables, roster)).toEqual([])
    expect(rosterViolations(persistenceSchema.tables, roster.slice(1))).not.toEqual([])
    expect(rosterViolations(persistenceSchema.tables, [...roster, roster[0]!])).toContain(
      'duplicate roster table',
    )
    expect(
      rosterViolations(
        persistenceSchema.tables,
        roster.map((row, i) => (i === 0 ? { ...row, owner: 'wrong' } : row)),
      ),
    ).not.toEqual([])
    expect(
      rosterViolations(persistenceSchema.tables, [
        ...roster,
        { table: 'unregistered', owner: 'wrong', sources: [] },
      ]),
    ).toContain('unregistered target: unregistered')
  })
  test('all reshaped source columns have exactly one tagged destination, including content and relations', () => {
    expect(destinationViolations(destinations)).toEqual([])
    const missing = structuredClone(destinations)
    delete (missing.clarify_rounds as Record<string, unknown>).answers_json
    expect(destinationViolations(missing)).toContain('source coverage: clarify_rounds')
    const retired = structuredClone(destinations)
    delete (retired.employee_os_writer_state as Record<string, unknown>).active_generation
    expect(destinationViolations(retired)).toContain('source coverage: employee_os_writer_state')
    const duplicate = structuredClone(destinations) as unknown as Record<
      string,
      Record<string, Destination>
    >
    duplicate.agents!.skills = [
      destinations.agents.skills,
      destinations.agents.skills,
    ] as unknown as Destination
    expect(destinationViolations(duplicate)).toContain('one tagged destination: agents.skills')
    const unknown = structuredClone(destinations)
    unknown.hosted_task_archive_entries.parts_json.column = 'parts_json'
    expect(destinationViolations(unknown)).toContain(
      'unknown destination: hosted_task_archive_entries.parts_json',
    )
    expect(
      roster.some(
        (row) => row.table.startsWith('migration_') || row.table === 'activation_receipts',
      ),
    ).toBe(false)
    expect(destinations.employee_os_writer_state).toBeDefined()
    expect(destinations.tasks.branch).toMatchObject({
      table: 'task_workspaces',
      column: 'task_branch',
    })
  })
})
