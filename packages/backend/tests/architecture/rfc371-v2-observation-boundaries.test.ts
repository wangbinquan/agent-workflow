// RFC-371 v2 §2 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// observation lives only in `modules/run-observability`. The platform layer
// keeps no observation business code (only the four frozen generators that
// replay the published PostgreSQL history), the module reads other contexts only
// through their public contracts, nothing else writes its tables, and no
// CrewStation vocabulary remains in the domain or the UI.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { importEdges, packageSrcUnits, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const backend = packageSrcUnits(REPO_ROOT, 'backend')
const frontend = packageSrcUnits(REPO_ROOT, 'frontend')
const shared = packageSrcUnits(REPO_ROOT, 'shared')
const MODULE = 'packages/backend/src/modules/run-observability/'

const FROZEN_GENERATORS = [
  'packages/backend/src/platform/persistence/observationProjectionChangeSchema.ts',
  'packages/backend/src/platform/persistence/observationProjectionRoutes.ts',
  'packages/backend/src/platform/persistence/observationSourceRevisionSchema.ts',
  'packages/backend/src/platform/persistence/retainedOutputRevisionSchema.ts',
]

function importers(units: readonly SourceUnit[], target: string): string[] {
  const stem = target.replace(/\.ts$/, '').split('/').pop()!
  return units
    .filter((unit) =>
      importEdges(unit).some((edge) => edge.specifier.replace(/\.ts$/, '').endsWith('/' + stem)),
    )
    .map((unit) => unit.path)
    .sort()
}

describe('RFC-371 v2 observation boundaries', () => {
  test('the scanned corpus is the whole source tree', () => {
    expect(backend.length).toBeGreaterThanOrEqual(1000)
    expect(frontend.length).toBeGreaterThanOrEqual(200)
  })

  test('the platform layer holds no observation code beyond the frozen history generators', () => {
    const platform = backend.filter((unit) =>
      unit.path.startsWith('packages/backend/src/platform/'),
    )
    expect(
      platform
        .filter((unit) =>
          /observ|nativeUsage|storageUsage|report(Build|Pages|Worker)/i.test(unit.path),
        )
        .map((unit) => unit.path)
        .sort(),
    ).toEqual(FROZEN_GENERATORS.filter((path) => path.includes('observation')).sort())
    for (const path of FROZEN_GENERATORS) {
      const unit = backend.find((candidate) => candidate.path === path)!
      expect(unit.text.slice(0, 400), path).toContain('FROZEN HISTORY')
    }
  })

  test('frozen generators are reached only by the PostgreSQL migration machinery', () => {
    const allowed = new Set([
      ...FROZEN_GENERATORS,
      'packages/backend/src/platform/persistence/postgresqlMigrationHistory.ts',
      'packages/backend/src/platform/persistence/postgresqlMigrationSequence.ts',
      'packages/backend/src/platform/persistence/schema/postgresqlPlan.ts',
      'packages/backend/src/platform/persistence/schema/contractTypes.ts',
    ])
    for (const generator of FROZEN_GENERATORS)
      for (const importer of importers(backend, generator))
        expect(allowed.has(importer), `${importer} imports ${generator}`).toBe(true)
  })

  test('run observation depends on other contexts only through their public contracts', () => {
    const allowed = new Set([
      '@agent-workflow/shared',
      '@/auth/actor',
      '@/platform/persistence/persistenceDb',
      '@/platform/persistence/sessionTables',
      '@/platform/persistence/queryHelpers',
      '@/platform/persistence/singleInsert',
      '@/platform/persistence/schema/dsl',
      '@/platform/persistence/schema/drizzle',
      '@/platform/persistence/databaseTransaction',
      '@/routes/registry',
      '@/util/errors',
      '@/modules/runtime-management/public/queries',
      'drizzle-orm',
      'hono',
      'ulid',
      'zod',
    ])
    const units = backend.filter((unit) => unit.path.startsWith(MODULE))
    expect(units.length).toBeGreaterThan(0)
    const outside = units.flatMap((unit) =>
      importEdges(unit)
        .map((edge) => edge.specifier)
        .filter((specifier) => !specifier.startsWith('.') && !allowed.has(specifier))
        .map((specifier) => `${unit.path} -> ${specifier}`),
    )
    expect(outside).toEqual([])
  })

  test('only run observation imports the observation tables', () => {
    const tables = new Set(['observationCalls', 'observationCallModels', 'observationPrices'])
    const importsTables = (unit: SourceUnit) =>
      unit.source.statements.some(
        (statement) =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          /^@\/db\/(schema|observation)$/.test(statement.moduleSpecifier.text) &&
          statement.importClause?.namedBindings !== undefined &&
          ts.isNamedImports(statement.importClause.namedBindings) &&
          statement.importClause.namedBindings.elements.some((element) =>
            tables.has((element.propertyName ?? element.name).text),
          ),
      )
    const accessesSessionTables = (unit: SourceUnit): boolean => {
      let found = false
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'tablesOf'
        ) {
          found ||= node.name.elements.some((element) =>
            tables.has((element.propertyName ?? element.name).getText(unit.source)),
          )
        }
        ts.forEachChild(node, visit)
      }
      visit(unit.source)
      return found
    }
    const importers = backend
      .filter((unit) => importsTables(unit) || accessesSessionTables(unit))
      .map((unit) => unit.path)
    expect(importers.length).toBeGreaterThan(0)
    expect(importers.filter((path) => !path.startsWith(MODULE))).toEqual([])
  })

  test('no CrewStation vocabulary remains in observation, runtimes or the UI', () => {
    const scoped = [...backend, ...frontend, ...shared].filter(
      (unit) =>
        unit.path.startsWith(MODULE) ||
        unit.path.startsWith('packages/backend/src/services/runtime/') ||
        unit.path.startsWith('packages/shared/src/schemas/observation') ||
        /packages\/frontend\/src\/.*observ/i.test(unit.path),
    )
    expect(
      scoped.filter((unit) => /crewstation/i.test(unit.text)).map((unit) => unit.path),
    ).toEqual([])
  })
})
