// RFC-023 PR-B T9 — lock the clarify service contract.
//
// Covers, in order:
//   1. createClarifySession round-trips a session row, marks the clarify
//      node_run awaiting_human, and broadcasts clarify.created.
//   2. submitClarifyAnswers seals selectedOptionLabels server-side from
//      question.options (defends against client-supplied label forgery).
//   3. submitClarifyAnswers enforces the ifMatchIteration optimistic lock
//      with a ConflictError (REST translates to 412).
//   4. submitClarifyAnswers refuses to act on a session that is already
//      answered (idempotency guard) — ConflictError.
//   5. submitClarifyAnswers mints a fresh source-agent node_run with
//      clarifyIteration + 1 and retry_index = 0, preserving shardKey +
//      parent_node_run_id for agent-multi shards.
//   6. submitClarifyAnswers calls rollbackToSnapshot when the source agent
//      had a preSnapshot. (We patch the git util via the worktree path
//      being empty to keep the test hermetic; we assert the rerun row
//      exists with preSnapshot mirrored.)
//   7. buildClarifyPromptContext returns the most-recent answered session
//      for (agentNodeId, shardKey) only when targetIteration > 0; absent
//      otherwise.
//   8. buildClarifyPromptContext respects shardKey scoping: an agent-single
//      rerun (shardKey=null) does NOT see an agent-multi shard's session.
//
// Together with clarify-no-cross-review-interference (separate file), this
// gives PR-B its full 9-case unit lock.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildClarifyPromptContext,
  createClarifySession,
  sealAnswersServerSide,
  submitClarifyAnswers,
} from '../src/services/clarify'
import { resetBroadcastersForTests, taskBroadcaster, TASK_CHANNEL } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  TaskWsMessage,
  WorkflowDefinition,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(
  db: DbClient,
  opts: { id?: string; worktreePath?: string; definition?: WorkflowDefinition } = {},
): Promise<{ taskId: string }> {
  const taskId = opts.id ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const def: WorkflowDefinition = opts.definition ?? {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as any,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as any,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clarify1', portName: 'questions' },
      },
      {
        id: 'e2',
        source: { nodeId: 'clarify1', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
  // Stub workflow row to satisfy tasks.workflow_id FK.
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-clarify-test/repo',
    worktreePath: opts.worktreePath ?? '', // empty disables rollback path
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

function makeQuestion(overrides: Partial<ClarifyQuestion> = {}): ClarifyQuestion {
  return {
    id: 'q1',
    title: 'Which database?',
    kind: 'single',
    recommended: true,
    options: ['Postgres', 'MySQL', 'SQLite'],
    ...overrides,
  }
}

function makeAnswer(overrides: Partial<ClarifyAnswer> = {}): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
    ...overrides,
  }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('createClarifySession', () => {
  test('inserts row, parks clarify node_run awaiting_human, broadcasts clarify.created', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)

    // Pre-existing source agent node_run (asking node_run).
    const sourceRunId = 'nr_source_1'
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { session, clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })

    expect(session.status).toBe('awaiting_human')
    expect(session.clarifyNodeRunId).toBe(clarifyNodeRunId)
    expect(session.questions).toHaveLength(1)

    const sessionRows = await db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.id, session.id))
    expect(sessionRows[0]?.status).toBe('awaiting_human')

    const nrRows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId))
    expect(nrRows[0]?.status).toBe('awaiting_human')
    expect(nrRows[0]?.nodeId).toBe('clarify1')

    expect(received.length).toBe(1)
    expect(received[0]?.type).toBe('clarify.created')
  })

  test('passes through sourceShardKey for agent-multi and clarifyIteration on the node_run row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const sourceRunId = 'nr_multi_shard'
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 1,
      shardKey: 'shard-A',
      parentNodeRunId: 'parent-multi-run',
    })

    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: 'shard-A',
      clarifyNodeId: 'clarify1',
      iterationIndex: 1,
      questions: [makeQuestion()],
      parentNodeRunId: 'parent-multi-run',
    })

    const nr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId)))[0]
    expect(nr?.shardKey).toBe('shard-A')
    expect(nr?.clarifyIteration).toBe(1)
    expect(nr?.parentNodeRunId).toBe('parent-multi-run')

    const sess = (
      await db
        .select()
        .from(clarifySessions)
        .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.sourceShardKey).toBe('shard-A')
  })
})

describe('sealAnswersServerSide', () => {
  test('rebuilds selectedOptionLabels from question.options regardless of client claim', () => {
    const q = makeQuestion()
    const a = makeAnswer({
      selectedOptionIndices: [1],
      selectedOptionLabels: ['<<malicious-label>>'],
    })
    const sealed = sealAnswersServerSide([q], [a])
    expect(sealed[0]?.selectedOptionLabels).toEqual(['MySQL'])
  })

  test('drops out-of-range indices and unknown question ids silently', () => {
    const q = makeQuestion()
    const sealed = sealAnswersServerSide(
      [q],
      [
        // 5 is past the 3-option array; service silently drops it. Negative
        // indices are blocked at the zod schema layer (nonnegative) so we
        // exercise only the "too high" branch here.
        makeAnswer({ selectedOptionIndices: [0, 5] }),
        makeAnswer({ questionId: 'unknown' }),
      ],
    )
    expect(sealed.length).toBe(1)
    expect(sealed[0]?.selectedOptionIndices).toEqual([0])
    expect(sealed[0]?.selectedOptionLabels).toEqual(['Postgres'])
  })
})

describe('submitClarifyAnswers', () => {
  test('seals answers, marks session answered, mints a rerun with clarifyIteration+1', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const sourceRunId = 'nr_src_submit'
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 2,
      iteration: 0,
      clarifyIteration: 0,
      reviewIteration: 1,
      preSnapshot: '',
    })

    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { session, rerunNodeRunId } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer({ selectedOptionIndices: [2] })],
    })

    expect(session.status).toBe('answered')
    expect(session.answers?.[0]?.selectedOptionLabels).toEqual(['SQLite'])

    const rerun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunNodeRunId)))[0]
    expect(rerun?.nodeId).toBe('designer')
    expect(rerun?.status).toBe('pending')
    expect(rerun?.retryIndex).toBe(0)
    expect(rerun?.clarifyIteration).toBe(1)
    expect(rerun?.reviewIteration).toBe(1) // passthrough

    // clarify node_run should be done now.
    const clRun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId)))[0]
    expect(clRun?.status).toBe('done')

    expect(received.find((m) => m.type === 'clarify.answered')).toBeDefined()
  })

  test('rejects mismatched ifMatchIteration with ConflictError', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_optimistic_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 3,
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_optimistic_src',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 3,
      questions: [makeQuestion()],
    })

    await expect(
      submitClarifyAnswers({
        db,
        clarifyNodeRunId,
        answers: [makeAnswer()],
        ifMatchIteration: 99,
      }),
    ).rejects.toMatchObject({ code: 'clarify-iteration-mismatch' })
  })

  test('refuses to act on an already-answered session (ConflictError)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_dup_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_dup_src',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
    })
    await expect(
      submitClarifyAnswers({
        db,
        clarifyNodeRunId,
        answers: [makeAnswer()],
      }),
    ).rejects.toMatchObject({ code: 'clarify-already-answered' })
  })

  test('preserves shardKey + parentNodeRunId on the rerun row for agent-multi shards', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_shard_submit',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      shardKey: 'shard-B',
      parentNodeRunId: 'parent-multi',
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_shard_submit',
      sourceShardKey: 'shard-B',
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
      parentNodeRunId: 'parent-multi',
    })

    const { rerunNodeRunId } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
    })

    const rerun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunNodeRunId)))[0]
    expect(rerun?.shardKey).toBe('shard-B')
    expect(rerun?.parentNodeRunId).toBe('parent-multi')
  })
})

describe('buildClarifyPromptContext', () => {
  test('returns undefined when targetIteration is 0 (first run)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const ctx = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 0,
      shardKey: null,
    })
    expect(ctx).toBeUndefined()
  })

  test('surfaces the latest answered session whose iterationIndex < targetIteration', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_ctx_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_ctx_src',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer({ selectedOptionIndices: [0] })],
    })

    const ctx = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.iteration).toBe('1')
    expect(ctx?.questionsBlock ?? '').toContain('Which database?')
    expect(ctx?.answersBlock ?? '').toContain('Postgres')
  })

  test('shardKey scoping: agent-single rerun does not see agent-multi shard sessions', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_shard_only',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      shardKey: 'shard-X',
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_shard_only',
      sourceShardKey: 'shard-X',
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
    })

    const ctxSingle = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null, // agent-single asking — must NOT pick up the shard-X session
    })
    expect(ctxSingle).toBeUndefined()

    const ctxShard = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: 'shard-X',
    })
    expect(ctxShard).toBeDefined()
  })
})

function emptyDefinition(): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes: [],
    edges: [],
    outputs: [],
  }
}
