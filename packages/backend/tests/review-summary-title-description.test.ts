// Locks in that listReviewSummaries surfaces the review node's
// human-readable title + description from the task's workflowSnapshot,
// not just the bare reviewNodeId.
//
// Without this, the Reviews tab + detail page would show only the internal
// node id (e.g. "review_1"), which is what the user reported was unhelpful.
// RFC-005 design.md §3 + ReviewNodeSchema both declare title/description
// as the human-facing fields shown in the Reviews list + detail. PR-A
// stored them on the workflow definition, this PR wires them through the
// API contract.

import { expect, test } from 'bun:test'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { listReviewSummaries } from '../src/services/review'
import { describeEachProvider } from './helpers/eachProvider'

interface SeedOptions {
  workflowSnapshot: string
  reviewNodes: Array<{ nodeId: string; status?: 'awaiting_review' | 'done' }>
}

async function seed(
  db: ProviderNeutralDatabase,
  opts: SeedOptions,
): Promise<{ db: ProviderNeutralDatabase; taskId: string }> {
  const wfId = 'wf_test_1'
  const taskId = 'task_test_1'
  await db.insert(workflows).values({
    id: wfId,
    name: 'Test Workflow',
    description: '',
    definition: opts.workflowSnapshot,
    version: 1,
    schemaVersion: 2,
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId: wfId,
    workflowSnapshot: opts.workflowSnapshot,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: 'agent-workflow/task_test_1',
    baseCommit: null,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: 1000,
    schemaVersion: 2,
  })
  let i = 0
  for (const rn of opts.reviewNodes) {
    const runId = `nr_${i}`
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: rn.nodeId,
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: rn.status ?? 'awaiting_review',
      startedAt: 1000,
    })
    await db.insert(docVersions).values({
      id: `dv_${i}`,
      taskId,
      reviewNodeId: rn.nodeId,
      reviewNodeRunId: runId,
      sourceNodeId: 'designer',
      sourcePortName: 'design',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: `runs/${taskId}/review/${rn.nodeId}/design/v1.md`,
      commentsJson: '[]',
      decision: 'pending',
      decisionReason: null,
      promptSnapshot: null,
      createdAt: 1100 + i,
      decidedAt: null,
      decidedBy: null,
    })
    i++
  }
  return { db, taskId }
}

describeEachProvider(
  'listReviewSummaries surfaces title + description from workflowSnapshot',
  (harness) => {
    test('returns title + description when the review node defines both', async () => {
      const snapshot = JSON.stringify({
        $schema_version: 2,
        inputs: [],
        nodes: [
          {
            id: 'review_1',
            kind: 'review',
            inputSource: { nodeId: 'designer', portName: 'design' },
            title: 'Design Review',
            description: 'Check the architecture before merging.',
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
          },
        ],
        edges: [],
      })
      const { db } = await seed(harness.db, {
        workflowSnapshot: snapshot,
        reviewNodes: [{ nodeId: 'review_1' }],
      })
      const list = await listReviewSummaries(db, { status: 'all' })
      expect(list).toHaveLength(1)
      expect(list[0]!.title).toBe('Design Review')
      expect(list[0]!.description).toBe('Check the architecture before merging.')
    })

    test('falls back to nodeId when title is empty; description stays empty', async () => {
      const snapshot = JSON.stringify({
        $schema_version: 2,
        inputs: [],
        nodes: [
          {
            id: 'review_blank',
            kind: 'review',
            inputSource: { nodeId: 'designer', portName: 'design' },
            title: '',
            description: '',
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
          },
        ],
        edges: [],
      })
      const { db } = await seed(harness.db, {
        workflowSnapshot: snapshot,
        reviewNodes: [{ nodeId: 'review_blank' }],
      })
      const list = await listReviewSummaries(db, { status: 'all' })
      expect(list).toHaveLength(1)
      expect(list[0]!.title).toBe('review_blank')
      expect(list[0]!.description).toBe('')
    })

    test('whitespace-only title falls back to nodeId', async () => {
      const snapshot = JSON.stringify({
        $schema_version: 2,
        inputs: [],
        nodes: [
          {
            id: 'review_ws',
            kind: 'review',
            inputSource: { nodeId: 'designer', portName: 'design' },
            title: '   ',
            description: 'has description though',
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
          },
        ],
        edges: [],
      })
      const { db } = await seed(harness.db, {
        workflowSnapshot: snapshot,
        reviewNodes: [{ nodeId: 'review_ws' }],
      })
      const list = await listReviewSummaries(db, { status: 'all' })
      expect(list[0]!.title).toBe('review_ws')
      expect(list[0]!.description).toBe('has description though')
    })

    test('corrupt workflowSnapshot does not throw — degrades to nodeId / empty', async () => {
      const { db } = await seed(harness.db, {
        workflowSnapshot: 'not valid json {{{',
        reviewNodes: [{ nodeId: 'review_corrupt' }],
      })
      const list = await listReviewSummaries(db, { status: 'all' })
      expect(list).toHaveLength(1)
      expect(list[0]!.title).toBe('review_corrupt')
      expect(list[0]!.description).toBe('')
    })

    test('multiple review nodes in the same task each carry their own title / description', async () => {
      const snapshot = JSON.stringify({
        $schema_version: 2,
        inputs: [],
        nodes: [
          {
            id: 'review_a',
            kind: 'review',
            inputSource: { nodeId: 'designer', portName: 'design' },
            title: 'A title',
            description: 'A desc',
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
          },
          {
            id: 'review_b',
            kind: 'review',
            inputSource: { nodeId: 'designer', portName: 'design' },
            title: 'B title',
            description: '',
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
          },
        ],
        edges: [],
      })
      const { db } = await seed(harness.db, {
        workflowSnapshot: snapshot,
        reviewNodes: [{ nodeId: 'review_a' }, { nodeId: 'review_b' }],
      })
      const list = await listReviewSummaries(db, { status: 'all' })
      const byNode = new Map(list.map((r) => [r.reviewNodeId, r]))
      expect(byNode.get('review_a')!.title).toBe('A title')
      expect(byNode.get('review_a')!.description).toBe('A desc')
      expect(byNode.get('review_b')!.title).toBe('B title')
      expect(byNode.get('review_b')!.description).toBe('')
    })
  },
)
