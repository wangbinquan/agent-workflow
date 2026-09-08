import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { nodeRuns, taskExecutionIntents, tasks } from '@/db/schema'
import {
  recoverPendingHumanGateContinuations,
  type PendingHumanGateContinuation,
} from '@/services/humanGateContinuationRecovery'
import { createHumanGateContinuationRecoveryQueries } from '@/modules/collaboration/infrastructure/humanGateContinuationRecovery'
import { reapOrphanRuns } from '@/services/orphans'
import { createTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'

const NOW = 1_788_969_900_000

async function seedTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-rfc333-recovery',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/rfc333-recovery',
      worktreePath: '/tmp/rfc333-recovery',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: NOW,
      executionLineageId: taskId,
      lineageSlotPathJson: '[]',
    })
    .run()
}

async function seedIntent(
  db: ProviderNeutralDatabase,
  input: {
    id: string
    taskId: string
    kind: 'gate-continuation' | 'resume'
    state: 'pending' | 'claimed'
    createdAt: number
    payloadJson?: string
  },
): Promise<void> {
  await seedTask(db, input.taskId)
  await db
    .insert(taskExecutionIntents)
    .values({
      id: input.id,
      taskId: input.taskId,
      kind: input.kind,
      state: input.state,
      source: 'internal',
      requestHash: input.id.padEnd(64, '0').slice(0, 64),
      payloadJson: input.payloadJson ?? '{"v":1}',
      executionLineageId: input.taskId,
      continuationSlotKey: `${input.taskId}:root`,
      slotPathJson: '[]',
      operationGeneration: 0,
      expectedTaskRevision: 1,
      createdAt: input.createdAt,
      ...(input.state === 'claimed' ? { claimedAt: input.createdAt + 1, claimedEpoch: 1 } : {}),
      updatedAt: input.createdAt,
    })
    .run()
}

describeEachProvider('RFC-333 pending human-gate continuation recovery', (harness) => {
  test('boot orphan reap preserves the exact pending task/run owned by a pending gate intent', async () => {
    const db = harness.db
    await seedIntent(db, {
      id: 'intent-gate-before-wake',
      taskId: 'task-gate-before-wake',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW,
    })
    await db
      .insert(nodeRuns)
      .values({
        id: 'run-gate-before-wake',
        taskId: 'task-gate-before-wake',
        nodeId: 'designer',
        status: 'pending',
        retryIndex: 0,
        iteration: 1,
      })
      .run()

    expect(await reapOrphanRuns(createTaskExecutionPersistence(db).recoveryAdministration)).toEqual(
      { tasks: 0, runs: 0 },
    )
    expect(
      await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, 'task-gate-before-wake'))
        .get(),
    ).toEqual({ status: 'pending' })
    expect(
      await db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-gate-before-wake'))
        .get(),
    ).toEqual({ status: 'pending' })
    expect(
      await db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, 'intent-gate-before-wake'))
        .get(),
    ).toEqual({ state: 'pending' })
  })

  test('boot orphan reap fences an interrupted owner row without consuming its pending RFC-333 successor', async () => {
    const db = harness.db
    const taskId = 'task-gate-owner-before-wake'
    const continuationRef = 'intent-gate-owner-before-wake'
    await seedIntent(db, {
      id: continuationRef,
      taskId,
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW,
      payloadJson: JSON.stringify({
        v: 1,
        gate: { kind: 'clarify', ref: `clarify:${taskId}:0` },
        operationId: 'operation-gate-owner-before-wake',
        expectedNodeProjection: { digest: 'a'.repeat(64), memberCount: 0 },
        continuationLineage: { sourceNodeRunIds: [], rerunNodeRunIds: [] },
      }),
    })
    await db
      .insert(nodeRuns)
      .values([
        {
          id: 'run-gate-old-owner',
          taskId,
          nodeId: 'designer-old-owner',
          status: 'running',
          retryIndex: 0,
          iteration: 0,
          startedAt: NOW - 1,
        },
        {
          id: 'run-gate-pending-successor',
          taskId,
          nodeId: 'designer-successor',
          status: 'pending',
          retryIndex: 0,
          iteration: 1,
        },
      ])
      .run()

    expect(
      await reapOrphanRuns(createTaskExecutionPersistence(db).recoveryAdministration, {
        killStaleRunProcessTree: async () => 'no-pid',
      }),
    ).toEqual({ tasks: 0, runs: 1 })
    expect(
      await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get(),
    ).toEqual({ status: 'pending' })
    expect(
      await db
        .select({ id: nodeRuns.id, status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .orderBy(nodeRuns.id)
        .all(),
    ).toEqual([
      { id: 'run-gate-old-owner', status: 'interrupted' },
      { id: 'run-gate-pending-successor', status: 'pending' },
    ])
    expect(
      await db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, continuationRef))
        .get(),
    ).toEqual({ state: 'pending' })
  })

  test('wakes each RFC-333 pending gate ref but leaves legacy task gates request-owned', async () => {
    const db = harness.db
    await seedIntent(db, {
      id: 'intent-gate-b',
      taskId: 'task-gate-b',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW + 2,
    })
    await seedIntent(db, {
      id: 'intent-resume',
      taskId: 'task-resume',
      kind: 'resume',
      state: 'pending',
      createdAt: NOW,
    })
    await seedIntent(db, {
      id: 'intent-gate-claimed',
      taskId: 'task-gate-claimed',
      kind: 'gate-continuation',
      state: 'claimed',
      createdAt: NOW,
    })
    await seedIntent(db, {
      id: 'intent-gate-a',
      taskId: 'task-gate-a',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW + 1,
    })
    await seedIntent(db, {
      id: 'intent-legacy-task-gate',
      taskId: 'task-legacy-task-gate',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW,
      payloadJson: '{"event":"resume","v":1}',
    })
    const before = await db.select().from(taskExecutionIntents).all()
    const calls: PendingHumanGateContinuation[] = []

    const result = await recoverPendingHumanGateContinuations({
      queries: createHumanGateContinuationRecoveryQueries(db),
      wake: async (continuation) => {
        calls.push(continuation)
        if (continuation.continuationRef === 'intent-gate-b') {
          throw new Error('wake-b-failed')
        }
      },
    })

    expect(calls).toEqual([
      { taskId: 'task-gate-a', continuationRef: 'intent-gate-a' },
      { taskId: 'task-gate-b', continuationRef: 'intent-gate-b' },
    ])
    expect(result).toEqual({
      attempted: calls,
      woken: [{ taskId: 'task-gate-a', continuationRef: 'intent-gate-a' }],
      failed: [
        {
          taskId: 'task-gate-b',
          continuationRef: 'intent-gate-b',
          error: 'wake-b-failed',
        },
      ],
    })
    expect(await db.select().from(taskExecutionIntents).all()).toEqual(before)
  })
})
