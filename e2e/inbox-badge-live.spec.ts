// RFC-319 B41 —— HUMAN-14：待办角标与 Inbox 抽屉，接的是**真的**待办。
//
// 角标是这个产品里唯一一个「不需要人主动去找」的通知面：任务停在等人回答上时，
// 全靠它把人叫回来。所以它的失效**天然是静默的**——不亮就是不亮，没有任何报错、
// 没有任何日志，任务就那么停在那儿，直到有人碰巧点开收件箱。
//
// 这一条与既有覆盖的差别正在这里：`e2e/a11y.spec.ts` / `e2e/nav-redesign.spec.ts` /
// `e2e/visual-regression.spec.ts` 都开过这个抽屉，但它们喂的是 `page.route` 造出来的
// 假数据（`routePopulatedInbox`）——那些用例证明的是「给它数据它画得出来」，
// **不是**「真有一条待办时它拿得到」。三条端点接错、权限过滤把自己的任务滤掉、
// 查询条件写反，在假数据下全都照样绿。
//
// 所以这里全程用真 daemon 跑出来的真轮次：
//
//   1. 任务停在等人回答 ⇒ 角标亮出真实计数；抽屉里列得出那一行；点进去落在那一屏；
//   2. 待办没了（任务被取消，轮次被终态清扫封存）⇒ 角标**自己**消失，不用刷新页面。
//
// 第 2 条是这条用例里唯一 e2e 才验得出的部分，也是最容易坏而没人发现的部分：轮询若
// 掉了（`refetchInterval` 没接、或查询被 staleTime 冻住），角标会一直挂着一个早就
// 不成立的数字。人点进去发现什么都没有，下次就不信它了——一个不被信任的通知面等于
// 没有通知面。它同时也是第 1 条的反向对照：证明那个「1」不是一块永远亮着的死牌子。
//
// 判据取自源码单一事实源：
//   components/shell/InboxFooterButton.tsx:39-57  三路 pending-count 求和，15s 轮询
//   components/shell/InboxDrawer.tsx:36-53        抽屉用的是列表端点，不是计数端点
//   lib/inbox-view.ts:126-141                     clarify 行的 rowKey=round.id、导航用 intermediaryNodeRunId
//   services/clarify/rounds.ts:260-277            计数排除终态任务的轮次（RFC-202 T6）
//   services/terminalSweep.ts:76-88               取消时 self 轮 awaiting_human → canceled

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
let roundId: string

const TASK_NAME = 'rfc319-inbox-badge-task'

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

async function openShell(page: Page): Promise<void> {
  // 角标挂在 AppShell 的页脚上，任何一页都有；用 /tasks 是因为它与澄清无关——
  // 角标必须在「人没有在看澄清页」的时候也把人叫回来，那才是它存在的理由。
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
  await page.goto(`${daemon.baseUrl}/tasks`)
  await expect(page.getByTestId('inbox-footer-button')).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-inbox-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 inbox badge fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-inbox-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-inbox-designer',
      description: 'RFC-319 inbox badge fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-inbox-wf',
      description: 'RFC-319 inbox badge fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-inbox-designer',
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
      name: TASK_NAME,
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  interface Session {
    id: string
    intermediaryNodeRunId: string
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
  roundId = session!.id
  // 计数端点必须先认得这条待办，否则下面断言的是界面还是后端就分不清了。
  await expect
    .poll(async () => (await api<{ count: number }>('/api/clarify/pending-count')).count, {
      timeout: 30_000,
    })
    .toBe(1)
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('真有一条待办时：角标亮出真实计数，抽屉列得出它，点进去落在那一屏 @nightly', async ({
  page,
}) => {
  await openShell(page)

  const badge = page.getByTestId('inbox-footer-badge')
  await expect(badge, '一条待回答的澄清轮 ⇒ 角标应当亮出 1').toHaveText('1', { timeout: 30_000 })

  await page.getByTestId('inbox-footer-button').click()
  await expect(page.getByTestId('inbox-drawer')).toBeVisible()

  // 行的 testid 里带的是**轮次 id**，导航用的却是 intermediary node_run id
  // （`lib/inbox-view.ts:128-130`）——两者写混时抽屉照样画得出来，只是点进去会 404。
  const row = page.getByTestId(`inbox-row-clarify-${roundId}`)
  await expect(row, '抽屉里应当有这条真实轮次').toBeVisible()
  await expect(row.getByTestId('inbox-row-task-name')).toHaveText(TASK_NAME)

  await row.click()
  await expect(page).toHaveURL(new RegExp(`/clarify/${nodeRunId}$`))
  // 落地页真的是那一轮，而不是一个空壳。
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
})

test('待办没了：角标自己消失，不用刷新页面 @nightly', async ({ page }) => {
  await openShell(page)
  await expect(page.getByTestId('inbox-footer-badge')).toHaveText('1', { timeout: 30_000 })

  // 在页面上留一个哨兵：它只要还在，就证明这一页没有被重载过——
  // 「刷新之后就对了」和「它自己会更新」是两件完全不同的事，而用户不会去刷新。
  await page.evaluate(() => {
    ;(window as unknown as { __rfc319B41?: number }).__rfc319B41 = 1
  })

  // 任务在别处走到终态：轮次被终态清扫封成 canceled，计数端点也不再算它。
  const cancelRes = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  expect(cancelRes.ok, `cancel: ${cancelRes.status} ${await cancelRes.text()}`).toBe(true)
  await expect
    .poll(async () => (await api<{ count: number }>('/api/clarify/pending-count')).count, {
      timeout: 60_000,
    })
    .toBe(0)

  // 页面没被碰过，角标必须靠自己的轮询归零（15s 一轮，给足两轮余量）。
  await expect(page.getByTestId('inbox-footer-badge'), '角标应当自己消失').toHaveCount(0, {
    timeout: 60_000,
  })
  expect(
    await page.evaluate(() => (window as unknown as { __rfc319B41?: number }).__rfc319B41 ?? null),
    '哨兵不在了 ⇒ 这一页其实被重载过，上面那条断言就不成立',
  ).toBe(1)
})
