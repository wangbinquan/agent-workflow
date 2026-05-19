// RFC-041 — verify that completing a clarify session and submitting a
// review decision both enqueue a `memory_distill_jobs` row (best-effort,
// must not break the original decision path).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, memoryDistillJobs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { submitClarifyAnswers } from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedFixture(db: DbClient): {
  taskId: string
  workflowId: string
  clarifyNodeRunId: string
  sourceAgentNodeRunId: string
  clarifySessionId: string
} {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({
        schemaVersion: 1,
        name: 'wf',
        nodes: [
          { id: 'agent-1', kind: 'agent-single', agentName: 'codegen' },
          { id: 'clarify-1', kind: 'clarify' },
        ],
        edges: [],
      }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'fixture-task',
      workflowId: wfId,
      workflowSnapshot: JSON.stringify({
        schemaVersion: 1,
        nodes: [
          { id: 'agent-1', kind: 'agent-single', agentName: 'codegen' },
          { id: 'clarify-1', kind: 'clarify' },
        ],
      }),
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  const sourceRunId = ulid()
  db.insert(nodeRuns)
    .values({
      id: sourceRunId,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'awaiting_human',
    })
    .run()
  const clarifyRunId = ulid()
  db.insert(nodeRuns)
    .values({
      id: clarifyRunId,
      taskId,
      nodeId: 'clarify-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'awaiting_human',
    })
    .run()
  const sessionId = ulid()
  db.insert(clarifySessions)
    .values({
      id: sessionId,
      taskId,
      sourceAgentNodeId: 'agent-1',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify-1',
      clarifyNodeRunId: clarifyRunId,
      iterationIndex: 0,
      questionsJson: JSON.stringify([{ id: 'q1', kind: 'open', text: 'what?' }]),
      status: 'awaiting_human',
    })
    .run()
  return {
    taskId,
    workflowId: wfId,
    clarifyNodeRunId: clarifyRunId,
    sourceAgentNodeRunId: sourceRunId,
    clarifySessionId: sessionId,
  }
}

describe('submitClarifyAnswers enqueues a distill job', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('after a successful submit, exactly one feedback-source-job row exists with the matching debounce key', async () => {
    const fx = seedFixture(db)
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: fx.clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: 'an answer',
        },
      ],
    })
    const jobs = db.select().from(memoryDistillJobs).all()
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.sourceKind).toBe('clarify')
    expect(jobs[0]!.sourceEventId).toBe(fx.clarifySessionId)
    expect(jobs[0]!.debounceKey).toBe(`${fx.taskId}:clarify`)
    expect(jobs[0]!.taskId).toBe(fx.taskId)
  })

  test('clarify session row reflects the answered status (independent of the enqueue side-effect)', async () => {
    const fx = seedFixture(db)
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: fx.clarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: 'an answer',
        },
      ],
    })
    const row = db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.id, fx.clarifySessionId))
      .all()[0]!
    expect(row.status).toBe('answered')
    expect(row.answeredAt).not.toBeNull()
  })
})

describe('source-code grep guard — review.ts enqueues distill on both decision paths', () => {
  test('enqueueDistillJob appears twice in review.ts (once per return path)', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'review.ts'),
      'utf8',
    )
    const matches = src.match(/enqueueDistillJob\(/g) ?? []
    // Two call sites: one for approve, one for reject/iterate.
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})
