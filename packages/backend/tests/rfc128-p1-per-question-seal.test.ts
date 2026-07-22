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
//   快通道互操作：整轮 finalize（RFC-132 起 = autoDispatchClarifyRound）不覆盖已 seal 的答案 /
//          不丢已 seal 的 scope（P2-2/P2-3）。旧「一次性 seal == legacy 整轮 submit 逐字一致」
//          对比锁随 legacy immediate 路径一起删除（RFC-132 §8——有意行为变更，非回归）。

import { createClarifyRound } from '../src/services/clarify/service'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
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
const actor = { userId: 'u1', role: 'owner' as const }

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
  const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
    kind: 'self',
    db,
    taskId,
    askingNodeId: 'designer',
    askingNodeRunId: sourceRunId,
    askingShardKey: null,
    intermediaryNodeId: 'clarify1',
    iteration: 0,
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
  const { intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound({
    kind: 'cross',
    db,
    taskId,
    intermediaryNodeId: 'cross1',
    askingNodeId: 'questioner',
    askingNodeRunId: questionerRunId,
    targetConsumerNodeId: 'designer',
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

  // RFC-136（用户 2026-07-02 拍板「问题返回待指派应允许修改答案」）改写原「同题不可重复
  // seal」锁：exactly-once 的边界收窄到「已 staged / 已下发」——一个 sealed 但仍 待指派
  // （staged_at/dispatched_at 均 NULL）的题现在允许重 seal（覆盖），正向 case 在
  // rfc136-reanswer.test.ts。本测试守住收窄后的 409 边界（staged 后不可重答）。
  test('RFC-136 边界：已 staged 的题重复 seal 仍抛 clarify-question-already-sealed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    // autoStage: seal 即进 待下发（staged_at 非空）——重 seal 必须仍被拒。
    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')], autoStage: true })
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
    const [legacy] = await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, round!.id))
    expect(legacy?.status).toBe('answered')
    expect(legacy?.answersJson).toBe(round?.answersJson)
  })
})

// ---------------------------------------------------------------------------
// AC-2 — reconcile 门控 (cross). RFC-162: per-question scope (designer↔questioner) is DELETED, so
// the old "seal a designer-scope question → its designer entry appears" gate is gone. reconcile now
// emits exactly ONE asker (questioner) entry per question for a cross round; designer handlers come
// ONLY from a human reassign (locked in rfc120-task-questions-service.test.ts). The three tests here
// asserting the deleted designer-by-scope gate were RETIRED; the one below locks the surviving half
// (reconcile is asker-only, per-question sealed derivation still works on a partial round).
// ---------------------------------------------------------------------------

describe('RFC-162 — AC-2 reconcile: cross round → questioner-only entries (no designer)', () => {
  test('partial seal q1 → 只出 questioner 条目（q1 sealed=true / q2 sealed=false）；从不出 designer', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1'), makeQ('q2')])

    const res = await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')] })
    expect(res.roundFullySealed).toBe(false)

    const dtos = await listTaskQuestions(db, taskId)
    const sig = dtos.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    // RFC-162: exactly one questioner entry per question — NEVER a designer entry from a seal.
    expect(sig).toEqual(['q1:questioner', 'q2:questioner'])
    // Per-question sealed derivation survives: q1 sealed even though the round is still
    // awaiting_human (partial, derived), q2 not.
    expect(dtos.find((d) => d.questionId === 'q1')!.sealed).toBe(true)
    expect(dtos.find((d) => d.questionId === 'q2')!.sealed).toBe(false)
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
// (RFC-132 §8: 旧「一次性 seal 全题 == legacy 整轮 submit」byte-for-byte 对比锁已随
// legacy immediate 路径删除；seal 原语本身的「控制通道不 mint」语义由上面 AC 组 +
// autoStage 黄金锁继续覆盖。)
// ---------------------------------------------------------------------------

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

    // Quick channel finalize (autoDispatchClarifyRound) posts ALL questions, trying to CHANGE
    // q1 → index 1.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1), makeAns('q2', 1)],
      actor,
    })

    const [round] = await roundOf(db, taskId)
    const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
    // q1 KEEPS its locked (sealed) value 0, NOT the posted 1; q2 takes the posted 1.
    expect(answers.find((a) => a.questionId === 'q1')?.selectedOptionIndices).toEqual([0])
    expect(answers.find((a) => a.questionId === 'q2')?.selectedOptionIndices).toEqual([1])
    expect(round?.status).toBe('answered') // finalize still flips the whole round
  })

  test('黄金锁: 无任何预先 seal 时，整轮 finalize 逐字不变（lockedIds 空）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    await autoDispatchClarifyRound({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1), makeAns('q2', 0)],
      actor,
    })
    const [round] = await roundOf(db, taskId)
    const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
    expect(answers.find((a) => a.questionId === 'q1')?.selectedOptionIndices).toEqual([1])
    expect(answers.find((a) => a.questionId === 'q2')?.selectedOptionIndices).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// RFC-162: retired — P2-3 "cross scopes merge" (sparse questionScopes 不丢早先 seal 的 scope +
// locked-scope 不被 stale tab 改写 + scopes 黄金锁). Per-question scope (designer↔questioner) is
// DELETED: sealRoundQuestions / autoDispatchClarifyRound no longer take `scopes` and question_scopes_json
// is never written, so there is no scope-merge behavior left to lock. The answer-merge half these
// tests rode on (sealed answers not overwritten by a stale finalize) survives in the P2-2 block above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RFC-128 (用户 2026-07-01) — autoStage 参数：控制通道 seal 即进「待下发/staged」。
//
// 集中回答提交(seal)后，问题应自动进「待下发」，好让看板「批量下发全下」(dispatchTaskQuestions
// = ALL staged) 直接拾取，而不是落「待指派」(pending) 还要人工「移入待下发」。autoStage 只在同一
// seal tx 内对「本次 sealed 条目」补一条 set staged_at（IS NULL 才写、幂等），staged_by 镜像
// sealed_by（RFC-099 审计位，绝不进 prompt）。
//   黄金锁：不传 autoStage（autoDispatch / 原语默认）→ staged_at 不写，逐字不变。
// ---------------------------------------------------------------------------

describe('RFC-128 P1 — autoStage 参数 (seal→待下发/staged)', () => {
  test('autoStage:true → 本次 sealed 条目 staged_at 落、deriveQuestionPhase=staged（只碰已 seal 题）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')], autoStage: true })

    const list = await listTaskQuestions(db, taskId)
    const q1 = list.find((d) => d.questionId === 'q1')!
    const q2 = list.find((d) => d.questionId === 'q2')!
    // q1 sealed + auto-staged → 待下发（staged）。
    expect(q1.sealed).toBe(true)
    expect(q1.staged).toBe(true)
    expect(q1.phase).toBe('staged')
    // q2 未 seal → 不在本次 sealingSet → autoStage 不碰它 → 待指派（pending）。
    expect(q2.sealed).toBe(false)
    expect(q2.staged).toBe(false)
    expect(q2.phase).toBe('pending')
  })

  test('黄金锁：缺省(不传 autoStage) → staged_at 不写、phase=pending（autoDispatch / 原语逐字不变）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')] })

    const q1 = (await listTaskQuestions(db, taskId)).find((d) => d.questionId === 'q1')!
    expect(q1.sealed).toBe(true)
    expect(q1.staged).toBe(false)
    expect(q1.phase).toBe('pending')
  })

  test('per-call 隔离：seal q1(autoStage) 后再 seal q2(不传 autoStage) → q1 仍 staged、q2 pending（后一次不 un-stage 前一次）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])

    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1')], autoStage: true })
    // Second seal opts OUT of autoStage; it also fully seals the round (both questions sealed).
    await sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q2')] })

    const list = await listTaskQuestions(db, taskId)
    expect(list.find((d) => d.questionId === 'q1')!.staged).toBe(true) // preserved from call 1
    expect(list.find((d) => d.questionId === 'q2')!.staged).toBe(false) // call 2 did not stage it
  })

  // RFC-162: retired — "cross designer partial seal + autoStage → questioner + designer 两角色条目都
  // staged". A designer entry no longer arises from a designer-scope seal (scope deleted); a cross
  // seal produces only the questioner entry. autoStage's stamp semantics (across every role row of a
  // question, keyed on origin × question) are covered by the self cases above and, for a genuine
  // two-role question built via reassign, by rfc136-reanswer.test.ts.
})
