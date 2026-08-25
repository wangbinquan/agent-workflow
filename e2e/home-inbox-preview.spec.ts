// RFC-319 B64 —— HUMAN-X3：首页那块「等你处理」在**真实待办**下的样子。
//
// 首页这块预览是绝大多数人每天第一眼看到的东西。它错了不会报错，只会让人「今天没
// 什么事」——而任务正停在等人回答上。三条契约：
//
//   1. **两个来源都要进来**。它合的是评审与澄清两条 feed（`lib/homepage.ts:102-150`）。
//      少合一条，那一类待办就整类消失——不是显示错，是**完全看不见**。
//   2. **点得进去**。行是按钮，点了要落到那条待办自己的详情页；落错页面比不给点更糟，
//      人会以为自己已经处理过了。
//   3. **一条 feed 挂了不许把另一条也吞掉**。两条 feed 各自可能失败；失败时要能分辨是
//      哪一条挂了并能重试，而**另一条的待办要照常显示**——否则一个小故障就让人以为
//      全部清空了。
//
// 判据取自源码单一事实源：
//   components/home/InboxPreviewList.tsx:40-49   两条 feed：/api/reviews?status=pending 与 /api/clarify?status=awaiting_human
//   lib/homepage.ts:102-150                       合并 + 按时间倒序 + rowKey（评审用 nodeRunId、澄清用 round id）
//   components/home/InboxPreviewList.tsx:170-190  行是按钮，点击按 kind 落到各自详情页
//   components/home/InboxPreviewList.tsx:110-165  partial（还有数据）出可重试的 warning 条；全挂才是 ErrorBanner

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
let clarifyRoundId: string
let clarifyNodeRunId: string
let reviewNodeRunId: string

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

function seedAuth(page: Page): Promise<void> {
  return page.addInitScript(
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
}

async function createAgent(name: string): Promise<string> {
  const a = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 B64 fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  return a.id
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b64-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 b64 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-b64-state-'))
  daemon = await startDaemon({
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: stubState },
  })

  // ── 待办一：一个停在「等人回答」的澄清轮 ────────────────────────────────
  const askerId = await createAgent('rfc319-b64-asker')
  const clarifyWf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b64-clarify',
      description: 'RFC-319 B64 clarify fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'asker',
            kind: 'agent-single',
            agentId: askerId,
            agentName: 'rfc319-b64-asker',
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'B64 clarify gate',
            position: { x: 560, y: 160 },
          },
        ],
        edges: [
          {
            id: 'e_in_asker',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'asker', portName: 'topic' },
          },
          {
            id: 'e_ask',
            source: { nodeId: 'asker', portName: '__clarify__' },
            target: { nodeId: 'clarify_1', portName: 'questions' },
          },
          {
            id: 'e_ans',
            source: { nodeId: 'clarify_1', portName: 'answers' },
            target: { nodeId: 'asker', portName: '__clarify_response__' },
          },
        ],
      },
    }),
  })
  const clarifyTask = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b64-clarify-task',
      workflowId: clarifyWf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'inbox preview' },
    }),
  })

  // ── 待办二：一个停在「等人评审」的评审轮 ────────────────────────────────
  // 复用同一个 stub：它第二次调用同一 agent 时出 `design`（markdown），正好喂评审节点。
  const writerId = await createAgent('rfc319-b64-writer')
  const reviewWf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b64-review',
      description: 'RFC-319 B64 review fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'writer',
            kind: 'agent-single',
            agentId: writerId,
            agentName: 'rfc319-b64-writer',
            promptTemplate: 'Write about {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'doc_review',
            kind: 'review',
            title: 'B64 review gate',
            inputSource: { nodeId: 'writer', portName: 'design' },
            position: { x: 640, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'approved', bind: { nodeId: 'doc_review', portName: 'approved_doc' } }],
            position: { x: 960, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_in_writer',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'writer', portName: 'topic' },
          },
          {
            id: 'e_writer_review',
            source: { nodeId: 'writer', portName: 'design' },
            target: { nodeId: 'doc_review', portName: '__review_input__' },
          },
          {
            id: 'e_review_out',
            source: { nodeId: 'doc_review', portName: 'approved_doc' },
            target: { nodeId: 'out_1', portName: 'approved' },
          },
        ],
      },
    }),
  })
  const reviewTask = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b64-review-task',
      workflowId: reviewWf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'inbox preview' },
    }),
  })

  interface ClarifyRow {
    id: string
    intermediaryNodeRunId: string
    taskId: string
  }
  await expect
    .poll(
      async () => {
        const rows = await api<ClarifyRow[]>('/api/clarify?status=awaiting_human')
        const mine = rows.find((r) => r.taskId === clarifyTask.id)
        if (mine !== undefined) {
          clarifyRoundId = mine.id
          clarifyNodeRunId = mine.intermediaryNodeRunId
        }
        return mine !== undefined
      },
      { timeout: 180_000 },
    )
    .toBe(true)

  interface ReviewRow {
    nodeRunId: string
    taskId: string
    awaitingReview: boolean
  }
  await expect
    .poll(
      async () => {
        const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
        const mine = rows.find((r) => r.taskId === reviewTask.id && r.awaitingReview)
        if (mine !== undefined) reviewNodeRunId = mine.nodeRunId
        return mine !== undefined
      },
      { timeout: 180_000 },
    )
    .toBe(true)
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('首页「等你处理」要把两类待办都摆出来，而不是只显示其中一类 @nightly', async ({ page }) => {
  await seedAuth(page)
  await page.goto(`${daemon.baseUrl}/`)
  const clarifyRow = page.getByTestId(`inbox-preview-clarify-${clarifyRoundId}`)
  const reviewRow = page.getByTestId(`inbox-preview-review-${reviewNodeRunId}`)
  await expect(clarifyRow).toBeVisible({ timeout: 30_000 })
  await expect(reviewRow).toBeVisible()
  // 两行各自标出自己是哪一类——只列标题的话，人分不出该去回答还是去审阅。
  await expect(clarifyRow).toContainText('B64 clarify gate')
  await expect(reviewRow).toContainText('B64 review gate')
  await expect(page.getByTestId('inbox-preview-empty')).toHaveCount(0)
})

test('点一行要落到那条待办自己的详情页——落错页面比不给点更糟 @nightly', async ({ page }) => {
  await seedAuth(page)
  await page.goto(`${daemon.baseUrl}/`)
  await page.getByTestId(`inbox-preview-clarify-${clarifyRoundId}`).click()
  await expect(page).toHaveURL(new RegExp(`/clarify/${clarifyNodeRunId}$`))

  await page.goto(`${daemon.baseUrl}/`)
  await page.getByTestId(`inbox-preview-review-${reviewNodeRunId}`).click()
  await expect(page).toHaveURL(new RegExp(`/reviews/${reviewNodeRunId}$`))
})

test('一条 feed 挂了：要说清是哪条、能重试，而另一条的待办照常显示 @nightly', async ({ page }) => {
  await seedAuth(page)
  // 只打掉评审那条 feed；澄清那条放行。
  await page.route('**/api/reviews?status=pending', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, code: 'boom', message: 'injected reviews failure' }),
    })
  })
  await page.goto(`${daemon.baseUrl}/`)

  // 先等那条 feed 的错误落地，再断言另一条还在——顺序反了两头都过（另一条本来就先到）。
  await expect(page.getByTestId('inbox-preview-error-reviews')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('inbox-preview-error-clarify')).toHaveCount(0)
  await expect(
    page.getByTestId(`inbox-preview-clarify-${clarifyRoundId}`),
    '一条 feed 挂了就把另一条的待办也吞了 —— 人会以为今天没事',
  ).toBeVisible({ timeout: 2_000 })
  // 挂掉那条的行确实没了（否则上一条断言可能是拿旧缓存过的）。
  await expect(page.getByTestId(`inbox-preview-review-${reviewNodeRunId}`)).toHaveCount(0)
})
