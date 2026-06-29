// RFC-123 — 反问 directive 双向单一事实源（RFC-122 修订）.
//
// 用户报（2026-06-29）：「我已经在反问页面选择要求停止反问了，为什么任务节点上的
// 反问开关还是继续反问」。根因 = 答题 stop 写 clarify_sessions/cross_clarify_sessions
// 的 directive，但画布开关只读 task_node_clarify_directives（RFC-122 故意并行）。
// 用户追问「两者本是一套语义」+ 拍板「也把重启用纳入」。
//
// 本文件锁定：
//   A. stop 写（self + cross）：答 directive='stop' 把 (task, asking-node) directive
//      写成 'stop'（画布开关单一事实源）；'continue' 不写（D1，golden-lock）。
//   B. 重启用 B1（prompt 路径）：buildPromptContext 收到 directiveOverride='continue'
//      时，即便最新已答轮 directive='stop'，ctx.directive 也被覆盖为 'continue'、
//      answersBlock 渲染 KEEP CLARIFYING（非 STOP）→ resolveEffectiveClarifyChannel
//      重新放行 ask-back。无 override ⇒ 读 rowDirective（golden-lock）。
//   C. 重启用 B2（cross 节点短路）：questioner 画布 toggle='continue' 覆盖 stale
//      hasPersistentStop → dispatchCrossClarifyNode 不再 short-circuit；无 continue
//      行 ⇒ 仍 short-circuit（golden-lock）。
//   D. 源码 wiring 守卫：scheduler directiveOverride 泛化 + 两处 questioner toggle 闸 +
//      两写点存在（catches a refactor that drops the single-source wiring）。
//
// 若任一变红 = 双向单一事实源契约漂移，先查再放。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRuns,
  taskNodeClarifyDirectives,
  tasks,
  workflows,
} from '../src/db/schema'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import {
  createCrossClarifySession,
  dispatchCrossClarifyNode,
  hasPersistentStop,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import { buildPromptContext } from '../src/services/clarifyRounds'
import {
  getNodeClarifyDirective,
  setNodeClarifyDirective,
} from '../src/services/taskClarifyDirective'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeQ(id = 'q1'): ClarifyQuestion {
  return {
    id,
    title: 'Which database?',
    kind: 'single',
    recommended: false,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid = 'q1'): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

async function insertTask(db: DbClient, def: WorkflowDefinition): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc123',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc123-fixture',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc123/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

function selfDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
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
}

function crossDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'qA', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_qA_cross1',
        source: { nodeId: 'qA', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_c1_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedSelfStopAnswered(
  db: DbClient,
  taskId: string,
  opts: {
    directive: 'stop' | 'continue'
    answeredBy?: string
    iterationIndex?: number
    srcId?: string
    now?: () => number
  },
): Promise<void> {
  const srcId = opts.srcId ?? 'nr_src'
  await db.insert(nodeRuns).values({
    id: srcId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  const { clarifyNodeRunId } = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: srcId,
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    iterationIndex: opts.iterationIndex ?? 0,
    questions: [makeQ()],
  })
  await submitClarifyAnswers({
    db,
    clarifyNodeRunId,
    answers: [makeAns()],
    directive: opts.directive,
    ...(opts.answeredBy !== undefined ? { answeredBy: opts.answeredBy } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
}

async function seedCrossStopAnswered(
  db: DbClient,
  taskId: string,
  directive: 'stop' | 'continue',
): Promise<void> {
  // designer run needed for the 'continue' path's designer rerun (triggerDesignerRerun).
  await db.insert(nodeRuns).values({
    id: 'nr_designer',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: 'snap-rfc123',
  })
  await db.insert(nodeRuns).values({
    id: 'nr_qA',
    taskId,
    nodeId: 'qA',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: 'cross1',
    sourceQuestionerNodeId: 'qA',
    sourceQuestionerNodeRunId: 'nr_qA',
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ()],
  })
  await submitCrossClarifyAnswers({
    db,
    crossClarifyNodeRunId,
    answers: [makeAns()],
    directive,
  })
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// A. stop 写（self + cross）— 答 stop 回写画布开关单一事实源
// ---------------------------------------------------------------------------
describe('RFC-123 A: 答 stop 回写 task_node_clarify_directives', () => {
  test('self-clarify 答 stop → asking 节点 directive=stop（setBy=answeredBy）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await seedSelfStopAnswered(db, taskId, { directive: 'stop', answeredBy: 'user_x' })

    expect(await getNodeClarifyDirective(db, taskId, 'designer')).toBe('stop')
    const row = (
      await db
        .select()
        .from(taskNodeClarifyDirectives)
        .where(
          and(
            eq(taskNodeClarifyDirectives.taskId, taskId),
            eq(taskNodeClarifyDirectives.nodeId, 'designer'),
          ),
        )
    )[0]
    expect(row?.setBy).toBe('user_x')
  })

  test('self-clarify 答 continue → 不写该表（golden-lock）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await seedSelfStopAnswered(db, taskId, { directive: 'continue' })

    expect(await getNodeClarifyDirective(db, taskId, 'designer')).toBeUndefined()
  })

  test('cross-clarify 答 stop → questioner 节点 directive=stop', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedCrossStopAnswered(db, taskId, 'stop')

    expect(await getNodeClarifyDirective(db, taskId, 'qA')).toBe('stop')
  })

  test('cross-clarify 答 continue → questioner 节点不写该表（golden-lock）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedCrossStopAnswered(db, taskId, 'continue')

    expect(await getNodeClarifyDirective(db, taskId, 'qA')).toBeUndefined()
  })

  test('幂等：手点 continue 后答 stop → 行终值 stop', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await setNodeClarifyDirective(db, taskId, 'designer', 'continue', 'manual')
    await seedSelfStopAnswered(db, taskId, { directive: 'stop' })

    expect(await getNodeClarifyDirective(db, taskId, 'designer')).toBe('stop')
  })
})

// ---------------------------------------------------------------------------
// B. 重启用 B1（prompt 路径）— directiveOverride='continue' 覆盖 stale stop
// ---------------------------------------------------------------------------
describe('RFC-123 B: directiveOverride=continue 覆盖 stale 已答 stop（重启用 prompt 路径）', () => {
  test('self：已答 stop 轮 + directiveOverride=continue → ctx.directive=continue、KEEP（非 STOP）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await seedSelfStopAnswered(db, taskId, { directive: 'stop' })

    const ctx = await buildPromptContext({
      db,
      definition: selfDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      directiveOverride: 'continue',
    })
    expect(ctx).toBeDefined()
    expect(ctx!.directive).toBe('continue')
    expect(ctx!.answersBlock).toContain('KEEP CLARIFYING')
    expect(ctx!.answersBlock).not.toContain('STOP CLARIFYING')
  })

  test('self：directiveOverride=stop 仍 STOP（RFC-122 既有不回归）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await seedSelfStopAnswered(db, taskId, { directive: 'stop' })

    const ctx = await buildPromptContext({
      db,
      definition: selfDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      directiveOverride: 'stop',
    })
    expect(ctx!.directive).toBe('stop')
    expect(ctx!.answersBlock).toContain('STOP CLARIFYING')
  })

  test('self：无 override → 读 rowDirective=stop（golden-lock）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await seedSelfStopAnswered(db, taskId, { directive: 'stop' })

    const ctx = await buildPromptContext({
      db,
      definition: selfDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
    })
    expect(ctx!.directive).toBe('stop')
    expect(ctx!.answersBlock).toContain('STOP CLARIFYING')
  })

  test('cross-questioner：已答 stop 轮 + directiveOverride=continue → ctx.directive=continue、非 STOP', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await db
      .insert(nodeRuns)
      .values({ id: 'nr_q', taskId, nodeId: 'qA', status: 'done', retryIndex: 0, iteration: 0 })
    await db.insert(nodeRuns).values({
      id: 'nr_cc',
      taskId,
      nodeId: 'cross1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(clarifyRounds).values({
      id: 'r_cross_stop',
      taskId,
      kind: 'cross',
      askingNodeId: 'qA',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cross1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: JSON.stringify([makeQ()]),
      answersJson: JSON.stringify([makeAns()]),
      directive: 'stop',
      status: 'answered',
    })

    const ctx = await buildPromptContext({
      db,
      definition: crossDef(),
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'qA',
      targetIteration: 1,
      loopIter: 0,
      directiveOverride: 'continue',
    })
    expect(ctx).toBeDefined()
    expect(ctx!.directive).toBe('continue')
    expect(ctx!.answersBlock).not.toContain('STOP CLARIFYING')
  })
})

// ---------------------------------------------------------------------------
// C. 重启用 B2（cross 节点短路）— questioner toggle=continue 覆盖 hasPersistentStop
// ---------------------------------------------------------------------------
describe('RFC-123 C: questioner toggle=continue 覆盖 cross hasPersistentStop（重启用）', () => {
  async function seedRejectedCross(db: DbClient, taskId: string): Promise<void> {
    await seedCrossStopAnswered(db, taskId, 'stop')
    // sanity: persistent stop is in force.
    expect(await hasPersistentStop(db, taskId, 'cross1')).toBe(true)
  }

  async function dispatchFresh(db: DbClient, taskId: string) {
    const freshId = `nr_cross1_${Math.random().toString(36).slice(2, 6)}`
    await db.insert(nodeRuns).values({
      id: freshId,
      taskId,
      nodeId: 'cross1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })
    const ret = await dispatchCrossClarifyNode({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      nodeRunId: freshId,
      definition: crossDef(),
    })
    const finalRun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, freshId)))[0]
    return { ret, finalStatus: finalRun?.status }
  }

  test('答 stop 写了 toggle=stop → short-circuit-stop', async () => {
    // seedCrossStopAnswered(stop) 走 submit，按 RFC-123 改动 A 顺带写 questioner toggle=stop。
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedRejectedCross(db, taskId)

    const { ret, finalStatus } = await dispatchFresh(db, taskId)
    expect(ret.kind).toBe('short-circuit-stop')
    expect(finalStatus).toBe('done')
  })

  test('questioner toggle=continue → 不再 short-circuit（awaiting；node_run 留 pending）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedRejectedCross(db, taskId)
    // 用户手点画布开关把 questioner 翻回 continue（重启用）。
    await setNodeClarifyDirective(db, taskId, 'qA', 'continue', 'user_x')

    const { ret, finalStatus } = await dispatchFresh(db, taskId)
    expect(ret.kind).not.toBe('short-circuit-stop')
    expect(finalStatus).toBe('pending')
  })

  test('questioner toggle=stop → 仍 short-circuit（不影响 stop 方向）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedRejectedCross(db, taskId)
    await setNodeClarifyDirective(db, taskId, 'qA', 'stop', 'user_x')

    const { ret } = await dispatchFresh(db, taskId)
    expect(ret.kind).toBe('short-circuit-stop')
  })
})

// ---------------------------------------------------------------------------
// D. 源码 wiring 守卫 — 锁定单一事实源接线，防 refactor 漂移
// ---------------------------------------------------------------------------
describe('RFC-123 D: 源码 wiring 守卫', () => {
  const schedulerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )
  const clarifySrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'clarify.ts'),
    'utf8',
  )
  const crossSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'crossClarify.ts'),
    'utf8',
  )

  test('scheduler：directiveOverride 泛化为 nodeDirective + recency directiveOverrideAt（非 stop 字面量）', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ')
    expect(schedulerSrc).toContain('const nodeDirective = nodeDirectiveRow?.directive')
    expect(norm(schedulerSrc)).toContain('directiveOverride: nodeDirective')
    expect(norm(schedulerSrc)).toContain('directiveOverrideAt: nodeDirectiveRow?.updatedAt')
    // 旧的 'stop' 字面量注入不得复活（否则重启用断）。
    expect(schedulerSrc).not.toContain("directiveOverride: 'stop' as const")
  })

  test('scheduler + crossClarify：cross 短路经 resolveCrossNodeStopped（B2 recency 闸）', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ')
    expect(norm(schedulerSrc)).toContain('resolveCrossNodeStopped(db, taskId, node.id')
    expect(crossSrc).toContain('export async function resolveCrossNodeStopped')
    expect(crossSrc).toContain('latestPersistentStopAt')
    // recency 闸本体：continue 仅在 ≥ stop 时间戳时覆盖（否则维持 stopped）。
    expect(norm(crossSrc)).toContain('return stopAt === null || stopAt > qRow.updatedAt')
  })

  test('clarify + crossClarify：答 stop 两写点存在（写 asking/questioner 节点 directive）', () => {
    // prettier 可能把长调用换行，故对归一化空白后的参数串匹配（对换行健壮、仍精确）。
    const norm = (s: string) => s.replace(/\s+/g, ' ')
    expect(clarifySrc).toContain('setNodeClarifyDirective')
    expect(norm(clarifySrc)).toContain(
      "db, sessionRow.taskId, sessionRow.sourceAgentNodeId, 'stop', answeredBy",
    )
    expect(crossSrc).toContain('setNodeClarifyDirective')
    expect(norm(crossSrc)).toContain(
      "args.db, row.taskId, row.sourceQuestionerNodeId, 'stop', answeredBy",
    )
  })
})

// ---------------------------------------------------------------------------
// E. recency 闸 — stale 'continue' toggle 不得重启用更晚的 stop（Codex impl-gate P2）
// ---------------------------------------------------------------------------
describe('RFC-123 E: stale continue 不重启用（recency 闸）', () => {
  // 直接 seed 一条 directive=stop 的 cross 会话（不走 submit，避免答 stop 顺带写 toggle），
  // 这样可以用受控 updatedAt 重现「升级前的旧 continue 行 + 后来的 stop」状态。
  async function seedCrossStopSessionDirect(
    db: DbClient,
    taskId: string,
    answeredAt: number,
  ): Promise<void> {
    await db
      .insert(nodeRuns)
      .values({ id: 'nr_qd', taskId, nodeId: 'qA', status: 'done', retryIndex: 0, iteration: 0 })
    await db.insert(nodeRuns).values({
      id: 'nr_ccd',
      taskId,
      nodeId: 'cross1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(crossClarifySessions).values({
      id: 'ccs_stop_direct',
      taskId,
      crossClarifyNodeId: 'cross1',
      crossClarifyNodeRunId: 'nr_ccd',
      sourceQuestionerNodeId: 'qA',
      sourceQuestionerNodeRunId: 'nr_qd',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: JSON.stringify([makeQ()]),
      answersJson: JSON.stringify([makeAns()]),
      directive: 'stop',
      status: 'answered',
      designerRunTriggeredAt: null,
      createdAt: answeredAt,
      answeredAt,
      abandonedAt: null,
    })
  }

  async function dispatchFresh(db: DbClient, taskId: string) {
    const freshId = `nr_cross1_${Math.random().toString(36).slice(2, 6)}`
    await db.insert(nodeRuns).values({
      id: freshId,
      taskId,
      nodeId: 'cross1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })
    return dispatchCrossClarifyNode({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      nodeRunId: freshId,
      definition: crossDef(),
    })
  }

  test('B2 真 golden-lock：stop 会话 + 无 toggle 行 → short-circuit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedCrossStopSessionDirect(db, taskId, 1_000_000)
    expect((await dispatchFresh(db, taskId)).kind).toBe('short-circuit-stop')
  })

  test('B2 stale continue（updatedAt < stop）→ 仍 short-circuit（不误重启用）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedCrossStopSessionDirect(db, taskId, 1_000_000)
    // 旧的 continue toggle，早于 stop（重现升级前残留）。
    await db.insert(taskNodeClarifyDirectives).values({
      taskId,
      nodeId: 'qA',
      directive: 'continue',
      setBy: 'pre',
      updatedAt: 999_000,
    })
    expect((await dispatchFresh(db, taskId)).kind).toBe('short-circuit-stop')
  })

  test('B2 fresh continue（updatedAt > stop）→ 重启用（不 short-circuit）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, crossDef())
    await seedCrossStopSessionDirect(db, taskId, 1_000_000)
    await db.insert(taskNodeClarifyDirectives).values({
      taskId,
      nodeId: 'qA',
      directive: 'continue',
      setBy: 'me',
      updatedAt: 1_001_000,
    })
    expect((await dispatchFresh(db, taskId)).kind).not.toBe('short-circuit-stop')
  })

  test('B1 stale continue override（directiveOverrideAt < 轮 answeredAt）→ ctx.directive=stop', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await seedSelfStopAnswered(db, taskId, { directive: 'stop', now: () => 1_000_000 })
    const ctx = await buildPromptContext({
      db,
      definition: selfDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      directiveOverride: 'continue',
      directiveOverrideAt: 999_000,
    })
    expect(ctx!.directive).toBe('stop')
    expect(ctx!.answersBlock).toContain('STOP CLARIFYING')
  })

  test('B1 fresh continue override（directiveOverrideAt >= 轮 answeredAt）→ ctx.directive=continue', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await insertTask(db, selfDef())
    await seedSelfStopAnswered(db, taskId, { directive: 'stop', now: () => 1_000_000 })
    const ctx = await buildPromptContext({
      db,
      definition: selfDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      directiveOverride: 'continue',
      directiveOverrideAt: 1_001_000,
    })
    expect(ctx!.directive).toBe('continue')
    expect(ctx!.answersBlock).not.toContain('STOP CLARIFYING')
  })
})
