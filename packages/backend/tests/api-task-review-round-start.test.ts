// RFC-078 — locks the getTaskNodeRuns serialization of a review node's
// content-anchored display timing (reviewRoundStartedAt / reviewDecidedAt) and
// the timeline re-sort, end to end against the DB.
//
// Regression guarded: a review row whose started_at (slot first-open) is pinned
// far before the agent run it reviews must surface reviewRoundStartedAt = the
// current pending doc_version's created_at, keep its raw startedAt untouched,
// and sort AFTER the reviewed agent run — not at the misleading early position.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
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
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId }
}

type RunStatus = 'done' | 'awaiting_review' | 'running' | 'failed'

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  opts: { id?: string; nodeId: string; status?: RunStatus; startedAt: number; finishedAt?: number },
): Promise<string> {
  const id = opts.id ?? ulid()
  await db
    .insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId: opts.nodeId,
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: opts.status ?? 'done',
      startedAt: opts.startedAt,
      finishedAt: opts.finishedAt ?? null,
    })
    .run()
  return id
}

async function seedDocVersion(
  db: ProviderNeutralDatabase,
  taskId: string,
  reviewNodeRunId: string,
  opts: {
    versionIndex: number
    createdAt: number
    decision: 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'
    decidedAt?: number | null
  },
): Promise<void> {
  await db
    .insert(docVersions)
    .values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId,
      sourceNodeId: 'agent',
      sourcePortName: 'docpath',
      versionIndex: opts.versionIndex,
      reviewIteration: 0,
      bodyPath: `reviews/rev/docpath/v${opts.versionIndex}.md`,
      decision: opts.decision,
      createdAt: opts.createdAt,
      decidedAt: opts.decidedAt ?? null,
    })
    .run()
}

describeEachProvider('RFC-078 — getTaskNodeRuns surfaces review round timing', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    resetBroadcastersForTests()
    db = harness.db
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('awaiting review: reviewRoundStartedAt = latest pending version created_at; startedAt untouched; sorts after the agent run', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    // Agent run produced its doc at t=5000.
    await seedRun(db, taskId, { id: 'AGENT0', nodeId: 'agent', startedAt: 5000, finishedAt: 5200 })
    // Review slot first opened at t=100 (far before), then refreshed: v1 superseded, v2 pending @9000.
    const revId = 'REVIEW0'
    await seedRun(db, taskId, {
      id: revId,
      nodeId: 'rev',
      status: 'awaiting_review',
      startedAt: 100,
    })
    await seedDocVersion(db, taskId, revId, {
      versionIndex: 1,
      createdAt: 5300,
      decision: 'superseded',
    })
    await seedDocVersion(db, taskId, revId, {
      versionIndex: 2,
      createdAt: 9000,
      decision: 'pending',
    })

    const res = await getTaskNodeRuns(db, taskId)
    const rev = res.runs.find((r) => r.id === revId)!
    const agent = res.runs.find((r) => r.id === 'AGENT0')!

    expect(rev.reviewRoundStartedAt).toBe(9000)
    expect(rev.reviewDecidedAt ?? null).toBeNull()
    expect(rev.startedAt).toBe(100) // pinned slot time NOT mutated
    expect(agent.reviewRoundStartedAt ?? null).toBeNull() // non-review row → no anchor

    // Sort: review's round anchor (9000) is later than the agent (5000), so the
    // review must come AFTER the agent — not first (which its pinned 100 would give).
    const ids = res.runs.map((r) => r.id)
    expect(ids.indexOf('REVIEW0')).toBeGreaterThan(ids.indexOf('AGENT0'))
  })

  test('approved review: anchor = approved version created_at, decidedAt = its decided_at', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    const revId = 'REVIEW1'
    // approve stamps node_run finished_at = decided time; started_at stays pinned early.
    await seedRun(db, taskId, {
      id: revId,
      nodeId: 'rev',
      status: 'done',
      startedAt: 100,
      finishedAt: 9600,
    })
    await seedDocVersion(db, taskId, revId, {
      versionIndex: 1,
      createdAt: 5300,
      decision: 'superseded',
    })
    await seedDocVersion(db, taskId, revId, {
      versionIndex: 2,
      createdAt: 9000,
      decision: 'approved',
      decidedAt: 9600,
    })

    const res = await getTaskNodeRuns(db, taskId)
    const rev = res.runs.find((r) => r.id === revId)!
    expect(rev.reviewRoundStartedAt).toBe(9000)
    expect(rev.reviewDecidedAt).toBe(9600)
    expect(rev.startedAt).toBe(100)
  })

  test('non-review-only task: every row has null reviewRoundStartedAt and original order is preserved', async () => {
    const { taskId } = await seedTaskAndWorkflow(db)
    await seedRun(db, taskId, { id: 'A', nodeId: 'a', startedAt: 1000 })
    await seedRun(db, taskId, { id: 'B', nodeId: 'b', startedAt: 2000 })
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs.every((r) => (r.reviewRoundStartedAt ?? null) === null)).toBe(true)
    expect(res.runs.map((r) => r.id)).toEqual(['A', 'B'])
  })
})
