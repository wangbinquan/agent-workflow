// Restore normal development reloads without weakening fresh-process integrity
// or migration checks: count the real SQLite PRAGMAs and retained receipts.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DbCorruptionError, openDb, type OpenDbOptions } from '../src/db/client'
import { migrateSqlite } from '../src/platform/persistence/sqliteMigrator'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-dev-database-'))
  roots.push(root)
  const migrationsFolder = join(root, 'migrations')
  mkdirSync(join(migrationsFolder, 'meta'), { recursive: true })
  let count = 0
  const entries: Array<{
    idx: number
    version: string
    when: number
    tag: string
    breakpoints: boolean
  }> = []
  const append = (sql: string) => {
    const tag = `${String(count).padStart(4, '0')}_dev_reload`
    writeFileSync(join(migrationsFolder, `${tag}.sql`), sql)
    entries.push({ idx: count, version: '6', when: ++count, tag, breakpoints: true })
    writeFileSync(
      join(migrationsFolder, 'meta', '_journal.json'),
      JSON.stringify({ version: '6', dialect: 'sqlite', entries }),
    )
  }
  append('CREATE TABLE parent (id TEXT PRIMARY KEY);')
  const options: OpenDbOptions = {
    path: join(root, 'db.sqlite'),
    migrationsFolder,
    slowQueryMs: 0,
  }
  return { options, append }
}

test('already-applied migrations do not repeat the post-migration full foreign-key scan', () => {
  const f = fixture()
  const queries = spyOn(Database.prototype, 'query')
  try {
    const first = openDb(f.options)
    first.$client.close()
    const fkChecks = () =>
      queries.mock.calls.filter(([sql]) => sql === 'PRAGMA foreign_key_check;').length
    const integrityChecks = () =>
      queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;').length
    expect(fkChecks()).toBe(1)
    const second = openDb(f.options)
    expect(fkChecks()).toBe(1)
    expect(integrityChecks()).toBe(2)
    expect(migrateSqlite(second.$client, { migrationsFolder: f.options.migrationsFolder })).toBe(0)
    second.$client.close()
    f.append('CREATE TABLE child (parent_id TEXT REFERENCES parent(id));')
    const upgraded = openDb(f.options)
    expect(fkChecks()).toBe(2)
    expect(upgraded.$client.query('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 2,
    })
    expect(upgraded.$client.query('PRAGMA foreign_keys;').get()).toEqual({ foreign_keys: 1 })
    upgraded.$client.close()
  } finally {
    queries.mockRestore()
  }
})

test('source reload reuses this process preparation; a new process state checks again', () => {
  const f = fixture()
  const preparation: NonNullable<OpenDbOptions['developmentIntegrity']> = {}
  const queries = spyOn(Database.prototype, 'query')
  try {
    const first = openDb({ ...f.options, developmentIntegrity: preparation })
    first.$client.exec("INSERT INTO parent VALUES ('retained')")
    first.$client.close()
    expect(preparation.validatedDatabase).toBeDefined()
    const second = openDb({ ...f.options, developmentIntegrity: preparation })
    expect(second.$client.query('SELECT id FROM parent').get()).toEqual({ id: 'retained' })
    second.$client.close()
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(1)
    const cold = openDb({ ...f.options, developmentIntegrity: {} })
    cold.$client.close()
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(2)
  } finally {
    queries.mockRestore()
  }
})

test('changed migration journals and replaced database files invalidate development preparation', () => {
  const f = fixture()
  const preparation: NonNullable<OpenDbOptions['developmentIntegrity']> = {}
  const queries = spyOn(Database.prototype, 'query')
  try {
    openDb({ ...f.options, developmentIntegrity: preparation }).$client.close()
    f.append('CREATE TABLE child (parent_id TEXT REFERENCES parent(id));')
    openDb({ ...f.options, developmentIntegrity: preparation }).$client.close()
    renameSync(f.options.path, `${f.options.path}.old`)
    copyFileSync(`${f.options.path}.old`, f.options.path)
    openDb({ ...f.options, developmentIntegrity: preparation }).$client.close()
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(3)
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA foreign_key_check;')).toHaveLength(
      2,
    )
  } finally {
    queries.mockRestore()
  }
})

test('a genuine new start still refuses header-intact page corruption after previous validation', () => {
  const f = fixture()
  const db = openDb({ ...f.options, developmentIntegrity: {} })
  const { rootpage } = db.$client
    .query("SELECT rootpage FROM sqlite_schema WHERE name='parent'")
    .get() as { rootpage: number }
  db.$client.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.$client.close()
  const bytes = readFileSync(f.options.path)
  const encoded = bytes.readUInt16BE(16)
  bytes[(rootpage - 1) * (encoded === 1 ? 65_536 : encoded)] = 0xff
  writeFileSync(f.options.path, bytes)
  const preparation: NonNullable<OpenDbOptions['developmentIntegrity']> = {}
  expect(() => openDb({ ...f.options, developmentIntegrity: preparation })).toThrow(
    DbCorruptionError,
  )
  expect(preparation.validatedDatabase).toBeUndefined()
})
