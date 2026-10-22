// RFC-395 I-b: native query helpers preserve sync execution, row codecs and write counts on both providers.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { createInMemoryDb } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  affectedRows,
  decodeRawValue,
  first,
  queryRows,
  rawExec,
  rawFirst,
  rawRows,
} from '@/platform/persistence/queryHelpers'
import {
  driveSyncProgram,
  executeTransactionStepSync,
  transactionStep,
} from '@/platform/persistence/transactionProgram'
import { describeEachProvider } from './helpers/eachProvider'
import { MIGRATIONS } from './migration-freeze'

const row = (id: string) => ({ id, username: id, displayName: id, createdAt: 1, updatedAt: 1 })

describe('RFC-395 I-b raw contract codecs', () => {
  test('semantic codecs decode both native representations without guessing from field names', () => {
    for (const value of [0, false]) expect(decodeRawValue('bool', value, 'flag')).toBe(false)
    for (const value of [1, true]) expect(decodeRawValue('bool', value, 'flag')).toBe(true)
    for (const value of ['1788278410000', 1788278410000])
      expect(decodeRawValue('epochMs', value, 'time')).toBe(1788278410000)
    expect(decodeRawValue('int', null, 'nullable')).toBeNull()
    expect(decodeRawValue('real', '0.25', 'ratio')).toBe(0.25)
    expect(decodeRawValue('bigint', '9223372036854775807', 'large')).toBe(9223372036854775807n)
    expect(decodeRawValue('jsonText', '{"n":1}', 'text')).toBe('{"n":1}')
    expect(decodeRawValue('jsonDoc', '{"n":1}', 'document')).toEqual({ n: 1 })
    for (const value of ['true', 2, 'abc'])
      expect(() => decodeRawValue('bool', value, 'flag')).toThrow('flag')
    for (const value of ['9007199254740992', 'abc', 1.5])
      expect(() => decodeRawValue('int', value, 'count')).toThrow('count')
    expect(() => decodeRawValue({ codec: 'text', nullable: false }, null, 'required')).toThrow(
      'required',
    )
  })

  test('write counts accept only valid native affected-row counts', () => {
    expect(affectedRows({ changes: 2 })).toBe(2)
    expect(affectedRows(Object.assign([], { count: 3 }))).toBe(3)
    for (const result of [null, undefined, {}, { count: -1 }, { changes: '1' }, { count: NaN }])
      expect(affectedRows(result)).toBe(0)
  })

  test('the synchronous transaction-program driver still observes writes immediately', () => {
    const db = createInMemoryDb(MIGRATIONS)
    try {
      function* program() {
        const result = yield* transactionStep(() => {
          const { users } = tablesOf(db)
          return insertOne(db, users, row('sync-helper'))
        })
        expect(affectedRows(result)).toBe(1)
        const rows = yield* transactionStep(() => {
          const { users } = tablesOf(db)
          return queryRows(db.select().from(users).where(eq(users.id, 'sync-helper')))
        })
        return rows[0]
      }
      expect(dbTxSync(db, () => driveSyncProgram(program(), executeTransactionStepSync))?.id).toBe(
        'sync-helper',
      )
    } finally {
      db.$client.close()
    }
  })
})

describeEachProvider('RFC-395 I-b native query helper parity', (h) => {
  test('raw object rows apply codecs and empty rawFirst is undefined', async () => {
    const query = sql`select 1788278410000 as moment, true as enabled, 0.25 as ratio, null as absent`
    const codecs = { moment: 'epochMs', enabled: 'bool', ratio: 'real', absent: 'int' } as const
    const rows = await rawRows<{
      moment: number
      enabled: boolean
      ratio: number
      absent: number | null
    }>(h.db, query, codecs)
    expect(rows).toEqual([{ moment: 1788278410000, enabled: true, ratio: 0.25, absent: null }])
    expect(await rawFirst(h.db, sql`select 1 as n where 1 = 0`, { n: 'int' })).toBeUndefined()
  })

  test('first bounds selects, preserves empty results and does not truncate RETURNING mutations', async () => {
    const { users } = tablesOf(h.db)
    await h.db.insert(users).values([row('helper-a'), row('helper-b')])
    const recording = h.recordStatements()
    try {
      expect((await first(h.db.select().from(users).orderBy(users.id)))?.id).toBeDefined()
      expect(recording.selects().at(-1)?.sql.toLowerCase()).toContain('limit')
      expect(recording.selects().at(-1)?.rows).toBe(1)
    } finally {
      recording.stop()
    }
    expect(
      await first(h.db.select().from(users).where(eq(users.id, 'missing-helper'))),
    ).toBeUndefined()
    const returned = await first(
      h.db
        .update(users)
        .set({ displayName: 'changed' })
        .where(sql`${users.id} in ('helper-a', 'helper-b')`)
        .returning({ id: users.id }),
    )
    expect(returned?.id).toBeDefined()
    const changed = await h.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.displayName, 'changed'))
    expect(changed).toHaveLength(2)
  })

  test('native and raw mutation results count direct changes consistently', async () => {
    const { users } = tablesOf(h.db)
    expect(affectedRows(await insertOne(h.db, users, row('helper-count')))).toBe(1)
    expect(
      affectedRows(
        await rawExec(
          h.db,
          sql`update ${users} set display_name = 'updated' where ${users.id} = 'helper-count'`,
        ),
      ),
    ).toBe(1)
    // Bun.SQL's begin() passes an array result through Promise.all: a standalone write (fenced in its
    // own transaction) and a transaction body returning its mutation result must keep the count.
    expect(
      affectedRows(
        await h.db.update(users).set({ displayName: 'fenced' }).where(eq(users.id, 'helper-count')),
      ),
    ).toBe(1)
    expect(
      affectedRows(
        await h.session.transaction(
          async (tx) =>
            await tx
              .update(users)
              .set({ displayName: 'in-transaction' })
              .where(eq(users.id, 'helper-count')),
        ),
      ),
    ).toBe(1)
    expect(affectedRows(await h.db.delete(users).where(eq(users.id, 'helper-count')))).toBe(1)
    expect(affectedRows(await h.db.delete(users).where(eq(users.id, 'helper-count')))).toBe(0)
  })
})
