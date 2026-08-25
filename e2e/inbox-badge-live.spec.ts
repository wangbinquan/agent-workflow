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
  // 点完行抽屉必须自己收起来（`InboxDrawer.tsx:96-102` 的 navigateAndClose 先 onClose
  // 再 navigate）。不收的话，人落到详情页上还盖着一层 modal：焦点被 Dialog 的 trap
  // 圈着、背景滚动被锁着，得先想明白「先按 ESC」才能开始回答——而这一屏本来就是
  // 他被角标叫过来要做的那件事。
  await expect(
    page.getByTestId('inbox-drawer'),
    '点进详情之后抽屉还盖在上面 ⇒ 落地页被 modal 罩着，人动不了',
  ).toHaveCount(0)
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

// ---------------------------------------------------------------------------
// UX-24 补漏 —— 上面两条只走了 clarify 一路，于是三件事没验到：
//   ① 角标是**三路求和**（`InboxFooterButton.tsx:52-56`）。只有一路非零时，
//      「只念了 clarify 那一路」与「三路求和」完全同形——角标照样是 1。
//   ② 抽屉里的 **review 行**（`lib/inbox-view.ts:105-115`）。它与 clarify 行的
//      rowKey / navigationId 取法不同（review 两者都是 nodeRunId，clarify 是
//      round.id 与 intermediaryNodeRunId 两个不同的值），所以 clarify 那一路绿
//      并不能说明 review 这一路也接对了。
//   ③ 点行之后抽屉要收起来（已在上面第一条用例里补了 clarify 一路，这里再验
//      review 一路——两条行的 onOpen 是**同一个** navigateAndClose，但导航目标不同，
//      而 close 与 navigate 的顺序错了只会在其中一路上暴露）。
// 所以这条用例同时造出「一条待评审 + 一条待反问」，让求和的两个非零项互相区分。
// ---------------------------------------------------------------------------

/** 造一个「先反问一轮、答完再停在评审上」的任务；返回它的评审行标识。 */
async function seedReviewGate(slug: string): Promise<{
  taskId: string
  taskName: string
  reviewNodeRunId: string
}> {
  const agentName = `rfc319-inbox-${slug}`
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: agentName,
      description: 'RFC-319 inbox review fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-inbox-${slug}-wf`,
      description: 'RFC-319 inbox review fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'Clarify design',
            position: { x: 560, y: 180 },
          },
          {
            id: 'review_1',
            kind: 'review',
            title: 'Review design',
            inputSource: { nodeId: 'designer', portName: 'design' },
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
            position: { x: 640, y: 0 },
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
          {
            id: 'e_designer_review',
            source: { nodeId: 'designer', portName: 'design' },
            target: { nodeId: 'review_1', portName: '__review_input__' },
          },
        ],
      },
    }),
  })
  const taskName = `rfc319-inbox-${slug}-task`
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: taskName,
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: `${slug} order_status enum` },
    }),
  })

  // clarify stub 的第一轮必然是反问；答掉它，designer 才会吐出 design、评审门才立得起来。
  interface Session {
    intermediaryNodeRunId: string
    iteration: number
  }
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(task.id)}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 180_000, message: `${slug}: 任务没有停在反问上` },
    )
    .toBe(true)
  await api(`/api/clarify/${session!.intermediaryNodeRunId}/answers`, {
    method: 'POST',
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
      directive: 'stop',
      ifMatchIteration: session!.iteration,
    }),
  })

  interface ReviewRow {
    taskId: string
    nodeRunId: string
    awaitingReview: boolean
  }
  let review: ReviewRow | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
        review = rows.find((row) => row.taskId === task.id && row.awaitingReview) ?? null
        return review !== null
      },
      { timeout: 180_000, message: `${slug}: 任务没有停在评审上` },
    )
    .toBe(true)
  return { taskId: task.id, taskName, reviewNodeRunId: review!.nodeRunId }
}

/** 造一个停在反问上的任务，只为让 clarify 那一路也非零。 */
async function seedClarifyGate(slug: string): Promise<{ roundId: string; taskName: string }> {
  const agentName = `rfc319-inbox-${slug}`
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: agentName,
      description: 'RFC-319 inbox clarify fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-inbox-${slug}-wf`,
      description: 'RFC-319 inbox clarify fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
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
  const taskName = `rfc319-inbox-${slug}-task`
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: taskName,
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: `${slug} order_status enum` },
    }),
  })
  interface Session {
    id: string
  }
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(task.id)}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 180_000, message: `${slug}: 任务没有停在反问上` },
    )
    .toBe(true)
  return { roundId: session!.id, taskName }
}

test('角标是三路求和，抽屉里的评审行也点得进去、点完抽屉自己收起来 @nightly', async ({ page }) => {
  const reviewGate = await seedReviewGate('reviewee')
  const clarifyGate = await seedClarifyGate('asker2')

  // 前提对账：两路各恰好一条。任何一路是 0 或 2，下面「角标=2」这条判据就退化了。
  interface Counts {
    reviews: number
    clarify: number
    workgroups: number
  }
  const readCounts = async (): Promise<Counts> => ({
    reviews: (await api<{ count: number }>('/api/reviews/pending-count')).count,
    clarify: (await api<{ count: number }>('/api/clarify/pending-count')).count,
    workgroups: (await api<{ total: number }>('/api/workgroup-tasks/pending-count')).total,
  })
  await expect
    .poll(async () => JSON.stringify(await readCounts()), {
      timeout: 60_000,
      message: '两路待办没有各自落到 1 ⇒ 求和判据退化成「念了其中一路」也成立',
    })
    .toBe(JSON.stringify({ reviews: 1, clarify: 1, workgroups: 0 }))

  // 三个计数端点都要被真的问过一遍。第三路（工作组）在本夹具里恒为 0，数字上
  // 分辨不出来，但「这一路的查询还在不在」是分辨得出来的——查询被删掉时这里当场红。
  const countHits = new Set<string>()
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.endsWith('/pending-count')) countHits.add(pathname)
  })

  await openShell(page)

  const badge = page.getByTestId('inbox-footer-badge')
  await expect(
    badge,
    '一条待评审 + 一条待反问 ⇒ 角标必须是 2。显示 1 说明它只念了其中一路，' +
      '另一路的待办在导航上完全没有痕迹',
  ).toHaveText('2', { timeout: 30_000 })

  const counts = await readCounts()
  expect(Number(await badge.innerText()), '角标与三路计数之和对不上 ⇒ 它念的不是这三路').toBe(
    counts.reviews + counts.clarify + counts.workgroups,
  )
  const BADGE_FEEDS = [
    '/api/clarify/pending-count',
    '/api/reviews/pending-count',
    '/api/workgroup-tasks/pending-count',
  ]
  await expect
    .poll(() => BADGE_FEEDS.filter((feed) => countHits.has(feed)), {
      timeout: 30_000,
      message: '三路里有一路的计数端点从未被请求 ⇒ 那一路的待办永远不进角标',
    })
    .toEqual(BADGE_FEEDS)

  await page.getByTestId('inbox-footer-button').click()
  await expect(page.getByTestId('inbox-drawer')).toBeVisible()

  // 两类行必须同时在场：只有 clarify 行时，「review 那一路的投影根本没接上」
  // 与「接上了」在单一路夹具下同形。
  const clarifyRow = page.getByTestId(`inbox-row-clarify-${clarifyGate.roundId}`)
  await expect(clarifyRow, '抽屉里没有那条待反问').toBeVisible()
  const reviewRow = page.getByTestId(`inbox-row-review-${reviewGate.reviewNodeRunId}`)
  await expect(
    reviewRow,
    '抽屉里没有那条待评审 ⇒ 评审这一路在收件箱上等于不存在，人只能自己想起来去 /reviews 翻',
  ).toBeVisible()
  await expect(reviewRow.getByTestId('inbox-row-task-name')).toHaveText(reviewGate.taskName)

  // review 行的 rowKey 与 navigationId 是同一个 nodeRunId，但导航目标是另一条路由；
  // 写混时行照样画得出来，只是点进去落在别处。
  await reviewRow.click()
  await expect(page).toHaveURL(new RegExp(`/reviews/${reviewGate.reviewNodeRunId}$`))
  await expect(
    page.getByTestId('review-detail-task-link'),
    '落地页不是这条评审 ⇒ 点进去看的是别人的文档',
  ).toHaveText(reviewGate.taskName)
  await expect(
    page.getByTestId('inbox-drawer'),
    '点评审行之后抽屉还盖在上面 ⇒ 落地页被 modal 罩着，人动不了',
  ).toHaveCount(0)
})
