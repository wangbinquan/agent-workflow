// RFC-349 T2/T8 — locks the exact 222-table source census, the 216-table
// PostgreSQL parity set, and the only six archive-then-omit tables approved by
// D9 (RFC-371 v2 retired 81 v1 observation tables and added three; RFC-370 v2
// retired the host write-context and memory distill receipt tables; RFC-370 M0
// added the hosted configuration document, external identity and skill content tables;
// RFC-370 M1 added the hosted execution control, binding and task workspace tables;
// RFC-370 v3 V11 squashed every unreleased hosted table into one 0259/0035 migration).
// New/missing/ownerless tables and revived legacy consumers must fail here
// before any migration can prepare a target.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  assertExactSchemaRoster,
  canonicalSchemaJson,
  digestSchemaContract,
  RFC349_ARCHIVE_THEN_OMIT_TABLES,
  RFC349_SOURCE_TABLES,
} from '@/platform/persistence/schemaContract'
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { packageSrcUnits } from './census'
import { isSchemaDeclarationFile } from './schemaRoles'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const contract = buildLogicalSchemaContract()

function sourceMentionsArchiveTable(text: string, schemaSymbol: string, tableId: string): boolean {
  // U-5 names archive sections in one pure decoder; a SQL/import/use elsewhere remains a consumer.
  const source = ts.createSourceFile('archive.ts', text, ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer
      const value = init && ts.isAsExpression(init) ? init.expression : init
      if (
        declaration.name.getText(source) === 'CODE_HISTORY_TABLES' &&
        value &&
        ts.isArrayLiteralExpression(value) &&
        value.elements.every(ts.isStringLiteral)
      )
        text = text.replace(declaration.getText(source), '')
    }
  }
  const symbolPattern = new RegExp(`\\b${schemaSymbol}\\b`)
  const physicalPattern = new RegExp(`(?:['"\`])${tableId}(?:['"\`])`)
  const sqlPattern = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+["\\x60]?${tableId}\\b`, 'i')
  return symbolPattern.test(text) || physicalPattern.test(text) || sqlPattern.test(text)
}

// RFC-395 V2 archives these rows into the code-history packages: that one-time conversion is not a runtime consumer.
const ARCHIVAL_CONVERTER = /(?:^|\/)platform\/persistence\/migration\/archives\//

describe('RFC-349 canonical schema contract', () => {
  test('epoch-1 permission grants use plain primary-key text while agent permissions remain JSON', () => {
    // Released JSON-codec defect; user decision 2026-10-24: correct epoch 1 now.
    const grants = contract.tables.find((table) => table.id === 'user_permission_grants')!
    expect(
      Object.values(persistenceSchema.tables.find((table) => table.id === grants.id)!.columns).find(
        (column) => column.name === 'permission',
      )!.codec,
    ).toBe('id')
    expect(grants.columns.find((column) => column.name === 'permission')).toMatchObject({
      logicalCodec: 'text-identity',
      primary: true,
      providerType: { sqlite: 'text', postgresql: 'text' },
    })
    expect(
      contract.tables
        .find((table) => table.id === 'agents')!
        .columns.find((column) => column.name === 'permission')!.logicalCodec,
    ).toBe('json-text')
  })

  test('locks the source, active parity and archive-only counts', () => {
    expect(RFC349_SOURCE_TABLES).toHaveLength(222)
    expect(contract.sourceTableCount).toBe(222)
    expect(contract.activeTableCount).toBe(216)
    expect(contract.archiveOnlyTableCount).toBe(6)
    // RFC-396 retains the source/active parity set and adds exactly five graph tables.
    expect(
      contract.tables
        .filter((table) => table.id.startsWith('development_design'))
        .map((table) => table.id)
        .sort(),
    ).toEqual([
      'development_design_baselines',
      'development_design_links',
      'development_design_proposals',
      'development_design_revisions',
      'development_designs',
    ])
    expect(contract.tables.map((table) => table.id)).toEqual([...RFC349_SOURCE_TABLES])
    // Retired RFC-372 companion tables stay absent.
    expect(contract.tables.filter((t) => /^(clarify_mindmap_|task_clarify_)/.test(t.id))).toEqual(
      [],
    )
    // RFC-371 v2 (SQLite 0256 / PostgreSQL 0032): one call row, its per-model rows
    // and append-only prices; no v1 projection, report, native-usage or source table survives.
    expect(
      contract.tables
        .map((table) => table.id)
        .filter((id) => /^observation_|native_usage|_observation_/.test(id))
        .sort(),
    ).toEqual(['observation_call_models', 'observation_calls', 'observation_prices'])
    for (const [id, key] of [
      ['observation_calls', ['id']],
      ['observation_call_models', ['call_id', 'model']],
      ['observation_prices', ['id']],
    ] as const) {
      const table = contract.tables.find((table) => table.id === id)!
      expect(table.disposition, id).toBe('KEEP')
      expect(table.ownerContext, id).toBe('run-observability')
      expect(table.migrationKey, id).toEqual([...key])
      expect(table.providerTables, id).toEqual({ sqlite: id, postgresql: id })
    }
    expect(
      contract.tables.find((table) => table.id === 'observation_call_models')!.foreignKeys[0]!
        .foreignTable,
    ).toBe('observation_calls')
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
        expect(
          column.providerType.sqlite.length,
          `${table.id}.${column.name}.sqliteType`,
        ).toBeGreaterThan(0)
        expect(
          column.providerType.postgresql.length,
          `${table.id}.${column.name}.postgresqlType`,
        ).toBeGreaterThan(0)
      }
      for (const foreignKey of table.foreignKeys) {
        expect(knownTables.has(foreignKey.foreignTable), `${table.id}.${foreignKey.name}`).toBe(
          true,
        )
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
        !isSchemaDeclarationFile(unit.path, unit.text) &&
        !ARCHIVAL_CONVERTER.test(unit.path) &&
        unit.path !== 'packages/backend/src/platform/persistence/migration/epoch1/tables.ts',
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
    // 语料扫描在 macOS runner 上量到 5.3s（CI run 33888112525，macos shard 3/4 超时红）：这是一条扫源码的
    // 守卫，不是被测行为；给它扫描量级的预算，别让 5s 缺省把它判成 flaky。
  }, 60_000)

  test('frozen declarations are exempt but an adjacent converter consumer is rejected', () => {
    const code = "readTable('code_artifacts')"
    for (const name of ['definitions', 'roster'])
      expect(
        isSchemaDeclarationFile(`platform/persistence/migration/epoch1/${name}.ts`, code),
      ).toBe(true)
    expect(isSchemaDeclarationFile('platform/persistence/migration/epoch1/reader.ts', code)).toBe(
      false,
    )
    expect(sourceMentionsArchiveTable(code, 'codeArtifacts', 'code_artifacts')).toBe(true)
    expect(
      ARCHIVAL_CONVERTER.test(
        'packages/backend/src/platform/persistence/migration/archives/codeHistory.ts',
      ),
    ).toBe(true)
    for (const path of [
      'packages/backend/src/platform/persistence/migration/conversion/rule.ts',
      'packages/backend/src/platform/persistence/migration/epoch1/reader.ts',
      'packages/backend/src/modules/code-capability/infrastructure/archives/codeHistory.ts',
    ])
      expect(ARCHIVAL_CONVERTER.test(path)).toBe(false)
  })
  test('archive section vocabulary does not permit table reads beside it', () => {
    const names = "export const CODE_HISTORY_TABLES = ['code_artifacts'] as const"
    expect(sourceMentionsArchiveTable(names, 'codeArtifacts', 'code_artifacts')).toBe(false)
    expect(
      sourceMentionsArchiveTable(
        names + '; db.select().from(codeArtifacts)',
        'codeArtifacts',
        'code_artifacts',
      ),
    ).toBe(true)
    expect(
      sourceMentionsArchiveTable(
        names + '; db.query("SELECT * FROM code_artifacts")',
        'codeArtifacts',
        'code_artifacts',
      ),
    ).toBe(true)
  })

  test('archive-only production-consumer matcher rejects symbol and physical table references', () => {
    expect(sourceMentionsArchiveTable('const rows = legacyRows', 'legacyRows', 'legacy_rows')).toBe(
      true,
    )
    expect(
      sourceMentionsArchiveTable("readTable('legacy_rows')", 'legacyRows', 'legacy_rows'),
    ).toBe(true)
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
