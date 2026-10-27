// RFC-395 CIP-A: optimization keeps byte order and exact row counts while bounding repeated work.
import { expect, test } from 'bun:test'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { assertHistoryCatalog } from '@/platform/persistence/schema/history/catalog'
import {
  sortHistoryCatalog,
  type CatalogEntry,
} from '@/platform/persistence/schema/history/catalogModel'
import {
  collectSourceFingerprint,
  makeSourceFingerprint,
} from '@/platform/persistence/migration/sourceCatalog'
import { describeR2Providers } from './helpers/rfc395R2Harness'

test('catalog sorting preserves the original canonical locale order and encodes each row once', () => {
  const original: CatalogEntry[] = ['z', 'é', 'e\u0301', '中', 'a', 'A', 'a'].map(
    (name, index) => ({
      kind: index % 2 ? 'column' : 'table',
      relation: 'fixture',
      name,
      definition: `literal ${index}`,
    }),
  )
  const expected = [...original].sort((a, b) =>
    canonicalSchemaJson(a).localeCompare(canonicalSchemaJson(b)),
  )
  let reads = 0
  const observed = original.map((row) =>
    Object.fromEntries(Object.keys(row).map((key) => [key, row[key as keyof CatalogEntry]])),
  ) as unknown as CatalogEntry[]
  for (const [index, row] of observed.entries())
    for (const key of Object.keys(row) as (keyof CatalogEntry)[])
      Object.defineProperty(row, key, {
        enumerable: true,
        get() {
          reads++
          return original[index]![key]
        },
      })
  expect(sortHistoryCatalog(observed)).toBe(observed)
  expect(reads).toBe(original.length * 4)
  expect(observed).toEqual(expected)
  expect(sortHistoryCatalog([])).toEqual([])
})

test('catalog rejection stays linear and preserves first-difference, ordering and duplicate diagnostics', () => {
  let reads = 0
  const expected: CatalogEntry[] = Array.from({ length: 3000 }, (_, index) => ({
    kind: 'column',
    relation: 'fixture',
    get name() {
      reads++
      return String(index)
    },
    definition: 'text',
  }))
  const actual = expected.slice(1)
  expect(() => assertHistoryCatalog(expected, actual)).toThrow('column fixture.0')
  expect(reads).toBeLessThan(4 * expected.length + 10)
  const introduced = { kind: 'column', relation: 'fixture', name: 'new', definition: 'text' }
  expect(() => assertHistoryCatalog(expected, [...actual, introduced])).toThrow(
    'column fixture.new',
  )
  const rows = expected.slice(0, 2)
  expect(() => assertHistoryCatalog(rows, [...rows].reverse())).toThrow(
    'catalog differs from compiled head',
  )
  expect(() => assertHistoryCatalog(rows, [...rows, rows[0]!])).toThrow(
    'catalog differs from compiled head',
  )
  expect(() =>
    assertHistoryCatalog(
      rows,
      rows.map((row) => ({ ...row })),
    ),
  ).not.toThrow()
})

describeR2Providers('source fingerprint exact counts with bounded query batches', (h) => {
  test('all tables, empty tables, row-count changes and catalog bytes match the sequential oracle', async () => {
    if (h.provider === 'postgresql') await h.native.execute('CREATE SCHEMA agent_workflow')
    for (let index = 0; index < 130; index++)
      await h.native.execute(`CREATE TABLE ${h.table(`count_${index}`)} (id integer PRIMARY KEY)`)
    await h.native.execute(`INSERT INTO ${h.table('count_0')} VALUES (1), (2)`)
    const statements: string[] = []
    const native = h.native
    const fingerprint =
      h.provider === 'sqlite'
        ? collectSourceFingerprint(h.sqlite)
        : await collectSourceFingerprint({
            ...native,
            async execute(statement, values) {
              statements.push(statement)
              return await native.execute(statement, values)
            },
          })
    const expectedCounts: Record<string, number> = {}
    for (let index = 0; index < 130; index++) {
      const rows = await h.native.execute(`SELECT count(*) AS n FROM ${h.table(`count_${index}`)}`)
      expectedCounts[`${h.provider === 'sqlite' ? '' : 'agent_workflow.'}count_${index}`] = Number(
        rows[0]!.n,
      )
    }
    expect(fingerprint.tableRows).toEqual(expectedCounts)
    const expected = makeSourceFingerprint(
      h.provider,
      fingerprint.catalog,
      fingerprint.journal,
      expectedCounts,
    )
    expect(fingerprint.digest).toBe(expected.digest)
    expect(fingerprint.catalogDigest).toBe(expected.catalogDigest)
    if (h.provider === 'postgresql') {
      expect(statements.filter((statement) => statement.includes('count(*) AS n'))).toHaveLength(3)
      // The old one-table query refused missing counts; batching must keep that refusal.
      await expect(
        collectSourceFingerprint({
          ...native,
          async execute(statement, values) {
            const rows = await native.execute(statement, values)
            return statement.includes('count(*) AS n') ? rows.slice(1) : rows
          },
        }),
      ).rejects.toThrow('source row count exceeds safe integer')
    }
    await h.native.execute(`INSERT INTO ${h.table('count_129')} VALUES (3)`)
    const changed =
      h.provider === 'sqlite'
        ? collectSourceFingerprint(h.sqlite)
        : await collectSourceFingerprint(h.native)
    expect(changed.catalogDigest).toBe(fingerprint.catalogDigest)
    expect(changed.digest).not.toBe(fingerprint.digest)
    expect(changed.tableRows[`${h.provider === 'sqlite' ? '' : 'agent_workflow.'}count_129`]).toBe(
      1,
    )
  })
})
