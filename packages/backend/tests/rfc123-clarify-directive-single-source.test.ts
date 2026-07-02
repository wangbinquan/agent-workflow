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
//   C. 重启用 B2（cross 节点短路）：RFC-132 T7 起 questioner 节点的 node 级 directive 是唯一
//      事实源；toggle='continue'（写序晚于 stop）→ resolveCrossNodeStopped=false →
//      dispatchCrossClarifyNode 不再 short-circuit；directive='stop' / 无行 ⇒ 仍 short-circuit。
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
import { nodeRuns, taskNodeClarifyDirectives, tasks, workflows } from '../src/db/schema'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import {
  createCrossClarifySession,
  dispatchCrossClarifyNode,
  resolveCrossNodeStopped,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
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

// ---------------------------------------------------------------------------
// C. 重启用 B2（cross 节点短路）— questioner node 级 directive last-write-wins（RFC-132 T7）
// ---------------------------------------------------------------------------
describe('RFC-123 C: questioner node 级 directive 决定 cross 节点短路（RFC-132 T7 last-write-wins）', () => {
  async function seedRejectedCross(db: DbClient, taskId: string): Promise<void> {
    await seedCrossStopAnswered(db, taskId, 'stop')
    // sanity: the questioner node's node-level directive is 'stop'.
    expect(await resolveCrossNodeStopped(db, taskId, 'qA')).toBe(true)
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

  test('scheduler：directive 收敛为 per-node clarify 状态（nodeDirective 喂 oracle，非 per-round override）', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ')
    // RFC-132 (PR-C §7): 站定 directive = per-node clarify 状态。scheduler 读 nodeDirective 并喂进
    // resolveEffectiveClarifyChannel；'continue' toggle 因 nodeStopOverride 翻 false 而重开通道。
    // per-round 注入器 override plumbing（directiveOverride/directiveOverrideAt/applyLatestDirective）
    // 随平铺注入器一起删除。
    expect(schedulerSrc).toContain('const nodeDirective = nodeDirectiveRow?.directive')
    expect(norm(schedulerSrc)).toContain('contextDirective: nodeDirective')
    expect(schedulerSrc).not.toContain('directiveOverride')
    expect(schedulerSrc).not.toContain('applyLatestDirective')
  })

  test('scheduler + crossClarify：cross 短路经 resolveCrossNodeStopped（questioner node 级 directive 单一事实源）', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ')
    // RFC-132 T7: scheduler 传 questioner 节点（reenableQuestionerNodeId），非 cross node.id；
    // resolveCrossNodeStopped 收敛为只读 questioner 节点的 node 级 directive（node last-write-wins
    // 天然等价 RFC-123 recency gate）。旧 recency 闸（latestPersistentStopAt + stopAt 比较）已删。
    expect(norm(schedulerSrc)).toContain(
      'resolveCrossNodeStopped(db, taskId, reenableQuestionerNodeId',
    )
    expect(crossSrc).toContain('export async function resolveCrossNodeStopped')
    expect(norm(crossSrc)).toContain(
      "getNodeClarifyDirectiveRow(db, taskId, questionerNodeId))?.directive === 'stop'",
    )
    expect(crossSrc).not.toContain('latestPersistentStopAt')
    expect(crossSrc).not.toContain('function hasPersistentStop')
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
