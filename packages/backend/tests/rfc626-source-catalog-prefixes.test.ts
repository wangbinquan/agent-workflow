// RFC-626 §3.5 and the implementation gate's timings: the precheck that refuses a database with a
// structure no release wrote spent most of its ten seconds in `compileSqlitePrefixes`, which
// applied the frozen SQLite chain one migration at a time and collected and normalised the whole
// catalog after each one (its cached pragma statements also slowed every later migration down).
// `compileSqlitePrefixCatalogs` now reads again only the relations whose stored SQL changed.
//
// What this file locks: the catalogs are still the full ones — after every prefix, entry for
// entry, in the same order, with an entry object shared across prefixes exactly where the full
// collection shares it. The full collection, as the compiler did it before, is the reference
// implementation kept here.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { collectSqliteHistoryCatalog } from '@/platform/persistence/schema/history/catalog'
import type {
  CatalogEntry,
  HistoryCatalog,
} from '@/platform/persistence/schema/history/catalogModel'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import {
  applyFrozenSqliteMigrations,
  createFrozenSqliteJournal,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import {
  compileSqlitePrefixCatalogs,
  loadSupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'

type Migration = Parameters<typeof compileSqlitePrefixCatalogs>[1][number]

/** An empty migration database, as the prefix compiler starts from. */
function emptyChain(): Database {
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = OFF')
  createFrozenSqliteJournal(database)
  return database
}
/** The reference: the full catalog after every prefix, equal entries shared across prefixes. */
function collectEveryPrefix(migrations: readonly Migration[]): HistoryCatalog[] {
  const database = emptyChain()
  const shared = new Map<string, CatalogEntry>()
  try {
    return migrations.map((migration) => {
      applyFrozenSqliteMigrations(database, [migration])
      return collectSqliteHistoryCatalog(database).map((entry) => {
        const key = canonicalSchemaJson(entry)
        const one = shared.get(key) ?? entry
        shared.set(key, one)
        return one
      })
    })
  } finally {
    database.close()
  }
}
function compileEveryPrefix(migrations: readonly Migration[]): HistoryCatalog[] {
  const database = emptyChain()
  const catalogs: HistoryCatalog[] = []
  try {
    compileSqlitePrefixCatalogs(database, migrations, (through, catalog) => {
      catalogs[through - 1] = catalog
    })
  } finally {
    database.close()
  }
  return catalogs
}
/**
 * How `actual` differs from `expected`: entries compared field by field in order, and sharing —
 * two places hold one object in `actual` exactly when they hold one object in `expected`. Every
 * prefix has an array of its own, as before.
 */
function differences(
  actual: readonly HistoryCatalog[],
  expected: readonly HistoryCatalog[],
): string[] {
  const found: string[] = []
  if (actual.length !== expected.length)
    found.push(`${actual.length} prefixes instead of ${expected.length}`)
  if (new Set(actual).size !== actual.length) found.push('prefixes share a catalog array')
  const forward = new Map<CatalogEntry, CatalogEntry>()
  const backward = new Map<CatalogEntry, CatalogEntry>()
  for (let prefix = 0; prefix < expected.length && found.length < 20; prefix += 1) {
    const got = actual[prefix] ?? []
    const want = expected[prefix]!
    if (got.length !== want.length)
      found.push(`prefix ${prefix + 1}: ${got.length} entries instead of ${want.length}`)
    for (let index = 0; index < Math.min(got.length, want.length); index += 1) {
      const entry = got[index]!
      const reference = want[index]!
      if (JSON.stringify(entry) !== JSON.stringify(reference))
        found.push(
          `prefix ${prefix + 1} #${index}: ${JSON.stringify(entry)} instead of ${JSON.stringify(reference)}`,
        )
      if (
        (forward.get(reference) ?? entry) !== entry ||
        (backward.get(entry) ?? reference) !== reference
      )
        found.push(`prefix ${prefix + 1} #${index}: shared unlike the full collection`)
      forward.set(reference, entry)
      backward.set(entry, reference)
    }
  }
  return found
}

test('every prefix of the frozen SQLite chain has the catalog a full collection gives', async () => {
  const history = await loadFrozenEpoch1History()
  const manifest = await loadSupportedSourceManifest()
  const prefixes = manifest.sources.filter(
    (source) => source.provider === 'sqlite' && !source.id.endsWith(':observed-rfc278'),
  )
  expect(prefixes.map((source) => source.sqliteThrough)).toEqual(
    history.sqlite.map((_, index) => index + 1),
  )
  expect(
    differences(
      prefixes.map((source) => source.catalog),
      collectEveryPrefix(history.sqlite),
    ),
  ).toEqual([])
}, 180_000)

let folderMillis = 1_700_000_000_000
const migration = (...sql: string[]): Migration => ({
  sql,
  folderMillis: (folderMillis += 1),
  hash: `rfc626-${folderMillis}`,
  bps: true,
})
/** Composed and decomposed spellings of one name: two tables, whose texts `localeCompare` ties. */
const COMPOSED = 'été'
const DECOMPOSED = 'été'

test('every kind of schema change, and entries the collector sorts as equal, give the full catalogs', () => {
  const migrations = [
    migration(
      'CREATE TABLE parent (id integer PRIMARY KEY, code text NOT NULL UNIQUE)',
      'CREATE TABLE child (id integer PRIMARY KEY AUTOINCREMENT, parent_id integer REFERENCES parent(id) ON DELETE CASCADE, body text)',
      'CREATE INDEX idx_child_parent ON child (parent_id)',
      'CREATE TABLE pairs (a text NOT NULL, b text NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID',
    ),
    // Rows only: no relation changes.
    migration("INSERT INTO parent (id, code) VALUES (1, 'one')"),
    migration("ALTER TABLE child ADD COLUMN note text DEFAULT 'x' COLLATE NOCASE"),
    migration(
      'CREATE INDEX idx_parent_code ON parent (code DESC) WHERE code IS NOT NULL',
      'CREATE TRIGGER trg_parent AFTER INSERT ON parent BEGIN SELECT 1; END',
      'CREATE VIEW parent_codes AS SELECT code FROM parent',
    ),
    // A rebuild the way the frozen chain does it.
    migration(
      'CREATE TABLE child_new (id integer PRIMARY KEY AUTOINCREMENT, parent_id integer NOT NULL REFERENCES parent(id), body text, note text)',
      'INSERT INTO child_new SELECT id, parent_id, body, note FROM child',
      'DROP TABLE child',
      'ALTER TABLE child_new RENAME TO child',
      'CREATE INDEX idx_child_parent ON child (parent_id)',
    ),
    // Renaming the parent rewrites the text of the child's reference, the view and the trigger,
    // and moves its index and trigger to the new name.
    migration('ALTER TABLE parent RENAME TO parents'),
    migration(
      'DROP INDEX idx_parent_code',
      'DROP VIEW parent_codes',
      'DROP TRIGGER trg_parent',
      'ALTER TABLE pairs RENAME COLUMN b TO c',
    ),
    migration(
      `CREATE TABLE "${COMPOSED}" (value text)`,
      `CREATE TABLE "${DECOMPOSED}" (value text)`,
    ),
    migration('ALTER TABLE parents ADD COLUMN label text'),
    migration(`DROP TABLE "${DECOMPOSED}"`),
    migration('CREATE INDEX idx_pairs_c ON pairs (c)', 'DROP TABLE child'),
  ]
  const reference = collectEveryPrefix(migrations)
  // The case is about what it says: the full collection really has entries that compare equal
  // (so the compiler has to collect those prefixes in full), and they are gone again later.
  const ties = reference.map((catalog) =>
    catalog.some(
      (entry, index) =>
        index > 0 &&
        canonicalSchemaJson(catalog[index - 1]!).localeCompare(canonicalSchemaJson(entry)) === 0,
    ),
  )
  expect(ties).toEqual([false, false, false, false, false, false, false, true, true, false, false])
  expect(new Set(reference.map((catalog) => catalog.length)).size).toBeGreaterThan(5)
  expect(differences(compileEveryPrefix(migrations), reference)).toEqual([])
})
