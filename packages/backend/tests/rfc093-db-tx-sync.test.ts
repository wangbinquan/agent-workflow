// RFC-093 (audit S-10, WP-7) — dbTxSync primitive locks.
//
// What this locks in:
//   1. dbTxSync commits a synchronous body atomically.
//   2. A throw anywhere in the body rolls back EVERYTHING (the property the
//      old `db.transaction(async …)` form silently lacked — see the behavior
//      proof in scheduler-audit-s10-async-transaction-decorative.test.ts).
//   3. A runtime-smuggled async callback (cast past the type system) throws
//      loudly AND rolls back — it can never half-commit.
//   4. The type system rejects async callbacks outright (@ts-expect-error).
//   5. Red/green contrast for the review.ts three-step retire sequence
//      (delete comments → flip decision → stamp provenance): with dbTxSync a
//      step-3 failure leaves steps 1-2 fully rolled back. The async-form
//      half-commit counterpart is locked in the S-10 behavior-proof file;
//      the two files cross-reference each other.
//
// The five rewritten call sites (review/memory×2/plugin/mcp) keep their
// behavior nets in the existing memory/plugin/mcp/review suites; this file
// only owns the primitive.

import { inheritDatabaseHandle } from '@/platform/persistence/sessionTables'
import { schemaFixtureDb } from './helpers/schemaFixture'
import { insertOne } from '@/platform/persistence/singleInsert'
import { queryWrite, queryRows, rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq, sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { dbTxSync } from '../src/db/txSync'
import type { DbClient } from '../src/db/client'

const docs = sqliteTable('docs', {
  id: integer('id').primaryKey(),
  decision: text('decision').notNull(),
  consumed: text('consumed'),
})
const comments = sqliteTable('comments', {
  id: integer('id').primaryKey(),
  docId: integer('doc_id').notNull(),
  body: text('body').notNull(),
})

function makeDb(): { raw: Database; db: DbClient } {
  const raw = new Database(':memory:')
  raw.exec(
    'CREATE TABLE docs (id INTEGER PRIMARY KEY, decision TEXT NOT NULL, consumed TEXT);' +
      'CREATE TABLE comments (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, body TEXT NOT NULL);',
  )
  // The schemaless drizzle instance is structurally compatible with DbClient
  // for transaction purposes; the cast keeps the test self-contained instead
  // of dragging the full app schema in.
  return { raw, db: inheritDatabaseHandle(drizzle(raw), schemaFixtureDb()) as unknown as DbClient }
}

describe('RFC-093 dbTxSync — the sanctioned synchronous transaction primitive', () => {
  test('commits a synchronous body atomically and returns its value', () => {
    const { db } = makeDb()
    const out = dbTxSync(db, (tx) => {
      insertOne(tx, docs, { id: 1, decision: 'pending' })
      insertOne(tx, comments, { id: 1, docId: 1, body: 'c1' })
      return queryRows(tx.select().from(docs)).length
    })
    expect(out).toBe(1)
    expect(queryRows(db.select().from(comments))).toHaveLength(1)
  })

  test('a throw mid-body rolls back every prior statement', () => {
    const { db } = makeDb()
    insertOne(db, docs, { id: 1, decision: 'pending' })
    expect(() =>
      dbTxSync(db, (tx) => {
        queryWrite(tx.update(docs).set({ decision: 'superseded' }).where(eq(docs.id, 1)))
        insertOne(tx, comments, { id: 9, docId: 1, body: 'orphan' })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(queryRows(db.select().from(docs))[0]!.decision).toBe('pending')
    expect(queryRows(db.select().from(comments))).toHaveLength(0)
  })

  test('runtime guard: a smuggled async callback throws AND rolls back (never half-commits)', () => {
    const { raw, db } = makeDb()
    const smuggled = (async (tx: Parameters<Parameters<typeof dbTxSync>[1]>[0]) => {
      // Statement issued synchronously before the first await — exactly the
      // shape that half-commits under `db.transaction(async …)`.
      insertOne(tx, docs, { id: 1, decision: 'pending' })
    }) as unknown as Parameters<typeof dbTxSync>[1]
    expect(() => dbTxSync(db, smuggled)).toThrow(/dbTxSync callback returned a Promise/)
    expect(queryRows(db.select().from(docs))).toHaveLength(0)
    expect(raw.query('SELECT 1').get()).toBeTruthy() // connection still usable post-rollback
  })

  test('type guard: async callbacks do not compile', () => {
    const { db } = makeDb()
    void ((): void => {
      // @ts-expect-error — RFC-093: a Promise-returning callback collapses
      // NotPromise<T> to never; async bodies must not reach db transactions.
      dbTxSync(db, async (tx) => {
        queryRows(tx.select().from(docs))
      })
    })
  })

  test('review.ts three-step retire sequence: step-3 failure rolls steps 1-2 back (green half of the S-10 contrast)', () => {
    // Mirror of services/review.ts:505 (delete stale comments → flip pending
    // doc_versions to superseded → stamp consumed provenance). The RED half —
    // the async form COMMITting step 1-2 despite a step-3 throw — is locked in
    // scheduler-audit-s10-async-transaction-decorative.test.ts (behavior
    // proof layer).
    const { db } = makeDb()
    insertOne(db, docs, { id: 1, decision: 'pending', consumed: null })
    insertOne(db, comments, { id: 1, docId: 1, body: 'anchored' })

    expect(() =>
      dbTxSync(db, (tx) => {
        const stale = queryRows(
          tx.select({ id: docs.id }).from(docs).where(eq(docs.decision, 'pending')),
        )
        for (const s of stale) {
          queryWrite(tx.delete(comments).where(eq(comments.docId, s.id)))
        }
        queryWrite(
          tx.update(docs).set({ decision: 'superseded' }).where(eq(docs.decision, 'pending')),
        )
        // Step 3 (provenance stamp) fails — e.g. malformed SQL / constraint.
        rawExec(tx, sql`UPDATE no_such_table SET x = 1`)
      }),
    ).toThrow()

    // Atomicity: the anchored comment survives and the decision is untouched.
    expect(queryRows(db.select().from(comments))).toHaveLength(1)
    expect(queryRows(db.select().from(docs))[0]!.decision).toBe('pending')
  })
})
