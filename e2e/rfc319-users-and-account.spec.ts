// RFC-319 —— 账号自服务面（概览 / 安全 / 令牌）、/users 目录与它的权限门、用户选择器、
// 在线状态，以及**凭据被撤之后系统怎么自愈**。九条能力（IAM-14/16/28/29/41/42/44/X3/X5）。
//
// 这一族的共同点是：**坏掉的时候没有任何报错**。会话吊销不生效 ⇒ 丢了的笔记本仍然能读你的
// 全部任务；PAT 明文留在 DOM 里 ⇒ 一次截图 / 一次 DOM dump 就把长期凭据泄出去；`/users` 的
// 写入口只是"藏起来" ⇒ 只读账号照样能改别人的角色；在线点在无权限账号上"顺手"渲染 ⇒ 谁在
// 上班这件事对全员公开；WS 不在服务端主动关 ⇒ 已被吊销的连接继续推 agent 的完整 stdout。
// 所以每条判据都写成「它不成立时用户会遭遇什么」，而不是「接口回了 200」。
//
// 刻意不在本文件内的：OIDC 那一族（IAM-02/07/09/10/11/15）需要一个真的 OIDC provider。
// 受牵连的是 IAM-X5 的「SSO 托管」那一半——绑定身份只能由 OIDC 回调写入
// （`packages/backend/src/routes/auth.ts:508-520` 的 DELETE 永久拒绝，没有任何写入口），
// 所以本文件只覆盖
// 「本地账号」那一半，并把 `identity-unlink-disabled` 这条永久拒绝顺手锁住。
//
// 与既有用例的分工（避免重复，也避免误以为已覆盖）：
//   * `e2e/session-invalidation.spec.ts` 覆盖「账号被停用 ⇒ 清凭据回登录页」与
//     「4403 不许把人踢去登录」。本文件的 IAM-44 走的是**另一个触发器**（在另一台设备上
//     吊销这一条会话），而且用 `page.routeWebSocket` 把 WS 通道整个假掉——否则 4401 关闭码
//     会抢先自愈，`packages/frontend/src/api/client.ts:223-226` 的 HTTP-401 分支一行都不会跑，
//     那是一条空洞的绿。
//   * `e2e/rfc250-visual-states.spec.ts:571` 是全仓唯一点过 `token-create-confirm` 的用例，
//     但整个 describe 被 `test.skip(!RUN_VISUAL_REGRESSION)` 罩着（同文件 :529-530），
//     `RUN_VISUAL_REGRESSION=1` 只出现在 `package.json:32` 与 visual nightly —— 功能车道里
//     等于不存在。IAM-16 把这条链搬进功能车道，并补上它没有的那一半：**关掉弹窗之后**。
//   * `e2e/collab-multi-user.spec.ts:367` 用过任务成员面板的 UserPicker（搜索 + 点中），
//     但没有验证过**排除**与**字段裁剪**。IAM-41 补的正是这两件。
//   * `e2e/rfc099-ownership-acl.spec.ts:219-221` 同理：真搜索、真点中，零裁剪断言。

import { expect, test, type Browser, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const PASSWORD = 'Rfc319UsersPass!1'

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

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

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

type SeedRole = 'admin' | 'manager' | 'user' | 'guest'

interface SeededAccount {
  id: string
  username: string
  displayName: string
  accessRevision: number
}

/**
 * 建号一律走 `POST /api/users`（产品自己的入口），不直接写库。
 * `withPassword: false` ⇒ 服务端把状态定为 `invited`
 * （`packages/backend/src/routes/users.ts:219`），
 * 这正是 /users 目录里「等待首次登录」那一档的唯一真实来源。
 */
async function createAccount(opts: {
  slug: string
  role?: SeedRole
  additionalPermissions?: readonly string[]
  withPassword?: boolean
  displayName?: string
}): Promise<SeededAccount> {
  const username = opts.slug
  const displayName = opts.displayName ?? username
  const created = await jsonOf<{ id: string; accessRevision: number }>(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName,
        email: `${username}@example.com`,
        role: opts.role ?? 'user',
        additionalPermissions: [...(opts.additionalPermissions ?? [])],
        ...(opts.withPassword === false ? {} : { password: PASSWORD }),
      }),
    }),
    `seed user ${username}`,
  )
  return { id: created.id, username, displayName, accessRevision: created.accessRevision }
}

/**
 * `userAgent` 直接决定「活跃会话」列表里那一行的标题
 * （packages/frontend/src/components/account/AccountSecurityPanel.tsx:166）。
 */
async function login(username: string, userAgent?: string): Promise<string> {
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userAgent === undefined ? {} : { 'User-Agent': userAgent }),
      },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

async function createAccountAndLogin(opts: {
  slug: string
  role?: SeedRole
  additionalPermissions?: readonly string[]
  displayName?: string
  userAgent?: string
}): Promise<SeededAccount & { token: string }> {
  const account = await createAccount(opts)
  return { ...account, token: await login(account.username, opts.userAgent) }
}

async function primeToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: token },
  )
}

/** 独立 context = 独立 localStorage，多账号同屏时必须这么开。 */
async function pageAs(browser: Browser, token: string): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: token },
  )
  return context.newPage()
}

/** 管理员改某个账号的附加授权（OCC：必须带上当下的 accessRevision）。 */
async function setAdditionalPermissions(
  userId: string,
  role: SeedRole,
  permissions: readonly string[],
): Promise<void> {
  const current = await jsonOf<{ accessRevision: number }>(
    await req(`/api/users/${userId}`),
    'read access revision',
  )
  await jsonOf(
    await req(`/api/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        access: {
          role,
          additionalPermissions: [...permissions],
          expectedRevision: current.accessRevision,
        },
      }),
    }),
    'update additional permissions',
  )
}

// ---------------------------------------------------------------------------
// IAM-X5 —— 我的账号 → 概览
// ---------------------------------------------------------------------------

test('RFC-319 IAM-X5: 概览面板一屏说清「我是谁、什么档、什么状态、账号归谁管」，本地账号不冒充 SSO 托管 @nightly', async ({
  page,
}) => {
  // 角色刻意用 manager 而不是 user：`USER_ROLE_PRESENTATION`
  // （packages/frontend/src/lib/account-user-presentation.ts:10-17）
  // 把四个角色映射到四段文案，
  // 用最常见的那一档做断言，写死成 'user' 的实现也能蒙混过关。
  const me = await createAccountAndLogin({
    slug: `rfc319-overview-${++sequence}`,
    role: 'manager',
    displayName: 'RFC-319 Overview Person',
  })
  await primeToken(page, me.token)
  await page.goto(`${daemon.baseUrl}/account`)

  const panel = page.locator(
    'section.account-section-panel[aria-labelledby="account-section-title-overview"]',
  )
  await expect(panel, '/account 默认落在概览分区').toBeVisible({ timeout: 30_000 })

  // 身份：显示名 + @用户名。两者都要在——只有显示名时，两个同名同事在系统里不可区分。
  await expect(panel.locator('.account-profile-summary__identity')).toContainText(
    'RFC-319 Overview Person',
  )
  await expect(panel.locator('.account-profile-summary__identity')).toContainText(`@${me.username}`)

  // chip 行必须**恰好**是这三枚，且逐字正确。多一枚少一枚都算错：
  //  · 角色 chip 错 ⇒ 用户以为自己没有 / 有某档权限，据此做出错误的操作决定；
  //  · 状态 chip 错 ⇒ 被停用的人以为自己还正常，把「什么都点不动」归咎于系统故障；
  //  · 「本地账号 / OIDC 托管」错 ⇒ 用户跑去身份提供方那边改密码，而这里根本不受它管
  //    （改密卡片同一判据分叉，
  //    packages/frontend/src/components/account/AccountSecurityPanel.tsx:34-43）。
  await expect(panel.locator('.account-profile-summary__chips > *')).toHaveText([
    'resource admin',
    'Active',
    'Local account',
  ])
  await expect(
    panel.getByText('OIDC managed'),
    '本地账号被标成 OIDC 托管 ⇒ 用户会去一个根本不存在的身份提供方那里找自己的密码',
  ).toHaveCount(0)

  // 「Authenticated via」如实说出这次是怎么进来的（会话 / 令牌 / 安装令牌）。
  const meta = panel.locator('.account-profile-summary__meta')
  await expect(meta).toContainText('Authenticated via')
  await expect(meta).toContainText('Web session')

  // 已绑定身份：本地账号是**空态**而不是一个空列表。空列表看不出「是没绑还是没加载出来」。
  await expect(panel.getByText('This is a local account')).toBeVisible()
  await expect(panel.locator('.account-identity-list')).toHaveCount(0)

  // 空态背后的数据源确实是空的（不是列表渲染坏了才看着像本地账号）。
  const identities = await jsonOf<unknown[]>(
    await req('/api/auth/identities', undefined, me.token),
    'list own identities',
  )
  expect(identities, '本地账号的已绑定身份列表必须是空的').toEqual([])

  // 解绑是**永久拒绝**的（packages/backend/src/routes/auth.ts:508-520）。
  // 这条要是哪天变成 204，
  // 用户就能把自己从企业身份体系里摘出去，而这个平台并不是那件事的权威。
  const unlink = await req('/api/auth/identities/01JZZZZZZZZZZZZZZZZZZZZZZZ', {
    method: 'DELETE',
  })
  expect(unlink.status, '解绑身份必须一律拒绝').toBe(403)
  expect(((await unlink.json()) as { code?: string }).code).toBe('identity-unlink-disabled')
})

// ---------------------------------------------------------------------------
// IAM-14 —— 我的账号 → 安全：会话列表与逐条吊销
// ---------------------------------------------------------------------------

test('RFC-319 IAM-14: 安全页列出全部活跃会话，吊销一条只杀掉被点的那一条，当前这条毫发无伤 @nightly', async ({
  page,
}) => {
  // 「我在别的设备上还登着」是这个面板存在的唯一理由。两条会话用不同 User-Agent 区分，
  // 因为列表行的标题就是它
  // （packages/frontend/src/components/account/AccountSecurityPanel.tsx:166）。
  const account = await createAccount({ slug: `rfc319-sessions-${++sequence}` })
  const browserToken = await login(account.username, 'RFC-319 this browser')
  const otherDeviceToken = await login(account.username, 'RFC-319 lost laptop')

  await primeToken(page, browserToken)
  await page.goto(`${daemon.baseUrl}/account?section=security`)

  const panel = page.locator(
    'section.account-section-panel[aria-labelledby="account-section-title-security"]',
  )
  await expect(panel).toBeVisible({ timeout: 30_000 })

  const rows = panel.locator('.account-session-list__item')
  await expect(
    rows,
    '在另一台设备上登录过，这里却只有一条 ⇒ 用户根本看不到那台丢失的机器还连着',
  ).toHaveCount(2)
  const lostRow = rows.filter({ hasText: 'RFC-319 lost laptop' })
  await expect(lostRow, '会话行必须能被认出来是哪台机器，否则用户不敢点任何一条').toHaveCount(1)

  // 吊销那条陌生会话。二次确认走的是共享 ConfirmDialog。
  await lostRow.getByRole('button', { name: 'Revoke' }).click()
  const confirm = page.getByRole('dialog', { name: 'Revoke this session?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Revoke' }).click()

  // ① 列表当场少一条，而且少掉的正是那条。
  await expect(rows).toHaveCount(1)
  await expect(
    panel.getByText('RFC-319 lost laptop'),
    '按钮点完列表没变 ⇒ 用户不知道自己到底吊销成功了没有，只能反复点',
  ).toHaveCount(0)

  // ② 被吊销的那条凭据**真的死了**。只从列表里消失而凭据还活着，是这条能力最坏的失败形态：
  //    用户以为自己已经把丢失的笔记本踢下线了，实际上对方还在读他的全部任务。
  await expect
    .poll(
      async () =>
        (
          await fetch(`${daemon.baseUrl}/api/auth/me`, {
            headers: { Authorization: `Bearer ${otherDeviceToken}` },
          })
        ).status,
      {
        timeout: 15_000,
        message: '被吊销的会话仍然能读 /api/auth/me ⇒ 「踢下线」只是界面上的错觉',
      },
    )
    .toBe(401)

  // ③ 当前这条没有被牵连——把自己也踢下线的话，用户每吊销一台设备就要重登一次。
  expect(
    (
      await fetch(`${daemon.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${browserToken}` },
      })
    ).status,
    '吊销别的会话把自己也踢了 ⇒ 用户不敢再用这个功能',
  ).toBe(200)
  expect(new URL(page.url()).pathname, '页面被踢去了登录页').toBe('/account')
  expect(await page.evaluate(() => window.localStorage.getItem('agent-workflow.token'))).toBe(
    browserToken,
  )

  // ④ 不存在的会话 id 与别人的会话 id 必须同答 403，而不是 404。
  //    404/403 一旦分叉，任何登录用户都能拿这个端点当「这个 session id 存在吗」的探针
  //    （packages/backend/src/routes/auth.ts:363-372 的注释记着这个决定）。
  const strangerSession = await login(
    (await createAccount({ slug: `rfc319-sessions-other-${++sequence}` })).username,
  )
  const strangerSessions = await jsonOf<Array<{ id: string }>>(
    await req('/api/auth/sessions', undefined, strangerSession),
    'stranger lists own sessions',
  )
  const strangerSessionId = strangerSessions[0]?.id
  expect(strangerSessionId, '前提：陌生人得先有一条自己的会话').toBeDefined()
  const revokeUnknown = await req(
    '/api/auth/sessions/01JZZZZZZZZZZZZZZZZZZZZZZZ/revoke',
    { method: 'POST' },
    browserToken,
  )
  const revokeStranger = await req(
    `/api/auth/sessions/${strangerSessionId}/revoke`,
    { method: 'POST' },
    browserToken,
  )
  expect(
    [revokeUnknown.status, revokeStranger.status],
    '「不存在」与「不是你的」答得不一样 ⇒ 这个端点变成了会话 id 的存在性探针',
  ).toEqual([403, 403])
  expect(
    (
      await fetch(`${daemon.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${strangerSession}` },
      })
    ).status,
    '越权吊销被拒了，别人的会话却还是死了 ⇒ 拒绝只是回执上的',
  ).toBe(200)
})

// ---------------------------------------------------------------------------
// IAM-16 —— 我的账号 → 令牌：界面签发 PAT，明文只出现一次
// ---------------------------------------------------------------------------

test('RFC-319 IAM-16: 在界面上签发 PAT —— 明文当场可用，点完「完成」之后 DOM 与浏览器存储里都不再有它 @nightly', async ({
  page,
}) => {
  const owner = await createAccountAndLogin({ slug: `rfc319-pat-${++sequence}` })
  await primeToken(page, owner.token)
  await page.goto(`${daemon.baseUrl}/account?section=tokens`)

  const panel = page.locator(
    'section.account-section-panel[aria-labelledby="account-section-title-tokens"]',
  )
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(
    panel.locator('.account-token-list__item'),
    '前提：这个账号还没有任何令牌',
  ).toHaveCount(0)

  await panel.getByTestId('token-create-open').click()
  const dialog = page.getByTestId('token-create-dialog')
  await expect(dialog).toBeVisible()

  const tokenName = `rfc319-ci-${sequence}`
  await page.getByTestId('token-create-name').fill(tokenName)
  // 默认用途是 `mcp_only`（只能打 /api/mcp）。签一条能打 REST 的，才谈得上下面
  // 「这条明文真的能用」的验证。
  await page.getByTestId('token-purpose-general').click()
  // read-only 模板 = 空矩阵：读面永远开着，写面一个都不给
  // （packages/frontend/src/lib/token-matrix.ts:91-94）。
  await expect(
    page.getByTestId('token-template-read-only'),
    '空矩阵没有被识别成 read-only ⇒ 用户看到的模板与他即将签出的权限对不上',
  ).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('token-create-confirm').click()

  const created = page.getByTestId('token-created-dialog')
  await expect(created).toBeVisible()
  const secret = (await page.getByTestId('token-created-value').innerText()).trim()
  expect(secret, '揭示阶段没给出可用的明文 ⇒ 这次签发白做了，而令牌已经在服务端存在了').toMatch(
    /^aws_pat_[A-Za-z0-9]+$/,
  )

  // 明文当场就是能用的那一条——只显示一次的东西如果还是错的，用户没有第二次机会发现。
  const readWithSecret = await fetch(`${daemon.baseUrl}/api/agents`, {
    headers: { Authorization: `Bearer ${secret}` },
  })
  expect(readWithSecret.status, '刚签发的令牌读不了任何东西 ⇒ 明文是错的或者根本没生效').toBe(200)
  const writeWithSecret = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `rfc319-pat-should-not-exist-${sequence}`,
      description: 'must be refused',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  expect(
    writeWithSecret.status,
    '按 read-only 模板签出来的令牌却能创建代理 ⇒ 界面上的模板名与实际权限不是一回事',
  ).toBe(403)

  // 正向对照：**弹窗还开着的时候**，明文确实出现在 `page.content()` 里。
  // 没有这一条的话，下面那句「关掉之后 DOM 里没有明文」可能只是因为
  // `page.content()` 压根看不到弹窗（例如它被 portal 到了别的 frame），
  // 于是不管明文留没留，那条断言都恒绿——正是 RFC-319 审计点名的那类假覆盖。
  expect(
    (await page.content()).includes(secret),
    '前提：揭示阶段的明文必须能被 page.content() 看见，否则下面的"看不见"是空洞的',
  ).toBe(true)

  // 关掉揭示弹窗。先等库存刷新落定，否则点「完成」会与那次刷新抢时序。
  await expect(page.getByTestId('token-created-refreshing')).toBeHidden()
  await page.getByTestId('token-created-done').click()
  await expect(created).toHaveCount(0)

  // 列表里出现这条令牌（名字 + 用途），证明"关掉弹窗"不是把这次签发一起丢了。
  const row = panel.locator('.account-token-list__item').filter({ hasText: tokenName })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('REST API + MCP')
  await expect(row).toContainText('active')

  // 「只显示一次」的真正判据在这里：**关掉之后 DOM 里一个字节都不许留**。
  // 只断言"弹窗里有明文"是把这条能力反过来测了——留在页面上的长期凭据，一次截图、
  // 一次 devtools 复制、一次崩溃报告的 DOM dump 就外泄，而用户以为它已经收好了。
  expect(
    (await page.content()).includes(secret),
    '关掉揭示弹窗后明文仍留在 DOM 里 ⇒ 一次截图 / 一次 DOM dump 就把长期凭据泄出去',
  ).toBe(false)

  // 浏览器存储同理：签发流程会写一个"结果未知"的恢复标记，那个标记里绝不能含明文。
  const storageContains = async (needle: string): Promise<boolean> =>
    page.evaluate((probe) => {
      const scan = (store: Storage): boolean => {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i)
          if (key === null) continue
          if ((store.getItem(key) ?? '').includes(probe)) return true
        }
        return false
      }
      try {
        return scan(window.localStorage) || scan(window.sessionStorage)
      } catch {
        return false
      }
    }, needle)
  // 正向对照：这个扫描器**看得见**存储里真实存在的东西（会话令牌就在 localStorage 里）。
  // 否则一个永远返回 false 的扫描器也能让下一条断言绿。
  expect(
    await storageContains(owner.token),
    '前提：存储扫描器连 localStorage 里的会话令牌都找不到 ⇒ 它什么也没在查',
  ).toBe(true)
  expect(
    await storageContains(secret),
    '明文被落进了 localStorage / sessionStorage ⇒ 它不再是「只显示一次」，而是常驻磁盘',
  ).toBe(false)

  // 刷新之后也找不回来，而且服务端的读路径本来就没有明文可给。
  await page.reload()
  await expect(
    panel.locator('.account-token-list__item').filter({ hasText: tokenName }),
  ).toHaveCount(1)
  expect((await page.content()).includes(secret), '刷新之后明文又冒出来了').toBe(false)
  const meBody = await (await req('/api/auth/me', undefined, owner.token)).text()
  expect(
    meBody.includes(secret),
    '/api/auth/me 把令牌明文回读了出来 ⇒ 「只显示一次」在服务端就不成立',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// IAM-28 —— /users：搜索、状态 / 角色筛选、筛空态、URL 同步
// ---------------------------------------------------------------------------

test('RFC-319 IAM-28: /users 的搜索与状态/角色筛选真的在过滤，筛空有出路，筛选条件写进 URL 且深链与后退都还原得回来 @nightly', async ({
  page,
}) => {
  // 四个人各占一格：管理员 / 普通活跃 / 已停用 / 等待首次登录。
  const tag = `rfc319dir${++sequence}`
  const adminUser = await createAccount({ slug: `${tag}-adm`, role: 'admin' })
  const plainUser = await createAccount({ slug: `${tag}-usr`, role: 'user' })
  const disabledUser = await createAccount({ slug: `${tag}-off`, role: 'user' })
  const invitedUser = await createAccount({ slug: `${tag}-inv`, role: 'user', withPassword: false })
  await jsonOf(
    await req(`/api/users/${disabledUser.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    }),
    'disable one user',
  )

  await primeToken(page, daemon.token)
  await page.goto(`${daemon.baseUrl}/users`)

  const rows = page.locator('.user-directory__item')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  const totalBefore = await rows.count()
  expect(totalBefore, '前提：目录里至少有这四个人加上管理员自己').toBeGreaterThan(4)

  const search = page.getByTestId('users-search')
  const usernamesOf = async (): Promise<string[]> =>
    (await rows.locator('.user-directory__identity-meta code').allInnerTexts())
      .map((text) => text.trim())
      .sort()

  // ① 搜索：只剩匹配的四行，且**条件写进了 URL**。写不进 URL 的筛选是不可分享、
  //    刷新即丢的——用户把链接发给同事，对方看到的是没筛过的全量目录。
  await search.fill(tag)
  await expect(rows).toHaveCount(4)
  expect(await usernamesOf()).toEqual(
    [adminUser, plainUser, disabledUser, invitedUser].map((u) => `@${u.username}`).sort(),
  )
  await expect
    .poll(() => new URL(page.url()).searchParams.get('q'), {
      message: '搜索词没有进 URL ⇒ 刷新一下筛选就没了，链接也分享不出去',
    })
    .toBe(tag)
  await expect(
    page.getByText('@e2e_admin'),
    '搜索没有真的在过滤 —— 不匹配的账号（管理员自己）还留在列表里',
  ).toHaveCount(0)

  // ② 角色筛选：Select 的选项落在 portal 出来的 listbox 里。
  await page.getByTestId('users-role-filter').click()
  await page.getByRole('option', { name: 'admin', exact: true }).click()
  await expect
    .poll(() => new URL(page.url()).searchParams.get('role'), {
      message: '角色筛选没有进 URL',
    })
    .toBe('admin')
  await expect(rows).toHaveCount(1)
  expect(await usernamesOf()).toEqual([`@${adminUser.username}`])

  // ③ 后退键回到上一档筛选。角色 / 状态筛选是 push
  //    （packages/frontend/src/routes/users.tsx:346-347 传 replace=false），
  //    所以浏览器历史必须是可用的：筛错了一步却退不回去，用户只能从头再筛一遍。
  await page.goBack()
  await expect
    .poll(() => new URL(page.url()).searchParams.get('role'), {
      message: '后退没有回滚角色筛选 ⇒ 浏览器的后退键在这个页面上是坏的',
    })
    .toBeNull()
  await expect(rows).toHaveCount(4)
  await expect(search).toHaveValue(tag)

  // ④ 状态筛选：三档各自只留下该留的人。
  await page.getByTestId('users-status-filter-disabled').click()
  await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('disabled')
  await expect(rows).toHaveCount(1)
  expect(await usernamesOf()).toEqual([`@${disabledUser.username}`])
  await page.getByTestId('users-status-filter-invited').click()
  await expect(rows).toHaveCount(1)
  expect(
    await usernamesOf(),
    '「等待首次登录」筛出来的不是那个没有密码的账号 ⇒ 管理员分不清谁还没进过门',
  ).toEqual([`@${invitedUser.username}`])
  await page.getByTestId('users-status-filter-active').click()
  await expect(rows).toHaveCount(2)
  expect(await usernamesOf()).toEqual([`@${adminUser.username}`, `@${plainUser.username}`].sort())

  // ⑤ 筛空：必须是**带出路的空态**，不是一个什么都没有的白屏。
  //    白屏时用户无从判断「是没有人，还是我筛错了」。
  await page.getByTestId('users-status-filter-all').click()
  await search.fill(`${tag}-nobody`)
  await expect(page.getByTestId('users-filtered-empty')).toBeVisible()
  await expect(rows).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByTestId('users-filtered-empty')).toHaveCount(0)
  await expect(rows).toHaveCount(totalBefore)
  await expect(search).toHaveValue('')
  expect(
    new URL(page.url()).searchParams.get('q'),
    '「清除筛选」把界面清了却把 URL 留在筛选态 ⇒ 一刷新筛选又回来了',
  ).toBeNull()

  // ⑥ 反向同步：直接打开一条带筛选的深链，界面必须自己还原成那个筛选态。
  //    只写不读的话，同事收到的链接打开还是全量目录。
  await page.goto(`${daemon.baseUrl}/users?q=${tag}&status=disabled`)
  await expect(rows).toHaveCount(1)
  expect(await usernamesOf()).toEqual([`@${disabledUser.username}`])
  await expect(search, '深链没有把搜索词回填进输入框 ⇒ 用户看到的结果没有任何解释').toHaveValue(tag)
  await expect(page.getByTestId('users-status-filter-disabled')).toHaveAttribute(
    'aria-checked',
    'true',
  )
})

// ---------------------------------------------------------------------------
// IAM-29 —— /users 的两道门：没有 users:read / 有读没有写
// ---------------------------------------------------------------------------

test('RFC-319 IAM-29: 没有 users:read 的人得到一句说明而不是空目录；只有读权的人看得见目录却摸不到任何写入口，且服务端同样拒绝 @nightly', async ({
  browser,
}) => {
  const seed = ++sequence
  const outsider = await createAccountAndLogin({ slug: `rfc319-noread-${seed}`, role: 'user' })
  const reader = await createAccountAndLogin({
    slug: `rfc319-readonly-${seed}`,
    role: 'user',
    additionalPermissions: ['users:read'],
  })
  const victim = await createAccount({ slug: `rfc319-target-${seed}`, role: 'user' })

  // ── 第一道门：连读都没有 ──────────────────────────────────────────────
  const outsiderPage = await pageAs(browser, outsider.token)
  await outsiderPage.goto(`${daemon.baseUrl}/users`)
  const denial = outsiderPage.getByTestId('no-permission')
  await expect(
    denial,
    '无权限时给的是空列表而不是一句说明 ⇒ 用户以为系统里一个人都没有，转头去找运维报障',
  ).toBeVisible({ timeout: 30_000 })
  await expect(denial).toContainText('users:read')
  await expect(
    outsiderPage.locator('.user-directory__item'),
    '无权限却仍然渲染出了用户行 ⇒ 目录整个泄露',
  ).toHaveCount(0)
  await expect(outsiderPage.getByTestId('users-search')).toHaveCount(0)

  // 导航里也不该出现入口——留着一个必然失败的入口只会让人反复点。
  await outsiderPage.locator('.user-menu__trigger').click()
  await expect(outsiderPage.getByRole('menuitem', { name: 'My account' })).toBeVisible()
  await expect(
    outsiderPage.getByRole('menuitem', { name: 'Manage users' }),
    '看不了用户目录，菜单里却挂着「管理用户」⇒ 一个必然撞墙的入口',
  ).toHaveCount(0)

  // 界面藏起来只是第一层；服务端必须自己也拒绝。
  expect(
    (await req('/api/users', undefined, outsider.token)).status,
    '界面藏了目录，接口却照给 ⇒ 任何人打开 devtools 就能拿到全员名单',
  ).toBe(403)

  // ── 正向对照：有 users:write 的人**看得到**这些入口 ───────────────────
  // 没有这一段，下面那两条 `toHaveCount(0)` 就可能只是因为选择器写错了名字 /
  // 这个页面从来不长这个按钮——那样的话写入口即使泄露给只读账号也照样绿。
  const adminPage = await pageAs(browser, daemon.token)
  await adminPage.goto(`${daemon.baseUrl}/users`)
  await expect(adminPage.locator('.user-directory__item').first()).toBeVisible({ timeout: 30_000 })
  await expect(
    adminPage.getByRole('button', { name: 'New user' }),
    '前提：有写权的人必须看得到「新建用户」，否则下面的"看不到"证明不了任何事',
  ).toBeVisible()
  await expect(adminPage.getByTestId(`user-manage-${victim.id}`)).toBeVisible()

  // ── 第二道门：能读，不能写 ───────────────────────────────────────────
  const readerPage = await pageAs(browser, reader.token)
  await readerPage.goto(`${daemon.baseUrl}/users`)
  await expect(readerPage.locator('.user-directory__item').first()).toBeVisible({ timeout: 30_000 })
  await expect(readerPage.getByTestId('no-permission')).toHaveCount(0)
  await expect(
    readerPage.getByTestId('users-search'),
    '前提：只读账号得真的看到了目录本身（否则"没有写入口"只是因为页面是空的）',
  ).toBeVisible()
  await expect(
    readerPage.getByTestId(`user-manage-${victim.id}`),
    '只有读权的人看到了逐行的「管理」⇒ 点下去必然 403，而按钮本身在骗他',
  ).toHaveCount(0)
  await expect(
    readerPage.getByRole('button', { name: 'New user' }),
    '只有读权的人看到了「新建用户」⇒ 同上',
  ).toHaveCount(0)
  await expect(readerPage.locator('[data-testid^="user-manage-"]')).toHaveCount(0)
  await readerPage.locator('.user-menu__trigger').click()
  await expect(readerPage.getByRole('menuitem', { name: 'Manage users' })).toBeVisible()

  // 写面在服务端同样是关的。只靠隐藏按钮的话，一次手写请求就能改别人的角色。
  const forbiddenWrites = await Promise.all([
    req(
      '/api/users',
      {
        method: 'POST',
        body: JSON.stringify({
          username: `rfc319-should-not-exist-${seed}`,
          displayName: 'nope',
          role: 'admin',
          password: PASSWORD,
        }),
      },
      reader.token,
    ),
    req(
      `/api/users/${victim.id}`,
      { method: 'PATCH', body: JSON.stringify({ displayName: 'hijacked' }) },
      reader.token,
    ),
    req(`/api/users/${victim.id}`, { method: 'DELETE' }, reader.token),
  ])
  expect(
    forbiddenWrites.map((r) => r.status),
    '写入口只是被藏起来了 ⇒ 只读账号手写一个请求就能建管理员 / 改别人资料 / 停用别人',
  ).toEqual([403, 403, 403])
  const stillIntact = await jsonOf<{ displayName: string; status: string }>(
    await req(`/api/users/${victim.id}`),
    're-read the target user',
  )
  expect(stillIntact.displayName, '拒绝只是回执上的，改动其实落库了').toBe(victim.displayName)
  expect(stillIntact.status).toBe('active')
})

// ---------------------------------------------------------------------------
// IAM-41 —— 用户选择器：搜索、排除、公开字段裁剪
// ---------------------------------------------------------------------------

test('RFC-319 IAM-41: 用户选择器只拿得到公开字段，且 owner 与已授权的人不会再出现在候选里 @nightly', async ({
  page,
}) => {
  // 三个人共享同一前缀，于是一次搜索**三个都会被服务端返回**——这是本条用例的关键：
  // 候选里少掉的那两个必须是被前端排除的，而不是"服务端本来就没返回"。
  const tag = `rfc319pick${++sequence}`
  const owner = await createAccountAndLogin({ slug: `${tag}-owner` })
  const granted = await createAccount({ slug: `${tag}-granted` })
  const candidate = await createAccount({ slug: `${tag}-candidate` })

  const agent = await jsonOf<{ id: string }>(
    await req(
      '/api/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `${tag}-agent`,
          description: 'rfc319 user-picker fixture',
          outputs: ['answer'],
          readonly: true,
          bodyMd: '',
        }),
      },
      owner.token,
    ),
    'owner creates an agent',
  )
  const acl = await jsonOf<{ aclRevision: number }>(
    await req(`/api/agents/${agent.id}/acl`, undefined, owner.token),
    'read agent acl',
  )
  await jsonOf(
    await req(
      `/api/agents/${agent.id}/acl`,
      {
        method: 'PUT',
        body: JSON.stringify({
          grants: [{ userId: granted.id, level: 'read' }],
          expectedResourceId: agent.id,
          expectedAclRevision: acl.aclRevision,
        }),
      },
      owner.token,
    ),
    'grant read to one user',
  )

  await primeToken(page, owner.token)
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)
  await page.getByTestId('detail-more-actions').click()
  await page.getByTestId('detail-actions-dialog').getByTestId('acl-dialog-button').click()
  await expect(page.getByTestId('acl-panel')).toBeVisible()

  const input = page.getByTestId('acl-members-input')
  await input.click()
  const searched = page.waitForResponse(
    (response) =>
      response.url().includes('/api/users/search') &&
      response.url().includes(`q=${tag}`) &&
      response.status() === 200,
  )
  await input.fill(tag)
  const returned = (await (await searched).json()) as Array<Record<string, unknown>>

  // ① 服务端确实把三个人都返回了（否则下面的「排除」断言就是空洞的）。
  expect(
    returned.map((row) => row.username).sort(),
    '前提：这一次搜索必须把 owner / 已授权 / 候选三个人都返回，排除断言才有意义',
  ).toEqual([owner.username, granted.username, candidate.username].sort())

  // ② 公开字段裁剪：选择器是**全员**都能用的能力（users:search 在 user 预设里），
  //    它回什么就等于全员能看到什么。邮箱、附加权限一旦随手带出来，就是一次全员通讯录泄露。
  for (const row of returned) {
    expect(
      Object.keys(row).sort(),
      '用户选择器回了公开字段以外的东西 ⇒ 任何普通用户都能把全员通讯录 / 权限清单抓下来',
    ).toEqual(['displayName', 'id', 'role', 'status', 'username'])
  }

  // ③ 候选里只剩下真正可以加的那个人。
  await expect(page.getByTestId(`acl-members-option-${candidate.username}`)).toBeVisible()
  await expect(
    page.getByTestId(`acl-members-option-${owner.username}`),
    'owner 出现在「加成员」的候选里 ⇒ 把所有者降级成普通成员，权限模型当场自相矛盾',
  ).toHaveCount(0)
  await expect(
    page.getByTestId(`acl-members-option-${granted.username}`),
    '已经授过权的人还留在候选里 ⇒ 重复添加，管理员分不清谁已经加过了',
  ).toHaveCount(0)
  // 「已授权的人」确实在面板里（不是根本没加成功才没出现在候选里）。
  await expect(page.getByTestId('acl-panel')).toContainText(granted.username)

  // ④ 非法的 status 取值必须当场 422 报错，而不是被静默忽略成"全部"。
  //    静默忽略的话，调用方以为自己只在找活跃账号，实际拿到的包含已停用的人。
  const bogus = await req(`/api/users/search?q=${tag}&status=bogus`, undefined, owner.token)
  expect(bogus.status, '未知的 status 被静默忽略 ⇒ 调用方拿到的范围与他要的不是一回事').toBe(422)
  expect(((await bogus.json()) as { code?: string }).code).toBe('user-invalid')

  // ⑤ 没有 users:search 的账号（guest 预设）连这个端点都够不着。
  const guest = await createAccountAndLogin({ slug: `${tag}-guest`, role: 'guest' })
  expect(
    (await req(`/api/users/search?q=${tag}`, undefined, guest.token)).status,
    'guest 也能搜全员 ⇒ 「公开只读」这一档顺带把通讯录也公开了',
  ).toBe(403)
})

// ---------------------------------------------------------------------------
// IAM-42 —— 在线状态：有权限看得到点，无权限的界面逐字节不变
// ---------------------------------------------------------------------------

test('RFC-319 IAM-42: 有 users:presence 的人看得到在线点；权限被收回后同一屏逐字节回到没有点的样子，且不再建立 presence 连接 @nightly', async ({
  page,
}) => {
  const seed = ++sequence
  // 被观察的三个人**从不登录**：他们的行里只会渲染常量文案「Never signed in」，
  // 于是这一屏的 HTML 与时间无关，才能拿来做逐字节比较（相对时间会随秒数漂）。
  const watched = [
    await createAccount({ slug: `rfc319-pdot-${seed}a` }),
    await createAccount({ slug: `rfc319-pdot-${seed}b` }),
    await createAccount({ slug: `rfc319-pdot-${seed}c` }),
  ]
  const viewer = await createAccountAndLogin({
    slug: `rfc319-pwatch-${seed}`,
    role: 'user',
    // users:read 让他看得到目录；users:presence 是 user 档建号时的默认授予
    // （packages/backend/src/modules/identity-access/domain/initialGrants.ts:20-32），
    // 管理员可逐账号收回。
    additionalPermissions: ['users:read'],
  })

  await primeToken(page, viewer.token)
  // 用搜索前缀把这一屏收窄到那三个从不登录的人：viewer 自己的行（带「You」chip 与
  // 一个会漂的相对时间）被过滤掉，比较面因此是稳定的。
  await page.goto(`${daemon.baseUrl}/users?q=rfc319-pdot-${seed}`)

  const list = page.locator('ul.user-directory__list')
  await expect(list.locator('li')).toHaveCount(watched.length, { timeout: 30_000 })
  await expect(
    page.locator('.presence-dot'),
    '有 users:presence 却一个在线点都没有 ⇒ 这条能力对有权限的人也是坏的（下面的比较就会变成一条空洞的绿）',
  ).toHaveCount(watched.length)
  const withPresence = await list.evaluate((node) => node.outerHTML)

  // 管理员逐账号收回 users:presence。这是产品里唯一的收回姿势。
  await setAdditionalPermissions(viewer.id, 'user', ['users:read'])

  // 服务端会主动把 presence 连接以 4403 关掉，客户端据此清空 store —— 不需要刷新页面。
  await expect(page.locator('.presence-dot')).toHaveCount(0, { timeout: 30_000 })
  const withoutPresence = await list.evaluate((node) => node.outerHTML)

  // 「逐字节不变」的判据：把在线点那几个 span 从有权限的 HTML 里删掉之后，
  // 两份必须**完全相等**。比较面选的是同一账号、同一次访问、同一屏——唯一变量就是那个权限点，
  // 所以任何别的差异都只能来自 presence 这条链。
  //
  // 它挡的是最容易发生的那类实现：无权限时渲染一个空 span / 一个占位圆点 / 一段
  // 「未知」文案。那些都会让"谁在上班"这件事从一个受权限保护的信号，退化成"看得出这里
  // 本来该有点"的旁路——而 PresenceDot 的契约是 `online === undefined` 时**渲染 null**
  // （packages/frontend/src/components/PresenceDot.tsx:15-17）。
  const dotPattern = /<span[^>]*class="presence-dot[^"]*"[^>]*><\/span>/g
  const stripped = withPresence.replace(dotPattern, '')
  expect(
    (withPresence.match(dotPattern) ?? []).length,
    '在线点的 DOM 形状变了 ⇒ 下面这条比较不再是在比较「有点」与「没点」',
  ).toBe(watched.length)
  expect(withoutPresence.includes('presence-dot'), '权限已收回，界面上还留着在线点').toBe(false)
  expect(
    stripped,
    '收回 users:presence 之后界面并非「只少了那几个点」⇒ 无权限者仍能从界面差异反推谁在线',
  ).toBe(withoutPresence)

  // 再往前一步：无权限的账号**根本不该建立** presence 连接。
  // 建立了才被服务端拒，等于每 30 秒敲一次门；不建立才是这条设计说的话
  // （packages/frontend/src/hooks/usePresence.ts:97-119 的 `enabled: canSeePresence`）。
  const socketUrls: string[] = []
  page.on('websocket', (socket) => socketUrls.push(socket.url()))
  await page.reload()
  await expect(list.locator('li')).toHaveCount(watched.length, { timeout: 30_000 })
  await expect
    .poll(() => socketUrls.filter((url) => url.includes('/ws/authority')).length, {
      timeout: 30_000,
      message: '连 /ws/authority 都没建 ⇒ 这个 websocket 记录器什么也没观察到，下一条断言是空的',
    })
    .toBeGreaterThan(0)
  expect(
    socketUrls.filter((url) => url.includes('/ws/presence')),
    '没有 users:presence 却仍然去连 presence 通道 ⇒ 一个注定被拒的重连循环',
  ).toEqual([])
})

// ---------------------------------------------------------------------------
// IAM-X3 —— 凭据 / 权限被撤时，服务端主动关闭已建立的 WebSocket
// ---------------------------------------------------------------------------

interface RawSocketState {
  opened: boolean
  hello: string | null
  closed: { code: number; wasClean: boolean } | null
}

test('RFC-319 IAM-X3: 权限被撤只关掉那一条通道（4403），凭据被吊销则连服务端主动关掉（4401）—— 两次都是服务端关的，不是前端自己断开 @nightly', async ({
  page,
}) => {
  const seed = ++sequence
  const subject = await createAccountAndLogin({
    slug: `rfc319-wsclose-${seed}`,
    role: 'user',
    additionalPermissions: ['users:read'],
    userAgent: 'RFC-319 ws subject',
  })

  await primeToken(page, subject.token)
  await page.goto(`${daemon.baseUrl}/users`)
  await expect(page.locator('.user-directory__item').first()).toBeVisible({ timeout: 30_000 })

  // 这两条 socket 由用例**自己**建立并且**从不主动 close()**。这是本条用例的核心手法：
  // 前端框架的那套（useWebSocket 的重连 / 凭据轮换 / 清 token）碰不到它们，所以任何
  // 关闭事件都只能来自服务端。再看 `wasClean`——服务端发了正常的 close 帧才是 true；
  // 连接被网络掐断 / 进程没了会得到 code 1006 且 wasClean 为 false。于是
  // 「code 恰好是 4403/4401 且 wasClean」这一对判据，把「服务端主动关」与
  // 「前端自己断开 / 连接掉了」区分得干干净净。
  await page.evaluate(
    ({ base, token }) => {
      interface Recorded {
        opened: boolean
        hello: string | null
        closed: { code: number; wasClean: boolean } | null
      }
      const registry: Record<string, Recorded> = {}
      ;(window as unknown as { __rfc319Sockets: Record<string, Recorded> }).__rfc319Sockets =
        registry
      for (const [name, path] of [
        ['presence', '/ws/presence'],
        ['tasks', '/ws/tasks'],
      ] as const) {
        const state: Recorded = { opened: false, hello: null, closed: null }
        registry[name] = state
        const url = new URL(path, base)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('token', token)
        const socket = new WebSocket(url.toString())
        socket.addEventListener('open', () => {
          state.opened = true
        })
        socket.addEventListener('message', (event: MessageEvent) => {
          try {
            const frame = JSON.parse(String(event.data)) as { type?: string; channel?: string }
            if (frame.type === 'hello') state.hello = frame.channel ?? ''
          } catch {
            /* 非 JSON 帧忽略 */
          }
        })
        socket.addEventListener('close', (event: CloseEvent) => {
          state.closed = { code: event.code, wasClean: event.wasClean }
        })
      }
    },
    { base: daemon.baseUrl, token: subject.token },
  )

  const sockets = async (): Promise<Record<string, RawSocketState>> =>
    page.evaluate(
      () =>
        (window as unknown as { __rfc319Sockets: Record<string, RawSocketState> }).__rfc319Sockets,
    )

  // 前提：两条都真的**被服务端接受**了（hello 帧是服务端在升级门通过之后才发的，
  // packages/backend/src/ws/registry.ts:1128）。只看 onopen 不够——一条被立刻拒掉的连接
  // 也会先 open 再 close。
  await expect
    .poll(async () => Object.values(await sockets()).map((s) => s.hello), { timeout: 30_000 })
    .toEqual(['presence', 'tasks'])

  // ── ① 权限被撤：只该关那一条 ──────────────────────────────────────────
  await setAdditionalPermissions(subject.id, 'user', ['users:read'])
  await expect
    .poll(async () => (await sockets()).presence?.closed, {
      timeout: 30_000,
      message:
        '收回 users:presence 之后，已经连着的 presence 通道仍然开着 ⇒ 被撤权的人继续收着' +
        '全员在线名单，直到他自己关掉页面',
    })
    .toEqual({ code: 4403, wasClean: true })
  expect(
    (await sockets()).tasks?.closed,
    '撤一个权限点把这个人所有的连接都关了 ⇒ 他仍然有权使用的页面全部停止更新',
  ).toBeNull()

  // ── ② 凭据被吊销：全部都该关 ─────────────────────────────────────────
  const ownSessions = await jsonOf<Array<{ id: string; userAgent: string | null }>>(
    await req('/api/auth/sessions', undefined, subject.token),
    'subject lists own sessions',
  )
  const target = ownSessions.find((row) => row.userAgent === 'RFC-319 ws subject')
  expect(target, '前提：得先找到这条会话').toBeDefined()
  await req(`/api/auth/sessions/${target?.id}/revoke`, { method: 'POST' }, subject.token)

  await expect
    .poll(async () => (await sockets()).tasks?.closed, {
      timeout: 30_000,
      message:
        '凭据都已经吊销了，已经建立的连接却还开着 ⇒ 被吊销的会话继续接收任务频道的' +
        '全部推送（含 agent 的完整 stdout），而"吊销"在用户看来早就完成了',
    })
    .toEqual({ code: 4401, wasClean: true })
})

// ---------------------------------------------------------------------------
// IAM-44 —— 凭据死掉之后的自愈
// ---------------------------------------------------------------------------

test('RFC-319 IAM-44: 会话在别处被吊销后，下一次真实请求的 401 就把凭据清掉并送回登录页；令牌够不着账号面时留一个能自己脱身的兜底 @nightly', async ({
  page,
  browser,
}) => {
  const seed = ++sequence
  const person = await createAccount({ slug: `rfc319-selfheal-${seed}` })
  const browserToken = await login(person.username, 'RFC-319 stale browser')
  const otherDevice = await login(person.username, 'RFC-319 revoking device')

  // WS 整条假掉：不 connectToServer 就等于一条永不收到关闭帧的连接。
  // 不这么做的话，凭据一吊销服务端就会用 4401 关掉真连接，`useWebSocket` 的关闭分支
  // 抢先 clearToken（packages/frontend/src/hooks/useWebSocket.ts:231-234），而
  // `packages/frontend/src/api/client.ts:223-226` 的 HTTP-401
  // 分支一行都不会执行——用例照样绿，覆盖的却是另一条路径。IAM-X3 专门盯那条 WS 路径；
  // 这一条盯的是**没有 WS 时**系统还能不能自愈。
  await page.routeWebSocket(/\/ws\//, () => {})
  await primeToken(page, browserToken)
  await page.goto(`${daemon.baseUrl}/agents`)
  await expect(page.getByRole('heading', { name: /agents/i }).first()).toBeVisible({
    timeout: 30_000,
  })

  // 在另一台设备上把这条会话吊销掉（正是「我的账号 → 安全」那个面板做的事）。
  const sessions = await jsonOf<Array<{ id: string; userAgent: string | null }>>(
    await req('/api/auth/sessions', undefined, otherDevice),
    'list sessions from the other device',
  )
  const stale = sessions.find((row) => row.userAgent === 'RFC-319 stale browser')
  expect(stale, '前提：得先找到这台旧浏览器的会话').toBeDefined()
  const revoked = await req(
    `/api/auth/sessions/${stale?.id}/revoke`,
    { method: 'POST' },
    otherDevice,
  )
  expect(revoked.status, 'revoke the stale browser session').toBe(204)

  // 用户在旧浏览器里做一次再普通不过的事：打开另一个页面。
  await page.goto(`${daemon.baseUrl}/workflows`)
  await page.waitForURL(/\/auth/, { timeout: 30_000 })
  expect(
    await page.evaluate(() => window.localStorage.getItem('agent-workflow.token')),
    '凭据已经死了，前端却还留着它 ⇒ 每一次请求都 401，页面看着还在但永远不再更新',
  ).toBeNull()
  expect(
    new URL(page.url()).searchParams.get('redirect') ?? '',
    '被踢回登录页时丢掉了原本要去的地方 ⇒ 登录之后落在首页，用户得自己再找一遍',
  ).toContain('/workflows')

  // ── 孤儿兜底：token 有效，但它够不着账号面 ────────────────────────────
  // PAT 打 `/api/auth/me` 是 403（`tokenAccess: 'never'`，
  // packages/backend/src/routes/registry.ts:172-176），
  // 不是 401 —— 于是凭据不会被自动清掉，`useActor` 拿不到 actor。没有兜底的话，
  // 侧栏连个可点的东西都没有：用户被**锁在一个自己无法退出的会话里**，
  // 只能手动清 localStorage 才能脱身。
  const patOwner = await createAccountAndLogin({ slug: `rfc319-orphan-${seed}` })
  const pat = await jsonOf<{ token: string }>(
    await req(
      '/api/auth/pats',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `rfc319-orphan-${seed}`,
          scopes: [],
          purpose: 'general',
          expiresAt: null,
        }),
      },
      patOwner.token,
    ),
    'mint a PAT',
  )
  expect(
    (
      await fetch(`${daemon.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${pat.token}` },
      })
    ).status,
    '前提：令牌打账号面必须是 403（若变成 401，凭据会被自动清掉，兜底也就无从谈起）',
  ).toBe(403)

  const orphanPage = await pageAs(browser, pat.token)
  await orphanPage.goto(`${daemon.baseUrl}/agents`)
  const orphanTrigger = orphanPage.locator('.user-menu__trigger--orphan')
  await expect(
    orphanTrigger,
    '令牌够不着账号面时侧栏什么也不给 ⇒ 用户被锁在一个自己退不出去的会话里，' +
      '只能手动清 localStorage',
  ).toBeVisible({ timeout: 30_000 })
  await expect(orphanTrigger).toContainText('Token has no access')

  await orphanTrigger.click()
  await orphanPage.waitForURL(/\/auth/, { timeout: 30_000 })
  expect(
    await orphanPage.evaluate(() => window.localStorage.getItem('agent-workflow.token')),
    '点了兜底的「退出」却没有清掉凭据 ⇒ 一刷新又回到同一个死局',
  ).toBeNull()
})
