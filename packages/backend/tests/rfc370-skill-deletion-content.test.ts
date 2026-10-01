// RFC-370 H6: selected delete/reserve storage must finish before the existing
// durable operation can advance or release its lock, including restart recovery.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skills } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { buildActor } from '@/auth/actor'
import type {
  SkillDeletionContentPlan,
  SkillDeletionContentStore,
} from '@/modules/resource-catalog/application/skills/deletionContentStore'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { createFileSkillDeletionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillDeletionContentStore'
import {
  createManagedSkill,
  deleteSkill,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { deleteManagedSkillOp } from '@/modules/resource-catalog/infrastructure/legacy/skillDeleteOp'
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
      throw new Error('operation completed before storage step')
    }),
  ])
}
function storage(): SkillDeletionContentStore {
  return {
    plan(input) {
      return {
        ...input,
        rootRef: `content:${input.skillId}`,
        backupRef: `backup:${input.operationId}`,
        backupJournalRef: `backup:${input.operationId}`,
      }
    },
    stage() {},
    rollback() {},
    discard() {},
  }
}
const actor = buildActor({
  user: {
    id: 'delete-adapter-admin',
    username: 'delete-adapter-admin',
    displayName: 'Delete adapter admin',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

describeEachProvider('RFC-370 skill deletion content', (harness) => {
  let directory: string, appHome: string, skillId: string
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aw-skill-deletion-'))
    appHome = join(directory, 'absent-home')
    const skill = await createManagedSkill(
      harness.db,
      { appHome: directory },
      {
        name: 'delete-adapter',
        description: '',
        bodyMd: 'body',
        frontmatterExtra: {},
      },
    )
    skillId = skill.id
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  async function row() {
    return (await harness.db.select().from(skills).where(eq(skills.id, skillId)))[0]
  }

  test('service delete awaits reversible staging and cleanup with the original durable phases', async () => {
    const staged = barrier(),
      stageReady = barrier(),
      clearing = barrier(),
      clearReady = barrier()
    const plans: SkillDeletionContentPlan[] = []
    const content: SkillDeletionContentStore = {
      ...storage(),
      async stage(plan) {
        plans.push(plan)
        staged.release()
        await stageReady.pending
      },
      async discard(plan) {
        expect(plans).toHaveLength(1)
        expect(plan).toBe(plans[0]!)
        clearing.release()
        await clearReady.pending
      },
    }
    const pending = deleteSkill(harness.db, { appHome, deletionContent: content }, skillId, actor)
    try {
      await reached(staged, pending)
      expect(await row()).toBeDefined()
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({ phase: 'intent', active: 1 })
      stageReady.release()
      await reached(clearing, pending)
      expect(await row()).toBeUndefined()
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({
        phase: 'db-committed',
        active: 1,
        backupPath: plans[0]!.backupJournalRef,
      })
    } finally {
      stageReady.release()
      clearReady.release()
    }
    await pending
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
    expect(existsSync(appHome)).toBe(false)
  })

  test('pre-commit failure waits for selected rollback before releasing its durable lock', async () => {
    const entered = barrier(),
      ready = barrier(),
      failure = new Error('delete stopped before commit')
    const content: SkillDeletionContentStore = {
      ...storage(),
      async rollback(plan, recovery) {
        expect(plan.skillId).toBe(skillId)
        expect(recovery).toBe(false)
        entered.release()
        await ready.pending
      },
    }
    const pending = deleteManagedSkillOp(
      harness.db,
      { appHome, deletionContent: content },
      { id: skillId },
      {
        afterPhase(phase) {
          if (phase === 'fs-staged') throw failure
        },
      },
    )
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await reached(entered, outcome)
      expect(await row()).toBeDefined()
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({
        phase: 'fs-staged',
        active: 1,
      })
    } finally {
      ready.release()
    }
    expect(await outcome).toBe(failure)
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
  })

  test('failed post-commit cleanup is recovered with the same persisted storage reference', async () => {
    const failure = new Error('cleanup temporarily unavailable')
    let stored!: SkillDeletionContentPlan
    const content: SkillDeletionContentStore = {
      ...storage(),
      async discard(plan) {
        stored = plan
        throw failure
      },
    }
    await expect(
      deleteManagedSkillOp(harness.db, { appHome, deletionContent: content }, { id: skillId }),
    ).rejects.toBe(failure)
    expect(await row()).toBeUndefined()
    expect(await getActiveOp(harness.db, skillId)).toMatchObject({
      phase: 'db-committed',
      active: 1,
    })
    const entered = barrier(),
      ready = barrier()
    const recovering: SkillDeletionContentStore = {
      ...storage(),
      plan(input) {
        expect(input.recordedBackupRef).toBe(stored.backupJournalRef)
        return storage().plan(input)
      },
      async discard(plan) {
        expect(plan.backupRef).toBe(stored.backupRef)
        entered.release()
        await ready.pending
      },
    }
    const pending = recoverSkillOperations(
      harness.db,
      { appHome, deletionContent: recovering },
      SKILL_OP_RECOVERY_REGISTRY,
    )
    try {
      await reached(entered, pending)
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({
        phase: 'db-committed',
        active: 1,
      })
    } finally {
      ready.release()
    }
    expect(await pending).toMatchObject({ rolledForward: 1, rolledBack: 0, quarantined: 0 })
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
    expect(
      await recoverSkillOperations(
        harness.db,
        { appHome, deletionContent: recovering },
        SKILL_OP_RECOVERY_REGISTRY,
      ),
    ).toMatchObject({ total: 0 })
  })

  test('restart rollback restores selected content and retains the op when storage fails', async () => {
    const opId = await databaseSessionFor(harness.db).transaction(async (tx) => {
      const id = await beginOperation(tx, {
        skillId,
        kind: 'delete',
        preconditionJson: JSON.stringify({ skillId }),
      })
      await advancePhase(tx, id, 'fs-staged', { backupPath: `backup:${id}` })
      return id
    })
    const failure = new Error('restore unavailable')
    const content: SkillDeletionContentStore = {
      ...storage(),
      async rollback(plan, recovery) {
        expect(plan.operationId).toBe(opId)
        expect(recovery).toBe(true)
        throw failure
      },
    }
    await expect(
      recoverSkillOperations(
        harness.db,
        { appHome, deletionContent: content },
        SKILL_OP_RECOVERY_REGISTRY,
      ),
    ).rejects.toBe(failure)
    expect(await row()).toBeDefined()
    expect(await getActiveOp(harness.db, skillId)).toMatchObject({ opId, active: 1 })
    const ready = barrier(),
      entered = barrier()
    const pending = recoverSkillOperations(
      harness.db,
      {
        appHome,
        deletionContent: {
          ...storage(),
          async rollback() {
            entered.release()
            await ready.pending
          },
        },
      },
      SKILL_OP_RECOVERY_REGISTRY,
    )
    try {
      await reached(entered, pending)
      expect(await getActiveOp(harness.db, skillId)).not.toBeNull()
    } finally {
      ready.release()
    }
    expect(await pending).toMatchObject({ rolledBack: 1, rolledForward: 0 })
    expect(await row()).toBeDefined()
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
  })

  test('production boot barrier forwards the selected recovery store and awaits real residue cleanup', async () => {
    const local = createFileSkillDeletionContentStore(directory)
    const failure = new Error('interrupted cleanup')
    let staged!: SkillDeletionContentPlan
    await expect(
      deleteManagedSkillOp(
        harness.db,
        {
          appHome: directory,
          deletionContent: {
            ...local,
            discard(plan) {
              staged = plan
              throw failure
            },
          },
        },
        { id: skillId },
      ),
    ).rejects.toBe(failure)
    expect(existsSync(staged.backupRef)).toBe(true)
    const entered = barrier(),
      ready = barrier()
    const boot = composeSkillCatalogBoot({
      db: harness.db,
      appHome: directory,
      deletionContent: {
        ...local,
        async discard(plan) {
          expect(plan.backupRef).toBe(staged.backupRef)
          entered.release()
          await ready.pending
          await local.discard(plan)
        },
      },
    })
    const pending = boot.runIdentityMigrationBarrier()
    try {
      await reached(entered, pending)
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({ active: 1 })
      expect(existsSync(staged.backupRef)).toBe(true)
    } finally {
      ready.release()
    }
    expect(await pending).toMatchObject({ recoveredOperations: 1 })
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
    expect(existsSync(staged.backupRef)).toBe(false)
  })

  test('reserve restart waits for selected root discard before removing the reservation', async () => {
    await harness.db
      .update(skills)
      .set({ reservationState: 'reserving' })
      .where(eq(skills.id, skillId))
    await databaseSessionFor(harness.db).transaction(
      async (tx) =>
        await beginOperation(tx, {
          skillId,
          kind: 'reserve',
          preconditionJson: JSON.stringify({ skillId }),
        }),
    )
    const entered = barrier(),
      ready = barrier()
    const pending = recoverSkillOperations(
      harness.db,
      {
        appHome,
        creationContent: {
          plan(id) {
            return { skillId: id, rootRef: `object:${id}`, liveRef: `object:${id}/live` }
          },
          initialize() {
            throw new Error('reserve recovery must never initialize')
          },
          async discard(root) {
            expect(root.rootRef).toBe(`object:${skillId}`)
            entered.release()
            await ready.pending
          },
        },
      },
      SKILL_OP_RECOVERY_REGISTRY,
    )
    try {
      await reached(entered, pending)
      expect(await row()).toMatchObject({ reservationState: 'reserving' })
      expect(await getActiveOp(harness.db, skillId)).toMatchObject({ active: 1 })
    } finally {
      ready.release()
    }
    expect(await pending).toMatchObject({ rolledBack: 1, rolledForward: 0 })
    expect(await row()).toBeUndefined()
    expect(await getActiveOp(harness.db, skillId)).toBeNull()
    expect(existsSync(appHome)).toBe(false)
  })
})
