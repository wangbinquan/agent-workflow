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
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
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
// AC-2 — reconcile 门控 (cross). RFC-128 P3 放开了 P1 阶段的 P2-4a 临时「整轮 gate」：现在
// partial seal 一个 designer-scope 题即逐题出它的 designer 条目，未 seal 的兄弟题不出；整轮
// 全 seal = 全题 designer 条目（黄金锁，= 旧 roundAnswered 逐字一致）。
// ---------------------------------------------------------------------------

describe('RFC-128 P1/P3 — AC-2 reconcile 逐题门控: seal 一题即出它的 designer 条目', () => {
  test('partial seal Q1(designer scope) → 出 Q1 designer 条目；Q2 未 seal 不出（P3 放开 P2-4a）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'designer' }, // scope 在答该题时定（已 merge 进 round）
    })
    expect(res.roundFullySealed).toBe(false)

    const dtos = await listTaskQuestions(db, taskId)
    const sig = dtos.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    // P3 逐题：Q1 已 seal + designer scope → 出 Q1 designer 条目；Q2 未 seal → 只 questioner。
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:questioner'])
    // Q1 designer 条目 sealed=true（即便轮仍 awaiting_human——partial 派生），故可 stage/dispatch。
    const q1Designer = dtos.find((d) => d.questionId === 'q1' && d.roleKind === 'designer')!
    expect(q1Designer.sealed).toBe(true)
  })

  test('全题 seal（designer scope）→ 轮 answered → 两题 designer 条目都出现（= 旧整轮行为）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'designer' },
    })
    const res2 = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q2')],
      scopes: { q2: 'designer' },
    })
    expect(res2.roundFullySealed).toBe(true)

    const dtos = await listTaskQuestions(db, taskId)
    const sig = dtos.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    // 全 seal → 轮 answered → designer 条目出现（两题都 designer scope）。
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:designer', 'q2:questioner'])
  })

  test('全题 seal 但 scope 混合 → 仅 designer-scope 题出 designer 条目', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'designer' },
    })
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q2')],
      scopes: { q2: 'questioner' },
    })
    const dtos = await listTaskQuestions(db, taskId)
    const sig = dtos.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:questioner'])
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

// ---------------------------------------------------------------------------
// P2-1 — seal 原子性: overlapping seals 不丢更新, 不留「全 sealed 但轮仍 awaiting」
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — P2-1 seal 原子性 (no lost-update / no torn state)', () => {
  test('Promise.all 两题并发 seal 同一 round → 两题答案都在 answers_json，轮 answered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    // Fire both seals "concurrently". With the dbTxSync (sync-body) wrapping, each runs to
    // completion atomically — the SECOND observes the first's committed answers_json, so
    // neither answer is lost (pre-P2-1 the two interleaved read-merge-writes lost one).
    await Promise.all([
      sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1', 0)] }),
      sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q2', 1)] }),
    ])

    const [round] = await roundOf(db, taskId)
    const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
    expect(answers.map((a) => a.questionId).sort()).toEqual(['q1', 'q2']) // no lost-update
    // Torn-state invariant: all sealed ⟺ round answered (never "all sealed but awaiting").
    expect(round?.status).toBe('answered')
  })

  test('seal 失败（terminal round）整体回滚——answers_json 不被部分写入', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    // Force the round terminal so the in-tx guard throws AFTER nothing has committed.
    await db
      .update(clarifyRounds)
      .set({ status: 'canceled' })
      .where(eq(clarifyRounds.taskId, taskId))
    await expect(
      sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')] }),
    ).rejects.toThrow('cannot seal')
    const [round] = await roundOf(db, taskId)
    expect(round?.answersJson ?? null).toBeNull() // nothing written
  })
})

// ---------------------------------------------------------------------------
// P2-2 — 整轮 submit 不覆盖已 sealed 答案（locked），未 sealed 正常写；黄金锁不破
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — P2-2 quick-channel 不覆盖已 sealed (self)', () => {
  test('control 通道先 seal q1，再走整轮 submit（post q1 改值 + q2）→ q1 保留锁定值，q2 写入', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    // Control channel seals q1 with index 0 (round stays awaiting_human).
    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1', 0)] })

    // Quick channel finalize posts ALL questions, trying to CHANGE q1 → index 1.
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: originNodeRunId,
      answers: [makeAns('q1', 1), makeAns('q2', 1)],
    })

    const [round] = await roundOf(db, taskId)
    const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
    // q1 KEEPS its locked (sealed) value 0, NOT the posted 1; q2 takes the posted 1.
    expect(answers.find((a) => a.questionId === 'q1')?.selectedOptionIndices).toEqual([0])
    expect(answers.find((a) => a.questionId === 'q2')?.selectedOptionIndices).toEqual([1])
    expect(round?.status).toBe('answered') // finalize still flips the whole round
  })

  test('黄金锁: 无任何预先 seal 时，整轮 submit 逐字不变（lockedIds 空）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: originNodeRunId,
      answers: [makeAns('q1', 1), makeAns('q2', 0)],
    })
    const [round] = await roundOf(db, taskId)
    const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
    expect(answers.find((a) => a.questionId === 'q1')?.selectedOptionIndices).toEqual([1])
    expect(answers.find((a) => a.questionId === 'q2')?.selectedOptionIndices).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// P2-3 — cross scopes merge: sparse questionScopes 不丢早先 seal 的 scope
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — P2-3 cross scopes merge (sparse request 不丢 scope)', () => {
  test('先 seal q1=questioner scope；整轮 submit 只带 q2 scope → q1 scope 保留 questioner', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    // Control channel seals q1 with questioner scope (round stays awaiting_human).
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'questioner' },
    })

    // Quick channel finalize sends a SPARSE questionScopes (only q2) — q1 omitted.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: originNodeRunId,
      answers: [makeAns('q1'), makeAns('q2')],
      directive: 'continue',
      questionScopes: { q2: 'designer' }, // q1 omitted → must NOT lose its stored scope
    })

    const [round] = await roundOf(db, taskId)
    const scopes = JSON.parse(round?.questionScopesJson ?? '{}') as Record<string, string>
    expect(scopes.q1).toBe('questioner') // P2-3: preserved (not defaulted to designer)
    expect(scopes.q2).toBe('designer')
  })

  // P2-3b (Codex re-gate): a LOCKED question's scope is sealed — a stale whole-round tab that
  // posts a DIFFERENT scope for it must NOT change the stored scope (mirrors answer lockedIds).
  test('先 seal q1=questioner；整轮 submit 改 q1=designer → q1 scope 仍锁定 questioner（不被改）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1')],
      scopes: { q1: 'questioner' },
    })

    // Stale tab finalize tries to FLIP q1 back to designer — must be ignored (q1 is locked).
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: originNodeRunId,
      answers: [makeAns('q1'), makeAns('q2')],
      directive: 'continue',
      questionScopes: { q1: 'designer', q2: 'designer' },
    })

    const [round] = await roundOf(db, taskId)
    const scopes = JSON.parse(round?.questionScopesJson ?? '{}') as Record<string, string>
    expect(scopes.q1).toBe('questioner') // P2-3b: locked scope NOT re-routed to designer
    expect(scopes.q2).toBe('designer')
  })

  test('黄金锁: 无 stored scope 时，整轮 submit 的 scopes 行为不变', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: originNodeRunId,
      answers: [makeAns('q1'), makeAns('q2')],
      directive: 'continue',
      questionScopes: { q1: 'designer', q2: 'questioner' },
    })
    const [round] = await roundOf(db, taskId)
    const scopes = JSON.parse(round?.questionScopesJson ?? '{}') as Record<string, string>
    expect(scopes).toEqual({ q1: 'designer', q2: 'questioner' })
  })
})
