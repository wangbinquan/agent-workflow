// RFC-372: official migrations own Task host/entry and immutable consumer versions.
// No fixture DDL is allowed here; both providers start from their full migration chain.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  tasks,
  nodeRuns,
  taskClarifyHostRuns,
  taskClarifyChannels,
  taskClarifyEntries,
  taskClarifyMaterials,
  taskClarifyConsumptions,
} from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-372 official Task companion schema', (harness) => {
  test('preserves material versions, enforces one acceptance per business run, and deletes companions with the original task', async () => {
    const taskId = randomUUID(),
      runId = randomUUID(),
      channelId = randomUUID(),
      entryId = randomUUID()
    await harness.db
      .insert(tasks)
      .values({
        id: taskId,
        name: 'Schema fixture',
        workflowId: 'frozen',
        workflowSnapshot: '{}',
        repoPath: '/tmp/rfc372-schema',
        baseBranch: 'main',
        branch: 'fixture',
        status: 'pending',
        inputs: '{}',
      })
      .run()
    await harness.db
      .insert(nodeRuns)
      .values({ id: runId, taskId, nodeId: 'writer', status: 'pending', iteration: 0 })
      .run()
    await harness.db
      .insert(taskClarifyHostRuns)
      .values({
        nodeRunId: runId,
        taskId,
        occurrenceRef: 'occurrence',
        slotKey: 'slot',
        createdAt: 1,
      })
      .run()
    await harness.db
      .insert(taskClarifyChannels)
      .values({
        id: channelId,
        taskId,
        logicalKey: 'logical',
        askingNodeId: 'writer',
        clarifyNodeId: 'clarify',
        bindingDigest: 'binding',
        hostJson: '{}',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    await harness.db
      .insert(taskClarifyEntries)
      .values({
        id: entryId,
        channelId,
        entryRevision: 1,
        hostEntryKey: 'host',
        hostJson: '{}',
        sourceAskingRunId: runId,
        sourceContextDigest: 'source',
        sourceContextJson: '{}',
        configSnapshotRef: 'config',
        triggerJson: '{}',
        disposition: 'completed',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    const firstId = randomUUID(),
      secondId = randomUUID()
    const material = {
      taskId,
      entryScopeRef: entryId,
      consumerNodeId: 'writer',
      planId: 'plan',
      sourceContextDigest: 'source',
      snapshotSetDigest: 'set',
      materialJson: '{}',
      createdAt: 2,
    }
    await harness.db
      .insert(taskClarifyMaterials)
      .values({ ...material, id: firstId, materialRevision: 1 })
      .run()
    await harness.db
      .insert(taskClarifyMaterials)
      .values({ ...material, id: secondId, materialRevision: 2 })
      .run()
    await expect(
      harness.db
        .insert(taskClarifyMaterials)
        .values({ ...material, id: randomUUID(), materialRevision: 2 })
        .run(),
    ).rejects.toThrow()
    const accepted = {
      nodeRunId: runId,
      taskId,
      materialId: firstId,
      acceptanceRef: 'invocation',
      sourceContextDigest: 'source',
      snapshotSetDigest: 'set',
      finalizedPromptDigest: 'prompt',
      acceptedAt: 3,
      consumedAt: null,
    }
    await harness.db.insert(taskClarifyConsumptions).values(accepted).run()
    await expect(
      harness.db
        .insert(taskClarifyConsumptions)
        .values({ ...accepted, acceptanceRef: 'other', materialId: secondId })
        .run(),
    ).rejects.toThrow()
    expect(await harness.db.select().from(taskClarifyMaterials).all()).toHaveLength(2)
    expect(await harness.db.select().from(taskClarifyConsumptions).get()).toMatchObject({
      materialId: firstId,
      consumedAt: null,
    })
    await harness.db.delete(tasks).where(eq(tasks.id, taskId)).run()
    for (const table of [
      taskClarifyHostRuns,
      taskClarifyChannels,
      taskClarifyEntries,
      taskClarifyMaterials,
      taskClarifyConsumptions,
    ])
      expect(await harness.db.select().from(table).all()).toHaveLength(0)
  })
})
