// RFC-319 —— 技能 / MCP / 插件管理面里**剩下的那一半**：拒绝路径。
//
// 覆盖能力账本 RES-18、RES-27、RES-31、RES-34、RES-35、RES-36、RES-38、RES-40、RES-41
// 九行（账本里全部是 gap）。九条全是 P2 / P3，所以每条 test 标题末尾都带 ` @nightly`
// ——PR 腿跑的是 `--grep-invert '@nightly'`，这些用例只在夜跑的全量腿上跑；账本的
// `tierWiringMismatches` 守卫会逐字核对这个 tag 与 `tier: 'nightly'` 是否一致。
//
// 本文件的选题原则：**只挑禁用分支 / 拒绝路径**。本仓的既有 e2e 几乎只走成功路——
// 「点了、成了、界面变了」——而这九格问的都是反面：**该拦的时候拦住了吗，拦住之后
// 说清楚了吗，被拦住的那次有没有把脏数据顺手写进去**。按仓规「禁用分支与正向功能同等
// 对待」，这些格子最容易出真缺陷。
//
// 与既有 e2e 的分工（**刻意不重叠**）：
//   * `e2e/rfc319-mcp-management.spec.ts` —— MCP / 插件的**新建、保存、探测、停用、抢写**。
//     它的头注释第 11 行逐字写着「本文件 RES-18 一次都不删 MCP」，所以删除的拒绝面至今无人写。
//     本文件反过来：一次探测都不做、一次 enabled 开关都不碰。
//   * `e2e/rfc223-tenant-identity.spec.ts` 的
//     `admin same-name MCP actions remain bound to the selected tenant id`
//     ——它锁的是**同名 MCP 的租户绑定**，删除只是它的载体动作：通篇没有
//     `expectedConfigHash` / `resource-operation-stale` / `toBeDisabled`，走的是一条
//     「名字打对、没人抢写、没人引用」的直路。本文件的 RES-18 只补它没有的三道闸
//     （名字打错 / 背后被人改过 / 还被代理引用着），成功路只用来证明前三道闸不是把功能
//     整个拦死了。
//   * `e2e/config-package-import.spec.ts`（RES-39）—— 导入的**预览 → 逐项决策 → 提交**
//     三段，全程用 agent 包在 `/agents/new` 走。它从没制造过根类型错配（RES-41），
//     也从没让包里带过一条密钥（RES-40），更没走过导出按钮（RES-38）。
//   * `e2e/rfc319-skills-management.spec.ts` —— 技能的手动新建 / ZIP 错误态 / 版本历史 /
//     列表搜索 / 离开守卫 / 无写权收敛。本文件一条技能 ZIP、一次列表搜索都不碰。
//   * `package-import-secrets` / `package-secret-0` / `package-import-root-mismatch` /
//     `package-import-skipped-secrets` / `export-package-mcp` / `export-package-plugin` /
//     `plugin-check-update` / `plugin-upgrade` / `plugin-update-empty` /
//     `plugin-field-options-error` 这些 testid 与选择器，在本文件之前的全仓 e2e 里
//     **一次都没出现过**。
//
// 各条断言失效时**用户会遭遇什么**（这是每条用例存在的理由，不是断言在做什么）：
//
//   * RES-27 —— 动态加载变量能在被声明的那条命令自己的启动逻辑跑起来之前把代码换掉。
//     闸门漏了 ⇒ 任何能编辑 MCP 的人都能让 daemon 在本机加载任意 .so；闸门收得过紧 ⇒
//     `API_KEY` / `token` 这种**服务器真在用**的普通变量被拒，用户的正常配置存不进去
//     ——RFC-242 那次事故正是后者，所以这条用例把「拒得对」与「不该拒的别拒」一起锁。
//   * RES-18 / RES-36 —— 删除是不可逆的。三道闸各自失效的后果不同：名字闸漏了 ⇒ 手滑点
//     两下就没了；hash 闸漏了 ⇒ 别人刚改完的那一版被你按着几分钟前的印象删掉，你删的
//     根本不是你看到的那个东西；引用闸漏了 ⇒ 代理里留下一条指向空气的引用，保存的那一刻
//     系统明明知道，却要等到任务真跑起来才炸。而**被拒之后行还必须在**——拒了个响、
//     数据照删是最坏的一档。
//   * RES-31 —— 装不上的插件是常态（路径敲错、包名写错）。失败后表单要是被清空，用户得把
//     name / description / options 全部重敲一遍才能改那一个字；失败后要是留下了半条 DB 记录，
//     列表里就多一个永远起不来的幽灵插件。
//   * RES-34 —— file: 源插件的内容在平台之外被人改动，平台没有任何可比对的基线。这时候还
//     给出 Check / Upgrade 两颗按钮 ⇒ 用户点下去要么拿到一个凭空捏造的「已是最新」，要么
//     触发一次以外部路径当基线的「升级」——两种都是在给一个平台管不着的东西发合格证。
//   * RES-35 —— options 是一段自由 JSON，敲错一个括号是家常便饭。错误要是只在 Config 页
//     显示、而用户此刻站在 Updates 页，他只会看到「按钮点了没反应」；不聚焦到出错字段 ⇒
//     一屏六个输入框，用户得自己找哪个红了。
//   * RES-38 —— 导出的是「所见即所得」的那一版。有未保存改动时还让导出 ⇒ 用户拿到的 zip
//     里是**旧**内容，而他刚刚才改过；显式传了空 fence 却当成「没传」放行 ⇒ 调用方以为
//     自己有防护、实际什么都没有（静默降级比报错糟得多）。
//   * RES-40 —— 这是本批的头号断言。包里的凭据被替换成了占位符，导入侧必须**要用户重填**：
//     必填的没填就提交 ⇒ 建出一条 URL 是 `<REDACTED:SECRET>` 的资源；跳过的可选项要是
//     把占位符**原样写进库** ⇒ 系统会拿字面量 `<REDACTED:SECRET>` 当密钥去认证，而界面上
//     看起来一切正常。所以这条用例最后一定要**从服务端读回落库的那一行**逐字核对。
//   * RES-41 —— 用户是从「新建插件」进来的，包里却是一台 MCP。不说 ⇒ 他提交完在插件列表
//     里怎么也找不到刚建的东西，会以为导入失败了、再导一遍。
//
// 源码锚点（可复跑核对，纯文本引用；禁 GitHub 外链见 CLAUDE.md §opencode 源码自取规则）：
//   packages/shared/src/schemas/mcp.ts:41                  MCP_ENV_DENY_RE = /^(?:LD_|DYLD_)/i
//   packages/shared/src/schemas/mcp.ts:116-120             McpLocalConfigWriteSchema：写路径专用的 env 闸
//   packages/shared/src/schemas/mcp.ts:200-216             CreateMcp / UpdateMcpLocal 都挂 Write 版
//   packages/frontend/src/lib/mcp-form.ts:158-167          表单最终用同一份 schema 兜底 ⇒ 请求发不出去
//   packages/frontend/src/components/McpFields.tsx:24-27   只渲染 name/command/url/timeoutMs 四个简单键
//   packages/backend/src/services/deleteConfirm.ts:44-66   assertDeleteConfirm：422 delete-confirm-mismatch
//   packages/backend/src/routes/mcps.ts:413-440            删除顺序：confirm → 独占区内 hash + fresh-name 复核
//   packages/backend/src/services/mcp.ts:243-287           引用闸：预检 + 同一事务内复核，两处都抛 mcp-still-referenced
//   packages/backend/src/routes/plugins.ts:200-217         插件删除的同款双闸
//   packages/backend/src/services/plugin.ts:233-259        插件的引用闸（预检 + 事务内复核）
//   packages/frontend/src/components/ConfirmDialog.tsx:84-108  键入名字才解锁；失败时弹窗留在原地并挂 ErrorBanner
//   packages/backend/src/services/pluginInstaller.ts:112-118   PluginFileNotFoundError（ValidationError ⇒ 422）
//   packages/backend/src/services/pluginInstaller.ts:347-366   file: 源装不上时抛，DB 不落行
//   packages/backend/src/routes/plugins.ts:366-374         assertOperationSupported：file 源 check/upgrade 422
//   packages/frontend/src/routes/plugins.detail.tsx:423-426    file 源用通知**替换**掉整个按钮区
//   packages/frontend/src/routes/plugins.detail.tsx:278-290    validateSnapshot：setErrors + setTab('config') + 聚焦
//   packages/frontend/src/components/PluginFields.tsx:25-31    focusFirstPluginFieldError 的字段优先序
//   packages/backend/src/routes/resourcePackages.ts:149-161     显式空 fence ⇒ 422 package-invalid
//   packages/backend/src/services/resourcePackage/export.ts:276-280  fence 不匹配 ⇒ 409 package-root-changed
//   packages/frontend/src/routes/mcps.detail.tsx:258-266    脏态禁用导出并给出理由
//   packages/shared/src/bundle/secrets.ts:80-95             env / headers 整体收敛（不逐个判熵）
//   packages/shared/src/bundle/secrets.ts:159-186           URL 脱敏：userinfo 整段剥掉并记一条 config.url
//   packages/frontend/src/components/ResourcePackageImportDialog.tsx:108-110  只有 config.url / spec 是必填
//   packages/frontend/src/components/ResourcePackageImportDialog.tsx:693-703  必填没填 ⇒ commit 按钮不可用
//   packages/backend/src/services/resourcePackage/secretInputs.ts:110-121     跳过 = **删键**，不是留占位符
//   packages/backend/src/services/resourcePackage/secretInputs.ts:145-150     残留占位符 ⇒ fail closed
//   packages/frontend/src/components/ResourcePackageImportDialog.tsx:887-899  根类型不符的提示
//   packages/frontend/src/components/ResourcePackageImportDialog.tsx:757-786  提交后跳到**实际**根
//
// 执行模型：全文件共用一个 daemon（默认 stub 模式，不跑任何任务），管理员会话直连——
// 本文件验的是资源管理本身，不是可见性（RES-15 / RES-45 另有其人）。每条 test 自己 seed
// 自己的资源（`nextSlug` 保证不撞名），互不依赖，因此可以整批并发注入变异后按「红了哪几条」
// 逐条归因（`test.describe.configure({ mode: 'serial' })` 会毁掉这个性质，故不用）。
// 一次 `page.route` 都不用：所有拒绝分支都由**真的**被拒动作产生——真 schema、真事务、
// 真安装器、真 zip。

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultSystemMockToolPath, startDaemon, type DaemonHandle } from './harness'

test.setTimeout(150_000)

let daemon: DaemonHandle
let fixtureDir: string
let systemMockTool: string
let missingPluginPath: string
/** 带凭据的远端 MCP 导出的包（含一条必填 + 一条可选密钥）——RES-40 用。 */
let secretsPackagePath: string
/** 一台干净本地 MCP 导出的包（零密钥）——RES-41 用。 */
let plainMcpPackagePath: string
let secretsPackageMcpName: string
let plainPackageMcpName: string
let sequence = 0

// ---------------------------------------------------------------------------
// 类型 / 请求封装
// ---------------------------------------------------------------------------

interface McpRow {
  id: string
  name: string
  description: string
  type: 'local' | 'remote'
  enabled: boolean
  config: {
    command?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    timeoutMs?: number
  }
  operationConfigHash: string
}

interface PluginRow {
  id: string
  name: string
  description: string
  spec: string
  sourceKind: 'npm' | 'git' | 'file'
  options?: Record<string, unknown>
  enabled: boolean
  operationConfigHash: string
}

interface ErrorBody {
  code: string
  message?: string
  details?: { issues?: Array<{ message: string; path: unknown[] }> }
}

async function raw(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return { status: response.status, body: await response.text() }
}

async function json<T>(path: string, init: RequestInit | undefined, what: string): Promise<T> {
  const response = await raw(path, init)
  expect(response.status < 400, `${what}: HTTP ${response.status} ${response.body}`).toBe(true)
  return JSON.parse(response.body) as T
}

function errorOf(body: string): ErrorBody {
  return JSON.parse(body) as ErrorBody
}

/** 一条 422 里 zod issue 的全部文案——用来断言「报错点名了是哪个 env key」。 */
function issueMessages(body: string): string {
  return (errorOf(body).details?.issues ?? []).map((issue) => issue.message).join(' | ')
}

function nextSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

async function seedLocalMcp(input: {
  slug: string
  env?: Record<string, string>
  description?: string
}): Promise<McpRow> {
  return json<McpRow>(
    '/api/mcps',
    {
      method: 'POST',
      body: JSON.stringify({
        name: input.slug,
        description: input.description ?? 'rfc319 fixture',
        type: 'local',
        config: {
          command: [systemMockTool, 'mcp-stdio'],
          timeoutMs: 10_000,
          ...(input.env === undefined ? {} : { env: input.env }),
        },
        enabled: true,
      }),
    },
    `seed local mcp ${input.slug}`,
  )
}

async function seedRemoteMcpWithCredentials(slug: string): Promise<McpRow> {
  return json<McpRow>(
    '/api/mcps',
    {
      method: 'POST',
      body: JSON.stringify({
        name: slug,
        description: 'rfc319 credential-carrying fixture',
        type: 'remote',
        config: {
          // userinfo 与 header 是两类**不同**的密钥载体：前者会被整段剥掉（必填补录），
          // 后者键保留值收敛（可选补录）。一个包里同时带上两种，才验得出两条不同的分支。
          url: 'https://exporter:original-userinfo-secret@mcp.example.com/sse',
          headers: { Authorization: 'Bearer original-header-secret' },
          timeoutMs: 9_000,
          oauth: false,
        },
        enabled: true,
      }),
    },
    `seed remote mcp ${slug}`,
  )
}

function readMcp(id: string): Promise<McpRow> {
  return json<McpRow>(`/api/mcps/${id}`, undefined, `read mcp ${id}`)
}

function listMcps(): Promise<McpRow[]> {
  return json<McpRow[]>('/api/mcps', undefined, 'list mcps')
}

async function deleteMcpViaApi(mcp: McpRow): Promise<void> {
  const current = await readMcp(mcp.id)
  const response = await raw(`/api/mcps/${mcp.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: current.name,
      expectedConfigHash: current.operationConfigHash,
    }),
  })
  expect(response.status, `delete mcp ${mcp.name}: ${response.body}`).toBe(204)
}

async function seedFilePlugin(slug: string): Promise<PluginRow> {
  return json<PluginRow>(
    '/api/plugins',
    {
      method: 'POST',
      body: JSON.stringify({
        name: slug,
        // 绝对路径 ⇒ inferSourceKind 判成 'file'（pluginInstaller.ts:120-128）。
        spec: daemon.stubOpencode,
        description: 'rfc319 fixture',
        enabled: true,
      }),
    },
    `seed plugin ${slug}`,
  )
}

function readPlugin(id: string): Promise<PluginRow> {
  return json<PluginRow>(`/api/plugins/${id}`, undefined, `read plugin ${id}`)
}

function listPlugins(): Promise<PluginRow[]> {
  return json<PluginRow[]>('/api/plugins', undefined, 'list plugins')
}

async function seedAgentReferencing(
  slug: string,
  refs: { mcp?: string[]; plugins?: string[] },
): Promise<{ id: string }> {
  return json<{ id: string }>(
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name: slug,
        description: 'rfc319 reference holder',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'body',
        ...(refs.mcp === undefined ? {} : { mcp: refs.mcp }),
        ...(refs.plugins === undefined ? {} : { plugins: refs.plugins }),
      }),
    },
    `seed agent ${slug}`,
  )
}

async function primeAdmin(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

/**
 * 数一数某个端点到底被打了几次。
 *
 * 「校验拦住了」这件事的判据是**请求没发出去**，不是界面上有没有红字：只看红字等于允许
 * 「先发了再报错」，而写坏行的正是那次请求。计数器必须配一次**真的往返**当同步点
 * （见各用例里的注释），否则「零请求」可能只是断言跑得比请求快。
 */
function countRequests(page: Page, method: string, pathname: string): () => number {
  let seen = 0
  page.on('request', (request) => {
    if (request.method() === method && new URL(request.url()).pathname === pathname) seen += 1
  })
  return () => seen
}

function waitForResponseOn(page: Page, method: string, pathname: string, timeout = 30_000) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === pathname,
    { timeout },
  )
}

/** 打开某条资源详情页的 More 弹窗（导出 / 权限 / 删除都住在里面）。 */
async function openMoreActions(page: Page): Promise<void> {
  await page.getByTestId('detail-more-actions').click()
  await expect(
    page.getByTestId('detail-actions-dialog'),
    'More 弹窗打不开 ⇒ 删除 / 导出 / 权限三个入口一个都够不着',
  ).toBeVisible()
}

/** 通过界面导出一个配置包并落盘，返回本地路径。 */
async function exportPackageToDisk(
  page: Page,
  testid: string,
  targetPath: string,
): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(testid).click(),
  ])
  const suggested = download.suggestedFilename()
  await download.saveAs(targetPath)
  return suggested
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  systemMockTool = defaultSystemMockToolPath()
  fixtureDir = mkdtempSync(join(tmpdir(), 'rfc319-res-rest-'))
  // 刻意**不创建**这个文件：它就是「插件路径敲错了」的那一条 spec。
  missingPluginPath = join(fixtureDir, 'no-such-plugin-entry.js')

  // ---- RES-40 的包：一台带两类凭据的远端 MCP，导出后把源删掉 ----
  // 删源是为了让导入侧默认就落在「新建」上：本用例要验的是**补录的值真的落进了新行**，
  // 掺进「复用既有」的分支只会让判据变糊。
  const secretsSource = await seedRemoteMcpWithCredentials(nextSlug('rfc319-secret-src'))
  secretsPackageMcpName = secretsSource.name
  const secretsZip = await fetch(
    `${daemon.baseUrl}/api/mcps/${secretsSource.id}/export-package?expectedConfigHash=${secretsSource.operationConfigHash}`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  expect(secretsZip.status, '带凭据的 MCP 导不出包，RES-40 无从谈起').toBe(200)
  secretsPackagePath = join(fixtureDir, 'rfc319-secrets.awpkg.zip')
  writeFileSync(secretsPackagePath, Buffer.from(await secretsZip.arrayBuffer()))
  await deleteMcpViaApi(secretsSource)

  // ---- RES-41 的包：一台干净的本地 MCP（零密钥），同样导出后删源 ----
  const plainSource = await seedLocalMcp({ slug: nextSlug('rfc319-plain-src') })
  plainPackageMcpName = plainSource.name
  const plainZip = await fetch(
    `${daemon.baseUrl}/api/mcps/${plainSource.id}/export-package?expectedConfigHash=${plainSource.operationConfigHash}`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  expect(plainZip.status, '干净 MCP 导不出包，RES-41 无从谈起').toBe(200)
  plainMcpPackagePath = join(fixtureDir, 'rfc319-plain.awpkg.zip')
  writeFileSync(plainMcpPackagePath, Buffer.from(await plainZip.arrayBuffer()))
  await deleteMcpViaApi(plainSource)
})

test.afterEach(async ({ page }) => {
  // 本文件一条 page.route 都不注入，但仍按 docs/dev-gotchas.md §「page.route 两把锁」
  // 的锁 B 无条件摘一次：将来任何人往这里加注入时，不必再想起补这一句。
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (fixtureDir !== undefined) rmSync(fixtureDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// RES-27 —— MCP stdio 子进程环境变量的安全闸
// ---------------------------------------------------------------------------

test('RFC-319 RES-27: MCP 的 env 只拒动态加载变量，LD_PRELOAD 连请求都发不出去，API_KEY 这类合法名字必须放行 @nightly', async ({
  page,
}) => {
  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps/new`)
  const createCount = countRequests(page, 'POST', '/api/mcps')

  const slug = nextSlug('rfc319-envgate')
  await page.locator('#mcp-field-name').fill(slug)
  await page.locator('#mcp-field-command').fill(`${systemMockTool} mcp-stdio`)
  await page
    .getByLabel('Environment variables')
    .fill('LD_PRELOAD=/tmp/evil.so\nAPI_KEY=perfectly-ordinary')

  await page.getByTestId('mcp-save-button').click()

  // 界面上的**唯一**反馈是页签角上那枚红徽标（mcps.new.tsx 的 badgeTone: 'danger'）。
  // ⚠️ 现状：`config.env.LD_PRELOAD` 这种完整路径 key 在 McpFields.tsx:24-27 里没有对应的
  // 渲染位，所以字段级红字**一个字都没有**——这是一条已报的产品缺陷（见本批报告 §5）。
  // 这里按**源码实际**断言，不去要一条不存在的字段级消息：把缺陷锁成契约和照着账本措辞
  // 写一条永远红的用例一样糟。
  await expect(
    page.locator('.tabs__tab-badge--danger'),
    '带 LD_PRELOAD 的表单点了创建，界面上连一枚错误徽标都不给 ⇒ 用户只看到按钮像坏了',
  ).toHaveText('!')
  await expect(page, '校验没过却已经离开新建页 ⇒ 说明它其实建成功了').toHaveURL(/\/mcps\/new$/)

  // 把 env 改成一组**完全正常**的名字再建一次。这一步同时是上面那条「零请求」的同步点:
  // 若第一次点击真的发了 POST，它必然排在这一次成功的 POST 之前，计数就不会是 1。
  await page
    .getByLabel('Environment variables')
    .fill('API_KEY=perfectly-ordinary\nTOKEN=t-2\nMODE=on')
  const created = waitForResponseOn(page, 'POST', '/api/mcps')
  await page.getByTestId('mcp-save-button').click()
  const createdResponse = await created
  expect(
    createdResponse.status(),
    'RFC-242 的反向锁：API_KEY / TOKEN 这类**服务器真在用**的普通变量被拒 ⇒ 用户的正常配置存不进去，' +
      '第一版 no-network fence 就是这么拆掉生产配置的',
  ).toBe(201)
  const createdRow = (await createdResponse.json()) as McpRow
  expect(
    createCount(),
    '带 LD_PRELOAD 的那次点击把请求发出去了 ⇒ 校验只是装饰，坏行是否落库全看服务端的心情',
  ).toBe(1)
  expect(
    (await readMcp(createdRow.id)).config.env,
    '合法 env 落库后少了几条 ⇒ 闸门顺手吃掉了',
  ).toEqual({ API_KEY: 'perfectly-ordinary', TOKEN: 't-2', MODE: 'on' })

  // ---- 改存量行：同一道闸必须挂在 PUT 上 ----
  await page.goto(`${daemon.baseUrl}/mcps/${createdRow.id}`)
  await expect(page.getByTestId('mcp-save-button')).toBeVisible()
  const putCount = countRequests(page, 'PUT', `/api/mcps/${createdRow.id}`)
  await page.getByLabel('Environment variables').fill('DYLD_INSERT_LIBRARIES=/tmp/evil.dylib')
  await page.getByTestId('mcp-save-button').click()
  // ⚠️ 现状：详情页的 TabBar（mcps.detail.tsx:193-196）**连徽标都没有**，
  // `showValidationErrors` 的聚焦也只认 name/command/url/timeoutMs 四个字段
  // （mcps.detail.tsx:116-127）——所以这一次点击在界面上是**彻底无声**的：
  // 没有红字、没有徽标、没有焦点跳转。已作为产品缺陷单独报出（本批报告 §5），
  // 这里按源码实际只锁「请求没发出去 + 库没被改」这两件真的成立的事。
  await expect(
    page.getByLabel('Environment variables'),
    '被拒之后编辑框里的内容被清了 ⇒ 用户连自己刚敲了什么都看不到',
  ).toHaveValue('DYLD_INSERT_LIBRARIES=/tmp/evil.dylib')

  await page.getByLabel('Environment variables').fill('API_KEY=still-fine')
  const saved = waitForResponseOn(page, 'PUT', `/api/mcps/${createdRow.id}`)
  await page.getByTestId('mcp-save-button').click()
  expect((await saved).status()).toBe(200)
  expect(putCount(), '带 DYLD_ 的那次保存把 PUT 发出去了 ⇒ 编辑路径上的闸门是漏的').toBe(1)

  // ---- 绕过界面直打接口：闸门的**权威实施**在服务端，不能只靠表单 ----
  const rejectedCreate = await raw('/api/mcps', {
    method: 'POST',
    body: JSON.stringify({
      name: nextSlug('rfc319-envgate-api'),
      description: 'bypasses the form entirely',
      type: 'local',
      config: { command: [systemMockTool, 'mcp-stdio'], env: { LD_PRELOAD: '/tmp/evil.so' } },
      enabled: true,
    }),
  })
  expect(
    rejectedCreate.status,
    '绕过表单直接建一条带 LD_PRELOAD 的 MCP 竟然成了 ⇒ 任何能调接口的人都能让 daemon 加载任意动态库',
  ).toBe(422)
  expect(errorOf(rejectedCreate.body).code).toBe('mcp-invalid')
  expect(
    issueMessages(rejectedCreate.body),
    '拒了却不说是哪一个 key ⇒ 面对一屏环境变量，用户不知道该删哪一行',
  ).toContain('LD_PRELOAD')

  const rejectedUpdate = await raw(`/api/mcps/${createdRow.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        command: [systemMockTool, 'mcp-stdio'],
        env: { dyld_insert_libraries: '/tmp/evil.dylib' },
      },
      expectedConfigHash: (await readMcp(createdRow.id)).operationConfigHash,
    }),
  })
  expect(
    rejectedUpdate.status,
    '小写的 dyld_ 被放行 ⇒ 闸门是大小写敏感的，而环境变量在 macOS 上并不区分这一层',
  ).toBe(422)
  expect(
    (await readMcp(createdRow.id)).config.env,
    '被拒的那次 PUT 仍然改了库 ⇒ 「拒绝」只拒了个响',
  ).toEqual({ API_KEY: 'still-fine' })
})

// ---------------------------------------------------------------------------
// RES-18 —— 删除 MCP 的三道闸
// ---------------------------------------------------------------------------

test('RFC-319 RES-18: 删除 MCP 的三道闸——名字打错点不动、背后被人改过就 409、还被代理引用着就不许删 @nightly', async ({
  page,
}) => {
  // guarded = 三道闸都在它身上试；clean = 谁也不引用它，用来证明「删除本身没坏」。
  const guarded = await seedLocalMcp({ slug: nextSlug('rfc319-del-mcp') })
  const clean = await seedLocalMcp({ slug: nextSlug('rfc319-del-mcp-clean') })

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps/${guarded.id}`)
  await expect(page.getByTestId('mcp-save-button')).toBeVisible()
  const deleteCount = countRequests(page, 'DELETE', `/api/mcps/${guarded.id}`)

  // ---- 闸一：名字打错，确认按钮压根解不了锁 ----
  await openMoreActions(page)
  await page.getByTestId('detail-delete-button').click()
  const dialog = page.getByRole('dialog')
  const confirmButton = dialog.getByRole('button', { name: 'Delete', exact: true })
  await expect(
    confirmButton,
    '什么都没输就能点删除 ⇒ 键入确认这道设计等于没有，手滑两下资源就没了',
  ).toBeDisabled()
  await dialog.getByTestId('confirm-input').fill(`${guarded.name}-typo`)
  await expect(
    confirmButton,
    '名字打错了却解锁了 ⇒ 用户以为自己在删另一台 MCP，删掉的是眼前这台',
  ).toBeDisabled()

  // ---- 闸二：页面手里的 hash 已经不是当前版本 ----
  // 「另一个人 / 另一个标签页刚刚保存过这台 MCP」——此时删除的必须是**你看到的那一版**。
  await json<McpRow>(
    `/api/mcps/${guarded.id}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        description: 'changed by somebody else',
        expectedConfigHash: (await readMcp(guarded.id)).operationConfigHash,
      }),
    },
    'mutate mcp behind the page',
  )
  await dialog.getByTestId('confirm-input').fill(guarded.name)
  await expect(confirmButton).toBeEnabled()
  const stale = waitForResponseOn(page, 'DELETE', `/api/mcps/${guarded.id}`)
  await confirmButton.click()
  const staleResponse = await stale
  expect(
    staleResponse.status(),
    '拿着几分钟前的印象删掉了别人刚改过的那一版 ⇒ 你删的根本不是你看到的东西',
  ).toBe(409)
  expect(errorOf(await staleResponse.text()).code).toBe('resource-operation-stale')
  expect(deleteCount(), '名字打错的那两次也发出了 DELETE ⇒ 键入确认只是画在界面上的').toBe(1)
  await expect(
    dialog.getByRole('alert').filter({ hasText: 'The resource changed since this operation' }),
    '被 hash 闸拒了却不告诉用户为什么 ⇒ 他只看到弹窗没关，会一直点',
  ).toBeVisible()
  expect(
    (await listMcps()).some((row) => row.id === guarded.id),
    '拒了个响，行照样没了 ⇒ 这是最坏的一档：用户以为被保护了，其实数据已经删掉',
  ).toBe(true)

  // ---- 闸三：hash 追平了，但这台 MCP 还被一个代理引用着 ----
  await seedAgentReferencing(nextSlug('rfc319-del-mcp-holder'), { mcp: [guarded.id] })
  await page.reload()
  await openMoreActions(page)
  await page.getByTestId('detail-delete-button').click()
  const reopened = page.getByRole('dialog')
  await reopened.getByTestId('confirm-input').fill(guarded.name)
  const refused = waitForResponseOn(page, 'DELETE', `/api/mcps/${guarded.id}`)
  await reopened.getByRole('button', { name: 'Delete', exact: true }).click()
  const refusedResponse = await refused
  expect(
    refusedResponse.status(),
    '还被代理引用着就把 MCP 删了 ⇒ 代理里留下一条指向空气的引用，要等任务真跑起来才炸',
  ).toBe(409)
  expect(errorOf(await refusedResponse.text()).code).toBe('mcp-still-referenced')
  await expect(
    reopened.getByRole('alert').filter({ hasText: 'Agents still reference this MCP' }),
    '被引用闸拒了却不说是被谁挡住的 ⇒ 用户不知道该先去解哪一条绑定',
  ).toBeVisible()
  expect(
    (await listMcps()).some((row) => row.id === guarded.id),
    '引用闸拒了，行却已经删了',
  ).toBe(true)

  // ---- 没有任何闸挡着的那台，删除必须真的能完成 ----
  // 少了这一段，上面三条无法与「删除功能整个坏掉」区分开。
  await page.goto(`${daemon.baseUrl}/mcps/${clean.id}`)
  await expect(page.getByTestId('mcp-save-button')).toBeVisible()
  await openMoreActions(page)
  await page.getByTestId('detail-delete-button').click()
  const cleanDialog = page.getByRole('dialog')
  await cleanDialog.getByTestId('confirm-input').fill(clean.name)
  const removed = waitForResponseOn(page, 'DELETE', `/api/mcps/${clean.id}`)
  await cleanDialog.getByRole('button', { name: 'Delete', exact: true }).click()
  expect((await removed).status()).toBe(204)
  await expect(page).toHaveURL(/\/mcps$/)
  await expect(
    page.getByTestId(`split-card-${clean.id}`),
    '删完列表里还挂着那张卡片 ⇒ 用户会再点进去，撞上一片报错',
  ).toHaveCount(0)

  await page.goto(`${daemon.baseUrl}/mcps/${clean.id}`)
  await expect(
    page.getByRole('alert').filter({ hasText: 'MCP not found' }),
    '删掉之后深链接还渲染出内容 ⇒ 那是一份已经不存在的东西的快照',
  ).toBeVisible()
  expect((await raw(`/api/mcps/${clean.id}`)).status, '删了之后详情接口还给 200').toBe(404)
})

// ---------------------------------------------------------------------------
// RES-31 —— 插件装不上之后就地改 spec 重试
// ---------------------------------------------------------------------------

test('RFC-319 RES-31: 插件装不上时停在新建页、表单一字不丢，就地改对 spec 再建就能成 @nightly', async ({
  page,
}) => {
  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/plugins/new`)

  const slug = nextSlug('rfc319-install-retry')
  await page.locator('#plugin-field-name').fill(slug)
  await page.locator('#plugin-field-spec').fill(missingPluginPath)
  await page.locator('#plugin-field-description').fill('typed once, must survive the failure')
  await page.getByTestId('plugin-form-options').fill('{\n  "retries": 3\n}')

  const failed = waitForResponseOn(page, 'POST', '/api/plugins', 60_000)
  await page.getByTestId('plugin-save-button').click()
  const failedResponse = await failed
  expect(
    failedResponse.status(),
    '路径根本不存在的插件竟然装上了 ⇒ 列表里会多一个永远起不来的幽灵',
  ).toBe(422)
  expect(errorOf(await failedResponse.text()).code).toBe('plugin-file-not-found')

  await expect(
    page.getByRole('alert').filter({ hasText: 'Plugin file not found' }),
    '装不上却不说原因 ⇒ 用户对着一个没反应的按钮，不知道是路径错了还是权限不够',
  ).toBeVisible()
  await expect(page, '安装失败却把人带走了 ⇒ 改一个字都得从头再来').toHaveURL(/\/plugins\/new$/)

  // 失败**不能**把 DB 弄脏：pluginInstaller 在写行之前就抛。
  expect(
    (await listPlugins()).some((row) => row.name === slug),
    '安装失败却留下了半条记录 ⇒ 名字被占住，用户连重试都会撞「名字已存在」',
  ).toBe(false)

  // 表单里的其它字段必须**一字不丢**——用户只想改那一个路径。
  await expect(
    page.locator('#plugin-field-name'),
    '失败后名字被清空 ⇒ 三个字段全部重敲一遍',
  ).toHaveValue(slug)
  await expect(page.locator('#plugin-field-description')).toHaveValue(
    'typed once, must survive the failure',
  )
  await expect(
    page.getByTestId('plugin-form-options'),
    '失败后 options 被清空 ⇒ 这是全表最难重敲的一段',
  ).toHaveValue('{\n  "retries": 3\n}')

  // 就地把 spec 改对，重试必须能成。
  await page.locator('#plugin-field-spec').fill(daemon.stubOpencode)
  const created = waitForResponseOn(page, 'POST', '/api/plugins', 60_000)
  await page.getByTestId('plugin-save-button').click()
  const createdResponse = await created
  expect(
    createdResponse.status(),
    '改对路径后仍然建不出来 ⇒ 第一次失败在页面上留下了什么脏状态',
  ).toBe(201)
  const createdRow = (await createdResponse.json()) as PluginRow
  await expect(page).toHaveURL(new RegExp(`/plugins/${createdRow.id}$`))
  const persisted = await readPlugin(createdRow.id)
  expect(
    persisted.options,
    '重试成功了，但第一次敲进去的 options 没跟着存 ⇒ 用户不会发现，直到插件行为不对',
  ).toEqual({ retries: 3 })
  expect(persisted.spec).toBe(daemon.stubOpencode)
})

// ---------------------------------------------------------------------------
// RES-34 —— file: 源插件禁用 Check / Upgrade
// ---------------------------------------------------------------------------

test('RFC-319 RES-34: file: 源插件不给 Check / Upgrade 两颗按钮，绕过界面直打端点同样被 422 拒 @nightly', async ({
  page,
}) => {
  const plugin = await seedFilePlugin(nextSlug('rfc319-file-src'))
  expect(
    plugin.sourceKind,
    '夹具插件没被判成 file 源，这条用例证明不了任何事（inferSourceKind 认绝对路径）',
  ).toBe('file')

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/plugins/${plugin.id}`)
  await page.getByTestId('plugin-tab-updates').click()
  const panel = page.getByTestId('plugin-panel-updates')

  await expect(
    panel.getByText('Managed by an external path'),
    'file 源插件不说明自己为什么没有更新入口 ⇒ 用户以为这一页坏了',
  ).toBeVisible()
  await expect(
    panel.getByText(
      'This file source can change outside Agent Workflow, so atomic Check and Upgrade are unavailable.',
    ),
    '只给一个标题、不说原因 ⇒ 用户不知道该拿这条插件怎么办',
  ).toBeVisible()

  await expect(
    page.getByTestId('plugin-check-update'),
    'file 源还给 Check 按钮 ⇒ 点下去只会拿到一个凭空捏造的「已是最新」，等于给平台管不着的东西发合格证',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('plugin-upgrade'),
    'file 源还给 Upgrade 按钮 ⇒ 会以外部路径当基线做一次「升级」',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('plugin-update-empty'),
    'file 源还渲染「还没检查过更新」的空态 ⇒ 在暗示用户「去点一下检查」，而这里根本没有可点的东西',
  ).toHaveCount(0)

  // 服务端才是权威实施：按钮没渲染不等于端点关着。
  const fresh = await readPlugin(plugin.id)
  for (const operation of ['check-update', 'upgrade'] as const) {
    const response = await raw(`/api/plugins/${plugin.id}/${operation}`, {
      method: 'POST',
      body: JSON.stringify({ expectedConfigHash: fresh.operationConfigHash }),
    })
    expect(
      response.status,
      `${operation}: 界面藏了按钮、端点却照跑 ⇒ 任何调接口的人都能对一个外部托管的路径做「原子升级」`,
    ).toBe(422)
    expect(errorOf(response.body).code).toBe('plugin-operation-unsupported')
  }
  expect(
    (await readPlugin(plugin.id)).operationConfigHash,
    '被拒的 upgrade 仍然改了这一行 ⇒ 「不支持」只是句话',
  ).toBe(fresh.operationConfigHash)
})

// ---------------------------------------------------------------------------
// RES-35 —— options JSON 非法时回到 Config 页并聚焦出错字段
// ---------------------------------------------------------------------------

test('RFC-319 RES-35: options JSON 非法时跳回 Config 页并聚焦出错字段，一个保存请求都不发 @nightly', async ({
  page,
}) => {
  const plugin = await seedFilePlugin(nextSlug('rfc319-bad-options'))

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/plugins/${plugin.id}`)
  await expect(page.getByTestId('plugin-save-button')).toBeVisible()
  const putCount = countRequests(page, 'PUT', `/api/plugins/${plugin.id}`)

  await page.getByTestId('plugin-tab-config').click()
  await page.getByTestId('plugin-form-options').fill('{ "unclosed": ')

  // 站到**另一个**页签上再触发保存——这正是「跳回 Config 页」这件事唯一有意义的场景：
  // 人在 Updates 页，错误却只画在 Config 页上，他会看到「按钮点了没反应」。
  await page.getByTestId('plugin-tab-updates').click()
  await expect(page.getByTestId('plugin-panel-updates')).toBeVisible()
  await page.getByTestId('plugin-save-button').click()

  await expect(
    page.getByTestId('plugin-panel-config'),
    'options 敲错了却把人留在 Updates 页 ⇒ 错误信息在另一屏，用户只看到按钮没反应',
  ).toBeVisible()
  await expect(
    page.locator('#plugin-field-options-error'),
    '非法 JSON 没有任何提示 ⇒ 用户不知道是哪个字段不对',
  ).toHaveText('Options must be a valid JSON object.')
  await expect(
    page.locator('#plugin-field-options'),
    '跳回来了却不把光标放到出错的那个框 ⇒ 一屏六个输入框，用户得自己找哪个红了',
  ).toBeFocused()

  // JSON 里的**数组 / 标量**同样不是合法 options（parseOptions 只收对象）。
  await page.getByTestId('plugin-form-options').fill('[1, 2, 3]')
  await page.getByTestId('plugin-save-button').click()
  await expect(
    page.locator('#plugin-field-options-error'),
    '一个 JSON 数组被当成合法 options 放行 ⇒ 它会一路写进库，等运行期展开时才炸',
  ).toHaveText('Options must be a valid JSON object.')

  // 改成合法的再存一次——这次真的往返，同时给上面两条「零请求」当同步点。
  await page.getByTestId('plugin-form-options').fill('{ "level": "debug" }')
  const saved = waitForResponseOn(page, 'PUT', `/api/plugins/${plugin.id}`)
  await page.getByTestId('plugin-save-button').click()
  expect((await saved).status()).toBe(200)
  expect(
    putCount(),
    '非法 options 的那两次点击把 PUT 发出去了 ⇒ 校验只是装饰，一段坏 JSON 已经到过服务端',
  ).toBe(1)
  expect((await readPlugin(plugin.id)).options).toEqual({ level: 'debug' })
})

// ---------------------------------------------------------------------------
// RES-36 —— 删除插件的键入名字 + expectedConfigHash 双闸
// ---------------------------------------------------------------------------

test('RFC-319 RES-36: 删除插件的键入名字与 expectedConfigHash 双闸各自都拦得住 @nightly', async ({
  page,
}) => {
  const plugin = await seedFilePlugin(nextSlug('rfc319-del-plugin'))

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/plugins/${plugin.id}`)
  await expect(page.getByTestId('plugin-save-button')).toBeVisible()
  const deleteCount = countRequests(page, 'DELETE', `/api/plugins/${plugin.id}`)

  // ---- 闸一（界面侧）：名字没打对就解不了锁 ----
  await openMoreActions(page)
  await page.getByTestId('detail-delete-button').click()
  const dialog = page.getByRole('dialog')
  const confirmButton = dialog.getByRole('button', { name: 'Delete', exact: true })
  await expect(confirmButton, '什么都没输就能点删除 ⇒ 键入确认等于没有').toBeDisabled()
  await dialog.getByTestId('confirm-input').fill(plugin.name.toUpperCase())
  await expect(
    confirmButton,
    '大小写不同也算匹配 ⇒ 名字只差大小写的两条资源，用户会删错那一条',
  ).toBeDisabled()

  // ---- 闸二：hash 陈旧 ----
  await dialog.getByTestId('confirm-input').fill(plugin.name)
  await expect(confirmButton).toBeEnabled()
  const current = await readPlugin(plugin.id)
  await json<PluginRow>(
    `/api/plugins/${plugin.id}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        description: 'changed by somebody else',
        expectedConfigHash: current.operationConfigHash,
      }),
    },
    'mutate plugin behind the page',
  )
  const stale = waitForResponseOn(page, 'DELETE', `/api/plugins/${plugin.id}`)
  await confirmButton.click()
  const staleResponse = await stale
  expect(
    staleResponse.status(),
    '拿着旧 hash 的删除被放行 ⇒ 你删掉的是别人刚写进去的那一版，而你以为删的是自己看到的那版',
  ).toBe(409)
  expect(errorOf(await staleResponse.text()).code).toBe('resource-operation-stale')
  expect(deleteCount(), '名字没打对的那两次也发出了 DELETE ⇒ 界面那道闸是画上去的').toBe(1)
  expect(
    (await listPlugins()).some((row) => row.id === plugin.id),
    'hash 闸拒了，行却已经删了 ⇒ 拒了个响',
  ).toBe(true)

  // ---- 闸一（服务端侧）：界面之外的调用方同样要过名字这一关 ----
  // 界面那道只是 disabled 按钮，脚本 / 别的客户端根本不经过它。
  const wrongName = await raw(`/api/plugins/${plugin.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: `${plugin.name}-typo`,
      expectedConfigHash: (await readPlugin(plugin.id)).operationConfigHash,
    }),
  })
  expect(
    wrongName.status,
    '绕开界面就能不打名字直接删 ⇒ 键入确认只是前端的一层皮，脚本一句话就没了',
    // 服务端用 ValidationError（422），前端按 code 认。
  ).toBe(422)
  expect(errorOf(wrongName.body).code).toBe('delete-confirm-mismatch')

  const noConfirm = await raw(`/api/plugins/${plugin.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      expectedConfigHash: (await readPlugin(plugin.id)).operationConfigHash,
    }),
  })
  expect(noConfirm.status, '干脆不带 confirm 字段就能删 ⇒ 老调用方全是后门').toBe(422)
  expect(errorOf(noConfirm.body).code).toBe('delete-confirm-required')

  // ---- 两道闸都让路之后，删除必须真的能完成 ----
  await page.reload()
  await openMoreActions(page)
  await page.getByTestId('detail-delete-button').click()
  const reopened = page.getByRole('dialog')
  await reopened.getByTestId('confirm-input').fill(plugin.name)
  const removed = waitForResponseOn(page, 'DELETE', `/api/plugins/${plugin.id}`)
  await reopened.getByRole('button', { name: 'Delete', exact: true }).click()
  expect((await removed).status()).toBe(204)
  await expect(page).toHaveURL(/\/plugins$/)
  await expect(page.getByTestId(`split-card-${plugin.id}`), '删完列表里还挂着那张卡片').toHaveCount(
    0,
  )
  expect((await raw(`/api/plugins/${plugin.id}`)).status, '删了之后详情接口还给 200').toBe(404)
})

// ---------------------------------------------------------------------------
// RES-38 —— 配置包导出的所见即所得 fence
// ---------------------------------------------------------------------------

test('RFC-319 RES-38: 有未保存改动时导出入口按不动，保存后导出的包能落盘；空 fence 422、陈旧 fence 409 @nightly', async ({
  page,
}) => {
  const mcp = await seedLocalMcp({
    slug: nextSlug('rfc319-export'),
    description: 'before the edit',
  })

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps/${mcp.id}`)
  await expect(page.getByTestId('mcp-save-button')).toBeVisible()
  const exportCount = countRequests(page, 'GET', `/api/mcps/${mcp.id}/export-package`)

  // ---- 脏态：导出入口必须按不动，且**真的**发不出请求 ----
  await page.getByLabel('Description', { exact: true }).fill('edited but not saved')
  await openMoreActions(page)
  const exportItem = page.getByTestId('export-package-mcp')
  await expect(
    exportItem,
    '有未保存改动时还能导出 ⇒ 用户拿到的 zip 里是**旧**内容，而他刚刚才改过——「所见即所得」当场破功',
  ).toBeDisabled()
  await expect(
    exportItem,
    '禁用了却不说为什么 ⇒ 用户会以为导出功能坏了，而只要先按一下保存',
  ).toContainText('Save the current changes before exporting.')
  // docs/dev-gotchas.md §「要证明置灰的东西真的点不动」：只断言 disabled 锁不住
  // 「禁用只是画上去的」这种退化，必须 force 把点击真的打进去。
  await exportItem.click({ force: true })

  // ---- 保存之后才允许导出 ----
  await page.keyboard.press('Escape')
  const saved = waitForResponseOn(page, 'PUT', `/api/mcps/${mcp.id}`)
  await page.getByTestId('mcp-save-button').click()
  expect((await saved).status()).toBe(200)
  expect(
    exportCount(),
    '脏态下的那次点击把导出请求发出去了 ⇒ 用户拿到的是一个与眼前内容不符的包',
  ).toBe(0)

  await openMoreActions(page)
  await expect(exportItem, '保存之后导出仍然按不动 ⇒ 这条能力对所有人都等于不存在').toBeEnabled()
  const downloadedTo = join(fixtureDir, 'rfc319-export-ui.awpkg.zip')
  const [exported, suggestedName] = await Promise.all([
    waitForResponseOn(page, 'GET', `/api/mcps/${mcp.id}/export-package`, 60_000),
    exportPackageToDisk(page, 'export-package-mcp', downloadedTo),
  ])
  expect(exported.status(), '导出请求没成 ⇒ 用户点了个寂寞').toBe(200)
  expect(
    new URL(exported.url()).searchParams.get('expectedConfigHash'),
    '导出请求没带 fence ⇒ 导的是「导出那一刻恰好在库里的那版」，不是用户看到的那版',
  ).toBe((await readMcp(mcp.id)).operationConfigHash)
  expect(suggestedName, '下载下来的文件名不带资源身份 ⇒ 一次导十个包，用户分不清哪个是哪个').toBe(
    `mcp-${mcp.name}.awpkg.zip`,
  )
  const bytes = readFileSync(downloadedTo)
  expect(
    bytes.subarray(0, 2).toString('latin1'),
    '落盘的不是一个 zip ⇒ 拿去导入必然失败，而失败点会远在天边',
  ).toBe('PK')
  expect(bytes.byteLength).toBeGreaterThan(200)

  // ---- fence 的两条拒绝分支（服务端权威实施；界面拼 URL 时变量取空正是这条） ----
  const emptyFence = await raw(`/api/mcps/${mcp.id}/export-package?expectedConfigHash=`)
  expect(
    emptyFence.status,
    '显式传了空 fence 却当成「没传」放行 ⇒ 调用方以为自己有防护、实际什么都没有；' +
      '静默降级比报错糟得多',
  ).toBe(422)
  expect(errorOf(emptyFence.body).code).toBe('package-invalid')

  const staleHash = (await readMcp(mcp.id)).operationConfigHash
  await json<McpRow>(
    `/api/mcps/${mcp.id}`,
    {
      method: 'PUT',
      body: JSON.stringify({ description: 'changed again', expectedConfigHash: staleHash }),
    },
    'mutate mcp behind the exporter',
  )
  const staleFence = await raw(`/api/mcps/${mcp.id}/export-package?expectedConfigHash=${staleHash}`)
  expect(
    staleFence.status,
    '拿着旧 fence 照样导出 ⇒ 用户按着旧标签点导出，静默拿到的是新版本',
  ).toBe(409)
  expect(errorOf(staleFence.body).code).toBe('package-root-changed')

  // 同一道闸也必须挂在插件的导出上——六类导出共用 parseRootFence，漏一类等于漏一片。
  const plugin = await seedFilePlugin(nextSlug('rfc319-export-plugin'))
  const pluginEmptyFence = await raw(`/api/plugins/${plugin.id}/export-package?expectedConfigHash=`)
  expect(pluginEmptyFence.status, '插件导出的空 fence 被放行').toBe(422)
  expect(errorOf(pluginEmptyFence.body).code).toBe('package-invalid')
  const pluginOk = await raw(
    `/api/plugins/${plugin.id}/export-package?expectedConfigHash=${plugin.operationConfigHash}`,
  )
  expect(pluginOk.status, '插件带对 fence 也导不出来 ⇒ 上面那条 422 可能只是端点整个坏了').toBe(200)
})

// ---------------------------------------------------------------------------
// RES-40 —— 导入时的密钥补录与脱敏输入（本批头号断言）
// ---------------------------------------------------------------------------

test('RFC-319 RES-40: 导入时密钥以密码框补录，必填的没填就提交不了，跳过的那条绝不会把占位符写进库 @nightly', async ({
  page,
}) => {
  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps/new`)
  await page.getByTestId('mcps-create-package-tab').click()
  await page.getByTestId('package-import-file').setInputFiles(secretsPackagePath)
  await page.getByTestId('package-import-preview').click()
  await expect(page.getByTestId('package-import-commit')).toBeVisible()

  // ---- 包里有几处凭据，界面必须先说出来 ----
  await expect(
    page.getByTestId('package-import-secrets'),
    '包里的凭据被换成了占位符，界面却一声不吭 ⇒ 用户提交完才发现资源根本连不上，' +
      '而那时他已经不知道该去补哪几个字段',
  ).toContainText('2 credential fields were redacted')

  const urlSecret = page.getByLabel(/config\.url/)
  const headerSecret = page.getByLabel(/config\.headers\.Authorization/)
  await expect(
    urlSecret,
    '必填的 URL 凭据在界面上根本没有输入框 ⇒ 用户没有任何办法把它填回去',
  ).toBeVisible()
  await expect(
    urlSecret,
    '凭据输入框不是密码框 ⇒ 用户当着别人的面补录，值就直接显示在屏幕上',
  ).toHaveAttribute('type', 'password')
  await expect(headerSecret).toHaveAttribute('type', 'password')

  // ---- 必填没填就提交不了 ----
  const commit = page.getByTestId('package-import-commit')
  await expect(
    commit,
    '必填凭据空着也能提交 ⇒ 会建出一条 URL 是 <REDACTED:SECRET> 的 MCP，它长得和正常的一样',
  ).toBeDisabled()
  await headerSecret.fill('Bearer only-the-optional-one')
  await expect(commit, '只填了可选那条就解锁了 ⇒ 必填 / 可选的区分等于没有').toBeDisabled()
  await headerSecret.fill('')

  // ---- 只填必填、**故意跳过**可选的那条 ----
  const reenteredUrl = 'https://reentered:brand-new-secret@mcp.example.com/sse'
  await urlSecret.fill(reenteredUrl)
  await expect(
    commit,
    '必填填上了却仍然提交不了 ⇒ 这条导入路径对所有带凭据的包都是死的',
  ).toBeEnabled()

  const committed = waitForResponseOn(page, 'POST', '/api/resource-packages/commit', 60_000)
  await commit.click()
  expect((await committed).status(), '提交失败').toBe(200)
  await expect(page.getByTestId('package-import-report')).toBeVisible()

  // ---- 跳过的那条必须被**当面报出来**，而不是无声吞掉 ----
  await expect(
    page.getByTestId('package-import-skipped-secrets'),
    '跳过的凭据不出现在导入报告里 ⇒ 用户不知道自己刚建的资源缺了一项，会一直找不到它为什么不工作',
  ).toContainText('config.headers.Authorization')

  // ---- 本批头号断言：从服务端读回落库的那一行，逐字核对 ----
  const imported = (await listMcps()).find((row) => row.name === secretsPackageMcpName)
  expect(imported, '导入报了成功，库里却找不到这台 MCP').toBeTruthy()
  const persisted = await readMcp(imported!.id)
  expect(
    persisted.config.url,
    '补录的凭据没写进去 ⇒ 用户照着提示把值填了，建出来的资源还是连不上',
  ).toBe(reenteredUrl)
  expect(
    JSON.stringify(persisted.config),
    '字面量 <REDACTED:SECRET> 被原样写进了库 ⇒ 系统会拿这串字符当密钥去认证，' +
      '而界面上一切正常——这是这类导入最难被发现的一种坏法',
  ).not.toContain('<REDACTED:SECRET>')
  // 跳过 = **删键**（secretInputs.ts:110-121）。载体对象本身会留下（这里是空的
  // `headers: {}`），但那一条 Authorization 必须整条消失——留一个占位符值在里面
  // 才是灾难，所以判据写成「载体里一条都不剩」而不是「载体不存在」。
  expect(
    persisted.config.headers ?? {},
    '跳过的凭据没有被删掉，而是把 <REDACTED:SECRET> 留在库里 ⇒ 系统会拿这串字符去认证',
  ).toEqual({})
  expect(
    persisted.config.timeoutMs,
    '与凭据无关的字段在往返里丢了 ⇒ 脱敏顺手改坏了不该碰的东西',
  ).toBe(9_000)
})

// ---------------------------------------------------------------------------
// RES-41 —— 配置包根类型与当前入口不匹配
// ---------------------------------------------------------------------------

test('RFC-319 RES-41: 在插件新建页导入 MCP 包会明说根类型不符，提交后落到真正的那类资源上 @nightly', async ({
  page,
}) => {
  await primeAdmin(page)
  // 故意走**插件**的新建页导入一个 **MCP** 包：expectedRootType='plugin'，包根是 mcp。
  await page.goto(`${daemon.baseUrl}/plugins/new`)
  await page.getByTestId('plugins-create-package-tab').click()
  await page.getByTestId('package-import-file').setInputFiles(plainMcpPackagePath)
  await page.getByTestId('package-import-preview').click()
  await expect(page.getByTestId('package-import-commit')).toBeVisible()

  const mismatch = page.getByTestId('package-import-root-mismatch')
  await expect(
    mismatch,
    '从插件新建页导入了一个 MCP 包，界面却一声不吭 ⇒ 用户提交完在插件列表里怎么也找不到，' +
      '会以为导入失败了再导一遍',
  ).toBeVisible()
  // 三个变量都必须真被填上：只说一句「类型不符」而不说清是哪两类、叫什么名字，
  // 对着一个包名一无所知的用户毫无用处。
  await expect(mismatch, '提示里没说清「你打开的是哪个新建页」').toContainText('Plugin')
  await expect(mismatch, '提示里没说清「这个包实际是什么」').toContainText('MCP')
  await expect(mismatch, '提示里没说清是哪一条资源').toContainText(plainPackageMcpName)

  // 不匹配**不是**错误：它仍然可以提交，只是提交完该落到真正的那类资源上。
  const committed = waitForResponseOn(page, 'POST', '/api/resource-packages/commit', 60_000)
  await page.getByTestId('package-import-commit').click()
  expect(
    (await committed).status(),
    '根类型不符就把提交整个拦死 ⇒ 用户手里那个包变成了永远导不进来的东西',
  ).toBe(200)

  const imported = (await listMcps()).find((row) => row.name === plainPackageMcpName)
  expect(imported, '提交成功了，MCP 却没建出来').toBeTruthy()
  await expect(
    page,
    '提交完把人留在 /plugins ⇒ 他刚建出来的那台 MCP 在哪一页都没提示，只能自己去猜',
  ).toHaveURL(new RegExp(`/mcps/${imported!.id}$`))
  expect(
    (await readMcp(imported!.id)).config.command,
    '跨入口导入把 MCP 的配置改坏了 ⇒ 导进来的是一条起不来的命令',
  ).toEqual([systemMockTool, 'mcp-stdio'])
})
