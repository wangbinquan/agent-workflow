import {
  executableReachability,
  EPOCH2_RUNTIME_ENTRIES,
} from '../helpers/epochMigrationReachability'
// RFC-395 AD-7/BF-D2: conversion stays offline; boot recovery uses only durable pointer/journal mechanics.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'
import { BACKEND_PREFIX } from './rfc294Gates'

const runtimeRecovery = new Set(
  ['fileJournal', 'pointerReplacement', 'sourceRetention', 'bootAdmission'].map(
    (name) => BACKEND_PREFIX + `modules/system-operations/infrastructure/epochSwitch/${name}.ts`,
  ),
)

// PGX-B: restore and provider moves borrow the migration connection policy.
// Only that named import is shared with runtime; scratch/target provisioning stays offline.
const runtimeConnection =
  BACKEND_PREFIX + 'platform/persistence/migration/freeze/postgresqlDatabases.ts'
const runtimeMechanisms = new Set([...runtimeRecovery, runtimeConnection])

function isV3(path: string): boolean {
  return (
    /\/platform\/persistence\/migration\/(run|target|freeze)\//.test(path) ||
    /\/platform\/content\/inventory\//.test(path) ||
    /\/modules\/system-operations\/(application|infrastructure)\/epochSwitch\//.test(path) ||
    /\/modules\/system-operations\/(application\/ports\/epochSwitch|public\/epochSwitch|infrastructure\/local\/epochSwitchQuiesce)\.ts$/.test(
      path,
    ) ||
    /\/bootstrap\/epochMigration[^/]*\.ts$/.test(path) ||
    path.endsWith('/cli/epochMigration.ts')
  )
}
function violations(
  units: readonly SourceUnit[],
  entries: readonly string[] = EPOCH2_RUNTIME_ENTRIES,
): string[] {
  const { corpus, reachable } = executableReachability(units, entries)
  const out = corpus.edges
    .filter(
      (edge) =>
        isV3(edge.from.path) &&
        edge.from.path.includes('/platform/') &&
        edge.target.startsWith(BACKEND_PREFIX + 'modules/'),
    )
    .map((edge) => `platform-to-module: ${edge.from.path} -> ${edge.target}`)
  for (const unit of corpus.backend)
    if (isV3(unit.path) && !runtimeMechanisms.has(unit.path) && reachable.has(unit.path))
      out.push(`runtime-reaches-v3: ${unit.path}`)
  for (const edge of corpus.edges.filter(
    (edge) =>
      edge.target === runtimeConnection && edge.kind === 'value' && reachable.has(edge.from.path),
  )) {
    const imports = edge.from.source.statements.filter(
      (node) =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === edge.specifier,
    )
    const connectionOnly =
      edge.syntax === 'static-import' &&
      imports.length > 0 &&
      imports.every((node) => {
        if (!ts.isImportDeclaration(node) || !node.importClause || node.importClause.name)
          return false
        const bindings = node.importClause.namedBindings
        return (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.every(
            (binding) =>
              binding.isTypeOnly ||
              (binding.propertyName ?? binding.name).text === 'migrationPostgresqlRuntime',
          )
        )
      })
    if (!connectionOnly)
      out.push(`runtime-v3-connection-import: ${edge.from.path} -> ${edge.target}`)
  }
  return out.sort()
}
const destinations = [
  'platform/persistence/migration/run/types.ts',
  'platform/persistence/migration/target/install.ts',
  'platform/persistence/migration/freeze/sourceAccess.ts',
  'platform/content/inventory/manifest.ts',
  'modules/system-operations/application/epochSwitch/runner.ts',
  'modules/system-operations/infrastructure/epochSwitch/metaStore.ts',
  'modules/system-operations/application/ports/epochSwitch.ts',
  'modules/system-operations/public/epochSwitch.ts',
  'modules/system-operations/infrastructure/local/epochSwitchQuiesce.ts',
  'bootstrap/epochMigration.ts',
  'bootstrap/epochMigrationHosted.ts',
  'cli/epochMigration.ts',
] as const
describe('RFC-395 V3 migration entry boundary', () => {
  test('daemon and maintenance reach reviewed recovery and connection mechanics, never the V3 runner', () => {
    const units = packageSrcUnits(resolve(import.meta.dir, '../../../..'), 'backend')
    expect(units.length).toBeGreaterThan(1000)
    expect(units.filter((unit) => isV3(unit.path)).length).toBeGreaterThanOrEqual(6)
    expect(violations(units)).toEqual([])
    const reachable = executableReachability(units, EPOCH2_RUNTIME_ENTRIES).reachable
    expect([...runtimeMechanisms].filter((path) => reachable.has(path)).sort()).toEqual(
      [...runtimeMechanisms].sort(),
    )
  })
  test('recovery mechanics cannot hide a transitive converter or a copied recovery file', () => {
    for (const target of [
      BACKEND_PREFIX + 'modules/system-operations/application/epochSwitch/runner.ts',
      BACKEND_PREFIX + 'modules/system-operations/infrastructure/epochSwitch/copiedJournal.ts',
    ]) {
      for (const recovery of runtimeMechanisms)
        expect(
          violations(
            [
              sourceUnit(
                BACKEND_PREFIX + 'main.ts',
                `import '@/${recovery.slice(BACKEND_PREFIX.length)}'`,
              ),
              sourceUnit(recovery, `import '@/${target.slice(BACKEND_PREFIX.length)}'`),
              sourceUnit(target, 'export const value = 1'),
            ],
            [BACKEND_PREFIX + 'main.ts'],
          ),
        ).toContain(`runtime-reaches-v3: ${target}`)
    }
  })
  test('runtime connection imports cannot expose scratch or target provisioning', () => {
    const entry = BACKEND_PREFIX + 'main.ts'
    const check = (text: string) =>
      violations(
        [sourceUnit(entry, text), sourceUnit(runtimeConnection, 'export const value = 1')],
        [entry],
      )
    expect(
      check(
        `import { migrationPostgresqlRuntime as runtime } from '@/${runtimeConnection.slice(BACKEND_PREFIX.length)}'`,
      ),
    ).toEqual([])
    for (const shape of [
      'import { openPostgresqlScratch } from',
      'import { migrationPostgresqlRuntime, preparePostgresqlScratch } from',
      'import * as scratch from',
      'export * from',
    ])
      expect(check(`${shape} '@/${runtimeConnection.slice(BACKEND_PREFIX.length)}'`)).toContain(
        `runtime-v3-connection-import: ${entry} -> ${runtimeConnection}`,
      )
    for (const call of ['import', 'require'])
      expect(
        check(`const scratch = ${call}('@/${runtimeConnection.slice(BACKEND_PREFIX.length)}')`),
      ).toContain(`runtime-v3-connection-import: ${entry} -> ${runtimeConnection}`)
  })
  test('negative direct imports, re-exports, dynamic imports and require reach every V3 surface', () => {
    for (const destination of destinations)
      for (const text of [
        `import '@/${destination}'`,
        `export * from '@/${destination}'`,
        `const value=import('@/${destination}')`,
        `const value=require('./${destination}')`,
      ])
        expect(
          violations(
            [
              sourceUnit(BACKEND_PREFIX + 'main.ts', text),
              sourceUnit(BACKEND_PREFIX + destination, 'export const value=1'),
            ],
            [BACKEND_PREFIX + 'main.ts'],
          ),
        ).toContain(`runtime-reaches-v3: ${BACKEND_PREFIX + destination}`)
  })
  test('negative transitive CLI and bootstrap paths cannot load switch code', () => {
    for (const destination of destinations) {
      const units = [
        sourceUnit(BACKEND_PREFIX + 'main.ts', "import './cli/database'"),
        sourceUnit(BACKEND_PREFIX + 'cli/database.ts', "export * from '../bootstrap/runtime'"),
        sourceUnit(
          BACKEND_PREFIX + 'bootstrap/runtime.ts',
          `const lazy=import('@/${destination}')`,
        ),
        sourceUnit(BACKEND_PREFIX + destination, 'export const value=1'),
      ]
      expect(violations(units, [BACKEND_PREFIX + 'main.ts'])).toContain(
        `runtime-reaches-v3: ${BACKEND_PREFIX + destination}`,
      )
    }
  })
  test('negative platform-to-module edges include type-only and relative imports in all mechanisms', () => {
    const target = BACKEND_PREFIX + 'modules/system-operations/domain/epochSwitch/model.ts'
    for (const destination of destinations.filter((path) => path.startsWith('platform/'))) {
      const relative = destination.startsWith('platform/content/') ? '../../../' : '../../../../'
      for (const text of [
        "import type { Fact } from '@/modules/system-operations/domain/epochSwitch/model'",
        "export * from '@/modules/system-operations/domain/epochSwitch/model'",
        "const p=import('@/modules/system-operations/domain/epochSwitch/model')",
        `const p=require('${relative}modules/system-operations/domain/epochSwitch/model')`,
      ])
        expect(
          violations(
            [
              sourceUnit(BACKEND_PREFIX + 'main.ts', ''),
              sourceUnit(BACKEND_PREFIX + destination, text),
              sourceUnit(target, 'export type Fact=string'),
            ],
            [BACKEND_PREFIX + 'main.ts'],
          ),
        ).toContain(`platform-to-module: ${BACKEND_PREFIX + destination} -> ${target}`)
    }
  })
})

test('CLI converter is executable while content codecs and stores are runtime', () => {
  const units = packageSrcUnits(resolve(import.meta.dir, '../../../..'), 'backend')
  const runtime = executableReachability(units, EPOCH2_RUNTIME_ENTRIES).reachable
  expect(runtime.has(BACKEND_PREFIX + 'platform/content/contentRefCodec.ts')).toBe(true)
  expect(runtime.has(BACKEND_PREFIX + 'platform/content/contentStore.ts')).toBe(true)
  const cli = executableReachability(units, [
    BACKEND_PREFIX + 'bootstrap/epochMigrationEntry.ts',
  ]).reachable
  expect(cli.has(BACKEND_PREFIX + 'platform/persistence/migration/conversion/engine.ts')).toBe(true)
  expect(
    cli.has(BACKEND_PREFIX + 'modules/system-operations/application/epochSwitch/runner.ts'),
  ).toBe(true)
})

// AF-D18: deployment profiles execute before daemonStart and must be traversed.
test('both deployment profile roots reject transitive migration imports', () => {
  for (const root of ['bootstrap/standalone.ts', 'bootstrap/crewstation.ts']) {
    expect(EPOCH2_RUNTIME_ENTRIES).toContain(BACKEND_PREFIX + root)
    const target = BACKEND_PREFIX + 'modules/system-operations/application/epochSwitch/runner.ts'
    const units = EPOCH2_RUNTIME_ENTRIES.map((entry) =>
      sourceUnit(entry, entry === BACKEND_PREFIX + root ? "export * from './profileChild'" : ''),
    )
    units.push(
      sourceUnit(
        BACKEND_PREFIX + 'bootstrap/profileChild.ts',
        "const module = import('@/modules/system-operations/application/epochSwitch/runner.ts')",
      ),
      sourceUnit(target, 'export const value = 1'),
    )
    expect(violations(units)).toContain(`runtime-reaches-v3: ${target}`)
  }
})
