// RFC-061 G6 — lazy cascade scanner extension. Validates that
// scanFreshDownstream emits a logical-run-created for a downstream
// node when an upstream node has advanced past it (i.e. review
// iterate / cross-clarify submit cascade).

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { logicalRuns, tasks, workflows } from '../src/db/schema'
import { scanFreshDownstream } from '../src/scheduler-v2/readyScanner'
import type { WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const linearWorkflow: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [
    { id: 'A', kind: 'agent-single' as never },
    { id: 'B', kind: 'agent-single' as never },
  ] as never,
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'A', portName: 'out' },
      target: { nodeId: 'B', portName: 'in' },
    },
  ],
}

function makeDb() {
  const db = createInMemoryDb(MIGRATIONS)
  const wfId = 'wf'
  db.insert(workflows).values({ id: wfId, name: 'wf', definition: '{}' }).run()
  const taskId = 't'
  db.insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/t',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { db, taskId }
}

function seedLr(
  db: ReturnType<typeof createInMemoryDb>,
  taskId: string,
  nodeId: string,
  iter: number,
  status: 'done' | 'pending' | 'running' | 'suspended' | 'failed' | 'canceled' = 'done',
): void {
  db.insert(logicalRuns)
    .values({
      id: `lr_${nodeId}_${iter}`,
      taskId,
      nodeId,
      loopIter: 0,
      shardKey: '',
      iter,
      status,
      createdAt: 0,
      updatedAt: 0,
      lastEventId: `evt_${nodeId}_${iter}`,
    })
    .run()
}

describe('RFC-061 G6 lazy cascade — scanFreshDownstream', () => {
  test('initial-mint case still works: B gets iter=0 when A.iter=0 is done', () => {
    const { db, taskId } = makeDb()
    seedLr(db, taskId, 'A', 0, 'done')
    const out = scanFreshDownstream({ db, taskId, workflow: linearWorkflow })
    expect(out.length).toBe(1)
    expect(out[0]?.scope).toEqual({ nodeId: 'B', loopIter: 0, shardKey: '', iter: 0 })
  })

  test('cascade case: A bumps to iter=1, B at iter=0 → emit B at iter=1', () => {
    const { db, taskId } = makeDb()
    seedLr(db, taskId, 'A', 0, 'done')
    seedLr(db, taskId, 'A', 1, 'done')
    seedLr(db, taskId, 'B', 0, 'done')
    const out = scanFreshDownstream({ db, taskId, workflow: linearWorkflow })
    expect(out.length).toBe(1)
    expect(out[0]?.scope.iter).toBe(1)
    expect(out[0]?.scope.nodeId).toBe('B')
  })

  test('no cascade when downstream is already at upstream max iter', () => {
    const { db, taskId } = makeDb()
    seedLr(db, taskId, 'A', 0, 'done')
    seedLr(db, taskId, 'A', 1, 'done')
    seedLr(db, taskId, 'B', 0, 'done')
    seedLr(db, taskId, 'B', 1, 'pending')
    const out = scanFreshDownstream({ db, taskId, workflow: linearWorkflow })
    expect(out.length).toBe(0)
  })

  test('upstream not done at any iter → no cascade emitted', () => {
    const { db, taskId } = makeDb()
    seedLr(db, taskId, 'A', 0, 'running')
    seedLr(db, taskId, 'B', 0, 'done')
    const out = scanFreshDownstream({ db, taskId, workflow: linearWorkflow })
    expect(out.length).toBe(0)
  })
})
