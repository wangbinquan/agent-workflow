// RFC-170 §6a / T-BOOT — boot recovery driver orchestration.
//
// Uses the real op primitives (beginOperation/advancePhase) to plant crashed
// ops at chosen (kind, phase) states, then asserts the driver dispatches each to
// the right terminal via recoveryDirection: pre-db-committed → rollbackFs +
// abandon (lock freed); ≥ db-committed → rollForwardFs + finish (lock freed);
// impossible phase → quarantine (skill version_state) + retire; missing handler
// → lock freed + counted; orphan locks GC'd last.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { skills, skillOperationLocks } from '../src/db/schema'
import { advancePhase, beginOperation, getActiveOp } from '../src/services/skillOperations'
import {
  recoverSkillOperations,
  type OpRecoveryRegistry,
} from '../src/services/skillOpRecoveryDriver'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FS = { appHome: '/tmp/aw-recovery-driver-noop' } // handlers here are spies; no real FS

describe('recoverSkillOperations — boot driver', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  function seedSkill(name: string): string {
    const id = ulid()
    db.insert(skills)
      .values({ id, name, sourceKind: 'managed', managedPath: `skills/${name}/files` })
      .run()
    return id
  }
  function locksFor(skillId: string): number {
    return db
      .select()
      .from(skillOperationLocks)
      .all()
      .filter((l) => l.lockedSkillId === skillId).length
  }
  function plant(
    skillId: string,
    kind: Parameters<typeof beginOperation>[1]['kind'],
    phase: string,
  ) {
    const opId = dbTxSync(db, (tx) => beginOperation(tx, { skillId, kind }))
    if (phase !== 'intent') dbTxSync(db, (tx) => advancePhase(tx, opId, phase as never))
    return opId
  }

  test('pre-db-committed op → rollbackFs called, op abandoned, lock freed', () => {
    const skillId = seedSkill('rb')
    const opId = plant(skillId, 'version-write', 'fs-staged')
    const calls: string[] = []
    const registry: OpRecoveryRegistry = {
      'version-write': { rollbackFs: (_f, op) => calls.push(`rb:${op.opId}`) },
    }
    const rep = recoverSkillOperations(db, FS, registry)
    expect(calls).toEqual([`rb:${opId}`])
    expect(getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
    expect(rep.rolledBack).toBe(1)
  })

  test('≥ db-committed op → rollForwardFs called, op finished (done), lock freed', () => {
    const skillId = seedSkill('rf')
    const opId = plant(skillId, 'version-write', 'db-committed')
    const calls: string[] = []
    const registry: OpRecoveryRegistry = {
      'version-write': { rollForwardFs: (_f, op) => calls.push(`rf:${op.opId}`) },
    }
    const rep = recoverSkillOperations(db, FS, registry)
    expect(calls).toEqual([`rf:${opId}`])
    expect(getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
    expect(rep.rolledForward).toBe(1)
  })

  test('impossible (phase ∉ kind spine) → skill quarantined + op retired', () => {
    const skillId = seedSkill('qn')
    // delete's spine is intent/fs-staged/db-committed/done — fs-versioned is impossible.
    plant(skillId, 'delete', 'fs-versioned')
    const rep = recoverSkillOperations(db, FS, {})
    expect(rep.quarantined).toBe(1)
    const skill = db.select().from(skills).where(eq(skills.id, skillId)).get()
    expect(skill?.versionState).toBe('quarantined')
    expect(getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
  })

  test('recoverDb contributes writes to the terminal tx', () => {
    const skillId = seedSkill('dbwrite')
    plant(skillId, 'version-write', 'db-committed')
    const dbCalls: string[] = []
    const registry: OpRecoveryRegistry = {
      'version-write': {
        rollForwardFs: () => {},
        recoverDb: (tx, op, dir) => {
          dbCalls.push(dir)
          tx.update(skills)
            .set({ description: `recovered:${op.opId}` })
            .where(eq(skills.id, skillId))
            .run()
        },
      },
    }
    recoverSkillOperations(db, FS, registry)
    expect(dbCalls).toEqual(['rollforward'])
    expect(db.select().from(skills).where(eq(skills.id, skillId)).get()?.description).toContain(
      'recovered:',
    )
  })

  test('no handler for a kind → lock still freed + counted (loud gap, not stuck)', () => {
    const skillId = seedSkill('nohand')
    plant(skillId, 'reserve', 'fs-staged')
    const rep = recoverSkillOperations(db, FS, {})
    expect(rep.noHandler).toBe(1)
    expect(locksFor(skillId)).toBe(0) // NOT stuck
    expect(getActiveOp(db, skillId)).toBeNull()
  })

  test('orphan locks (op already done) are GC-cleared after active recovery', () => {
    const skillId = seedSkill('orphan')
    // A lock whose op is inactive — simulate a crash that left it behind.
    db.insert(skillOperationLocks).values({ lockedSkillId: skillId, opId: ulid() }).run()
    const rep = recoverSkillOperations(db, FS, {})
    expect(rep.orphanLocksCleared).toBe(1)
    expect(locksFor(skillId)).toBe(0)
  })

  test('empty (no active ops) → clean no-op report', () => {
    const rep = recoverSkillOperations(db, FS, {})
    expect(rep).toMatchObject({ total: 0, rolledBack: 0, rolledForward: 0, quarantined: 0 })
  })
})
