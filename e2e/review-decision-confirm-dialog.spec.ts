// RFC-319 B47 —— HUMAN-35：评审决策的二次确认弹窗。
//
// 这个弹窗不是礼貌，是**止损**。三种被它挡住的损失，每一种在没有它的时候都完全静默：
//
//   * **带着意见按「通过」**：意见只有在迭代 / 驳回时才会进重跑提示词（见 B45）。
//     通过意味着这些意见一个字都不会到 agent 手里——评审的人却刚刚写完它们。
//     没有提示的话，他会以为「我提了，所以它会被处理」。
//   * **一条意见都没有就按「按意见修改」**：agent 会收到一份**空**的意见清单，
//     于是重跑出几乎一样的东西。评审的人看到「又是这个」，再迭代一次——B45 里描述的
//     那个没有报错面的死循环，起点常常就在这里。
//   * **驳回不写理由**：驳回是「推倒重来」那一下。理由为空时弹窗必须**当场拦下**、
//     一个请求都不发；把空理由送到服务端再吃 4xx，界面上看起来同样是「没反应」，
//     但用户已经以为自己驳回了。
//
// 还有一条正向的：弹窗要**预告哪些节点会回滚重跑**。评审的人据此判断「这一下要扔掉
// 多少工作」，预告错了或空着，他就是在没有信息的情况下按下那一步。
//
// 反向对照同样必要：**没有意见也没有草稿时按「通过」不该弹窗**，直接过。
// 少了这条，「永远弹窗」也能让上面每一条成立——而永远弹窗会训练人闭眼点确认，
// 那等于把这道止损闸拆了。
//
// 判据取自源码单一事实源：
//   routes/reviews.detail.tsx:296-315   approve：有草稿或有意见才弹窗，否则直接提交
//   routes/reviews.detail.tsx:329-338   iterate：noComments 由 comments.length 推出
//   routes/reviews.detail.tsx:318-328   reject：willRerun 空时回落成「直接上游」而不是「(none)」
//   routes/reviews.detail.tsx:843-880   三种弹窗正文；reject 的理由必填
//   i18n/en-US.ts:1763-1772             四段文案

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
let withComment: { nodeRunId: string; taskId: string }
let clean: { nodeRunId: string; taskId: string }

const COMMENT = 'rfc319-b47-this-needs-a-migration-note'

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

async function launchAndAwaitReview(name: string): Promise<ReviewRow> {
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
  return row as unknown as ReviewRow
}

async function openReview(page: Page, nodeRunId: string): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/reviews/${encodeURIComponent(nodeRunId)}`)
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-decdialog-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 decision dialog fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon()

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-decdialog-designer',
      description: 'RFC-319 decision dialog fixture',
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
        name: 'rfc319-decdialog-wf',
        description: 'RFC-319 decision dialog fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-decdialog-designer',
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

  const a = await launchAndAwaitReview('rfc319-decdialog-main')
  withComment = { nodeRunId: a.nodeRunId, taskId: a.taskId }
  const b = await launchAndAwaitReview('rfc319-decdialog-clean')
  clean = { nodeRunId: b.nodeRunId, taskId: b.taskId }
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('一条意见都没有就要迭代：弹窗必须说「agent 会收到一份空清单」，并预告谁会重跑 @nightly', async ({
  page,
}) => {
  await openReview(page, withComment.nodeRunId)
  await page.getByRole('button', { name: 'Revise per comments' }).click()

  const dialog = page.getByTestId('review-decision-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog, '没有意见就迭代 ⇒ 必须警告清单是空的').toContainText(
    'No comments submitted yet',
  )
  // 预告哪些节点会回滚重跑——评审的人据此判断这一下要扔掉多少工作。
  await expect(dialog, '弹窗必须预告重跑节点').toContainText('designer')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
})

test('驳回不写理由：弹窗当场拦下，一个决策请求都不许发出去 @nightly', async ({ page }) => {
  const decisionCalls: string[] = []
  await page.route('**/api/reviews/*/decision', async (route) => {
    decisionCalls.push(route.request().method())
    await route.fallback()
  })

  await openReview(page, withComment.nodeRunId)
  await page.getByRole('button', { name: 'Reject' }).click()
  const dialog = page.getByTestId('review-decision-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog, '驳回弹窗同样要预告重跑节点').toContainText('designer')

  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(dialog, '理由为空时弹窗必须留在原地').toBeVisible()
  await expect(dialog).toContainText('A reason is required to reject.')
  // 载荷断言：把空理由送到服务端再吃 4xx，在界面上与「当场拦下」同形，
  // 但用户已经以为自己驳回了。所以这里锁的是**一个请求都没发**。
  expect(decisionCalls, '空理由不该产生任何决策请求').toEqual([])

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
})

test('带着已提交的意见按「通过」：弹窗要点明这些意见不会被处理 @nightly', async ({ page }) => {
  const detail = await api<{ currentBody: string }>(`/api/reviews/${withComment.nodeRunId}`)
  const word = detail.currentBody.trim().split(/\s+/)[0] ?? ''
  const at = detail.currentBody.indexOf(word)
  await api(`/api/reviews/${withComment.nodeRunId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      anchor: {
        sectionPath: '',
        paragraphIdx: 0,
        offsetStart: at,
        offsetEnd: at + word.length,
        selectedText: word,
        contextBefore: '',
        contextAfter: detail.currentBody.slice(at + word.length, at + word.length + 12),
        occurrenceIndex: 1,
      },
      commentText: COMMENT,
    }),
  })

  await openReview(page, withComment.nodeRunId)
  await page.getByRole('button', { name: 'Approve' }).click()
  const dialog = page.getByTestId('review-decision-dialog')
  await expect(dialog, '有意见时按通过必须先问一句').toBeVisible()
  await expect(dialog).toContainText('This review has 1 submitted comment(s).')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  // 取消就是取消：这一轮必须仍然待评审。弹窗关掉了但决策已经发出去，
  // 是这类确认闸最恶劣的坏法——人以为自己反悔成功了。
  const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
  expect(
    rows.some((r) => r.nodeRunId === withComment.nodeRunId && r.awaitingReview),
    '按了取消，这一轮就必须原样还在',
  ).toBe(true)
})

test('反向对照：没有意见也没有草稿时按「通过」，不弹窗、直接过 @nightly', async ({ page }) => {
  await openReview(page, clean.nodeRunId)
  await page.getByRole('button', { name: 'Approve' }).click()
  // 这条是上面三条的地基：如果「永远弹窗」，上面每条都照样绿，而永远弹窗会训练人
  // 闭眼点确认——那等于把这道止损闸拆了。
  await expect(
    page.getByTestId('review-decision-dialog'),
    '没有任何未决信号时不该拦人',
  ).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (await api<Array<{ nodeRunId: string }>>('/api/reviews?status=approved')).some(
          (r) => r.nodeRunId === clean.nodeRunId,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
})
