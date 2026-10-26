// Q-3: task cleanup must not erase the independently retained usage and price ledger.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createTaskDeletionParticipantInTx } from '@/modules/task-execution/public/participants'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, nodeRunFixture } from './helpers/model'

describeEachProvider('Q-3 independent observation retention', (h) => {
  test('deleting a root and descendant removes runs but preserves exact call, model and price rows', async () => {
    const definition = {
      workflowId: 'q3-retained-workflow',
      workflowSnapshot: '{}',
      inputs: '{}',
      repoPath: '',
      worktreePath: '',
      baseBranch: '',
      branch: 'q3-cost',
      status: 'done' as const,
      startedAt: 1,
    }
    await taskFixture(h.db, { ...definition, id: 'q3-cost-root' })
    await taskFixture(h.db, { ...definition, id: 'q3-cost-child', parentTaskId: 'q3-cost-root' })
    await nodeRunFixture(h.db, {
      id: 'q3-cost-run',
      taskId: 'q3-cost-child',
      nodeId: 'worker',
      status: 'done',
    })
    const { observationCalls, observationCallModels, observationPrices, tasks, nodeRuns } =
      tablesOf(h.db)
    await h.db.insert(observationPrices).values({
      id: 'q3-price',
      runtimeId: 'retained-runtime',
      model: 'retained-model',
      inputMicro: 123,
      outputMicro: 456,
      effectiveFrom: 1,
      createdAt: 2,
      createdBy: '__system__',
      note: '历史费用 原文\r\n',
    })
    await h.db.insert(observationCalls).values({
      id: 'q3-call',
      purpose: 'task',
      taskId: 'q3-cost-child',
      nodeRunId: 'q3-cost-run',
      agentName: 'deleted agent',
      runtimeId: 'retained-runtime',
      protocol: 'claude-code',
      status: 'done',
      startedAt: 3,
      endedAt: 4,
      usageState: 'complete',
      costState: 'priced',
      costNano: 987654321,
      inputTokens: 17,
      outputTokens: 19,
      updatedAt: 4,
    })
    await h.db.insert(observationCallModels).values({
      callId: 'q3-call',
      model: 'retained-model',
      inputTokens: 17,
      outputTokens: 19,
      priceId: 'q3-price',
      costNano: 987654321,
      costState: 'priced',
    })
    const read = async () => ({
      calls: await h.db.select().from(observationCalls),
      models: await h.db.select().from(observationCallModels),
      prices: await h.db.select().from(observationPrices),
    })
    const before = await read()
    expect(before.calls).toHaveLength(1)
    expect(before.models).toHaveLength(1)
    expect(before.prices).toHaveLength(1)
    await h.session.transaction(async (tx) => {
      const deletion = createTaskDeletionParticipantInTx(tx)
      expect((await deletion.cascade('q3-cost-root')).map((row) => row.id).sort()).toEqual([
        'q3-cost-child',
        'q3-cost-root',
      ])
      await deletion.deleteRoot('q3-cost-root')
    })
    expect(await h.db.select().from(tasks).where(eq(tasks.id, 'q3-cost-child'))).toEqual([])
    expect(await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'q3-cost-run'))).toEqual([])
    expect(await read()).toEqual(before)
    await h.session.transaction((tx) =>
      createTaskDeletionParticipantInTx(tx).deleteRoot('q3-cost-root'),
    )
    expect(await read()).toEqual(before)
  })
})
