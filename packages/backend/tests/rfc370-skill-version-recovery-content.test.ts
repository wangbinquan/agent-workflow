// RFC-370 H6: durable version metadata decides direction; the selected storage
// performs rollback/publish and must finish before the recovery driver retires it.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { skills, skillVersions } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { SkillVersionRecoveryContentStore } from '@/modules/resource-catalog/application/skills/versionRecoveryContentStore'
import { createManagedSkill } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { recoverSkillOperations } from '@/modules/resource-catalog/infrastructure/legacy/skillOpRecoveryDriver'
import { SKILL_OP_RECOVERY_REGISTRY } from '@/modules/resource-catalog/infrastructure/legacy/skillOpRegistry'
import { describeEachProvider } from './helpers/eachProvider'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}
async function reached(gate: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  await Promise.race([
    gate.pending,
    pending.then(() => {
      throw new Error('recovery completed before effect')
    }),
  ])
}
function storage(): SkillVersionRecoveryContentStore {
  return {
    plan(input) {
      return {
        skillId: input.skillId,
        operationId: input.operationId,
        version: input.version,
        publicationId: input.operationId,
        rootRef: `object:${input.skillId}`,
        liveRef: `object:${input.skillId}/live`,
        stagingRef: input.stagingReference,
        versionRef: input.versionReference,
      }
    },
    matchesVersionReference(plan, reference) {
      return plan.versionRef === reference
    },
    rollback() {},
    rollForward() {},
  }
}

describeEachProvider('RFC-370 skill version recovery content', (harness) => {
  let directory: string, appHome: string, skillId: string
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aw-version-recovery-'))
    appHome = join(directory, 'absent-home')
    const skill = await createManagedSkill(
      harness.db,
      { appHome: directory },
      {
        name: 'recovery-adapter',
        description: '',
        bodyMd: 'initial',
        frontmatterExtra: {},
      },
    )
    skillId = skill.id
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  async function seed(committed: boolean) {
    return await databaseSessionFor(harness.db).transaction(async (tx) => {
      const opId = await beginOperation(tx, {
        skillId,
        kind: 'version-write',
        targetVersion: 2,
        preconditionJson: JSON.stringify({ skillId }),
        stagingPath: 'object:staged',
        candidatePath: 'object:version-2',
      })
      await advancePhase(tx, opId, 'fs-staged')
      await advancePhase(tx, opId, 'fs-versioned')
      if (committed) {
        await tx.insert(skillVersions).values({
          id: ulid(),
          skillId,
          versionIndex: 2,
          filesPath: 'object:version-2',
          source: 'editor',
          authorUserId: null,
          contentHash: 'b'.repeat(64),
          createdAt: Date.now(),
        })
        await tx.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, skillId))
        await advancePhase(tx, opId, 'db-committed')
      }
      return opId
    })
  }

  test('pre-commit rollback awaits selected storage and keeps the original version', async () => {
    const opId = await seed(false),
      entered = barrier(),
      ready = barrier()
    const content: SkillVersionRecoveryContentStore = {
      ...storage(),
      async rollback(plan) {
        expect(plan).toMatchObject({
          operationId: opId,
          skillId,
          version: 2,
          stagingRef: 'object:staged',
          versionRef: 'object:version-2',
        })
        entered.release()
        await ready.pending
      },
      rollForward() {
        throw new Error('uncommitted version must never publish')
      },
    }
    const pending = recoverSkillOperations(
      harness.db,
      { appHome, versionRecovery: content },
      SKILL_OP_RECOVERY_REGISTRY,
    )
    try {
      await reached(entered, pending)
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({
        active: 1,
        phase: 'fs-versioned',
      })
    } finally {
      ready.release()
    }
    expect(await pending).toMatchObject({ rolledBack: 1, rolledForward: 0 })
    expect(
      (await harness.db.select().from(skills).where(eq(skills.id, skillId)))[0]?.contentVersion,
    ).toBe(1)
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
    expect(existsSync(appHome)).toBe(false)
  })

  test('committed recovery waits for publish with the recorded hash and same references', async () => {
    const opId = await seed(true),
      entered = barrier(),
      ready = barrier()
    const content: SkillVersionRecoveryContentStore = {
      ...storage(),
      rollback() {
        throw new Error('committed version must never rollback')
      },
      async rollForward(plan, hash) {
        expect(plan.operationId).toBe(opId)
        expect(hash).toBe('b'.repeat(64))
        entered.release()
        await ready.pending
      },
    }
    const pending = recoverSkillOperations(
      harness.db,
      { appHome, versionRecovery: content },
      SKILL_OP_RECOVERY_REGISTRY,
    )
    try {
      await reached(entered, pending)
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({
        active: 1,
        phase: 'db-committed',
      })
    } finally {
      ready.release()
    }
    expect(await pending).toMatchObject({ rolledForward: 1, rolledBack: 0 })
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
    expect(
      await harness.db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)),
    ).toHaveLength(2)
  })

  test('failed storage publish retains evidence for retry; metadata contradictions never invoke it', async () => {
    const opId = await seed(true),
      failure = new Error('publication unavailable')
    let publishes = 0
    const content: SkillVersionRecoveryContentStore = {
      ...storage(),
      async rollForward() {
        publishes++
        throw failure
      },
    }
    await expect(
      recoverSkillOperations(
        harness.db,
        { appHome, versionRecovery: content },
        SKILL_OP_RECOVERY_REGISTRY,
      ),
    ).rejects.toBe(failure)
    expect(await getActiveOp(harness.db, skillId)).toMatchObject({ opId, active: 1 })
    await harness.db.update(skills).set({ contentVersion: 1 }).where(eq(skills.id, skillId))
    await expect(
      recoverSkillOperations(
        harness.db,
        { appHome, versionRecovery: content },
        SKILL_OP_RECOVERY_REGISTRY,
      ),
    ).rejects.toThrow("target is not the skill's current committed version")
    expect(publishes).toBe(1)
    await harness.db.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, skillId))
    const mismatched: SkillVersionRecoveryContentStore = {
      ...content,
      matchesVersionReference() {
        return false
      },
    }
    await expect(
      recoverSkillOperations(
        harness.db,
        { appHome, versionRecovery: mismatched },
        SKILL_OP_RECOVERY_REGISTRY,
      ),
    ).rejects.toThrow('target row files_path does not match its candidate')
    expect(publishes).toBe(1)
    expect(
      await recoverSkillOperations(
        harness.db,
        { appHome, versionRecovery: storage() },
        SKILL_OP_RECOVERY_REGISTRY,
      ),
    ).toMatchObject({ rolledForward: 1 })
  })
})
