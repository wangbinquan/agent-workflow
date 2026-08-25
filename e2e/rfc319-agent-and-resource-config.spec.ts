// RFC-319 —— 代理（AGENT-*）与三类资源（RES-*）里**「配置存得住、并且真的影响运行」**的那一批。
//
// 覆盖能力账本 AGENT-24、AGENT-25、AGENT-26、AGENT-28、AGENT-36、AGENT-44、AGENT-45、
// RES-X1、RES-X2、RES-X6 十行（账本里全部 status='gap'）。这十行的 `tier` **全部**是
// `'nightly'`，所以每条 test 标题末尾都带 ` @nightly`——PR 腿跑的是
// `--grep-invert '@nightly'`，守卫 `tierWiringMismatches` 会双向逐字核对 tag 与 tier。
//
// 选题原则：**只挑「用户在界面上把某个配置存下去，之后这份配置真的被系统当真」的硬判据**。
// 纯展示（图标、文案、空态措辞）一条不写。每条用例都以「从服务端读回落库的那一行」或
// 「另一个消费这份配置的端点/界面」收尾，而不是以「界面上出现了某个元素」收尾。
//
// 与既有 e2e 的分工（**刻意不重叠**，逐条核对过）：
//   * `e2e/main.spec.ts` 的 `RFC-022: agent form Dependency tree (preview) renders the full
//     closure` —— 它把 A→B→C 三条**用 REST 种好**，再打开 A 的表单看树渲染出三行，并直打
//     `/closure` 锁线格式。它**从没在界面上挑过一条依赖，也从没按过保存**。本文件的
//     AGENT-24 补的正是那两半：用 `AgentDependsPicker` 真的挑一条 → 预览当场从「没有依赖」
//     长出闭包 → 保存 → 回读 DB → 重载后仍在。两条用例的失败面完全不同（它锁渲染，
//     这里锁 pick→PUT→SQLite→reload 的往返）。
//   * `e2e/rfc319-ui-primitives-a11y.spec.ts` 的 UX-17 —— 在 `/agents/new` 上把 Skills 多选
//     框的 toggle / chip 删除 / Backspace 全走了一遍，但**一次保存都没点**，落库形状
//     （`skills` 是 `{kind:'managed',skillId}` 的联合类型，前端要做编解码）无人看守。
//     本文件 RES-X1 只管「挑完三类 → 一次保存 → 落库形状对不对 → 谁在消费它」。
//   * `e2e/agent-authoring.spec.ts` 的 `RFC-319 T32` —— 它锁「停用被引用的插件后，能力页出现
//     完整性告警」。它没有碰过**启动任务**那颗按钮。本文件 AGENT-36 只管那颗按钮的两态
//     （健康时是可点的链接 / 坏掉时是带原因 tooltip 的禁用按钮），一句告警都不断言。
//   * `e2e/agent-import.spec.ts` —— agent.md 导入的**粘贴**路径（响应式 / a11y / 只改草稿）。
//     它一次都没走过**上传文件**那条路。本文件 AGENT-28 只走上传：被拒的扩展名 + 真 .md
//     文件，并锁住只有上传路径才有的 `filenameStem`（文件名兜底填 name）。
//   * `e2e/rfc319-agent-authoring.spec.ts` 的 AGENT-33 —— **代理**的所有者转让。本文件
//     RES-X2 转的是**技能 / MCP / 插件**三类（三个不同的详情路由各自往
//     `DetailHeaderActions` 接 `acl`），并额外锁「转让其中一类不会顺手改掉另外两类的归属」。
//   * `e2e/rfc319-iam-oidc-and-acl.spec.ts` 的 IAM-48 —— 内置代理**不进列表 + ACL 改不动**。
//     它没有碰过内置行的**内容写面**。本文件 AGENT-45 只管那条唯一被许可的写路径
//     （`isRuntimeOnlyAgentPatch`）的边界：runtime-only 放行、混进任何第二个键就 403。
//   * `agent-dep-autodetect-button` / `autodetect-apply` / `autodetect-checkbox-*` /
//     `agent-import-file` / `/api/agents/:id/rename` / `/api/mcps/:id/rename` /
//     `/api/plugins/:id/rename` 这些 testid 与端点，在本文件之前的全仓 e2e 里**一次都没出现过**
//     （前四个只有 `packages/frontend/tests/` 的组件单测碰过，rename 三条一个调用方都没有）。
//
// 各条断言失效时**用户会遭遇什么**（这是用例存在的理由，不是断言在做什么）：
//   * AGENT-24 —— 依赖是「这个代理能把活派给谁」。挑了、看见树了、按了保存，值却没进
//     `agents.dependsOn` ⇒ 用户以为编排好了，任务真跑起来时下游代理根本不会被拉起来，
//     而界面上（重载前）一切正常。
//   * AGENT-25 —— 成环的依赖闭包在运行期就是无限展开。预览这一格是**唯一**在保存前告诉
//     用户「你把 A→B→A 连上了」的地方；它哑掉 ⇒ 用户只会看到保存按钮吃了个不明所以的
//     400。而更坏的一档是**拦了却还是写进去了**，所以每一格都回读 DB 确认没落库。
//   * AGENT-26 —— 自动探测是把 Prompt 正文里提到的名字变成真引用的省事入口。它把没提到的
//     东西也塞进来 ⇒ 用户莫名其妙多了一堆挂载（每一条都会进运行期配置）；勾掉的还照样合并
//     ⇒ 复选框是个摆设，用户对导入内容失去控制。
//   * AGENT-28 —— 上传是导入 agent.md 的两条腿之一。扩展名闸漏了 ⇒ 一个 .zip / .png 被当成
//     markdown 读进来，解析出满屏垃圾；文件名兜底断了 ⇒ 用户拿到一个 name 为空的草稿，
//     而 agent.md 惯例上就是不写 name 的（文件名即名字）。
//   * AGENT-36 —— 引用坏掉的代理**启动必失败**。按钮还可点 ⇒ 用户建了任务、等它跑、拿到一个
//     运行期错误；按钮禁用了却不给原因 ⇒ 用户对着一颗灰按钮，不知道该去修什么。
//   * AGENT-44 / RES-X6 —— 改名端点没有任何前端调用方，等于**只有 API 用户在用**。它一旦把
//     引用按名字重绑（而不是按 id），改一次名就会把所有引用它的代理/工作流悄悄改指向别处，
//     或者干脆断掉；重名闸漏了 ⇒ 同一个 owner 下出现两条同名资源，此后所有按名字的人工排查
//     都会指错人。
//   * AGENT-45 —— 内置代理是融合链路的基础设施。写面开得太宽 ⇒ 管理员能把它的 Prompt / 端口
//     改坏，全平台的技能融合从此静默失效，而它连列表都不进、没人找得到去修哪；开得太窄
//     ⇒ 设置页的「融合运行时」这一格永远存不下去。
//   * RES-X1 —— 这是「代理能用哪些能力」的**唯一**用户入口。三个 Picker 里少拷一个
//     ⇒ 用户在界面上明明挂了 MCP，运行期却没有；技能那一格更险，它要做 `managed:` 前缀的
//     编解码，编错了就是一条指向空气的引用。
//   * RES-X2 —— 转让是资源交接的唯一手段。某个详情页的 `acl` 接错 `resourceBaseUrl`
//     ⇒ 用户在插件页点「转让」，改掉的是另一条资源的归属，两边都不会报错。
//
// 源码锚点（可复跑核对，纯文本引用；禁 GitHub 外链见 CLAUDE.md §opencode 源码自取规则）：
//   packages/backend/src/routes/agents.ts:495-590        POST /api/agents/closure-preview：200 + ok:false
//   packages/backend/src/routes/agents.ts:524-529        acl-missing-refs（引用了看不见的代理）
//   packages/backend/src/services/agentDeps.ts:158-163   agent-dependency-self
//   packages/backend/src/services/agentDeps.ts:203-212   agent-dependency-cycle（cyclePath 是裸 id）
//   packages/frontend/src/components/agents/DependencyTreePreview.tsx:70-131  200ms 防抖 + 三类错误分支
//   packages/frontend/src/components/agents/DependencyTree.tsx:35-45          role=tree / treeitem + aria-label
//   packages/frontend/src/lib/agent-dep-detect.ts:52-70  buildGroup：body.includes(name) + 排除已选/自身
//   packages/frontend/src/lib/agent-dep-detect.ts:118-140 mergeAgentDeps：四组各自 appendUnique
//   packages/frontend/src/components/agents/DependencyAutodetectDialog.tsx:34-40 打开时全部预勾
//   packages/frontend/src/lib/agent-import-preview.ts:193-196  validateAgentMarkdownFile：只判扩展名
//   packages/frontend/src/components/AgentImportDialog.tsx:196-222 扩展名不符 ⇒ 文件不被接受 + 报错
//   packages/frontend/src/components/AgentImportDialog.tsx:498-503 canCheck ⇒ 「检查内容」按钮的启用条件
//   packages/frontend/src/routes/agents.detail.tsx:243-272  启动按钮的链接态 / 禁用态二选一
//   packages/frontend/src/components/AgentForm.tsx:688-750   三个能力 Picker + dependsOn Picker
//   packages/backend/src/routes/agents.ts:80-87          isRuntimeOnlyAgentPatch（按**原始 body** 判）
//   packages/backend/src/routes/agents.ts:274-276        内置行：非 runtime-only ⇒ assertNotBuiltin
//   packages/backend/src/services/systemResources.ts:78-86  assertNotBuiltin ⇒ 403 builtin-readonly
//   packages/backend/src/services/agent.ts:814-830       renameAgent：owner 域内重名 ⇒ 409 agent-name-in-use
//   packages/backend/src/routes/mcps.ts:443-475          MCP rename：govern + expectedConfigHash
//   packages/backend/src/routes/plugins.ts:223-245       插件 rename：同款双闸
//   packages/backend/src/services/agentResourceIntegrity.ts:432-452  resource-status 的 references 投影
//   packages/backend/src/services/resourceAcl.ts:878-891  转让后前任降级为 read
//
// 执行模型：全文件共用一个 daemon（stub 模式，不跑任何任务），管理员会话直连；需要非管理员
// 视角的两条用例（AGENT-25 的不可见依赖、RES-X2 的转让）自己 seed 普通用户并开独立
// BrowserContext。每条 test 自己 seed 自己的资源（`nextSlug` 保证不撞名），互不依赖，
// 因此可以整批并发注入变异后按「红了哪几条」逐条归因——`test.describe.configure({ mode:
// 'serial' })` 会毁掉这个性质，故**不用**（本文件里 "serial" 一词只出现在本行注释里）。
// 一次 `page.route` 都不注入（"route.fetch(" 同样只出现在本注释段），所有拒绝分支都由**真的**
// 被拒动作产生——真 schema、真事务、真 ACL。

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

const PASSWORD = 'Rfc319AgentRes!1'
/** RFC-223 PR-4 的确定性框架身份（`systemResources.ts:45`）。 */
const BUILTIN_MERGER_AGENT_ID = '00000000000000000000000001'

let daemon: DaemonHandle
let daemonHome: string
let fixtureDir: string
let sequence = 0

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string
  name: string
  description: string | null
  bodyMd?: string
  runtime?: string | null
  skills: Array<{ kind: 'managed'; skillId: string } | { kind: 'project'; name: string }>
  mcp: string[]
  plugins: string[]
  dependsOn: string[]
  updatedAt: number
  aclRevision: number | null
}

interface IdNameRow {
  id: string
  name: string
}

interface HashedRow extends IdNameRow {
  operationConfigHash: string
}

interface AclRow {
  ownerUserId: string | null
  grants: Array<{ user: { id: string; username: string }; level: string }>
}

interface ResourceStatusRow {
  ok: boolean
  references: Array<{ kind: string; refId: string; name: string | null; state: string }>
}

interface ClosurePreviewRow {
  ok: boolean
  code?: string
  details?: { missing?: Array<{ type: string; name: string }>; id?: string; cyclePath?: string[] }
  agents?: Array<{ id: string; name: string }>
}

interface SeededUser {
  username: string
  userId: string
  token: string
}

// ---------------------------------------------------------------------------
// 请求封装
// ---------------------------------------------------------------------------

async function raw(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return { status: response.status, body: await response.text() }
}

async function json<T>(
  token: string,
  path: string,
  init: RequestInit | undefined,
  what: string,
): Promise<T> {
  const response = await raw(token, path, init)
  expect(response.status < 400, `${what}: HTTP ${response.status} ${response.body}`).toBe(true)
  return JSON.parse(response.body) as T
}

function codeOf(body: string): string {
  return (JSON.parse(body) as { code?: string }).code ?? '<no code>'
}

function nextSlug(prefix: string): string {
  sequence += 1
  return `rfc319-${prefix}-${sequence}`
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function seedAgent(
  body: Record<string, unknown>,
  token: string = daemon.token,
): Promise<AgentRow> {
  return json<AgentRow>(
    token,
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        outputs: ['answer'],
        description: 'rfc319 agent/resource-config fixture',
        bodyMd: '',
        // 依赖图在 OpenCode 上被能力策略拒（见 e2e/main.spec.ts:645-648 的同款处置），
        // 所以夹具一律钉在 claude-code 上——这是夹具选择，不是被测行为。
        runtime: 'claude-code',
        ...body,
      }),
    },
    `seed agent ${String(body.name)}`,
  )
}

async function seedSkill(name: string, token: string = daemon.token): Promise<IdNameRow> {
  return json<IdNameRow>(
    token,
    '/api/skills',
    {
      method: 'POST',
      body: JSON.stringify({ name, description: 'rfc319 fixture skill', bodyMd: `# ${name}\n` }),
    },
    `seed skill ${name}`,
  )
}

async function seedMcp(name: string, token: string = daemon.token): Promise<HashedRow> {
  return json<HashedRow>(
    token,
    '/api/mcps',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'rfc319 fixture mcp',
        type: 'remote',
        // 从不探测，所以这个地址永远不会被拨号；它只需要通过 schema。
        config: { url: 'http://127.0.0.1:1/mcp', oauth: false },
        enabled: true,
      }),
    },
    `seed mcp ${name}`,
  )
}

async function seedPlugin(name: string, token: string = daemon.token): Promise<HashedRow> {
  return json<HashedRow>(
    token,
    '/api/plugins',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        spec: daemon.stubOpencode,
        description: 'rfc319 fixture plugin',
        enabled: true,
      }),
    },
    `seed plugin ${name}`,
  )
}

async function seedUser(tag: string): Promise<SeededUser> {
  const username = `rfc319-arc-${tag}`
  const created = await json<{ id: string }>(
    daemon.token,
    '/api/users',
    {
      method: 'POST',
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

function getAgent(id: string, token: string = daemon.token): Promise<AgentRow> {
  return json<AgentRow>(token, `/api/agents/${id}`, undefined, `read agent ${id}`)
}

function getResourceStatus(id: string): Promise<ResourceStatusRow> {
  return json<ResourceStatusRow>(
    daemon.token,
    `/api/agents/${id}/resource-status`,
    undefined,
    `resource status ${id}`,
  )
}

function getAcl(base: string, id: string): Promise<AclRow> {
  return json<AclRow>(daemon.token, `/api/${base}/${id}/acl`, undefined, `read acl ${base}/${id}`)
}

// ---------------------------------------------------------------------------
// 浏览器封装
// ---------------------------------------------------------------------------

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

/** 打开代理详情页并切到 Resources 页签（表单 hydrate 完成的信号是保存键出现）。 */
async function openResourcesTab(page: Page, agentId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/agents/${agentId}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('agent-tab-resources').click()
  await expect(page.getByTestId('agent-panel-resources')).toBeVisible()
}

/**
 * 在某个 `<MultiSelect>` 里挑一条目录行。
 *
 * `ariaLabel` 同时挂在输入框（combobox）与 portal 出去的 listbox 上，所以两者都能按
 * 可访问名精确定位——不必依赖 DOM 层级（listbox 被 portal 到了 body）。
 */
async function pickCatalogOption(
  page: Page,
  fieldLabel: string,
  optionText: string,
): Promise<void> {
  const combo = page.getByRole('combobox', { name: fieldLabel })
  await combo.click()
  const listbox = page.getByRole('listbox', { name: fieldLabel })
  await expect(listbox).toBeVisible()
  await combo.fill(optionText)
  const option = listbox.locator('.multi-select__option', { hasText: optionText })
  await expect(
    option,
    `「${fieldLabel}」的下拉里找不到目录行「${optionText}」 ⇒ 用户根本挂不上这条资源`,
  ).toHaveCount(1)
  await option.click()
  // 关掉 portal 出来的浮层，否则它会盖住页面上的保存按钮。
  await combo.fill('')
  await page.keyboard.press('Escape')
  await expect(listbox).toHaveCount(0)
}

/** 某个 Picker 当前的 chip 文案。 */
function chipsOf(page: Page, fieldLabel: string): Locator {
  return page.getByRole('combobox', { name: fieldLabel }).locator('xpath=..').locator('.chip')
}

/** 点详情页保存并等它真的落库（用 API 回读，不信任 UI 自己的状态）。 */
async function saveAndReread(page: Page, agentId: string, wasUpdatedAt: number): Promise<AgentRow> {
  await page.getByTestId('agent-save-button').click()
  await expect
    .poll(async () => (await getAgent(agentId)).updatedAt, { timeout: 30_000 })
    .toBeGreaterThan(wasUpdatedAt)
  return getAgent(agentId)
}

/** 资源详情页 More → Permissions。 */
async function openAclPanel(page: Page): Promise<Locator> {
  await page.getByTestId('detail-more-actions').click()
  const actions = page.getByTestId('detail-actions-dialog')
  await expect(actions).toBeVisible()
  await actions.getByTestId('acl-dialog-button').click()
  const panel = page.getByTestId('acl-panel')
  await expect(panel).toBeVisible()
  return panel
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  daemonHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-agent-res-'))
  // 「样例已经提供过」的标记：不种 RFC-307 的 demo 内容。AGENT-26 的自动探测是拿
  // **整个库存**去扫正文的，多出来的 demo 资源会让「没提到的不该被探测到」这条判据变糊。
  writeFileSync(join(daemonHome, '.demo-seeded'), `${String(Date.now())}\n`)
  daemon = await startDaemon({ home: daemonHome })
  fixtureDir = mkdtempSync(join(tmpdir(), 'rfc319-agent-res-files-'))
})

test.afterEach(async ({ page }) => {
  // 本文件一条注入都没有，但仍按 docs/dev-gotchas.md §「page.route 两把锁」的锁 B
  // 无条件摘一次：将来任何人往这里加注入时，不必再想起补这一句。
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (daemonHome !== undefined) rmSync(daemonHome, { recursive: true, force: true })
  if (fixtureDir !== undefined) rmSync(fixtureDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AGENT-24 —— 在界面上挑一条依赖，预览长出闭包，保存后真的落库
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-24: 在依赖选择器里挑一条代理 —— 预览当场长出二级闭包，保存后落库且重载仍在 @nightly', async ({
  page,
}) => {
  const leafSkill = await seedSkill(nextSlug('a24-leaf-skill'))
  const leaf = await seedAgent({
    name: nextSlug('a24-leaf'),
    skills: [{ kind: 'managed', skillId: leafSkill.id }],
  })
  const mid = await seedAgent({ name: nextSlug('a24-mid'), dependsOn: [leaf.id] })
  const root = await seedAgent({ name: nextSlug('a24-root') })

  await primeAuth(page)
  await openResourcesTab(page, root.id)

  // ① 起点：一条依赖都没有。没有这一格，下面的「树里有三行」可能只是因为树一直都在。
  await expect(
    page.getByRole('treeitem'),
    '还没挑任何依赖，闭包树里就已经有行了 ⇒ 后面「挑完树长出来」的断言失去意义',
  ).toHaveCount(0)
  await expect(page.locator('.dep-tree__empty')).toBeVisible()

  // ② 在选择器里挑 mid（**不是** leaf）。
  await pickCatalogOption(page, 'Agents it can collaborate with', mid.name)
  await expect(chipsOf(page, 'Agents it can collaborate with')).toHaveCount(1)

  // ③ 预览必须展开到**二级**：root → mid → leaf。只回显被挑中的那一条（两行）说明
  //    它没有真的去后端展开闭包，用户就看不出「挑一条会连带拉起谁」。
  const tree = page.getByRole('tree', { name: 'Dependency tree' })
  await expect(tree).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole('treeitem'),
    '闭包树没有展开到二级依赖 ⇒ 用户看不出挑这一条会连带把谁拉进运行期',
  ).toHaveCount(3)
  await expect(page.getByRole('treeitem', { name: root.name })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: mid.name })).toBeVisible()
  await expect(
    page.getByRole('treeitem', { name: leaf.name }),
    '二级依赖没出现在树里 ⇒ 预览只是把我刚挑的那一条回显了一遍',
  ).toBeVisible()
  // 叶子节点身上挂的能力也要一并显示——这是「拉起它会带进什么」的唯一提示。
  await expect(
    page.getByRole('treeitem', { name: leaf.name }),
    '闭包成员的能力 chip 没渲染 ⇒ 用户看不出这条依赖会把哪些技能带进运行期',
  ).toContainText(leafSkill.name)

  // ④ 保存 → 回读 DB。这一格是本条用例的核心：预览是纯读的，只有 PUT 才会写。
  const saved = await saveAndReread(page, root.id, root.updatedAt)
  expect(
    saved.dependsOn,
    '界面上挑了依赖、按了保存，DB 里的 dependsOn 却没变 ⇒ 用户以为编排好了，' +
      '任务真跑起来时下游代理根本不会被拉起来',
  ).toEqual([mid.id])

  // ⑤ 重载后仍在——用户下次进来看到的就是生效值。
  await openResourcesTab(page, root.id)
  await expect(
    chipsOf(page, 'Agents it can collaborate with'),
    '重载后依赖 chip 掉了 ⇒ 存上了但读不回来，用户会再挑一遍',
  ).toHaveCount(1)
  await expect(chipsOf(page, 'Agents it can collaborate with').first()).toContainText(mid.name)
  await expect(page.getByRole('treeitem')).toHaveCount(3)
})

// ---------------------------------------------------------------------------
// AGENT-25 —— 非法依赖的三种形态都必须被预览挡下来，并且一条都不落库
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-25: 成环 / 自依赖 / 引用看不见的代理 —— 预览一律 ok:false 并说明，保存也写不进去 @nightly', async ({
  page,
}) => {
  const upstream = await seedAgent({ name: nextSlug('a25-up') })
  const downstream = await seedAgent({ name: nextSlug('a25-down'), dependsOn: [upstream.id] })

  // ---- (a) 成环：给 upstream 挑上 downstream，就闭成了 up → down → up -------
  await primeAuth(page)
  await openResourcesTab(page, upstream.id)
  await pickCatalogOption(page, 'Agents it can collaborate with', downstream.name)

  const cycleHint = page.locator('.dep-tree__cycle')
  await expect(
    cycleHint,
    '把依赖连成环之后预览毫无反应 ⇒ 保存前唯一能发现这件事的地方哑掉了，' +
      '用户只会看到保存按钮吃一个不明所以的 400',
  ).toBeVisible({ timeout: 30_000 })
  await expect(cycleHint).toHaveAttribute('role', 'alert')
  // 环路要指得出是哪几个节点（cyclePath 是裸 id，agentDeps.ts:83 的注释写明了这一点）。
  await expect(
    cycleHint,
    '提示了「有环」却不说是哪条环 ⇒ 依赖多起来之后用户无从下手',
  ).toContainText(upstream.id)
  await expect(cycleHint).toContainText(downstream.id)
  await expect(
    page.getByRole('treeitem'),
    '既然是环，就不该同时再渲染一棵「正常」的闭包树出来',
  ).toHaveCount(0)

  // 保存也必须被服务端拦住，而且**拦住之后不能写**。
  await page.getByTestId('agent-save-button').click()
  await expect(
    page.locator('.error-box').first(),
    '成环的依赖保存下去毫无提示 ⇒ 用户不知道自己刚存了个会无限展开的闭包',
  ).toBeVisible({ timeout: 30_000 })
  expect(
    (await getAgent(upstream.id)).dependsOn,
    '拦了个响、数据照写 ⇒ 这是最坏的一档：界面报错、库里已经成环',
  ).toEqual([])

  // ---- (b) 自依赖：界面上挑不到自己（选择器把 selfId 过滤掉了），只能直打端点 ----
  const selfPreview = await json<ClosurePreviewRow>(
    daemon.token,
    '/api/agents/closure-preview',
    {
      method: 'POST',
      body: JSON.stringify({ id: upstream.id, name: upstream.name, dependsOn: [upstream.id] }),
    },
    'closure-preview self-reference',
  )
  expect(
    selfPreview.ok,
    '自依赖被预览判成合法 ⇒ 保存时才 400，而预览的全部价值就是「保存前就知道」',
  ).toBe(false)
  expect(selfPreview.code).toBe('agent-dependency-self')

  // ---- (c) 引用看不见的代理：alice 的私有代理对 bob 不可见 -------------------
  const alice = await seedUser(`a25-alice-${++sequence}`)
  const bob = await seedUser(`a25-bob-${++sequence}`)
  const alicePrivate = await seedAgent({ name: nextSlug('a25-private') }, alice.token)

  const hiddenPreview = await json<ClosurePreviewRow>(
    bob.token,
    '/api/agents/closure-preview',
    {
      method: 'POST',
      body: JSON.stringify({ name: nextSlug('a25-bob-draft'), dependsOn: [alicePrivate.id] }),
    },
    'closure-preview hidden dependency',
  )
  expect(
    hiddenPreview.ok,
    '引用了自己看不见的代理，预览却说没问题 ⇒ 用户会一直存不下去而不知道为什么，' +
      '更糟的是预览可能顺手把那条私有代理的名字回显给他',
  ).toBe(false)
  expect(hiddenPreview.code).toBe('acl-missing-refs')
  // 回显的是**输入的那个 token**（resourceRefs.ts:411 的 D1 规则），不是那条私有代理的
  // 展示名——把 name 换成 row.name 只会让这条错误信息本身变成一次泄露。
  expect(hiddenPreview.details?.missing).toEqual([{ type: 'agent', name: alicePrivate.id }])
  expect(
    JSON.stringify(hiddenPreview),
    '预览的响应体里出现了那条私有代理的名字 ⇒ 不可见资源的存在性从错误信息里泄露了出去',
  ).not.toContain(alicePrivate.name)

  // 而 alice 自己预览同一条是合法的——证明上面那条 false 是**权限**造成的，不是这条 id 坏了。
  const ownerPreview = await json<ClosurePreviewRow>(
    alice.token,
    '/api/agents/closure-preview',
    {
      method: 'POST',
      body: JSON.stringify({ name: nextSlug('a25-alice-draft'), dependsOn: [alicePrivate.id] }),
    },
    'closure-preview owner',
  )
  expect(
    ownerPreview.ok,
    '连所有者自己都预览不了这条依赖 ⇒ 上一格的 ok:false 不能归因到可见性',
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// AGENT-26 —— 依赖自动探测：扫正文 → 逐项勾选 → 合并进四组 → 保存落库
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-26: 自动探测只捞正文里真提到的库存，勾掉的那一条不许合并，勾上的保存后落库 @nightly', async ({
  page,
}) => {
  const mentionedSkill = await seedSkill(nextSlug('a26-mentioned-skill'))
  const decoySkill = await seedSkill(nextSlug('a26-decoy-skill'))
  const mentionedMcp = await seedMcp(nextSlug('a26-mentioned-mcp'))
  const mentionedAgent = await seedAgent({ name: nextSlug('a26-mentioned-agent') })

  // 正文提到三条（技能 / MCP / 代理），**没提**诱饵技能，也没提任何插件。
  const subject = await seedAgent({
    name: nextSlug('a26-subject'),
    bodyMd: [
      'Delegate the audit to ' + mentionedAgent.name + ' when the diff is large.',
      'Follow ' + mentionedSkill.name + ' for the report format.',
      'Query ' + mentionedMcp.name + ' for upstream facts.',
    ].join('\n'),
  })

  await primeAuth(page)
  await openResourcesTab(page, subject.id)
  await page.getByTestId('agent-dep-autodetect-button').click()
  const dialog = page.getByTestId('agent-dep-autodetect-dialog')
  await expect(dialog).toBeVisible()

  // ① 三个提到的各自成候选，**没提到的一个都不许出现**。这一格是整条用例的判据核心：
  //    扫描退化成「把库存全列出来」时它会红。
  await expect(dialog.getByTestId(`autodetect-checkbox-agents-${mentionedAgent.id}`)).toBeVisible()
  await expect(dialog.getByTestId(`autodetect-checkbox-skills-${mentionedSkill.id}`)).toBeVisible()
  await expect(dialog.getByTestId(`autodetect-checkbox-mcps-${mentionedMcp.id}`)).toBeVisible()
  await expect(
    dialog.getByTestId(`autodetect-checkbox-skills-${decoySkill.id}`),
    '正文里根本没提到的技能也被探测成了候选 ⇒ 用户点一下「导入」就会莫名其妙多出一堆挂载，' +
      '而每一条都会进运行期配置',
  ).toHaveCount(0)
  await expect(
    dialog.getByTestId('autodetect-section-plugins'),
    '一个插件都没提到，插件分组却还渲染着 ⇒ 分组是按「有没有候选」显示的，说明候选算错了',
  ).toHaveCount(0)

  // ② 打开时全部预勾（DependencyAutodetectDialog.tsx:34-40）。把 MCP 那条**取消**，
  //    它就不该被合并——复选框要是摆设，用户对导入内容完全失去控制。
  const mcpCheckbox = dialog.getByTestId(`autodetect-checkbox-mcps-${mentionedMcp.id}`)
  await expect(mcpCheckbox).toBeChecked()
  await mcpCheckbox.uncheck()
  await expect(mcpCheckbox).not.toBeChecked()

  await dialog.getByTestId('autodetect-apply').click()
  await expect(dialog, '点了导入弹窗还开着 ⇒ 用户会以为没生效再点一次').toHaveCount(0)

  // ③ 合并结果先在草稿里可见：代理 + 技能各一枚 chip，MCP 一枚都没有。
  await expect(chipsOf(page, 'Agents it can collaborate with')).toHaveCount(1)
  await expect(chipsOf(page, 'Skills')).toHaveCount(1)
  await expect(
    chipsOf(page, 'MCP servers'),
    '取消勾选的那一条照样被合并进了草稿 ⇒ 复选框是个摆设',
  ).toHaveCount(0)

  // ④ 保存 → 回读 DB。技能那一格顺带锁住联合类型的编码（`{kind:'managed'}`）——
  //    编错了就是一条指向空气的引用，而界面上看起来一切正常。
  const saved = await saveAndReread(page, subject.id, subject.updatedAt)
  expect(saved.dependsOn, '探测勾中的代理没落库').toEqual([mentionedAgent.id])
  expect(saved.skills, '探测勾中的技能没按 managed 引用落库 ⇒ 运行期拿不到这条技能').toEqual([
    { kind: 'managed', skillId: mentionedSkill.id },
  ])
  expect(saved.mcp, '取消勾选的 MCP 还是被写进了库 ⇒ 用户挂上了一台自己没同意挂的服务器').toEqual(
    [],
  )
})

// ---------------------------------------------------------------------------
// RES-X1 —— 三类 Picker 一次挂上、一次保存、三类都落库并被消费方认出来
// ---------------------------------------------------------------------------

test('RFC-319 RES-X1: 技能 / MCP / 插件三个选择器挂完一次保存 —— 三类都落库，且引用状态端点逐条认得出来 @nightly', async ({
  page,
}) => {
  const skill = await seedSkill(nextSlug('resx1-skill'))
  const mcp = await seedMcp(nextSlug('resx1-mcp'))
  const plugin = await seedPlugin(nextSlug('resx1-plugin'))
  const agent = await seedAgent({ name: nextSlug('resx1-agent') })

  await primeAuth(page)
  await openResourcesTab(page, agent.id)

  // ① 起点：三个 Picker 都空。没有这一格，「挂上之后有一枚 chip」可能一直成立。
  for (const label of ['Skills', 'MCP servers', 'Plugins']) {
    await expect(chipsOf(page, label), `${label} 一开始就不是空的 ⇒ 夹具不干净`).toHaveCount(0)
  }
  expect((await getResourceStatus(agent.id)).references).toEqual([])

  // ② 三个 Picker 各挑一条，然后**只按一次保存**。
  await pickCatalogOption(page, 'Skills', skill.name)
  await pickCatalogOption(page, 'MCP servers', mcp.name)
  await pickCatalogOption(page, 'Plugins', plugin.name)

  const saved = await saveAndReread(page, agent.id, agent.updatedAt)

  // ③ 三类各自的落库形状。技能是联合类型（`managed:` 前缀要在前端编解码），
  //    另外两类是裸 id 数组——任意一格漏拷，用户在界面上明明挂了、运行期却没有。
  expect(
    saved.skills,
    '技能没按 managed 引用落库 ⇒ 前端的 `managed:` 编解码坏了，这条引用指向空气',
  ).toEqual([{ kind: 'managed', skillId: skill.id }])
  expect(saved.mcp, 'MCP 没落库 ⇒ 运行期不会挂载这台服务器').toEqual([mcp.id])
  expect(saved.plugins, '插件没落库 ⇒ 运行期不会注入这个插件').toEqual([plugin.id])

  // ④ 「真的生效」的判据不是 DB 里那一行，而是**消费这份配置的那个端点**：
  //    resource-status 是保存/启动/运行三处共用的完整性视图（agentResourceIntegrity.ts）。
  //    它逐条认出这三个引用、状态都是 available，才说明这份配置进入了运行期判据。
  const status = await getResourceStatus(agent.id)
  expect(
    status.references.map((ref) => [ref.kind, ref.refId, ref.name, ref.state]),
    '落库了但引用状态端点认不出来 ⇒ 启动前的完整性检查根本没看见这三条挂载',
  ).toEqual([
    ['skill', skill.id, skill.name, 'available'],
    ['mcp', mcp.id, mcp.name, 'available'],
    ['plugin', plugin.id, plugin.name, 'available'],
  ])
  expect(status.ok).toBe(true)

  // ⑤ 重载后三枚 chip 都回显——用户下次进来看到的就是生效值。
  await openResourcesTab(page, agent.id)
  await expect(chipsOf(page, 'Skills').first()).toContainText(skill.name)
  await expect(chipsOf(page, 'MCP servers').first()).toContainText(mcp.name)
  await expect(chipsOf(page, 'Plugins').first()).toContainText(plugin.name)
})

// ---------------------------------------------------------------------------
// AGENT-36 —— 引用坏掉时「启动任务」按钮必须从可点链接变成带原因的禁用按钮
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-36: 引用失效前后 —— 启动任务从可点链接变成带原因 tooltip 的禁用按钮 @nightly', async ({
  page,
}) => {
  const plugin = await seedPlugin(nextSlug('a36-plugin'))
  const agent = await seedAgent({ name: nextSlug('a36-agent'), plugins: [plugin.id] })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)

  // ① 健康态：按钮是一个**链接**，点得动，指向任务向导并带上这个代理。
  const launch = page.getByTestId('agent-launch-button')
  await expect(launch).toBeVisible({ timeout: 60_000 })
  await expect(
    launch,
    '引用完好时启动入口就不是链接 ⇒ 后面「坏了之后变禁用按钮」的对照失去意义',
  ).toHaveAttribute('href', new RegExp(`/tasks/new\\?.*agentId=${agent.id}`))
  await expect(launch).not.toBeDisabled()
  await expect(
    launch,
    '引用完好时就挂着「引用无效」的 tooltip ⇒ 这条提示与真实状态无关，等于恒真',
  ).not.toHaveAttribute('title', /Resource references are invalid/)

  // ② 把被引用的插件停用——这是真路径，不需要任何 mock（插件 PUT 就能关）。
  const disabled = await raw(daemon.token, `/api/plugins/${plugin.id}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: false, expectedConfigHash: plugin.operationConfigHash }),
  })
  expect(disabled.status, `停用插件失败：${disabled.body}`).toBe(200)
  expect(
    (await getResourceStatus(agent.id)).ok,
    '插件停用后引用状态仍然是 ok ⇒ 本用例的前提不成立，后面断言的不是「坏了之后」',
  ).toBe(false)

  await page.reload()

  // ③ 坏态：同一个 testid 变成一颗**禁用的 button**，并把原因写进 tooltip。
  //    三格缺一不可：还渲染成链接 ⇒ 用户点得进去，建了任务、等它跑、拿一个运行期错误；
  //    渲染成 button 但没 disabled ⇒ 同上；有 disabled 没 title ⇒ 用户对着灰按钮不知道去修什么。
  const blocked = page.getByTestId('agent-launch-button')
  await expect(blocked).toBeVisible({ timeout: 60_000 })
  await expect(
    blocked,
    '引用坏掉后启动入口还是可点的链接 ⇒ 用户会建一个注定失败的任务',
  ).not.toHaveAttribute('href', /.+/)
  await expect(blocked, '引用坏掉后启动按钮没有被禁用 ⇒ 同上，只是换了个标签名').toBeDisabled()
  await expect(
    blocked,
    '禁用了却不说为什么 ⇒ 用户对着一颗灰按钮，不知道该去修哪条引用',
  ).toHaveAttribute(
    'title',
    'Resource references are invalid, so this Agent cannot launch until they are fixed',
  )

  // ④ 修好（重新启用插件）之后必须恢复——否则这颗按钮就是个单向阀门。
  const fresh = await json<HashedRow>(
    daemon.token,
    `/api/plugins/${plugin.id}`,
    undefined,
    'reread plugin',
  )
  const reenabled = await raw(daemon.token, `/api/plugins/${plugin.id}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, expectedConfigHash: fresh.operationConfigHash }),
  })
  expect(reenabled.status, `重新启用插件失败：${reenabled.body}`).toBe(200)

  await page.reload()
  await expect(
    page.getByTestId('agent-launch-button'),
    '修好引用之后启动入口没有恢复成链接 ⇒ 代理一旦坏过一次就再也启动不了了',
  ).toHaveAttribute('href', new RegExp(`/tasks/new\\?.*agentId=${agent.id}`), { timeout: 60_000 })
})

// ---------------------------------------------------------------------------
// AGENT-45 —— 框架内置代理的写面：runtime-only 是唯一被许可的口子
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-45: 内置代理只放行 runtime-only 补丁 —— 混进任何第二个键就 403，且被拒那次一个字都没写 @nightly', async ({
  page,
}) => {
  const readBuiltin = (): Promise<AgentRow> =>
    json<AgentRow>(
      daemon.token,
      '/api/agents/builtins/skill-merger',
      undefined,
      'read builtin merger',
    )
  const builtin = await readBuiltin()
  expect(builtin.id, '内置融合代理不在它的确定性 id 上 ⇒ 本用例打的不是那一行').toBe(
    BUILTIN_MERGER_AGENT_ID,
  )
  /** 每发一次写都取一份**当下**的 fence，这样被拒不是因为 fence 陈旧。 */
  const fenceOf = async (): Promise<{ expectedUpdatedAt: number; expectedAclRevision: number }> => {
    const row = await readBuiltin()
    return { expectedUpdatedAt: row.updatedAt, expectedAclRevision: row.aclRevision ?? 0 }
  }

  // ① runtime-only：唯一被许可的写路径（设置页的「融合运行时」走的就是它）。
  const put = await raw(daemon.token, `/api/agents/${BUILTIN_MERGER_AGENT_ID}`, {
    method: 'PUT',
    body: JSON.stringify({ runtime: 'claude-code', ...(await fenceOf()) }),
  })
  expect(
    put.status,
    `runtime-only 补丁被拒了 ⇒ 设置页的「融合运行时」这一格永远存不下去：${put.body}`,
  ).toBe(200)
  expect(
    (
      await json<AgentRow>(
        daemon.token,
        '/api/agents/builtins/skill-merger',
        undefined,
        'reread after runtime patch',
      )
    ).runtime,
    'runtime-only 补丁回了 200，值却没落库 ⇒ 用户改完看不出没生效',
  ).toBe('claude-code')

  // ② 混合补丁：body 里只要多一个键，整发就被拒。判据按**原始 body** 而不是解析后的
  //    patch（routes/agents.ts:80-87），所以「顺手带一个 description」不是灰色地带。
  const mixed = await raw(daemon.token, `/api/agents/${BUILTIN_MERGER_AGENT_ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      runtime: 'opencode',
      description: 'rfc319 must not land',
      ...(await fenceOf()),
    }),
  })
  expect(
    mixed.status,
    `runtime 里夹带了 description 却放行了 ⇒ 内置代理的 Prompt / 端口都能被改坏，` +
      `而它连列表都不进、没人找得到去修哪：${mixed.body}`,
  ).toBe(403)
  expect(codeOf(mixed.body)).toBe('builtin-readonly')

  // ③ 被拒那次**一个字都不许写**：runtime 仍是上一步存进去的值。
  const afterMixed = await json<AgentRow>(
    daemon.token,
    '/api/agents/builtins/skill-merger',
    undefined,
    'reread after refused mixed patch',
  )
  expect(
    afterMixed.runtime,
    '混合补丁被拒了，runtime 却跟着改了 ⇒ 守卫跑在写之后，403 只是个装饰',
  ).toBe('claude-code')
  expect(afterMixed.description, '混合补丁被拒了，description 却写进去了').toBe(builtin.description)

  // ④ 不含 runtime 的普通内容补丁：同样 403。
  const contentOnly = await raw(daemon.token, `/api/agents/${BUILTIN_MERGER_AGENT_ID}`, {
    method: 'PUT',
    body: JSON.stringify({ description: 'rfc319 content-only', ...(await fenceOf()) }),
  })
  expect(contentOnly.status, `内置行的普通内容写没被拒：${contentOnly.body}`).toBe(403)
  expect(codeOf(contentOnly.body)).toBe('builtin-readonly')

  // ⑤ 改名与删除是治理动作，内置身份高于归属——管理员也不行。
  const renamed = await raw(daemon.token, `/api/agents/${BUILTIN_MERGER_AGENT_ID}/rename`, {
    method: 'POST',
    body: JSON.stringify({ newName: nextSlug('a45-renamed'), ...(await fenceOf()) }),
  })
  expect(renamed.status, `内置代理被改名了：${renamed.body}`).toBe(403)
  expect(codeOf(renamed.body)).toBe('builtin-readonly')

  const deleted = await raw(daemon.token, `/api/agents/${BUILTIN_MERGER_AGENT_ID}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: builtin.name, ...(await fenceOf()) }),
  })
  expect(
    deleted.status,
    `内置代理被删掉了 ⇒ 全平台的技能融合链路当场断掉，且没有任何界面能把它建回来：${deleted.body}`,
  ).toBe(403)
  expect(codeOf(deleted.body)).toBe('builtin-readonly')
  expect(
    (
      await json<AgentRow>(
        daemon.token,
        '/api/agents/builtins/skill-merger',
        undefined,
        'reread after refused delete',
      )
    ).name,
    '删除被拒之后内置行的名字变了 ⇒ 拒绝分支里混进了写',
  ).toBe(builtin.name)

  // ⑥ 用户面：这一行始终不进代理列表（内置是基础设施，不是可管理的行）。
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents`)
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible({ timeout: 60_000 })
  await expect(
    // 按卡片自己的 testid 定位，不按可访问名：`ResourceSplitPage` 的卡是整块 `<Link>`，
    // 可访问名是卡内全部文字拼起来的，`{ name: 'aw-skill-merger', exact: true }`
    // **在场也匹配不到**，那样写出来的是一条恒真断言。
    page.getByTestId(`split-card-${BUILTIN_MERGER_AGENT_ID}`),
    '内置代理出现在用户面列表里 ⇒ 用户会以为它可编辑，点进去每一次保存都吃 403',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// AGENT-44 / RES-X6 —— 三类资源的 rename 端点（前端零调用方，只有 API 用户在用）
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-44/RES-X6: 代理 / MCP / 插件改名后引用按 id 全程不断，重名与陈旧 fence 各自被拒 @nightly', async ({
  page: _page,
}) => {
  const mcp = await seedMcp(nextSlug('x6-mcp'))
  const plugin = await seedPlugin(nextSlug('x6-plugin'))
  const target = await seedAgent({ name: nextSlug('a44-target') })
  const consumer = await seedAgent({
    name: nextSlug('a44-consumer'),
    dependsOn: [target.id],
    mcp: [mcp.id],
    plugins: [plugin.id],
  })
  const occupied = await seedAgent({ name: nextSlug('a44-occupied') })

  // ---- 代理改名 ------------------------------------------------------------
  const newAgentName = nextSlug('a44-renamed')
  const renamed = await json<AgentRow>(
    daemon.token,
    `/api/agents/${target.id}/rename`,
    {
      method: 'POST',
      body: JSON.stringify({
        newName: newAgentName,
        expectedUpdatedAt: target.updatedAt,
        expectedAclRevision: target.aclRevision ?? 0,
      }),
    },
    'rename agent',
  )
  expect(renamed.name, '改名端点回了 200，名字却没变').toBe(newAgentName)

  // 引用是 id-canonical 的：改名只动显示元数据，引用它的代理**一格都不该受影响**。
  const consumerAfter = await getAgent(consumer.id)
  expect(
    consumerAfter.dependsOn,
    '被引用的代理改了个名，引用方的 dependsOn 就变了 ⇒ 引用是按名字绑的，' +
      '改一次名就会把编排悄悄改指向别处或者干脆断掉',
  ).toEqual([target.id])
  const consumerStatus = await getResourceStatus(consumer.id)
  expect(
    consumerStatus.ok,
    '被引用的代理改名之后，引用方的完整性检查判它坏了 ⇒ 改名把编排改断了',
  ).toBe(true)
  expect(
    consumerStatus.references.find((ref) => ref.kind === 'agent')?.name,
    '引用方读到的仍是旧名字 ⇒ 界面上会一直显示一个已经不存在的名字',
  ).toBe(newAgentName)

  // 同一 owner 域内重名要被拒——漏了就会出现两条同名资源，此后按名字的人工排查全指错人。
  const fresh = await getAgent(target.id)
  const collision = await raw(daemon.token, `/api/agents/${target.id}/rename`, {
    method: 'POST',
    body: JSON.stringify({
      newName: occupied.name,
      expectedUpdatedAt: fresh.updatedAt,
      expectedAclRevision: fresh.aclRevision ?? 0,
    }),
  })
  expect(collision.status, `改成一个已被占用的名字却成功了：${collision.body}`).toBe(409)
  expect(codeOf(collision.body)).toBe('agent-name-in-use')
  expect((await getAgent(target.id)).name, '重名被拒之后名字还是被改了').toBe(newAgentName)

  // 陈旧 fence：拿改名前的 updatedAt 再来一次，必须 409。
  const stale = await raw(daemon.token, `/api/agents/${target.id}/rename`, {
    method: 'POST',
    body: JSON.stringify({
      newName: nextSlug('a44-stale'),
      expectedUpdatedAt: target.updatedAt,
      expectedAclRevision: target.aclRevision ?? 0,
    }),
  })
  expect(
    stale.status,
    `拿几分钟前的快照改名却放行了 ⇒ 我改的根本不是我看到的那个东西：${stale.body}`,
  ).toBe(409)
  expect(codeOf(stale.body)).toBe('resource-operation-stale')
  expect((await getAgent(target.id)).name).toBe(newAgentName)

  // ---- MCP / 插件改名（RES-X6）---------------------------------------------
  const newMcpName = nextSlug('x6-mcp-renamed')
  const mcpRenamed = await json<HashedRow>(
    daemon.token,
    `/api/mcps/${mcp.id}/rename`,
    {
      method: 'POST',
      body: JSON.stringify({ newName: newMcpName, expectedConfigHash: mcp.operationConfigHash }),
    },
    'rename mcp',
  )
  expect(mcpRenamed.name).toBe(newMcpName)

  const newPluginName = nextSlug('x6-plugin-renamed')
  const pluginRenamed = await json<HashedRow>(
    daemon.token,
    `/api/plugins/${plugin.id}/rename`,
    {
      method: 'POST',
      body: JSON.stringify({
        newName: newPluginName,
        expectedConfigHash: plugin.operationConfigHash,
      }),
    },
    'rename plugin',
  )
  expect(pluginRenamed.name).toBe(newPluginName)

  // 引用方三类引用全都按 id 存活，且读到的是新名字。
  const afterAll = await getAgent(consumer.id)
  expect(afterAll.mcp, 'MCP 改名把引用方的挂载改断了').toEqual([mcp.id])
  expect(afterAll.plugins, '插件改名把引用方的挂载改断了').toEqual([plugin.id])
  const finalStatus = await getResourceStatus(consumer.id)
  expect(
    finalStatus.references.map((ref) => [ref.kind, ref.name, ref.state]),
    '三类资源改名之后，引用方的完整性视图没有跟着更新 ⇒ 界面上永远显示旧名字，' +
      '或者更糟：把还在的引用报成坏的',
  ).toEqual([
    ['mcp', newMcpName, 'available'],
    ['plugin', newPluginName, 'available'],
    ['agent', newAgentName, 'available'],
  ])

  // 陈旧 hash：MCP / 插件的 rename 各自带 expectedConfigHash 闸。
  const staleMcp = await raw(daemon.token, `/api/mcps/${mcp.id}/rename`, {
    method: 'POST',
    body: JSON.stringify({
      newName: nextSlug('x6-mcp-stale'),
      expectedConfigHash: mcp.operationConfigHash,
    }),
  })
  expect(staleMcp.status, `MCP 拿陈旧 hash 改名却成功了：${staleMcp.body}`).toBe(409)
  expect(codeOf(staleMcp.body)).toBe('resource-operation-stale')

  const stalePlugin = await raw(daemon.token, `/api/plugins/${plugin.id}/rename`, {
    method: 'POST',
    body: JSON.stringify({
      newName: nextSlug('x6-plugin-stale'),
      expectedConfigHash: plugin.operationConfigHash,
    }),
  })
  expect(stalePlugin.status, `插件拿陈旧 hash 改名却成功了：${stalePlugin.body}`).toBe(409)
  expect(codeOf(stalePlugin.body)).toBe('resource-operation-stale')

  const untouched = await getAgent(consumer.id)
  expect(untouched.mcp, '被拒的改名把引用方改坏了').toEqual([mcp.id])
})

// ---------------------------------------------------------------------------
// RES-X2 —— 技能 / MCP / 插件三类的所有者转让（Permissions 弹窗）
// ---------------------------------------------------------------------------

test('RFC-319 RES-X2: 技能 / MCP / 插件各自转让一次 —— 只有被转的那类换主，前任降级为只读 @nightly', async ({
  browser,
}) => {
  const alice = await seedUser(`x2-alice-${++sequence}`)
  const heir = await seedUser(`x2-heir-${++sequence}`)

  const skill = await seedSkill(nextSlug('x2-skill'), alice.token)
  const mcp = await seedMcp(nextSlug('x2-mcp'), alice.token)
  const plugin = await seedPlugin(nextSlug('x2-plugin'), alice.token)

  const targets = [
    { base: 'skills', route: 'skills', row: skill },
    { base: 'mcps', route: 'mcps', row: mcp },
    { base: 'plugins', route: 'plugins', row: plugin },
  ] as const

  for (const target of targets) {
    expect(
      (await getAcl(target.base, target.row.id)).ownerUserId,
      `${target.base} 的创建者不是 alice ⇒ 本用例的转让前提不成立`,
    ).toBe(alice.userId)
  }

  const aliceSide = await openAs(browser, alice.token)
  try {
    for (const [index, target] of targets.entries()) {
      await aliceSide.page.goto(`${daemon.baseUrl}/${target.route}/${target.row.id}`)
      const panel = await openAclPanel(aliceSide.page)
      await expect(panel).toContainText(alice.username)

      await aliceSide.page.getByTestId('acl-transfer-owner').click()
      const input = aliceSide.page.getByTestId('acl-transfer-input')
      await expect(input).toBeVisible()
      await input.fill(heir.username)
      await aliceSide.page.getByTestId(`acl-transfer-option-${heir.username}`).click()
      await aliceSide.page.getByTestId('acl-transfer-confirm').click()
      await expect(
        aliceSide.page.getByTestId('acl-transfer-dialog'),
        `${target.base} 的转让确认之后弹窗还开着 ⇒ 用户不知道成没成，会再点一次`,
      ).toHaveCount(0, { timeout: 30_000 })

      // ① 服务端真值：这一类换了主，前任降级为 read（不是被踢光）。
      await expect
        .poll(async () => (await getAcl(target.base, target.row.id)).ownerUserId, {
          timeout: 30_000,
        })
        .toBe(heir.userId)
      const acl = await getAcl(target.base, target.row.id)
      expect(
        acl.grants.map((grant) => [grant.user.username, grant.level]),
        `${target.base} 转让把前任彻底踢光了 ⇒ 他连自己刚交出去的东西都看不见` +
          '（产品规则是降级为只读，resourceAcl.ts:878-891）',
      ).toEqual([[alice.username, 'read']])

      // ② 交叉核对：**只有**被转的那一类换主。三个详情页各自往 DetailHeaderActions
      //    接 `acl.resourceBaseUrl`，接错一条就会「在插件页点转让、改掉的是 MCP 的归属」。
      for (const other of targets.slice(index + 1)) {
        expect(
          (await getAcl(other.base, other.row.id)).ownerUserId,
          `转让 ${target.base} 顺手把 ${other.base} 的归属也改了 ⇒ 某个详情页把 ` +
            'acl 的 resourceBaseUrl 接到了别的资源上',
        ).toBe(alice.userId)
      }

      // ③ 前任这一侧当场降级：治理键消失。
      await expect(
        aliceSide.page.getByTestId('acl-save'),
        `交出 ${target.base} 的所有权后前任仍有「保存权限」键 ⇒ 他还能改这份资源的授权名单`,
      ).toHaveCount(0)
      await expect(
        aliceSide.page.getByTestId('acl-transfer-owner'),
        `交出 ${target.base} 的所有权后前任仍能再转让一次 ⇒ 治理权没跟着所有权走`,
      ).toHaveCount(0)
    }
  } finally {
    await aliceSide.context.close()
  }

  // ④ 新主这一侧：三类都进得去、都能治理。转让要是只改了记录不改控制权，
  //    这份资源的授权从此没人能改，等于锁死。
  const heirSide = await openAs(browser, heir.token)
  try {
    for (const target of targets) {
      await heirSide.page.goto(`${daemon.baseUrl}/${target.route}/${target.row.id}`)
      const panel = await openAclPanel(heirSide.page)
      await expect(panel, `${target.base} 的权限面板里的主人不是新主`).toContainText(heir.username)
      await expect(
        heirSide.page.getByTestId('acl-save'),
        `${target.base} 的新主人拿不到治理权 ⇒ 这份资源的授权从此没人能改`,
      ).toBeVisible()
      await expect(
        panel.getByTestId(`acl-members-remove-${alice.username}`),
        `${target.base} 的前任没有作为成员出现在新主的名单里 ⇒ 新主看不到还有谁能读它`,
      ).toBeVisible()
    }
  } finally {
    await heirSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// AGENT-28 —— agent.md 导入的**上传**路径 + 扩展名校验
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-28: 上传非 .md 文件当场被拒且检查键按不动，换成真 .md 后文件名兜底填进 Name @nightly', async ({
  page,
}) => {
  const stem = nextSlug('a28-from-filename')
  const goodPath = join(fixtureDir, `${stem}.md`)
  const badPath = join(fixtureDir, `${stem}.txt`)
  // 刻意**不写** `name:`：agent.md 惯例上就是不写名字的，名字由文件名兜底
  // （`agentMarkdownFilenameStem`）。这条兜底只存在于上传路径——粘贴路径没有文件名，
  // 所以 e2e/agent-import.spec.ts 那条永远照不到它。
  const markdown = [
    '---',
    'description: Imported from a real uploaded file',
    'outputs: [result]',
    '---',
    'Review the supplied changes and explain every material risk.',
  ].join('\n')
  writeFileSync(goodPath, markdown, 'utf-8')
  writeFileSync(badPath, markdown, 'utf-8')

  const agentCreates: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents') {
      agentCreates.push(request.url())
    }
  })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await page.getByTestId('agent-import-open').click()
  const dialog = page.getByTestId('agent-import-dialog')
  await expect(dialog).toBeVisible()

  const fileInput = page.getByTestId('agent-import-file')
  const parse = page.getByTestId('agent-import-parse')

  // ① 起点：还没选文件，检查键就该是按不动的。
  await expect(parse, '没选文件「检查内容」就可点 ⇒ 后面「被拒之后按不动」不能归因').toBeDisabled()

  // ② 扩展名不符：文件**不被接受**（不是先收下再报错），错误就地播报。
  //    内容其实是一份合法的 agent.md——所以这一格锁的确实是扩展名闸，不是解析失败。
  await fileInput.setInputFiles(badPath)
  await expect(
    dialog.locator('.file-dropzone__error'),
    '扩展名不符的文件被静静吃掉了 ⇒ 用户点「检查内容」没反应，不知道哪里出了问题',
  ).toHaveText('Choose a .md or .markdown file.')
  await expect(dialog.locator('.file-dropzone__error')).toHaveAttribute('role', 'alert')
  await expect(
    parse,
    '扩展名不符的文件仍然让「检查内容」可点 ⇒ 一个 .zip / .png 会被当成 markdown 读进来解析',
  ).toBeDisabled()
  await expect(
    page.getByTestId('agent-import-file-remove'),
    '被拒的文件还是被挂进了选择区 ⇒ 用户以为它已经被接受了',
  ).toHaveCount(0)

  // ③ 换成真 .md：走完 检查 → 审阅 → 应用到草稿。
  await fileInput.setInputFiles(goodPath)
  await expect(dialog.locator('.file-dropzone__error')).toHaveCount(0)
  await expect(parse).toBeEnabled()
  await parse.click()

  await expect(page.getByTestId('agent-import-review-heading')).toBeFocused()
  await expect(
    dialog.getByTestId('agent-import-item-name'),
    '上传路径没有把文件名兜底成 name ⇒ 按 agent.md 惯例（不写 name）导入的草稿名字是空的',
  ).toContainText(stem)

  await page.getByTestId('agent-import-apply').click()
  await expect(page.getByTestId('agent-import-result-heading')).toBeFocused()
  await page.getByTestId('agent-import-view-form').click()
  await expect(dialog).toHaveCount(0)

  // ④ 落到表单上的就是文件名 + 文件里的描述；而且导入**只改草稿**，一条记录都没建。
  await expect(
    page.getByRole('textbox', { name: 'Name' }),
    '上传导入没有把文件名填进 Name ⇒ 用户拿到一个名字为空的草稿',
  ).toHaveValue(stem)
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Imported from a real uploaded file',
  )
  expect(
    agentCreates,
    '导入过程中就把代理建出来了 ⇒ 用户只是想看看这份文件里有什么，库里已经多了一条',
  ).toEqual([])
  expect(
    (await json<AgentRow[]>(daemon.token, '/api/agents', undefined, 'list agents')).some(
      (row) => row.name === stem,
    ),
    '导入只应改草稿，库里却真的多了一行',
  ).toBe(false)
})
