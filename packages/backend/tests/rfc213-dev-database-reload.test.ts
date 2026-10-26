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
import { persistenceHead } from '@/bootstrap/persistenceHead'
import {
  registerSchemaHistoryRuntime,
  schemaHistoryRuntime,
} from '@/platform/persistence/schema/history/runtime'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-dev-database-'))
  roots.push(root)
  const migrationsFolder = join(root, 'retired-migrations')
  mkdirSync(migrationsFolder, { recursive: true })
  writeFileSync(
    join(migrationsFolder, 'do-not-replay.sql'),
    'CREATE TABLE retired_chain_must_not_run(id TEXT);',
  )
  const options: OpenDbOptions = { path: join(root, 'db.sqlite'), migrationsFolder, slowQueryMs: 0 }
  return { options }
}

test('reload admits the installed epoch-2 head without replaying the old migration folder or reinstalling receipts', () => {
  const f = fixture()
  const queries = spyOn(Database.prototype, 'query')
  try {
    const first = openDb(f.options)
    const receipts = first.$client.query('SELECT * FROM aw_meta_schema_history').all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      contract_digest: persistenceHead().contract.contract.digest,
    })
    first.$client.close()
    const second = openDb(f.options)
    expect(second.$client.query('SELECT * FROM aw_meta_schema_history').all()).toEqual(receipts)
    expect(
      second.$client
        .query(
          "SELECT name FROM sqlite_schema WHERE name IN ('__drizzle_migrations', 'retired_chain_must_not_run')",
        )
        .all(),
    ).toEqual([{ name: '__drizzle_migrations' }])
    expect(second.$client.query('SELECT hash, created_at FROM __drizzle_migrations').all()).toEqual(
      [{ hash: 'RFC395_SCHEMA_EPOCH_2_REQUIRES_TARGET_BINARY', created_at: -395 }],
    )
    expect(second.$client.query('PRAGMA foreign_keys;').get()).toEqual({ foreign_keys: 1 })
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(2)
    second.$client.close()
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
    first.$client.exec(
      "INSERT INTO maintenance_state (key,value,updated_at) VALUES ('retained','kept',1)",
    )
    first.$client.close()
    expect(preparation.validatedDatabase).toBeDefined()
    const second = openDb({ ...f.options, developmentIntegrity: preparation })
    expect(
      second.$client.query("SELECT value FROM maintenance_state WHERE key='retained'").get(),
    ).toEqual({ value: 'kept' })
    second.$client.close()
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(1)
    const cold = openDb({ ...f.options, developmentIntegrity: {} })
    cold.$client.close()
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(2)
  } finally {
    queries.mockRestore()
  }
})

test('changed native head and replaced database files invalidate development preparation', () => {
  const f = fixture()
  const preparation: NonNullable<OpenDbOptions['developmentIntegrity']> = {}
  const queries = spyOn(Database.prototype, 'query')
  const runtime = schemaHistoryRuntime()
  try {
    openDb({ ...f.options, developmentIntegrity: preparation }).$client.close()
    const head = runtime.head()
    registerSchemaHistoryRuntime({
      ...runtime,
      head: () => ({
        ...head,
        contract: {
          ...head.contract,
          digest: `sha256:${'1'.repeat(64)}`,
          contract: { ...head.contract.contract, digest: `sha256:${'0'.repeat(64)}` },
        },
      }),
    })
    expect(() => openDb({ ...f.options, developmentIntegrity: preparation })).toThrow()
    expect(preparation.validatedDatabase).toBeUndefined()
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(2)
    registerSchemaHistoryRuntime(runtime)
    openDb({ ...f.options, developmentIntegrity: preparation }).$client.close()
    renameSync(f.options.path, `${f.options.path}.old`)
    copyFileSync(`${f.options.path}.old`, f.options.path)
    openDb({ ...f.options, developmentIntegrity: preparation }).$client.close()
    expect(queries.mock.calls.filter(([sql]) => sql === 'PRAGMA quick_check;')).toHaveLength(4)
  } finally {
    registerSchemaHistoryRuntime(runtime)
    queries.mockRestore()
  }
})

test('a genuine new start still refuses header-intact page corruption after previous validation', () => {
  const f = fixture()
  const db = openDb({ ...f.options, developmentIntegrity: {} })
  const { rootpage } = db.$client
    .query("SELECT rootpage FROM sqlite_schema WHERE name='maintenance_state'")
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
