// RFC-319 B52 —— HUMAN-26：跨通道协调（别处已封存的题，在澄清页要变灰只读并被排除出提交）。
//
// 同一道问题有**两条**可以作答的通道：澄清页的快速通道，和看板 / 集中回答面板的控制通道。
// 两个人同时在用时，某一题很可能已经被别处封存了。这时澄清页若照旧把它渲染成可答：
//
//   * 人会**再答一遍**——他不知道同事已经答过了；
//   * 提交时如果把它也带上，要么覆盖掉同事的答案（他的输入静默消失），
//     要么被服务端的 exactly-once 守卫整批拒掉（他自己那几题也白填了）。
//
// 两种后果都不报错。所以这一屏的判据是三段：**看得出**（变灰 + 标记）、**动不了**（输入禁用）、
// **不带走**（提交载荷里没有它）。第三段是最关键也最容易漏的——前两段只改观感，
// 真正决定同事答案生死的是提交时带不带它，而那一段在界面上完全看不见。
//
// 判据取自源码单一事实源：
//   routes/clarify.detail.tsx:147-168   locked 集合：仅**本轮**（originNodeRunId 相同）且已 seal / 已下发的题
//   routes/clarify.detail.tsx:944-953   locked ⇒ 包一层 --locked 并打 data-locked
//   routes/clarify.detail.tsx:503-505   提交前 `.filter((q) => !lockedQuestionIds.has(q.id))`
//   routes/clarify.ts:245-258           控制通道才允许 questionIds 子集（B36 已锁）
//
// 覆盖边界（如实记，别让读的人以为这条比实际更宽）：`lockedQuestionIds` 里还有一条
// **轮次范围限定**（`originNodeRunId !== nodeRunId` 时跳过），防的是「兄弟轮复用了同名
// question id ⇒ 把本轮的同名题误锁灰」。本条 fixture 只有一轮，去掉那句限定**不会红**
// ——要打中它得在同一个任务里造出两轮共存的澄清，clarify stub 现有的轮次标记机制做不到。
// 这条留给后续批次（与 HUMAN-25 集中回答面板同批更顺手）。

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
let nodeRunId: string
let iteration: number

/** 同事在别处给 q-db 填的答案：提交完之后它必须还在。 */
const COLLEAGUE_CUSTOM = 'rfc319-b52-colleague-picked-duckdb'

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

async function openClarify(page: Page): Promise<void> {
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
  await expect(page.getByTestId('clarify-question-q-lang')).toBeVisible()
}

const wrapperOf = (page: Page, questionId: string) =>
  page.locator(`[data-question-wrapper-id="${questionId}"]`)

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-xchannel-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 cross-channel fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-xchannel-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-xchannel-designer',
      description: 'RFC-319 cross-channel fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-xchannel-wf',
      description: 'RFC-319 cross-channel fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-xchannel-designer',
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
      name: 'rfc319-xchannel-task',
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
  nodeRunId = session!.intermediaryNodeRunId
  iteration = session!.iteration
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('正向对照：没被别处动过时，两题都可答', async ({ page }) => {
  // 没有这一段，「所有题永远变灰」也能让后面每条断言成立。
  await openClarify(page)
  for (const qid of ['q-db', 'q-lang']) {
    await expect(wrapperOf(page, qid)).not.toHaveAttribute('data-locked', 'true')
  }
  await expect(
    page.getByTestId('clarify-question-q-db').locator('input[data-option-idx="0"]'),
  ).toBeEnabled()
})

test('别处封存过的那题：变灰、动不了、且不被这次提交带走', async ({ page }) => {
  // 同事走控制通道，只封存 q-db（`defer:true` + `questionIds` 子集，见 B36）。
  const sealed = await fetch(`${daemon.baseUrl}/api/clarify/${nodeRunId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-db',
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: COLLEAGUE_CUSTOM,
        },
      ],
      questionIds: ['q-db'],
      ifMatchIteration: iteration,
      directive: 'continue',
      defer: true,
    }),
  })
  expect(sealed.ok, `defer seal: ${sealed.status} ${await sealed.text()}`).toBe(true)

  const submits: Array<{ questionIds: string[] }> = []
  await page.route('**/api/clarify/*/answers', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        answers?: Array<{ questionId: string }>
      }
      submits.push({ questionIds: (body.answers ?? []).map((a) => a.questionId) })
    }
    await route.fallback()
  })

  await openClarify(page)
  // ① 看得出。
  await expect(wrapperOf(page, 'q-db'), '别处封存过的题要变灰').toHaveAttribute(
    'data-locked',
    'true',
  )
  await expect(wrapperOf(page, 'q-lang'), '没被动过的题不该跟着变灰').not.toHaveAttribute(
    'data-locked',
    'true',
  )
  // ② 动不了。
  await expect(
    page.getByTestId('clarify-question-q-db').locator('input[data-option-idx="0"]'),
  ).toBeDisabled()
  await expect(
    page.getByTestId('clarify-question-q-lang').locator('input[data-option-idx="0"]'),
  ).toBeEnabled()

  // ③ 不带走。这一段在界面上完全看不见，却是真正决定同事答案生死的一段：
  //    带上它要么覆盖掉同事的答案，要么被服务端的 exactly-once 守卫整批拒掉。
  await page.getByTestId('clarify-question-q-lang').locator('input[data-option-idx="0"]').check()
  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/clarify/${nodeRunId}`)).status, {
      timeout: 60_000,
    })
    .toBe('answered')

  expect(submits.length, '应当恰好提交一次').toBe(1)
  expect(submits[0]!.questionIds, '提交载荷里不该出现别处已封存的那题').toEqual(['q-lang'])

  // ④ 同事的答案原样还在——这是上面三段合起来要保护的东西。
  const detail = await api<{
    answers: Array<{ questionId: string; customText: string }> | null
  }>(`/api/clarify/${nodeRunId}`)
  const qDb = (detail.answers ?? []).find((a) => a.questionId === 'q-db')
  expect(qDb?.customText, '同事在别处填的答案必须原样保留').toBe(COLLEAGUE_CUSTOM)
})
