// RFC-371: only a continuously open connection proves unchanged native numeric pages.
// Real external SQLite commits must invalidate same-count/same-ID and late usage, too.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeNativeVersionObserver } from '../src/modules/runtime-management/infrastructure/opencodeNativeVersionObserver'
import { createHistoricalNativeVersionObserver } from '../src/modules/runtime-management/composition/historicalNativeVersion'
import { openReadonlySqliteDatabase } from '../src/platform/persistence/sqlite/readonlySqliteDatabase'
import type { HistoricalNativeVersionObserver } from '../src/modules/runtime-management/public/participants'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture(missing = false) {
  const directory = mkdtempSync(join(tmpdir(), 'aw-native-version-')),
    path = join(directory, 'original.db')
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const writers = new WeakMap<Database, () => void>()
  const create = (filename = path) => {
    const writer = new Database(filename)
    writer.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);
      CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
      INSERT INTO session VALUES ('root',NULL,1);
      INSERT INTO part VALUES ('part','root','{"input":1}');`)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      writer.close()
    }
    writers.set(writer, close)
    cleanups.push(close)
    return writer
  }
  const writer = missing ? undefined : create()
  const calls = { open: 0, close: 0, statements: [] as string[], handles: [] as Array<() => void> }
  const observer: HistoricalNativeVersionObserver = createOpencodeNativeVersionObserver(
    path,
    (filename) => {
      calls.open++
      const db = openReadonlySqliteDatabase(filename)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        calls.close++
        db.close()
      }
      calls.handles.push(close)
      return {
        query<Row, Parameters extends readonly unknown[]>(sql: string) {
          calls.statements.push(sql)
          return db.query<Row, Parameters>(sql)
        },
        close,
      }
    },
  )
  cleanups.push(() => observer.close())
  const closeWriter = (db: Database) => writers.get(db)!()
  const move = (from: string, to: string) => {
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix)
  }
  return { directory, path, writer, create, closeWriter, move, observer, calls }
}

test('an unchanged source uses the same continuous readonly connection without BEGIN or writes', async () => {
  const { observer, calls } = fixture()
  const before = await observer.sample()
  expect(before).not.toBeNull()
  expect(await observer.sample()).toEqual(before)
  expect(calls.open).toBe(1)
  expect(calls.statements).toEqual(['PRAGMA data_version', 'PRAGMA data_version'])
  await observer.close()
  expect(calls.close).toBe(1)
  const reopened = await observer.sample()
  expect(reopened?.sourceGeneration).toBe(before?.sourceGeneration)
  expect(reopened?.connectionEpoch).not.toBe(before?.connectionEpoch)
  expect(reopened?.revisionToken).not.toBe(before?.revisionToken)
})

for (const [name, statement] of [
  ['insert', "INSERT INTO part VALUES ('late','root','{\"input\":2}')"],
  [
    'same-ID and same-count numeric revision',
    "UPDATE part SET data='{\"input\":7}' WHERE id='part'",
  ],
  ['delete', "DELETE FROM part WHERE id='part'"],
  ['DDL', 'ALTER TABLE part ADD COLUMN late_revision TEXT'],
  ['reparent', "UPDATE session SET parent_id='another-root' WHERE id='root'"],
  ['late usage', 'UPDATE part SET data=\'{"input":1,"output":9}\' WHERE id=\'part\''],
] as const)
  test(`a real external WAL ${name} invalidates the revision while retaining physical identity`, async () => {
    const { writer, observer } = fixture()
    const before = await observer.sample()
    writer!.exec(statement)
    const after = await observer.sample()
    expect(after).not.toBeNull()
    expect(after?.nativeSource).toBe(before?.nativeSource)
    expect(after?.sourceGeneration).toBe(before?.sourceGeneration)
    expect(after?.connectionEpoch).toBe(before?.connectionEpoch)
    expect(after?.revisionToken).not.toBe(before?.revisionToken)
    expect(await observer.sample()).toEqual(after)
  })

test('missing then created never reuses a prior proof', async () => {
  const { create, observer, calls } = fixture(true)
  expect(await observer.sample()).toBeNull()
  expect(calls.open).toBe(0)
  create()
  expect(await observer.sample()).not.toBeNull()
  expect(calls.open).toBe(1)
})

test('replacing the physical file closes the old connection and changes generation and epoch', async () => {
  const { directory, path, writer, create, closeWriter, move, observer, calls } = fixture()
  const before = await observer.sample()
  // Checkpoint both real writers so no old WAL can be attached to the replacement.
  writer!.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const replacement = join(directory, 'replacement.db'),
    second = create(replacement)
  second.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  closeWriter(writer!)
  closeWriter(second)
  // Windows requires releasing the real OS handle before file replacement. The
  // observer still retains the old generation/epoch and must discard that entry.
  if (process.platform === 'win32') calls.handles[0]!()
  move(path, join(directory, 'old.db'))
  move(replacement, path)
  const after = await observer.sample()
  expect(after?.sourceGeneration).not.toBe(before?.sourceGeneration)
  expect(after?.connectionEpoch).not.toBe(before?.connectionEpoch)
  expect(calls.open).toBe(2)
  expect(calls.close).toBe(1)
})

test('a missing previously open file destroys its epoch; recreate gets another proof', async () => {
  const { directory, path, writer, create, closeWriter, move, observer, calls } = fixture()
  const before = await observer.sample()
  writer!.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  closeWriter(writer!)
  if (process.platform === 'win32') calls.handles[0]!()
  move(path, join(directory, 'removed.db'))
  expect(await observer.sample()).toBeNull()
  expect(calls.close).toBe(1)
  create()
  const after = await observer.sample()
  expect(after?.sourceGeneration).not.toBe(before?.sourceGeneration)
  expect(after?.connectionEpoch).not.toBe(before?.connectionEpoch)
})

test('serialized samples and close cannot reopen the old epoch during teardown', async () => {
  const { observer, calls } = fixture()
  const first = observer.sample(),
    second = observer.sample(),
    closing = observer.close()
  expect(await second).toEqual(await first)
  await closing
  expect(calls.close).toBe(1)
  expect((await observer.sample())?.connectionEpoch).not.toBe((await first)?.connectionEpoch)
})

test('a disabled original native path has no connection or invented zero proof', async () => {
  const observer = createOpencodeNativeVersionObserver(null)
  expect(await observer.sample()).toBeNull()
  await observer.close()
})

test('changing the original environment path destroys its previous connection proof', async () => {
  const { directory, path, create } = fixture()
  const other = join(directory, 'second-source.db')
  create(other)
  const env = { OPENCODE_DB: path }
  const observer = createHistoricalNativeVersionObserver(env)
  cleanups.push(() => observer.close())
  const first = await observer.sample()
  env.OPENCODE_DB = other
  const second = await observer.sample()
  expect(second?.nativeSource).not.toBe(first?.nativeSource)
  expect(second?.sourceGeneration).not.toBe(first?.sourceGeneration)
  expect(second?.connectionEpoch).not.toBe(first?.connectionEpoch)
  env.OPENCODE_DB = path
  const again = await observer.sample()
  expect(again?.nativeSource).toBe(first?.nativeSource)
  expect(again?.sourceGeneration).toBe(first?.sourceGeneration)
  expect(again?.connectionEpoch).not.toBe(first?.connectionEpoch)
  env.OPENCODE_DB = ':memory:'
  expect(await observer.sample()).toBeNull()
})
