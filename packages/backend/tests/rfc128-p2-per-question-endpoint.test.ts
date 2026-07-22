// RFC-128 P2 — 逐题 seal 端点 + defer 意图 + 待下发 gate（先红后绿，route 层）。
//
// P2 在既有 `POST /api/clarify/:nodeRunId/answers` 上加 `defer` + `questionIds`，并给
// `stageTaskQuestion`（→ `POST /api/tasks/:id/questions/:entryId/stage`）加「该题须已 seal」
// gate。本文件锁端点契约（service 级 seal 正确性见 rfc128-p1-per-question-seal.test.ts）：
//
//   T6 defer=true   → 控制通道：seal 子题（sealRoundQuestions, autoStage=true）直接进「待下发/
//                     staged」（用户 2026-07-01），不 mint 续跑、不 resume；response
//                     `{ kind:'seal', sealedQuestionIds, roundFullySealed }`。
//   defer=false/缺省 → 快通道逐字不变（黄金锁）：整轮 answered + 恰好一条 clarify-answer 续跑。
//   T5 questionIds   → 子集帽：只 seal 列出的题（其余答案忽略）。
//   T7 待下发 gate    → stage 未 seal 题 → 409 task-question-not-sealed；已 seal → 200；
//                      unstage 始终允许（仅 stage 方向受门）。
//   鉴权             → 非成员打端点 → 403 not-task-member（ensureClarifyMember）。
//
// Codex 实现 gate 复审（commit b3d2c7e）抓出的 3 个补丁，在此回归：
//   P1   full defer seal → 关闭中介 clarify/cross-clarify node_run（awaiting_human→done），
//        否则 deriveFrontier 永久 park 该 deferred round（看板 dispatch 也解不开）；partial
//        seal 不动 node_run（对照锁）。full cross-designer seal 后任务仍由 §18 designer park
//        把持、可被 dispatchTaskQuestions 续跑。
//   P2-1 questionIds 配 defer!=true → 422（别静默 filter 后走 quick path 把整轮 finalize）。
//   P2-2 defer=true 透传 directive：cross full seal + stop → directive 落库（round+session）
//        且不产 designer 条目（reconcile 跳过）。
//
// 黄金锁：不传 defer/questionIds 的整轮提交语义不变——轮 answered + 恰好一条 clarify-answer 续跑
// （RFC-132 后由统一 autoDispatchClarifyRound 驱动 + resume；legacy immediate mint 已删）。

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
import { createCrossClarifySession, resolveCrossNodeStopped } from '../src/services/crossClarify'
import { loadUndispatchedSelfQuestionerTargets } from '../src/services/taskQuestions'
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
  // Wire questioner → cross1 → designer with the RFC-056/059 ports so the designer-dispatch
  // readiness check (findCrossClarifyNodesPointingToDesigner) sees cross1 feeding designer.
  edges: [
    {
      id: 'e_q_cc',
      source: { nodeId: 'questioner', portName: '__clarify__' },
      target: { nodeId: 'cross1', portName: 'questions' },
    },
    {
      id: 'e_cc_d',
      source: { nodeId: 'cross1', portName: 'to_designer' },
      target: { nodeId: 'designer', portName: '__external_feedback__' },
    },
  ],
  outputs: [],
}

async function seedTaskRow(
  db: DbClient,
  ownerUserId: string,
  def: object,
  _opts: { deferred?: boolean } = {},
): Promise<string> {
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
  opts: { deferred?: boolean } = {},
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = await seedTaskRow(db, ownerUserId, CROSS_DEF, opts)
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
  staged: boolean
}

async function nodeRunStatus(db: DbClient, id: string): Promise<string | undefined> {
  const [r] = await db.select({ status: nodeRuns.status }).from(nodeRuns).where(eq(nodeRuns.id, id))
  return r?.status
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

describe('RFC-128 P2 — T6 defer=true 控制通道 (seal 进待下发/staged, 不续跑)', () => {
  test('partial defer-seal 单题：response kind=seal/roundFullySealed=false；轮 awaiting_human；q1 sealed+staged(autoStage)、q2 未 seal pending；0 续跑', async () => {
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

    // RFC-128 (用户 2026-07-01) AUTO-STAGE: the control channel now seals q1 straight into
    // 待下发 (staged) — sealed=true + staged=true + phase='staged' — so the board's 批量下发全下 can
    // pick it up WITHOUT a manual 移入待下发. q2 stays 未 seal → 待指派 (pending, staged=false)
    // (autoStage only stamps THIS call's sealed subset).
    const list = await listQuestions(h.app, h.alice.token, taskId)
    const q1 = list.find((q) => q.questionId === 'q1')!
    const q2 = list.find((q) => q.questionId === 'q2')!
    expect(q1.sealed).toBe(true)
    expect(q1.staged).toBe(true)
    expect(q1.phase).toBe('staged')
    expect(q2.sealed).toBe(false)
    expect(q2.staged).toBe(false)
    expect(q2.phase).toBe('pending')
  })

  // RFC-132 PR-B (universal deferred model): the P5-0 stranding guard is REMOVED, so a FULL
  // defer-seal of a SELF round through the CONTROL channel now SUCCEEDS (200). It seals + stages +
  // flips the round 'answered' + closes the intermediary node_run, but mints NO rerun (the control
  // channel never dispatches) — the self/questioner park source holds the asking node until the
  // board's 批量下发 mints the continuation. No strand.
  test('P5-0 (removed): 全题 defer-seal SELF 轮 → 200 seal + 轮 answered + 0 续跑（park 等 dispatch）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1'), makeAns('q2')] }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { kind: string }).kind).toBe('seal')
    // Full seal committed: round answered; the control channel mints NO rerun (dispatch does).
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(0)
  })

  // RFC-162: retired — "cross defer-seal 带 scope：route 把 questionScopes 透传落 question_scopes_json".
  // Per-question scope is DELETED: the route schema dropped `questionScopes` and sealRoundQuestions
  // no longer writes question_scopes_json, so there is no passthrough to lock. The partial-seal /
  // no-rerun half is covered by the self partial defer-seal test above.
})

// ---------------------------------------------------------------------------
// RFC-128 P5-BC (route) — control-channel full-seal of self/questioner on a DEFERRED task now
// SUCCEEDS (the P5-0 guard is LIFTED for deferred tasks — §5.2.1). The seal parks the home via
// loadUndispatchedSelfQuestionerTargets until board dispatch mints the continuation → no strand.
//
// Migrated from the P5-0 "→ 409" locks (these are deferred tasks; P5-BC provides the park +
// dispatch release path the guard waited for). The NON-deferred SELF full-seal route locks
// (still 409 — no park source) stay green in the T6 / Codex-P1 blocks. The stop branch's
// questioner continuation now rides the self/questioner park + dispatch (cross-clarify-questioner-
// rerun minted at board dispatch), not the quick-path immediate mint.
// ---------------------------------------------------------------------------

describe('RFC-128 P5-BC (route) — deferred cross full-seal of self/questioner → 200 + park (no strand)', () => {
  test('cross full seal 单题 (deferred) → 200 + 轮 answered + node_run 关 + questioner home parked', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedCrossRound(h.db, h.alice.id, [makeQ('q1')], {
      deferred: true,
    })

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      // RFC-162: scope deleted — a cross full seal parks the questioner home (not strands).
      body: JSON.stringify({ defer: true, answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { roundFullySealed: boolean }).roundFullySealed).toBe(true)
    // Sealed: round answered, intermediary node_run closed; the questioner home is PARKED (the
    // P5-BC self/questioner park source holds the deferred task until board dispatch).
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
    expect(await nodeRunStatus(h.db, nodeRunId)).toBe('done')
    const parked = await loadUndispatchedSelfQuestionerTargets(h.db, taskId)
    expect(parked.has('questioner')).toBe(true)
  })

  // RFC-162: retired — "cross full seal 混合 scope（designer + questioner）→ 两 home 各自 park".
  // Per-question scope is DELETED, so a cross seal never mints a designer entry / a §18 designer park;
  // both questions become questioner entries that park the ONE questioner home. There is no "two homes
  // park" behavior left. The questioner park is locked by the single-question test above.

  test('cross full seal + directive=stop (deferred) → 200 + questioner park（无 designer 条目）', async () => {
    // RFC-162: a cross round produces only the questioner (asker) continuation entry — never a
    // designer entry (scope deleted). On a deferred task that questioner entry parks via the P5-BC
    // park source until board dispatch mints the cross-clarify-questioner-rerun — no strand.
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedCrossRound(h.db, h.alice.id, [makeQ('q1')], {
      deferred: true,
    })

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, directive: 'stop', answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
    expect((await roundOf(h.db, taskId))[0]?.directive).toBe('stop')
    // stop round → no designer entry; the questioner continuation entry parks the questioner home.
    expect((await loadUndispatchedSelfQuestionerTargets(h.db, taskId)).has('questioner')).toBe(true)
  })

  test('对照（照常）：cross full seal + directive=continue → 200 + 轮 answered', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedCrossRound(h.db, h.alice.id, [makeQ('q1')], {
      deferred: true,
    })

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, directive: 'continue', answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { roundFullySealed: boolean }).roundFullySealed).toBe(true)
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
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
    // RFC-132 PR-B: the quick channel is now the unified AUTO-DISPATCH path (autoDispatchClarifyRound).
    // The response is the autodispatch shape; the KEY invariant — round answered + EXACTLY ONE
    // clarify-answer rerun (no double-mint) — is preserved (the dispatch mints it, not a legacy submit).
    const body = (await res.json()) as {
      ok: boolean
      kind: string
      roundKind: string
      reruns: Array<{ nodeRunId: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.kind).toBe('autodispatch')
    expect(body.roundKind).toBe('self')
    expect((body.reruns[0]?.nodeRunId ?? '').length).toBeGreaterThan(0)
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('answered')
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(1) // exactly one, via the single dispatch path
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

// ---------------------------------------------------------------------------
// Codex P1 — full defer seal 关闭中介 node_run（解永久 park）；partial 不动（对照锁）；
// cross-designer 全 seal 后任务由 §18 designer park 把持 + 可被 dispatch 续跑。
// RFC-128 P5-0：full seal 关 node_run 的「解永久 park」逻辑只对 DESIGNER 路径有效（见
// 本块第 3 个 test, cross-designer）；SELF/questioner full seal 会被 P5-0 guard 在 close 之前
// 拒绝（第 1 个 test 锁住「guard 原子回滚、node_run 不被关」），因为它没有 self/q park 源、关了
// 就 strand——self/q 逐题重跑 + park 是 P5-B/C。
// ---------------------------------------------------------------------------

describe('RFC-128 P2 — Codex P1 / P5-0: full defer seal 关闭中介 node_run (designer) vs guard (self/q)', () => {
  // RFC-132 PR-B (universal deferred model): the P5-0 guard is REMOVED — a SELF round full
  // defer-seal now CLOSES the intermediary node_run (same as the DESIGNER path). The self/questioner
  // park source holds the asking node until board dispatch mints the continuation → no strand.
  test('P5-0 (removed): full defer seal SELF 轮 → 200 + 中介 node_run 关（park 等 dispatch，不 strand）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1')])
    expect(await nodeRunStatus(h.db, nodeRunId)).toBe('awaiting_human')

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
    // Full seal closes the intermediary node_run; the control channel mints NO rerun (dispatch does).
    expect(await nodeRunStatus(h.db, nodeRunId)).toBe('done')
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(0)
  })

  test('partial defer seal → 中介 node_run 仍 awaiting_human（对照锁：只 full seal 才关）', async () => {
    const h = await buildHarness()
    const { nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])
    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, answers: [makeAns('q1')] }), // q2 未 seal → partial
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { roundFullySealed: boolean }).roundFullySealed).toBe(false)
    expect(await nodeRunStatus(h.db, nodeRunId)).toBe('awaiting_human') // 不动
  })

  // RFC-162: retired — "full cross-designer defer seal → cross node_run done + §18 designer park +
  // dispatch". A designer entry no longer arises from a designer-scope seal (scope deleted); a cross
  // full seal produces the questioner entry and parks the questioner home. The "full cross seal closes
  // the intermediary node_run + persists directive" half is covered by the P5-BC block above
  // (nodeRunStatus → 'done', directive persisted). The surviving designer-handler dispatch path (via a
  // human reassign + §18 designer park) is locked in rfc120-task-questions-service.test.ts.
})

// ---------------------------------------------------------------------------
// Codex P2-1 — questionIds 须配 defer（否则 422，不静默 filter 后走 quick path）
// ---------------------------------------------------------------------------

describe('RFC-128 P2 — Codex P2-1: questionIds 须配 defer', () => {
  test('questionIds + defer 缺省 → 422 clarify-question-ids-requires-defer（不 finalize、不 mint）', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ questionIds: ['q1'], answers: [makeAns('q1'), makeAns('q2')] }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe(
      'clarify-question-ids-requires-defer',
    )
    // Rejected BEFORE the quick path → round untouched, nothing finalized/minted (the bug:
    // it would have finalized the whole round persisting only q1, stranding q2).
    expect((await roundOf(h.db, taskId))[0]?.status).toBe('awaiting_human')
    expect(await clarifyAnswerReruns(h.db, taskId)).toBe(0)
  })

  test('questionIds + defer=false 显式 → 同样 422', async () => {
    const h = await buildHarness()
    const { nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])
    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: false, questionIds: ['q1'], answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe(
      'clarify-question-ids-requires-defer',
    )
  })
})

// ---------------------------------------------------------------------------
// Codex P2-2 / P5-0 — defer 透传 directive (stop)：
//   - FULL seal + stop（经路由）→ 被 P5-0 guard 拒（409）：cross-stop 在 scope 切分前恒发
//     反问者续跑（crossClarify.ts:534-560），控制通道不发 → strand（Codex PR-1 P1）。
//     「directive 落库 + 无 designer 条目」的原语行为改由 rfc128-p5-0-stranding-guard.test.ts
//     的 raw-primitive（flag 关）service 测锁（控制通道不再 reach 它）。
//   - PARTIAL seal + stop → directive 两表都不提前落（resolveCrossNodeStopped=false，节点不被
//     提前 short-circuit）——partial 仍允许（轮停 awaiting_human）。
// ---------------------------------------------------------------------------

describe('RFC-128 P2/P5-BC — defer 透传 directive (stop): full deferred→200+park, partial→不落 directive', () => {
  test('cross FULL seal + directive=stop（deferred, 经路由）→ 200 + directive=stop 持久化 + node_run 关 + questioner park', async () => {
    const h = await buildHarness()
    const { taskId, nodeRunId } = await seedCrossRound(h.db, h.alice.id, [makeQ('q1')], {
      deferred: true,
    })

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      // RFC-162: scope deleted — directive still threads through defer=true.
      body: JSON.stringify({ defer: true, directive: 'stop', answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { roundFullySealed: boolean }).roundFullySealed).toBe(true)
    // P5-BC: a deferred full seal SUCCEEDS — round answered + directive=stop persisted (both
    // tables) + cross node_run closed. The questioner continuation entry parks the questioner home
    // (P5-BC park source) until board dispatch mints the cross-clarify-questioner-rerun → no strand.
    const [round] = await roundOf(h.db, taskId)
    expect(round?.status).toBe('answered')
    expect(round?.directive).toBe('stop')
    const [legacy] = await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, round!.id))
    expect(legacy?.directive).toBe('stop')
    expect(await nodeRunStatus(h.db, nodeRunId)).toBe('done')
    expect((await loadUndispatchedSelfQuestionerTargets(h.db, taskId)).has('questioner')).toBe(true)
  })

  test('cross PARTIAL seal + directive=stop → 两表 directive 仍 NULL（resolveCrossNodeStopped=false，节点不被提前 short-circuit）', async () => {
    const h = await buildHarness()
    // 2-question round; defer-seal only q1 with stop → PARTIAL (round stays awaiting_human).
    const { taskId, nodeRunId } = await seedCrossRound(
      h.db,
      h.alice.id,
      [makeQ('q1'), makeQ('q2')],
      {
        deferred: true,
      },
    )

    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ defer: true, directive: 'stop', answers: [makeAns('q1')] }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { roundFullySealed: boolean }).roundFullySealed).toBe(false)

    // Directive must NOT be persisted while the round is partial: stop detection reads the
    // questioner node's node-level directive (RFC-132 T7, via resolveCrossNodeStopped), so a
    // premature 'stop' would short-circuit the cross node before q2 is ever answered.
    const [round] = await roundOf(h.db, taskId)
    expect(round?.status).toBe('awaiting_human')
    expect(round?.directive ?? null).toBeNull() // clarify_rounds: not prematurely 'stop'
    const [legacy] = await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, round!.id))
    expect(legacy?.directive ?? null).toBeNull() // legacy session: still NULL
    // node NOT short-circuited (questioner node-level directive not written on a partial seal)
    expect(await resolveCrossNodeStopped(h.db, taskId, 'questioner')).toBe(false)
  })
})
