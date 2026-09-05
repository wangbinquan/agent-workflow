// RFC-359 W4-D5 —— knowledge-evolution 融合仓库与 resource-catalog 技能版本提交 participant 合一之后，
// 同一段断言在两个引擎上各跑一遍：apply 把技能版本推进、记忆标记为已融合、提案目录发布收在一个事务序列里；
// 技能操作锁撞库经能力矩阵归类成同一个 ConflictError；CAS / 决策认领 / 取消认领的前置条件；
// provenance 修复经 memory 的 participant 逐条改判；决策恢复把中断的 apply 前滚或回滚。

import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  fusions,
  memories,
  skillOperationLocks,
  skillOperations,
  skills,
  skillVersions,
} from '@/db/schema'
import { composeFusionPersistenceFor } from '@/modules/knowledge-evolution/composition/fusion'
import type { FusionPersistenceRecord } from '@/modules/knowledge-evolution/public/types'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { encodeSkillToken } from '@/modules/resource-catalog/application/skills/skillToken'
import { composeSkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'
import { QUARANTINED_FUSION_SKILL_ID } from '@/services/systemResources'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc359-d5-'))
  roots.push(root)
  return root
}

function actorOf(id: string, role: 'admin' | 'user' = 'admin'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

function fusionRecord(
  input: {
    readonly id: string
    readonly skillId: string
    readonly preconditionToken: string | null
  },
  patch: Partial<FusionPersistenceRecord> = {},
): FusionPersistenceRecord {
  return {
    id: input.id,
    skillId: input.skillId,
    skillName: 'managed-skill',
    baseSkillVersion: 1,
    preconditionToken: input.preconditionToken,
    memoryIdsJson: '["memory-1"]',
    intent: 'merge approved knowledge',
    status: 'applying',
    iteration: 1,
    currentTaskId: null,
    proposedWorktreePath: null,
    proposedDiff: null,
    incorporatedMemoryIdsJson: '["memory-1"]',
    skippedJson: '[]',
    changelog: 'merged memory',
    appliedSkillVersion: null,
    ownerUserId: 'owner-1',
    createdAt: 1,
    decidedByUserId: null,
    decidedAt: null,
    decisionReason: null,
    error: null,
    ...patch,
  }
}

async function seedSkill(
  db: ProviderNeutralDatabase,
  ownerUserId: string,
  contentVersion = 1,
): Promise<string> {
  const id = `skill_d5_${ulid()}`
  await db.insert(skills).values({
    id,
    name: `managed-${id}`,
    managedPath: `skills/${id}/files`,
    contentVersion,
    versionState: 'snapshot-authoritative',
    ownerUserId,
  })
  return id
}

async function seedApprovedMemory(db: ProviderNeutralDatabase): Promise<string> {
  const id = `memory_d5_${ulid()}`
  await db.insert(memories).values({
    id,
    scopeType: 'global',
    scopeId: null,
    title: 'approved memory',
    bodyMd: 'durable content',
    status: 'approved',
    sourceKind: 'manual',
    createdAt: 1,
  })
  return id
}

function seedSkillFiles(appHome: string, skillId: string): { live: string; proposal: string } {
  const live = join(appHome, `skills/${skillId}/files`)
  const versionOne = join(appHome, `skills/${skillId}/versions/v1/files`)
  const proposal = join(appHome, 'proposal')
  for (const directory of [live, versionOne, proposal]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(live, 'SKILL.md'), 'old\n')
  writeFileSync(join(versionOne, 'SKILL.md'), 'old\n')
  writeFileSync(join(proposal, 'SKILL.md'), 'new\n')
  return { live, proposal }
}

describeEachProvider('RFC-359 W4-D5 —— 融合仓库与技能版本提交 participant', (harness) => {
  const persistenceOf = (appHome: string) =>
    composeFusionPersistenceFor({
      db: harness.db,
      appHome,
      memoryMembership: composeSkillMemoryFusionParticipantFactory(),
      skillVersionCommit: composeSkillVersionCommitParticipantFactory(),
    })

  test('apply：技能版本、记忆成员关系、提案发布与操作账本一个序列落地；重复操作锁经能力矩阵归类', async () => {
    const db = harness.db
    const appHome = tempRoot()
    const actor = actorOf('owner-1')
    const skillId = await seedSkill(db, actor.user.id)
    const memoryId = await seedApprovedMemory(db)
    const { live, proposal } = seedSkillFiles(appHome, skillId)
    const persistence = persistenceOf(appHome)

    const access = await persistence.loadSkillAccess(actor, skillId)
    expect(access).not.toBeNull()
    expect(access!.access).toBe('own')
    expect(await persistence.loadSkillIdentity(skillId)).toMatchObject({
      id: skillId,
      contentVersion: 1,
    })
    expect(await persistence.loadSkillIdentity('missing')).toBeNull()

    const fusionId = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id: fusionId, skillId, preconditionToken: access!.preconditionToken },
        {
          incorporatedMemoryIdsJson: JSON.stringify([memoryId]),
          memoryIdsJson: JSON.stringify([memoryId]),
        },
      ),
    )
    expect((await persistence.load(fusionId))?.status).toBe('applying')
    expect((await persistence.listSummaries({ skillId })).map((row) => row.id)).toEqual([fusionId])
    expect(await persistence.listIdsByStatus('applying')).toEqual([fusionId])

    const applied = await persistence.apply({
      fusionId,
      actor,
      appHome,
      proposedWorktreePath: proposal,
      incorporatedMemoryIds: [memoryId],
      summary: 'merged memory',
      now: 10,
    })
    expect(applied).toEqual({ versionIndex: 2 })
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toBe('new\n')
    expect(
      readFileSync(join(appHome, `skills/${skillId}/versions/v2/files/SKILL.md`), 'utf8'),
    ).toBe('new\n')
    expect((await db.select().from(skills).where(eq(skills.id, skillId)))[0]?.contentVersion).toBe(
      2,
    )
    expect((await db.select().from(memories).where(eq(memories.id, memoryId)))[0]).toMatchObject({
      status: 'fused',
      fusedIntoSkillId: skillId,
      fusedIntoSkillVersion: 2,
      fusedFusionId: fusionId,
    })
    expect(
      (await db.select().from(skillVersions).where(eq(skillVersions.fusionId, fusionId)))[0]
        ?.versionIndex,
    ).toBe(2)
    expect(
      (await db.select().from(skillOperations).where(eq(skillOperations.skillId, skillId)))[0]
        ?.active,
    ).toBe(0)
    expect(
      await db
        .select()
        .from(skillOperationLocks)
        .where(eq(skillOperationLocks.lockedSkillId, skillId)),
    ).toHaveLength(0)

    // 第二次 apply：认领重验先答「技能已被推进」——fusion 仍是 applying 状态但 token 落后一版。
    const second = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord({ id: second, skillId, preconditionToken: access!.preconditionToken }),
    )
    await expect(
      persistence.apply({
        fusionId: second,
        actor,
        appHome,
        proposedWorktreePath: proposal,
        incorporatedMemoryIds: [],
        summary: 's',
        now: 11,
      }),
    ).rejects.toMatchObject({ code: 'fusion-precondition-stale' })
    // 失败路径也收回了操作账本：没有残留的活跃操作与锁。
    expect(
      await db
        .select()
        .from(skillOperationLocks)
        .where(eq(skillOperationLocks.lockedSkillId, skillId)),
    ).toHaveLength(0)

    // 别人的操作正锁着这个技能：撞唯一键 → 同一个 ConflictError（两个引擎的驱动错误都经能力矩阵归类）。
    await db.insert(skillOperationLocks).values({ lockedSkillId: skillId, opId: `op_${ulid()}` })
    const third = `fusion_${ulid()}`
    const freshAccess = await persistence.loadSkillAccess(actor, skillId)
    await persistence.create(
      fusionRecord(
        { id: third, skillId, preconditionToken: freshAccess!.preconditionToken },
        { baseSkillVersion: 2 },
      ),
    )
    await expect(
      persistence.apply({
        fusionId: third,
        actor,
        appHome,
        proposedWorktreePath: proposal,
        incorporatedMemoryIds: [],
        summary: 's',
        now: 12,
      }),
    ).rejects.toMatchObject({ code: 'skill-operation-busy' })
  })

  test('CAS / 决策认领 / 取消认领：前置条件在同一事务里判', async () => {
    const db = harness.db
    const appHome = tempRoot()
    const owner = actorOf('owner-2')
    const stranger = actorOf('stranger-2', 'user')
    const skillId = await seedSkill(db, owner.user.id)
    const persistence = persistenceOf(appHome)
    const access = await persistence.loadSkillAccess(owner, skillId)
    const id = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id, skillId, preconditionToken: access!.preconditionToken },
        { status: 'running', ownerUserId: owner.user.id, currentTaskId: 'task-1' },
      ),
    )
    expect(await persistence.casStatus({ id, from: ['awaiting_approval'], to: 'applying' })).toBe(
      false,
    )
    expect(
      await persistence.casStatus({
        id,
        from: ['running'],
        to: 'awaiting_approval',
        expectedCurrentTaskId: 'other',
      }),
    ).toBe(false)
    expect(
      await persistence.casStatus({
        id,
        from: ['running'],
        to: 'awaiting_approval',
        expectedCurrentTaskId: 'task-1',
        patch: { currentTaskId: null },
      }),
    ).toBe(true)
    expect((await persistence.load(id))?.status).toBe('awaiting_approval')
    expect((await persistence.listAwaitingApprovalOwners()).map((row) => row.id)).toContain(id)

    // 陌生人认领决策：技能 ACL 在事务里重判。
    await expect(
      persistence.claimDecision({ id, actor: stranger, from: 'awaiting_approval', to: 'applying' }),
    ).rejects.toMatchObject({ code: 'fusion-skill-forbidden' })
    expect(
      await persistence.claimDecision({ id, actor: owner, from: 'running', to: 'applying' }),
    ).toBe(false)
    expect(
      await persistence.claimDecision({
        id,
        actor: owner,
        from: 'awaiting_approval',
        to: 'applying',
      }),
    ).toBe(true)

    // 取消：只有 owner / bypass；状态门。
    const running = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id: running, skillId, preconditionToken: access!.preconditionToken },
        { status: 'running', ownerUserId: owner.user.id, currentTaskId: 'task-9' },
      ),
    )
    await expect(
      persistence.claimCancellation({ id: running, actor: stranger, now: 5 }),
    ).rejects.toMatchObject({ code: 'fusion-forbidden' })
    expect(await persistence.claimCancellation({ id: running, actor: owner, now: 5 })).toEqual({
      ok: true,
      taskId: 'task-9',
    })
    expect(await persistence.claimCancellation({ id: running, actor: owner, now: 6 })).toEqual({
      ok: false,
    })

    // 陈旧 token 的决策认领：技能被推进后 token 不再匹配。
    await db.update(skills).set({ contentVersion: 5 }).where(eq(skills.id, skillId))
    const stale = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id: stale, skillId, preconditionToken: access!.preconditionToken },
        { status: 'awaiting_approval', ownerUserId: owner.user.id },
      ),
    )
    await expect(
      persistence.claimDecision({
        id: stale,
        actor: owner,
        from: 'awaiting_approval',
        to: 'applying',
      }),
    ).rejects.toMatchObject({ code: 'fusion-precondition-stale' })
  })

  test('provenance 修复与决策恢复', async () => {
    const db = harness.db
    const appHome = tempRoot()
    const persistence = persistenceOf(appHome)
    const ledgerSkill = await seedSkill(db, 'owner-3', 10)
    const orphanSkill = await seedSkill(db, 'owner-3', 10)

    // 账本单一且一致：修复回真实技能；无法证明的行隔离并终态化。
    const proven = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id: proven, skillId: QUARANTINED_FUSION_SKILL_ID, preconditionToken: null },
        { status: 'failed', appliedSkillVersion: 2 },
      ),
    )
    await db.insert(skillVersions).values({
      id: `version_${ulid()}`,
      skillId: ledgerSkill,
      versionIndex: 2,
      filesPath: `skills/${ledgerSkill}/versions/v2/files`,
      source: 'fusion',
      fusionId: proven,
      createdAt: 2,
    })
    const unprovable = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        {
          id: unprovable,
          skillId: orphanSkill,
          preconditionToken: encodeSkillToken({
            skillId: orphanSkill,
            contentVersion: 1,
            metaRevision: 0,
          }),
        },
        { status: 'awaiting_approval', appliedSkillVersion: 3 },
      ),
    )
    const fusedMemory = await seedApprovedMemory(db)
    await db
      .update(memories)
      .set({
        status: 'fused',
        fusedIntoSkillId: orphanSkill,
        fusedIntoSkill: 'x',
        fusedIntoSkillVersion: 3,
        fusedAt: 3,
        fusedFusionId: unprovable,
      })
      .where(eq(memories.id, fusedMemory))
    const receipt = await persistence.repairProvenance()
    expect(receipt).toMatchObject({
      repairedFusions: 1,
      quarantinedFusions: 1,
      terminalizedFusions: 1,
      quarantinedMemories: 1,
    })
    expect((await persistence.load(proven))?.skillId).toBe(ledgerSkill)
    expect(await persistence.load(unprovable)).toMatchObject({
      skillId: QUARANTINED_FUSION_SKILL_ID,
      status: 'failed',
    })
    expect(
      (await db.select().from(memories).where(eq(memories.id, fusedMemory)))[0]?.fusedIntoSkillId,
    ).toBe(QUARANTINED_FUSION_SKILL_ID)
    // 幂等：再跑一次没有新的修复。
    expect(await persistence.repairProvenance()).toMatchObject({
      repairedFusions: 0,
      quarantinedFusions: 0,
      repairedMemories: 0,
      quarantinedMemories: 0,
    })

    // 决策恢复：applying 且账本可信 → done；applying 且不可信 → failed；running 无任务 → failed。
    const forward = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id: forward, skillId: ledgerSkill, preconditionToken: null },
        { status: 'applying' },
      ),
    )
    await db.insert(skillVersions).values({
      id: `version_${ulid()}`,
      skillId: ledgerSkill,
      versionIndex: 11,
      filesPath: `skills/${ledgerSkill}/versions/v11/files`,
      source: 'fusion',
      fusionId: forward,
      createdAt: 11,
    })
    const back = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id: back, skillId: ledgerSkill, preconditionToken: null },
        { status: 'applying' },
      ),
    )
    const stuck = `fusion_${ulid()}`
    await persistence.create(
      fusionRecord(
        { id: stuck, skillId: ledgerSkill, preconditionToken: null },
        { status: 'running', currentTaskId: null },
      ),
    )
    expect(await persistence.recoverDecisions(99)).toEqual({
      rolledForward: 1,
      rolledBack: 1,
      rejectFailed: 1,
    })
    expect(await persistence.load(forward)).toMatchObject({
      status: 'done',
      appliedSkillVersion: 11,
      decidedAt: 99,
    })
    expect((await persistence.load(back))?.status).toBe('failed')
    expect((await persistence.load(stuck))?.status).toBe('failed')
    expect((await db.select().from(fusions).where(eq(fusions.id, stuck)))[0]?.error).toContain(
      'daemon restarted mid-rerun',
    )
  })
})
