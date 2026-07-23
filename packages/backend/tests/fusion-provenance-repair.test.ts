import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { fusions, memories, skills, skillVersions } from '../src/db/schema'
import { repairFusionProvenance } from '../src/services/fusion'
import { encodeSkillToken } from '../src/services/skillToken'
import { QUARANTINED_FUSION_SKILL_ID } from '../src/services/systemResources'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function addSkill(db: DbClient, id: string): void {
  db.insert(skills)
    .values({
      id,
      name: `name-${id}`,
      sourceKind: 'managed',
      managedPath: `skills/${id}/files`,
      contentVersion: 10,
      versionState: 'snapshot-authoritative',
    })
    .run()
}

function addFusionVersion(
  db: DbClient,
  fusionId: string,
  skillId: string,
  versionIndex: number,
): void {
  db.insert(skillVersions)
    .values({
      id: `version-${fusionId}-${skillId}-${versionIndex}`,
      skillId,
      versionIndex,
      filesPath: `skills/${skillId}/versions/v${versionIndex}/files`,
      source: 'fusion',
      fusionId,
      createdAt: versionIndex,
    })
    .run()
}

function addFusion(
  db: DbClient,
  id: string,
  patch: Partial<typeof fusions.$inferInsert> = {},
): void {
  db.insert(fusions)
    .values({
      id,
      skillId: QUARANTINED_FUSION_SKILL_ID,
      skillName: `historical-${id}`,
      baseSkillVersion: 1,
      memoryIdsJson: '[]',
      status: 'failed',
      ownerUserId: '__system__',
      createdAt: 1,
      ...patch,
    })
    .run()
}

describe('RFC-223 fusion provenance boot repair', () => {
  test('uses only trustworthy token/ledger oracles, quarantines conflicts, and is idempotent', () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (const id of ['skill-ledger', 'skill-other', 'skill-duplicate', 'skill-applied']) {
      addSkill(db, id)
    }

    // Token-only remains trustworthy even after the current skill row was deleted.
    addFusion(db, 'token-only', {
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 1,
        metaRevision: 0,
      }),
    })

    // A malformed token contributes no identity; the exact single ledger is an
    // independent durable oracle.
    addFusion(db, 'malformed-ledger', {
      preconditionToken: 'not-a-token',
      appliedSkillVersion: 2,
    })
    addFusionVersion(db, 'malformed-ledger', 'skill-ledger', 2)

    addFusion(db, 'token-ledger-disagree', {
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 1,
        metaRevision: 0,
      }),
    })
    addFusionVersion(db, 'token-ledger-disagree', 'skill-other', 2)

    addFusion(db, 'duplicate-ledger', { status: 'applying' })
    addFusionVersion(db, 'duplicate-ledger', 'skill-duplicate', 1)
    addFusionVersion(db, 'duplicate-ledger', 'skill-duplicate', 2)

    addFusion(db, 'token-base-mismatch', {
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 2,
        metaRevision: 0,
      }),
    })

    addFusion(db, 'applied-version-mismatch', { appliedSkillVersion: 3 })
    addFusionVersion(db, 'applied-version-mismatch', 'skill-applied', 2)

    addFusion(db, 'sentinel-token', {
      preconditionToken: encodeSkillToken({
        skillId: QUARANTINED_FUSION_SKILL_ID,
        contentVersion: 1,
        metaRevision: 0,
      }),
    })

    addFusion(db, 'terminal-conflict', {
      status: 'done',
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 9,
        metaRevision: 0,
      }),
    })

    db.insert(memories)
      .values([
        {
          id: 'memory-exact',
          scopeType: 'global',
          scopeId: null,
          title: 'exact',
          bodyMd: 'body',
          status: 'fused',
          sourceKind: 'manual',
          createdAt: 1,
          fusedIntoSkill: 'historical',
          fusedIntoSkillId: QUARANTINED_FUSION_SKILL_ID,
          fusedIntoSkillVersion: 2,
          fusedFusionId: 'malformed-ledger',
        },
        {
          id: 'memory-wrong-version',
          scopeType: 'global',
          scopeId: null,
          title: 'wrong',
          bodyMd: 'body',
          status: 'fused',
          sourceKind: 'manual',
          createdAt: 2,
          fusedIntoSkill: 'historical',
          fusedIntoSkillId: 'skill-ledger',
          fusedIntoSkillVersion: 3,
          fusedFusionId: 'malformed-ledger',
        },
        {
          id: 'memory-quarantined-parent',
          scopeType: 'global',
          scopeId: null,
          title: 'quarantined',
          bodyMd: 'body',
          status: 'fused',
          sourceKind: 'manual',
          createdAt: 3,
          fusedIntoSkill: 'historical',
          fusedIntoSkillId: 'deleted-skill-id',
          fusedIntoSkillVersion: 2,
          fusedFusionId: 'token-ledger-disagree',
        },
        {
          id: 'memory-approved',
          scopeType: 'global',
          scopeId: null,
          title: 'approved',
          bodyMd: 'body',
          status: 'approved',
          sourceKind: 'manual',
          createdAt: 4,
        },
      ])
      .run()

    const first = repairFusionProvenance(db)
    expect(first.repairedFusions).toBe(2)
    expect(first.terminalizedFusions).toBe(1)
    expect(first.repairedMemories).toBe(1)
    expect(first.quarantinedMemories).toBe(2)

    const rows = db
      .select({ id: fusions.id, skillId: fusions.skillId, status: fusions.status })
      .from(fusions)
      .all()
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('token-only')?.skillId).toBe('deleted-skill-id')
    expect(byId.get('malformed-ledger')?.skillId).toBe('skill-ledger')
    for (const id of [
      'token-ledger-disagree',
      'duplicate-ledger',
      'token-base-mismatch',
      'applied-version-mismatch',
      'sentinel-token',
      'terminal-conflict',
    ]) {
      expect(byId.get(id)?.skillId).toBe(QUARANTINED_FUSION_SKILL_ID)
    }
    expect(byId.get('duplicate-ledger')?.status).toBe('failed')
    expect(byId.get('terminal-conflict')?.status).toBe('done')

    expect(
      db
        .select({ id: memories.id, skillId: memories.fusedIntoSkillId })
        .from(memories)
        .where(eq(memories.status, 'fused'))
        .all()
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: 'memory-exact', skillId: 'skill-ledger' },
      {
        id: 'memory-quarantined-parent',
        skillId: QUARANTINED_FUSION_SKILL_ID,
      },
      { id: 'memory-wrong-version', skillId: QUARANTINED_FUSION_SKILL_ID },
    ])
    expect(
      db
        .select({ skillId: memories.fusedIntoSkillId })
        .from(memories)
        .where(eq(memories.id, 'memory-approved'))
        .get(),
    ).toEqual({ skillId: null })

    expect(repairFusionProvenance(db)).toEqual({
      repairedFusions: 0,
      quarantinedFusions: 0,
      terminalizedFusions: 0,
      repairedMemories: 0,
      quarantinedMemories: 0,
    })
  })
})
