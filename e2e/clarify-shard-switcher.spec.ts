// RFC-319 B66 —— HUMAN-15：同一个澄清节点上有多个分片在等人回答时，页内要能横跳。
//
// fan-out 把活切成 N 份，每一份都可能各自反问。人是从收件箱点**某一条**进来的，如果这
// 一屏不告诉他「同一个节点上还有另外几份也在等」，剩下那几份就**没有任何入口**——任务
// 一直停着，而他以为自己已经答完了。切换器还必须只在真有 ≥2 份待答时出现：恒显一个只
// 有一项的切换器，等于把「还有别人在等」这个信号变成噪声（负向那半在
// `e2e/clarify-detail-states.spec.ts` 里锁着）。
//
// 为什么 fixture 是**工作组**而不是工作流 fan-out：仓内只有工作组这一条路能真的造出
// 「同一个 clarify 节点、多个分片待答」。工作流那条路实测走不通——把 clarify 节点接到
// wrapper-fanout 的内层 agent 上，工作流能过校验、分片也都跑完，但渲染出来的提示词里
// 根本没有 clarify 邀请（per-shard clarify 自 RFC-060 PR-D 推迟至今未接线，
// `e2e/clarify.spec.ts:442-450` 那段被 skip 的旧用例注释亦然）。工作组这边：worker 的
// park 带 `askingShardKey`（任务卡 id），而 `WG_CLARIFY_NODE_ID` 是全组共用的一个节点，
// 于是两个 worker 同时反问就正好构成这个形态。
//
// 判据取自源码单一事实源：
//   services/workgroup/launch.ts:93        全组共用一个 WG_CLARIFY_NODE_ID
//   services/scheduler.ts:1389             轮次带上 node_run 的 shardKey（worker park ⇒ 任务卡 id）
//   routes/clarify.detail.tsx:448-458      同 task + 同 clarify 节点、待答 ≥2 才渲染切换器
//   routes/clarify.detail.tsx:803-828      每项 data-shard-key + aria-current，跳转到该轮自己的详情页
//   packages/system-mocks/src/runtime/mode-workgroup-matrix.ts（WG_WORKER_CLARIFY 支线，默认不生效）

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  seedShowcase,
  SHOWCASE_TASKS,
  type ShowcaseSeedResult,
} from '../examples/workgroups/showcase/seed'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
let stateDir: string
let showcase: ShowcaseSeedResult
let taskId: string
/** shardKey（任务卡 id）→ 该分片那一轮的 intermediaryNodeRunId。 */
let shardRounds: Array<{ shard: string; nodeRunId: string }> = []

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

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

interface ClarifyRow {
  intermediaryNodeRunId: string
  intermediaryNodeId: string
  askingNodeId: string
  askingShardKey: string | null
  iteration: number
}

async function awaitingRounds(): Promise<ClarifyRow[]> {
  return api<ClarifyRow[]>(
    `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
  )
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
  stateDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b66-state-'))
  daemon = await startDaemon({
    stubMode: 'workgroup-matrix',
    extraEnv: { WORKGROUP_MATRIX_STATE_DIR: stateDir, WG_WORKER_CLARIFY: '1' },
    configOverrides: {
      defaultRuntime: 'opencode',
      defaultNodeRetries: 1,
      sessionRestartBudget: 0,
      defaultPerNodeTimeoutMs: 10_000,
      maxConcurrentNodes: 6,
      multiProcessSubprocessConcurrency: 6,
    },
  })
  showcase = await seedShowcase({
    baseUrl: daemon.baseUrl,
    token: daemon.token,
    runtime: 'opencode',
  })

  const group = showcase.workgroups.leaderWorker
  const spec = SHOWCASE_TASKS.leaderWorker
  const task = await api<{ id: string }>(`/api/workgroups/${group.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      name: spec.name,
      goal: spec.goal,
      scratch: true,
      expectedWorkgroupId: group.id,
      expectedWorkgroupVersion: group.version,
    }),
  })
  taskId = task.id

  // ① 先答掉 leader 那一轮（它是分派任务卡的前提）。
  let leader: ClarifyRow | undefined
  await expect
    .poll(
      async () => {
        leader = (await awaitingRounds()).find((r) => r.askingNodeId === '__wg_leader__')
        return leader !== undefined
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  await api(`/api/clarify/${leader!.intermediaryNodeRunId}/answers`, {
    method: 'POST',
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-release-strategy',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['blue-green'],
          customText: '',
        },
      ],
      directive: 'stop',
      ifMatchIteration: leader!.iteration,
    }),
  })

  // ② 两张 v1 任务卡各自反问一次 ⇒ 同一个 clarify 节点上出现两个分片待答。
  // 轮询而不是 expect.poll：失败时要能把当时的 shardRounds 打进断言消息里。
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && shardRounds.length < 2) {
    const rows = (await awaitingRounds()).filter((r) => r.askingShardKey !== null)
    shardRounds = rows.map((r) => ({
      shard: r.askingShardKey!,
      nodeRunId: r.intermediaryNodeRunId,
    }))
    if (shardRounds.length < 2) await new Promise((r) => setTimeout(r, 500))
  }
  expect(shardRounds.length, '两张 v1 任务卡应各自反问一次').toBe(2)
  const nodes = new Set((await awaitingRounds()).map((r) => r.intermediaryNodeId))
  expect(nodes.size, '两个分片必须落在同一个 clarify 节点上，否则不构成切换器的场景').toBe(1)
  shardRounds.sort((a, b) => a.shard.localeCompare(b.shard))
})

test.afterAll(async () => {
  await daemon?.stop()
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true })
})

test('两个分片同时在等人回答：这一屏要把兄弟分片摆出来并且真的跳得过去', async ({ page }) => {
  await seedAuth(page)
  const [first, second] = shardRounds
  await page.goto(`${daemon.baseUrl}/clarify/${encodeURIComponent(first!.nodeRunId)}`)
  await expect(page.getByTestId('clarify-question-q-build-target')).toBeVisible()

  const switcher = page.getByTestId('clarify-shard-switcher')
  await expect(switcher, '同一节点上有两份待答却没有切换器 —— 另一份就没有入口了').toBeVisible()
  await expect(switcher.getByTestId(`clarify-shard-${first!.shard}`)).toHaveCount(1)
  await expect(switcher.getByTestId(`clarify-shard-${second!.shard}`)).toHaveCount(1)
  // 当前这份要标出来，否则跳来跳去分不清自己在哪一份上。
  await expect(switcher.getByTestId(`clarify-shard-${first!.shard}`)).toHaveAttribute(
    'aria-current',
    /page|true/,
  )

  // 真的跳得过去：地址换成兄弟分片那一轮自己的详情页。
  await switcher.getByTestId(`clarify-shard-${second!.shard}`).click()
  await expect(page).toHaveURL(new RegExp(`/clarify/${second!.nodeRunId}$`))
  await expect(page.getByTestId('clarify-question-q-build-target')).toBeVisible()
  await expect(
    page.getByTestId('clarify-shard-switcher').getByTestId(`clarify-shard-${second!.shard}`),
  ).toHaveAttribute('aria-current', /page|true/)
})

test('答掉其中一份之后：只剩一份在等，切换器就该收起来', async ({ page }) => {
  await seedAuth(page)
  const [first, second] = shardRounds
  const detail = await api<{ iteration: number }>(`/api/clarify/${second!.nodeRunId}`)
  await api(`/api/clarify/${second!.nodeRunId}/answers`, {
    method: 'POST',
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-build-target',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['debug'],
          customText: '',
        },
      ],
      directive: 'stop',
      ifMatchIteration: detail.iteration,
    }),
  })
  await expect
    .poll(async () => (await awaitingRounds()).filter((r) => r.askingShardKey !== null).length, {
      timeout: 60_000,
    })
    .toBe(1)

  await page.goto(`${daemon.baseUrl}/clarify/${encodeURIComponent(first!.nodeRunId)}`)
  await expect(page.getByTestId('clarify-question-q-build-target')).toBeVisible()
  await expect(
    page.getByTestId('clarify-shard-switcher'),
    '只剩一份还显示切换器 —— 那个「还有别人在等」的信号就成了噪声',
  ).toHaveCount(0)
})
