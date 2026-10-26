// RFC-395 T18 FIN R02: the shared sorter preserves the catalog's canonical order and bytes.
import { expect, test } from 'bun:test'
import {
  sortHistoryCatalog,
  type CatalogEntry,
} from '@/platform/persistence/schema/history/catalogModel'
import { sortHistoryCatalog as offeredSort } from '@/platform/persistence/schema/history/catalog'

test('catalog sorting keeps complete entries, duplicate stability and the existing public function', () => {
  const column: CatalogEntry = {
    kind: 'column',
    relation: 'MixedCase',
    name: '中文',
    definition: "DEFAULT ' AbC '",
  }
  const duplicate = { ...column }
  const index: CatalogEntry = {
    kind: 'index',
    relation: 'MixedCase',
    name: 'idx',
    definition: 'CREATE INDEX idx ON MixedCase(id)',
  }
  const rows = [column, index, duplicate]
  expect(offeredSort).toBe(sortHistoryCatalog)
  expect(sortHistoryCatalog(rows)).toBe(rows)
  expect(rows).toEqual([index, column, duplicate])
  expect(rows.indexOf(column)).toBeLessThan(rows.indexOf(duplicate))
  expect(column.definition).toBe("DEFAULT ' AbC '")
  expect(sortHistoryCatalog([])).toEqual([])
})
