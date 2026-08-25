// RFC-319 B49 —— HUMAN-20 / 21 / 23 / 24：任务问题看板的四段生命周期。
//
// 看板把一轮反问拆成逐题的「条目」，让人**分批**决定谁来答、什么时候下发。它的每一段
// 都可能静默地卡住整条任务：
//
//   * **暂存不下发**：条目进「待下发」之后，任务仍停在等人上。下发这一步若空转，
//     题目就永远停在那一列——没有报错、没有日志，任务再也不会动。这是这条链上最贵的
//     一种坏法，因为看板上一切看起来都「已经处理过了」。
//   * **人工提问被吞**：人自己写的问题（`manual`）是「我要额外告诉 agent 一件事」的
//     唯一入口。落库了却进不了看板 / 下发不到，那句话就消失了，而人以为自己交代过。
//   * **确认关闭**：承接 run 跑完之后条目停在「已处理待确认」，需要人点一下收尾。
//     确认路径若认错条目，关掉的就是别人的那一条。
//   * **跨任务的条目 id**：拿甲任务的条目 id 去乙任务上操作必须 404。同形处理成
//     「找不到」而不是「无权限」是刻意的——但**不能**变成「悄悄成功」。
//
// 判据一律取「任务状态真的动了没有」，而不是「接口返回 200 了没有」：这一段的所有
// 失效形态都返回 200。
//
// 判据取自源码单一事实源：
//   shared/task-questions.ts:46-56        五个展示态 pending/staged/processing/awaiting_confirm/done
//   routes/taskQuestions.ts:187-204       stage：`staged` 缺省为 true
//   routes/taskQuestions.ts:209-240       dispatch：entryIds 必填，随后释放门、任务继续跑
//   routes/taskQuestions.ts:112-137       manual：人工提问
//   routes/taskQuestions.ts:50-68         gateMemberEntry：条目不属于该任务 ⇒ 404
//   routes/clarify.ts:266-292             defer=true 只封存不下发（B36 已锁），本条从它接力

import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
let repoDir: string
let stubState: string

interface Fixture {
  taskId: string
  nodeRunId: string
  iteration: number
}
let main: Fixture
let other: Fixture

const MANUAL_TITLE = 'rfc319-b49-manual-question'
const MANUAL_BODY = 'rfc319-b49-also-write-the-migration-note'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function raw(
  path: string,
  payload: unknown,
): Promise<{ status: number; code: string | null }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let code: string | null = null
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null
  } catch {
    code = null
  }
  return { status: res.status, code }
}

interface BoardEntry {
  id: string
  questionId: string
  phase: string
  sourceKind: string
  title?: string
}
const board = async (taskId: string): Promise<BoardEntry[]> =>
  api<BoardEntry[]>(`/api/tasks/${taskId}/questions`)

const taskStatus = async (taskId: string): Promise<string> =>
  (await api<{ status: string }>(`/api/tasks/${taskId}`)).status

/**
 * 每个 fixture 自建 agent + 工作流。**不能共用**：clarify stub 的轮次标记文件按
 * agent 名分键，共用一个名字时第二个任务会被当成「已经问过了」，直接出最终输出、
 * 根本不停在等人上（实撞：第二个 fixture 在等待澄清轮的轮询上超时）。
 */
async function makeFixture(slug: string): Promise<Fixture> {
  const workflowId = await createWorkflow(slug)
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-board-${slug}-task`,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: `${slug} order_status enum` },
    }),
  })
  interface Session {
    intermediaryNodeRunId: string
    iteration: number
  }
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(task.id)}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  return {
    taskId: task.id,
    nodeRunId: session!.intermediaryNodeRunId,
    iteration: session!.iteration,
  }
}

async function createWorkflow(slug: string): Promise<string> {
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-board-${slug}`,
      description: 'RFC-319 question board fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-board-${slug}-wf`,
      description: 'RFC-319 question board fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: `rfc319-board-${slug}`,
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'Clarify design',
            position: { x: 560, y: 160 },
          },
        ],
        edges: [
          {
            id: 'e_in_designer',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'designer', portName: 'topic' },
          },
          {
            id: 'e_clarify_ask',
            source: { nodeId: 'designer', portName: '__clarify__' },
            target: { nodeId: 'clarify_1', portName: 'questions' },
          },
          {
            id: 'e_clarify_ans',
            source: { nodeId: 'clarify_1', portName: 'answers' },
            target: { nodeId: 'designer', portName: '__clarify_response__' },
          },
        ],
      },
    }),
  })
  return wf.id
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-board-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 question board fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-board-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  main = await makeFixture('main')
  other = await makeFixture('other')
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('人工提问进得了看板：带来源标记、建出来就待下发，并且把任务扣住 @nightly', async () => {
  const before = await board(main.taskId)
  const created = await api<{ id: string }>(`/api/tasks/${main.taskId}/questions/manual`, {
    method: 'POST',
    body: JSON.stringify({ title: MANUAL_TITLE, body: MANUAL_BODY, targetNodeId: 'designer' }),
  })
  const after = await board(main.taskId)
  expect(after.length, '人工提问必须多出一条').toBe(before.length + 1)
  const row = after.find((e) => e.id === created.id)
  expect(row, '新建的那条要能在看板上找得到——落库但不进看板等于那句话消失了').toBeDefined()
  expect(row!.sourceKind, '来源要标成 manual，否则人分不出哪些是自己加的').toBe('manual')
  // 实测契约（`services/taskQuestions.ts:1383-1387`）：人工提问**故意**建成 `staged`
  // 而不是 `pending`——§15 要求它建出来就有 handler，于是直接进「待下发」，
  // 由 park gate 把任务扣在等人上直到有人下发。第一版按直觉断言 `pending`，当场红。
  expect(row!.phase, '人工提问建出来就该在「待下发」（§15：有 handler ⇒ 直接可下发）').toBe(
    'staged',
  )
  // 真正要锁的是**它把任务扣住了**：建完之后任务必须仍停在等人上。
  // 若不扣，任务会越过这条人工提问径直跑完——那句话就永远不会被处理，而且没人会发现。
  expect(await taskStatus(main.taskId), '人工提问必须把任务扣在等人上').toBe('awaiting_human')
})

test('暂存不等于下发：任务必须仍停在等人上，直到真的下发 @nightly', async () => {
  // 先把整轮封存进看板（控制通道：只封存不下发，见 B36）。
  const entriesBefore = await board(main.taskId)
  const sealed = await raw(`/api/clarify/${main.nodeRunId}/answers`, {
    answers: [
      { questionId: 'q-db', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      {
        questionId: 'q-lang',
        selectedOptionIndices: [0],
        selectedOptionLabels: [],
        customText: '',
      },
    ],
    ifMatchIteration: main.iteration,
    directive: 'stop',
    defer: true,
  })
  expect(sealed.status, `defer seal: ${sealed.code}`).toBe(200)
  expect(await taskStatus(main.taskId), '控制通道封存不该推进任务').toBe('awaiting_human')

  const staged = (await board(main.taskId)).filter((e) => e.phase === 'staged')
  expect(staged.length, '封存后被点名那两题应当进「待下发」').toBeGreaterThanOrEqual(2)
  expect(
    entriesBefore.length,
    '封存前看板里已经有这两题（reconcile 出来的承接条目）',
  ).toBeGreaterThan(0)

  // 空的 entryIds 必须被拒——「下发了个寂寞」在界面上与「下发成功」完全同形。
  const empty = await raw(`/api/tasks/${main.taskId}/questions/dispatch`, { entryIds: [] })
  expect(empty.status).toBe(422)
  expect(empty.code).toBe('entry-ids-required')
  expect(await taskStatus(main.taskId), '被拒的下发不该改变任务状态').toBe('awaiting_human')

  // 真的下发：任务必须离开等人态。
  const ok = await raw(`/api/tasks/${main.taskId}/questions/dispatch`, {
    entryIds: staged.map((e) => e.id),
  })
  expect(ok.status, `dispatch: ${ok.code}`).toBe(200)
  await expect
    .poll(async () => taskStatus(main.taskId), { timeout: 120_000 })
    .not.toBe('awaiting_human')
})

test('跨任务的条目 id：确认 / 暂存都必须 404，而不是悄悄成功 @nightly', async () => {
  const mine = (await board(main.taskId))[0]
  expect(mine, '主任务看板不该是空的').toBeDefined()

  // 拿主任务的条目 id 去操作**另一个**任务。
  for (const action of ['confirm', 'stage'] as const) {
    const res = await raw(`/api/tasks/${other.taskId}/questions/${mine!.id}/${action}`, {})
    expect(res.status, `${action} 跨任务条目必须 404`).toBe(404)
  }
  // 另一个任务的看板一个字节都不该变。
  const otherBoard = await board(other.taskId)
  expect(otherBoard.some((e) => e.id === mine!.id)).toBe(false)
  expect(await taskStatus(other.taskId), '越界操作不该动到别的任务').toBe('awaiting_human')
})

test('承接 run 跑完之后：条目进「已处理待确认」，确认一下才收尾 @nightly', async () => {
  // 上一条用例已经下发过，等承接 run 跑完。
  let target: BoardEntry | undefined
  await expect
    .poll(
      async () => {
        const rows = await board(main.taskId)
        target = rows.find((e) => e.phase === 'awaiting_confirm')
        return target !== undefined
      },
      { timeout: 180_000 },
    )
    .toBe(true)

  const res = await raw(`/api/tasks/${main.taskId}/questions/${target!.id}/confirm`, {})
  expect(res.status, `confirm: ${res.code}`).toBe(200)
  await expect
    .poll(async () => (await board(main.taskId)).find((e) => e.id === target!.id)?.phase, {
      timeout: 60_000,
    })
    .toBe('done')
  // 确认只关掉被点名那一条：把整块一起关掉的实现在这里露出来。
  const others = (await board(main.taskId)).filter((e) => e.id !== target!.id)
  expect(
    others.every((e) => e.phase !== 'done'),
    '确认一条不该顺手把别的条目也关掉',
  ).toBe(true)
})

test('没答过的题不许推进「待下发」；答过之后撤回是**题**级的，动一题不该拖下另一题 @nightly', async () => {
  // 用另一个任务，避免动到上面那条已经下发过的链。
  const rows = await board(other.taskId)
  const qDb = rows.find((e) => e.questionId === 'q-db')
  const qLang = rows.find((e) => e.questionId === 'q-lang')
  expect(qDb, '看板上应当有 q-db 的承接条目').toBeDefined()
  expect(qLang, '看板上应当有 q-lang 的承接条目').toBeDefined()

  // ① 还没答就想推进待下发 ⇒ 必须拒。放行的话，一道**没人答过**的问题会被下发给
  //    agent——它拿到的是一份空答案，产出自然是错的，而看板上写着「已处理」。
  const tooEarly = await raw(`/api/tasks/${other.taskId}/questions/${qDb!.id}/stage`, {})
  expect(tooEarly.status, '未封存的条目不该能进待下发').toBe(409)
  // 被拒之后阶段一个字节不变（先落库再报错同样会返回 409）。逐条比阶段而不是整体深比：
  // 看板行还带 updatedAt 之类的时间戳，整体比会因无关字段红。
  const phasesOf = (list: BoardEntry[]) => list.map((e) => `${e.id}:${e.phase}`).sort()
  expect(phasesOf(await board(other.taskId))).toEqual(phasesOf(rows))

  // ② 走控制通道把两题都封存（autoStage：封存即进待下发，见 B36）。
  const sealed = await raw(`/api/clarify/${other.nodeRunId}/answers`, {
    answers: [
      { questionId: 'q-db', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      {
        questionId: 'q-lang',
        selectedOptionIndices: [1],
        selectedOptionLabels: [],
        customText: '',
      },
    ],
    ifMatchIteration: other.iteration,
    directive: 'stop',
    defer: true,
  })
  expect(sealed.status, `defer seal: ${sealed.code}`).toBe(200)
  const staged = await board(other.taskId)
  expect(staged.find((e) => e.id === qDb!.id)?.phase).toBe('staged')
  expect(staged.find((e) => e.id === qLang!.id)?.phase).toBe('staged')

  // ③ 只把 q-db 撤回。unstage 按**题**级联（同一 originNodeRunId+questionId 的未下发行
  //    一起撤），但**不能**波及另一道题——`services/taskQuestions.ts:1213-1219` 记着那次
  //    用户报障「回答问题的按键又没了」：半 staged 的题会从答题面板上消失且无法重答。
  const un = await raw(`/api/tasks/${other.taskId}/questions/${qDb!.id}/stage`, { staged: false })
  expect(un.status, `unstage: ${un.code}`).toBe(200)
  const after = await board(other.taskId)
  expect(after.find((e) => e.id === qDb!.id)?.phase, '撤回的那题应回到「待指派」').toBe('pending')
  expect(
    after.find((e) => e.id === qLang!.id)?.phase,
    '另一道题不该被顺手撤回——那会让它从答题面板上消失',
  ).toBe('staged')

  // 任务全程不动：封存、暂存、撤回都不推进执行。
  expect(await taskStatus(other.taskId)).toBe('awaiting_human')
})
