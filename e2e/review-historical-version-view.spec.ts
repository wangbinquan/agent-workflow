// RFC-319 B46 —— HUMAN-38：历史版本的只读视图（`?version=<vid>`）。
//
// 评审页有两种截然不同的用途，却共用同一个 URL 形状：**决策当前这一版**，与
// **回看某个旧版本**。分不清的后果只有一种，而且是不可逆的——人以为自己在看当前稿，
// 于是按下「通过」，实际通过的是三轮以前那一版；或者反过来，看着旧版的问题去驳回
// 一份早已修好的新稿。两种都不会报错，因为决策本身完全合法。
//
// 所以这一屏的判据不是「横幅显示了吗」，而是**写操作到底还在不在**：
// RFC-013 的做法是历史模式下决策按钮**根本不进 DOM**（不是 disabled——disabled 的
// 按钮仍然在讲「这里可以决策，只是现在不行」，而真相是「这一版早就决策完了」）。
//
// 另外两条同样静默：
//
//   * **非法版本号**：`?version=` 指向一个不存在的 id 时，页面必须**说出来**并回落到
//     当前版；静默忽略的话，人以为自己在看那个版本，其实看的是当前稿——比看错版本更坏，
//     因为他有明确的「我已经切过去了」的心理预期。
//   * **跨评审的版本号**：拿另一条评审的版本 id 来问，不能把那份文档渲染出来。
//     它既是越权读，也是一次张冠李戴的误导。
//
// 判据取自源码单一事实源：
//   routes/reviews.detail.tsx:163-173   三态 mode：historical / awaiting / decided
//   routes/reviews.detail.tsx:440-442   历史模式下决策按钮**不在 DOM**
//   routes/reviews.detail.tsx:590-620   决策按钮只在 mode !== 'historical' 时渲染
//   routes/reviews.detail.tsx:699-716   只读横幅 + 「返回当前版」
//   lib/review/readonly.ts:86           版本列表里找不到 ⇒ mode='invalid'
//   routes/reviews.detail.tsx:655       非法版本的告警块

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
let workflowId: string

/** 主用例：迭代过一轮，因此 v1 已决策、v2 待评审。 */
let main: { taskId: string; nodeRunId: string; v1Id: string }
/** 旁证用例：只为了拿一个**属于别人**的版本 id。 */
let other: { nodeRunId: string; v1Id: string }

const DECISION_BUTTONS = ['Approve', 'Reject', 'Revise per comments'] as const

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

interface ReviewRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
}
interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  startedAt: number | null
}

const designerRuns = async (taskId: string): Promise<NodeRunRow[]> =>
  (await api<{ runs: NodeRunRow[] }>(`/api/tasks/${taskId}/node-runs`)).runs.filter(
    (r) => r.nodeId === 'designer',
  )

async function launchAndAwaitReview(name: string): Promise<{ taskId: string; review: ReviewRow }> {
  const created = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  let row: ReviewRow | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
        row = rows.find((r) => r.taskId === created.id && r.awaitingReview) ?? null
        return row !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  return { taskId: created.id, review: row as unknown as ReviewRow }
}

async function openReview(page: Page, nodeRunId: string, query = ''): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/reviews/${encodeURIComponent(nodeRunId)}${query}`)
  await expect(page.getByTestId('review-detail-task-link')).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-histver-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 historical version fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon()

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-histver-designer',
      description: 'RFC-319 historical version fixture',
      // 默认 stub 只发 `answer` 端口；声明别的会得到一份空文档（见 B45 的实撞）。
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  workflowId = (
    await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-histver-wf',
        description: 'RFC-319 historical version fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-histver-designer',
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'review_design',
              kind: 'review',
              inputSource: { nodeId: 'designer', portName: 'answer' },
              rerunnableOnIterate: ['designer'],
              rerunnableOnReject: ['designer'],
              position: { x: 640, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_designer',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'designer', portName: 'topic' },
            },
          ],
        },
      }),
    })
  ).id

  // 主 fixture：迭代一轮，制造出「v1 已决策 + v2 待评审」的两版历史。
  const launched = await launchAndAwaitReview('rfc319-histver-main')
  const beforeIds = new Set((await designerRuns(launched.taskId)).map((r) => r.id))
  const decided = await fetch(
    `${daemon.baseUrl}/api/reviews/${launched.review.nodeRunId}/decision`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'iterated',
        reviewIteration: launched.review.reviewIteration,
      }),
    },
  )
  expect(decided.ok, `iterate: ${decided.status} ${await decided.text()}`).toBe(true)
  // 等重跑真的跑完——按 id 认新起的那一轮（计数会被 pending 行与 canceled 旧行骗到，
  // 见 B45 的两次实撞）。
  await expect
    .poll(
      async () =>
        (await designerRuns(launched.taskId)).some(
          (r) => !beforeIds.has(r.id) && r.status === 'done' && r.startedAt !== null,
        ),
      { timeout: 180_000 },
    )
    .toBe(true)
  // 直到第二版出现为止：只有两版都在，v1 才是「历史版本」。
  let v1Id = ''
  await expect
    .poll(
      async () => {
        const vs = await api<Array<{ id: string; versionIndex: number; decision: string }>>(
          `/api/reviews/${launched.review.nodeRunId}/versions`,
        )
        const v1 = vs.find((v) => v.versionIndex === 1)
        if (v1 !== undefined) v1Id = v1.id
        return vs.length
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(2)
  main = { taskId: launched.taskId, nodeRunId: launched.review.nodeRunId, v1Id }

  // 旁证 fixture：另一条评审，只为拿一个属于它的版本 id。
  const second = await launchAndAwaitReview('rfc319-histver-other')
  const otherVersions = await api<Array<{ id: string; versionIndex: number }>>(
    `/api/reviews/${second.review.nodeRunId}/versions`,
  )
  other = { nodeRunId: second.review.nodeRunId, v1Id: otherVersions[0]!.id }
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('看旧版本时：只读横幅在，决策按钮**不在 DOM**；回到当前版按钮才回来 @nightly', async ({
  page,
}) => {
  // 正向对照先做：当前版上三个决策按钮都在。少了这一段，
  // 「这三个按钮在任何情况下都不渲染」也能让下面的断言成立。
  await openReview(page, main.nodeRunId)
  for (const label of DECISION_BUTTONS) {
    await expect(page.getByRole('button', { name: label })).toBeVisible()
  }

  await openReview(page, main.nodeRunId, `?version=${encodeURIComponent(main.v1Id)}`)
  await expect(page.locator('.readonly-banner')).toBeVisible()
  await expect(page.locator('.readonly-banner')).toContainText('viewing version v1')

  // 载荷断言：不是 disabled，是**根本不在**。disabled 的按钮仍在讲
  // 「这里可以决策，只是现在不行」，而真相是这一版早已决策完毕。
  for (const label of DECISION_BUTTONS) {
    await expect(
      page.getByRole('button', { name: label }),
      `历史模式下「${label}」不该出现在 DOM 里`,
    ).toHaveCount(0)
  }

  // 「返回当前版」把写操作还回来。
  await page.locator('.readonly-banner__back').click()
  await expect(page.locator('.readonly-banner')).toHaveCount(0)
  for (const label of DECISION_BUTTONS) {
    await expect(page.getByRole('button', { name: label })).toBeVisible()
  }
})

test('版本号不存在时要说出来，而不是默默给你看当前稿 @nightly', async ({ page }) => {
  await openReview(page, main.nodeRunId, '?version=dv_rfc319_does_not_exist')
  await expect(
    page.getByTestId('review-invalid-version-warning'),
    '静默忽略非法版本号比看错版本更坏——人有明确的「我已经切过去了」的预期',
  ).toBeVisible()
  // 回落到当前版：既不是历史模式，也不是一片空白。
  await expect(page.locator('.readonly-banner')).toHaveCount(0)
  for (const label of DECISION_BUTTONS) {
    await expect(page.getByRole('button', { name: label })).toBeVisible()
  }
})

test('拿别条评审的版本号来问：不许把那份文档渲染出来 @nightly', async ({ page }) => {
  await openReview(page, main.nodeRunId, `?version=${encodeURIComponent(other.v1Id)}`)
  // 与「不存在」同形处理即可——重要的是**不能**进入历史模式去渲染别人的正文。
  await expect(page.getByTestId('review-invalid-version-warning')).toBeVisible()
  await expect(
    page.locator('.readonly-banner'),
    '别条评审的版本 id 不该被当成本条评审的历史版本',
  ).toHaveCount(0)
})
