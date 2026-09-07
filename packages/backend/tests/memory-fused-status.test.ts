// RFC-101 PR-B — memory `fused` terminal status + provenance + restore un-fuse.
//
// Locks: the fusion participant's markFused only transitions `approved` rows (drifted rows
// skipped), the DB CHECK enforces fused⟺provenance, a fused memory is terminal
// (cannot be edited), and restoring a skill below a fusion version un-fuses the
// affected memories in the SAME transaction (invariant: fused ⟺ knowledge is
// in the current skill version).

import { TEST_SKILL_RESTORE_MEMBERSHIP } from './helpers/skillRestoreMembership'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { memories } from '../src/db/schema'
import {
  composeMemoryCatalogOperations,
  composeSkillMemoryFusionParticipantFactory,
} from '../src/modules/memory/composition'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './helpers/resourceScopeAuthority'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createManagedSkill,
  writeSkillContent,
  type SkillFsOptions,
} from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import { restoreSkillVersion } from '../src/modules/resource-catalog/infrastructure/legacy/skillVersion'

interface H {
  db: ProviderNeutralDatabase
  fsOpts: SkillFsOptions
  cleanup: () => void
}
function build(db: ProviderNeutralDatabase): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-mem-fused-'))
  return {
    db,
    fsOpts: { appHome },
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertApprovedGlobalMemory(
  db: ProviderNeutralDatabase,
  title: string,
): Promise<string> {
  const id = ulid()
  await db
    .insert(memories)
    .values({
      id,
      scopeType: 'global',
      scopeId: null,
      title,
      bodyMd: `body of ${title}`,
      tags: '[]',
      status: 'approved',
      sourceKind: 'manual',
      createdAt: Date.now(),
      version: 1,
    })
    .run()
  return id
}

// RFC-359 W4-D4：融合写入经 memory 提供给 knowledge-evolution 的中立 participant（生产同一份），
// 不再有 SQLite 专属的 `the fusion participant`。
const FUSION = composeSkillMemoryFusionParticipantFactory()
async function fuse(
  db: ProviderNeutralDatabase,
  args: {
    memoryIds: readonly string[]
    skillId: string
    skillName: string
    skillVersion: number
    fusionId: string
    userId: string
    now: number
  },
): Promise<readonly string[]> {
  return await databaseSessionFor(db).transaction(
    async (tx) =>
      await FUSION.inTransaction(tx).markFused({
        memoryIds: args.memoryIds,
        skillId: args.skillId,
        skillName: args.skillName,
        skillVersion: args.skillVersion,
        fusionId: args.fusionId,
        actorUserId: args.userId,
        now: args.now,
      }),
  )
}

async function statusOf(db: ProviderNeutralDatabase, id: string): Promise<string> {
  const rows = await db.select().from(memories).where(eqId(id)).all()
  return rows[0]!.status
}
function eqId(id: string) {
  return eq(memories.id, id)
}

describeEachProvider('RFC-101 memory fusion and skill restore', (harness) => {
  describe('fusion participant markFused', () => {
    let h: H
    beforeEach(() => (h = build(harness.db)))
    afterEach(() => h.cleanup())

    test('only approved memories transition to fused (+ provenance); others skipped', async () => {
      const a = await insertApprovedGlobalMemory(h.db, 'a')
      const b = await insertApprovedGlobalMemory(h.db, 'b')
      // archive b so it is no longer 'approved'
      await h.db.update(memories).set({ status: 'archived' }).where(eqId(b)).run()

      const fused = await fuse(h.db, {
        memoryIds: [a, b],
        skillId: 'skill-lint',
        skillName: 'lint',
        skillVersion: 4,
        fusionId: 'fus_1',
        userId: 'u1',
        now: Date.now(),
      })
      expect(fused).toEqual([a])
      expect(await statusOf(h.db, a)).toBe('fused')
      expect(await statusOf(h.db, b)).toBe('archived') // untouched
      const rowA = await h.db.select().from(memories).where(eqId(a)).all()
      expect(rowA[0]!.fusedIntoSkill).toBe('lint')
      expect(rowA[0]!.fusedIntoSkillId).toBe('skill-lint')
      expect(rowA[0]!.fusedIntoSkillVersion).toBe(4)
    })
  })

  describe('fused⟺provenance DB CHECK', () => {
    let h: H
    beforeEach(() => (h = build(harness.db)))
    afterEach(() => h.cleanup())

    test('status=fused without provenance is rejected', async () => {
      await expect(
        (async () => {
          await h.db
            .insert(memories)
            .values({
              id: ulid(),
              scopeType: 'global',
              scopeId: null,
              title: 't',
              bodyMd: 'b',
              tags: '[]',
              status: 'fused', // no fusedIntoSkill -> CHECK fails
              sourceKind: 'manual',
              createdAt: Date.now(),
              version: 1,
            })
            .run()
        })(),
      ).rejects.toThrow()
    })

    test('non-fused status with provenance set is rejected', async () => {
      await expect(
        (async () => {
          await h.db
            .insert(memories)
            .values({
              id: ulid(),
              scopeType: 'global',
              scopeId: null,
              title: 't',
              bodyMd: 'b',
              tags: '[]',
              status: 'approved',
              fusedIntoSkill: 'lint', // provenance without fused -> CHECK fails
              sourceKind: 'manual',
              createdAt: Date.now(),
              version: 1,
            })
            .run()
        })(),
      ).rejects.toThrow()
    })
  })

  describe('fused is terminal', () => {
    let h: H
    beforeEach(() => (h = build(harness.db)))
    afterEach(() => h.cleanup())

    test('patchMemory refuses to edit a fused memory', async () => {
      const a = await insertApprovedGlobalMemory(h.db, 'a')
      await fuse(h.db, {
        memoryIds: [a],
        skillId: 'skill-lint',
        skillName: 'lint',
        skillVersion: 2,
        fusionId: 'f',
        userId: 'u',
        now: Date.now(),
      })
      let code: string | undefined
      try {
        await composeMemoryCatalogOperations({
          db: h.db,
          contexts: composeIdentityAccess(h.db).contexts,
          authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
        }).commands.patch(a, { title: 'new title' })
      } catch (err) {
        code = (err as { code?: string }).code
      }
      expect(code).toBe('memory-terminal-status')
    })
  })

  describe('restore un-fuses memories fused after the target version', () => {
    let h: H
    beforeEach(() => (h = build(harness.db)))
    afterEach(() => h.cleanup())

    test('restore to v1 un-fuses a memory fused at v2; keeps one fused at v1', async () => {
      const skill = await createManagedSkill(h.db, h.fsOpts, {
        name: 'lint',
        description: 'd',
        bodyMd: 'v1',
        frontmatterExtra: {},
      })
      await writeSkillContent(h.db, h.fsOpts, skill.id, { bodyMd: 'v2' }, 'u') // -> v2

      const fusedAtV1 = await insertApprovedGlobalMemory(h.db, 'old')
      const fusedAtV2 = await insertApprovedGlobalMemory(h.db, 'new')
      await fuse(h.db, {
        memoryIds: [fusedAtV1],
        skillId: skill.id,
        skillName: 'lint',
        skillVersion: 1,
        fusionId: 'f1',
        userId: 'u',
        now: Date.now(),
      })
      await fuse(h.db, {
        memoryIds: [fusedAtV2],
        skillId: skill.id,
        skillName: 'lint',
        skillVersion: 2,
        fusionId: 'f2',
        userId: 'u',
        now: Date.now(),
      })

      const res = await restoreSkillVersion(
        h.db,
        h.fsOpts,
        skill.id,
        1,
        'admin',
        TEST_SKILL_RESTORE_MEMBERSHIP,
        'rollback',
      )
      expect(res.unfusedMemoryIds).toEqual([fusedAtV2])
      expect(await statusOf(h.db, fusedAtV2)).toBe('approved') // un-fused, re-injectable
      expect(await statusOf(h.db, fusedAtV1)).toBe('fused') // still in v1 content
    })

    test('unfuseAboveVersion 清掉 provenance（RFC-359 W4-D23b：同步那份已退役，改用中立参与者）', async () => {
      const m = await insertApprovedGlobalMemory(h.db, 'm')
      await fuse(h.db, {
        memoryIds: [m],
        skillId: 'skill-lint',
        skillName: 'lint',
        skillVersion: 9,
        fusionId: 'f',
        userId: 'u',
        now: Date.now(),
      })
      const unfused = await databaseSessionFor(h.db).transaction(
        async (tx) =>
          await composeSkillMemoryFusionParticipantFactory()
            .inTransaction(tx)
            .unfuseAboveVersion({ skillId: 'skill-lint', aboveVersion: 0 }),
      )
      expect(unfused).toEqual([m])
      const row = await h.db.select().from(memories).where(eqId(m)).all()
      expect(row[0]!.status).toBe('approved')
      expect(row[0]!.fusedIntoSkill).toBeNull()
      expect(row[0]!.fusedIntoSkillId).toBeNull()
    })
  })
})
