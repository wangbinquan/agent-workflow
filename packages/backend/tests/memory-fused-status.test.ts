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
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories } from '../src/db/schema'
import { dbTxSync } from '../src/db/txSync'
import { composeSkillMemoryFusionParticipantFactory } from '../src/modules/memory/composition'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { memoryCatalogOf } from './helpers/memoryCatalog'
import { unfuseAboveVersionSync } from '../src/modules/memory/infrastructure/sqliteMemoryMembershipParticipant'
import {
  createManagedSkill,
  writeSkillContent,
  type SkillFsOptions,
} from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import { restoreSkillVersion } from '../src/modules/resource-catalog/infrastructure/legacy/skillVersion'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  fsOpts: SkillFsOptions
  cleanup: () => void
}
function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-mem-fused-'))
  return {
    db: createInMemoryDb(MIGRATIONS),
    fsOpts: { appHome },
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

function insertApprovedGlobalMemory(db: DbClient, title: string): string {
  const id = ulid()
  db.insert(memories)
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
  db: DbClient,
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

function statusOf(db: DbClient, id: string): string {
  const rows = db.select().from(memories).where(eqId(id)).all() as Array<{ status: string }>
  return rows[0]!.status
}
function eqId(id: string) {
  return eq(memories.id, id)
}

describe('fusion participant markFused', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('only approved memories transition to fused (+ provenance); others skipped', async () => {
    const a = insertApprovedGlobalMemory(h.db, 'a')
    const b = insertApprovedGlobalMemory(h.db, 'b')
    // archive b so it is no longer 'approved'
    h.db.update(memories).set({ status: 'archived' }).where(eqId(b)).run()

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
    expect(statusOf(h.db, a)).toBe('fused')
    expect(statusOf(h.db, b)).toBe('archived') // untouched
    const rowA = h.db.select().from(memories).where(eqId(a)).all() as Array<{
      fusedIntoSkill: string | null
      fusedIntoSkillId: string | null
      fusedIntoSkillVersion: number | null
    }>
    expect(rowA[0]!.fusedIntoSkill).toBe('lint')
    expect(rowA[0]!.fusedIntoSkillId).toBe('skill-lint')
    expect(rowA[0]!.fusedIntoSkillVersion).toBe(4)
  })
})

describe('fused⟺provenance DB CHECK', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('status=fused without provenance is rejected', async () => {
    expect(() =>
      h.db
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
        .run(),
    ).toThrow()
  })

  test('non-fused status with provenance set is rejected', async () => {
    expect(() =>
      h.db
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
        .run(),
    ).toThrow()
  })
})

describe('fused is terminal', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('patchMemory refuses to edit a fused memory', async () => {
    const a = insertApprovedGlobalMemory(h.db, 'a')
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
      await memoryCatalogOf(h.db).commands.patch(a, { title: 'new title' })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('memory-terminal-status')
  })
})

describe('restore un-fuses memories fused after the target version', () => {
  let h: H
  beforeEach(() => (h = build()))
  afterEach(() => h.cleanup())

  test('restore to v1 un-fuses a memory fused at v2; keeps one fused at v1', async () => {
    const skill = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'v1',
      frontmatterExtra: {},
    })
    await writeSkillContent(h.db, h.fsOpts, skill.id, { bodyMd: 'v2' }, 'u') // -> v2

    const fusedAtV1 = insertApprovedGlobalMemory(h.db, 'old')
    const fusedAtV2 = insertApprovedGlobalMemory(h.db, 'new')
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

    const res = restoreSkillVersion(
      h.db,
      h.fsOpts,
      skill.id,
      1,
      'admin',
      TEST_SKILL_RESTORE_MEMBERSHIP,
      'rollback',
    )
    expect(res.unfusedMemoryIds).toEqual([fusedAtV2])
    expect(statusOf(h.db, fusedAtV2)).toBe('approved') // un-fused, re-injectable
    expect(statusOf(h.db, fusedAtV1)).toBe('fused') // still in v1 content
  })

  test('unfuseAboveVersionSync clears provenance', async () => {
    const m = insertApprovedGlobalMemory(h.db, 'm')
    await fuse(h.db, {
      memoryIds: [m],
      skillId: 'skill-lint',
      skillName: 'lint',
      skillVersion: 9,
      fusionId: 'f',
      userId: 'u',
      now: Date.now(),
    })
    const unfused = dbTxSync(h.db, (tx) =>
      unfuseAboveVersionSync(tx, { skillId: 'skill-lint', aboveVersion: 0 }),
    )
    expect(unfused).toEqual([m])
    const row = h.db.select().from(memories).where(eqId(m)).all() as Array<{
      status: string
      fusedIntoSkill: string | null
      fusedIntoSkillId: string | null
    }>
    expect(row[0]!.status).toBe('approved')
    expect(row[0]!.fusedIntoSkill).toBeNull()
    expect(row[0]!.fusedIntoSkillId).toBeNull()
  })
})
