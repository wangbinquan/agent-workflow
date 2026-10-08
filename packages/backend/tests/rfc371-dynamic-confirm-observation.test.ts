// Real dynamic task 01M4CJ3CE7BZGX70D5P87GS4YM: a human confirm gate was mistaken for lost model usage.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { nodeRuns, tasks } from '@/db/schema'
import {
  buildOriginalCompleteTask,
  COMPLETE_NOW,
  seedCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 original dynamic confirmation accounting', (harness) => {
  test('a retained human confirmation keeps all attempts and the full original numeric total after DAG replacement', async () => {
    await seedCompleteTask(harness, 2, 5)
    const before = await buildOriginalCompleteTask(harness, 5)
    await harness.db
      .update(tasks)
      .set({
        workgroupId: 'original-dynamic-group',
        workgroupConfigJson: JSON.stringify({ mode: 'dynamic_workflow' }),
      })
      .where(eq(tasks.id, 'complete-original-task'))
      .run()
    await harness.db
      .insert(nodeRuns)
      .values({
        id: 'dw-original-confirm',
        taskId: 'complete-original-task',
        nodeId: '__dw_orchestrator__',
        rerunCause: 'dw-gate',
        status: 'done',
        startedAt: COMPLETE_NOW + 1,
        finishedAt: COMPLETE_NOW + 2,
      })
      .run()
    const after = await buildOriginalCompleteTask(harness, 5)
    expect(before.summary.metrics.state).toBe('ready')
    expect(after.summary.metrics).toEqual(before.summary.metrics)
    expect(after.summary.attemptCount).toBe('3')
    expect(after.attempts).toHaveLength(3)
    expect(after.attempts.find((row) => row.id === 'dw-original-confirm')).toMatchObject({
      computeKind: 'non-agent',
      metrics: { state: 'not-applicable' },
      durationMs: '1',
    })
    expect(after.allocations).toEqual(before.allocations)
    expect(after.sourceReceipts.every((receipt) => receipt.eof)).toBe(true)
  })

  for (const scenario of [
    {
      name: 'a real generation with missing invocation',
      cause: 'dw-generate',
      config: '{"mode":"dynamic_workflow"}',
      group: 'original-dynamic-group',
      kind: 'agent',
    },
    {
      name: 'an ordinary task using the same node ID',
      cause: 'dw-gate',
      config: null,
      group: null,
      kind: 'unknown',
    },
    {
      name: 'a dynamic node with an unknown cause',
      cause: 'unknown',
      config: '{"mode":"dynamic_workflow"}',
      group: 'original-dynamic-group',
      kind: 'unknown',
    },
    {
      name: 'an invalid original group configuration',
      cause: 'dw-gate',
      config: '{broken',
      group: 'original-dynamic-group',
      kind: 'unknown',
    },
  ]) {
    test(`${scenario.name} retains the missing-use gap`, async () => {
      await seedCompleteTask(harness, 1, 1)
      await harness.db
        .update(tasks)
        .set({ workgroupId: scenario.group, workgroupConfigJson: scenario.config })
        .where(eq(tasks.id, 'complete-original-task'))
        .run()
      await harness.db
        .insert(nodeRuns)
        .values({
          id: 'unobserved-original-run',
          taskId: 'complete-original-task',
          nodeId: '__dw_orchestrator__',
          rerunCause: scenario.cause,
          status: 'done',
          startedAt: COMPLETE_NOW,
          finishedAt: COMPLETE_NOW + 1,
        })
        .run()
      const result = await buildOriginalCompleteTask(harness, 1)
      expect(result.summary.metrics.state).toBe('not-ready')
      expect(result.summary.metrics).toMatchObject({ gaps: ['invocation-unobserved'] })
      expect(result.attempts.find((row) => row.id === 'unobserved-original-run')).toMatchObject({
        computeKind: scenario.kind,
        metrics: { state: 'not-ready' },
      })
      expect(result.allocations).toHaveLength(1)
    })
  }
})
