// RFC-023 PR-B C4 — when clarify session activity happens on a task that
// also has an in-flight review (awaiting_review on a different node), the
// clarify path MUST NOT touch the review's node_run state, doc_versions, or
// review_comments. The two iteration counters (review_iteration vs.
// clarify_iteration) are orthogonal and the review row must remain
// untouched through both createClarifySession and submitClarifyAnswers.
//
// If this goes red:
//   - check services/clarify.ts: any UPDATE / DELETE that touches the
//     review tables OR a node_runs row that isn't the source agent / the
//     clarify node itself is a regression.
//   - check that submitClarifyAnswers' rerun-mint passthrough preserves
//     reviewIteration on the new source-agent row (locked here too).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { ulid } from 'ulid'
import type { ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const QUESTION: ClarifyQuestion = {
  id: 'q-color',
  title: 'Which?',
  kind: 'single',
  recommended: false,
  options: ['Red', 'Blue'],
}

async function seed(
  db: DbClient,
): Promise<{ taskId: string; reviewRunId: string; docVersionId: string; sourceRunId: string }> {
  const taskId = `task_${ulid()}`
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as any,
      { id: 'review1', kind: 'review' } as any,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as any,
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
    clarifyIteration: 0,
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
    clarifyIteration: 0,
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
  test('createClarifySession + submitClarifyAnswers leave review node_run + doc_version untouched, and preserve reviewIteration on the rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, reviewRunId, docVersionId, sourceRunId } = await seed(db)

    const reviewBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]
    const dvBefore = (
      await db.select().from(docVersions).where(eq(docVersions.id, docVersionId))
    )[0]
    expect(reviewBefore?.status).toBe('awaiting_review')
    expect(dvBefore?.decision).toBe('pending')

    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [QUESTION],
    })

    // After createClarifySession: review row + doc_version unchanged.
    const reviewMid = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]
    const dvMid = (await db.select().from(docVersions).where(eq(docVersions.id, docVersionId)))[0]
    expect(reviewMid?.status).toBe('awaiting_review')
    expect(reviewMid?.reviewIteration).toBe(2)
    expect(dvMid?.decision).toBe('pending')
    expect(dvMid?.reviewIteration).toBe(2)

    const { rerunNodeRunId } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [
        {
          questionId: 'q-color',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
    })

    // After submit: review row + doc_version still unchanged. New rerun
    // node_run carries reviewIteration = 2 forward (no reset).
    const reviewAfter = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]
    const dvAfter = (await db.select().from(docVersions).where(eq(docVersions.id, docVersionId)))[0]
    expect(reviewAfter?.status).toBe('awaiting_review')
    expect(reviewAfter?.reviewIteration).toBe(2)
    expect(dvAfter?.decision).toBe('pending')

    const rerun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunNodeRunId)))[0]
    expect(rerun?.clarifyIteration).toBe(1) // bumped
    expect(rerun?.reviewIteration).toBe(2) // passthrough
  })
})
