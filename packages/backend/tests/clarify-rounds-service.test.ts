// RFC-058 T12 — unit tests for the unified clarify_rounds service helpers.
// Exercises:
//   - computeHistoryCutoff for kind='self' + kind='cross' iterationField
//   - selectAnsweredRoundsForConsumer per consumerKind (self / cross-designer /
//     cross-questioner), including shardKey filter + loopIter isolation
//   - buildPromptContext multi-round / aging cutoff / inline mode / wrapper-
//     loop loop_iter isolation (RFC-056 缺口 2 structurally fixed)
//   - listClarifyRounds filter dispatch
//
// Notes for T12 stage:
//   - Tests seed clarify_rounds DIRECTLY (no legacy clarify_sessions write path)
//     because the new service module operates on the unified table. Once T17
//     drops the legacy tables + migrates all writers to clarify_rounds, the
//     PR-A baseline tests will exercise these helpers indirectly.

import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { afterAll, beforeEach, expect, test } from 'bun:test'

import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  getClarifyRoundDetail,
  listClarifyRoundSummaries,
  listClarifyRounds,
} from '../src/services/clarifyRounds'
import { NotFoundError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

async function seedTask(
  db: ProviderNeutralDatabase,
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
      { id: 'cc1', kind: 'clarify-cross-agent', title: 'CC1' } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rounds-test',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    id: taskId,
    name: 'rounds-test',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-rounds/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition }
}

function sampleQuestionsJson(title: string): string {
  return JSON.stringify([
    {
      id: 'q1',
      title,
      kind: 'single',
      recommended: false,
      options: [
        { label: 'A', description: '', recommended: false, recommendationReason: '' },
        { label: 'B', description: '', recommended: false, recommendationReason: '' },
      ],
    },
  ])
}

function sampleAnswersJson(): string {
  return JSON.stringify([
    {
      questionId: 'q1',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['A'],
      customText: '',
    },
  ])
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// RFC-070: `computeHistoryCutoff` is gone — the GENERAL aging rule is now
// row-state ("`consumed_by_..._run_id IS NULL`") rather than a numeric
// iteration cutoff. The semantic guarantees that block was locking
// (prior-done-with-outputs → drop older rounds) are now covered by
// `rfc070-aging-stamp-behavior.test.ts` B-group cases against the mark
// helper + the read-side `IS NULL` filter.

describeEachProvider('RFC-058 T12 — listClarifyRounds filter dispatch', (harness) => {
  test('kind=all returns both self + cross; kind filter narrows', async () => {
    const db = harness.db
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_q',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_cc',
        taskId,
        nodeId: 'cc1',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_self',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: sampleQuestionsJson('self Q'),
        status: 'awaiting_human',
      },
      {
        id: 'r_cross',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc',
        targetConsumerNodeId: 'designer',
        iteration: 0,
        questionsJson: sampleQuestionsJson('cross Q'),
        status: 'awaiting_human',
      },
    ])
    const all = await listClarifyRounds(db, { taskId, kind: 'all', status: 'awaiting_human' })
    expect(all.length).toBe(2)
    const selfOnly = await listClarifyRounds(db, { taskId, kind: 'self', status: 'awaiting_human' })
    expect(selfOnly.length).toBe(1)
    expect(selfOnly[0]?.kind).toBe('self')
    const crossOnly = await listClarifyRounds(db, {
      taskId,
      kind: 'cross',
      status: 'awaiting_human',
    })
    expect(crossOnly.length).toBe(1)
    expect(crossOnly[0]?.kind).toBe('cross')
  })

  test('limit caps the result set; default status=awaiting_human filters answered', async () => {
    const db = harness.db
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_a_open',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: sampleQuestionsJson('open Q'),
        status: 'awaiting_human',
      },
      {
        id: 'r_b_done',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 1,
        questionsJson: sampleQuestionsJson('done Q'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
    ])
    // Default status filter only surfaces awaiting_human
    const open = await listClarifyRounds(db, { taskId })
    expect(open.length).toBe(1)
    expect(open[0]?.status).toBe('awaiting_human')
    // Explicit limit cap
    const limited = await listClarifyRounds(db, { taskId, status: 'all', limit: 1 })
    expect(limited.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// RFC-058 T14 — REST projector helpers
// ---------------------------------------------------------------------------

async function seedNodeRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  id: string,
  nodeId: string,
): Promise<void> {
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
}

describeEachProvider('RFC-058 T14 — listClarifyRoundSummaries (REST projector)', (harness) => {
  test('projects clarify_rounds row to ClarifyRoundSummary with task name + node titles', async () => {
    const db = harness.db
    const { taskId } = await seedTask(db)
    await seedNodeRun(db, taskId, 'nr_d', 'designer')
    await seedNodeRun(db, taskId, 'nr_c', 'clarify1')
    await db.insert(clarifyRounds).values({
      id: 'r1',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_d',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_c',
      targetConsumerNodeId: null,
      loopIter: 0,
      iteration: 0,
      questionsJson: sampleQuestionsJson('S1'),
      answersJson: null,
      directive: null,
      status: 'awaiting_human',
      truncationWarningsJson: null,
      designerRunTriggeredAt: null,
      abandonedAt: null,
      createdAt: 1000,
      answeredAt: null,
      answeredBy: null,
    })
    const out = await listClarifyRoundSummaries(db, { taskId })
    expect(out.length).toBe(1)
    expect(out[0]).toMatchObject({
      id: 'r1',
      taskId,
      taskName: 'rounds-test',
      kind: 'self',
      askingNodeId: 'designer',
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_c',
      intermediaryNodeTitle: 'Clarify',
      loopIter: 0,
      iteration: 0,
      questionCount: 1,
      status: 'awaiting_human',
      directive: null,
    })
  })

  test('filters by status and limits result count', async () => {
    const db = harness.db
    const { taskId } = await seedTask(db)
    await seedNodeRun(db, taskId, 'nr_d', 'designer')
    await seedNodeRun(db, taskId, 'nr_c1', 'clarify1')
    await seedNodeRun(db, taskId, 'nr_c2', 'clarify1')
    await db.insert(clarifyRounds).values([
      {
        id: 'r_open',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c1',
        iteration: 0,
        questionsJson: sampleQuestionsJson('Q open'),
        status: 'awaiting_human',
        createdAt: 1000,
      },
      {
        id: 'r_done',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c2',
        iteration: 1,
        questionsJson: sampleQuestionsJson('Q done'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
        createdAt: 2000,
      },
    ])
    const onlyOpen = await listClarifyRoundSummaries(db, { taskId })
    expect(onlyOpen.length).toBe(1)
    expect(onlyOpen[0]?.status).toBe('awaiting_human')
    const all = await listClarifyRoundSummaries(db, { taskId, status: 'all' })
    expect(all.length).toBe(2)
    const limited = await listClarifyRoundSummaries(db, { taskId, status: 'all', limit: 1 })
    expect(limited.length).toBe(1)
  })

  test('filters by kind (self / cross / all)', async () => {
    const db = harness.db
    const { taskId } = await seedTask(db)
    await seedNodeRun(db, taskId, 'nr_d', 'designer')
    await seedNodeRun(db, taskId, 'nr_q', 'questioner')
    await seedNodeRun(db, taskId, 'nr_c1', 'clarify1')
    await seedNodeRun(db, taskId, 'nr_cc1', 'cc1')
    await db.insert(clarifyRounds).values([
      {
        id: 'r_self',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c1',
        iteration: 0,
        questionsJson: sampleQuestionsJson('self Q'),
        status: 'awaiting_human',
        createdAt: 1000,
      },
      {
        id: 'r_cross',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc1',
        targetConsumerNodeId: 'designer',
        iteration: 0,
        questionsJson: sampleQuestionsJson('cross Q'),
        status: 'awaiting_human',
        createdAt: 2000,
      },
    ])
    const justSelf = await listClarifyRoundSummaries(db, { taskId, kind: 'self' })
    expect(justSelf.map((r) => r.id)).toEqual(['r_self'])
    const justCross = await listClarifyRoundSummaries(db, { taskId, kind: 'cross' })
    expect(justCross.map((r) => r.id)).toEqual(['r_cross'])
    // 'all' returns both, sorted by createdAt desc (cross first since newer)
    const both = await listClarifyRoundSummaries(db, { taskId, kind: 'all' })
    expect(both.map((r) => r.id)).toEqual(['r_cross', 'r_self'])
  })
})

describeEachProvider('RFC-058 T14 — getClarifyRoundDetail (REST projector)', (harness) => {
  test('projects clarify_rounds row to ClarifyRound with questions parsed', async () => {
    const db = harness.db
    const { taskId } = await seedTask(db)
    await seedNodeRun(db, taskId, 'nr_d', 'designer')
    await seedNodeRun(db, taskId, 'nr_c', 'clarify1')
    await db.insert(clarifyRounds).values({
      id: 'r1',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_d',
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_c',
      iteration: 0,
      questionsJson: sampleQuestionsJson('Detail Q'),
      answersJson: null,
      status: 'awaiting_human',
      createdAt: 1000,
    })
    const detail = await getClarifyRoundDetail(db, 'nr_c')
    expect(detail.id).toBe('r1')
    expect(detail.kind).toBe('self')
    expect(detail.intermediaryNodeId).toBe('clarify1')
    expect(detail.intermediaryNodeTitle).toBe('Clarify')
    expect(detail.questions.length).toBe(1)
    expect(detail.questions[0]?.title).toBe('Detail Q')
    expect(detail.answers).toBeUndefined()
    expect(detail.status).toBe('awaiting_human')
  })

  test('parses answersJson when present', async () => {
    const db = harness.db
    const { taskId } = await seedTask(db)
    await seedNodeRun(db, taskId, 'nr_d', 'designer')
    await seedNodeRun(db, taskId, 'nr_c', 'clarify1')
    await db.insert(clarifyRounds).values({
      id: 'r_ans',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_d',
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_c',
      iteration: 0,
      questionsJson: sampleQuestionsJson('Q'),
      answersJson: sampleAnswersJson(),
      directive: 'continue',
      status: 'answered',
      createdAt: 1000,
      answeredAt: 2000,
    })
    const detail = await getClarifyRoundDetail(db, 'nr_c')
    expect(detail.answers).toBeDefined()
    expect(detail.answers?.length).toBe(1)
    expect(detail.directive).toBe('continue')
    expect(detail.answeredAt).toBe(2000)
  })

  test('throws NotFoundError when intermediary node_run id has no row', async () => {
    const db = harness.db
    await seedTask(db)
    await expect(getClarifyRoundDetail(db, 'does-not-exist')).rejects.toThrow(NotFoundError)
  })
})
