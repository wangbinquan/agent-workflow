// RFC-319 —— 设置 · 运行时管理（CFG-10 / 11 / 12 / 13 / 14 / 15 / 16 / 17）。
//
// 运行时表是「这台机器上到底会拉起哪个二进制、用什么协议说话」的**唯一编辑面**。
// 它的失效形态不是崩溃，而是**界面与真相脱节**——而且每一种脱节都要等到真跑任务
// 的时候才爆：
//
//   ① 列表撒谎：默认标记贴错行 / 二进制路径显示的不是真会拉起的那个 / 冒烟结论
//      是上一次配置留下的绿。管理员照着表判断「装好了」，任务起来才发现拉的是
//      别的东西（CFG-10）。
//   ② 保存前预检形同虚设：新增运行时时点了保存却从没真跑过那个二进制，一行看着
//      正常的配置其实根本起不来（CFG-11）。
//   ③ 编辑落不了库、或落库了却把旧的冒烟绿留在新二进制上（CFG-12）。
//   ④ 重测拿回来的结论贴到了**探测期间已经被改掉**的那一行上——绿灯对应的是一个
//      已经不存在的配置（CFG-13）。
//   ⑤ 设为默认只改了界面没写 config，或写了 config 界面不动；两种都会让「默认
//      运行时」这件事在两个地方各说各话（CFG-14）。
//   ⑥ 把**有效默认**停用掉：调度链从此没有活着的目标（CFG-15）。
//   ⑦ 删掉一个还被代理 / config 字段 / 默认指向的运行时，或删掉最后一行——引用方
//      当场指向空气，且删除不可撤销（CFG-16）。
//   ⑧ 模型下拉在探测失败时给一个空下拉：用户既选不了、也不知道为什么，只能干瞪眼
//      （CFG-17）。
//
// 判据取自源码单一事实源（纯文本引用，禁外链）：
//   packages/frontend/src/components/RuntimeList.tsx:205-311   行渲染（名称 / 各 chip / 二进制 / 动作区）
//   packages/frontend/src/components/RuntimeList.tsx:222-241   默认 chip、协议 chip、停用 chip、冒烟 chip
//   packages/frontend/src/components/RuntimeList.tsx:255-264   Set default 只在「非默认且启用」时渲染
//   packages/frontend/src/components/RuntimeList.tsx:280-290   启停按钮：默认行 disabled + title 提示
//   packages/frontend/src/components/RuntimeList.tsx:156-171   setDefault = writeConfigPatch({ defaultRuntime })
//   packages/frontend/src/components/RuntimeList.tsx:429-453   新建带 `probe: trimmed !== ''` 的预检
//   packages/frontend/src/components/RuntimeList.tsx:493-544   身份字段（name/protocol）在编辑态锁死 + config-dir 覆盖
//   packages/frontend/src/components/ModelSelect.tsx:110-123   模型清单取不到时的降级：自由文本 + model-select-load-error
//   packages/frontend/src/components/ModelSelect.tsx:162-171   Refresh 按钮（?refresh=1）
//   packages/backend/src/routes/runtimes.ts:268-334            POST /api/runtimes：保存前 smoke 预检 → createRuntime → cacheRuntimeProbe
//   packages/backend/src/routes/runtimes.ts:372-394            POST /:name/enabled
//   packages/backend/src/routes/runtimes.ts:395-422            DELETE /:name（默认 + 5 个 config 字段 + 代理引用一起扫）
//   packages/backend/src/routes/runtimes.ts:424-486            POST /:name/probe + withRuntimeProbeConfigFence 的两处 runtime-probe-stale
//   packages/backend/src/routes/runtime.ts:57-72               GET /api/runtime/models 失败 → 502（脱敏）
//   packages/backend/src/routes/config.ts:65-77                默认运行时必须指向 enabled 行
//   packages/backend/src/services/runtimeRegistry.ts:967-1002  setRuntimeEnabled：有效默认不可停用（409）
//   packages/backend/src/services/runtimeRegistry.ts:1006-1070 deleteRuntime：最后一行 / 默认 / config 字段 / 代理引用四条拒绝
//   packages/backend/src/services/runtimeRegistry.ts:819-861   执行画像一变，旧的冒烟回执立刻置 null
//
// 与既有设置页覆盖的分工（务必不重复）：
//   * e2e/settings-save-receipt.spec.ts —— 设置**分区表单**（tab=gc）的保存回执与落库（CFG-04）。
//   * e2e/settings-outcome-unknown.spec.ts —— /api/config 写入**响应丢失**时的写屏障（RES-08）。
//   本文件既不碰分区表单的 Save 回执，也不碰响应丢失；它只覆盖 tab=runtime 的运行时
//   注册表本身（列表 / 新增 / 编辑 / 默认 / 启停 / 删除 / 重测 / 模型清单）。
//
// 运行时用的是 harness 的 stub 可执行文件（`daemon.stubOpencode`），不指望机器上有
// 真的 opencode。stub 选 `slow` 模式并挂上 `STUB_OPENCODE_HOLD_FILE`：平时那个文件
// 不存在，冒烟照常秒回；只有 CFG-13 的 409 用例临时把它创建出来，才能把一次探测
// **确定性地**扣在半空中（同 e2e/mcp-acl-session-termination.spec.ts:36-46 的手法），
// 而不是靠 sleep 赌时序。

import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

// 用例之间有真实的状态承接（新建 → 编辑 → 设默认 → 停用 → 重测 → 删除），
// 必须串行；任一环断掉后面的断言就失去前提，serial 让它直接停在第一处红。
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let holdDir: string
let holdFile: string

/** 本用例新建的自定义运行时：带二进制路径，创建时会走保存前预检。 */
const FORK = 'e2e-fork'
/** 对照用：不填二进制路径，创建时**不应**产生任何冒烟回执。 */
const NO_PATH = 'e2e-nopath'
/**
 * 换路径用的「另一条真实二进制」：只要求过得了服务端写入闸并且与 stub 不同，
 * 用例从不真的执行它（CFG-12 只保存、CFG-13 只在探测半空中改这一行）。
 *
 * **必须逐平台成立**：写入闸 `validateBinaryPath`
 * （packages/backend/src/services/runtimeRegistry.ts:567-588）对绝对路径只收
 * **canonical** 形式——`resolve(p) === p`，否则 422 `runtime-binary-invalid`。
 * 这个判据是平台相关的：原先写死的 `/bin/echo` 在 win32 上 `isAbsolute()` 为真
 * （无盘符的根路径也算绝对），但 `path.win32.resolve('/bin/echo')` 会补上当前
 * 盘符并换成反斜杠（`D:\bin\echo`），两者不等 ⇒ **保存被 422 拒、弹窗按设计
 * 留在原地**（RuntimeList.tsx:445-449 的 `onSuccess` 才关窗）。2026-08-25 的
 * Windows CI 实红（commit 188dda224，shard 2/3，`toHaveCount(0)` 收到 1）就是
 * 这一条：不是慢、不是竞态，是夹具值在那台机器上本来就非法。
 *
 * 改用 `process.execPath`——跑这份用例的 node/bun 自己：三个平台上都是**存在的、
 * 可执行的、canonical 的**绝对路径（Windows 上带盘符与反斜杠，天然满足
 * `resolve(p) === p`），且必然不是 stub，正是这两条用例需要的语义。
 */
const OTHER_BINARY = process.execPath

// packages/frontend/src/i18n/en-US.ts:3350-3357 —— 冒烟结论 → 界面文案的唯一映射。
// 用例不预设 stub 会得出哪一种结论，只要求「界面显示的那一句 == 服务端存的那一条」。
// （实测 stub 走到的是 `stream-nonconforming`：它不回显冒烟自己发的 nonce，
//  runtimeSmoke.ts:353-361 的 conformed 因此不成立。刻意不写死——换 stub 行为、
//  换真二进制都不该让这条红，红只应该来自「界面与回执对不上」。`conforms` 这条
//  绿路径在 e2e 里造不出来，属已知未覆盖。）
const SMOKE_LABEL: Record<string, string> = {
  conforms: 'conforms',
  'spawn-failed': 'cannot start',
  'auth-missing': 'auth missing',
  'network-blocked': 'endpoint unreachable',
  'model-call-failed': 'model call failed',
  'stream-nonconforming': 'not conforming',
}
/** en-US.ts:3291 —— 从未跑过冒烟时的 chip 文案。 */
const SMOKE_UNTESTED = 'not tested'
/** en-US.ts:3290 —— binaryPath 为空时列表里显示的占位。 */
const DEFAULT_BINARY_LABEL = 'default (PATH / configured)'

interface RuntimeSmoke {
  outcome: string
  conforms: boolean
  detail: string
}
interface RuntimeRow {
  name: string
  protocol: string
  binaryPath: string | null
  enabled: boolean
  isDefault: boolean
  model: string | null
  configDirEnv: string | null
  configDirName: string | null
  lastProbe: RuntimeSmoke | null
}

test.beforeAll(async () => {
  // 夹具自检（不是产品面）：把「这条路径在本平台合不合法」提前到这里判，
  // 而不是留给 CFG-12 的「保存后弹窗该关」去表达。前者一眼能看出是夹具值不对，
  // 后者只会显示「弹窗没关」，读的人会去查产品的关窗逻辑——2026-08-25 的
  // Windows 红就白烧了一轮排查。
  expect(
    isAbsolute(OTHER_BINARY) && resolve(OTHER_BINARY) === OTHER_BINARY,
    `夹具不成立：OTHER_BINARY=${OTHER_BINARY} 在本平台不是 canonical 绝对路径，` +
      '服务端写入闸（runtimeRegistry.ts:567-588）会以 422 拒掉它，' +
      '下面「改二进制 → 保存」的用例验的将是夹具而不是产品',
  ).toBe(true)
  expect(
    existsSync(OTHER_BINARY),
    `夹具不成立：OTHER_BINARY=${OTHER_BINARY} 不存在，「换成另一条真实二进制」的前提落空`,
  ).toBe(true)

  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-runtimes-'))
  holdFile = join(holdDir, 'hold')
  daemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: holdFile },
  })
})

test.afterAll(async () => {
  releaseHold()
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(holdDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** 放开被扣住的那一次探测（stub 见文件消失即继续）。 */
function releaseHold(): void {
  try {
    rmSync(holdFile, { force: true })
  } catch {
    /* best-effort */
  }
}

async function rawApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await rawApi(path, init)
  const text = await res.text()
  expect(res.ok, `${path}: ${res.status} ${text}`).toBe(true)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function listRuntimes(): Promise<RuntimeRow[]> {
  const body = await api<{ runtimes: RuntimeRow[] }>('/api/runtimes')
  return body.runtimes
}

async function runtimeRow(name: string): Promise<RuntimeRow | undefined> {
  return (await listRuntimes()).find((r) => r.name === name)
}

async function readConfig(): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>('/api/config')
}

async function openRuntimeTab(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}/settings?tab=runtime`)
  await expect(page.locator('.runtime-list__row').first()).toBeVisible({ timeout: 30_000 })
}

/** 按运行时名精确定位那一行（名称是 `.runtime-list__name`，避免子串误命中）。 */
function row(page: Page, name: string) {
  return page
    .locator('.runtime-list__row')
    .filter({ has: page.locator('.runtime-list__name', { hasText: new RegExp(`^${name}$`) }) })
}

/** 冒烟 chip 是行内唯一带圆点的 chip（RuntimeList.tsx:237 的 `withDot`）。 */
function smokeChip(page: Page, name: string) {
  return row(page, name).locator('.status-chip--with-dot')
}

test('RFC-319 CFG-10：运行时表把「会拉起哪个二进制」逐行摊开，且每一格都对得上服务端', async ({
  page,
}) => {
  await openRuntimeTab(page)

  const served = await listRuntimes()
  // 前提：全新 daemon 只预置 opencode / claude-code 两行。若这里就不是 2 行，
  // 后面所有「表里有几行」的断言都失去意义。
  expect(
    served.map((r) => r.name).sort(),
    '预置运行时不是 opencode + claude-code —— 本文件后续所有断言的前提不成立',
  ).toEqual(['claude-code', 'opencode'])

  await expect(
    page.locator('.runtime-list__row'),
    '表里的行数与 /api/runtimes 返回的不一致 ⇒ 管理员在界面上看到的注册表根本不是真的注册表',
  ).toHaveCount(served.length)

  for (const rt of served) {
    const line = row(page, rt.name)
    await expect(line, `注册表里有 ${rt.name}，界面上却没有这一行`).toHaveCount(1)

    // 协议决定平台用哪一套 CLI 语法去驱动它。贴错协议 = 参数拼错 = 每次都起不来，
    // 而错误只会在任务日志深处显形。
    const protocolLabel = rt.protocol === 'claude-code' ? 'Claude Code' : 'opencode'
    await expect(
      line.locator('.status-chip', { hasText: new RegExp(`^${protocolLabel}$`) }),
      `${rt.name} 的协议 chip 与服务端的 protocol=${rt.protocol} 不符 ⇒ 管理员会按错误的协议去排查`,
    ).toHaveCount(1)

    // 二进制路径是这张表最要紧的一格：它就是「点下去会执行什么」。
    await expect(
      line.locator('code.runtime-list__binary'),
      `${rt.name} 显示的二进制路径不是服务端解析出来的那个 ⇒ 表在指向 A，实际拉起 B`,
    ).toHaveText(rt.binaryPath ?? DEFAULT_BINARY_LABEL)

    // 全新 daemon 上没人跑过冒烟，chip 必须是「未测」而不是任何一种结论。
    // 假绿比没有结论危险得多：它会让人跳过验证直接排期。
    expect(rt.lastProbe, `${rt.name} 在没人点过 Test 时就带上了冒烟回执`).toBeNull()
    await expect(
      smokeChip(page, rt.name),
      `${rt.name} 没跑过冒烟却显示了结论 ⇒ 管理员会把一个从未验证过的二进制当成已验证`,
    ).toHaveText(SMOKE_UNTESTED)

    // 启停状态：预置两行都是启用的，所以不该出现 disabled chip。
    expect(rt.enabled, `${rt.name} 预置状态不是启用`).toBe(true)
    await expect(
      line.locator('.status-chip', { hasText: /^disabled$/ }),
      `${rt.name} 是启用的却挂着「disabled」⇒ 管理员会以为它不参与调度`,
    ).toHaveCount(0)
  }

  // 默认标记必须**恰好一行**：零行 ⇒ 没人知道任务会落到哪个运行时；两行 ⇒ 界面
  // 自相矛盾。config 未设 defaultRuntime 时有效默认是 opencode
  // （runtimeRegistry.ts:401 `row.name === (defaultRuntimeName ?? 'opencode')`）。
  expect(
    (await readConfig())['defaultRuntime'],
    '前提变了：config 已经写了 defaultRuntime，本条对「隐式默认」的断言不再成立',
  ).toBeUndefined()
  await expect(
    page
      .locator('.runtime-list__row')
      .filter({ has: page.locator('.status-chip', { hasText: /^default$/ }) }),
    '默认标记不是恰好一行 ⇒ 「任务会用哪个运行时」在界面上没有答案（或有两个答案）',
  ).toHaveCount(1)
  await expect(
    row(page, 'opencode').locator('.status-chip', { hasText: /^default$/ }),
    '默认标记贴在了错误的一行 ⇒ 管理员改的是 A 的配置，跑的是 B',
  ).toHaveCount(1)

  // 负向对照：默认行不给「设为默认」按钮，非默认行给——否则这个按钮就是个装饰。
  await expect(
    row(page, 'opencode').getByRole('button', { name: 'Set default', exact: true }),
    '已经是默认的行还提供「设为默认」⇒ 按钮与状态无关，点了也说明不了任何事',
  ).toHaveCount(0)
  await expect(
    row(page, 'claude-code').getByRole('button', { name: 'Set default', exact: true }),
    '非默认行没有「设为默认」入口 ⇒ 默认运行时在界面上根本改不了',
  ).toHaveCount(1)
})

test('RFC-319 CFG-11：新增自定义运行时时，保存前真的把那个二进制拉起来跑了一遍', async ({
  page,
}) => {
  await openRuntimeTab(page)

  await page.getByRole('button', { name: '+ Add runtime', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add runtime' })
  await expect(dialog, '「+ Add runtime」没有打开新增对话框 ⇒ 自定义运行时无从注册').toBeVisible()

  await dialog.getByTestId('runtime-name').fill(FORK)
  await dialog.getByTestId('runtime-binary').fill(daemon.stubOpencode)

  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/runtimes',
    { timeout: 90_000 },
  )
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  const response = await created
  expect(response.status(), `新增运行时失败：${await response.text()}`).toBe(201)
  const body = (await response.json()) as { smoke?: RuntimeSmoke }
  // 这一条就是 CFG-11 的核心：**保存前**的预检。响应体里带回 smoke，说明服务端在
  // 落库之前真的按这条路径拉起了子进程；没有它，管理员点完保存只能拿到「表里多了
  // 一行」，那一行到底能不能跑要等第一个任务失败才知道。
  expect(
    body.smoke?.outcome,
    '创建响应里没有 smoke ⇒ 保存前预检根本没跑，新注册的运行时可用性完全没被验证过',
  ).toBeTruthy()

  await expect(dialog, '保存成功后对话框没关 ⇒ 用户不知道自己到底存没存上').toHaveCount(0)
  await expect(row(page, FORK), '保存成功了，列表里却没有新行 ⇒ 界面与注册表脱节').toHaveCount(1)

  const stored = await runtimeRow(FORK)
  expect(stored?.binaryPath, '新行的二进制路径没按填的那个落库').toBe(daemon.stubOpencode)
  expect(
    stored?.lastProbe?.outcome,
    '预检跑过了，结论却没落到行上 ⇒ 下次打开这一页又是「未测」，等于白跑',
  ).toBe(body.smoke?.outcome)

  // 界面显示的结论必须就是服务端存的那一条（用映射表对账，而不是把某个具体结论写死）。
  const label = SMOKE_LABEL[stored?.lastProbe?.outcome ?? '']
  expect(label, `未知的冒烟结论 ${stored?.lastProbe?.outcome}，界面无从渲染`).toBeTruthy()
  await expect(
    smokeChip(page, FORK),
    '行上的冒烟 chip 与服务端存的结论不是同一件事 ⇒ 界面在替一个不存在的结论背书',
  ).toHaveText(label!)
  await expect(
    page.getByTestId(`runtime-smoke-detail-${FORK}`),
    '只有一个 chip、没有失败详情 ⇒ 管理员知道「不行」却不知道「哪不行」，无从下手',
  ).toHaveText(stored?.lastProbe?.detail ?? '')

  // 负向对照：不填二进制路径就不该有预检（RuntimeList.tsx:442 `probe: trimmed !== ''`）。
  // 没有这一步，「新行带回执」也可能只是「每一行都会带回执」。
  await page.getByRole('button', { name: '+ Add runtime', exact: true }).click()
  const second = page.getByRole('dialog', { name: 'Add runtime' })
  await second.getByTestId('runtime-name').fill(NO_PATH)
  const createdNoPath = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/runtimes',
    { timeout: 60_000 },
  )
  await second.getByRole('button', { name: 'Save', exact: true }).click()
  const noPathBody = (await (await createdNoPath).json()) as { smoke?: RuntimeSmoke }
  expect(
    noPathBody.smoke,
    '没给二进制路径也跑了预检 ⇒ 上面那条「预检真的跑了」的证据不成立（回执与路径无关）',
  ).toBeUndefined()
  await expect(
    smokeChip(page, NO_PATH),
    '没有可探测的目标却显示了冒烟结论 ⇒ 这个结论是凭空来的',
  ).toHaveText(SMOKE_UNTESTED)
  await expect(
    row(page, NO_PATH).locator('code.runtime-list__binary'),
    '没填路径的行没有显示「走协议默认」的占位 ⇒ 管理员看不出它会拉起什么',
  ).toHaveText(DEFAULT_BINARY_LABEL)
})

test('RFC-319 CFG-17：模型下拉能列能刷新；探测不出清单时降级成可输入并说明原因，而不是给一个空下拉', async ({
  page,
}) => {
  await openRuntimeTab(page)

  // —— 能列：claude-code 的清单是静态表（claudeCode/models.ts:10-21），不依赖二进制。
  await row(page, 'claude-code').getByRole('button', { name: 'Edit', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit runtime' })
  await expect(dialog).toBeVisible()

  // 对话框里共两个下拉：被锁死的 Protocol + 模型。模型那个必须真的存在，
  // 否则「选模型」这件事只能靠手打字符串，打错了要到任务失败才知道。
  const modelSelect = dialog.getByRole('combobox').nth(1)
  await expect(modelSelect, '编辑态没有模型下拉 ⇒ 只能盲打模型 id').toBeVisible()
  await modelSelect.click()
  await expect(
    page.getByRole('option', { name: 'Sonnet (alias → latest)', exact: true }),
    '模型下拉是空的 ⇒ 用户看不到这个运行时到底能用哪些模型',
  ).toBeVisible()

  await page.getByRole('option', { name: 'Sonnet (alias → latest)', exact: true }).click()

  // —— 能刷新：Refresh 必须真的重新问一次（带 refresh=1），否则它只是个装饰按钮，
  // 换了二进制 / 新开了 provider 的人永远刷不出新模型。
  const refreshed = page.waitForResponse(
    (r) => r.url().includes('/api/runtime/models') && r.url().includes('refresh=1'),
    { timeout: 60_000 },
  )
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  expect((await refreshed).status(), 'Refresh 请求没成功').toBe(200)
  await expect(
    page.getByTestId('model-select-refresh-error'),
    '刷新成功了却仍挂着错误条 ⇒ 用户会以为模型清单坏了',
  ).toHaveCount(0)

  // 选中的值要能存下去——下拉选完不落库，等于没选。
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(async () => (await runtimeRow('claude-code'))?.model, {
      timeout: 20_000,
      message: '在下拉里选的模型没有落库 ⇒ 任务仍会用旧模型跑，且界面不会提示',
    })
    .toBe('sonnet')

  // 重新打开必须回显同一个选择，否则用户无法确认自己存的是什么。
  await page.reload()
  await row(page, 'claude-code').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Edit runtime' }).getByRole('combobox').nth(1),
    '重开编辑框没有回显已保存的模型 ⇒ 用户无从确认当前生效的是哪个模型',
  ).toContainText('Sonnet (alias → latest)')
  await page
    .getByRole('dialog', { name: 'Edit runtime' })
    .getByRole('button', { name: 'Cancel' })
    .click()

  // —— 探测失败：stub 不实现 `models` 子命令，opencode 协议的清单请求必然 502
  // （routes/runtime.ts:57-72）。此时**不能**给空下拉——那是最坏的形态：既选不了，
  // 也不解释。必须降级成自由文本 + 一句能看懂的原因。
  const modelsFailed = page.waitForResponse(
    (r) => r.url().includes('/api/runtime/models') && r.url().includes(`runtime=${FORK}`),
    { timeout: 60_000 },
  )
  await row(page, FORK).getByRole('button', { name: 'Edit', exact: true }).click()
  expect(
    (await modelsFailed).status(),
    `前提不成立：${FORK} 的模型清单居然拉成功了，下面对失败降级的断言无从验证`,
  ).toBe(502)

  const forkDialog = page.getByRole('dialog', { name: 'Edit runtime' })
  await expect(
    page.getByTestId('model-select-load-error'),
    '模型清单拉不到却什么都不说 ⇒ 用户面对一个空下拉，既不知道为什么也不知道该做什么',
  ).toBeVisible()
  await expect(page.getByTestId('model-select-load-error')).toContainText(
    'Failed to fetch the model list.',
  )
  await expect(
    forkDialog.locator('input[placeholder="anthropic/claude-sonnet-4-6"]'),
    '清单拉不到时没有留下自由输入 ⇒ 探测失败直接等于「这个运行时没法配模型」',
  ).toBeVisible()
  await forkDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('RFC-319 CFG-12：编辑已注册运行时——身份锁死、路径与 config-dir 覆盖真的落库，且旧的冒烟结论随之失效', async ({
  page,
}) => {
  await openRuntimeTab(page)

  const before = await runtimeRow(FORK)
  expect(
    before?.lastProbe,
    `前提不成立：${FORK} 现在没有冒烟回执，无从验证「改配置会让它失效」`,
  ).not.toBeNull()

  await row(page, FORK).getByRole('button', { name: 'Edit', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit runtime' })

  // 身份（名字 + 协议）是引用键与驱动选择：改掉它等于把所有引用这个名字的代理
  // 悄悄指到别处、或用错误的协议去驱动同一个二进制。服务端不允许改，界面也必须锁死，
  // 否则用户填了半天才在保存时被打回。
  await expect(
    dialog.getByTestId('runtime-name'),
    '编辑态还能改名字 ⇒ 用户以为能改，实际服务端不认，改动白填',
  ).toBeDisabled()
  await expect(
    dialog.getByRole('combobox').first(),
    '编辑态还能改协议 ⇒ 同一个二进制会被换一套 CLI 语法驱动',
  ).toBeDisabled()

  // 表单闸：config-dir 名必须是单层目录名，带分隔符会在 run root 之外 mkdir。
  // 没有这个闸，用户要等到保存被服务端 422 打回才知道（RFC-319 CFG-19 顺带）。
  await dialog.getByTestId('runtime-config-dir-name').fill('a/b')
  await expect(
    dialog.locator('.form-field__error'),
    '非法的 config-dir 名没有当场解释 ⇒ 用户只能靠保存失败去猜哪一格填错了',
  ).toHaveText('Must be a single directory name: no path separators, and not "." or "..".')
  await expect(
    dialog.getByRole('button', { name: 'Save', exact: true }),
    '非法输入下保存仍可点 ⇒ 表单闸形同虚设，错误配置会一路发到服务端',
  ).toBeDisabled()

  // 改成合法值 + 换一条二进制路径，全部保存。
  await dialog.getByTestId('runtime-config-dir-name').fill('e2eforkcfg')
  await dialog.getByTestId('runtime-config-dir-env').fill('E2E_FORK_CONFIG_DIR')
  await dialog.getByTestId('runtime-binary').fill(OTHER_BINARY)
  await expect(
    dialog.getByRole('button', { name: 'Save', exact: true }),
    '改回合法值后保存仍是灰的 ⇒ 用户被永久卡住',
  ).toBeEnabled()
  // 保存这一步分两件事，必须分别断言，否则「弹窗没关」会同时代表两种完全不同的
  // 故障（服务端拒了 / 关窗逻辑坏了），读红的人无从分辨。
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/runtimes/${FORK}`,
    { timeout: 60_000 },
  )
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const savedResponse = await saved
  // ① 服务端事实：这组编辑真的被接受了。被拒时这里直接把服务端原话打出来
  //   （例如 `binaryPath must be a canonical absolute path`），用户侧的对应遭遇是
  //   「填了半天点保存，弹窗一动不动」。
  expect(savedResponse.status(), `保存运行时编辑被服务端拒了：${await savedResponse.text()}`).toBe(
    200,
  )
  // ② 界面事实：保存成功后弹窗必须收起。不收起 ⇒ 用户不知道自己到底存没存上，
  //   会反复点保存（每点一次就是一次真实写入）。
  //   这里用默认超时是有意的：上一行已经等到了写入回执，剩下的只是 React 的一次
  //   状态翻转，再给它更长的窗口只会把「关窗逻辑坏了」拖成慢性红。
  await expect(dialog, '保存成功后编辑弹窗没关 ⇒ 用户不知道存没存上，只会反复点保存').toHaveCount(0)

  const after = await runtimeRow(FORK)
  expect(after?.binaryPath, '改过的二进制路径没落库 ⇒ 界面显示新路径、实际仍拉旧的').toBe(
    OTHER_BINARY,
  )
  expect(
    after?.configDirEnv,
    'config-dir 环境变量名没落库 ⇒ 自定义 fork 读不到平台注入的配置',
  ).toBe('E2E_FORK_CONFIG_DIR')
  expect(after?.configDirName, 'config-dir 目录名没落库').toBe('e2eforkcfg')

  // 关键的一条：冒烟回执描述的是**某一组确切的执行画像**。画像一变，旧结论必须作废
  // （runtimeRegistry.ts:853-857 直接把 lastProbeJson 置 null）。留着旧绿 = 给一个
  // 从未被验证过的二进制发通行证。
  expect(
    after?.lastProbe,
    '换了二进制/配置目录，旧的冒烟结论却还挂着 ⇒ 绿灯对应的是一个已经不存在的配置',
  ).toBeNull()
  await expect(
    smokeChip(page, FORK),
    '服务端已经作废了旧结论，界面还在显示它 ⇒ 管理员据此判断「已验证」',
  ).toHaveText(SMOKE_UNTESTED)
  await expect(
    row(page, FORK).locator('code.runtime-list__binary'),
    '列表还在显示旧的二进制路径 ⇒ 表与注册表脱节',
  ).toHaveText(OTHER_BINARY)
})

test('RFC-319 CFG-14：在表内「设为默认」既要改界面，也要真的写进 config.defaultRuntime', async ({
  page,
}) => {
  await openRuntimeTab(page)

  expect(
    (await readConfig())['defaultRuntime'],
    '前提变了：config 里已经有 defaultRuntime',
  ).toBeUndefined()

  const patched = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/config',
    { timeout: 60_000 },
  )
  await row(page, FORK).getByRole('button', { name: 'Set default', exact: true }).click()
  expect((await patched).status(), `设为默认的写入失败：${await (await patched).text()}`).toBe(200)

  // ① 服务端事实：默认运行时是 config 里的一个字段，不是列表的装饰。只改界面不写
  // config，重启后一切复原，而任务在这期间跑的还是老默认。
  await expect
    .poll(async () => (await readConfig())['defaultRuntime'], {
      timeout: 20_000,
      message: '界面标了新默认，config.defaultRuntime 却没变 ⇒ 任务仍会落到旧的运行时上',
    })
    .toBe(FORK)

  // ② 界面事实：标记要跟着挪走，并且旧默认那一行重新出现「设为默认」入口。
  await expect(
    row(page, FORK).locator('.status-chip', { hasText: /^default$/ }),
    'config 已经改了，界面上的默认标记却没挪 ⇒ 两个地方各说各话',
  ).toHaveCount(1)
  await expect(
    row(page, 'opencode').locator('.status-chip', { hasText: /^default$/ }),
    '旧默认行的标记没撤 ⇒ 界面上出现两个默认',
  ).toHaveCount(0)
  await expect(
    row(page, FORK).getByRole('button', { name: 'Set default', exact: true }),
    '已经是默认了还留着「设为默认」⇒ 按钮不反映状态',
  ).toHaveCount(0)
  await expect(
    row(page, 'opencode').getByRole('button', { name: 'Set default', exact: true }),
    '旧默认行拿不回「设为默认」⇒ 默认再也改不回去',
  ).toHaveCount(1)

  // ③ 刷新后仍然如此——排除「只改了内存里的乐观态」。
  await page.reload()
  await expect(
    row(page, FORK).locator('.status-chip', { hasText: /^default$/ }),
    '刷新之后默认标记回到了旧行 ⇒ 之前那次只是乐观更新，没有真的生效',
  ).toHaveCount(1)
})

test('RFC-319 CFG-15：非默认运行时能真停用；有效默认停不掉——按钮拦一层，服务端还要再拦一层', async ({
  page,
}) => {
  await openRuntimeTab(page)

  expect(
    (await readConfig())['defaultRuntime'],
    `前提不成立：默认应当仍是 ${FORK}（由 CFG-14 那条设定）`,
  ).toBe(FORK)

  // —— 正向：非默认的行确实停得掉。没有这一条，「默认停不掉」可能只是「谁都停不掉」。
  await row(page, 'claude-code').getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(
    row(page, 'claude-code').locator('.status-chip', { hasText: /^disabled$/ }),
    '点了停用却没有任何状态变化 ⇒ 用户以为停了，它其实还在被选取',
  ).toHaveCount(1)
  await expect
    .poll(async () => (await runtimeRow('claude-code'))?.enabled, {
      timeout: 20_000,
      message: '界面标成停用，注册表里仍是启用 ⇒ 停用只是个视觉效果',
    })
    .toBe(false)
  await expect(
    row(page, 'claude-code').getByRole('button', { name: 'Enable', exact: true }),
    '停用后没有还原入口 ⇒ 停用变成单向操作',
  ).toHaveCount(1)
  // 停用的行不能再被设成默认（RuntimeList.tsx:255 与 routes/config.ts:65-77 两道），
  // 否则调度会指向一个已经退出选取面的运行时。
  await expect(
    row(page, 'claude-code').getByRole('button', { name: 'Set default', exact: true }),
    '停用的行还能被设为默认 ⇒ 默认会指向一个已经不参与调度的运行时',
  ).toHaveCount(0)

  // —— 反向：有效默认停不掉。停掉它，调度链就没有活着的目标了。
  const defaultDisable = row(page, FORK).getByRole('button', { name: 'Disable', exact: true })
  await expect(
    defaultDisable,
    '默认运行时的停用按钮仍可点 ⇒ 一次误点就让调度链没有可用目标',
  ).toBeDisabled()
  await expect(
    defaultDisable,
    '禁用了按钮却不说为什么 ⇒ 用户只会觉得界面坏了，而不知道要先改默认',
  ).toHaveAttribute('title', 'The default runtime cannot be disabled — change the default first.')

  // 界面上的 disabled 只是 UX。真边界在服务端——直接打这条 API 必须被拒，
  // 否则任何脚本 / 老页面都能绕过去。
  const refused = await rawApi(`/api/runtimes/${FORK}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  })
  expect(refused.status, '服务端允许停用有效默认 ⇒ 灰按钮是唯一防线，绕过即生效').toBe(409)
  expect(((await refused.json()) as { code: string }).code).toBe('runtime-default-cannot-disable')
  expect(
    (await runtimeRow(FORK))?.enabled,
    '被拒的请求仍然改了状态 ⇒ 拒绝只是个错误码，副作用照样发生',
  ).toBe(true)

  // 还原：把 claude-code 启用回来（后面的删除用例要它在场），顺带证明启用真的生效。
  await row(page, 'claude-code').getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(
    row(page, 'claude-code').locator('.status-chip', { hasText: /^disabled$/ }),
    '重新启用后停用标记没撤 ⇒ 停用/启用不是一对可逆操作',
  ).toHaveCount(0)
  await expect
    .poll(async () => (await runtimeRow('claude-code'))?.enabled, { timeout: 20_000 })
    .toBe(true)
})

test('RFC-319 CFG-13：对已注册运行时重测会留下新结论；探测期间那一行被改掉，结论必须作废而不是贴到新配置上', async ({
  page,
}) => {
  // 夹具复位（不是本条要验的面）：把 FORK 的二进制指回可探测的 stub。
  await api(`/api/runtimes/${FORK}`, {
    method: 'PUT',
    body: JSON.stringify({ binaryPath: daemon.stubOpencode }),
  })
  expect(
    (await runtimeRow(FORK))?.lastProbe,
    '前提不成立：换过二进制之后这一行不该还带着回执',
  ).toBeNull()

  await openRuntimeTab(page)

  // —— 正向：点 Test 会真的再跑一次冒烟，并把结论落到行上。
  const probed = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/runtimes/${FORK}/probe`,
    { timeout: 90_000 },
  )
  await row(page, FORK).getByRole('button', { name: 'Test', exact: true }).click()
  const probeResponse = await probed
  expect(probeResponse.status(), `重测失败：${await probeResponse.text()}`).toBe(200)

  const retested = await runtimeRow(FORK)
  expect(
    retested?.lastProbe?.outcome,
    '点了 Test 却没有在行上留下结论 ⇒ 下次打开还是「未测」，这个按钮等于没有',
  ).toBeTruthy()
  await expect(
    smokeChip(page, FORK),
    '重测拿到了结论，chip 却还停在「未测」⇒ 用户会以为没跑起来，反复点',
  ).toHaveText(SMOKE_LABEL[retested!.lastProbe!.outcome]!)
  await expect(
    page.getByTestId(`runtime-smoke-detail-${FORK}`),
    '有结论没有详情 ⇒ 失败时无从定位',
  ).toHaveText(retested!.lastProbe!.detail)

  // —— 409：探测跑在子进程里，期间这一行完全可能被别人（或另一个标签页）改掉。
  // 若结论仍被写下，那面绿灯描述的是**已经不存在**的那份配置。
  // 用 hold 文件把这一次探测确定性地扣住，再在中途改掉二进制路径。
  rmSync(`${holdFile}.started`, { force: true })
  writeFileSync(holdFile, '')

  const stale = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/runtimes/${FORK}/probe`,
    { timeout: 120_000 },
  )
  await row(page, FORK).getByRole('button', { name: 'Test', exact: true }).click()

  await expect
    .poll(() => existsSync(`${holdFile}.started`), {
      timeout: 60_000,
      message: '被探测的子进程始终没起来 ⇒ 这条竞态用例的前提不成立（不是产品问题）',
    })
    .toBe(true)

  // 探测还扣在半空中时把这一行改掉。
  await api(`/api/runtimes/${FORK}`, {
    method: 'PUT',
    body: JSON.stringify({ binaryPath: OTHER_BINARY }),
  })
  releaseHold()

  const staleResponse = await stale
  expect(
    staleResponse.status(),
    '探测期间那一行被改了，结论却照旧被接受 ⇒ 新二进制会白捡一个从未属于它的结论',
  ).toBe(409)
  expect(((await staleResponse.json()) as { code: string }).code).toBe('runtime-probe-stale')

  const afterRace = await runtimeRow(FORK)
  expect(afterRace?.binaryPath, '中途那次改动没生效，竞态前提不成立').toBe(OTHER_BINARY)
  expect(
    afterRace?.lastProbe,
    '过期的探测结论被贴到了改动后的配置上 ⇒ 管理员看到一面为旧二进制点亮的绿灯',
  ).toBeNull()

  await page.reload()
  await expect(
    smokeChip(page, FORK),
    '刷新后界面仍给这一行显示结论 ⇒ 用户据此认为新二进制已验证',
  ).toHaveText(SMOKE_UNTESTED)
})

test('RFC-319 CFG-16（一）：删除的三条引用型拒绝分支——被代理引用 / 是默认 / 被 config 功能字段引用', async ({
  page,
}) => {
  // 夹具：一个代理指向 NO_PATH；一个 config 功能字段指向 claude-code。
  const agent = await api<{ id: string; updatedAt: number; aclRevision: number }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-runtime-holder',
      description: 'RFC-319 CFG-16 fixture: holds a reference to a runtime',
      outputs: ['answer'],
      runtime: NO_PATH,
      bodyMd: 'body',
    }),
  })
  await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ memoryDistillRuntime: 'claude-code' }),
  })

  await openRuntimeTab(page)

  const confirmDialog = page.locator('.confirm-dialog')

  /** 点删除 → 确认 → 期望被拒；返回确认框里那条错误的原始文案。 */
  async function expectDeleteRefused(name: string, expectedRaw: string): Promise<void> {
    await row(page, name).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      confirmDialog,
      `删除 ${name} 没有二次确认 ⇒ 一次误点就不可撤销地删掉一个运行时`,
    ).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click()

    const banner = confirmDialog.getByRole('alert')
    await expect(
      banner,
      `${name} 的删除被服务端拒了，界面却什么都没说 ⇒ 用户以为删掉了，回头发现还在`,
    ).toBeVisible()
    // 原始文案在可展开的详情里——三条拒绝分支共用同一句标题，只有它能区分
    // 到底是被谁挡住的（被哪个代理 / 哪个 config 字段）。看不到它，用户只知道
    // 「删不掉」，不知道该去改哪里。
    await banner.locator('details.error-details__raw summary').click()
    await expect(
      banner.locator('details.error-details__raw pre'),
      `${name} 的拒绝原因没有指出具体的引用方 ⇒ 用户不知道该先去改什么才能删`,
    ).toContainText(expectedRaw)

    await confirmDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(
      row(page, name),
      `${name} 被拒之后仍从列表里消失了 ⇒ 界面显示已删、注册表里还在，引用方指向一个「看不见」的行`,
    ).toHaveCount(1)
    expect(
      (await listRuntimes()).map((r) => r.name),
      `${name} 被拒之后仍被真的删掉了 ⇒ 拒绝只是提示，副作用照样发生`,
    ).toContain(name)
  }

  // ① 被代理引用：删掉它，那个代理下次派发就指向空气。
  await expectDeleteRefused(NO_PATH, "agent 'rfc319-runtime-holder'")

  // ② 是有效默认：删掉它，所有未显式指定运行时的任务都没有落点。
  await expectDeleteRefused(FORK, 'config.defaultRuntime')

  // ③ 被 config 的功能字段引用（记忆蒸馏用的运行时）：这条最容易被漏——它既不是
  // 默认、也没有代理指着，只有 config 里一行字段在用。漏了它，蒸馏会在下一次
  // 触发时才失败，而且现场离配置改动已经很远。
  await expectDeleteRefused('claude-code', 'config.memoryDistillRuntime')

  // 收尾：解除引用，交给下一条用例做正向删除。
  // 代理的 DELETE 是 type-to-confirm（services/deleteConfirm.ts:44-66）+ 版本围栏。
  await api(`/api/agents/${agent.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: 'rfc319-runtime-holder',
      expectedUpdatedAt: agent.updatedAt,
      expectedAclRevision: agent.aclRevision ?? 0,
    }),
  })
  await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ memoryDistillRuntime: null, defaultRuntime: 'opencode' }),
  })
})

test('RFC-319 CFG-16（二）：没有引用的运行时确实删得掉；删到只剩一行时必须停手', async ({
  page,
}) => {
  expect(
    (await readConfig())['defaultRuntime'],
    '前提不成立：默认应当已经改回 opencode（由上一条用例收尾）',
  ).toBe('opencode')

  await openRuntimeTab(page)
  const confirmDialog = page.locator('.confirm-dialog')

  // —— 负向对照：解除引用之后，同一行确实删得掉。没有这一条，上面三条「删不掉」
  // 可能只是「删除功能坏了」。
  await row(page, NO_PATH).getByRole('button', { name: 'Delete', exact: true }).click()
  await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(
    confirmDialog,
    '删除成功了确认框却不关 ⇒ 用户不知道到底删没删，容易再点一次',
  ).toHaveCount(0)
  await expect(
    row(page, NO_PATH),
    '删除成功了列表里还在 ⇒ 界面与注册表脱节，用户会反复删同一行',
  ).toHaveCount(0)
  expect(
    (await listRuntimes()).map((r) => r.name),
    '界面上行没了，注册表里还在 ⇒ 「删掉了」是假象',
  ).not.toContain(NO_PATH)

  // 夹具：把剩下的非默认行清掉，逼出「只剩一行」的边界（删除本身已在上面验过）。
  await api(`/api/runtimes/${FORK}`, { method: 'DELETE' })
  await api('/api/runtimes/claude-code', { method: 'DELETE' })
  expect(
    (await listRuntimes()).map((r) => r.name),
    '夹具没能删到只剩一行，最后一行的边界无从验证',
  ).toEqual(['opencode'])

  // —— 最后一行：删掉它，注册表就空了——调度没有任何目标，而且下次启动的空表播种
  // 还会把「被删掉的」内置行复活，删除语义当场自相矛盾。
  await page.reload()
  await expect(page.locator('.runtime-list__row')).toHaveCount(1)
  await row(page, 'opencode').getByRole('button', { name: 'Delete', exact: true }).click()
  await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click()

  const banner = confirmDialog.getByRole('alert')
  await expect(
    banner,
    '删掉最后一个运行时没有被拦 ⇒ 注册表被清空，任何任务都没有可用的运行时',
  ).toBeVisible()
  await expect(banner).toContainText('This is the only remaining runtime; it cannot be deleted.')
  await confirmDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(
    (await listRuntimes()).map((r) => r.name),
    '被拒之后最后一行仍被删掉了 ⇒ 注册表已经空了，只是界面还没显示出来',
  ).toEqual(['opencode'])
  await expect(
    row(page, 'opencode'),
    '被拒之后界面上的最后一行消失了 ⇒ 管理员看到一张空表，会去重装或重建',
  ).toHaveCount(1)
})
