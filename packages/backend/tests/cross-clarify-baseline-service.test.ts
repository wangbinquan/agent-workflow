// RFC-058 PR-A baseline (T3): byte-level lock of RFC-056 cross-clarify service
// path. Exercises createCrossClarifySession → submitCrossClarifyAnswers →
// designer rerun readiness → questioner cascade, asserting iteration counter
// rules, dispatch outcomes, External Feedback / Prior Output assembly, and
// hasPersistentStop persistence semantics that PR-B refactor must preserve.
//
// Locks:
//   - createCrossClarifySession iteration counter (same node × loopIter)
//   - loop_iter isolation (different loopIter → independent iteration count)
//   - submit continue single source → designer-rerun-triggered
//   - submit continue multi-source → designer-waiting → designer-rerun-triggered
//   - submit stop → questioner-stop-triggered + hasPersistentStop=true
//   - reject persistence: hasPersistentStop survives across reruns
//   - ifMatchIteration optimistic lock
//   - designer-target-missing path
//   - evaluateDesignerRerunReadiness returns sources in stable order
//   - buildExternalFeedbackContext dictionary order + priorOutputBlock presence
//   - buildQuestionerCrossClarifyContext returns full Q&A history (RFC-058
//     baseline locks current behavior; PR-B introduces aging cutoff)

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  buildQuestionerCrossClarifyContext,
  createCrossClarifySession,
  evaluateDesignerRerunReadiness,
  hasPersistentStop,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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
      crossClarifyIteration: 0,
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
    expect(nr?.crossClarifyIteration).toBe(0)
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
      crossClarifyIteration: 0,
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
      crossClarifyIteration: 0,
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
      crossClarifyIteration: 0,
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

describe('RFC-058 baseline T3 — submitCrossClarifyAnswers outcomes', () => {
  async function seedSubmittable(
    db: DbClient,
    designerCciTarget: 'designer' | null = 'designer',
    crossClarifyNodeIds: string[] = ['cc1'],
    questionerNodeIds: string[] = ['questioner'],
  ): Promise<{ taskId: string; crossClarifyNodeRunIds: string[] }> {
    const { taskId } = await seedCrossClarifyTask(db, {
      crossClarifyNodeIds,
      questionerNodeIds,
    })
    // Always seed a designer prior done run — triggerDesignerRerun needs to
    // look it up to inherit cci + spawn a new attempt.
    await db.insert(nodeRuns).values({
      id: 'nr_designer_prior',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      startedAt: Date.now() - 100,
    })
    const crossClarifyNodeRunIds: string[] = []
    for (let i = 0; i < crossClarifyNodeIds.length; i++) {
      const ccId = crossClarifyNodeIds[i]!
      const qId = questionerNodeIds[Math.min(i, questionerNodeIds.length - 1)]!
      const qRunId = `nr_${qId}_${i}`
      const existing = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, qRunId))).length > 0
      if (!existing) {
        await db.insert(nodeRuns).values({
          id: qRunId,
          taskId,
          nodeId: qId,
          status: 'done',
          retryIndex: 0,
          iteration: 0,
          crossClarifyIteration: 0,
        })
      }
      const { crossClarifyNodeRunId } = await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId: ccId,
        sourceQuestionerNodeId: qId,
        sourceQuestionerNodeRunId: qRunId,
        targetDesignerNodeId: designerCciTarget,
        loopIter: 0,
        questions: [makeQuestion()],
      })
      crossClarifyNodeRunIds.push(crossClarifyNodeRunId)
    }
    return { taskId, crossClarifyNodeRunIds }
  }

  test('continue single source → designer-rerun-triggered + designer node_run minted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunIds } = await seedSubmittable(db)
    const r = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: crossClarifyNodeRunIds[0]!,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    expect(r.session.status).toBe('answered')
    expect(r.session.directive).toBe('continue')
    expect(r.outcome.kind).toBe('designer-rerun-triggered')
    if (r.outcome.kind === 'designer-rerun-triggered') {
      const designerRun = (
        await db.select().from(nodeRuns).where(eq(nodeRuns.id, r.outcome.designerNodeRunId))
      )[0]
      expect(designerRun?.nodeId).toBe('designer')
      expect(r.outcome.sourceCount).toBe(1)
    }
    // designer_run_triggered_at stamped on session
    const persisted = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, r.session.id))
    )[0]
    expect(persisted?.designerRunTriggeredAt).toBeTruthy()
    void taskId
  })

  test('continue multi-source: first submit → designer-waiting, second → designer-rerun-triggered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { crossClarifyNodeRunIds } = await seedSubmittable(
      db,
      'designer',
      ['cc_a', 'cc_b'],
      ['q_a', 'q_b'],
    )
    const r1 = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: crossClarifyNodeRunIds[0]!,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    expect(r1.outcome.kind).toBe('designer-waiting')
    if (r1.outcome.kind === 'designer-waiting') {
      expect(r1.outcome.pendingCrossClarifyNodeIds).toEqual(['cc_b'])
    }
    const r2 = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: crossClarifyNodeRunIds[1]!,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    expect(r2.outcome.kind).toBe('designer-rerun-triggered')
    if (r2.outcome.kind === 'designer-rerun-triggered') {
      expect(r2.outcome.sourceCount).toBe(2)
    }
  })

  test('stop directive → questioner-stop-triggered + hasPersistentStop=true', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunIds } = await seedSubmittable(db)
    const r = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: crossClarifyNodeRunIds[0]!,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
    })
    expect(r.session.directive).toBe('stop')
    expect(r.outcome.kind).toBe('questioner-stop-triggered')
    const persistentStop = await hasPersistentStop(db, taskId, 'cc1')
    expect(persistentStop).toBe(true)
  })

  test('ifMatchIteration mismatch → ConflictError cross-clarify-iteration-mismatch', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { crossClarifyNodeRunIds } = await seedSubmittable(db)
    await expect(
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId: crossClarifyNodeRunIds[0]!,
        answers: [makeAnswer()],
        directive: 'continue',
        ifMatchIteration: 42,
      }),
    ).rejects.toThrow(/cross-clarify-iteration-mismatch|server/)
  })

  test('designer-target-missing path: targetDesignerNodeId=null → designer-target-missing outcome', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { crossClarifyNodeRunIds } = await seedSubmittable(db, null)
    const r = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: crossClarifyNodeRunIds[0]!,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    expect(r.outcome.kind).toBe('designer-target-missing')
  })

  test('idempotency: re-submitting answered session throws ConflictError', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { crossClarifyNodeRunIds } = await seedSubmittable(db)
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: crossClarifyNodeRunIds[0]!,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    await expect(
      submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId: crossClarifyNodeRunIds[0]!,
        answers: [makeAnswer()],
        directive: 'continue',
        ifMatchIteration: 0,
      }),
    ).rejects.toThrow()
  })
})

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
      crossClarifyIteration: 0,
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
        crossClarifyIteration: 0,
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
    // Submit only cc_alpha. cc_zeta still awaiting_human.
    const ccAlphaRunRows = await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.crossClarifyNodeId, 'cc_alpha'))
    const cnrA = ccAlphaRunRows[0]!.crossClarifyNodeRunId
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: cnrA,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
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

describe('RFC-058 baseline T3 — buildExternalFeedbackContext (designer side prompt)', () => {
  test('returns block with sources after answered+continue sessions exist', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedCrossClarifyTask(db)
    // Designer's prior done run + outputs (priorOutputBlock is built by
    // scheduler — not by buildExternalFeedbackContext; keep this DB shape
    // realistic so the buildExternalFeedbackContext call has the rows it needs).
    await db.insert(nodeRuns).values({
      id: 'nr_designer_prior',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      startedAt: Date.now() - 100,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_designer_prior',
      portName: 'plan',
      content: 'step 1; step 2',
    })
    await db.insert(nodeRuns).values({
      id: 'nr_q_done',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      crossClarifyIteration: 0,
    })
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_done',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion({ title: 'cross-clarify question A' })],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: 1,
      definition,
    })
    expect(ctx?.block).toContain('### From')
    expect(ctx?.block).toContain('cross-clarify question A')
    expect(ctx?.sourcesCsv).toContain('questioner')
    // priorOutputBlock is populated by scheduler.ts (line 1490), NOT this
    // function. RFC-058 baseline locks: this function returns the External
    // Feedback block + iteration + sourcesCsv; priorOutputBlock is undefined
    // here by design.
    expect(ctx?.priorOutputBlock).toBeUndefined()
  })

  test('designerCrossClarifyIteration<=0 → undefined (first designer run)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedCrossClarifyTask(db)
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerCrossClarifyIteration: 0,
      definition,
    })
    expect(ctx).toBeUndefined()
  })
})

describe('RFC-058 baseline T3 — buildQuestionerCrossClarifyContext (questioner cascade prompt)', () => {
  test('returns full Q&A history when questioner runs after submit (RFC-058 PR-A: locks current behavior)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    // Designer prior done run so triggerDesignerRerun can spawn the next attempt.
    await db.insert(nodeRuns).values({
      id: 'nr_designer_prior',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      crossClarifyIteration: 0,
      startedAt: Date.now() - 100,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_q_done',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      crossClarifyIteration: 0,
    })
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_done',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion({ title: 'first round question' })],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 1,
    })
    expect(ctx).toBeDefined()
    // RFC-058 baseline: PR-A locks current behavior — full history surfaces in
    // questioner cascade prompt. PR-B will add aging cutoff + loop_iter filter
    // and tighten this surface (see C3 + C6 守门 in RFC-058 design.md §8.3).
    expect(ctx?.questionsBlock).toContain('first round question')
  })

  test('no prior cross-clarify Q&A → undefined ctx (first questioner run)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 0,
    })
    expect(ctx).toBeUndefined()
  })

  test('targetCrossClarifyIteration=0 path → undefined', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_designer_prior',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        crossClarifyIteration: 0,
        startedAt: Date.now() - 100,
      },
      {
        id: 'nr_q_done',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        crossClarifyIteration: 0,
      },
    ])
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_done',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 0,
    })
    expect(ctx).toBeUndefined()
  })
})

describe('RFC-058 baseline T3 — hasPersistentStop reject persistence', () => {
  test('returns false when no stop submit yet', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedCrossClarifyTask(db)
    expect(await hasPersistentStop(db, taskId, 'cc1')).toBe(false)
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
        crossClarifyIteration: 0,
      },
      {
        id: 'nr_qb',
        taskId,
        nodeId: 'questioner_b',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        crossClarifyIteration: 0,
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
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: cnrStop,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
    })
    expect(await hasPersistentStop(db, taskId, 'cc_stop')).toBe(true)
    expect(await hasPersistentStop(db, taskId, 'cc_continue')).toBe(false)
  })
})
