// RFC-134 (design/RFC-134-reassign-asker-echo) — 改派回执（asker echo）GATE 集成。
//
// 锁定通用不变量「凡有效承接 ≠ 提问节点，下发时同步把该题 Q&A 送进提问节点的队列」的
// 全链路行为（设计 gate 8 轮 12 findings 的落地面）：
//
//   1. 写入（AC-1）：dispatch 同事务物化 roleKind='echo' 行（目标=提问节点、生来已下发、
//      trigger NULL 排队、sealed 继承/兜底），提问节点**零 mint**；重复下发幂等。
//   2. 黄金锁（AC-5）：未改派批次零 echo；designer 改派不产 echo。
//   3. seal 归一化（AC-1b，Codex R5-F9）：answered 轮 sealedAt-NULL 源行 stamp 时补行戳
//      （sealed_by NULL）→ 承接方与提问节点双投递均可渲染；manual 不补、已 sealed 不改写。
//   4. 序列化豁免（AC-3，Codex F1 折为 D4）：queued echo 不阻塞对提问节点的同类/异类
//      后续下发；同批「改派 + 异类下发到提问节点」照常提交，异类 rerun 顺带注入并绑定
//      echo（提前送达=有意行为）；run 义务仍按 RFC-133 阻塞（回归锁）。
//   5. 注入端到端（AC-2）：提问节点下一次运行平铺注入 echo Q&A → bindTriggerRun 绑定 →
//      done+output 派生老化出队——注入层零 echo 特判（源码锁见文末）。
//   6. 同题同目标去重（AC-2b，Codex R2-F3 折为 D9）：pre-existing「designer 条目改派到
//      questioner 节点」与「echo+兄弟同指提问节点」都只渲染一次、绑定全量；manual 不参与。
//   7. 生命周期（AC-6/7）：echo 相位 processing→awaiting_confirm→done；confirm 任意相位可
//      调（D3）且不撤销投递；reassign/stage/再下发被 CAS 拒（stage 为 RFC-134 D10 新守卫，
//      对所有已下发行生效）。
//   8. reconcile 安全（AC-4）：懒 reconcile 与 stop-finalize designer 清理均不增/改/删 echo。
//   9. RFC-099：echo 渲染块无归属字段。
//  10. 源码文本锁（AC-2/AC-3）：clarifyQueue.ts 无 'echo' 字面量；两文件守卫白名单恒三角色。

import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { causeClassForEntry } from '../src/services/clarifyRerunLedger'
import { buildClarifyQueueContext, selectAgentQueue } from '../src/services/clarifyQueue'
import {
  confirmTaskQuestion,
  createManualTaskQuestion,
  listTaskQuestions,
  reassignTaskQuestion,
  reconcileTaskQuestionsForRound,
  stageTaskQuestion,
} from '../src/services/taskQuestions'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const ASKER = 'asker' // 提问节点（self 反问的 agent / cross 的 questioner）
const DOWN = 'down' // 下游 agent（改派目标）
const CL = 'cl' // self clarify 节点
const CC = 'cc' // cross-clarify 节点
const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DOWN, kind: 'agent-single', agentName: 'agent-down' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_dataflow',
        source: { nodeId: ASKER, portName: 'out' },
        target: { nodeId: DOWN, portName: 'in' },
      },
      {
        id: 'e_ask_cl',
        source: { nodeId: ASKER, portName: '__clarify__' },
        target: { nodeId: CL, portName: 'questions' },
      },
      {
        id: 'e_cl_ask',
        source: { nodeId: CL, portName: 'answers' },
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

async function seedTask(db: DbClient, taskId: string): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc134',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc134',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc134',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: DbClient,
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

/** 落一条 clarify 轮（默认 answered、有答案），返回 intermediary run id（= 条目 origin）。 */
async function seedRound(
  db: DbClient,
  taskId: string,
  opts: {
    kind: 'self' | 'cross'
    askingNodeId: string
    questions: ClarifyQuestion[]
    status?: 'answered' | 'awaiting_human'
  },
): Promise<string> {
  const askingRunId = await seedRun(db, taskId, opts.askingNodeId, { status: 'done' })
  const intRunId = await seedRun(db, taskId, opts.kind === 'self' ? CL : CC, { status: 'done' })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: opts.kind,
    askingNodeId: opts.askingNodeId,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: opts.kind === 'self' ? CL : CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: opts.kind === 'cross' ? DOWN : null,
    iteration: 0,
    questionsJson: JSON.stringify(opts.questions),
    answersJson: JSON.stringify(opts.questions.map((q) => ans(q.id))),
    directive: 'continue',
    status: opts.status ?? 'answered',
    answeredAt: Date.now(),
  })
  return intRunId
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  sourceKind?: 'self' | 'cross'
  defaultTargetNodeId: string | null
  overrideTargetNodeId?: string | null
  sealed?: boolean
  dispatchedAt?: number | null
  triggerRunId?: string | null
  stagedAt?: number | null
}

async function insertEntry(db: DbClient, taskId: string, e: EntrySeed): Promise<string> {
  const id = ulid()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: `${e.questionId}-title`,
    sourceKind: e.sourceKind ?? (e.roleKind === 'self' ? 'self' : 'cross'),
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: e.overrideTargetNodeId ?? null,
    sealedAt: (e.sealed ?? true) ? Date.now() : null,
    sealedBy: (e.sealed ?? true) ? 'u1' : null,
    dispatchedAt: e.dispatchedAt ?? null,
    dispatchedBy: e.dispatchedAt ? 'u1' : null,
    triggerRunId: e.triggerRunId ?? null,
    stagedAt: e.stagedAt ?? null,
    stagedBy: e.stagedAt ? 'u1' : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

const allEntries = (db: DbClient, taskId: string) =>
  db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
const echoRows = async (db: DbClient, taskId: string) =>
  (await allEntries(db, taskId)).filter((e) => e.roleKind === 'echo')
const taskRuns = (db: DbClient, taskId: string) =>
  db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))

beforeEach(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// 1. 写入 + 黄金锁
// ---------------------------------------------------------------------------

describe('RFC-134 echo 写入（AC-1 / AC-5）', () => {
  test('改派 self 条目下发 → 恰一条 echo（字段全断言），提问节点零 mint，重复下发幂等', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, DOWN, { hasOutput: true }) // 改派目标须有过 run（frontier 安全门）
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const entry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
      stagedAt: Date.now(),
    })
    const askerRunsBefore = (await taskRuns(db, taskId)).filter((r) => r.nodeId === ASKER).length

    const result = await dispatchTaskQuestions(db, taskId, [entry], actor)

    expect(result.dispatchedEntryIds).toEqual([entry])
    // 提问节点零 mint（rerun 只在改派目标 DOWN 上）。
    expect(result.reruns.map((r) => r.targetNodeId)).toEqual([DOWN])
    const askerRunsAfter = (await taskRuns(db, taskId)).filter((r) => r.nodeId === ASKER).length
    expect(askerRunsAfter).toBe(askerRunsBefore)
    // echo 行字段（design §2.2）。
    const echoes = await echoRows(db, taskId)
    expect(echoes.length).toBe(1)
    const echo = echoes[0]!
    const source = (await allEntries(db, taskId)).find((e) => e.id === entry)!
    expect(echo.originNodeRunId).toBe(origin)
    expect(echo.questionId).toBe('q1')
    expect(echo.questionTitle).toBe('q1-title')
    expect(echo.sourceKind).toBe('self')
    expect(echo.defaultTargetNodeId).toBe(ASKER)
    expect(echo.overrideTargetNodeId).toBeNull()
    expect(echo.dispatchedAt).toBe(source.dispatchedAt) // 生来已下发（同批 stamp 时间戳）
    expect(echo.dispatchedBy).toBe('u1')
    expect(echo.triggerRunId).toBeNull() // queued，等提问节点下次运行绑定
    expect(echo.sealedAt).toBe(source.sealedAt) // 继承源 seal
    expect(echo.stagedAt).toBeNull()
    expect(echo.confirmation).toBe('open')
    // 幂等：同 id 再下发 → CAS 失手（已 stamp）→ 空结果、无第二条 echo、无新 run。
    const again = await dispatchTaskQuestions(db, taskId, [entry], actor)
    expect(again.dispatchedEntryIds).toEqual([])
    expect((await echoRows(db, taskId)).length).toBe(1)
  })

  test('黄金锁：未改派条目下发 → 零 echo；designer 条目改派 → 零 echo', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const plain = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
    })
    const first = await dispatchTaskQuestions(db, taskId, [plain], actor)
    expect((await echoRows(db, taskId)).length).toBe(0)
    // 让第一次下发的条目走完消费闭环（绑定 + done+output 老化），否则第二段对 ASKER 的异类
    // 下发会被 RFC-133 run 义务 / cause 序列化正常拦截（与 echo 无关）。
    const mintedRunId = first.reruns[0]!.nodeRunId
    await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: mintedRunId,
      iteration: 0,
    })
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, mintedRunId))
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: mintedRunId, portName: 'out', content: 'w' })

    // designer 改派（cross 轮）：questioner 条目天然承担回执职责，不重复产 echo。
    const crossOrigin = await seedRound(db, taskId, {
      kind: 'cross',
      askingNodeId: ASKER,
      questions: [mkQ('q2')],
    })
    const designer = await insertEntry(db, taskId, {
      originNodeRunId: crossOrigin,
      questionId: 'q2',
      roleKind: 'designer',
      defaultTargetNodeId: DOWN,
      overrideTargetNodeId: ASKER,
    })
    await dispatchTaskQuestions(db, taskId, [designer], actor)
    expect((await echoRows(db, taskId)).length).toBe(0)
  })

  test('兄弟已交付指向提问节点（已下发+sealed 的 designer 改派行）→ 跳过 echo', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'cross',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    // designer 兄弟已被改派到提问节点并已下发（sealed）→ 投递已保证。
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DOWN,
      overrideTargetNodeId: ASKER,
      dispatchedAt: Date.now() - 500,
    })
    const questioner = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
    })
    await dispatchTaskQuestions(db, taskId, [questioner], actor)
    expect((await echoRows(db, taskId)).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. seal 归一化（AC-1b）
// ---------------------------------------------------------------------------

describe('RFC-134 seal 行戳归一化（AC-1b，Codex R5-F9）', () => {
  test('answered 轮 sealedAt-NULL 源行：stamp 后补行戳（sealed_by NULL），承接方与提问节点双投递均渲染', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    // 懒建行形态：answered 轮上 sealed_at NULL（契约 #17）。
    const entry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
      sealed: false,
    })
    const result = await dispatchTaskQuestions(db, taskId, [entry], actor)
    const source = (await allEntries(db, taskId)).find((e) => e.id === entry)!
    expect(source.sealedAt).not.toBeNull() // 归一化补戳
    expect(source.sealedBy).toBeNull() // 「answered 轮证据落戳」审计语义（非人工 seal）
    const echo = (await echoRows(db, taskId))[0]!
    expect(echo.sealedAt).not.toBeNull() // 回执恒可渲染
    // 承接方（DOWN）投递可渲染：其 rerun 的队列含该 Q&A（修 pre-existing 投递洞）。
    const downRunId = result.reruns[0]!.nodeRunId
    const downQueue = await selectAgentQueue({
      db,
      taskId,
      consumerNodeId: DOWN,
      dispatchedRunId: downRunId,
    })
    expect(downQueue.map((e) => e.id)).toContain(entry)
    // 提问节点投递可渲染：echo 在 ASKER 队列。
    const askerRunId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const askerQueue = await selectAgentQueue({
      db,
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: askerRunId,
    })
    expect(askerQueue.map((e) => e.id)).toContain(echo.id)
  })

  test('已 sealed 行不改写；manual 行不补戳', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const sealedEntry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
    })
    const sealedBefore = (await allEntries(db, taskId)).find((e) => e.id === sealedEntry)!.sealedAt
    // manual 条目（sealed_at 恒 NULL——manual 无 seal 概念，isEntrySealed 恒真）。
    const { id: manualId } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'manual-t', body: 'manual-b', targetNodeId: ASKER },
      actor,
    )
    await dispatchTaskQuestions(db, taskId, [sealedEntry, manualId], actor)
    const after = await allEntries(db, taskId)
    expect(after.find((e) => e.id === sealedEntry)!.sealedAt).toBe(sealedBefore) // 不改写
    expect(after.find((e) => e.id === manualId)!.sealedAt).toBeNull() // manual 不补
  })
})

// ---------------------------------------------------------------------------
// 3. 序列化豁免（AC-3）
// ---------------------------------------------------------------------------

describe('RFC-134 序列化豁免（AC-3，D4）', () => {
  test('queued echo 挂在提问节点上：同类与异类后续下发均放行（零 409）；echo 搭异类 rerun 送达并绑定', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const entry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
    })
    await dispatchTaskQuestions(db, taskId, [entry], actor)
    const echo = (await echoRows(db, taskId))[0]!
    expect(echo.triggerRunId).toBeNull() // queued

    // 异类（manual → cross-clarify-answer 类）下发到提问节点 → 放行 + mint。
    const { id: manualId } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'fix-this', body: 'fix instruction', targetNodeId: ASKER },
      actor,
    )
    const manualResult = await dispatchTaskQuestions(db, taskId, [manualId], actor)
    expect(manualResult.reruns.map((r) => r.targetNodeId)).toEqual([ASKER])
    const askerRun = (await taskRuns(db, taskId)).find(
      (r) => r.id === manualResult.reruns[0]!.nodeRunId,
    )!
    expect(askerRun.rerunCause).toBe('cross-clarify-answer') // 异类 rerun

    // Codex F1 场景转正：异类 rerun 的注入把 echo 一起送达（提前送达=有意行为）+ 绑定。
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: askerRun.id,
      iteration: 0,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block).toContain('q1-title') // echo Q&A
    expect(ctx!.block).toContain('fix instruction') // manual 本体
    const boundEcho = (await echoRows(db, taskId))[0]!
    expect(boundEcho.triggerRunId).toBe(askerRun.id)
    // 提问节点 done+output → echo 老化出队（送达定型）。
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, askerRun.id))
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: askerRun.id, portName: 'out', content: 'y' })
    const nextRunId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const queueAfter = await selectAgentQueue({
      db,
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: nextRunId,
    })
    expect(queueAfter.map((e) => e.id)).not.toContain(boundEcho.id)
  })

  test('同批「改派 + 异类下发到提问节点」→ 照常提交（豁免不阻塞同批），echo 与 manual 同车注入', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const entry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
    })
    const { id: manualId } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'same-batch', body: 'same batch body', targetNodeId: ASKER },
      actor,
    )
    const result = await dispatchTaskQuestions(db, taskId, [entry, manualId], actor)
    // ASKER 是 {ASKER, DOWN} 的上游 frontier → 本批只在 ASKER mint（异类 cause），DOWN 走级联。
    expect(result.reruns.map((r) => r.targetNodeId)).toEqual([ASKER])
    expect((await echoRows(db, taskId)).length).toBe(1)
    const askerRunId = result.reruns[0]!.nodeRunId
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: askerRunId,
      iteration: 0,
    })
    expect(ctx!.block).toContain('q1-title')
    expect(ctx!.block).toContain('same batch body')
  })

  test('run 义务仍阻塞（RFC-133 回归锁，与 echo 无关）：提问节点有 pending run 时对它下发 → 409', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1'), mkQ('q2')],
    })
    const first = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
    })
    // 第一次下发在 ASKER mint 了 pending rerun → run 义务。
    await dispatchTaskQuestions(db, taskId, [first], actor)
    const second = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q2',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
    })
    await expect(dispatchTaskQuestions(db, taskId, [second], actor)).rejects.toThrow(ConflictError)
  })
})

// ---------------------------------------------------------------------------
// 4. 同题同目标去重（AC-2b）
// ---------------------------------------------------------------------------

describe('RFC-134 同题同目标渲染去重（AC-2b，D9）', () => {
  test('pre-existing：designer 条目改派到 questioner 节点 → 同一 Q&A 只渲染一次、两行均绑定', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedRound(db, taskId, {
      kind: 'cross',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const questioner = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now() - 100,
    })
    const designer = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DOWN,
      overrideTargetNodeId: ASKER, // 改派到 questioner 节点 → 同题同目标
      dispatchedAt: Date.now(),
    })
    const runId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: runId,
      iteration: 0,
    })
    expect(ctx).toBeDefined()
    // 只渲染一次。
    const occurrences = ctx!.block.split('q1-title').length - 1
    expect(occurrences).toBe(1)
    // 两行均绑定（独立老化/相位推进）。
    const rows = await allEntries(db, taskId)
    expect(rows.find((e) => e.id === questioner)!.triggerRunId).toBe(runId)
    expect(rows.find((e) => e.id === designer)!.triggerRunId).toBe(runId)
  })

  test('echo 跨批与后到的 designer 兄弟同指提问节点 → 单渲染双绑定；manual 条目不参与去重', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'cross',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    // 批 1：questioner 条目改派到 DOWN → echo(ASKER)。
    const questioner = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
    })
    await dispatchTaskQuestions(db, taskId, [questioner], actor)
    const echo = (await echoRows(db, taskId))[0]!
    // 批 2（跨批）：designer 兄弟后到、也改派到提问节点（直接落 dispatched 行模拟已下发态）。
    const designer = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DOWN,
      overrideTargetNodeId: ASKER,
      dispatchedAt: Date.now(),
    })
    // 两条 manual（origin 合成唯一）→ 永不被去重。
    const { id: m1 } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'm1', body: 'manual-one', targetNodeId: ASKER },
      actor,
    )
    const { id: m2 } = await createManualTaskQuestion(
      db,
      taskId,
      { title: 'm2', body: 'manual-two', targetNodeId: ASKER },
      actor,
    )
    await db.update(taskQuestions).set({ dispatchedAt: Date.now() }).where(eq(taskQuestions.id, m1))
    await db.update(taskQuestions).set({ dispatchedAt: Date.now() }).where(eq(taskQuestions.id, m2))

    const runId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: runId,
      iteration: 0,
    })
    const occurrences = ctx!.block.split('q1-title').length - 1
    expect(occurrences).toBe(1) // echo + designer 同题 → 一次
    expect(ctx!.block).toContain('manual-one')
    expect(ctx!.block).toContain('manual-two')
    const rows = await allEntries(db, taskId)
    expect(rows.find((e) => e.id === echo.id)!.triggerRunId).toBe(runId)
    expect(rows.find((e) => e.id === designer)!.triggerRunId).toBe(runId)
  })
})

// ---------------------------------------------------------------------------
// 5. 生命周期（AC-6 / AC-7）
// ---------------------------------------------------------------------------

describe('RFC-134 echo 生命周期（AC-6/AC-7）', () => {
  async function seedEchoViaDispatch(db: DbClient, taskId: string) {
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const entry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
    })
    await dispatchTaskQuestions(db, taskId, [entry], actor)
    return (await echoRows(db, taskId))[0]!
  }

  test('相位三跳：queued→processing；绑定+done+output→awaiting_confirm；confirm→done', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    const echo = await seedEchoViaDispatch(db, taskId)
    const phase1 = (await listTaskQuestions(db, taskId)).find((d) => d.id === echo.id)!
    expect(phase1.phase).toBe('processing') // dispatched + trigger NULL
    expect(phase1.roleKind).toBe('echo')
    // 提问节点运行绑定 + done+output。
    const runId = await seedRun(db, taskId, ASKER, { status: 'running' })
    await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: runId,
      iteration: 0,
    })
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, runId))
    await db.insert(nodeRunOutputs).values({ nodeRunId: runId, portName: 'out', content: 'z' })
    const phase2 = (await listTaskQuestions(db, taskId)).find((d) => d.id === echo.id)!
    expect(phase2.phase).toBe('awaiting_confirm')
    await confirmTaskQuestion(db, echo.id, actor)
    const phase3 = (await listTaskQuestions(db, taskId)).find((d) => d.id === echo.id)!
    expect(phase3.phase).toBe('done')
  })

  test('D3：echo 任意相位可 confirm（processing 即可收卡），confirm 不撤销投递；非 echo 仍守 awaiting_confirm', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    const echo = await seedEchoViaDispatch(db, taskId)
    // processing 相位直接 confirm —— echo 放宽。
    await confirmTaskQuestion(db, echo.id, actor)
    expect((await listTaskQuestions(db, taskId)).find((d) => d.id === echo.id)!.phase).toBe('done')
    // confirm 不撤销投递：注入选取仍含该 echo。
    const runId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const queue = await selectAgentQueue({
      db,
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: runId,
    })
    expect(queue.map((e) => e.id)).toContain(echo.id)
    // 非 echo（processing 的源条目）confirm → 仍被 guard 拒。
    const source = (await allEntries(db, taskId)).find((e) => e.roleKind === 'self')!
    await expect(confirmTaskQuestion(db, source.id, actor)).rejects.toThrow(ConflictError)
  })

  test('只读知会：reassign 被 CAS 拒；stage 被 D10 新守卫拒；再下发空结果', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    const echo = await seedEchoViaDispatch(db, taskId)
    await expect(reassignTaskQuestion(db, echo.id, DOWN, actor)).rejects.toThrow(ConflictError)
    await expect(stageTaskQuestion(db, echo.id, true, actor)).rejects.toThrow(ConflictError)
    const before = (await echoRows(db, taskId)).length
    const res = await dispatchTaskQuestions(db, taskId, [echo.id], actor)
    expect(res.dispatchedEntryIds).toEqual([])
    expect((await echoRows(db, taskId)).length).toBe(before)
  })

  test('D10 交错回归（实现 gate fold）：seal 门通过后、CAS 前被 dispatch 抢戳 → 0 行 → Conflict、零脏戳', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    // sealed + 未下发：seal 门必过——此时「dispatch 抢先 stamp」是 stage 单语句 CAS 前
    // 唯一可能的交错；直接落戳模拟赢家（stage 的 staged=true 路径没有任何 dispatched 预读，
    // 该交错与「调用时已下发」命中同一条条件更新——单语句原子，输者恰得 0 行）。
    const entry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
    })
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: Date.now(), dispatchedBy: 'racer' })
      .where(eq(taskQuestions.id, entry))
    await expect(stageTaskQuestion(db, entry, true, actor)).rejects.toThrow(ConflictError)
    const row = (await allEntries(db, taskId)).find((e) => e.id === entry)!
    expect(row.stagedAt).toBeNull() // 零脏戳
    expect(row.stagedBy).toBeNull()
  })

  test('D10 源码形态锁：stage 的 staged=true 路径是单条条件更新 + 受影响行数判定（无先查后改）', async () => {
    const src = await Bun.file(
      fileURLToPath(new URL('../src/services/taskQuestions.ts', import.meta.url)),
    ).text()
    const start = src.indexOf('export async function stageTaskQuestion')
    const end = src.indexOf('export', start + 10)
    const fn = src.slice(start, end)
    expect(fn).toContain('isNull(taskQuestions.dispatchedAt)') // 条件更新（同列 CAS）
    expect(fn).toContain('changes') // 受影响行数判定
    expect(fn).not.toContain('stillOpen') // 不得回退成 tx 内先查后改
  })

  test('D10 通用性：任何已下发行都不可 stage（补 pre-existing 缺口）；未下发行 stage/un-stage 照常', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1'), mkQ('q2')],
    })
    const dispatched = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now(),
    })
    await expect(stageTaskQuestion(db, dispatched, true, actor)).rejects.toThrow(ConflictError)
    expect((await allEntries(db, taskId)).find((e) => e.id === dispatched)!.stagedAt).toBeNull()
    const open = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q2',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
    })
    await stageTaskQuestion(db, open, true, actor)
    expect((await allEntries(db, taskId)).find((e) => e.id === open)!.stagedAt).not.toBeNull()
    await stageTaskQuestion(db, open, false, actor) // un-stage 不受守卫影响
    expect((await allEntries(db, taskId)).find((e) => e.id === open)!.stagedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. reconcile 安全（AC-4）+ RFC-099（AC-9）
// ---------------------------------------------------------------------------

describe('RFC-134 reconcile 安全 + 隔离', () => {
  test('懒 reconcile 反复跑 + stop-finalize designer 清理 → echo 不增不改不删', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'cross',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const questioner = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
    })
    await dispatchTaskQuestions(db, taskId, [questioner], actor)
    const echoBefore = (await echoRows(db, taskId))[0]!
    // 反复 reconcile（listTaskQuestions 内部也会 reconcile 全部轮）。
    const round = (
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    reconcileTaskQuestionsForRound(db, round)
    reconcileTaskQuestionsForRound(db, round)
    await listTaskQuestions(db, taskId)
    // stop-finalize：directive='stop' 的 answered 轮清理未下发 designer 行——echo 不在清理面。
    await db.update(clarifyRounds).set({ directive: 'stop' }).where(eq(clarifyRounds.id, round.id))
    const stopped = (
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, round.id))
    )[0]!
    reconcileTaskQuestionsForRound(db, stopped)
    const echoAfter = (await echoRows(db, taskId))[0]
    expect(echoAfter).toBeDefined()
    expect(echoAfter!.id).toBe(echoBefore.id)
    expect(echoAfter!.updatedAt).toBe(echoBefore.updatedAt) // 不改
    expect((await echoRows(db, taskId)).length).toBe(1) // 不增
  })

  test('RFC-099：echo 渲染块不含任何归属字段（actor id 不入 prompt）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, ASKER, { hasOutput: true })
    await seedRun(db, taskId, DOWN, { hasOutput: true })
    const origin = await seedRound(db, taskId, {
      kind: 'self',
      askingNodeId: ASKER,
      questions: [mkQ('q1')],
    })
    const entry = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DOWN,
    })
    await dispatchTaskQuestions(db, taskId, [entry], actor)
    const runId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: runId,
      iteration: 0,
    })
    expect(ctx!.block).toContain('q1-title')
    expect(ctx!.block).not.toContain('u1') // dispatched_by / sealed_by 等归属字段绝不入 prompt
  })
})

// ---------------------------------------------------------------------------
// 7. causeClassForEntry echo 防御映射（AC-3）+ 源码文本锁（AC-2 / AC-3）
// ---------------------------------------------------------------------------

describe('RFC-134 cause 防御映射 + 源码锁', () => {
  test('causeClassForEntry(echo)：self→clarify-answer；cross→cross-clarify-questioner-rerun（防御映射，非守卫判据）', () => {
    expect(causeClassForEntry({ roleKind: 'echo', sourceKind: 'self' })).toBe('clarify-answer')
    expect(causeClassForEntry({ roleKind: 'echo', sourceKind: 'cross' })).toBe(
      'cross-clarify-questioner-rerun',
    )
  })

  test("源码锁：clarifyQueue.ts 不含 'echo' 字面量（注入层零特判，AC-2）", async () => {
    const src = await Bun.file(
      fileURLToPath(new URL('../src/services/clarifyQueue.ts', import.meta.url)),
    ).text()
    expect(src).not.toContain("'echo'")
  })

  test("源码锁：两文件守卫白名单恒为三角色、不得扩入 'echo'（D4 豁免不被顺手破坏，AC-3）", async () => {
    for (const rel of [
      '../src/services/taskQuestionDispatch.ts',
      '../src/services/clarifyAutoDispatch.ts',
    ]) {
      const src = await Bun.file(fileURLToPath(new URL(rel, import.meta.url))).text()
      const whitelists = src.match(/inArray\(taskQuestions\.roleKind,\s*\[[^\]]*\]\)/g) ?? []
      expect(whitelists.length).toBeGreaterThan(0)
      for (const w of whitelists) {
        expect(w).not.toContain("'echo'")
      }
    }
  })
})
