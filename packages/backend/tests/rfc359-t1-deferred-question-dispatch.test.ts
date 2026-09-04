// RFC-359 W1-T1（P0-7）—— 延迟提问的自动派发在两个引擎上各跑一遍。
//
// 这是 dual-provider-parity-audit-2026-09-04 里第一条被真机实证的 P0：PostgreSQL 上每个调度 tick
// 抛 `deferred-question-dispatcher-not-bound`，任务的 node_runs 永远是 0 行。派发管线现在跑在
// `DatabaseSession` 上（`legacySqliteTaskQuestionDispatch.ts`），`createTaskDagCollaborationOperations`
// 两个 provider 共用。场景移植自 `rfc140-one-click-dispatch-all.test.ts`（SQLite 黄金锁，仍保留）。

import { beforeEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '@/db/schema'
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { dispatchTaskQuestions } from '@/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '@/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'

const ulid = monotonicFactory()
const ASKER = 'asker'
const DESIGNER = 'designer'
const OTHER = 'other'
const CC = 'cc'
const CL = 'cl'
const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DESIGNER, kind: 'agent-single', agentName: 'agent-designer' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: 'agent-other' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_dataflow',
        source: { nodeId: DESIGNER, portName: 'out' },
        target: { nodeId: ASKER, portName: 'in' },
      },
      {
        id: 'e_cc_designer',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_questioner',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: ASKER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  } as unknown as WorkflowDefinition
}

function mkQ(id: string): ClarifyQuestion {
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

function ans(qid: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

async function seedTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc359',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc359-dispatch',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeId: string,
  over: { status?: string; hasOutput?: boolean; rerunCause?: string } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
    ...(over.rerunCause ? { rerunCause: over.rerunCause } : {}),
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

async function seedRound(
  db: ProviderNeutralDatabase,
  taskId: string,
  kind: 'self' | 'cross',
  questions: ClarifyQuestion[],
): Promise<{ roundId: string; origin: string }> {
  const askingRunId = await seedRun(db, taskId, kind === 'cross' ? ASKER : DESIGNER, {
    status: 'done',
  })
  const intRunId = await seedRun(db, taskId, kind === 'cross' ? CC : CL, { status: 'done' })
  const roundId = ulid()
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind,
    askingNodeId: kind === 'cross' ? ASKER : DESIGNER,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: kind === 'cross' ? CC : CL,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: kind === 'cross' ? DESIGNER : null,
    iteration: 0,
    questionsJson: JSON.stringify(questions),
    answersJson: JSON.stringify(questions.map((q) => ans(q.id))),
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
  })
  return { roundId, origin: intRunId }
}

async function insertEntry(
  db: ProviderNeutralDatabase,
  taskId: string,
  e: {
    originNodeRunId: string
    questionId: string
    roleKind: 'self' | 'questioner' | 'designer'
    sourceKind?: 'self' | 'cross'
    defaultTargetNodeId: string | null
    stagedAt?: number | null
  },
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: `${e.questionId}-title`,
    sourceKind: e.sourceKind ?? 'cross',
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: null,
    sealedAt: now,
    sealedBy: 'u1',
    dispatchedAt: null,
    dispatchedBy: null,
    stagedAt: e.stagedAt ?? null,
    stagedBy: e.stagedAt ? 'u1' : null,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

const entryById = async (db: ProviderNeutralDatabase, id: string) =>
  (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]

/** 混批夹具：DESIGNER home 上 self（clarify-answer）+ designer（cross-clarify-answer）两类 cause；
 *  self staged 更早 → aging 选 self 先发，designer 批被 defer。 */
async function seedMixedBatch(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<{ selfIds: string[]; designerIds: string[] }> {
  await seedTask(db, taskId)
  await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
  const self = await seedRound(db, taskId, 'self', [mkQ('sq1')])
  const cross = await seedRound(db, taskId, 'cross', [mkQ('dq1'), mkQ('dq2')])
  const selfIds = [
    await insertEntry(db, taskId, {
      originNodeRunId: self.origin,
      questionId: 'sq1',
      roleKind: 'self',
      sourceKind: 'self',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now() - 10_000,
    }),
  ]
  const designerIds: string[] = []
  for (const q of ['dq1', 'dq2']) {
    designerIds.push(
      await insertEntry(db, taskId, {
        originNodeRunId: cross.origin,
        questionId: q,
        roleKind: 'designer',
        defaultTargetNodeId: DESIGNER,
        stagedAt: Date.now(),
      }),
    )
  }
  return { selfIds, designerIds }
}

describeEachProvider('RFC-359 T1 —— 延迟提问自动派发（P0-7）', (harness) => {
  beforeEach(() => resetBroadcastersForTests())

  test('混批 defer 盖列 → 承接 rerun done 后 autoDispatch 补发（__system__）并铸造 rerun', async () => {
    const db = harness.db
    const taskId = `t_${ulid()}`
    const { selfIds, designerIds } = await seedMixedBatch(db, taskId)
    const ops = createTaskDagCollaborationOperations(db)

    const res = await dispatchTaskQuestions(db, taskId, [...selfIds, ...designerIds], actor)
    expect(res.dispatchedEntryIds).toEqual(selfIds)
    expect(res.deferred.map((d) => d.entryId).sort()).toEqual([...designerIds].sort())
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.autoDispatchDeferredAt).not.toBeNull()
      expect(row.dispatchedAt).toBeNull()
    }
    // self continuation 仍 pending → in-flight gate 挡住补发（retryable，登记保留）。
    await ops.autoDispatchDeferredQuestions(taskId)
    expect((await entryById(db, designerIds[0]!))!.dispatchedAt).toBeNull()
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).not.toBeNull()

    const pending = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.status === 'pending',
    )!
    expect(pending, 'dispatch 必须铸出 self continuation').toBeDefined()
    await db
      .update(taskQuestions)
      .set({ triggerRunId: pending.id })
      .where(inArray(taskQuestions.id, selfIds))
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, pending.id))
    await ops.autoDispatchDeferredQuestions(taskId)
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.dispatchedAt).not.toBeNull()
      expect(row.dispatchedBy).toBe('__system__')
    }
    const minted = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'cross-clarify-answer',
    )
    expect(minted, 'designer home 上铸出一条 cross-clarify-answer rerun').toHaveLength(1)
    expect(await ops.loadUndispatchedParkTargets(taskId)).toEqual(new Set())
  })

  test('越权防护：staged 未点发（无登记）不被自动下发', async () => {
    const db = harness.db
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
    const cross = await seedRound(db, taskId, 'cross', [mkQ('dq1')])
    const id = await insertEntry(db, taskId, {
      originNodeRunId: cross.origin,
      questionId: 'dq1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now(),
    })
    await createTaskDagCollaborationOperations(db).autoDispatchDeferredQuestions(taskId)
    expect((await entryById(db, id))!.dispatchedAt).toBeNull()
  })

  test('不可恢复 Conflict（task-terminal）→ 清登记 + 不再重试（回手动轨道）', async () => {
    const db = harness.db
    const taskId = `t_${ulid()}`
    const { selfIds, designerIds } = await seedMixedBatch(db, taskId)
    await dispatchTaskQuestions(db, taskId, [...selfIds, ...designerIds], actor)
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).not.toBeNull()
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId))
    await createTaskDagCollaborationOperations(db).autoDispatchDeferredQuestions(taskId)
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.autoDispatchDeferredAt).toBeNull()
      expect(row.dispatchedAt).toBeNull()
      expect(row.stagedAt).not.toBeNull()
    }
  })

  test('park 投影：未派发的 designer 条目让其 home 停车；派发后释放', async () => {
    const db = harness.db
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
    const cross = await seedRound(db, taskId, 'cross', [mkQ('dq1')])
    const id = await insertEntry(db, taskId, {
      originNodeRunId: cross.origin,
      questionId: 'dq1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now(),
    })
    const ops = createTaskDagCollaborationOperations(db)
    expect(await ops.loadUndispatchedParkTargets(taskId)).toEqual(new Set([DESIGNER]))
    await dispatchTaskQuestions(db, taskId, [id], actor)
    expect(await ops.loadUndispatchedParkTargets(taskId)).toEqual(new Set())
  })
})
