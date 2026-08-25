// RFC-319 —— 代理的「找 / 看 / 删」这一圈用户面 e2e：列表投影 + 删除的四道拒绝闸。
//
// 覆盖能力账本 AGENT-08 / AGENT-09 / AGENT-10 / AGENT-11 / AGENT-12 / AGENT-13 /
// AGENT-40 / AGENT-X2 八行（账本里全部是 gap）。
//
// 与既有代理 e2e 的分工（**刻意不重叠**）：
//   * `e2e/agent-authoring.spec.ts` —— 只跑「建 / 改 / 存」：新建表单落库（AGENT-01）、
//     只改描述其余字段不丢（AGENT-04/23）、陈旧保存被拒（AGENT-07）、插件完整性闸（T32）。
//     它一次都没删过代理，也没碰过左栏列表。
//   * `e2e/ux-consistency.spec.ts:505-560` —— 借 `/agents` 页量响应式断点与脏点焦点，
//     用的是一个空壳 fixture 代理，从不看卡片徽章、不搜索、不删除。
//   * `e2e/rfc223-tenant-identity.spec.ts:148-166` —— 走过一次 **MCP** 的
//     More→Delete→输入名称，但那是另一类资源，代理侧四条 409 拒删闸一条都不在其中。
//   * `split-search` 这个 testid 在本文件之前的全仓 e2e 里**一次都没出现过**——
//     左栏搜索框从来没被点过。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//   * AGENT-08 —— 删除是不可逆的，而它唯一的入口是详情页 More 里那一项。这条断言
//     红掉的形态有三种，每种都是真损失：①对话框根本不弹 / 删除项不在 More 里 ⇒
//     用户删不掉自己建错的代理，只能靠改名回避；②删成功了却不回列表 ⇒ 用户停在一个
//     指向已删资源的详情页上，刷新吃 404，会以为「把系统点坏了」；③界面上卡片没了但
//     服务端还在 ⇒ 「删除」只是前端把它藏起来，下次别人还能看到它、工作流还能引用它。
//   * AGENT-13 —— 输入名称确认是误删的最后一道闸。它必须**逐字**相等：只要放宽成
//     「差不多就行」（前缀匹配 / 忽略大小写），同一批命名相近的代理（`audit-fix` 与
//     `audit-fix-2`）就会被删错一个。它还必须在**服务端**独立成立：前端跳过对话框
//     直接打接口（脚本、模型调用、PAT）不能得逞，否则这道闸只是装饰。同时确认值必须是
//     用户**真的敲进去的那串**（trim 后），不是前端手里的 `expected` 常量——后者会让
//     整道校验变成自己跟自己比。
//   * AGENT-09 —— 工作流定义引用的是**活的**编辑面：删掉被引用的代理，那个工作流的
//     节点当场悬空，下一次运行报 `agent-not-found`，而用户在删的时候完全没被告知。
//     所以不仅要拒，还要**点名**是哪几个工作流拦住了——只说「有引用」用户不知道去哪
//     收拾。反向也必须成立：解引用之后必须真的删得掉，否则「引用拒删」就成了永久锁死。
//   * AGENT-10 —— dependsOn 是运行期闭包：删掉被依赖的代理，依赖方在**下一次派发**时
//     才炸（`agent-dependency-not-found`），而那时人早就不在现场了。这道闸把失败从
//     运行期挪到删除的那一刻。
//   * AGENT-11 —— 非终态的单代理任务正拿着这个代理的 id 在跑。删掉它 = 正在跑的任务
//     失去它的定义，用户看到的是一条无法解释的失败。终态任务不拦是刻意的（快照已冻结），
//     所以任务一落终态就必须放行。
//   * AGENT-12 —— 定时任务是**无人值守**的：它引用的代理被删掉后，到点触发只会失败，
//     而没有人在盯着。删除时拦下并点名是哪条定时任务，是唯一的止损点。**停用的定时
//     任务同样要拦**——它随时可以被重新启用，那时引用早已悬空。
//   * AGENT-40 —— 左栏是用户挑代理的唯一界面。runtime chip 错 ⇒ 用户以为这个代理跑在
//     默认 runtime 上，实际被钉在另一个；端口数错 ⇒ 用户按「几进几出」接线时接错；
//     Private 徽章漏了 ⇒ 用户以为随手建的代理对全平台可见（或反过来）；归属人漏了 ⇒
//     同名代理分不清是谁的。搜索若退化成只搜标题，用户按「Aggregator」「哪个 runtime」
//     找代理会一条都搜不到；无匹配时若不给空态与「清空搜索」，用户面对空白页只能手动
//     删输入框，而清空后若不复原列表 / 不回焦，就是一次彻底的死界面。真空态与
//     无匹配空态若混成一种，新用户会在「No matches」上找不到「新建」。
//   * AGENT-X2 —— 列表读不到时若画成真空态，用户会认定「我没有代理」而去重建一个
//     ——重名撞上、或者干脆放弃。故障必须自报，且重试必须**真的重发请求**把列表拉回来，
//     而不是只摆一个按钮。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/agents.tsx:57-136           列表卡片投影（runtime / 端口数 / private / owner / builtin / aggregator）
//   packages/frontend/src/routes/agents.tsx:94-102            searchText：把卡片上可见的事实并进过滤面
//   packages/frontend/src/routes/agents.tsx:105-134           badges 各 chip 的渲染条件与顺序
//   packages/frontend/src/routes/agents.tsx:150-153           emptyList / emptyDescription / onRetry 接线
//   packages/frontend/src/components/split/ResourceSplitPage.tsx:364-368  split-count 只在 items 有值时渲染
//   packages/frontend/src/components/split/ResourceSplitPage.tsx:380-400  loading / ErrorBanner / 真空态 vs 无匹配空态
//   packages/frontend/src/components/split/ResourceSplitPage.tsx:345-348  clearSearch：清空 + 焦点还给搜索框
//   packages/frontend/src/lib/resource-card-filter.ts:15-20    title / subtitle / searchText 三面过滤
//   packages/frontend/src/components/DetailHeaderActions.tsx:120-130      More 触发键
//   packages/frontend/src/components/DetailHeaderActions.tsx:152-161      More 里的 Delete 动作项
//   packages/frontend/src/components/DetailHeaderActions.tsx:181-199      ConfirmDialog 接线（confirmName → typedConfirm）
//   packages/frontend/src/components/ConfirmDialog.tsx:82-90   trim + 精确相等；键盘提交走同一道门
//   packages/frontend/src/components/ConfirmDialog.tsx:96-108  只有 fulfilled 才关；reject 留在原地并显错
//   packages/frontend/src/components/ConfirmDialog.tsx:97-100  交给调用方的是用户的敲击，不是 expected 常量
//   packages/frontend/src/routes/agents.detail.tsx:134-156     del mutation：confirm=typedConfirm + 双 fence + 成功后回列表
//   packages/frontend/src/components/ErrorDetails.tsx:103-116  principal-aware 名单按名字渲染
//   packages/frontend/src/components/ErrorDetails.tsx:118-129  legacy 裸数组只出计数（ACL 铁律）
//   packages/frontend/src/i18n/en-US.ts:3219-3223              deleteConfirm 三条文案
//   packages/frontend/src/i18n/en-US.ts:3359-3375              agents.* 列表文案
//   packages/frontend/src/i18n/en-US.ts:7656-7669              errorDetails 名单 / 计数文案
//   packages/frontend/src/i18n/en-US.ts:7959-7973              四条拒删文案 + hint
//   packages/backend/src/routes/agents.ts:109-115              GET /api/agents：先剥 builtin，再按 ACL 过滤
//   packages/backend/src/routes/agents.ts:305-330              DELETE 顺序：404 → builtin → 授权 → confirm → fence → 业务闸
//   packages/backend/src/services/deleteConfirm.ts:44-66       delete-confirm-required / -mismatch（精确比较，不 trim）
//   packages/backend/src/services/agent.ts:665-670             agent-launching
//   packages/backend/src/services/agent.ts:685-697             agent-in-use（工作流定义引用）
//   packages/backend/src/services/agent.ts:714-723             agent-dependency-still-referenced
//   packages/backend/src/services/agent.ts:734-749             agent-tasks-active（只拦非终态）
//   packages/backend/src/services/agent.ts:762-774             agent-scheduled-referenced
//   packages/backend/src/services/agent.ts:919-936             workflowsUsingAgentIn（按 node.agentId 判定）
//   packages/backend/src/services/scheduledTaskRefs.ts:12-27   引用判定**不看** enabled
//   packages/backend/src/services/resourceAcl.ts:359-370       discloseRefsSync：{visible[], hiddenCount}
//   packages/backend/src/services/resourceAcl.ts:388-398       discloseScheduleRefs
//   packages/backend/src/services/systemResources.ts:53-60     isBuiltinRow / excludeBuiltinAgents
//   packages/shared/src/schemas/agent.ts:448-452               DeleteAgentSchema（strict：confirm + 双 fence）
//   packages/shared/src/schemas/permission.ts:955-1004         user 预设自带 agents:* / workflows:* / scheduled-tasks:*
//   packages/system-mocks/src/runtime/mode-slow.ts:62-73       STUB_OPENCODE_HOLD_FILE：把「回合还在飞」做成确定性
//
// 执行模型：全文件共用一个 daemon。stub 用 `slow` 模式并挂上
// `STUB_OPENCODE_HOLD_FILE`：只有 AGENT-11 需要「一条**确定性**停在非终态的任务」，
// 它在动手前才把 hold 文件建出来；其余用例期间该文件不存在，stub 完全不受影响。
// 每条用例各自开一个新用户做夹具——RFC-231 起所有 canonical 创建路径都是
// creator-owner + private，加上 GET /api/agents 会先剥掉 framework built-in，
// 所以「这个账号在列表里看到几条」永远只等于它自己种的那几条，不受其他用例影响。
//
// 一处**刻意的环境设置**：daemon 跑在一个预先写好 `.demo-seeded` 标记的 home 上，
// 于是 RFC-307 的样例内容（`[demo] reviewer` 等）不会被种下
// （services/demoSeed.ts:100-101 的 marker 门；标记路径见 util/paths.ts:56-58）。
// 理由不是「样例碍事」，而是它把本行要验的状态**变得不可达**：`[demo] reviewer`
// 是 `__system__` 名下的 **public** 行（demoSeed.ts:38-42、:156-158），对每个账号都可见，
// 于是任何账号的代理列表都永远不为空——AGENT-08 的「删完回到空态列表」与 AGENT-40 的
// 「真空态」就再也走不到。而「样例已经被删掉的实例」是产品明文支持的一等状态
// （demoSeed.ts:11-17 规则 1：deleted stays deleted），这里模拟的正是它。
// 顺带把「这个账号看到的恰好是它自己建的那几条」重新变成一条可断言的强事实。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

const PASSWORD = 'Rfc319AgentPass!1'

let daemon: DaemonHandle
let holdDir: string
let daemonHome: string
let holdFile: string
let sequence = 0

interface SeededUser {
  username: string
  userId: string
  token: string
}

interface AgentRow {
  id: string
  name: string
  description: string
  outputs: string[]
  inputs?: Array<{ name: string; kind?: string }>
  runtime?: string
  role?: 'normal' | 'aggregator'
  dependsOn: string[]
  ownerUserId?: string | null
  visibility?: 'public' | 'private'
  builtin?: boolean
  aclRevision?: number
  updatedAt: number
}

interface WorkflowRow {
  id: string
  name: string
  version: number
}

interface ScheduledTaskRow {
  id: string
  name: string
}

interface TaskRow {
  id: string
  status: string
}

interface RuntimeView {
  name: string
  isDefault: boolean
  enabled: boolean
}

interface RefusalBody {
  code: string
  message?: string
  details?: {
    visible?: Array<{ id: string; name: string }>
    hiddenCount?: number
    taskIds?: string[]
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function raw(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
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

async function json<T>(token: string, path: string, init: RequestInit | undefined, what: string) {
  const res = await raw(token, path, init)
  expect(res.status < 400, `${what}: HTTP ${res.status} ${res.body}`).toBe(true)
  return JSON.parse(res.body) as T
}

/** 工作流 DELETE 的 body 需要一个合法 ULID 形状的 clientMutationId
 *  （schemas/workflow.ts:461-474 的 DeleteWorkflowSchema）。 */
function newMutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = '01'
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

/** 每条用例一个专属短标签；代理名与用户名共用它但**不互相包含**——
 *  AGENT-40 要证明「按 owner 名字搜到的是 searchText 而不是标题」。 */
function nextTag(prefix: string): string {
  return `${prefix}-${++sequence}`
}

async function seedUser(tag: string): Promise<SeededUser> {
  const username = `rfc319-u-${tag}`
  const created = await json<{ id: string }>(
    daemon.token,
    '/api/users',
    {
      method: 'POST',
      // 邮箱不是可选项：RFC-320 起任务的 git 提交身份取自创建者账号，缺邮箱的账号
      // 连启动都过不去。AGENT-11 要真的起一条任务。
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: PASSWORD,
      }),
    },
    `seed user ${username}`,
  )
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  expect(login.ok, `login ${username}: HTTP ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { username, userId: created.id, token: sessionToken }
}

async function seedAgent(owner: SeededUser, body: Record<string, unknown>): Promise<AgentRow> {
  return json<AgentRow>(
    owner.token,
    '/api/agents',
    { method: 'POST', body: JSON.stringify({ outputs: ['answer'], bodyMd: '', ...body }) },
    `seed agent ${String(body.name)}`,
  )
}

async function getAgent(token: string, id: string): Promise<AgentRow> {
  return json<AgentRow>(token, `/api/agents/${id}`, undefined, `read agent ${id}`)
}

async function listAgents(token: string): Promise<AgentRow[]> {
  return json<AgentRow[]>(token, '/api/agents', undefined, 'list agents')
}

/**
 * 「像前端那样」发一次删除：confirm + 双 fence（updatedAt + aclRevision）。
 * `overrides` 用于逐项破坏其中一格，验各自的拒绝码。
 */
async function deleteAgentRequest(
  owner: SeededUser,
  agent: Pick<AgentRow, 'id' | 'name' | 'updatedAt' | 'aclRevision'>,
  overrides?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return raw(owner.token, `/api/agents/${agent.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: agent.name,
      expectedUpdatedAt: agent.updatedAt,
      expectedAclRevision: agent.aclRevision ?? 0,
      ...overrides,
    }),
  })
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

/**
 * 卡片右下角一格一格的事实 chip（`.agent-card__facts` 的直接子 span）。
 *
 * 取 `textContent` 而非 `innerText`：卡片上的 chip 带 `text-transform`，
 * innerText 会把渲染后的大小写还回来，于是断言锁的就变成了那条 CSS 而不是文案本身。
 */
async function factChips(page: Page, agentId: string): Promise<string[]> {
  return page
    .getByTestId(`split-card-${agentId}`)
    .locator('.agent-card__facts > span')
    .allTextContents()
}

/** 详情页打开删除确认框：More → Delete。 */
async function openDeleteConfirm(page: Page): Promise<void> {
  await page.getByTestId('detail-more-actions').click()
  const actions = page.getByTestId('detail-actions-dialog')
  await expect(
    actions,
    '详情页 More 打不开 ⇒ 删除 / ACL / 导出这几项用户一项都够不着',
  ).toBeVisible()
  await actions.getByTestId('detail-delete-button').click()
}

test.beforeAll(async () => {
  // hold 文件此刻**不存在** —— stub 只在文件存在时才扣住一回合
  // （mode-slow.ts:62-73），所以除 AGENT-11 外的用例完全不受影响。
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-agentdel-hold-'))
  holdFile = join(holdDir, 'hold')

  // 自带 home，并在 daemon 起来之前写下「样例已经提供过」的标记：见文件头
  // §执行模型。`home` 一旦由调用方提供，harness 就不再负责清理（keepHome），
  // 所以 afterAll 里自己删。
  daemonHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-agentdel-home-'))
  writeFileSync(join(daemonHome, '.demo-seeded'), `${String(Date.now())}\n`)

  daemon = await startDaemon({
    home: daemonHome,
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: holdFile },
  })
})

test.afterAll(async () => {
  try {
    rmSync(holdFile, { force: true })
  } catch {
    /* best-effort */
  }
  if (daemon !== undefined) await daemon.stop()
  for (const dir of [holdDir, daemonHome]) {
    try {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// AGENT-40
// ---------------------------------------------------------------------------

test('AGENT-40 代理列表：计数 / 卡片徽章逐格 / 按卡片可见事实搜索 / 无匹配空态 / 真空态 @nightly', async ({
  browser,
}) => {
  const tag = nextTag('a40')
  const owner = await seedUser(tag)
  // 代理名**不含**用户名：下面要用 owner 的显示名去搜，若名字里带着它，
  // 搜到就分不清是命中了标题还是命中了 searchText 里的归属人。
  const prefix = `rfc319-a-${tag}`

  const runtimes = await json<{ runtimes: RuntimeView[] }>(
    owner.token,
    '/api/runtimes',
    undefined,
    'list runtimes',
  )
  const defaultRuntime = runtimes.runtimes.find((r) => r.isDefault)
  const pinnable = runtimes.runtimes.find((r) => !r.isDefault && r.enabled)
  expect(
    defaultRuntime,
    '注册表里没有默认 runtime ⇒ 夹具前提就不成立（继承型代理的 chip 无从谈起）',
  ).toBeDefined()
  expect(
    pinnable,
    '注册表里没有第二个可用 runtime ⇒ 无法区分「继承默认」与「钉住某个」两种 chip',
  ).toBeDefined()
  const defaultRuntimeName = (defaultRuntime as RuntimeView).name
  const pinnedRuntimeName = (pinnable as RuntimeView).name

  const alpha = await seedAgent(owner, {
    name: `${prefix}-alpha`,
    description: 'Reads the release diff',
    outputs: ['answer', 'notes'],
    inputs: [{ name: 'topic', kind: 'string' }],
  })
  const bravo = await seedAgent(owner, {
    name: `${prefix}-bravo`,
    description: 'Writes the fix',
    outputs: ['answer'],
    runtime: pinnedRuntimeName,
  })
  const charlie = await seedAgent(owner, {
    name: `${prefix}-charlie`,
    description: 'Merges shard results',
    outputs: ['merged'],
    role: 'aggregator',
  })

  // 服务端真值：这个账号看得见的**恰好**是它自己种的三条。
  // 这一格同时锁住两件事：framework built-in（aw-skill-merger）被 excludeBuiltinAgents
  // 剥掉了，别的账号的私有代理也照 ACL 过滤掉了。任何一边漏了，下面所有计数都会错。
  const visible = await listAgents(owner.token)
  expect(
    visible.map((a) => a.name).sort(),
    '这个新账号看到的代理不等于它自己建的三条 ⇒ 要么 framework 内建行漏进了用户列表，' +
      '要么别人的私有代理对他可见',
  ).toEqual([alpha.name, bravo.name, charlie.name].sort())

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/agents`)

    const count = page.getByTestId('split-count')
    const search = page.getByTestId('split-search')
    await expect(
      count,
      '页面上的条数与服务端可见集合对不上 ⇒ 用户看到的是一份残缺（或多出别人）的清单',
    ).toHaveText('3 items', { timeout: 60_000 })

    // (1) 卡片徽章逐格。断的是**整个数组**而不是 contains：多一格（比如把别人的
    //     归属人渲染上去）和少一格（比如 Private 掉了）同样是事故。
    await expect
      .poll(() => factChips(page, alpha.id), { timeout: 30_000 })
      .toEqual([
        // 没钉 runtime 的代理必须显示「继承来的是哪个 + 这是默认」，否则用户
        // 无从知道换掉全局默认会连带把这个代理换走。
        `${defaultRuntimeName} · default`,
        // 端口数是接线前唯一的速览。数错 ⇒ 用户按错误的进出口去连边。
        '1 in · 2 out',
        // 私有徽章掉了 ⇒ 用户以为随手建的代理对全平台可见（或反过来）。
        'Private',
        // 归属人掉了 ⇒ 同名 / 近名代理分不清是谁的。
        owner.username,
      ])
    await expect
      .poll(() => factChips(page, bravo.id), { timeout: 30_000 })
      .toEqual([
        // 钉住的 runtime **不能**再带 default 后缀，否则用户会以为它随全局默认漂移。
        pinnedRuntimeName,
        '0 in · 1 out',
        'Private',
        owner.username,
      ])
    await expect(
      page.getByTestId(`split-card-${charlie.id}`).locator('.split-card__primary-status'),
      'aggregator 代理没有角色标 ⇒ 用户会把它当普通代理拖进普通节点，' +
        '直到运行时才吃 aggregator-agent-outside-fanout',
    ).toHaveText('Aggregator')
    await expect(
      page.getByTestId(`split-card-${alpha.id}`).locator('.split-card__primary-status'),
      '普通代理也被标成了角色 chip ⇒ 这个标失去区分力',
    ).toHaveCount(0)

    // (2) 按标题片段过滤（最基本的那条路径）。用完整的唯一名字，保证「只剩一条」
    //     是这条用例自己的事实。
    await search.fill(alpha.name)
    await expect(count, '按名字搜不到唯一那条 ⇒ 名字搜索这条最基本的路径断了').toHaveText('1 item')
    await expect(
      page.getByTestId(`split-card-${bravo.id}`),
      '被过滤掉的卡片仍留在 DOM 里 ⇒ 搜索只是视觉遮挡，键盘 / 读屏用户照样会走到它',
    ).toHaveCount(0)

    // (3) 按**卡片上可见、标题与描述里都没有的事实**过滤——这是过滤器与「只搜标题」
    //     的分水岭。三条：角色 chip、钉住的 runtime 名、归属人。
    await search.fill('Aggregator')
    await expect(
      count,
      '按角色 chip 的文案搜不到 aggregator 代理 ⇒ 过滤退化成只搜标题，' +
        '用户没法按「哪个是汇聚代理」来找',
    ).toHaveText('1 item')
    await expect(page.getByTestId(`split-card-${charlie.id}`)).toHaveCount(1)

    await search.fill(pinnedRuntimeName)
    await expect(
      count,
      '按 runtime 名搜不到钉在它上面的代理 ⇒ 「哪些代理跑在这个 runtime 上」这个问题在界面上无解',
    ).toHaveText('1 item')
    await expect(page.getByTestId(`split-card-${bravo.id}`)).toHaveCount(1)
    await expect(
      page.getByTestId(`split-card-${alpha.id}`),
      '继承默认 runtime 的代理也被「按 runtime 名」搜了出来 ⇒ 钉住与继承在过滤面上被混为一谈',
    ).toHaveCount(0)

    await search.fill(owner.username)
    await expect(
      count,
      '按归属人搜不到他名下的代理 ⇒ 多人实例里「这几个是谁的」只能靠一格一格看',
    ).toHaveText('3 items')

    // (4) 无匹配：必须给空态 + 一键清空，而不是一片空白。
    await search.fill('zzz-no-such-agent')
    const empty = page.getByTestId('split-empty')
    await expect(
      empty,
      '搜不到东西时页面一片空白 ⇒ 用户分不清是「没有匹配」还是「加载失败」',
    ).toBeVisible()
    await expect(empty).toContainText('No matches')
    await expect(
      empty,
      '无匹配时却说「你还没有代理」⇒ 用户会去重建一个已经存在的代理，然后撞重名',
    ).not.toContainText('No agents yet')
    await expect(
      page.getByTestId(`split-card-${alpha.id}`),
      '无匹配空态与残留卡片同时出现 ⇒ 界面自相矛盾',
    ).toHaveCount(0)

    // (5) 清空搜索：列表复原 + 焦点回到搜索框（否则用户想重新输入还得再点一次）。
    const clear = empty.getByRole('button', { name: 'Clear search', exact: true })
    await expect(clear, '无匹配空态里没有「清空搜索」⇒ 用户只能手动全选删除输入框').toHaveCount(1)
    await clear.click()
    await expect(count, '清空搜索后列表没复原 ⇒ 一次搜索就把列表弄丢了').toHaveText('3 items')
    await expect(search, '清空后输入框里还留着旧关键词 ⇒ 「清空」名不副实').toHaveValue('')
    await expect(search, '清空后焦点没还给搜索框 ⇒ 用户想重新输入还得再点一次').toBeFocused()
    for (const row of [alpha, bravo, charlie]) {
      await expect(
        page.getByTestId(`split-card-${row.id}`),
        `清空搜索后 ${row.name} 没回来 ⇒ 过滤是有副作用的，列表被永久裁剪了`,
      ).toHaveCount(1)
    }
  } finally {
    await side.context.close()
  }

  // (6) 真空态（一条代理都没有的新账号）必须与「无匹配」**长得不一样**：
  //     它要给出引导文案 + 新建入口，且**不**给「清空搜索」（没什么可清）。
  const newcomer = await seedUser(nextTag('a40e'))
  const fresh = await openAs(browser, newcomer.token)
  try {
    const { page } = fresh
    await page.goto(`${daemon.baseUrl}/agents`)
    const empty = page.getByTestId('split-empty')
    await expect(
      empty,
      '新账号打开代理页没有任何空态 ⇒ 第一屏是一片空白，用户不知道下一步该做什么',
    ).toBeVisible({ timeout: 60_000 })
    await expect(empty).toContainText('No agents yet. Create one to get started.')
    await expect(
      empty,
      '真空态少了引导说明 ⇒ 用户知道「没有」，但不知道代理是用来干什么的',
    ).toContainText('Define reusable roles, prompts, and ports for workflows and workgroups.')
    await expect(
      empty.getByRole('button', { name: 'Clear search', exact: true }),
      '真空态也挂着「清空搜索」⇒ 用户点了什么都不会发生，以为界面坏了',
    ).toHaveCount(0)
    await expect(
      page.getByTestId('split-count'),
      '真空态没有计数 ⇒ 分不清「确实是 0 条」与「压根没读到」（AGENT-X2 的那一格正相反）',
    ).toHaveText('0 items')
    await expect(
      page.getByTestId('split-new-button'),
      '空列表上找不到新建入口 ⇒ 新用户第一屏就是死路',
    ).toBeVisible()
  } finally {
    await fresh.context.close()
  }
})

// ---------------------------------------------------------------------------
// AGENT-X2
// ---------------------------------------------------------------------------

test('AGENT-X2 代理列表读不到时自报故障并可重试，绝不画成「你还没有代理」 @nightly', async ({
  browser,
}) => {
  const tag = nextTag('ax2')
  const owner = await seedUser(tag)
  const prefix = `rfc319-a-${tag}`
  const one = await seedAgent(owner, { name: `${prefix}-one`, description: 'first' })
  const two = await seedAgent(owner, { name: `${prefix}-two`, description: 'second' })

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side

    // 只拦**集合**那一条；详情 / resource-status / 用户名批查都必须原样放行，
    // 否则红掉时分不清是列表故障态坏了还是别的请求被误伤。
    let failing = true
    await page.route(
      (url) => url.pathname === '/api/agents',
      async (route) => {
        if (!failing) {
          await route.fallback()
          return
        }
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'internal-error', message: 'injected list failure' }),
        })
      },
    )

    await page.goto(`${daemon.baseUrl}/agents`)

    const cards = page.getByTestId('split-cards')
    const banner = cards.getByRole('alert')
    await expect(
      banner,
      '列表读失败却没有任何提示 ⇒ 用户面对空列表，会认定「我没有代理」',
    ).toBeVisible({ timeout: 60_000 })
    await expect(banner, '故障横幅不说是什么故障 ⇒ 用户既不知道该重试还是该找管理员').toContainText(
      'Internal server error.',
    )
    await expect(
      page.getByTestId('split-empty'),
      '读不到被画成了空态 ⇒ 用户会去重建一个已经存在的代理，然后撞重名；这是本行最贵的一种红',
    ).toHaveCount(0)
    await expect(
      page.getByTestId('split-count'),
      '读不到却还报了个条数 ⇒ 那个数字是凭空的，用户会当真',
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`split-card-${one.id}`),
      '故障态下还渲染出卡片 ⇒ 显示的是过期缓存却没有任何标记',
    ).toHaveCount(0)

    // 重试必须**真的重发请求**并把列表拉回来——只摆一个按钮等于没有恢复路径。
    failing = false
    await cards.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      page.getByTestId('split-count'),
      '点了重试列表没回来 ⇒ 这个按钮是装饰，用户只能刷新整页（还未必知道可以）',
    ).toHaveText('2 items', { timeout: 30_000 })
    await expect(page.getByTestId(`split-card-${one.id}`)).toHaveCount(1)
    await expect(page.getByTestId(`split-card-${two.id}`)).toHaveCount(1)
    await expect(
      cards.getByRole('alert'),
      '恢复之后故障横幅还挂着 ⇒ 用户不敢相信眼前这份列表是新的',
    ).toHaveCount(0)
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// AGENT-08 / AGENT-13
// ---------------------------------------------------------------------------

test('AGENT-08 / AGENT-13 删除代理：确认名逐字对上才放行，删完 204 并回到空态列表 @nightly', async ({
  browser,
}) => {
  const tag = nextTag('a08')
  const owner = await seedUser(tag)
  const victim = await seedAgent(owner, {
    name: `rfc319-a-${tag}-victim`,
    description: 'deleted through the UI',
  })

  // ---- (A) 服务端自己就得挡住「跳过对话框直接打接口」---------------------
  const noConfirm = await deleteAgentRequest(owner, victim, { confirm: undefined })
  expect(
    noConfirm.status,
    '不带 confirm 也能删 ⇒ 输入名称确认只是前端装饰，任何脚本 / 模型调用都能直接删掉代理',
  ).toBe(422)
  expect((JSON.parse(noConfirm.body) as RefusalBody).code).toBe('delete-confirm-required')

  // 名字**差一个字符**就必须整笔拒绝：放宽成前缀 / 忽略大小写，
  // 命名相近的一批代理（audit-fix 与 audit-fix-2）迟早会被删错一个。
  const typo = await deleteAgentRequest(owner, victim, { confirm: `${victim.name}-2` })
  expect(typo.status, '名字只是「差不多」就放行 ⇒ 用户很容易删掉同名前缀的另一个代理').toBe(422)
  expect((JSON.parse(typo.body) as RefusalBody).code).toBe('delete-confirm-mismatch')

  // 截断成前缀：这是「逐字确认」最容易被松开的方向——把 `!==` 写成 `startsWith`
  // 之类的宽松比较，超串（上面那条 `-2`）照旧被拦，**少打几个字反而放行**。
  const truncated = await deleteAgentRequest(owner, victim, {
    confirm: victim.name.slice(0, -3),
  })
  expect(
    truncated.status,
    '名字打了一半就放行 ⇒ 「逐字确认」这道闸对最常见的手滑（少打几个字直接回车）完全不设防',
  ).toBe(422)
  expect((JSON.parse(truncated.body) as RefusalBody).code).toBe('delete-confirm-mismatch')

  const casing = await deleteAgentRequest(owner, victim, { confirm: victim.name.toUpperCase() })
  expect(casing.status, '大小写不同也放行 ⇒ 「逐字确认」名不副实').toBe(422)
  expect((JSON.parse(casing.body) as RefusalBody).code).toBe('delete-confirm-mismatch')

  // 确认闸必须排在 fence 校验**之前**（routes/agents.ts:312-321 的注释就是这条）：
  // 名字错 + 版本也错时，用户该看到的是「名字不对」，而不是一个他无从下手的版本冲突。
  const bothWrong = await deleteAgentRequest(owner, victim, {
    confirm: `${victim.name}-2`,
    expectedUpdatedAt: victim.updatedAt + 1,
  })
  expect(bothWrong.status, '名字错 + 版本错时报的不是 422 ⇒ 两道闸的先后顺序变了').toBe(422)
  expect(
    (JSON.parse(bothWrong.body) as RefusalBody).code,
    '名字打错却报成版本冲突 ⇒ 用户会去刷新页面重试，而真正的问题是他名字敲错了',
  ).toBe('delete-confirm-mismatch')

  expect(
    (await raw(owner.token, `/api/agents/${victim.id}`)).status,
    '四次被拒的删除里有一次真的删掉了 ⇒ 拒绝路径与删除路径并不共用同一道闸',
  ).toBe(200)

  // ---- (B) 浏览器面：对话框只认逐字相同的名字，回车也不能绕过 -----------
  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/agents/${victim.id}`)
    await expect(
      page.getByRole('heading', { name: victim.name }),
      '详情页没加载出这个代理 ⇒ 后面所有删除断言都会变成空洞绿',
    ).toBeVisible({ timeout: 60_000 })

    // 这一页**总共**往删除端点发了几笔、每笔带的 confirm 是什么，全部记下来：
    // 「回车没有绕过闸」这件事只有「一笔请求都没发出去」才算真的成立，
    // 靠「对话框还开着 + 服务端还在」是判不出来的（服务端本来就会拒）。
    const deleteAttempts: string[] = []
    page.on('request', (req) => {
      if (req.method() !== 'DELETE') return
      if (new URL(req.url()).pathname !== `/api/agents/${victim.id}`) return
      deleteAttempts.push(String((req.postDataJSON() as { confirm?: unknown }).confirm ?? ''))
    })

    await openDeleteConfirm(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog, '删除没有二次确认 ⇒ 动作面板上误点一下代理就没了').toBeVisible()
    await expect(
      dialog,
      '确认框不说要删的是哪一个 ⇒ 用户在多标签页之间切换后会删错对象',
    ).toContainText(`Delete ${victim.name}?`)

    const confirmInput = page.getByTestId('confirm-input')
    const confirmButton = dialog.getByRole('button', { name: 'Delete', exact: true })
    await expect(
      confirmButton,
      '还没输入任何名字，删除键就是可点的 ⇒ 输入名称确认形同虚设',
    ).toBeDisabled()

    await confirmInput.fill(`${victim.name}-2`)
    await expect(
      confirmButton,
      '名字只是「差不多」按钮就亮了 ⇒ 用户会在没意识到的情况下删掉另一个代理',
    ).toBeDisabled()

    // 键盘提交必须走**同一道门**（ConfirmDialog.tsx:164-166 的 Enter 分支）：
    // 只把按钮置灰而放行回车，等于给最容易误触的那条路开了后门。
    await confirmInput.press('Enter')
    await expect(
      dialog,
      '名字没对上时按回车把对话框关掉了 ⇒ 要么删了，要么用户以为删了',
    ).toBeVisible()
    expect(
      (await raw(owner.token, `/api/agents/${victim.id}`)).status,
      '名字没对上时按回车真的把代理删了 ⇒ 键盘路径绕过了确认闸',
    ).toBe(200)

    // 逐字输对（带首尾空格——复制粘贴常见形态）：对话框 trim 后放行，
    // 发给服务端的必须是 **trim 过的用户敲击**，不是前端手里的 expected 常量，
    // 也不是没 trim 的原文（服务端是精确比较，带空格会当场 422）。
    await confirmInput.fill(`  ${victim.name}  `)
    await expect(
      confirmButton,
      '名字前后多了空格就不给删 ⇒ 从别处复制名字粘贴进来的用户永远删不掉这个代理',
    ).toBeEnabled()

    const deleteResponse = page.waitForResponse(
      (res) =>
        res.request().method() === 'DELETE' &&
        new URL(res.url()).pathname === `/api/agents/${victim.id}`,
    )
    await confirmButton.click()
    expect((await deleteResponse).status(), '逐字输对了服务端还是不放行 ⇒ 这个代理永远删不掉').toBe(
      204,
    )
    // 整页只发出过**一笔**删除，且它带的正是 trim 后的用户敲击。这条断言抓两类回归：
    //   * 多出一笔 ⇒ 上面那次名字不匹配的回车把请求打出去了，前端那道门没关；
    //   * confirm 带着空格 ⇒ 没 trim 就发，服务端是精确比较（deleteConfirm.ts:57-64），
    //     从别处复制名字粘贴进来的用户会永远删不掉这个代理。
    // 说清楚这条**抓不到**什么，免得后人以为它管得更宽：「前端把 expected 常量回填成
    // confirm」在这个接缝上不可观测——按钮只在 typed === expected 时才亮，两者此刻
    // 逐字相同，发哪一个在线上都是同一串字节。那一格由前端单测锁
    //（ConfirmDialog.tsx:97-100 的注释即此意），不是这里。
    expect(
      deleteAttempts,
      '删除端点收到的请求笔数 / confirm 内容不对 ⇒ 键盘旁路，或没 trim 就发，' +
        '两种都让「输入名称确认」这道闸失去意义',
    ).toEqual([victim.name])

    // ---- (C) 用户可见后果：回到列表，且列表回到真空态 --------------------
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe('/agents')
    await expect(
      page.getByTestId(`split-card-${victim.id}`),
      '删完之后卡片还留在列表里 ⇒ 用户会以为没删掉而再点一次',
    ).toHaveCount(0)
    await expect(
      page.getByTestId('split-empty'),
      '删掉最后一条之后没有回到空态 ⇒ 用户停在一个既没有卡片也没有引导的空白左栏上',
    ).toContainText('No agents yet. Create one to get started.')

    // 服务端真值对账：界面消失 ≠ 真的删了。
    expect(
      (await raw(owner.token, `/api/agents/${victim.id}`)).status,
      '界面上消失了但服务端还在 ⇒ 「删除」只是前端把它藏起来了',
    ).toBe(404)
    expect(
      (await listAgents(owner.token)).map((a) => a.name),
      '删完之后集合里还留着它 ⇒ 它照样会出现在别人的选择器 / 工作流引用里',
    ).toEqual([])
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// AGENT-09
// ---------------------------------------------------------------------------

test('AGENT-09 删除被工作流引用的代理：409 agent-in-use 并点名引用它的工作流；解引用后可删 @nightly', async ({
  browser,
}) => {
  const tag = nextTag('a09')
  const owner = await seedUser(tag)
  const prefix = `rfc319-a-${tag}`
  const victim = await seedAgent(owner, {
    name: `${prefix}-victim`,
    description: 'referenced by a workflow',
  })
  // 负向对照：同一账号下另一条**没有任何引用**的代理，最后必须删得掉——
  // 否则「拒删」可能只是「谁都删不掉」的假象。
  const loner = await seedAgent(owner, {
    name: `${prefix}-loner`,
    description: 'referenced by none',
  })

  const workflow = await json<WorkflowRow>(
    owner.token,
    '/api/workflows',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-flow`,
        description: 'RFC-319 agent-in-use fixture',
        definition: {
          $schema_version: 4,
          inputs: [],
          nodes: [
            {
              id: 'agent_main',
              kind: 'agent-single',
              agentId: victim.id,
              agentName: victim.name,
              promptTemplate: 'Do the thing.',
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
        },
      }),
    },
    'seed referencing workflow',
  )

  const refused = await deleteAgentRequest(owner, victim)
  expect(
    refused.status,
    '被工作流引用的代理也能删 ⇒ 那个工作流的节点当场悬空，下一次运行才炸，' +
      '而删的时候没有任何人被告知',
  ).toBe(409)
  const body = JSON.parse(refused.body) as RefusalBody
  expect(body.code).toBe('agent-in-use')
  expect(
    body.details?.visible?.map((v) => v.name),
    '拒绝信息不说是哪个工作流拦住的 ⇒ 用户知道「有引用」却不知道去哪里改，这道闸就成了死胡同',
  ).toEqual([workflow.name])
  expect(
    body.details?.hiddenCount,
    '把看不见的引用也算成 0 ⇒ 用户按名单改完仍然删不掉，且完全不知道为什么',
  ).toBe(0)
  expect(
    (await raw(owner.token, `/api/agents/${victim.id}`)).status,
    '被拒的删除还是把代理删了 ⇒ 引用检查跑在删除之后',
  ).toBe(200)

  // 用户可见后果：对话框里就要看到「谁拦住了我」，而不是一句笼统的失败。
  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/agents/${victim.id}`)
    await expect(page.getByRole('heading', { name: victim.name })).toBeVisible({ timeout: 60_000 })
    await openDeleteConfirm(page)
    const dialog = page.getByRole('dialog')
    await page.getByTestId('confirm-input').fill(victim.name)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(
      dialog,
      '拒删之后对话框自己关了 ⇒ 用户看不到失败原因，只看到「什么都没发生」',
    ).toBeVisible()
    await expect(
      dialog,
      '界面上不说是「工作流还在引用」⇒ 用户只能看到一个红条，不知道该去改什么',
    ).toContainText('Workflows still reference this agent; it cannot be deleted.')
    await expect(
      dialog,
      '下一步提示掉了 ⇒ 用户知道被拦，但要自己猜「先在工作流里换掉它」',
    ).toContainText('Swap it out of the referencing workflows first.')
    await expect(
      dialog,
      '拒绝信息里不点名那个工作流 ⇒ 一个装了几十个工作流的实例上，用户得一个个翻',
    ).toContainText(`Referenced by: ${workflow.name}.`)
    expect(new URL(page.url()).pathname, '拒删之后却离开了详情页 ⇒ 用户以为删成功了').toBe(
      `/agents/${victim.id}`,
    )
  } finally {
    await side.context.close()
  }

  // 负向对照 1：没有任何引用的代理确实删得掉（证明上面拦住的是引用，不是删除本身坏了）。
  const lonerGone = await deleteAgentRequest(owner, loner)
  expect(
    lonerGone.status,
    '没有任何引用的代理也删不掉 ⇒ 上面那条 409 根本不是「引用拒删」，而是删除整个坏了',
  ).toBe(204)

  // 负向对照 2：把引用拿掉之后，同一笔删除必须放行——否则「引用拒删」等于永久锁死。
  const wfGone = await raw(owner.token, `/api/workflows/${workflow.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: workflow.name,
      expectedVersion: workflow.version,
      clientMutationId: newMutationId(),
    }),
  })
  expect(wfGone.status, `删除夹具工作流失败：${wfGone.body}`).toBe(204)
  const allowed = await deleteAgentRequest(owner, await getAgent(owner.token, victim.id))
  expect(allowed.status, '引用已经不在了还是删不掉 ⇒ 这个代理被永久锁死，用户再也清理不掉它').toBe(
    204,
  )
})

// ---------------------------------------------------------------------------
// AGENT-10
// ---------------------------------------------------------------------------

test('AGENT-10 删除被其它代理 dependsOn 引用的代理：409 agent-dependency-still-referenced；解依赖后可删 @nightly', async ({
  browser,
}) => {
  const tag = nextTag('a10')
  const owner = await seedUser(tag)
  const prefix = `rfc319-a-${tag}`
  const base = await seedAgent(owner, { name: `${prefix}-base`, description: 'depended upon' })
  const dependent = await seedAgent(owner, {
    name: `${prefix}-dependent`,
    description: 'declares the dependency',
    dependsOn: [base.id],
  })
  expect(
    (await getAgent(owner.token, dependent.id)).dependsOn,
    '依赖没有落库 ⇒ 下面的「拒删」会变成空洞绿（拦住的其实是别的东西）',
  ).toEqual([base.id])

  const refused = await deleteAgentRequest(owner, base)
  expect(
    refused.status,
    '被别的代理依赖的代理也能删 ⇒ 依赖方在下一次派发时才炸 agent-dependency-not-found，' +
      '那时删它的人早已不在现场',
  ).toBe(409)
  const body = JSON.parse(refused.body) as RefusalBody
  expect(body.code).toBe('agent-dependency-still-referenced')
  expect(
    body.details?.visible?.map((v) => v.name),
    '不说是哪个代理还依赖着它 ⇒ 用户无从下手解依赖',
  ).toEqual([dependent.name])
  expect(
    (await raw(owner.token, `/api/agents/${base.id}`)).status,
    '被拒的删除还是把代理删了 ⇒ 反向依赖检查跑在删除之后',
  ).toBe(200)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/agents/${base.id}`)
    await expect(page.getByRole('heading', { name: base.name })).toBeVisible({ timeout: 60_000 })
    await openDeleteConfirm(page)
    const dialog = page.getByRole('dialog')
    await page.getByTestId('confirm-input').fill(base.name)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      dialog,
      '界面上不说是「别的代理还依赖它」⇒ 用户会去翻工作流，翻不到，然后放弃',
    ).toContainText('Other agents still depend on this agent; it cannot be deleted.')
    await expect(dialog, '下一步提示掉了 ⇒ 用户不知道要去依赖方那边把它摘掉').toContainText(
      'Remove it from the depending agents first.',
    )
    await expect(dialog, '拒绝信息里不点名依赖方 ⇒ 依赖多起来以后只能一个个试').toContainText(
      `Referenced by: ${dependent.name}.`,
    )
  } finally {
    await side.context.close()
  }

  // 负向对照：把依赖摘掉之后必须放行。
  const current = await getAgent(owner.token, dependent.id)
  const cleared = await raw(owner.token, `/api/agents/${dependent.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      dependsOn: [],
      expectedUpdatedAt: current.updatedAt,
      expectedAclRevision: current.aclRevision ?? 0,
    }),
  })
  expect(cleared.status, `摘依赖失败：${cleared.body}`).toBe(200)
  const allowed = await deleteAgentRequest(owner, await getAgent(owner.token, base.id))
  expect(allowed.status, '依赖已经摘掉了还是删不掉 ⇒ 「反向依赖拒删」变成永久锁死').toBe(204)
})

// ---------------------------------------------------------------------------
// AGENT-11
// ---------------------------------------------------------------------------

test('AGENT-11 删除还有非终态单代理任务的代理：409 agent-tasks-active；任务落终态后可删 @nightly', async ({
  browser,
}) => {
  // 这条用例要真的起一个任务并把它扣在运行中，比其余用例慢得多。
  test.setTimeout(180_000)

  const tag = nextTag('a11')
  const owner = await seedUser(tag)
  const prefix = `rfc319-a-${tag}`
  const victim = await seedAgent(owner, {
    name: `${prefix}-busy`,
    description: 'has a live single-agent task',
  })

  // 先把一条任务**确定性**地扣在非终态：stub 起来后先落 `<hold>.started`
  // 再进等待循环（mode-slow.ts:62-73），看到它就说明这一回合确实在飞，不靠 sleep 猜时序。
  writeFileSync(holdFile, '')
  const task = await json<TaskRow>(
    owner.token,
    `/api/agents/${victim.id}/tasks`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-live-task`,
        description: 'Hold this turn open so the delete refusal is deterministic.',
        scratch: true,
        allowClarify: false,
      }),
    },
    'launch single-agent task',
  )
  await expect
    .poll(() => existsSync(`${holdFile}.started`), {
      timeout: 120_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true)
  const live = await json<TaskRow>(
    owner.token,
    `/api/tasks/${task.id}`,
    undefined,
    'read live task',
  )
  expect(
    ['pending', 'running'],
    `任务没有停在非终态（实际 ${live.status}）⇒ 下面的「拒删」断言会变成空洞绿`,
  ).toContain(live.status)

  const refused = await deleteAgentRequest(owner, victim)
  expect(
    refused.status,
    '正在跑任务的代理也能删 ⇒ 运行中的任务当场失去它的定义，用户看到的是一条无法解释的失败',
  ).toBe(409)
  const body = JSON.parse(refused.body) as RefusalBody
  expect(body.code).toBe('agent-tasks-active')
  expect(
    body.details?.taskIds,
    '拒绝信息里不带那条任务的 id ⇒ 用户不知道该去取消哪一条才能删',
  ).toEqual([task.id])
  expect(
    (await raw(owner.token, `/api/agents/${victim.id}`)).status,
    '被拒的删除还是把代理删了 ⇒ 非终态任务检查跑在删除之后',
  ).toBe(200)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/agents/${victim.id}`)
    await expect(page.getByRole('heading', { name: victim.name })).toBeVisible({ timeout: 60_000 })
    await openDeleteConfirm(page)
    const dialog = page.getByRole('dialog')
    await page.getByTestId('confirm-input').fill(victim.name)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      dialog,
      '界面上不说是「还有任务在跑」⇒ 用户会以为是权限或系统故障，跑去问管理员',
    ).toContainText('This agent still has non-terminal tasks; cancel or wait before deleting.')
    // taskIds 是**未经可见性过滤**的裸数组，按 ACL 铁律只能出计数、不能出名字/id
    // （ErrorDetails.tsx:118-129）。这一格若变成点名，等于把别人的任务标识泄漏进错误提示。
    await expect(
      dialog,
      '把裸任务 id 数组渲染成了名单 ⇒ 越过了 ACL 铁律，错误提示成了枚举他人任务的信道',
    ).toContainText('1 reference(s) exist; remove them first.')
    await expect(
      dialog,
      '错误提示里出现了任务 id ⇒ 同上，未经可见性过滤的标识不该出现在界面上',
    ).not.toContainText(task.id)
  } finally {
    await side.context.close()
  }

  // 负向对照：任务落终态后同一笔删除必须放行——终态任务的快照已冻结，
  // 继续拦着就是把代理永久锁死（services/agent.ts:724-726 的注释即此意）。
  await json(owner.token, `/api/tasks/${task.id}/cancel`, { method: 'POST' }, 'cancel live task')
  rmSync(holdFile, { force: true })
  await expect
    .poll(
      async () => {
        const row = await json<TaskRow>(
          owner.token,
          `/api/tasks/${task.id}`,
          undefined,
          'poll task',
        )
        return row.status
      },
      { timeout: 90_000, intervals: [250, 500, 1000] },
    )
    .toMatch(/^(done|failed|canceled|interrupted)$/)

  const allowed = await deleteAgentRequest(owner, await getAgent(owner.token, victim.id))
  expect(
    allowed.status,
    '任务已经终态了还是删不掉 ⇒ 「非终态任务拒删」变成永久锁死，这个代理再也删不了',
  ).toBe(204)
})

// ---------------------------------------------------------------------------
// AGENT-12
// ---------------------------------------------------------------------------

test('AGENT-12 删除被定时任务引用的代理：409 agent-scheduled-referenced；删掉定时任务后可删 @nightly', async ({
  browser,
}) => {
  const tag = nextTag('a12')
  const owner = await seedUser(tag)
  const prefix = `rfc319-a-${tag}`
  const victim = await seedAgent(owner, {
    name: `${prefix}-scheduled`,
    description: 'targeted by a scheduled task',
  })

  // 刻意用**停用**的定时任务：①它绝不会在用例期间自己触发，从而把「拒删」
  // 与 AGENT-11 的非终态任务闸彻底隔开（两条闸在同一段事务里，触发了就会串味）；
  // ②它同时锁住一条更强的语义——引用判定不看 enabled
  // （scheduledTaskRefs.ts:12-27）。停用只是「现在不跑」，随时可以重新启用，
  // 那时引用早已悬空。
  const schedule = await json<ScheduledTaskRow>(
    owner.token,
    '/api/scheduled-tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-nightly`,
        launchKind: 'agent',
        enabled: false,
        scheduleSpec: { kind: 'monthly', dayOfMonth: 28, at: '03:00', timezone: 'UTC' },
        launchPayload: {
          agentId: victim.id,
          name: `${prefix}-nightly-run`,
          description: 'RFC-319 agent-scheduled-referenced fixture',
          scratch: true,
          allowClarify: false,
        },
      }),
    },
    'seed scheduled task',
  )

  const refused = await deleteAgentRequest(owner, victim)
  expect(
    refused.status,
    '被定时任务引用的代理也能删 ⇒ 到点触发只会失败，而定时任务是无人值守的，' +
      '没有人会看到那次失败',
  ).toBe(409)
  const body = JSON.parse(refused.body) as RefusalBody
  expect(body.code).toBe('agent-scheduled-referenced')
  expect(
    body.details?.visible?.map((v) => v.name),
    '不说是哪条定时任务在引用 ⇒ 用户要在定时列表里一条条翻 payload 才能找到',
  ).toEqual([schedule.name])

  expect(
    (await raw(owner.token, `/api/agents/${victim.id}`)).status,
    '被拒的删除还是把代理删了 ⇒ 定时引用检查跑在删除之后',
  ).toBe(200)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/agents/${victim.id}`)
    await expect(page.getByRole('heading', { name: victim.name })).toBeVisible({ timeout: 60_000 })
    await openDeleteConfirm(page)
    const dialog = page.getByRole('dialog')
    await page.getByTestId('confirm-input').fill(victim.name)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      dialog,
      '界面上不说是「定时任务还指着它」⇒ 用户翻遍工作流也找不到原因',
    ).toContainText('Scheduled tasks still target this agent; delete or repoint them first.')
    await expect(dialog, '拒绝信息里不点名那条定时任务 ⇒ 用户无从下手').toContainText(
      `Referenced by: ${schedule.name}.`,
    )
  } finally {
    await side.context.close()
  }

  // 负向对照：定时任务删掉之后必须放行。
  const scheduleGone = await raw(owner.token, `/api/scheduled-tasks/${schedule.id}`, {
    method: 'DELETE',
  })
  expect(scheduleGone.status, `删除夹具定时任务失败：${scheduleGone.body}`).toBe(204)
  const allowed = await deleteAgentRequest(owner, await getAgent(owner.token, victim.id))
  expect(allowed.status, '定时任务已经删掉了还是删不掉代理 ⇒ 「定时引用拒删」变成永久锁死').toBe(
    204,
  )
})
