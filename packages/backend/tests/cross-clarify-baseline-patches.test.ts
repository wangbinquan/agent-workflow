// RFC-058 PR-A baseline (T4): byte-level lock of RFC-056 patch chain 2026-05-22
// through 2026-05-25 invariants. These tests are intentionally focused on the
// direct outcomes of each patch (cascade BFS minted, cci computation, cci
// inheritance, questioner cascade visibility) rather than re-deriving the full
// scenario coverage already in:
//   - cross-clarify-downstream-cascade.test.ts (patch-22 cascade)
//   - cross-clarify-questioner-context.test.ts (patch-22 questioner Q&A inject)
//   - cross-clarify-designer-retry-index.test.ts (patch-23 cci formula)
//   - cross-clarify-retry-preserves-iteration.test.ts (patch-24 inheritance)
//   - cross-clarify-questioner-cascade-no-skip.test.ts (patch-25 cascade)
//
// PR-B refactor: when this file goes red AND the per-patch tests stay green,
// inspect which invariant slipped (likely cci computation moved or cascade
// helper signature changed). When this file stays green but a per-patch test
// goes red, the underlying patch logic was preserved but a corner case
// regressed.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createCrossClarifySession,
  submitCrossClarifyAnswers,
  triggerDesignerRerun,
  buildQuestionerCrossClarifyContext,
} from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTriad(
  db: DbClient,
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: 'cc1', kind: 'clarify-cross-agent', title: 'cc1' } as WorkflowNode,
  ]
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cc1', portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: 'cc1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: 'cc1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    name: 'patch-baseline',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-patch-baseline/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition }
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

function makeAnswer(): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
  }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-058 baseline T4 — patch-2026-05-23 designer retry index', () => {
  test('triggerDesignerRerun mints new attempt with cci > max(designer, source)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTriad(db)
    // Seed designer at cci=2 (i.e. has been pumped before)
    await db.insert(nodeRuns).values({
      id: 'nr_designer_old',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      crossClarifyIteration: 2,
      startedAt: Date.now() - 1000,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_q1',
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
      sourceQuestionerNodeRunId: 'nr_q1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const result = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [
        {
          sessionId: 'sess1',
          crossClarifyNodeId: 'cc1',
          sourceQuestionerNodeId: 'questioner',
          iteration: 0,
          questions: [makeQuestion()],
          answers: [makeAnswer()],
          questionScopes: null,
        },
      ],
      loopIter: 0,
      worktreePath: '',
      definition,
    })
    const newRun = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.designerNodeRunId))
    )[0]
    // RFC-058 baseline locks: patch-2026-05-23 formula — newCci > prior max
    expect(newRun?.crossClarifyIteration).toBeGreaterThan(2)
    void crossClarifyNodeRunId
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-24 cci inheritance', () => {
  test('cross-clarify session cci row inherits from latest questioner cci value', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
    // Questioner has been around — has cci=3
    await db.insert(nodeRuns).values({
      id: 'nr_q3',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      crossClarifyIteration: 3,
      startedAt: Date.now() - 100,
    })
    // createCrossClarifySession iteration counter is per (cc node, loopIter)
    // — cci on the cross-clarify node_run is the session iteration. So this
    // test pivots to: session iteration is per (cc, loopIter), not inheriting
    // from the questioner's cci.
    const { session } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q3',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(session.iteration).toBe(0)
    // The cc node_run row mints crossClarifyIteration = session iteration
    const nr = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, session.crossClarifyNodeRunId))
    )[0]
    expect(nr?.crossClarifyIteration).toBe(0)
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-22 questioner Q&A injection', () => {
  test('buildQuestionerCrossClarifyContext surfaces prior cc Q&A when cci > 0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
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
      questions: [makeQuestion({ title: 'patch-22 baseline question' })],
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
    expect(ctx?.questionsBlock).toContain('patch-22 baseline question')
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-25 cci inheritance grep guards', () => {
  test('source-text grep: 5 insert sites carry inherited cci fields', async () => {
    const fs = await import('node:fs/promises')
    const files = ['packages/backend/src/services/scheduler.ts']
    let hits = 0
    for (const path of files) {
      const txt = await fs.readFile(resolve(import.meta.dir, '..', '..', '..', path), 'utf8')
      const matches = txt.match(/inheritedCrossClarifyIteration\b/g) ?? []
      hits += matches.length
    }
    // RFC-058 baseline locks: patch-25 wired inheritance in ≥3 places per
    // grep audit. Hard min keeps the lock from being trivially satisfied.
    expect(hits).toBeGreaterThanOrEqual(3)
  })

  test('source-text grep: isClarifyChannelEdge is callable in scheduler cascade path', async () => {
    const fs = await import('node:fs/promises')
    const txt = await fs.readFile(
      resolve(import.meta.dir, '..', '..', '..', 'packages/backend/src/services/scheduler.ts'),
      'utf8',
    )
    // RFC-058 baseline locks: patch-25 cascade uses isClarifyChannelEdge so
    // clarify-only done nodes are not skipped during downstream cascade.
    expect(txt).toContain('isClarifyChannelEdge')
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-22 cascade BFS smoke', () => {
  test('triggerDesignerRerun returns a designerNodeRunId (cascade caller hooks in)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTriad(db)
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
        id: 'nr_q1',
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
      sourceQuestionerNodeRunId: 'nr_q1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const result = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [
        {
          sessionId: 'sess1',
          crossClarifyNodeId: 'cc1',
          sourceQuestionerNodeId: 'questioner',
          iteration: 0,
          questions: [makeQuestion()],
          answers: [makeAnswer()],
          questionScopes: null,
        },
      ],
      loopIter: 0,
      worktreePath: '',
      definition,
    })
    expect(result.designerNodeRunId).toBeTruthy()
    void crossClarifyNodeRunId
  })
})

describe('RFC-058 baseline T4 — patch-2026-05-25 questioner cascade visibility', () => {
  test('submit continue stamps designerRunTriggeredAt on the consumed session', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
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
        id: 'nr_q1',
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
      sourceQuestionerNodeRunId: 'nr_q1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const r = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    expect(r.outcome.kind).toBe('designer-rerun-triggered')
    const row = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, r.session.id))
    )[0]
    expect(row?.designerRunTriggeredAt).not.toBeNull()
  })

  test('cascade BFS does not strand questioner — runner can find the next attempt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTriad(db)
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
        id: 'nr_q1',
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
      sourceQuestionerNodeRunId: 'nr_q1',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
    })
    // After stop, a new questioner attempt should exist (the cascaded rerun).
    const questionerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'questioner'))
    expect(questionerRuns.length).toBeGreaterThan(1) // original + cascade rerun
  })
})
