// RFC-023 PR-B T9 — lock the clarify service contract.
//
// Covers, in order:
//   1. createClarifyRound round-trips a session row, marks the clarify
//      node_run awaiting_human, and broadcasts clarify.created.
//   2. createClarifyRound passes through sourceShardKey + parentNodeRunId
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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  collaborationGateOperations,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { createClarifyRound, sealAnswersServerSide } from '../src/services/clarify/service'
import { resetBroadcastersForTests, taskBroadcaster, TASK_CHANNEL } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  TaskWsMessage,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import { installCommittedEventProjectionHarness } from './helpers/committedEventHarness'

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

let uninstallProjection = (): void => {}

function createProjectionDb(): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  uninstallProjection = installCommittedEventProjectionHarness(db)
  return db
}

beforeEach(() => {
  uninstallProjection()
  uninstallProjection = (): void => {}
  resetBroadcastersForTests()
})
afterEach(() => {
  uninstallProjection()
  resetBroadcastersForTests()
})

describe('createClarifyRound', () => {
  test('inserts row, parks clarify node_run awaiting_human, broadcasts clarify.created', async () => {
    const db = createProjectionDb()
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

    const { round: session, intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: sourceRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    })

    expect(session.status).toBe('awaiting_human')
    expect(session.intermediaryNodeRunId).toBe(clarifyNodeRunId)
    expect(session.questions).toHaveLength(1)

    const sessionRows = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, session.id))
    expect(sessionRows[0]?.status).toBe('awaiting_human')

    const nrRows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId))
    expect(nrRows[0]?.status).toBe('awaiting_human')
    expect(nrRows[0]?.nodeId).toBe('clarify1')
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe('awaiting_human')
    expect(
      db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)).get(),
    ).toMatchObject({
      originNodeRunId: clarifyNodeRunId,
      questionId: 'q1',
      sourceKind: 'self',
      roleKind: 'self',
      defaultTargetNodeId: 'designer',
    })

    expect(received.length).toBe(1)
    expect(received[0]?.type).toBe('clarify.created')
  })

  test('exact re-emit replays one round/question/event; changed content advances the stable gate', async () => {
    const db = createProjectionDb()
    const { taskId } = await seedTask(db)
    const sourceRunId = 'nr_source_reemit'
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (message) => received.push(message))
    const request = {
      kind: 'self' as const,
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: sourceRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    }
    const first = await createClarifyRound(request)
    const replay = await createClarifyRound(request)
    expect(replay.round.id).toBe(first.round.id)
    expect(received).toHaveLength(1)
    expect(
      db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all(),
    ).toHaveLength(1)
    expect(
      db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)).all(),
    ).toHaveLength(1)

    const changed = await createClarifyRound({
      ...request,
      questions: [makeQuestion({ title: 'Which durable database?' })],
    })
    expect(changed.round.id).not.toBe(first.round.id)
    expect(changed.intermediaryNodeRunId).toBe(first.intermediaryNodeRunId)
    expect(received).toHaveLength(2)
    expect(
      db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all(),
    ).toHaveLength(2)
    expect(db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)).all()).toEqual([
      expect.objectContaining({ questionId: 'q1', questionTitle: 'Which durable database?' }),
    ])
    expect(
      db
        .select({ revision: collaborationGateOperations.resultGateRevision })
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
        .all()
        .map((operation) => operation.revision)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual([1, 2])
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

    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: sourceRunId,
      askingShardKey: 'shard-A',
      intermediaryNodeId: 'clarify1',
      iteration: 1,
      questions: [makeQuestion()],
      parentNodeRunId: 'parent-multi-run',
      truncationWarnings: [
        { code: 'clarify-options-too-many', detail: 'fixture warning survives atomic open' },
      ],
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
    expect(sess?.truncationWarningsJson).toBe(
      JSON.stringify([
        { code: 'clarify-options-too-many', detail: 'fixture warning survives atomic open' },
      ]),
    )
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
