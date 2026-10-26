import {
  databaseSessionFor,
  databaseTransactionIsActive,
} from '@/platform/persistence/databaseTransaction'
import { sql } from 'drizzle-orm'
import { rawExec } from '@/platform/persistence/queryHelpers'
// RFC-395 T18 X1: frozen provider clients and inherited transaction handles retain their bindings.
import { expect, test } from 'bun:test'
import { schemaFixtureDb } from './helpers/schemaFixture'
import {
  bindDatabaseHandle,
  inheritDatabaseHandle,
  tablesOf,
  engineForHandle,
} from '@/platform/persistence/sessionTables'

test('frozen native handles and clients resolve tables through their bound provider identity', () => {
  const db = schemaFixtureDb()
  const tables = tablesOf(db)
  const engine = engineForHandle(db)
  const client = Object.freeze({})
  const handle = Object.freeze({ session: { client } })
  expect(bindDatabaseHandle(handle, tables, engine)).toBe(handle)
  expect(tablesOf(handle)).toBe(tables)
  const transaction = Object.freeze({ session: { client } })
  expect(tablesOf(transaction)).toBe(tables)
  expect(engineForHandle(transaction)).toBe(engine)
  const inherited = Object.freeze({})
  expect(inheritDatabaseHandle(inherited, transaction)).toBe(inherited)
  expect(tablesOf(inherited)).toBe(tables)
  expect(engineForHandle(inherited)).toBe(engine)
})

test('a re-bound frozen client uses its explicit context without changing its properties', () => {
  const db = schemaFixtureDb()
  const client = {}
  const handle = { session: { client } }
  const tables = tablesOf(db)
  const engine = engineForHandle(db)
  bindDatabaseHandle(handle, tables, engine)
  Object.freeze(handle)
  Object.freeze(client)
  expect(() => bindDatabaseHandle(handle, tables, engine)).not.toThrow()
  expect(tablesOf({ session: { client } })).toBe(tables)
})

test('proxy and original SQLite handles share one transaction and roll back together', async () => {
  const db = schemaFixtureDb()
  db.run(sql.raw('CREATE TABLE x1_transaction_probe (value INTEGER NOT NULL)'))
  const proxy = new Proxy(db, {})
  try {
    await expect(
      databaseSessionFor(proxy).transaction(async () => {
        expect(databaseTransactionIsActive(db)).toBe(true)
        await databaseSessionFor(db).transaction(async (tx) => {
          await rawExec(tx, sql.raw('INSERT INTO x1_transaction_probe VALUES (1)'))
        })
        throw new Error('rollback-proxy')
      }),
    ).rejects.toThrow('rollback-proxy')
    expect(db.all(sql.raw('SELECT value FROM x1_transaction_probe'))).toEqual([])
  } finally {
    db.run(sql.raw('DROP TABLE x1_transaction_probe'))
  }
})
