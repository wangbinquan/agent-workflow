// RFC-395 II-b R2: immutable artifacts, diff refusal and the same head check used by the CLI/CI guard.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { column } from '@/platform/persistence/schema/dsl'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import {
  generateHistoryBaseline,
  readSchemaHistory,
  runSchemaHistoryCommand,
  verifySchemaHistory,
  writeHistoryArtifacts,
} from '@/platform/persistence/schema/history/artifacts'
import { schemaHistoryMain } from '../../../scripts/schema-history'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { itemTable, parentTable, r2Registry } from './helpers/rfc395R2Schema'

const roots: string[] = []
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc395-r2-artifacts-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('RFC-395 R2 artifact authoring', () => {
  test('baseline generator and --append produce exactly three expected artifacts per version', () => {
    const root = directory()
    const registry = r2Registry()
    const paths = generateHistoryBaseline(root, registry)
    const original = paths.map((path) => readFileSync(path, 'utf8'))
    expect(paths.map((path) => path.slice(root.length + 1))).toEqual([
      '0000_baseline.contract.json',
      '0000_baseline.sqlite-plan.json',
      '0000_baseline.postgresql-plan.json',
    ])
    const next = r2Registry([
      parentTable,
      {
        ...itemTable,
        columns: { ...itemTable.columns, note: column.text('note', { nullable: true }) },
      },
    ])
    expect(
      runSchemaHistoryCommand(['--append', 'add-column', 'note'], {
        registry: next,
        directory: root,
      }),
    ).toHaveLength(3)
    expect(readdirSync(root)).toHaveLength(6)
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(original)
    const history = readSchemaHistory(root)
    expect(history[1]!.contract.edge).toEqual({
      kind: 'add-column',
      tableId: 'r2_items',
      column: 'note',
    })
    expect(history[1]!.contract.previousDigest).toBe(history[0]!.contract.digest)
    expect(() =>
      runSchemaHistoryCommand(['--check'], { registry: next, directory: root }),
    ).not.toThrow()
    expect(() => runSchemaHistoryCommand(['--check'], { registry, directory: root })).toThrow(
      'registry-head-mismatch',
    )
    expect(() => writeHistoryArtifacts(root, history[0]!)).toThrow()
  })
  test('multi-column and undeclared non-null deltas are refused without writing partial artifacts', () => {
    const root = directory()
    generateHistoryBaseline(root, r2Registry())
    for (const columns of [
      {
        ...itemTable.columns,
        one: column.text('one', { nullable: true }),
        two: column.text('two', { nullable: true }),
      },
      { ...itemTable.columns, one: column.text('one') },
    ]) {
      expect(() =>
        runSchemaHistoryCommand(['--append', 'add-column', 'ambiguous'], {
          registry: r2Registry([parentTable, { ...itemTable, columns }]),
          directory: root,
        }),
      ).toThrow('ambiguous-diff')
      expect(readdirSync(root)).toHaveLength(3)
    }
  })
  test('edited contract, plan and broken predecessor are refused', () => {
    const base = createHistoryVersion({ registry: r2Registry(), slug: 'baseline' })
    expect(() =>
      verifySchemaHistory([{ ...base, sqlite: { ...base.sqlite, statements: [] } }]),
    ).toThrow('digest-mismatch')
    expect(() =>
      verifySchemaHistory([{ ...base, contract: { ...base.contract, previousDigest: 'changed' } }]),
    ).toThrow('digest-mismatch')
    const root = directory()
    generateHistoryBaseline(root, r2Registry())
    writeFileSync(join(root, '0000_baseline.sqlite-plan.json'), '{}')
    expect(() => readSchemaHistory(root)).toThrow()
  })
  test('seed-delta is derived from changed install-only seed declarations', () => {
    const root = directory()
    const seeded = (label: string) =>
      createSchemaRegistry(
        [
          {
            owner: 'system-operations',
            version: 1,
            tables: [parentTable, itemTable],
            seeds: [
              {
                table: 'r2_items',
                mode: 'install-only',
                rows: [{ id: 'seed', label, amount: 0, parent_id: null }],
              },
            ],
          },
        ],
        { schemaEpoch: 2 },
      )
    generateHistoryBaseline(root, seeded('Before'))
    runSchemaHistoryCommand(['--append', 'seed-delta', 'seed-label'], {
      registry: seeded('After'),
      directory: root,
    })
    expect(readSchemaHistory(root)[1]!.contract.edge).toMatchObject({
      kind: 'seed-delta',
      tableId: 'r2_items',
      upsert: [{ id: 'seed', label: 'After', amount: 0, parent_id: null }],
      remove: [],
    })
  })
  test('data-transform cannot be invented from a schema diff', () => {
    const root = directory()
    generateHistoryBaseline(root, r2Registry())
    expect(() =>
      runSchemaHistoryCommand(['--append', 'data-transform', 'unknown'], {
        registry: r2Registry(),
        directory: root,
      }),
    ).toThrow('ambiguous-diff')
  })
  test('snapshot is independent of later mutation of the caller registry', () => {
    const mutable = structuredClone(itemTable)
    const base = createHistoryVersion({
      registry: r2Registry([parentTable, mutable]),
      slug: 'baseline',
    })
    Object.assign(mutable.columns.label, { nullable: true })
    expect(
      base.contract.contract.tables.find((table) => table.id === itemTable.id)!.columns.label!
        .nullable,
    ).toBe(false)
  })
  test('CLI defaults to the single live registry while retaining an explicit override', async () => {
    const root = directory()
    await schemaHistoryMain(['--baseline', 'live', '--directory', root])
    expect(() => verifySchemaHistory(readSchemaHistory(root), persistenceSchema)).not.toThrow()
    await schemaHistoryMain(['--check', '--directory', root])
  })
  test('CLI loads an explicit synthetic registry and check mode reports mismatch', async () => {
    const root = directory()
    const declarationPath = join(root, 'registry.ts')
    const registryModule = join(import.meta.dir, '../src/platform/persistence/schema/registry.ts')
    writeFileSync(
      declarationPath,
      `import { createSchemaRegistry } from ${JSON.stringify(registryModule)}\nexport const schemaRegistry = createSchemaRegistry(${JSON.stringify(r2Registry().contributions)}, {schemaEpoch: 2})\n`,
    )
    const historyDirectory = join(root, 'history')
    await schemaHistoryMain([
      '--baseline',
      'synthetic',
      '--registry',
      declarationPath,
      '--directory',
      historyDirectory,
    ])
    await schemaHistoryMain([
      '--check',
      '--registry',
      declarationPath,
      '--directory',
      historyDirectory,
    ])
    const different = createSchemaRegistry(
      [{ owner: 'system-operations', version: 1, tables: [parentTable] }],
      { schemaEpoch: 2 },
    )
    expect(() => verifySchemaHistory(readSchemaHistory(historyDirectory), different)).toThrow(
      'registry-head-mismatch',
    )
  })
})
