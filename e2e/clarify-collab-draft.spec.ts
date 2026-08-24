// RFC-319 B53 —— HUMAN-10：反问的服务端逐题协作草稿。
//
// 澄清页是多人共用的一屏，草稿因此不是「我这台机器上的临时状态」，而是**服务端**上
// 逐题共享的东西。它的失效形态全部静默：
//
//   * **粒度写错成「整轮」**：甲在 q-db 上打字，乙在 q-lang 上打字，后写的一方把整轮
//     草稿覆盖掉——先写那位的内容凭空消失，界面上不会有任何提示，他下次刷新才发现。
//     这是这条链上最容易写错也最贵的一处：整轮存一份 JSON 是最自然的实现。
//   * **归属没记 / 记成第一个人**：谁最后动过这一题是「这两条互相矛盾的答案该听谁的」
//     的唯一线索。记错了，讨论就从「问事实」变成「猜是谁」。
//   * **提交之后草稿没冻**：轮次已封存，草稿却还活着——下一次打开页面时它会把已封存的
//     答案**盖回去**，人以为自己看到的是提交出去的那份。
//
// 归属只进审计与界面，**绝不进 agent 提示词**（RFC-099 D7 的隔离不变量），
// 所以这里只从 API 断言，不去提示词里找。
//
// 判据取自源码单一事实源：
//   routes/clarify.ts:471-503        PUT draft：逐题载荷（roundId + questionId + 值）
//   schemas/clarify.ts:446-470       answerAttributions（逐题 {userId, role, updatedAt}）与 draftAnswers
//   schemas/clarify.ts:459-460       「live during drafting, frozen at submit」
//   routes/clarify.detail.tsx:338-345 服务端草稿是协作事实源，载入时压过本地 IDB 副本

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
let taskId: string
let nodeRunId: string
let roundId: string
let iteration: number

const DRAFT_DB = 'rfc319-b53-db-draft'
const DRAFT_LANG = 'rfc319-b53-lang-draft'
const DRAFT_DB_SECOND = 'rfc319-b53-db-draft-rewritten'

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

interface RoundDetail {
  id: string
  status: string
  draftAnswers: Record<string, { selectedOptionIndices: number[]; customText: string }> | null
  answerAttributions: Record<string, { userId: string; role: string; updatedAt: number }> | null
}
const detail = async (): Promise<RoundDetail> => api<RoundDetail>(`/api/clarify/${nodeRunId}`)

const saveDraft = (questionId: string, customText: string, indices: number[] = []) =>
  api<{ ok: boolean }>(`/api/clarify/${nodeRunId}/draft`, {
    method: 'PUT',
    body: JSON.stringify({
      roundId,
      questionId,
      selectedOptionIndices: indices,
      customText,
    }),
  })

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-collabdraft-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 collab draft fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-collabdraft-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-collabdraft-designer',
      description: 'RFC-319 collab draft fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-collabdraft-wf',
      description: 'RFC-319 collab draft fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-collabdraft-designer',
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
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-collabdraft-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  interface Session {
    id: string
    intermediaryNodeRunId: string
    iteration: number
  }
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  nodeRunId = session!.intermediaryNodeRunId
  roundId = session!.id
  iteration = session!.iteration
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('草稿是**逐题**的：写第二题不该把第一题冲掉', async () => {
  const before = await detail()
  expect(before.draftAnswers ?? {}, '一开始还没有任何草稿').toEqual({})

  await saveDraft('q-db', DRAFT_DB)
  await saveDraft('q-lang', DRAFT_LANG, [1])

  const after = await detail()
  // 这是这条链上最容易写错的一处：整轮存一份 JSON 是最自然的实现，
  // 而它会让后写的人把先写的人的内容凭空覆盖掉，且没有任何提示。
  expect(after.draftAnswers?.['q-db']?.customText, '第一题的草稿被第二题冲掉了').toBe(DRAFT_DB)
  expect(after.draftAnswers?.['q-lang']?.customText).toBe(DRAFT_LANG)
  expect(after.draftAnswers?.['q-lang']?.selectedOptionIndices).toEqual([1])
})

test('同一题再写一次：后写的赢，且逐题归属跟着更新', async () => {
  const before = await detail()
  const beforeStamp = before.answerAttributions?.['q-db']?.updatedAt
  expect(beforeStamp, '写过草稿之后该题就应当有归属记录').toBeGreaterThan(0)
  // 另一题的归属戳留作对照：逐题更新才算「逐题」，整轮刷新戳会在这里露出来。
  const otherStamp = before.answerAttributions?.['q-lang']?.updatedAt
  expect(otherStamp).toBeGreaterThan(0)

  await new Promise((r) => setTimeout(r, 1_100))
  await saveDraft('q-db', DRAFT_DB_SECOND)

  const after = await detail()
  expect(after.draftAnswers?.['q-db']?.customText, '同题后写的应当赢').toBe(DRAFT_DB_SECOND)
  expect(
    after.answerAttributions?.['q-db']?.updatedAt,
    '「谁最后动过这一题」是讨论时唯一的线索，必须跟着更新',
  ).toBeGreaterThan(beforeStamp!)
  expect(
    after.answerAttributions?.['q-lang']?.updatedAt,
    '没被动过的那一题，归属戳不该跟着刷新',
  ).toBe(otherStamp)
  // 没被动的那题草稿也要原样在。
  expect(after.draftAnswers?.['q-lang']?.customText).toBe(DRAFT_LANG)
})

test('提交之后草稿必须冻住：否则它会把已封存的答案盖回去', async () => {
  const res = await fetch(`${daemon.baseUrl}/api/clarify/${nodeRunId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-db',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
        {
          questionId: 'q-lang',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      ifMatchIteration: iteration,
      directive: 'stop',
    }),
  })
  expect(res.ok, `submit: ${res.status} ${await res.text()}`).toBe(true)

  const after = await detail()
  expect(after.status).toBe('answered')
  // 服务端草稿是载入时的协作事实源、会压过本地副本；封存之后它若还活着，
  // 下一次打开页面就会用一份**没被提交**的内容盖住真正提交出去的那份。
  expect(after.draftAnswers ?? null, '提交之后逐题草稿必须清空').toBeNull()
  // 归属则相反：它是审计线索，冻在提交那一刻、不该被一起抹掉。
  expect(
    after.answerAttributions?.['q-db']?.userId,
    '归属是审计线索，提交后应当冻结保留而不是抹掉',
  ).toBeTruthy()
})
