// Regression coverage for the 2026-10-29 `bun dev` startup failure on Bun 1.3.13:
// the transport-projections step stopped with "cannot rollback - no transaction
// is active". Bun 1.3.x `Database.query()` prepares through the instance
// `prepare`, so the fence's own marker read came back through its read wrapper
// and re-entered `observeCommit()` until the stack overflowed after COMMIT; the
// catch block's ROLLBACK then replaced the real error. Locks in both halves: the
// observation does not re-enter, and a statement that ends the transaction
// itself keeps its own error.

import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { instrumentSlowStatements } from '@/db/client'
import { guardSqliteGenerationWrites } from '@/platform/persistence/sqliteGenerationFence'

/** The Bun 1.3.x shape: `query()` resolves `this.prepare` at call time. */
function prepareThroughInstance(db: Database): void {
  db.query = ((statement: string) => db.prepare(statement)) as typeof db.query
}

function probeTable(db: Database, trigger: string): void {
  db.exec('CREATE TABLE fence_probe (id INTEGER PRIMARY KEY)')
  db.exec(trigger)
}

test('a query entry that prepares through the instance commits without re-entering the observation', () => {
  const db = createSqliteBaseline({ generationId: 'dbg_fence_reentry' })
  const native = db.prepare.bind(db)
  prepareThroughInstance(db)
  guardSqliteGenerationWrites(db)
  const markerStatements: string[] = []
  instrumentSlowStatements(db, 0, undefined, (_ms, statement) => {
    if (statement?.includes('first_live_write_at')) markerStatements.push(statement)
  })
  try {
    db.exec('UPDATE auth_login_policy SET updated_at=1')
    expect(native('SELECT first_live_write_at FROM aw_meta_first_write').get()).toEqual({
      first_live_write_at: expect.any(Number),
    })
    // One marker check, one marker update, one post-commit read; the failure
    // ran thousands of nested reads before the stack gave out.
    expect(markerStatements.length).toBeLessThanOrEqual(3)
    db.exec('UPDATE auth_login_policy SET updated_at=2')
    expect(native('SELECT updated_at FROM auth_login_policy').get()).toEqual({ updated_at: 2 })
    expect(markerStatements.length).toBeLessThanOrEqual(3)
  } finally {
    db.close()
  }
})

test('a statement that rolls back the whole transaction keeps its own error', () => {
  const db = createSqliteBaseline({ generationId: 'dbg_fence_raise_rollback' })
  probeTable(
    db,
    "CREATE TRIGGER fence_probe_rollback BEFORE INSERT ON fence_probe BEGIN SELECT RAISE(ROLLBACK, 'fence-probe-rolled-back'); END",
  )
  guardSqliteGenerationWrites(db)
  try {
    expect(() => db.exec('INSERT INTO fence_probe (id) VALUES (1)')).toThrow(
      'fence-probe-rolled-back',
    )
    expect(db.inTransaction).toBeFalse()
    // Inside the caller's transaction the fence uses a savepoint; RAISE(ROLLBACK)
    // ends the caller's transaction as well, so there is no savepoint to undo.
    db.exec('BEGIN')
    expect(() => db.exec('INSERT INTO fence_probe (id) VALUES (2)')).toThrow(
      'fence-probe-rolled-back',
    )
    expect(db.inTransaction).toBeFalse()
    db.exec('UPDATE auth_login_policy SET updated_at=3')
    expect(db.prepare('SELECT updated_at FROM auth_login_policy').get()).toEqual({
      updated_at: 3,
    })
  } finally {
    db.close()
  }
})

test('a statement error inside the caller transaction still undoes only the fenced write', () => {
  const db = createSqliteBaseline({ generationId: 'dbg_fence_raise_abort' })
  probeTable(
    db,
    "CREATE TRIGGER fence_probe_abort BEFORE INSERT ON fence_probe WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'fence-probe-aborted'); END",
  )
  guardSqliteGenerationWrites(db)
  try {
    db.exec('BEGIN')
    db.exec('INSERT INTO fence_probe (id) VALUES (1)')
    expect(() => db.exec('INSERT INTO fence_probe (id) VALUES (2)')).toThrow('fence-probe-aborted')
    expect(db.inTransaction).toBeTrue()
    db.exec('COMMIT')
    expect(db.prepare('SELECT id FROM fence_probe').all()).toEqual([{ id: 1 }])
  } finally {
    db.close()
  }
})
