// RFC-359 W9 —— `CollaborationCommittedEventProjection` 的双引擎对拍。
//
// **为什么存在**：这一对适配器是「同一件事两份实现」的教科书形态——
// `collaborationCommittedEventWsProjector.ts` 里的 `createSqliteCollaborationCommittedEventProjection`
// （bun:sqlite 同步 `.get()` / `.all()`）与 `postgresqlCollaborationCommittedEventProjection.ts`
// （273 行把同一批语义用异步 drizzle 重写了一遍）。两份都实现同一个端口，
// `cli/start.ts` 按 provider 二选一装配（PG 在 :699，SQLite 在 :2606）。
// 而这份 PG 重写**从未在真数据库上跑过**：写下本文件之前它唯一的用例
// （`rfc349-collaboration-runtime-mechanics.test.ts`）只对源码文本做断言。
//
// **它投影的是什么（用户可见契约）**：人审门打开 / 澄清决定提交之后，浏览器在
// `/ws/tasks/:id` 上收到的那一帧。投错 = 评审页不弹出待审文档、澄清面板不刷新、
// 「谁被重跑了」指向错的 node_run。判据因此写在帧上，不写在 SQL 上。
//
// **两处 NULL 排序陷阱**是本文件的重点（`platform/persistence/postgresqlNullOrdering.ts`
// 实测：SQLite 把 NULL 当最小、PostgreSQL 当最大，两个默认正好相反）：
//   · 评审门打开时挑「哪一份待审文档」用 `item_index ASC`——`item_index IS NULL` 是
//     RFC-079 的单文档判别位，SQLite 上它排最前；PG 默认会排到最后，于是**弹出的是另一份文档**；
//   · 澄清决定回落到读模型时挑「最近一次下发」用 `dispatched_at DESC`——未下发行是 NULL，
//     SQLite 上排最后，PG 默认排最前，于是 `rerunNodeRunId` **指向一个还没下发的条目的重跑**。
// 两条都只在真库上才分得出来，纸面读代码看不出，所以先补对拍再谈合一。

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { monotonicFactory } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  committedEvents,
  docVersions,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '@/db/schema'
import type { CollaborationCommittedEventProjection } from '@/modules/collaboration/application/ports/collaborationCommittedEventProjection'
import { createCollaborationCommittedEventProjection } from '@/modules/collaboration/infrastructure/collaborationCommittedEventWsProjector'
import type {
  CollaborationCommittedV1,
  CollaborationGateRefV1,
  CollaborationProjectionFrame,
} from '@/modules/collaboration/domain/collaborationCommittedEvent'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const ulid = monotonicFactory()

const ASKER = 'asker'
const DESIGNER = 'designer'
const CROSS = 'cc'
const CLARIFY = 'cl'
const REVIEW = 'rv'
const WRITER = 'writer'

/** 完整形状的澄清问题 / 回答 —— 投影只做 `JSON.parse`，帧里原样带出去。 */
function question(id: string): ClarifyQuestion {
  return {
    id,
    title: `${id}-title`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function answer(questionId: string): ClarifyAnswer {
  return {
    questionId,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

let APP_HOME = ''

beforeAll(() => {
  APP_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc359-w9-proj-'))
})

afterAll(() => {
  if (APP_HOME !== '') rmSync(APP_HOME, { recursive: true, force: true })
})

/** 生产装配的唯一工厂：两个 daemon 都走它（`cli/start.ts:698` / `:2605`）。 */
function projectionFor(harness: ProviderHarness): CollaborationCommittedEventProjection {
  return createCollaborationCommittedEventProjection(harness.db)
}

function definition(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker', title: '提问者' } as WorkflowNode,
    {
      id: DESIGNER,
      kind: 'agent-single',
      agentName: 'agent-designer',
      title: '设计者',
    } as WorkflowNode,
    { id: WRITER, kind: 'agent-single', agentName: 'agent-writer' } as WorkflowNode,
    { id: CROSS, kind: 'clarify-cross-agent', title: '跨代理澄清' } as WorkflowNode,
    { id: CLARIFY, kind: 'clarify', title: '澄清' } as WorkflowNode,
    { id: REVIEW, kind: 'review', title: 'Design Review' } as unknown as WorkflowNode,
  ]
  return {
    $schema_version: 6,
    inputs: [],
    nodes,
    edges: [],
    outputs: [],
  } as unknown as WorkflowDefinition
}

async function seedTask(
  db: ProviderNeutralDatabase,
  name = 'rfc359 w9 projection',
): Promise<string> {
  const taskId = `t_${ulid()}`
  const snapshot = JSON.stringify(definition())
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: `rfc359-w9-${taskId}`,
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 6,
  })
  await db.insert(tasks).values({
    id: taskId,
    name,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    repoPath: '/tmp/aw-rfc359-w9-proj',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    executionLineageId: taskId,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
  return taskId
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeId: string,
): Promise<string> {
  const id = `nr_${ulid()}`
  await db
    .insert(nodeRuns)
    .values({ id, taskId, nodeId, status: 'done', retryIndex: 0, iteration: 0 })
  return id
}

async function seedDocVersion(
  db: ProviderNeutralDatabase,
  input: {
    taskId: string
    reviewNodeRunId: string
    versionIndex: number
    itemIndex: number | null
    decision?: 'pending' | 'approved'
  },
): Promise<string> {
  const id = `dv_${ulid()}`
  const bodyPath = join('reviews', `${id}.md`)
  const absolute = join(APP_HOME, bodyPath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `# ${id}\n`)
  await db.insert(docVersions).values({
    id,
    taskId: input.taskId,
    reviewNodeId: REVIEW,
    reviewNodeRunId: input.reviewNodeRunId,
    sourceNodeId: WRITER,
    sourcePortName: 'out',
    versionIndex: input.versionIndex,
    reviewIteration: 0,
    bodyPath,
    commentsJson: '[]',
    decision: input.decision ?? 'pending',
    itemIndex: input.itemIndex,
    createdAt: Date.now(),
  })
  return id
}

interface RoundInput {
  taskId: string
  kind: 'self' | 'cross'
  askingNodeRunId: string
  intermediaryNodeRunId: string
  status?: 'awaiting_human' | 'answered' | 'canceled'
  directive?: 'continue' | 'stop' | null
  askingShardKey?: string | null
  questionsJson?: string
  answersJson?: string | null
  truncationWarningsJson?: string | null
}

async function seedRound(db: ProviderNeutralDatabase, input: RoundInput): Promise<string> {
  const id = `cr_${ulid()}`
  await db.insert(clarifyRounds).values({
    id,
    taskId: input.taskId,
    kind: input.kind,
    askingNodeId: ASKER,
    askingNodeRunId: input.askingNodeRunId,
    askingShardKey: input.askingShardKey ?? null,
    intermediaryNodeId: input.kind === 'cross' ? CROSS : CLARIFY,
    intermediaryNodeRunId: input.intermediaryNodeRunId,
    targetConsumerNodeId: input.kind === 'cross' ? DESIGNER : null,
    iteration: 3,
    questionsJson: input.questionsJson ?? '[]',
    answersJson: input.answersJson ?? null,
    directive: input.directive ?? null,
    status: input.status ?? 'awaiting_human',
    truncationWarningsJson: input.truncationWarningsJson ?? null,
    createdAt: 1_000,
    answeredAt: input.status === 'answered' ? 2_000 : null,
    answeredBy: input.status === 'answered' ? 'u-answerer' : null,
  })
  return id
}

async function seedQuestionEntry(
  db: ProviderNeutralDatabase,
  input: {
    taskId: string
    originNodeRunId: string
    triggerRunId: string | null
    dispatchedAt: number | null
    updatedAt: number
  },
): Promise<string> {
  const id = `tq_${ulid()}`
  await db.insert(taskQuestions).values({
    id,
    taskId: input.taskId,
    originNodeRunId: input.originNodeRunId,
    questionId: `q_${id}`,
    questionTitle: 'q-title',
    sourceKind: 'self',
    roleKind: 'self',
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: ASKER,
    triggerRunId: input.triggerRunId,
    dispatchedAt: input.dispatchedAt,
    createdAt: 1_000,
    updatedAt: input.updatedAt,
  })
  return id
}

function gateRef(input: {
  taskId: string
  nodeRunId: string
  gateKind: CollaborationGateRefV1['gateKind']
  gateId: string
  roundId?: string | null
}): CollaborationGateRefV1 {
  return {
    taskId: input.taskId,
    nodeRunId: input.nodeRunId,
    gateKind: input.gateKind,
    gateId: input.gateId,
    roundId: input.roundId ?? null,
  }
}

function openedEvent(input: {
  gate: CollaborationGateRefV1
  family: 'review' | 'clarify'
  frames?: readonly CollaborationProjectionFrame[]
}): CollaborationCommittedV1 {
  return {
    eventId: `ce_${ulid()}`,
    eventGroupId: `eg_${ulid()}`,
    eventGroupOrdinal: 0,
    type: 'collaboration.human-gate-opened.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: input.family,
    aggregate: {
      kind: input.family === 'review' ? 'review-round' : 'clarify-round',
      id: input.gate.roundId ?? input.gate.gateId,
      seq: 1,
    },
    operationRef: `op_${ulid()}`,
    correlationRef: null,
    causationRef: null,
    occurredAt: new Date(5_000).toISOString(),
    payload: {
      gate: input.gate,
      gateStatus: 'open',
      projectionFrames: input.frames ?? [],
    },
  }
}

function decisionEvent(input: {
  gate: CollaborationGateRefV1
  family: 'review' | 'clarify'
  gateStatus?: 'committed' | 'deferred' | 'closed'
  occurredAtMs?: number
  frames?: readonly CollaborationProjectionFrame[]
}): CollaborationCommittedV1 {
  return {
    eventId: `ce_${ulid()}`,
    eventGroupId: `eg_${ulid()}`,
    eventGroupOrdinal: 1,
    type: 'collaboration.human-gate-decision-committed.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: input.family,
    aggregate: {
      kind: input.family === 'review' ? 'review-round' : 'clarify-round',
      id: input.gate.roundId ?? input.gate.gateId,
      seq: 2,
    },
    operationRef: `op_${ulid()}`,
    correlationRef: null,
    causationRef: null,
    occurredAt: new Date(input.occurredAtMs ?? 5_000).toISOString(),
    payload: {
      gate: input.gate,
      decision:
        input.family === 'review'
          ? { gateKind: 'review', kind: 'approved' }
          : { gateKind: 'clarify', kind: 'continue' },
      gateStatus: input.gateStatus ?? 'committed',
      continuationRef: null,
      distillSourceEventId: null,
      projectionFrames: input.frames ?? [],
    },
  }
}

/** 落一条 `question-dispatch-committed.v1` 到 committed_events（投影按 entryIds 反查重跑目标）。 */
async function seedDispatchCommittedEvent(
  db: ProviderNeutralDatabase,
  input: {
    taskId: string
    gateNodeRunId: string
    occurredAt: number
    aggregateSeq: number
    questionIds: readonly string[]
    reruns: readonly { nodeRunId: string; nodeId: string; entryIds: readonly string[] }[]
  },
): Promise<void> {
  const gate = gateRef({
    taskId: input.taskId,
    nodeRunId: input.gateNodeRunId,
    gateKind: 'questions',
    gateId: `questions:${input.taskId}`,
  })
  const payload = {
    eventId: `ce_${ulid()}`,
    eventGroupId: `eg_${ulid()}`,
    eventGroupOrdinal: 0,
    type: 'collaboration.question-dispatch-committed.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: 'questions',
    aggregate: { kind: 'question-gate', id: gate.gateId, seq: input.aggregateSeq },
    operationRef: `op_${ulid()}`,
    correlationRef: null,
    causationRef: null,
    occurredAt: new Date(input.occurredAt).toISOString(),
    payload: {
      gate,
      questionIds: [...input.questionIds],
      dispatchMode: 'immediate',
      reruns: input.reruns.map((rerun) => ({ ...rerun, entryIds: [...rerun.entryIds] })),
      projectionFrames: [],
    },
  }
  const payloadJson = JSON.stringify(payload)
  await db.insert(committedEvents).values({
    id: payload.eventId,
    eventGroupId: payload.eventGroupId,
    eventGroupOrdinal: 0,
    producer: 'collaboration',
    family: 'questions',
    eventType: 'collaboration.question-dispatch-committed.v1',
    schemaVersion: 1,
    aggregateKind: 'question-gate',
    aggregateId: gate.gateId,
    aggregateSeq: input.aggregateSeq,
    operationRef: payload.operationRef,
    correlationRef: null,
    causationRef: null,
    occurredAt: input.occurredAt,
    payloadJson,
    payloadDigest: `canonical-hex-v1:${Buffer.from(payloadJson, 'utf8').toString('hex')}`,
    deliveryMode: 'dispatchable',
    producerEpoch: 1,
    createdAt: input.occurredAt,
  })
}

describeEachProvider('RFC-359 W9 —— 协作已提交事件投影（WS 帧）', (harness) => {
  // ---------------------------------------------------------------------------
  // 短路：事件自带帧就原样返回（不读库）
  // ---------------------------------------------------------------------------

  test('事件自带 projectionFrames 时原样返回，不去读读模型', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, REVIEW)
    const carried: CollaborationProjectionFrame = {
      id: -1,
      type: 'review.created',
      nodeRunId: runId,
      reviewNodeId: REVIEW,
      docVersionId: 'dv-carried',
      versionIndex: 9,
      reviewIteration: 4,
    }
    // 库里那份和自带帧**不一样**：拿到自带的那份才证明短路真的发生了。
    await seedDocVersion(db, {
      taskId,
      reviewNodeRunId: runId,
      versionIndex: 1,
      itemIndex: null,
    })
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({ taskId, nodeRunId: runId, gateKind: 'review', gateId: `review:${runId}` }),
        family: 'review',
        frames: [carried],
      }),
    )
    expect(frames).toEqual([carried])
  })

  // ---------------------------------------------------------------------------
  // 评审门打开 —— review.created
  // ---------------------------------------------------------------------------

  test('评审门打开 —— 投出待审文档的 review.created 帧', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, REVIEW)
    const docId = await seedDocVersion(db, {
      taskId,
      reviewNodeRunId: runId,
      versionIndex: 2,
      itemIndex: null,
    })
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({ taskId, nodeRunId: runId, gateKind: 'review', gateId: `review:${runId}` }),
        family: 'review',
      }),
    )
    expect(frames).toEqual([
      {
        id: -1,
        type: 'review.created',
        nodeRunId: runId,
        reviewNodeId: REVIEW,
        docVersionId: docId,
        versionIndex: 2,
        reviewIteration: 0,
      },
    ])
  })

  test('评审门打开 —— item_index 为 NULL 的那份排最前（SQLite 的 NULLS FIRST 语义）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, REVIEW)
    // 先落 item_index = 0 的那份，再落 NULL 的那份：插入顺序与期望顺序相反，
    // 于是「按插入顺序返回」的实现也过不了这条。
    await seedDocVersion(db, { taskId, reviewNodeRunId: runId, versionIndex: 1, itemIndex: 0 })
    const nullItemDoc = await seedDocVersion(db, {
      taskId,
      reviewNodeRunId: runId,
      versionIndex: 1,
      itemIndex: null,
    })
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({ taskId, nodeRunId: runId, gateKind: 'review', gateId: `review:${runId}` }),
        family: 'review',
      }),
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'review.created', docVersionId: nullItemDoc })
  })

  test('评审门打开 —— 同 item_index 内按 version_index 升序取第一份', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, REVIEW)
    await seedDocVersion(db, { taskId, reviewNodeRunId: runId, versionIndex: 5, itemIndex: 1 })
    const first = await seedDocVersion(db, {
      taskId,
      reviewNodeRunId: runId,
      versionIndex: 2,
      itemIndex: 1,
    })
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({ taskId, nodeRunId: runId, gateKind: 'review', gateId: `review:${runId}` }),
        family: 'review',
      }),
    )
    expect(frames[0]).toMatchObject({ docVersionId: first, versionIndex: 2 })
  })

  test('评审门打开 —— 只有非 pending 文档时不投任何帧', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, REVIEW)
    await seedDocVersion(db, {
      taskId,
      reviewNodeRunId: runId,
      versionIndex: 1,
      itemIndex: null,
      decision: 'approved',
    })
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({ taskId, nodeRunId: runId, gateKind: 'review', gateId: `review:${runId}` }),
        family: 'review',
      }),
    )
    expect(frames).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // 澄清门打开 —— clarify.created / cross-clarify.created
  // ---------------------------------------------------------------------------

  test('自澄清门打开 —— clarify.created 带会话摘要（节点标题从工作流快照取）', async () => {
    const db = harness.db
    const taskId = await seedTask(db, '带标题的任务')
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'self',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: parkRun,
      askingShardKey: 'shard-a',
      questionsJson: JSON.stringify([question('q1'), question('q2')]),
    })
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: `clarify:${parkRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames).toEqual([
      {
        id: -1,
        type: 'clarify.created',
        nodeRunId: parkRun,
        clarifyNodeId: CLARIFY,
        sourceShardKey: 'shard-a',
        iterationIndex: 3,
        session: {
          id: roundId,
          taskId,
          taskName: '带标题的任务',
          sourceAgentNodeId: ASKER,
          sourceAgentNodeTitle: '提问者',
          sourceShardKey: 'shard-a',
          clarifyNodeId: CLARIFY,
          clarifyNodeTitle: '澄清',
          clarifyNodeRunId: parkRun,
          iterationIndex: 3,
          questionCount: 2,
          status: 'awaiting_human',
          createdAt: 1_000,
          answeredAt: null,
        },
      },
    ])
  })

  test('跨代理澄清门打开 —— cross-clarify.created 带提问者 / 设计者节点', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const crossRun = await seedRun(db, taskId, CROSS)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'cross',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: crossRun,
    })
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({
          taskId,
          nodeRunId: crossRun,
          gateKind: 'clarify',
          gateId: `clarify:${crossRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames).toEqual([
      {
        id: -1,
        type: 'cross-clarify.created',
        nodeRunId: crossRun,
        crossClarifyNodeId: CROSS,
        sessionId: roundId,
        iteration: 3,
        sourceQuestionerNodeId: ASKER,
        targetDesignerNodeId: DESIGNER,
      },
    ])
  })

  test('澄清门打开 —— 轮次行不存在时不投帧', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const frames = await projectionFor(harness).frames(
      openedEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: 'cr_missing',
        }),
        family: 'clarify',
      }),
    )
    expect(frames).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // 澄清决定提交 —— clarify.answered / cross-clarify.answered / rejected
  // ---------------------------------------------------------------------------

  test('自澄清决定提交 —— clarify.answered 的 rerunNodeRunId 取自已提交下发事件的 entryIds 反查', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const rerunRun = await seedRun(db, taskId, ASKER)
    const staleRun = await seedRun(db, taskId, ASKER)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'self',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: parkRun,
      status: 'answered',
      questionsJson: JSON.stringify([question('q1')]),
      answersJson: JSON.stringify([answer('q1')]),
      truncationWarningsJson: JSON.stringify([{ code: 'truncated', detail: 'd' }]),
    })
    const entryId = await seedQuestionEntry(db, {
      taskId,
      originNodeRunId: parkRun,
      // 读模型里那条指向 staleRun：已提交事件必须**赢过**它。
      triggerRunId: staleRun,
      dispatchedAt: 4_000,
      updatedAt: 4_000,
    })
    await seedDispatchCommittedEvent(db, {
      taskId,
      gateNodeRunId: parkRun,
      occurredAt: 6_000,
      aggregateSeq: 1,
      questionIds: [entryId],
      reruns: [{ nodeRunId: rerunRun, nodeId: ASKER, entryIds: [entryId] }],
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: `clarify:${parkRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames).toEqual([
      {
        id: -1,
        type: 'clarify.answered',
        nodeRunId: parkRun,
        clarifyNodeId: CLARIFY,
        sourceShardKey: null,
        iterationIndex: 3,
        rerunNodeRunId: rerunRun,
        session: {
          id: roundId,
          taskId,
          sourceAgentNodeId: ASKER,
          sourceAgentNodeRunId: askingRun,
          sourceShardKey: null,
          clarifyNodeId: CLARIFY,
          clarifyNodeRunId: parkRun,
          iterationIndex: 3,
          questions: [question('q1')],
          answers: [answer('q1')],
          truncationWarnings: [{ code: 'truncated', detail: 'd' }],
          status: 'answered',
          createdAt: 1_000,
          answeredAt: 2_000,
          answeredBy: 'u-answerer',
          directive: null,
        },
      },
    ])
  })

  test('自澄清决定提交 —— 没有已提交下发事件时回落到读模型里最近一次下发的 triggerRunId', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const older = await seedRun(db, taskId, ASKER)
    const newest = await seedRun(db, taskId, ASKER)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'self',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: parkRun,
      status: 'answered',
    })
    await seedQuestionEntry(db, {
      taskId,
      originNodeRunId: parkRun,
      triggerRunId: older,
      dispatchedAt: 3_000,
      updatedAt: 3_000,
    })
    await seedQuestionEntry(db, {
      taskId,
      originNodeRunId: parkRun,
      triggerRunId: newest,
      dispatchedAt: 4_000,
      updatedAt: 4_000,
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: `clarify:${parkRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames[0]).toMatchObject({ type: 'clarify.answered', rerunNodeRunId: newest })
  })

  test('自澄清决定提交 —— 未下发（dispatched_at IS NULL）的条目排最后，不许抢走 rerunNodeRunId', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const dispatched = await seedRun(db, taskId, ASKER)
    const notDispatched = await seedRun(db, taskId, ASKER)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'self',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: parkRun,
      status: 'answered',
    })
    await seedQuestionEntry(db, {
      taskId,
      originNodeRunId: parkRun,
      triggerRunId: dispatched,
      dispatchedAt: 3_000,
      updatedAt: 3_000,
    })
    // `dispatched_at IS NULL` + 更大的 updated_at：PostgreSQL 的 `DESC` 默认把 NULL 排最前，
    // 于是这一条会赢——那正是这条 ORDER BY 必须显式写出 SQLite 语义的原因。
    await seedQuestionEntry(db, {
      taskId,
      originNodeRunId: parkRun,
      triggerRunId: notDispatched,
      dispatchedAt: null,
      updatedAt: 9_000,
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: `clarify:${parkRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames[0]).toMatchObject({ type: 'clarify.answered', rerunNodeRunId: dispatched })
  })

  test('自澄清决定提交 —— 完全没有问题条目时 rerunNodeRunId 为空串', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'self',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: parkRun,
      status: 'answered',
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: `clarify:${parkRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames[0]).toMatchObject({ type: 'clarify.answered', rerunNodeRunId: '' })
  })

  test('跨代理澄清决定提交 —— directive=stop 时追加 cross-clarify.rejected', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const crossRun = await seedRun(db, taskId, CROSS)
    const questionerRun = await seedRun(db, taskId, ASKER)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'cross',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: crossRun,
      status: 'answered',
      directive: 'stop',
    })
    await seedQuestionEntry(db, {
      taskId,
      originNodeRunId: crossRun,
      triggerRunId: questionerRun,
      dispatchedAt: 3_000,
      updatedAt: 3_000,
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: crossRun,
          gateKind: 'clarify',
          gateId: `clarify:${crossRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames).toEqual([
      {
        id: -1,
        type: 'cross-clarify.answered',
        nodeRunId: crossRun,
        sessionId: roundId,
        iteration: 3,
        directive: 'stop',
      },
      {
        id: -1,
        type: 'cross-clarify.rejected',
        nodeRunId: crossRun,
        sessionId: roundId,
        questionerNodeRunId: questionerRun,
      },
    ])
  })

  test('跨代理澄清决定提交 —— directive=continue 只投 answered 一帧', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const crossRun = await seedRun(db, taskId, CROSS)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'cross',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: crossRun,
      status: 'answered',
      directive: 'continue',
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: crossRun,
          gateKind: 'clarify',
          gateId: `clarify:${crossRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames).toEqual([
      {
        id: -1,
        type: 'cross-clarify.answered',
        nodeRunId: crossRun,
        sessionId: roundId,
        iteration: 3,
        directive: 'continue',
      },
    ])
  })

  test('澄清决定 —— 轮次未 answered 时不投帧', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'self',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: parkRun,
      status: 'awaiting_human',
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: `clarify:${parkRun}`,
          roundId,
        }),
        family: 'clarify',
      }),
    )
    expect(frames).toEqual([])
  })

  test('澄清决定 —— gateStatus=deferred 不投帧（延后不是收场）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY)
    const roundId = await seedRound(db, {
      taskId,
      kind: 'self',
      askingNodeRunId: askingRun,
      intermediaryNodeRunId: parkRun,
      status: 'answered',
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({
          taskId,
          nodeRunId: parkRun,
          gateKind: 'clarify',
          gateId: `clarify:${parkRun}`,
          roundId,
        }),
        family: 'clarify',
        gateStatus: 'deferred',
      }),
    )
    expect(frames).toEqual([])
  })

  test('评审决定提交 —— 决定帧由命令端自带，投影不再补（review family 返回空）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, REVIEW)
    await seedDocVersion(db, {
      taskId,
      reviewNodeRunId: runId,
      versionIndex: 1,
      itemIndex: null,
    })
    const frames = await projectionFor(harness).frames(
      decisionEvent({
        gate: gateRef({ taskId, nodeRunId: runId, gateKind: 'review', gateId: `review:${runId}` }),
        family: 'review',
      }),
    )
    expect(frames).toEqual([])
  })
})
