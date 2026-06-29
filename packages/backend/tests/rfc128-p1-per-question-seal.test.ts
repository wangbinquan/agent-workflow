// RFC-128 P1 — per-question seal 落库地基（先红后绿）。
//
// P1 把 clarify「整轮一次 seal」改造成逐题 seal 的存储地基：task_questions.sealed_at +
// reconcile 逐题门控 + answers_json 逐题 merge + 轮 answered 仅全 seal 才翻 + partial 纯
// 派生。本文件锁 P1 的服务级契约（纯函数门控见 shared/tests/task-questions-*.test.ts）：
//
//   AC-1 逐题 seal：单题 merge 进 answers_json / 轮不翻 / 同题不可重复 seal / 兄弟题可答。
//   AC-3 全题 seal 才 answered（RFC-126 failed→resume 须保持 answered 的地基）。
//   AC-2 reconcile 逐题门控：seal Q1(designer) → 出 Q1 designer 条目；Q2 未 seal 不出。
//   DTO  sealed 字段 + answerSummary 独立于轮 status（partial 下已 seal 题仍显示答案，F3）。
//   黄金锁：单题全答一次性 seal = 旧整轮 submit 在 answers_json 内容 + status 上逐字一致
//          （差异只在新增的 sealed_at + 借壳/续跑 mint——控制通道不 mint，是有意的 defer）。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, clarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { listTaskQuestions } from '../src/services/taskQuestions'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
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
    repoPath: '/tmp/aw-rfc128-p1',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

/** Seed a self clarify round with the given questions; returns its origin node-run id. */
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

/** Seed a cross clarify round; returns its origin node-run id. */
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

// ---------------------------------------------------------------------------
// AC-1 — 逐题 seal: 单题 merge / 轮不翻 / 同题不可重复 / 兄弟可答
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — AC-1 逐题 seal (self round)', () => {
  test('seal 单题 → 该题答案进 answers_json，轮仍 awaiting_human（不翻）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    const res = await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1', 1)] })
    expect(res.sealedQuestionIds).toEqual(['q1'])
    expect(res.roundFullySealed).toBe(false)

    const [round] = await roundOf(db, taskId)
    expect(round?.status).toBe('awaiting_human') // 轮不翻（partial 派生态）
    const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
    expect(answers.map((a) => a.questionId)).toEqual(['q1'])
    expect(answers[0]?.selectedOptionIndices).toEqual([1])
  })

  test('兄弟题可答：seal q1 后仍可 seal q2，q1 答案被 merge 保留（非整轮覆盖）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1', 0)] })
    const res2 = await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q2', 1)] })

    // 第二题 seal 后全题已 seal → 轮翻 answered。
    expect(res2.roundFullySealed).toBe(true)
    const [round] = await roundOf(db, taskId)
    expect(round?.status).toBe('answered')
    // merge 保留 q1 + 追加 q2（per-question merge，非覆盖）。
    const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
    expect(answers.map((a) => a.questionId).sort()).toEqual(['q1', 'q2'])
    expect(answers.find((a) => a.questionId === 'q1')?.selectedOptionIndices).toEqual([0])
    expect(answers.find((a) => a.questionId === 'q2')?.selectedOptionIndices).toEqual([1])
  })

  test('同题不可重复 seal：再次 seal q1 抛 clarify-question-already-sealed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')] })
    await expect(
      sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')] }),
    ).rejects.toThrow('already sealed')
  })
})

// ---------------------------------------------------------------------------
// AC-3 — 全题 seal 才 answered（RFC-126 failed→resume 地基）
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — AC-3 轮 answered 仅全 seal 才翻', () => {
  test('部分 seal 不翻；最后一题 seal 才翻 answered + dual-write legacy 一致', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [
      makeQ('q1'),
      makeQ('q2'),
      makeQ('q3'),
    ])
    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')] })
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')
    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q2')] })
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')

    const res3 = await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q3')] })
    expect(res3.roundFullySealed).toBe(true)
    const [round] = await roundOf(db, taskId)
    expect(round?.status).toBe('answered')
    expect(round?.answeredAt).not.toBeNull()
    // dual-write: legacy clarify_sessions 同步翻 answered + 同一 answers_json。
    const [legacy] = await db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.id, round!.id))
    expect(legacy?.status).toBe('answered')
    expect(legacy?.answersJson).toBe(round?.answersJson)
  })
})

// ---------------------------------------------------------------------------
// AC-2 — reconcile 逐题门控 (cross): seal Q1(designer) 出 Q1 designer 条目，Q2 不出
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — AC-2 reconcile 逐题门控 (cross)', () => {
  test('seal Q1 designer-scope → Q1 designer 条目出现，Q2 未 seal 无 designer 条目', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'designer' }, // scope 在答该题时定
    })

    const dtos = await listTaskQuestions(db, taskId)
    const sig = dtos.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    // 两条 questioner 恒有 + 仅 q1 出 designer（q1 已 seal + designer scope）。
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:questioner'])
    expect(sig).not.toContain('q2:designer')
  })

  test('seal Q1 questioner-scope → 仍只有 questioner 条目（无 designer）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'questioner' },
    })
    const dtos = await listTaskQuestions(db, taskId)
    expect(dtos.every((d) => d.roleKind !== 'designer')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DTO — sealed 字段 + answerSummary 独立于轮 status (F3)
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — DTO sealed 字段 + answerSummary 独立轮 status', () => {
  test('partial 轮：已 seal 题 sealed=true 且有 answerSummary；未 seal 题 sealed=false 且 summary=null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1', 'Why?'), makeQ('q2')])

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: 'because',
        },
      ],
      scopes: { q1: 'questioner' },
    })

    const dtos = await listTaskQuestions(db, taskId)
    // 轮仍 awaiting_human（q2 未 seal），但 q1 已 seal。
    expect((await roundOf(db, taskId))[0]?.status).toBe('awaiting_human')
    const q1 = dtos.find((d) => d.questionId === 'q1')!
    const q2 = dtos.find((d) => d.questionId === 'q2')!
    expect(q1.sealed).toBe(true)
    expect(q1.answerSummary).toContain('because') // F3: 已 seal → 显示答案，即便轮未 answered
    expect(q2.sealed).toBe(false)
    expect(q2.answerSummary).toBeNull() // 未 seal → 不误显示
  })

  test('全题 seal（轮 answered）：所有题 sealed=true（无 sealed_at 回填也成立——派生自轮 status）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1'), makeAns('q2')] })
    const dtos = await listTaskQuestions(db, taskId)
    expect(dtos.length).toBeGreaterThan(0)
    expect(dtos.every((d) => d.sealed)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 黄金锁 — 单题全答一次性 seal = 旧整轮 submit 在 answers_json + status 上逐字一致
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — 黄金锁: 一次性 seal 全题 == 旧整轮 submit', () => {
  test('answers_json 内容 + status 逐字一致；控制通道不 mint 续跑（defer 语义）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const questions = [makeQ('q1'), makeQ('q2')]
    const answers = [makeAns('q1', 1), makeAns('q2', 0)]

    // 旧整轮 quick channel。
    const a = await seedSelfRound(db, questions)
    await submitClarifyAnswers({ db, clarifyNodeRunId: a.originNodeRunId, answers })
    const [roundA] = await roundOf(db, a.taskId)

    // 新逐题 seal 全题一次。
    const b = await seedSelfRound(db, questions)
    await sealRoundQuestions({ db, originNodeRunId: b.originNodeRunId, answers })
    const [roundB] = await roundOf(db, b.taskId)

    // 内容 + status 逐字一致。
    expect(roundB?.answersJson).toBe(roundA?.answersJson)
    expect(roundA?.status).toBe('answered')
    expect(roundB?.status).toBe('answered')

    // quick channel 续跑 mint 一条；控制通道（seal 原语）不 mint（有意的 defer）。
    const rerunsA = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, a.taskId))).filter(
      (r) => r.rerunCause === 'clarify-answer',
    )
    const rerunsB = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, b.taskId))).filter(
      (r) => r.rerunCause === 'clarify-answer',
    )
    expect(rerunsA).toHaveLength(1)
    expect(rerunsB).toHaveLength(0)
  })
})
