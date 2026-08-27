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

    // The handoff used to disable this button for a short password while hiding
    // the minimum in an HTML attribute. Keep every rule visible, let a click
    // explain all missing fields, and report invalid values beside their inputs.
    await expect(
      page.getByText(
        'Use 1–64 lowercase letters or numbers; after the first character, - and _ are allowed.',
      ),
    ).toBeVisible()
    await expect(page.getByText('Use 1–128 characters.')).toBeVisible()
    await expect(
      page.getByText('Optional. Enter a valid email address with at most 254 characters.'),
    ).toBeVisible()
    await expect(page.getByText('Use 8–256 characters.')).toBeVisible()
    await expect(page.getByText('Enter the same password again.')).toBeVisible()
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page.getByText('This field is required.')).toHaveCount(4)
    await expect(page.getByLabel(/^Username/)).toBeFocused()

    await page.getByLabel(/^Username/).fill('Invalid Username')
    await page.getByLabel(/^Display name/).fill('RFC-319 First Admin')
    await page.getByLabel(/^Email/).fill('not-an-email')
    await page.getByLabel(/^Password/).fill('short')
    await page.getByLabel(/^Confirm password/).fill('different')
    await expect(page.getByLabel(/^Username/)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(/^Email/)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel(/^Password/)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByText('Passwords do not match.')).toBeVisible()
    await submit.click()
    await expect(page).toHaveURL(/\/setup\/admin/)

    await page.getByLabel(/^Username/).fill('rfc319-first-admin')
    await page.getByLabel(/^Email/).fill('admin@example.com')
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

// ---------------------------------------------------------------------------
// IAM-30 —— 用户访问变更的三条硬不变量
// ---------------------------------------------------------------------------
//
// 这三条是「谁能改谁的权限」的底线，坏了的后果都是**不可逆的**：改坏 `__system__`
// 会让平台自己的执行身份失效；能改自己的权限就等于任何管理员都能给自己提权；
// 最后一个管理员被停用后，没有人再能恢复任何东西。判据来自
// `modules/identity-access/domain/userAccessPolicy.ts:100-127` 的三个失败码。
//
// 此前只有内存 DB 单测。这里走编译后的 daemon，连中间件与错误码投影一起锁。
test('RFC-319 IAM-30: three hard invariants on user access changes are enforced end to end', async () => {
  const daemon = await startDaemon()
  try {
    const asDaemon = async (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${daemon.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      })

    const users = (await (await asDaemon('/api/users')).json()) as Array<{
      id: string
      username: string
      role: string
      status: string
    }>
    const system = users.find((u) => u.username === '__system__')
    expect(system, '找不到 __system__ 用户——这条用例的前提没了').toBeDefined()

    // ① __system__ 不可改。
    const touchSystem = await asDaemon(`/api/users/${system!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    })
    const systemBody = await touchSystem.text()
    expect(touchSystem.ok, `__system__ 竟然可以被改：${systemBody}`).toBe(false)
    expect(systemBody).toContain('system-user-immutable')

    // ② 不能改自己的权限。需要一个**人类**管理员会话——daemon 令牌的 actor 不是人，
    //    自我判定那一支走不到。
    const admin = await asDaemon('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'rfc319-selfguard',
        displayName: 'RFC-319 Self Guard',
        email: 'rfc319-selfguard@example.com',
        role: 'admin',
        password: 'Rfc319SelfGuard!1',
      }),
    })
    const adminBody = await admin.text()
    expect(admin.status, adminBody).toBe(201)
    const adminId = (JSON.parse(adminBody) as { id: string }).id
    const { sessionToken } = (await (
      await fetch(`${daemon.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'rfc319-selfguard',
          password: 'Rfc319SelfGuard!1',
        }),
      })
    ).json()) as { sessionToken: string }

    const selfDemote = await fetch(`${daemon.baseUrl}/api/users/${adminId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'user' }),
    })
    const selfBody = await selfDemote.text()
    expect(selfDemote.ok, `管理员改掉了自己的权限：${selfBody}`).toBe(false)
    expect(selfBody).toContain('self-access-change-forbidden')

    // ③ 自我停用保护。这一条是写这条用例时**实测撞出来**的：本来想构造
    //    `last-access-administrator-protection`，结果拿到的是 `self-disable-forbidden`
    //    ——harness 的 daemon 令牌映射的就是那个 bootstrap 管理员，所以停用它属于
    //    「停用自己」。那也是一条真护栏，此前同样没有任何端到端断言。
    const humanAdmins = users.filter(
      (u) => u.username !== '__system__' && u.role === 'admin' && u.status === 'active',
    )
    expect(humanAdmins.length, '前提变了：不止一个在岗人类管理员').toBe(1)
    const disableSelf = await asDaemon(`/api/users/${humanAdmins[0]!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })
    const lastBody = await disableSelf.text()
    expect(disableSelf.ok, `管理员停用了自己：${lastBody}`).toBe(false)
    expect(lastBody).toContain('self-disable-forbidden')

    // 第三条不变量 `last-access-administrator-protection` **从 HTTP 面不可达**，
    // 这是实测结论而不是懒得写：
    //   * 任何能 PATCH 用户的 actor 自己就是访问管理员，于是
    //     `countOtherActiveAccessAdministrators` 对目标而言 ≥ 1，保护不触发；
    //   * 唯一被排除在计数外的是 `__system__`，而以它的身份调 API 要走 bootstrap 档，
    //     那一档在交接完成前对所有业务端点回 `bootstrap-admin-required`（实测 403）。
    // 所以它是策略层（userAccessPolicy.ts:118-125）的纵深防御，由那一层的单测守着；
    // 用户面这一侧没有能到达它的路径。把这段写在这里，是为了让下一个想「补上第三条」
    // 的人不必再撞一遍。
  } finally {
    await daemon.stop()
  }
})

// ---------------------------------------------------------------------------
// IAM-21 + IAM-47 —— 令牌只能管自己，且永远够不到归属 / 授权写面
// ---------------------------------------------------------------------------
//
// IAM-47 的判据是 `tokenAccess: 'never'`：`resourceAcl.ts:163` 的注释写明
// 「a token must NEVER change owner / grants / visibility」，同规则还覆盖
// `PUT /api/tasks/:id/members` 等三处。这条不变量**只有源码注释在说**，
// 端到端没有任何东西证明它今天还成立。
test('RFC-319 IAM-21/47: a PAT manages only its own tokens and can never reach ownership/ACL writes', async () => {
  const daemon = await startDaemon()
  try {
    const asDaemon = async (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${daemon.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      })

    const mkUser = async (username: string): Promise<string> => {
      const res = await asDaemon('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          displayName: username,
          email: `${username}@example.com`,
          role: 'admin',
          password: 'Rfc319PatPass!1',
        }),
      })
      const body = await res.text()
      expect(res.status, body).toBe(201)
      return (
        await (
          await fetch(`${daemon.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: 'Rfc319PatPass!1' }),
          })
        ).json()
      ).sessionToken as string
    }
    const owner = await mkUser('rfc319-pat-owner')
    const other = await mkUser('rfc319-pat-other')

    const mintPat = async (session: string, name: string) => {
      const res = await fetch(`${daemon.baseUrl}/api/auth/pats`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          // `agents:read` 是角色基线权限，不能作为 PAT scope 显式授予（实测
          // `pat-scope-ungrantable`）。只要写权就够——下面的对照用的正是写面。
          scopes: ['agents:update'],
          purpose: 'general',
        }),
      })
      const body = await res.text()
      expect(res.status, `mint PAT ${name}: ${body}`).toBe(201)
      // 回执形状是 { token, pat: { id, ... } }——原始令牌只返回这一次。
      const parsed = JSON.parse(body) as { token: string; pat: { id: string } }
      return { id: parsed.pat.id, token: parsed.token }
    }
    const ownerPat = await mintPat(owner, 'rfc319-owner-pat')
    const otherPat = await mintPat(other, 'rfc319-other-pat')

    // IAM-47 —— 拿着 PAT 去改一个 agent 的 ACL：必须被拒，且**不是**因为权限不够
    // （scope 里明明有 agents:update），而是因为这个通道整体够不到这个面。
    // 用 **PAT 拥有者自己的会话**建资源：daemon 建的是 __system__ 私有的，
    // 那个用户根本看不见它（404 与不存在同形——ACL 本身是对的），
    // 于是「令牌写不了」会因为看不见而成立，证明不了任何针对性。
    const agentRes = await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'rfc319-pat-acl-target',
        description: 'IAM-47 fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'body',
      }),
    })
    const agentBody = await agentRes.text()
    expect(agentRes.status, agentBody).toBe(201)
    const agentId = (JSON.parse(agentBody) as { id: string }).id

    const aclViaPat = await fetch(`${daemon.baseUrl}/api/agents/${agentId}/acl`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerPat.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: agentId,
        expectedAclRevision: 0,
      }),
    })
    expect(
      aclViaPat.ok,
      '令牌改动了资源的归属 / 授权面。resourceAcl.ts:163 的 tokenAccess: never 就是为了' +
        '挡住这件事——一个被泄露的 API 令牌不该能把私有资源变成 public',
    ).toBe(false)
    // 对照：**同一个资源、同一个权限**的普通写面照常可用。没有这一条，
    // 上面那句拒绝可能只是「这个令牌什么都干不了」，证明不了任何针对性。
    const fence = (await (await asDaemon(`/api/agents/${agentId}`)).json()) as {
      updatedAt: number
      aclRevision: number | null
    }
    const ordinaryWrite = await fetch(`${daemon.baseUrl}/api/agents/${agentId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerPat.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'written through a PAT',
        expectedUpdatedAt: fence.updatedAt,
        expectedAclRevision: fence.aclRevision ?? 0,
      }),
    })
    expect(
      ordinaryWrite.status,
      `令牌连普通字段都写不了 ⇒ 上面那条 ACL 拒绝证明不了针对性：${await ordinaryWrite.text()}`,
    ).toBe(200)

    // 最强对照：**同一个人、同一个资源**，会话能改 ACL、令牌永远不能。
    // 这把「拒绝」精确归因到通道本身，而不是权限、可见性或所有权。
    const aclViaSession = await fetch(`${daemon.baseUrl}/api/agents/${agentId}/acl`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: agentId,
        expectedAclRevision: 0,
      }),
    })
    expect(
      aclViaSession.status,
      `同一个人用会话也改不了自己资源的 ACL ⇒ 对照失效：${await aclViaSession.text()}`,
    ).toBe(200)

    // IAM-21 —— 吊销自己的令牌可以；吊销别人的不行。
    const revokeOther = await fetch(`${daemon.baseUrl}/api/auth/pats/${otherPat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner}` },
    })
    expect(revokeOther.ok, '一个用户吊销掉了另一个用户的令牌').toBe(false)
    // 别人的令牌确实还活着。探针不能用 /api/auth/me——账号面对 PAT 同样是
    // tokenAccess: never（实测 403）。用「在自己的资源上做一次普通写」，
    // 那正是这个 PAT 的 scope。
    const otherAgent = await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${other}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'rfc319-pat-other-agent',
        description: 'liveness probe target',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'body',
      }),
    })
    const otherAgentBody = await otherAgent.text()
    expect(otherAgent.status, otherAgentBody).toBe(201)
    const otherAgentId = (JSON.parse(otherAgentBody) as { id: string }).id
    const patWrite = async (token: string, id: string, session: string): Promise<number> => {
      const f = (await (
        await fetch(`${daemon.baseUrl}/api/agents/${id}`, {
          headers: { Authorization: `Bearer ${session}` },
        })
      ).json()) as { updatedAt: number; aclRevision: number | null }
      return (
        await fetch(`${daemon.baseUrl}/api/agents/${id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: `probe ${Math.trunc(f.updatedAt)}`,
            expectedUpdatedAt: f.updatedAt,
            expectedAclRevision: f.aclRevision ?? 0,
          }),
        })
      ).status
    }
    expect(await patWrite(otherPat.token, otherAgentId, other)).toBe(200)

    const revokeOwn = await fetch(`${daemon.baseUrl}/api/auth/pats/${ownerPat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner}` },
    })
    expect(revokeOwn.status, `吊销自己的令牌失败：${await revokeOwn.text()}`).toBe(204)
    await expect
      .poll(async () => patWrite(ownerPat.token, agentId, owner), {
        message: 'revoked PAT still works',
      })
      .not.toBe(200)
  } finally {
    await daemon.stop()
  }
})
