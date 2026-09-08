// RFC-037 T4 — locks `listReviewSummaries` returning `taskName: tasks.name`
// per row. Mirrors the clarify list test; the inbox merges both source types
// and needs taskName on both schemas.

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { listReviewSummaries } from '../src/services/review'
import { describeEachProvider } from './helpers/eachProvider'

async function seedReview(db: ProviderNeutralDatabase, taskName: string): Promise<void> {
  const wfId = ulid()
  const tId = ulid()
  const nrId = ulid()
  const dvId = ulid()
  const now = Date.now()
  await db
    .insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      description: '',
      definition: JSON.stringify({ nodes: [{ id: 'rev-1', kind: 'review', title: 'Review' }] }),
      version: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  await db
    .insert(tasks)
    .values({
      id: tId,
      name: taskName,
      workflowId: wfId,
      workflowSnapshot: JSON.stringify({
        nodes: [{ id: 'rev-1', kind: 'review', title: 'Review' }],
      }),
      repoPath: '/tmp/r',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${tId}`,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: now,
    })
    .run()
  await db
    .insert(nodeRuns)
    .values({
      id: nrId,
      taskId: tId,
      nodeId: 'rev-1',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: now,
    })
    .run()
  await db
    .insert(docVersions)
    .values({
      id: dvId,
      taskId: tId,
      reviewNodeId: 'rev-1',
      reviewNodeRunId: nrId,
      sourceNodeId: 'src',
      sourcePortName: 'port',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'runs/x/review/rev-1/port/v1.md',
      commentsJson: '[]',
      decision: 'pending',
      createdAt: now,
    })
    .run()
}

describeEachProvider('RFC-037 — listReviewSummaries joins tasks.name → taskName', (harness) => {
  test('summary row carries taskName equal to tasks.name', async () => {
    const db = harness.db
    await seedReview(db, 'PR-9999 doc review')
    const summaries = await listReviewSummaries(db, { status: 'all', limit: 100 })
    expect(summaries.length).toBe(1)
    expect(summaries[0]?.taskName).toBe('PR-9999 doc review')
  })

  test('multiple tasks → each row has its own taskName', async () => {
    const db = harness.db
    await seedReview(db, 'task-A')
    await seedReview(db, 'task-B')
    const summaries = await listReviewSummaries(db, { status: 'all', limit: 100 })
    const names = summaries.map((s) => s.taskName).sort()
    expect(names).toEqual(['task-A', 'task-B'])
  })
})
