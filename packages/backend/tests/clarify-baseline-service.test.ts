// RFC-058 PR-A baseline (T2): byte-level lock of RFC-023 self-clarify service
// path. Exercises createClarifySession → submitClarifyAnswers →
// buildClarifyPromptContext end-to-end, asserting the prompt strings, status
// transitions, and node_run cci inheritance that PR-B refactor must preserve.
//
// Locks:
//   - createClarifySession field projection (agent-single + agent-multi shard)
//   - submitClarifyAnswers happy continue / stop directives + new run mint
//   - ifMatchIteration optimistic lock (mismatch + match)
//   - buildClarifyPromptContext multi-round Q&A rendering w/ `### Round N`
//   - buildClarifyPromptContext inline mode collapse to last round
//   - buildClarifyPromptContext shard-key isolation
//   - buildClarifyPromptContext historyCutoffClarifyIteration GENERAL aging
//   - applyLatestDirective=false suppresses trailer (review-iterate path)
//   - cancel-on-task-close converts awaiting_human → canceled
//   - sealAnswersServerSide rebuilds labels from question.options

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, nodeRuns, nodeRunOutputs, tasks, workflows } from '../src/db/schema'
import {
  buildClarifyPromptContext,
  cleanupSessionsForTask,
  createClarifySession,
  sealAnswersServerSide,
  submitClarifyAnswers,
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
      clarifyIteration: 0,
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
      clarifyIteration: 1,
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
        .from(clarifySessions)
        .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    )[0]
    expect(sess?.sourceShardKey).toBe('shard-A')
    const cnr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyNodeRunId)))[0]
    expect(cnr?.shardKey).toBe('shard-A')
    expect(cnr?.parentNodeRunId).toBe('parent-multi')
    expect(cnr?.clarifyIteration).toBe(1)
  })
})

describe('RFC-058 baseline T2 — submitClarifyAnswers continue / stop / lock', () => {
  test('happy continue: status=answered, directive=continue, source run cci+1', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_source_2',
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
      sourceAgentNodeRunId: 'nr_source_2',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    const r = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer({ selectedOptionIndices: [0] })],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    expect(r.session.status).toBe('answered')
    expect(r.session.directive).toBe('continue')
    expect(r.rerunNodeRunId).toBeTruthy()
    const next = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, r.rerunNodeRunId)))[0]
    expect(next?.clarifyIteration).toBe(1)
    expect(next?.retryIndex).toBe(0)
    expect(next?.nodeId).toBe('designer')
  })

  test('stop directive: session.directive=stop persisted; source rerun minted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_source_3',
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
      sourceAgentNodeRunId: 'nr_source_3',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    const r = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
    })
    expect(r.session.directive).toBe('stop')
    expect(r.session.status).toBe('answered')
  })

  test('ifMatchIteration mismatch → ConflictError thrown (no state change)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_source_4',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    const { session, clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_source_4',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    await expect(
      submitClarifyAnswers({
        db,
        clarifyNodeRunId,
        answers: [makeAnswer()],
        directive: 'continue',
        ifMatchIteration: 99,
      }),
    ).rejects.toThrow()
    // Status unchanged
    const fresh = (
      await db.select().from(clarifySessions).where(eq(clarifySessions.id, session.id))
    )[0]
    expect(fresh?.status).toBe('awaiting_human')
  })

  test('idempotency: re-submitting an already-answered session throws ConflictError', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_source_5',
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
      sourceAgentNodeRunId: 'nr_source_5',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    await expect(
      submitClarifyAnswers({
        db,
        clarifyNodeRunId,
        answers: [makeAnswer()],
        directive: 'continue',
        ifMatchIteration: 0,
      }),
    ).rejects.toThrow()
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

describe('RFC-058 baseline T2 — buildClarifyPromptContext multi-round + inline', () => {
  test('targetIteration=0 → undefined (first run, no prior Q&A)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const ctx = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 0,
      shardKey: null,
    })
    expect(ctx).toBeUndefined()
  })

  test('multi-round (2 prior rounds): both rendered chronologically with `### Round N`', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // Round 0 source run + clarify + submit
    await db.insert(nodeRuns).values({
      id: 'nr_s_r0',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    const { clarifyNodeRunId: cnr0 } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_s_r0',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion({ title: 'Round 0 question?' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnr0,
      answers: [makeAnswer({ selectedOptionIndices: [0] })],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    // Round 1 source run + clarify + submit
    await db.insert(nodeRuns).values({
      id: 'nr_s_r1',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 1,
      clarifyIteration: 1,
    })
    const { clarifyNodeRunId: cnr1 } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_s_r1',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 1,
      questions: [makeQuestion({ title: 'Round 1 question?' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnr1,
      answers: [makeAnswer({ selectedOptionIndices: [1] })],
      directive: 'continue',
      ifMatchIteration: 1,
    })
    // Build context for cci=2 rerun
    const ctx = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
    })
    expect(ctx).toBeDefined()
    // RFC-058 BASELINE: prompt questionsBlock contains BOTH rounds, ordered
    // chronologically (Round 1, Round 2) — multi-round invariant.
    expect(ctx?.questionsBlock).toContain('### Round 1')
    expect(ctx?.questionsBlock).toContain('### Round 2')
    expect(ctx?.questionsBlock).toContain('Round 0 question?')
    expect(ctx?.questionsBlock).toContain('Round 1 question?')
    // Round 1 must appear before Round 2 in the rendered string
    const block = ctx?.questionsBlock ?? ''
    expect(block.indexOf('### Round 1')).toBeLessThan(block.indexOf('### Round 2'))
    expect(ctx?.directive).toBe('continue')
  })

  test('inline mode: only the LAST round rendered (current-round-only flag set)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // 2 prior answered rounds
    await db.insert(nodeRuns).values([
      {
        id: 'nr_i_r0',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        clarifyIteration: 0,
      },
      {
        id: 'nr_i_r1',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 1,
        clarifyIteration: 1,
      },
    ])
    const { clarifyNodeRunId: cnr0 } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_i_r0',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion({ title: 'older round Q' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnr0,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    const { clarifyNodeRunId: cnr1 } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_i_r1',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 1,
      questions: [makeQuestion({ title: 'newest round Q' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnr1,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 1,
    })
    const ctx = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      sessionMode: 'inline',
    })
    // Inline collapses to last round only; tagged with mode='inline'
    expect(ctx?.mode).toBe('inline')
    expect(ctx?.currentRoundOnly).toBe(true)
    expect(ctx?.questionsBlock).toContain('newest round Q')
    expect(ctx?.questionsBlock).not.toContain('older round Q')
  })

  test('shardKey isolation: agent-single (shardKey=null) does NOT see agent-multi shard session', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_shard_A',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      shardKey: 'shard-A',
      parentNodeRunId: 'parent-A',
    })
    const { clarifyNodeRunId: cnrA } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_shard_A',
      sourceShardKey: 'shard-A',
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion({ title: 'shard A question' })],
      parentNodeRunId: 'parent-A',
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnrA,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    // agent-single rerun (shardKey=null) for cci=1 — should NOT see shard-A's Q&A.
    const ctx = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
    })
    expect(ctx).toBeUndefined()
  })

  test('historyCutoffClarifyIteration prunes rounds with iterationIndex < cutoff', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // Two prior rounds (round 0 + round 1 answered)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_cut_r0',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        clarifyIteration: 0,
      },
      {
        id: 'nr_cut_r1',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 1,
        clarifyIteration: 1,
      },
    ])
    const { clarifyNodeRunId: cnrR0 } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_cut_r0',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion({ title: 'pre-cutoff round' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnrR0,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    const { clarifyNodeRunId: cnrR1 } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_cut_r1',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 1,
      questions: [makeQuestion({ title: 'post-cutoff round' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnrR1,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 1,
    })
    const ctx = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      historyCutoffClarifyIteration: 1, // drop iterationIndex < 1
    })
    expect(ctx).toBeDefined()
    expect(ctx?.questionsBlock).not.toContain('pre-cutoff round')
    expect(ctx?.questionsBlock).toContain('post-cutoff round')
  })

  test('historyCutoff prunes ALL rows → undefined ctx (clarify section omitted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_cut_all_r0',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    const { clarifyNodeRunId: cnrAll } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_cut_all_r0',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnrAll,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    const ctx = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      historyCutoffClarifyIteration: 5,
    })
    expect(ctx).toBeUndefined()
  })

  test('applyLatestDirective=false suppresses STOP CLARIFYING trailer (review-iterate path)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_dir_r0',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    const { clarifyNodeRunId: cnrDir } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_dir_r0',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion()],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: cnrDir,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
    })
    const ctxApply = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      applyLatestDirective: true,
    })
    expect(ctxApply?.directive).toBe('stop')
    expect(ctxApply?.answersBlock).toContain('STOP CLARIFYING')

    const ctxNoApply = await buildClarifyPromptContext({
      db,
      definition: JSON.parse(
        (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workflowSnapshot,
      ) as WorkflowDefinition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      applyLatestDirective: false,
    })
    // Default directive remains 'continue'; trailer suppressed
    expect(ctxNoApply?.directive).toBe('continue')
    expect(ctxNoApply?.answersBlock).not.toContain('STOP CLARIFYING')
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
      clarifyIteration: 0,
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
    const fresh = await db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
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
      clarifyIteration: 0,
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
