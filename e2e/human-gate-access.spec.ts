// RFC-319 B13 —— 人机门的可见性与作答权（HUMAN-09 / HUMAN-32）。
//
// 反问与评审是**任务内部的对话**：问题正文里通常有设计取舍、目录结构、甚至
// 待办清单，评审面里直接摊着产物 diff。它们的边界有两层，两层都不响亮：
//
//   * 读面漏 ⇒ 陌生人能读到别人任务里的问题与产物；更糟的是错误码本身会泄露
//     「这个 id 存在」，让人可以拿 id 空间去枚举任务。
//   * 写面漏 ⇒ 非任务成员能替别人作答 / 拍板。反问的答案会直接进下一次
//     agent prompt，评审的决定会推动任务往下走——两者都没有二次确认。
//
// 判据取自源码单一事实源：
//   `ensureClarifyVisible`（routes/clarify.ts:90，RFC-285 B1：**不可见 ≡ 不存在**，
//     且同形基准是 detail 端点对真缺失产出的那个形状）；
//   `ensureClarifyMember`（clarify.ts:54）/ `ensureReviewMember`（reviews.ts）
//     —— 作答与拍板要求任务成员（或管理档）。
//
// 编排沿用 `clarify.spec.ts` 的 stub designer：它第一轮抛问题、任务停在
// awaiting_human，正好给出一个真实的反问门；下游 review 节点给出评审门。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const PASSWORD = 'Rfc319HumanGatePass!1'
/** 一个语法合法但绝不存在的 node_run id —— 「从来没有过」那一侧的对照。 */
const NEVER_EXISTED = '01JZZZZZZZZZZZZZZZZZZZZZZZ'

let daemon: DaemonHandle
let repoDir: string
let stubState: string
let taskId: string
let clarifyNodeRunId: string

/**
 * 存在性不可区分的判据。
 *
 * 拒绝正文里会回显**调用方自己送进去的那个 id**（`no clarify_round for
 * intermediary node_run <id>`）——那不是泄露：他本来就知道自己问的是谁。
 * 所以比较前先把各自的 id 归一成同一个占位符；剩下任何一处差异，都意味着
 * 「存在但看不见」和「从来没有过」在服务端是两种可分辨的状态，也就意味着
 * 一个人可以拿 id 空间去枚举别人的任务。
 */
function normalizeRefusal(body: string, askedId: string): string {
  return body.split(askedId).join('<asked-id>')
}

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function stranger(): Promise<string> {
  const username = `rfc319-outsider-${Date.now().toString(36)}${Math.floor(performance.now())}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: PASSWORD,
      }),
    }),
    `seed ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

test.beforeAll(async () => {
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-gate-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-gate-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 human gate fixture\n', 'utf-8')
  initGitRepo(repoDir)

  const agentName = 'rfc319-gate-designer'
  const agent = await jsonOf<{ id: string }>(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: agentName,
        description: 'RFC-319 human-gate designer',
        outputs: ['design'],
        outputKinds: { design: 'markdown' },
        readonly: true,
        bodyMd: 'Stub designer for the RFC-319 human-gate access spec.',
      }),
    }),
    'create agent',
  )

  const workflow = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-human-gate-access',
        description: 'RFC-319 B13 fixture.',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentId: agent.id,
              agentName,
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'clarify_1',
              kind: 'clarify',
              title: 'Clarify design',
              description: 'Designer asks before producing the doc.',
              position: { x: 560, y: 160 },
            },
            {
              id: 'review_design',
              kind: 'review',
              title: 'review design',
              description: '',
              inputSource: { nodeId: 'designer', portName: 'design' },
              rerunnableOnReject: [],
              rerunnableOnIterate: [],
              rollbackFilesOnReject: false,
              rollbackFilesOnIterate: false,
              position: { x: 640, y: 0 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'doc', bind: { nodeId: 'review_design', portName: 'approved_doc' } }],
              position: { x: 960, y: 0 },
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
            {
              id: 'e_designer_review',
              source: { nodeId: 'designer', portName: 'design' },
              target: { nodeId: 'review_design', portName: '__review_input__' },
            },
            {
              id: 'e_review_out',
              source: { nodeId: 'review_design', portName: 'approved_doc' },
              target: { nodeId: 'out_1', portName: 'doc' },
            },
          ],
        },
      }),
    }),
    'create workflow',
  )

  const launched = await jsonOf<{ id: string }>(
    await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow.id,
        name: 'rfc319-human-gate-task',
        repoUrl: repoRemoteUrl(repoDir),
        ref: 'main',
        inputs: { topic: 'order_status enum' },
      }),
    }),
    'launch task',
  )
  taskId = launched.id

  // 等任务停在反问门上。这个等待是**前提**：没有真门，下面所有的隔离断言
  // 都会因为「本来就没有东西」而平凡通过。
  const deadline = Date.now() + 90_000
  let rows: Array<{ intermediaryNodeRunId: string }> = []
  while (Date.now() < deadline) {
    const res = await req(`/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`)
    if (res.ok) {
      rows = (await res.json()) as typeof rows
      if (rows.length > 0) break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  expect(rows.length, '任务没有停在反问门上 —— 后面的隔离断言将无从证明').toBeGreaterThan(0)
  clarifyNodeRunId = rows[0]!.intermediaryNodeRunId
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const dir of [repoDir, stubState]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// HUMAN-09 —— 反问：陌生人读不到（与不存在同形），也答不了
// ---------------------------------------------------------------------------

test('RFC-319 HUMAN-09: a clarify gate is invisible to non-members — byte-identical to one that never existed — and only a task member can answer it', async () => {
  const outsider = await stranger()

  // 前提：这个门对任务成员是真实存在的。
  const owner = await req(`/api/clarify/${clarifyNodeRunId}`)
  expect(owner.status, '任务成员自己都读不到这个门').toBe(200)

  // 读面：不可见 ≡ 不存在。两次响应必须**逐字节相同**——只比状态码不够，
  // 错误码 / message 里任何一处差异都足以把「这个 id 存在」告诉调用方。
  const hidden = await req(`/api/clarify/${clarifyNodeRunId}`, undefined, outsider)
  const absent = await req(`/api/clarify/${NEVER_EXISTED}`, undefined, outsider)
  expect(hidden.status).toBe(absent.status)
  expect(
    normalizeRefusal(await hidden.text(), clarifyNodeRunId),
    '「存在但看不见」与「从来没有过」的响应不同 ⇒ 可以拿 id 空间枚举别人的任务',
  ).toBe(normalizeRefusal(await absent.text(), NEVER_EXISTED))

  // 列表面同样不得出现。
  const listed = (
    await jsonOf<Array<{ intermediaryNodeRunId: string }>>(
      await req(`/api/clarify?status=awaiting_human`, undefined, outsider),
      'outsider lists clarify gates',
    )
  ).map((row) => row.intermediaryNodeRunId)
  expect(listed, '别人任务的反问门出现在陌生人的待办里').not.toContain(clarifyNodeRunId)

  // 写面：陌生人不能作答。答案会直接进下一次 agent prompt，没有二次确认。
  const answered = await req(
    `/api/clarify/${clarifyNodeRunId}/answers`,
    {
      method: 'POST',
      body: JSON.stringify({
        answers: [
          {
            questionId: 'q-db',
            selectedOptionIndices: [1],
            selectedOptionLabels: [],
            customText: 'injected by an outsider',
          },
        ],
      }),
    },
    outsider,
  )
  expect(answered.ok, '陌生人替别人回答了反问 ⇒ 他写的内容会直接进下一次 agent prompt').toBe(false)

  // 门还在原地：既没被推进，也没被污染。
  const stillOpen = await jsonOf<{ answers?: unknown[] }>(
    await req(`/api/clarify/${clarifyNodeRunId}`),
    're-read the gate',
  )
  expect(JSON.stringify(stillOpen)).not.toContain('injected by an outsider')
})

// ---------------------------------------------------------------------------
// HUMAN-32 —— 评审：同样的两层边界
// ---------------------------------------------------------------------------

test('RFC-319 HUMAN-32: a review gate answers a stranger exactly as it answers someone asking about an id that never existed, and a stranger cannot decide', async () => {
  const outsider = await stranger()

  const hidden = await req(`/api/reviews/${clarifyNodeRunId}`, undefined, outsider)
  const absent = await req(`/api/reviews/${NEVER_EXISTED}`, undefined, outsider)
  expect(hidden.status).toBe(absent.status)
  expect(
    normalizeRefusal(await hidden.text(), clarifyNodeRunId),
    '评审面的「看不见」与「不存在」响应不同 ⇒ 同样可以枚举',
  ).toBe(normalizeRefusal(await absent.text(), NEVER_EXISTED))

  // 待办列表不得包含别人任务的评审。
  const listed = (
    await jsonOf<Array<{ taskId: string }>>(
      await req('/api/reviews?status=pending', undefined, outsider),
      'outsider lists reviews',
    )
  ).map((row) => row.taskId)
  expect(listed, '别人任务的评审出现在陌生人的待办里').not.toContain(taskId)

  // 拍板同样要求任务成员：评审决定会推动任务往下走。
  const decided = await req(
    `/api/reviews/${clarifyNodeRunId}/decision`,
    { method: 'POST', body: JSON.stringify({ decision: 'approved', reviewIteration: 0 }) },
    outsider,
  )
  expect(decided.ok, '陌生人替别人拍了评审 ⇒ 任务会带着未经审阅的产物继续往下走').toBe(false)
})
