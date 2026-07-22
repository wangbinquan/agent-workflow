// RFC-058 PR-A baseline (T3): byte-level lock of RFC-056 cross-clarify service
// path. Exercises createCrossClarifySession → answering the round (RFC-132
// unified quick channel) → designer rerun readiness, asserting iteration
// counter rules and the node-level stop-directive persistence semantics that
// refactors must preserve.
//
// Locks:
//   - createCrossClarifySession iteration counter (same node × loopIter)
//   - loop_iter isolation (different loopIter → independent iteration count)
//   - evaluateDesignerRerunReadiness ready/pending logic (the dispatch's
//     multi-source readiness gate reuses it)
//   - reject persistence: resolveCrossNodeStopped reads the node-level stop
//     directive an answer-stop writes (RFC-132 T7)
//
// (The legacy quick-channel outcome contract itself was retired by RFC-132 —
// answers now seal + auto-dispatch via autoDispatchClarifyRound.)

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import {
  createCrossClarifySession,
  evaluateDesignerRerunReadiness,
  resolveCrossNodeStopped,
} from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

async function seedCrossClarifyTask(
  db: DbClient,
  opts: {
    id?: string
    designerCount?: number
    questionerNodeIds?: string[]
    crossClarifyNodeIds?: string[]
  } = {},
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = opts.id ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const designerNodeId = 'designer'
  const questionerNodeIds = opts.questionerNodeIds ?? ['questioner']
  const crossClarifyNodeIds = opts.crossClarifyNodeIds ?? ['cc1']
  const nodes: WorkflowNode[] = [
    { id: designerNodeId, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    ...questionerNodeIds.map(
      (qid) =>
        ({
          id: qid,
          kind: 'agent-single',
          agentName: qid,
        }) as WorkflowNode,
    ),
    ...crossClarifyNodeIds.map(
      (ccId) =>
        ({
          id: ccId,
          kind: 'clarify-cross-agent',
          title: ccId,
        }) as WorkflowNode,
    ),
  ]
  const edges = [] as WorkflowDefinition['edges']
  // Wire each cross-clarify to its questioner + designer
  for (let i = 0; i < crossClarifyNodeIds.length; i++) {
    const ccId = crossClarifyNodeIds[i]!
    const qId = questionerNodeIds[Math.min(i, questionerNodeIds.length - 1)]!
    edges.push({
      id: `e_q_${ccId}`,
      source: { nodeId: qId, portName: '__clarify__' },
      target: { nodeId: ccId, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${ccId}`,
      source: { nodeId: ccId, portName: 'to_designer' },
      target: { nodeId: designerNodeId, portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${ccId}`,
      source: { nodeId: ccId, portName: 'to_questioner' },
      target: { nodeId: qId, portName: '__clarify_response__' },
    })
  }
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges,
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-cross-clarify-test/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition: def }
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

describe('RFC-058 baseline T3 — createCrossClarifySession iteration counter', () => {
  test('first session: iteration=0 + row carries source / target / loopIter', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { session, crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(session.iteration).toBe(0)
    expect(session.status).toBe('awaiting_human')
    expect(session.targetDesignerNodeId).toBe('designer')
    expect(session.loopIter).toBe(0)
    const nr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, crossClarifyNodeRunId)))[0]
    expect(nr?.status).toBe('awaiting_human')
  })

  test('same (node, loopIter): iteration increments to 1 after another mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const { session: s2 } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(s2.iteration).toBe(1)
  })

  test('loop_iter isolation: same node, different loopIter → both start at iteration=0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { session: i0 } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const { session: i1 } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_1',
      targetDesignerNodeId: 'designer',
      loopIter: 1,
      questions: [makeQuestion()],
    })
    expect(i0.iteration).toBe(0)
    expect(i1.iteration).toBe(0)
  })

  test('different cross-clarify nodes are independent counters', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db, {
      crossClarifyNodeIds: ['cc_a', 'cc_b'],
      questionerNodeIds: ['questioner'],
    })
    await db.insert(nodeRuns).values({
      id: 'nr_q_1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { session: a } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc_a',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const { session: b } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc_b',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(a.iteration).toBe(0)
    expect(b.iteration).toBe(0)
  })
})

// (The legacy quick-channel 'outcomes' describe was DELETED by RFC-132 — it locked the
// retired outcome contract itself. The unified equivalents live in
// rfc128-p5-d-autodispatch.test.ts: iteration-mismatch → 'clarify-iteration-mismatch',
// double-answer → 'clarify-already-answered', stop → questioner rerun + node directive.)

describe('RFC-058 baseline T3 — evaluateDesignerRerunReadiness ready/pending logic', () => {
  test('after 1 of 2 submits: ready=false + pending lists unsubmitted cc', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedCrossClarifyTask(db, {
      crossClarifyNodeIds: ['cc_alpha', 'cc_zeta'],
      questionerNodeIds: ['questioner_alpha', 'questioner_zeta'],
    })
    await db.insert(nodeRuns).values({
      id: 'nr_designer_prior',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 100,
    })
    for (const [qid, ccid] of [
      ['questioner_alpha', 'cc_alpha'],
      ['questioner_zeta', 'cc_zeta'],
    ] as const) {
      const runId = `nr_${qid}`
      await db.insert(nodeRuns).values({
        id: runId,
        taskId,
        nodeId: qid,
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      })
      await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId: ccid,
        sourceQuestionerNodeId: qid,
        sourceQuestionerNodeRunId: runId,
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQuestion()],
      })
    }
    // Answer only cc_alpha (unified quick channel; the designer auto-dispatch parks on the
    // not-ready sibling). cc_zeta still awaiting_human.
    const ccAlphaRunRows = await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeId, 'cc_alpha'))
    const cnrA = ccAlphaRunRows[0]!.intermediaryNodeRunId
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: cnrA,
      answers: [makeAnswer()],
      ifMatchIteration: 0,
      actor,
    })
    const r = await evaluateDesignerRerunReadiness({
      db,
      taskId,
      designerNodeId: 'designer',
      definition,
      loopIter: 0,
    })
    expect(r.ready).toBe(false)
    expect(r.pendingCrossClarifyNodeIds).toContain('cc_zeta')
  })
})

describe('RFC-058 baseline T3 — resolveCrossNodeStopped reject persistence', () => {
  test('returns false when no stop submit yet', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner')).toBe(false)
  })

  test('returns true after stop submit, persists across additional continue submits on other ccs', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db, {
      crossClarifyNodeIds: ['cc_stop', 'cc_continue'],
      questionerNodeIds: ['questioner_a', 'questioner_b'],
    })
    await db.insert(nodeRuns).values([
      {
        id: 'nr_qa',
        taskId,
        nodeId: 'questioner_a',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_qb',
        taskId,
        nodeId: 'questioner_b',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    const { crossClarifyNodeRunId: cnrStop } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc_stop',
      sourceQuestionerNodeId: 'questioner_a',
      sourceQuestionerNodeRunId: 'nr_qa',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    // RFC-132: the stop answer (unified quick channel) writes the questioner's node-level
    // directive; resolveCrossNodeStopped reads it (RFC-132 T7 single source).
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: cnrStop,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
      actor,
    })
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner_a')).toBe(true)
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner_b')).toBe(false)
  })
})
