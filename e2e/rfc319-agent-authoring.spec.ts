// RFC-319 —— 代理编辑面**剩下的那一半**：建之前被拦住的路、编辑页的几个自愈面、
// 归属转让，以及三个从来没被任何测试碰过的控件（执行契约选择器 / Markdown 预览 /
// 不可用引用的置灰选项）。
//
// 覆盖能力账本 AGENT-02 / 03 / 06 / 21 / 22 / 33 / 41 / 42 / X3 / X4 十行。
// 全部是 P2 / P3，所以每条 test 标题末尾都带 ` @nightly`——PR 腿只跑不带这个 tag 的
// （`.github/workflows/e2e-full-nightly.yml:4-5`），这十条只在夜跑里执行。
//
// ## 与既有代理 e2e 的分工（刻意不重叠）
//
//   * `e2e/agent-authoring.spec.ts` —— 建成功 / 只改描述不丢字段 / 陈旧保存 409 /
//     引用的插件被停用后的完整性告警（AGENT-01 / 04 / 07 / 23 / 35 / T32）。它走的
//     全是**成功**路径与**保存**路径；「名字不合法」「名字撞车」「离开时还有草稿」
//     这三种**建不成**的路一条都没走过。
//   * `e2e/rfc319-agent-ports.spec.ts` —— 端口编辑器落库（AGENT-14～20 / X5）。它从不
//     碰执行契约选择器：`agent-execution-contracts` 这个 testid 在本文件之前的全仓
//     e2e 里一次都没出现过，受管端口只有组件测（packages/frontend/tests/
//     rfc310-digital-employee-ui-contract.test.ts:311-345）而没有任何浏览器覆盖。
//   * `e2e/rfc319-agent-delete-and-refs.spec.ts` —— 列表投影与四道拒删闸。它不改
//     表单、不转让归属。
//   * `e2e/rfc099-ownership-acl.spec.ts:201-219` —— 转让弹窗只做 **NESTED dialog
//     smoke**：填完名字按两下 Escape 收尾，`acl-transfer-confirm` **一次都没被点过**。
//     也就是说「转让真的发生了什么」在全仓零覆盖：新主是否拿到治理权、前任是被踢光
//     还是降级，全靠读代码猜。本文件把这一步走完。
//   * `e2e/rfc324-graded-grants.spec.ts:90` —— 授权档位的**实时**升降档（不刷新页面）。
//     本文件的 AGENT-33 只锁「转让这件事本身落库后的结果」，刷新之后再断，两者不重叠。
//   * `e2e/ux-consistency.spec.ts:541-568` —— 未保存守卫的三个 testid 走过一遍，但那是
//     在**详情页**上，且只有一个空壳 fixture 代理。`/agents/new` 上的守卫（AGENT-41）
//     与「切卡片时草稿不许串台」（AGENT-42）都不在其中。
//
// ## 每条断言红掉时用户遭遇什么（详细理由写在各用例内联）
//
//   * AGENT-02 —— 非法名字必须被拦下并**说清楚哪里不合法**。只弹一句「失败」用户
//     只能一个字一个字试；而如果压根没拦住，服务端 422 之后前端若不呈现，用户会以为
//     代理建好了，回到列表却找不到它。
//   * AGENT-03 —— 重名冲突若不可读，用户会反复点「创建」，每次都以为是网络抖动。
//   * AGENT-06 —— 注册表读不到时若让选择器保持可点，用户会在一份**空的**候选里选，
//     选完保存就把代理的 runtime 钉成了不存在的值；若把已钉住的值也擦掉，用户会以为
//     自己的代理从来没钉过 runtime。
//   * AGENT-21 —— 执行契约与它的受管输出端口是**一个值**。选了契约却不物化端口 ⇒
//     平台按契约投递结果时找不到出口；取消契约却留下端口和 kind sidecar ⇒ 库里多一个
//     谁也删不掉的「受管」端口（受管端口卡片没有删除键），用户被永久卡住。
//   * AGENT-22 —— 非法 JSON 若不挡住创建，半截 JSON 会被当成 `{}` 静默吞掉，用户的
//     permission 配置消失得无声无息；「去修复」若不真的把焦点落到那个 textarea 上，
//     用户在五个页签之间找不到是哪个字段坏了。
//   * AGENT-33 —— 转让是**不可逆**的治理动作。新主拿不到治理权 ⇒ 转让等于把资源锁死；
//     前任若被彻底踢光 ⇒ 他连自己刚交出去的东西都看不见了（产品规则是降级为只读，
//     packages/backend/src/services/resourceAcl.ts:887）。
//   * AGENT-41 —— 守卫不弹 ⇒ 用户点错一下卡片，刚填的整张表单无声消失。
//   * AGENT-42 —— 详情面板不重挂载 ⇒ 用户在 A 上改了描述、切到 B，看到的是 **A 的
//     草稿**；此时按保存就把 A 的内容写进了 B。这是 agents.detail.tsx:4-8 记下的
//     真实事故（T-D11）。
//   * AGENT-X3 —— Prompt 正文是代理的全部行为来源。预览不跟随 ⇒ 用户写 Markdown 像
//     在黑盒里打字；正文往返不逐字节相等 ⇒ 保存一次提示词就被悄悄改写。
//   * AGENT-X4 —— 引用的技能失效后，选择器若把它当成一个普通可选项，用户「修复」的
//     动作就是把坏引用**原样挂回去**，然后保存被 422 挡住，且没有任何提示说明为什么。
//
// ## 判据锚点（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check 逐条
// ## 请求，见 CLAUDE.md §opencode 源码自取规则）
//
//   packages/frontend/src/routes/agents.new.tsx:185-192   创建键的禁用条件（只含空名 + JSON/端口校验）
//   packages/frontend/src/routes/agents.new.tsx:270-288   AgentJsonValidationSummary 与 create.error 的挂点
//   packages/frontend/src/components/AgentForm.tsx:528    name 上的 HTML5 pattern（不是提交闸）
//   packages/shared/src/schemas/agent.ts:112-118          AGENT_NAME_RE 与它的 422 文案
//   packages/frontend/src/components/AgentForm.tsx:433-441 registry 不可用 ⇒ 冻结 Select
//   packages/frontend/src/components/AgentForm.tsx:558-573 runtime 错误条 + onRetry
//   packages/frontend/src/components/AgentForm.tsx:289-320 withAgentExecutionContractsAndPorts：契约 ⇒ 端口 + sidecar
//   packages/frontend/src/components/AgentForm.tsx:592-607 ExecutionContractPicker 的 onChange 接线
//   packages/frontend/src/components/execution-contracts/ExecutionContractPicker.tsx:33-66  选择器选项来源
//   packages/frontend/src/components/agent-ports/AgentPortCard.tsx:117-150  受管端口：只有说明，没有 Edit/Delete
//   packages/frontend/src/components/AgentForm.tsx:366-378 focusJsonField ⇒ useLayoutEffect 真聚焦
//   packages/frontend/src/components/AgentForm.tsx:876-920 AgentJsonValidationSummary 的 role=alert 与跳转键
//   packages/frontend/src/components/JsonField.tsx:48-69   raw / parsed / error 三态
//   packages/frontend/src/components/AclPanel.tsx:640-680  转让弹窗与 acl-transfer-confirm
//   packages/backend/src/services/resourceAcl.ts:878-891   转让后前任降级为 read（服务端规则）
//   packages/frontend/src/hooks/useResourceAccess.ts:81-89 canEdit / canManage 的判定
//   packages/frontend/src/components/split/UnsavedChangesGuard.tsx:76-90   dirty ⇒ 阻断一切站内导航
//   packages/frontend/src/components/split/UnsavedChangesGuard.tsx:155-195 三个 testid
//   packages/frontend/src/routes/agents.detail.tsx:52-53   remountDeps：换 param 就重挂载
//   packages/frontend/src/components/MarkdownEditor.tsx:34-57  编辑 / 预览两栏（不是页签）
//   packages/frontend/src/components/MultiSelect.tsx:350-363   rowDisabled = 未选中 ∧ disabled ⇒ aria-disabled + 点不动
//   packages/frontend/src/components/SkillsPicker.tsx:80-84    不可用引用的选项**无条件**并入候选（这才让置灰可达）
//   packages/frontend/src/components/AgentForm.tsx:459-471     state==='unavailable' ⇒ disabled: true
//   packages/backend/src/services/agentResourceIntegrity.ts:496-511 displayRef：可见但不可用 ⇒ 'unavailable'
//   packages/backend/src/services/skillBootVerify.ts:293-301   live 树与已提交版本不一致 ⇒ 本次启动隔离
//   packages/backend/src/services/skill.ts:75-83               隔离的技能从 /api/skills 里消失
//
// ## 执行模型
//
// 全文件共用一个 daemon，跑在一个自带的 home 上（写了 `.demo-seeded` 标记，于是
// RFC-307 的样例内容不会被种下——`[demo] reviewer` 是 `__system__` 名下的 public 行，
// 会让「这个账号看到几张卡片」永远不可断言）。
//
// **beforeAll 里刻意重启了一次 daemon**：AGENT-X4 需要一个「引用的技能不可用」的
// 状态，而这个状态在产品里只有一条真实通路——受管技能的 live 目录与已提交版本的
// 内容哈希对不上，于是**下一次启动**的快照复验把它隔离掉
// （skillBootVerify.ts:293-301 → skill.ts:75-83 → agentResourceIntegrity.ts:496-511）。
// 把资源删掉或转私有都只会得到 'missing' / 'hidden'，那两种状态**不带** disabled 标记，
// 走不到置灰分支。所以 beforeAll 的顺序是：起 daemon → 播技能与引用它的代理 →
// 停 daemon → 在 home 里改坏那份 live SKILL.md → 用同一个 home 重新起 daemon。
// 这是用例自己制造的环境状态，不是产品缺陷。

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

const PASSWORD = 'Rfc319AuthoringPass!1'

let daemon: DaemonHandle
let daemonHome: string
let sequence = 0

/** AGENT-X4 的夹具：一个引用了「启动时被隔离」的技能的代理。 */
let brokenSkill: { skillId: string; skillName: string; agentId: string }

interface AgentRow {
  id: string
  name: string
  description: string | null
  outputs: string[]
  outputKinds?: Record<string, string>
  frontmatterExtra?: Record<string, unknown>
  permission?: Record<string, unknown>
  bodyMd?: string
  runtime?: string
  updatedAt: number
  aclRevision: number | null
}

interface SkillRow {
  id: string
  name: string
}

interface RuntimeRow {
  name: string
  isDefault: boolean
  enabled: boolean
}

interface ResourceStatusRow {
  ok: boolean
  references: Array<{ kind: string; refId: string; name: string | null; state: string }>
}

interface ContractSummary {
  contractRef: { contractId: string; version: number }
  displayName: { 'zh-CN': string; 'en-US': string }
  allowedExecutorKinds: string[]
  agentOutputPort: string | null
  agentOutputKind: string | null
}

interface AclRow {
  ownerUserId: string | null
  grants: Array<{ user: { id: string; username: string }; level: string }>
}

interface SeededUser {
  username: string
  userId: string
  token: string
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

async function json<T>(
  token: string,
  path: string,
  init: RequestInit | undefined,
  what: string,
): Promise<T> {
  const res = await raw(token, path, init)
  expect(res.status < 400, `${what}: HTTP ${res.status} ${res.body}`).toBe(true)
  return JSON.parse(res.body) as T
}

async function getAgent(id: string): Promise<AgentRow> {
  return json<AgentRow>(daemon.token, `/api/agents/${id}`, undefined, `read agent ${id}`)
}

async function listAgents(token: string = daemon.token): Promise<AgentRow[]> {
  return json<AgentRow[]>(token, '/api/agents', undefined, 'list agents')
}

async function seedAgent(
  body: Record<string, unknown>,
  token: string = daemon.token,
): Promise<AgentRow> {
  return json<AgentRow>(
    token,
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({ outputs: ['answer'], bodyMd: '', description: '', ...body }),
    },
    `seed agent ${String(body.name)}`,
  )
}

async function seedUser(tag: string): Promise<SeededUser> {
  const username = `rfc319-au-${tag}`
  const created = await json<{ id: string }>(
    daemon.token,
    '/api/users',
    {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        // RFC-320：账号缺 email 连启动任务都过不去；这里只是保持夹具与产品一致。
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

async function primeAuth(page: Page, token: string = daemon.token): Promise<void> {
  await page.addInitScript(
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

/** 打开一个已存在代理的详情页，等到保存键出现（= 表单已 hydrate）。 */
async function openAgentDetail(page: Page, agentId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/agents/${agentId}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible()
}

/** 点详情页保存并等它真的落库（用 API 回读，不信任 UI 自己的状态）。 */
async function saveAgentForm(
  page: Page,
  agentId: string,
  expectUpdatedAfter: number,
): Promise<AgentRow> {
  await page.getByTestId('agent-save-button').click()
  await expect
    .poll(async () => (await getAgent(agentId)).updatedAt, { timeout: 30_000 })
    .toBeGreaterThan(expectUpdatedAfter)
  return getAgent(agentId)
}

/** 详情页 More → Permissions。 */
async function openAclPanel(page: Page): Promise<Locator> {
  await page.getByTestId('detail-more-actions').click()
  const actions = page.getByTestId('detail-actions-dialog')
  await expect(actions).toBeVisible()
  await actions.getByTestId('acl-dialog-button').click()
  const panel = page.getByTestId('acl-panel')
  await expect(panel).toBeVisible()
  return panel
}

test.beforeAll(async () => {
  daemonHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-authoring-'))
  // 「样例已经提供过」的标记：不种 RFC-307 的 demo 内容，见文件头 §执行模型。
  writeFileSync(join(daemonHome, '.demo-seeded'), `${String(Date.now())}\n`)

  const first = await startDaemon({ home: daemonHome })
  daemon = first
  const skill = await json<SkillRow>(
    first.token,
    '/api/skills',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-doomed-skill',
        description: 'AGENT-X4 fixture: will be quarantined on the next boot',
        bodyMd: '# doomed\n',
      }),
    },
    'seed doomed skill',
  )
  const agent = await seedAgent(
    {
      name: 'rfc319-x4-broken-ref',
      description: 'references a skill that the next boot quarantines',
      skills: [{ kind: 'managed', skillId: skill.id }],
    },
    first.token,
  )
  brokenSkill = { skillId: skill.id, skillName: skill.name, agentId: agent.id }
  await first.stop()

  // 改坏 live 目录：下一次启动的快照复验会算出与已提交版本不同的哈希并隔离它。
  appendFileSync(
    join(daemonHome, 'skills', skill.id, 'files', 'SKILL.md'),
    '\n<!-- rfc319 AGENT-X4 tamper -->\n',
    'utf-8',
  )

  daemon = await startDaemon({ home: daemonHome })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    if (daemonHome !== undefined) rmSync(daemonHome, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// `page.route` 的 handler 必须在 page 还活着的时候等干净：先摘 handler，再等在飞的
// callback 跑完。必须是 'wait' 而不是 'ignoreErrors'——后者只是把错吞掉，
// 那等于「重跑就过了」。见 docs/dev-gotchas.md §e2e 里凡是 page.route 拦 API 的。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// AGENT-02 —— 空名 / 非法名格式
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-02: 空名点不动创建键，非法名被服务端逐条说明地拒收且一条记录都不落库 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)

  const createButton = page.getByTestId('agent-create-button')
  const nameField = page.getByLabel(/^Name/)
  await expect(nameField).toBeVisible()

  // (1) 空名字：唯一一道**前端**闸。它若失效，用户点下去只能吃一条 422，
  //     而按钮上写的是「创建代理」——被拒时人只会以为系统坏了。
  await expect(
    createButton,
    '名字还是空的，创建键却可点 ⇒ 用户点了只会吃一条服务端拒绝，没人告诉他缺的是名字',
  ).toBeDisabled()

  // (2) 非法格式：**刻意不断言按钮禁用**——当前产品就是放行到服务端再拒
  //     （agents.new.tsx:185-192 的 disabled 条件只看 `draft.name === ''`；
  //     AgentForm.tsx:528 的 HTML5 pattern 没有提交事件可拦）。这里锁的是
  //     「拒绝必须可读」，不是把现状写成期望。
  const illegal = `RFC319 Bad Name ${++sequence}`
  await nameField.fill(illegal)
  await expect(createButton).toBeEnabled()
  await createButton.click()

  const banner = page.locator('.error-box').first()
  await expect(
    banner,
    '非法名字被服务端拒了却没有任何可见呈现 ⇒ 用户以为代理建好了，回列表却找不到它',
  ).toBeVisible()
  await expect(
    banner,
    '错误里没写清楚是「名字」哪里不合法 ⇒ 用户只能一个字一个字试，不知道大写 / 空格才是问题',
  ).toContainText('name must start with [a-z0-9] and contain only [a-z0-9_-]')

  // 还留在新建页：被拒之后若跳走，用户刚填的整张表单就没了。
  await expect(page).toHaveURL(/\/agents\/new$/)

  // 服务端真值：一条半成品都不许留下。
  expect(
    (await listAgents()).some((row) => row.name === illegal),
    '非法名字居然落库了 ⇒ 之后所有按名字寻址的路径（导入 / frontmatter / dependsOn）都会撞上它',
  ).toBe(false)

  // (3) 清空名字要回到禁用态——否则「禁用」只是初次渲染的一次性表演。
  await nameField.fill('')
  await expect(
    createButton,
    '把名字删空后创建键仍可点 ⇒ 那道空名闸只在首次渲染成立，改一次就失效了',
  ).toBeDisabled()

  // (4) 反向对照：同一张表单填合法名字必须建得成，证明上面拦的是名字本身、
  //     不是这条路整个坏了。
  const legal = `rfc319-a02-${++sequence}`
  await nameField.fill(legal)
  await createButton.click()
  await expect(page).toHaveURL(new RegExp('/agents/[0-9A-Z]{26}$'))
  const created = new URL(page.url()).pathname.split('/').pop() as string
  expect((await getAgent(created)).name).toBe(legal)
})

// ---------------------------------------------------------------------------
// AGENT-03 —— 重名冲突
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-03: 同名代理再建一次吃 409，冲突在页面上读得到且库里仍只有一条 @nightly', async ({
  page,
}) => {
  const name = `rfc319-a03-${++sequence}`
  await seedAgent({ name, description: 'the original' })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await page.getByLabel(/^Name/).fill(name)
  await page.getByLabel('Description', { exact: true }).fill('the impostor')
  await page.getByTestId('agent-create-button').click()

  const banner = page.locator('.error-box').first()
  await expect(
    banner,
    '重名冲突没有任何可见呈现 ⇒ 用户会反复点「创建」，每次都以为是网络抖了一下',
  ).toBeVisible()
  await expect(
    banner,
    '冲突文案读不出「这个名字已经有人用了」⇒ 用户不知道该改名，只会换别的方式重试',
  ).toContainText('already exists')

  // 没有跳走：跳走等于「看起来成功了」。
  await expect(page).toHaveURL(/\/agents\/new$/)

  // 服务端真值：库里仍然**恰好**一条。第二条若真被写进去，之后按名字解析引用
  // （import / dependsOn / frontmatter）就会在两条里随机命中一条。
  expect(
    (await listAgents()).filter((row) => row.name === name).length,
    '同名代理被建出了第二条 ⇒ 按名字解析引用时会在两条之间随机命中',
  ).toBe(1)
  // 而且原来那条没被改写。
  expect(
    (await listAgents()).find((row) => row.name === name)?.description,
    '重名创建把已有那条的描述覆盖了 ⇒ 一次「创建」变成了一次静默的编辑',
  ).toBe('the original')
})

// ---------------------------------------------------------------------------
// AGENT-06 —— Runtime 注册表加载失败
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-06: Runtime 注册表读不到时选择器冻结、错误条自报、重试后恢复可选 @nightly', async ({
  page,
}) => {
  const runtimes = await json<{ runtimes: RuntimeRow[] }>(
    daemon.token,
    '/api/runtimes',
    undefined,
    'list runtimes',
  )
  const pinned = runtimes.runtimes.find((row) => row.enabled)
  expect(pinned, '注册表里一个可用 runtime 都没有 ⇒ 夹具前提不成立').toBeDefined()
  const pinnedName = (pinned as RuntimeRow).name
  const agent = await seedAgent({ name: `rfc319-a06-${++sequence}`, runtime: pinnedName })

  await primeAuth(page)
  // handler 里**不出现 route.fetch()**，只 fulfill 一个注入体；匹配用 URL 谓词
  // 精确到这一条路径，无关请求不进 handler。理由见 docs/dev-gotchas.md。
  await page.route(
    (url) => url.pathname === '/api/runtimes',
    async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, code: 'internal', message: 'injected registry outage' }),
      })
    },
  )
  await openAgentDetail(page, agent.id)

  const errorBanner = page.getByTestId('agent-runtime-load-error')
  await expect(
    errorBanner,
    '注册表读不到却一声不吭 ⇒ 用户面对一个空的 / 冻住的下拉框，不知道是加载中还是坏了',
  ).toBeVisible({ timeout: 40_000 })

  const runtimeSelect = page
    .getByTestId('agent-panel-basics')
    .getByRole('combobox', { name: 'Runtime' })
  await expect(
    runtimeSelect,
    '注册表不可用时选择器仍可点 ⇒ 用户会在一份残缺候选里改钉，保存后代理被钉在一个没验证过的值上',
  ).toBeDisabled()
  await expect(
    runtimeSelect,
    '加载失败把已经钉住的 runtime 也擦掉了 ⇒ 用户以为自己的代理从来没钉过 runtime',
  ).toContainText(pinnedName)

  // 重试必须**真的重发请求**并把界面救回来，而不是只摆一个按钮。
  await page.unrouteAll({ behavior: 'wait' })
  await errorBanner.getByRole('button', { name: 'Retry' }).click()
  await expect(
    errorBanner,
    '点了重试错误条还在 ⇒ 那个按钮是装饰，用户只能刷新整页（并丢掉未保存的编辑）',
  ).toHaveCount(0, { timeout: 40_000 })
  await expect(runtimeSelect).toBeEnabled()

  await runtimeSelect.click()
  const listbox = page.getByRole('listbox')
  await expect(
    listbox.getByRole('option', { name: 'Inherit (global default)' }),
    '恢复之后候选里连「继承全局默认」这一项都没有 ⇒ 用户再也解除不了已有的钉住',
  ).toBeVisible()
  await expect(listbox.getByRole('option', { name: pinnedName })).toBeVisible()
  await page.keyboard.press('Escape')
})

// ---------------------------------------------------------------------------
// AGENT-21 —— 执行契约 ⇄ 受管输出端口
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-21: 选中平台执行契约自动物化受管端口，取消最后一个契约把端口与 kind sidecar 一并清除 @nightly', async ({
  page,
}) => {
  const contracts = await json<{ items: ContractSummary[] }>(
    daemon.token,
    '/api/execution-contracts',
    undefined,
    'list execution contracts',
  )
  const agentContracts = contracts.items.filter((item) =>
    item.allowedExecutorKinds.includes('agent'),
  )
  // 选项文案是 displayName['en-US']（ExecutionContractPicker.tsx:61-65）。
  // 只挑**文案唯一**的候选，否则 getByRole('option', {name}) 会撞上多条。
  const labelCount = new Map<string, number>()
  for (const item of agentContracts) {
    const label = item.displayName['en-US']
    labelCount.set(label, (labelCount.get(label) ?? 0) + 1)
  }
  const unique = agentContracts.filter(
    (item) => labelCount.get(item.displayName['en-US']) === 1 && item.agentOutputPort !== null,
  )
  const plain = unique.find(
    (item) => item.agentOutputPort === 'agent-result' && item.agentOutputKind === null,
  )
  const kinded = unique.find(
    (item) => item.agentOutputKind !== null && item.agentOutputPort !== 'agent-result',
  )
  expect(
    plain,
    '注册表里没有「输出到 agent-result、不带 kind」的 Agent 契约 ⇒ 夹具前提不成立',
  ).toBeDefined()
  expect(
    kinded,
    '注册表里没有「自带 outputKind」的 Agent 契约 ⇒ 无法验证 sidecar 随契约一起来去',
  ).toBeDefined()
  const plainContract = plain as ContractSummary
  const kindedContract = kinded as ContractSummary
  const kindedPort = kindedContract.agentOutputPort as string
  const kindedKind = kindedContract.agentOutputKind as string

  const agent = await seedAgent({ name: `rfc319-a21-${++sequence}`, outputs: ['answer'] })

  await primeAuth(page)
  await openAgentDetail(page, agent.id)
  await page.getByTestId('agent-tab-ports').click()
  const panel = page.getByTestId('agent-panel-ports')
  await expect(panel).toBeVisible()

  // 起点：只有用户自己声明的那一个普通端口。
  await expect(panel.getByTestId('agent-output-port-list').locator('.agent-port-card')).toHaveCount(
    1,
  )

  const picker = panel.getByTestId('agent-execution-contracts')
  await picker.click()
  const listbox = page.getByRole('listbox', { name: 'Platform execution contracts' })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: plainContract.displayName['en-US'] }).click()

  const managedCard = panel.getByTestId('agent-port-card-output-1')
  await expect(
    managedCard,
    '选了执行契约却没物化出受管端口 ⇒ 平台按契约投递结果时找不到出口，任务在运行期才炸',
  ).toContainText('agent-result')
  await expect(
    managedCard,
    '受管端口没有「contract managed」标记 ⇒ 用户以为这是自己建的端口，改它 / 删它都无从下手',
  ).toContainText('contract managed')
  await expect(
    managedCard.getByRole('button', { name: /^Edit output port agent-result/ }),
    '受管端口居然给了编辑键 ⇒ 用户改掉端口名后契约投递就落空了（契约那边的名字没跟着改）',
  ).toHaveCount(0)
  await expect(
    managedCard.getByRole('button', { name: /^Delete output port agent-result/ }),
    '受管端口居然给了删除键 ⇒ 删完契约还在，代理立刻处于「声明了契约却没有出口」的自相矛盾态',
  ).toHaveCount(0)
  // 对照：普通端口的两个键必须还在，否则上面两条只是「所有端口都没键」。
  const ordinaryCard = panel.getByTestId('agent-port-card-output-0')
  await expect(
    ordinaryCard.getByRole('button', { name: /^Edit output port answer/ }),
    '普通端口也被当成受管端口锁住 ⇒ 用户再也编辑不了自己声明的端口',
  ).toBeVisible()

  // 第二个契约：带 outputKind，用来验证 sidecar 也跟着契约一起来。
  await listbox.getByRole('option', { name: kindedContract.displayName['en-US'] }).click()
  await expect(panel.getByTestId('agent-port-card-output-2')).toContainText(kindedPort)
  await expect(
    panel.getByTestId('agent-port-card-output-2'),
    '契约声明的 outputKind 没落到端口上 ⇒ 端口退回默认 string，下游按纯文本处理这份产物',
  ).toContainText(kindedKind)
  await page.keyboard.press('Escape')

  const afterSelect = await saveAgentForm(page, agent.id, agent.updatedAt)
  expect(
    afterSelect.outputs,
    '受管端口没落库 ⇒ 页面上看着有、库里没有，工作流接线时这个端口根本不存在',
  ).toEqual(['answer', 'agent-result', kindedPort])
  expect(
    afterSelect.outputKinds?.[kindedPort],
    '受管端口的 kind sidecar 没落库 ⇒ 契约产物在下游被当成 string',
  ).toBe(kindedKind)
  expect(
    (afterSelect.frontmatterExtra?.executionContracts as unknown[] | undefined)?.length,
    '契约声明本身没落库 ⇒ 端口留下了、契约没了，代理变成一个谁也解释不了的形状',
  ).toBe(2)

  // ---- 取消全部契约：端口与 sidecar 必须一起消失 ----
  await picker.click()
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: plainContract.displayName['en-US'] }).click()
  await listbox.getByRole('option', { name: kindedContract.displayName['en-US'] }).click()
  await page.keyboard.press('Escape')

  await expect(
    panel.getByTestId('agent-output-port-list').locator('.agent-port-card'),
    '取消契约后受管端口还在 ⇒ 它已经不再受管、卡片上却没有删除键，用户被永久卡住',
  ).toHaveCount(1)
  await expect(panel.getByTestId('agent-port-card-output-0')).toContainText('answer')

  const afterClear = await saveAgentForm(page, agent.id, afterSelect.updatedAt)
  expect(
    afterClear.outputs,
    '取消契约后受管端口仍在库里 ⇒ 工作流还能连到一个再也不会有数据的端口',
  ).toEqual(['answer'])
  expect(
    Object.prototype.hasOwnProperty.call(afterClear.outputKinds ?? {}, kindedPort),
    '端口没了、它的 kind sidecar 留下了 ⇒ 库里多一条谁也看不见的孤儿映射，占着这个端口名',
  ).toBe(false)
  expect(
    afterClear.frontmatterExtra?.executionContracts,
    '契约声明没被清干净 ⇒ 代理仍自称能执行某个契约，但已经没有对应的出口了',
  ).toBeUndefined()
})

// ---------------------------------------------------------------------------
// AGENT-22 —— Advanced 页非法 JSON
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-22: Advanced 页非法 JSON 挡住创建，摘要的「去修复」把焦点真的送到那个字段 @nightly', async ({
  page,
}) => {
  const name = `rfc319-a22-${++sequence}`
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await page.getByLabel(/^Name/).fill(name)

  const createButton = page.getByTestId('agent-create-button')
  await expect(createButton).toBeEnabled()

  await page.getByTestId('agent-tab-advanced').click()
  const permission = page.getByTestId('agent-json-permission')
  await expect(permission).toBeVisible()
  await permission.fill('{"edit":')

  const summary = page.getByTestId('agent-json-validation')
  await expect(
    summary,
    '半截 JSON 没有任何汇总提示 ⇒ 用户只看到创建键莫名其妙点不动，找不到是哪个字段坏了',
  ).toBeVisible()
  await expect(
    summary,
    '校验摘要不是 role=alert ⇒ 读屏用户完全不会被告知这里出了问题',
  ).toHaveAttribute('role', 'alert')
  await expect(summary, '摘要没点名是哪个字段 ⇒ 五个页签里逐个翻找是唯一的排查方式').toContainText(
    'Permission JSON',
  )
  await expect(
    createButton,
    '非法 JSON 没挡住创建 ⇒ 半截 JSON 被当成 {} 静默吞掉，用户的 permission 配置无声消失',
  ).toBeDisabled()

  // 切走，把出错的字段藏起来——这正是「一键跳转」要解决的场景。
  await page.getByTestId('agent-tab-basics').click()
  await expect(page.getByTestId('agent-panel-advanced')).toBeHidden()
  await expect(summary, '换个页签摘要就消失了 ⇒ 用户离开 Advanced 页后再也看不到障碍').toBeVisible()

  await summary.getByRole('button', { name: 'Fix Permission JSON' }).click()
  await expect(
    page.getByTestId('agent-panel-advanced'),
    '「去修复」没把 Advanced 页调出来 ⇒ 这个按钮什么也没做',
  ).toBeVisible()
  // 真浏览器焦点是组件测证明不了的那一格：面板露出来但焦点没落到字段上，
  // 键盘用户还得自己一路 Tab 过去找。
  await expect(
    permission,
    '跳过去了但焦点没落在那个 textarea 上 ⇒ 键盘 / 读屏用户要自己 Tab 着找是哪一格坏了',
  ).toBeFocused()

  await permission.fill('{"edit":"allow"}')
  await expect(summary, '修好之后摘要还赖着不走 ⇒ 用户以为自己没改对').toHaveCount(0)
  await expect(createButton).toBeEnabled()

  // 第二种非法：合法 JSON、但不是对象。它和语法错误是两条分支，必须各自成立。
  const extra = page.getByTestId('agent-json-frontmatter-extra')
  await extra.fill('[1, 2]')
  await expect(
    summary,
    'JSON 数组被当成合法 frontmatter ⇒ 保存后 frontmatter 变成一个后端读不懂的形状',
  ).toBeVisible()
  await expect(summary).toContainText('Extra frontmatter (JSON)')
  await expect(createButton).toBeDisabled()

  await extra.fill('{"color":"blue"}')
  await expect(summary).toHaveCount(0)
  await createButton.click()

  await expect(page).toHaveURL(new RegExp('/agents/[0-9A-Z]{26}$'))
  const created = await getAgent(new URL(page.url()).pathname.split('/').pop() as string)
  expect(
    created.permission,
    '修好之后创建，permission 却不是修好的那份 ⇒ 中途某个非法态被当成最终值提交了',
  ).toEqual({ edit: 'allow' })
  expect(created.frontmatterExtra).toEqual({ color: 'blue' })
})

// ---------------------------------------------------------------------------
// AGENT-33 —— 归属转让
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-33: 代理所有者真转让一次 —— 新主拿到治理权，前任降级为只读 @nightly', async ({
  browser,
}) => {
  const tag = `a33-${++sequence}`
  const alice = await seedUser(`${tag}-alice`)
  const carol = await seedUser(`${tag}-carol`)
  // RFC-231：canonical 创建路径一律 creator-owner + private。
  const agent = await seedAgent(
    { name: `rfc319-${tag}`, description: 'about to change hands' },
    alice.token,
  )

  const aliceSide = await openAs(browser, alice.token)
  const carolSide = await openAs(browser, carol.token)
  try {
    // (0) 起点：carol 看不见这个私有代理。转让之后她要能看见——没有这一格，
    //     后面的「她看得见」可能只是因为它一直是公开的。
    await carolSide.page.goto(`${daemon.baseUrl}/agents`)
    await expect(
      carolSide.page.getByTestId(`split-card-${agent.id}`),
      '别人的私有代理出现在了 carol 的列表里 ⇒ 私有根本没生效，本用例的前提不成立',
    ).toHaveCount(0)

    // (1) alice 现在是主人：能保存、能治理。
    await openAgentDetail(aliceSide.page, agent.id)
    const alicePanel = await openAclPanel(aliceSide.page)
    await expect(alicePanel).toContainText(alice.username)
    await expect(aliceSide.page.getByTestId('acl-save')).toBeVisible()

    // (2) 走完整条转让：选人 → 确认。rfc099 那条只走到「选人」就按 Escape 收尾了。
    await aliceSide.page.getByTestId('acl-transfer-owner').click()
    const transferInput = aliceSide.page.getByTestId('acl-transfer-input')
    await expect(transferInput).toBeVisible()
    await transferInput.fill(carol.username)
    await aliceSide.page.getByTestId(`acl-transfer-option-${carol.username}`).click()
    await aliceSide.page.getByTestId('acl-transfer-confirm').click()

    // 内层弹窗必须自己关掉；外层权限面板刻意留着（面板刚在你眼皮底下换了主人）。
    await expect(
      aliceSide.page.getByTestId('acl-transfer-dialog'),
      '确认之后转让弹窗还开着 ⇒ 用户不知道转让成没成，会再点一次',
    ).toHaveCount(0, { timeout: 30_000 })
    await expect(alicePanel).toBeVisible()

    // (3) 服务端真值。UI 关掉弹窗只说明请求回了 200，不说明库里换了主人。
    await expect
      .poll(
        async () =>
          (await json<AclRow>(daemon.token, `/api/agents/${agent.id}/acl`, undefined, 'read acl'))
            .ownerUserId,
        { timeout: 30_000 },
      )
      .toBe(carol.userId)
    const acl = await json<AclRow>(
      daemon.token,
      `/api/agents/${agent.id}/acl`,
      undefined,
      'read acl',
    )
    expect(
      acl.grants.map((grant) => [grant.user.username, grant.level]),
      '转让把前任彻底踢光了 ⇒ 他连自己刚交出去的东西都看不见（产品规则是降级为只读，' +
        'packages/backend/src/services/resourceAcl.ts:878-891）',
    ).toEqual([[alice.username, 'read']])

    // (4) alice 这一侧：面板当场变只读。治理键还在 ⇒ 她还能把资源再转走一次。
    await expect(
      alicePanel,
      '转让完面板还显示旧主人 ⇒ 用户看不出这次操作到底改了什么',
    ).toContainText(carol.username)
    await expect(
      aliceSide.page.getByTestId('acl-save'),
      '交出所有权后前任仍有「保存权限」键 ⇒ 他还能改这份资源的授权名单',
    ).toHaveCount(0)
    await expect(
      aliceSide.page.getByTestId('acl-transfer-owner'),
      '交出所有权后前任仍能再转让一次 ⇒ 治理权根本没跟着所有权走',
    ).toHaveCount(0)

    // 刷新后编辑 / 删除入口也必须消失。**用刷新而不是等实时降档**：实时那条路是
    // e2e/rfc324-graded-grants.spec.ts:90 的地盘，这里只锁「落库之后的结果」。
    await aliceSide.page.reload()
    await expect(
      aliceSide.page.getByTestId('agent-save-button'),
      '只读授权者仍看得到保存键 ⇒ 他填完整张表单，保存才吃 403（docs/audit-backlog.md:108 记的就是这个）',
    ).toHaveCount(0, { timeout: 30_000 })
    await aliceSide.page.getByTestId('detail-more-actions').click()
    await expect(
      aliceSide.page.getByTestId('detail-actions-dialog').getByTestId('detail-delete-button'),
      '只读授权者仍能删除这个代理 ⇒ 删除是治理动作，可读授权绝不该覆盖它',
    ).toHaveCount(0)

    // (5) carol 这一侧：她现在是主人。
    await carolSide.page.goto(`${daemon.baseUrl}/agents`)
    await expect(
      carolSide.page.getByTestId(`split-card-${agent.id}`),
      '接手之后新主人的列表里没有这个代理 ⇒ 转让等于把资源转进了黑洞',
    ).toBeVisible({ timeout: 30_000 })
    await openAgentDetail(carolSide.page, agent.id)
    const carolPanel = await openAclPanel(carolSide.page)
    await expect(carolPanel, '权限面板里的主人不是新主 ⇒ 转让只改了可见性，没改归属').toContainText(
      carol.username,
    )
    await expect(
      carolSide.page.getByTestId('acl-save'),
      '新主人拿不到治理权 ⇒ 这份资源的授权从此没人能改，等于锁死',
    ).toBeVisible()
    await expect(carolSide.page.getByTestId('acl-transfer-owner')).toBeVisible()
    await expect(
      carolPanel.getByTestId(`acl-members-remove-${alice.username}`),
      '前任没有作为成员出现在新主的名单里 ⇒ 新主看不到还有谁能读这份资源',
    ).toBeVisible()
  } finally {
    await aliceSide.context.close()
    await carolSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// AGENT-41 —— 新建页的未保存守卫
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-41: 带着未保存草稿离开新建页 —— 留下保住草稿，放弃则一条记录都不落库 @nightly', async ({
  page,
}) => {
  const neighbour = await seedAgent({
    name: `rfc319-a41-neighbour-${++sequence}`,
    description: 'the card the user clicks by mistake',
  })
  const typed = `rfc319-a41-draft-${++sequence}`

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  const nameField = page.getByLabel(/^Name/)
  await nameField.fill(typed)
  await page.getByLabel('Description', { exact: true }).fill('half-typed, never saved')

  // (1) 点错一张卡片 ⇒ 必须先问。不问就直接跳，用户刚填的整张表单无声消失。
  await page.getByTestId(`split-card-${neighbour.id}`).click()
  const guard = page.getByTestId('unsaved-guard-dialog')
  await expect(
    guard,
    '带着未保存草稿点别的卡片直接跳走了 ⇒ 用户点错一下，刚填的整张新建表单就没了',
  ).toBeVisible()

  // (2) 「留下」= 什么都不改：URL 不动，草稿逐字还在。
  await page.getByTestId('unsaved-stay').click()
  await expect(guard).toHaveCount(0)
  await expect(page, '选了「留下」却还是跳走了 ⇒ 这个按钮是反的').toHaveURL(/\/agents\/new$/)
  await expect(
    nameField,
    '「留下」之后草稿被清空了 ⇒ 守卫救下了导航却没救下内容，等于白问一次',
  ).toHaveValue(typed)

  // (3) 「放弃」= 真的走，且**什么都不落库**。守卫若在放弃时顺手提交，
  //     用户会莫名其妙多出一个自己明确说过不要的代理。
  await page.getByTestId(`split-card-${neighbour.id}`).click()
  await expect(guard).toBeVisible()
  await page.getByTestId('unsaved-discard').click()
  await expect(page).toHaveURL(new RegExp(`/agents/${neighbour.id}$`))
  expect(
    (await listAgents()).some((row) => row.name === typed),
    '选了「放弃」却把草稿创建成了真代理 ⇒ 用户明确说不要的东西被建了出来',
  ).toBe(false)

  // (4) 再回新建页必须是干净的一张表。残留的草稿会让下一次创建带上上一次的字段。
  await page.getByTestId('split-new-button').click()
  await expect(page).toHaveURL(/\/agents\/new$/)
  await expect(
    page.getByLabel(/^Name/),
    '放弃之后重进新建页，上一次的草稿还在 ⇒ 用户下一次创建会带上他已经放弃过的内容',
  ).toHaveValue('')
})

// ---------------------------------------------------------------------------
// AGENT-42 —— 切卡片必须重挂载详情
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-42: 切换左栏代理卡片时详情重挂载 —— 草稿绝不许串到另一个代理 @nightly', async ({
  page,
}) => {
  const tag = `a42-${++sequence}`
  const alpha = await seedAgent({
    name: `rfc319-${tag}-alpha`,
    description: 'alpha as stored on the server',
  })
  const bravo = await seedAgent({
    name: `rfc319-${tag}-bravo`,
    description: 'bravo as stored on the server',
  })
  const leak = 'ALPHA DRAFT — must never appear on bravo'

  await primeAuth(page)
  await openAgentDetail(page, alpha.id)
  const description = page.getByLabel('Description', { exact: true })
  await expect(description).toHaveValue('alpha as stored on the server')
  await description.fill(leak)

  // 切到 bravo（脏草稿 ⇒ 守卫先问，选放弃）。
  await page.getByTestId(`split-card-${bravo.id}`).click()
  await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()
  await page.getByTestId('unsaved-discard').click()
  await expect(page).toHaveURL(new RegExp(`/agents/${bravo.id}$`))
  await expect(page.getByTestId('agent-save-button')).toBeVisible()

  // ---- 这条用例的全部价值在这一格：**负向**。
  // 详情面板若不随 param 重挂载（agents.detail.tsx:52-53 的 remountDeps），
  // hydrate-once 的草稿会原样留在表单里 —— 用户看到的是 alpha 的草稿、标题却是
  // bravo；此时按一下保存，alpha 的内容就被写进了 bravo。
  await expect(
    description,
    'bravo 的表单里出现了 alpha 的未保存草稿 ⇒ 按一下保存就把 alpha 的内容写进了 bravo',
  ).not.toHaveValue(leak)
  await expect(
    description,
    'bravo 的表单没显示 bravo 自己的服务端值 ⇒ 详情面板没有按新 param 重新取数',
  ).toHaveValue('bravo as stored on the server')
  await expect(page.getByRole('heading', { name: bravo.name })).toBeVisible()

  // ---- 反方向同样要断：切回 alpha 必须是**服务端**的 alpha，
  // 既不能带回被放弃的草稿，也不能显示 bravo 的值。
  await page.getByTestId(`split-card-${alpha.id}`).click()
  await expect(page).toHaveURL(new RegExp(`/agents/${alpha.id}$`))
  await expect(page.getByTestId('agent-save-button')).toBeVisible()
  await expect(
    description,
    '切回来时 alpha 显示的是 bravo 的值 ⇒ 反方向也在串台，用户会把 bravo 的内容存进 alpha',
  ).not.toHaveValue('bravo as stored on the server')
  await expect(
    description,
    '被放弃的草稿又回来了 ⇒ 「放弃」没有真正丢掉它，只是暂时藏了起来',
  ).toHaveValue('alpha as stored on the server')

  // 服务端两条都必须原封不动——整段来回不该产生任何写入。
  expect((await getAgent(alpha.id)).description).toBe('alpha as stored on the server')
  expect(
    (await getAgent(bravo.id)).description,
    '来回切了几次之后 bravo 的描述变了 ⇒ 某一次切换顺手替用户保存了一次',
  ).toBe('bravo as stored on the server')
})

// ---------------------------------------------------------------------------
// AGENT-X3 —— Prompt 页的 Markdown 编辑与预览
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-X3: Prompt 页写 Markdown 正文实时出预览，并随保存逐字节往返 @nightly', async ({
  page,
}) => {
  const name = `rfc319-x3-${++sequence}`
  const body = '## Release checklist\n\n- run the gate\n- read the log\n\n`keep  two  spaces`'

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await page.getByLabel(/^Name/).fill(name)
  await page.getByTestId('agent-tab-prompt').click()
  const promptPanel = page.getByTestId('agent-panel-prompt')
  await expect(promptPanel).toBeVisible()

  // 起点：预览是空态。没有这一格，「预览渲染出了东西」可能只是它一直在渲染。
  await expect(
    promptPanel.locator('.md-editor__preview'),
    '正文还是空的，预览栏却已经有内容 ⇒ 预览与正文没有关系，看它等于看别人的东西',
  ).toContainText('Nothing to preview yet.')

  const editor = promptPanel.locator('textarea')
  await editor.fill(body)

  const preview = promptPanel.locator('.md-editor__pane--preview')
  await expect(
    preview.getByRole('heading', { level: 2, name: 'Release checklist' }),
    '写了标题预览里没有标题 ⇒ 用户写 Markdown 等于在黑盒里打字，格式对不对只能靠猜',
  ).toBeVisible()
  await expect(
    preview.getByRole('listitem'),
    '列表没被渲染成列表 ⇒ 预览没走真正的 Markdown 渲染，它给的是假的确认',
  ).toHaveCount(2)

  await page.getByTestId('agent-create-button').click()
  await expect(page).toHaveURL(new RegExp('/agents/[0-9A-Z]{26}$'))
  const id = new URL(page.url()).pathname.split('/').pop() as string
  expect(
    (await getAgent(id)).bodyMd,
    '正文没有逐字节落库 ⇒ 提示词被保存这一步悄悄改写（空格 / 换行 / 代码块都可能被吃掉），' +
      '而提示词是代理全部行为的来源',
  ).toBe(body)

  // 往返的另一半：重新打开必须原样读回来，否则下一次保存就把它写坏了。
  await page.reload()
  await page.getByTestId('agent-tab-prompt').click()
  await expect(
    page.getByTestId('agent-panel-prompt').locator('textarea'),
    '重新打开时正文和存进去的不一样 ⇒ 用户下一次随手保存就把提示词写成了这份被改过的版本',
  ).toHaveValue(body)
  await expect(
    page.getByTestId('agent-panel-prompt').getByRole('heading', { level: 2 }),
    '重新打开后预览是空的 ⇒ 预览只在打字时活着，读一个已存在的代理时没有任何可视确认',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// AGENT-X4 —— 不可用的引用在选择器里置灰
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-X4: 引用的技能不可用时在 Skills 选择器里置灰，摘掉之后不能被重新选中 @nightly', async ({
  page,
}) => {
  // 前提：beforeAll 改坏了这份技能的 live 目录并重启了 daemon，本次启动的快照复验
  // 应当把它隔离掉。这是用例自己制造的环境状态，不是产品缺陷。
  await expect
    .poll(
      async () =>
        (
          await json<ResourceStatusRow>(
            daemon.token,
            `/api/agents/${brokenSkill.agentId}/resource-status`,
            undefined,
            'read resource status',
          )
        ).references.find((ref) => ref.refId === brokenSkill.skillId)?.state,
      { timeout: 30_000 },
    )
    .toBe('unavailable')

  // 对照组：本次启动之后新建的技能是健康的，必须仍然可选。没有它，
  // 「那个选项点不动」可能只是因为整个选择器坏了。
  const healthy = await json<SkillRow>(
    daemon.token,
    '/api/skills',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-x4-healthy-${++sequence}`,
        description: 'still fine',
        bodyMd: '# fine\n',
      }),
    },
    'seed healthy skill',
  )

  await primeAuth(page)
  await openAgentDetail(page, brokenSkill.agentId)
  await page.getByTestId('agent-tab-resources').click()
  const panel = page.getByTestId('agent-panel-resources')
  await expect(panel).toBeVisible()

  // (1) 已经挂着的坏引用必须**自报**不可用。只显示技能名 ⇒ 用户看不出这条引用
  //     已经失效，只会奇怪为什么代理启动不了。
  await expect(
    panel.locator('.chip').filter({ hasText: brokenSkill.skillName }),
    '失效的技能标签只显示名字 ⇒ 用户看不出坏的是哪一条，只知道这个代理莫名其妙不能启动',
  ).toContainText('(disabled or unavailable)')

  const combobox = panel.getByRole('combobox', { name: 'Skills' })
  await combobox.click()
  const listbox = page.getByRole('listbox', { name: 'Skills' })
  await expect(listbox).toBeVisible()

  const brokenOption = listbox.getByRole('option', {
    name: `${brokenSkill.skillName} (disabled or unavailable)`,
  })
  // (2) 还挂着的时候必须**可以**摘掉——否则用户永远修不好这个代理
  //     （MultiSelect.tsx:350 的 rowDisabled 刻意只在「未选中」时才成立）。
  await expect(brokenOption).toHaveAttribute('aria-selected', 'true')
  await expect(
    brokenOption,
    '已选中的失效引用也被置灰 ⇒ 用户既不能用它、也不能摘掉它，这个代理被永久锁死',
  ).not.toHaveAttribute('aria-disabled', 'true')
  await brokenOption.click()
  await expect(brokenOption).toHaveAttribute('aria-selected', 'false')

  // (3) 摘掉之后：置灰，且**再点一次也挂不回去**。这是本条用例的全部价值——
  //     选择器若把失效资源当普通候选，用户的「修复」动作就是把坏引用原样挂回去，
  //     然后保存被 422 挡住，而界面上没有任何东西解释为什么。
  await expect(
    brokenOption,
    '失效的技能被摘掉后又变回了普通可选项 ⇒ 用户会把同一条坏引用原样挂回去',
  ).toHaveAttribute('aria-disabled', 'true')
  // `force: true` 是刻意的：Playwright 自己的可操作性检查看到 role=option 上的
  // `aria-disabled="true"` 就已经拒绝点击（普通 `click()` 会在 "element is not
  // enabled" 上超时）——那只证明**标记**对了。这里要证的是更里面那一层：即便一次
  // 真实的 mousedown 落在这一行上，MultiSelect.tsx:362 的 `if (!rowDisabled)`
  // 也必须把它挡住。两层缺任何一层，用户都能把坏引用重新挂回去。
  await brokenOption.click({ force: true })
  await expect(
    brokenOption,
    '置灰的选项仍然点得动 ⇒ aria-disabled 只是画上去的，实际的 toggle 分支并没有被挡住',
  ).toHaveAttribute('aria-selected', 'false')
  await expect(
    panel.locator('.chip').filter({ hasText: brokenSkill.skillName }),
    '点了置灰选项之后坏引用又回到了已选标签里 ⇒ 置灰完全没有生效',
  ).toHaveCount(0)

  // (4) 对照组：同一个下拉里的健康技能必须照常可选。
  const healthyOption = listbox.getByRole('option', { name: new RegExp(`^${healthy.name}`) })
  await expect(
    healthyOption,
    '健康的技能也被置灰 ⇒ 置灰的判据不是「这条引用坏了」，而是把整个选择器锁死了',
  ).not.toHaveAttribute('aria-disabled', 'true')
  await healthyOption.click()
  await expect(healthyOption).toHaveAttribute('aria-selected', 'true')
})
