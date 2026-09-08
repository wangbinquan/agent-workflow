// RFC-046 — locks the REST projection of node_runs.injected_memories_json
// into the wire-level `injectedMemories` field on NodeRun. Covers:
//   - Happy path: persisted JSON → parsed array in the response.
//   - Legacy row (NULL column) → field surfaces as null.
//   - Corrupted JSON in the column → field surfaces as null (no 5xx).
//   - Empty-array payload distinct from NULL.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { getTaskNodeRuns } from '../src/services/task'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

async function seedTaskAndWorkflow(db: ProviderNeutralDatabase): Promise<{ taskId: string }> {
  const wfId = ulid()
  await db
    .insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  await db
    .insert(tasks)
    .values({
      // Preserve the exact task lineage formerly supplied by SQLite's retained INSERT trigger.
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId }
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  json: string | null,
  nodeId = 'n',
): Promise<string> {
  const id = ulid()
  await db
    .insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId,
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      injectedMemoriesJson: json,
      startedAt: Date.now(),
    })
    .run()
  return id
}

describeEachProvider('RFC-046 — getTaskNodeRuns surfaces injectedMemories', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    resetBroadcastersForTests()
    db = harness.db
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('A1: persisted snapshot JSON parses into an array on the wire', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const payload = JSON.stringify([
      {
        id: 'm1',
        version: 3,
        scopeType: 'agent',
        scopeId: 'a',
        title: 'Title',
        bodyMd: 'Body',
        tags: ['x', 'y'],
        sourceKind: 'review',
        approvedAt: 1_700_000_000_000,
      },
    ])
    await seedRun(db, taskId, payload)
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs.length).toBe(1)
    const im = res.runs[0]!.injectedMemories
    expect(im).not.toBeNull()
    expect(im?.length).toBe(1)
    expect(im?.[0]?.id).toBe('m1')
    expect(im?.[0]?.version).toBe(3)
    expect(im?.[0]?.tags).toEqual(['x', 'y'])
    expect(im?.[0]?.sourceKind).toBe('review')
  })

  test('A2: legacy row with NULL column surfaces as injectedMemories=null', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    await seedRun(db, taskId, null)
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs[0]!.injectedMemories).toBeNull()
  })

  test('A3: corrupted JSON in column degrades to null (no 5xx)', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    await seedRun(db, taskId, '{not-an-array')
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs[0]!.injectedMemories).toBeNull()
  })

  test('A4: empty-array payload surfaces as [] (distinct from null)', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    await seedRun(db, taskId, '[]')
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs[0]!.injectedMemories).toEqual([])
  })
})
