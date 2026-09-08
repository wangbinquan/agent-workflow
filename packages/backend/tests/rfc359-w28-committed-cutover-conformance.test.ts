// RFC-359 W28 — the native cutover CAS also serves real asynchronous transactions.
// Trigger failures and readback interference use the selected physical database.
// PostgreSQL execution is provided by the default dual-provider hosted lane.

import { expect, test } from 'bun:test'
import { and, asc, eq } from 'drizzle-orm'

import { committedEventAggregateHeads, committedEventFamilyCutovers } from '@/db/schema'
import {
  changeCommittedEventCutover,
  readCommittedEventCutover,
} from '@/platform/events/committed/append'
import type { CommittedEventCutover } from '@/platform/events/committed/types'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const NOW = 1_789_488_100_000
type Change = Parameters<typeof changeCommittedEventCutover>[1]
const family = and(
  eq(committedEventFamilyCutovers.producer, 'collaboration'),
  eq(committedEventFamilyCutovers.family, 'review'),
)

function change(overrides: Partial<Change> = {}): Change {
  return {
    producer: 'collaboration',
    family: 'review',
    expectedMode: 'legacy',
    expectedEpoch: 1,
    mode: 'shadow',
    changedAt: NOW,
    changeRef: 'w28:shadow',
    ...overrides,
  }
}

async function seed(harness: ProviderHarness): Promise<void> {
  await harness.db
    .update(committedEventFamilyCutovers)
    .set({ mode: 'legacy', epoch: 1, changedAt: NOW - 1, changeRef: 'w28:legacy' })
    .where(family)
    .run()
}

async function rows(harness: ProviderHarness) {
  return await harness.db
    .select()
    .from(committedEventFamilyCutovers)
    .orderBy(asc(committedEventFamilyCutovers.producer), asc(committedEventFamilyCutovers.family))
    .all()
}

function cutoverSql(statements: readonly RecordedStatement[]): readonly RecordedStatement[] {
  return statements.filter(
    ({ sql }) =>
      /^\s*(update|select)\b/i.test(sql) && sql.includes('committed_event_family_cutovers'),
  )
}

async function failureOf(operation: PromiseLike<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (!(error instanceof Error)) throw error
    let failure = error
    while (failure.cause instanceof Error) failure = failure.cause
    return failure
  }
  throw new Error('expected operation to fail')
}

async function installWriteFailure(harness: ProviderHarness): Promise<() => Promise<void>> {
  const name = 'w28_cutover_fail_write'
  if (harness.capabilities.provider === 'sqlite') {
    await harness.executeFixtureDdl(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON committed_event_family_cutovers
       WHEN NEW.change_ref = 'w28:fail-write'
       BEGIN SELECT RAISE(ABORT, 'w28 cutover writer failure'); END`,
    )
    return async () => await harness.executeFixtureDdl(`DROP TRIGGER ${name}`)
  }
  await harness.executeFixtureDdl(
    `CREATE FUNCTION agent_workflow.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.change_ref = 'w28:fail-write' THEN
         RAISE EXCEPTION 'w28 cutover writer failure';
       END IF;
       RETURN NEW;
     END $$`,
  )
  const removeFunction = async () =>
    await harness.executeFixtureDdl(`DROP FUNCTION agent_workflow.${name}()`)
  try {
    await harness.executeFixtureDdl(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON agent_workflow.committed_event_family_cutovers
       FOR EACH ROW EXECUTE FUNCTION agent_workflow.${name}()`,
    )
  } catch (error) {
    await removeFunction()
    throw error
  }
  return async () => {
    try {
      await harness.executeFixtureDdl(
        `DROP TRIGGER ${name} ON agent_workflow.committed_event_family_cutovers`,
      )
    } finally {
      await removeFunction()
    }
  }
}

describeEachProvider('RFC-359 W28 committed cutover transaction', (harness) => {
  test('preserves all fields, exact bindings and existing same/backward-mode transitions', async () => {
    await seed(harness)
    const before = await rows(harness)
    const modes = ['shadow', 'shadow', 'legacy', 'dispatchable'] as const
    let expectedMode: CommittedEventCutover['mode'] = 'legacy'
    for (const [index, mode] of modes.entries()) {
      const input = change({
        expectedMode,
        expectedEpoch: index + 1,
        mode,
        changedAt: index === 0 ? NOW : 0,
        changeRef: ` \nraw:${index}:雪\t `,
      })
      const recording = harness.recordStatements()
      const receipt = await harness.session
        .transaction(async (tx) => await changeCommittedEventCutover(tx, input))
        .finally(() => recording.stop())
      const expected = {
        producer: input.producer,
        family: input.family,
        mode,
        epoch: input.expectedEpoch + 1,
        changedAt: input.changedAt,
        changeRef: input.changeRef,
      }
      expect(receipt).toEqual(expected)
      expect(await rows(harness)).toEqual(
        before.map((row) =>
          row.producer === 'collaboration' && row.family === 'review' ? expected : row,
        ),
      )
      const statements = cutoverSql(recording.statements)
      expect(statements.map(({ sql }) => sql.trim().split(' ')[0]?.toLowerCase())).toEqual([
        'update',
        'select',
      ])
      expect(statements.map(({ values }) => values)).toEqual([
        [
          mode,
          input.expectedEpoch + 1,
          input.changedAt,
          input.changeRef,
          'collaboration',
          'review',
          expectedMode,
          input.expectedEpoch,
        ],
        ['collaboration', 'review'],
      ])
      expect(statements.map(({ params }) => params)).toEqual([8, 2])
      expectedMode = mode
    }
  })

  test('validates epoch, timestamp and reference before issuing cutover SQL', async () => {
    await seed(harness)
    const before = await rows(harness)
    const invalid: readonly (readonly [Partial<Change>, string])[] = [
      [
        { expectedEpoch: 0, changedAt: -1, changeRef: '' },
        'expectedEpoch must be a positive safe integer',
      ],
      [{ expectedEpoch: 1.5 }, 'expectedEpoch must be a positive safe integer'],
      [{ changedAt: -1 }, 'committed event cutover change requires time and durable ref'],
      [{ changedAt: Number.NaN }, 'committed event cutover change requires time and durable ref'],
      [{ changeRef: '' }, 'committed event cutover change requires time and durable ref'],
    ]
    for (const [input, message] of invalid) {
      const recording = harness.recordStatements()
      const error = await failureOf(
        harness.session.transaction(
          async (tx) => await changeCommittedEventCutover(tx, change(input)),
        ),
      ).finally(() => recording.stop())
      expect(error.message).toBe(message)
      expect(cutoverSql(recording.statements)).toEqual([])
      expect(await rows(harness)).toEqual(before)
    }
  })

  test('a stale mode does not write or read back another transition', async () => {
    await seed(harness)
    const before = await rows(harness)
    const recording = harness.recordStatements()
    const error = await failureOf(
      harness.session.transaction(
        async (tx) => await changeCommittedEventCutover(tx, change({ expectedMode: 'shadow' })),
      ),
    ).finally(() => recording.stop())
    expect(error.message).toBe('committed event cutover changed concurrently: collaboration/review')
    expect(cutoverSql(recording.statements).map(({ values }) => values)).toEqual([
      ['shadow', 2, NOW, 'w28:shadow', 'collaboration', 'review', 'shadow', 1],
    ])
    expect(await rows(harness)).toEqual(before)
  })

  test('a stale epoch does not write or read back another transition', async () => {
    await seed(harness)
    const before = await rows(harness)
    const recording = harness.recordStatements()
    const error = await failureOf(
      harness.session.transaction(
        async (tx) => await changeCommittedEventCutover(tx, change({ expectedEpoch: 2 })),
      ),
    ).finally(() => recording.stop())
    expect(error.message).toBe('committed event cutover changed concurrently: collaboration/review')
    expect(cutoverSql(recording.statements).map(({ values }) => values)).toEqual([
      ['shadow', 3, NOW, 'w28:shadow', 'collaboration', 'review', 'legacy', 2],
    ])
    expect(await rows(harness)).toEqual(before)
  })

  test('a missing row loses CAS before the readback step', async () => {
    await seed(harness)
    await harness.db.delete(committedEventFamilyCutovers).where(family).run()
    const before = await rows(harness)
    const recording = harness.recordStatements()
    const error = await failureOf(
      harness.session.transaction(async (tx) => await changeCommittedEventCutover(tx, change())),
    ).finally(() => recording.stop())
    expect(error.message).toBe('committed event cutover changed concurrently: collaboration/review')
    expect(cutoverSql(recording.statements)).toHaveLength(1)
    expect(recording.selects()).toEqual([])
    expect(await rows(harness)).toEqual(before)
  })

  test('propagates the actual writer error and leaves the complete row unchanged', async () => {
    await seed(harness)
    const before = await rows(harness)
    const remove = await installWriteFailure(harness)
    try {
      const error = await failureOf(
        harness.session.transaction(
          async (tx) =>
            await changeCommittedEventCutover(tx, change({ changeRef: 'w28:fail-write' })),
        ),
      )
      expect(error.message).toBe('w28 cutover writer failure')
      expect(await rows(harness)).toEqual(before)
    } finally {
      await remove()
    }
  })

  test('a successful update with missing readback rolls the real transaction back', async () => {
    // This controlled interleaving exercises the shared readback branch. It
    // deletes a real row on the same transaction after the actual UPDATE;
    // it does not claim to model an external PostgreSQL concurrent writer.
    const { changeCommittedEventCutoverProgram } =
      await import('@/platform/events/committed/appendProgram')
    const { driveAsyncProgram } = await import('@/platform/persistence/transactionProgram')
    await seed(harness)
    const before = await rows(harness)
    const recording = harness.recordStatements()
    let steps = 0
    const error = await failureOf(
      harness.session.transaction(
        async (tx) =>
          await driveAsyncProgram(
            changeCommittedEventCutoverProgram(tx, change()),
            async (step) => {
              await step()
              steps += 1
              if (steps === 1) await tx.delete(committedEventFamilyCutovers).where(family).run()
            },
          ),
      ),
    ).finally(() => recording.stop())
    expect(error.message).toBe('committed event cutover is missing: collaboration/review')
    expect(steps).toBe(2)
    expect(cutoverSql(recording.statements).map(({ values }) => values)).toEqual([
      ['shadow', 2, NOW, 'w28:shadow', 'collaboration', 'review', 'legacy', 1],
      ['collaboration', 'review'],
    ])
    expect(await rows(harness)).toEqual(before)
  })

  test('an outer failure rolls back cutover and a real companion write together', async () => {
    await seed(harness)
    const before = await rows(harness)
    const beforeHeads = await harness.db.select().from(committedEventAggregateHeads).all()
    const stop = new Error('w28 outer rollback')
    const error = await failureOf(
      harness.session.transaction(async (tx) => {
        const receipt = await changeCommittedEventCutover(tx, change())
        expect(await readCommittedEventCutover(tx, 'collaboration', 'review')).toEqual(receipt)
        await tx
          .insert(committedEventAggregateHeads)
          .values({
            producer: 'collaboration',
            family: 'review',
            aggregateKind: 'review-round',
            aggregateId: 'w28-companion',
            lastSeq: 17,
            updatedAt: NOW,
          })
          .run()
        throw stop
      }),
    )
    expect(error).toBe(stop)
    expect(await rows(harness)).toEqual(before)
    expect(await harness.db.select().from(committedEventAggregateHeads).all()).toEqual(beforeHeads)
  })

  test('two transactions expecting the same epoch have exactly one stored winner', async () => {
    await seed(harness)
    const before = await rows(harness)
    const settled = await Promise.allSettled(
      ['a', 'b'].map((name) =>
        harness.session.transaction(
          async (tx) => await changeCommittedEventCutover(tx, change({ changeRef: `w28:${name}` })),
        ),
      ),
    )
    const winners = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    const failures = settled.filter((result) => result.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBeInstanceOf(Error)
    expect(failures[0]?.reason.message).toBe(
      'committed event cutover changed concurrently: collaboration/review',
    )
    expect(await rows(harness)).toEqual(
      before.map((row) =>
        row.producer === 'collaboration' && row.family === 'review' ? winners[0]! : row,
      ),
    )
  })
})
