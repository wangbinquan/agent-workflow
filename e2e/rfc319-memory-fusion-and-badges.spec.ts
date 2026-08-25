// RFC-319 —— 记忆域剩下的四块用户面：**批量融合入口**、**待办徽标**、
// **多标签页实时同步**、以及 `/ws/*` 两条通道的**服务端**过滤 / 门禁。
// 覆盖 MEM-13 / MEM-14 / MEM-22 / MEM-41 / MEM-42 / MEM-45 / MEM-46 / MEM-X5。
//
// **刻意不重复**（已被别处锁住，本文件只把它们当夹具用，不再断言）：
//   * MEM-21（融合分区列表：待审行 / 点行进详情 / 空态 / 错误态重试）与
//     MEM-X2（带反馈驳回 → iteration+1）与 MEM-X3 的二次确认取消
//     —— e2e/fusion-review-surface.spec.ts 的
//     『RFC-319 INTENT-51 / INTENT-X9: …』两条、『RFC-319 INTENT-55: …』、
//     『RFC-319 INTENT-56: …』。本文件只在 MEM-22 里**发起**一次融合，
//     发起之后的评审面一律不碰。
//   * MEM-42 的「无 memory:read 时磁贴整块不渲染」与「点磁贴落到 /memory?tab=all」
//     —— e2e/rfc319-overview-and-docs.spec.ts 的
//     『CFG-41 没有读权限的分区整块不渲染，有权限的磁贴点进去落在自己的列表页 @nightly』。
//     这里补的是那条**没人管过**的：磁贴上的数字数的是哪一档、以及它与落地页
//     行数是否对得上。
//   * 「已打开的列表被 WS 推着自更新」的单页面形态 —— e2e/live-list-updates.spec.ts。
//     MEM-45 要的是**另一个标签页里的人动手**、且**多个分区 + 导航徽标一起跟上**，
//     两者不是一回事（见该用例开头的说明）。
//   * 蒸馏任务分区的 HTTP 权限门与深链回落（MEM-24 / MEM-31）
//     —— e2e/memory-distill-gating.spec.ts；MEM-46 管的是同一道门的 **WS** 那一半。
//   * 候选行在 HTTP 列表面对非 bypass 账号不可见（MEM-34）
//     —— e2e/memory-access.spec.ts；这里断的是它在**界面上**长什么样。
//
// 这四块坏掉时都不报错，只会安静地少给或多给东西：
//
//   * 批量融合的勾选与弹窗对不上 ⇒ 用户勾了三条、融进技能的是两条（或者是他
//     上一次勾的那两条）。融合会**改写托管技能的正文并递增版本**，而技能正文是
//     此后每次任务都要读的东西；错融进去的那一条从此对所有人生效，且没有任何
//     提示说「你少给了一条」。
//   * 导航徽标算错 ⇒ 它是个数字，错了没有任何症状。少算（比如漏掉待审融合那一
//     半）时，等着人审的东西永远不会把用户叫过来；多算时用户点进去发现什么都
//     没有，几次之后这个红点就被彻底无视了——之后真有事也叫不动他。
//   * 首页磁贴的数字如果数错了档（把候选 / 已归档也算进去）⇒ 用户点进去落地页
//     的行数比磁贴少，他会以为列表页漏了东西，转头去翻回收站找。
//   * 多标签页不同步 ⇒ 两个标签页里同一条候选并存，用户在 A 里批准、在 B 里又
//     点一次「驳回」，最后一次点击赢；界面全程不报错。
//   * `/ws/memories` 的逐帧过滤失守 ⇒ 陌生人的浏览器上收得到他**看不见**的那个
//     scope 的记忆事件（含 memoryId 与状态变化）。这是一次越权读，且发生在
//     WebSocket 上，任何 HTTP 层的 ACL 测试都照不到。
//   * `/ws/memory-distill-jobs` 的升级门失守 ⇒ 未经人审的模型产出（含失败诊断里
//     的 stderr 摘录）实时推给没有 `memory-distill-jobs:manage` 的人。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链——外链会被 CI 的 markdown
// link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/components/shell/MemoryPendingBadge.tsx:26-28   只认 canManage===true
//   packages/frontend/src/components/shell/MemoryPendingBadge.tsx:30-53   candidates + fusions 两路 query
//   packages/frontend/src/components/shell/MemoryPendingBadge.tsx:61-63   total===0 不渲染；>99 显示 '99+'
//   packages/frontend/src/components/shell/AppShell.tsx:137-139           徽标只挂在 /memory 这一条 nav 上
//   packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:68-85 rows 先按 canManage 过滤，再判空态
//   packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:274-318 COLLAPSE_LINE_THRESHOLD=8 + toggle
//   packages/frontend/src/components/memory/MemoryAllList.tsx:186-197     memory-fuse-button 的文案与出现条件
//   packages/frontend/src/components/memory/MemoryAllList.tsx:363-371     勾选框只在 approved 视图 + rowManage
//   packages/frontend/src/components/memory/MemoryRow.tsx:43-54           memory-row-<id>-select
//   packages/frontend/src/components/fusion/FuseDialog.tsx:53-64          open 时按当前选择重新 seed
//   packages/frontend/src/components/fusion/FuseDialog.tsx:100-109        POST /api/fusions → 跳详情页
//   packages/frontend/src/components/home/CapabilityGrid.tsx:60-69,105-120 memory 磁贴 + 计数
//   packages/backend/src/services/overview.ts:195-198                     磁贴数字 = 可见的 **approved**
//   packages/backend/src/routes/memories.ts:120-126                       非 bypass 账号看不到 candidate
//   packages/frontend/src/hooks/useMemoryWs.ts:55-67                      七个 memory.* 变体的失效规则表
//   packages/frontend/src/lib/query-client.ts:46-48                       refetchOnWindowFocus:false（无轮询兜底）
//   packages/frontend/src/hooks/useWebSocket.ts:82-95                     auth store 一变，整个连接池强制重连
//   packages/backend/src/ws/registry.ts:818-847                           /ws/memories 逐帧 scope 过滤
//   packages/backend/src/ws/registry.ts:848-872                           /ws/memory-distill-jobs 升级门
//   packages/backend/src/ws/server.ts:199-225                             升级门失败 403 / 非握手 426
//   packages/backend/src/services/memory.ts:778-795                       canViewMemory：repo/global 全员，agent 随资源
//   packages/backend/src/services/memory.ts:621                           archive 发 memory.archived
//   packages/backend/src/routes/fusions.ts:115-131                        /api/fusions/pending-count
//   packages/shared/src/schemas/permission.ts:915-923                     guest 预设没有 memory:read
//   packages/shared/src/schemas/permission.ts:1064-1089                   manager 才有 memory-distill-jobs:manage
//
// **覆盖边界（如实记，免得后人看到「改了没红」误以为已经覆盖）**：
//   * `MemoryPendingBadge.tsx:64` 的 `nav.memoryBadge` sr-only 文案没有被断言——
//     徽标本体 `aria-hidden`，可读的那一份是同级的 `.sr-only`；本文件只断数字。
//   * `MemoryPendingBadge.tsx:33-43` 两条 query 的 `refetchInterval: 60_000`
//     没有被断言（等 60 秒不值当）；本文件所有徽标断言要么发生在导航之后，
//     要么在 20 秒内完成，因此**不可能**是那个轮询兜出来的。
//   * FuseDialog 里 `launch.error` 的服务端失败横幅、`fusion.noManagedSkills`
//     空技能列表分支、以及 `submitting` 期间的 disabled 态——未覆盖。
//   * `/ws/memories` 的 `memory.superseded` 变体（registry.ts:842-843 一律 drop）
//     未覆盖：它没有 memoryId，帧里没有可用来分辨「该不该到」的东西。
//   * MEM-X3 的另一半「applying 中不允许取消」不在此处：`applying` 只在一次
//     approve 的事务窗口内存在，e2e 无法确定性地停在那一格；服务端 CAS 由
//     packages/backend/tests/fusion-engine.test.ts:693 锁住。
//   * 需要断言「某一帧到没到」的两处（MEM-45 / MEM-X5）用的是**用例自己开的**
//     `/ws/memories`，不是应用连接池里的那条——`useWebSocket.ts:82-95` 在 auth
//     store 变动时会把整池强制重连，重连窗口里的帧对那条连接是彻底丢失的。
//     所以本文件不覆盖「应用自己那条 socket 的具体收帧」；应用侧的证据是界面在
//     20 秒内自更新（远小于 60 秒的 refetchInterval，且窗口焦点重取是关的）。

import { join } from 'node:path'

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

// serial：本文件是一条**有状态的直线**——第一条用例要的前提是「库里一条记忆都
// 没有」，最后一条会往库里灌 120 条候选。顺序是这个文件的一部分，别改成 parallel，
// 也别调换用例次序。每条用例开头都写明了它假设的库存。
test.describe.configure({ mode: 'serial' })
// 融合要真的跑一轮 agent（含一次强制反问的往返），180 秒的等待预算要放得下。
test.setTimeout(240_000)

const PASSWORD = 'Rfc319MemFusionPass!1'
const SKILL_NAME = 'rfc319-mfb-target-skill'
/** 证明「这一段中间没有发生过导航 / 刷新」——只要页面重载过，这个标记就没了。 */
const STAY_PUT_MARK = '__rfc319MemorySyncStayedPut'

let daemon: DaemonHandle
let skillId = ''
/** 只为把首页从 Onboarding 分支推到 Dashboard 分支；同时充当 MEM-X5 的私有 scope。 */
let privateAgentId = ''
let stranger: SeededUser
let manager: SeededUser

/** 库存账本，跨用例传递（见每条用例开头的「进来时的库存」注释）。 */
let longCandidateId = ''
let shortCandidateId = ''
let approvedIds: string[] = []
let archivedId = ''
let fusionId = ''

interface SeededUser {
  username: string
  userId: string
  token: string
}

interface MemoryWire {
  id: string
  title: string
  status: string
  scopeType: string
  canManage?: boolean
}

interface FusionWire {
  id: string
  status: string
  skillId: string
  memoryIds: string[]
  intent: string
  currentTaskId: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function api<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const res = await req(path, init, token)
  const body = await res.text()
  expect(res.ok, `${init?.method ?? 'GET'} ${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

/**
 * 手工建的记忆初始状态恒为 `candidate`（services/memory.ts:152-200，没有「跳过
 * 人审」的捷径）；`approve` 时再走一次 promote 把它送进 approved 面。
 */
async function seedMemory(title: string, bodyMd: string, approve: boolean): Promise<string> {
  const created = await api<{ memory: { id: string } }>('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ scopeType: 'global', scopeId: null, title, bodyMd }),
  })
  if (approve) {
    await api(`/api/memories/${created.memory.id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    })
  }
  return created.memory.id
}

async function listMemories(status: string, token?: string): Promise<MemoryWire[]> {
  const res = await api<{ items: MemoryWire[] }>(`/api/memories?status=${status}`, undefined, token)
  return res.items
}

async function fusionOf(id: string): Promise<FusionWire> {
  return api<FusionWire>(`/api/fusions/${id}`)
}

async function pendingFusionCount(): Promise<number> {
  return (await api<{ count: number }>('/api/fusions/pending-count')).count
}

/** RFC-099 的建号姿势：管理员建用户 → 用户名密码登录换会话 token。 */
async function seedUser(slug: string, role: 'user' | 'manager' | 'guest'): Promise<SeededUser> {
  const username = `rfc319-mfb-${slug}`
  const created = await api<{ id: string }>('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username, displayName: username, role, password: PASSWORD }),
  })
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  expect(login.ok, `login ${username}: ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { username, userId: created.id, token: sessionToken }
}

async function openAs(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addInitScript(
    ([baseUrl, tok]) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    [daemon.baseUrl, token] as const,
  )
  return context
}

/** 默认 `page` fixture 走管理员身份。 */
async function openApp(page: Page, path: string): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}${path}`)
}

/** 导航栏那一个待办徽标。整个视口 1280px（非 compact），全页只会有一个。 */
function navBadge(page: Page) {
  return page.getByTestId('nav-memory-badge')
}

/** 记录一个页面上**所有** WebSocket 的 URL。必须在 goto 之前挂。 */
interface SocketTap {
  urls: string[]
}

function tapSockets(page: Page): SocketTap {
  const tap: SocketTap = { urls: [] }
  page.on('websocket', (socket) => {
    tap.urls.push(socket.url())
  })
  return tap
}

/**
 * 页面里**自己**开的一条 `/ws/memories`，用来收帧。
 *
 * 为什么不直接收应用自己那条 socket 的帧（`page.on('websocket')` + framereceived）：
 * `hooks/useWebSocket.ts:82-84` 在 auth store 一变就把**整个连接池**强制重连
 * （`subscribeAuth(() => forceReconnect)`），而重连窗口里发出的帧对这条连接是
 * 彻底丢失的——界面靠 `useWsInvalidation` 的 `reconcileOnOpen` 兜回来，所以用户
 * 看不出异常，但「这一帧到没到」的断言会**间歇性**变红。那种红不是产品 bug，
 * 却又只能靠重跑变绿——本仓明令不接受这种通过依据（CLAUDE.md §Test-with-every-change）。
 *
 * 这条 socket 由用例自己建、自己持有：前端框架的重连 / 凭据轮换碰不到它，它从建立
 * 到用例结束一直开着，因此「收到了 / 没收到」是确定的。姿势照抄
 * e2e/rfc319-users-and-account.spec.ts:960-1000（那条用同样的手法把「服务端主动关」
 * 与「前端自己断开」分开）。
 */
const RAW_FEED_KEY = '__rfc319RawMemoryFeed'

interface RawFeed {
  hello: boolean
  frames: string[]
  closed: { code: number; wasClean: boolean } | null
}

async function openRawMemoryFeed(page: Page, token: string): Promise<void> {
  await page.evaluate(
    ({ base, tok, key }) => {
      const state: RawFeed = { hello: false, frames: [], closed: null }
      ;(window as unknown as Record<string, RawFeed>)[key] = state
      const url = new URL('/ws/memories', base)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('token', tok)
      const socket = new WebSocket(url.toString())
      socket.addEventListener('message', (event: MessageEvent) => {
        const text = String(event.data)
        state.frames.push(text)
        if (text.includes('"type":"hello"')) state.hello = true
      })
      socket.addEventListener('close', (event: CloseEvent) => {
        state.closed = { code: event.code, wasClean: event.wasClean }
      })
    },
    { base: daemon.baseUrl, tok: token, key: RAW_FEED_KEY },
  )
}

async function rawFeed(page: Page): Promise<RawFeed> {
  return page.evaluate((key) => (window as unknown as Record<string, RawFeed>)[key], RAW_FEED_KEY)
}

async function rawFramesMatching(page: Page, needle: string): Promise<string[]> {
  return (await rawFeed(page)).frames.filter((payload) => payload.includes(needle))
}

/**
 * 回答融合那一轮**强制**反问。
 *
 * 反问本身不是这条 spec 要覆盖的能力（e2e/clarify.spec.ts 已经锁住它），但它是
 * 产品的硬契约：merger 节点跑在强制 ask-back 模式下，第一轮直接出
 * `<workflow-output>` 会被以 `clarify-required-output-emitted` 当场判失败
 * （packages/system-mocks/src/runtime/mode-fusion.ts:43-52）。所以必须真答一次，
 * 融合才走得到待审批——`directive: 'stop'` 是把节点从强制反问里放出来的开关。
 */
async function answerFusionClarify(id: string): Promise<void> {
  let taskId: string | null = null
  await expect
    .poll(
      async () => {
        taskId = (await fusionOf(id)).currentTaskId
        return taskId !== null
      },
      { timeout: 120_000, message: `融合 ${id} 一直没有关联的引擎任务` },
    )
    .toBe(true)

  let session: { intermediaryNodeRunId: string; iteration: number } | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Array<{ intermediaryNodeRunId: string; iteration: number }>>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(String(taskId))}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 120_000, message: `融合 ${id} 的任务没有停在反问上` },
    )
    .toBe(true)

  const round = session as unknown as { intermediaryNodeRunId: string; iteration: number }
  await api(`/api/clarify/${round.intermediaryNodeRunId}/answers`, {
    method: 'POST',
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-merge',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      directive: 'stop',
      ifMatchIteration: round.iteration,
    }),
  })
}

/**
 * 等融合到某个状态。**连 error 一起报**：只说「期望 X、实得 Y」等于把真正的原因
 * 留在服务端，接手的人要从头复现一遍才能看到它。
 */
async function waitForFusionStatus(id: string, expected: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await fusionOf(id)
        return row.status === expected
          ? expected
          : `${row.status}: ${row.error ?? '(no error recorded)'}`
      },
      { timeout: 180_000 },
    )
    .toBe(expected)
}

test.beforeAll(async () => {
  // `fusion` 是唯一能把一次融合推过 `running` 的 stub 模式：只有它会留下改过的
  // 技能文件 + `.agent-workflow/fusion/result.json` 清单。
  daemon = await startDaemon({ stubMode: 'fusion' })

  skillId = (
    await api<{ id: string }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: SKILL_NAME,
        description: 'RFC-319 memory-fusion-and-badges fixture',
        bodyMd: '# fixture\n\nOriginal skill body.\n',
      }),
    })
  ).id

  // 首页在「一个 agent 和一个 workflow 都没有」时渲染的是 Onboarding 而不是
  // Dashboard（routes/index.tsx:56-63），MEM-42 要的能力网格就不在场。建一个
  // 私有代理同时解决两件事：把首页推到 Dashboard 分支，并给 MEM-X5 一个
  // 「陌生人看不见」的 scope（RFC-231：创建路径恒为 creator-owner + private）。
  privateAgentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-mfb-private-agent',
        description: 'RFC-319 private scope fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'fixture body',
      }),
    })
  ).id

  stranger = await seedUser('stranger', 'user')
  manager = await seedUser('manager', 'manager')
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// MEM-14 / MEM-41 —— 空库这一档
// 进来时的库存：一条记忆都没有。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-14 / MEM-41: 空库时审批队列说的是「没有待审记忆」，导航徽标整块不出现 @nightly', async ({
  page,
}) => {
  expect(
    (await listMemories('candidate')).length,
    '前提：这条用例要的是空库。库里已经有候选 ⇒ 下面所有「没有」的断言都不成立',
  ).toBe(0)

  await openApp(page, '/memory?tab=approval-queue')
  await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })

  await expect(
    page.getByTestId('memory-approval-queue-empty'),
    '没有待审记忆时给的是一片空白（或者一直转圈）⇒ 用户分不清「都处理完了」和' +
      '「这个面板坏了」，于是每次进来都要刷新几次确认',
  ).toBeVisible()
  await expect(
    page.getByText('No candidate memories need your review', { exact: true }),
    '空态没有把话说出来 ⇒ 空态框只是个占位符，等于什么都没说',
  ).toBeVisible()
  await expect(
    page.getByTestId('memory-approval-queue'),
    '空态与列表容器同时在场 ⇒ 页面自相矛盾，用户不知道到底有没有东西等他审',
  ).toHaveCount(0)

  // 徽标的零分支（MemoryPendingBadge.tsx:61-63）。这一条是所有徽标断言的基线：
  // 一个恒亮的徽标在「有待办」时也是绿的，只有先证明它会灭，后面的数字才有意义。
  await expect(
    navBadge(page),
    '零待办也挂徽标 ⇒ 导航上永远有个红点，用户点进来什么都没有；几次之后这个' +
      '红点就被彻底无视了，之后真有事也叫不动他',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('memory-section-approval-queue').locator('.page-section-nav__badge'),
    '分区徽章同上：零待审不该挂数字',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// MEM-13 —— 长正文候选的展开 / 收起
// 进来时的库存：0 条。出去时：2 条候选（长 + 短）。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-13: 长正文候选默认收起、点一次展开再点一次收回；短正文根本不给这个按钮 @nightly', async ({
  page,
}) => {
  // 12 行 > COLLAPSE_LINE_THRESHOLD(8)：出 toggle。3 行：不出。
  // 阈值是按**换行数**算的（MemoryApprovalQueue.tsx:264-277），不是按字符数，
  // 所以两条夹具都用真实的换行而不是长段落。
  const longBody = Array.from({ length: 12 }, (_, i) => `RFC-319 long body line ${i + 1}`).join(
    '\n',
  )
  longCandidateId = await seedMemory('rfc319-mfb-long-candidate', longBody, false)
  shortCandidateId = await seedMemory(
    'rfc319-mfb-short-candidate',
    'RFC-319 short body line 1\nline 2\nline 3',
    false,
  )

  await openApp(page, '/memory?tab=approval-queue')
  const longBodyEl = page.getByTestId(`memory-candidate-${longCandidateId}-body`)
  await expect(longBodyEl).toBeVisible({ timeout: 30_000 })

  // 负向对照，同时也是 MEM-14 的反面：队列里有东西了，空态必须让位。
  // 少了这一条，上一条用例的「空态可见」也可能只是「空态永远可见」。
  await expect(
    page.getByTestId('memory-approval-queue-empty'),
    '队列里明明有候选却仍显示空态 ⇒ 等着人审的候选彻底从视野里消失，没人会再去找它',
  ).toHaveCount(0)

  const toggle = page.getByTestId(`memory-candidate-${longCandidateId}-body-toggle`)
  await expect(
    toggle,
    '长正文没有展开入口 ⇒ 用户只能看到前 8 行就去做批准 / 驳回的决定，' +
      '而记忆正文是会被原样注入下一次任务 prompt 的东西',
  ).toBeVisible()
  await expect(toggle).toHaveText('Show full body')
  await expect(
    longBodyEl,
    '默认就是展开的 ⇒ 队列里排几条长记忆就没法扫了，收起的意义正在于此',
  ).toHaveAttribute('data-expanded', 'false')
  await expect(longBodyEl).toHaveClass(/memory-candidate-card__body--clamped/)

  await toggle.click()
  await expect(
    longBodyEl,
    '点了展开正文没有真的展开 ⇒ 按钮只是换了个字，用户看不到被折起来的那部分',
  ).toHaveAttribute('data-expanded', 'true')
  await expect(
    longBodyEl,
    '展开了却还挂着夹紧的样式 ⇒ CSS 仍然把内容截在 8 行，展开等于没展开',
  ).not.toHaveClass(/memory-candidate-card__body--clamped/)
  await expect(toggle).toHaveText('Collapse body')

  await toggle.click()
  await expect(
    longBodyEl,
    '收不回去 ⇒ 这是个单向开关，队列一旦被展开就再也扫不动了',
  ).toHaveAttribute('data-expanded', 'false')
  await expect(toggle).toHaveText('Show full body')

  // 短正文：不给按钮，也不该带展开状态——否则一屏候选里一半的卡片挂着一个
  // 点了什么都不会发生的按钮。
  const shortBodyEl = page.getByTestId(`memory-candidate-${shortCandidateId}-body`)
  await expect(shortBodyEl).toBeVisible()
  await expect(
    page.getByTestId(`memory-candidate-${shortCandidateId}-body-toggle`),
    '三行的正文也给展开按钮 ⇒ 点了什么都不会发生，用户会以为这条记忆的内容没加载出来',
  ).toHaveCount(0)
  expect(
    await shortBodyEl.getAttribute('data-expanded'),
    '短正文也带 data-expanded ⇒ 说明它走的是折叠分支，只是恰好按钮没渲染出来',
  ).toBeNull()
})

// ---------------------------------------------------------------------------
// MEM-14 —— 普通用户那一档
// 进来时的库存：2 条候选（管理员可管）。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-14: 未经人审的候选不进普通用户的读面——他的审批队列给的是空态说明，不是空白也不是一直转圈 @nightly', async ({
  browser,
}) => {
  // 服务端事实先立起来：同一时刻，管理员数得到 2 条，普通用户一条都读不到
  // （routes/memories.ts:120-126 的 dropCandidates）。
  expect(
    (await listMemories('candidate')).length,
    '前提：库里应当正好有 2 条候选，否则下面的对照没有基线',
  ).toBe(2)
  expect(
    (await listMemories('candidate', stranger.token)).length,
    '普通用户读得到未经人审的候选 ⇒ 未经审核的模型产出（含正文）直接进了他的读面',
  ).toBe(0)

  const context = await openAs(browser, stranger.token)
  try {
    const page = await context.newPage()
    await page.goto(`${daemon.baseUrl}/memory?tab=approval-queue`)
    await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })

    await expect(
      page.getByTestId('memory-approval-queue-empty'),
      '普通用户的审批队列不给空态说明 ⇒ 他看到的是一片空白 / 一直转圈，' +
        '会以为页面坏了并反复刷新，而这一屏本来就没有他的活',
    ).toBeVisible()
    await expect(
      page.getByTestId('memory-approval-queue'),
      '普通用户看到了候选列表容器 ⇒ 未经人审的候选被渲染给了不该看到它的人',
    ).toHaveCount(0)
    await expect(
      page.getByText('rfc319-mfb-long-candidate', { exact: false }),
      '候选标题出现在普通用户的页面上 ⇒ 这就是越权读本身，空态只是它的第一个症状',
    ).toHaveCount(0)
    await expect(
      navBadge(page),
      '普通用户挂着待办徽标 ⇒ 徽标数的不是「他能管的」，他点进去只会看到一屏空的',
    ).toHaveCount(0)
  } finally {
    await context.close()
  }
})

// ---------------------------------------------------------------------------
// MEM-42 —— 首页记忆磁贴的数字数的是哪一档
// 进来时的库存：2 条候选。出去时：+3 已批准、+1 已归档。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-42: 首页记忆磁贴数的是「已批准」那一档，候选与已归档都不算，落地页行数与它一致 @nightly', async ({
  page,
}) => {
  approvedIds = []
  for (let i = 1; i <= 3; i += 1) {
    approvedIds.push(
      await seedMemory(`rfc319-mfb-approved-${i}`, `RFC-319 approved fixture body ${i}.`, true),
    )
  }
  archivedId = await seedMemory('rfc319-mfb-archived-1', 'RFC-319 archived fixture body.', true)
  await api(`/api/memories/${archivedId}/archive`, { method: 'POST' })

  // 服务端口径（overview.ts:195-198）：只数当前账号看得见的 **approved**。
  // 库里此刻是 3 approved + 1 archived + 2 candidate，所以答案必须是 3——
  // 任何把另外两档算进去的实现都会得到 4 / 5 / 6。
  const overview = await api<{ resources: { memories: number | null } }>('/api/overview')
  expect(
    overview.resources.memories,
    '磁贴的数据源把候选 / 已归档也算了进去 ⇒ 用户点进去落地页的行数比磁贴少，' +
      '他会以为列表页漏了东西，转头去翻已归档里找',
  ).toBe(3)

  await openApp(page, '/')
  await expect(page.getByTestId('home-cap-grid')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByTestId('home-cap-memory-count'),
    '磁贴上的数字与后端给这个账号算出来的对不上 ⇒ 首页在替用户编数字',
  ).toHaveText(String(overview.resources.memories))

  // 口径一致性：点进去那一页里能数出来的行数，必须**就是**磁贴上的那个数。
  // 这是这条用例真正的价值——磁贴与落地页各自算各自的，两边都「有个数字」，
  // 但对不上时用户只能自己在两屏之间来回数。
  await page.getByTestId('home-cap-memory').click()
  await page.waitForURL(/\/memory\?tab=all$/)
  await expect(page.getByTestId('memory-all-list')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByTestId('memory-all-list').locator('li.memory-row'),
    '落地页的行数与磁贴上的数字对不上 ⇒ 用户会以为其中一边漏了东西',
  ).toHaveCount(3)

  // 反面：已归档的那一条确实存在，只是不该被磁贴算进去。少了这一条，
  // 「磁贴 = 3」也可能只是因为归档那条根本没建成功。
  await page.getByTestId('memory-all-filter-archived').click()
  await expect(
    page.getByTestId(`memory-row-${archivedId}`),
    '已归档的记忆连已归档视图里也找不到 ⇒ 上面「磁贴不算它」的结论没有对照，' + '它可能压根不存在',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// MEM-22 —— 已批准库里多选 → 融合成技能
// 进来时的库存：3 已批准、1 已归档、2 候选。出去时：多一条 running 的融合。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-22: 已批准库里勾几条就融合几条——按钮带着条数，重开弹窗跟得上改过的选择，提交后落在这次融合自己的详情页 @nightly', async ({
  page,
}) => {
  const launches: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/fusions') {
      launches.push(request.url())
    }
  })

  await openApp(page, '/memory?tab=all')
  await expect(page.getByTestId('memory-all-list')).toBeVisible({ timeout: 30_000 })

  await expect(
    page.getByTestId('memory-fuse-button'),
    '一条都没勾就摆出批量按钮 ⇒ 点下去要么是空提交、要么融的是上一次的选择，' +
      '而融合会改写技能正文，谁都说不清融进去的是什么',
  ).toHaveCount(0)

  // 勾选只在「已批准」视图给（MemoryAllList.tsx:363-371）。已归档的记忆不是
  // 可融合的素材——真给了勾选框，用户会把一条自己刚归档的规矩融回技能里。
  await page.getByTestId('memory-all-filter-archived').click()
  await expect(page.getByTestId(`memory-row-${archivedId}`)).toBeVisible()
  await expect(
    page.getByTestId(`memory-row-${archivedId}-select`),
    '已归档的行也能被勾进融合 ⇒ 用户会把一条已经作废的规矩融回技能正文里，' +
      '而技能正文是往后每次任务都要读的东西',
  ).toHaveCount(0)
  await page.getByTestId('memory-all-filter-approved').click()
  await expect(page.getByTestId('memory-all-list')).toBeVisible()

  const [first, second, third] = approvedIds
  await page.getByTestId(`memory-row-${first}-select`).check()
  await page.getByTestId(`memory-row-${second}-select`).check()
  await expect(
    page.getByTestId('memory-fuse-button'),
    '批量按钮不写清「这次要融几条」 ⇒ 用户在滚了半屏的列表里根本不知道自己勾中了几条，' +
      '而少勾 / 多勾一条的后果只有融完之后才看得见',
  ).toHaveText('Fuse into skill · 2 selected')

  await page.getByTestId('memory-fuse-button').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByText('2 selected', { exact: true }),
    '弹窗里的条数与按钮上的对不上 ⇒ 两个数字打架，用户不知道该信哪一个',
  ).toBeVisible()

  // 重开分支（FuseDialog.tsx:53-64）：弹窗关掉时**仍然挂载着**，只是 `open`
  // 翻成 false。不在每次打开时按当前选择重新 seed，第二次打开拿到的就是第一次
  // 的选择——用户以为自己加了一条，实际融进去的还是旧的两条。
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByTestId(`memory-row-${third}-select`).check()
  await expect(page.getByTestId('memory-fuse-button')).toHaveText('Fuse into skill · 3 selected')
  await page.getByTestId('memory-fuse-button').click()
  const reopened = page.getByRole('dialog')
  await expect(reopened).toBeVisible()
  await expect(
    reopened.getByText('3 selected', { exact: true }),
    '第二次打开弹窗还带着上一次的选择 ⇒ 用户明明又勾了一条，融进技能的却还是旧的两条，' +
      '而且界面全程不会说任何话',
  ).toBeVisible()

  // 选目标技能 + 写意图，然后真的发起。
  await reopened.getByRole('combobox').first().click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: new RegExp(SKILL_NAME) }).click()
  await expect(listbox).toHaveCount(0)
  await reopened.getByTestId('fusion-intent').fill('RFC-319 MEM-22: consolidate the three rules')
  await reopened.getByRole('button', { name: 'Start fusion', exact: true }).click()

  await page.waitForURL(/\/fusions\/[^/]+$/, { timeout: 60_000 })
  fusionId = new URL(page.url()).pathname.split('/').pop() ?? ''
  expect(fusionId, '发起之后没有落到这次融合自己的详情页 ⇒ 用户丢失了刚发起的那次融合').not.toBe('')
  expect(
    launches.length,
    '一次提交发了不止一个 /api/fusions ⇒ 同一批记忆被融了两遍，技能版本平白多跳一格',
  ).toBe(1)

  // 服务端可核对的事实：融进去的**正是**勾中的那三条，一条不多一条不少。
  // 这是整条用例的核心——界面上的数字对了、发出去的清单错了，是最难被发现的一种。
  const launched = await fusionOf(fusionId)
  expect(
    [...launched.memoryIds].sort(),
    '发起的融合带的记忆清单与勾选不符 ⇒ 技能正文会被一份用户没有选过的内容改写',
  ).toEqual([...approvedIds].sort())
  expect(launched.skillId, '融进了别的技能 ⇒ 改错了对象，而且是不可见地改错').toBe(skillId)
  expect(
    launched.intent,
    '融合意图没传上去 ⇒ agent 拿不到「要按什么口径合」，结果只能靠它自己猜',
  ).toBe('RFC-319 MEM-22: consolidate the three rules')
})

// ---------------------------------------------------------------------------
// MEM-41 —— 徽标是「可管候选 + 待审融合」两项之和
// 进来时的库存：2 候选 + 1 条 running 的融合。出去时：1 候选 + 1 条待审融合。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-41: 导航徽标是「可管候选 + 待审融合」之和，批准一条候选当场少一个 @nightly', async ({
  page,
}) => {
  await answerFusionClarify(fusionId)
  await waitForFusionStatus(fusionId, 'awaiting_approval')

  const candidatesBefore = (await listMemories('candidate')).filter((m) => m.canManage === true)
  const fusionsBefore = await pendingFusionCount()
  expect(candidatesBefore.length, '前提：应当正好剩 2 条待审候选').toBe(2)
  expect(fusionsBefore, '前提：应当正好有 1 条待审融合').toBe(1)

  await openApp(page, '/memory?tab=all')
  await expect(page.getByTestId('memory-all-list')).toBeVisible({ timeout: 30_000 })

  // 合成规则本身。两个分量都非零、且互不相等的取值（2 与 1）才能把三种错误
  // 实现分开：只数候选 → '2'，只数融合 → '1'，两者都数 → '3'。
  await expect(
    navBadge(page),
    '徽标不是两项之和 ⇒ 少算的那一半永远不会把用户叫过来：待审的融合（它会改写' +
      '技能正文）就那么一直等着，导航上什么都不显示',
  ).toHaveText(String(candidatesBefore.length + fusionsBefore))

  // 批准掉一条候选：候选那一半减 1，融合那一半不动 ⇒ 徽标必须落到 2。
  // 这一步刻意走 HTTP + 重新导航，而不是等 WS 推——「不刷新也跟上」是 MEM-45
  // 的活，混在这里会让两条用例互相掩护。
  await api(`/api/memories/${shortCandidateId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  await page.reload()
  await expect(page.getByTestId('memory-all-list')).toBeVisible({ timeout: 30_000 })
  await expect(
    navBadge(page),
    '处理掉一条待办，徽标却纹丝不动 ⇒ 这个数字是死的；用户处理完所有事项后' +
      '红点还在，从此不再相信它',
  ).toHaveText(String(candidatesBefore.length - 1 + fusionsBefore))
  expect(
    await pendingFusionCount(),
    '批准一条记忆把待审融合数也改了 ⇒ 两个分量串了线，下一条断言的基线不成立',
  ).toBe(fusionsBefore)
})

// ---------------------------------------------------------------------------
// MEM-45 —— 多标签页实时同步
// 进来时的库存：1 候选（长的那条）+ 1 条待审融合。出去时：0 候选。
//
// 与 e2e/live-list-updates.spec.ts 的分工：那条锁的是「一个页面 + 一次页面外的
// HTTP 写」；这条锁的是**另一个标签页里的人动手**，而且要求**多个分区 + 导航
// 徽标一起**跟上——审批队列少一张卡、已批准库多一行、徽标减一，三处同源。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-45: 一个标签页里批准，另一个标签页不刷新就跟上——已批准库、审批队列与徽标一起变 @nightly', async ({
  browser,
}) => {
  const context = await openAs(browser, daemon.token)
  try {
    // A：停在「已批准」库。它全程不再被碰一下——不刷新、不导航、不点任何东西。
    const pageA = await context.newPage()
    await pageA.goto(`${daemon.baseUrl}/memory?tab=all`)
    await expect(pageA.getByTestId('memory-all-list')).toBeVisible({ timeout: 30_000 })
    // 第二台仪器：A 自己开的一条 /ws/memories（见 openRawMemoryFeed 的说明）。
    await openRawMemoryFeed(pageA, daemon.token)
    await expect.poll(async () => (await rawFeed(pageA)).hello, { timeout: 30_000 }).toBe(true)
    await expect(
      pageA.getByTestId(`memory-row-${longCandidateId}`),
      '前提：这条还没被批准，已批准库里当然不该有它',
    ).toHaveCount(0)
    await expect(navBadge(pageA), '前提：A 上的徽标应当是 1 候选 + 1 融合').toHaveText('2')

    // B：另一个标签页，停在审批队列。动手的是它。
    const pageB = await context.newPage()
    await pageB.goto(`${daemon.baseUrl}/memory?tab=approval-queue`)
    const card = pageB.getByTestId(`memory-candidate-${longCandidateId}`)
    await expect(card).toBeVisible({ timeout: 30_000 })

    // 从这里开始 A 不允许发生任何导航 / 刷新，否则下面的断言证明的是
    // 「刷新之后能看到」，而不是 MEM-45 要的「自己被推着更新」。
    await pageA.evaluate((key) => {
      const w = window as unknown as Record<string, number>
      w[key] = 1
    }, STAY_PUT_MARK)

    await pageB.getByTestId(`memory-candidate-${longCandidateId}-approve`).click()

    // ① 另一个分区（已批准库）跟上。20 秒的预算刻意远小于两条 query 的
    // `refetchInterval: 60_000`，而 `refetchOnWindowFocus` 在本仓是关的
    // （lib/query-client.ts:46）——所以这条只可能是 WS 推出来的。
    await expect(
      pageA.getByTestId(`memory-row-${longCandidateId}`),
      '另一个标签页里已经批准了，这一页却还停在旧数据上 ⇒ 界面不报错、不空白、' +
        '不转圈，只是永远显示着过时的库存，用户会以为事情还没发生',
    ).toBeVisible({ timeout: 20_000 })

    // ② 导航徽标（另一个数据源、另一条 query）也跟上。
    await expect(
      navBadge(pageA),
      '列表更新了徽标没更新 ⇒ 用户看着一个「还有 2 件待办」的红点，点进去只剩 1 件，' +
        '几次之后这个红点就被无视了',
    ).toHaveText('1', { timeout: 20_000 })

    const survived = await pageA.evaluate(
      (key) => (window as unknown as Record<string, number | undefined>)[key],
      STAY_PUT_MARK,
    )
    expect(
      survived,
      '这段中间 A 发生过导航 / 刷新 ⇒ 上面两条断言证明的是「刷新之后能看到」，' +
        '而不是 MEM-45 要的「不刷新就跟上」',
    ).toBe(1)

    // ③ 机制证据：服务端确实把这条记忆的 promoted 事件推到了 A 这个浏览器会话上。
    // 上面两条断言已经排除了轮询（20s ≪ 60s 的 refetchInterval，且窗口焦点重取是
    // 关的），这一条再从传输层确认「推送本身发生过」——两者一起，才排得掉
    // 「界面是靠某个我们没注意到的重取兜上的、真正的实时链路早就断了」。
    await expect
      .poll(
        async () =>
          (await rawFramesMatching(pageA, longCandidateId)).some((payload) =>
            payload.includes('memory.candidate.promoted'),
          ),
        {
          timeout: 20_000,
          message:
            'A 这个会话的 /ws/memories 上没有这条记忆的 promoted 帧 ⇒ 实时链路没有把' +
            '这次批准推出去，界面上的变化是别的东西兜上的',
        },
      )
      .toBe(true)
    expect(
      (await rawFeed(pageA)).closed,
      'A 的 /ws/memories 中途被关掉了 ⇒ 上面这条「收到了」不能代表稳态行为',
    ).toBeNull()

    // ④ 动手的那一页自己也要收敛到正确的终态。
    await expect(card, '批准完了卡片还留在队列里 ⇒ 人审会对着同一条反复处理').toHaveCount(0, {
      timeout: 20_000,
    })
    await expect(
      pageB.getByTestId('memory-approval-queue-empty'),
      '最后一条候选处理完了却不给空态 ⇒ 用户不知道自己是不是已经清空了队列',
    ).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }
})

// ---------------------------------------------------------------------------
// MEM-46 —— /ws/memory-distill-jobs 的升级门
// 进来时的库存：0 候选 + 1 条待审融合（本条不依赖库存）。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-46: 没有 memory-distill-jobs:manage 的人连不上蒸馏任务通道——服务端在升级门就拒，浏览器侧压根不建这条连接 @nightly', async ({
  browser,
}) => {
  // ── ① 服务端那一半 ────────────────────────────────────────────────────
  // `/ws/*` 的升级在 Bun.serve 的 fetch 里完成（ws/server.ts:104-226），升级门
  // 不过就直接回 403 + `permission-required`，**根本不会走到** server.upgrade()。
  // 所以一个普通 GET 就能把这道门单独打出来：门不过 = 403，门过了但不是握手 = 426。
  // 这一对取值把「被权限拒了」和「压根没这条通道 / 请求形状不对」分得干干净净。
  const asPlain = await fetch(
    `${daemon.baseUrl}/ws/memory-distill-jobs?token=${encodeURIComponent(stranger.token)}`,
  )
  expect(
    asPlain.status,
    '普通用户能升级蒸馏任务通道 ⇒ 未经人审的模型产出（含失败诊断里的 stderr 摘录）' +
      '会实时推给不该看到它的人，而且是在 WebSocket 上，HTTP 的 ACL 测试一条都照不到',
  ).toBe(403)
  expect(
    ((await asPlain.json()) as { code?: string }).code,
    '拒是拒了，却没说是因为权限 ⇒ 排查的人会先去怀疑通道名 / token 解析',
  ).toBe('permission-required')

  // 正向对照 A：同一个账号连 /ws/memories（无升级门）拿到的是 426，不是 403。
  // 少了它，上面的 403 也可能只是「这个 token 连不上任何 WS」。
  const plainOnMemories = await fetch(
    `${daemon.baseUrl}/ws/memories?token=${encodeURIComponent(stranger.token)}`,
  )
  expect(
    plainOnMemories.status,
    '普通用户连 /ws/memories 都被 403 ⇒ 上面那条 403 证明不了「是蒸馏通道的门」，' +
      '而且他的记忆页会整个失去实时更新',
  ).toBe(426)

  // 正向对照 B：manager 预设带 memory-distill-jobs:manage + memory:update，
  // 同一条通道上必须过门（过门之后因为不是真握手，落在 426）。
  const asManager = await fetch(
    `${daemon.baseUrl}/ws/memory-distill-jobs?token=${encodeURIComponent(manager.token)}`,
  )
  expect(
    asManager.status,
    '有权限的账号也被升级门拒了 ⇒ 蒸馏任务面对谁都不会实时更新，' +
      '上面那条 403 也就不能算是「按权限拒」',
  ).toBe(426)
  expect(((await asManager.json()) as { code?: string }).code).toBe('upgrade-failed')

  // ── ② 浏览器那一半 ────────────────────────────────────────────────────
  // routes/memory.tsx:128 的 `useMemoryDistillJobWs({ enabled: canManageDistillJobs })`：
  // 没权限就**不建**这条连接。服务端拒了固然安全，但每次开记忆页都撞一次 403
  // 会把日志淹掉，真正的问题反而找不到。
  const plainCtx = await openAs(browser, stranger.token)
  const managerCtx = await openAs(browser, manager.token)
  try {
    const plainPage = await plainCtx.newPage()
    const plainTap = tapSockets(plainPage)
    await plainPage.goto(`${daemon.baseUrl}/memory`)
    await expect(plainPage.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => plainTap.urls.some((u) => u.includes('/ws/memories')), { timeout: 30_000 })
      .toBe(true)

    // 时间对照：manager 的页面上**两条**都建起来了，说明「建蒸馏连接」这件事在
    // 这段窗口里本来是来得及发生的。少了这一步，普通用户那边的「没有」可能只是
    // 观察窗口太短。
    const managerPage = await managerCtx.newPage()
    const managerTap = tapSockets(managerPage)
    await managerPage.goto(`${daemon.baseUrl}/memory`)
    await expect(managerPage.getByTestId('memory-section-distill-jobs')).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(() => managerTap.urls.some((u) => u.includes('/ws/memory-distill-jobs')), {
        timeout: 30_000,
      })
      .toBe(true)

    expect(
      plainTap.urls.filter((u) => u.includes('/ws/memory-distill-jobs')),
      '普通用户的记忆页仍然去连蒸馏任务通道 ⇒ 每开一次页面就在服务端留一条 403，' +
        '真正的权限问题被这些噪音淹掉',
    ).toEqual([])
    expect(
      plainTap.urls.some((u) => u.includes('/ws/memories')),
      '普通用户连记忆通道也没建 ⇒ 上面那条「没连蒸馏通道」可能只是整页的 WS 都没起来',
    ).toBe(true)
  } finally {
    await plainCtx.close()
    await managerCtx.close()
  }
})

// ---------------------------------------------------------------------------
// MEM-X5 —— /ws/memories 的逐帧 scope 过滤
// 进来时的库存：不依赖。本条自带夹具。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-X5: /ws/memories 逐帧过滤——看不见那个 scope 的人收不到它的记忆事件，全局记忆的事件照常送到 @nightly', async ({
  browser,
}) => {
  // 私有 agent scope 的记忆：陌生人看不见那个 agent，于是也看不见它名下的记忆
  // （services/memory.ts:778-795）。global 那条则是全员可读——两条同走一个通道，
  // 差别只在 frameGate。
  const secretId = await api<{ memory: { id: string } }>('/api/memories', {
    method: 'POST',
    body: JSON.stringify({
      scopeType: 'agent',
      scopeId: privateAgentId,
      title: 'rfc319-mfb-secret-scope',
      bodyMd: 'RFC-319 private-scope memory.',
    }),
  }).then((r) => r.memory.id)
  await api(`/api/memories/${secretId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  const publicId = await seedMemory('rfc319-mfb-global-scope', 'RFC-319 global-scope memory.', true)

  // 服务端读面先立起来：陌生人确实看不见那条私有 scope 的记忆。
  const strangerSees = (await listMemories('approved', stranger.token)).map((m) => m.id)
  expect(
    strangerSees,
    '陌生人在 HTTP 列表面就能看到私有 agent scope 的记忆 ⇒ 下面的 WS 断言无从谈起，' +
      '这已经是一次越权读',
  ).not.toContain(secretId)
  expect(strangerSees, '陌生人连全局记忆都看不到 ⇒ 下面「全局帧该到」的正向对照失去基线').toContain(
    publicId,
  )

  const strangerCtx = await openAs(browser, stranger.token)
  const adminCtx = await openAs(browser, daemon.token)
  try {
    // 两个浏览器会话各自开一条**自己持有**的 /ws/memories（见 openRawMemoryFeed
    // 的说明：应用自己的连接池会因为 auth store 变动整体重连，重连窗口里的帧对它
    // 是丢失的，用它断「这一帧到没到」注定间歇性变红）。
    const strangerPage = await strangerCtx.newPage()
    await strangerPage.goto(`${daemon.baseUrl}/memory?tab=all`)
    await expect(strangerPage.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
    await openRawMemoryFeed(strangerPage, stranger.token)

    const adminPage = await adminCtx.newPage()
    await adminPage.goto(`${daemon.baseUrl}/memory?tab=all`)
    await expect(adminPage.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
    await openRawMemoryFeed(adminPage, daemon.token)

    // 两条连接都真的**被服务端接受**了：hello 帧是升级门通过之后才发的
    // （ws/registry.ts:1128）。只看 onopen 不够——一条被立刻拒掉的连接也会先 open
    // 再 close，而那种连接收不到任何后续帧，下面的「没收到」就成了空话。
    for (const [who, target] of [
      ['陌生人', strangerPage],
      ['管理员', adminPage],
    ] as const) {
      await expect
        .poll(async () => (await rawFeed(target)).hello, {
          timeout: 30_000,
          message: `${who}的 /ws/memories 没有收到 hello ⇒ 这条连接压根没被服务端接受，下面的断言是空的`,
        })
        .toBe(true)
    }

    // 先动私有的，再动全局的。两次广播走同一个 broadcaster、同一个顺序，而这两条
    // socket 从建立起就一直开着（不会重连、不会漏窗口），所以「全局那条到了」本身
    // 就证明观察已经越过了私有那条——私有那条的缺席不可能是「还没来得及到」。
    await api(`/api/memories/${secretId}/archive`, { method: 'POST' })
    await api(`/api/memories/${publicId}/archive`, { method: 'POST' })

    await expect
      .poll(async () => (await rawFramesMatching(strangerPage, publicId)).length > 0, {
        timeout: 30_000,
        message:
          '陌生人收不到全局记忆的事件 ⇒ 他的记忆页从此不会自更新（而全局记忆本来就' +
          '全员可读），同时下面「私有那条没到」的断言也失去了对照',
      })
      .toBe(true)

    expect(
      (await rawFeed(strangerPage)).closed,
      '陌生人的 /ws/memories 被关掉了 ⇒ 「没收到私有那条」可能只是因为连接早就断了',
    ).toBeNull()
    expect(
      await rawFramesMatching(strangerPage, secretId),
      '陌生人在 WebSocket 上收到了他看不见的那个 scope 的记忆事件 ⇒ 这是一次越权读：' +
        '帧里带着 memoryId 与状态变化，谁在这台机器上给哪个私有代理挂了规矩因此外泄，' +
        '而 HTTP 层的 ACL 测试一条都照不到它',
    ).toEqual([])

    // 决定性的对照：同一次归档，管理员**收到了**。少了这一条，上面的「没收到」
    // 可能只是因为这次归档根本没广播出任何帧——那是一个完全不同的 bug，
    // 却会让这条用例照样绿。
    await expect
      .poll(async () => (await rawFramesMatching(adminPage, secretId)).length > 0, {
        timeout: 30_000,
        message:
          '管理员也没收到那条私有 scope 记忆的归档帧 ⇒ 说明这次归档压根没广播，' +
          '上面「陌生人没收到」证明的不是逐帧过滤，而是「谁都收不到」',
      })
      .toBe(true)
    expect(
      (await rawFramesMatching(adminPage, publicId)).length,
      '管理员收不到全局记忆的事件 ⇒ 管理员这条通道本身就是坏的，上一条对照不成立',
    ).toBeGreaterThan(0)
  } finally {
    await strangerCtx.close()
    await adminCtx.close()
  }
})

// ---------------------------------------------------------------------------
// MEM-41 —— 三位数的待办
// **必须最后跑**：它往库里灌 120 条候选，之后任何依赖精确计数的用例都不成立。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-41: 待办数超过 99 时徽标显示 99+，而不是把三位数塞进那个小圆点 @nightly', async ({
  page,
}) => {
  // 这一条锁的是**徽标的呈现规则**（MemoryPendingBadge.tsx:62 的 `> 99 ? '99+'`），
  // 不是候选是怎么产生的——「产生候选」的路径由 e2e/rfc319-memory-panels.spec.ts
  // （手工建）与 e2e/rfc319-memory-distill-jobs.spec.ts（蒸馏产出）各自覆盖。
  // 走 HTTP 建 120 条要 120 次往返，纯粹是把机器时间花在与本条断言无关的事情上，
  // 所以直接落库。字段取值全部照 CHECK 约束填
  // （db/migrations/0132_rfc248_memory_repo_group_scope.sql:50-59）：
  // global scope 的 scope_id 必须为 NULL，非 fused 的 fused_* 必须为 NULL。
  const bulk = 120
  const now = Date.now()
  runSqlite(
    dbPath(),
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${bulk})
     INSERT INTO memories (
       id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version
     )
     SELECT
       printf('01RFC319BADGE00000000%05d', n),
       'global',
       NULL,
       printf('rfc319-mfb-bulk-%05d', n),
       'RFC-319 badge-overflow fixture.',
       '[]',
       'candidate',
       'manual',
       ${now} + n,
       1
     FROM seq;`,
  )

  const manageable = (await listMemories('candidate')).filter((m) => m.canManage === true)
  const fusions = await pendingFusionCount()
  expect(
    manageable.length + fusions,
    '前提：造出来的待办总数没有越过 99 ⇒ 下面断言的是普通分支，不是溢出分支',
  ).toBeGreaterThan(99)

  // 停在「已批准」库而不是审批队列：本条断言的是导航栏的徽标，没必要为它渲染
  // 120 张候选卡片。
  await openApp(page, '/memory?tab=all')
  await expect(page.getByTestId('memory-all-list')).toBeVisible({ timeout: 30_000 })
  await expect(
    navBadge(page),
    '三位数被原样塞进徽标 ⇒ 那个小圆点会被撑破 / 数字被裁掉，导航栏当场变形；' +
      '而用户真正需要知道的只是「多到看不过来」',
  ).toHaveText('99+')
})
