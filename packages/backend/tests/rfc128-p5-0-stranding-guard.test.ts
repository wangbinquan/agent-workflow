// RFC-128 P5-0 — hotfix stranding guard（self/questioner 全 seal 防御，service 层 SoT）。
//
// 背景（P5 feasibility 研究发现的 latent bug，现状已可触发）：
//   控制通道（POST /api/clarify/:id/answers defer=true，或 sealRoundQuestions 直调）seal 时
//   NOT mint 续跑。对 DESIGNER-scope cross 轮没问题——§18 designer park
//   (loadUndispatchedDesignerTargets) 把持 deferred 任务，等看板 dispatch mint 借壳 designer
//   续跑（P3，已交付）。但一条 SELF 轮、或带任一 questioner-scope 题的 CROSS 轮，全题 seal 时
//   需要 self/questioner CONTINUATION 续跑（快通道 mint clarify-answer / cross-clarify-
//   questioner-rerun），而**没有 self/q 未下发 park 源**——于是 full seal 会关闭中介 node_run、
//   翻 answered 释放 asking-run park、却 mint 不出任何续跑 → 任务越过提问节点推进、续跑永不
//   触发（stranding，数据/进度丢失）。self/questioner 逐题重跑 + park 是 RFC-128 P5-B/C。
//
// P5-0：在 sealRoundQuestions 加 opt-in guard（`rejectSelfQuestionerFullSeal`，API 路由开启），
// 当一次 seal 会令 self/questioner 续跑型轮 roundFullySealed=true 时拒绝（409
// clarify-selfq-full-seal-unsupported-pre-p5）。约束：
//   - PARTIAL seal 仍允许（轮停 awaiting_human、OPEN session 兜 park，不 strand）。
//   - DESIGNER 域 full seal 完全不受影响（P0-P4 designer 主线照常 dispatch）。
//   - 判定按轮 KIND + 逐题 SCOPE（self 轮、或 cross 任一题 questioner-scope），**不看 directive**
//     ——与 reconcileDesiredEntries 的 self/questioner vs designer 切分一致。
//   - guard 是 opt-in：flag 不开（原始存储原语 / P1 黄金锁 / 未来 P5-B/C 调用方）行为不变。
//
// 本文件锁 service 层 guard 逻辑全矩阵（route 层「路由开启 guard」覆盖在
// rfc128-p2-per-question-endpoint.test.ts 的 P5-0 块）。任一断言变红 = guard 行为被改，
// 须确认是 P5-B/C 有意放开（届时把锁迁移到逐题重跑语义），而非误删。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession } from '../src/services/clarify'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  ClarifyQuestionScope,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

const GUARD_CODE = 'clarify-selfq-full-seal-unsupported-pre-p5'

function makeQ(id: string, title = `q-${id}`): ClarifyQuestion {
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

function makeAns(qid: string, idx = 0): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [idx], selectedOptionLabels: [], customText: '' }
}

function selfDef(): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
}

function crossDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [],
    outputs: [],
  }
}

async function seedTask(db: DbClient, def: WorkflowDefinition): Promise<{ taskId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: def.$schema_version,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p5-0',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

async function seedSelfRound(
  db: DbClient,
  questions: ClarifyQuestion[],
): Promise<{ taskId: string; originNodeRunId: string }> {
  const { taskId } = await seedTask(db, selfDef())
  const sourceRunId = `nr_src_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id: sourceRunId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: '',
  })
  const { clarifyNodeRunId } = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: sourceRunId,
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    iterationIndex: 0,
    questions,
  })
  return { taskId, originNodeRunId: clarifyNodeRunId }
}

async function seedCrossRound(
  db: DbClient,
  questions: ClarifyQuestion[],
): Promise<{ taskId: string; originNodeRunId: string }> {
  const { taskId } = await seedTask(db, crossDef())
  const questionerRunId = `nr_q_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values([
    { id: questionerRunId, taskId, nodeId: 'questioner', status: 'done', iteration: 0 },
    {
      id: `nr_d_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      nodeId: 'designer',
      status: 'done',
      iteration: 0,
      preSnapshot: 'stub',
    },
  ])
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: 'cross1',
    sourceQuestionerNodeId: 'questioner',
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions,
  })
  return { taskId, originNodeRunId: crossClarifyNodeRunId }
}

function roundOf(db: DbClient, taskId: string) {
  return db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
}

function nodeRunStatusOf(db: DbClient, id: string) {
  return db.select({ status: nodeRuns.status }).from(nodeRuns).where(eq(nodeRuns.id, id))
}

/** Seal with the route's flag enabled, capturing the thrown error (or undefined on success). */
async function sealGuarded(
  db: DbClient,
  originNodeRunId: string,
  answers: ClarifyAnswer[],
  scopes?: Record<string, ClarifyQuestionScope>,
): Promise<{ error?: unknown; result?: Awaited<ReturnType<typeof sealRoundQuestions>> }> {
  try {
    const result = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers,
      rejectSelfQuestionerFullSeal: true,
      ...(scopes !== undefined ? { scopes } : {}),
    })
    return { result }
  } catch (error) {
    return { error }
  }
}

// ---------------------------------------------------------------------------
// self/questioner FULL seal → 409（拒绝），且原子回滚（什么都没写）
// ---------------------------------------------------------------------------

describe('RFC-128 P5-0 — self/questioner full seal 拒绝 (ConflictError 409)', () => {
  test('SELF 轮全题 seal → 抛 ConflictError(clarify-selfq-full-seal-unsupported-pre-p5, 409)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    const { error } = await sealGuarded(db, originNodeRunId, [makeAns('q1'), makeAns('q2')])
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).code).toBe(GUARD_CODE)
    expect((error as ConflictError).status).toBe(409)
  })

  test('SELF 轮全题 seal 被拒 → 原子回滚：轮仍 awaiting_human、answers 仍 NULL、中介 node_run 未关', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    const { error } = await sealGuarded(db, originNodeRunId, [makeAns('q1'), makeAns('q2')])
    expect(error).toBeInstanceOf(ConflictError)

    // The guard throws BEFORE the first tx write → nothing committed.
    const [round] = await roundOf(db, taskId)
    expect(round?.status).toBe('awaiting_human')
    expect(round?.answersJson ?? null).toBeNull()
    expect((await nodeRunStatusOf(db, originNodeRunId))[0]?.status).toBe('awaiting_human')
  })

  test('CROSS 轮全题 seal — 全 questioner-scope → 拒绝（反问者续跑无 park、会 strand）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    const { error } = await sealGuarded(db, originNodeRunId, [makeAns('q1'), makeAns('q2')], {
      q1: 'questioner',
      q2: 'questioner',
    })
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).code).toBe(GUARD_CODE)
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')
  })

  test('CROSS 轮全题 seal — 混合 scope（designer + questioner）→ 拒绝（任一 questioner-scope 即 strand）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    const { error } = await sealGuarded(db, originNodeRunId, [makeAns('q1'), makeAns('q2')], {
      q1: 'designer',
      q2: 'questioner',
    })
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).code).toBe(GUARD_CODE)
  })

  test('CROSS 轮全题 seal — 跨多次 seal 累计成全题（partial 后补最后一题 questioner-scope）→ 末次拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    // First seal q1 (questioner) — PARTIAL, allowed.
    const first = await sealGuarded(db, originNodeRunId, [makeAns('q1')], { q1: 'questioner' })
    expect(first.error).toBeUndefined()
    expect(first.result?.roundFullySealed).toBe(false)
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')

    // Sealing the LAST question completes the round → full seal of a questioner-scope round → reject.
    const second = await sealGuarded(db, originNodeRunId, [makeAns('q2')], { q2: 'questioner' })
    expect(second.error).toBeInstanceOf(ConflictError)
    expect((second.error as ConflictError).code).toBe(GUARD_CODE)
    // q1 stays sealed from the allowed partial; round NOT flipped.
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')
  })
})

// ---------------------------------------------------------------------------
// PARTIAL seal 仍允许（轮停 awaiting_human，OPEN session 兜 park，不 strand）
// ---------------------------------------------------------------------------

describe('RFC-128 P5-0 — partial seal 仍允许（self/questioner）', () => {
  test('SELF 轮 partial seal（2 题答 1）→ 允许：roundFullySealed=false、轮 awaiting_human', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    const { error, result } = await sealGuarded(db, originNodeRunId, [makeAns('q1')])
    expect(error).toBeUndefined()
    expect(result?.roundFullySealed).toBe(false)
    expect(result?.sealedQuestionIds).toEqual(['q1'])
    // OPEN session still parks the asking run (loadOpenClarify) → no strand.
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')
    expect((await nodeRunStatusOf(db, originNodeRunId))[0]?.status).toBe('awaiting_human')
  })

  test('CROSS 轮 questioner-scope partial seal（2 题答 1）→ 允许', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    const { error, result } = await sealGuarded(db, originNodeRunId, [makeAns('q1')], {
      q1: 'questioner',
    })
    expect(error).toBeUndefined()
    expect(result?.roundFullySealed).toBe(false)
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')
  })
})

// ---------------------------------------------------------------------------
// DESIGNER 域 full seal 完全不受影响（P0-P4 designer 主线照常）
// ---------------------------------------------------------------------------

describe('RFC-128 P5-0 — designer full seal 照常（不受 guard 影响）', () => {
  test('CROSS 轮全题 seal — 全 designer-scope（+ flag）→ 照常：roundFullySealed=true、轮 answered、node_run 关', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    const { error, result } = await sealGuarded(
      db,
      originNodeRunId,
      [makeAns('q1'), makeAns('q2')],
      {
        q1: 'designer',
        q2: 'designer',
      },
    )
    expect(error).toBeUndefined()
    expect(result?.roundFullySealed).toBe(true)
    // designer 主线：full seal 翻 answered + 关中介 node_run（§18 park 把持任务，等看板 dispatch）。
    expect((await roundOf(db, taskId))[0]?.status).toBe('answered')
    expect((await nodeRunStatusOf(db, originNodeRunId))[0]?.status).toBe('done')
  })

  test('CROSS 轮全 designer-scope full seal — 缺省 scope（无 questionScopes）默认 designer → 照常允许', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1')])

    // No scopes provided → CLARIFY_QUESTION_SCOPE_DEFAULT='designer' → not a questioner round.
    const { error, result } = await sealGuarded(db, originNodeRunId, [makeAns('q1')])
    expect(error).toBeUndefined()
    expect(result?.roundFullySealed).toBe(true)
    expect((await roundOf(db, taskId))[0]?.status).toBe('answered')
  })

  test('directive 不参与判定：CROSS 全 designer-scope full seal + stop → 照常允许（按 scope，非 directive）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1')])

    const result = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'designer' },
      directive: 'stop',
      rejectSelfQuestionerFullSeal: true,
    })
    expect(result.roundFullySealed).toBe(true)
    expect((await roundOf(db, taskId))[0]?.directive).toBe('stop')
  })
})

// ---------------------------------------------------------------------------
// guard 是 opt-in：flag 不开 → 原始存储原语行为不变（P1 黄金锁 / 未来 P5-B/C 调用方）
// ---------------------------------------------------------------------------

describe('RFC-128 P5-0 — guard 是 opt-in（flag 默认关，原始原语不变）', () => {
  test('SELF 轮全题 seal、flag 不传 → 照旧成功（roundFullySealed=true、answered）——P1 黄金锁不破', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    // Raw primitive, no flag → the guard does NOT run (P1 storage golden-lock).
    const result = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1'), makeAns('q2')],
    })
    expect(result.roundFullySealed).toBe(true)
    expect((await roundOf(db, taskId))[0]?.status).toBe('answered')
  })

  test('SELF 轮全题 seal、flag=false 显式 → 同样照旧成功', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1')])

    const result = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      rejectSelfQuestionerFullSeal: false,
    })
    expect(result.roundFullySealed).toBe(true)
    expect((await roundOf(db, taskId))[0]?.status).toBe('answered')
  })
})
