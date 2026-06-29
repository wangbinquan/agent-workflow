// RFC-128 P2 — 逐题 seal 端点 + defer 意图 + 待下发 gate（先红后绿，route 层）。
//
// P2 在既有 `POST /api/clarify/:nodeRunId/answers` 上加 `defer` + `questionIds`，并给
// `stageTaskQuestion`（→ `POST /api/tasks/:id/questions/:entryId/stage`）加「该题须已 seal」
// gate。本文件锁端点契约（service 级 seal 正确性见 rfc128-p1-per-question-seal.test.ts）：
//
//   T6 defer=true   → 控制通道：seal 子题（sealRoundQuestions）进「待指派」，不 mint 续跑、
//                     不 resume；response `{ kind:'seal', sealedQuestionIds, roundFullySealed }`。
//   defer=false/缺省 → 快通道逐字不变（黄金锁）：整轮 answered + 恰好一条 clarify-answer 续跑。
//   T5 questionIds   → 子集帽：只 seal 列出的题（其余答案忽略）。
//   T7 待下发 gate    → stage 未 seal 题 → 409 task-question-not-sealed；已 seal → 200；
//                      unstage 始终允许（仅 stage 方向受门）。
//   鉴权             → 非成员打端点 → 403 not-task-member（ensureClarifyMember）。
//
// 黄金锁：不传 defer/questionIds 的整轮提交与今天逐字一致（仍走 submitClarifyAnswers + resume）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createSession } from '../src/auth/sessionStore'
import { createUser } from '../src/services/users'
import { createClarifySession } from '../src/services/clarify'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string } // regular user — task owner / member
  carol: { id: string; token: string } // regular user — stranger (non-member)
}

async function buildHarness(): Promise<Harness> {
  process.env.AGENT_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc128-p2-home-'))
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  async function mkUser(username: string) {
    const u = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return { db, app, alice: await mkUser('alice'), carol: await mkUser('carol') }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

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

const SELF_DEF = {
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' },
    { id: 'c1', kind: 'clarify', title: 'Clarify' },
  ],
  edges: [],
  outputs: [],
}

const CROSS_DEF = {
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

async function seedTaskRow(db: DbClient, ownerUserId: string, def: object): Promise<string> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: (def as { $schema_version: number }).$schema_version,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    ownerUserId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p2',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

/** Seed a self clarify round owned by `ownerUserId`; returns task + the clarify node-run id
 *  (= the `:nodeRunId` the answers/seal endpoint keys on = origin/intermediary id). */
async function seedSelfRound(
  db: DbClient,
  ownerUserId: string,
  questions: ClarifyQuestion[],
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = await seedTaskRow(db, ownerUserId, SELF_DEF)
  const sourceRunId = ulid()
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
    clarifyNodeId: 'c1',
    iterationIndex: 0,
    questions,
  })
  return { taskId, nodeRunId: clarifyNodeRunId }
}

/** Seed a cross clarify round owned by `ownerUserId`; returns task + the cross node-run id. */
async function seedCrossRound(
  db: DbClient,
  ownerUserId: string,
  questions: ClarifyQuestion[],
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = await seedTaskRow(db, ownerUserId, CROSS_DEF)
  const questionerRunId = ulid()
  await db.insert(nodeRuns).values([
    { id: questionerRunId, taskId, nodeId: 'questioner', status: 'done', iteration: 0 },
    { id: ulid(), taskId, nodeId: 'designer', status: 'done', iteration: 0, preSnapshot: 'stub' },
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
  return { taskId, nodeRunId: crossClarifyNodeRunId }
}

function roundOf(db: DbClient, taskId: string) {
  return db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
}

async function clarifyAnswerReruns(db: DbClient, taskId: string): Promise<number> {
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  return rows.filter((r) => r.rerunCause === 'clarify-answer').length
}

interface ListedQuestion {
  id: string
  questionId: string
  roleKind: string
  phase: string
  sealed: boolean
}

async function listQuestions(app: Hono, token: string, taskId: string): Promise<ListedQuestion[]> {
  const res = await req(app, token, `/api/tasks/${taskId}/questions`)
  expect(res.status).toBe(200)
  return (await res.json()) as ListedQuestion[]
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterEach(() => {
  resetBroadcastersForTests()
})

// ---------------------------------------------------------------------------
// T6 — defer=true → control channel: seal subset, 进待指派, 不续跑/不 resume
// ---------------------------------------------------------------------------

describe('RFC-128 P2 — T6 defer=true 控制通道 (seal 进待指派, 不续跑)', () => {
  test('partial defer-seal 单题：response kind=seal/roundFullySealed=false；轮 awaiting_human；q1 sealed+pending、q2 未 seal；0 续跑', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1', 1)] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      kind: string
      sealedQuestionIds: string[]
      roundFullySealed: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('seal')
    expect(body.sealedQuestionIds).toEqual(['q1'])
    expect(body.roundFullySealed).toBe(false)

    // 轮不翻（partial 派生态）。
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('awaiting_human')
    // 控制通道 NOT mint 续跑（defer 的全部意义）。
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(0)

    // q1 进「待指派」(pending) 且 sealed=true；q2 仍 未 seal、pending。
    const list = await listQuestions(h.app, h.alice.token, taskId)
    const q1 = list.find((q) => q.questionId === 'q1')!
    const q2 = list.find((q) => q.questionId === 'q2')!
    expect(q1.sealed).toBe(true)
    expect(q1.phase).toBe('pending')
    expect(q2.sealed).toBe(false)
    expect(q2.phase).toBe('pending')
  })

  test('全题 defer-seal：roundFullySealed=true、轮 answered，但仍 0 续跑（defer 不 mint）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1'), makeAns('q2')] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { roundFullySealed: boolean; kind: string }
    expect(body.kind).toBe('seal')
    expect(body.roundFullySealed).toBe(true)
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
    // Even a FULL defer seal does not advance execution — that is what separates it from
    // the quick channel (which would mint exactly one rerun here).
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(0)
  })

  test('cross defer-seal 带 scope：route 把 questionScopes 透传给 sealRoundQuestions（落 question_scopes_json）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedCrossRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        defer: true,
        answers: [makeAns('q1')],
        questionScopes: { q1: 'questioner' },
      }),
    })
    expect(res.status).toBe(200)
    const [round] = await roundOf(h.db, taskId)
    const scopes = JSON.parse(round?.questionScopesJson ?? '{}') as Record<string, string>
    expect(scopes.q1).toBe('questioner')
    expect(round?.status).toBe('awaiting_human') // q2 未 seal → partial
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// defer=false / 缺省 → 快通道逐字不变（黄金锁）
// ---------------------------------------------------------------------------

describe('RFC-128 P2 — defer=false/缺省 快通道逐字不变 (黄金锁)', () => {
  test('不传 defer/questionIds：整轮 submit → 轮 answered + 恰好一条 clarify-answer 续跑（=今天）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ answers: [makeAns('q1', 1), makeAns('q2', 0)] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      kind?: string
      session: { status: string }
      rerunNodeRunId: string
    }
    expect(body.ok).toBe(true)
    expect(body.kind).toBeUndefined() // self quick channel → no 'seal'/'cross' tag
    expect(body.session.status).toBe('answered')
    expect(body.rerunNodeRunId.length).toBeGreaterThan(0)
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(1) // quick channel mints exactly one
  })

  test('显式 defer=false：与缺省一致（轮 answered + 一条续跑）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: false, answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// T5 — questionIds 子集帽
// ---------------------------------------------------------------------------

describe('RFC-128 P2 — T5 questionIds 子集帽', () => {
  test('defer=true + questionIds 只含 q1：即便 answers 带 q1+q2，也只 seal q1', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        defer: true,
        questionIds: ['q1'],
        answers: [makeAns('q1'), makeAns('q2')], // q2 应被子集帽过滤掉
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sealedQuestionIds: string[]; roundFullySealed: boolean }
    expect(body.sealedQuestionIds).toEqual(['q1'])
    expect(body.roundFullySealed).toBe(false) // q2 没被 seal → 轮未满
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('awaiting_human')

    const list = await listQuestions(h.app, h.alice.token, taskId)
    expect(list.find((q) => q.questionId === 'q1')!.sealed).toBe(true)
    expect(list.find((q) => q.questionId === 'q2')!.sealed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T7 — 待下发 gate（stage 须先 seal）
// ---------------------------------------------------------------------------

describe('RFC-128 P2 — T7 待下发 gate (stage 须先 seal)', () => {
  test('stage 未 seal 题 → 409 task-question-not-sealed；stage 已 seal 题 → 200', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])
    // defer-seal q1 only (round stays awaiting_human; q2 stays unsealed).
    await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1')] }),
    })
    const list = await listQuestions(h.app, h.alice.token, taskId)
    const q1 = list.find((q) => q.questionId === 'q1')!
    const q2 = list.find((q) => q.questionId === 'q2')!

    // q2 not sealed → stage rejected (gate).
    const bad = await req(h.app, h.alice.token, `/api/tasks/${taskId}/questions/${q2.id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ staged: true }),
    })
    expect(bad.status).toBe(409)
    expect(((await bad.json()) as { code: string }).code).toBe('task-question-not-sealed')

    // q1 sealed → stage accepted.
    const ok = await req(h.app, h.alice.token, `/api/tasks/${taskId}/questions/${q1.id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ staged: true }),
    })
    expect(ok.status).toBe(200)
    const after = await listQuestions(h.app, h.alice.token, taskId)
    expect(after.find((q) => q.questionId === 'q1')!.phase).toBe('staged')
  })

  test('unstage 始终允许（仅 stage 方向受门）：未 seal 题可 staged=false', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])
    await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1')] }),
    })
    const q2 = (await listQuestions(h.app, h.alice.token, taskId)).find(
      (q) => q.questionId === 'q2',
    )!
    // staged=false on an unsealed question must NOT be gated (un-stage is always allowed).
    const res = await req(h.app, h.alice.token, `/api/tasks/${taskId}/questions/${q2.id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ staged: false }),
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 鉴权 — 非成员打端点 → 403（ensureClarifyMember）
// ---------------------------------------------------------------------------

describe('RFC-128 P2 — 端点鉴权 403 (ensureClarifyMember)', () => {
  test('非成员 defer=true → 403 not-task-member（且不 seal、不 mint）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.carol.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('not-task-member')
    // Gate ran BEFORE any seal → round untouched, no rerun.
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('awaiting_human')
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(0)
  })

  test('非成员 defer=false (快通道) → 同样 403', async () => {
    const h = await buildHarness()
    const { nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1')])
    const res = await req(h.app, h.carol.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('not-task-member')
  })

  test('成员 (owner) defer=true → 200（对照组：同 round 鉴权放行）', async () => {
    const h = await buildHarness()
    const { nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])
    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
  })
})
