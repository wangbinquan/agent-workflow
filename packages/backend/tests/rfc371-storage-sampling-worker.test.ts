// RFC-371: physical capacity sampling must not freeze the daemon or change any stored usage.
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSqliteTableStorage } from '@/platform/persistence/sqliteStorageWorkerHost'
import { sqliteStorageUsage } from '@/platform/persistence/storageUsage'
import type { ProviderNeutralDatabase } from '@/db/query'

test('the separate readonly sampler returns every table and index byte exactly while the caller event loop continues', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aw-storage-sampling-')),
    file = join(directory, 'original.sqlite')
  const db = new Database(file)
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE observation_usage(id INTEGER PRIMARY KEY,document TEXT); CREATE INDEX usage_document ON observation_usage(document); CREATE TABLE retained_fact(id INTEGER PRIMARY KEY,document TEXT)',
    )
    db.transaction(() => {
      const insert = db.query('INSERT INTO observation_usage VALUES(?,?)')
      for (let n = 0; n < 1001; n++) insert.run(n, 'original-' + n + 'x'.repeat(200))
    })()
    db.query('INSERT INTO retained_fact VALUES(?,?)').run(1, 'original retained evidence')
    const expected = db
      .query(
        `SELECT s.tbl_name AS name,cast(sum(d.pgsize) AS text) AS bytes,cast(sum(CASE WHEN s.type='index' THEN d.pgsize ELSE 0 END) AS text) AS indexBytes FROM dbstat d JOIN sqlite_schema s ON s.name=d.name GROUP BY s.tbl_name ORDER BY s.tbl_name`,
      )
      .all()
    const before = db.query('SELECT * FROM observation_usage ORDER BY id').all()
    let yielded = false
    const heartbeat = new Promise<void>((resolve) =>
      setTimeout(() => {
        yielded = true
        resolve()
      }, 0),
    )
    const pending = readSqliteTableStorage(file)
    await heartbeat
    expect(yielded).toBe(true)
    expect(await pending).toEqual(expected)
    expect(db.query('SELECT * FROM observation_usage ORDER BY id').all()).toEqual(before)
    expect(db.query('SELECT * FROM retained_fact').all()).toEqual([
      { id: 1, document: 'original retained evidence' },
    ])
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('unreadable measurement never creates a database or falls back to its caller connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aw-storage-missing-')),
    file = join(directory, 'missing.sqlite')
  try {
    await expect(readSqliteTableStorage(file)).rejects.toThrow()
    expect(existsSync(file)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cancellation terminates the dedicated measurement and preserves the original cancellation reason', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aw-storage-cancel-')),
    file = join(directory, 'original.sqlite'),
    db = new Database(file)
  db.exec('CREATE TABLE original_fact(id INTEGER)')
  db.close()
  try {
    const stop = new AbortController(),
      reason = new DOMException('original owner stopping', 'AbortError'),
      pending = readSqliteTableStorage(file, stop.signal)
    stop.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(existsSync(file)).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an in-memory database keeps observed totals and never performs a physical dbstat scan on its serving connection', async () => {
  const reads: string[] = [],
    get = async (statement: unknown) => {
      reads.push(String(statement))
      return { page_count: 12, page_size: 4096, freelist_count: 2 }
    },
    all = async () => [{ name: 'main', file: '' }]
  const usage = await sqliteStorageUsage({ get, all } as unknown as ProviderNeutralDatabase)
  expect(usage).toMatchObject({
    databaseBytes: '49152',
    reusableBytes: '8192',
    tables: null,
    freeBytes: null,
  })
  expect(reads).toHaveLength(3)
})

test('the published binary explicitly includes the capacity Worker and the foreground sampler has no dbstat fallback', () => {
  const source = readFileSync(
    new URL('../src/platform/persistence/storageUsage.ts', import.meta.url),
    'utf8',
  )
  const build = readFileSync(new URL('../../../scripts/build-binary.ts', import.meta.url), 'utf8')
  expect(source).not.toContain('FROM dbstat')
  expect(build).toContain("join(backendSrc, 'platform', 'persistence', 'sqliteStorageWorker.ts')")
})
