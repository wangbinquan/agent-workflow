// RFC-319 B42 —— HUMAN-13：澄清收件箱列表页（三态过滤 / 按任务分组 / 读不到 ≠ 没有）。
//
// 这一页是「我该去回答哪一条」的唯一入口。它坏起来不会报错，只会**给出一份错的清单**：
//
//   * **过滤没接上**：`awaiting` 页签把已经答过的轮次也列出来 ⇒ 人点进去发现是只读的，
//     几次之后就不再信这一页；反方向更糟——`answered` 空着 ⇒ 历史看不到，
//     「这题当初到底怎么答的」查无对证。两个方向都不报错。
//   * **分组串了**：这一页按任务分节，节标题就是任务名。分组键写错时页面照样画得出来，
//     只是**甲任务的问题挂在了乙任务名下**——回答的人是照着任务上下文判断的，
//     串组等于让他在错误的上下文里作答，而且答完也不会有任何提示。
//   * **把「读不到」画成「没有」**：列表请求失败时如果落到空态（「没有待回答的问题」），
//     人就直接走了。空态与故障态在用户那儿的区别是「我可以下班」与「我得去修」。
//
// 所以判据都取**两个任务、真实轮次**，而不是单任务 happy path：单任务下分组永远只有一节，
// 分组键写成常量也照样绿。
//
// 判据取自源码单一事实源：
//   routes/clarify.tsx:41-47    三个页签映射到 status=awaiting_human / answered / all
//   routes/clarify.tsx:178-184  按 taskId 分组
//   routes/clarify.tsx:207-231  error ⇒ ErrorBanner(onRetry)；空态只在 data 已到且为空时渲染
//   routes/clarify.tsx:101-107  「打开」按钮走 intermediaryNodeRunId，不是轮次 id

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
  taskName: string
  roundId: string
  nodeRunId: string
  iteration: number
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

/** 建一条 designer→clarify 工作流并起任务，等它停在等人回答上。
 *  每个 fixture 用各自的 agent 名——clarify stub 的轮次标记文件按 agent 分键，
 *  共用一个名字的话第二个任务会被当成「已经问过了」，直接出最终输出。 */
async function makeFixture(slug: string): Promise<Fixture> {
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-inboxlist-${slug}`,
      description: 'RFC-319 clarify inbox list fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-inboxlist-${slug}-wf`,
      description: 'RFC-319 clarify inbox list fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: `rfc319-inboxlist-${slug}`,
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
  const taskName = `rfc319-inboxlist-${slug}-task`
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
    taskName,
    roundId: session!.id,
    nodeRunId: session!.intermediaryNodeRunId,
    iteration: session!.iteration,
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
  await page.goto(`${daemon.baseUrl}/clarify`)
  await expect(page.getByTestId('clarify-list-page')).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-inboxlist-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 clarify inbox list fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-inboxlist-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })
  alpha = await makeFixture('alpha')
  beta = await makeFixture('beta')
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('两个任务各自成节、行不串组，「打开」落在正确的那一轮 @nightly', async ({ page }) => {
  await openList(page)

  const groupA = page.getByTestId(`clarify-group-${alpha.taskId}`)
  const groupB = page.getByTestId(`clarify-group-${beta.taskId}`)
  await expect(groupA).toBeVisible()
  await expect(groupB).toBeVisible()
  // 节标题必须是**任务名**：分组键写对但标题取错，人照样会在错的上下文里作答。
  await expect(groupA).toContainText(alpha.taskName)
  await expect(groupB).toContainText(beta.taskName)
  // 关键的负向断言：甲的行**不能**出现在乙那一节里。单任务 fixture 验不出这条。
  await expect(groupA.getByTestId(`clarify-row-${alpha.roundId}`)).toHaveCount(1)
  await expect(groupA.getByTestId(`clarify-row-${beta.roundId}`)).toHaveCount(0)
  await expect(groupB.getByTestId(`clarify-row-${beta.roundId}`)).toHaveCount(1)
  await expect(groupB.getByTestId(`clarify-row-${alpha.roundId}`)).toHaveCount(0)

  // 「打开」按钮走的是 intermediary node_run id 而不是轮次 id——两者写混时
  // 这一页看起来完全正常，只有点下去才 404。
  await groupA
    .getByTestId(`clarify-row-${alpha.roundId}`)
    .getByRole('link', { name: 'Open' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/clarify/${alpha.nodeRunId}$`))
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
})

test('答过的那一轮：从「待回答」里消失、在「已回答」里出现，「全部」两条都在 @nightly', async ({
  page,
}) => {
  // 只答 alpha，beta 留着当对照——否则「页签根本没生效、永远返回全部」也能让
  // 「已回答里有 alpha」成立。
  const res = await fetch(`${daemon.baseUrl}/api/clarify/${alpha.nodeRunId}/answers`, {
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
      ifMatchIteration: alpha.iteration,
      directive: 'stop',
    }),
  })
  expect(res.ok, `answer alpha: ${res.status} ${await res.text()}`).toBe(true)
  await expect
    .poll(
      async () =>
        (await api<Array<{ id: string }>>('/api/clarify?status=answered')).some(
          (r) => r.id === alpha.roundId,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)

  await openList(page)

  // 待回答：只剩 beta。
  await expect(page.getByTestId(`clarify-row-${beta.roundId}`)).toHaveCount(1)
  await expect(page.getByTestId(`clarify-row-${alpha.roundId}`)).toHaveCount(0)

  // 已回答：只有 alpha。两个方向都断言，页签才真的被证明是「筛选」而不是摆设。
  await page.getByTestId('clarify-filter-answered').click()
  await expect(page.getByTestId(`clarify-row-${alpha.roundId}`)).toHaveCount(1)
  await expect(page.getByTestId(`clarify-row-${beta.roundId}`)).toHaveCount(0)

  // 全部：两条都在。
  await page.getByTestId('clarify-filter-all').click()
  await expect(page.getByTestId(`clarify-row-${alpha.roundId}`)).toHaveCount(1)
  await expect(page.getByTestId(`clarify-row-${beta.roundId}`)).toHaveCount(1)
})

test('列表读不到时报故障并可重试，绝不画成「没有待回答的问题」 @nightly', async ({ page }) => {
  let failing = true
  await page.route('**/api/clarify?status=*', async (route) => {
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
  // 故障态必须可见，且**空态必须不在**——把「读不到」画成「没有」，
  // 人就直接下班了，而真实情况是有一条待办正在等他。
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(page.getByTestId('clarify-list-empty')).toHaveCount(0)

  // 重试真的能把列表拉回来（只有「重试」按钮存在还不够，它得真的重发请求）。
  failing = false
  await page.getByRole('button', { name: /retry/i }).click()
  await expect(page.getByTestId(`clarify-row-${beta.roundId}`)).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
