// RFC-349 T2/T8 — locks the exact 184-table source census, the 178-table
// PostgreSQL parity set, and the only six archive-then-omit tables approved by
// D9. New/missing/ownerless tables and revived legacy consumers must fail here
// before any migration can prepare a target.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertExactSchemaRoster,
  buildLogicalSchemaContract,
  canonicalSchemaJson,
  digestSchemaContract,
  RFC349_ARCHIVE_THEN_OMIT_TABLES,
  RFC349_SOURCE_TABLES,
} from '@/platform/persistence/schemaContract'
import { packageSrcUnits } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const contract = buildLogicalSchemaContract()

function sourceMentionsArchiveTable(text: string, schemaSymbol: string, tableId: string): boolean {
  const symbolPattern = new RegExp(`\\b${schemaSymbol}\\b`)
  const physicalPattern = new RegExp(`(?:['"\`])${tableId}(?:['"\`])`)
  return symbolPattern.test(text) || physicalPattern.test(text)
}

describe('RFC-349 canonical schema contract', () => {
  test('locks the source, active parity and archive-only counts', () => {
    expect(RFC349_SOURCE_TABLES).toHaveLength(184)
    expect(contract.sourceTableCount).toBe(184)
    expect(contract.activeTableCount).toBe(178)
    expect(contract.archiveOnlyTableCount).toBe(6)
    expect(contract.tables.map((table) => table.id)).toEqual([...RFC349_SOURCE_TABLES])
  })

  test('every source table has one owner, stable key, codec and provider mapping', () => {
    const ids = contract.tables.map((table) => table.id)
    const symbols = contract.tables.map((table) => table.schemaSymbol)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(symbols).size).toBe(symbols.length)

    const knownTables = new Set(ids)
    for (const table of contract.tables) {
      expect(table.ownerContext.length, `${table.id}.ownerContext`).toBeGreaterThan(0)
      expect(table.migrationKey.length, `${table.id}.migrationKey`).toBeGreaterThan(0)
      expect(table.primaryKey, `${table.id}.primaryKey`).toEqual(table.migrationKey)
      expect(table.columns.length, `${table.id}.columns`).toBeGreaterThan(0)
      expect(table.retention.rule.length, `${table.id}.retention`).toBeGreaterThan(20)
      expect(table.rationale.length, `${table.id}.rationale`).toBeGreaterThan(20)
      expect(table.providerTables.sqlite, `${table.id}.sqlite`).toBe(table.id)

      for (const key of table.migrationKey) {
        expect(
          table.columns.some((column) => column.name === key),
          `${table.id}.migrationKey.${key}`,
        ).toBe(true)
      }
      for (const column of table.columns) {
        expect(column.logicalCodec.length, `${table.id}.${column.name}.codec`).toBeGreaterThan(0)
        expect(column.providerType.sqlite.length, `${table.id}.${column.name}.sqliteType`).toBeGreaterThan(
          0,
        )
        expect(
          column.providerType.postgresql.length,
          `${table.id}.${column.name}.postgresqlType`,
        ).toBeGreaterThan(0)
      }
      for (const foreignKey of table.foreignKeys) {
        expect(knownTables.has(foreignKey.foreignTable), `${table.id}.${foreignKey.name}`).toBe(true)
      }

      if (table.disposition === 'ARCHIVE_THEN_OMIT') {
        expect(table.providerTables.postgresql, `${table.id}.postgresql`).toBeUndefined()
        expect(table.archive?.approval, `${table.id}.archive`).toBe('RFC-349-D9')
        expect(table.archive?.stableOrder, `${table.id}.archiveOrder`).toEqual(table.migrationKey)
      } else {
        expect(table.providerTables.postgresql, `${table.id}.postgresql`).toBe(table.id)
        expect(table.archive, `${table.id}.archive`).toBeUndefined()
      }
    }
  })

  test('D9 archive allowlist is exact and no seventh table can disappear', () => {
    const actual = contract.tables
      .filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT')
      .map((table) => table.id)
      .sort()
    expect(actual).toEqual([...RFC349_ARCHIVE_THEN_OMIT_TABLES].sort())
  })

  test('the six archive-only tables still have zero production consumer', () => {
    const units = packageSrcUnits(REPO_ROOT, 'backend').filter(
      (unit) =>
        unit.path !== 'packages/backend/src/db/schema.ts' &&
        unit.path !== 'packages/backend/src/platform/persistence/schemaContract.ts' &&
        !unit.path.startsWith('packages/backend/src/platform/persistence/migration/'),
    )
    expect(units.length).toBeGreaterThanOrEqual(1000)
    const byId = new Map(contract.tables.map((table) => [table.id, table]))
    for (const id of RFC349_ARCHIVE_THEN_OMIT_TABLES) {
      const table = byId.get(id)
      if (!table) throw new Error(`missing archive contract for ${id}`)
      const consumers = units
        .filter((unit) => sourceMentionsArchiveTable(unit.text, table.schemaSymbol, id))
        .map((unit) => unit.path)
      expect(consumers, `${id} regained a production consumer`).toEqual([])
    }
  })

  test('archive-only production-consumer matcher rejects symbol and physical table references', () => {
    expect(sourceMentionsArchiveTable('const rows = legacyRows', 'legacyRows', 'legacy_rows')).toBe(
      true,
    )
    expect(sourceMentionsArchiveTable("readTable('legacy_rows')", 'legacyRows', 'legacy_rows')).toBe(
      true,
    )
    expect(sourceMentionsArchiveTable('const unrelated = true', 'legacyRows', 'legacy_rows')).toBe(
      false,
    )
  })

  test('manifest digest covers every canonical field', () => {
    const { digest, ...payload } = contract
    expect(digest).toBe(digestSchemaContract(payload))
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('committed machine manifest and human report are the same generated snapshot', () => {
    const artifactDir = resolve(
      REPO_ROOT,
      'design',
      'RFC-349-postgresql-provider-one-click-migration',
    )
    const machine = JSON.parse(
      readFileSync(resolve(artifactDir, 'schema-contract.json'), 'utf8'),
    ) as unknown
    expect(canonicalSchemaJson(machine)).toBe(canonicalSchemaJson(contract))

    const report = readFileSync(resolve(artifactDir, 'schema-contract.md'), 'utf8')
    expect(report).toContain(`Digest: \`${contract.digest}\``)
    expect(report).toContain(`SQLite source tables: **${contract.sourceTableCount}**`)
    expect(report).toContain(
      `PostgreSQL logical active parity tables: **${contract.activeTableCount}**`,
    )
    const ledger = report.split('## Exact table ledger')[1] ?? ''
    const reportedTables = ledger
      .split('\n')
      .map((line) => /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined)
    expect(reportedTables).toEqual(contract.tables.map((table) => table.id))
  })

  test('missing, extra and duplicate table mutations fail closed', () => {
    expect(() => assertExactSchemaRoster(['a'], ['a'])).not.toThrow()
    expect(() => assertExactSchemaRoster([], ['a'])).toThrow('missing=a')
    expect(() => assertExactSchemaRoster(['a', 'b'], ['a'])).toThrow('extra=b')
    expect(() => assertExactSchemaRoster(['a', 'a'], ['a'])).toThrow('duplicate table a')
  })
})
