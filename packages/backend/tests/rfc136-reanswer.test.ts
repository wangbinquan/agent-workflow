// RFC-136 — 待指派问题重答（用户 2026-07-02 拍板：仅待指派 / 面板纳入已答题 / 直接覆盖）。
//
// 锁 sealRoundQuestions 的逐题三分类语义（design §2.1）：
//   fresh    未 seal → 原路径字节不变（golden-lock，rfc128-p1 大盘继续锁）；
//   reseal   已 seal 且该题全部非 echo 条目 dispatched_at IS NULL ∧ staged_at IS NULL
//            （典型来源：seal→autoStage 进待下发→移出待下发回待指派）→ 覆盖 answers_json、
//            sealed_at/By 前移、autoStage 回待下发（D4）、scope 锁定原值（D6）、
//            answered 轮不重触发翻转副作用（AC-3）；
//   rejected 已 staged / 已下发 → 409 clarify-question-already-sealed（pre-RFC-136 行为）。
//
// 回归意图：任何 refactor 让「移出待下发的已答题」再次不可重答（409）、或让重答冲掉
// answered 轮的 answeredAt / directive / 长出 stop 轮 designer 条目，这里立刻变红。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { createClarifySession } from '../src/services/clarify'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { listTaskQuestions, stageTaskQuestion } from '../src/services/taskQuestions'
import { buildClarifyQueueContext } from '../src/services/clarifyQueue'
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

function makeAns(qid: string, idx = 0, customText = ''): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [idx], selectedOptionLabels: [], customText }
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
    repoPath: '/tmp/aw-rfc136',
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

async function roundRow(db: DbClient, taskId: string) {
  const rows = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
  return rows[0]
}

async function entriesOf(db: DbClient, originNodeRunId: string) {
  return db.select().from(taskQuestions).where(eq(taskQuestions.originNodeRunId, originNodeRunId))
}

function answersOf(json: string | null): ClarifyAnswer[] {
  return JSON.parse(json ?? '[]') as ClarifyAnswer[]
}

/** seal(autoStage) → 移出待下发：把一个已答题制备成「待指派 + sealed」的重答起点。 */
async function sealThenUnstage(
  db: DbClient,
  taskId: string,
  originNodeRunId: string,
  qid: string,
  ans: ClarifyAnswer,
  now = 1_000,
) {
  await sealRoundQuestions({
    db,
    originNodeRunId,
    answers: [ans],
    autoStage: true,
    sealedBy: 'u1',
    now: () => now,
  })
  const dtos = await listTaskQuestions(db, taskId)
  const staged = dtos.filter((e) => e.questionId === qid && e.staged)
  expect(staged.length).toBeGreaterThan(0)
  for (const e of staged) await stageTaskQuestion(db, e.id, false, actor)
}

describe('RFC-136 — 重答（reseal）正向路径', () => {
  test('待指派已答题重 seal：answers_json 覆盖 + sealed 戳前移 + autoStage 回待下发 + resealedQuestionIds', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1')])
    await sealThenUnstage(db, taskId, originNodeRunId, 'q1', makeAns('q1', 0, 'OLD-MARKER'), 1_000)

    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1, 'NEW-MARKER')],
      autoStage: true,
      sealedBy: 'u2',
      allowResealFor: ['q1'],
      now: () => 2_000,
    })
    expect(res.resealedQuestionIds).toEqual(['q1'])
    expect(res.sealedQuestionIds).toEqual([])

    const round = await roundRow(db, taskId)
    const answers = answersOf(round?.answersJson ?? null)
    expect(answers).toHaveLength(1)
    expect(answers[0]?.selectedOptionIndices).toEqual([1])
    expect(answers[0]?.customText).toBe('NEW-MARKER')

    const rows = await entriesOf(db, originNodeRunId)
    const selfRow = rows.find((r) => r.roleKind === 'self')
    expect(selfRow?.sealedAt).toBe(2_000)
    expect(selfRow?.sealedBy).toBe('u2')
    // D4 — 重答与初答同语义：autoStage 直接回待下发。
    expect(selfRow?.stagedAt).not.toBeNull()
  })

  test('AC-3 — answered 轮重答：status/answeredAt/answeredBy 保持，不重触发翻转', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1')])
    // 单题轮：seal 即全 seal → answered @1000。
    await sealThenUnstage(db, taskId, originNodeRunId, 'q1', makeAns('q1', 0), 1_000)
    const before = await roundRow(db, taskId)
    expect(before?.status).toBe('answered')
    expect(before?.answeredAt).toBe(1_000)

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1)],
      autoStage: true,
      sealedBy: 'u2',
      allowResealFor: ['q1'],
      now: () => 2_000,
    })
    const after = await roundRow(db, taskId)
    expect(after?.status).toBe('answered')
    expect(after?.answeredAt).toBe(1_000) // 不被重答冲掉
    expect(after?.answeredBy).toBe(before?.answeredBy ?? null)
  })

  test('stop 轮重答：directive 保持 stop、reconcile 不长 designer 条目（wasAnswered 忽略 body 默认 continue）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1')])
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 0)],
      directive: 'stop',
      autoStage: true,
      sealedBy: 'u1',
      now: () => 1_000,
    })
    const before = await roundRow(db, taskId)
    expect(before?.directive).toBe('stop')
    const designerBefore = (await entriesOf(db, originNodeRunId)).filter(
      (r) => r.roleKind === 'designer',
    )
    expect(designerBefore).toHaveLength(0) // stop 轮无 designer 条目

    // 移出待下发 → 重答（路由层 schema 会给 directive 默认 'continue'——防它冲掉 stop）。
    const dtos = await listTaskQuestions(db, taskId)
    for (const e of dtos.filter((x) => x.staged)) await stageTaskQuestion(db, e.id, false, actor)
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1)],
      directive: 'continue', // 模拟 body 默认值
      autoStage: true,
      sealedBy: 'u1',
      allowResealFor: ['q1'],
      now: () => 2_000,
    })
    const after = await roundRow(db, taskId)
    expect(after?.directive).toBe('stop')
    const designerAfter = (await entriesOf(db, originNodeRunId)).filter(
      (r) => r.roleKind === 'designer',
    )
    expect(designerAfter).toHaveLength(0)
  })

  test('部分 seal 轮：q1 重答不影响未答 q2；fresh+reseal 混合一次提交', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    await sealThenUnstage(db, taskId, originNodeRunId, 'q1', makeAns('q1', 0, 'OLD'), 1_000)
    expect((await roundRow(db, taskId))?.status).toBe('awaiting_human')

    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1, 'NEW'), makeAns('q2', 0, 'FRESH')],
      autoStage: true,
      sealedBy: 'u1',
      allowResealFor: ['q1'],
      now: () => 2_000,
    })
    expect(res.resealedQuestionIds).toEqual(['q1'])
    expect(res.sealedQuestionIds).toEqual(['q2'])
    expect(res.roundFullySealed).toBe(true) // q2 补齐 → 本次翻 answered

    const round = await roundRow(db, taskId)
    expect(round?.status).toBe('answered')
    const answers = answersOf(round?.answersJson ?? null)
    expect(answers.find((a) => a.questionId === 'q1')?.customText).toBe('NEW')
    expect(answers.find((a) => a.questionId === 'q2')?.customText).toBe('FRESH')
  })

  test('D6 — reseal 题客户端误传 scope 被忽略（question_scopes_json 原值保持）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1')])
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 0)],
      scopes: { q1: 'designer' },
      autoStage: true,
      sealedBy: 'u1',
      now: () => 1_000,
    })
    const dtos = await listTaskQuestions(db, taskId)
    for (const e of dtos.filter((x) => x.staged)) await stageTaskQuestion(db, e.id, false, actor)

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1)],
      scopes: { q1: 'questioner' }, // 误传——必须被忽略
      autoStage: true,
      sealedBy: 'u1',
      allowResealFor: ['q1'],
      now: () => 2_000,
    })
    const round = await roundRow(db, taskId)
    const scopes = JSON.parse(round?.questionScopesJson ?? '{}') as Record<string, string>
    expect(scopes.q1).toBe('designer')
  })

  test('AC-8 — 重答后注入面读到新答案（buildClarifyQueueContext 含新不含旧）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1')])
    await sealThenUnstage(db, taskId, originNodeRunId, 'q1', makeAns('q1', 0, 'OLD-MARKER'), 1_000)
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1, 'NEW-MARKER')],
      autoStage: true,
      sealedBy: 'u1',
      allowResealFor: ['q1'],
      now: () => 2_000,
    })
    // 简化的下发面：手动把 self 条目置 dispatched 并 mint 一个承接 rerun（真实 dispatch 路径
    // 由 RFC-133 测试锁定；本断言只锁「注入读 answers_json → 重答后注入新答案」）。
    const rerunId = `nr_rerun_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(nodeRuns).values({
      id: rerunId,
      taskId,
      nodeId: 'designer',
      status: 'running',
      retryIndex: 1,
      iteration: 0,
      preSnapshot: '',
    })
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: 3_000, dispatchedBy: 'u1' })
      .where(
        and(eq(taskQuestions.originNodeRunId, originNodeRunId), eq(taskQuestions.questionId, 'q1')),
      )
    const ctx = await buildClarifyQueueContext({
      db,
      definition: selfDef(),
      taskId,
      consumerNodeId: 'designer',
      dispatchedRunId: rerunId,
      iteration: 0,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.block ?? '').toContain('NEW-MARKER')
    expect(ctx?.block ?? '').not.toContain('OLD-MARKER')
  })
})

describe('RFC-136 — 守卫（rejected 路径不放宽）', () => {
  test('staged（待下发）已答题重 seal → 409 clarify-question-already-sealed（即便 allowReseal）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { originNodeRunId } = await seedSelfRound(db, [makeQ('q1')])
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 0)],
      autoStage: true,
      sealedBy: 'u1',
    })
    await expect(
      sealRoundQuestions({
        db,
        originNodeRunId,
        answers: [makeAns('q1', 1)],
        allowResealFor: ['q1'],
      }),
    ).rejects.toThrow('already sealed')
  })

  test('已下发（dispatched_at 非空）的已答题重 seal → 409（即便 allowReseal）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1')])
    await sealThenUnstage(db, taskId, originNodeRunId, 'q1', makeAns('q1', 0), 1_000)
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: 1_500, dispatchedBy: 'u1' })
      .where(eq(taskQuestions.originNodeRunId, originNodeRunId))
    await expect(
      sealRoundQuestions({
        db,
        originNodeRunId,
        answers: [makeAns('q1', 1)],
        allowResealFor: ['q1'],
      }),
    ).rejects.toThrow('already sealed')
  })

  test('cross 多角色条目仅一行 staged → 整题 409（不产生半新半旧；即便 allowReseal）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1')])
    // designer scope → questioner + designer 双角色条目；autoStage 全 staged。
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 0)],
      scopes: { q1: 'designer' },
      autoStage: true,
      sealedBy: 'u1',
    })
    const dtos = await listTaskQuestions(db, taskId)
    const stagedEntries = dtos.filter((e) => e.staged)
    expect(stagedEntries.length).toBeGreaterThan(1)
    // 直接 UPDATE 单行清 staged_at 构造「半 staged」（stageTaskQuestion 的 unstage 已按题
    // 级联，正常路径不再产生这种形态——这里模拟并发窗口/历史残留），重 seal 整题拒绝。
    await db
      .update(taskQuestions)
      .set({ stagedAt: null, stagedBy: null })
      .where(eq(taskQuestions.id, stagedEntries[0]!.id))
    await expect(
      sealRoundQuestions({
        db,
        originNodeRunId,
        answers: [makeAns('q1', 1)],
        allowResealFor: ['q1'],
      }),
    ).rejects.toThrow('already sealed')
  })

  // 用户 2026-07-02「回答问题的按键又没了」——cross 题两行两张卡，只移出一张留下半
  // staged 题（面板整题排除、重答 409 双死路）。修复：unstage 按 (origin, question) 级联，
  // 一次操作整题回待指派 → 面板可重答。
  test('unstage 级联：cross 双行一张卡移出待下发 → 整题回待指派、可重答', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedCrossRound(db, [makeQ('q1')])
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 0, 'OLD')],
      scopes: { q1: 'designer' },
      autoStage: true,
      sealedBy: 'u1',
    })
    const stagedEntries = (await listTaskQuestions(db, taskId)).filter((e) => e.staged)
    expect(stagedEntries.length).toBeGreaterThan(1)
    // 只对其中一张卡操作「移出待下发」——级联应让同题全部行回 pending。
    await stageTaskQuestion(db, stagedEntries[0]!.id, false, actor)
    const after = await listTaskQuestions(db, taskId)
    expect(after.filter((e) => e.questionId === 'q1' && e.staged)).toHaveLength(0)
    expect(
      after.filter((e) => e.questionId === 'q1' && e.phase === 'pending').length,
    ).toBeGreaterThan(1)
    // 整题回到待指派后，重答放行。
    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 1, 'NEW')],
      autoStage: true,
      sealedBy: 'u1',
      allowResealFor: ['q1'],
    })
    expect(res.resealedQuestionIds).toEqual(['q1'])
  })

  test('golden-lock：纯 fresh 提交 resealedQuestionIds 为空、sealedQuestionIds 语义不变', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { originNodeRunId } = await seedSelfRound(db, [makeQ('q1'), makeQ('q2')])
    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [makeAns('q1', 0)],
      sealedBy: 'u1',
    })
    expect(res.sealedQuestionIds).toEqual(['q1'])
    expect(res.resealedQuestionIds).toEqual([])
    expect(res.roundFullySealed).toBe(false)
  })

  // D7（Codex 实现门 P2 fold）——重答是**按题声明**（allowResealFor）而非路由级布尔：
  // ①quick 通道（autoDispatch）从不声明——其 seal→dispatch 是两段锁 B 临界区，若默认放开
  // 重 seal，并发双提交能在窗口里二次 seal → double mint（rfc128-p5-bc §5.2.14 finding 1）；
  // ②面板提交若落在**他人** quick 提交的窗口里，该题虽 sealed 但面板用户未声明它（打开
  // 面板时它还是未答题）→ 仍 409，不会静默覆盖 in-flight 答案。
  test('未声明的已答题重 seal 仍 409（未传 allowResealFor / 声明了别的题都不放行）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedSelfRound(db, [makeQ('q1')])
    await sealThenUnstage(db, taskId, originNodeRunId, 'q1', makeAns('q1', 0), 1_000)
    // 完全未声明（quick 通道形态）。
    await expect(
      sealRoundQuestions({ db, originNodeRunId, answers: [makeAns('q1', 1)] }),
    ).rejects.toThrow('already sealed')
    // 声明了别的题（跨通道窗口形态：面板以为 q1 是新题、只声明了自己已知的重答题）。
    await expect(
      sealRoundQuestions({
        db,
        originNodeRunId,
        answers: [makeAns('q1', 1)],
        allowResealFor: ['q-other'],
      }),
    ).rejects.toThrow('already sealed')
  })
})
