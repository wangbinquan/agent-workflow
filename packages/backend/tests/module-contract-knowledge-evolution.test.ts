// Module contract audit: the existing fusion-engine/V20 suites cover proposal and approval.
// This closes the gap between KE's public restore participant and Memory's real transactional
// implementation: caller rollback, repeated restore, and a constant-size batch write.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAsyncSkillRestoreMembership } from '@/modules/knowledge-evolution/public/participants'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'

async function seedFused(db: PersistenceDb, id: string, skillId: string, version: number) {
  const { memories } = tablesOf(db)
  await insertOne(db, memories, {
    id,
    scopeType: 'global',
    scopeId: null,
    title: id,
    bodyMd: `knowledge ${id}`,
    status: 'fused',
    sourceKind: 'manual',
    tags: '[]',
    version: 1,
    fusedIntoSkillId: skillId,
    fusedIntoSkill: 'contract-skill',
    fusedIntoSkillVersion: version,
    fusedAt: 100,
    fusedByUserId: 'contract-editor',
    fusedFusionId: 'contract-fusion',
    createdAt: 10,
  })
}

describeEachProvider('module contract — knowledge-evolution restore membership', (harness) => {
  test('the public participant changes only versions newer than the restored version and repeated calls are empty', async () => {
    await seedFused(harness.db, 'ke-newer', 'skill-contract', 3)
    await seedFused(harness.db, 'ke-equal', 'skill-contract', 2)
    await seedFused(harness.db, 'ke-other', 'skill-other', 3)
    const participant = createAsyncSkillRestoreMembership(
      composeSkillMemoryFusionParticipantFactory(),
    )
    const request = { skillId: 'skill-contract', targetVersion: 2 }
    expect(
      await harness.session.transaction((tx) => participant.unfuseForRestore(tx, request)),
    ).toEqual(['ke-newer'])
    expect(
      await harness.session.transaction((tx) => participant.unfuseForRestore(tx, request)),
    ).toEqual([])
    const { memories } = tablesOf(harness.db)
    const rows = await harness.db.select().from(memories)
    expect(rows.find((row) => row.id === 'ke-newer')).toMatchObject({
      status: 'approved',
      bodyMd: 'knowledge ke-newer',
      fusedIntoSkillId: null,
      fusedIntoSkill: null,
      fusedIntoSkillVersion: null,
      fusedAt: null,
      fusedByUserId: null,
      fusedFusionId: null,
    })
    expect(rows.find((row) => row.id === 'ke-equal')).toMatchObject({
      status: 'fused',
      fusedIntoSkillVersion: 2,
    })
    expect(rows.find((row) => row.id === 'ke-other')).toMatchObject({
      status: 'fused',
      fusedIntoSkillId: 'skill-other',
    })
  })

  test('a failure later in the caller transaction rolls back membership and provenance together', async () => {
    await seedFused(harness.db, 'ke-rollback', 'skill-contract', 7)
    const { memories } = tablesOf(harness.db)
    const read = () => harness.db.select().from(memories).where(eq(memories.id, 'ke-rollback'))
    const before = await read()
    const participant = createAsyncSkillRestoreMembership(
      composeSkillMemoryFusionParticipantFactory(),
    )
    const failure = new Error('skill version commit failed after membership update')
    await expect(
      harness.session.transaction(async (tx) => {
        expect(
          await participant.unfuseForRestore(tx, { skillId: 'skill-contract', targetVersion: 1 }),
        ).toEqual(['ke-rollback'])
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await read()).toEqual(before)
    expect(
      await harness.session.transaction((tx) =>
        participant.unfuseForRestore(tx, { skillId: 'skill-contract', targetVersion: 1 }),
      ),
    ).toEqual(['ke-rollback'])
  })

  test('a large restore is one memory mutation, returns deterministic ids and never writes one row at a time', async () => {
    const ids = Array.from(
      { length: 64 },
      (_, index) => `ke-batch-${String(index).padStart(3, '0')}`,
    )
    for (const id of [...ids].reverse()) await seedFused(harness.db, id, 'skill-contract', 3)
    const participant = createAsyncSkillRestoreMembership(
      composeSkillMemoryFusionParticipantFactory(),
    )
    const recording = harness.recordStatements()
    try {
      const receipt = await harness.session.transaction((tx) =>
        participant.unfuseForRestore(tx, { skillId: 'skill-contract', targetVersion: 2 }),
      )
      expect(receipt).toEqual(ids)
    } finally {
      recording.stop()
    }
    const writes = recording.statements.filter(
      ({ sql }) => /^\s*update\b/i.test(sql) && /"memories"/.test(sql),
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]!.rows).toBe(64)
    expect(writes[0]!.params).toBeLessThan(20)
  })
})
