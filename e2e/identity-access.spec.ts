// RFC-319 —— 身份与访问的浏览器路径（IAM-01 / 03 / 05 / 06 / 26 / 43）。
//
// 这一组是**每个部署都会走一遍**的路径，而开工审计对账出它们在浏览器层全是空白：
//   * `/setup/admin` 是新部署的第一屏，在整个 `e2e/` 里连字符串都不出现（零自动化）。
//   * 登录的三类拒绝（错密码 / 停用账号 / 无本地密码）只有内存 DB 单测。
//   * 退出登录从未被点过一次：`.user-menu__trigger` 在 e2e 里只被点开看过文案与
//     可见性，`Sign out` 一次没被点击。而 logout 不只是清 token——它还
//     `queryClient.clear()`、清 sessionStorage 的向导草稿与 PAT 对账标记、清 IDB 里的
//     澄清/评审草稿（UserMenu.tsx:38-60，注释写明是 RFC-099 审计要求：共享浏览器上
//     不能把上一个账号的私有数据泄给下一个登录者）。这条链一处断掉都不会报错。
//
// 每条用例自带 daemon：bootstrap 那条必须从「还没有管理员」的状态起，而其余用例需要
// 一个已完成 bootstrap 的正常环境。共用一个 daemon 做不到这两者。

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(90_000)

async function primeToken(page: Page, baseUrl: string, token: string): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: baseUrl, tok: token },
  )
}

// ---------------------------------------------------------------------------
// IAM-01 + IAM-03 —— 首次安装：/setup/admin 交接
// ---------------------------------------------------------------------------

test('RFC-319 IAM-01/03: the first-admin handoff creates a real account and retires itself', async ({
  page,
}) => {
  // `bootstrap` 模式刻意**不**替我们完成交接，留下那个一次性 token。
  const daemon = await startDaemon({ authMode: 'bootstrap' })
  try {
    // 没有凭据时，任何受保护页面都被拦到 /auth——不是白屏、也不是直接放进去。
    await page.goto(`${daemon.baseUrl}/agents`)
    await expect(page).toHaveURL(/\/auth/)

    // 带着一次性 token 走交接页。
    await primeToken(page, daemon.baseUrl, daemon.bootstrapToken ?? '')
    await page.goto(`${daemon.baseUrl}/setup/admin`)
    const submit = page.getByRole('button', { name: 'Complete secure handoff' })
    await expect(submit).toBeVisible()

    await page.getByLabel(/^Username/).fill('rfc319-first-admin')
    await page.getByLabel(/^Display name/).fill('RFC-319 First Admin')
    await page.getByLabel(/^Password/).fill('Rfc319HandoffPass!1')
    await page.getByLabel(/^Confirm password/).fill('Rfc319HandoffPass!1')
    await submit.click()

    // 交接完成 ⇒ 落到登录页，并且明确告诉用户「拿刚建的账号登录」。
    await expect(page).toHaveURL(/\/auth\?setup=complete/)

    // 账号**真的建出来了**：用它登录拿得到会话。
    const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'rfc319-first-admin',
        password: 'Rfc319HandoffPass!1',
      }),
    })
    expect(login.status, `新建管理员登录失败：${await login.text()}`).toBe(200)

    // 交接是**一次性**的。判据不是 /api/auth/bootstrap/status——那个端点要求
    // daemon 源身份（auth.ts:137），而交接恰恰把那张一次性票退役了，所以交接之后
    // 它本就不再可调。真正该断言的是**那张票不能用了**：
    const retired = await fetch(`${daemon.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${daemon.bootstrapToken ?? ''}` },
    })
    expect(
      retired.status,
      '交接完成后一次性 setup token 仍然可用 ⇒ 拿到过安装链接的人可以一直用它',
    ).not.toBe(200)

    // 而那一页对没有凭据的人也不再是入口（交接后前端已 clearToken）。
    await page.goto(`${daemon.baseUrl}/setup/admin`)
    await expect(page, '已经有管理员了却还能停在交接页 ⇒ 任何人都能再造一个管理员').toHaveURL(
      /\/auth/,
    )
  } finally {
    await daemon.stop()
  }
})

// ---------------------------------------------------------------------------
// IAM-05 + IAM-06 —— 密码登录与三类拒绝
// ---------------------------------------------------------------------------

test('RFC-319 IAM-05/06: password sign-in lands on the requested page; three rejections are readable', async ({
  page,
}) => {
  const daemon = await startDaemon()
  try {
    const api = async (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${daemon.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      })

    const created = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'rfc319-signin',
        displayName: 'RFC-319 Sign-in',
        role: 'user',
        password: 'Rfc319SignInPass!1',
      }),
    })
    // 只读一次 body：先 text() 再 json() 会抛「Body is unusable」——
    // 断言消息里想带上响应体时，必须自己解析而不是再读一次。
    const createdBody = await created.text()
    expect(created.status, createdBody).toBe(201)
    const { id: userId } = JSON.parse(createdBody) as { id: string }

    // 正向：带 redirect 进登录页 → 登录后回到**原目标页**，而不是首页。
    await page.goto(`${daemon.baseUrl}/auth?redirect=%2Fmemory`)
    const form = page.getByTestId('auth-password-form')
    await expect(form).toBeVisible()
    await form.getByLabel(/^Username/).fill('rfc319-signin')
    await form.getByLabel(/^Password/).fill('Rfc319SignInPass!1')
    await form.getByRole('button', { name: 'Sign in' }).click()
    await expect(
      page,
      '登录成功后没有回到请求的目标页 ⇒ 深链接 + 登录这条组合会把用户丢在首页',
    ).toHaveURL(/\/memory/)

    // 拒绝一：错密码。
    const rejectionText = async (username: string, password: string): Promise<string> => {
      await page.goto(`${daemon.baseUrl}/auth`)
      const f = page.getByTestId('auth-password-form')
      await f.getByLabel(/^Username/).fill(username)
      await f.getByLabel(/^Password/).fill(password)
      await f.getByRole('button', { name: 'Sign in' }).click()
      const banner = page.locator('.error-box').first()
      await expect(banner).toBeVisible()
      return (await banner.innerText()).trim()
    }
    const wrongPassword = await rejectionText('rfc319-signin', 'not-the-password')
    expect(wrongPassword.length, '错密码没有任何可读提示').toBeGreaterThan(0)

    // 拒绝二：账号被停用。停用之后同一组正确凭据也必须被拒。
    const disabled = await api(`/api/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(disabled.status, `停用用户失败：${await disabled.text()}`).toBe(200)
    const disabledText = await rejectionText('rfc319-signin', 'Rfc319SignInPass!1')
    expect(disabledText.length).toBeGreaterThan(0)

    // 拒绝三：不存在的用户。与「错密码」**同形**——否则用户名的存在性会从
    // 登录页泄露出去（这是登录表单最常见的枚举漏洞）。
    const unknownUser = await rejectionText('rfc319-no-such-user', 'whatever-Pass!1')
    expect(unknownUser, '不存在的用户名与错密码给出不同的提示 ⇒ 登录页可以被用来枚举账号').toBe(
      wrongPassword,
    )
  } finally {
    await daemon.stop()
  }
})

// ---------------------------------------------------------------------------
// IAM-43 —— 退出登录：服务端吊销 + 客户端私有状态清空 + 回到 /auth
// ---------------------------------------------------------------------------

test('RFC-319 IAM-43: signing out revokes the session server-side and clears client-side private state', async ({
  page,
}) => {
  const daemon = await startDaemon()
  try {
    const login = await fetch(`${daemon.baseUrl}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'rfc319-signout',
        displayName: 'RFC-319 Sign-out',
        role: 'user',
        password: 'Rfc319SignOutPass!1',
      }),
    })
    expect(login.status, await login.text().catch(() => '')).toBe(201)
    const session = (await (
      await fetch(`${daemon.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'rfc319-signout',
          password: 'Rfc319SignOutPass!1',
        }),
      })
    ).json()) as { sessionToken: string }

    await primeToken(page, daemon.baseUrl, session.sessionToken)
    await page.goto(`${daemon.baseUrl}/memory`)
    await expect(page.locator('.user-menu__trigger').first()).toBeVisible()

    // 这个令牌现在是活的。
    const probe = async (): Promise<number> =>
      (
        await fetch(`${daemon.baseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${session.sessionToken}` },
        })
      ).status
    expect(await probe()).toBe(200)

    // 点 Sign out。全仓 e2e 此前一次都没点过它。
    await page.locator('.user-menu__trigger').first().click()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page, '退出后没有回到 /auth').toHaveURL(/\/auth/)

    // ① 服务端会话真的被吊销（不是只把 localStorage 清了）。
    await expect.poll(probe, { message: 'session token still works after sign-out' }).not.toBe(200)

    // ② 客户端凭据清空——共享浏览器上刷新一下不能又回到登录态。
    const leftover = await page.evaluate(() => window.localStorage.getItem('agent-workflow.token'))
    expect(leftover, '退出后 localStorage 里还留着令牌').toBeNull()
    await page.reload()
    await expect(page).toHaveURL(/\/auth/)
  } finally {
    await daemon.stop()
  }
})

// ---------------------------------------------------------------------------
// IAM-26 —— 停用用户后，他手里的会话必须立刻失效
// ---------------------------------------------------------------------------

test('RFC-319 IAM-26: disabling a user invalidates the session they already hold', async () => {
  const daemon: DaemonHandle = await startDaemon()
  try {
    const admin = async (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${daemon.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      })

    const created = await admin('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'rfc319-revoked',
        displayName: 'RFC-319 Revoked',
        role: 'user',
        password: 'Rfc319RevokedPass!1',
      }),
    })
    const createdBody = await created.text()
    expect(created.status, createdBody).toBe(201)
    const { id } = JSON.parse(createdBody) as { id: string }
    const { sessionToken } = (await (
      await fetch(`${daemon.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'rfc319-revoked',
          password: 'Rfc319RevokedPass!1',
        }),
      })
    ).json()) as { sessionToken: string }

    const asUser = async (): Promise<number> =>
      (
        await fetch(`${daemon.baseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        })
      ).status
    expect(await asUser()).toBe(200)

    const disabled = await admin(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(disabled.status, await disabled.text()).toBe(200)

    // **已经发出去的会话**必须立刻不能用。只挡新登录是不够的——被停用的人手里
    // 那张票如果还有效，停用这个动作在实际效果上要等到票过期才生效。
    await expect
      .poll(asUser, { message: 'disabled user can still use the session they already had' })
      .not.toBe(200)
  } finally {
    await daemon.stop()
  }
})
