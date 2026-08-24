// RFC-319 B56 —— HUMAN-25：集中回答面板（跨轮多题一次性作答）。
//
// 面板是「一次把手头几轮的问题都答掉」的入口。它比澄清页多两件事，而这两件事
// **都发生在请求里、界面上完全看不见**：
//
//   * **只提交你真填了的那些题**。面板会把当前所有待答的问题一次列出来，其中大多数
//     你并不打算现在答。若提交时把没填的也一并送上，那些题会被**当作「已答成空」封存**
//     ——它们从待答池里消失，而没有任何人回答过。事后翻看板只会看到「已处理」。
//   * **重答已封存的题必须显式声明**（`resubmitQuestionIds`）。服务端的封存是
//     exactly-once 的，没有这个声明就会整批被拒；而漏掉声明的表现是「点了提交没反应」。
//
// 还有一条边界：面板走的是**控制通道**（`defer:true`），所以提交完任务**仍停在等人上**
// ——它只封存、不下发。把它写成快速通道会让任务在人还没答完其余几题时就跑掉。
//
// 判据因此打在请求层（沿用 B27 / B52 的教训）：断言载荷里 `questionIds` 恰好是我填的那些、
// `defer` 为真、重答那次带上了声明。
//
// 判据取自源码单一事实源：
//   components/clarify/CentralizedAnswerDialog.tsx:13     提交走 defer:true + questionIds 上限
//   components/clarify/CentralizedAnswerDialog.tsx:100    重答走 resubmitQuestionIds（面板预填已封存答案）
//   components/clarify/CentralizedAnswerDialog.tsx:538-551 只有填了才可提交，按钮带计数
//   routes/clarify.ts:245-262                             这两个字段只在控制通道上合法（B36 已锁）

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
let roundA: { nodeRunId: string }
let roundB: { nodeRunId: string }

interface SubmitFrame {
  url: string
  defer: unknown
  questionIds: string[]
  resubmitQuestionIds: string[]
  answered: string[]
}

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

interface BoardEntry {
  id: string
  questionId: string
  phase: string
  originNodeRunId: string
}
const board = async (): Promise<BoardEntry[]> => api<BoardEntry[]>(`/api/tasks/${taskId}/questions`)
const taskStatus = async (): Promise<string> =>
  (await api<{ status: string }>(`/api/tasks/${taskId}`)).status

/** 录下面板发出的每一次提交载荷——这条用例的判据全在请求里。 */
async function captureSubmits(page: Page, sink: SubmitFrame[]): Promise<void> {
  await page.route('**/api/clarify/*/answers', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        defer?: unknown
        questionIds?: string[]
        resubmitQuestionIds?: string[]
        answers?: Array<{ questionId: string }>
      }
      sink.push({
        url: route.request().url(),
        defer: body.defer,
        questionIds: body.questionIds ?? [],
        resubmitQuestionIds: body.resubmitQuestionIds ?? [],
        answered: (body.answers ?? []).map((a) => a.questionId),
      })
    }
    await route.fallback()
  })
}

async function openPane(page: Page): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/tasks/${encodeURIComponent(taskId)}?tab=task-questions`)
  await expect(page.getByTestId('task-questions-board')).toBeVisible()
  await page.getByTestId('tq-open-answer-pane').click()
  await expect(page.getByTestId('centralized-answer-dialog')).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-pane-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 answer pane fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-pane-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const mk = async (slug: string) =>
    (
      await api<{ id: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: `rfc319-pane-${slug}`,
          description: 'RFC-319 answer pane fixture',
          outputs: ['design'],
          outputKinds: { design: 'markdown' },
          readonly: true,
          bodyMd: '',
        }),
      })
    ).id
  const agentA = await mk('alpha')
  const agentB = await mk('beta')

  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-pane-wf',
      description: 'RFC-319 answer pane fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer_a',
            kind: 'agent-single',
            agentId: agentA,
            agentName: 'rfc319-pane-alpha',
            promptTemplate: 'Design A for {{topic}}.',
            position: { x: 320, y: -120 },
          },
          {
            id: 'designer_b',
            kind: 'agent-single',
            agentId: agentB,
            agentName: 'rfc319-pane-beta',
            promptTemplate: 'Design B for {{topic}}.',
            position: { x: 320, y: 160 },
          },
          { id: 'clarify_a', kind: 'clarify', title: 'Clarify A', position: { x: 600, y: -120 } },
          { id: 'clarify_b', kind: 'clarify', title: 'Clarify B', position: { x: 600, y: 160 } },
        ],
        edges: [
          {
            id: 'e_in_a',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'designer_a', portName: 'topic' },
          },
          {
            id: 'e_in_b',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'designer_b', portName: 'topic' },
          },
          {
            id: 'e_ask_a',
            source: { nodeId: 'designer_a', portName: '__clarify__' },
            target: { nodeId: 'clarify_a', portName: 'questions' },
          },
          {
            id: 'e_ans_a',
            source: { nodeId: 'clarify_a', portName: 'answers' },
            target: { nodeId: 'designer_a', portName: '__clarify_response__' },
          },
          {
            id: 'e_ask_b',
            source: { nodeId: 'designer_b', portName: '__clarify__' },
            target: { nodeId: 'clarify_b', portName: 'questions' },
          },
          {
            id: 'e_ans_b',
            source: { nodeId: 'clarify_b', portName: 'answers' },
            target: { nodeId: 'designer_b', portName: '__clarify_response__' },
          },
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-pane-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  interface Session {
    intermediaryNodeId: string
    intermediaryNodeRunId: string
  }
  let rows: Session[] = []
  await expect
    .poll(
      async () => {
        rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        return rows.length
      },
      { timeout: 180_000 },
    )
    .toBe(2)
  roundA = {
    nodeRunId: rows.find((r) => r.intermediaryNodeId === 'clarify_a')!.intermediaryNodeRunId,
  }
  roundB = {
    nodeRunId: rows.find((r) => r.intermediaryNodeId === 'clarify_b')!.intermediaryNodeRunId,
  }
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('只提交我真填了的那一题：没填的不许被当成「已答成空」封掉', async ({ page }) => {
  const submits: SubmitFrame[] = []
  await captureSubmits(page, submits)
  await openPane(page)

  // 面板把两轮的问题都列出来了（跨轮一次性作答正是它存在的理由）。
  await expect(page.getByTestId(`centralized-round-${roundA.nodeRunId}`)).toBeVisible()
  await expect(page.getByTestId(`centralized-round-${roundB.nodeRunId}`)).toBeVisible()

  // 一个都没填时提交键必须是禁用的——否则一次误点会把四道题全部封成空。
  const submit = page.getByTestId('centralized-answer-submit')
  await expect(submit, '一个都没填时不该能提交').toBeDisabled()

  // 只填 A 轮的 q-db。
  const roundACard = page.getByTestId(`centralized-round-${roundA.nodeRunId}`)
  await roundACard
    .getByTestId('clarify-question-q-db')
    .locator('input[data-option-idx="0"]')
    .check()
  await expect(submit, '按钮上的计数要如实反映填了几题').toContainText('1')
  await submit.click()
  await expect(page.getByTestId('centralized-answer-dialog')).toHaveCount(0, { timeout: 30_000 })

  // 判据在请求里：只提交我填的那一题，且走控制通道。
  expect(submits.length, '只填了一轮里的一题 ⇒ 只该发一次提交').toBe(1)
  const f = submits[0]!
  expect(f.url, '应当提交到 A 那一轮').toContain(roundA.nodeRunId)
  expect(f.defer, '面板走控制通道：只封存、不下发').toBe(true)
  expect(f.questionIds, '没填的题不许被带上——它们会被当成「已答成空」封掉').toEqual(['q-db'])
  expect(f.resubmitQuestionIds, '首答不是重答').toEqual([])

  // 看板与任务状态：只有那一题进「待下发」，任务仍停在等人上。
  const rows = await board()
  const sealedOnes = rows.filter((r) => r.phase === 'staged')
  expect(
    sealedOnes.map((r) => r.questionId),
    '只该封存我填的那一题',
  ).toEqual(['q-db'])
  expect(sealedOnes[0]!.originNodeRunId).toBe(roundA.nodeRunId)
  expect(rows.filter((r) => r.phase === 'pending').length, '其余三题必须原样待答').toBe(3)
  expect(await taskStatus(), '控制通道不推进任务').toBe('awaiting_human')
})

test('重答一道已封存的题：必须带上显式的重答声明，否则会被 exactly-once 守卫整批拒掉', async ({
  page,
}) => {
  // 前置：把那题从「待下发」**撤回**。面板会把 staged 的题整个排除
  // （`CentralizedAnswerDialog.tsx:107-125`：任何非 pending 的兄弟行都让整题出局，
  // 防的是「半新半旧」的题被重复下发），所以重答针对的是「已封存但仍待指派」那一档。
  // 这也是一条真实路径：在面板里答完、又想改，先把它从待下发拉回来。
  const staged = (await board()).find((r) => r.questionId === 'q-db' && r.phase === 'staged')
  expect(staged, '上一条应当留下一条 staged 的 q-db').toBeDefined()
  const un = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/questions/${staged!.id}/stage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ staged: false }),
  })
  expect(un.ok, `unstage: ${un.status} ${await un.text()}`).toBe(true)
  expect(
    (await board()).find((r) => r.questionId === 'q-db' && r.originNodeRunId === roundA.nodeRunId)
      ?.phase,
    '撤回之后应当回到待指派（但仍是已封存的）',
  ).toBe('pending')

  const submits: SubmitFrame[] = []
  await captureSubmits(page, submits)
  await openPane(page)

  // 现在它是「已封存待指派」，面板允许重答并预填了已提交的答案。
  const roundACard = page.getByTestId(`centralized-round-${roundA.nodeRunId}`)
  await expect(
    page.getByTestId('centralized-resubmit-hint-q-db'),
    '已封存的题要提示这是一次重答',
  ).toBeVisible()

  // 改成另一个选项 ⇒ 这题变成一次重答。
  await roundACard
    .getByTestId('clarify-question-q-db')
    .locator('input[data-option-idx="1"]')
    .check()
  const submit = page.getByTestId('centralized-answer-submit')
  await submit.click()
  await expect(page.getByTestId('centralized-answer-dialog')).toHaveCount(0, { timeout: 30_000 })

  expect(submits.length).toBe(1)
  const f = submits[0]!
  expect(f.questionIds).toContain('q-db')
  expect(
    f.resubmitQuestionIds,
    '漏掉重答声明的表现是「点了提交没反应」——服务端的封存是 exactly-once 的',
  ).toContain('q-db')

  // 重答真的落地了：那题的答案换成了第二个选项。
  const detail = await api<{
    answers: Array<{ questionId: string; selectedOptionIndices: number[] }> | null
  }>(`/api/clarify/${roundA.nodeRunId}`)
  const qDb = (detail.answers ?? []).find((a) => a.questionId === 'q-db')
  expect(qDb?.selectedOptionIndices, '重答之后应当是新选的那一项').toEqual([1])
})
