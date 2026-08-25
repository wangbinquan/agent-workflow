// RFC-319 —— 设置页各**配置分区**的用户面 e2e
// （账本 CFG-18 / 19 / 21 / 22 / 25 / 33 / 37 / 38 / X1）。
//
// 这一批旋钮的共同点是：**它们不改变设置页自己的样子，只改变别处的行为**。
// 因此它们坏掉的方式高度一致——界面照常显示「已保存」，而那个值要么根本没落库、
// 要么落了库却没人读。逐条说清这里到底在防什么：
//
//   * 【CFG-18】`extraArgs` / `IS_SANDBOX` 是 claude-code 驱动**独有**的两个通道
//     （opencode 的 spawn 既不读 argv 追加也不写 IS_SANDBOX）。两条失败形态：
//     ① 界面把它们摊给 opencode，用户填了半天，保存时才被 422 打回；
//     ② 更坏的一条——一组**不被接受的参数先被执行、之后才因保存失败而报错**。
//     RFC-317 T71 把能力门前置到了 `smokeRuntime` 之前，本用例要证明的正是
//     「子进程根本没起」，而不只是「接口返回了错误」。
//   * 【CFG-19】config-dir 覆盖的两格：环境变量名撞上平台自己写的键（`IS_SANDBOX`
//     / `PWD` / `GIT_AUTHOR_NAME` …）会让两套机制互相覆盖、其中一套**静默**失效；
//     目录名带分隔符会在 run root **之外** mkdir。两格都必须前端拦一层、服务端再
//     拦一层——只有前端拦 = 任何脚本 / 旧页面都能把坏值写进注册表。
//   * 【CFG-21】System agents 分区一次保存要落齐三类东西（运行时 / 语言 / 数值参数），
//     且**只写本分区自己的键**。漏登记一个键的后果最阴：表单看起来改了、点了保存、
//     没有任何报错，值却被静默丢掉（`lib/settings-drafts.ts` 的白名单注释记的就是
//     这类事故）。
//   * 【CFG-22】同一个 Save 背后是**两个端点**（config PUT + 融合 Agent 行 PUT）。
//     两条判据：只改融合时**不许**再 PUT config（否则会拿一份可能已经过期的 config
//     快照去覆盖同事刚改的 commit/memory/merge）；config 被拒时融合**一格都不许写**
//     （否则用户看到一条「保存失败」的红条，而融合运行时已经被悄悄换掉了）。
//   * 【CFG-25】Recovery 分区是**自动执行**开关：它决定守护进程会不会自己去重启任务、
//     自己去杀子进程。存不住 = 运维以为开了自动恢复，实际重启后一切照旧；断路器阈值
//     存不住 = 一次故障能被无限自动重试放大。
//   * 【CFG-33】外部访问开关是事故杠杆：它必须**同时**关掉 `POST /api/mcp` 与新令牌
//     铸造，并且**不**波及已签发令牌的 REST 通道（`services/mcpSurface.ts` 的注释把
//     这三件事写成了同一个决定）。只关一半 = 事故当中以为止了血，其实还在发新凭据。
//   * 【CFG-37】渲染分区的「测试连接」是管理员**唯一**能在保存前验证端点的手段。四种
//     结果必须各自成立且互相分得开——把超时报成成功、把 500 报成「未填端点」，管理员
//     会照着一个错误结论去配反代 / 去查防火墙。
//   * 【CFG-38】后端代理把渲染搬到了服务端，所以「端点 + 鉴权头」只在服务端到渲染器
//     那一跳出现。五种响应形状是浏览器侧唯一的分支依据：混淆任意两种，用户看到的就是
//     「图不出来，且说不出为什么」。
//   * 【CFG-X1】Limits 的执行预算——账本写的是「保存后被新任务采用」。**这一句只对其中
//     三项成立**（见文末 §账本勘误），本用例按源码实际写：per-node 超时值逐字出现在被
//     杀节点的错误信息里，重试次数按 `(1+F)×(1+R)` 生长。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链——外链会被 CI 的
// markdown link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/components/RuntimeList.tsx:410-425      claude 专属字段在协议切换时归零
//   packages/frontend/src/components/RuntimeList.tsx:576-594      isSandbox Switch + extraArgs ChipsInput 只在 !isOpencode 渲染
//   packages/frontend/src/components/RuntimeList.tsx:378-388      config-dir 两格的内联错误与 Save 闸
//   packages/backend/src/routes/runtimes.ts:230-262               POST /api/runtimes/probe —— 能力门在 smokeRuntime **之前**
//   packages/backend/src/routes/runtimes.ts:264-300               POST /api/runtimes —— 预检 smoke 之前同一道门
//   packages/backend/src/services/runtimeRegistry.ts:715-745      assertRuntimeSpawnCapabilities（RFC-317 T71）
//   packages/backend/src/services/runtimeRegistry.ts:208-262      validateExtraArgs：协议门 / 平台自有 flag / 裸值 token
//   packages/backend/src/services/runtimeRegistry.ts:597-635      validateConfigDirName / validateConfigDirEnv
//   packages/shared/src/runtimeConfigDir.ts:52-95                 RESERVED_SPAWN_ENV + 两个共享判据（env 名大小写不敏感）
//   packages/frontend/src/routes/settings.tsx:1766-1789           System agents 的「一个 Save 两个端点」顺序
//   packages/frontend/src/components/settings/useFusionAgentDraft.ts:437-455  融合行 PUT /api/agents/<merger>
//   packages/frontend/src/lib/settings-drafts.ts:38-118           分区最小写入白名单
//   packages/frontend/src/routes/settings.tsx:709-786             RecoveryTab 的三开关 + 四阈值
//   packages/backend/src/services/mcpSurface.ts:1-21              一个开关关两件事的决定
//   packages/backend/src/mcp/server.ts:175-181                    /api/mcp 的 mcp-surface-disabled
//   packages/backend/src/routes/auth.ts:407-414                   POST /api/auth/pats 的 token-issuance-disabled
//   packages/backend/src/routes/registry.ts:179-190               mcp_only 令牌的 REST 用途门（本文件用 general 令牌绕开它）
//   packages/frontend/src/routes/settings.tsx:2050-2085           RenderingTab 的连通性测试四分支
//   packages/backend/src/routes/plantuml.ts:36-80                 代理的五种响应 + 两道体积闸
//   packages/backend/src/services/plantuml.ts:140-185             三步回退链与 error-svg 早停
//   packages/backend/src/services/launchRuntimeConfig.ts:150-172  per-node 超时 / 重试 / 会话重启预算的启动期解析
//   packages/backend/src/services/startTaskDeps.ts:51             每次启动都重读一次 config
//   packages/backend/src/services/runner.ts:1956-1958             `node-timeout: exceeded {N}ms`
//   packages/backend/src/services/scheduler.ts:5773-5775          maxRetries = retryAttemptCap(F,R) - 1
//   packages/shared/src/prompt.ts:1275-1278                       retryAttemptCap = (1+F)×(1+R)
//
// 与既有覆盖的分工（务必不重复）：
//   · `e2e/rfc319-settings-sections.spec.ts` —— 保存**机制**本身（分区导航 / 回执 /
//     stale / 未保存拦截 / GC / Git / 并发配额六项 / 外观）。本文件不再断言回执机制，
//     只把它当「保存成功」的信号使用。
//   · `e2e/rfc319-settings-runtimes.spec.ts` —— 运行时**注册表**（列表 / 新增预检 /
//     编辑 / 默认 / 启停 / 删除 / 重测 / 模型清单）。它在 CFG-12 里已经覆盖了
//     config-dir **目录名**带分隔符（`a/b`）这一格的内联错误，所以本文件的 CFG-19
//     只覆盖它没碰的另一半：**保留 env 名（含大小写折叠）**、非法 env 名字符、以及
//     两格各自的**服务端**第二道防线。
//   · `e2e/rfc319-ops-settings-panels.spec.ts` —— 同一页上的**动作型**按钮（备份 /
//     恢复 / 磁盘回收 / 归档）。本文件一个动作按钮都不点。
//   · `e2e/rfc319-overview-and-docs.spec.ts` CFG-40 —— `/.well-known/mcp` 的
//     `enabled` 字段（它用带外 PATCH 改 config，不碰界面开关，也不打 `/api/mcp`）。
//     本文件 CFG-33 走的是界面开关 + 两条**真实**被关停的通道。
//   · `e2e/system-mocks.spec.ts` —— 用统一 system mock 渲染器验证代理 happy path。
//     本文件 CFG-38 覆盖它没碰的另外四种响应形状，用一台**行为可编程**的本地渲染器。
//
// 执行模型：两个 daemon、**不用 serial**（`docs/dev-gotchas.md`：一条红之后 worker
// 会被丢弃、`beforeAll` 重跑，serial 还会让其余用例 `did not run`，变异验证无法按
// 「红了几条」归因）。每条用例自带夹具、自己 seed 前置配置，互不承接状态。
//   · `daemon`      —— 设置页各分区用。`stubMode: 'slow'` + `STUB_OPENCODE_HOLD_FILE`：
//     hold 文件本身**从不创建**，只借用 stub 在启动早期写下的 `<hold>.started`
//     当作「这个二进制真的被拉起来过」的证据（mode-slow.ts:62-70，该写入排在
//     `requireOutputOpen` 之前，所以冒烟提示词不带 RFC-200 信封也照样留痕）。
//   · `budgetDaemon` —— CFG-X1 专用。同样的 hold 通道（用来把一个节点确定性地挂住
//     以触发 per-node 超时），外加 `STUB_OPENCODE_SKIP_ENVELOPE=1`：不挂住时 stub
//     秒退且不吐信封 ⇒ 节点以 `envelope-missing` 失败 ⇒ 走的正是重试预算那条路。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(240_000)

/** 融合面背后的内置 Agent 行（useFusionAgentDraft.ts:17）。 */
const SKILL_MERGER_AGENT_ID = '00000000000000000000000001'

let daemon: DaemonHandle
let budgetDaemon: DaemonHandle
let holdDir: string
/** 从不创建；只有它的 `.started` 兄弟文件会被 stub 写出来。 */
let spawnHoldFile: string
let spawnMarker: string
/** CFG-X1 专用：创建它 = 把下一次 stub 调用确定性地挂在半空中。 */
let budgetHoldFile: string

test.beforeAll(async () => {
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-cfgsec-'))
  spawnHoldFile = join(holdDir, 'probe-hold')
  spawnMarker = `${spawnHoldFile}.started`
  budgetHoldFile = join(holdDir, 'budget-hold')
  daemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: spawnHoldFile },
  })
  budgetDaemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: budgetHoldFile, STUB_OPENCODE_SKIP_ENVELOPE: '1' },
  })
})

test.afterAll(async () => {
  try {
    rmSync(budgetHoldFile, { force: true })
  } catch {
    /* best-effort */
  }
  if (daemon !== undefined) await daemon.stop()
  if (budgetDaemon !== undefined) await budgetDaemon.stop()
  try {
    rmSync(holdDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// `page.route` 注入只出现在 CFG-22 的后半段；无条件摘干净是本仓的硬纪律
// （docs/dev-gotchas.md §「page.route 两把锁」——必须 'wait'，不是 'ignoreErrors'）。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type Json = Record<string, unknown>

async function rawApiOn(d: DaemonHandle, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${d.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function apiOn<T>(d: DaemonHandle, path: string, init?: RequestInit): Promise<T> {
  const res = await rawApiOn(d, path, init)
  const text = await res.text()
  expect(res.ok, `${init?.method ?? 'GET'} ${path}: ${res.status} ${text}`).toBe(true)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function rawApi(path: string, init?: RequestInit): Promise<Response> {
  return rawApiOn(daemon, path, init)
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return apiOn<T>(daemon, path, init)
}

async function readConfigOn(d: DaemonHandle): Promise<Json> {
  return apiOn<Json>(d, '/api/config')
}

async function readConfig(): Promise<Json> {
  return readConfigOn(daemon)
}

/** 守护进程下次启动会读的那份文件——「落库」的最终形态。 */
function readDiskConfigOn(d: DaemonHandle): Json {
  return JSON.parse(readFileSync(join(d.home, 'config.json'), 'utf-8')) as Json
}

async function seedConfigOn(d: DaemonHandle, patch: Json): Promise<void> {
  const res = await rawApiOn(d, '/api/config', { method: 'PUT', body: JSON.stringify(patch) })
  expect(res.ok, `seed config failed: ${res.status} ${await res.text().catch(() => '')}`).toBe(true)
}

async function seedConfig(patch: Json): Promise<void> {
  await seedConfigOn(daemon, patch)
}

function changedTopLevelKeys(before: Json, after: Json): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort()
}

async function primeToken(target: Page, d: DaemonHandle): Promise<void> {
  await target.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: d.baseUrl, tok: d.token },
  )
}

/** 打开某个设置分区并等它真正渲染出来（标题是分区身份的唯一稳定锚）。 */
async function openSection(page: Page, d: DaemonHandle, tab: string, title: string): Promise<void> {
  await primeToken(page, d)
  await page.goto(`${d.baseUrl}/settings?tab=${tab}`)
  await expect(
    page.locator(`#settings-section-title-${tab}`),
    `?tab=${tab} 没有打开对应分区 ⇒ 后面所有断言都落在别的分区上`,
  ).toHaveText(title, { timeout: 30_000 })
}

function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Save', exact: true })
}

function receipt(page: Page): Locator {
  return page.locator('.form-actions__ok')
}

function saveError(page: Page): Locator {
  return page.locator('.form-actions__error')
}

interface RuntimeRowWire {
  name: string
  protocol: string
  binaryPath: string | null
  enabled: boolean
  isSandbox?: boolean
  extraArgs?: string[] | null
  configDirEnv: string | null
  configDirName: string | null
}

async function runtimeRow(name: string): Promise<RuntimeRowWire | undefined> {
  const body = await api<{ runtimes: RuntimeRowWire[] }>('/api/runtimes')
  return body.runtimes.find((r) => r.name === name)
}

/** 同名行会 409；每条用例开头先把自己的夹具行清干净。 */
async function dropRuntime(name: string): Promise<void> {
  const res = await rawApi(`/api/runtimes/${encodeURIComponent(name)}`, { method: 'DELETE' })
  expect(
    res.status === 200 || res.status === 204 || res.status === 404,
    `清理夹具运行时 ${name} 时收到意外状态 ${res.status}`,
  ).toBe(true)
}

async function openRuntimeTab(page: Page): Promise<void> {
  await primeToken(page, daemon)
  await page.goto(`${daemon.baseUrl}/settings?tab=runtime`)
  await expect(page.locator('.runtime-list__row').first()).toBeVisible({ timeout: 30_000 })
}

/** 「这个二进制被真的拉起来过」的证据文件（stub mode-slow 在启动早期写下）。 */
function clearSpawnMarker(): void {
  rmSync(spawnMarker, { force: true })
}

function binaryWasSpawned(): boolean {
  return existsSync(spawnMarker)
}

// --------------------------------------------------------------------------
// CFG-18 P2 —— claude-code 专属字段 + 非法参数在 spawn 之前被拒
// --------------------------------------------------------------------------

test('RFC-319 CFG-18：extraArgs / IS_SANDBOX 只对 claude-code 露面；非法参数在拉起子进程之前就被拒 @nightly', async ({
  page,
}) => {
  const NAME = 'e2e-cfg18-fork'
  await dropRuntime(NAME)

  await openRuntimeTab(page)
  await page.getByRole('button', { name: '+ Add runtime', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add runtime' })
  await expect(dialog, '「+ Add runtime」没有打开新增对话框 ⇒ 这两个字段无从填写').toBeVisible()

  // ① 协议默认 opencode 时，两个 claude 专属控件都不该出现。露出来的后果不是
  //    「多一个没用的框」——用户会填进去、点保存、被服务端 422 打回
  //    （runtimeRegistry.ts:214-219 的 acceptsExtraArgs 能力门），而那条错误
  //    出现在弹窗底部，与他刚填的那一格隔着半屏。
  await expect(
    dialog.getByTestId('runtime-is-sandbox'),
    'opencode 协议下露出了 IS_SANDBOX 开关 ⇒ 用户会打开一个该驱动根本不读的旋钮',
  ).toHaveCount(0)
  await expect(
    dialog.getByTestId('runtime-extra-args-input'),
    'opencode 协议下露出了 extraArgs ⇒ 填了必被服务端拒，用户不知道为什么',
  ).toHaveCount(0)

  // ② 切到 Claude Code：两个控件同时出现。
  await dialog.getByRole('combobox', { name: 'Protocol' }).click()
  await page.getByRole('option', { name: 'Claude Code', exact: true }).click()
  await expect(
    dialog.getByTestId('runtime-is-sandbox'),
    'claude-code 协议下仍看不到 IS_SANDBOX ⇒ 上游要求这个兼容标记的 fork 无法配置',
  ).toBeVisible()
  await expect(
    dialog.getByTestId('runtime-extra-args-input'),
    'claude-code 协议下仍看不到 extraArgs ⇒ fork 私有 flag 只能靠改数据库',
  ).toBeVisible()

  // ③ 两个字段真的落库（而不是只在弹窗里存在）。
  await dialog.getByTestId('runtime-name').fill(NAME)
  await dialog.getByTestId('runtime-binary').fill(daemon.stubOpencode)
  await dialog.getByTestId('runtime-extra-args-input').fill('--skip-safe-check')
  await dialog.getByTestId('runtime-extra-args-input').press('Enter')
  await dialog.getByTestId('runtime-is-sandbox').check()

  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/runtimes',
    { timeout: 90_000 },
  )
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const createdResponse = await created
  expect(
    createdResponse.status(),
    `保存带 extraArgs / IS_SANDBOX 的 claude 运行时被拒：${await createdResponse.text()}`,
  ).toBe(201)
  await expect(dialog, '保存成功后弹窗没关 ⇒ 用户不知道存没存上，只会反复点保存').toHaveCount(0)

  const saved = await runtimeRow(NAME)
  expect(
    saved?.extraArgs,
    'extraArgs 没落库 ⇒ 界面上填的 fork flag 每次 spawn 都不会出现在 argv 里',
  ).toEqual(['--skip-safe-check'])
  expect(
    saved?.isSandbox,
    'IS_SANDBOX 没落库 ⇒ 需要这个兼容标记的 fork 每次都以另一种模式启动',
  ).toBe(true)

  // ④ 回显：重开编辑弹窗看到的就是落库的那两个值。看不到 ⇒ 用户会以为没存上，
  //    再填一遍（每填一遍就是一次真实写入 + 一次真实 spawn 预检）。
  await page.reload()
  await expect(page.locator('.runtime-list__row').first()).toBeVisible({ timeout: 30_000 })
  await page
    .locator('.runtime-list__row')
    .filter({ has: page.locator('.runtime-list__name', { hasText: new RegExp(`^${NAME}$`) }) })
    .getByRole('button', { name: 'Edit', exact: true })
    .click()
  const editDialog = page.getByRole('dialog', { name: 'Edit runtime' })
  await expect(
    editDialog.getByTestId('runtime-extra-args-remove---skip-safe-check'),
    '重开编辑弹窗时 extraArgs 没有回显 ⇒ 用户看到一个空框，会以为上次没存上',
  ).toBeVisible()
  await expect(
    editDialog.getByTestId('runtime-is-sandbox'),
    '重开编辑弹窗时 IS_SANDBOX 回到了关闭 ⇒ 同上',
  ).toBeChecked()
  await editDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(editDialog).toHaveCount(0)

  // ⑤ **本条用例的核心**：非法参数必须在拉起子进程**之前**被拒。
  //    判据不是「接口报错了」，而是「那个二进制根本没被执行」——
  //    stub 在 mode-slow 的最早期写下 `<hold>.started`（mode-slow.ts:62-70），
  //    它就是「进程起来过」的物证。`assertRuntimeSpawnCapabilities` 在
  //    `smokeRuntime` 之前抛出，而响应是在 `smokeRuntime` 之后才写回的，
  //    所以「拿到了响应 + 物证不存在」⇒ 这次请求期间一次子进程都没起。
  clearSpawnMarker()
  const refusedProtocol = await rawApi('/api/runtimes/probe', {
    method: 'POST',
    body: JSON.stringify({
      protocol: 'opencode',
      binaryPath: daemon.stubOpencode,
      extraArgs: ['--skip-safe-check'],
    }),
  })
  const refusedProtocolBody = await refusedProtocol.text()
  expect(refusedProtocol.status, `opencode + extraArgs 竟然被接受了：${refusedProtocolBody}`).toBe(
    422,
  )
  expect(
    (JSON.parse(refusedProtocolBody) as { code?: string }).code,
    '拒绝的理由不是「这个驱动不消费 extraArgs」⇒ 管理员会照着错误方向排查',
  ).toBe('runtime-extra-args-protocol')
  expect(refusedProtocolBody, '被拒的探测仍然回了 smoke 结论 ⇒ 说明它先跑了一遍才拒').not.toContain(
    '"smoke"',
  )
  expect(
    binaryWasSpawned(),
    '一组不被接受的参数已经被真的执行过了 ⇒ 能力门形同虚设：任何 settings:write 调用方' +
      '都能拿到一条未经校验的 argv 通道，「保存失败」只是事后诸葛',
  ).toBe(false)

  // ⑥ 正向对照——证明上面那条「物证不存在」不是恒真：同一条路径、同一个二进制，
  //    只是不带非法参数，物证必须出现。没有这一条，⑤ 在「物证机制本身失灵」时
  //    也会绿。
  const allowed = await rawApi('/api/runtimes/probe', {
    method: 'POST',
    body: JSON.stringify({ protocol: 'opencode', binaryPath: daemon.stubOpencode }),
  })
  expect(allowed.status, `合法探测被拒：${await allowed.text()}`).toBe(200)
  expect(
    binaryWasSpawned(),
    '合法探测也没有留下「进程起来过」的物证 ⇒ 上一条断言是恒真的，等于什么都没锁',
  ).toBe(true)

  // ⑦ 平台自有 flag 不许被 extraArgs 顶掉（`--model` 决定这次调用用哪个模型）。
  //    同样在 spawn 之前拒。
  clearSpawnMarker()
  const refusedReserved = await rawApi('/api/runtimes/probe', {
    method: 'POST',
    body: JSON.stringify({
      protocol: 'claude-code',
      binaryPath: daemon.stubOpencode,
      extraArgs: ['--model', 'someone-elses-model'],
    }),
  })
  const refusedReservedBody = await refusedReserved.text()
  expect(refusedReserved.status, `平台自有 flag 竟然被接受：${refusedReservedBody}`).toBe(422)
  expect(
    (JSON.parse(refusedReservedBody) as { code?: string }).code,
    '拒绝的理由不是「这是平台自有 flag」⇒ 管理员不知道该换成什么',
  ).toBe('runtime-extra-args-reserved')
  expect(
    binaryWasSpawned(),
    '带着一个会顶掉 --model 的参数已经真的跑过一次了 ⇒ 门在 spawn 之后，等于没门',
  ).toBe(false)

  // ⑧ isSandbox 的能力门同形：opencode 驱动不写 IS_SANDBOX，请求体里带 true 必须被拒。
  clearSpawnMarker()
  const refusedSandbox = await rawApi('/api/runtimes/probe', {
    method: 'POST',
    body: JSON.stringify({
      protocol: 'opencode',
      binaryPath: daemon.stubOpencode,
      isSandbox: true,
    }),
  })
  const refusedSandboxBody = await refusedSandbox.text()
  expect(refusedSandbox.status, `opencode + isSandbox 竟然被接受：${refusedSandboxBody}`).toBe(422)
  expect((JSON.parse(refusedSandboxBody) as { code?: string }).code).toBe(
    'runtime-is-sandbox-unsupported',
  )
  expect(
    binaryWasSpawned(),
    'isSandbox 的能力门排在 spawn 之后 ⇒ 未来任何开始消费该字段的驱动都会先被执行一次',
  ).toBe(false)

  await dropRuntime(NAME)
})

// --------------------------------------------------------------------------
// CFG-19 P3 —— config-dir 覆盖字段的校验（保留 env 名 / 非法叶子名）
// --------------------------------------------------------------------------

test('RFC-319 CFG-19：config-dir 覆盖的保留 env 名（大小写折叠）与非法叶子名，前端拦一层、服务端再拦一层 @nightly', async ({
  page,
}) => {
  const NAME = 'e2e-cfg19-fork'
  await dropRuntime(NAME)

  await openRuntimeTab(page)
  await page.getByRole('button', { name: '+ Add runtime', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add runtime' })
  await dialog.getByTestId('runtime-name').fill(NAME)

  const envField = dialog.getByTestId('runtime-config-dir-env')
  const nameField = dialog.getByTestId('runtime-config-dir-name')

  // ① 保留 env 名：`IS_SANDBOX` 是平台自己写进每次 spawn 的键
  //    （runtimeConfigDir.ts:52-61）。撞名的后果是两套机制互相覆盖，其中一套
  //    **静默**失效——不会报错，只会在某次任务里表现成「配置目录没生效」。
  await envField.fill('IS_SANDBOX')
  await expect(
    dialog.locator('.form-field__error'),
    '撞上平台保留变量名却毫无提示 ⇒ 用户存下去，之后两套机制互相覆盖且不报错',
  ).toHaveText('This variable name is reserved by the platform — pick another.')
  const dialogSave = dialog.getByRole('button', { name: 'Save', exact: true })
  await expect(dialogSave, '带着一个保留变量名还能点保存 ⇒ 前端校验只是装饰').toBeDisabled()

  // ② 大小写折叠（RFC-254 T2）。这条最容易退化成「只在 Windows 上判」：
  //    配置是**会旅行的数据**，在 Linux 上被接受、之后跑在 Windows daemon 上
  //    （环境块大小写不敏感）就变成一次静默撞名。
  await envField.fill('Is_Sandbox')
  await expect(
    dialog.locator('.form-field__error'),
    '大小写不同就放行 ⇒ 这条配置在 Linux 上存得下、换到 Windows 上就静默撞名',
  ).toHaveText('This variable name is reserved by the platform — pick another.')
  await expect(dialogSave).toBeDisabled()

  // ③ 非法 env 名字符：它会变成真正的环境变量键，数字开头 / 带连字符在 POSIX
  //    的 `env` 里根本表达不出来。
  await envField.fill('1-not-an-env')
  await expect(
    dialog.locator('.form-field__error'),
    '非法环境变量名没有当场解释 ⇒ 用户只能靠保存失败去猜哪一格填错了',
  ).toHaveText(
    'Must be a legal env var name (letters, digits, underscores; not starting with a digit).',
  )
  await expect(dialogSave).toBeDisabled()

  // ④ 目录名必须是**单层**叶子：`..` 会从 run root 里逃出去。
  //    （`a/b` 那一格由 rfc319-settings-runtimes.spec.ts 的 CFG-12 覆盖，这里取
  //    另一条分支，避免重复。）
  await envField.fill('')
  await nameField.fill('..')
  await expect(
    dialog.locator('.form-field__error'),
    '`..` 这种会逃出 run root 的目录名没有被指出 ⇒ 平台会在它不该写的地方 mkdir',
  ).toHaveText('Must be a single directory name: no path separators, and not "." or "..".')
  await expect(dialogSave).toBeDisabled()

  // ⑤ 改回合法值：闸必须放开，否则这个弹窗被一次输入错误永久卡死。
  await nameField.fill('e2ecfg19')
  await envField.fill('E2E_CFG19_CONFIG_DIR')
  await expect(
    dialog.locator('.form-field__error'),
    '改回合法值后错误还挂着 ⇒ 用户不知道自己到底改对没有',
  ).toHaveCount(0)
  await expect(dialogSave, '改回合法值后保存仍是灰的 ⇒ 用户被永久卡住').toBeEnabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // ⑥ 服务端第二道防线。只有前端拦 = 任何绕过界面的调用（脚本 / 旧版页面 /
  //    直接 curl）都能把坏值写进注册表，而注册表是每次 spawn 都要读的。
  for (const [payload, code] of [
    [{ configDirEnv: 'PWD' }, 'runtime-config-dir-env-reserved'],
    [{ configDirEnv: 'Git_Author_Name' }, 'runtime-config-dir-env-reserved'],
    [{ configDirEnv: '1-not-an-env' }, 'runtime-config-dir-env-invalid'],
    [{ configDirName: '../escape' }, 'runtime-config-dir-name-invalid'],
    [{ configDirName: '.' }, 'runtime-config-dir-name-invalid'],
  ] as const) {
    const res = await rawApi('/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({ name: NAME, protocol: 'opencode', ...payload }),
    })
    const body = await res.text()
    expect(
      res.status,
      `服务端放行了 ${JSON.stringify(payload)} ⇒ 前端校验是唯一防线，等于没有防线：${body}`,
    ).toBe(422)
    expect(
      (JSON.parse(body) as { code?: string }).code,
      `${JSON.stringify(payload)} 的拒绝码不对 ⇒ 调用方无法据此定位是哪一格`,
    ).toBe(code)
    expect(
      await runtimeRow(NAME),
      `被拒的写入仍然建出了 ${NAME} 这一行 ⇒ 拒绝只是嘴上说说，坏值已经进注册表`,
    ).toBeUndefined()
  }

  // ⑦ 正向对照：同一条路径、同一个名字，只把两格换成合法值就必须建得出来——
  //    否则上面五条「被拒」可能只是因为这条路径本来就不通。
  const ok = await rawApi('/api/runtimes', {
    method: 'POST',
    body: JSON.stringify({
      name: NAME,
      protocol: 'opencode',
      configDirEnv: 'E2E_CFG19_CONFIG_DIR',
      configDirName: 'e2ecfg19',
    }),
  })
  expect(ok.status, `合法的 config-dir 覆盖也建不出来：${await ok.text()}`).toBe(201)
  const created = await runtimeRow(NAME)
  expect(created?.configDirEnv, '合法的 env 覆盖没落库 ⇒ 自定义 fork 读不到注入的配置目录').toBe(
    'E2E_CFG19_CONFIG_DIR',
  )
  expect(created?.configDirName).toBe('e2ecfg19')

  await dropRuntime(NAME)
})

// --------------------------------------------------------------------------
// CFG-21 P2 —— System agents：运行时 + 语言 + 参数一次保存
// --------------------------------------------------------------------------

interface AgentWire {
  id: string
  runtime: string | null
  updatedAt: number
  aclRevision?: number
}

async function fusionAgent(): Promise<AgentWire> {
  return api<AgentWire>('/api/agents/builtins/skill-merger')
}

async function setFusionRuntime(runtime: string | null): Promise<void> {
  const current = await fusionAgent()
  await api(`/api/agents/${SKILL_MERGER_AGENT_ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      runtime,
      expectedUpdatedAt: current.updatedAt,
      expectedAclRevision: current.aclRevision ?? 0,
    }),
  })
}

async function pickRuntime(page: Page, ariaLabel: string, optionLabel: string): Promise<void> {
  const box = page.getByRole('combobox', { name: ariaLabel })
  await expect(box, `System agents 分区里找不到「${ariaLabel}」这个选择器`).toBeEnabled()
  await box.click()
  await page.getByRole('option', { name: optionLabel, exact: true }).click()
}

test('RFC-319 CFG-21：System agents 一次保存落齐运行时 + 语言 + 数值参数，且只写本分区自己的键 @nightly', async ({
  page,
}) => {
  await seedConfig({
    commitPushRuntime: 'opencode',
    commitPushLang: 'en-US',
    commitPushMaxRepairRetries: 2,
    commitPushDiffMaxBytes: 1024,
    memoryDistillRuntime: 'opencode',
    memoryDistillLang: 'en-US',
    changeNarrativeRuntime: 'opencode',
    mergeAgentRuntime: 'opencode',
    intentBuilderRuntime: 'opencode',
    intentBuilderLang: 'en-US',
    intentBuilderTurnTimeoutMs: 600_000,
    intentBuilderMaxGenerateRounds: 50,
    intentBuilderExtraInstructions: 'seed',
  })
  await setFusionRuntime('opencode')
  const before = await readConfig()

  await openSection(page, daemon, 'systemAgents', 'System agents')

  // 一次改动横跨三类字段：五个运行时选择器、三个语言选择器、三个数值 + 一段自由文本。
  await pickRuntime(page, 'Commit & push runtime', 'claude-code')
  await pickRuntime(page, 'Memory distill runtime', 'claude-code')
  await pickRuntime(page, 'Change-narrative runtime', 'claude-code')
  await pickRuntime(page, 'Merge-conflict runtime', 'claude-code')
  await pickRuntime(page, 'Intent builder runtime', 'claude-code')
  await pickRuntime(page, 'Fusion runtime', 'claude-code')

  await page.getByTestId('settings-commit-push-lang-select').click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await page.getByTestId('settings-memory-distill-lang-select').click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await page.getByTestId('settings-intent-lang-select').click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()

  await page.getByRole('spinbutton', { name: /Push repair retry limit/ }).fill('7')
  await page.getByRole('spinbutton', { name: /Commit-message diff byte cap/ }).fill('4096')
  await page.getByRole('spinbutton', { name: /Per-turn timeout \(ms\)/ }).fill('120000')
  await page.getByRole('spinbutton', { name: /Session round budget/ }).fill('12')
  await page.getByRole('textbox', { name: /Extra instructions/ }).fill('e2e: keep names kebab-case')

  await saveButton(page).click()
  await expect(
    receipt(page),
    `一次保存这十三项被拒了：${
      (await saveError(page)
        .textContent()
        .catch(() => '')) ?? ''
    }`,
  ).toBeVisible({ timeout: 30_000 })

  // ① 三类字段全部落库。漏掉任意一项都是同一种阴险形态：界面改了、点了保存、
  //    没有任何报错，值被静默丢掉（settings-drafts.ts 的最小写入白名单）。
  const after = await readConfig()
  const disk = readDiskConfigOn(daemon)
  const expected: Json = {
    commitPushRuntime: 'claude-code',
    commitPushLang: 'zh-CN',
    commitPushMaxRepairRetries: 7,
    commitPushDiffMaxBytes: 4096,
    memoryDistillRuntime: 'claude-code',
    memoryDistillLang: 'zh-CN',
    changeNarrativeRuntime: 'claude-code',
    mergeAgentRuntime: 'claude-code',
    intentBuilderRuntime: 'claude-code',
    intentBuilderLang: 'zh-CN',
    intentBuilderTurnTimeoutMs: 120_000,
    intentBuilderMaxGenerateRounds: 12,
    intentBuilderExtraInstructions: 'e2e: keep names kebab-case',
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(after[key], `${key} 没落库 ⇒ 用户改了、没报错、值却被静默丢掉`).toEqual(value)
    expect(disk[key], `${key} 没落盘 ⇒ 守护进程一重启就回到旧值`).toEqual(value)
  }

  // ② 融合运行时住在 Agent 行上、不在 config 里，但它跟上面十三项是**同一次** Save。
  //    落不下去 = 用户以为整页都存上了，其实融合那一格没动。
  expect(
    (await fusionAgent()).runtime,
    '融合运行时没跟着这一次保存写下去 ⇒ 同一个 Save 只兑现了一半',
  ).toBe('claude-code')

  // ③ 一次保存只写本分区自己的键。不成立 ⇒ 我在 System agents 点一次保存，
  //    同事刚在 Limits / Git 分区改的值被我带着的旧快照冲回去了，双方都不会收到提示。
  expect(
    changedTopLevelKeys(before, after),
    '保存 System agents 顺手改动了别的分区的键 ⇒ 一次保存会静默回滚同事刚做的改动',
  ).toEqual(Object.keys(expected).sort())

  // ④ 重载后逐格回显新值——用户下次进来看到的就是生效值。
  await page.reload()
  await expect(page.locator('#settings-section-title-systemAgents')).toHaveText('System agents', {
    timeout: 30_000,
  })
  await expect(
    page.getByRole('combobox', { name: 'Commit & push runtime' }),
    '重载后运行时选择器回到旧值 ⇒ 用户会以为没存上，于是再存一遍',
  ).toContainText('claude-code')
  await expect(page.getByTestId('settings-commit-push-lang-select')).toContainText('简体中文')
  await expect(page.getByRole('spinbutton', { name: /Push repair retry limit/ })).toHaveValue('7')
  await expect(page.getByRole('spinbutton', { name: /Per-turn timeout \(ms\)/ })).toHaveValue(
    '120000',
  )
  await expect(page.getByRole('textbox', { name: /Extra instructions/ })).toHaveValue(
    'e2e: keep names kebab-case',
  )
  await expect(
    page.getByRole('combobox', { name: 'Fusion runtime' }),
    '重载后融合运行时回到旧值 ⇒ 同上，而且这一格的真值在另一个端点上，最容易被漏掉',
  ).toContainText('claude-code')
})

// --------------------------------------------------------------------------
// CFG-22 P3 —— 双端点保存顺序（fusion-only 不重复 PUT；config 失败 fusion 不半应用）
// --------------------------------------------------------------------------

test('RFC-319 CFG-22：只改融合就不再 PUT config；config 被拒时融合一格都不写 @nightly', async ({
  page,
}) => {
  await seedConfig({ commitPushMaxRepairRetries: 2 })
  await setFusionRuntime('opencode')

  const configPuts: string[] = []
  const fusionPuts: string[] = []
  page.on('request', (req) => {
    if (req.method() !== 'PUT') return
    const path = new URL(req.url()).pathname
    if (path === '/api/config') configPuts.push(path)
    if (path === `/api/agents/${SKILL_MERGER_AGENT_ID}`) fusionPuts.push(path)
  })

  await openSection(page, daemon, 'systemAgents', 'System agents')
  const configBefore = await readConfig()

  // ---- 前半：只改融合运行时 ------------------------------------------------
  // 多发一次 config PUT 不会报错、界面也照样显示成功——但它带的是**我进页面时**
  // 的那份 config 快照。同事在这中间改过 commit/memory/merge 的话，这一发就把他的
  // 改动静默冲回去了（settings.tsx:1770-1773 的注释记的就是这件事）。
  await pickRuntime(page, 'Fusion runtime', 'claude-code')
  const fusionSaved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      new URL(r.url()).pathname === `/api/agents/${SKILL_MERGER_AGENT_ID}`,
    { timeout: 30_000 },
  )
  await saveButton(page).click()
  const fusionResponse = await fusionSaved
  expect(fusionResponse.status(), `融合行保存被拒：${await fusionResponse.text()}`).toBe(200)
  await expect(receipt(page), '融合单独保存成功却没有回执 ⇒ 用户不知道存没存上').toBeVisible({
    timeout: 30_000,
  })

  expect(
    configPuts,
    '只改了融合运行时，却仍然对 /api/config 发了一次写 ⇒ 它带的是进页面时的旧快照，' +
      '会把同事刚改的 commit / memory / merge 静默冲回去',
  ).toHaveLength(0)
  expect(
    await fusionAgent(),
    '融合单独保存没有真的落到 Agent 行上 ⇒ 上面那条「不发 config」的断言失去意义',
  ).toMatchObject({ runtime: 'claude-code' })
  expect(
    changedTopLevelKeys(configBefore, await readConfig()),
    '一次纯融合保存改动了 config ⇒ 它根本不该碰那份资源',
  ).toEqual([])

  // ---- 后半：config 被拒时，融合一格都不许写 -------------------------------
  // 顺序是产品的承诺（settings.tsx:1774-1786）：config 先发，融合只在它的
  // onSuccess 里提交。倒过来 / 并发发的话，用户看到的是一条「保存失败」的红条，
  // 而融合运行时已经被换掉了——两个资源就此不一致，且没有任何地方能看出来。
  configPuts.length = 0
  fusionPuts.length = 0
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'e2e-injected-config-rejection',
          message: 'injected: the config write was refused',
        }),
      })
    },
  )

  await pickRuntime(page, 'Fusion runtime', 'opencode')
  await page.getByRole('spinbutton', { name: /Push repair retry limit/ }).fill('9')

  const rejected = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/config',
    { timeout: 30_000 },
  )
  await saveButton(page).click()
  expect((await rejected).status()).toBe(422)

  await expect(saveError(page), 'config 被拒却没有任何错误呈现 ⇒ 用户以为整页都存上了').toBeVisible(
    { timeout: 30_000 },
  )
  await expect(saveError(page)).toContainText('injected')

  expect(
    fusionPuts,
    'config 已经被拒，融合行却还是被写了一次 ⇒ 用户面前是一条「保存失败」，' +
      '而融合运行时已经悄悄换掉了；两个资源从此不一致，且界面上看不出来',
  ).toHaveLength(0)
  expect((await fusionAgent()).runtime, '同上：服务端的融合运行时被半应用了').toBe('claude-code')
  expect(
    (await readConfig())['commitPushMaxRepairRetries'],
    '被注入拒绝的 config 写入竟然还是落库了 ⇒ 这条注入没有生效，后面的断言全是空的',
  ).toBe(2)

  // 收尾：把共享 daemon 的融合运行时放回默认，避免污染后续用例。
  await page.unrouteAll({ behavior: 'wait' })
  await setFusionRuntime(null)
})

// --------------------------------------------------------------------------
// CFG-25 P2 —— Recovery：自动恢复开关与断路器阈值
// --------------------------------------------------------------------------

test('RFC-319 CFG-25：Recovery 的三个自动执行开关与四个断路器阈值整体落库，越界的巡检间隔当场拦下 @nightly', async ({
  page,
}) => {
  await seedConfig({
    autoResumeOnBoot: false,
    autoRepair: { S4: false },
    autoKillStalledChild: false,
    heartbeatStallMs: 1_800_000,
    maxAutoRecoveriesPerWindow: 3,
    autoRecoveryWindowMs: 3_600_000,
    periodicOrphanReconcileMs: 0,
  })
  const before = await readConfig()

  await openSection(page, daemon, 'recovery', 'Recovery')

  const autoResume = page.getByRole('checkbox', { name: /Auto-resume interrupted tasks on boot/ })
  const autoRepairS4 = page.getByRole('checkbox', { name: /Auto-repair stuck pending tasks/ })
  const autoKill = page.getByRole('checkbox', { name: /Auto-kill a heartbeat-stalled child/ })
  await expect(
    autoResume,
    'Recovery 分区少了「开机自动续跑」开关 ⇒ 这项自动执行只能靠改配置文件',
  ).toBeVisible()

  // 前提：每个自动执行开关默认关（RFC-108 T24 决策 D1）。默认开的话，
  // 「打开它」这个动作就断言不了任何东西。
  await expect(
    autoResume,
    '自动执行开关默认就是开的 ⇒ 与「自动执行一律默认关」的决策矛盾',
  ).not.toBeChecked()
  await expect(autoRepairS4).not.toBeChecked()
  await expect(autoKill).not.toBeChecked()

  // ① 越界的巡检间隔必须当场拦下。这一格特殊：0 合法（= 关闭巡检），非零则必须
  //    ≥ 60s。放行一个 5s 的值 = 守护进程每 5 秒扫一次孤儿进程，整台机器被自己的
  //    巡检压住。
  const orphan = page.getByRole('spinbutton', { name: /Periodic orphan-reconcile interval/ })
  await orphan.fill('5000')
  await expect(
    page.locator('.form-field__error'),
    '一个 5 秒的巡检间隔被静默接受 ⇒ 守护进程会把自己扫死，而没有任何提示',
  ).toContainText('Enter 0, or an integer from')
  await expect(orphan, '越界的输入没有标成 aria-invalid ⇒ 读屏用户收不到这条错误').toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await expect(saveButton(page), '带着越界值还能点保存 ⇒ 校验只是装饰').toBeDisabled()
  await expect(
    page.getByText('Fix the invalid values in this section before saving'),
    '按钮灰了却不说为什么 ⇒ 用户面对一个点不动的保存按钮无从下手',
  ).toBeVisible()

  // ② 改成合法值后整批保存。
  await orphan.fill('120000')
  await autoResume.check()
  await autoRepairS4.check()
  await autoKill.check()
  await page.getByRole('spinbutton', { name: /Heartbeat-stall threshold/ }).fill('90000')
  await page.getByRole('spinbutton', { name: /Breaker: max auto-recoveries per window/ }).fill('5')
  await page.getByRole('spinbutton', { name: /Breaker: rolling window/ }).fill('600000')

  await expect(
    saveButton(page),
    '改回合法值后保存仍点不动 ⇒ 这个分区被一次输入错误卡死',
  ).toBeEnabled()
  await saveButton(page).click()
  await expect(
    receipt(page),
    `Recovery 整批保存被拒：${
      (await saveError(page)
        .textContent()
        .catch(() => '')) ?? ''
    }`,
  ).toBeVisible({ timeout: 30_000 })

  const after = await readConfig()
  const disk = readDiskConfigOn(daemon)
  expect(
    after['autoResumeOnBoot'],
    '开机自动续跑没落库 ⇒ 运维以为开了，重启后一条中断任务都不会自己回来',
  ).toBe(true)
  expect(
    after['autoKillStalledChild'],
    '「自动杀停摆子进程」没落库 ⇒ 心跳停了的子进程会一直占着并发额度',
  ).toBe(true)
  // 嵌套对象整体成立：只发一半会让「自动修复开了、但按的是默认条件」。
  expect(
    after['autoRepair'],
    'autoRepair 这个嵌套对象没有整体落库 ⇒ 自动修复按的是默认条件，不是用户选的',
  ).toEqual({ S4: true })
  expect(after['heartbeatStallMs']).toBe(90_000)
  expect(
    after['maxAutoRecoveriesPerWindow'],
    '断路器阈值没落库 ⇒ 一次故障能被无限自动重试放大，而断路器形同虚设',
  ).toBe(5)
  expect(after['autoRecoveryWindowMs']).toBe(600_000)
  expect(after['periodicOrphanReconcileMs']).toBe(120_000)

  expect(
    disk['autoRepair'],
    '只写进了内存没落盘 ⇒ 守护进程一重启，自动恢复又全变回关闭，且用户毫不知情',
  ).toEqual({ S4: true })
  expect(disk['autoResumeOnBoot']).toBe(true)
  expect(disk['maxAutoRecoveriesPerWindow']).toBe(5)

  // ③ 只写本分区自己的键。
  expect(
    changedTopLevelKeys(before, after),
    '保存 Recovery 顺手改动了别的分区的键 ⇒ 一次保存会静默回滚同事刚做的改动',
  ).toEqual([
    'autoKillStalledChild',
    'autoRecoveryWindowMs',
    'autoRepair',
    'autoResumeOnBoot',
    'heartbeatStallMs',
    'maxAutoRecoveriesPerWindow',
    'periodicOrphanReconcileMs',
  ])

  // ④ 重载后回显——自动执行开关尤其要看得见当前状态，否则运维无从判断「现在到底
  //    是不是平台在替我做决定」。
  await page.reload()
  await expect(page.locator('#settings-section-title-recovery')).toHaveText('Recovery', {
    timeout: 30_000,
  })
  await expect(
    page.getByRole('checkbox', { name: /Auto-resume interrupted tasks on boot/ }),
    '重载后自动执行开关回到关闭 ⇒ 运维看到的状态与守护进程真正的行为相反',
  ).toBeChecked()
  await expect(
    page.getByRole('checkbox', { name: /Auto-repair stuck pending tasks/ }),
  ).toBeChecked()
  await expect(
    page.getByRole('checkbox', { name: /Auto-kill a heartbeat-stalled child/ }),
  ).toBeChecked()
  await expect(
    page.getByRole('spinbutton', { name: /Breaker: max auto-recoveries per window/ }),
  ).toHaveValue('5')
  await expect(
    page.getByRole('spinbutton', { name: /Periodic orphan-reconcile interval/ }),
  ).toHaveValue('120000')
})

// --------------------------------------------------------------------------
// CFG-33 P2 —— MCP 外部访问开关：关掉后 /api/mcp 与新令牌铸造同时关停
// --------------------------------------------------------------------------

async function mcpInitialize(token: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Streamable HTTP 要求客户端两种都接受。
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'rfc319-cfg33', version: '1' },
      },
    }),
  })
}

async function mintPat(name: string): Promise<{ status: number; body: string }> {
  const res = await rawApi('/api/auth/pats', {
    method: 'POST',
    // `general` 而不是默认的 `mcp_only`：本条要同时验证「MCP 关了、REST 不受牵连」，
    // 而 mcp_only 令牌本来就进不了 REST（routes/registry.ts:179-190），
    // 用它会让那半条断言恒真。
    //
    // 空矩阵不等于「什么都不能做」：`resolveTokenPermissions`
    // （shared/schemas/permission.ts:1293-1303）把账号拥有的全部 READ_POINTS
    // 无条件并进来，`tasks:read` 正在其中。反过来，**读点不可显式勾选**
    // （grantableMatrixPoints 把 READ_POINTS 排除在外），写成 `scopes:['tasks:read']`
    // 会被 `pat-scope-ungrantable` 拒掉。
    body: JSON.stringify({ name, scopes: [], purpose: 'general' }),
  })
  // 先把响应体读成字符串再断言：`expect(res.status, \`…${await res.text()}\`)` 里的
  // 模板串是**先于** toBe 求值的，之后再 `res.json()` 会撞上「body already consumed」，
  // 于是真正的失败被一条无关的 TypeError 顶替掉。
  return { status: res.status, body: await res.text() }
}

test('RFC-319 CFG-33：关掉外部访问后 /api/mcp 与新令牌铸造同时关停，已签发令牌的 REST 通道不受牵连 @nightly', async ({
  page,
}) => {
  await seedConfig({ mcpSurfaceEnabled: true })

  // 前置：开着的时候两条通道都通。没有这一段，下面的 403 可能只是「本来就不通」。
  const mintedWhileOpen = await mintPat(`rfc319-cfg33-open-${Date.now()}`)
  expect(mintedWhileOpen.status, `开关开着时铸不出令牌：${mintedWhileOpen.body}`).toBe(201)
  const pat = JSON.parse(mintedWhileOpen.body) as { token: string }

  const mcpWhileOpen = await mcpInitialize(pat.token)
  expect(mcpWhileOpen.status, '开关开着时 MCP 握手就不通 ⇒ 后面的 403 说明不了任何事').toBe(200)
  expect(
    await mcpWhileOpen.text(),
    'MCP 端点回了 200 但不是一次真正的握手 ⇒ 这条正向前提是假的',
  ).toContain('"protocolVersion"')

  // 界面动作：Network 分区的外部访问开关。
  await openSection(page, daemon, 'network', 'Network')
  const toggle = page.getByTestId('settings-mcp-surface')
  await expect(toggle, 'Network 分区没有外部访问开关 ⇒ 事故当中没有任何界面手段止血').toBeChecked()
  await toggle.uncheck()
  await saveButton(page).click()
  await expect(
    receipt(page),
    `关闭外部访问被拒：${
      (await saveError(page)
        .textContent()
        .catch(() => '')) ?? ''
    }`,
  ).toBeVisible({ timeout: 30_000 })
  expect(
    (await readConfig())['mcpSurfaceEnabled'],
    '界面说保存成功，服务端却没关 ⇒ 运维以为止住血了，外面还在照常调用',
  ).toBe(false)

  // ① 第一件被关停的事：MCP 端点。注意用的是**同一个已签发的令牌**——
  //    关停必须是**按请求**判定的，不能只拦新连接（stateless transport 下
  //    「已建立的客户端」这个概念本来就不存在）。
  const mcpClosed = await mcpInitialize(pat.token)
  const mcpClosedBody = await mcpClosed.text()
  expect(
    mcpClosed.status,
    `关掉外部访问后 MCP 端点仍然应答 ⇒ 事故杠杆只拉了一半：${mcpClosedBody}`,
  ).toBe(403)
  expect(
    (JSON.parse(mcpClosedBody) as { code?: string }).code,
    'MCP 被拒的理由不是「外部访问已关闭」⇒ 对方会以为自己的令牌坏了，去重新申请一个',
  ).toBe('mcp-surface-disabled')

  // ② 第二件被关停的事：新令牌铸造。只关 MCP 不关铸造 = 事故当中还在发新凭据。
  const mintClosed = await mintPat(`rfc319-cfg33-closed-${Date.now()}`)
  expect(
    mintClosed.status,
    `关掉外部访问后仍然能铸出新令牌 ⇒ 事故当中还在发新凭据：${mintClosed.body}`,
  ).toBe(403)
  expect(
    (JSON.parse(mintClosed.body) as { code?: string }).code,
    '铸造被拒的理由不是「管理员关掉了外部访问」⇒ 用户会去查自己的权限',
  ).toBe('token-issuance-disabled')

  // ③ 明确**不**被关停的一件事：已签发令牌的 REST 通道。把它一起关掉 = 一次
  //    与本次事故无关的自动化被顺手打断，而运维只是想关掉 MCP。
  const restStillWorks = await fetch(`${daemon.baseUrl}/api/tasks`, {
    headers: { Authorization: `Bearer ${pat.token}` },
  })
  expect(
    restStillWorks.status,
    '关掉外部访问顺手把已签发令牌的 REST 通道也掐了 ⇒ 与本次事故无关的自动化被连坐',
  ).toBe(200)

  // ④ 打回来：两条通道必须一起恢复，否则这个开关是一条单行道。
  await toggle.check()
  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => (await mcpInitialize(pat.token)).status, {
      timeout: 20_000,
      message: '开关打回来了 MCP 端点却没恢复 ⇒ 这个开关只能关不能开',
    })
    .toBe(200)
  const mintReopened = await mintPat(`rfc319-cfg33-reopen-${Date.now()}`)
  expect(mintReopened.status, '开关打回来了却仍然铸不出令牌 ⇒ 同上').toBe(201)
})

// --------------------------------------------------------------------------
// CFG-37 / CFG-38 —— PlantUML：一台行为可编程的本地渲染器
// --------------------------------------------------------------------------

type RendererMode = 'ok' | 'server-error' | 'syntax-error' | 'hang'

interface RendererHit {
  method: string
  path: string
  authorization: string | null
}

interface FakeRenderer {
  origin: string
  host: string
  setMode: (mode: RendererMode) => void
  hits: RendererHit[]
  close: () => Promise<void>
}

const OK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80">' +
  '<title>rfc319 fake renderer</title><rect width="200" height="80" fill="#fff"/></svg>'

/** PlantUML 服务器对**源码有语法错**时的回应形状：4xx + 一张诊断 SVG。
 *  两端都靠 `<svg` + /PlantUML version/i 认它（services/plantuml.ts:72-74）。 */
const SYNTAX_ERROR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120" viewBox="0 0 400 120">' +
  '<text x="10" y="20">PlantUML version 1.2026.0</text>' +
  '<text x="10" y="40">[From string (line 3) ]</text>' +
  '<text x="10" y="60">@startuml</text>' +
  '<text x="10" y="80">Cannot find the requested element</text>' +
  '</svg>'

async function startFakeRenderer(): Promise<FakeRenderer> {
  let mode: RendererMode = 'ok'
  const hits: RendererHit[] = []
  const sockets = new Set<Socket>()
  // 浏览器侧的连通性测试是**跨源**的（页面在 daemon 的端口上，渲染器在这里），
  // 所以必须显式放行 CORS；否则「失败」会永远来自 CORS 而不是被测的分支。
  const cors: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  }
  const server: Server = createServer((req, res) => {
    req.resume()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    hits.push({
      method: req.method ?? '',
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
    })
    if (mode === 'hang') return // 故意永不应答
    if (mode === 'server-error') {
      res.writeHead(500, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
      res.end('fake renderer is down')
      return
    }
    if (mode === 'syntax-error') {
      res.writeHead(400, { ...cors, 'content-type': 'image/svg+xml; charset=utf-8' })
      res.end(SYNTAX_ERROR_SVG)
      return
    }
    res.writeHead(200, { ...cors, 'content-type': 'image/svg+xml; charset=utf-8' })
    res.end(OK_SVG)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    setMode: (next) => {
      mode = next
    },
    hits,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

test('RFC-319 CFG-37：渲染分区存下端点与鉴权头，「测试连接」的四种结果各自成立 @nightly', async ({
  page,
}) => {
  const renderer = await startFakeRenderer()
  try {
    await seedConfig({ plantumlEndpoint: '', plantumlAuthHeader: '' })
    await openSection(page, daemon, 'rendering', 'Rendering')

    const endpoint = page.getByRole('textbox', { name: /PlantUML render endpoint/ })
    const authHeader = page.getByRole('textbox', { name: /PlantUML Authorization header/ })
    const testButton = page.getByRole('button', { name: 'Test endpoint', exact: true })
    // 成功横幅按**文案**定位而不是按「非 error 的 notice-banner」——后者会把页面上
    // 任何一条无关提示（stale / 重启提醒）算进来，断言就不再说明任何事。
    const okBanner = page.locator('.notice-banner', {
      hasText: 'Endpoint returned an SVG — looks good.',
    })
    // 这一分区里 `.error-box`（ErrorBanner）只有连通性测试会渲染：SectionForm 的
    // 保存错误走的是 `.form-actions__error` 那个 span。
    const errBanner = page.locator('.error-box')

    // 【结果一】端点是空的：必须当场说「先填地址」，而不是跑一次注定失败的请求
    //   再报一个网络错——那会把「你还没填」说成「你的服务器有问题」。
    await expect(endpoint, '渲染分区没有端点输入框 ⇒ 这一页什么都配不了').toBeVisible()
    await testButton.click()
    await expect(
      errBanner,
      '端点为空时点测试毫无反应 ⇒ 用户以为在跑，其实什么都没发生',
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      errBanner,
      '端点为空时报的不是「先填地址」⇒ 用户会去查自己的服务器，而问题在这一格',
    ).toContainText('Fill in an endpoint URL first.')
    expect(renderer.hits, '端点还没填就已经往外发请求了 ⇒ 这条分支根本没生效').toHaveLength(0)

    // 【结果二】端点可用：必须给出肯定的结论。注意测的是**草稿值**（还没保存），
    //   这正是这个按钮存在的理由——先验证再保存。
    renderer.setMode('ok')
    await endpoint.fill(renderer.origin)
    await authHeader.fill('Bearer rfc319-cfg37-secret')
    await testButton.click()
    await expect(
      okBanner,
      '端点明明返回了 SVG，测试却没给出肯定结论 ⇒ 管理员会以为配错了，反复改一个本来就对的地址',
    ).toContainText('Endpoint returned an SVG — looks good.', { timeout: 30_000 })
    await expect(errBanner, '成功的同时还挂着一条错误 ⇒ 用户无法判断到底成没成').toHaveCount(0)

    // 鉴权头不是装饰：它必须真的出现在发往渲染器的那一跳上。不发 = 自建
    // kroki 挡在鉴权后面的用户永远测不通，而界面上那一格看起来已经填好了。
    const authorized = renderer.hits.filter((h) => h.authorization === 'Bearer rfc319-cfg37-secret')
    expect(
      authorized.length,
      '填了鉴权头，发往渲染器的请求却没带上 ⇒ 这一格是装饰，鉴权后的端点永远测不通',
    ).toBeGreaterThan(0)
    expect(
      authorized[0]?.path,
      '请求没有落在 PlantUML 的 `/plantuml/svg/...` 约定路径上 ⇒ 换成真服务器会 404',
    ).toMatch(/^\/plantuml\/svg\//)

    // 【结果三】端点在，但它坏了：必须报失败并把服务器给的线索带出来。
    renderer.setMode('server-error')
    await testButton.click()
    await expect(
      errBanner,
      '端点每一次都 500，测试却不报失败 ⇒ 管理员会带着一个坏端点保存下去',
    ).toBeVisible({ timeout: 30_000 })
    await expect(errBanner).toContainText('Render failed:')
    await expect(
      errBanner,
      '失败信息里没有服务器给的状态码 ⇒ 管理员只知道「不行」，不知道往哪查',
    ).toContainText('500')
    await expect(okBanner, '同时还显示着成功 ⇒ 两个结论并存，用户只能猜').toHaveCount(0)

    // 【结果四】端点在、但永不应答：必须以**超时**收场，而不是一直转圈。
    //   转圈到天荒地老 = 管理员放弃这个按钮，之后再也不验证就直接保存。
    renderer.setMode('hang')
    await testButton.click()
    await expect(
      page.getByRole('button', { name: 'Rendering test diagram…', exact: true }),
      '点了测试却没有进入「进行中」状态 ⇒ 用户不知道它到底跑没跑',
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      errBanner,
      '端点永不应答时测试也永不收场 ⇒ 这个按钮变成一个转不完的圈，管理员只能放弃验证',
    ).toContainText('timeout', { timeout: 40_000 })

    // 保存：端点与鉴权头都要真的落库 + 落盘（后端代理读的就是它们）。
    renderer.setMode('ok')
    const before = await readConfig()
    await saveButton(page).click()
    await expect(
      receipt(page),
      `渲染分区保存被拒：${
        (await saveError(page)
          .textContent()
          .catch(() => '')) ?? ''
      }`,
    ).toBeVisible({ timeout: 30_000 })
    const after = await readConfig()
    expect(
      after['plantumlEndpoint'],
      '端点没落库 ⇒ 界面上填好了，所有用户在评审页看到的仍然是源码而不是图',
    ).toBe(renderer.origin)
    expect(
      after['plantumlAuthHeader'],
      '鉴权头没落库 ⇒ 服务端代理每次都被渲染器 401，用户只看到「渲染失败」',
    ).toBe('Bearer rfc319-cfg37-secret')
    expect(readDiskConfigOn(daemon)['plantumlEndpoint'], '只写进内存没落盘 ⇒ 重启即丢').toBe(
      renderer.origin,
    )
    expect(
      changedTopLevelKeys(before, after),
      '保存渲染分区顺手改动了别的分区的键 ⇒ 一次保存会静默回滚同事刚做的改动',
    ).toEqual(['plantumlAuthHeader', 'plantumlEndpoint'])
  } finally {
    await renderer.close()
    await seedConfig({ plantumlEndpoint: '', plantumlAuthHeader: '' })
  }
})

// --------------------------------------------------------------------------
// CFG-38 P3 —— 后端代理渲染的五种响应
// --------------------------------------------------------------------------

interface ProxyResponse {
  status: number
  body: string
  json: Record<string, unknown>
}

async function proxyRender(source: string): Promise<ProxyResponse> {
  const res = await rawApi('/api/plantuml/render', {
    method: 'POST',
    body: JSON.stringify({ source }),
  })
  const body = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(body) as Record<string, unknown>
  } catch {
    json = {}
  }
  return { status: res.status, body, json }
}

test('RFC-319 CFG-38：PlantUML 后端代理的五种响应各自成立，鉴权头只出现在服务端到渲染器那一跳 @nightly', async () => {
  const renderer = await startFakeRenderer()
  const SOURCE = '@startuml\nAlice -> Bob: hello\n@enduml'
  try {
    // 【形状一】unconfigured —— 没配端点。浏览器据此退回源码 + 一行提示。
    //   把它错报成「渲染失败」= 用户去查一个根本不存在的服务器。
    await seedConfig({ plantumlEndpoint: '', plantumlAuthHeader: '' })
    const unconfigured = await proxyRender(SOURCE)
    expect(unconfigured.status, `未配置端点时代理没有 200：${unconfigured.body}`).toBe(200)
    expect(
      unconfigured.json['unconfigured'],
      '没配端点时代理没有回 `unconfigured` ⇒ 浏览器分不清「没配」与「配了但坏了」，' +
        '用户被推去排查一台不存在的服务器',
    ).toBe(true)
    expect(unconfigured.json['svg'], '未配置却回了 svg ⇒ 这条分支根本没走到').toBeUndefined()

    // 【形状二】400 —— 源码为空。它必须是**非 2xx**：空源码是调用方的错，
    //   混进 200 的联合体里会被当成一种「渲染结果」渲染出来。
    const empty = await proxyRender('')
    expect(empty.status, `空源码没有被 400 拒绝：${empty.body}`).toBe(400)
    expect((empty.json as { code?: string }).code).toBe('plantuml-source-required')

    // 【形状三】413 —— 超长源码。两道闸各锁一段：先按 Content-Length 在**缓冲之前**
    //   挡掉巨型体，再按解析后的真实长度挡掉「头在撒谎 / 头缺失」的那一类。
    //   只留前者 = 任何不带 Content-Length 的请求都能绕过体积上限。
    const justOver = await proxyRender('x'.repeat(100 * 1024 + 1))
    expect(
      justOver.status,
      `刚超过上限的源码没有被 413 拒绝（解析后那道闸失效了）：${justOver.body.slice(0, 200)}`,
    ).toBe(413)
    expect((justOver.json as { code?: string }).code).toBe('plantuml-source-too-large')
    const wayOver = await proxyRender('x'.repeat(400 * 1024))
    expect(wayOver.status, `巨型源码没有在缓冲之前被挡掉：${wayOver.body.slice(0, 200)}`).toBe(413)
    expect((wayOver.json as { code?: string }).code).toBe('plantuml-source-too-large')

    // 【形状四】svg —— 正常渲染。同时验证「鉴权头只走服务端那一跳」：
    //   它一旦出现在回给浏览器的响应里，就等于把自建渲染器的凭据发给了每一个
    //   登录用户（这个端点没有额外权限门，任何登录用户都能调）。
    await seedConfig({
      plantumlEndpoint: renderer.origin,
      plantumlAuthHeader: 'Bearer rfc319-cfg38-secret',
    })
    renderer.setMode('ok')
    renderer.hits.length = 0
    const rendered = await proxyRender(SOURCE)
    expect(rendered.status, `正常渲染没有 200：${rendered.body}`).toBe(200)
    expect(
      typeof rendered.json['svg'] === 'string' &&
        (rendered.json['svg'] as string).includes('rfc319 fake renderer'),
      '配好端点后代理没有把渲染出来的 SVG 带回来 ⇒ 评审页上的图形永远出不来',
    ).toBe(true)
    expect(
      rendered.json['host'],
      '响应里没有渲染器主机名 ⇒ 浏览器画不出「源码将发往 X」那条隐私提示，泄漏变成静默的',
    ).toBe(renderer.host)
    expect(
      renderer.hits.some((h) => h.authorization === 'Bearer rfc319-cfg38-secret'),
      '服务端到渲染器那一跳没有带鉴权头 ⇒ 鉴权后的自建渲染器一个字都渲染不出来',
    ).toBe(true)
    expect(
      rendered.body,
      '渲染器的鉴权凭据被原样回给了浏览器 ⇒ 任何登录用户调一次这个端点就拿到它',
    ).not.toContain('rfc319-cfg38-secret')

    // 【形状五】errorSvg —— 上游判定源码有语法错（4xx + 诊断 SVG）。它必须**原样**
    //   带回诊断 SVG 而不是降级成一句「渲染失败」：那张 SVG 里有行号和原因，
    //   丢掉它等于让用户对着一个几十行的图去猜哪一行写错了。
    renderer.setMode('syntax-error')
    const syntax = await proxyRender('@startuml\nbroken\n@enduml')
    expect(syntax.status, `语法错场景没有 200：${syntax.body}`).toBe(200)
    expect(
      typeof syntax.json['errorSvg'] === 'string' &&
        (syntax.json['errorSvg'] as string).includes('From string (line 3)'),
      '上游给了带行号的诊断 SVG，代理却没有原样带回 ⇒ 用户失去唯一的定位线索',
    ).toBe(true)
    expect(
      syntax.json['svg'],
      '把一张诊断 SVG 当成渲染结果回了 ⇒ 用户会把错误提示当成自己画的图',
    ).toBeUndefined()

    // 【第六种，源码里同样声明】error —— 三步回退全失败。它刻意用 **200** 承载：
    //   非 2xx 会让浏览器侧的 api.post 抛错并丢掉响应体，`detail` 就永远到不了人眼前。
    renderer.setMode('server-error')
    const failed = await proxyRender(SOURCE)
    expect(
      failed.status,
      '上游全挂时代理回了非 2xx ⇒ 浏览器侧会丢掉响应体，失败原因永远到不了用户面前',
    ).toBe(200)
    expect(
      typeof failed.json['error'] === 'string' && (failed.json['error'] as string).includes('500'),
      `上游全挂时没有带回可读的失败原因：${failed.body}`,
    ).toBe(true)
  } finally {
    await renderer.close()
    await seedConfig({ plantumlEndpoint: '', plantumlAuthHeader: '' })
  }
})

// --------------------------------------------------------------------------
// CFG-X1 P2 —— Limits 执行预算保存后被新任务采用
//
// §账本勘误（按源码实际写，见回报④）：账本这一行把六项预算并列成「保存后被新任务
// 采用」，但源码里只有三项真的进了启动漏斗：
//   · `defaultPerNodeTimeoutMs` / `defaultNodeRetries` / `sessionRestartBudget`
//     —— `services/launchRuntimeConfig.ts:154-171` 逐条读进 StartTaskDeps。
//   · `defaultPerTaskMaxDurationMs` / `defaultPerTaskMaxTotalTokens` —— **刻意**不接线：
//     RFC-108 PR-B 把自动接线撤了（存量 config 持久化着旧的 1h 默认值，一旦消费会
//     被 limits ticker 当硬上限取消任务，而 canceled 不可 resume），
//     `packages/backend/tests/rfc108-launch-budget-timeout-floor.test.ts:50-56` 正面锁着
//     「不许泄漏这两个字段」。
//   · `largeOutputThresholdBytes` —— 全仓零消费方（只出现在配置 schema / 设置页 /
//     最小写入白名单里）。
// 所以本用例对这三项只断言「存得住」，对另外三项断言「新任务真的按它跑」。
// 照账本字面写会得到一条永远红的用例，而为了让它绿去改产品更是本末倒置。
// --------------------------------------------------------------------------

interface NodeRunWire {
  id: string
  nodeId: string
  status: string
  retryIndex: number
  errorMessage: string | null
}

async function seedBudgetWorkflow(): Promise<string> {
  const agentName = `rfc319-cfgx1-agent-${Date.now()}`
  const agent = await apiOn<{ id: string }>(budgetDaemon, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: agentName,
      description: 'RFC-319 CFG-X1 budget fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  const workflow = await apiOn<{ id: string }>(budgetDaemon, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-cfgx1-${Date.now()}`,
      description: 'RFC-319 CFG-X1 budget fixture',
      definition: {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
            promptTemplate: '{{topic}}',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'agent_1', portName: 'topic' },
          },
          {
            id: 'e2',
            source: { nodeId: 'agent_1', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  return workflow.id
}

async function launchBudgetTask(workflowId: string, name: string): Promise<string> {
  const task = await apiOn<{ id: string }>(budgetDaemon, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ workflowId, name, scratch: true, inputs: { topic: 'budget probe' } }),
  })
  return task.id
}

async function waitForTerminal(taskId: string, timeoutMs: number): Promise<string> {
  let last = 'pending'
  await expect
    .poll(
      async () => {
        last = (await apiOn<{ status: string }>(budgetDaemon, `/api/tasks/${taskId}`)).status
        return last
      },
      { timeout: timeoutMs, message: `任务 ${taskId} 没有在预算内收敛（最后状态 ${last}）` },
    )
    .toMatch(/^(done|failed|canceled|interrupted)$/)
  return last
}

async function agentRunsOf(taskId: string): Promise<NodeRunWire[]> {
  const body = await apiOn<{ runs: NodeRunWire[] }>(budgetDaemon, `/api/tasks/${taskId}/node-runs`)
  return body.runs.filter((r) => r.nodeId === 'agent_1')
}

test('RFC-319 CFG-X1：Limits 的执行预算保存后被新任务采用——超时值逐字出现在被杀节点上，重试次数按预算生长 @nightly', async ({
  page,
}) => {
  const workflowId = await seedBudgetWorkflow()

  // ---- 第一次保存：把预算调成「一击必杀」---------------------------------
  await seedConfigOn(budgetDaemon, {
    defaultPerTaskMaxDurationMs: 3_600_000,
    defaultPerTaskMaxTotalTokens: 0,
    defaultPerNodeTimeoutMs: 1_800_000,
    defaultNodeRetries: 3,
    sessionRestartBudget: 1,
    largeOutputThresholdBytes: 1_048_576,
  })
  await openSection(page, budgetDaemon, 'limits', 'Limits')

  await page.getByRole('spinbutton', { name: /Per-task max duration \(ms\)/ }).fill('420000')
  await page.getByRole('spinbutton', { name: /Per-task max total tokens/ }).fill('123456')
  await page.getByRole('spinbutton', { name: /Per-node timeout \(ms\)/ }).fill('5000')
  await page.getByRole('spinbutton', { name: /Default node retries/ }).fill('0')
  await page.getByRole('spinbutton', { name: /Session restart budget/ }).fill('0')
  await page.getByRole('spinbutton', { name: /Large output threshold \(bytes\)/ }).fill('65536')
  await saveButton(page).click()
  await expect(
    receipt(page),
    `执行预算保存被拒：${
      (await saveError(page)
        .textContent()
        .catch(() => '')) ?? ''
    }`,
  ).toBeVisible({ timeout: 30_000 })

  // ① 六项全部落库 + 落盘。三项当前没有消费方（见本节 §账本勘误），但它们仍然
  //    必须存得住——否则连「以后接上线就生效」这条路都没有了。
  const saved = await readConfigOn(budgetDaemon)
  const savedDisk = readDiskConfigOn(budgetDaemon)
  const firstRound: Json = {
    defaultPerTaskMaxDurationMs: 420_000,
    defaultPerTaskMaxTotalTokens: 123_456,
    defaultPerNodeTimeoutMs: 5_000,
    defaultNodeRetries: 0,
    sessionRestartBudget: 0,
    largeOutputThresholdBytes: 65_536,
  }
  for (const [key, value] of Object.entries(firstRound)) {
    expect(saved[key], `${key} 没落库 ⇒ 用户改了、没报错、值却被静默丢掉`).toBe(value)
    expect(savedDisk[key], `${key} 没落盘 ⇒ 守护进程一重启就回到旧值`).toBe(value)
  }

  // ---- 采用验证（一）：per-node 超时 --------------------------------------
  // 把 stub 确定性地挂住，让节点除了被超时杀掉之外没有别的结局。
  // 判据是**逐字的数值**（runner.ts:1956-1958 的 `node-timeout: exceeded {N}ms`）：
  // 只断言「任务失败了」是恒真的——它在这条链路上本来就会失败。
  writeFileSync(budgetHoldFile, '')
  let timeoutTaskId: string
  try {
    timeoutTaskId = await launchBudgetTask(workflowId, 'rfc319-cfgx1-timeout')
    expect(
      await waitForTerminal(timeoutTaskId, 120_000),
      '被超时杀掉的节点没让任务收敛成失败',
    ).toBe('failed')
  } finally {
    rmSync(budgetHoldFile, { force: true })
  }

  const timeoutRuns = await agentRunsOf(timeoutTaskId)
  expect(
    timeoutRuns.map((r) => r.errorMessage ?? '').join(' | '),
    '节点没有以刚保存的那个超时值被杀掉 ⇒ 设置页上的 per-node 超时对新任务不生效，' +
      '一个挂住不动的子进程会一直占着并发额度直到默认的 30 分钟',
  ).toContain('node-timeout: exceeded 5000ms')
  // retries=0 且 restart=0 ⇒ attempt 上限 (1+0)×(1+0)=1。默认值（3 / 1）下会是 8 次，
  // 所以这条计数本身就是「新预算被采用」的第二重证据。
  expect(
    timeoutRuns.map((r) => r.retryIndex).sort((a, b) => a - b),
    '重试预算设成 0 之后仍然重试了 ⇒ 一个必然超时的节点会被反复重跑，' +
      '把一次 5 秒的失败放大成好几分钟',
  ).toEqual([0])

  // ---- 第二次保存：把重试预算调大 -----------------------------------------
  await page.reload()
  await expect(page.locator('#settings-section-title-limits')).toHaveText('Limits', {
    timeout: 30_000,
  })
  await expect(
    page.getByRole('spinbutton', { name: /Per-node timeout \(ms\)/ }),
    '重载后回显的不是刚存下的超时值 ⇒ 用户会以为没存上，于是再存一遍',
  ).toHaveValue('5000')
  await page.getByRole('spinbutton', { name: /Default node retries/ }).fill('1')
  await page.getByRole('spinbutton', { name: /Session restart budget/ }).fill('1')
  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 30_000 })
  expect((await readConfigOn(budgetDaemon))['defaultNodeRetries']).toBe(1)
  expect((await readConfigOn(budgetDaemon))['sessionRestartBudget']).toBe(1)

  // ---- 采用验证（二）：重试预算 -------------------------------------------
  // 这一次不挂住：stub 秒退且不吐信封 ⇒ 节点以 envelope-missing 失败 ⇒ 走重试链。
  // attempt 上限 = (1+1)×(1+1) = 4（shared/prompt.ts:1275-1278）。
  // 两次启动、两组不同的预算、两个不同的观测值——单看任何一次都可能是巧合。
  const retryTaskId = await launchBudgetTask(workflowId, 'rfc319-cfgx1-retries')
  expect(await waitForTerminal(retryTaskId, 120_000), '不吐信封的节点没让任务收敛成失败').toBe(
    'failed',
  )
  const retryRuns = await agentRunsOf(retryTaskId)
  expect(
    retryRuns.map((r) => r.retryIndex).sort((a, b) => a - b),
    '新任务没有按刚保存的两项重试预算生长（应为 (1+1)×(1+1)=4 次尝试）⇒ ' +
      '管理员调这两个旋钮对真实执行毫无影响，只是在改一份没人读的 JSON',
  ).toEqual([0, 1, 2, 3])
  expect(
    retryRuns.every((r) => r.status === 'failed'),
    '重试出来的行不是失败态 ⇒ 上面那条计数可能来自别的机制，不是重试',
  ).toBe(true)
})
