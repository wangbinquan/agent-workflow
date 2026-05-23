// RFC-058 PR-A baseline (T5): byte-level lock of scheduler dispatch routing
// + GENERAL aging cutoff calculation. Scheduler is hard to isolate as a unit
// (it pulls in runner, broadcaster, lifecycle invariants), so this baseline
// exercises the dispatch invariants via:
//   1. Direct helper-function calls (buildClarifyPromptContext +
//      buildExternalFeedbackContext + buildQuestionerCrossClarifyContext)
//      mirroring the call signatures scheduler.ts uses today.
//   2. Source-text grep guards on scheduler.ts to ensure the dispatch
//      gates (clarifyMode='cross' + cci>0 → questioner path;
//      hasExternalFeedbackChannel + cci>0 → designer path) remain in place.
//
// PR-B will refactor scheduler.ts:1283-1455 inline cutoff + double dispatch
// into a single computeHistoryCutoff + buildPromptContext call. This baseline
// fails red when the routing semantics drift, even if the function names
// change.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildClarifyPromptContext,
  createClarifySession,
  submitClarifyAnswers,
} from '../src/services/clarify'
import {
  buildExternalFeedbackContext,
  buildQuestionerCrossClarifyContext,
  createCrossClarifySession,
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

async function seedSelfClarifyTask(
  db: DbClient,
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition: WorkflowDefinition = {
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
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'sched-baseline',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-sched-baseline/repo',
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
    title: 'Pick',
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
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

describe('RFC-058 baseline T5 — self-clarify dispatch path', () => {
  test('buildClarifyPromptContext returns a context with `### Round 1` when prior answered round exists', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedSelfClarifyTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_src',
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
      sourceAgentNodeRunId: 'nr_src',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion({ title: 'Self clarify Q' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    const ctx = await buildClarifyPromptContext({
      db,
      definition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
    })
    expect(ctx?.questionsBlock).toContain('### Round 1')
    expect(ctx?.questionsBlock).toContain('Self clarify Q')
  })
})

describe('RFC-058 baseline T5 — cross-clarify designer dispatch path', () => {
  test('buildExternalFeedbackContext returns block when cci>0 + sessions exist', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedSelfClarifyTask(db)
    // Augment fixture with cross-clarify wiring
    const ccDef: WorkflowDefinition = {
      ...definition,
      $schema_version: 4,
      nodes: [
        ...definition.nodes,
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
        { id: 'cc_x', kind: 'clarify-cross-agent', title: 'cc_x' } as WorkflowNode,
      ],
      edges: [
        ...definition.edges,
        {
          id: 'e_q_cc',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'cc_x', portName: 'questions' },
        },
        {
          id: 'e_cc_d',
          source: { nodeId: 'cc_x', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
    }
    await db
      .update(tasks)
      .set({ workflowSnapshot: JSON.stringify(ccDef) })
      .where(eq(tasks.id, taskId))

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
        id: 'nr_q',
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
      crossClarifyNodeId: 'cc_x',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion({ title: 'cross Q' })],
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
      definition: ccDef,
    })
    expect(ctx?.block).toContain('### From')
    expect(ctx?.block).toContain('cross Q')
  })
})

describe('RFC-058 baseline T5 — cross-clarify questioner dispatch path', () => {
  test('buildQuestionerCrossClarifyContext returns the questioner Q&A when cci>0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedSelfClarifyTask(db)
    const ccDef: WorkflowDefinition = {
      ...definition,
      $schema_version: 4,
      nodes: [
        ...definition.nodes,
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
        { id: 'cc_q', kind: 'clarify-cross-agent', title: 'cc_q' } as WorkflowNode,
      ],
      edges: [
        ...definition.edges,
        {
          id: 'e_q_cc',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'cc_q', portName: 'questions' },
        },
        {
          id: 'e_cc_d',
          source: { nodeId: 'cc_q', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
    }
    await db
      .update(tasks)
      .set({ workflowSnapshot: JSON.stringify(ccDef) })
      .where(eq(tasks.id, taskId))

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
        id: 'nr_q',
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
      crossClarifyNodeId: 'cc_q',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion({ title: 'cross Q for questioner' })],
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
    expect(ctx?.questionsBlock).toContain('cross Q for questioner')
  })
})

describe('RFC-058 baseline T5 — GENERAL aging cutoff signal (prior done + outputs)', () => {
  test('historyCutoffClarifyIteration uses prior done node_run with node_run_outputs row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedSelfClarifyTask(db)
    // Round 0 done + outputs (this is the cutoff signal)
    await db.insert(nodeRuns).values({
      id: 'nr_round0',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 1,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_round0',
      portName: 'plan',
      content: 'output',
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_round0',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQuestion({ title: 'pre-output round' })],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })
    // Mimic scheduler: prune rounds with iterationIndex < 1 (the prior done
    // run's clarifyIteration).
    const ctx = await buildClarifyPromptContext({
      db,
      definition,
      taskId,
      agentNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      historyCutoffClarifyIteration: 1,
    })
    // pre-output round has iterationIndex=0 < cutoff=1 → pruned
    expect(ctx).toBeUndefined()
  })
})

describe('RFC-058 baseline T5 — scheduler dispatch gate grep guards', () => {
  test('source grep: scheduler routes through buildPromptContext consumerKind dispatch when cci>0', async () => {
    const fs = await import('node:fs/promises')
    const txt = await fs.readFile(
      resolve(import.meta.dir, '..', '..', '..', 'packages/backend/src/services/scheduler.ts'),
      'utf8',
    )
    // RFC-058 T13: legacy buildQuestionerCrossClarifyContext call site replaced
    // by unified `buildPromptContext({ consumerKind: 'cross-questioner', ... })`.
    expect(txt).toContain('buildPromptContext')
    expect(txt).toContain("consumerKind: 'cross-questioner'")
    expect(txt).toContain('isQuestionerCrossClarifyRerun')
    expect(txt).toContain('hasExternalFeedbackChannel')
    expect(txt).toContain('historyCutoffClarifyIteration')
  })
})
