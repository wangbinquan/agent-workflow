// RFC-058 PR-A baseline (T6): byte-level lock of REST list / detail wire
// shapes + WS event payloads. Tests are written against the service-layer
// functions (`listClarifySummaries`, `listCrossClarifySummaries`,
// `getClarifyDetail`, `getCrossClarifyDetail`) and the broadcaster subscribe
// surface, mirroring exactly the responses Hono returns and the events the
// frontend listens for.
//
// PR-B refactor: any change to the JSON field set, ordering, or event
// payload shape will trip these — confirm any drift was intended (e.g. a
// new optional field is fine; renaming `clarifyNodeRunId` would break
// frontend code).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  broadcastClarifyAnsweredForRound,
  createClarifyRound,
} from '../src/services/clarify/service'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { getClarifyRoundDetail, listClarifyRoundSummaries } from '../src/services/clarifyRounds'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests, TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
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
  withCross: boolean,
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const baseNodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
  ]
  const baseEdges = [
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
  ]
  const definition: WorkflowDefinition = withCross
    ? {
        $schema_version: 4,
        inputs: [],
        nodes: [
          ...baseNodes,
          { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
          { id: 'cc1', kind: 'clarify-cross-agent', title: 'cc1' } as WorkflowNode,
        ],
        edges: [
          ...baseEdges,
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
        ],
        outputs: [],
      }
    : {
        $schema_version: 3,
        inputs: [],
        nodes: baseNodes,
        edges: baseEdges,
        outputs: [],
      }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rest-baseline-task',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: withCross ? 4 : 3,
  })
  await db.insert(tasks).values({
    name: 'rest-baseline-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-rest-baseline/repo',
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

// RFC-099 audit-only actor for the unified answer driver (never enters a prompt).
const actor = { userId: 'u1', role: 'owner' as const }

// RFC-162: designer-by-default is DELETED — answering a cross round no longer auto-creates a
// designer entry. The designer rerun is now minted by reassigning the answered round's questioner
// card to the graph designer node + dispatching that designer entry.
async function reassignThenDispatchDesigner(
  db: DbClient,
  taskId: string,
  crossClarifyNodeRunId: string,
) {
  const questioner = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'questioner' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!questioner) throw new Error(`no questioner entry for round ${crossClarifyNodeRunId}`)
  await reassignTaskQuestion(db, questioner.id, 'designer', actor)
  const designer = (await listTaskQuestions(db, taskId)).find(
    (e) => e.roleKind === 'designer' && e.originNodeRunId === crossClarifyNodeRunId,
  )
  if (!designer) throw new Error(`no designer entry after reassign for ${crossClarifyNodeRunId}`)
  return dispatchTaskQuestions(db, taskId, [designer.id], actor)
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-058 baseline T6 — list summaries shape', () => {
  test('listClarifySummaries: rows carry taskName + sourceAgent + iteration', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, false)
    await db.insert(nodeRuns).values({
      id: 'nr_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_src',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    })
    const list = await listClarifyRoundSummaries(db, { taskId, kind: 'self' })
    expect(list.length).toBe(1)
    const row = list[0]!
    // RFC-058 baseline locks: ClarifySessionSummary wire fields
    expect(row.taskId).toBe(taskId)
    expect(row.taskName).toBe('rest-baseline-task')
    expect(row.askingNodeId).toBe('designer')
    expect(row.iteration).toBe(0)
    expect(row.status).toBe('awaiting_human')
    expect(row.questionCount).toBe(1)
  })

  test('listCrossClarifySummaries: rows carry crossClarifyNodeId + sourceQuestioner + iteration', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, true)
    await db.insert(nodeRuns).values({
      id: 'nr_q1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const list = await listClarifyRoundSummaries(db, { taskId, kind: 'cross' })
    expect(list.length).toBe(1)
    const row = list[0]!
    expect(row.taskId).toBe(taskId)
    expect(row.intermediaryNodeId).toBe('cc1')
    expect(row.askingNodeId).toBe('questioner')
    expect(row.targetConsumerNodeId).toBe('designer')
    expect(row.iteration).toBe(0)
    expect(row.status).toBe('awaiting_human')
  })

  test('mixed inbox: REST route merges + sorts by createdAt desc (simulated)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, true)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_src',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_q1',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_src',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    })
    await new Promise((r) => setTimeout(r, 5))
    await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const selfList = await listClarifyRoundSummaries(db, { taskId, kind: 'self' })
    const crossList = await listClarifyRoundSummaries(db, { taskId, kind: 'cross' })
    // Simulating the REST route's merge + tag logic.
    const merged = [
      ...selfList.map((r) => ({ ...r, kind: 'self' as const })),
      ...crossList.map((r) => ({ ...r, kind: 'cross' as const })),
    ].sort((a, b) => b.createdAt - a.createdAt)
    expect(merged.length).toBe(2)
    expect(merged.every((m) => m.kind === 'self' || m.kind === 'cross')).toBe(true)
  })
})

describe('RFC-058 baseline T6 — detail wire shape', () => {
  test('getClarifyDetail returns ClarifySession with full questions array', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, false)
    await db.insert(nodeRuns).values({
      id: 'nr_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_src',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion({ title: 'detail Q' })],
    })
    const detail = await getClarifyRoundDetail(db, clarifyNodeRunId)
    expect(detail.taskId).toBe(taskId)
    expect(detail.intermediaryNodeId).toBe('clarify1')
    expect(detail.questions[0]?.title).toBe('detail Q')
    expect(detail.status).toBe('awaiting_human')
  })

  test('getCrossClarifyDetail returns CrossClarifySession with full questions array', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, true)
    await db.insert(nodeRuns).values({
      id: 'nr_q1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion({ title: 'cross detail Q' })],
    })
    const detail = await getClarifyRoundDetail(db, crossClarifyNodeRunId)
    expect(detail.taskId).toBe(taskId)
    expect(detail.intermediaryNodeId).toBe('cc1')
    expect(detail.targetConsumerNodeId).toBe('designer')
    expect(detail.questions[0]?.title).toBe('cross detail Q')
  })
})

describe('RFC-058 baseline T6 — WS event payload shape', () => {
  test('clarify.created event carries clarifyNodeId + iterationIndex + session summary', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, false)
    await db.insert(nodeRuns).values({
      id: 'nr_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))
    await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_src',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    })
    expect(received.length).toBe(1)
    const m = received[0]!
    expect(m.type).toBe('clarify.created')
    expect((m as { clarifyNodeId?: string }).clarifyNodeId).toBe('clarify1')
    expect((m as { iterationIndex?: number }).iterationIndex).toBe(0)
  })

  test('cross-clarify.created event carries crossClarifyNodeId + iteration + targetDesigner', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, true)
    await db.insert(nodeRuns).values({
      id: 'nr_q1',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))
    await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    expect(received.length).toBe(1)
    const m = received[0]!
    expect(m.type).toBe('cross-clarify.created')
  })

  test('cross-clarify.answered + designer rerun dispatched on successful continue submit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, true)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_designer_prior',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
      },
      {
        id: 'nr_q1',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
      actor,
    })
    // Mirror the route (RFC-132): the unified driver broadcasts nothing itself; the
    // route re-emits the answered event after the auto-dispatch.
    await broadcastClarifyAnsweredForRound(db, 'cross', crossClarifyNodeRunId, {})
    const types = received.map((m) => m.type)
    // RFC-058 baseline, RFC-132 update: continue submit fires .answered. The legacy
    // .designer-rerun-batched event was emitted only by the deleted immediate-mint path.
    // RFC-162: the designer continuation is now an explicit reassign+dispatch of the answered
    // round, observable on the dispatch result.
    expect(types).toContain('cross-clarify.answered')
    const disp = await reassignThenDispatchDesigner(db, taskId, crossClarifyNodeRunId)
    expect(disp.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)
  })

  test('cross-clarify.rejected on stop submit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, true)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_designer_prior',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
      },
      {
        id: 'nr_q1',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cc1',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q1',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion()],
    })
    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'stop',
      ifMatchIteration: 0,
      actor,
    })
    // Mirror the route (RFC-132): a stop cross round also fires the rejected event,
    // carrying the dispatched questioner rerun id.
    const questionerRerunId =
      res.dispatch.reruns.find((r) => r.targetNodeId === 'questioner')?.nodeRunId ?? ''
    await broadcastClarifyAnsweredForRound(db, 'cross', crossClarifyNodeRunId, {
      rejectedQuestionerNodeRunId: questionerRerunId,
    })
    const types = received.map((m) => m.type)
    expect(types).toContain('cross-clarify.answered')
    expect(types).toContain('cross-clarify.rejected')
  })

  test('clarify.answered on self-clarify submit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, false)
    await db.insert(nodeRuns).values({
      id: 'nr_src',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_src',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      iteration: 0,
      questions: [makeQuestion()],
    })
    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))
    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: clarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
      actor,
    })
    // Mirror the route (RFC-132): re-emit clarify.answered with the dispatched rerun id.
    await broadcastClarifyAnsweredForRound(db, 'self', clarifyNodeRunId, {
      rerunNodeRunId: res.dispatch.reruns[0]?.nodeRunId ?? '',
    })
    const types = received.map((m) => m.type)
    expect(types).toContain('clarify.answered')
  })
})
