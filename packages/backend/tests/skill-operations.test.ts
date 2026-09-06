// RFC-170 §6a — skill_operations / skill_operation_locks primitive layer.
//
// Locks in the two-phase-commit invariants:
//   - beginOperation writes phase='intent'+active=1 AND acquires locks same-tx;
//   - the UNIVERSAL exclusion is the locks table; RFC-279 removed the retired
//     two-id slot, so every current op acquires exactly its primary skill lock;
//   - locks live until finishOperation (done), released same-tx; abandon also
//     releases; boot GCs orphan locks only after active-op recovery.

import { describe, expect, test, beforeEach } from 'bun:test'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { eq } from 'drizzle-orm'
import { skillOperationLocks, skillOperations } from '../src/db/schema'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
  gcOrphanLocks,
  getActiveOp,
  listActiveOps,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { ConflictError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('skillOperations primitives', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  async function begin(spec: Parameters<typeof beginOperation>[1]): Promise<string> {
    return await databaseSessionFor(db).transaction(async (tx) => await beginOperation(tx, spec))
  }
  function locksFor(skillId: string): number {
    return db
      .select()
      .from(skillOperationLocks)
      .all()
      .filter((l) => l.lockedSkillId === skillId).length
  }

  test('beginOperation records intent + acquires a lock', async () => {
    const skillId = ulid()
    const opId = await begin({ skillId, kind: 'delete' })
    const op = await getActiveOp(db, skillId)
    expect(op?.opId).toBe(opId)
    expect(op?.phase).toBe('intent')
    expect(op?.active).toBe(1)
    expect(locksFor(skillId)).toBe(1)
  })

  test('a second op on a locked skill is rejected as busy (ConflictError)', async () => {
    const skillId = ulid()
    await begin({ skillId, kind: 'delete' })
    await expect(begin({ skillId, kind: 'version-write' })).rejects.toThrow(ConflictError)
    // The failed begin rolled back — still exactly one active op + one lock.
    expect((await listActiveOps(db)).filter((o) => o.skillId === skillId)).toHaveLength(1)
    expect(locksFor(skillId)).toBe(1)
  })

  test('advancePhase moves the phase + persists a fingerprint patch', async () => {
    const skillId = ulid()
    const opId = await begin({ skillId, kind: 'version-write' })
    await databaseSessionFor(db).transaction(
      async (tx) =>
        await advancePhase(tx, opId, 'fs-versioned', {
          candidateFingerprint: 'sha256:abc',
          targetVersion: 2,
        }),
    )
    const op = await getActiveOp(db, skillId)
    expect(op?.phase).toBe('fs-versioned')
    expect(op?.candidateFingerprint).toBe('sha256:abc')
    expect(op?.targetVersion).toBe(2)
  })

  test('advancePhase on an absent/inactive op throws ValidationError', async () => {
    await expect(
      databaseSessionFor(db).transaction(async (tx) => await advancePhase(tx, ulid(), 'fs-staged')),
    ).rejects.toThrow(ValidationError)
  })

  test('finishOperation → done + inactive + locks released', async () => {
    const skillId = ulid()
    const opId = await begin({ skillId, kind: 'reserve' })
    await databaseSessionFor(db).transaction(async (tx) => await finishOperation(tx, opId))
    expect(await getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
    // A fresh op on the same skill now succeeds (lock freed).
    await expect(begin({ skillId, kind: 'delete' })).resolves.toBeDefined()
  })

  test('abandonOperation (rollback) → inactive + locks released', async () => {
    const skillId = ulid()
    const opId = await begin({ skillId, kind: 'delete' })
    await databaseSessionFor(db).transaction(async (tx) => await abandonOperation(tx, opId))
    expect(await getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
  })

  test('gcOrphanLocks removes locks whose op is done, keeps active op locks', async () => {
    const liveSkill = ulid()
    const doneSkill = ulid()
    await begin({ skillId: liveSkill, kind: 'delete' })
    const doneOp = await begin({ skillId: doneSkill, kind: 'reserve' })
    // Simulate a crash that flipped the op inactive but left a stale lock behind
    // (bypassing finishOperation's same-tx release).
    db.update(skillOperations)
      .set({ active: 0, phase: 'done' })
      .where(eq(skillOperations.opId, doneOp))
      .run()
    expect(locksFor(doneSkill)).toBe(1) // stale lock still present pre-GC

    const removed = await databaseSessionFor(db).transaction(async (tx) => await gcOrphanLocks(tx))
    expect(removed).toBe(1)
    expect(locksFor(doneSkill)).toBe(0) // orphan GC'd
    expect(locksFor(liveSkill)).toBe(1) // active op's lock untouched
  })
})
