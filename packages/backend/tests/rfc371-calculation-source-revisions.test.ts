// RFC-371: every approved source has transactional I/U/D revisions. These real
// engines exercise the generated trigger bodies against isolated probe relations;
// production schema identity, provider mappings and immutable history are checked separately.
// Canonical contract JSON orders keys independently of the authored descriptor;
// equivalent descriptors must retain the exact original SQL on both providers.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import {
  buildLogicalSchemaContract,
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import {
  OBSERVATION_SOURCE_REVISION,
  observationSourceRevisionStatements,
} from '@/platform/persistence/observationSourceRevisionSchema'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { describeEachProvider } from './helpers/eachProvider'

test('canonical JSON key order preserves the exact source revision projection, while material descriptor changes remain rejected', () => {
  const original = buildLogicalSchemaContract()
  const roundTrip: LogicalSchemaContract = JSON.parse(canonicalSchemaJson(original))
  expect(observationSourceRevisionStatements(roundTrip)).toEqual(
    observationSourceRevisionStatements(original),
  )
  for (const mutate of [
    (projection: Record<string, unknown>) => Reflect.set(projection, 'kind', 'other'),
    (projection: Record<string, unknown>) => Reflect.set(projection, 'sourceColumn', 'other'),
    (projection: Record<string, unknown>) => Reflect.set(projection, 'revisionColumn', 'other'),
    (projection: Record<string, unknown>) =>
      Reflect.set(projection, 'sources', [...OBSERVATION_SOURCE_REVISION.sources].reverse()),
    (projection: Record<string, unknown>) => Reflect.set(projection, 'extra', true),
  ]) {
    const changed: LogicalSchemaContract = JSON.parse(canonicalSchemaJson(original))
    const projection = changed.tables.find(
      (table) => table.id === 'observation_source_revisions',
    )!.sourceRevisionProjection!
    mutate(projection as unknown as Record<string, unknown>)
    expect(() => observationSourceRevisionStatements(changed)).toThrow(
      'Unsupported observation-source-revision schema projection',
    )
  }
})

test('all 55 approved source identities and physical provider mappings are registered, with no derived self-invalidation', () => {
  const approved = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dir,
        '../../..',
        'design/RFC-371-run-observability/persistent-calculation-sources-20261012.json',
      ),
      'utf8',
    ),
  ) as {
    sources: { sourceId: string; providerTables: { sqlite: string; postgresql: string } }[]
  }
  const contract = buildLogicalSchemaContract()
  expect<string[]>([...OBSERVATION_SOURCE_REVISION.sources]).toEqual(
    approved.sources.map((item) => item.sourceId),
  )
  expect(approved.sources).toHaveLength(55)
  for (const source of approved.sources) {
    const actual = contract.tables.find((table) => table.id === source.sourceId)!
    expect(actual.disposition).toBe('KEEP')
    expect(actual.providerTables).toEqual(source.providerTables)
  }
  const projected = observationSourceRevisionStatements(contract)
  expect(projected.sqlite).toHaveLength(166)
  expect(projected.postgresql).toHaveLength(331)
  expect(
    new Set(projected.postgresql.map((statement) => statement.kind + ':' + statement.logicalId))
      .size,
  ).toBe(331)
  for (const statement of projected.postgresql.filter(
    (statement) => statement.kind === 'trigger',
  )) {
    expect(statement.sql).toContain('FOR EACH STATEMENT')
    const name = statement.sql.match(/^CREATE TRIGGER "([^"]+)"/)![1]!
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63)
  }
  for (const name of [
    'observation_reports',
    'observation_report_rows',
    'observation_report_counts',
    'observation_report_retained_revisions',
    'observation_native_fact_roots',
    'observation_native_fact_pages',
    'observation_calculation_versions',
    'observation_calculation_rows',
    'observation_source_revisions',
  ])
    expect(new Set<string>(OBSERVATION_SOURCE_REVISION.sources).has(name)).toBe(false)
  const migration = readFileSync(
    resolve(import.meta.dir, '../db/migrations/0245_rfc371_observation_calculations.sql'),
    'utf8',
  )
  expect(
    migration
      .split('\n--> statement-breakpoint\n')
      .slice(-166)
      .join('\n--> statement-breakpoint\n'),
  ).toBe(
    projected.sqlite.map((statement) => statement + ';').join('\n--> statement-breakpoint\n') +
      '\n',
  )
})

test('the additive history preserves every old table/native descriptor and statement; old contracts have no source projection', async () => {
  const history = await loadPostgresqlMigrationHistory()
  const step = history.steps.find((step) => step.id === '0021_rfc371_observation_calculations')!
  expect(step).toBeDefined()
  const previous = history.versions.find(
    (version) => version.contract.digest === step.from.contractDigest,
  )!
  const current = history.versions.find(
    (version) => version.contract.digest === step.to.contractDigest,
  )!
  expect(current.contract.activeTableCount).toBe(previous.contract.activeTableCount + 3)
  for (const table of previous.contract.tables)
    expect(
      canonicalSchemaJson(current.contract.tables.find((candidate) => candidate.id === table.id)),
    ).toBe(canonicalSchemaJson(table))
  for (const statement of previous.plan.statements) {
    if (statement.kind === 'metadata' && statement.logicalId === 'contract-row') continue
    expect(
      current.plan.statements.find(
        (candidate) =>
          candidate.kind === statement.kind && candidate.logicalId === statement.logicalId,
      ),
    ).toEqual(statement)
  }
  expect(buildPostgresqlSchemaPlan(current.contract)).toEqual(current.plan)
  expect(step.sqliteMigration.appended.map((entry) => entry.tag)).toEqual([
    '0245_rfc371_observation_calculations',
  ])
  for (const version of history.versions.filter((version) =>
    version.contract.tables.every((table) => table.sourceRevisionProjection === undefined),
  ))
    expect(observationSourceRevisionStatements(version.contract)).toEqual({
      sqlite: [],
      postgresql: [],
    })
  const bad: LogicalSchemaContract = JSON.parse(canonicalSchemaJson(current.contract))
  Reflect.set(
    bad.tables.find((table) => table.id === 'observation_source_revisions')!
      .sourceRevisionProjection!,
    'revisionColumn',
    'missing',
  )
  expect(() => observationSourceRevisionStatements(bad)).toThrow(
    'Unsupported observation-source-revision schema projection',
  )
}, 60_000)

describeEachProvider('RFC-371 real source revision projections', (harness) => {
  test('every one of the 55 sources advances only on actual committed I/U/D, never rollback or an empty statement', async () => {
    const prefix = 'obs_probe_' + randomUUID().replaceAll('-', '').slice(0, 10)
    const sqlite = harness.capabilities.isolation === 'exclusive'
    const contract: LogicalSchemaContract = JSON.parse(
      canonicalSchemaJson(buildLogicalSchemaContract()),
    )
    const names = new Map<string, string>(
      OBSERVATION_SOURCE_REVISION.sources.map((source, index) => [source, prefix + '_' + index]),
    )
    names.set('observation_source_revisions', prefix + '_revisions')
    for (const table of contract.tables) {
      const name = names.get(table.id)
      if (name) Reflect.set(table, 'providerTables', { sqlite: name, postgresql: name })
    }
    if (!sqlite) await harness.executeFixtureDdl(`CREATE SCHEMA "${prefix}"`)
    const qualify = (name: string) => (sqlite ? `"${name}"` : `"${prefix}"."${name}"`)
    const target = qualify(names.get('observation_source_revisions')!)
    await harness.executeFixtureDdl(
      `CREATE TABLE ${target} ("source_id" TEXT PRIMARY KEY, "revision" TEXT NOT NULL)`,
    )
    for (const source of OBSERVATION_SOURCE_REVISION.sources)
      await harness.executeFixtureDdl(
        `CREATE TABLE ${qualify(names.get(source)!)} ("id" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
      )
    const projection = observationSourceRevisionStatements(contract)
    const statements = sqlite
      ? projection.sqlite.map((statement) =>
          statement.replace('CREATE TRIGGER "obs_src_', `CREATE TRIGGER "${prefix}_obs_src_`),
        )
      : projection.postgresql.map((statement) =>
          statement.sql.replaceAll('"agent_workflow".', `"${prefix}".`),
        )
    for (const statement of statements) await harness.executeFixtureDdl(statement)
    const revisions = async () =>
      Object.fromEntries(
        (
          await harness.db.all<{ source_id: string; revision: string }>(
            sql.raw(`SELECT "source_id", "revision" FROM ${target} ORDER BY "source_id"`),
          )
        ).map((row) => [row.source_id, row.revision]),
      )
    let before = await revisions()
    expect(Object.keys(before)).toHaveLength(55)
    for (const source of OBSERVATION_SOURCE_REVISION.sources) {
      const table = qualify(names.get(source)!)
      await harness.db.run(
        sql.raw(`INSERT INTO ${table} ("id", "value") VALUES ('original', 'one')`),
      )
      const inserted = await revisions()
      expect(inserted[source]).not.toBe(before[source])
      expect({ ...inserted, [source]: before[source] }).toEqual(before)
      await harness.db.run(sql.raw(`UPDATE ${table} SET "value"='two' WHERE "id"='original'`))
      const updated = await revisions()
      expect(updated[source]).not.toBe(inserted[source])
      expect({ ...updated, [source]: inserted[source] }).toEqual(inserted)
      await expect(
        harness.session.transaction(async (tx) => {
          await tx.run(sql.raw(`DELETE FROM ${table} WHERE "id"='original'`))
          throw new Error('original-transaction-rollback')
        }),
      ).rejects.toThrow('original-transaction-rollback')
      expect(await revisions()).toEqual(updated)
      await harness.db.run(sql.raw(`UPDATE ${table} SET "value"='empty' WHERE "id"='missing'`))
      await harness.db.run(sql.raw(`DELETE FROM ${table} WHERE "id"='missing'`))
      await harness.db.run(
        sql.raw(`INSERT INTO ${table} ("id", "value") SELECT 'empty', 'empty' WHERE FALSE`),
      )
      expect(await revisions()).toEqual(updated)
      await harness.db.run(sql.raw(`DELETE FROM ${table} WHERE "id"='original'`))
      const deleted = await revisions()
      expect(deleted[source]).not.toBe(updated[source])
      expect({ ...deleted, [source]: updated[source] }).toEqual(updated)
      before = deleted
    }
  }, 120_000)
})
