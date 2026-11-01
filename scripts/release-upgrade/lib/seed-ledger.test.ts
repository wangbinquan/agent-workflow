/** Authored for the later verification phase; do not execute during T8 development. */
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegistry, sha256, FIXTURES } from './io'
import {
  buildSeedDatabase,
  checkSeedLedger,
  deriveSeed,
  insertSeed,
  migrationSql,
  readSeed,
  sqliteValue,
} from './seed-ledger'
import type { ReleaseRegistry } from './model'
import type { CoverageExemption, SeedFile } from './seed-model'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), 'rfc398-ledger-unit-'))
  cleanup.push(path)
  return path
}
const seed = (rows: SeedFile['rows']): SeedFile => ({
  formatVersion: 1,
  epoch: 1,
  after: '0000_fixture',
  provenance: {
    kind: 'curated',
    sources: ['unit-fixture.sql'],
    note: 'Isolated data preparation.',
  },
  rows,
})
function fixture(
  rows: SeedFile['rows'],
  sql = 'CREATE TABLE example (id TEXT PRIMARY KEY, value TEXT)',
) {
  const root = temporary()
  const release = structuredClone(readRegistry().releases.find((entry) => entry.epoch1)!)
  const receipt = { tag: '0000_fixture', hash: sha256(sql), created_at: 1 }
  release.epoch1!.sqlite = [receipt]
  release.releasedSql = [
    {
      provider: 'sqlite',
      migration: receipt.tag,
      sha256: receipt.hash,
      file: 'released.sql',
      frozenSha256: null,
      recognizedAlias: false,
    },
  ]
  writeFileSync(join(root, 'released.sql'), sql)
  mkdirSync(join(root, 'epoch1'))
  writeFileSync(join(root, 'epoch1/0000_fixture.json'), JSON.stringify(seed(rows)))
  return { root, release, receipt, options: { seeds: root, fixtures: root } }
}

describe('release seed preparation', () => {
  test('uses exact released bytes and refuses a receipt/hash mismatch', () => {
    const f = fixture([{ table: 'example', values: { id: 'one', value: 'released' } }])
    expect(migrationSql(f.release, f.receipt, f.root)).toContain('CREATE TABLE example')
    writeFileSync(join(f.root, 'released.sql'), 'CREATE TABLE example (different TEXT)')
    expect(() => migrationSql(f.release, f.receipt, f.root)).toThrow('SQL receipt mismatch')
  })

  test('seeds immediately after each migration and checks the exact journal', () => {
    const f = fixture([{ table: 'example', values: { id: 'one', value: 'before backfill' } }])
    const sql =
      'CREATE TABLE derived (id TEXT PRIMARY KEY, value TEXT); INSERT INTO derived SELECT * FROM example;'
    const receipt = { tag: '0001_backfill', hash: sha256(sql), created_at: 2 }
    f.release.epoch1!.sqlite.push(receipt)
    f.release.releasedSql.push({
      provider: 'sqlite',
      migration: receipt.tag,
      sha256: receipt.hash,
      file: 'backfill.sql',
      frozenSha256: null,
      recognizedAlias: false,
    })
    writeFileSync(join(f.root, 'backfill.sql'), sql)
    writeFileSync(
      join(f.root, 'epoch1/0001_backfill.json'),
      JSON.stringify({ ...seed([]), after: receipt.tag }),
    )
    const home = join(f.root, 'home')
    const report = buildSeedDatabase(f.release, home, f.options)
    expect(report.failures).toEqual([])
    expect(report.tables.find((table) => table.table === 'derived')?.rows).toBe(1)
    const db = new Database(join(home, 'db.sqlite'), { readonly: true })
    try {
      expect(db.query('SELECT * FROM derived').all()).toEqual([
        { id: 'one', value: 'before backfill' },
      ])
      expect(
        db.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY rowid').all(),
      ).toEqual([
        { hash: f.receipt.hash, created_at: 1 },
        { hash: receipt.hash, created_at: 2 },
      ])
    } finally {
      db.close()
    }
  })

  test('missing seed data remains a coverage failure, never an implicit exemption', () => {
    const f = fixture([])
    const report = buildSeedDatabase(f.release, join(f.root, 'home'), f.options)
    expect(report.tables.find((table) => table.table === 'example')).toMatchObject({
      rows: 0,
      coverage: 'missing',
    })
  })

  test('a failed insert rolls back its receipt and reports the precise row', () => {
    const f = fixture([{ table: 'example', values: { id: 'one', absent_column: 'wrong' } }])
    const report = buildSeedDatabase(f.release, join(f.root, 'home'), f.options)
    expect(report.failures[0]?.phase).toBe('seed:0000_fixture')
    expect(report.failures[0]?.detail).toContain('row 0 (example)')
    expect(report.tables.find((table) => table.table === '__drizzle_migrations')?.rows).toBe(0)
  })

  test('foreign key drift fails despite deferred offline insertion', () => {
    const f = fixture(
      [{ table: 'child', values: { id: 'child', parent_id: 'missing' } }],
      'CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));',
    )
    const report = buildSeedDatabase(f.release, join(f.root, 'home'), f.options)
    expect(report.failures[0]?.phase).toBe('integrity')
    expect(report.failures[0]?.detail).toContain('Foreign key violations')
  })

  // RFC-398 §7.5 (user approval 2026-10-31): only approved, exact-build entries in the
  // fixtures' exemptions.json authorize an empty table; callers may narrow, never authorize.
  test('only approved exact-build exemptions from exemptions.json authorize coverage', () => {
    const f = fixture([])
    const entry: CoverageExemption = {
      id: 'metadata-only',
      table: 'example',
      epoch: 1,
      category: 'migration-metadata',
      status: 'proposed',
      reason: 'unit fixture',
      evidence: ['unit-fixture.sql'],
      build: f.release.buildKey,
      buildKeys: [f.release.buildKey],
    }
    const coverage = (directory: string, requested?: CoverageExemption[]) =>
      buildSeedDatabase(f.release, join(f.root, directory), {
        ...f.options,
        ...(requested ? { exemptions: requested } : {}),
      }).tables.find((table) => table.table === 'example')?.coverage
    // A proposed entry passed by the caller never authorizes, and no file means no authority.
    expect(coverage('proposed-only', [entry])).toBe('missing')
    const approved = {
      ...entry,
      status: 'approved' as const,
      approvedBy: 'user' as const,
      approvedAt: '2026-10-31',
    }
    writeFileSync(
      join(f.root, 'exemptions.json'),
      JSON.stringify({ formatVersion: 1, entries: [approved] }),
    )
    expect(coverage('approved')).toBe('exempt')
    // Narrowing to an entry that is not in the approved file removes the authority.
    expect(coverage('narrowed', [{ ...approved, reason: 'different' }])).toBe('missing')
    writeFileSync(
      join(f.root, 'exemptions.json'),
      JSON.stringify({
        formatVersion: 1,
        entries: [{ ...approved, build: 'another-build', buildKeys: ['another-build'] }],
      }),
    )
    expect(coverage('other-build')).toBe('missing')
  })

  test('content checks exact bytes, rejects traversal, and does not overwrite', () => {
    const home = temporary(),
      db = new Database(':memory:')
    const bytes = '\ufeffReport\r\n'
    const document = {
      ...seed([]),
      content: [{ path: 'reports/a.md', utf8: bytes, sha256: sha256(bytes) }],
    }
    try {
      insertSeed(db, document, home)
      expect(readFileSync(join(home, 'reports/a.md'), 'utf8')).toBe(bytes)
      expect(() =>
        insertSeed(
          db,
          { ...document, content: [{ path: '../outside', utf8: '', sha256: sha256('') }] },
          home,
        ),
      ).toThrow('escapes home')
      expect(() =>
        insertSeed(
          db,
          {
            ...document,
            content: [{ path: 'reports/a.md', utf8: 'changed', sha256: sha256('changed') }],
          },
          home,
        ),
      ).toThrow('Conflicting content')
    } finally {
      db.close()
    }
  })

  test('logical cells preserve binary and integer precision', () => {
    expect(sqliteValue({ $bigint: '9007199254740993' }, '/tmp')).toBe(9007199254740993n)
    expect(sqliteValue({ $bytes: 'AP8=' }, '/tmp')).toEqual(Buffer.from([0, 255]))
    expect(() => sqliteValue({ $bytes: 'not base64' }, '/tmp')).toThrow('Non-canonical base64')
    expect(sqliteValue('<AW_HOME>/runs/a', '/tmp/home')).toBe('/tmp/home/runs/a')
    const home = '/tmp/quoted"home'
    expect(sqliteValue('{ "path" : "<AW_HOME>/a" }', home)).toBe(
      '{ "path" : "/tmp/quoted\\"home/a" }',
    )
    expect(() => sqliteValue({ arbitrary: 'json' }, '/tmp')).toThrow('Unsupported logical value')
  })

  test('derive projects onto creation-time columns and stays an unaccepted draft', () => {
    const root = temporary(),
      release = readRegistry().releases.find((entry) => entry.epoch1)!
    const receipt = release.epoch1!.sqlite[0]!
    const rows =
      JSON.stringify({
        id: 'historical',
        status: 'done',
        name: 'column introduced later',
        future_column: 123,
      }) + '\n'
    writeFileSync(join(root, 'tasks.jsonl'), rows)
    writeFileSync(
      join(root, 'dataset.json'),
      JSON.stringify({
        formatVersion: 1,
        tag: 'v0.19.2',
        valueEncoding: 'json-with-tagged-bigint-bytes-timestamp-v1',
        tables: [
          { schema: 'main', name: 'tasks', file: 'tasks.jsonl', rowCount: 1, sha256: sha256(rows) },
        ],
      }),
    )
    const draft = deriveSeed({ dataset: root, release, migration: receipt.tag, tables: ['tasks'] })
    expect(draft.rows[0]?.values).toEqual({ id: 'historical', status: 'done' })
    const output = join(root, 'draft.json')
    writeFileSync(output, JSON.stringify(draft))
    expect(() => readSeed(output, 1, receipt.tag)).toThrow('Review and curate')
    writeFileSync(join(root, 'tasks.jsonl'), rows + '{}\n')
    expect(() => deriveSeed({ dataset: root, release, migration: receipt.tag })).toThrow(
      'Recording hash mismatch',
    )
  })

  test('every registry release must belong to exactly one build', () => {
    const registry = readRegistry()
    const invalid: ReleaseRegistry = { ...registry, l1Builds: [] }
    expect(() => checkSeedLedger(invalid)).toThrow('omitted from build matrix')
  })

  test('native history digest mismatch fails before insertion', () => {
    const release = structuredClone(readRegistry().releases.find((entry) => entry.epoch2)!)
    release.epoch2!.sqlitePlanDigest = 'sha256:wrong'
    const report = buildSeedDatabase(release, join(temporary(), 'home'), {
      seeds: join(FIXTURES, 'seeds'),
    })
    expect(report.failures[0]?.detail).toContain('History artifact digest mismatch')
    expect(report.tables).toEqual([])
  })
})
