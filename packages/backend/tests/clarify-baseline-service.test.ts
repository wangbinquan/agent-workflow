// RFC-058 PR-A baseline (T2): byte-level lock of RFC-023 self-clarify service
// path. Exercises createClarifySession + the seal/cleanup helpers, asserting
// the row projections and status transitions that PR-B refactor must preserve.
//
// Locks:
//   - createClarifySession field projection (agent-single + agent-multi shard)
//   - sealAnswersServerSide rebuilds labels from question.options
//   - cleanupSessionsForTask deletes the task's session rows
//   - node_run_outputs presence as the GENERAL aging trigger (sanity probe)
//
// RFC-132: the former 'continue / stop / lock' describe exercised the legacy
// quick-channel finalize itself (dead code deleted with RFC-132). Its unified
// equivalents — seal + auto-dispatch continuation, optimistic-lock mismatch,
// double-answer rejection — are locked by rfc128-p5-d-autodispatch.test.ts.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, nodeRunOutputs, tasks, workflows } from '../src/db/schema'
import {
  cleanupSessionsForTask,
  createClarifySession,
  sealAnswersServerSide,
} from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(
  db: DbClient,
  opts: { id?: string; definition?: WorkflowDefinition } = {},
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
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running' as const,
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
    recommended: false,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
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

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-058 baseline T2 — createClarifySession / row shape', () => {
  test('agent-single: session row carries source agent + shard NULL; clarify node_run awaiting_human', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_source_1',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { session, clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_source_1',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    expect(session.status).toBe('awaiting_human')
    expect(session.sourceAgentNodeId).toBe('designer')
    expect(session.sourceShardKey).toBeNull()
    expect(session.iterationIndex).toBe(0)
    const cnr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId)))[0]
    expect(cnr?.status).toBe('awaiting_human')
    expect(cnr?.shardKey).toBeNull()
  })

  test('agent-multi shard child: session row carries shardKey + parent_node_run_id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_multi',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      shardKey: 'shard-A',
      parentNodeRunId: 'parent-multi',
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_multi',
      sourceShardKey: 'shard-A',
      clarifyNodeId: 'clarify1',
      iterationIndex: 1,
      questions: [makeQuestion()],
      parentNodeRunId: 'parent-multi',
    })
    const sess = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.askingShardKey).toBe('shard-A')
    const cnr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId)))[0]
    expect(cnr?.shardKey).toBe('shard-A')
    expect(cnr?.parentNodeRunId).toBe('parent-multi')
  })
})

describe('RFC-058 baseline T2 — sealAnswersServerSide forgery defence', () => {
  test('selectedOptionLabels rebuilt from question.options regardless of client claim', () => {
    const q = makeQuestion()
    const sealed = sealAnswersServerSide(
      [q],
      [
        makeAnswer({
          selectedOptionIndices: [1],
          selectedOptionLabels: ['<<forged>>'],
        }),
      ],
    )
    expect(sealed[0]?.selectedOptionLabels).toEqual(['MySQL'])
  })

  test('out-of-bounds positive indices dropped silently (kept valid ones)', () => {
    const q = makeQuestion() // 2 options [Postgres, MySQL]
    const sealed = sealAnswersServerSide([q], [makeAnswer({ selectedOptionIndices: [5, 0] })])
    expect(sealed[0]?.selectedOptionLabels).toEqual(['Postgres'])
  })
})

describe('RFC-058 baseline T2 — cleanupSessionsForTask (task delete path)', () => {
  test('clears clarify_sessions rows belonging to the task', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_cleanup_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { session } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_cleanup_src',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    expect(session.status).toBe('awaiting_human')
    await cleanupSessionsForTask(db, taskId)
    const fresh = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    // RFC-058 baseline locks: cleanup deletes the row (does NOT transition to
    // canceled). Cancel-on-task-end is RFC-053 invariant CR-1 territory and
    // happens at a different layer.
    expect(fresh.length).toBe(0)
  })
})

describe('RFC-058 baseline T2 — nodeRunOutputs interaction (aging context)', () => {
  test('node_run_outputs row presence is the trigger for the GENERAL aging cutoff (sanity probe)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // A done run with outputs — this is what scheduler keys on for cutoff
    await db.insert(nodeRuns).values({
      id: 'nr_with_outputs',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_with_outputs',
      portName: 'plan',
      content: 'done output',
    })
    const rows = await db
      .select({ id: nodeRunOutputs.nodeRunId })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, 'nr_with_outputs'))
    expect(rows.length).toBe(1)
  })
})
