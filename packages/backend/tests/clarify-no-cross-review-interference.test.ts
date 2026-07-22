// RFC-023 PR-B C4 — when clarify session activity happens on a task that
// also has an in-flight review (awaiting_review on a different node), the
// clarify path MUST NOT touch the review's node_run state, doc_versions, or
// review_comments. The two iteration counters (review_iteration vs.
// clarify_iteration) are orthogonal and the review row must remain
// untouched through both createClarifyRound and the round's answer
// (autoDispatchClarifyRound, the unified seal + dispatch driver).
//
// If this goes red:
//   - check services/clarify.ts / clarifySeal.ts / taskQuestionDispatch.ts:
//     any UPDATE / DELETE that touches the review tables OR a node_runs row
//     that isn't the source agent / the clarify node itself is a regression.
//   - check that the answer-dispatch rerun mint (buildMintNodeRunValues
//     inheritance) preserves reviewIteration on the new source-agent row
//     (locked here too).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifyRound } from '../src/services/clarify/service'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { ulid } from 'ulid'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const QUESTION: ClarifyQuestion = {
  id: 'q-color',
  title: 'Which?',
  kind: 'single',
  recommended: false,
  options: [
    { label: 'Red', description: '', recommended: false, recommendationReason: '' },
    { label: 'Blue', description: '', recommended: false, recommendationReason: '' },
  ],
}

async function seed(
  db: DbClient,
): Promise<{ taskId: string; reviewRunId: string; docVersionId: string; sourceRunId: string }> {
  const taskId = `task_${ulid()}`
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'review1', kind: 'review' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  const wfId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-cross/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })

  // Source agent node_run that produced both an output and a clarify envelope.
  const sourceRunId = ulid()
  await db.insert(nodeRuns).values({
    id: sourceRunId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 2, // simulate prior reviewIteration > 0
  })

  // Pre-existing awaiting_review node_run on review1 with a pending doc_version.
  const reviewRunId = ulid()
  const docVersionId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'review1',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 2,
  })
  await db.insert(docVersions).values({
    id: docVersionId,
    taskId,
    reviewNodeId: 'review1',
    reviewNodeRunId: reviewRunId,
    sourceNodeId: 'designer',
    sourcePortName: 'design',
    versionIndex: 1,
    reviewIteration: 2,
    bodyPath: 'runs/x/review/r/design/v1.md',
    commentsJson: '[]',
    decision: 'pending',
  })

  return { taskId, reviewRunId, docVersionId, sourceRunId }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('clarify activity does not perturb in-flight reviews', () => {
  test('createClarifyRound + answering the round leave review node_run + doc_version untouched, and preserve reviewIteration on the rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, reviewRunId, docVersionId, sourceRunId } = await seed(db)

    const reviewBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]
    const dvBefore = (
      await db.select().from(docVersions).where(eq(docVersions.id, docVersionId))
    )[0]
    expect(reviewBefore?.status).toBe('awaiting_review')
    expect(dvBefore?.decision).toBe('pending')

    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: sourceRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [QUESTION],
    })

    // After createClarifyRound: review row + doc_version unchanged.
    const reviewMid = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]
    const dvMid = (await db.select().from(docVersions).where(eq(docVersions.id, docVersionId)))[0]
    expect(reviewMid?.status).toBe('awaiting_review')
    expect(reviewMid?.reviewIteration).toBe(2)
    expect(dvMid?.decision).toBe('pending')
    expect(dvMid?.reviewIteration).toBe(2)

    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [
        {
          questionId: 'q-color',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      actor: { userId: 'u1', role: 'owner' },
    })
    const rerunNodeRunId = res.dispatch.reruns[0]!.nodeRunId

    // After submit: review row + doc_version still unchanged. New rerun
    // node_run carries reviewIteration = 2 forward (no reset).
    const reviewAfter = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]
    const dvAfter = (await db.select().from(docVersions).where(eq(docVersions.id, docVersionId)))[0]
    expect(reviewAfter?.status).toBe('awaiting_review')
    expect(reviewAfter?.reviewIteration).toBe(2)
    expect(dvAfter?.decision).toBe('pending')

    const rerun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunNodeRunId)))[0]
    expect(rerun?.reviewIteration).toBe(2) // passthrough
  })
})
