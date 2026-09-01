import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { taskExecutionIntents, tasks } from '@/db/schema'
import { createHumanGateContinuationWorkerDefinition } from '@/modules/collaboration/application/humanGateContinuationWorker'
import { startManagedWorkerDefinition } from '@/platform/events/committed/workerDefinitions'
import { listPendingHumanGateContinuations } from '@/services/humanGateContinuationRecovery'
import { createSqliteHumanGateContinuationRecoveryQueries } from '@/modules/collaboration/infrastructure/sqliteHumanGateContinuationRecovery'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_789_488_200_000

function seedTask(db: ReturnType<typeof createInMemoryDb>, taskId: string): void {
  db.insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-gate',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      repoPath: '/tmp/rfc341',
      worktreePath: '/tmp/rfc341',
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

function seedPendingGate(db: ReturnType<typeof createInMemoryDb>): void {
  seedTask(db, 'task-gate')
  db.insert(taskExecutionIntents)
    .values({
      id: 'intent-gate',
      taskId: 'task-gate',
      kind: 'gate-continuation',
      state: 'pending',
      source: 'internal',
      requestHash: 'a'.repeat(64),
      payloadJson: JSON.stringify({
        v: 1,
        gate: { kind: 'review', ref: 'review:task-gate:0' },
        operationId: 'operation-gate',
        expectedNodeProjection: { digest: 'a'.repeat(64), memberCount: 0 },
        continuationLineage: { sourceNodeRunIds: [], rerunNodeRunIds: [] },
      }),
      executionLineageId: 'task-gate',
      continuationSlotKey: 'task-gate:root',
      slotPathJson: '[]',
      operationGeneration: 0,
      expectedTaskRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
}

function seedLegacyTaskGate(db: ReturnType<typeof createInMemoryDb>): void {
  seedTask(db, 'task-legacy-gate')
  db.insert(taskExecutionIntents)
    .values({
      id: 'intent-legacy-gate',
      taskId: 'task-legacy-gate',
      kind: 'gate-continuation',
      state: 'pending',
      source: 'internal',
      requestHash: 'b'.repeat(64),
      payloadJson: '{"event":"resume","v":1}',
      executionLineageId: 'task-legacy-gate',
      continuationSlotKey: 'task-legacy-gate:root',
      slotPathJson: '[]',
      operationGeneration: 0,
      expectedTaskRevision: 1,
      createdAt: NOW - 1,
      updatedAt: NOW - 1,
    })
    .run()
}

describe('RFC-341 human-gate continuation worker', () => {
  test('initial/reconcile scan owns RFC-333 refs without stealing legacy task gates', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedPendingGate(db)
    seedLegacyTaskGate(db)
    const driven: Array<{ taskId: string; continuationRef: string }> = []
    const worker = createHumanGateContinuationWorkerDefinition({
      listPending: () =>
        listPendingHumanGateContinuations(createSqliteHumanGateContinuationRecoveryQueries(db)),
      drive: async (continuation) => {
        driven.push(continuation)
        db.update(taskExecutionIntents)
          .set({ state: 'completed', completedAt: NOW + 1, updatedAt: NOW + 1 })
          .where(eq(taskExecutionIntents.id, continuation.continuationRef))
          .run()
      },
      now: () => NOW,
    })
    expect(worker.definition.kind).toBe('long-running')
    expect(worker.definition.owner).toBe('collaboration')
    expect(await worker.runCycle()).toEqual({ attempted: 1, completed: 1, failed: 0 })
    expect(driven).toEqual([{ taskId: 'task-gate', continuationRef: 'intent-gate' }])
    expect(await worker.runCycle()).toEqual({ attempted: 0, completed: 0, failed: 0 })
    expect(
      db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, 'intent-legacy-gate'))
        .get(),
    ).toEqual({ state: 'pending' })
  })

  test('a nudge wakes the continuous owner without carrying the durable work identity', async () => {
    const pending = { taskId: 'task-nudge', continuationRef: 'intent-nudge' }
    let visible: readonly (typeof pending)[] = []
    let markInitialScan!: () => void
    const initialScan = new Promise<void>((resolve) => {
      markInitialScan = resolve
    })
    let markDriven!: () => void
    const driven = new Promise<void>((resolve) => {
      markDriven = resolve
    })
    let scans = 0
    const worker = createHumanGateContinuationWorkerDefinition({
      async listPending() {
        scans += 1
        if (scans === 1) markInitialScan()
        return visible
      },
      async drive(continuation) {
        expect(continuation).toEqual(pending)
        visible = []
        markDriven()
      },
      reconcileMs: 60_000,
      now: () => NOW,
    })
    const running = startManagedWorkerDefinition(worker.definition, 'rfc341-test')
    await initialScan
    visible = [pending]
    worker.nudge()
    await driven
    await running.stop()
    expect(scans).toBeGreaterThanOrEqual(2)
    expect(worker.definition.readiness()).toBe('stopped')
    expect(worker.definition.health()).toMatchObject({ status: 'stopped' })
  })

  test('shutdown stops new scans and waits for the current bounded drive to hand off', async () => {
    const pending = { taskId: 'task-stop', continuationRef: 'intent-stop' }
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    let releaseDrive!: () => void
    const release = new Promise<void>((resolve) => {
      releaseDrive = resolve
    })
    let scans = 0
    const worker = createHumanGateContinuationWorkerDefinition({
      async listPending() {
        scans += 1
        return [pending]
      },
      async drive() {
        markEntered()
        await release
      },
      reconcileMs: 60_000,
      now: () => NOW,
    })
    const running = startManagedWorkerDefinition(worker.definition, 'rfc341-test')
    await entered
    let stopped = false
    const stopping = running.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    releaseDrive()
    await stopping
    expect(scans).toBe(1)
    expect(worker.definition.readiness()).toBe('stopped')
  })
})
