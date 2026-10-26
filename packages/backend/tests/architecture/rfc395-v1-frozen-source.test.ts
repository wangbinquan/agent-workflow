// RFC-395 II-b V1: freeze parity until activation and prohibit runtime imports; includes negative controls.
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, posix, join } from 'node:path'
import ts from 'typescript'
import {
  buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract,
  assertFrozenEpoch1Contract,
  frozenEpoch1Contract,
  frozenEpoch1ExplicitContract,
  epoch1GuardMode,
} from '@/platform/persistence/migration/epoch1/contract'
import { frozenEpoch1Registry as persistenceSchema } from '@/platform/persistence/migration/epoch1/definitions'
import targetRoster from '@/bootstrap/targetSchemaRoster.json'
import { compileContract } from '@/platform/persistence/schema/contract'
import { column } from '@/platform/persistence/schema/dsl'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { projectLegacyV2 } from '@/platform/persistence/migration/legacy/v2Contract'

import frozenDispositions from '@/platform/persistence/migration/epoch1/tableDispositions.json'
import frozenProvenance from '@/platform/persistence/migration/epoch1/provenance.json'
import {
  loadFrozenEpoch1History,
  resolveFrozenEpoch1Folders,
  verifyFrozenEpoch1Files,
  epoch1MaintenanceInstruction as maintenance,
} from '@/platform/persistence/migration/epoch1/bundle'
import { LEGACY_MIGRATION_HASHES as frozenAliases } from '@/platform/persistence/migration/epoch1/journalAliases'
import { LEGACY_MIGRATION_HASHES as liveAliases } from '@/db/schemaAdmission'
import { sha256Hex } from '@/util/hash'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const root = resolve(import.meta.dir, '../../../..')
const migration = 'platform/persistence/migration/'
// V3's epoch switch is the migration runner itself; its dormancy guard keeps runtime away from it.
const epochSwitch =
  /^(?:bootstrap\/epochMigration(?:Hosted)?(?:Entry)?\.ts|cli\/epochMigration\.ts|modules\/system-operations\/(?:application|infrastructure)\/epochSwitch\/|modules\/system-operations\/application\/ports\/epochSwitch\.ts)/
function violations(unit: SourceUnit): string[] {
  const path = unit.path.replace(/^packages\/backend\/src\//, '')
  if (
    path.startsWith(migration) ||
    path.includes('/infrastructure/migration/') ||
    epochSwitch.test(path)
  )
    return []
  const result: string[] = []
  const check = (specifier: string) => {
    const target = specifier.startsWith('@/')
      ? specifier.slice(2)
      : posix.normalize(posix.join(posix.dirname(path), specifier))
    if (
      target.startsWith(`${migration}epoch1/`) ||
      (target.startsWith(`${migration}legacy/`) && !target.endsWith('/v2Contract')) ||
      new RegExp(
        `^${migration}(?:sourceTypes|sourceCatalog|supportedSources|sourceDispositions|sourceReader|sqliteSourceReader|artifactSourceReader|offlineSourceUpgrade|rawSourceReader|postgresqlSourceReader|postgresqlSourceExport|auditSourceEvidence|sourceDispositionEvidence)(?:\\.ts)?$`,
      ).test(target)
    )
      result.push(`${path} -> ${target}`)
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      check(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return result
}
describe('RFC-395 V1 frozen source guard', () => {
  test('frozen epoch-1 digest, declarations and supported source history remain pinned after activation', async () => {
    expect(epoch1GuardMode).toBe('frozen-only')
    {
      expect(
        () => assertFrozenEpoch1Contract(buildLogicalSchemaContract()),
        maintenance,
      ).not.toThrow()
      expect(frozenEpoch1ExplicitContract.digest, maintenance).toBe(
        compileContract(persistenceSchema).digest,
      )
      expect(
        () => assertFrozenEpoch1Contract({ digest: 'sha256:changed-column' }),
        maintenance,
      ).toThrow('frozen epoch-1 contract changed')
      const first = persistenceSchema.tables[0]!.id
      const changed = createSchemaRegistry(
        persistenceSchema.contributions.map((contribution) => ({
          ...contribution,
          tables: contribution.tables.map((table) =>
            table.id === first
              ? {
                  ...table,
                  columns: {
                    ...table.columns,
                    negativeColumn: column.text('negative_column', { nullable: true }),
                  },
                }
              : table,
          ),
        })),
      )
      expect(() => assertFrozenEpoch1Contract(projectLegacyV2(changed)), maintenance).toThrow(
        'supported-source manifest together',
      )
      expect(frozenAliases, maintenance).toEqual(liveAliases)
      for (const [path, digest] of Object.entries(frozenProvenance.frozenDeclarations))
        expect(
          sha256Hex(readFileSync(resolve(root, 'packages/backend/src', path))),
          maintenance,
        ).toBe(digest)
    }
    const folders = await resolveFrozenEpoch1Folders()
    expect(() => verifyFrozenEpoch1Files(folders), maintenance).not.toThrow()
    expect(frozenEpoch1Contract.digest, maintenance).toBe(frozenProvenance.legacyContractDigest)
    expect(frozenEpoch1ExplicitContract.digest, maintenance).toBe(
      frozenProvenance.explicitContractDigest,
    )
    const history = await loadFrozenEpoch1History()
    expect(history.postgresql.head.contract.digest, maintenance).toBe(frozenEpoch1Contract.digest)
    // Released permission JSON defect; user chose to advance epoch 1 before activation.
    expect(history.postgresql.steps.at(-1)?.id, maintenance).toBe('0038_epoch1_permission_text')
    expect(history.postgresql.versions, maintenance).toHaveLength(39)
    expect(history.sqliteTags.at(-1), maintenance).toBe('0262_epoch1_permission_text')
    expect(history.sqlite, maintenance).toHaveLength(262)
    const permissionCodec = (contract: typeof frozenEpoch1Contract) =>
      contract.tables
        .find((table) => table.id === 'user_permission_grants')!
        .columns.find((column) => column.name === 'permission')!.logicalCodec
    expect(permissionCodec(frozenEpoch1Contract), maintenance).toBe('text-identity')
    expect(permissionCodec(history.postgresql.versions.at(-2)!.contract), maintenance).toBe(
      'json-text',
    )
  })
  test('resolved SQL bytes and file set are checked even after activation, with changed/missing/extra negative fixtures', async () => {
    const original = await resolveFrozenEpoch1Folders()
    const root = mkdtempSync(join(tmpdir(), 'v1-provenance-'))
    const folders = { sqlite: join(root, 'sqlite'), postgresql: join(root, 'postgresql') }
    try {
      cpSync(original.sqlite, folders.sqlite, { recursive: true })
      cpSync(original.postgresql, folders.postgresql, { recursive: true })
      const file = Object.keys(frozenProvenance.migrationFiles).find(
        (path) => path.startsWith('sqlite/') && path.endsWith('.sql'),
      )!
      const path = join(root, file)
      const bytes = readFileSync(path)
      writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n')]))
      expect(() => verifyFrozenEpoch1Files(folders), maintenance).toThrow('migration §3')
      writeFileSync(path, bytes)
      rmSync(path)
      expect(() => verifyFrozenEpoch1Files(folders), maintenance).toThrow('migration §3')
      writeFileSync(path, bytes)
      writeFileSync(join(folders.sqlite, 'unknown.sql'), 'SELECT 1;')
      expect(() => verifyFrozenEpoch1Files(folders), maintenance).toThrow('migration §3')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('all 222 source tables have exactly one decision and exact business or migration-record destinations', () => {
    const names = frozenEpoch1Contract.tables.map((table) => table.id).sort()
    expect(names, maintenance).toHaveLength(222)
    expect(frozenDispositions.map((table) => table.table).sort(), maintenance).toEqual(names)
    expect(new Set(frozenDispositions.map((table) => table.table)).size, maintenance).toBe(
      names.length,
    )
    const clarifyTargets = [
      'clarify_answer_attributions',
      'clarify_answer_drafts',
      'clarify_answers',
      'clarify_rounds',
    ]
    expect(
      frozenDispositions.find((table) => table.table === 'clarify_rounds'),
      maintenance,
    ).toMatchObject({
      disposition: 'converted',
      targets: clarifyTargets,
      destination: { kind: 'business', tables: clarifyTargets },
    })
    for (const table of frozenDispositions) {
      const targets = targetRoster.filter((target) => target.sources.includes(table.table))
      if (table.destination.kind === 'migration-records') {
        expect(table.table, maintenance).toBe('employee_os_writer_state')
        expect(table.disposition, maintenance).toBe('metadata')
        expect(table.destination.records, maintenance).toEqual(['activation'])
        expect(table.targets, maintenance).toEqual([])
        expect(targets, maintenance).toEqual([])
      } else if (table.destination.kind === 'archive') {
        // The retired code-work tables become the versioned code-history packages (design §9).
        const history = ['code_history_archives', 'code_history_id_index']
        expect(table.disposition, maintenance).toBe('archived')
        expect(table.targets, maintenance).toEqual(history)
        expect(targets.map((target) => target.table).sort(), maintenance).toEqual(history)
      } else {
        expect(table.targets, maintenance).toEqual(targets.map((target) => target.table).sort())
        expect(table.destination.tables, maintenance).toEqual(table.targets)
        expect(targets.length, maintenance).toBeGreaterThan(0)
        expect(table.disposition, maintenance).toBe(
          targets.every((target) => target.definition === 'reused') &&
            ![
              'task_space_nodes',
              'node_run_seq_allocations',
              'resource_grants',
              'intent_apply_journal',
              'resource_bundle_applies',
            ].includes(table.table)
            ? 'preserved'
            : 'converted',
        )
      }
    }
  })
  test('frozen readers use isolated epoch-1 formats, not mutable runtime paths', () => {
    const units = packageSrcUnits(root, 'backend').filter((unit) =>
      unit.path.startsWith(`packages/backend/src/${migration}`),
    )
    const mutable = (unit: SourceUnit) =>
      unit.source.statements.some((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          return false
        const specifier = statement.moduleSpecifier.text
        const target = specifier.startsWith('@/')
          ? 'packages/backend/src/' + specifier.slice(2)
          : posix.normalize(posix.join(posix.dirname(unit.path), specifier))
        return /^packages\/backend\/src\/platform\/persistence\/(?:logicalDatabase(?:Artifact|Export|Restore)|sqliteLogicalSource|postgresql(?:Migrator|MigrationHistory|MigrationSequence|LogicalTarget)|sqliteMigrator|sqlite\/systemBackupManifest)(?:\.ts)?$/.test(
          target,
        )
      })
    expect(
      units.filter(mutable).map((unit) => unit.path),
      maintenance,
    ).toEqual([])
    const probe = 'packages/backend/src/platform/persistence/migration/legacy/scripts/probe.ts'
    expect(mutable(sourceUnit(probe, "import '../postgresqlMigrationSequence'"))).toBe(false)
    expect(mutable(sourceUnit(probe, "import '../../../postgresqlMigrationSequence'"))).toBe(true)
    expect(
      mutable(sourceUnit(probe, "import '@/platform/persistence/postgresqlLogicalTarget'")),
    ).toBe(true)
    expect(
      units.filter((unit) => /migrationRole/.test(unit.text)).map((unit) => unit.path),
      maintenance,
    ).toEqual([])
  })
  test('no production consumer outside migration can import frozen schemas or activate V1', () => {
    const units = packageSrcUnits(root, 'backend')
    expect(units.length).toBeGreaterThan(1000)
    expect(units.flatMap(violations)).toEqual([])
    for (const statement of [
      "import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'",
      "export * from '@/platform/persistence/migration/epoch1/definitions'",
      "const reader = await import('@/platform/persistence/migration/sqliteSourceReader')",
    ])
      expect(
        violations(sourceUnit('packages/backend/src/bootstrap/negative.ts', statement)),
      ).toHaveLength(1)
    expect(
      violations(
        sourceUnit(
          'packages/backend/src/platform/persistence/migration/negative.ts',
          "import { frozenEpoch1Contract } from './epoch1/contract'",
        ),
      ),
    ).toEqual([])
    const sourceTypes =
      "import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'"
    for (const path of [
      'bootstrap/epochMigration.ts',
      'cli/epochMigration.ts',
      'modules/system-operations/application/epochSwitch/runner.ts',
      'modules/system-operations/application/ports/epochSwitch.ts',
    ])
      expect(violations(sourceUnit(`packages/backend/src/${path}`, sourceTypes))).toEqual([])
    for (const path of [
      'bootstrap/daemonApplication.ts',
      'modules/system-operations/application/maintenance.ts',
      'modules/system-operations/infrastructure/epochSwitchLike.ts',
    ])
      expect(violations(sourceUnit(`packages/backend/src/${path}`, sourceTypes))).toHaveLength(1)
  })
})
