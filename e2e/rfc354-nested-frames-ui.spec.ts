// RFC-354 T18 —— 嵌套 wrapper 的「帧」一路走到任务详情页。
//
// 后端把每一行的帧 `(container_run_id, iteration)` 与派生面包屑 `scope_path`
// 都投影上了 wire（`/api/tasks/:id/node-runs`），前端 `lib/node-history.ts` 把它
// 渲染成 `outer#1 › inner#0` 并按帧给运行历史分组。但在此之前，这条链路上只有
// **单测**：`packages/frontend/tests/rfc354-frame-breadcrumb.test.ts` 用手搓的
// `NodeRun` 对象验证纯函数，再用**源码文本**断言组件调用了那些函数——两头都没有
// 真 daemon 产出的行，也没有一次真实渲染。
//
// 这条用例补的正是中间那一段：真跑一个 loop-in-loop 任务（外 2 × 内 2 = 4 次调起），
// 然后在浏览器里读页面：
//   ① 运行列表的轮次列对**每一条**内层行显示它自己的面包屑，四条互不相同——
//      而它们的裸 `iteration` 只有 0 / 1 两个值，各出现两次；
//   ② 顶层作用域的行（output 节点）仍显示裸计数，没有面包屑；
//   ③ 节点抽屉的 Stats 页签显示当前这次运行的帧，且运行历史按帧分组，
//      四个分组标题就是那四个面包屑。
//
// 判据取自源码单一事实源：
//   packages/frontend/src/routes/tasks.detail.tsx:1869-1873   轮次列：有帧走面包屑，否则裸计数
//   packages/frontend/src/components/NodeDetailDrawer.tsx:401-408  Stats 的 frame 行
//   packages/frontend/src/components/NodeDetailDrawer.tsx:501-514  运行历史按帧分组的标题
//   packages/frontend/src/lib/node-history.ts:87-95           `outer:1/inner:0` → `outer#1 › inner#0`

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'
import { loadWorkflowFixture } from './workflow-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'examples', 'workflows', 'e2e', 'wrapper-loop-nested.yaml')

test.setTimeout(300_000)

interface NodeRunRow {
  id: string
  nodeId: string
  iteration: number
  scopePath: string
  status: string
}

let daemon: DaemonHandle
let repoDir = ''
let stateDir = ''
let taskId = ''
let runs: NodeRunRow[] = []

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

/** `outer_loop:1/inner_loop:0` → `outer_loop#1 › inner_loop#0`（前端的渲染契约）。 */
function breadcrumbOf(scopePath: string): string {
  return scopePath
    .split('/')
    .map((segment) => {
      const at = segment.lastIndexOf(':')
      return `${segment.slice(0, at)}#${segment.slice(at + 1)}`
    })
    .join(' › ')
}

async function primePage(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'aw-rfc354-frames-state-'))
  daemon = await startDaemon({
    stubMode: 'workflow-matrix',
    extraEnv: { MATRIX_STATE_DIR: stateDir },
  })

  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc354-frames-repo-'))
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'README.md'), '# rfc-354 nested frames fixture\n')
  initGitRepo(repoDir)

  await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'matrix-nested-worker',
      description: 'RFC-354 nested-frames UI fixture',
      outputs: ['status', 'outer_status'],
      outputKinds: { status: 'string', outer_status: 'string' },
      readonly: true,
      bodyMd: 'Deterministic agent used by the nested-frames UI spec.',
    }),
  })

  const workflow = await loadWorkflowFixture<{ id: string; version: number }>(apiFetch, FIXTURE)
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      expectedWorkflowVersion: workflow.version,
      name: 'rfc354-nested-frames-ui',
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: {},
    }),
  })
  taskId = task.id

  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
      message: '嵌套任务没有跑到终态',
    })
    .toBe('done')

  runs = (await api<{ runs: NodeRunRow[] }>(`/api/tasks/${taskId}/node-runs`)).runs
})

test.afterAll(async () => {
  for (const path of [repoDir, stateDir]) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best-effort fixture cleanup
    }
  }
  if (daemon !== undefined) await daemon.stop()
})

test('运行列表的轮次列：内层每一次运行显示自己的帧面包屑，顶层作用域仍是裸计数', async ({
  page,
}) => {
  const workers = runs.filter((run) => run.nodeId === 'loop_worker')
  expect(workers, 'fixture 没跑出外 2 × 内 2 的四次运行').toHaveLength(4)
  // 前提事实：裸计数区分不开这四行（0/0/1/1），面包屑才能。
  expect([...new Set(workers.map((run) => run.iteration))].sort()).toEqual([0, 1])
  expect(new Set(workers.map((run) => run.scopePath)).size).toBe(4)

  await primePage(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=node-runs`)

  for (const run of workers) {
    const cell = page.getByTestId(`node-run-frame-${run.id}`)
    await expect(cell, `运行 ${run.id} 的轮次列没有渲染帧面包屑`).toHaveText(
      breadcrumbOf(run.scopePath),
      { timeout: 30_000 },
    )
  }

  // 顶层作用域的行没有帧 ⇒ 不渲染面包屑（否则每个扁平工作流都会凭空多出一列噪音）。
  const topLevel = runs.filter((run) => run.scopePath === '' && run.nodeId === 'final_output')
  expect(topLevel.length).toBeGreaterThan(0)
  for (const run of topLevel) {
    await expect(page.getByTestId(`node-run-frame-${run.id}`)).toHaveCount(0)
  }
})

test('节点抽屉：Stats 显示这次运行所在的帧，运行历史按帧分组成四组', async ({ page }) => {
  const workers = runs
    .filter((run) => run.nodeId === 'loop_worker')
    .sort((a, b) => a.id.localeCompare(b.id))
  const latest = workers[workers.length - 1]!

  await primePage(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)

  // 画布点节点 ⇒ 抽屉停在最新那次运行上（普通节点的抽屉入口就是画布，
  // `node-run-detail-*` 按钮只给 call 节点）。
  await page.locator('.react-flow__node[data-id="loop_worker"] .canvas-node').click()
  const statsTab = page.getByRole('tab', { name: 'Stats' })
  await expect(statsTab, '点了画布上的嵌套节点却没有打开节点抽屉').toBeVisible({ timeout: 30_000 })
  await statsTab.click()

  await expect(page.getByTestId('stats-frame'), 'Stats 没有显示这次运行所在的帧').toHaveText(
    breadcrumbOf(latest.scopePath),
    { timeout: 30_000 },
  )

  // 运行历史按帧分组：四个标题 = 四个面包屑，按代际创建顺序（行 id 递增）。
  const frameHeaders = page.getByTestId('stats-history-frame')
  await expect(frameHeaders).toHaveCount(4, { timeout: 30_000 })
  await expect(frameHeaders).toHaveText(workers.map((run) => breadcrumbOf(run.scopePath)))
})
