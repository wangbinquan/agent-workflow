// RFC-319 B43 —— HUMAN-41：评审收件箱列表页（五态过滤 / 逐行版本历史展开 / 读不到 ≠ 没有）。
//
// 与 B42 的澄清收件箱同形，但评审这一侧的代价更高：澄清答错了还能再问一轮，
// 评审是**放行或打回**的那一下，而这一页决定了人会去看哪一份、看的是第几版。
//
//   * **过滤没接上**：待评审页签里混进已决策的行 ⇒ 人点进去发现动不了；
//     反方向——已通过 / 已驳回页签空着 ⇒ 「上一版为什么被打回」查无对证，
//     而那正是下一轮 agent 的修改依据。
//   * **展开取错了行**：每行的历史是按 `nodeRunId` 懒加载的
//     （`/api/reviews/:nodeRunId/versions`）。键写错时页面**照样展得开**，
//     只是给你看的是**另一份文档的版本史**——人据此判断「这版比上版改了什么」，
//     而两份根本不是同一条链。这种错没有任何报错面。
//   * **把「读不到」画成「没有」**：列表请求失败落到空态（「没有待评审」），
//     人就走了；而真实情况是有一条评审卡在那儿，任务停着。
//
// 两个任务、两条评审，其中一条被通过、一条留待评审——单条 fixture 下
// 「页签根本没生效、永远返回全部」也能让每一条断言成立。
//
// 判据取自源码单一事实源：
//   routes/reviews.tsx:40           五个页签 pending / all / approved / rejected / iterated
//   routes/reviews.tsx:67           页签直接进 `?status=`
//   routes/reviews.tsx:143-152      按任务分节，标题取任务名
//   routes/reviews.tsx:176-188      逐行展开按钮（aria-label = Show history / Hide history）
//   routes/reviews.tsx:267-284      历史按 nodeRunId 懒加载
//   routes/reviews.tsx:311-317      历史面板表头 `Version history · {{count}}`
//   routes/reviews.tsx:111-141      error ⇒ ErrorBanner(onRetry)；空态只在 data 已到且为空时渲染

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

interface Fixture {
  taskId: string
  taskName: string
  nodeRunId: string
  reviewNodeId: string
  reviewIteration: number
}
let alpha: Fixture
let beta: Fixture

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

/** 每个 fixture 用不同的评审节点 id：这一页的行是按节点 id 认的，
 *  两条共用一个 id 就分不出「展开的是不是自己那一行」。 */
async function makeFixture(slug: string): Promise<Fixture> {
  const reviewNodeId = `review_${slug}`
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-reviewlist-${slug}`,
      description: 'RFC-319 review inbox list fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-reviewlist-${slug}-wf`,
      description: 'RFC-319 review inbox list fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: `rfc319-reviewlist-${slug}`,
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: reviewNodeId,
            kind: 'review',
            inputSource: { nodeId: 'designer', portName: 'design' },
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
  const taskName = `rfc319-reviewlist-${slug}-task`
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: taskName,
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: `${slug} order_status enum` },
    }),
  })
  interface ReviewRow {
    nodeRunId: string
    taskId: string
    reviewIteration: number
    awaitingReview: boolean
  }
  let row: ReviewRow | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
        row = rows.find((r) => r.taskId === task.id && r.awaitingReview) ?? null
        return row !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  return {
    taskId: task.id,
    taskName,
    nodeRunId: row!.nodeRunId,
    reviewNodeId,
    reviewIteration: row!.reviewIteration,
  }
}

async function openList(page: Page): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/reviews`)
  await expect(page.getByTestId('reviews-filter-pending')).toBeVisible()
}

/** 某个任务那一节里、认得出是哪条评审的那一行。 */
const rowOf = (page: Page, f: Fixture) =>
  page.locator('section.reviews-group', { hasText: f.taskId }).locator('tbody tr', {
    hasText: f.reviewNodeId,
  })

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-reviewlist-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 review inbox list fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon()
  alpha = await makeFixture('alpha')
  beta = await makeFixture('beta')
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('逐行展开取的是自己那一行的版本史，另一行不受影响', async ({ page }) => {
  await openList(page)

  const rowA = rowOf(page, alpha).first()
  const rowB = rowOf(page, beta).first()
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()

  // 展开之前谁也不该有历史面板——否则「永远展开」也能让下面成立。
  await expect(page.locator('.reviews-version-panel')).toHaveCount(0)

  await rowA.getByRole('button', { name: 'Show history' }).click()
  const panel = page.locator('.reviews-version-panel')
  await expect(panel, '展开后应当加载出该行的版本史').toHaveCount(1)
  // 这一行只跑过一轮，所以恰好一版；数字来自 `/api/reviews/:nodeRunId/versions`，
  // 键写错时这里会变成另一份文档的版本数。
  await expect(panel.locator('.reviews-version-panel__header')).toHaveText('Version history · 1')
  await expect(panel.locator('.reviews-version-list__item')).toHaveCount(1)
  await expect(panel.locator('.reviews-version-list__label')).toHaveText('v1')

  // 另一行仍然是收起的：展开态是 per-row 的，不是全局开关。
  await expect(rowB.getByRole('button', { name: 'Show history' })).toBeVisible()

  // 收起后面板消失（懒加载的东西也要收得回去）。
  await rowA.getByRole('button', { name: 'Hide history' }).click()
  await expect(page.locator('.reviews-version-panel')).toHaveCount(0)
})

test('决策过的那一条：待评审里消失、已通过里出现、已驳回里没有，全部两条都在', async ({ page }) => {
  // 只通过 alpha，beta 留着当对照。
  const res = await fetch(`${daemon.baseUrl}/api/reviews/${alpha.nodeRunId}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', reviewIteration: alpha.reviewIteration }),
  })
  expect(res.ok, `approve alpha: ${res.status} ${await res.text()}`).toBe(true)
  await expect
    .poll(
      async () =>
        (await api<Array<{ nodeRunId: string }>>('/api/reviews?status=approved')).some(
          (r) => r.nodeRunId === alpha.nodeRunId,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)

  await openList(page)

  // 待评审：只剩 beta。
  await expect(rowOf(page, beta)).toHaveCount(1)
  await expect(rowOf(page, alpha)).toHaveCount(0)

  // 已通过：只有 alpha。
  await page.getByTestId('reviews-filter-approved').click()
  await expect(rowOf(page, alpha)).toHaveCount(1)
  await expect(rowOf(page, beta)).toHaveCount(0)

  // 已驳回：两条都不该在——只断言「已通过里有 alpha」的话，
  // 「任何页签都返回全部」也能过。
  await page.getByTestId('reviews-filter-rejected').click()
  await expect(rowOf(page, alpha)).toHaveCount(0)
  await expect(rowOf(page, beta)).toHaveCount(0)

  // 全部：两条都在。
  await page.getByTestId('reviews-filter-all').click()
  await expect(rowOf(page, alpha)).toHaveCount(1)
  await expect(rowOf(page, beta)).toHaveCount(1)
})

test('列表读不到时报故障并可重试，绝不画成「没有待评审」', async ({ page }) => {
  let failing = true
  await page.route('**/api/reviews?status=*', async (route) => {
    if (failing) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'upstream-unavailable', message: 'injected' }),
      })
      return
    }
    await route.fallback()
  })

  await openList(page)
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(page.getByTestId('reviews-empty')).toHaveCount(0)

  failing = false
  await page.getByRole('button', { name: /retry/i }).click()
  await expect(rowOf(page, beta)).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
