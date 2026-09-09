import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createInMemoryDb } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { skillOperations } from '@/db/schema'
import { loadLegacyIntentSkillOperationState } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'
import { skillOperationStateQuery } from '@/modules/resource-catalog/infrastructure/skillOperationStateQuery'
import { describeEachProvider, resolveTestProviders } from './helpers/eachProvider'
import { recordStatements } from './helpers/statementRecorder'
import { MIGRATIONS } from './migration-freeze'

type OperationRow = typeof skillOperations.$inferSelect

const operations: OperationRow[] = (
  [
    {
      opId: 'operation-active',
      skillId: 'skill-active',
      kind: 'reserve',
      phase: 'fs-staged',
      active: 1,
    },
    {
      opId: 'operation-done',
      skillId: 'skill-done',
      kind: 'version-write',
      phase: 'done',
      active: 0,
    },
    {
      opId: 'operation-partial',
      skillId: 'skill-partial',
      kind: 'migrate',
      phase: 'intent',
      active: 0,
    },
  ] satisfies Pick<OperationRow, 'opId' | 'skillId' | 'kind' | 'phase' | 'active'>[]
).map((row, index) => ({
  ...row,
  stagingPath: index === 0 ? 'staging/零' : null,
  backupPath: null,
  candidatePath: null,
  candidateFingerprint: null,
  backupFingerprint: null,
  targetVersion: index === 1 ? 7 : null,
  generation: index === 1 ? 3 : null,
  ownerUserId: null,
  preconditionJson: null,
  createdAt: 1_800_000_000_000 + index,
}))

// These are the three published read expressions, including their distinct tails.
function originalGet(db: ProviderNeutralDatabase, opId: string) {
  return db
    .select({ active: skillOperations.active, phase: skillOperations.phase })
    .from(skillOperations)
    .where(eq(skillOperations.opId, opId))
    .get()
}

async function originalAwaitedGet(db: ProviderNeutralDatabase, opId: string) {
  return await db
    .select({ active: skillOperations.active, phase: skillOperations.phase })
    .from(skillOperations)
    .where(eq(skillOperations.opId, opId))
    .get()
}

async function originalLimited(db: ProviderNeutralDatabase, opId: string) {
  return (
    await db
      .select({ active: skillOperations.active, phase: skillOperations.phase })
      .from(skillOperations)
      .where(eq(skillOperations.opId, opId))
      .limit(1)
  )[0]
}

async function candidateTails(db: ProviderNeutralDatabase, opId: string) {
  return [
    await skillOperationStateQuery(db, opId).get(),
    await skillOperationStateQuery(db, opId).get(),
    (await skillOperationStateQuery(db, opId).limit(1))[0],
  ]
}

async function readPhysicalRows(db: ProviderNeutralDatabase) {
  return await db.select().from(skillOperations).orderBy(skillOperations.opId).all()
}

describeEachProvider('RFC359 W36 skill operation state query', (harness) => {
  beforeEach(async () => {
    await harness.db.insert(skillOperations).values(operations).run()
  })

  test('preserves all three tails, ordered bindings, two-field rows and missing results', async () => {
    const before = await readPhysicalRows(harness.db)
    const recording = harness.recordStatements()
    try {
      for (const opId of [...operations.map((row) => row.opId), 'operation-missing']) {
        const start = recording.statements.length
        const original = [
          await originalGet(harness.db, opId),
          await originalAwaitedGet(harness.db, opId),
          await originalLimited(harness.db, opId),
        ]
        const originalStatements = recording.statements.slice(start)
        const candidate = await candidateTails(harness.db, opId)
        const candidateStatements = recording.statements.slice(start + originalStatements.length)
        const row = operations.find((operation) => operation.opId === opId)
        const expected = row === undefined ? undefined : { active: row.active, phase: row.phase }
        expect(original).toEqual([expected, expected, expected])
        expect(candidate).toEqual(original)
        expect(originalStatements).toHaveLength(3)
        expect(candidateStatements).toEqual(originalStatements)
        expect(originalStatements.map((statement) => statement.values)).toEqual([
          [opId],
          [opId],
          [opId, 1],
        ])
        expect(originalStatements.map((statement) => statement.params)).toEqual([1, 1, 2])
      }
    } finally {
      recording.stop()
    }
    expect(await readPhysicalRows(harness.db)).toEqual(before)
    expect(JSON.stringify(await readPhysicalRows(harness.db))).toBe(JSON.stringify(before))
  })

  test('constructs both query shapes lazily and executes each chosen terminal once', async () => {
    const recording = harness.recordStatements()
    try {
      const getQuery = skillOperationStateQuery(harness.db, 'operation-active')
      const limitedQuery = skillOperationStateQuery(harness.db, 'operation-done').limit(1)
      expect(recording.statements).toHaveLength(0)
      expect(await getQuery.get()).toEqual({ active: 1, phase: 'fs-staged' })
      expect(recording.statements).toHaveLength(1)
      expect(await limitedQuery).toEqual([{ active: 0, phase: 'done' }])
      expect(recording.statements).toHaveLength(2)
    } finally {
      recording.stop()
    }
  })

  test('reads the caller transaction and leaves every physical field unchanged on rollback', async () => {
    const before = await readPhysicalRows(harness.db)
    const failure = new Error('rollback operation state read')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx
          .update(skillOperations)
          .set({ active: 0, phase: 'done' })
          .where(eq(skillOperations.opId, 'operation-active'))
          .run()
        expect(await candidateTails(tx, 'operation-active')).toEqual([
          { active: 0, phase: 'done' },
          { active: 0, phase: 'done' },
          { active: 0, phase: 'done' },
        ])
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await readPhysicalRows(harness.db)).toEqual(before)
    expect(JSON.stringify(await readPhysicalRows(harness.db))).toBe(JSON.stringify(before))
  })
})

if (resolveTestProviders(process.env).includes('sqlite')) {
  test('native compatibility loader returns the actual row or undefined immediately', () => {
    const db = createInMemoryDb(MIGRATIONS)
    try {
      db.insert(skillOperations).values(operations).run()
      const recording = recordStatements(db.$client)
      try {
        const builder = skillOperationStateQuery(db, 'operation-done')
        expect(recording.statements).toHaveLength(0)
        for (const opId of [...operations.map((row) => row.opId), 'operation-missing']) {
          const returned = loadLegacyIntentSkillOperationState(db, opId)
          const row = operations.find((operation) => operation.opId === opId)
          expect(returned).not.toBeInstanceOf(Promise)
          expect(returned).toEqual(
            row === undefined ? undefined : { active: row.active, phase: row.phase },
          )
        }
        expect(recording.statements).toHaveLength(4)
        expect(builder.get()).toEqual({ active: 0, phase: 'done' })
        expect(recording.statements).toHaveLength(5)
      } finally {
        recording.stop()
      }
    } finally {
      db.$client.close()
    }
  })
}
