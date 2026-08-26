// RFC-319 —— 首启交接 / 资源权限弹窗 / 生成式手册的按身份裁剪
// （IAM-02 · IAM-X4 · UX-05 · IAM-34 · IAM-X2 · IAM-22 · IAM-45b · UX-35b · UX-X5b · WF-47b）。
//
// 这一组的共同点是：它们全都是「每个部署都会走一遍、但坏掉时没有任何响亮信号」的路径。
// 开工前逐条对账过既有 e2e，确认下面这些判据在浏览器层确实还没有人守：
//
//   * `auth-token-form`（/auth 的一次性 token 表单）与 `auth-bootstrap-handoff`
//     （?token= 链接落地时的交接态）在全仓 e2e 里**一次都没有出现过**——
//     `e2e/identity-access.spec.ts` 的 IAM-01/03 是直接把 token 塞进 localStorage
//     再 `goto('/setup/admin')`，把「浏览器怎么拿到这张票」整段跳过了。
//   * 资源权限弹窗（`AclPanel`）只在 agents / workflows / workgroups / 数字员工 上
//     走过真浏览器；`/skills` `/mcps` `/plugins` 三类**只有一条反向断言**
//     （`rfc319-skills-management.spec.ts:1129`：无权者看不到入口），正向的
//     「打开弹窗 → 加人 → 保存 → 被授权者当场看得见」一次都没跑过。
//   * `/api/tokens` 与 `/api/tokens/audit`（平台级令牌清单 + 调用审计）在前端**零消费**
//     （全仓 grep 无命中），也没有任何 e2e 打过——这是运维在「某个令牌干了不该干的事」
//     之后唯一能查的两张表。
//   * `/docs/api` 的 `notAvailableToYou` 分支从未在浏览器里渲染过：既有
//     `e2e/rfc247-api-docs-page.spec.ts` 整份只用管理员打开，而管理员持有全部权限点，
//     那条分支恒不成立。同一份 spec 里「宽块在自己容器里横滚」的谓词含
//     `scrollWidth > 0`，对任何已渲染元素都成立（近似恒真）。
//   * 未保存改动守卫的 **beforeunload 半边**（刷新 / 关标签页）在 PR 档没有任何断言：
//     `e2e/rfc250-task-wizard-recovery.spec.ts:105` 只是注册了一个 dialog handler 再
//     reload，守卫武装与否都一样过。
//   * 工作流重命名弹窗的**描述字段**与**名称折叠**（`normalizeResourceDisplayName`）
//     只有 shared 单测；`e2e/rfc264-unicode-names.spec.ts` 改的是一个不需要折叠的名字，
//     且从头到尾没碰过描述框。
//
// 判据来源（file:line 以 origin/main b8c24a5 为准）：
//   packages/frontend/src/routes/__root.tsx:22-49              ?token= 落地：scrub → setToken → /auth?bootstrap=token
//   packages/frontend/src/routes/auth.tsx:135-178              交接 effect：ready 实例上清票回登录页；bootstrap 上校验 daemon 身份再转交
//   packages/frontend/src/routes/auth.tsx:220-241              handleTokenSubmit：非 daemon 身份 ⇒ clearToken + 可读错误
//   packages/frontend/src/routes/auth.tsx:339-365              auth-token-form 仅在 bootstrap 且非 handoff 时挂载
//   packages/frontend/src/routes/auth.tsx:40-45                deriveAuthMethods：bootstrap ⇒ 只有 token；ready ⇒ 密码/OIDC
//   packages/frontend/src/components/AclPanel.tsx:396-421      加成员一律落 read 档
//   packages/frontend/src/components/AclPanel.tsx:604-620      acl-save 只在 canManage 时渲染
//   packages/backend/src/routes/users.ts:107-133               /api/tokens 与 /api/tokens/audit：users:read + tokenAccess never
//   packages/backend/src/server.ts:371-385                     PAT 调用审计中间件（fire-and-forget）
//   packages/backend/src/services/memory.ts:793-813            canManageMemory：repo/repo_group/global 仅 bypass；资源 scope 随写权
//   packages/backend/src/services/apiDocs.ts:85-107            按有效权限裁剪端点表 + 逐工具算 grantable
//   packages/frontend/src/lib/api-docs-markdown.ts:120-133     grantable=false ⇒ 名字后面缀一个 _(not available to your account)_
//   packages/frontend/src/components/prose/prose.css:310-315   .prose pre 自带 overflow-x: auto（宽块在自己容器里滚）
//   packages/frontend/src/components/split/UnsavedChangesGuard.tsx:100-105  enableBeforeUnload 随 dirty/busy 武装
//   packages/frontend/src/routes/workflows.edit.tsx:1358-1379  重命名提交：折叠后的 name + description 一起进本地事务
//
// 执行模型：大部分用例共用一个已完成 bootstrap 的 daemon（`beforeAll`），每条用例自带
// 自己的夹具（不依赖前一条留下的状态）。首启那条必须从「还没有管理员」起步，所以它自带
// 一个 `authMode: 'bootstrap'` 的 daemon 并在自己内部走完整条链，直到那个实例变成 ready。
//
// 本文件**刻意不用** `test.describe.configure({ mode: 'serial' })`，也**刻意不用**
// `route.fetch()`（见 docs/dev-gotchas.md 的两把锁）。

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

const PASSWORD = 'Rfc319HandoffPass!1'
const TOKEN_KEY = 'agent-workflow.token'

interface SeededUser {
  id: string
  username: string
  token: string
}

async function req(
  base: string,
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  // 只读一次 body：先 text() 再 json() 会抛「Body is unusable」。
  const body = await res.text()
  expect(res.ok, `${what}: HTTP ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

/** 建号并登录。`extra` 走 additionalPermissions（RFC-305 的显式加点）。 */
async function seedUser(
  slug: string,
  role: 'user' | 'manager' | 'admin' = 'user',
  extra: string[] = [],
): Promise<SeededUser> {
  const username = `rfc319-hd-${slug}-${++sequence}`
  const created = await jsonOf<{ id: string }>(
    await req(daemon.baseUrl, '/api/users', daemon.token, {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        role,
        password: PASSWORD,
        additionalPermissions: extra,
      }),
    }),
    `seed user ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
    `login ${username}`,
  )
  return { id: created.id, username, token: sessionToken }
}

/** 把 SPA 的存储凭据种进去。传 null 表示「有 baseUrl，但没有凭据」。 */
async function primeAuth(page: Page, baseUrl: string, token: string | null): Promise<void> {
  await page.addInitScript(
    ({ url, tok, key }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', url)
        window.localStorage.setItem('aw-language', 'en-US')
        if (tok === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, tok)
      } catch {
        /* ignore */
      }
    },
    { url: baseUrl, tok: token, key: TOKEN_KEY },
  )
}

function storedToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY)
}

// ---------------------------------------------------------------------------
// IAM-02 + IAM-X4 + UX-05 —— 首启这条链，从 daemon 打印的那一行开始
// ---------------------------------------------------------------------------

test('RFC-319 IAM-02/IAM-X4/UX-05: daemon 打印的 ?token= 链接落地即被消费并转交交接页；/auth 的一次性 token 表单认票不认人；交接完成后 token 方式退役、密码表单把人送进应用 @nightly', async ({
  page,
}) => {
  // `bootstrap` 模式刻意**不**替我们完成交接，留下那张一次性票。
  const boot = await startDaemon({ authMode: 'bootstrap' })
  try {
    const setupToken = boot.bootstrapToken
    expect(
      setupToken,
      'bootstrap 模式没有留下一次性 token ⇒ 这条用例的全部前提都不成立',
    ).not.toBeNull()
    const oneTimeToken = setupToken as string

    await primeAuth(page, boot.baseUrl, null)

    // --- IAM-X4：把 daemon 打印的那一行原样粘进地址栏 -----------------------
    //
    // `/api/whoami` 是交接 effect 唯一的服务端往返（auth.tsx:164），而且全前端
    // 只有这一处消费它（其余身份读面走 /api/auth/me）。把它闸住，「交接进行中」
    // 这个瞬时态才变成可确定断言的东西，而不是碰运气去截一帧。
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(
      (url) => url.pathname === '/api/whoami',
      async (route) => {
        await gate
        await route.continue()
      },
    )

    await page.goto(`${boot.baseUrl}/?token=${oneTimeToken}`)

    await expect(
      page.getByTestId('auth-bootstrap-handoff'),
      '带 ?token= 的链接落地后没有进入交接态 ⇒ 用户看到的是普通登录页，' +
        '而他手上根本没有账号密码，安装就此卡死',
    ).toBeVisible()
    await expect(page).toHaveURL(/\/auth\?[^#]*bootstrap=token/)
    expect(
      page.url(),
      '一次性 token 还留在地址栏里 ⇒ 它会进浏览器历史、书签与任何截图，' +
        '而这张票能创建第一个管理员',
    ).not.toContain(oneTimeToken)
    expect(
      await storedToken(page),
      '链接里的票没有被收进凭据存储 ⇒ 下一步的交接页拿不到 daemon 身份，转交必然失败',
    ).toBe(oneTimeToken)

    release()
    await page.unrouteAll({ behavior: 'wait' })

    await expect(page, '交接态没有转交到 /setup/admin ⇒ 用户永远停在一个转圈的登录页').toHaveURL(
      /\/setup\/admin\?redirect=/,
    )
    await expect(page.getByRole('button', { name: 'Complete secure handoff' })).toBeVisible()

    // --- IAM-02：把凭据丢掉，改走 /auth 的一次性 token 表单 -----------------
    await page.evaluate((key) => {
      window.localStorage.removeItem(key)
    }, TOKEN_KEY)
    await page.goto(`${boot.baseUrl}/auth`)

    const tokenForm = page.getByTestId('auth-token-form')
    await expect(
      tokenForm,
      '未完成 bootstrap 的实例在 /auth 上不给一次性 token 表单 ⇒ ' +
        '安装链接一旦丢失（复制漏了、终端被清屏），这台实例就再也进不去了',
    ).toBeVisible()
    await expect(
      page.getByTestId('auth-password-form'),
      '还没有任何账号的实例却摆着密码表单 ⇒ 用户只能对着一个必然失败的表单反复试',
    ).toHaveCount(0)
    await expect(page.getByTestId('auth-oidc-method')).toHaveCount(0)

    // 错票：给出可读拒绝，并且**不把它留在本地**。
    const tokenInput = tokenForm.locator('input')
    const continueSetup = tokenForm.getByRole('button', { name: 'Continue setup' })
    await tokenInput.fill('rfc319-definitely-not-the-setup-token')
    await continueSetup.click()
    await expect(
      page.locator('.error-box').first(),
      '错票被静默吞掉 ⇒ 用户不知道是自己粘错了还是产品坏了',
    ).toBeVisible()
    await expect(page).toHaveURL(/\/auth(\?|$)/)
    expect(
      await storedToken(page),
      '一张被服务端拒绝的票仍然留在 localStorage ⇒ 之后每一次请求都带着一个死凭据，' +
        '整站表现成随机 401',
    ).toBeNull()

    // 对票：进交接页。
    await tokenInput.fill(oneTimeToken)
    await continueSetup.click()
    await expect(page, '正确的一次性 token 也进不了交接页 ⇒ 手工粘贴这条路彻底不通').toHaveURL(
      /\/setup\/admin/,
    )

    // --- UX-05：把交接做完，再用密码表单真的进应用 -------------------------
    const adminName = 'rfc319-handoff-admin'
    await page.getByLabel(/^Username/).fill(adminName)
    await page.getByLabel(/^Display name/).fill('RFC-319 Handoff Admin')
    await page.getByLabel(/^Password/).fill(PASSWORD)
    await page.getByLabel(/^Confirm password/).fill(PASSWORD)
    await page.getByRole('button', { name: 'Complete secure handoff' }).click()
    await expect(page).toHaveURL(/\/auth\?setup=complete/)

    // 交接之后，一次性 token **这个登录方式**必须从界面上消失——它退役了，
    // 还摆在那儿就是在邀请人去试一张早已失效的票。
    await page.goto(`${boot.baseUrl}/auth`)
    await expect(
      page.getByTestId('auth-password-form'),
      '已经有管理员了却不给密码表单 ⇒ 刚建出来的账号无处可用',
    ).toBeVisible()
    await expect(
      page.getByTestId('auth-token-form'),
      '交接完成后登录页仍然提供一次性 token 方式 ⇒ 一个已经退役的凭据面还挂在门口',
    ).toHaveCount(0)

    await page.getByLabel(/^Username/).fill(adminName)
    await page.getByLabel(/^Password/).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page, '密码表单提交后没有进入应用 ⇒ 登录这条路是断的').toHaveURL(/\/agents/)
    const sessionToken = await storedToken(page)
    expect(sessionToken, '登录成功却没有留下会话凭据 ⇒ 下一次刷新又被踢回登录页').not.toBeNull()

    // --- IAM-X4 的另一半：过期书签 ---------------------------------------
    // 同一个实例现在已经 ready 了。一条被收藏下来的 `?token=` 链接必须**当场作废**：
    // 既不能把那张陈旧凭据留在本地，也不能把已经退役的 token 方式复活。
    await page.goto(`${boot.baseUrl}/?token=rfc319-stale-bookmarked-setup-token`)
    await expect(
      page,
      '过期的 ?token= 书签没有回落到普通登录页 ⇒ 用户卡在一个永远转圈的交接态',
    ).toHaveURL(/\/auth\?redirect=%2F$/)
    expect(
      page.url(),
      'ready 实例上仍然保留着 bootstrap=token ⇒ 交接分支被一条陈旧书签重新激活',
    ).not.toContain('bootstrap=token')
    expect(
      await storedToken(page),
      '陈旧书签里的假票被留在了凭据存储里（而且刚刚顶掉了一个有效会话）⇒ ' +
        '用户从「已登录」变成「带着一个死凭据到处 401」',
    ).toBeNull()
    await expect(page.getByTestId('auth-password-form')).toBeVisible()
  } finally {
    await boot.stop()
  }
})

// ---------------------------------------------------------------------------
// IAM-34 —— 权限弹窗：skills / mcps / plugins 三类的正向授权
// ---------------------------------------------------------------------------

test('RFC-319 IAM-34: 技能 / MCP / 插件三类资源的权限弹窗在真浏览器里加人保存后，被授权者当场看得见，而资源仍然是 private @nightly', async ({
  page,
}) => {
  const grantee = await seedUser('acl-grantee')

  const skill = await jsonOf<{ id: string }>(
    await req(daemon.baseUrl, '/api/skills', daemon.token, {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-acl-skill-${++sequence}`,
        description: 'RFC-319 IAM-34 fixture',
        bodyMd: 'Body.',
      }),
    }),
    'seed skill',
  )
  const mcp = await jsonOf<{ id: string }>(
    await req(daemon.baseUrl, '/api/mcps', daemon.token, {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-acl-mcp-${++sequence}`,
        description: 'RFC-319 IAM-34 fixture',
        type: 'remote',
        config: { url: 'http://127.0.0.1:1/mcp', oauth: false, timeoutMs: 5_000 },
        enabled: true,
      }),
    }),
    'seed mcp',
  )
  const plugin = await jsonOf<{ id: string }>(
    await req(daemon.baseUrl, '/api/plugins', daemon.token, {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-acl-plugin-${++sequence}`,
        description: 'RFC-319 IAM-34 fixture',
        spec: daemon.stubOpencode,
        enabled: true,
      }),
    }),
    'seed plugin',
  )

  const surfaces = [
    { kind: 'skill', list: '/api/skills', page: '/skills', id: skill.id },
    { kind: 'mcp', list: '/api/mcps', page: '/mcps', id: mcp.id },
    { kind: 'plugin', list: '/api/plugins', page: '/plugins', id: plugin.id },
  ] as const

  const visibleToGrantee = async (listPath: string): Promise<string[]> => {
    const rows = await jsonOf<Array<{ id: string }>>(
      await req(daemon.baseUrl, listPath, grantee.token),
      `list ${listPath} as grantee`,
    )
    return rows.map((row) => row.id)
  }

  await primeAuth(page, daemon.baseUrl, daemon.token)

  for (const surface of surfaces) {
    // 前提：被授权者现在**看不见**它。没有这一条，后面的「看得见」可能只是
    // 因为这类资源对谁都可见，授权动作本身就证明不了任何东西。
    expect(
      await visibleToGrantee(surface.list),
      `${surface.kind}：授权之前被授权者就已经看得见 ⇒ 这条用例证明不了授权真的生效`,
    ).not.toContain(surface.id)

    await page.goto(`${daemon.baseUrl}${surface.page}/${surface.id}`)
    await page.getByTestId('detail-more-actions').click()
    const actions = page.getByTestId('detail-actions-dialog')
    await expect(actions).toBeVisible()
    await expect(
      actions.getByTestId('acl-dialog-button'),
      `${surface.kind}：详情页的 More 菜单里没有权限入口 ⇒ 这类资源在界面上根本无法共享，` +
        '只能改数据库',
    ).toBeVisible()
    await actions.getByTestId('acl-dialog-button').click()

    const panel = page.getByTestId('acl-panel')
    await expect(panel).toBeVisible()
    await expect(
      panel.getByTestId('acl-members-empty'),
      `${surface.kind}：新建资源的授权名单不是空的 ⇒ 创建即默认外发`,
    ).toBeVisible()

    const memberInput = panel.getByTestId('acl-members-input')
    await memberInput.click()
    await memberInput.fill(grantee.username)
    // 候选列表走 AppPortal 挂在 document.body 上，**不在** .acl-panel 里面，
    // 所以这里必须从 page 取而不是从 panel 取。
    const option = page.getByTestId(`acl-members-option-${grantee.username}`)
    await expect(
      option,
      `${surface.kind}：加成员的搜索框找不到目标账号 ⇒ 弹窗打得开但加不了人`,
    ).toBeVisible()
    await option.click()

    // 新加的人一律落 `read` 档（AclPanel.tsx:409-413 的安全默认）。
    await expect(
      panel.getByTestId(`acl-level-read-${grantee.id}`),
      `${surface.kind}：新加的成员没有落在 read 档 ⇒ 加个人就等于交出编辑权`,
    ).toHaveAttribute('aria-checked', 'true')

    await panel.getByTestId('acl-save').click()
    await expect(
      page.getByTestId('acl-panel'),
      `${surface.kind}：保存之后弹窗没有关掉 ⇒ 用户分不清自己到底存没存进去`,
    ).toHaveCount(0)

    // 服务端落库了，而且**只**落了授权——可见性仍然是 private。
    const acl = await jsonOf<{
      visibility: string
      grants: Array<{ user: { id: string }; level: string }>
    }>(
      await req(daemon.baseUrl, `${surface.list}/${surface.id}/acl`, daemon.token),
      `read ${surface.kind} acl`,
    )
    expect(
      acl.grants.map((grant) => `${grant.user.id}:${grant.level}`),
      `${surface.kind}：保存后的授权名单不是「只有这一个人、read 档」`,
    ).toEqual([`${grantee.id}:read`])
    expect(
      acl.visibility,
      `${surface.kind}：加一个人顺手把资源改成了 public ⇒ 想分享给一个人，实际分享给了全员`,
    ).toBe('private')

    expect(
      await visibleToGrantee(surface.list),
      `${surface.kind}：授权已落库，被授权者的列表里却还是没有它 ⇒ 权限弹窗存了个寂寞`,
    ).toContain(surface.id)
    const detail = await req(daemon.baseUrl, `${surface.list}/${surface.id}`, grantee.token)
    expect(
      detail.status,
      `${surface.kind}：被授权者打不开详情（HTTP ${detail.status}）⇒ 列表里看得见、点进去 404`,
    ).toBe(200)
  }
})

// ---------------------------------------------------------------------------
// IAM-X2 —— 记忆条目的 scope 级读 / 管权限
// ---------------------------------------------------------------------------

test('RFC-319 IAM-X2: 工作流 scope 的记忆随工作流可见性进出读面；管理权随 scope 资源的写权——write 档改得动、read 档改不动 @nightly', async () => {
  // 账本这条的措辞覆盖了 repo / repo_group / global 全员读那一档，但那一档已经由
  // `e2e/memory-access.spec.ts` 的 MEM-37 / MEM-34 锁住了。这里补的是它**没有**碰的
  // 两条腿：①`canViewMemory` 的资源 scope 分支只对 agent 走过，workflow 那半边零覆盖；
  // ②`canManageMemory` 末行走的是 `canEditResource`（RFC-324 起含 `write` 授权档），
  // 而既有用例只验过「public 可见者改不动」，从没验过「write 档的人改得动」——
  // 那正是把「看得见」与「管得了」区分开的那条判据。
  const owner = await seedUser('mem-owner')
  const writer = await seedUser('mem-writer')
  const reader = await seedUser('mem-reader')

  const workflow = await jsonOf<{ id: string }>(
    await req(daemon.baseUrl, '/api/workflows', owner.token, {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-mem-scope-${++sequence}`,
        description: 'RFC-319 IAM-X2 fixture',
        definition: {
          $schema_version: 5,
          inputs: [{ kind: 'text', key: 'k1', label: 'K1', required: false }],
          nodes: [{ id: 'in_1', kind: 'input', inputKey: 'k1', position: { x: 0, y: 0 } }],
          edges: [],
        },
      }),
    }),
    'seed workflow',
  )

  const created = await jsonOf<{ memory: { id: string } }>(
    await req(daemon.baseUrl, '/api/memories', owner.token, {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'workflow',
        scopeId: workflow.id,
        title: `rfc319-workflow-memory-${sequence}`,
        bodyMd: 'RFC-319 IAM-X2 fixture body that is long enough to be meaningful.',
      }),
    }),
    'seed workflow-scoped memory',
  )
  const memoryId = created.memory.id
  // 手工建出来的记忆初始是 candidate，而 candidate 对无 bypass 的账号整体不可见
  // （memories.ts 的 dropCandidates）。先人审发布，读面断言才落在 scope 规则上。
  await jsonOf(
    await req(daemon.baseUrl, `/api/memories/${memoryId}/promote`, daemon.token, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    }),
    'promote memory',
  )

  // 列表回执是 `{ items: [...] }`（memories.ts:153），不是裸数组。
  const listIds = async (token: string): Promise<string[]> => {
    const body = await jsonOf<{ items: Array<{ id: string }> }>(
      await req(daemon.baseUrl, '/api/memories', token),
      'list memories',
    )
    return body.items.map((row) => row.id)
  }
  const putAcl = async (
    body: Record<string, unknown>,
    revision: number,
    what: string,
  ): Promise<void> => {
    await jsonOf(
      await req(daemon.baseUrl, `/api/workflows/${workflow.id}/acl`, owner.token, {
        method: 'PUT',
        body: JSON.stringify({
          ...body,
          expectedResourceId: workflow.id,
          expectedAclRevision: revision,
        }),
      }),
      what,
    )
  }

  // ① 私有工作流 ⇒ 陌生人读不到它名下的记忆，且详情与「不存在」同形。
  expect(
    await listIds(reader.token),
    '绑定工作流是私有的，它的记忆却出现在陌生人的列表里 ⇒ 别人沉淀的上下文被泄露，' +
      '而这些内容会被注入进下一次任务的 prompt',
  ).not.toContain(memoryId)
  const hidden = await req(daemon.baseUrl, `/api/memories/${memoryId}`, reader.token)
  const absent = await req(daemon.baseUrl, '/api/memories/01JZZZZZZZZZZZZZZZZZZZZZZZ', reader.token)
  expect(
    hidden.status,
    `不可见记忆的详情（${hidden.status}）与「不存在」（${absent.status}）状态码不同 ⇒ ` +
      'id 的存在性从错误码泄露出去',
  ).toBe(absent.status)

  // ② 授出 read 档 ⇒ 看得见（读面确实随资源走，不是「谁都看不见」）。
  await putAcl({ grants: [{ userId: reader.id, level: 'read' }] }, 0, 'grant read')
  expect(
    await listIds(reader.token),
    'read 档被授权者看不到该工作流名下的记忆 ⇒ 读面没有随绑定资源的可见性走',
  ).toContain(memoryId)

  // ③ read 档**管不了**：改 / 归档 / 删三条写路径都必须被拒，且内容一个字不动。
  const readerLeaks: string[] = []
  const readerPatch = await req(daemon.baseUrl, `/api/memories/${memoryId}`, reader.token, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'hijacked by a read grant' }),
  })
  if (readerPatch.ok) readerLeaks.push(`PATCH → ${readerPatch.status}`)
  const readerArchive = await req(
    daemon.baseUrl,
    `/api/memories/${memoryId}/archive`,
    reader.token,
    { method: 'POST' },
  )
  if (readerArchive.ok) readerLeaks.push(`archive → ${readerArchive.status}`)
  const readerDelete = await req(daemon.baseUrl, `/api/memories/${memoryId}`, reader.token, {
    method: 'DELETE',
  })
  if (readerDelete.ok) readerLeaks.push(`DELETE → ${readerDelete.status}`)
  expect(
    readerLeaks,
    '只读授权者改动了记忆 ⇒ 「看得见」被当成了「管得了」，而记忆改了只会在下一次任务的 ' +
      'prompt 里悄悄生效，没有任何人会收到通知',
  ).toEqual([])

  // ④ 提到 write 档 ⇒ 同一个写路径必须打得通（否则③只是「这个端点对谁都拒」）。
  await putAcl({ grants: [{ userId: writer.id, level: 'write' }] }, 1, 'grant write')
  const writerPatch = await req(daemon.baseUrl, `/api/memories/${memoryId}`, writer.token, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'renamed by a write grant' }),
  })
  expect(
    writerPatch.ok,
    `write 档授权者也改不动这条记忆（HTTP ${writerPatch.status}: ${await writerPatch.text()}）⇒ ` +
      '「能改这个工作流的人也能管它名下的记忆」这条规则没有生效，' +
      '而上面那三条拒绝也就退化成「对谁都拒」，证明不了任何针对性',
  ).toBe(true)
  // 详情回执是 `{ memory: {...}, ancestors: [...] }`（memories.ts:247），不是扁平行。
  const after = await jsonOf<{ memory: { title: string } }>(
    await req(daemon.baseUrl, `/api/memories/${memoryId}`, daemon.token),
    'read back memory',
  )
  expect(after.memory.title, 'write 档的修改没有真的落库').toBe('renamed by a write grant')

  // ⑤ 撤销授权 ⇒ 记忆重新退出读面（读面是活的，不是「授过一次就永远看得见」）。
  await putAcl({ grants: [] }, 2, 'revoke all grants')
  expect(
    await listIds(reader.token),
    '授权撤销之后记忆仍留在对方的读面里 ⇒ 收回权限这个动作对记忆无效',
  ).not.toContain(memoryId)
})

// ---------------------------------------------------------------------------
// IAM-22 —— 平台级令牌清单与调用审计（users:read 只读）
// ---------------------------------------------------------------------------

test('RFC-319 IAM-22: users:read 看得见全平台的令牌与它们打过的每一次调用，但吊销不了别人的令牌；这两张表还整体拒绝令牌通道 @nightly', async () => {
  const holder = await seedUser('token-holder')
  const auditor = await seedUser('token-auditor', 'user', ['users:read'])
  const bystander = await seedUser('token-bystander')

  const minted = await jsonOf<{ token: string; pat: { id: string } }>(
    await req(daemon.baseUrl, '/api/auth/pats', holder.token, {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-audited-pat-${++sequence}`,
        // `agents:read` 是角色基线权限，作为显式 scope 会被判 pat-scope-ungrantable。
        scopes: ['agents:update'],
        purpose: 'general',
      }),
    }),
    'mint holder PAT',
  )

  // 用这张令牌打一次真实调用——审计表的每一行都由这条中间件写出来。
  const probe = await req(daemon.baseUrl, '/api/agents', minted.token)
  expect(probe.status, `PAT 调用 /api/agents 失败：${await probe.text()}`).toBe(200)

  // ① 清单是**跨用户**的：审计者看得到别人的令牌。
  const inventory = await jsonOf<Array<{ id: string; userId: string }>>(
    await req(daemon.baseUrl, '/api/tokens', auditor.token),
    'list platform tokens as auditor',
  )
  const mine = inventory.find((row) => row.id === minted.pat.id)
  expect(
    mine,
    '持有 users:read 的账号在平台令牌清单里看不到别人刚签发的令牌 ⇒ ' +
      '「谁手上有票」这个问题在产品里无法回答',
  ).toBeDefined()
  expect(mine?.userId, '清单里的令牌没有归属到它真正的主人').toBe(holder.id)

  // ② 调用审计记下了那一次调用的归属、路径与结果。中间件是 fire-and-forget
  //    （server.ts:376 的 `void recordTokenCall`），所以必须轮询而不是读一次。
  await expect
    .poll(
      async () => {
        const rows = await jsonOf<
          Array<{ patId: string; userId: string; path: string; statusCode: number }>
        >(await req(daemon.baseUrl, '/api/tokens/audit', auditor.token), 'list token audit')
        return rows
          .filter((row) => row.patId === minted.pat.id)
          .map((row) => `${row.userId}|${row.path}|${row.statusCode}`)
      },
      { timeout: 15_000 },
    )
    .toContain(`${holder.id}|/api/agents|200`)

  // ③ 只读：审计者吊销不了别人的令牌，而且那张令牌**仍然能用**——
  //    这一步才把「拒绝」和「其实已经悄悄吊销了」分开。
  const revoke = await req(daemon.baseUrl, `/api/auth/pats/${minted.pat.id}`, auditor.token, {
    method: 'DELETE',
  })
  expect(
    revoke.ok,
    'users:read 能吊销别人的令牌 ⇒ 一个只读的审计角色拿到了处置他人凭据的权力',
  ).toBe(false)
  const stillWorks = await req(daemon.baseUrl, '/api/agents', minted.token)
  expect(
    stillWorks.status,
    `被拒的吊销仍然让令牌失效了（HTTP ${stillWorks.status}）⇒ 拒绝只是回执上的，实际已经动了手`,
  ).toBe(200)
  // 对照：主人自己吊销得掉，否则上一条只是「这个端点对谁都拒」。
  const ownRevoke = await req(daemon.baseUrl, `/api/auth/pats/${minted.pat.id}`, holder.token, {
    method: 'DELETE',
  })
  expect(ownRevoke.ok, `令牌主人自己也吊销不了：${await ownRevoke.text()}`).toBe(true)

  // ④ 没有 users:read 的普通账号够不着这两张表。
  for (const path of ['/api/tokens', '/api/tokens/audit']) {
    const denied = await req(daemon.baseUrl, path, bystander.token)
    expect(
      denied.ok,
      `${path}：没有 users:read 的普通账号也读得到 ⇒ 全平台的令牌清单对所有人开放`,
    ).toBe(false)
  }

  // ⑤ 通道闸：这两条路由是 tokenAccess: 'never'，任何 PAT 都够不着——
  //    哪怕签发它的是管理员。否则「令牌不能查令牌」这条自证边界就不存在了。
  const adminPat = await jsonOf<{ token: string }>(
    await req(daemon.baseUrl, '/api/auth/pats', daemon.token, {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-admin-pat-${++sequence}`,
        scopes: ['agents:update'],
        purpose: 'general',
      }),
    }),
    'mint admin PAT',
  )
  for (const path of ['/api/tokens', '/api/tokens/audit']) {
    const viaPat = await req(daemon.baseUrl, path, adminPat.token)
    expect(
      viaPat.ok,
      `${path}：管理员签发的 PAT 读得到平台令牌清单 ⇒ 一张票就能把全平台的票都抄走`,
    ).toBe(false)
  }
})

// ---------------------------------------------------------------------------
// IAM-45b —— /docs/api 按当前身份裁剪
// ---------------------------------------------------------------------------

interface ApiDocsToolRow {
  name: string
  grantable: boolean
}

/** 页面上被标了「not available to your account」的工具名。 */
async function markedToolNames(target: Page): Promise<string[]> {
  return target.evaluate(() => {
    const out: string[] = []
    for (const row of Array.from(document.querySelectorAll('.prose table tr'))) {
      const first = row.querySelector('td')
      if (first === null) continue
      const code = first.querySelector('code')
      if (code === null) continue
      const marked = Array.from(first.querySelectorAll('em')).some(
        (em) => (em.textContent ?? '').trim() === '(not available to your account)',
      )
      if (marked) out.push((code.textContent ?? '').trim())
    }
    return out
  })
}

/** REST 表里是否有 `<method> <path>` 这一行。 */
async function hasRestRow(target: Page, method: string, path: string): Promise<boolean> {
  return target.evaluate(
    ({ m, p }) => {
      for (const row of Array.from(document.querySelectorAll('.prose table tr'))) {
        const cells = Array.from(row.querySelectorAll('td'))
        if (cells.length < 2) continue
        if (
          (cells[0]?.textContent ?? '').trim() === m &&
          (cells[1]?.textContent ?? '').trim() === p
        ) {
          return true
        }
      }
      return false
    },
    { m: method, p: path },
  )
}

test('RFC-319 IAM-45b: /docs/api 用低权账号打开时，够不着的 MCP 工具被逐条标注、够不着的端点整行消失，而管理员那份两样都没有', async ({
  page,
  browser,
}) => {
  const plain = await seedUser('docs-plain')

  // 管理员那一份：全部权限点都在手上，所以标注分支恒不成立。
  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/docs/api`)
  await expect(page.getByText('launch_task').first()).toBeVisible()
  expect(
    await markedToolNames(page),
    '管理员的手册里也出现了「当前账户不可用」标注 ⇒ 裁剪算的不是调用者的有效权限',
  ).toEqual([])
  expect(
    await hasRestRow(page, 'DELETE', '/api/tasks/:id'),
    '管理员的端点表里缺了 DELETE /api/tasks/:id ⇒ 下面「低权账号看不到它」的断言就成了空洞绿',
  ).toBe(true)

  // 低权账号那一份：`user` 预设没有 `tasks:delete`，于是需要它的工具被标注、
  // 需要它的端点整行不出现。
  const context = await browser.newContext()
  try {
    const lowPage = await context.newPage()
    await primeAuth(lowPage, daemon.baseUrl, plain.token)
    await lowPage.goto(`${daemon.baseUrl}/docs/api`)
    await expect(lowPage.getByText('launch_task').first()).toBeVisible()

    const marked = await markedToolNames(lowPage)
    expect(
      marked,
      '低权账号的手册里一个「当前账户不可用」标注都没有 ⇒ ' +
        '这个账号被告知它可以把 delete_task 放上令牌，而实际不能',
    ).toContain('delete_task')

    // 与服务端算出来的那一份逐条对账：标注集合必须**恰好**等于 grantable=false 的集合，
    // 少标一个是误导，多标一个是把能用的能力说成不能用。
    const payload = await jsonOf<{ tools: ApiDocsToolRow[] }>(
      await req(daemon.baseUrl, '/api/docs/api', plain.token),
      'fetch api docs payload as plain user',
    )
    const ungrantable = payload.tools.filter((tool) => !tool.grantable).map((tool) => tool.name)
    expect(ungrantable.length, '服务端没有算出任何不可授予的工具 ⇒ 前提不成立').toBeGreaterThan(0)
    expect(
      [...marked].sort(),
      '页面上的标注集合与服务端算出来的 grantable=false 集合对不上',
    ).toEqual([...ungrantable].sort())

    expect(
      await hasRestRow(lowPage, 'DELETE', '/api/tasks/:id'),
      '低权账号的端点表里仍然列着它永远调不通的 DELETE /api/tasks/:id ⇒ ' + '手册在教用户去撞 403',
    ).toBe(false)
  } finally {
    await context.close()
  }
})

// ---------------------------------------------------------------------------
// UX-X5b —— /docs/api 的宽块在自己容器里横滚
// ---------------------------------------------------------------------------

test('RFC-319 UX-X5b: 390px 下 /docs/api 的宽块真的能在自己的容器里横向滚动，滚到底之后页面本身仍然不横滚', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/docs/api`)
  await expect(page.getByText('launch_task').first()).toBeVisible()

  // 判据必须能分辨「在容器内滚」与「把页面撑横」。既有那条断言的谓词里带着
  // `scrollWidth > 0`，对任何已渲染元素都成立，所以它两种情况都放行。这里换成
  // 三件事一起量，并且**逐类**（table / pre）都量，避免「代码块能滚」把
  // 「表格不能滚」盖过去：
  //   ① 内容确实比自身盒子宽（否则「能滚」无从谈起）；
  //   ② 盒子本身没有超出视口（超出了就是在撑页面，不是在自己里面滚）；
  //   ③ 把 scrollLeft 推到底之后**读回来大于 0**——这一步才是真正的区分点：
  //      一个 overflow 可见的块，scrollLeft 写进去永远读回 0。
  const probe = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth
    const results: Array<{
      tag: string
      overflows: boolean
      boxFits: boolean
      scrolled: number
    }> = []
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('.prose table, .prose pre'),
    )) {
      const before = el.scrollLeft
      el.scrollLeft = el.scrollWidth
      const scrolled = el.scrollLeft
      el.scrollLeft = before
      results.push({
        tag: el.tagName.toLowerCase(),
        overflows: el.scrollWidth > el.clientWidth + 1,
        boxFits: Math.ceil(el.getBoundingClientRect().width) <= viewport + 1,
        scrolled,
      })
    }
    return {
      viewport,
      results,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
    }
  })

  // 实测：390px 下这一页真正会溢出的**只有代码块**——表格的单元格靠
  // `.prose { overflow-wrap: anywhere }`（prose.css:48）折行，量到的 15 张表
  // 全是 `overflows:false`。所以「宽块」这条断言必须落在 `pre` 上；把它写成
  // 「随便哪个 table 或 pre」会让代码块的正常表现盖住表格的任何退化，
  // 而写成「必须有一张溢出的表」则是一条在本页恒假的断言。
  const pres = probe.results.filter((row) => row.tag === 'pre')
  expect(
    pres.length,
    '390px 下 /docs/api 一个代码块都没渲染出来 ⇒ 下面每一条断言都成了空洞绿',
  ).toBeGreaterThan(0)
  expect(
    pres.filter((row) => row.overflows && row.scrolled > 0).length,
    `没有任何一个代码块是可横向滚动的容器（量到 ${JSON.stringify(pres)}）⇒ ` +
      '手机上客户端配置那几段 JSON 只读得到左边一截，右边永远够不着',
  ).toBeGreaterThan(0)
  expect(
    probe.results.filter((row) => row.overflows && row.scrolled <= 0),
    '有宽块的内容溢出了自身盒子，却推不动 scrollLeft ⇒ 它不是滚动容器，只是在往外冒',
  ).toEqual([])
  expect(
    probe.results.filter((row) => !row.boxFits),
    `宽块的盒子本身超出了 ${probe.viewport}px 视口 ⇒ 它是在把页面撑横，而不是在自己容器里滚`,
  ).toEqual([])
  expect(
    probe.pageScrollWidth,
    '把宽块滚到底之后页面自身开始横滚 ⇒ 容器的滚动溢出到了文档层',
  ).toBeLessThanOrEqual(probe.pageClientWidth + 1)
})

// ---------------------------------------------------------------------------
// UX-35b —— 未保存改动守卫的 beforeunload 半边
// ---------------------------------------------------------------------------

/** 刷新 / 关标签页守卫是否武装：合成一个可取消的 beforeunload，看它被不被拦。
 *  用合成事件而不是真的 reload，是为了避开 Playwright 对原生 beforeunload
 *  弹窗的处理差异——那条路上「拦住了」与「根本没拦」看起来一模一样。 */
async function beforeUnloadIsArmed(target: Page): Promise<boolean> {
  return target.evaluate(() => {
    const probe = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(probe)
    return probe.defaultPrevented
  })
}

test('RFC-319 UX-35b: 未保存的草稿会武装刷新 / 关标签页的原生守卫，丢弃之后当场解除', async ({
  page,
}) => {
  const seedAgent = async (slug: string): Promise<{ id: string }> =>
    jsonOf<{ id: string }>(
      await req(daemon.baseUrl, '/api/agents', daemon.token, {
        method: 'POST',
        body: JSON.stringify({
          name: `rfc319-unload-${slug}-${++sequence}`,
          description: 'RFC-319 UX-35b fixture',
          outputs: ['answer'],
          readonly: true,
          bodyMd: 'Body.',
        }),
      }),
      `seed agent ${slug}`,
    )
  const agent = await seedAgent('a')
  const neighbour = await seedAgent('b')

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)

  const description = page.getByRole('textbox', { name: 'Description' })
  await expect(description).toHaveValue('RFC-319 UX-35b fixture')

  // ① 干净页面上守卫必须是**解除**的。没有这一条，②就可能只是
  //    「这个应用对任何页面都拦刷新」——那种拦法本身就是 bug。
  expect(
    await beforeUnloadIsArmed(page),
    '什么都没改的详情页也拦住了刷新 ⇒ 用户每次按 F5 都要多点一个弹窗',
  ).toBe(false)

  // ② 改一个字 ⇒ 守卫武装。
  await description.fill('An edit that must survive an accidental refresh.')
  await expect(
    page.getByTestId(`split-card-dot-${agent.id}`),
    '改了字却没有出现未保存圆点 ⇒ 前提不成立，下面的断言归因不到草稿上',
  ).toBeVisible()
  expect(
    await beforeUnloadIsArmed(page),
    '有未保存草稿时刷新 / 关标签页不给任何提示 ⇒ 用户一次误刷新就丢掉全部编辑，' +
      '而且事后没有任何痕迹说明它丢过',
  ).toBe(true)

  // ③ 明确丢弃之后 ⇒ 守卫解除（它跟着草稿走，不是一挂上就再也摘不掉）。
  await page.getByTestId(`split-card-${neighbour.id}`).click()
  const guard = page.getByTestId('unsaved-guard-dialog')
  await expect(guard).toBeVisible()
  await page.getByTestId('unsaved-discard').click()
  await expect(page).toHaveURL(new RegExp(`/agents/${neighbour.id}$`))
  expect(
    await beforeUnloadIsArmed(page),
    '草稿已经被丢弃，刷新守卫却还武装着 ⇒ 它从此永远拦着，提示也就再无意义',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// WF-47b —— 重命名工作流：描述字段 + 名称折叠
// ---------------------------------------------------------------------------

test('RFC-319 WF-47b: 工作流重命名弹窗同时提交描述，并把名称按空白折叠规则落定——重开弹窗看到的是折叠后的值，不是刚敲进去的原文', async ({
  page,
}) => {
  const originalName = `rfc319-wf47b-${++sequence}`
  const originalDescription = 'RFC-319 WF-47b fixture description'
  const workflow = await jsonOf<{ id: string }>(
    await req(daemon.baseUrl, '/api/workflows', daemon.token, {
      method: 'POST',
      body: JSON.stringify({
        name: originalName,
        description: originalDescription,
        definition: {
          $schema_version: 5,
          inputs: [{ kind: 'text', key: 'k1', label: 'K1', required: false }],
          nodes: [{ id: 'in_1', kind: 'input', inputKey: 'k1', position: { x: 0, y: 0 } }],
          edges: [],
        },
      }),
    }),
    'seed workflow',
  )

  // 前后各两个普通空格、中间一个 U+3000 表意空格（\p{Zs}）和一串连续空格。
  // normalizeResourceDisplayName 的三步（Zs→空格 / 折叠连续空格 / 去首尾）
  // 各被打到一次，所以任何一步被删掉都会让折叠结果对不上。
  const rawName = '  RFC-319 　WF-47b   折叠 名  '
  const foldedName = 'RFC-319 WF-47b 折叠 名'
  const newDescription = 'RFC-319 WF-47b 描述必须和名称一起提交'

  await primeAuth(page, daemon.baseUrl, daemon.token)
  await page.goto(`${daemon.baseUrl}/workflows/${workflow.id}`)

  const openRename = async (): Promise<void> => {
    await page.getByTestId('workflow-more-actions').click()
    await expect(page.getByTestId('workflow-actions-dialog')).toBeVisible()
    await page.getByTestId('workflow-rename-button').click()
    await expect(page.getByTestId('workflow-rename-dialog')).toBeVisible()
  }

  await openRename()
  // 弹窗确实是从当前草稿灌进来的——否则「改过了」这件事无从对照。
  await expect(page.getByTestId('workflow-rename-name')).toHaveValue(originalName)
  await expect(
    page.getByTestId('workflow-rename-description'),
    '重命名弹窗没有把当前描述带出来 ⇒ 用户一改名字就会把描述清空',
  ).toHaveValue(originalDescription)

  await page.getByTestId('workflow-rename-name').fill(rawName)
  await page.getByTestId('workflow-rename-description').fill(newDescription)
  await page.getByTestId('workflow-rename-confirm').click()
  await expect(page.getByTestId('workflow-rename-dialog')).toHaveCount(0)

  // ① 本地草稿里落的是**折叠后**的名字。重开弹窗读回来是最直接的证据：
  //    服务端在写入时也会折叠一次，所以只看服务端分辨不出客户端有没有折叠。
  await openRename()
  await expect(
    page.getByTestId('workflow-rename-name'),
    '重开弹窗看到的仍是刚敲进去的原文 ⇒ 客户端没有折叠，本地草稿与服务端存下来的值' +
      '从此长期不一致（RFC-264 说的「永远脏」）',
  ).toHaveValue(foldedName)
  await expect(page.getByTestId('workflow-rename-description')).toHaveValue(newDescription)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workflow-rename-dialog')).toHaveCount(0)

  // ② 服务端两项都落了。编辑器是防抖自动保存，所以轮询而不是读一次。
  await expect
    .poll(
      async () => {
        const row = await jsonOf<{ name: string; description: string }>(
          await req(daemon.baseUrl, `/api/workflows/${workflow.id}`, daemon.token),
          'read back workflow',
        )
        return { name: row.name, description: row.description }
      },
      { timeout: 20_000 },
    )
    .toEqual({ name: foldedName, description: newDescription })

  // ③ 落库之后草稿必须收敛到「已保存」。原文与折叠值不一致时这里会一直脏下去，
  //    自动保存也就永远停不下来。
  await expect(
    page.getByTestId('workflow-draft-phase'),
    '重命名落库之后编辑器仍然不是「已保存」 ⇒ 本地草稿与服务端存下来的值对不上',
  ).toHaveText('Saved')
})
