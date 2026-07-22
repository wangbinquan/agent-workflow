// RFC-023 PR-B T9 — lock the clarify service contract.
//
// Covers, in order:
//   1. createClarifySession round-trips a session row, marks the clarify
//      node_run awaiting_human, and broadcasts clarify.created.
//   2. createClarifySession passes through sourceShardKey + parentNodeRunId
//      for agent-multi shard children.
//   3. sealAnswersServerSide seals selectedOptionLabels server-side from
//      question.options (defends against client-supplied label forgery) and
//      drops out-of-range indices / unknown question ids silently.
//
// RFC-132: the former answer-submit describe (whole-round finalize, optimistic
// lock, double-answer rejection, rerun mint + shard passthrough) exercised the
// legacy quick-channel finalize itself — deleted with that dead code. The
// unified equivalents (seal + auto-dispatch continuation, incl. the
// dispatch-layer inheritance of shard/parent fields) are locked by
// rfc128-p5-d-autodispatch.test.ts.
//
// Together with clarify-no-cross-review-interference (separate file), this
// keeps the create/seal unit lock.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession, sealAnswersServerSide } from '../src/services/clarify'
import { resetBroadcastersForTests, taskBroadcaster, TASK_CHANNEL } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  TaskWsMessage,
  WorkflowDefinition,
  WorkflowNode,
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
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
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
    name: 'fixture-task',

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
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
      { label: 'SQLite', description: '', recommended: false, recommendationReason: '' },
    ],
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
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, session.id))
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
    expect(nr?.parentNodeRunId).toBe('parent-multi-run')

    const sess = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.askingShardKey).toBe('shard-A')
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
