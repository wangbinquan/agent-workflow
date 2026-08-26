// RFC-319 —— 首页总览 + API 文档 + 公开发现文档的用户面 e2e。
//
// 覆盖能力账本 CFG-41 / 42 / 20 / 39 / 40 / 43 / 34 七行。它们锁的是**平台的第一
// 屏与对外说明书**：一个是登录后看到的第一块信息，一个是别人拿来接入我们的唯一
// 依据。两类东西坏掉时都不会报错，只会安静地说错话——
//
//   * CFG-41 —— 能力网格的六个数字如果不是「按看的人算」，而是全库总数，那么
//     每个数字都在告诉用户「平台上还有 N 个你看不见的东西」。这本身就是一次
//     计数泄露（谁在这台机器上囤了多少代理 / 工作流），而且用户点进去只会看到
//     一个更短的列表，从此不再相信首页。判据必须是**两个账号同一时刻看到不同
//     的数字**，并且改成公开之后另一个人的数字**当场跟上**——只断言「有数字」
//     的测试对全库总数一样是绿的。
//   * CFG-42 —— 脉冲行是「7 天内」的统计。窗口一旦漏掉（或把取消 / 子任务 /
//     内部任务算进来），用户读到的成功率就是假的，而且是**朝着好看的方向**假
//     （历史上的成功堆积进来）。所以本文件为每一条排除规则各埋一行反例任务，
//     它们全部落在窗口外 / 边界外，任何一条被算进来都会把那句话算错。
//     「软降级」同理：/api/overview 挂掉时**整页白屏**与「数字变占位、其余照常
//     可用」在截图上都是「首页有问题」，但前者会让用户以为平台挂了、去重启
//     daemon。因此这里不止断言占位符，还要断言任务信息流仍在、并且真的点得动。
//   * CFG-20 —— hero 的运行时状态行是「这台机器还能不能干活」的唯一常驻信号。
//     缺失的**默认**运行时必须是红点：判成灰色（非默认那档）等于把「什么都跑
//     不了」画成「有个可选组件没装」，用户会一直等任务开始。三种状态还必须各自
//     说出人话——三条都渲染成同一句「未就绪」的话，用户就无从判断是没装、还是
//     装了但协议对不上。**边界（如实）**：`protocol-incompatible` 在当前构建里
//     服务端产不出来——routes/runtimes.ts:207-211 要 `ran && !compatible`，而两个
//     驱动的 probe 都写死 `compatible = ran`（opencode/util.ts:95、
//     claudeCode/probe.ts:79）。ready / not-found 两档全链路真造；第三档只能靠
//     改写状态接口响应把这份**契约上合法**的载荷送进页面，验它的措辞与颜色，
//     见下面第二条 CFG-20 用例开头的说明。
//   * CFG-39 —— 文档按调用者权限裁剪。不裁剪的后果不是「多看了几行」：一个只
//     有读权限的账号会拿到一份**完整的写端点清单**（路径 + 需要的权限点 + 用途
//     说明），那是一张现成的攻击面地图，照着扫就知道该去弄哪个权限点。判据必须
//     用两个权限档位对照，并且要有一条**同页同位置**的正向对照，否则「低权账号
//     看不到」可能只是页面整个没渲染出来。
//   * CFG-40 —— 发现文档里的 endpoint 是别人**要粘进自己客户端**的地址。反代
//     后面如果回的是 daemon 的内网 origin，所有照做的人都连不上，而失败现场在
//     他们那边、报的是连接错误，没人会怀疑到这份文档。所以逐条锁死推导优先级
//     （配置 → X-Forwarded-* → Host），并锁「关掉外部访问开关后文档如实说
//     enabled:false」——一份描述着不存在的surface的发现文档比没有文档更坏。
//   * CFG-43 —— 首次运行分支。空环境不给 Onboarding，新用户面对的就是一屏零；
//     反过来，有资源了还挂着 Onboarding，等于把老用户的真实数据藏在引导页后面。
//     两个方向都要断言，否则「永远显示 Dashboard」也能过。
//   * CFG-34 —— 设置 · Network 分区到文档页的跳转。这是产品里唯一一条把「外部
//     访问开关」和「怎么接入」连起来的路径；断了的话，管理员打开了开关却找不到
//     该给对方什么地址。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/backend/src/services/overview.ts:44-52        gatedCount：缺粗粒度读权限 → null
//   packages/backend/src/services/overview.ts:62-79        countAclResource：计数与列表页共用 visibleRowsCondition
//   packages/backend/src/services/overview.ts:42           WINDOW_7D_MS = 7 天
//   packages/backend/src/services/overview.ts:96           top-level + catalog_visibility='public' 才进卡片
//   packages/backend/src/services/overview.ts:103-106      awaiting = review ∪ human；canceled/interrupted 不进 7d 窗口
//   packages/backend/src/services/overview.ts:182          buildTaskStats 的 cutoff = now - 7d
//   packages/frontend/src/components/home/CapabilityGrid.tsx:91      visibleTiles：无权限的分区整块不渲染
//   packages/frontend/src/components/home/CapabilityGrid.tsx:110-120 计数 / 「—」占位
//   packages/frontend/src/components/home/CapabilityGrid.tsx:131-138 失败时的重试行（软降级）
//   packages/frontend/src/components/home/HomepageGreeting.tsx:146-150 脉冲行整行可缺省
//   packages/frontend/src/components/home/HomepageGreeting.tsx:193-212 describePulse：有终态才带成功率
//   packages/frontend/src/components/home/HomepageGreeting.tsx:223-245 itemSeverity / runtimeItemText
//   packages/frontend/src/components/home/HomepageGreeting.tsx:86        AGGREGATE_THRESHOLD = 3（超过就折叠成聚合行）
//   packages/frontend/src/routes/index.tsx:57-67                       首次运行分支
//   packages/frontend/src/components/Onboarding.tsx:38-56              computeIsFirstRun：demo 行不算「已配置」
//   packages/backend/src/routes/runtimes.ts:181                        默认运行时 fail-safe 回 opencode
//   packages/backend/src/routes/runtimes.ts:195-211                    ready / not-found / protocol-incompatible 三态
//   packages/backend/src/services/runtime/opencode/util.ts:95          probe: compatible = ran（所以第三态今天出不来）
//   packages/backend/src/services/runtime/claudeCode/probe.ts:79       同上
//   packages/shared/src/schemas/runtime.ts:17                          第三态仍是契约上的合法取值
//   packages/backend/src/services/apiDocs.ts:85-99                     端点按「账号能不能持有这些点」裁剪
//   packages/backend/src/services/apiDocs.ts:101-107                   工具的 grantable 标记
//   packages/backend/src/services/apiDocs.ts:240-250                   wellKnownMcp 文档体
//   packages/backend/src/routes/publicOrigin.ts:77-94                  derivePublicOrigin 优先级
//   packages/backend/src/routes/docs.ts:52-77                          /.well-known/mcp 挂在鉴权域外
//   packages/frontend/src/routes/settings.tsx:1622-1650                Network 分区 + 文档链接
//   packages/shared/src/schemas/permission.ts:915-923                  GUEST_BASELINE（只有六个 :read）
//
// 执行模型：本文件所有用例共用一个 daemon（默认 basic stub）。playwright.config.ts
// 把 fullyParallel 留在默认 false，因此文件内用例按**声明顺序串行**。顺序是判据的
// 一部分：
//   · CFG-43 必须第一个跑 —— 它要的是「用户什么都没建过」的实例，任何先跑的用例
//     建一个代理就把它变成恒真断言。
//   · CFG-40 放最后 —— 它会把 publicBaseUrl 写进 config.json（这是产品里唯一的
//     设置途径，没有 UI），写进去就没有「删掉某个键」的接口能撤销。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { join } from 'node:path'

import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

let daemon: DaemonHandle

const PASSWORD = 'longEnoughPassword'

/** 六个能力磁贴的 key（CapabilityGrid.tsx:44-78 的 TILES 顺序）。 */
const CAP_TILES = ['agents', 'workflows', 'workgroups', 'memory', 'scheduled', 'repos'] as const

/** guest 预设持有的三个资源读权限对应的磁贴（permission.ts:915-923）。 */
const GUEST_VISIBLE_TILES = ['agents', 'workflows', 'workgroups'] as const

interface SeededUser {
  username: string
  userId: string
  sessionToken: string
}

interface RawResponse {
  status: number
  body: string
}

interface OverviewLite {
  resources: {
    agents: number | null
    skills: number | null
    mcps: number | null
    plugins: number | null
    workflows: number | null
    workgroups: number | null
    repos: number | null
    scheduled: number | null
    memories: number | null
  }
  tasks: { running: number; awaiting: number; done7d: number; failed7d: number } | null
  generatedAt: string
}

interface RuntimeStatusLite {
  runtimes: Array<{
    name: string
    ok: boolean
    version: string | null
    state: 'ready' | 'not-found' | 'unlaunchable' | 'protocol-incompatible'
    isDefault: boolean
  }>
}

interface ApiDocsLite {
  role: string
  endpoints: Array<{
    method: string
    path: string
    summary: string
    permissions: string[]
    open: boolean
  }>
  tools: Array<{ name: string; permissions: string[]; grantable: boolean }>
  grantablePermissions: Array<{ resource: string; verbs: Array<{ verb: string }> }>
}

interface WellKnownMcp {
  version: string
  endpoint: string
  transport: string
  enabled: boolean
  authentication: { type: string; description: string }
  documentation: string
}

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

async function rawRequest(token: string, path: string, init?: RequestInit): Promise<RawResponse> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return { status: res.status, body: await res.text() }
}

async function jsonOf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await rawRequest(token, path, init)
  expect(res.status < 400, `${init?.method ?? 'GET'} ${path}: ${res.status} ${res.body}`).toBe(true)
  return JSON.parse(res.body) as T
}

/** RFC-099 的建号姿势：管理员建用户 → 用户名密码登录拿会话 token。ACL 的 PUT 是
 *  tokenAccess:'never'，只有会话 token 能过，所以一律用登录换来的 sessionToken。 */
async function createUserAndLogin(opts: {
  username: string
  role: 'admin' | 'user' | 'manager' | 'guest'
}): Promise<SeededUser> {
  const created = await rawRequest(daemon.token, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: PASSWORD,
    }),
  })
  expect(created.status, `createUser ${opts.username}: ${created.body}`).toBe(201)
  const { id } = JSON.parse(created.body) as { id: string }

  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: PASSWORD }),
  })
  expect(login.ok, `login ${opts.username}: ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { username: opts.username, userId: id, sessionToken }
}

async function openAs(
  browser: Browser,
  token: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  await context.addInitScript(
    ([baseUrl, tok]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [daemon.baseUrl, token] as const,
  )
  return { context, page: await context.newPage() }
}

/** RFC-231 起所有 canonical 创建路径都是 creator-owner + private；要让别人看得见
 *  必须显式改 public。 */
async function makePublic(id: string, token: string): Promise<void> {
  const acl = await jsonOf<{ aclRevision: number }>(token, `/api/agents/${id}/acl`)
  const res = await rawRequest(token, `/api/agents/${id}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      visibility: 'public',
      expectedResourceId: id,
      expectedAclRevision: acl.aclRevision,
    }),
  })
  expect(res.status, `make agents/${id} public: ${res.body}`).toBe(200)
}

async function createAgent(token: string, name: string): Promise<string> {
  const created = await jsonOf<{ id: string }>(token, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'rfc319 overview fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'fixture body',
    }),
  })
  return created.id
}

async function overviewOf(token: string): Promise<OverviewLite> {
  return jsonOf<OverviewLite>(token, '/api/overview')
}

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

/** 把 config.json 打一个补丁（PUT /api/config 会顺手让进程内的 config 读缓存失效，
 *  所以下一次请求就能读到——publicBaseUrl / mcpSurfaceEnabled 都靠这条生效）。 */
async function patchConfig(patch: Record<string, unknown>): Promise<void> {
  const res = await rawRequest(daemon.token, '/api/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  expect(res.status, `PUT /api/config ${JSON.stringify(patch)}: ${res.body}`).toBe(200)
}

async function wellKnown(headers: Record<string, string> = {}): Promise<WellKnownMcp> {
  const res = await fetch(`${daemon.baseUrl}/.well-known/mcp`, { headers })
  expect(res.status, 'GET /.well-known/mcp').toBe(200)
  return (await res.json()) as WellKnownMcp
}

/** 一个能力磁贴上显示的数字（或占位符）。 */
function capCount(page: Page, key: (typeof CAP_TILES)[number]) {
  return page.getByTestId(`home-cap-${key}-count`)
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// CFG-43 —— 必须第一个跑：它要的前提是「这个实例上用户什么都没建过」。
// ---------------------------------------------------------------------------

test('CFG-43 首次运行分支：空实例给 Onboarding，建出资源后换成 Dashboard，且引导只给动得了手的人 @nightly', async ({
  browser,
}) => {
  // 先建 guest：guest 没有 agents:create / workflows:create / tasks:execute，
  // 于是 canUseGuidedTour 为 false（routes/index.tsx:31）。这一档要在实例仍然
  // 空着的时候看 —— 它是「首次运行屏只发给动得了手的人」这条规则的唯一现场。
  const guest = await createUserAndLogin({ username: 'rfc319-cfg43-guest', role: 'guest' })

  const guestSide = await openAs(browser, guest.sessionToken)
  try {
    await guestSide.page.goto(`${daemon.baseUrl}/`)
    await expect(
      guestSide.page.getByTestId('homepage'),
      'guest 在空实例上没拿到 Dashboard ⇒ 要么整页坏了，要么下面那条「不给引导」' +
        '是因为页面根本没渲染出来',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      guestSide.page.getByTestId('onboarding-hero'),
      'guest 拿到了引导屏 ⇒ 引导的每一步都要 agents:create / workflows:create / ' +
        'tasks:execute，他点到第一步就吃 403，第一印象直接是一堵墙',
    ).toHaveCount(0)
  } finally {
    await guestSide.context.close()
  }

  // 管理员（能建东西的人）在同一个空实例上必须拿到引导屏。
  const adminSide = await openAs(browser, daemon.token)
  try {
    const { page } = adminSide
    await page.goto(`${daemon.baseUrl}/`)
    await expect(
      page.getByTestId('onboarding-hero'),
      '空实例不给引导屏 ⇒ 新装的平台第一屏是一排 0，用户不知道从哪儿开始',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId('homepage'),
      '引导屏和 Dashboard 同时在 ⇒ 首屏有两套主行动，等于没有主行动',
    ).toHaveCount(0)
    // 引导屏上的能力网格是 variant='intro'（CapabilityGrid.tsx:81-83）：一个
    // 计数都不该渲染 —— 全新安装不该拿一墙的 0 迎接用户。
    await expect(
      page.getByTestId('home-cap-agents-count'),
      '引导屏渲染了计数 ⇒ 新装的平台用一排 0 当第一印象',
    ).toHaveCount(0)

    // 这里的关键前提：平台自己 seed 的 demo 内容（aw-demo- 前缀）此刻已经在库里，
    // 引导屏却仍然出现 —— 也就是 computeIsFirstRun 没有把「平台自己放的样例」
    // 当成「用户已经配置过了」（Onboarding.tsx:38-56 / RFC-307 事故）。
    const seededAgents = await jsonOf<Array<{ id: string }>>(daemon.token, '/api/agents')
    const seededWorkflows = await jsonOf<Array<{ id: string }>>(daemon.token, '/api/workflows')
    expect(
      [...seededAgents, ...seededWorkflows].filter((r) => r.id.startsWith('aw-demo-')).length,
      '库里连一条 demo 行都没有 ⇒ 上面那条「有 demo 也算首次运行」是恒真断言',
    ).toBeGreaterThan(0)

    // 用户真的建了东西 → 换成 Dashboard。没有这一步，「永远显示引导屏」也能过。
    await createAgent(daemon.token, 'rfc319-cfg43-first-agent')
    await jsonOf<{ id: string }>(daemon.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-cfg43-first-workflow',
        description: '',
        definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
      }),
    })

    await page.goto(`${daemon.baseUrl}/`)
    await expect(
      page.getByTestId('homepage'),
      '用户建完资源仍停在引导屏 ⇒ 他的真实数据被藏在一张「从这里开始」后面',
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('onboarding-hero')).toHaveCount(0)
    await expect(
      page.getByTestId('home-cap-agents-count'),
      'Dashboard 上没有计数 ⇒ 能力网格退化成一排静态入口，首页不再回答「现在有多少」',
    ).toBeVisible()
  } finally {
    await adminSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// CFG-41
// ---------------------------------------------------------------------------

test('CFG-41 能力网格的计数按人算：两个账号同一时刻看到不同的数字，改成公开后当场跟上 @nightly', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({ username: 'rfc319-cfg41-alice', role: 'user' })
  const carol = await createUserAndLogin({ username: 'rfc319-cfg41-carol', role: 'user' })

  // RFC-231：默认 creator-owner + private。两个私有 + 一个公开，差值就是 2。
  const secretA = await createAgent(alice.sessionToken, 'rfc319-cfg41-alice-secret-a')
  const secretB = await createAgent(alice.sessionToken, 'rfc319-cfg41-alice-secret-b')
  const shared = await createAgent(alice.sessionToken, 'rfc319-cfg41-alice-shared')
  await makePublic(shared, alice.sessionToken)

  const aliceOverview = await overviewOf(alice.sessionToken)
  const carolOverview = await overviewOf(carol.sessionToken)
  expect(
    aliceOverview.resources.agents,
    'alice 的代理计数是 null ⇒ 她的读权限没生效',
  ).not.toBeNull()
  expect(carolOverview.resources.agents).not.toBeNull()
  expect(
    (aliceOverview.resources.agents ?? 0) - (carolOverview.resources.agents ?? 0),
    '两个账号看到同一个代理计数 ⇒ 首页报的是全库总数，等于告诉每个人「这台机器上' +
      '还有 N 个你看不见的东西」，而点进去的列表更短',
  ).toBe(2)

  // 界面面：磁贴上的数字必须**就是**这个账号的 /api/overview 数字（同一时刻，
  // 中间没有任何写入）。不这么钉，前端拿错 key / 拿了缓存都看不出来。
  const aliceSide = await openAs(browser, alice.sessionToken)
  const carolSide = await openAs(browser, carol.sessionToken)
  try {
    await aliceSide.page.goto(`${daemon.baseUrl}/`)
    await expect(aliceSide.page.getByTestId('home-cap-grid')).toBeVisible({ timeout: 30_000 })
    await expect(
      capCount(aliceSide.page, 'agents'),
      '磁贴上的数字与后端给这个账号算出来的不一致 ⇒ 首页在替用户编数字',
    ).toHaveText(String(aliceOverview.resources.agents))

    await carolSide.page.goto(`${daemon.baseUrl}/`)
    await expect(carolSide.page.getByTestId('home-cap-grid')).toBeVisible({ timeout: 30_000 })
    await expect(capCount(carolSide.page, 'agents')).toHaveText(
      String(carolOverview.resources.agents),
    )

    // 正向对照 + 活性证明：把一个私有代理改成公开，carol 的数字必须**当场** +1。
    // 少了这一条，「两个数字不同」也可能只是某个账号的计数整个坏了（恒小）。
    await makePublic(secretA, alice.sessionToken)
    const carolAfter = await overviewOf(carol.sessionToken)
    expect(
      carolAfter.resources.agents,
      '资源改成公开后别人的计数没涨 ⇒ 计数不是按人现算的，而是某处的快照',
    ).toBe((carolOverview.resources.agents ?? 0) + 1)

    await carolSide.page.goto(`${daemon.baseUrl}/`)
    await expect(capCount(carolSide.page, 'agents')).toHaveText(String(carolAfter.resources.agents))

    // 反向：仍然私有的那一个，carol 依旧看不见（否则上面 +1 可能是「全都能看见了」）。
    const carolAgents = await jsonOf<Array<{ id: string }>>(carol.sessionToken, '/api/agents')
    expect(
      carolAgents.map((row) => row.id),
      'carol 的代理列表里出现了 alice 仍未公开的代理 ⇒ 这是一次越权读，' +
        '首页的数字只是它的第一个症状',
    ).not.toContain(secretB)
    expect(carolAgents.map((row) => row.id)).toContain(secretA)
  } finally {
    await aliceSide.context.close()
    await carolSide.context.close()
  }
})

test('CFG-41 没有读权限的分区整块不渲染，有权限的磁贴点进去落在自己的列表页 @nightly', async ({
  browser,
}) => {
  // guest 预设只有六个资源 :read（permission.ts:915-923），没有 memory:read /
  // scheduled-tasks:read / repos:read —— 产品里唯一「登录了、看得见资源、但读不到
  // 这三类」的档位。
  const guest = await createUserAndLogin({ username: 'rfc319-cfg41-guest', role: 'guest' })

  // 服务端事实：缺粗粒度读权限的键回 null，而不是 0（overview.ts:44-52）。
  // 这个区别是有意义的：0 是「你有权限、确实没有」，null 是「不该由你看到」。
  const guestOverview = await overviewOf(guest.sessionToken)
  expect(guestOverview.resources.memories, 'guest 读到了记忆计数 ⇒ 计数没跟着权限走').toBeNull()
  expect(guestOverview.resources.scheduled).toBeNull()
  expect(guestOverview.resources.repos).toBeNull()
  expect(
    guestOverview.tasks,
    'guest 读到了任务统计 ⇒ 他连任务列表都打不开，首页却告诉他有几个在跑',
  ).toBeNull()
  expect(
    guestOverview.resources.agents,
    'guest 连代理计数都没有 ⇒ 下面的磁贴断言无效',
  ).not.toBeNull()

  const guestSide = await openAs(browser, guest.sessionToken)
  try {
    const { page } = guestSide
    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.getByTestId('home-cap-grid')).toBeVisible({ timeout: 30_000 })
    for (const key of CAP_TILES) {
      const expected = (GUEST_VISIBLE_TILES as readonly string[]).includes(key) ? 1 : 0
      await expect(
        page.getByTestId(`home-cap-${key}`),
        expected === 0
          ? `${key} 磁贴对没有该读权限的账号仍然渲染 ⇒ 用户点进去只能吃 403，` +
              `而且磁贴上那个「—」还在暗示「这里有东西，只是没数出来」`
          : `${key} 磁贴对有权限的账号没渲染 ⇒ 这类能力在首页整体不可达`,
      ).toHaveCount(expected)
    }
    await expect(
      page.getByTestId('homepage-pulse'),
      'guest 拿不到任务统计却仍渲染脉冲行 ⇒ 行里只能是编出来的数字',
    ).toHaveCount(0)
    await expect(
      page.getByTestId('homepage-runtime'),
      'guest 没有 runtime:read 却看到运行时状态行 ⇒ 它暴露了这台机器上装了哪些 CLI、' +
        '在什么路径、什么版本',
    ).toHaveCount(0)
  } finally {
    await guestSide.context.close()
  }

  // 正向对照：同样六个磁贴，换成有全部读权限的账号，一个不少 —— 少了这一条，
  // 上面那些 0 可能只是「能力网格整个没渲染」。
  const adminSide = await openAs(browser, daemon.token)
  try {
    const { page } = adminSide
    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.getByTestId('home-cap-grid')).toBeVisible({ timeout: 30_000 })
    for (const key of CAP_TILES) {
      await expect(page.getByTestId(`home-cap-${key}`)).toHaveCount(1)
    }

    // 跳转：整块磁贴就是一个链接（Card interactive to=…）。点不动 = 首页的能力
    // 地图只是一张画，用户得自己去侧栏找。
    await page.getByTestId('home-cap-agents').click()
    await page.waitForURL(/\/agents$/)
    expect(new URL(page.url()).pathname, '代理磁贴跳去了别处').toBe('/agents')

    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.getByTestId('home-cap-grid')).toBeVisible()
    await page.getByTestId('home-cap-memory').click()
    await page.waitForURL(/\/memory\?tab=all$/)
    // 深链带 tab=all 是有原因的：/memory 的默认视图与磁贴计数口径不同，落错页
    // 用户会看到一个和磁贴对不上的数字，然后以为哪边错了（CapabilityGrid.tsx:60-69）。
    const memoryUrl = new URL(page.url())
    expect(memoryUrl.pathname).toBe('/memory')
    expect(
      memoryUrl.searchParams.get('tab'),
      '记忆磁贴没带 tab=all ⇒ 落地页统计口径与磁贴上的数字对不上',
    ).toBe('all')
  } finally {
    await adminSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// CFG-42
// ---------------------------------------------------------------------------

/** 26 位、形状合法的固定 id：便于清理，也便于失败时一眼认出是本文件种的行。 */
function seededTaskId(suffix: string): string {
  return `01JC319CFG42${suffix}`.toUpperCase().padEnd(26, '0').slice(0, 26)
}

const EMPTY_DEFINITION = '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[]}'

interface SeedTaskSpec {
  suffix: string
  status: string
  /** 相对 now 的完成时刻（毫秒偏移，负数=过去）；null = 未完成。 */
  finishedOffsetMs: number | null
  catalogVisibility?: 'public' | 'internal'
  parentSuffix?: string
}

/**
 * 直接把任务行种进 daemon 的 sqlite。
 *
 * 为什么不跑真任务：本用例锁的是「7 天窗口」和几条排除规则，而其中三条反例
 * （8 天前完成、被取消、子任务）**无法**由一次真实执行在测试时限内造出来 ——
 * 尤其「8 天前」，真跑永远造不出。窗口边界只有种行能验。
 */
function seedTasks(ownerUserId: string, specs: readonly SeedTaskSpec[]): void {
  const now = Date.now()
  const rows = specs.map((spec) => {
    const id = seededTaskId(spec.suffix)
    const finishedAt = spec.finishedOffsetMs === null ? 'NULL' : String(now + spec.finishedOffsetMs)
    const parent = spec.parentSuffix === undefined ? 'NULL' : `'${seededTaskId(spec.parentSuffix)}'`
    return (
      `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, ` +
      `base_branch, branch, status, inputs, started_at, finished_at, owner_user_id, ` +
      `catalog_visibility, parent_task_id) VALUES (` +
      `'${id}', 'rfc319-cfg42-${spec.suffix}', 'rfc319-cfg42-workflow', '${EMPTY_DEFINITION}', ` +
      `'/tmp/rfc319-cfg42', '/tmp/rfc319-cfg42/wt', 'main', 'agent-workflow/${id}', ` +
      `'${spec.status}', '{}', ${now - 3_600_000}, ${finishedAt}, '${ownerUserId}', ` +
      `'${spec.catalogVisibility ?? 'public'}', ${parent});`
    )
  })
  runSqlite(dbPath(), rows.join('\n'))
}

const DAY_MS = 86_400_000

test('CFG-42 任务脉冲行：只数 7 天内的终态、只数自己看得见的任务 @nightly', async ({ browser }) => {
  const alice = await createUserAndLogin({ username: 'rfc319-cfg42-alice', role: 'user' })
  const bystander = await createUserAndLogin({ username: 'rfc319-cfg42-bystander', role: 'user' })

  // 应当被数进去的：running 1、awaiting(review ∪ human) 2、done7d 2、failed7d 1。
  // 其余四行每一行都是一条**独立的排除规则**的反例，任何一条被算进来，下面那句
  // 话就算错，而且是朝着「更好看」的方向错。
  seedTasks(alice.userId, [
    { suffix: 'RUN', status: 'running', finishedOffsetMs: null },
    { suffix: 'REVIEW', status: 'awaiting_review', finishedOffsetMs: null },
    { suffix: 'HUMAN', status: 'awaiting_human', finishedOffsetMs: null },
    { suffix: 'DONEA', status: 'done', finishedOffsetMs: -DAY_MS },
    { suffix: 'DONEB', status: 'done', finishedOffsetMs: -DAY_MS },
    { suffix: 'FAIL', status: 'failed', finishedOffsetMs: -DAY_MS },
    // ① 8 天前完成 —— 落在 7 天窗口外（overview.ts:42 / :182）。
    { suffix: 'OLD', status: 'done', finishedOffsetMs: -8 * DAY_MS },
    // ② 取消 —— D11 明确把 canceled / interrupted 排除在 7d 窗口外。
    { suffix: 'CANCEL', status: 'canceled', finishedOffsetMs: -DAY_MS },
    // ③ 内部任务 —— catalog_visibility='internal' 不进首页卡片（overview.ts:96）。
    {
      suffix: 'INTERNAL',
      status: 'done',
      finishedOffsetMs: -DAY_MS,
      catalogVisibility: 'internal',
    },
    // ④ 子任务 —— 父任务代表整棵树，子执行不重复计数（overview.ts:96）。
    { suffix: 'CHILD', status: 'done', finishedOffsetMs: -DAY_MS, parentSuffix: 'RUN' },
  ])

  const aliceOverview = await overviewOf(alice.sessionToken)
  expect(
    aliceOverview.tasks,
    '任务统计整个是 null ⇒ 这个账号连 tasks:read:own 都没有，本用例无效',
  ).not.toBeNull()
  expect(
    aliceOverview.tasks,
    '7 天窗口 / 取消 / 内部 / 子任务四条排除规则里有一条漏了 —— 用户读到的成功率' +
      '就是假的，而且是朝着好看的方向假',
  ).toEqual({ running: 1, awaiting: 2, done7d: 2, failed7d: 1 })

  const bystanderOverview = await overviewOf(bystander.sessionToken)
  expect(
    bystanderOverview.tasks,
    '旁观者读到了别人的任务统计 ⇒ 首页把「谁在忙什么、忙得成不成」漏给了无关的人',
  ).toEqual({ running: 0, awaiting: 0, done7d: 0, failed7d: 0 })

  const aliceSide = await openAs(browser, alice.sessionToken)
  const bystanderSide = await openAs(browser, bystander.sessionToken)
  try {
    await aliceSide.page.goto(`${daemon.baseUrl}/`)
    // done 2 / failed 1 → 成功率 round(2/3*100) = 67%。整句逐字锁：这一行是用户
    // 判断「平台最近干得怎么样」的唯一入口，数字错、单位错、成功率算反都在这里红。
    await expect(
      aliceSide.page.getByTestId('homepage-pulse'),
      '脉冲行的文案与后端统计对不上 ⇒ 首页那句「最近干得怎么样」是编的',
    ).toHaveText('1 running · 2 waiting · 2 done in 7d (67% success)')

    await bystanderSide.page.goto(`${daemon.baseUrl}/`)
    // 没有任何终态时不该出现成功率括号（describePulse：outcomes>0 才带）——
    // 否则新用户第一眼看到的是「0% success」，一个凭空的坏消息。
    await expect(
      bystanderSide.page.getByTestId('homepage-pulse'),
      '零终态却渲染了成功率 ⇒ 新用户第一眼看到「0% 成功」，一个凭空的坏消息',
    ).toHaveText('0 running · 0 waiting · 0 done in 7d')
  } finally {
    await aliceSide.context.close()
    await bystanderSide.context.close()
  }
})

test('CFG-42 /api/overview 失败：计数降级为占位、脉冲行整行消失，首页其余部分仍然能用 @nightly', async ({
  browser,
}) => {
  const side = await openAs(browser, daemon.token)
  try {
    const { page } = side

    // (0) 正常态基线。没有它，下面「变成 —」可能只是这台机器本来就没数据。
    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.getByTestId('home-cap-grid')).toBeVisible({ timeout: 30_000 })
    await expect(capCount(page, 'agents')).toHaveText(/^\d+$/)
    await expect(page.getByTestId('homepage-pulse')).toBeVisible()

    // (1) 只掐 /api/overview 这一条 —— 首页其余接口照常。
    await page.route('**/api/overview', (route) => route.abort())
    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.getByTestId('home-cap-grid')).toBeVisible({ timeout: 30_000 })
    // 先等失败真的落定再看占位符：加载中同样渲染「—」（CapabilityGrid.tsx:118），
    // 不等的话下面那一圈断言可能只是在断言「还在转圈」。
    const errorRow = page.locator('.home-cap__error')
    await expect(errorRow, '总览失败连一句提示都没有 ⇒ 一排「—」没有任何解释').toBeVisible()
    for (const key of CAP_TILES) {
      await expect(
        capCount(page, key),
        `${key} 磁贴在总览接口失败时没有降级 ⇒ 要么卡在旧数字（用户照着一个过期` +
          `数字做判断），要么整块炸掉`,
      ).toHaveText('—')
    }
    await expect(
      page.getByTestId('homepage-pulse'),
      '统计取不到却仍渲染脉冲行 ⇒ 行里的数字只能是 0 或旧值，两种都在说谎',
    ).toHaveCount(0)
    // 失败必须给一条出路，否则用户只会盯着一排「—」猜。
    await expect(
      errorRow.getByRole('button', { name: 'Retry', exact: true }),
      '提示里没有重试入口 ⇒ 用户只能刷新整页碰运气',
    ).toBeVisible()

    // (2) 「软」的判据不是占位符，是**其余部分还活着**：任务信息流仍在，
    //     并且真的点得动 —— 整页白屏和这个在截图上都叫「首页有问题」，但前者
    //     会让用户以为平台挂了、去重启 daemon。
    await expect(
      page.getByTestId('homepage-section-feed'),
      '总览接口挂掉带走了任务信息流 ⇒ 一个聚合计数接口把整张首页拖下水',
    ).toBeVisible()
    await expect(page.getByTestId('homepage-section-running')).toBeVisible()
    await expect(page.getByTestId('homepage-section-inbox')).toBeVisible()
    await expect(page.getByTestId('homepage-section-recent')).toBeVisible()
    await expect(page.getByTestId('homepage-start-task')).toBeVisible()
    await page.getByTestId('homepage-all-tasks-link').click()
    await page.waitForURL(/\/tasks$/)
    expect(new URL(page.url()).pathname, '降级态下首页的出口点不动 ⇒ 用户被困在首页').toBe('/tasks')

    // (3) 重试按钮不是装饰：放开拦截后点它，数字必须自己回来（不需要刷新页面）。
    //     必须**先等错误行出现再解除拦截**：react-query 的 retry:1 会在约 1s 后
    //     自动重试一次，抢在那之前放开拦截的话这一轮根本不会落进 error 态，
    //     错误行永远不出现——那是测试自己的时序问题，不是产品的。
    await page.goto(`${daemon.baseUrl}/`)
    const staleError = page.locator('.home-cap__error')
    await expect(staleError).toBeVisible()
    await expect(capCount(page, 'agents')).toHaveText('—')
    await page.unroute('**/api/overview')
    await staleError.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      capCount(page, 'agents'),
      '点了重试数字没回来 ⇒ 这个按钮只是让用户以为自己做了点什么',
    ).toHaveText(/^\d+$/)
    await expect(page.getByTestId('homepage-pulse')).toBeVisible()
    await expect(page.locator('.home-cap__error')).toHaveCount(0)
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// CFG-20
// ---------------------------------------------------------------------------

const MISSING_RUNTIME = 'rfc319-cfg20-missing'
const RETIRED_RUNTIME = 'rfc319-cfg20-retired-fork'

test('CFG-20 首页运行时状态行：三种失败各说各的话，缺失的默认运行时必须是红点 @nightly', async ({
  browser,
}) => {
  // 造出三行、且只有三行 —— HomepageGreeting.tsx:86 的 AGGREGATE_THRESHOLD=3，
  // 超过就折叠成一句聚合，逐行的措辞与颜色就再也看不见了。内置的 claude-code
  // 在本 harness 里指向同一个 stub（会是 ready），先停用它腾出位置。
  await rawRequest(daemon.token, '/api/runtimes/claude-code/enabled', {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  })

  // ① not-found：注册一个指向不存在文件的运行时。probe:false 让它别在保存前
  //    先去 spawn（那会直接失败）——这正是「装之前先登记好」的真实用法。
  const created = await rawRequest(daemon.token, '/api/runtimes', {
    method: 'POST',
    body: JSON.stringify({
      name: MISSING_RUNTIME,
      protocol: 'claude-code',
      binaryPath: join(daemon.home, 'no-such-runtime-binary'),
      probe: false,
    }),
  })
  expect(created.status, `register ${MISSING_RUNTIME}: ${created.body}`).toBe(201)

  // ② protocol-incompatible：库里留着一行、但这个构建已经不认识它的协议了
  //    （RFC-282 C2 的现实来源：降级 / 驱动被移除，行还在）。这条分支只能从
  //    数据侧造 —— HTTP 面的 protocol 是 enum，进不来。
  runSqlite(
    dbPath(),
    `INSERT INTO runtimes (id, name, protocol, binary_path, enabled) VALUES ` +
      `('01JC319CFG20RETIRED0000000', '${RETIRED_RUNTIME}', 'retired-fork-protocol', NULL, 1);`,
  )

  try {
    // 服务端事实先对账：三行、三态、默认仍是 opencode。
    const status = await jsonOf<RuntimeStatusLite>(daemon.token, '/api/runtimes/status')
    const byName = new Map(status.runtimes.map((row) => [row.name, row]))
    expect(
      status.runtimes.length,
      `枚举出的运行时不是 3 行（拿到 ${status.runtimes.map((r) => r.name).join(',')}）⇒ ` +
        `hero 会折叠成聚合行，逐行措辞与颜色都验不到`,
    ).toBe(3)
    expect(byName.get('opencode')?.state, '内置 opencode 探不通 ⇒ 没有 ready 这一档可对照').toBe(
      'ready',
    )
    expect(
      byName.get(MISSING_RUNTIME)?.state,
      '指向不存在的文件却不是 not-found ⇒ 状态行分不清「没装」和别的失败',
    ).toBe('not-found')
    // 库里那行协议不认识的运行时**必须仍然出现在清单里、并且判成不可用**。
    // 它今天落在 not-found 而不是 protocol-incompatible，是因为
    // runtimes.ts:207-211 只在 `ran===true && compatible===false` 时给出后者，
    // 而两个驱动的 probe 都是 `compatible = ran`
    // （opencode/util.ts:95、claudeCode/probe.ts:79）——详见本文件末尾对
    // protocol-incompatible 的说明。这里锁的是 RFC-282 C2 真正保证的那件事：
    // 一行脏数据只拖垮自己。
    expect(
      byName.has(RETIRED_RUNTIME),
      '协议不认识的那一行整个从清单里消失 ⇒ 管理员在首页看不到它、也就永远不知道' +
        '库里躺着一个再也起不来的运行时',
    ).toBe(true)
    expect(
      byName.get(RETIRED_RUNTIME)?.ok,
      '协议不认识的那一行被判成可用 ⇒ 首页说它没问题，派发过去才发现根本没有驱动',
    ).toBe(false)
    expect(byName.get('opencode')?.isDefault).toBe(true)

    // 状态行的措辞从**接口实际返回的版本**推导，不写死：ready 有版本号时是
    // 「name vX」，拿不到版本号时是「name ok」（HomepageGreeting.tsx:233-238）。
    const opencodeRow = byName.get('opencode')!
    const readyText =
      opencodeRow.version !== null ? `opencode v${opencodeRow.version}` : 'opencode ok'

    const side = await openAs(browser, daemon.token)
    try {
      const { page } = side
      await page.goto(`${daemon.baseUrl}/`)
      const line = page.getByTestId('homepage-runtime')
      await expect(line, '首页没有运行时状态行 ⇒ 这台机器能不能干活没有任何常驻信号').toBeVisible({
        timeout: 30_000,
      })

      // 每一行各说各的话，并且**逐行点名**。三行被压成同一句「未就绪」、或者
      // 不说名字，用户就无从判断该去装哪一个。
      await expect(line).toContainText(readyText)
      await expect(
        line,
        '「没装」这一档没说清是哪一个运行时没装 ⇒ 用户不知道该去装什么',
      ).toContainText(`${MISSING_RUNTIME} not found`)
      await expect(
        line,
        '库里那行坏掉的运行时在首页上没有任何痕迹 ⇒ 它会一直躺在注册表里没人处理',
      ).toContainText(`${RETIRED_RUNTIME} not found`)

      // 颜色就是 dot 的 modifier 类（span 是 aria-hidden 的纯装饰，类名是它
      // 唯一的载体）。默认运行时健在时，两条失败都是「灰」而非「红」——非默认
      // 组件没装不该常驻一个红点，否则红点会被当成背景噪音。
      await expect(page.locator('.homepage__runtime-dot--ok')).toHaveCount(1)
      await expect(
        page.locator('.homepage__runtime-dot--soft'),
        '非默认运行时的失败被画成红点 ⇒ 红点变成常态，真出事时没人再看它',
      ).toHaveCount(2)
      await expect(page.locator('.homepage__runtime-dot--fault')).toHaveCount(0)

      // 反向：把那个缺失的运行时设成默认 —— 同一行、同一个失败，必须从灰变红。
      // 这是「什么都跑不了」的唯一提示，判成灰色用户会一直等任务开始。
      await patchConfig({ defaultRuntime: MISSING_RUNTIME })
      const afterDefault = await jsonOf<RuntimeStatusLite>(daemon.token, '/api/runtimes/status')
      expect(
        afterDefault.runtimes.find((r) => r.name === MISSING_RUNTIME)?.isDefault,
        '改了 defaultRuntime 但状态接口不认 ⇒ 下面的颜色断言测的是旧状态',
      ).toBe(true)

      await page.goto(`${daemon.baseUrl}/`)
      await expect(page.getByTestId('homepage-runtime')).toBeVisible({ timeout: 30_000 })
      await expect(
        page.locator('.homepage__runtime-dot--fault'),
        '缺失的**默认**运行时不是红点 ⇒ 「平台此刻什么都跑不了」这件事在首页上' +
          '毫无提示，用户只会以为任务排着队',
      ).toHaveCount(1)
      await expect(page.getByTestId('homepage-runtime')).toContainText(
        `${MISSING_RUNTIME} not found`,
      )
    } finally {
      await side.context.close()
    }
  } finally {
    // 复位：后面的用例不该继承一个坏掉的默认运行时。
    await patchConfig({ defaultRuntime: 'opencode' })
    await rawRequest(daemon.token, `/api/runtimes/${MISSING_RUNTIME}`, { method: 'DELETE' })
    runSqlite(dbPath(), `DELETE FROM runtimes WHERE name = '${RETIRED_RUNTIME}';`)
    await rawRequest(daemon.token, '/api/runtimes/claude-code/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
  }
})

test('CFG-20 protocol-incompatible 这一档：与「没装」必须是两句不同的话，当默认时同样是红点 @nightly', async ({
  browser,
}) => {
  // 诚实说明：这个状态在**当前构建里服务端产不出来**。routes/runtimes.ts:207-211
  // 只在 `ran===true && compatible===false` 时给出它，而现存两个驱动的 probe 都
  // 写死 `compatible = ran`（opencode/util.ts:95、claudeCode/probe.ts:79），
  // 于是「二进制跑起来了、但协议对不上」没有产生者；上一条用例里那行协议不认识
  // 的运行时因此落在 not-found。它仍是 shared 契约的合法取值
  // （packages/shared/src/schemas/runtime.ts:17）并且有专属文案，任何一天某个
  // 驱动开始区分这两件事，用户看到的就是这句话。
  //
  // 所以这里**改写 /api/runtimes/status 的响应**把这份合法载荷送到页面上：被测
  // 的是页面对它的呈现（措辞是否与「没装」分得开、默认失败是否变红），不是后端
  // 能不能产出它。这条边界写在这里，免得后来的人把它读成「产品能进这个状态」。
  const statusPayload = (incompatibleIsDefault: boolean): string =>
    JSON.stringify({
      runtimes: [
        {
          name: 'opencode',
          protocol: 'opencode',
          binary: '/opt/opencode',
          ok: true,
          version: '1.2.3',
          reportedVersion: '1.2.3',
          state: 'ready',
          isDefault: !incompatibleIsDefault,
        },
        {
          name: 'legacy-fork',
          protocol: 'claude-code',
          binary: '/opt/legacy-fork',
          ok: false,
          version: '7.0.0',
          reportedVersion: '7.0.0',
          state: 'protocol-incompatible',
          isDefault: incompatibleIsDefault,
        },
        {
          name: 'gone-cli',
          protocol: 'claude-code',
          binary: '/opt/gone-cli',
          ok: false,
          version: null,
          reportedVersion: null,
          state: 'not-found',
          isDefault: false,
        },
      ],
    })

  const side = await openAs(browser, daemon.token)
  try {
    const { page } = side
    let incompatibleIsDefault = false
    await page.route('**/api/runtimes/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: statusPayload(incompatibleIsDefault),
      }),
    )

    await page.goto(`${daemon.baseUrl}/`)
    const line = page.getByTestId('homepage-runtime')
    await expect(line).toBeVisible({ timeout: 30_000 })
    await expect(line, '就绪那一档没带版本号 ⇒ 用户无法判断装的是不是自己要的版本').toContainText(
      'opencode v1.2.3',
    )
    await expect(
      line,
      '「协议对不上」被说成「没装」⇒ 用户会去重装一个本来就装着的二进制，' + '装完还是不能用',
    ).toContainText('legacy-fork protocol incompatible')
    await expect(line, '「没装」这一档丢了').toContainText('gone-cli not found')
    // 两句必须真的不同：把三态压成同一句「未就绪」也能让上面三条 contains 里的
    // 两条过（子串包含），所以这里直接比对整行里两种失败的措辞不相等。
    const lineText = (await line.innerText()).replace(/\s+/g, ' ')
    expect(
      lineText.includes('legacy-fork protocol incompatible') &&
        lineText.includes('gone-cli not found'),
      '两种失败的措辞被压成同一句 ⇒ 用户分不清该装、该改路径、还是该降级平台',
    ).toBe(true)
    await expect(page.locator('.homepage__runtime-dot--ok')).toHaveCount(1)
    await expect(page.locator('.homepage__runtime-dot--soft')).toHaveCount(2)
    await expect(
      page.locator('.homepage__runtime-dot--fault'),
      '非默认运行时的协议不兼容被画成红点 ⇒ 红点变成常态，真出事时没人再看它',
    ).toHaveCount(0)

    // 反向：同一个失败挂到**默认**运行时上，必须变红。灰色等于把「什么都跑不了」
    // 画成「有个可选组件没装」。
    incompatibleIsDefault = true
    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.getByTestId('homepage-runtime')).toBeVisible({ timeout: 30_000 })
    await expect(
      page.locator('.homepage__runtime-dot--fault'),
      '协议不兼容的**默认**运行时不是红点 ⇒ 平台此刻什么都跑不了，首页却毫无提示',
    ).toHaveCount(1)
    await expect(page.locator('.homepage__runtime-dot--soft')).toHaveCount(1)
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// CFG-39
// ---------------------------------------------------------------------------

/** 读出 /docs/api 页面里所有表格行的单元格文本（REST 表是 方法 / 路径 / 需要 / 摘要）。 */
async function docTableRows(page: Page): Promise<string[][]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.prose table tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').trim()),
    ),
  )
}

async function docTableHas(page: Page, method: string, path: string): Promise<boolean> {
  return (await docTableRows(page)).some((row) => row[0] === method && row[1] === path)
}

test('CFG-39 /docs/api 由实时注册表生成，并按调用者权限裁剪：低权账号读不到写端点清单 @nightly', async ({
  browser,
}) => {
  const guest = await createUserAndLogin({ username: 'rfc319-cfg39-guest', role: 'guest' })

  const adminDocs = await jsonOf<ApiDocsLite>(daemon.token, '/api/docs/api')
  const guestDocs = await jsonOf<ApiDocsLite>(guest.sessionToken, '/api/docs/api')

  // 「实时注册表生成」的自证：这份文档必须把**它自己**这条路由列出来。手写的
  // 文档不会想到这一条；从 allRouteMeta() 派生的必然带上它。
  for (const [label, docs] of [
    ['管理员', adminDocs],
    ['guest', guestDocs],
  ] as const) {
    expect(
      docs.endpoints,
      `${label} 的文档里没有 /api/docs/api 自己这条路由 ⇒ 它不是从实时注册表派生的，` +
        `而是某处手写的清单，会在下一次改路由时静默过期`,
    ).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/docs/api', open: true }))
    expect(
      docs.endpoints,
      `${label} 的文档里没有 /.well-known/mcp ⇒ 同上，派生链断了`,
    ).toContainEqual(expect.objectContaining({ method: 'GET', path: '/.well-known/mcp' }))
  }

  // 裁剪的核心判据：写端点。guest 一个都拿不到，管理员拿得到。
  const hasEndpoint = (docs: ApiDocsLite, method: string, path: string): boolean =>
    docs.endpoints.some((e) => e.method === method && e.path === path)
  expect(
    hasEndpoint(adminDocs, 'POST', '/api/agents'),
    '管理员的文档里都没有创建代理这条 ⇒ 下面 guest 看不到不能证明是裁剪的功劳',
  ).toBe(true)
  expect(
    hasEndpoint(guestDocs, 'POST', '/api/agents'),
    'guest 读到了写端点 ⇒ 一个只有读权限的账号拿到了完整的写面清单（路径 + 需要' +
      '哪个权限点 + 用途），那是一张现成的攻击面地图',
  ).toBe(false)
  // 正向对照（同一份文档、同一个资源）：读端点两边都在。没有它，上面那条 false
  // 可能只是 guest 的文档整个是空的。
  expect(
    hasEndpoint(guestDocs, 'GET', '/api/agents'),
    'guest 的文档连读端点都没有 ⇒ 这份文档对他毫无用处，上面的裁剪断言也证明不了什么',
  ).toBe(true)

  // 结构判据：guest 的清单里**不存在**任何需要写/执行点的条目。逐条点名挡不住
  // 「漏了另一个资源的 create」，这条能。
  const writeShaped = guestDocs.endpoints.filter((e) =>
    e.permissions.some((p) => /:(create|update|delete|execute)$/.test(p)),
  )
  expect(
    writeShaped.map((e) => `${e.method} ${e.path}`),
    'guest 的文档里出现了需要写/执行权限的端点 ⇒ 裁剪只挡住了被点名的那几条',
  ).toEqual([])
  expect(
    adminDocs.endpoints.filter((e) =>
      e.permissions.some((p) => /:(create|update|delete|execute)$/.test(p)),
    ).length,
    '管理员的文档里也没有写端点 ⇒ 上面那条空数组是恒真的',
  ).toBeGreaterThan(0)

  // 工具面同理：工具**列出来但标注不可用**（apiDocs.ts:101-107 与 markdown 的
  // notAvailableToYou）——藏起来会让读者以为平台没这个能力。
  expect(
    adminDocs.tools.find((t) => t.name === 'launch_task')?.grantable,
    '管理员也无法把 launch_task 放上令牌 ⇒ 下面 guest 的 false 证明不了裁剪',
  ).toBe(true)
  expect(
    guestDocs.tools.find((t) => t.name === 'launch_task')?.grantable,
    'guest 的文档说他能把 launch_task 放上令牌 ⇒ 他照做会得到一个永远 403 的令牌',
  ).toBe(false)
  expect(
    guestDocs.grantablePermissions,
    'guest 的权限矩阵不为空 ⇒ 文档在教他勾一些他根本拿不到的框',
  ).toEqual([])

  // 浏览器面：页面确实按同一份裁剪结果渲染（后端裁了、前端又全量渲染一遍，
  // 等于没裁）。
  const adminSide = await openAs(browser, daemon.token)
  const guestSide = await openAs(browser, guest.sessionToken)
  try {
    await adminSide.page.goto(`${daemon.baseUrl}/docs/api`)
    await expect(
      adminSide.page.getByRole('heading', { name: 'API & MCP access', exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    // The heading is static shell content; it can render before the docs query
    // has populated any rows. Wait on the registry-derived row itself.
    await expect
      .poll(() => docTableHas(adminSide.page, 'POST', '/api/agents'), {
        message: '管理员页面上没有创建代理那一行 ⇒ 页面没在渲染后端给的清单',
        timeout: 30_000,
      })
      .toBe(true)

    await guestSide.page.goto(`${daemon.baseUrl}/docs/api`)
    await expect(
      guestSide.page.getByRole('heading', { name: 'API & MCP access', exact: true }),
      'guest 的文档页整个没渲染 ⇒ 下面的「没有写端点行」是恒真断言',
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => docTableHas(guestSide.page, 'GET', '/api/agents'), {
        message: 'guest 页面上连读端点都没渲染 ⇒ 页面是空的，证明不了裁剪',
        timeout: 30_000,
      })
      .toBe(true)
    const guestRows = await docTableRows(guestSide.page)
    expect(
      guestRows.filter((r) => r[0] === 'POST' && r[1] === '/api/agents'),
      'guest 页面渲染出了写端点行 ⇒ 后端裁过、前端又发回去了',
    ).toEqual([])
    await expect(
      guestSide.page.getByText('launch_task').first(),
      'guest 页面上完全找不到 launch_task ⇒ 工具被藏了，读者会以为平台没有这个能力',
    ).toBeVisible()
    await expect(
      guestSide.page.getByText('not available to your account').first(),
      'guest 页面把用不了的工具当成能用的列出来 ⇒ 他照着配一遍才发现调不动',
    ).toBeVisible()
  } finally {
    await adminSide.context.close()
    await guestSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// CFG-34
// ---------------------------------------------------------------------------

test('CFG-34 设置 · Network 分区的文档链接落在真实的 API 文档页 @nightly', async ({ browser }) => {
  const side = await openAs(browser, daemon.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/settings?tab=network`)
    // 正向前提：分区确实渲染出来了（外部访问开关就在这张卡片里）。
    await expect(
      page.getByTestId('settings-mcp-surface'),
      'Network 分区没渲染 ⇒ 下面点链接的动作落在一张不存在的页面上',
    ).toBeVisible({ timeout: 30_000 })

    const link = page.getByTestId('settings-api-docs-link')
    await expect(
      link,
      '外部访问开关旁边没有文档入口 ⇒ 管理员打开了开关，却没有任何地方告诉他' +
        '该把什么地址交给对方',
    ).toBeVisible()
    await expect(link).toHaveAttribute('href', '/docs/api')

    await link.click()
    await page.waitForURL(/\/docs\/api$/)
    expect(new URL(page.url()).pathname).toBe('/docs/api')
    // 落地页必须是**有内容的**文档页，不是一个空壳 —— 死链和空壳在 URL 上看不出
    // 区别，只有内容能区分。
    await expect(page.getByRole('heading', { name: 'API & MCP access', exact: true })).toBeVisible()
    const rows = await docTableRows(page)
    expect(
      rows.some((r) => r[0] === 'GET' && r[1] === '/api/agents'),
      '从设置跳过来的文档页是空壳 ⇒ 链接活着，内容没有',
    ).toBe(true)
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// CFG-40 —— 放最后：它会把 publicBaseUrl 写进 config.json，而 config 补丁没有
// 「删掉某个键」的语义，写进去就撤不掉。
// ---------------------------------------------------------------------------

test('CFG-40 /.well-known/mcp：无凭据可读，endpoint 用调用者真正到得了的 origin @nightly', async () => {
  // (0) 无凭据可读 —— 一份需要鉴权才能读的发现文档，做不到它存在的唯一一件事。
  const anonymous = await wellKnown()
  expect(anonymous.version).toBe('1')
  expect(anonymous.transport).toBe('streamable-http')
  expect(
    anonymous.authentication.type,
    '发现文档没说清怎么鉴权 ⇒ 客户端只能靠猜，猜错的表现是 401，看起来像凭据错了',
  ).toBe('bearer')
  // 负向对照：同一条路径**带**一个乱七八糟的凭据也照样 200（它在鉴权域之外，
  // docs.ts:52-57）。若这里 401，说明它被卷进了 /api/* 的鉴权，发现就失效了。
  const withGarbage = await fetch(`${daemon.baseUrl}/.well-known/mcp`, {
    headers: { Authorization: 'Bearer not-a-real-token' },
  })
  expect(
    withGarbage.status,
    '带一个无效凭据就 401 ⇒ 这份文档被挪进了鉴权域，任何还没拿到令牌的人都读不到它',
  ).toBe(200)

  // (1) 直连：Host 头就是调用者到得了的地址。
  expect(
    anonymous.endpoint,
    '直连时 endpoint 与调用者正在使用的地址对不上 ⇒ 粘进客户端就连不上',
  ).toBe(`${daemon.baseUrl}/api/mcp`)
  expect(anonymous.documentation).toBe(`${daemon.baseUrl}/docs/api`)

  // (2) 反代：X-Forwarded-* 必须压过 Host / 请求 URL。这是本条最贵的失败——
  //     TLS 终结在反代上时，daemon 看到的是内网 http origin，照着它粘的人全连不上，
  //     而报错在对方那边、长得像网络故障，没人会怀疑到这份文档。
  const proxied = await wellKnown({
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'aw.example.test',
  })
  expect(
    proxied.endpoint,
    '反代头没被采纳 ⇒ 发现文档回的是 daemon 的内网地址，外面所有照做的客户端都连不上',
  ).toBe('https://aw.example.test/api/mcp')
  expect(proxied.documentation).toBe('https://aw.example.test/docs/api')

  // (3) 多级代理链取**第一跳**（最初的客户端），不是最后一跳（内网入口）。
  const chained = await wellKnown({
    'X-Forwarded-Proto': 'https, http',
    'X-Forwarded-Host': 'aw.example.test, inner.internal:8080',
  })
  expect(chained.endpoint, '代理链取了最后一跳 ⇒ 回给用户的是内网入口地址，外网照样连不上').toBe(
    'https://aw.example.test/api/mcp',
  )

  // (4) 头在但是空的，不算答案 —— 必须退回 Host，而不是拼出 `://` 这种废字符串。
  const blank = await wellKnown({ 'X-Forwarded-Proto': '  ', 'X-Forwarded-Host': '   ' })
  expect(blank.endpoint, '空的转发头被当成答案 ⇒ endpoint 变成一个语法上都不成立的地址').toBe(
    `${daemon.baseUrl}/api/mcp`,
  )

  // (5) 外部访问开关：关掉后文档必须如实说 enabled:false。一份描述着不存在的
  //     surface 的发现文档比没有文档更坏 —— 客户端每次调用都被拒，失败长得像
  //     鉴权问题，而不是「这个部署没开 MCP」。
  expect(anonymous.enabled, '默认部署的发现文档就说 MCP 关着 ⇒ 下面这条对照无意义').toBe(true)
  await patchConfig({ mcpSurfaceEnabled: false })
  try {
    const disabled = await wellKnown()
    expect(
      disabled.enabled,
      '管理员关掉了外部访问，发现文档仍然宣称 endpoint 可用 ⇒ 对方每次调用都被拒，' +
        '而且看起来像是自己的令牌有问题',
    ).toBe(false)
    expect(
      disabled.endpoint,
      '关掉开关顺手把地址也抹了 ⇒ 对方连「这个部署有 MCP、只是没开」都判断不了',
    ).toBe(`${daemon.baseUrl}/api/mcp`)
  } finally {
    await patchConfig({ mcpSurfaceEnabled: true })
  }
  expect((await wellKnown()).enabled, '开关打回来后文档没跟着回来').toBe(true)

  // (6) 配置里的 publicBaseUrl 压过一切转发头 —— 运维显式声明过的对外地址，
  //     不能被任意一个客户端发来的 X-Forwarded-Host 改写（否则任何人都能让这份
  //     公开文档回自己指定的地址）。放最后：这个键没有「删掉」的补丁语义。
  await patchConfig({ publicBaseUrl: 'https://aw.example.test/base' })
  const configured = await wellKnown({
    'X-Forwarded-Proto': 'http',
    'X-Forwarded-Host': 'attacker.example.test',
  })
  expect(
    configured.endpoint,
    '转发头压过了运维显式配置的 publicBaseUrl ⇒ 任何人都能让这份**公开**文档' +
      '把别人指到自己的地址上',
  ).toBe('https://aw.example.test/base/api/mcp')
  expect(
    configured.documentation,
    'publicBaseUrl 带子路径时文档地址丢了子路径 ⇒ 子路径部署下这条链接 404',
  ).toBe('https://aw.example.test/base/docs/api')
})
