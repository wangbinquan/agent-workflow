import { loadPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
// RFC-395 I-a: durable equivalence between contributions, the maintained v2 artifact and both provider projections.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { is, SQL } from 'drizzle-orm'
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { getTableConfig as pgConfig, PgDialect } from 'drizzle-orm/pg-core'
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { frozenEpoch1Registry as persistenceSchema } from '@/platform/persistence/migration/epoch1/definitions'
import { canonicalSchemaJson } from '@/platform/persistence/schemaContract'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/migration/legacy/postgresqlSchema'
import { projectLegacyV2 } from '@/platform/persistence/migration/legacy/v2Contract'
import { compileContract } from '@/platform/persistence/schema/contract'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'
import { CODECS } from '@/platform/persistence/schema/codecs'
import { renderSchemaExpression } from '@/platform/persistence/schema/expressions'

const owners = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'fixtures/rfc395-owner-map.json'), 'utf8'),
) as Record<string, string[]>
const contract = buildLogicalSchemaContract()
const sqliteDialect = new SQLiteSyncDialect()
const pgDialect = new PgDialect()
function renderedDefault(value: unknown, dialect: SQLiteSyncDialect | PgDialect): string | null {
  if (value === undefined) return null
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql.replaceAll(/\s+/g, ' ').trim()
  if (value === null) return 'NULL'
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (typeof value === 'boolean')
    return dialect === pgDialect ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0'
  return String(value)
}
describe('RFC-395 I-a explicit schema equivalence', () => {
  test('bootstrap and frozen v2 rules equal the generator-maintained canonical artifact', () => {
    const projected = projectLegacyV2(persistenceSchema)
    expect(contract).toEqual(projected)
    expect(canonicalSchemaJson(projected)).toBe(
      readFileSync(
        resolve(
          import.meta.dir,
          '../../../design/RFC-349-postgresql-provider-one-click-migration/schema-contract.json',
        ),
        'utf8',
      ),
    )
  })
  test('owners match the reviewed ledger and migration policies match the v2 dispositions', () => {
    const explicit = compileContract(persistenceSchema)
    expect(explicit.contractVersion).toBe(3)
    expect(
      Object.fromEntries(
        persistenceSchema.contributions.map((entry) => [
          entry.owner,
          entry.tables.map((table): string => table.id),
        ]),
      ),
    ).toEqual(owners)
    expect(new Set(explicit.tables.map((table) => table.id)).size).toBe(explicit.tables.length)
    const dispositions = new Map(contract.tables.map((table) => [table.id, table.disposition]))
    for (const table of explicit.tables) {
      expect(
        Object.values(table.columns).every((column) => column.codec in CODECS),
        table.id,
      ).toBe(true)
      expect(table.migrationPolicy, table.id).toBe(dispositions.get(table.id)!)
    }
  })
  test('frozen PostgreSQL compilation preserves the published baseline and the live compiler rejects epoch 1', async () => {
    expect(() => compilePostgresqlPlan(persistenceSchema)).toThrow(
      'epoch-1-schema-compilation-is-offline-only',
    )
    const plan = buildPostgresqlSchemaPlan(contract)
    const published = await loadPostgresqlMigrationHistory({ headContract: contract })
    expect(plan).toEqual(published.head.plan)
  })
  test('both materialized Drizzle column sets agree with their v2 provider projections', () => {
    const definitions = new Map<string, (typeof persistenceSchema.tables)[number]>(
      persistenceSchema.tables.map((table) => [table.id, table]),
    )
    expect([...definitions.keys()].sort()).toEqual(contract.tables.map((table) => table.id).sort())
    for (const table of contract.tables) {
      const definition = definitions.get(table.id)!
      const materialized = materializeDrizzle(definition)
      const sqliteConfig = getTableConfig(materialized.sqlite)
      const sqlite = sqliteConfig.columns
      const compositePrimary = new Set(
        sqliteConfig.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
      )
      const postgresql = pgConfig(materialized.postgresql).columns
      expect(
        sqlite.map((column) => column.name),
        table.id,
      ).toEqual(table.columns.map((column) => column.name))
      expect(
        postgresql.map((column) => column.name),
        table.id,
      ).toEqual(table.columns.map((column) => column.name))
      for (const [position, expected] of table.columns.entries()) {
        const sc = sqlite[position]!
        const pc = postgresql[position]!
        expect(
          {
            type: sc.getSQLType(),
            notNull: sc.notNull,
            primary: sc.primary || compositePrimary.has(sc.name),
            hasDefault: sc.hasDefault,
            identity: 'autoIncrement' in sc && sc.autoIncrement === true,
            default: renderedDefault(sc.default, sqliteDialect),
            uniqueName: sc.isUnique ? sc.uniqueName : null,
            enumValues: sc.enumValues ?? [],
          },
          `${table.id}.${expected.name}:sqlite`,
        ).toEqual({
          type: expected.providerType.sqlite,
          notNull: !expected.nullable,
          primary: expected.primary,
          hasDefault: expected.hasDefault,
          identity: expected.identity,
          default: expected.providerDefault.sqlite,
          uniqueName: expected.uniqueName,
          enumValues: [...expected.enumValues],
        })
        expect(
          {
            // Bigserial is Drizzle's runtime identity builder; the physical plan uses bigint IDENTITY.
            type: pc.getSQLType(),
            notNull: pc.notNull,
            identity: pc.columnType === 'PgBigSerial53',
            hasDefault: pc.hasDefault,
            default: renderedDefault(pc.default, pgDialect),
            enumValues: pc.enumValues ?? [],
          },
          `${table.id}.${expected.name}:postgresql`,
        ).toEqual({
          type: expected.identity ? 'bigserial' : expected.providerType.postgresql,
          notNull: !expected.nullable,
          identity: expected.identity,
          hasDefault: expected.hasDefault,
          default: expected.identity ? 'default' : expected.providerDefault.postgresql,
          enumValues: [...expected.enumValues],
        })
      }
      expect(materializeDrizzle(definition).table).toBe(materialized.table)
    }
  })
  test('typed expressions preserve literal case and render provider booleans explicitly', () => {
    const expression = {
      kind: 'binary',
      op: '=',
      left: { kind: 'column', name: 'enabled' },
      right: { kind: 'literal', value: true },
    } as const
    expect(renderSchemaExpression(expression, 'sqlite')).toBe('("enabled" = 1)')
    expect(renderSchemaExpression(expression, 'postgresql')).toBe('("enabled" = TRUE)')
    expect(renderSchemaExpression({ kind: 'literal', value: 'Ready' }, 'sqlite')).toBe("'Ready'")
  })
})
