// RFC-371: native projection belongs to a complete additive KEEP relation;
// old contracts, projected statements and published migration bytes stay intact.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import {
  buildLogicalSchemaContract,
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import { retainedOutputRevisionStatements } from '@/platform/persistence/retainedOutputRevisionSchema'

test('the original V2 whole KEEP addition replays native objects without modifying any historical table or statement', async () => {
  const history = await loadPostgresqlMigrationHistory()
  const previous = history.versions.at(-2)!,
    current = history.head
  const step = history.steps.at(-1)!
  expect(step.id).toBe('0017_rfc371_retained_output_revision')
  expect(step.version).toBe(2)
  expect(current.contract.activeTableCount).toBe(previous.contract.activeTableCount + 1)
  expect(
    current.contract.tables
      .filter((table) => table.nativeProjection !== undefined)
      .map((table) => table.id),
  ).toEqual(['observation_report_retained_revisions'])
  for (const table of previous.contract.tables)
    expect(
      canonicalSchemaJson(current.contract.tables.find((candidate) => candidate.id === table.id)),
    ).toBe(canonicalSchemaJson(table))
  for (const statement of previous.plan.statements) {
    if (statement.logicalId === 'contract-row' && statement.kind === 'metadata') continue
    expect(
      current.plan.statements.find(
        (candidate) =>
          candidate.kind === statement.kind && candidate.logicalId === statement.logicalId,
      ),
    ).toEqual(statement)
  }
  expect(step.sqliteMigration.appended.map((entry) => entry.tag)).toEqual([
    '0241_rfc371_retained_output_revision',
  ])
  const projected = buildPostgresqlSchemaPlan(current.contract)
  expect(projected).toEqual(current.plan)
  const functions = projected.statements.filter((statement) => statement.kind === 'function')
  const triggers = projected.statements.filter((statement) => statement.kind === 'trigger')
  expect(functions).toHaveLength(3)
  expect(triggers).toHaveLength(12)
  for (const statement of functions) {
    expect(statement.sql).toContain('ORDER BY p."id" FOR UPDATE OF p')
    expect(statement.sql).toContain('gen_random_uuid()::text')
    expect(statement.sql).not.toContain('LIMIT')
  }
  expect(functions.find((statement) => statement.logicalId.endsWith(':update'))!.sql).toContain(
    'SELECT "report_id" FROM aw_old_rows UNION SELECT "report_id" FROM aw_new_rows',
  )
  for (const statement of triggers) expect(statement.sql).toContain('FOR EACH STATEMENT')
}, 60_000)

test('the SQLite appended migration contains precisely the generated twelve row triggers and same-parent UPDATE marks once', () => {
  const statements = retainedOutputRevisionStatements(buildLogicalSchemaContract()).sqlite
  expect(statements).toHaveLength(12)
  const migration = readFileSync(
    resolve(import.meta.dir, '../db/migrations/0241_rfc371_retained_output_revision.sql'),
    'utf8',
  )
  expect(
    migration.split('\n--> statement-breakpoint\n').slice(1).join('\n--> statement-breakpoint\n'),
  ).toBe(statements.map((statement) => statement + ';').join('\n--> statement-breakpoint\n') + '\n')
  for (const statement of statements.filter((statement) => statement.includes('AFTER UPDATE'))) {
    expect(statement).toContain('NEW."report_id" <> OLD."report_id"')
    expect(statement).toContain('lower(hex(randomblob(16)))')
  }
})

test('the one common operation keeps every historical descriptor-free contract empty', async () => {
  const history = await loadPostgresqlMigrationHistory()
  for (const version of history.versions.filter((version) =>
    version.contract.tables.every((table) => table.nativeProjection === undefined),
  ))
    expect(retainedOutputRevisionStatements(version.contract)).toEqual({
      sqlite: [],
      postgresql: [],
    })
}, 60_000)

test('the common operation rejects an unsupported or duplicated native descriptor', () => {
  const contract = buildLogicalSchemaContract()
  const invalid: LogicalSchemaContract = JSON.parse(canonicalSchemaJson(contract))
  const revision = invalid.tables.find((table) => table.nativeProjection !== undefined)!
  Reflect.set(revision.nativeProjection!, 'revisionColumn', 'unsupported-column')
  expect(() => retainedOutputRevisionStatements(invalid)).toThrow(
    'Unsupported retained-output-revision schema projection',
  )
  expect(() =>
    retainedOutputRevisionStatements({
      ...contract,
      tables: [
        ...contract.tables,
        ...contract.tables.filter((table) => table.nativeProjection !== undefined),
      ],
    }),
  ).toThrow('Unsupported retained-output-revision schema projection')
})
