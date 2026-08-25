// RFC-319 B63 —— HUMAN-47 / HUMAN-X6：任务反馈（写给未来的自己）与它的蒸馏去向。
//
// 这一屏的价值全在「写下去之后会怎样」：任务跑完了，人回头写一句「下次别再用
// 那个模板了」。这句话要么进了记忆蒸馏、以后真的会被用上，要么就只是躺在一个
// 没人看的列表里。差别在界面上只有一个小徽标，所以它必须是真的：
//
//   * **写下去要真的排进蒸馏**（HUMAN-47）。后端在插入行的同一条链路里 enqueue 一个
//     distill job 并把 `distilled` 置位（`services/taskFeedback.ts:48-70`）。徽标要是
//     写死的，人会以为每条都进了蒸馏，实际可能一条都没排上。
//   * **连点要有节流**（HUMAN-47）。3 秒的客户端闸（`TaskFeedbackList.tsx:40,128-135`）。
//     没有它，一次手抖就往同一个任务里灌好几条一模一样的笔记，蒸馏那头还得逐条处理。
//   * **看不见的任务与不存在的任务，404 必须逐字节同形**（HUMAN-47）。两者一旦能分辨，
//     任何人都能拿任务 id 探测「这个 id 存不存在」——`routes/taskFeedback.ts:67-80`
//     的注释逐字写着这条曾被 byte-oracle 抓到过残余可区分性。
//   * **深链要能定位到具体那一条**（HUMAN-X6）。蒸馏出来的记忆候选会带着来源链接指回
//     这条反馈；链接点开落不到那一行，追溯就断了。
//
// 覆盖边界（如实记）：`routes/taskFeedback.ts` 自己那句「不可见 ⇒ 404」**测不出来**——
// 把它改成可区分的 403 文案，本用例照样绿。原因是这条路由挂在 `/api/tasks/:id/*` 的
// 可见性中间件之下，外人根本走不到路由自己的那一行；真正兜住这条保证的是
// `routes/tasks.ts:1204-1208` 的中间件（改它当场红）。路由里那句是**双保险的第二层**，
// 注释也这么写着。记在这里，免得后人看到「改了没红」误以为没覆盖。
//
// 判据取自源码单一事实源：
//   services/taskFeedback.ts:48-72        插入 + enqueueDistillJob + distilled 置位
//   routes/taskFeedback.ts:67-80          两个 404 分支逐字节同形（含带引号文案）
//   shared/schemas/taskFeedback.ts:17-19  bodyMd trim + 1..4000
//   components/tasks/TaskFeedbackList.tsx:40,128-135  3 秒节流闸与提示条
//   components/tasks/TaskFeedbackList.tsx:42-44,91-122  锚点 id 与 hash 定位 + 移焦

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const NOTE_ONE = 'RFC-319 B63: next time, skip the boilerplate template.'
const NOTE_TWO = 'RFC-319 B63: and pin the runtime version.'

let daemon: DaemonHandle
let repoDir: string
let taskId: string
/** 一个**非管理员**的第二个人：管理员看得见所有任务，用他测不出「不可见」。 */
let outsiderToken: string

function apiFetch(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

interface FeedbackRow {
  id: string
  bodyMd: string
  distilled: boolean
  distillJobId: string | null
}

async function feedbackRows(): Promise<FeedbackRow[]> {
  return (await api<{ items: FeedbackRow[] }>(`/api/tasks/${taskId}/feedback`)).items
}

async function openFeedbackTab(page: Page, hash = ''): Promise<void> {
  await page.goto(`${daemon.baseUrl}/tasks/${encodeURIComponent(taskId)}?tab=feedback${hash}`)
  await expect(page.getByTestId('task-feedback')).toBeVisible()
}

function seedAuth(page: Page): Promise<void> {
  return page.addInitScript(
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
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b63-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 b63 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon({ stubMode: 'basic' })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b63-worker',
      description: 'RFC-319 B63 fixture',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b63-wf',
      description: 'RFC-319 B63 fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'worker',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-b63-worker',
            promptTemplate: 'Work on {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'worker', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_in_worker',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'worker', portName: 'topic' },
          },
          {
            id: 'e_worker_out',
            source: { nodeId: 'worker', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b63-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'retro notes' },
    }),
  })
  taskId = task.id
  // 反馈面板对任何状态都开放，但让任务跑完更贴近真实场景（人是回头写复盘的）。
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
    })
    .toBe('done')

  const username = 'rfc319-b63-outsider'
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      displayName: 'RFC-319 B63 Outsider',
      role: 'user',
      password: 'outsider-pass-9F!x',
    }),
  })
  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'outsider-pass-9F!x' }),
  })
  expect(loginRes.ok, `login: ${loginRes.status}`).toBe(true)
  outsiderToken = ((await loginRes.json()) as { sessionToken: string }).sessionToken
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('写下一条反馈：它要真的排进蒸馏，而不是只在列表里躺着', async ({ page }) => {
  await seedAuth(page)
  await openFeedbackTab(page)
  await expect(page.getByTestId('task-feedback-empty')).toBeVisible()

  await page.getByTestId('task-feedback-textarea').fill(NOTE_ONE)
  await page.getByTestId('task-feedback-submit').click()

  await expect(page.getByTestId('task-feedback-list')).toBeVisible()
  await expect(page.getByTestId('task-feedback-distilled')).toHaveCount(1)

  // 服务端对账：徽标背后必须真有一个蒸馏任务，否则那个徽标就是句空话。
  const rows = await feedbackRows()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.bodyMd).toBe(NOTE_ONE)
  expect(rows[0]!.distilled, '徽标说进了蒸馏，行上却没置位').toBe(true)
  expect(rows[0]!.distillJobId, '置了位却没有 job id —— 那条笔记不会被任何人处理').not.toBeNull()
})

test('连点要被拦住：一次手抖不该往同一个任务里灌两条一样的笔记', async ({ page }) => {
  await seedAuth(page)
  await openFeedbackTab(page)
  await expect(page.getByTestId('task-feedback-list')).toBeVisible()

  // 第一条：正常写进去（把节流窗口的起点打上）。
  await page.getByTestId('task-feedback-textarea').fill(NOTE_TWO)
  await page.getByTestId('task-feedback-submit').click()
  await expect.poll(async () => (await feedbackRows()).length, { timeout: 15_000 }).toBe(2)

  // 紧接着再来一次：要出提示条，且**服务端不许多出一行**。
  await page.getByTestId('task-feedback-textarea').fill('rapid double tap')
  await page.getByTestId('task-feedback-submit').click()
  await expect(page.getByTestId('task-feedback-rate-limit')).toBeVisible()
  await page.waitForTimeout(1_000)
  expect((await feedbackRows()).length, '节流只挡了界面、请求照样发出去了').toBe(2)

  // 冷却过后要能继续写——只挡连点，不是把人挡在门外。
  await page.waitForTimeout(3_000)
  await expect(page.getByTestId('task-feedback-rate-limit')).toHaveCount(0)
  await page.getByTestId('task-feedback-textarea').fill('after the cooldown')
  await page.getByTestId('task-feedback-submit').click()
  await expect.poll(async () => (await feedbackRows()).length, { timeout: 15_000 }).toBe(3)
})

test('正文校验，以及「看不见」与「不存在」必须逐字节同形', async () => {
  // 空正文 / 超长都要被拒——不然蒸馏那头会收到一条没有信息量的作业。
  const empty = await apiFetch(`/api/tasks/${taskId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ bodyMd: '   ' }),
  })
  expect(empty.status).toBe(422)
  const tooLong = await apiFetch(`/api/tasks/${taskId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ bodyMd: 'x'.repeat(4001) }),
  })
  expect(tooLong.status).toBe(422)

  // 探测面：不存在的任务 vs 存在但看不见的任务。两者的状态码与**响应体**都必须一样，
  // 否则谁都能拿任务 id 逐个试出「这个 id 是不是真的」。
  const missingId = '01ZZZZZZZZZZZZZZZZZZZZZZZZ'
  const missing = await apiFetch(`/api/tasks/${missingId}/feedback`, {}, outsiderToken)
  const invisible = await apiFetch(`/api/tasks/${taskId}/feedback`, {}, outsiderToken)
  expect(missing.status).toBe(404)
  expect(invisible.status, '别人的私有任务必须也是 404，而不是 403').toBe(404)
  const missingBody = (await missing.text()).replace(missingId, '<id>')
  const invisibleBody = (await invisible.text()).replace(taskId, '<id>')
  expect(invisibleBody, '两个 404 的响应体不一样 —— 拿任务 id 就能探测它到底存不存在').toBe(
    missingBody,
  )
})

test('深链要落到具体那一条：蒸馏出来的记忆指回来时，追溯不能断在半路', async ({ page }) => {
  await seedAuth(page)
  const rows = await feedbackRows()
  // 挑**最后**那一条：落在第一条上可能只是「本来就在视口里」，说明不了定位真的发生过。
  const target = rows[rows.length - 1]!
  await openFeedbackTab(page, `#feedback-${target.id}`)

  const row = page.getByTestId(`task-feedback-row-${target.id}`)
  await expect(row).toBeVisible()
  // 移焦是这条契约里可判定的那一半：滚动位置会因视口高度而异，焦点不会。
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.id ?? ''), { timeout: 15_000 })
    .toBe(`feedback-${target.id}`)

  // 认不出的锚点不许把焦点乱扔到别的行上。
  // 先手动 blur：只改 hash 属于同文档导航，页面不会重载，上一步落在目标行上的焦点会
  // 原样留着——不清掉的话这条断言测的是上一步的残留，不是本步的行为。
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await openFeedbackTab(page, '#feedback-01ZZZZZZZZZZZZZZZZZZZZZZZZ')
  await expect(page.getByTestId('task-feedback-list')).toBeVisible()
  await page.waitForTimeout(500)
  expect(
    await page.evaluate(() => document.activeElement?.id ?? ''),
    '锚点认不出来时把焦点扔到了某一行上 —— 人会以为那就是链接指的那条',
  ).not.toContain('feedback-')
})
