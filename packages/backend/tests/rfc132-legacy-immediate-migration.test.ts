// RFC-132 PR-D' 步骤0 — reconcileLegacyImmediateRounds 迁移垫片。
//
// 锁定 design §13 更正① 的丢答案缺口 + 修复：PR-C 删了 PR-B 的 `buildPromptContext`
// fallback，而 `selectAgentQueue` 要 `dispatched_at IS NOT NULL AND sealed_at IS NOT NULL`。
// ⇒ 升级前 answered、其 self/questioner continuation 仍在飞、但 entry 没打 dispatched_at 的
// 遗留 round，恢复后 selectAgentQueue 注入空 → agent 看不到用户答案 → 丢答案。此垫片补
// sealed+dispatched + 把 trigger_run_id 绑到【已存在】的 continuation run（不新 mint），令
// buildClarifyQueueContext 能重新选中并注入。
//
// 这些是直接 DB fixture（迁移垫片在 boot 跑，不经 scheduler）。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
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
import { reconcileLegacyImmediateRounds } from '../src/services/clarifyMigration'
import { selectAgentQueue } from '../src/services/clarifyQueue'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const P = 'P' // self-asking agent / consumer
const Q = 'Q' // cross questioner agent / consumer
const D = 'D' // designer
const CL = 'CL' // self clarify node
const CC = 'CC' // cross-clarify node

function opt(label: string) {
  return { label, description: '', recommended: false, recommendationReason: '' }
}
function mkQ(id: string, title: string): ClarifyQuestion {
  return { id, title, kind: 'single', recommended: false, options: [opt('A'), opt('B')] }
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
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw-rfc132-mig',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: {
    status?: string
    iteration?: number
    hasOutput?: boolean
    rerunCause?: string
    parentNodeRunId?: string | null
  } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: over.iteration ?? 0,
    ...(over.rerunCause ? { rerunCause: over.rerunCause as 'clarify-answer' } : {}),
    ...(over.parentNodeRunId ? { parentNodeRunId: over.parentNodeRunId } : {}),
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

/** Seed an answered clarify round; returns its intermediary node_run id (= entries' originNodeRunId). */
async function seedAnsweredRound(
  db: DbClient,
  taskId: string,
  opts: {
    kind: 'self' | 'cross'
    askingNodeId: string
    questions: ClarifyQuestion[]
    iteration?: number
  },
): Promise<string> {
  const askingRunId = await seedRun(db, taskId, opts.askingNodeId, {
    status: 'awaiting_human',
    iteration: opts.iteration ?? 0,
  })
  const intRunId = await seedRun(db, taskId, opts.kind === 'self' ? CL : CC, {
    status: 'awaiting_human',
  })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: opts.kind,
    askingNodeId: opts.askingNodeId,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: opts.kind === 'self' ? CL : CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: opts.kind === 'cross' ? D : null,
    iteration: opts.iteration ?? 0,
    questionsJson: JSON.stringify(opts.questions),
    answersJson: JSON.stringify(opts.questions.map((q) => ans(q.id))),
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
  })
  return intRunId
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  defaultTargetNodeId: string | null
  sealed?: boolean
  dispatchedAt?: number | null
  triggerRunId?: string | null
}

async function insertEntry(db: DbClient, taskId: string, e: EntrySeed): Promise<string> {
  const id = ulid()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: e.questionId,
    sourceKind: e.roleKind === 'self' ? 'self' : 'cross',
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    sealedAt: e.sealed ? Date.now() : null,
    sealedBy: e.sealed ? 'u1' : null,
    dispatchedAt: e.dispatchedAt ?? null,
    dispatchedBy: e.dispatchedAt ? 'u1' : null,
    triggerRunId: e.triggerRunId ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

function entryRow(db: DbClient, id: string) {
  return db.select().from(taskQuestions).where(eq(taskQuestions.id, id))
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-132 PR-D 步骤0 — reconcileLegacyImmediateRounds', () => {
  test('复现+修复：遗留 answered-无-dispatched self round → reconcile 前注入空、后注入答案', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'DB choice')],
    })
    // 升级前 mint 的 self continuation，仍在飞（running）。
    const continuation = await seedRun(db, taskId, P, {
      status: 'running',
      rerunCause: 'clarify-answer',
    })
    // 遗留 entry：answered 轮生成，但 immediate 路径从没打 dispatched_at / 逐题 seal。
    const entryId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: false,
      dispatchedAt: null,
    })

    // BEFORE：selectAgentQueue 注入空 —— 复现 HEAD 丢答案缺口。
    const before = await selectAgentQueue({
      db,
      taskId,
      consumerNodeId: P,
      dispatchedRunId: continuation,
    })
    expect(before).toHaveLength(0)

    // reconcile（幂等一次性垫片）。
    const r = await reconcileLegacyImmediateRounds(db)
    expect(r.reconciled).toBe(1)
    expect(r.skipped).toBe(0)

    // entry 现在 sealed + dispatched + 绑到已存在的 continuation（不新 mint）。
    const row = (await entryRow(db, entryId))[0]!
    expect(row.dispatchedAt).not.toBeNull()
    expect(row.sealedAt).not.toBeNull()
    expect(row.triggerRunId).toBe(continuation)

    // AFTER：selectAgentQueue 注入完整答案 —— 修复。
    const after = await selectAgentQueue({
      db,
      taskId,
      consumerNodeId: P,
      dispatchedRunId: continuation,
    })
    expect(after).toHaveLength(1)
    const render = after[0]!.render
    expect('question' in render && render.question.title).toBe('DB choice')
    expect('question' in render && render.answer?.selectedOptionLabels).toEqual(['A'])
  })

  test('幂等：二次 reconcile 不再命中', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'DB choice')],
    })
    await seedRun(db, taskId, P, { status: 'running', rerunCause: 'clarify-answer' })
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      dispatchedAt: null,
    })
    expect((await reconcileLegacyImmediateRounds(db)).reconciled).toBe(1)
    const second = await reconcileLegacyImmediateRounds(db)
    expect(second.reconciled).toBe(0)
    expect(second.skipped).toBe(0)
  })

  test('不变式②：无 continuation run → skip，不制造半状态（entry 仍 undispatched）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'DB choice')],
    })
    // NO continuation run seeded（数据已损 / GC）。
    const entryId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      dispatchedAt: null,
    })
    const r = await reconcileLegacyImmediateRounds(db)
    expect(r.reconciled).toBe(0)
    expect(r.skipped).toBe(1)
    // entry 未被半改：仍 undispatched（不变式②）。
    const row = (await entryRow(db, entryId))[0]!
    expect(row.dispatchedAt).toBeNull()
    expect(row.triggerRunId).toBeNull()
  })

  test('不碰新数据：已 dispatched 的 entry 不动（PR-B 后的正常态）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'self',
      askingNodeId: P,
      questions: [mkQ('q1', 'DB choice')],
    })
    const priorRun = await seedRun(db, taskId, P, { status: 'running' })
    const already = Date.now() - 5000
    const entryId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'self',
      defaultTargetNodeId: P,
      sealed: true,
      dispatchedAt: already,
      triggerRunId: priorRun,
    })
    const r = await reconcileLegacyImmediateRounds(db)
    expect(r.reconciled).toBe(0)
    // 原 trigger / dispatched 未被覆盖。
    const row = (await entryRow(db, entryId))[0]!
    expect(row.triggerRunId).toBe(priorRun)
    expect(row.dispatchedAt).toBe(already)
  })

  test('cross round：questioner entry 补 + 绑 questioner continuation', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const origin = await seedAnsweredRound(db, taskId, {
      kind: 'cross',
      askingNodeId: Q,
      questions: [mkQ('cq', 'Cross Q')],
    })
    const continuation = await seedRun(db, taskId, Q, {
      status: 'running',
      rerunCause: 'cross-clarify-questioner-rerun',
    })
    const entryId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'cq',
      roleKind: 'questioner',
      defaultTargetNodeId: Q,
      dispatchedAt: null,
    })
    const r = await reconcileLegacyImmediateRounds(db)
    expect(r.reconciled).toBe(1)
    const row = (await entryRow(db, entryId))[0]!
    expect(row.triggerRunId).toBe(continuation)
    // questioner 队列现在注入。
    const q = await selectAgentQueue({
      db,
      taskId,
      consumerNodeId: Q,
      dispatchedRunId: continuation,
    })
    expect(q).toHaveLength(1)
  })
})
