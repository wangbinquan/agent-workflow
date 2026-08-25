// RFC-319 —— MCP（与插件）资源管理的用户面 e2e：建 / 改 / 探 / 停用 / 抢写。
//
// 覆盖能力账本 RES-16 / RES-21 / RES-22 / RES-23 / RES-37 / RES-X3 六行
// （账本里全部是 gap），并顺带把 RES-17 的「配置字段真的往返落库」这半边补上。
//
// 与既有 e2e 的分工（**刻意不重叠**）：
//   * `e2e/rfc223-tenant-identity.spec.ts` 的
//     `admin same-name MCP actions remain bound to the selected tenant id`
//     ——已经逐字锁住 RES-17 的「写入严格绑定所选的 id」与 RES-18 的整条删除链路
//     （More → Delete → 键入名字 → 204 → 卡片消失 → 详情 404）。本文件**不再重复**：
//     RES-18 一次都不删 MCP；RES-17 只补它没碰的那半——它只改过 Description，
//     command / env / timeout 这些**真正的 config 字段**从未被前端改写过一次。
//   * `e2e/system-mocks.spec.ts` 的
//     `daemon probes the unified MCP mock over Streamable HTTP and compiled stdio`
//     ——纯接口层的成功探测（RES-19 的真握手）。它只断言 status==='ok'，从不进浏览器，
//     四种失败码、过期、草稿分叉一条都没有。
//   * `e2e/agent-authoring.spec.ts` 的
//     `RFC-319 T32: disabling a referenced plugin surfaces a real integrity blocker`
//     ——插件被停用后**代理能力页的告警**。它是用接口把插件关掉的，既没走过插件详情页
//     的 Enabled 开关，也没验证「代理保存会被拒」。本文件补的正是这两段。
//   * `e2e/mcp-runtime-playground.spec.ts` / `e2e/mcp-acl-session-termination.spec.ts`
//     ——runtime 试跑对话框与 ACL 撤权，与本文件无交集。
//   * `mcp-probe-status-*` / `mcp-save-and-probe` / `mcp-probe-saved-version` /
//     `mcp-probe-expired` / `mcp-inventory-error*` 这些 testid，在本文件之前的全仓 e2e 里
//     **一次都没出现过**——探测面板除了「点一次 Re-probe 拿 200」之外从未被点过。
//
// 各条断言失效时用户会遭遇什么（这是每条用例存在的理由，不是断言在做什么）：
//
//   * RES-16 —— 新建表单是唯一的自助入口。必填校验**必须挡在请求之前**：一旦漏过去，
//     库里就多一条命令为空 / URL 没有 scheme 的 MCP，它在列表里长得和正常的一样，
//     直到某个任务真的去拉它的工具才炸，而那时人早就不在现场。local ↔ remote 的分段
//     切换必须**换掉整组必填字段**：切到 remote 之后还留着 Command，用户会以为自己配的
//     是远端、实际带着一条本地命令行进了库；反过来 Command 校验在 remote 下还生效，
//     用户会被一条永远填不掉的红字卡死在新建页。
//   * RES-17 —— 「保存」必须把改过的字段真的写进这一行，且**不碰没改的字段**。
//     env / timeout 存不进去 ⇒ 用户按提示填了凭据，跑起来还是没有；顺手把 command
//     清掉 ⇒ 一次只改超时的保存把这台 MCP 变成不可启动。
//   * RES-22 —— 探测结果是「这台服务器现在什么样」的唯一凭据。改完配置不作废它，
//     用户会盯着一枚**上一版配置**的绿色 Online 做决策：以为工具还在、以为地址还通，
//     实际这一版可能根本连不上。作废必须同时体现在列表卡片（改回 Unknown）与详情面板
//     （过期空态 + 提示），只作废一处等于另一处继续骗人。
//   * RES-23 —— 草稿没保存时探测有两种意图，产品把它做成了两个按钮。按错必须有可见后果：
//     「用已保存版本探测」若偷偷用了草稿，用户会以为草稿已经被验证过、放心保存一条坏配置；
//     「保存并探测」若偷偷用了旧版本，用户会拿着一枚绿灯上线一条从没被验证过的配置。
//     这条用例把两者的**结果做成相反的**（旧配置通、草稿不通），所以一旦用错版本，
//     断言立刻红。
//   * RES-21 —— 探测失败时，用户只能靠这一屏判断「该去修什么」。错误码错位 ⇒ 明明是
//     凭据没配（auth-required）却被告知「子进程没起来」，人去查命令行查一晚上；只给一句
//     分类、不给具体事实（缺失的路径 / 等了多少毫秒 / 哪个方法没实现）⇒ 面对一份 20 台
//     MCP 的清单，用户拿着「连接失败」四个字无从下手。partial 还必须**不被当成失败**：
//     服务器是通的、工具清单是好的，只是某一类清单没枚举到；若被渲染成红色 Error，
//     用户会把一台可用的 MCP 当成坏的删掉。
//   * RES-37 —— 同一条资源可能被两个人（或两个标签页）同时编辑。陈旧写入必须被认出来：
//     探测若拿旧 hash 照跑，用户会得到一份**描述上一版配置**的探测结果并当成现状；
//     保存若拿旧 hash 照写，用户会**静默盖掉**别人刚写进去的内容，双方都不会知道。
//   * RES-X3 —— enabled 是「这条资源现在算不算数」的总开关。关掉之后还能探测 ⇒ 用户以为
//     它仍在服务、把一台已停用的 MCP 写进代理；关掉插件之后引用它的代理还能存 ⇒ 这条
//     引用会一路带到运行期才炸，而保存的那一刻系统明明知道它是坏的。
//
// 源码锚点（可复跑核对，纯文本引用；禁 GitHub 外链见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/mcps.new.tsx:70-80              submit：校验不过直接 return，**不发请求**
//   packages/frontend/src/lib/mcp-form.ts:107-118                四条必填 / 格式校验的错误键
//   packages/frontend/src/components/McpFields.tsx:60-70         type 分段控件（role=radiogroup，aria-label=Type）
//   packages/frontend/src/components/McpFields.tsx:83-131        local / remote 各自的字段块
//   packages/frontend/src/routes/mcps.detail.tsx:98-112          保存成功后失效两个探测缓存键
//   packages/frontend/src/lib/probe-freshness.ts:15-20           startedAt > updatedAt 才算新鲜（相等按过期处理）
//   packages/frontend/src/routes/mcps.tsx:37-40                  列表卡片 chip：不新鲜 = Unknown
//   packages/frontend/src/components/mcps/McpInventoryPanel.tsx:96-125   dirty 时分裂成两个按钮
//   packages/frontend/src/components/mcps/McpInventoryPanel.tsx:175-183  resultStale / savedResultExpired 两条提示
//   packages/frontend/src/components/mcps/McpInventoryPanel.tsx:200-214  过期空态 / 从未探测空态
//   packages/frontend/src/components/mcps/McpInventoryPanel.tsx:230-267  ProbeError + 详情折叠
//   packages/frontend/src/components/mcps/McpInventoryPanel.tsx:269-289  errorCode → i18n 键
//   packages/frontend/src/lib/mcp-probe-query.ts:100-118         409 stale/superseded → resultStale
//   packages/backend/src/routes/mcps.ts:544-561                  探测前的 hash 闸与 mcp-disabled 闸
//   packages/backend/src/routes/mcps.ts:392-394                  PUT 的 hash 闸（assertExpectedHash）
//   packages/backend/src/services/mcpProbe.ts:126-133            enabled=false 在任何 I/O 之前就拒
//   packages/backend/src/services/mcpProbe.ts:193-211            partial：status 仍是 ok，只标 errorCode
//   packages/backend/src/services/mcpProbe.ts:367-411            classifyProbeError 的分档顺序
//   packages/backend/src/services/mcpProbe.ts:52                 HARD_TOTAL_TIMEOUT_MS = 60_000（timeout 档的唯一来源）
//   packages/backend/src/services/agent.ts:1037-1065             plugin-disabled（422）
//   packages/shared/src/mcp-operation.ts:42-57                   操作 hash 覆盖 updatedAt ⇒ 任何写入都会让旧 hash 作废
//   packages/system-mocks/src/mcp/stdio.ts:6-18                  stdio 桩的 ok / crash / hang 三档（本文件只用既有档，未新增）
//   packages/system-mocks/src/code-host/http.ts:17-20            未带凭据的请求一律 401（auth-required 的真来源）
//
// 执行模型：全文件共用一个 daemon（默认 stub 模式，不跑任何任务）。所有请求用 daemon 的
// 管理员会话，避免与 ACL 纠缠——本文件验的是资源管理本身，不是可见性（RES-15 / RES-28
// 另有其人）。每一档探测失败都用**真的**被探测端造出来，全程零请求注入：不存在的可执行
// 文件（ENOENT）、既有 stdio 桩的 crash / hang 两档、system-mock 那个「没凭据一律 401」的
// HTTP 面，以及一台在临时目录里现写的、真说 MCP stdio 协议的服务器——daemon 走的是完整的
// StdioClientTransport + 真握手 + 真 list 调用，只是这台服务器故意不实现 prompts/list。

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultSystemMockToolPath, startDaemon, type DaemonHandle } from './harness'

test.setTimeout(150_000)

let daemon: DaemonHandle
let fixtureDir: string
let partialServerPath: string
let missingBinaryPath: string
let systemMockTool: string
let sequence = 0

// ---------------------------------------------------------------------------
// 夹具：一台**真的**说 MCP stdio 协议的服务器，唯独 prompts/list 回 JSON-RPC 错误。
//
// 为什么必须自己写一台：仓内既有的 stdio 桩（packages/system-mocks/src/mcp/server.ts:82-86）
// 把 tools / resources / prompts 三种能力全实现了，永远探不出 partial；而
// `packages/backend/tests/rfc254-stub-differential.test.ts` 要求给桩加档要么补 golden、
// 要么进 POST_PORT_MODES，动它有连带成本。这台服务器只活在本用例的临时目录里，走的仍是
// daemon 的真实探测路径（真 spawn、真握手、真 list 调用），只是它对 prompts/list 应答
// 一个 -32601——这正是 partial 的定义：服务器可达，清单枚举不全。
// stdio 帧格式 = 一行一条 JSON（SDK 的 ReadBuffer 按 '\n' 切分）。
// initialize 的 protocolVersion 原样回抄客户端请求的那个，避免版本协商把用例变脆。
// ---------------------------------------------------------------------------
const PARTIAL_MCP_SERVER_SOURCE = `'use strict'
let pending = ''
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8')
  let index = pending.indexOf('\\n')
  while (index >= 0) {
    const line = pending.slice(0, index).replace(/\\r$/, '')
    pending = pending.slice(index + 1)
    if (line.trim() !== '') handle(JSON.parse(line))
    index = pending.indexOf('\\n')
  }
})
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
function handle(message) {
  const id = message.id
  if (id === undefined || id === null) return
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'rfc319-partial-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'still-here',
            description: 'listed even though prompts/list failed',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    })
    return
  }
  if (message.method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
    return
  }
  if (message.method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } })
    return
  }
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'method not implemented by this fixture: ' + message.method },
  })
}
process.stdin.resume()
`

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
    timeoutMs?: number
  }
  operationConfigHash: string
  updatedAt: number
}

interface ProbeRow {
  mcpId: string
  status: 'ok' | 'error'
  errorCode: string | null
  errorMessage: string | null
  errorDetail: Record<string, unknown> | null
  tools: Array<{ name: string }> | null
  startedAt: number
}

interface PluginRow {
  id: string
  name: string
  description: string
  enabled: boolean
  operationConfigHash: string
}

interface AgentRow {
  id: string
  name: string
  description: string
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

function requiredEnv(name: string): string {
  const value = process.env[name]
  expect(value, `${name} 未注入 —— system mock 套件没起来，本文件的 401 夹具无从谈起`).toBeTruthy()
  return value as string
}

function nextSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

async function seedLocalMcp(input: {
  slug: string
  command: string[]
  timeoutMs: number
  enabled?: boolean
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
        config: { command: input.command, timeoutMs: input.timeoutMs },
        enabled: input.enabled ?? true,
      }),
    },
    `seed local mcp ${input.slug}`,
  )
}

async function seedRemoteMcp(input: {
  slug: string
  url: string
  timeoutMs: number
}): Promise<McpRow> {
  return json<McpRow>(
    '/api/mcps',
    {
      method: 'POST',
      body: JSON.stringify({
        name: input.slug,
        description: 'rfc319 fixture',
        type: 'remote',
        config: { url: input.url, timeoutMs: input.timeoutMs, oauth: false },
        enabled: true,
      }),
    },
    `seed remote mcp ${input.slug}`,
  )
}

function readMcp(id: string): Promise<McpRow> {
  return json<McpRow>(`/api/mcps/${id}`, undefined, `read mcp ${id}`)
}

function readStoredProbe(id: string): Promise<ProbeRow> {
  return json<ProbeRow>(`/api/mcps/${id}/probe`, undefined, `read stored probe ${id}`)
}

/** 接口层探测一次（用当前保存版本的 hash）。 */
async function probeViaApi(mcp: McpRow): Promise<ProbeRow> {
  return json<ProbeRow>(
    `/api/mcps/${mcp.id}/probe`,
    { method: 'POST', body: JSON.stringify({ expectedConfigHash: mcp.operationConfigHash }) },
    `probe mcp ${mcp.name}`,
  )
}

/** 背着页面改一次这条 MCP —— 模拟「另一个人 / 另一个标签页刚刚保存过」。 */
async function mutateBehindThePage(mcp: McpRow, description: string): Promise<McpRow> {
  const current = await readMcp(mcp.id)
  return json<McpRow>(
    `/api/mcps/${mcp.id}`,
    {
      method: 'PUT',
      body: JSON.stringify({ description, expectedConfigHash: current.operationConfigHash }),
    },
    `mutate mcp ${mcp.name} behind the page`,
  )
}

async function seedPlugin(slug: string): Promise<PluginRow> {
  return json<PluginRow>(
    '/api/plugins',
    {
      method: 'POST',
      body: JSON.stringify({
        name: slug,
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

async function seedAgentReferencing(slug: string, pluginId: string): Promise<AgentRow> {
  return json<AgentRow>(
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name: slug,
        description: 'references a plugin',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'body',
        plugins: [pluginId],
      }),
    },
    `seed agent ${slug}`,
  )
}

function readAgent(id: string): Promise<AgentRow> {
  return json<AgentRow>(`/api/agents/${id}`, undefined, `read agent ${id}`)
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

function waitForProbePost(page: Page, mcpId: string, timeout: number) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/mcps/${mcpId}/probe`,
    { timeout },
  )
}

function waitForMcpPut(page: Page, mcpId: string, timeout: number) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/mcps/${mcpId}`,
    { timeout },
  )
}

/** 打开某条 MCP 的详情页并切到「Tools & probe」页签。 */
async function openProbeTab(page: Page, mcpId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/mcps/${mcpId}`)
  await expect(
    page.getByTestId('mcp-tab-probe'),
    '详情页没渲染出探测页签 ⇒ 用户根本没有查看 / 重跑探测的入口',
  ).toBeVisible()
  await page.getByTestId('mcp-tab-probe').click()
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  systemMockTool = defaultSystemMockToolPath()
  fixtureDir = mkdtempSync(join(tmpdir(), 'rfc319-mcp-'))
  partialServerPath = join(fixtureDir, 'partial-mcp-server.cjs')
  writeFileSync(partialServerPath, PARTIAL_MCP_SERVER_SOURCE, 'utf8')
  // 刻意**不创建**这个文件：它就是「命令写错了」的那条 MCP。
  missingBinaryPath = join(fixtureDir, 'no-such-mcp-binary')
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (fixtureDir !== undefined) rmSync(fixtureDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// RES-16 —— 新建表单：必填校验挡在请求之前 + local/remote 分段切换
// ---------------------------------------------------------------------------

test('RFC-319 RES-16: 新建 MCP 的必填校验挡在请求之前，local ↔ remote 分段切换换掉整组必填字段', async ({
  page,
}) => {
  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps/new`)

  // 数一数到底发出去了几个创建请求。这条计数是本用例的核心：校验的意义在于
  // **别把坏行写进库**，只看红字不看请求，等于允许「先发了再报错」。
  let createAttempts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/mcps') {
      createAttempts += 1
    }
  })

  const createButton = page.getByTestId('mcp-save-button')
  await expect(
    createButton,
    '名字还没填就能点「创建」⇒ 用户点下去只会撞一条服务端报错，表单白填一遍',
  ).toBeDisabled()

  const slug = nextSlug('rfc319-new-mcp')
  await page.locator('#mcp-field-name').fill(slug)
  await expect(createButton).toBeEnabled()

  // ① local 下命令为空。
  await createButton.click()
  await expect(
    page.locator('#mcp-field-command-error'),
    '命令为空却没有报错 ⇒ 库里会多一条永远起不来的本地 MCP，直到某个任务真去拉它的工具才炸',
  ).toHaveText('Command must contain at least one executable entry.')
  expect(createAttempts, '校验没过却已经把请求发出去了 ⇒ 校验只是装饰').toBe(0)
  await expect(page).toHaveURL(/\/mcps\/new$/)

  // ② 切到 remote：本地字段整组消失，远端字段整组出现。
  await page
    .getByRole('radiogroup', { name: 'Type' })
    .getByRole('radio', { name: 'Remote (http / sse)' })
    .click()
  await expect(
    page.locator('#mcp-field-command'),
    '切到远端后 Command 还在 ⇒ 用户以为自己配的是远端，实际带着一条本地命令行进库',
  ).toBeHidden()
  await expect(
    page.locator('#mcp-field-url'),
    '切到远端却没有 URL 输入框 ⇒ 远端 MCP 根本没法新建',
  ).toBeVisible()
  await expect(
    page.locator('#mcp-field-command-error'),
    '切换类型后仍挂着上一种类型的必填红字 ⇒ 用户被一条永远填不掉的错误卡死在新建页',
  ).toHaveCount(0)

  // ③ remote 下 URL 缺 scheme。
  await page.locator('#mcp-field-url').fill('mcp.example.com/sse')
  await createButton.click()
  await expect(
    page.locator('#mcp-field-url-error'),
    '没有 scheme 的地址被放行 ⇒ 探测时才会以一句看不懂的 URL 解析错误收场',
  ).toHaveText('URL must start with http:// or https://.')
  expect(createAttempts).toBe(0)

  // ④ 超时填了个非正整数。
  await page.locator('#mcp-field-url').fill('https://mcp.example.com/sse')
  await page.locator('#mcp-field-timeout').fill('0')
  await createButton.click()
  await expect(
    page.locator('#mcp-field-timeout-error'),
    '超时 0 被放行 ⇒ 这条 MCP 每次探测 / 调用都会瞬间超时，而配置页看起来完全正常',
  ).toHaveText('Timeout must be a positive whole number of milliseconds.')
  expect(createAttempts).toBe(0)

  // ⑤ 补齐之后才真的创建。
  await page.locator('#mcp-field-timeout').fill('4500')
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/mcps' &&
      response.status() === 201,
    { timeout: 30_000 },
  )
  await createButton.click()
  const createdRow = (await (await created).json()) as McpRow
  await expect(
    page,
    '创建成功却没落到新资源的详情页 ⇒ 用户不知道自己刚建的东西在哪，只能回列表里找',
  ).toHaveURL(new RegExp(`/mcps/${createdRow.id}$`))
  expect(createAttempts, '一次成功创建却发了多个 POST ⇒ 会建出重名/重复行').toBe(1)

  // 落库的必须正是表单上那份，而且**不能夹带**已经被切走的 local 字段。
  const persisted = await readMcp(createdRow.id)
  expect(persisted.type).toBe('remote')
  expect(persisted.name).toBe(slug)
  expect(persisted.config.url).toBe('https://mcp.example.com/sse')
  expect(persisted.config.timeoutMs).toBe(4500)
  expect(
    persisted.config.command,
    '远端 MCP 存进去却带着 command ⇒ 类型切换只是换了张皮，旧字段仍在生效',
  ).toBeUndefined()
})

// ---------------------------------------------------------------------------
// RES-17 / RES-22 —— 改配置真的落库；旧探测结果当场作废
// ---------------------------------------------------------------------------

test('RFC-319 RES-17/RES-22: 改完 MCP 配置保存后字段真的落库，上一版探测结果当场作废', async ({
  page,
}) => {
  const mcp = await seedLocalMcp({
    slug: nextSlug('rfc319-expiry'),
    command: [systemMockTool, 'mcp-stdio'],
    timeoutMs: 10_000,
    description: 'before the edit',
  })
  const firstProbe = await probeViaApi(mcp)
  expect(firstProbe.status, `夹具 MCP 一开始就探不通：${firstProbe.errorMessage}`).toBe('ok')
  expect(firstProbe.errorCode).toBeNull()

  await primeAdmin(page)
  await openProbeTab(page, mcp.id)

  const card = page.getByTestId(`split-card-${mcp.id}`)
  await expect(
    card.getByTestId('mcp-probe-status-ok'),
    '刚探通的 MCP 在列表里不显示 Online ⇒ 用户在列表上完全看不出哪台是活的',
  ).toBeVisible()
  await expect(
    page.getByTestId('mcp-tool-row-ping'),
    '探通了却列不出工具 ⇒ 用户无法确认这台 MCP 到底给代理提供了什么',
  ).toBeVisible()

  // 改三个字段：描述 + 环境变量 + 超时。command 一个字都不碰。
  await page.getByTestId('mcp-tab-config').click()
  await page.getByLabel('Description', { exact: true }).fill('after the edit')
  await page
    .getByLabel('Environment variables')
    .fill('MCP_FIXTURE_FLAG=on\nMCP_FIXTURE_LEVEL=debug')
  await page.locator('#mcp-field-timeout').fill('7500')

  const saved = waitForMcpPut(page, mcp.id, 30_000)
  await page.getByTestId('mcp-save-button').click()
  expect((await saved).status(), '保存 MCP 配置失败').toBe(200)

  const persisted = await readMcp(mcp.id)
  expect(
    persisted.config.env,
    '环境变量没存进去 ⇒ 用户照着提示把凭据填了，跑起来 MCP 还是拿不到',
  ).toEqual({ MCP_FIXTURE_FLAG: 'on', MCP_FIXTURE_LEVEL: 'debug' })
  expect(persisted.config.timeoutMs, '超时没存进去 ⇒ 用户改的每一次超时都是白改').toBe(7500)
  expect(persisted.description).toBe('after the edit')
  expect(
    persisted.config.command,
    '只改了 env / timeout 却把 command 冲掉了 ⇒ 一次无关的保存把这台 MCP 变成不可启动',
  ).toEqual([systemMockTool, 'mcp-stdio'])

  // 保存过后，上一版的探测结果必须在**两处**同时作废。
  await expect(
    card.getByTestId('mcp-probe-status-unknown'),
    '改完配置列表里还挂着上一版的 Online ⇒ 用户盯着一枚描述旧配置的绿灯做决策',
  ).toBeVisible()
  await page.getByTestId('mcp-tab-probe').click()
  await expect(
    page.getByTestId('mcp-probe-expired'),
    '详情面板仍把过期结果当成现状 ⇒ 用户以为工具还在、地址还通，而这一版可能根本连不上',
  ).toBeVisible()
  await expect(
    page.locator('.notice-banner', { hasText: 'The saved probe result is out of date.' }),
    '过期了却没有一句提示 ⇒ 用户不知道该重新探测',
  ).toBeVisible()
  await expect(
    page.getByTestId('mcp-tool-row-ping'),
    '过期之后还继续列着上一版的工具 ⇒ 最容易被误信的就是这份清单',
  ).toHaveCount(0)

  // 作废是**呈现层的判定**，不是把结果删了：服务端那条记录仍在，重新探测前它只是不再算数。
  const stored = await readStoredProbe(mcp.id)
  expect(stored.status).toBe('ok')
  expect(
    stored.startedAt < persisted.updatedAt,
    '保存后的 updatedAt 没有越过旧探测的 startedAt ⇒ 新鲜度判据失效，过期结果会被当成现状',
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// RES-23 —— 草稿未保存时的两个探测按钮，各自用的是哪一份配置
// ---------------------------------------------------------------------------

test('RFC-319 RES-23: 草稿未保存时「用已保存版本探测」与「保存并探测」用的是两份不同的配置', async ({
  page,
}) => {
  // 已保存版本 = 通的；草稿 = 一条不存在的可执行文件。两者结果相反，用错版本立刻穿帮。
  const mcp = await seedLocalMcp({
    slug: nextSlug('rfc319-draft-choice'),
    command: [systemMockTool, 'mcp-stdio'],
    timeoutMs: 10_000,
  })

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps/${mcp.id}`)
  await expect(page.getByTestId('mcp-save-button')).toBeVisible()
  await page.locator('#mcp-field-command').fill(missingBinaryPath)
  await page.getByTestId('mcp-tab-probe').click()

  await expect(
    page.locator('.notice-banner', { hasText: 'Current changes are not saved' }),
    '草稿未保存却没有任何提示 ⇒ 用户会以为下面那颗按钮探的就是他眼前这份配置',
  ).toBeVisible()
  await expect(
    page.getByTestId('mcp-probe-saved-version'),
    '草稿态下没有「用已保存版本探测」⇒ 用户想验证线上那一版，只能先把草稿丢掉',
  ).toBeVisible()
  await expect(
    page.getByTestId('mcp-save-and-probe'),
    '草稿态下没有「保存并探测」⇒ 用户要分两步做，中间任何人改一下就探的不是自己那份了',
  ).toBeVisible()

  // ① 用已保存版本探测：结果必须是「通」，即那条**没被草稿污染**的命令。
  const savedVersionProbe = waitForProbePost(page, mcp.id, 60_000)
  await page.getByTestId('mcp-probe-saved-version').click()
  const savedVersionReceipt = (await (await savedVersionProbe).json()) as ProbeRow
  expect(
    savedVersionReceipt.status,
    '「用已保存版本探测」探出了失败 ⇒ 它其实拿的是草稿里那条坏命令，按钮名不副实',
  ).toBe('ok')
  await expect(page.getByTestId('mcp-tool-row-ping')).toBeVisible()
  expect(
    (await readMcp(mcp.id)).config.command,
    '「用已保存版本探测」把草稿顺手保存了 ⇒ 用户只想试一下，配置却被改了',
  ).toEqual([systemMockTool, 'mcp-stdio'])

  // ② 保存并探测：先落库，再用**新**版本探测，于是必须探出失败。
  const put = waitForMcpPut(page, mcp.id, 30_000)
  const draftProbe = waitForProbePost(page, mcp.id, 60_000)
  await page.getByTestId('mcp-save-and-probe').click()
  expect((await put).status(), '「保存并探测」没有先保存 ⇒ 探的仍是旧版本').toBe(200)
  const draftReceipt = (await (await draftProbe).json()) as ProbeRow
  expect(
    draftReceipt.status,
    '「保存并探测」探出了成功 ⇒ 它用的是保存前那一版，用户会拿着绿灯上线一条从没被验证过的配置',
  ).toBe('error')
  expect(draftReceipt.errorCode).toBe('connect-failed')
  expect((await readMcp(mcp.id)).config.command).toEqual([missingBinaryPath])
  await expect(
    page.getByTestId('mcp-inventory-error'),
    '探测失败却不在面板上说 ⇒ 用户点完按钮什么都没看到，以为存好了',
  ).toContainText('Connect failed')
})

// ---------------------------------------------------------------------------
// RES-21 —— 四种错误码（含 connect-failed 的两条判定分支）各自渲染自己的事实与详情
// ---------------------------------------------------------------------------

test('RFC-319 RES-21: connect-failed / handshake-failed / auth-required / partial 各自渲染自己的错误码与详情', async ({
  page,
}) => {
  const unauthenticatedHttpEndpoint = `${requiredEnv('AW_SYSTEM_MOCK_GITHUB_API_BASE_URL')}/mcp`

  // `expectedTexts` = 这一屏必须把哪些事实写给用户看：先是**哪一类失败**（本地化的码文案），
  // 再是**具体是哪一条**（缺失的路径 / 等了多少毫秒 / 哪个方法没实现）。只断言前者不够——
  // 「Connect failed」四个字对着一份 20 台 MCP 的列表毫无指向性。
  // `expectedDetail` 只在**当前确实存在**结构化详情时才填：这里刻意不断言「某几档没有详情」，
  // 那是现状不是契约（见下面 connect-failed 两档的注释），未来补上详情不该把这条用例变红。
  const cases = [
    {
      // ① 命令根本不存在：spawn 直接 ENOENT，连子进程都没有。
      label: 'connect-failed / 命令不存在',
      mcp: await seedLocalMcp({
        slug: nextSlug('rfc319-connect-missing'),
        command: [missingBinaryPath],
        timeoutMs: 10_000,
      }),
      expectedCode: 'connect-failed',
      expectedChip: 'mcp-probe-status-error',
      expectedTexts: ['Connect failed', missingBinaryPath],
      expectedDetail: null,
      consequence:
        '命令找不到却不把那条路径回显出来 ⇒ 用户对着一句「连接失败」，不知道是路径写错、没装、还是没有执行权限',
    },
    {
      // ② 子进程起来了又立刻死掉：走的是另一条判定分支（连接被关闭，而不是 ENOENT），
      //    这一档同样必须落在 connect-failed 上，否则用户会被指去查网络。
      //    ⚠️ 现状：这一档没有可展开的详情——子进程的 stderr 采集不到失败路径上
      //    （services/mcpProbe.ts:243 读的是 `client?.capturedStderr()`，而 openClient
      //    在握手失败时抛错、那个 client 对象根本没被构造出来）。已单独报为产品缺陷；
      //    这里**不**断言「详情不存在」，以免把这个缺陷锁成契约。
      label: 'connect-failed / 子进程起来就崩',
      mcp: await seedLocalMcp({
        slug: nextSlug('rfc319-connect-crash'),
        command: [systemMockTool, 'mcp-stdio', 'crash'],
        timeoutMs: 10_000,
      }),
      expectedCode: 'connect-failed',
      expectedChip: 'mcp-probe-status-error',
      expectedTexts: ['Connect failed', 'Connection closed'],
      expectedDetail: null,
      consequence:
        '子进程崩了却报成握手 / 超时 ⇒ 用户去调超时参数，而真正该看的是这条命令自己为什么活不下来',
    },
    {
      // ③ 传输通了、initialize 没人应答：这是「握手超时」，与整体 60s 天花板是两码事。
      label: 'handshake-failed',
      mcp: await seedLocalMcp({
        slug: nextSlug('rfc319-handshake-failed'),
        command: [systemMockTool, 'mcp-stdio', 'hang'],
        timeoutMs: 3_000,
      }),
      expectedCode: 'handshake-failed',
      expectedChip: 'mcp-probe-status-error',
      // 3000 = 这条 MCP 自己配的超时。不回显它，用户不知道该去调哪个旋钮。
      expectedTexts: ['Handshake failed', '3000'],
      expectedDetail: null,
      consequence:
        '进程活着但不应答却报成 connect-failed ⇒ 用户去查命令行和路径，而真正该调的是超时与服务端实现',
    },
    {
      // ④ 远端要凭据：system mock 的 HTTP 面对未带凭据的请求一律 401。
      label: 'auth-required',
      mcp: await seedRemoteMcp({
        slug: nextSlug('rfc319-auth-required'),
        url: unauthenticatedHttpEndpoint,
        timeoutMs: 10_000,
      }),
      expectedCode: 'auth-required',
      expectedChip: 'mcp-probe-status-error',
      expectedTexts: ['Authentication required'],
      expectedDetail: '401',
      consequence: '缺凭据被报成连接失败 ⇒ 用户去查网络查一晚上，而只要在 Headers 里补一行就好了',
    },
    {
      // ⑤ 服务器可达、工具清单完整，只有 prompts/list 没实现。
      label: 'partial',
      mcp: await seedLocalMcp({
        slug: nextSlug('rfc319-partial'),
        command: [process.execPath, partialServerPath],
        timeoutMs: 10_000,
      }),
      expectedCode: 'partial',
      expectedChip: 'mcp-probe-status-ok',
      expectedTexts: ['Some list endpoints are missing on the server side', 'prompts/list'],
      expectedDetail: 'prompts/list',
      consequence:
        'partial 被渲染成红色 Error ⇒ 用户会把一台完全可用的 MCP 当成坏的删掉；反过来一声不吭 ⇒ 用户不知道有一类清单其实没拿到',
    },
  ] as const

  await primeAdmin(page)

  for (const item of cases) {
    await openProbeTab(page, item.mcp.id)
    const probed = waitForProbePost(page, item.mcp.id, 60_000)
    await page.getByTestId(`mcp-inventory-reprobe-${item.mcp.id}`).click()
    const receipt = (await (await probed).json()) as ProbeRow
    expect(
      receipt.errorCode,
      `${item.label}: 服务端判成了 ${receipt.errorCode ?? 'null'} —— ${item.consequence}`,
    ).toBe(item.expectedCode)

    const panel = page.getByTestId('mcp-panel-probe')
    await expect(
      panel.getByTestId(item.expectedChip),
      `${item.label}: 状态 chip 不对 —— ${item.consequence}`,
    ).toBeVisible()
    for (const text of item.expectedTexts) {
      await expect(
        page.getByTestId('mcp-inventory-error'),
        `${item.label}: 这一屏没有写出「${text}」—— ${item.consequence}`,
      ).toContainText(text)
    }

    if (item.expectedDetail !== null) {
      await page.getByTestId('mcp-inventory-error-detail-toggle').click()
      await expect(
        page.locator('.mcp-inventory__error-detail pre'),
        `${item.label}: 展开详情后拿不到 HTTP 状态 / 失败的方法名 ⇒ 排查线索整条丢失`,
      ).toContainText(item.expectedDetail)
    }

    if (item.expectedCode === 'partial') {
      // partial 的关键在于「剩下的清单仍然可用」——这是它和真失败最本质的区别。
      await expect(
        page.getByTestId('mcp-tool-row-still-here'),
        'partial 时把已经拿到的工具也一并丢弃 ⇒ 用户以为这台 MCP 什么都没有',
      ).toBeVisible()
      expect(receipt.status, 'partial 被记成 error ⇒ 一台可用的 MCP 在全系统里都显示为坏的').toBe(
        'ok',
      )
      expect(receipt.tools?.map((tool) => tool.name)).toEqual(['still-here'])
    }
  }
})

// ---------------------------------------------------------------------------
// RES-21（续）—— 60 秒总时限那一档
// ---------------------------------------------------------------------------

test('RFC-319 RES-21: 探测撞上 60 秒总时限时报 timeout，而不是伪装成握手失败', async ({ page }) => {
  // 单次调用超时故意配得比 60s 天花板还长（services/mcpProbe.ts:52），
  // 于是先触发的必然是**总时限**——这是 timeout 这一档唯一的真实来源。
  const mcp = await seedLocalMcp({
    slug: nextSlug('rfc319-timeout'),
    command: [systemMockTool, 'mcp-stdio', 'hang'],
    timeoutMs: 120_000,
  })

  await primeAdmin(page)
  await openProbeTab(page, mcp.id)

  const probed = waitForProbePost(page, mcp.id, 120_000)
  await page.getByTestId(`mcp-inventory-reprobe-${mcp.id}`).click()
  await expect(
    page.getByTestId('mcp-probe-running'),
    '一分钟的等待里界面不说自己在探测 ⇒ 用户以为按钮没反应，会反复点、最后关掉页面',
  ).toBeVisible({ timeout: 30_000 })

  const receipt = (await (await probed).json()) as ProbeRow
  expect(
    receipt.errorCode,
    '撞上总时限却报成别的码 ⇒ 用户按错误提示去调单次超时，而真正触顶的是 60s 总预算，怎么调都没用',
  ).toBe('timeout')
  await expect(
    page.getByTestId('mcp-inventory-error'),
    '超时之后面板不说明原因 ⇒ 用户等了一分钟，只等来一片空白',
  ).toContainText('60s ceiling', { timeout: 30_000 })
  await expect(
    page.getByTestId('mcp-panel-probe').getByTestId('mcp-probe-status-error'),
    '超时之后状态 chip 没变红 ⇒ 列表和详情都还把它当成未知/正常',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// RES-37 —— exact-operation 陈旧冲突（MCP 探测 + 插件保存）
// ---------------------------------------------------------------------------

test('RFC-319 RES-37: MCP 探测与插件保存都必须认出「这条资源已经被人改过」，而不是拿旧版本继续', async ({
  page,
}) => {
  // ---- MCP：页面手里的 hash 已经不是当前版本，探测必须被拒 ----
  const mcp = await seedLocalMcp({
    slug: nextSlug('rfc319-stale-probe'),
    command: [systemMockTool, 'mcp-stdio'],
    timeoutMs: 10_000,
  })

  await primeAdmin(page)
  await openProbeTab(page, mcp.id)

  // 先证明这颗按钮本来是好的，否则「被拒」可能只是它一直坏着。
  const healthy = waitForProbePost(page, mcp.id, 60_000)
  await page.getByTestId(`mcp-inventory-reprobe-${mcp.id}`).click()
  expect(((await (await healthy).json()) as ProbeRow).status).toBe('ok')
  const okProbe = await readStoredProbe(mcp.id)

  // 另一个人（另一个标签页 / 脚本 / 同事）刚刚保存了这条 MCP。
  await mutateBehindThePage(mcp, 'changed by somebody else')

  const stale = waitForProbePost(page, mcp.id, 60_000)
  await page.getByTestId(`mcp-inventory-reprobe-${mcp.id}`).click()
  const staleResponse = await stale
  expect(
    staleResponse.status(),
    '拿着旧 hash 的探测被照常执行 ⇒ 用户会得到一份描述上一版配置的探测结果，并把它当成现状',
  ).toBe(409)
  expect((JSON.parse(await staleResponse.text()) as { code: string }).code).toBe(
    'resource-operation-stale',
  )
  await expect(
    page.locator('.notice-banner', { hasText: 'The MCP changed before this probe settled' }),
    '被拒了却不告诉用户为什么 ⇒ 用户只看到按钮点了没反应，会一直点下去',
  ).toBeVisible()
  const afterStale = await readStoredProbe(mcp.id)
  expect(
    afterStale.startedAt,
    '被拒的探测仍然覆盖了已存的结果 ⇒ 「拒绝」只拒了个响，脏数据照样落库',
  ).toBe(okProbe.startedAt)

  // ---- 插件：保存也要被同一道闸拦住，不能静默盖掉别人写的内容 ----
  const plugin = await seedPlugin(nextSlug('rfc319-stale-plugin'))
  await page.goto(`${daemon.baseUrl}/plugins/${plugin.id}`)
  await expect(page.getByTestId('plugin-save-button')).toBeVisible()

  const currentPlugin = await readPlugin(plugin.id)
  await json<PluginRow>(
    `/api/plugins/${plugin.id}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        description: 'written by somebody else',
        expectedConfigHash: currentPlugin.operationConfigHash,
      }),
    },
    'mutate plugin behind the page',
  )

  await page.getByTestId('plugin-tab-config').click()
  await page.locator('#plugin-field-description').fill('my own edit')
  const pluginSave = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/plugins/${plugin.id}`,
    { timeout: 30_000 },
  )
  await page.getByTestId('plugin-save-button').click()
  const pluginSaveResponse = await pluginSave
  expect(
    pluginSaveResponse.status(),
    '拿着旧版本的保存被放行 ⇒ 用户静默盖掉了同事刚写进去的内容，双方都不会知道',
  ).toBe(409)
  expect((JSON.parse(await pluginSaveResponse.text()) as { code: string }).code).toBe(
    'resource-operation-stale',
  )
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The resource changed since this operation started' }),
    '冲突没有出现在界面上 ⇒ 用户以为保存成功了，实际什么都没写进去',
  ).toBeVisible()
  expect((await readPlugin(plugin.id)).description, '别人的内容还是被盖掉了 ⇒ 409 只是个幌子').toBe(
    'written by somebody else',
  )
})

// ---------------------------------------------------------------------------
// RES-X3 —— enabled 开关：MCP 关掉后不可探测；插件关掉后引用它的代理存不下
// ---------------------------------------------------------------------------

test('RFC-319 RES-X3: 关掉 enabled 之后 MCP 不再可探测，插件让引用它的代理保存被拒', async ({
  page,
}) => {
  // ---- MCP ----
  const mcp = await seedLocalMcp({
    slug: nextSlug('rfc319-disable-mcp'),
    command: [systemMockTool, 'mcp-stdio'],
    timeoutMs: 10_000,
  })
  const before = await probeViaApi(mcp)
  expect(before.status, '夹具 MCP 在被停用之前就探不通，这条用例证明不了任何事').toBe('ok')

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps/${mcp.id}`)
  const enabledSwitch = page.getByTestId('mcp-panel-config').getByRole('checkbox')
  await expect(
    enabledSwitch,
    '详情页没有 Enabled 开关 ⇒ 用户想临时停用一台 MCP，只能把它删掉',
  ).toBeChecked()
  await enabledSwitch.uncheck()
  const saved = waitForMcpPut(page, mcp.id, 30_000)
  await page.getByTestId('mcp-save-button').click()
  expect((await saved).status()).toBe(200)
  expect(
    (await readMcp(mcp.id)).enabled,
    '开关关了却没落库 ⇒ 用户以为停用了，daemon 下次照样把它注入给代理',
  ).toBe(false)

  await expect(
    page.getByTestId(`split-card-${mcp.id}`),
    '停用后列表卡片看不出区别 ⇒ 用户在列表上分不清哪些是停用的，会照着挑进代理',
  ).toContainText('disabled')

  await page.getByTestId('mcp-tab-probe').click()
  const refused = waitForProbePost(page, mcp.id, 60_000)
  await page.getByTestId(`mcp-inventory-reprobe-${mcp.id}`).click()
  const refusedResponse = await refused
  expect(
    refusedResponse.status(),
    '已停用的 MCP 仍然探得动 ⇒ 用户拿一枚绿灯确认「它还在服务」，而运行时根本不会加载它',
  ).toBe(422)
  expect((JSON.parse(await refusedResponse.text()) as { code: string }).code).toBe('mcp-disabled')
  await expect(
    page.getByRole('alert').filter({ hasText: 'This MCP is disabled' }),
    '被拒了却不说是因为停用 ⇒ 用户会去查网络、查命令，而只要把开关打开就好了',
  ).toBeVisible()
  expect(
    (await readStoredProbe(mcp.id)).startedAt,
    '被拒的探测竟然覆盖了已存结果 ⇒ 停用一台 MCP 会顺手毁掉它上一次的诊断记录',
  ).toBe(before.startedAt)

  // ---- 插件 ----
  const plugin = await seedPlugin(nextSlug('rfc319-disable-plugin'))
  const agent = await seedAgentReferencing(nextSlug('rfc319-disable-agent'), plugin.id)

  await page.goto(`${daemon.baseUrl}/plugins/${plugin.id}`)
  await page.getByTestId('plugin-tab-config').click()
  const pluginSwitch = page.getByTestId('plugin-panel-config').getByRole('checkbox')
  await expect(pluginSwitch).toBeChecked()
  await pluginSwitch.uncheck()
  const pluginSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/plugins/${plugin.id}`,
    { timeout: 30_000 },
  )
  await page.getByTestId('plugin-save-button').click()
  expect((await pluginSaved).status()).toBe(200)
  expect(
    (await readPlugin(plugin.id)).enabled,
    '插件开关关了却没落库 ⇒ 用户以为停用了，它照样被注入进每一次运行',
  ).toBe(false)
  await expect(
    page.getByTestId(`split-card-${plugin.id}`),
    '停用后插件卡片看不出区别 ⇒ 用户会继续把一个已停用的插件挂到新代理上',
  ).toContainText('disabled')

  // 引用它的代理：这时候保存必须被拒，而且要说清是哪一类问题。
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible()
  await page.getByTestId('agent-tab-basics').click()
  await page.getByLabel('Description', { exact: true }).fill('edited while the plugin is off')
  const agentSave = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/agents/${agent.id}`,
    { timeout: 30_000 },
  )
  await page.getByTestId('agent-save-button').click()
  const agentSaveResponse = await agentSave
  expect(
    agentSaveResponse.status(),
    '引用了已停用插件的代理照样存得下 ⇒ 这条坏引用会一路带到运行期才炸，而保存的那一刻系统明明知道它是坏的',
  ).toBe(422)
  expect((JSON.parse(await agentSaveResponse.text()) as { code: string }).code).toBe(
    'plugin-disabled',
  )
  await expect(
    page.getByRole('alert').filter({ hasText: 'references disabled plugin' }),
    '拒了却不说是插件被停用 ⇒ 用户对着一条读不懂的报错，不知道该去开哪个开关',
  ).toBeVisible()
  expect(
    (await readAgent(agent.id)).description,
    '保存被拒，改动却已经写进去了 ⇒ 「拒绝」只拒了个响',
  ).toBe('references a plugin')
})
