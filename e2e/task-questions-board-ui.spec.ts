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

// ---------------------------------------------------------------------------
// TASK-39 补漏 —— 看板上的三个**控件**。
//
// B49 把四段生命周期都验过了，但**全部走 REST**：`tq-add-question` /
// `tq-stage-{id}` / `tq-batch-dispatch` 三个按钮在全仓 e2e 里一次都没被点过。
// 「后端对、按钮没接上」正是这块板最容易坏的形态，而且它的失效完全静默：
//
//   * 新增问题的表单少拷一个字段（handler 没绑上 state），Save 永远灰着，
//     或者存进去的是一条没有承接节点的题——那句话谁也不会处理；
//   * 「加入待下发 / 移出」按错行（组卡取 `rep.id` 而不是整组 handler），
//     人以为整题都进了待下发，实际只进了一半；
//   * 「一键下发」把当前视图的 staged 卡全展开成 entryIds（TaskQuestionList.tsx:317）。
//     它空转的话，题目永远停在「待下发」那一列——没有报错、没有日志，
//     任务再也不会动，而看板上一切看起来都「已经处理过了」。
//
// 判据取自源码单一事实源：
//   components/tasks/TaskQuestionList.tsx:250-262   「+ 新增问题」按钮
//   components/tasks/QuestionAuthorForm.tsx:74-77   title/body/handler 三者齐全才放行
//   components/tasks/QuestionAuthorForm.tsx:59-70   成功后失效看板查询并关闭弹窗
//   components/tasks/TaskQuestionList.tsx:455-473   组级 stage / unstage 的 id 取法
//   components/tasks/TaskQuestionList.tsx:315-318   staged 卡 → entryIds 展开
//   components/tasks/TaskQuestionList.tsx:359-372   一键下发按钮与它的计数
//   services/taskQuestions.ts:1382-1387            人工提问建出来就是 staged
// ---------------------------------------------------------------------------

const MANUAL_TITLE = 'rfc319-boardui-manual-question'
const MANUAL_BODY = 'rfc319-boardui-also-write-the-migration-note'
const HANDLER_LABEL = 'rfc319-boardui-alpha'

test('看板上的三个控件真的通到服务端：手写一题、逐题暂存、一键下发 @nightly', async ({ page }) => {
  await openBoard(page)
  const before = await board()

  // ---- ① 「+ 新增问题」----------------------------------------------------
  await page.getByTestId('tq-add-question').click()
  const form = page.getByTestId('question-author-form')
  await expect(form, '点了「+ 新增问题」没有弹出表单').toBeVisible()

  const save = page.getByTestId('question-author-save')
  await expect(save, '空表单就能提交 ⇒ 会往任务里塞一条没有内容的题').toBeDisabled()
  await page.getByTestId('question-author-title').fill(MANUAL_TITLE)
  await page.getByTestId('question-author-body').fill(MANUAL_BODY)
  // §15 的硬契约：人工提问**必须**指定承接节点。只填标题正文就能存的话，
  // 那条题没有任何人会处理，而人以为自己交代过了。
  await expect(save, '没选承接节点就能保存 ⇒ 建出来一条没人接的题，它永远不会被下发').toBeDisabled()

  await page.getByRole('combobox', { name: 'Handler node', exact: true }).click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox, '承接节点下拉没有打开').toBeVisible()
  await listbox.getByRole('option', { name: HANDLER_LABEL, exact: true }).click()
  await expect(save, '三项都填齐了保存还是灰的 ⇒ 这个表单交不出去').toBeEnabled()

  await save.click()
  await expect(form, '保存成功后弹窗没关 ⇒ 人不知道到底存没存进去').toHaveCount(0)

  // 服务端对账：真的多出一条 manual 条目，正文与承接节点都对得上。
  const afterCreate = await board()
  expect(afterCreate.length, '点了保存，看板上没有多出那一条').toBe(before.length + 1)
  const manual = afterCreate.find((entry) => !before.some((old) => old.id === entry.id))
  expect(manual, '新增的那条在看板接口里找不到').toBeDefined()
  expect(
    manual!.effectiveTargetNodeId,
    '弹窗里选的承接节点没有跟着存进去 ⇒ 这条题会挂在一个没人认领的位置上',
  ).toBe('designer_a')
  expect(manual!.phase, '人工提问建出来就该在「待下发」（§15：有 handler ⇒ 直接可下发）').toBe(
    'staged',
  )

  // 界面上也要看得见——建进了库却不进这块板，等于那句话消失了。
  const manualCard = page.getByTestId(`tq-card-${manual!.id}`)
  await expect(manualCard, '新建的那条没有出现在看板上').toBeVisible()
  await expect(colOf(page, 'staged').getByTestId(`tq-card-${manual!.id}`)).toHaveCount(1)
  await expect(manualCard, '卡上不是刚写的那个标题').toContainText(MANUAL_TITLE)

  // ---- ② 「加入待下发 / 移出」-------------------------------------------
  // 人工提问建出来就是 staged，所以这个按钮此刻是「移出」。一来一回两次都要
  // 真的改到服务端：只改界面的话，人以为撤回了，下一次一键下发照样把它发出去。
  const stageButton = page.getByTestId(`tq-stage-${manual!.id}`)
  await expect(stageButton, '待下发的卡上没有「移出」按钮').toHaveText('Unstage')
  await stageButton.click()
  await expect
    .poll(async () => (await board()).find((e) => e.id === manual!.id)?.phase, {
      timeout: 30_000,
      message: '点了「移出」服务端还停在 staged ⇒ 撤回只是界面上的错觉',
    })
    .toBe('pending')
  await expect(colOf(page, 'pending').getByTestId(`tq-card-${manual!.id}`)).toHaveCount(1)

  await expect(stageButton, '移出之后按钮没有变回「加入待下发」').toHaveText('Stage')
  await stageButton.click()
  await expect
    .poll(async () => (await board()).find((e) => e.id === manual!.id)?.phase, {
      timeout: 30_000,
      message: '点了「加入待下发」服务端没有跟上 ⇒ 这一题永远进不了下发批次',
    })
    .toBe('staged')

  // ---- ③ 「一键下发」-----------------------------------------------------
  const stagedIds = (await board()).filter((entry) => entry.phase === 'staged').map((e) => e.id)
  expect(
    stagedIds.length,
    '待下发列是空的 ⇒ 下面那颗按钮压根不该出现，这一段测不到东西',
  ).toBeGreaterThan(0)
  const dispatch = page.getByTestId('tq-batch-dispatch')
  await expect(
    dispatch,
    '按钮上的条数与服务端「待下发」的条数对不上 ⇒ 人点下去发出的不是他以为的那一批',
  ).toHaveText(`Dispatch all (${stagedIds.length})`)

  await dispatch.click()
  // 真正要锁的是**条目真的离开了「待下发」**，而不是「请求返回 200 了」——
  // 这一段的所有失效形态都返回 200。
  await expect
    .poll(
      async () => {
        const rows = await board()
        return stagedIds.filter((id) => rows.find((e) => e.id === id)?.phase === 'staged').length
      },
      {
        timeout: 120_000,
        message: '点了一键下发，条目还停在「待下发」⇒ 任务再也不会动，而看板上看起来一切正常',
      },
    )
    .toBe(0)
  // 下发之后这颗按钮要自己消失（没有 staged 卡 ⇒ 不渲染下发条），
  // 否则人会对着一颗只会 422 的按钮反复点。
  await expect(
    page.getByTestId('tq-batch-dispatch-bar'),
    '全部下发完了还留着下发条 ⇒ 再点一次只会得到「entry-ids-required」',
  ).toHaveCount(0, { timeout: 30_000 })
})
