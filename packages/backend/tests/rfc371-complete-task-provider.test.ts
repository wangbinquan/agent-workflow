// RFC-371: full original population, exact four buckets and CNY; missing one row never becomes a complete total.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  observationUsageCurrent,
  observationUsageCaptures,
  observationPriceVersions,
  nodeRuns,
  tasks,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import {
  buildOriginalCompleteTask,
  completeFixtureId,
  completeTaskRecord,
  seedCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 complete original Task statistics', (harness) => {
  test('all 1001 attempts/invocations and 10001 original records contribute exact bins, timing and frozen CNY', async () => {
    await seedCompleteTask(harness)
    const result = await buildOriginalCompleteTask(harness)
    const sum = (10001n * 10002n) / 2n
    expect(result.summary.metrics).toEqual({
      state: 'ready',
      invocations: '1001',
      observedInvocations: '1001',
      records: '10001',
      tokens: {
        input: String(sum),
        cacheRead: String(sum * 3n),
        cacheWrite: String(sum * 5n),
        output: String(sum * 7n),
        total: String(sum * 16n),
      },
      cost: { currency: 'CNY', state: 'complete', amount: '2500.75005' },
    })
    expect(String(result.originals[0]?.records)).toBe('10001')
    expect(result.summary.attemptCount).toBe('1001')
    expect(result.summary.timing).toEqual({
      wallMs: '10002',
      runningMs: '10002',
      range: { from: 1790985600000, to: 1790985601010 },
      intervals: { state: 'complete', cumulativeMs: '10010', activeUnionMs: '1010', unknown: '0' },
    })
    expect(result.attempts.map((row) => row.id)).toEqual(
      Array.from({ length: 1001 }, (_, n) => completeFixtureId('run', n)),
    )
    expect(
      result.attempts.every(
        (row) =>
          row.computeKind === 'agent' && row.metrics.state === 'ready' && row.durationMs === '10',
      ),
    ).toBe(true)
    expect(result.allocations).toHaveLength(10001)
    expect(result.allocations.map((row) => row.recordId).sort()).toEqual(
      Array.from({ length: 10001 }, (_, n) => completeFixtureId('meter', n)),
    )
    for (const row of result.allocations) {
      const n = Number(row.recordId.split('-').at(-1))
      expect(row.contribution).toEqual(completeTaskRecord(n, 1001).contribution)
      expect(row.cost.complete).toBe(true)
      expect(row.cost.hidden).toBe(false)
    }
    expect(result.sourceReceipts.every((receipt) => receipt.eof)).toBe(true)
  }, 120000)
  test('one missing original numeric record hides all totals instead of publishing a lower bound', async () => {
    await seedCompleteTask(harness, 2, 5)
    const row = completeTaskRecord(4, 2)
    await harness.db
      .delete(observationUsageCurrent)
      .where(
        eq(
          observationUsageCurrent.id,
          sha256Hex(
            JSON.stringify([row.sourceId, row.measurement.invocationId, row.measurement.recordId]),
          ),
        ),
      )
      .run()
    const result = await buildOriginalCompleteTask(harness, 5)
    expect(result.summary.metrics).toEqual({
      state: 'not-ready',
      gaps: ['native-capture-records-missing'],
      costCoverage: { records: '4', pricedRecords: '4', visibility: 'visible' },
      tokenCoverage: {
        invocations: '2',
        observedInvocations: '2',
        records: '4',
        bucketRecords: { input: '4', cacheRead: '4', cacheWrite: '4', output: '4' },
      },
      recordedUsage: {
        invocations: '2',
        observedInvocations: '2',
        records: '4',
        bucketRecords: { input: '4', cacheRead: '4', cacheWrite: '4', output: '4' },
        tokens: { input: '10', cacheRead: '30', cacheWrite: '50', output: '70', total: '160' },
      },
      recordedCost: { currency: 'CNY', amount: '0.0005', records: '4', pricedRecords: '4' },
    })
    expect(result.summary.metrics).not.toHaveProperty('tokens')
    expect(result.summary.metrics).not.toHaveProperty('cost')
    expect(result.attempts[0]?.metrics.state).toBe('not-ready')
    expect(result.attempts[1]?.metrics.state).toBe('ready')
  })
  test('missing capture proof and an unknown started Agent are never interpreted as zero', async () => {
    await seedCompleteTask(harness, 2, 5)
    await harness.db
      .delete(observationUsageCaptures)
      .where(eq(observationUsageCaptures.invocationId, completeFixtureId('invocation', 1)))
      .run()
    await harness.db
      .insert(nodeRuns)
      .values({
        id: 'uncaptured-run',
        taskId: 'complete-original-task',
        nodeId: 'unknown-original-node',
        status: 'done',
        startedAt: 1790985600000,
        finishedAt: 1790985600001,
      })
      .run()
    const result = await buildOriginalCompleteTask(harness, 5)
    expect(result.summary.metrics.state).toBe('not-ready')
    if (result.summary.metrics.state === 'not-ready')
      expect(result.summary.metrics.gaps).toEqual([
        'native-capture-unobserved',
        'invocation-unobserved',
      ])
    expect(result.attempts.find((row) => row.id === 'uncaptured-run')?.metrics.state).toBe(
      'not-ready',
    )
  })
  test('unpriced records retain every token bucket and hide the whole CNY amount', async () => {
    await seedCompleteTask(harness, 2, 5)
    await harness.db.delete(observationPriceVersions).run()
    const result = await buildOriginalCompleteTask(harness, 5)
    expect(result.summary.metrics).toEqual({
      state: 'ready',
      invocations: '2',
      observedInvocations: '2',
      records: '5',
      tokens: { input: '15', cacheRead: '45', cacheWrite: '75', output: '105', total: '240' },
      cost: { currency: 'CNY', state: 'unpriced', amount: null },
    })
  })
  test('a frozen explicit non-Agent is not charged while malformed original node metadata remains unknown', async () => {
    await seedCompleteTask(harness, 1, 1)
    await harness.db
      .update(tasks)
      .set({
        workflowSnapshot: JSON.stringify({
          nodes: [
            { id: completeFixtureId('node', 0), kind: 'agent-single' },
            { id: 'passive', kind: 'input' },
          ],
        }),
      })
      .where(eq(tasks.id, 'complete-original-task'))
      .run()
    await harness.db
      .insert(nodeRuns)
      .values({
        id: 'passive-run',
        taskId: 'complete-original-task',
        nodeId: 'passive',
        status: 'done',
        startedAt: 1790985600000,
        finishedAt: 1790985600001,
      })
      .run()
    expect(
      (await buildOriginalCompleteTask(harness, 1)).attempts.find((row) => row.id === 'passive-run')
        ?.metrics,
    ).toEqual({ state: 'not-applicable' })
    await harness.db
      .update(tasks)
      .set({ workflowSnapshot: '{invalid' })
      .where(eq(tasks.id, 'complete-original-task'))
      .run()
    const result = await buildOriginalCompleteTask(harness, 1)
    expect(result.summary.metrics.state).toBe('not-ready')
    expect(result.attempts.find((row) => row.id === 'passive-run')?.computeKind).toBe('unknown')
  })
})
