// RFC-370 H6: selected delete/reserve storage must finish before the durable
// write can advance or release its lock, including restart recovery.
//
// RFC-401 T5：删除经 skill 写入场景——「阶段」读 journal 状态与 claim 尾部，提交后的清理失败由 AtomicApply 恢复前滚；
// 手工构造的旧 delete / reserve operation 仍由启动兼容执行器排空（restart rollback、reserve restart 两条）。
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { skillApplyRecoveryContentFor } from '@/modules/resource-catalog/infrastructure/skillApplyContent'
import { createSkillApplyRecoveryScene } from '@/modules/resource-catalog/infrastructure/skillApplyRecovery'
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
    const { skills } = tablesOf(harness.db)
    return (await harness.db.select().from(skills).where(eq(skills.id, skillId)))[0]
  }
  async function journal() {
    const { skillApplyJournal, atomicApplyClaims, skillOperationLocks } = tablesOf(harness.db)
    const entry = (
      await harness.db
        .select()
        .from(skillApplyJournal)
        .where(eq(skillApplyJournal.skillId, skillId))
    ).find((candidate) => candidate.operation === 'delete')
    if (entry === undefined) return undefined
    const claim = (
      await harness.db
        .select()
        .from(atomicApplyClaims)
        .where(eq(atomicApplyClaims.journalId, entry.id))
    )[0]
    const locks = await harness.db.select().from(skillOperationLocks)
    return {
      state: entry.state,
      tail: claim?.tailState,
      locked: locks.some((lock) => lock.opId === entry.id),
      artifacts: entry.preparedArtifactsJson,
    }
  }
  const recoverWith = (deletionContent: SkillDeletionContentStore) =>
    createAtomicApplyRecovery([
      createSkillApplyRecoveryScene({
        db: harness.db,
        content: (kind) => ({
          ...skillApplyRecoveryContentFor(harness.db, appHome)(kind),
          deletionContent,
        }),
      }),
    ]).converge({ skill: [] })

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
      expect(await journal()).toMatchObject({ state: 'prepared', locked: true })
      stageReady.release()
      await reached(clearing, pending)
      expect(await row()).toBeUndefined()
      const committed = await journal()
      expect(committed).toMatchObject({ state: 'committed', tail: 'pending', locked: true })
      expect(committed?.artifacts).toContain(plans[0]!.backupJournalRef)
    } finally {
      stageReady.release()
      clearReady.release()
    }
    await pending
    expect(await journal()).toMatchObject({ state: 'committed', tail: 'complete', locked: false })
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
    const pending = deleteSkill(
      harness.db,
      { appHome, deletionContent: content },
      skillId,
      actor,
      undefined,
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
      expect(await journal()).toMatchObject({ state: 'prepared', locked: true })
    } finally {
      ready.release()
    }
    expect(await outcome).toBe(failure)
    expect(await journal()).toMatchObject({ state: 'failed', locked: false })
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
      deleteSkill(harness.db, { appHome, deletionContent: content }, skillId, actor),
    ).rejects.toBe(failure)
    expect(await row()).toBeUndefined()
    expect(await journal()).toMatchObject({ state: 'committed', tail: 'pending', locked: true })
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
    const pending = recoverWith(recovering)
    try {
      await reached(entered, pending)
      expect(await journal()).toMatchObject({ state: 'committed', tail: 'pending', locked: true })
    } finally {
      ready.release()
    }
    expect(await pending).toEqual({ rolledForward: 1, failed: 0 })
    expect(await journal()).toMatchObject({ tail: 'complete', locked: false })
    expect(await recoverWith(recovering)).toEqual({ rolledForward: 0, failed: 0 })
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
      deleteSkill(
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
        skillId,
        actor,
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
    const pending = boot.recoverOperations()
    try {
      await reached(entered, pending)
      expect(await journal()).toMatchObject({ state: 'committed', tail: 'pending', locked: true })
      expect(existsSync(staged.backupRef)).toBe(true)
    } finally {
      ready.release()
    }
    // 旧记录为零；skill 写入场景的 journal 在同一启动步骤里前滚。
    expect(await pending).toMatchObject({ total: 0 })
    expect(await journal()).toMatchObject({ tail: 'complete', locked: false })
    expect(existsSync(staged.backupRef)).toBe(false)
  })

  test('reserve restart waits for selected root discard before removing the reservation', async () => {
    const { skills } = tablesOf(harness.db)
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
