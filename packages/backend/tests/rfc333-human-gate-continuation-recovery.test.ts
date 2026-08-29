import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { nodeRuns, taskExecutionIntents, tasks } from '@/db/schema'
import {
  recoverPendingHumanGateContinuations,
  type PendingHumanGateContinuation,
} from '@/services/humanGateContinuationRecovery'
import { reapOrphanRuns } from '@/services/orphans'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_788_969_900_000

function seedTask(db: ReturnType<typeof createInMemoryDb>, taskId: string): void {
  db.insert(tasks)
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

function seedIntent(
  db: ReturnType<typeof createInMemoryDb>,
  input: {
    id: string
    taskId: string
    kind: 'gate-continuation' | 'resume'
    state: 'pending' | 'claimed'
    createdAt: number
    payloadJson?: string
  },
): void {
  seedTask(db, input.taskId)
  db.insert(taskExecutionIntents)
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

describe('RFC-333 pending human-gate continuation recovery', () => {
  test('boot orphan reap preserves the exact pending task/run owned by a pending gate intent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedIntent(db, {
      id: 'intent-gate-before-wake',
      taskId: 'task-gate-before-wake',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW,
    })
    db.insert(nodeRuns)
      .values({
        id: 'run-gate-before-wake',
        taskId: 'task-gate-before-wake',
        nodeId: 'designer',
        status: 'pending',
        retryIndex: 0,
        iteration: 1,
      })
      .run()

    expect(await reapOrphanRuns(db)).toEqual({ tasks: 0, runs: 0 })
    expect(
      db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, 'task-gate-before-wake'))
        .get(),
    ).toEqual({ status: 'pending' })
    expect(
      db
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'run-gate-before-wake'))
        .get(),
    ).toEqual({ status: 'pending' })
    expect(
      db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, 'intent-gate-before-wake'))
        .get(),
    ).toEqual({ state: 'pending' })
  })

  test('boot orphan reap fences an interrupted owner row without consuming its pending RFC-333 successor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task-gate-owner-before-wake'
    const continuationRef = 'intent-gate-owner-before-wake'
    seedIntent(db, {
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
    db.insert(nodeRuns)
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

    expect(await reapOrphanRuns(db, { killStaleRunProcessTree: async () => 'no-pid' })).toEqual({
      tasks: 0,
      runs: 1,
    })
    expect(
      db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get(),
    ).toEqual({ status: 'pending' })
    expect(
      db
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
      db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, continuationRef))
        .get(),
    ).toEqual({ state: 'pending' })
  })

  test('wakes each RFC-333 pending gate ref but leaves legacy task gates request-owned', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedIntent(db, {
      id: 'intent-gate-b',
      taskId: 'task-gate-b',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW + 2,
    })
    seedIntent(db, {
      id: 'intent-resume',
      taskId: 'task-resume',
      kind: 'resume',
      state: 'pending',
      createdAt: NOW,
    })
    seedIntent(db, {
      id: 'intent-gate-claimed',
      taskId: 'task-gate-claimed',
      kind: 'gate-continuation',
      state: 'claimed',
      createdAt: NOW,
    })
    seedIntent(db, {
      id: 'intent-gate-a',
      taskId: 'task-gate-a',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW + 1,
    })
    seedIntent(db, {
      id: 'intent-legacy-task-gate',
      taskId: 'task-legacy-task-gate',
      kind: 'gate-continuation',
      state: 'pending',
      createdAt: NOW,
      payloadJson: '{"event":"resume","v":1}',
    })
    const before = db.select().from(taskExecutionIntents).all()
    const calls: PendingHumanGateContinuation[] = []

    const result = await recoverPendingHumanGateContinuations({
      db,
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
    expect(db.select().from(taskExecutionIntents).all()).toEqual(before)
  })
})
