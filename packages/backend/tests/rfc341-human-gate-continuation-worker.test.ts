import { describe, expect, test } from 'bun:test'

import { createInMemoryDb } from '@/db/client'
import { taskExecutionIntents, tasks } from '@/db/schema'
import { createHumanGateContinuationWorkerDefinition } from '@/modules/collaboration/application/humanGateContinuationWorker'
import { listPendingHumanGateContinuations } from '@/services/humanGateContinuationRecovery'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_789_488_200_000

function seedPendingGate(db: ReturnType<typeof createInMemoryDb>): void {
  db.insert(tasks)
    .values({
      id: 'task-gate',
      name: 'task-gate',
      workflowId: 'workflow-gate',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      repoPath: '/tmp/rfc341',
      worktreePath: '/tmp/rfc341',
      baseBranch: 'main',
      branch: 'agent-workflow/task-gate',
      status: 'pending',
      inputs: '{}',
      startedAt: NOW,
      executionLineageId: 'task-gate',
      lineageSlotPathJson: '[]',
    })
    .run()
  db.insert(taskExecutionIntents)
    .values({
      id: 'intent-gate',
      taskId: 'task-gate',
      kind: 'gate-continuation',
      state: 'pending',
      source: 'internal',
      requestHash: 'a'.repeat(64),
      payloadJson: '{"v":1}',
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

describe('RFC-341 human-gate continuation worker', () => {
  test('initial/reconcile scan owns exact pending refs without requiring a request nudge', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedPendingGate(db)
    const driven: Array<{ taskId: string; continuationRef: string }> = []
    const worker = createHumanGateContinuationWorkerDefinition({
      listPending: () => listPendingHumanGateContinuations(db),
      drive: async (continuation) => {
        driven.push(continuation)
        db.update(taskExecutionIntents)
          .set({ state: 'completed', completedAt: NOW + 1, updatedAt: NOW + 1 })
          .run()
      },
      now: () => NOW,
    })
    expect(worker.definition.kind).toBe('long-running')
    expect(worker.definition.owner).toBe('collaboration')
    expect(await worker.runCycle()).toEqual({ attempted: 1, completed: 1, failed: 0 })
    expect(driven).toEqual([{ taskId: 'task-gate', continuationRef: 'intent-gate' }])
    expect(await worker.runCycle()).toEqual({ attempted: 0, completed: 0, failed: 0 })
  })
})
