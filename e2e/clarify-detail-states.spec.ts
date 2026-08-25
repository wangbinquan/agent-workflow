// RFC-319 B62 —— HUMAN-16 / HUMAN-48 / HUMAN-X5：澄清详情页上三件事，外加一条实测结论。
//
// 这一屏是「任务停在等人回答」时人真正会盯着的那一屏。三条契约此前一条 e2e 都没有：
//
//   1. **agent 超发题目 / 选项时要显式说「被截断了」**（HUMAN-16）。框架的解析是
//      permissive 的：超过上限就截断 + 记一条 warning（`shared/clarify.ts:113-145`）。
//      页面不说，人看到的就是一份「看起来完整」的问卷——他答完 5 题，agent 问的第 6、
//      第 7 题从此没有人知道存在过。
//   2. **两条查询各自的失败要各自可见、各自能重试**（HUMAN-X5）。主查询（本轮）挂了
//      要整页给出错 + 重试；同伴查询（分片邻居）挂了**不能**把整页拖垮——那只是个
//      辅助信息，为它白屏是把小故障放大成大故障。
//   3. **答完之后要写清是谁提交的**（HUMAN-48 的澄清那半）。多人协作时，「这答案谁
//      拍的板」是后面所有追问的起点。
//
// 关于分片切换器（HUMAN-15）的实测结论，写在这里免得下一个人再走一遍：
//   本条**只锁住它的负向半边**——只有一份待答时不许出现（恒显一个只有一项的切换器，
//   等于把「还有别人在等」变成噪声）。正向半边（≥2 份分片同时待答）**当前走工作流
//   fan-out 到不了**：把 clarify 节点接到 wrapper-fanout 的内层 agent 上，工作流能通过
//   校验、三个分片也都跑完，但**渲染出来的提示词里根本没有 clarify 邀请**（实测三个
//   分片的 promptText 只列了 `design` 输出端口），于是没有任何一轮被 mint 出来，
//   任务直接 done。这与 `e2e/clarify.spec.ts:442-450` 那段被 skip 的旧用例的注释一致：
//   per-shard clarify 从 RFC-060 PR-D 推迟到 PR-D2，至今未接线。
//   真正能产出「同节点多分片待答」的只剩**工作组**那条路（worker park 的
//   `askingShardKey` 是任务卡 id，`WG_CLARIFY_NODE_ID` 全组共用一个），需要一个能让
//   ≥2 个 worker 同时反问的 stub —— 现有 workgroup stub 只有 leader 会问。
//   已记进 `docs/audit-backlog.md`；HUMAN-15 因此仍留在缺口表里。
//
// 判据取自源码单一事实源：
//   routes/clarify.detail.tsx:448-458  shardPeers：同 task + 同 clarify 节点、待答 ≥2 才渲染
//   routes/clarify.detail.tsx:790-800  截断告警条（逐条 [code] detail）
//   routes/clarify.detail.tsx:641-655  主查询：加载态 / 错误态（整页）+ 重试
//   routes/clarify.detail.tsx:749-756  主查询与同伴查询各自一条可重试的错误条
//   routes/clarify.detail.tsx:1053-1060 clarify-submitter：谁提交 + 角色

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
let roundIteration: number

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
  askingShardKey: string | null
  iteration: number
  status?: string
}

async function openClarify(page: Page, nodeRunId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/clarify/${encodeURIComponent(nodeRunId)}`)
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
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b62-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 b62 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-b62-state-'))
  daemon = await startDaemon({
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: stubState },
  })

  const agentName = 'rfc319-b62-designer'
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: agentName,
      description: 'RFC-319 B62 fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b62-clarify',
      description: 'RFC-319 B62 clarify detail states',
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
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b62-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  let row: ClarifyRow | undefined
  await expect
    .poll(
      async () => {
        const rows = await api<ClarifyRow[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        row = rows[0]
        return row !== undefined
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  nodeRunId = row!.intermediaryNodeRunId
  roundIteration = row!.iteration
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// route handler 生命周期纪律（2026-08-24 macOS CI 那条红的根治点）
// ---------------------------------------------------------------------------
// CI 报的是：
//   `"route.fetch: Target page, context or browser has been closed" while running route callback`
// 根因实测（本机 chromium 探针，逐次打时间戳）：
//
//   1. 详情页一次冷加载会打**两次** `GET /api/clarify/{nodeRunId}`——第 1 次是 `session`
//      useQuery 挂载时打的（routes/clarify.detail.tsx:101-105），第 2 次是 `/ws/tasks/{taskId}`
//      握手成功后 `reconcileOnOpen` 触发的 invalidate 补打的（hooks/useClarifyWs.ts:75 →
//      hooks/useWsInvalidation.ts:117-124）。本机实测两次相隔约 60ms。
//   2. 断言只要第 1 次的响应就能满足，于是用例正文常常在第 2 次请求的 route callback 还在飞的
//      时候就跑完了——本机实测正文结束点只比第 2 次 callback 收尾晚 **29ms**。macOS runner 负载
//      更高、WS 握手落得更晚，这 29ms 余量翻成负数，那条腿就红。
//   3. 为什么偏偏炸在 `route.fetch()`：Playwright 的 Route 动词里，`fulfill` / `continue` /
//      `fallback` / `abort` 全都包在 `_raceWithTargetClose()`（= `_targetClosedScope().safeRace`）
//      里——页面关掉时它们被**静默放弃**，不抛错；只有 `route.fetch()` 走的是 `_wrapApiCall`，
//      没有这层 race，页面一关它就 reject 并被 Playwright 冒泡成上面那条测试失败。
//      （playwright-core@1.60.0 `lib/coreBundle.js` 里 Route 各动词的实现，逐个可查。）
//
// 所以本文件有两道锁，缺一不可：
//   * 锁 A（各用例内）——handler 里不许出现 `route.fetch()`。要回源的数据一律在 Node 侧预取好，
//     handler 只留 `fulfill` / `fallback`。这直接掐掉唯一会抛的那个动词。
//   * 锁 B（本 hook）——每条用例收尾时摘掉全部 handler，并**趁 page 还活着**把已经在跑的 handler
//     等完，于是拆环境时根本不存在「还在飞的 callback」。用 `'wait'` 而不是 `'ignoreErrors'`：
//     前者让 handler 正常跑完、竞态被真正消除，后者只是把错吞掉——那等于「重跑就过了」，禁止。
//
// 反向验证（都在干净 origin/main 构建上跑过）：把第 2 次 callback 人为延后 40ms，**旧写法**
// 稳定复现同一条报错、同一个行号；换成现在这两道锁后，即便把第 2 次 callback 拖慢 500ms 也全绿
// （用例 1 时长从 ~0.5s 涨到 ~1.0s，正是锁 B 在等它跑完）。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

test('agent 超发题目时，页面必须说「被截断了」——否则人以为自己看到的就是全部 @nightly', async ({
  page,
}) => {
  await seedAuth(page)
  // 截断发生在**解析**那一层（超上限即截断 + 记 warning），stub 固定只发 2 题；真造一次
  // 超发就得改 stub，而那会废掉 RFC-254 的 shell↔TS 差分基线。这里改在请求层注入
  // warning，锁的正是本条真正欠缺的那一段：**页面到底说不说**。
  //
  //
  // 锁 A（见上面 afterEach 那段的根因）：注入体在 **Node 侧一次性取好**，handler 里只剩一次
  // `route.fulfill()`，不再有 `route.fetch()`。取的是同一个 daemon、同一个 token 的同一条
  // 路径，拿到的就是页面本来会拿到的那份真响应——注入的保真度没变，变的只是「回源发生在
  // 用例正文里」而不是「发生在随时可能跨过用例边界的 route callback 里」。
  const real = await api<Record<string, unknown>>(`/api/clarify/${nodeRunId}`)
  const injectedBody = JSON.stringify({
    ...real,
    truncationWarnings: [
      { code: 'too-many-questions', detail: 'got 7 questions, truncated to 5' },
      { code: 'too-many-options', detail: 'question "q-db" had 9 options, truncated to 6' },
    ],
  })
  // 只拦「本轮详情」这一条**精确路径**：用 URL 谓词而不是 `**/api/clarify/**` 通配。同屏还在飞的
  // `/api/clarify/pending-count`、`/api/clarify?taskId=…` 因此根本不进 handler，`route.fallback()`
  // 这条分支也随之消失——少一类能活过用例边界的 callback 调用。
  await page.route(
    (url) => url.pathname === `/api/clarify/${nodeRunId}`,
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: injectedBody }),
  )
  await openClarify(page, nodeRunId)
  const warning = page.getByTestId('clarify-truncation-warning')
  // 不成立时：解析层已经悄悄砍掉了第 6、7 题，页面却一个字都不说，人答完 5 题就走人，
  // agent 真正问的后两题从此没有人知道存在过。
  await expect(warning).toBeVisible()
  // 逐条都要在场：只说「有截断」而不说截了什么，人无从判断该不该回去追 agent。
  await expect(warning).toContainText('[too-many-questions] got 7 questions, truncated to 5')
  await expect(warning).toContainText('[too-many-options]')
  await expect(warning).toContainText('had 9 options, truncated to 6')
})

test('不注入截断时不许出现告警条；只有一份待答时也不许出现分片切换器 @nightly', async ({
  page,
}) => {
  await seedAuth(page)
  await openClarify(page, nodeRunId)
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
  // 上一条的告警条若是恒显的，这一条会红。
  await expect(page.getByTestId('clarify-truncation-warning')).toHaveCount(0)
  // HUMAN-15 的负向半边：只有一份在等 ⇒ 不出切换器。恒显一个只有一项的切换器，
  // 等于把「还有别人在等」这个信号变成噪声。（正向半边的可达性结论见文件头。）
  await expect(page.getByTestId('clarify-shard-switcher')).toHaveCount(0)
})

test('两条查询各自坏掉：本轮坏了要整页报错可重试，同伴坏了不许把整页拖垮 @nightly', async ({
  page,
}) => {
  await seedAuth(page)

  // ① 本轮查询坏掉 ⇒ 整页错误 + 重试；放行后必须真的恢复（只出错不给路走等于死页）。
  let failDetail = true
  await page.route('**/api/clarify/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== `/api/clarify/${nodeRunId}` || !failDetail) {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, code: 'boom', message: 'injected failure' }),
    })
  })
  await openClarify(page, nodeRunId)
  await expect(page.getByTestId('clarify-session-error')).toBeVisible()
  await expect(page.getByTestId('clarify-question-q-db')).toHaveCount(0)
  failDetail = false
  await page.getByRole('button', { name: 'Retry' }).first().click()
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
  // 摘掉 ① 的注入。用 unrouteAll('wait') 而不是 unroute()：此刻 WS 的 reconcile 补打的那次详情
  // 请求很可能正在 handler 里飞，而 `unroute()` 不等它——被摘掉的 handler 会继续跑到 ② 的
  // `openClarify` 重新导航之后，拿着一个已经不该生效的 500 去 fulfill 新页面的请求。
  // 同上面 afterEach 的锁 B：先摘、再趁页面还活着等它跑完，两段注入才互不串味。
  await page.unrouteAll({ behavior: 'wait' })

  // ② 同伴查询（分片邻居）坏掉 ⇒ 只出一条错误条，问卷照常能答。
  // 它是辅助信息，为它白屏是把小故障放大成大故障。
  await page.route('**/api/clarify?*', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, code: 'boom', message: 'injected peers failure' }),
    })
  })
  await openClarify(page, nodeRunId)
  // 两处讲究，都是实测逼出来的：
  //   * **先**等错误落地、**再**断言问卷仍在。反过来写两头都过——问卷在错误到达之前
  //     本来就可见，断言就没有预测力（把「同伴失败也整页顶掉」注入进去，颠倒顺序的
  //     版本照样绿）。
  //   * 等的是**同伴那条自己的**错误条锚点，不是泛泛一个 `.error-box`。页面上不止一处
  //     会出错误条，用泛选择器时它会被别的东西满足，于是 query 的重试还没跑完测试就
  //     往下走了（实测只拦到 3 次重试、`peers.error` 还没最终置位就过了）。原文案也不
  //     能用来锚——错误条渲染的是解析后的文案，注入的 message 只进折叠的详情。
  //     `clarify-peers-error` / `clarify-session-error` 两个 testid 是本批顺带加的
  //     （ErrorBanner 本来就有 testid 直通，见 components/ErrorBanner.tsx:32）。
  await expect(page.getByTestId('clarify-peers-error')).toBeVisible({ timeout: 30_000 })
  // 问卷这条要**当场**判（短超时），不能给它 15 秒去等一个「好时机」：把「同伴失败也
  // 整页顶掉」注入进去时，那个页面会随 10s 轮询在错误视图与正常视图之间来回摆，
  // 长超时的断言总能逮到一帧正常的，于是照样绿。当场判才问的是「错误在场的那一刻，
  // 问卷还在不在」。
  await expect(
    page.getByTestId('clarify-question-q-db'),
    '同伴查询挂了就把整页顶掉 —— 把小故障放大成了大故障',
  ).toBeVisible({ timeout: 1_000 })
  await expect(page.getByTestId('clarify-submit-continue')).toBeEnabled()
})

test('答完之后：页面写清是谁提交的 @nightly', async ({ page }) => {
  await seedAuth(page)
  await api(`/api/clarify/${nodeRunId}/answers`, {
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
      ifMatchIteration: roundIteration,
      directive: 'stop',
    }),
  })
  // 多人协作时「这答案谁拍的板」是后面所有追问的起点；不写，就只能去翻审计日志。
  await openClarify(page, nodeRunId)
  await expect(page.getByTestId('clarify-submitter')).toContainText('E2E Administrator')
})
