// RFC-319 B55 —— HUMAN-20：任务问题看板的**界面面**（按承接节点过滤 + 五列分阶段）。
//
// B49 锁的是看板的四个动作（人工提问 / 暂存下发 / 确认 / 改派）在服务端是否真的生效；
// 这一条锁的是**人怎么在这块板上找到自己该干的那张卡**。两个东西坏掉都不会报错：
//
//   * **五列的分阶段**：卡片按 `pending / staged / processing / awaiting_confirm / done`
//     分列。列错了位，人就在「待指派」里找不到那张真的待指派的卡——他会以为没有待办。
//   * **按承接节点过滤**：一条任务上常有多个提问节点各自在问。过滤器坏掉（点了不筛、
//     或筛错节点）时，人会在一堆卡里挑，而挑错的那张属于另一个节点的上下文。
//
// 这两件事只有**多个提问节点**才验得出来：单节点 fixture 下「过滤器点了什么都不做」
// 与「过滤正确」完全同形。所以这条用例特意造了两条并行的 designer+clarify 分支。
//
// 判据取自源码单一事实源：
//   components/tasks/TaskQuestionList.tsx:84-90    五列的顺序
//   components/tasks/TaskQuestionList.tsx:397-405  逐列渲染 + data-phase + 计数
//   components/tasks/TaskQuestionList.tsx:326-354  承接节点过滤 chip（含「全部」与逐节点计数）
//   routes/tasks.detail.tsx:1298-1302              看板挂在 `?tab=task-questions`

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
/** 两个提问节点各自的澄清轮。 */
let roundA: { nodeRunId: string; iteration: number }
let roundB: { nodeRunId: string; iteration: number }

const PHASES = ['pending', 'staged', 'processing', 'awaiting_confirm', 'done'] as const

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
  sourceNodeId: string | null
  effectiveTargetNodeId: string | null
}
const board = async (): Promise<BoardEntry[]> => api<BoardEntry[]>(`/api/tasks/${taskId}/questions`)

async function openBoard(page: Page): Promise<void> {
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
}

const colOf = (page: Page, phase: string) =>
  page.locator(`.task-questions__col[data-phase="${phase}"]`)

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-boardui-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 board ui fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-boardui-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  // 两个 agent：clarify stub 的轮次标记按 agent 名分键，同名的话第二个不会再问。
  const mk = async (slug: string) =>
    (
      await api<{ id: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: `rfc319-boardui-${slug}`,
          description: 'RFC-319 board UI fixture',
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
      name: 'rfc319-boardui-wf',
      description: 'RFC-319 board UI fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer_a',
            kind: 'agent-single',
            agentId: agentA,
            agentName: 'rfc319-boardui-alpha',
            promptTemplate: 'Design A for {{topic}}.',
            position: { x: 320, y: -120 },
          },
          {
            id: 'designer_b',
            kind: 'agent-single',
            agentId: agentB,
            agentName: 'rfc319-boardui-beta',
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
      name: 'rfc319-boardui-task',
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
    iteration: number
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
  const a = rows.find((r) => r.intermediaryNodeId === 'clarify_a')!
  const b = rows.find((r) => r.intermediaryNodeId === 'clarify_b')!
  roundA = { nodeRunId: a.intermediaryNodeRunId, iteration: a.iteration }
  roundB = { nodeRunId: b.intermediaryNodeRunId, iteration: b.iteration }
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('五列都在、顺序固定，且卡片按阶段落在对的那一列 @nightly', async ({ page }) => {
  const rows = await board()
  expect(rows.length, '两个提问节点各两题 ⇒ 看板上应有 4 条').toBe(4)
  expect(
    rows.every((r) => r.phase === 'pending'),
    '这会儿都还没答，全在待指派',
  ).toBe(true)

  await openBoard(page)
  // 列的存在与顺序：少一列的话，那一列里的卡就从视野里消失了，而人不会知道。
  const cols = page.locator('.task-questions__col')
  await expect(cols).toHaveCount(PHASES.length)
  expect(await cols.evaluateAll((els) => els.map((e) => e.getAttribute('data-phase')))).toEqual([
    ...PHASES,
  ])
  // 四张卡全在「待指派」，别的列都空。
  await expect(colOf(page, 'pending').locator('[data-testid^="tq-card-"]')).toHaveCount(4)
  for (const phase of PHASES.filter((p) => p !== 'pending')) {
    await expect(colOf(page, phase).locator('[data-testid^="tq-card-"]')).toHaveCount(0)
  }

  // 封存 A 的两题（控制通道 autoStage ⇒ 进「待下发」），卡必须换列。
  const sealed = await fetch(`${daemon.baseUrl}/api/clarify/${roundA.nodeRunId}/answers`, {
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
      ifMatchIteration: roundA.iteration,
      directive: 'stop',
      defer: true,
    }),
  })
  expect(sealed.ok, `defer seal: ${sealed.status} ${await sealed.text()}`).toBe(true)

  // B 那一轮没被动过——控制通道只封存被点名的那一轮，不该顺手推进另一个提问节点。
  expect(
    (await api<{ status: string }>(`/api/clarify/${roundB.nodeRunId}`)).status,
    '只封存了 A，B 那一轮必须原样还在等人',
  ).toBe('awaiting_human')

  await openBoard(page)
  await expect(colOf(page, 'staged').locator('[data-testid^="tq-card-"]')).toHaveCount(2)
  await expect(colOf(page, 'pending').locator('[data-testid^="tq-card-"]')).toHaveCount(2)
})

test('按承接节点过滤：点一个节点只剩它的卡，「全部」把两边都放回来 @nightly', async ({ page }) => {
  await openBoard(page)
  const filter = page.getByTestId('tq-node-filter')
  await expect(filter).toBeVisible()

  // 两个提问节点各自一个 chip，各带 (2)。计数错了的话人会以为某个节点没有待办。
  const chipA = page.getByTestId('tq-node-filter-designer_a')
  const chipB = page.getByTestId('tq-node-filter-designer_b')
  await expect(chipA).toBeVisible()
  await expect(chipB).toBeVisible()
  await expect(chipA).toContainText('(2)')
  await expect(chipB).toContainText('(2)')

  const allCards = page.locator('[data-testid^="tq-card-"]')
  await expect(allCards, '未过滤时四张卡都在').toHaveCount(4)

  // 点 A：只剩 A 的两张。「点了不筛」与「筛对了」在单节点 fixture 下同形，
  // 所以这条必须同时断言**另一边消失了**。
  await chipA.click()
  await expect(allCards, '点了 designer_a 之后应当只剩它的两张卡').toHaveCount(2)
  await expect(colOf(page, 'staged').locator('[data-testid^="tq-card-"]')).toHaveCount(2)
  await expect(colOf(page, 'pending').locator('[data-testid^="tq-card-"]')).toHaveCount(0)

  // 点 B：换成 B 的两张（都还在待指派）。
  await chipB.click()
  await expect(allCards).toHaveCount(2)
  await expect(colOf(page, 'pending').locator('[data-testid^="tq-card-"]')).toHaveCount(2)
  await expect(colOf(page, 'staged').locator('[data-testid^="tq-card-"]')).toHaveCount(0)

  // 「全部」把两边放回来。
  await filter.getByRole('button', { name: /All nodes/i }).click()
  await expect(allCards).toHaveCount(4)
})
