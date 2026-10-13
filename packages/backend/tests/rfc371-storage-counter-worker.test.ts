// RFC-371 CI 38429502007: the complete pending COUNT/MIN blocked the serving
// thread for 660–690ms on the 100k/3m/10m seed. Keep every row, move physical
// SQLite counting to the original readonly Worker, and retain exact decimals.
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sqliteStorageCounters } from '@/platform/persistence/storageUsage'
import { readSqliteStorageCounters } from '@/platform/persistence/sqliteStorageWorkerHost'
import { decodeDatabaseStorageCounters } from '@/platform/persistence/sqliteStorageProtocol'

function physicalCounters() {
  const directory = mkdtempSync(join(tmpdir(), 'aw-original-storage-counters-')),
    file = join(directory, 'original.sqlite'),
    db = new Database(file)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE observation_projection_changes(id TEXT PRIMARY KEY,completed INTEGER,created_at INTEGER);
    CREATE TABLE observation_projection_work(id TEXT PRIMARY KEY,completed_revision TEXT);
    CREATE TABLE observation_work_retention(id TEXT PRIMARY KEY,queued_at INTEGER);
    CREATE TABLE observation_report_leases(id TEXT PRIMARY KEY,retiring INTEGER);`)
  db.transaction(() => {
    const change = db.query('INSERT INTO observation_projection_changes VALUES(?,?,?)')
    for (let n = 0; n < 10001; n++) change.run('pending-' + n, 0, 100 + n)
    change.run('already-complete', 1, 1)
    const work = db.query('INSERT INTO observation_projection_work VALUES(?,?)'),
      retained = db.query('INSERT INTO observation_work_retention VALUES(?,?)')
    for (let n = 0; n < 17; n++) {
      work.run('work-' + n, null)
      retained.run('work-' + n, 50 + n)
    }
    work.run('already-applied', '8')
    retained.run('already-applied', 1)
    db.query('INSERT INTO observation_report_leases VALUES(?,?)').run('active', 0)
    db.query('INSERT INTO observation_report_leases VALUES(?,?)').run('retiring', 1)
  })()
  return {
    file,
    db,
    close: () => {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

test('all >10000 pending facts, unfinished work and leases remain exact while the foreground performs only file discovery', async () => {
  const f = physicalCounters()
  try {
    let discoveries = 0,
      yielded = false
    const caller = {
      all: async () => {
        discoveries++
        if (discoveries !== 1)
          throw new Error('Original pending counts must not run on the foreground connection')
        return [{ name: 'main', file: f.file }]
      },
      get: () => {
        throw new Error('Raw ORM get returns tuple rows')
      },
    } as unknown as ProviderNeutralDatabase
    const before = f.db.query('SELECT count(*) AS n FROM observation_projection_changes').get()
    const heartbeat = new Promise<void>((resolve) =>
      setTimeout(() => {
        yielded = true
        resolve()
      }, 0),
    )
    const pending = sqliteStorageCounters(caller)
    await heartbeat
    expect(yielded).toBe(true)
    expect(await pending).toEqual({
      pending: '10018',
      oldestPendingAt: 50,
      activeReports: '1',
      retiringReports: '1',
    })
    expect(discoveries).toBe(1)
    expect(f.db.query('SELECT count(*) AS n FROM observation_projection_changes').get()).toEqual(
      before,
    )
    expect(f.db.query('SELECT count(*) AS n FROM observation_projection_work').get()).toEqual({
      n: 18,
    })
  } finally {
    f.close()
  }
})

test('an aborted or missing original file never yields invented zero counts or creates a replacement', async () => {
  const f = physicalCounters()
  try {
    const control = new AbortController(),
      pending = readSqliteStorageCounters(f.file, control.signal)
    control.abort(new DOMException('Original counter cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const absent = f.file + '.missing.sqlite'
    await expect(readSqliteStorageCounters(absent)).rejects.toThrow()
    expect(existsSync(absent)).toBe(false)
    expect(
      f.db
        .query('SELECT count(*) AS n FROM observation_projection_changes WHERE completed=0')
        .get(),
    ).toEqual({ n: 10001 })
  } finally {
    f.close()
  }
})

test('native decimal aggregates above IEEE754 precision combine without loss and incomplete rows fail explicitly', () => {
  expect(
    decodeDatabaseStorageCounters(
      { pending: '9007199254740993', oldest: '1790985600000' },
      { pending: '17', oldest: null },
      { active: '9007199254740995', retiring: '2' },
    ),
  ).toEqual({
    pending: '9007199254741010',
    oldestPendingAt: 1790985600000,
    activeReports: '9007199254740995',
    retiringReports: '2',
  })
  expect(() =>
    decodeDatabaseStorageCounters(
      undefined,
      { pending: '0', oldest: null },
      { active: '0', retiring: '0' },
    ),
  ).toThrow('missing')
  expect(() =>
    decodeDatabaseStorageCounters(
      { pending: '-1', oldest: null },
      { pending: '0', oldest: null },
      { active: '0', retiring: '0' },
    ),
  ).toThrow('invalid')
  expect(() =>
    decodeDatabaseStorageCounters(
      { pending: '0', oldest: '9007199254740993' },
      { pending: '0', oldest: null },
      { active: '0', retiring: '0' },
    ),
  ).toThrow('clock')
})
