// RFC-319 —— 设置页各配置分区与保存机制的用户面验收
// （CFG-01 / 02 / 05 / 07 / 09 / 23 / 26 / 27 / 35 / 36）。
//
// 这一页管的是**守护进程自己的运行参数**：谁能进来改、改错了怎么说、别人同时改
// 了怎么办、改完到底生效没有。它的失效形态都很安静，用户往往要等到很久以后才发现：
//
//   * 【CFG-02】守卫只藏了侧栏入口，URL 一敲照样进 —— 非管理员看到整页设置骨架
//     （RFC-270 之前的真实形态，见 routes/settings.tsx:80-106 的注释），以为自己
//     能改，改完每个请求 403，或更糟：他以为改成功了。
//   * 【CFG-05】服务端拒绝了却没说为什么（或干脆什么都不显示）—— 用户带着一个从
//     未落库的值继续走；更坏的是把一次「明确失败」当成「结果未知」处理，整条连接
//     被 fail-closed 锁死，本来只要改个数字就能继续。
//   * 【CFG-07】别人并发改了同一项，本地草稿被静默覆盖（或反过来：我一保存就把
//     别人的值悄悄冲掉）。正确形态是**告诉我服务端变了、保留我的草稿、并给我一条
//     「用服务端的值」的出路**——而且那条出路必须落到**服务端当前的值**，不是我
//     进页面时的旧基线。
//   * 【CFG-23】并发/配额六项在设置页上长得一模一样，用户没有任何线索知道哪一项
//     是「下次重启才生效」（RFC-287 T10 修的正是这个）。要么真的立即生效，要么明
//     确说要重启，不能两不沾。
//   * 【CFG-26】排除规则写错（`../` 逃出仓库）却照样存下去 —— 平台自动提交时按一
//     条越界规则行事；反过来，校验只在前端做而服务端放行，同样是假防线。
//   * 【CFG-27】嵌套对象保存时被拆散（只发了 enabled 就把 olderThanDays / onlyMerged
//     丢了），或者一个分区保存顺手把别的分区的值一起写回旧值。
//   * 【CFG-35/36】主题/语言存下了但没应用，用户得刷新才看到；或者应用了但没存住，
//     刷新就打回原形。
//   * 【CFG-01】?tab= 不是分区的事实源 —— 收藏/分享的链接总是落回默认分区。
//   * 【CFG-09】带着未保存的改动点走，改动无声消失（或反过来：没有任何改动也弹拦截
//     框，用户被迫多点一次）。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链）：
//   * 路由守卫 / 重定向：packages/frontend/src/routes/settings.tsx:108-124
//   * ?tab= 规范化：packages/frontend/src/routes/settings.tsx:259-263、296-306
//   * 保存回执 / 错误 / stale / 重启横幅：packages/frontend/src/routes/settings.tsx:3283-3371
//   * 「重启才生效」的键集合：packages/frontend/src/routes/settings.tsx:3214-3232
//   * 分区最小写入白名单（保存只写自己那一份）：packages/frontend/src/lib/settings-drafts.ts:36-118
//   * stale 判定与「放弃本地」采用服务端当前值：packages/frontend/src/lib/edit-scope.ts:309-335、337-350
//   * 未保存拦截 + 同资源分区切换放行：packages/frontend/src/components/settings/SettingsDraftProvider.tsx:277-300
//     与 packages/frontend/src/lib/edit-scope.ts:659-684
//   * 主题落到 <html data-theme>：packages/frontend/src/hooks/useTheme.ts:88-96
//   * 语言保存后立即 setLanguage：packages/frontend/src/routes/settings.tsx:1656-1663
//   * 服务端保存门（body ≤ row）：packages/backend/src/routes/config.ts:79-90
//   * 六项并发/配额的热应用线性化点：packages/backend/src/routes/config.ts:118-142
//   * 排除规则的服务端校验（`../` 越界）：packages/shared/src/schemas/config.ts:80-114
//
// 与既有用例的分工（务必不要重复）：
//   * e2e/settings-save-receipt.spec.ts —— CFG-04：保存成功要有明确回执，且回执对应
//     真的落库（以 GC 的 webhook body 保留期为载体）。本文件不再重复「回执本身」，
//     只在别的能力里把它当作「保存成功」的信号使用。
//   * e2e/settings-outcome-unknown.spec.ts —— RES-08：响应**丢失**（连接被掐断）时
//     的 fail-closed 写屏障。本文件 CFG-05 覆盖的是相反的一侧：服务端给出了**明确
//     的 4xx 拒绝**，此时绝不允许进入写屏障。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// --------------------------------------------------------------------------
// Helpers —— 服务端可核对的事实优先：/api/config、磁盘上的 config.json、/health。
// --------------------------------------------------------------------------

type ConfigJson = Record<string, unknown>

async function primeToken(target: Page, token: string = daemon.token): Promise<void> {
  await target.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: token },
  )
}

async function readConfig(token: string = daemon.token): Promise<ConfigJson> {
  const res = await fetch(`${daemon.baseUrl}/api/config`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.text()
  expect(res.ok, `read config: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as ConfigJson
}

/** 带外写入：模拟「另一个管理员 / 另一台机器」对同一份配置的改动。 */
async function putConfig(patch: ConfigJson, token: string = daemon.token): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

async function seedConfig(patch: ConfigJson): Promise<void> {
  const res = await putConfig(patch)
  expect(res.ok, `seed config failed: ${res.status} ${await res.text().catch(() => '')}`).toBe(true)
}

/** 守护进程真正会在下次启动时读的那份文件——「落库」的最终形态。 */
function readDiskConfig(): ConfigJson {
  return JSON.parse(readFileSync(join(daemon.home, 'config.json'), 'utf-8')) as ConfigJson
}

async function daemonUptimeSeconds(): Promise<number> {
  const res = await fetch(`${daemon.baseUrl}/health`)
  expect(res.ok, `health: ${res.status}`).toBe(true)
  return ((await res.json()) as { uptime: number }).uptime
}

function changedTopLevelKeys(before: ConfigJson, after: ConfigJson): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort()
}

function saveButton(page: Page, label = 'Save'): Locator {
  return page.getByRole('button', { name: label, exact: true })
}

function receipt(page: Page): Locator {
  return page.locator('.form-actions__ok')
}

function saveError(page: Page): Locator {
  return page.locator('.form-actions__error')
}

function noticeBanner(page: Page, title: string): Locator {
  return page.locator('.notice-banner', { hasText: title })
}

/** 分区导航：宽屏是 rail（真链接），窄屏折叠成 Select——两种形态都要能点。 */
async function clickSectionNav(page: Page, label: string): Promise<void> {
  const nav = page.locator('nav.page-section-nav')
  await expect(nav).toBeVisible()
  if ((await nav.getAttribute('data-mode')) === 'compact') {
    await page.getByTestId('settings-compact-select').click()
    await page.getByRole('option', { name: new RegExp(`^${label}\\b`) }).click()
    return
  }
  await nav.getByRole('link', { name: new RegExp(`^${label}\\b`) }).click()
}

/** 分区导航上某个叶子的状态徽标（脏 = neutral，服务端变了 = attention）。 */
function sectionBadge(
  page: Page,
  label: string,
  tone: 'neutral' | 'attention' | 'danger',
): Locator {
  return page
    .locator('nav.page-section-nav .page-section-nav__leaf', { hasText: label })
    .locator(`.page-section-nav__badge[data-tone="${tone}"]`)
}

async function createUserAndLogin(
  username: string,
  role: 'admin' | 'user',
): Promise<{ id: string; token: string }> {
  const password = 'Sect10n-Pass-2026!'
  const created = await fetch(`${daemon.baseUrl}/api/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      displayName: username,
      role,
      password,
    }),
  })
  const createdBody = await created.text()
  expect(created.ok, `create ${username}: ${created.status} ${createdBody}`).toBe(true)
  const { id } = JSON.parse(createdBody) as { id: string }

  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(login.ok, `login ${username}: ${login.status}`).toBe(true)
  return { id, token: ((await login.json()) as { sessionToken: string }).sessionToken }
}

// --------------------------------------------------------------------------
// CFG-01 P3 —— 分区导航与 ?tab= 深链接
// --------------------------------------------------------------------------

test('RFC-319 CFG-01：?tab= 是设置分区的唯一事实源——深链接直达、导航改 URL、脏值回落默认分区 @nightly', async ({
  page,
}) => {
  await primeToken(page)

  // ① 深链接直达 Git 分区。不成立 ⇒ 收藏/分享出去的设置链接永远落回默认分区，
  //    接收方还要自己再点一次才知道说的是哪一块。
  await page.goto(`${daemon.baseUrl}/settings?tab=git`)
  await expect(
    page.locator('#settings-section-title-git'),
    '?tab=git 没有打开 Git 分区 ⇒ 深链接失去意义',
  ).toHaveText('Git', { timeout: 30_000 })
  await expect(
    page.getByTestId('settings-task-commit-exclude-patterns'),
    'Git 分区的专属控件没渲染 ⇒ 标题对了内容没对，用户面前是一块空白',
  ).toBeVisible()
  await expect(
    page.getByTestId('settings-webhook-body-retention'),
    'GC 分区的控件同时出现在 Git 分区里 ⇒ 分区形同虚设，用户会改到自己没打算改的东西',
  ).toHaveCount(0)

  // ② 当前叶子要在导航上自报身份，否则用户在十一个分区里找不到自己在哪。
  const nav = page.locator('nav.page-section-nav')
  await expect(
    nav.getByRole('link', { name: /^Git\b/ }),
    '导航没有标出当前分区 ⇒ 用户不知道自己身处哪一块设置',
  ).toHaveAttribute('aria-current', 'page')

  // ③ 点导航必须改 URL（而不是只换组件内部状态）。不成立 ⇒ 刷新/后退全部回到起点。
  await clickSectionNav(page, 'GC')
  await expect(page, '点分区导航没有改 URL ⇒ 刷新即丢失所在分区').toHaveURL(/\/settings\?.*tab=gc/)
  await expect(page.getByTestId('settings-webhook-body-retention')).toBeVisible()
  await expect(
    page.getByTestId('settings-task-commit-exclude-patterns'),
    '切走之后旧分区的控件还在 ⇒ 两个分区叠在一起',
  ).toHaveCount(0)

  // ④ 后退回到上一个分区——分区切换是 push 而不是 replace。不成立 ⇒ 用户按后退
  //    会直接跳出设置页，丢掉刚才的浏览路径。
  await page.goBack()
  await expect(page, '后退没有回到上一个分区 ⇒ 分区导航没有进入历史').toHaveURL(
    /\/settings\?.*tab=git/,
  )
  await expect(page.locator('#settings-section-title-git')).toHaveText('Git')

  // ⑤ 刷新后仍停在深链接指定的分区（URL 权威，而非组件状态）。
  await page.goto(`${daemon.baseUrl}/settings?tab=appearance`)
  await expect(page.locator('#settings-section-title-appearance')).toHaveText('Appearance', {
    timeout: 30_000,
  })
  await page.reload()
  await expect(
    page.locator('#settings-section-title-appearance'),
    '刷新后掉回默认分区 ⇒ URL 不是事实源，深链接只是「第一次有效」',
  ).toHaveText('Appearance', { timeout: 30_000 })

  // ⑥ 缺省与非法值都要规范化到 runtime，并把 URL 一起写正。不成立 ⇒ 用户手敲/被
  //    分享到一个坏链接时看到空白面板，且后退会在坏 URL 上打转。
  await page.goto(`${daemon.baseUrl}/settings`)
  await expect(page, '缺省 tab 没有被规范化写回 URL ⇒ 后退会在无 tab 的 URL 上反复').toHaveURL(
    /\/settings\?.*tab=runtime/,
    { timeout: 30_000 },
  )
  await expect(page.locator('#settings-section-title-runtime')).toHaveText('Runtime')

  await page.goto(`${daemon.baseUrl}/settings?tab=definitely-not-a-tab`)
  await expect(page, '非法 tab 没有回落到默认分区 ⇒ 坏链接把用户带到一块空白').toHaveURL(
    /\/settings\?.*tab=runtime/,
    { timeout: 30_000 },
  )
  await expect(page.locator('#settings-section-title-runtime')).toHaveText('Runtime')
})

// --------------------------------------------------------------------------
// CFG-02 P2 —— 非 admin 直接输入 /settings URL 被重定向（含 admin 能进的正向对照）
// --------------------------------------------------------------------------

test('RFC-319 CFG-02：非管理员直接敲 /settings URL 被弹回首页，管理员照常进入 @nightly', async ({
  page,
  browser,
}) => {
  const bob = await createUserAndLogin('rfc319-cfg02-bob', 'user')

  // 前提（也是这条能力的边界）：普通用户在服务端就没有 settings:read。守卫是 UX，
  // 真正的边界在服务端——两边都要成立。
  const me = await fetch(`${daemon.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  })
  expect(me.ok).toBe(true)
  const permissions = ((await me.json()) as { permissions: string[] }).permissions
  expect(
    permissions,
    '普通用户竟然带着 settings:read ⇒ 这条用例的前提不成立，权限模型本身要先修',
  ).not.toContain('settings:read')

  const forbidden = await fetch(`${daemon.baseUrl}/api/config`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  })
  expect(
    forbidden.status,
    '普通用户能直接读 /api/config ⇒ 前端跳不跳转都无所谓了，配置已经泄露',
  ).toBe(403)

  // 负向：非管理员敲 URL 进不去，被 replace 到首页。
  await primeToken(page, bob.token)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  await expect
    .poll(() => new URL(page.url()).pathname, {
      timeout: 30_000,
      message: '非管理员敲 /settings 竟然停在设置页 ⇒ 他会以为自己能改，改完每次都 403',
    })
    .toBe('/')
  await expect(
    page.locator('nav.page-section-nav'),
    '被弹回首页后设置分区导航还在 ⇒ 页面只是「看起来」跳走了',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('shell-navigation-desktop'),
    '重定向落到了一块白屏 ⇒ 用户被卡在一个没有出口的页面上',
  ).toBeVisible({ timeout: 30_000 })

  // 正向对照：同一个 URL，管理员必须进得去——守卫不能宽到把管理员也挡在外面
  // （settings.tsx:96-101 明确要求 /me 出错时 fail-open，就是怕把管理员锁在门外）。
  const adminContext = await browser.newContext()
  try {
    const adminPage = await adminContext.newPage()
    await primeToken(adminPage)
    await adminPage.goto(`${daemon.baseUrl}/settings?tab=gc`)
    await expect(
      adminPage.getByTestId('settings-webhook-body-retention'),
      '管理员也被挡在设置页之外 ⇒ 守卫过宽，没人能再修守护进程了',
    ).toBeVisible({ timeout: 30_000 })
    expect(new URL(adminPage.url()).pathname).toBe('/settings')
  } finally {
    await adminContext.close()
  }
})

// --------------------------------------------------------------------------
// CFG-05 P2 —— 服务端拒绝保存时的错误呈现
// --------------------------------------------------------------------------

test('RFC-319 CFG-05：服务端明确拒绝时，页面说清原因、原样保留草稿、且不进入写屏障 @nightly', async ({
  page,
}) => {
  // 前提：body(30) ≤ row(90)。下面故意把 body 填到 95 去越过服务端的保存门
  // （backend/src/routes/config.ts:79-90 —— body 置空窗口不得长于整行保留窗口）。
  await seedConfig({ webhookDeliveryBodyRetentionDays: 30, webhookDeliveryRowRetentionDays: 90 })

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const body = page.getByTestId('settings-webhook-body-retention')
  await expect(body).toBeVisible({ timeout: 30_000 })

  await body.fill('95')
  await expect(saveButton(page)).toBeEnabled()
  await saveButton(page).click()

  // ① 必须给出**可执行的**失败说明。只说「失败了」等于让用户去猜哪一项越界。
  await expect(
    saveError(page),
    '服务端拒绝了却没有任何错误呈现 ⇒ 用户以为存上了，带着一个从未生效的保留期继续走',
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    saveError(page),
    '错误里没有说清是哪两项冲突 ⇒ 用户只能一项项试，而这页有几十个数字',
  ).toContainText('must not exceed')
  await expect(saveError(page)).toContainText('95')

  // ② 服务端一点没变：被拒绝的保存不允许半落地。
  expect(
    (await readConfig())['webhookDeliveryBodyRetentionDays'],
    '保存被拒却把值写进去了 ⇒ 校验形同虚设，坏值已经生效',
  ).toBe(30)

  // ③ 草稿原样保留，用户不必重打一遍。
  await expect(
    body,
    '报错顺手把输入清空/回滚了 ⇒ 用户要重新输入，且失去了「我刚才填的是什么」的线索',
  ).toHaveValue('95')

  // ④ 明确的 4xx 是「已知失败」，绝不能升级成「结果未知」的连接级写屏障
  //    （那条路径由 settings-outcome-unknown.spec.ts 专门守着，两者必须分得开）。
  await expect(
    noticeBanner(page, 'The previous save is still being reconciled with the server'),
    '一次明确的拒绝把整条连接锁成了「结果未知」⇒ 用户只是填错一个数字，却被要求重启 daemon',
  ).toHaveCount(0)
  await expect(
    saveButton(page),
    '拒绝之后保存按钮被永久禁用 ⇒ 改对了也提交不了，只能刷新页面',
  ).toBeEnabled()

  // ⑤ 可恢复：改成合法值就能存进去，且错误呈现随之消失。
  await body.fill('45')
  await saveButton(page).click()
  await expect(receipt(page), '改对之后仍然存不进去 ⇒ 这个分区被上一次失败卡死了').toBeVisible({
    timeout: 20_000,
  })
  await expect(
    saveError(page),
    '保存成功了旧的错误还挂在那里 ⇒ 用户无法判断当前到底是成是败',
  ).toHaveCount(0)
  await expect
    .poll(async () => (await readConfig())['webhookDeliveryBodyRetentionDays'], { timeout: 20_000 })
    .toBe(45)
})

// --------------------------------------------------------------------------
// CFG-26 P2 —— Git 分区：任务提交排除模式的校验与保存
// --------------------------------------------------------------------------

test('RFC-319 CFG-26：越界的提交排除规则前端拦、服务端也拦；合法规则原样落库并归一化 @nightly', async ({
  page,
}) => {
  await seedConfig({ taskCommitExcludePatterns: [] })

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=git`)
  const patterns = page.getByTestId('settings-task-commit-exclude-patterns')
  await expect(patterns).toBeVisible({ timeout: 30_000 })

  // ① 一条逃出仓库的规则（`../`）必须当场被指出。不成立 ⇒ 平台自动提交时会按一条
  //    越界规则行事，用户以为自己只是排除了一个缓存目录。
  await patterns.fill('/.cache-agent/\n../outside/secrets')
  await expect(
    page.getByText('Host paths, NUL, and ../ are not allowed', { exact: false }),
    '越界规则没有任何提示 ⇒ 用户不知道自己写错了，直到某次提交漏/多了文件才发现',
  ).toBeVisible()
  await expect(patterns, '控件没有标成 aria-invalid ⇒ 读屏用户完全收不到这条错误').toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await expect(saveButton(page), '带着非法规则还能点保存 ⇒ 校验只是装饰').toBeDisabled()
  await expect(
    page.getByText('Fix the invalid values in this section before saving'),
    '按钮灰了却不说为什么 ⇒ 用户面对一个点不动的保存按钮无从下手',
  ).toBeVisible()

  // ② 服务端不能只信前端：同样的载荷直接 PUT 也必须被拒。不成立 ⇒ 任何绕过界面的
  //    调用（脚本、旧版页面）都能把越界规则写进配置。
  const rejected = await putConfig({ taskCommitExcludePatterns: ['../outside/secrets'] })
  expect(rejected.ok, '服务端放行了越界规则 ⇒ 前端校验是唯一防线，等于没有防线').toBe(false)
  expect(rejected.status).toBeGreaterThanOrEqual(400)
  expect(rejected.status).toBeLessThan(500)
  expect(
    (await readConfig())['taskCommitExcludePatterns'],
    '被拒的规则仍然进了配置 ⇒ 拒绝只是嘴上说说',
  ).toEqual([])

  // ③ 合法规则：保存后逐条落库，顺序保持，空行被归一化掉。
  await patterns.fill('# runtime scratch\n/.cache-agent/\n\n*.trace\n!generated/schema.ts')
  await expect(
    saveButton(page),
    '改成合法规则后保存仍然点不动 ⇒ 这个分区被上一次校验失败卡死了',
  ).toBeEnabled()
  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 20_000 })

  const expected = ['# runtime scratch', '/.cache-agent/', '*.trace', '!generated/schema.ts']
  await expect
    .poll(async () => (await readConfig())['taskCommitExcludePatterns'], {
      timeout: 20_000,
      message: '界面报了保存成功，服务端却没有这些规则 ⇒ 平台提交时仍按旧规则走',
    })
    .toEqual(expected)
  expect(
    readDiskConfig()['taskCommitExcludePatterns'],
    '只写进了内存没落盘 ⇒ 守护进程一重启，用户的排除规则就没了',
  ).toEqual(expected)

  // ④ 重新加载后回显的是归一化后的文本——用户下次编辑看到的就是真正生效的内容。
  await page.reload()
  await expect(
    page.getByTestId('settings-task-commit-exclude-patterns'),
    '重载后回显与落库内容不一致 ⇒ 用户按屏幕上的文本继续编辑，会把一条不存在的规则当成存在',
  ).toHaveValue(expected.join('\n'), { timeout: 30_000 })
})

// --------------------------------------------------------------------------
// CFG-27 P2 —— GC 分区：worktree 自动回收 / 事件归档阈值 / 保留期
// --------------------------------------------------------------------------

test('RFC-319 CFG-27：GC 三组旋钮整体落库——嵌套对象不被拆散，且只写本分区自己的键 @nightly', async ({
  page,
}) => {
  await seedConfig({
    worktreeAutoGc: { enabled: false },
    eventsArchiveThresholds: { perNodeRunRows: 50_000, globalRows: 1_000_000 },
    eventStreamRetentionDays: 30,
  })
  const before = await readConfig()

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)

  const autoGc = page.getByRole('checkbox', { name: /Auto-GC merged worktrees/ })
  const onlyMerged = page.getByRole('checkbox', { name: /Only GC merged branches/ })
  const olderThan = page.getByRole('spinbutton', { name: /GC older-than \(days\)/ })
  const perNodeRun = page.getByRole('spinbutton', { name: /per-node-run rows/ })
  const globalRows = page.getByRole('spinbutton', { name: /Events archive — global rows/ })
  const streamRetention = page.getByRole('spinbutton', { name: /Event stream retention \(days\)/ })
  await expect(autoGc).toBeVisible({ timeout: 30_000 })

  await autoGc.check()
  await olderThan.fill('5')
  await onlyMerged.check()
  await perNodeRun.fill('12000')
  await globalRows.fill('120000')
  await streamRetention.fill('7')

  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 20_000 })

  // ① 嵌套对象要整体成立。只发 enabled 而把 olderThanDays / onlyMerged 丢掉，
  //    结果就是「自动回收开了，但按的是默认条件」——它会去删用户没打算删的工作树。
  const after = await readConfig()
  expect(
    after['worktreeAutoGc'],
    '自动回收的三个字段没有整体落库 ⇒ 回收按的是默认条件，可能删掉用户还要用的工作树',
  ).toEqual({ enabled: true, olderThanDays: 5, onlyMerged: true })

  // ② 归档阈值同理：改行数不能把同一对象里的字节水位一起抹掉。
  const thresholds = after['eventsArchiveThresholds'] as Record<string, unknown>
  const thresholdsBefore = before['eventsArchiveThresholds'] as Record<string, unknown>
  expect(thresholds['perNodeRunRows']).toBe(12_000)
  expect(thresholds['globalRows']).toBe(120_000)
  expect(
    thresholds['perNodeRunBytes'],
    '改行数阈值把同一对象里的字节水位抹掉了 ⇒ 归档策略被无声改成另一套',
  ).toBe(thresholdsBefore['perNodeRunBytes'])
  expect(thresholds['globalBytes']).toBe(thresholdsBefore['globalBytes'])

  expect(after['eventStreamRetentionDays']).toBe(7)

  // ③ 真正落盘（守护进程下次启动读的就是它）。
  const disk = readDiskConfig()
  expect(
    disk['worktreeAutoGc'],
    '只写进了内存没落盘 ⇒ 重启后自动回收又变回关闭，用户毫不知情',
  ).toEqual({ enabled: true, olderThanDays: 5, onlyMerged: true })
  expect(disk['eventStreamRetentionDays']).toBe(7)

  // ④ 一次保存只写本分区自己的键（settings-drafts.ts 的最小写入白名单）。
  //    不成立 ⇒ 我在 GC 分区点一次保存，别人刚在 Limits / Git 分区改的值被我
  //    带着的旧快照冲回去了——而两边都不会收到任何提示。
  expect(
    changedTopLevelKeys(before, after),
    '保存 GC 分区顺手改动了别的分区的键 ⇒ 一次保存会静默回滚同事刚做的改动',
  ).toEqual(['eventStreamRetentionDays', 'eventsArchiveThresholds', 'worktreeAutoGc'])

  // ⑤ 重新加载后六个控件都回显新值——用户下次进来看到的就是生效值。
  await page.reload()
  await expect(page.getByRole('checkbox', { name: /Auto-GC merged worktrees/ })).toBeChecked({
    timeout: 30_000,
  })
  await expect(page.getByRole('checkbox', { name: /Only GC merged branches/ })).toBeChecked()
  await expect(page.getByRole('spinbutton', { name: /GC older-than \(days\)/ })).toHaveValue('5')
  await expect(page.getByRole('spinbutton', { name: /per-node-run rows/ })).toHaveValue('12000')
  await expect(page.getByRole('spinbutton', { name: /Events archive — global rows/ })).toHaveValue(
    '120000',
  )
  await expect(
    page.getByRole('spinbutton', { name: /Event stream retention \(days\)/ }),
    '重载后回显的不是刚存下的值 ⇒ 用户会以为没存上，于是再存一遍',
  ).toHaveValue('7')
})

// --------------------------------------------------------------------------
// CFG-23 P2 —— 并发与配额六项保存后立即热生效（无需重启）
// --------------------------------------------------------------------------

test('RFC-319 CFG-23：并发/配额六项一次保存全部落地，同一个进程立刻按新值应答，且不要求重启 @nightly', async ({
  page,
}) => {
  // RFC-287 T10 之前，这六项里有三项只能改配置文件、且要等 daemon 重启才生效，
  // 而它们在设置页上和旁边三项长得一模一样。这条用例锁的就是「六项等价」。
  await seedConfig({
    maxConcurrentNodes: 4,
    maxConcurrentScriptNodes: 4,
    multiProcessSubprocessConcurrency: 4,
    maxConcurrentCodeHostCalls: 8,
    maxActiveChildTasks: 8,
    maxInvocationDepth: 3,
  })
  const uptimeBefore = await daemonUptimeSeconds()

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=limits`)

  const knobs: ReadonlyArray<readonly [RegExp, string, number]> = [
    [/Max concurrent agent nodes \(global\)/, 'maxConcurrentNodes', 7],
    [/Max concurrent script nodes \(global\)/, 'maxConcurrentScriptNodes', 6],
    [/Fan-out subprocess concurrency \(per task\)/, 'multiProcessSubprocessConcurrency', 5],
    [/Max concurrent code-host calls \(global\)/, 'maxConcurrentCodeHostCalls', 9],
    [/Max active child tasks \(global\)/, 'maxActiveChildTasks', 11],
    [/Max invocation depth \(global\)/, 'maxInvocationDepth', 4],
  ]

  for (const [label, , value] of knobs) {
    const field = page.getByRole('spinbutton', { name: label })
    await expect(field, `并发/配额里少了一项（${String(label)}）⇒ 它只能靠改配置文件`).toBeVisible({
      timeout: 30_000,
    })
    await field.fill(String(value))
  }

  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 20_000 })

  // ① 六项全部落库。少登记一项的后果是最阴的：表单看起来改了、点了保存、没有任何
  //    报错，值却被静默丢掉（settings-drafts.ts 的白名单注释记的就是这次事故）。
  const after = await readConfig()
  const disk = readDiskConfig()
  for (const [, key, value] of knobs) {
    expect(after[key], `${key} 没有落库 ⇒ 用户改了、没报错、值却被静默丢掉`).toBe(value)
    expect(disk[key], `${key} 没有落盘 ⇒ 重启后回到旧值`).toBe(value)
  }

  // ② 同一个进程立刻按新值应答：uptime 没有回零，说明中间没有发生任何重启，
  //    而任意一个新的客户端（这里是带外 fetch）此刻读到的已经是新值。
  const uptimeAfter = await daemonUptimeSeconds()
  expect(
    uptimeAfter,
    '保存并发/配额之后守护进程重启了 ⇒ 正在跑的任务会被打断，这不是「热生效」',
  ).toBeGreaterThanOrEqual(uptimeBefore)

  // ③ 界面不得要求重启。这一项的可信度来自下面的正向对照：真正需要重启的键
  //    （bindPort）在同一套 UI 上**确实**会亮出重启横幅，所以这里的沉默是一个
  //    肯定的陈述，不是「这个功能根本没接线」。
  await expect(
    noticeBanner(page, 'Daemon restart required'),
    '并发/配额保存后要求重启 ⇒ 与文案和后端热应用逻辑自相矛盾，用户会白白重启一次',
  ).toHaveCount(0)

  const persistedPort = Number(after['bindPort'] ?? 0)
  await clickSectionNav(page, 'Network')
  const bindPort = page.getByTestId('settings-bind-port')
  await expect(bindPort).toBeVisible({ timeout: 30_000 })
  await bindPort.fill(String(persistedPort === 45_678 ? 45_679 : 45_678))
  await saveButton(page).click()
  await expect(
    noticeBanner(page, 'Daemon restart required'),
    '改监听端口却不提示重启 ⇒ 用户以为已经换端口了，实际连的还是旧端口',
  ).toBeVisible({ timeout: 20_000 })
})

// --------------------------------------------------------------------------
// CFG-07 P2 —— 设置项被他人并发改动后的 stale 横幅与「放弃本地」
// --------------------------------------------------------------------------

test('RFC-319 CFG-07：他人改了同一项时给出提示、保住我的草稿，「用服务端的值」落到对方的新值 @nightly', async ({
  page,
}) => {
  await seedConfig({
    webhookDeliveryBodyRetentionDays: 30,
    webhookDeliveryRowRetentionDays: 90,
    maxConcurrentNodes: 4,
  })

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const body = page.getByTestId('settings-webhook-body-retention')
  await expect(body).toBeVisible({ timeout: 30_000 })
  await body.fill('11')

  // 负向对照（没人动服务端时不能误报）：先在另一个分区做一次正常保存，把服务端
  // 最新配置带回来。此时 GC 分区只应显示「未保存」的中性徽标。
  await clickSectionNav(page, 'Limits')
  const concurrency = page.getByRole('spinbutton', {
    name: /Max concurrent agent nodes \(global\)/,
  })
  await expect(concurrency).toBeVisible({ timeout: 30_000 })
  await concurrency.fill('5')
  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 20_000 })
  await expect(
    sectionBadge(page, 'GC', 'neutral'),
    '带着未保存草稿切走后连「未保存」标记都没有 ⇒ 用户会忘记那边还有没提交的改动',
  ).toBeVisible()
  await expect(
    sectionBadge(page, 'GC', 'attention'),
    '没人动服务端却报「服务端已变更」⇒ 狼来了，真出现并发改动时用户不会再理它',
  ).toHaveCount(0)

  // 同事在另一台机器上把同一项改成 17。
  await seedConfig({ webhookDeliveryBodyRetentionDays: 17 })

  // 页面下一次拿到服务端权威配置（这里是本分区的又一次正常保存）时，必须发现冲突。
  await concurrency.fill('6')
  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 20_000 })
  await expect(
    sectionBadge(page, 'GC', 'attention'),
    '同事改了同一项却没有在导航上提示 ⇒ 我在别的分区忙活，回头一保存就把他的值冲掉',
  ).toBeVisible({ timeout: 20_000 })

  await clickSectionNav(page, 'GC')
  await expect(
    noticeBanner(page, 'Server settings changed'),
    '进入分区也不说服务端变了 ⇒ 用户在一个已经过期的基线上继续编辑',
  ).toBeVisible({ timeout: 20_000 })

  // ① 我的草稿必须原封不动——「发现冲突」不等于「替我做主」。
  await expect(
    page.getByTestId('settings-webhook-body-retention'),
    '冲突提示顺手把我的草稿覆盖了 ⇒ 我还没决定，输入就先没了',
  ).toHaveValue('11')
  await expect(
    saveButton(page),
    '出现冲突就把保存按死 ⇒ 我连「坚持我的值」这条路都没有了',
  ).toBeEnabled()

  // ② 「用服务端的值」必须落到**服务端当前的值（17）**，而不是我进页面时的旧基线
  //    （30）。落回旧基线会一边清掉警告、一边把一个早已不存在的值端到我面前。
  await page.getByRole('button', { name: 'Use server values', exact: true }).click()
  await expect(
    page.getByTestId('settings-webhook-body-retention'),
    '「用服务端的值」给的是我进页面时的旧基线 ⇒ 警告消失了，屏幕上却是一个服务端根本没有的值',
  ).toHaveValue('17', { timeout: 20_000 })
  await expect(
    noticeBanner(page, 'Server settings changed'),
    '采用服务端值之后警告还挂着 ⇒ 用户不知道冲突到底解决没有',
  ).toHaveCount(0)
  await expect(
    saveButton(page),
    '放弃本地草稿后仍显示「有改动可保存」⇒ 用户会再点一次，把刚采用的值又写一遍',
  ).toBeDisabled()

  // ③ 放弃本地是纯本地动作：不许顺手写服务端。
  expect(
    (await readConfig())['webhookDeliveryBodyRetentionDays'],
    '「用服务端的值」竟然发起了一次写入 ⇒ 一个只想放弃草稿的动作改了服务端状态',
  ).toBe(17)
})

// --------------------------------------------------------------------------
// CFG-09 P3 —— 离开有未保存改动的设置分区时的拦截
// --------------------------------------------------------------------------

test('RFC-319 CFG-09：带着未保存改动离开设置页会被拦下；没有改动时不拦，同页换分区也不拦 @nightly', async ({
  page,
}) => {
  await seedConfig({ webhookDeliveryBodyRetentionDays: 30 })

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const body = page.getByTestId('settings-webhook-body-retention')
  await expect(body).toBeVisible({ timeout: 30_000 })

  const homeLink = page.getByTestId('shell-navigation-desktop').locator('a.nav-item--home')
  const guard = page.getByTestId('unsaved-guard-dialog')

  // ① 负向对照：什么都没改时点走就直接走。不成立 ⇒ 每次路过设置页都要多点一次
  //    「放弃」，久而久之用户会条件反射地点掉它——真有改动时也照点不误。
  await homeLink.click()
  await expect(
    guard,
    '没有任何改动却弹出拦截框 ⇒ 用户被训练成闭眼点「放弃」，真有改动那天就丢了',
  ).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe('/')

  // 造一个真的未保存改动。
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  await expect(page.getByTestId('settings-webhook-body-retention')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-webhook-body-retention').fill('13')

  // ② 同一资源内换分区**不该**被拦——草稿由分区之上的 owner 持有，切走不会丢。
  //    误拦的后果：用户想去隔壁分区看一眼参照值，都要先放弃自己的草稿。
  await clickSectionNav(page, 'Limits')
  await expect(guard, '同页换分区也弹拦截框 ⇒ 想去隔壁看一眼参照值都要先放弃草稿').toHaveCount(0)
  await expect(page).toHaveURL(/\/settings\?.*tab=limits/)
  await clickSectionNav(page, 'GC')
  await expect(
    page.getByTestId('settings-webhook-body-retention'),
    '换分区回来草稿没了 ⇒ 「不拦」的前提（草稿活着）不成立，那才是真丢数据',
  ).toHaveValue('13')

  // ③ 离开整个设置页必须拦下来，并且「留下」真的留下、草稿完好。
  await homeLink.click()
  await expect(
    guard,
    '带着未保存改动点走却毫无阻拦 ⇒ 刚填的运行参数无声消失，用户以为已经改好了',
  ).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('unsaved-stay').click()
  await expect(guard).toHaveCount(0)
  expect(new URL(page.url()).pathname, '点了「留在本页」还是被带走了 ⇒ 拦截框只是个摆设').toBe(
    '/settings',
  )
  await expect(
    page.getByTestId('settings-webhook-body-retention'),
    '留下来之后草稿被清空了 ⇒ 「留下」反而比「离开」损失更大',
  ).toHaveValue('13')

  // ④ 明确选择「放弃改动」才离开——而且放弃就是放弃，不许顺手替用户保存。
  await homeLink.click()
  await expect(guard).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('unsaved-discard').click()
  await expect
    .poll(() => new URL(page.url()).pathname, {
      timeout: 20_000,
      message: '选了「放弃改动」却仍被挡在设置页 ⇒ 用户被困在一个走不掉的页面上',
    })
    .toBe('/')
  expect(
    (await readConfig())['webhookDeliveryBodyRetentionDays'],
    '「放弃改动」把改动写进去了 ⇒ 用户明确说不要的值反而生效了',
  ).toBe(30)
})

// --------------------------------------------------------------------------
// CFG-35 P2 —— 外观分区：主题切换（system / light / dark）保存并应用
// --------------------------------------------------------------------------

test('RFC-319 CFG-35：主题保存后当场换肤、刷新仍在，选「跟随系统」则真的跟随系统 @nightly', async ({
  page,
}) => {
  await seedConfig({ theme: 'light' })
  await page.emulateMedia({ colorScheme: 'light' })

  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=appearance`)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'light', { timeout: 30_000 })
  const lightBackground = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  )

  // ① 保存 dark 后**不刷新**就要换肤。不成立 ⇒ 用户点了保存、屏幕纹丝不动，只能
  //    靠刷新才知道到底改没改成。
  await page.getByRole('combobox', { name: 'Theme' }).click()
  await page.getByRole('option', { name: 'Dark', exact: true }).click()
  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 20_000 })
  await expect(
    html,
    '保存了主题却没有当场应用 ⇒ 用户以为没生效，会反复点保存或去刷新页面',
  ).toHaveAttribute('data-theme', 'dark', { timeout: 20_000 })
  const darkBackground = await page.evaluate(
    () => window.getComputedStyle(document.body).backgroundColor,
  )
  expect(
    darkBackground,
    '属性换了但页面配色没变 ⇒ 换肤只是写了个属性，用户看到的还是原来的界面',
  ).not.toBe(lightBackground)
  expect((await readConfig())['theme']).toBe('dark')

  // ② 刷新后仍是 dark——主题存的是守护进程配置，不是这一次会话的临时状态。
  await page.reload()
  await expect(html, '刷新后主题打回原形 ⇒ 用户每次打开都要重新选一遍').toHaveAttribute(
    'data-theme',
    'dark',
    { timeout: 30_000 },
  )

  // ③ 「跟随系统」要真的跟随系统：移除固定属性，改由系统偏好决定。
  //    不成立 ⇒ 这一项就是个假选项，用户选了它却被永久钉在某一种配色上。
  await page.getByRole('combobox', { name: 'Theme' }).click()
  await page.getByRole('option', { name: 'Follow system', exact: true }).click()
  await saveButton(page).click()
  await expect(receipt(page)).toBeVisible({ timeout: 20_000 })
  await expect(
    html,
    '选了「跟随系统」却仍把主题钉死在 html 上 ⇒ 系统切换深浅色时界面纹丝不动',
  ).not.toHaveAttribute('data-theme', /.*/, { timeout: 20_000 })

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(() => page.evaluate(() => window.getComputedStyle(document.body).backgroundColor), {
      timeout: 10_000,
      message: '系统切到深色，跟随系统的界面却还是浅色 ⇒ 「跟随系统」名不副实',
    })
    .toBe(darkBackground)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect
    .poll(() => page.evaluate(() => window.getComputedStyle(document.body).backgroundColor), {
      timeout: 10_000,
      message: '系统切回浅色界面却留在深色 ⇒ 跟随是单向的，等于没跟随',
    })
    .toBe(lightBackground)
  expect((await readConfig())['theme']).toBe('system')
})

// --------------------------------------------------------------------------
// CFG-36 P2 —— 外观分区：语言切换保存并落地
// --------------------------------------------------------------------------

test('RFC-319 CFG-36：语言保存后整页当场切换，刷新仍在，且守护进程的值压过浏览器本地猜测 @nightly', async ({
  page,
}) => {
  await seedConfig({ language: 'en-US' })

  // 注意：primeToken 每次导航都会把 localStorage 的 aw-language 强写回 en-US。
  // 这正是这条用例的价值所在——刷新后仍是中文，只可能来自守护进程的配置。
  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=appearance`)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible({
    timeout: 30_000,
  })

  await page.getByTestId('settings-language-select').click()
  await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await saveButton(page).click()

  // ① 保存成功就要当场换语言（文案明确承诺「applies instantly — no page refresh
  //    required」）。不成立 ⇒ 用户点完保存看到的还是英文，只能猜是不是没存上。
  await expect(
    page.getByRole('heading', { level: 1, name: '设置' }),
    '语言保存后整页没有切换 ⇒ 界面文案自称「立即生效」，实际要刷新，用户会重复保存',
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    saveButton(page, '保存'),
    '只有标题换了、其余控件还是英文 ⇒ 半中半英，比不换更糟',
  ).toBeVisible()
  expect(
    (await readConfig())['language'],
    '界面换了语言但服务端没存 ⇒ 刷新即打回，用户每次进来都要再选一遍',
  ).toBe('zh-CN')

  // ② 刷新后仍是中文——而且此刻浏览器本地的 aw-language 已被重置成 en-US，
  //    所以中文只能来自守护进程配置。管理员改的是全局值，不是本机偏好。
  await page.reload()
  await expect(
    page.getByRole('heading', { level: 1, name: '设置' }),
    '刷新后回到英文 ⇒ 管理员设的全局语言被浏览器本地猜测压过，等于没设',
  ).toBeVisible({ timeout: 30_000 })

  // ③ 换得回来（同时把这份共享的守护进程恢复成英文，避免污染后续用例）。
  await page.getByTestId('settings-language-select').click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await saveButton(page, '保存').click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Settings' }),
    '切回英文失败 ⇒ 语言切换是一条单行道，选错了就换不回来',
  ).toBeVisible({ timeout: 20_000 })
  expect((await readConfig())['language']).toBe('en-US')
})
