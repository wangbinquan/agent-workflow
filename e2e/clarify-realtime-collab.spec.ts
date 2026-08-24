// RFC-319 B54 —— HUMAN-12：澄清页的实时协作提示与多标签同步。
//
// 这一屏最危险的状态不是「显示错了」，而是**显示的是一份已经不存在的现实**：
//
//   * 同事在别处改了某题的草稿，而我这一屏毫不知情 —— 我照着自己那份旧内容继续填，
//     两个人各自以为自己在协作，实际在互相覆盖；
//   * 更糟的是同事**把整轮提交了**：我这一屏还是可编辑的表单，我继续打字、点提交，
//     然后拿到一个 409。在那之前我完全没有理由怀疑任何事。
//
// 两种都不需要任何东西「出错」——只要 WS 那一路没接上、或者接上了却没让界面改口，
// 就会发生。而这一段**只有真浏览器 + 真 daemon 才验得出来**：单测里 WS 是假的，
// 组件测试里「不刷新也能变」这个前提根本不存在。
//
// 判据两段，都要求**不刷新页面**：
//   ① 同事改了某题 ⇒ 这一屏出现「谁刚动了哪一题」的提示，且那题的值被采纳过来；
//   ② 同事提交了整轮 ⇒ 这一屏转成只读（两个提交键都禁用）。
//
// 判据取自源码单一事实源：
//   hooks/useClarifyWs.ts:56-63          clarify.draft.updated ⇒ 回调 + 失效聚焦轮
//   hooks/useClarifyWs.ts:64             clarify.answered ⇒ 失效整片澄清面
//   routes/clarify.detail.tsx:390-420    远端草稿在本地未分叉时被采纳（本地编辑者本地优先）
//   routes/clarify.detail.tsx:922-925    「X 刚编辑了第 N 题」提示条
//   routes/clarify.detail.tsx:660        status !== 'awaiting_human' ⇒ readonly

import { expect, test, type Page } from '@playwright/test'
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
  roundId: string
  iteration: number
}
let live: Fixture
let sealed: Fixture
let colleague: SeededUser

const REMOTE_TEXT = 'rfc319-b54-a-colleague-typed-this'

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

interface SeededUser {
  userId: string
  sessionToken: string
}

/**
 * 造一个**真正的第二个人**。这条用例绕不开它：草稿提示条对**自己**的编辑是刻意抑制的
 * （`routes/clarify.detail.tsx:182-184`：`frame.editor.userId === myId` 直接 return），
 * 用同一个身份在「别处」写草稿，界面正确地什么都不显示。第一版正是这么写的、当场红。
 */
async function createUserAndLogin(username: string, password: string): Promise<SeededUser> {
  const created = await api<{ id: string }>('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      displayName: username,
      role: 'admin',
      password,
    }),
  })
  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(loginRes.ok, `login ${username}: ${loginRes.status}`).toBe(true)
  const { sessionToken } = (await loginRes.json()) as { sessionToken: string }
  return { userId: created.id, sessionToken }
}

/** 以某个**会话** token 发请求（成员维护端点 tokenAccess 是 never，API token 用不了）。 */
async function asUser<T>(
  sessionToken: string,
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: T | null = null
  try {
    body = JSON.parse(text) as T
  } catch {
    body = null
  }
  return { status: res.status, body }
}

async function createWorkflow(slug: string): Promise<string> {
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-rtcollab-${slug}`,
      description: 'RFC-319 realtime collab fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-rtcollab-${slug}-wf`,
      description: 'RFC-319 realtime collab fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: `rfc319-rtcollab-${slug}`,
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

async function makeFixture(slug: string): Promise<Fixture> {
  // 每个 fixture 自建 agent：clarify stub 的轮次标记按 agent 名分键（B49 实撞）。
  const workflowId = await createWorkflow(slug)
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-rtcollab-${slug}-task`,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: `${slug} order_status enum` },
    }),
  })
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
    roundId: session!.id,
    iteration: session!.iteration,
  }
}

async function openClarify(page: Page, nodeRunId: string): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}/clarify/${encodeURIComponent(nodeRunId)}`)
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
  await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
    'data-draft-status',
    /saved|local-only/,
  )
}

/** 在这一页上放个哨兵：它还在，就证明这一屏没有被重载过。 */
const plantSentinel = (page: Page) =>
  page.evaluate(() => {
    ;(window as unknown as { __rfc319B54?: number }).__rfc319B54 = 1
  })
const sentinelAlive = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rfc319B54?: number }).__rfc319B54 ?? null)

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-rtcollab-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 realtime collab fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-rtcollab-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })
  live = await makeFixture('live')
  sealed = await makeFixture('sealed')

  // 第二个人 + 任务管理员（成员维护端点只认会话 token）。
  const admin = await createUserAndLogin('rfc319-b54-admin', 'Rfc319-b54-admin!')
  colleague = await createUserAndLogin('rfc319-b54-mate', 'Rfc319-b54-mate!')
  const put = await asUser(admin.sessionToken, `/api/tasks/${live.taskId}/members`, {
    method: 'PUT',
    body: JSON.stringify({ userIds: [colleague.userId] }),
  })
  expect(put.status, `add member: ${JSON.stringify(put.body)}`).toBe(200)
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('同事改了某题：这一屏不刷新就要看见提示，并把那题的值接过来', async ({ page }) => {
  await openClarify(page, live.nodeRunId)
  await plantSentinel(page)
  // 正向对照：此刻还没有任何人动过，提示条不该在。
  await expect(page.getByTestId('clarify-draft-hint')).toHaveCount(0)

  // 「同事」在别处写了 q-db 的草稿（服务端逐题草稿，见 B53）。必须是**另一个人**：
  // 自己的编辑不会反过来提醒自己。
  const wrote = await asUser(colleague.sessionToken, `/api/clarify/${live.nodeRunId}/draft`, {
    method: 'PUT',
    body: JSON.stringify({
      roundId: live.roundId,
      questionId: 'q-db',
      selectedOptionIndices: [],
      customText: REMOTE_TEXT,
    }),
  })
  expect(wrote.status, '同事写草稿应当成功（他已被加为任务协作者）').toBe(200)

  // ① 提示条自己冒出来——WS 那一路没接上时，这一屏会一直显示一份过期的现实。
  await expect(page.getByTestId('clarify-draft-hint'), 'WS 草稿帧没让界面改口').toBeVisible({
    timeout: 30_000,
  })
  // ② 那题的值被采纳（本地没分叉时远端赢）。
  await expect(
    page.getByTestId('clarify-question-q-db').getByTestId('clarify-custom-textarea'),
    '远端草稿没有被采纳进表单',
  ).toHaveValue(REMOTE_TEXT, { timeout: 30_000 })
  // ③ 全程没有重载——「刷新一下就对了」和「它自己会变」是两件事，而用户不会去刷新。
  expect(await sentinelAlive(page), '哨兵不在了 ⇒ 这一屏被重载过，上面两条就不成立').toBe(1)
})

test('同事把整轮提交了：这一屏必须自己转成只读，而不是继续让我打字', async ({ page }) => {
  await openClarify(page, sealed.nodeRunId)
  await plantSentinel(page)
  await expect(page.getByTestId('clarify-submit-continue')).toBeEnabled()

  // 「同事」在别处提交了整轮。
  const res = await fetch(`${daemon.baseUrl}/api/clarify/${sealed.nodeRunId}/answers`, {
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
      ifMatchIteration: sealed.iteration,
      directive: 'stop',
    }),
  })
  expect(res.ok, `submit: ${res.status} ${await res.text()}`).toBe(true)

  // 不刷新就该转只读。没有这一步，我会继续打字、点提交，然后拿到一个 409——
  // 在那之前我完全没有理由怀疑任何事。
  await expect(
    page.getByTestId('clarify-submit-continue'),
    '同事提交之后这一屏还让我继续填',
  ).toBeDisabled({ timeout: 30_000 })
  await expect(page.getByTestId('clarify-submit-stop')).toBeDisabled()
  expect(await sentinelAlive(page), '哨兵不在了 ⇒ 这一屏被重载过').toBe(1)
})
