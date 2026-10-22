import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first as firstRow } from '@/platform/persistence/queryHelpers'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { repairFusionProvenance } from '../src/modules/knowledge-evolution/application/fusionOrchestration'
import { encodeSkillToken } from '../src/modules/resource-catalog/application/skills/skillToken'
import { composeFusionPersistenceFor } from '../src/modules/knowledge-evolution/composition/fusion'
import { QUARANTINED_FUSION_SKILL_ID } from '../src/services/systemResources'
import { TEST_FUSION_PARTICIPANTS } from './helpers/fusionParticipants'
import { describeEachProvider } from './helpers/eachProvider'

async function addSkill(db: PersistenceDb, id: string): Promise<void> {
  const { skills } = tablesOf(db)
  await insertOne(db, skills, {
    id,
    name: `name-${id}`,
    managedPath: `skills/${id}/files`,
    contentVersion: 10,
    versionState: 'snapshot-authoritative',
  })
}

async function addFusionVersion(
  db: PersistenceDb,
  fusionId: string,
  skillId: string,
  versionIndex: number,
): Promise<void> {
  const { skillVersions } = tablesOf(db)
  await insertOne(db, skillVersions, {
    id: `version-${fusionId}-${skillId}-${versionIndex}`,
    skillId,
    versionIndex,
    filesPath: `skills/${skillId}/versions/v${versionIndex}/files`,
    source: 'fusion',
    fusionId,
    createdAt: versionIndex,
  })
}

async function addFusion(
  db: PersistenceDb,
  id: string,
  patch: Partial<PersistenceTables['fusions']['$inferInsert']> = {},
): Promise<void> {
  const { fusions } = tablesOf(db)
  await insertOne(db, fusions, {
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
}

describeEachProvider('RFC-223 fusion provenance boot repair', (harness) => {
  test('uses only trustworthy token/ledger oracles, quarantines conflicts, and is idempotent', async () => {
    const db = harness.db
    const persistence = composeFusionPersistenceFor({
      ...TEST_FUSION_PARTICIPANTS,
      db,
      appHome: resolve(import.meta.dir, '.rfc223-unused-app-home'),
    })
    for (const id of ['skill-ledger', 'skill-other', 'skill-duplicate', 'skill-applied']) {
      await addSkill(db, id)
    }

    // Token-only remains trustworthy even after the current skill row was deleted.
    await addFusion(db, 'token-only', {
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 1,
        metaRevision: 0,
      }),
    })

    // A malformed token contributes no identity; the exact single ledger is an
    // independent durable oracle.
    await addFusion(db, 'malformed-ledger', {
      preconditionToken: 'not-a-token',
      appliedSkillVersion: 2,
    })
    await addFusionVersion(db, 'malformed-ledger', 'skill-ledger', 2)

    await addFusion(db, 'token-ledger-disagree', {
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 1,
        metaRevision: 0,
      }),
    })
    await addFusionVersion(db, 'token-ledger-disagree', 'skill-other', 2)

    await addFusion(db, 'duplicate-ledger', { status: 'applying' })
    await addFusionVersion(db, 'duplicate-ledger', 'skill-duplicate', 1)
    await addFusionVersion(db, 'duplicate-ledger', 'skill-duplicate', 2)

    await addFusion(db, 'token-base-mismatch', {
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 2,
        metaRevision: 0,
      }),
    })

    await addFusion(db, 'applied-version-mismatch', { appliedSkillVersion: 3 })
    await addFusionVersion(db, 'applied-version-mismatch', 'skill-applied', 2)

    await addFusion(db, 'sentinel-token', {
      preconditionToken: encodeSkillToken({
        skillId: QUARANTINED_FUSION_SKILL_ID,
        contentVersion: 1,
        metaRevision: 0,
      }),
    })

    await addFusion(db, 'terminal-conflict', {
      status: 'done',
      preconditionToken: encodeSkillToken({
        skillId: 'deleted-skill-id',
        contentVersion: 9,
        metaRevision: 0,
      }),
    })

    const { memories, fusions } = tablesOf(db)
    await db.insert(memories).values([
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

    const first = await repairFusionProvenance(persistence)
    expect(first.repairedFusions).toBe(2)
    expect(first.terminalizedFusions).toBe(1)
    expect(first.repairedMemories).toBe(1)
    expect(first.quarantinedMemories).toBe(2)

    const rows = await db
      .select({ id: fusions.id, skillId: fusions.skillId, status: fusions.status })
      .from(fusions)
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
      (
        await db
          .select({ id: memories.id, skillId: memories.fusedIntoSkillId })
          .from(memories)
          .where(eq(memories.status, 'fused'))
      ).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: 'memory-exact', skillId: 'skill-ledger' },
      {
        id: 'memory-quarantined-parent',
        skillId: QUARANTINED_FUSION_SKILL_ID,
      },
      { id: 'memory-wrong-version', skillId: QUARANTINED_FUSION_SKILL_ID },
    ])
    expect(
      await firstRow(
        db
          .select({ skillId: memories.fusedIntoSkillId })
          .from(memories)
          .where(eq(memories.id, 'memory-approved')),
      ),
    ).toEqual({ skillId: null })

    expect(await repairFusionProvenance(persistence)).toEqual({
      repairedFusions: 0,
      quarantinedFusions: 0,
      terminalizedFusions: 0,
      repairedMemories: 0,
      quarantinedMemories: 0,
    })
  })
})
