// RFC-128 P5-A — pre-refactor 锁网（纯测试，零生产改动）。
//
// P5 深度重构（self/questioner 逐题重跑）将动 4 处「整轮」机制（design.md §5.2 + STATE.md
// P5 路线）：① 整轮 buildPromptContext 注入拆 per-question + suppress 已 dispatch 的 self/q
// 整轮注入；② 整轮消费戳 markClarifyRoundsConsumedBy/resolveTriggerForEntry 改 per-entry
// trigger_run_id；③ 新增 self/q 未下发 park 源（扩 loadUndispatchedDesignerTargets）；
// ④ resolveBorrowForNode 三账本 borrow-conflict 重做。这些都在调度器高发区 + RFC-125 历史
// 否决区。按 [hotspot-fortify-refactor]「先有网再动刀」：本网把 P5 动刀前的现状钉死，让
// P5-B/C/D 一旦破坏现状立刻变红——届时须确认那是 RFC-128 有意的逐题改造、并把对应锁迁移到
// 逐题语义，而不是「放松断言让它过」。
//
// 与既有网的关系（不重复）：
//   - rfc128-p0-whole-round-seal-net.test.ts 锁了 SEAL/续跑-mint 侧（self 单 rerun /
//     cross questioner cascade 一条 / resolveTriggerForEntry 整轮门控）。本网锁 INJECTION /
//     CONSUMPTION / BORROW 侧。
//   - rfc070-aging-stamp-behavior.test.ts B6/B7 锁 markClarifyRoundsConsumedBy 每 kind 的
//     stamp 写入；clarify-rounds-service.test.ts 锁 buildPromptContext 多轮渲染。本网补
//     「非 deferred self/q 是整轮（whole-round）注入 + 整轮消费」的显式 RFC-128-P5 锁 + 调度器
//     源码文本锁（P5-B suppress/拆 per-question 会破文本锁）。
//   - rfc127-self-questioner-borrow.test.ts P2-2 按 message 锁了两账本 reject；本网补
//     error CODE 锁（P5-D 三账本重做会破 code 锁）。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  nodeRuns,
  nodeRunOutputs,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { buildPromptContext } from '../src/services/clarifyRounds'
import { resolveBorrowForNode } from '../src/services/taskQuestionDispatch'
import { loadUndispatchedDesignerTargets } from '../src/services/taskQuestions'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

// Monotonic ulids so a later-seeded run always sorts freshest (asking run + rerun back-to-back).
const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCHEDULER_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

// node ids + agentNames in the frozen snapshot.
const P = 'P' // self-asking agent (also a borrow home)
const Q = 'Q' // cross questioner agent
const D = 'D' // cross designer agent
const X = 'X' // borrow target
const CL = 'CL' // self clarify node
const CC = 'CC' // cross-clarify node

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: P, kind: 'agent-single', agentName: 'agent-p' } as WorkflowNode,
    { id: Q, kind: 'agent-single', agentName: 'agent-q' } as WorkflowNode,
    { id: D, kind: 'agent-single', agentName: 'agent-d' } as WorkflowNode,
    { id: X, kind: 'agent-single', agentName: 'borrow-x' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return { $schema_version: 4, inputs: [], nodes, edges: [], outputs: [] }
}

function mkQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
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

async function seedTask(db: DbClient, taskId: string, deferred = false): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p5-a',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    deferredQuestionDispatch: deferred,
  })
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: { status?: string; iteration?: number; hasOutput?: boolean } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: over.iteration ?? 0,
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

/** Insert an answered clarify round (self or cross) with the given questions/answers + the
 *  consumed stamps. Returns the round + its asking/intermediary run ids. */
async function seedAnsweredRound(
  db: DbClient,
  taskId: string,
  opts: {
    kind: 'self' | 'cross'
    askingNodeId: string
    questions: ClarifyQuestion[]
    loopIter?: number
    consumedByConsumerRunId?: string | null
    consumedByQuestionerRunId?: string | null
  },
): Promise<{ roundId: string; askingRunId: string; intermediaryNodeRunId: string }> {
  const askingRunId = await seedRun(db, taskId, opts.askingNodeId, {
    iteration: opts.loopIter ?? 0,
  })
  const intRunId = await seedRun(db, taskId, opts.kind === 'self' ? CL : CC, {
    status: 'awaiting_human',
  })
  const roundId = ulid()
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind: opts.kind,
    askingNodeId: opts.askingNodeId,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: opts.kind === 'self' ? CL : CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: opts.kind === 'cross' ? D : null,
    loopIter: opts.loopIter ?? 0,
    iteration: 0,
    questionsJson: JSON.stringify(opts.questions),
    answersJson: JSON.stringify(opts.questions.map((q) => ans(q.id))),
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
    consumedByConsumerRunId: opts.consumedByConsumerRunId ?? null,
    consumedByQuestionerRunId: opts.consumedByQuestionerRunId ?? null,
  })
  return { roundId, askingRunId, intermediaryNodeRunId: intRunId }
}

function roundById(db: DbClient, roundId: string) {
  return db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId))
}

// ===========================================================================
// #1 — 非 deferred self/q 整轮注入：源码文本锁 + 行为锁（most critical）
//
// 非 deferred 任务 self/q 走整轮 buildPromptContext（clarifyRounds.ts:355）：调度器对带
// clarify 通道的节点用 consumerKind='self' / 'cross-questioner' 一次性拉所有 answered-且-未
// consumed 轮、render 全 Q&A。P5-B 计划「拆 per-question 注入 + suppress 已 dispatch 的
// self/q 整轮注入」——会改这两个 consumerKind 的调度器接线（源码文本锁）以及整轮渲染（行为锁）。
// ===========================================================================

describe('RFC-128 P5-A #1 → RFC-132 PR-C — self/q 注入收敛为统一平铺注入器: 调度器源码文本锁', () => {
  test('scheduler.ts 用 buildClarifyQueueContext 统一注入 self/q/designer（整轮 buildPromptContext + consumerKind 接线已删）', () => {
    const src = readFileSync(SCHEDULER_SRC, 'utf8')
    // RFC-132 (PR-C):整轮 buildPromptContext + per-role consumerKind 调度器接线被单一平铺注入器
    // buildClarifyQueueContext 取代(selectAgentQueue 一次查全 self/questioner/designer)。
    expect(src).toContain('await buildClarifyQueueContext(')
    expect(src).not.toContain('await buildPromptContext(')
    expect(src).not.toContain("consumerKind: 'self'")
    expect(src).not.toContain("consumerKind: 'cross-questioner'")
  })
})

describe('RFC-128 P5-A #1/#2 — buildPromptContext 整轮渲染全 Q&A (self / cross-questioner)', () => {
  test('self: 一条多题 answered 轮 → questionsBlock/answersBlock 含轮内所有题（整轮注入，非逐题子集）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'FIRST self question'), mkQ('q2', 'SECOND self question')],
    })

    const ctx = await buildPromptContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: P,
      targetIteration: 1,
      shardKey: null,
    })
    expect(ctx).toBeDefined()
    // Whole-round: BOTH questions of the single round are rendered (P5-B per-question injection
    // would render only the dispatched subset — this lock catches that change).
    expect(ctx?.questionsBlock).toContain('FIRST self question')
    expect(ctx?.questionsBlock).toContain('SECOND self question')
  })

  test('cross-questioner: 一条多题 answered 轮 → 含轮内所有题（反问者整轮看全部，与 scope 无关）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      loopIter: 0,
      questions: [mkQ('q1', 'FIRST cross question'), mkQ('q2', 'SECOND cross question')],
    })

    const ctx = await buildPromptContext({
      db,
      definition: liveDef(),
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: Q,
      targetIteration: 1,
      loopIter: 0,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.questionsBlock).toContain('FIRST cross question')
    expect(ctx?.questionsBlock).toContain('SECOND cross question')
  })
})

// ===========================================================================

// ===========================================================================
// #3 — resolveBorrowForNode 去借壳分离 (RFC-131 T4)
//
// RFC-131 T4 去借壳: 延迟账本（immediate self/q + designer deferred-dispatch）改按 EFFECTIVE
// TARGET（override ?? default）归属。原「同一 home P 两账本都开 → reject」的场景在去借壳后自然
// 分离——designer 条目按其 override 目标归到 D，不再落在 origin P 上，所以 resolveBorrowForNode(P)
// 只剩 immediate 账本、单账本解析借壳 agent；designer 在其 target D 上 run-self（null，无借壳）。
// 两账本真正落在同一 node 时仍 reject（code='task-question-borrow-ledger-conflict'），该守卫由
// rfc128-p5-bc-self-questioner-rerun.test.ts three-ledger SAME TARGET 用例覆盖。
// ===========================================================================

describe('RFC-128 P5-A #3 — resolveBorrowForNode 去借壳分离 (RFC-131 T4)', () => {
  /** Immediate ledger: an answered self round on home P reassigned to X (unconsumed). */
  async function seedImmediateBorrow(db: DbClient, taskId: string): Promise<void> {
    const { intermediaryNodeRunId } = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await db.insert(taskQuestions).values({
      id: ulid(),
      taskId,
      originNodeRunId: intermediaryNodeRunId,
      questionId: 'q1',
      questionTitle: 't',
      sourceKind: 'self',
      roleKind: 'self',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: P,
      overrideTargetNodeId: X, // borrow X on home P (immediate ledger)
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    // RFC-128 P5-BC (Codex impl-gate round 4): the OPEN immediate ledger is keyed on a PENDING
    // continuation node_run (truth source), so seed the clarify-answer continuation on P.
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: P,
      status: 'pending',
      rerunCause: 'clarify-answer',
      retryIndex: 0,
      iteration: 0,
    })
  }

  /** Designer ledger: a dispatched designer entry natively for P, reassigned to D. RFC-131 T4 去借壳:
   *  its ledger is keyed on the effective target D (not the origin P), and it runs D's own agent. */
  async function seedDesignerBorrowOnHomeP(db: DbClient, taskId: string): Promise<void> {
    const { intermediaryNodeRunId } = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      loopIter: 0,
      questions: [mkQ('dq', 't')],
    })
    await db.insert(taskQuestions).values({
      id: ulid(),
      taskId,
      originNodeRunId: intermediaryNodeRunId,
      questionId: 'dq',
      questionTitle: 't',
      sourceKind: 'cross',
      roleKind: 'designer',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: P, // graph home P (so it lands on the SAME home as the self borrow)
      overrideTargetNodeId: D,
      dispatchedAt: Date.now(), // dispatched + trigger NULL ⇒ open/unconsumed (designer ledger)
      dispatchedBy: 'u1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  test('去借壳: designer 移到其 target D → P 上不再撞 → immediate 单账本解析借壳 agent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId, true)
    await seedImmediateBorrow(db, taskId)
    await seedDesignerBorrowOnHomeP(db, taskId)

    // RFC-131 T4 去借壳: the designer entry (default P, override D) is keyed on its effective target D,
    // so P no longer holds two ledgers — resolveBorrowForNode(P) resolves the immediate ledger alone.
    expect(await resolveBorrowForNode(db, taskId, P, 0, liveDef())).toBe('borrow-x')
    // The designer ledger resolves run-self (null) on its target D — no borrow (去借壳).
    expect(await resolveBorrowForNode(db, taskId, D, 0, liveDef())).toBeNull()
  })

  test('对照：只有 immediate 账本（无 designer dispatch）→ 不冲突，返回借壳 agent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId, true)
    await seedImmediateBorrow(db, taskId)
    // No designer ledger → single ledger → resolves to X's agentName (no conflict).
    expect(await resolveBorrowForNode(db, taskId, P, 0, liveDef())).toBe('borrow-x')
  })
})

// ===========================================================================
// #4 — deferred designer 逐题(P3) 与整轮 self/q 交界现状
//
// 在 deferred 任务上，designer 与 self/q 走两套不同账本：designer = per-question dispatch
// （dispatched_at + loadUndispatchedDesignerTargets park）；self/q = 整轮 RFC-070 消费戳、
// 永不碰 dispatched_at、也不进 designer park 源。本锁钉死「两者在同一 deferred 任务上并存且
// 互不串台」的现状——P5-C 新增 self/q park 源（扩 loadUndispatchedDesignerTargets）会破这条。
// ===========================================================================

describe('RFC-128 P5-A #4 — deferred 任务: designer 逐题 park vs self/q 整轮 (交界现状)', () => {
  test('designer 未下发条目进 park 源；self/q 整轮答案不进 park、dispatched_at 恒 NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId, true)

    // Designer ledger: an undispatched designer entry (default home D) → §18 park source.
    const cross = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      loopIter: 0,
      questions: [mkQ('dq', 't')],
    })
    await db.insert(taskQuestions).values({
      id: ulid(),
      taskId,
      originNodeRunId: cross.intermediaryNodeRunId,
      questionId: 'dq',
      questionTitle: 't',
      sourceKind: 'cross',
      roleKind: 'designer',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: D,
      overrideTargetNodeId: null,
      // dispatched_at NULL ⇒ undispatched ⇒ in the designer park source.
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    // self/q ledger: an answered self round + its self entry — round-based, never dispatched.
    const self = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 't')],
    })
    await db.insert(taskQuestions).values({
      id: ulid(),
      taskId,
      originNodeRunId: self.intermediaryNodeRunId,
      questionId: 'q1',
      questionTitle: 't',
      sourceKind: 'self',
      roleKind: 'self',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: P,
      overrideTargetNodeId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    // Designer park source sees ONLY the designer home (D), NOT the self/q home (P) — there is
    // no self/questioner undispatched-park source yet (the stranding root cause P5-0 guards;
    // P5-C will ADD a self/q park source here → this lock turns red and must migrate).
    const parked = await loadUndispatchedDesignerTargets(db, taskId)
    expect(parked.has(D)).toBe(true)
    expect(parked.has(P)).toBe(false)

    // self/q entries are round-based — never stamped dispatched_at (designer-only column today).
    const selfEntries = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.roleKind, 'self'))
    expect(selfEntries.length).toBeGreaterThan(0)
    expect(selfEntries.every((e) => e.dispatchedAt === null)).toBe(true)
  })
})
