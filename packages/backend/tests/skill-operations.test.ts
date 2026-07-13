// RFC-170 §6a — skill_operations / skill_operation_locks primitive layer.
//
// Locks in the two-phase-commit invariants:
//   - beginOperation writes phase='intent'+active=1 AND acquires locks same-tx;
//   - the UNIVERSAL exclusion is the locks table, NOT the ops partial-unique —
//     a replace locking old+new must exclude a single-id op on the NEW id, which
//     the ops-table `(skill_id) WHERE active=1` cannot (its row's skill_id=old).
//     G6-2 was the round-6 finding; the cross-id test below locks it in.
//   - locks live until finishOperation (done), released same-tx; abandon also
//     releases; boot GCs orphan locks only after active-op recovery.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { eq } from 'drizzle-orm'
import { dbTxSync } from '../src/db/txSync'
import { skillOperationLocks, skillOperations } from '../src/db/schema'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
  gcOrphanLocks,
  getActiveOp,
  listActiveOps,
} from '../src/services/skillOperations'
import { ConflictError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('skillOperations primitives', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  function begin(spec: Parameters<typeof beginOperation>[1]): string {
    return dbTxSync(db, (tx) => beginOperation(tx, spec))
  }
  function locksFor(skillId: string): number {
    return db
      .select()
      .from(skillOperationLocks)
      .all()
      .filter((l) => l.lockedSkillId === skillId).length
  }

  test('beginOperation records intent + acquires a lock', () => {
    const skillId = ulid()
    const opId = begin({ skillId, kind: 'delete' })
    const op = getActiveOp(db, skillId)
    expect(op?.opId).toBe(opId)
    expect(op?.phase).toBe('intent')
    expect(op?.active).toBe(1)
    expect(locksFor(skillId)).toBe(1)
  })

  test('a second op on a locked skill is rejected as busy (ConflictError)', () => {
    const skillId = ulid()
    begin({ skillId, kind: 'delete' })
    expect(() => begin({ skillId, kind: 'version-write' })).toThrow(ConflictError)
    // The failed begin rolled back — still exactly one active op + one lock.
    expect(listActiveOps(db).filter((o) => o.skillId === skillId)).toHaveLength(1)
    expect(locksFor(skillId)).toBe(1)
  })

  test('G6-2: a two-id op (nextSkillId) locks both ids; a single-id op on the NEW id is excluded', () => {
    const oldId = ulid()
    const newId = ulid()
    // RFC-178: the two-id lock capability is retained (dormant — the `replace` op
    // that used it was removed); exercise it here with a valid kind + nextSkillId.
    begin({ skillId: oldId, kind: 'reserve', nextSkillId: newId })
    expect(locksFor(oldId)).toBe(1)
    expect(locksFor(newId)).toBe(1)
    // A delete whose OWN skill_id is newId — the ops partial-unique (keyed on the
    // op row's skill_id = oldId) would NOT catch this; only the lock on newId does.
    expect(() => begin({ skillId: newId, kind: 'delete' })).toThrow(ConflictError)
  })

  test('advancePhase moves the phase + persists a fingerprint patch', () => {
    const skillId = ulid()
    const opId = begin({ skillId, kind: 'version-write' })
    dbTxSync(db, (tx) =>
      advancePhase(tx, opId, 'fs-versioned', {
        candidateFingerprint: 'sha256:abc',
        targetVersion: 2,
      }),
    )
    const op = getActiveOp(db, skillId)
    expect(op?.phase).toBe('fs-versioned')
    expect(op?.candidateFingerprint).toBe('sha256:abc')
    expect(op?.targetVersion).toBe(2)
  })

  test('advancePhase on an absent/inactive op throws ValidationError', () => {
    expect(() => dbTxSync(db, (tx) => advancePhase(tx, ulid(), 'fs-staged'))).toThrow(
      ValidationError,
    )
  })

  test('finishOperation → done + inactive + locks released', () => {
    const skillId = ulid()
    const opId = begin({ skillId, kind: 'reserve' })
    dbTxSync(db, (tx) => finishOperation(tx, opId))
    expect(getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
    // A fresh op on the same skill now succeeds (lock freed).
    expect(() => begin({ skillId, kind: 'delete' })).not.toThrow()
  })

  test('abandonOperation (rollback) → inactive + locks released', () => {
    const skillId = ulid()
    const opId = begin({ skillId, kind: 'delete' })
    dbTxSync(db, (tx) => abandonOperation(tx, opId))
    expect(getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
  })

  test('gcOrphanLocks removes locks whose op is done, keeps active op locks', () => {
    const liveSkill = ulid()
    const doneSkill = ulid()
    begin({ skillId: liveSkill, kind: 'delete' })
    const doneOp = begin({ skillId: doneSkill, kind: 'reserve' })
    // Simulate a crash that flipped the op inactive but left a stale lock behind
    // (bypassing finishOperation's same-tx release).
    db.update(skillOperations)
      .set({ active: 0, phase: 'done' })
      .where(eq(skillOperations.opId, doneOp))
      .run()
    expect(locksFor(doneSkill)).toBe(1) // stale lock still present pre-GC

    const removed = dbTxSync(db, (tx) => gcOrphanLocks(tx))
    expect(removed).toBe(1)
    expect(locksFor(doneSkill)).toBe(0) // orphan GC'd
    expect(locksFor(liveSkill)).toBe(1) // active op's lock untouched
  })
})
