// RFC-319 B57 —— HUMAN-37：评审 diff 视图的粒度切换与快捷键。
//
// diff 是评审的人**据以做决定**的那块内容。它坏起来不会报错，只会让人在一份看错的
// 内容上按下「通过」或「驳回」：
//
//   * **段选了但渲染没跟着换**：pill 上高亮的是「词」，屏幕上却仍是行级 diff。
//     词级与行级对「这处到底改了什么」的呈现差别很大——整行标红时人看不出实际只动了
//     一个标识符，于是把一次无害改名读成一次重写。
//   * **快捷键把不该触发的也触发了**：`Cmd/Ctrl+1/2/3` 切粒度，而**裸的 1/2/3 不许**——
//     否则在输入框里打字（比如写驳回理由里的编号）会把身下的视图切走；更糟的是
//     这一页上 A/R/I 是单键决策，键盘事件一旦漏进来就是不可逆的一下。
//   * **上一版正文取不到时假装无事**：diff 的一侧来自上一版；那一侧加载失败若被
//     无声吞掉，人看到的是一份「什么都没改」的 diff——最危险的一种假象。
//
// 判据取自源码单一事实源：
//   routes/reviews.detail.tsx:718-745   四段 pill（Source / Word / Line / Block）
//   routes/reviews.detail.tsx:389-408   Cmd/Ctrl+1/2/3 才切粒度；无修饰键时不拦
//   routes/reviews.detail.tsx:382-388   焦点在 INPUT/TEXTAREA/SELECT 里时整个快捷键停用
//   components/review/DiffView.tsx:38   `.diff-view[data-granularity=…]`
//   routes/reviews.detail.tsx:695-697   上一版正文加载失败 ⇒ review-diff-body-stale-error

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
let reviewNodeRunId: string

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

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  startedAt: number | null
}

async function openReview(page: Page): Promise<void> {
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
  await page.setViewportSize({ width: 1536, height: 900 })
  await page.goto(`${daemon.baseUrl}/reviews/${encodeURIComponent(reviewNodeRunId)}`)
  await expect(page.getByTestId('review-detail-task-link')).toBeVisible()
}

const seg = (page: Page, label: string) =>
  page.locator('.diff-mode-segmented').getByRole('radio', { name: label, exact: true })
const diffView = (page: Page) => page.locator('.diff-view')

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-diffgran-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 diff granularity fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon()

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-diffgran-designer',
      description: 'RFC-319 diff granularity fixture',
      // 默认 stub 只发 `answer` 端口；声明别的会得到一份空文档（B45 实撞）。
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-diffgran-wf',
      description: 'RFC-319 diff granularity fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-diffgran-designer',
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
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-diffgran-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
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
  reviewNodeRunId = row!.nodeRunId

  // diff 工具条只在 versionIndex > 1 时出现，所以先迭代一轮造出第二版。
  const runsBefore = new Set(
    (await api<{ runs: NodeRunRow[] }>(`/api/tasks/${task.id}/node-runs`)).runs
      .filter((r) => r.nodeId === 'designer')
      .map((r) => r.id),
  )
  const decided = await fetch(`${daemon.baseUrl}/api/reviews/${reviewNodeRunId}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'iterated', reviewIteration: row!.reviewIteration }),
  })
  expect(decided.ok, `iterate: ${decided.status} ${await decided.text()}`).toBe(true)
  // 按 id 认新起的那一轮（计数会被 pending 行与 canceled 旧行同时骗到，见 B45）。
  await expect
    .poll(
      async () =>
        (await api<{ runs: NodeRunRow[] }>(`/api/tasks/${task.id}/node-runs`)).runs.some(
          (r) =>
            r.nodeId === 'designer' &&
            !runsBefore.has(r.id) &&
            r.status === 'done' &&
            r.startedAt !== null,
        ),
      { timeout: 180_000 },
    )
    .toBe(true)
  await expect
    .poll(
      async () =>
        (await api<Array<{ versionIndex: number }>>(`/api/reviews/${reviewNodeRunId}/versions`))
          .length,
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(2)
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('四段切换：选哪一段，渲染出来的就必须是哪一段的粒度', async ({ page }) => {
  await openReview(page)
  await expect(page.locator('.diff-mode-segmented'), '第二版之后才有 diff 工具条').toBeVisible()

  // 缺省是「原文」：没有 diff 视图。少了这条对照，「永远渲染 diff」也能让后面成立。
  await expect(diffView(page), '缺省应当是原文视图').toHaveCount(0)

  // 三段各切一次，逐段断言**渲染出来的粒度**——只看 pill 高亮的话，
  // 「段变了但渲染没跟着换」正好落在盲区里，而那恰是最贵的坏法。
  for (const [label, granularity] of [
    ['Word', 'word'],
    ['Line', 'line'],
    ['Block', 'block'],
  ] as const) {
    await seg(page, label).click()
    await expect(diffView(page)).toHaveCount(1)
    await expect(diffView(page), `选了「${label}」，渲染却不是 ${granularity}`).toHaveAttribute(
      'data-granularity',
      granularity,
    )
  }

  // 切回原文：diff 视图必须收回去。
  await seg(page, 'Source').click()
  await expect(diffView(page)).toHaveCount(0)
})

test('Cmd/Ctrl+1/2/3 切粒度；裸的 1/2/3 不许动它', async ({ page }) => {
  await openReview(page)
  await seg(page, 'Word').click()
  await expect(diffView(page)).toHaveAttribute('data-granularity', 'word')

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${modifier}+2`)
  await expect(diffView(page), '带修饰键的 2 应当切到行级').toHaveAttribute(
    'data-granularity',
    'line',
  )
  await page.keyboard.press(`${modifier}+3`)
  await expect(diffView(page)).toHaveAttribute('data-granularity', 'block')
  await page.keyboard.press(`${modifier}+1`)
  await expect(diffView(page)).toHaveAttribute('data-granularity', 'word')

  // 裸数字键不许动它。这一页上 A/R/I 是**单键决策**，键盘处理一旦放宽，
  // 在输入框里打字就可能顺手按下一次不可逆的操作。
  await page.keyboard.press('2')
  await page.keyboard.press('3')
  await expect(diffView(page), '裸的 2/3 把视图切走了').toHaveAttribute('data-granularity', 'word')
})

test('上一版正文取不到时要报出来，而不是画成「什么都没改」', async ({ page }) => {
  // diff 的一侧来自上一版。那一侧失败若被无声吞掉，人看到的是一份「无改动」的 diff
  // ——他会据此通过一版其实改了很多的稿子。
  await page.route('**/api/reviews/*/versions/*', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'upstream-unavailable', message: 'injected' }),
    })
  })
  await openReview(page)
  await seg(page, 'Word').click()
  await expect(
    page.getByTestId('review-diff-body-error'),
    '上一版正文取不到时必须报出来',
  ).toBeVisible({ timeout: 30_000 })
  // 而且**不能**同时画出一份 diff——半份 diff 比没有 diff 更误导。
  await expect(diffView(page)).toHaveCount(0)
})

test('版本列表本身取不到时，报的是另一条错，而不是含糊地「没有上一版」', async ({ page }) => {
  // 三种失败态各有各的 testid（`reviews.detail.tsx:494-506`）。共用一条的话，
  // 「服务端挂了」与「这份文档确实只有一版」在界面上无法区分，而两者该做的事完全不同。
  await page.route('**/api/reviews/*/versions', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'upstream-unavailable', message: 'injected' }),
    })
  })
  await openReview(page)
  await seg(page, 'Word').click()
  await expect(
    page.getByTestId('review-diff-versions-error'),
    '版本列表失败要报自己那一条',
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('review-diff-body-error')).toHaveCount(0)
  await expect(diffView(page)).toHaveCount(0)
})

// 覆盖边界（如实记）：第三种失败态 `review-diff-body-stale-error` 只在「**已有缓存数据**、
// 随后一次刷新失败」时渲染（`reviews.detail.tsx:694-697` 的 `data !== undefined && error`）。
// 本仓的 QueryClient 关掉了 `refetchOnWindowFocus`（`lib/query-client.ts:49`），
// 外部没有可确定性触发那次刷新的把手，硬造只能靠计时器抢跑——那种用例本仓不写。
// 这一档留给能拿到 QueryClient 句柄的组件级测试。
