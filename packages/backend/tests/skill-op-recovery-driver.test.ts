// RFC-170 §6a / T-BOOT — boot recovery driver orchestration.
//
// Uses the real op primitives (beginOperation/advancePhase) to plant crashed
// ops at chosen (kind, phase) states, then asserts the driver dispatches each to
// the right terminal via recoveryDirection: pre-db-committed → rollbackFs +
// abandon (lock freed); ≥ db-committed → rollForwardFs + finish (lock freed);
// impossible phase → quarantine (skill version_state) + retire; missing handler
// → lock freed + counted; orphan locks GC'd last.

import { describe, expect, test, beforeEach } from 'bun:test'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills, skillOperationLocks } from '../src/db/schema'
import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillOperations'
import {
  recoverSkillOperations,
  type OpRecoveryRegistry,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'

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
      .values({ id, name, managedPath: `skills/${name}/files` })
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
  async function plant(
    skillId: string,
    kind: Parameters<typeof beginOperation>[1]['kind'],
    phase: string,
  ) {
    const opId = await databaseSessionFor(db).transaction(
      async (tx) => await beginOperation(tx, { skillId, kind }),
    )
    if (phase !== 'intent')
      await databaseSessionFor(db).transaction(
        async (tx) => await advancePhase(tx, opId, phase as never),
      )
    return opId
  }

  test('pre-db-committed op → rollbackFs called, op abandoned, lock freed', async () => {
    const skillId = seedSkill('rb')
    const opId = await plant(skillId, 'version-write', 'fs-staged')
    const calls: string[] = []
    const registry: OpRecoveryRegistry = {
      'version-write': {
        rollbackFs: (_f, op) => {
          calls.push(`rb:${op.opId}`)
        },
      },
    }
    const rep = await recoverSkillOperations(db, FS, registry)
    expect(calls).toEqual([`rb:${opId}`])
    expect(await getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
    expect(rep.rolledBack).toBe(1)
  })

  test('≥ db-committed op → rollForwardFs called, op finished (done), lock freed', async () => {
    const skillId = seedSkill('rf')
    const opId = await plant(skillId, 'version-write', 'db-committed')
    const calls: string[] = []
    const registry: OpRecoveryRegistry = {
      'version-write': {
        rollForwardFs: (_f, op) => {
          calls.push(`rf:${op.opId}`)
        },
      },
    }
    const rep = await recoverSkillOperations(db, FS, registry)
    expect(calls).toEqual([`rf:${opId}`])
    expect(await getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
    expect(rep.rolledForward).toBe(1)
  })

  test('impossible (phase ∉ kind spine) → skill quarantined + op retired', async () => {
    const skillId = seedSkill('qn')
    // delete's spine is intent/fs-staged/db-committed/done — fs-versioned is impossible.
    await plant(skillId, 'delete', 'fs-versioned')
    const rep = await recoverSkillOperations(db, FS, {})
    expect(rep.quarantined).toBe(1)
    const skill = db.select().from(skills).where(eq(skills.id, skillId)).get()
    expect(skill?.versionState).toBe('quarantined')
    expect(await getActiveOp(db, skillId)).toBeNull()
    expect(locksFor(skillId)).toBe(0)
  })

  test('recoverDb contributes writes to the terminal tx', async () => {
    const skillId = seedSkill('dbwrite')
    await plant(skillId, 'version-write', 'db-committed')
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
    await recoverSkillOperations(db, FS, registry)
    expect(dbCalls).toEqual(['rollforward'])
    expect(db.select().from(skills).where(eq(skills.id, skillId)).get()?.description).toContain(
      'recovered:',
    )
  })

  test('no handler for a kind → fail closed with active row + lock preserved', async () => {
    const skillId = seedSkill('nohand')
    await plant(skillId, 'reserve', 'fs-staged')
    await expect(recoverSkillOperations(db, FS, {})).rejects.toThrow(
      /handler-missing.*active row and lock preserved/,
    )
    expect(locksFor(skillId)).toBe(1)
    expect((await getActiveOp(db, skillId))?.phase).toBe('fs-staged')
  })

  test('orphan locks (op already done) are GC-cleared after active recovery', async () => {
    const skillId = seedSkill('orphan')
    // A lock whose op is inactive — simulate a crash that left it behind.
    db.insert(skillOperationLocks).values({ lockedSkillId: skillId, opId: ulid() }).run()
    const rep = await recoverSkillOperations(db, FS, {})
    expect(rep.orphanLocksCleared).toBe(1)
    expect(locksFor(skillId)).toBe(0)
  })

  test('empty (no active ops) → clean no-op report', async () => {
    const rep = await recoverSkillOperations(db, FS, {})
    expect(rep).toMatchObject({ total: 0, rolledBack: 0, rolledForward: 0, quarantined: 0 })
  })
})
