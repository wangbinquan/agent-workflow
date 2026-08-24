// RFC-319 B48 —— HUMAN-X1：从任务详情进入人工门的入口。
//
// 前面几条锁的是「待办清单对不对」（B42/B43）与「角标亮不亮」（B41）。这一条锁的是
// **另一条真实路径**：人正在看某个任务，想知道「它卡在哪儿、我该做什么」。这条路
// 断掉的形态很朴素也很致命——节点表里那一行只显示一个状态 chip，没有任何可点的东西，
// 于是人得自己去猜「awaiting_human 是什么意思」，再自己绕到收件箱里翻。多数人不会绕，
// 任务就那么停着。
//
// 两条判据都必须带**负向对照**：跳转按钮只该出现在真正卡人的那一行上。
// 每一行都挂一个「去回答」在功能上等于没有指示——人会按错，落到一个与他无关的节点上。
//
// 判据取自源码单一事实源：
//   routes/tasks.detail.tsx:2009-2021  只有 awaiting_review / awaiting_human 两个状态出跳转按钮
//   routes/tasks.detail.tsx:1797-1821  两个按钮的落点：/reviews/$nodeRunId 与 /clarify/$nodeRunId
//   i18n/en-US.ts:5270-5271            两个按钮的英文标签 Review / Answer
//
// fixture 用一条同时挂了澄清通道与评审节点的工作流，一个任务连着走完两道门：
// 先停在等人回答，答完之后重跑出稿、再停在等人评审。两道门因此在同一页上先后出现。

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
let taskId: string
let clarifyNodeRunId: string
let clarifyIteration: number

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

async function openTask(page: Page): Promise<void> {
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
  // 节点表在 `?tab=node-runs` 那一页签下；默认落在 workflow-status，
  // 直接 goto 会等到一个隐藏的 section 上。
  await page.goto(`${daemon.baseUrl}/tasks/${encodeURIComponent(taskId)}?tab=node-runs`)
  await expect(page.locator('[data-task-detail-section="node-runs"]')).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-gateentry-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 gate entry fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-gateentry-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-gateentry-designer',
      description: 'RFC-319 gate entry fixture',
      // clarify stub 第二轮出的是 `design` 端口，评审就挂在它上面。
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-gateentry-wf',
      description: 'RFC-319 gate entry fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-gateentry-designer',
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'Clarify design',
            position: { x: 560, y: 160 },
          },
          {
            id: 'review_design',
            kind: 'review',
            inputSource: { nodeId: 'designer', portName: 'design' },
            rerunnableOnIterate: ['designer'],
            rerunnableOnReject: ['designer'],
            position: { x: 860, y: 0 },
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
      name: 'rfc319-gateentry-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  interface Session {
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
  clarifyNodeRunId = session!.intermediaryNodeRunId
  clarifyIteration = session!.iteration
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('任务卡在等人回答时：节点表里那一行有「Answer」，别的行没有，点下去落在那一轮', async ({
  page,
}) => {
  await openTask(page)

  const answerLinks = page.locator('.node-runs__clarify-link')
  await expect(answerLinks, '卡人的那一行必须给一个可点的入口').toHaveCount(1)
  // 负向对照：跳转按钮只挂在卡人的那一行上。每行都挂等于没有指示——
  // 人会按错，落到一个与他无关的节点上。
  await expect(
    page.locator('.node-runs__review-link'),
    '这会儿还没到评审，不该出现「Review」',
  ).toHaveCount(0)

  await answerLinks.first().click()
  await expect(page).toHaveURL(new RegExp(`/clarify/${clarifyNodeRunId}$`))
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
})

test('答完之后任务卡在等人评审：那一行换成「Review」，「Answer」不再出现', async ({ page }) => {
  const res = await fetch(`${daemon.baseUrl}/api/clarify/${clarifyNodeRunId}/answers`, {
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
      ifMatchIteration: clarifyIteration,
      directive: 'stop',
    }),
  })
  expect(res.ok, `answer: ${res.status} ${await res.text()}`).toBe(true)

  interface ReviewRow {
    nodeRunId: string
    taskId: string
    awaitingReview: boolean
  }
  let review: ReviewRow | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
        review = rows.find((r) => r.taskId === taskId && r.awaitingReview) ?? null
        return review !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)

  await openTask(page)
  const reviewLinks = page.locator('.node-runs__review-link')
  await expect(reviewLinks, '卡在等人评审时必须给一个可点的入口').toHaveCount(1)
  // 澄清那一轮已经答完，它的入口必须收回去——留着的话人会点进一个只读页面，
  // 以为「我这儿还有事没做」。
  await expect(
    page.locator('.node-runs__clarify-link'),
    '答完的那一轮不该继续挂着「Answer」',
  ).toHaveCount(0)

  await reviewLinks.first().click()
  await expect(page).toHaveURL(new RegExp(`/reviews/${review!.nodeRunId}$`))
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
})
