// RFC-319 —— 意图构建器：权限、可见性与归档的用户面 e2e。
//
// 覆盖能力账本 INTENT-45 / 44 / 43 / 27 / 11 / X1 六行（账本里全部是 gap）。这六条
// 锁的都是「谁能看见什么、谁能改什么」，失效形态各不相同但同样**静默**：
//
//   * INTENT-45 —— 非成员访问他人会话，若与「不存在」不同形（403 / 不同文案 /
//     不同 body），攻击者就拿到了一个**存在性探针**：拿一串 id 扫一遍就能枚举出
//     平台上有哪些会话、谁在忙什么。判据因此必须**逐字节**——只比状态码挡不住
//     「同样 404、但一个带 id 一个不带」这种泄露。
//   * INTENT-44 —— 管理员审计视图一旦渲染出变更控件，审计就变成了**代改**：
//     管理员在别人的会话里点一下「提交」，别人的资源被改而本人毫不知情。而且
//     「按钮没渲染」不等于「改不动」——写面必须自己也 404，所以本文件在断言
//     控件计数为 0 之外，还直接打写接口。
//   * INTENT-43 —— 归档后若控件还在，用户以为这条会话已封存、实际仍能被继续
//     提交；反过来重新打开后控件回不来则是功能丢失。两个方向都要断言，否则
//     「永远只读」也能过。
//   * INTENT-27 —— 挂载是一次**读**：能挂载 = 能把别人的私有资源整份 dump 进
//     自己的会话上下文喂给模型。不可见与不存在必须同形，否则同样是存在性探针。
//   * INTENT-11 —— provenance 徽章泄露的是「这个资源是某人用意图构建器做的、
//     源会话在这里」。对看不到源会话的人，它必须在 DOM 里**完全不存在**，而不是
//     渲染出来再靠点击时 404 兜底。注意这条的负向断言极易恒真（资源本身不可见时
//     整页都打不开，徽章当然是 0），所以本文件先把资源**改成 public**，让第二个
//     用户能完整看到资源页，再断言徽章为 0。
//   * INTENT-X1 —— 没有 intent:write 却渲染入口按钮，用户点进去只能吃 403。
//     「不渲染」的断言天然容易恒真，因此每一条都配一个**同页、同资源**的正向
//     对照（有权限的账号在同一个位置确实渲染出 1 个）。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/backend/src/services/intent/session.ts:82-99       canReadIntentSession + 404 同形装载
//   packages/backend/src/services/intent/session.ts:111         列表 all=1 只对 intent:audit 生效
//   packages/backend/src/services/intent/session.ts:446-453     assertWritable：非 owner→404、已归档→409
//   packages/backend/src/services/intent/session.ts:834-836     addIntentMount：不可见资源 → resource-not-found
//   packages/backend/src/services/intent/session.ts:963-965     setIntentSessionStatus：归档/重开 owner-only
//   packages/backend/src/services/intent/session.ts:1027-1029   provenance：非本人会话的行被过滤掉
//   packages/backend/src/routes/intentSessions.ts:241           includeOwner = all && canAuditIntentSessions
//   packages/backend/src/routes/intentSessions.ts:479-486       详情：ownerUserId 仅在「不是本人」时下发
//   packages/backend/src/routes/intentSessions.ts:910-915       cancel-turn：审计读旁路不延伸到写
//   packages/backend/src/services/resourceAcl.ts:199-201        canAuditIntentSessions = intent:audit
//   packages/shared/src/schemas/permission.ts:1030-1058         USER_BASELINE 含 intent:read/write
//   packages/shared/src/schemas/permission.ts:914-923           GUEST_BASELINE 不含 intent:*
//   packages/frontend/src/routes/intent.detail.tsx:95-98        isAuditView / canManageLifecycle / canEdit
//   packages/frontend/src/routes/intent.detail.tsx:328-341      归档 / 重新打开按钮
//   packages/frontend/src/routes/intent.detail.tsx:350-354      auditReadOnly / archivedReadOnly 横幅
//   packages/frontend/src/components/IntentEntryButton.tsx:30-32   无 intent:write → return null
//   packages/frontend/src/components/IntentProvenanceBadge.tsx:32-33 无 provenance 行 → return null
//
// 执行模型：本文件所有用例共用一个 daemon（stubMode: 'intent'）。playwright.config.ts
// 把 fullyParallel 留在默认 false，因此文件内用例按声明顺序串行。**唯一一条真正
// 提交草稿的用例（INTENT-11）声明在最后**——intent stub 每轮产出的都是同名代理
// `e2e-auditor`，提交两次会撞占用名，把无关用例拖红。

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

let daemon: DaemonHandle

/**
 * 26 位、字母表合法、但从未被铸造过的 id——404 同形比较的「对照组」。
 * 后端对这两个路径参数没有格式校验（routes/intentSessions.ts:304-306 直接进
 * getIntentSessionForActor），所以它们走的是和真 id 完全相同的代码路径。
 */
const ABSENT_SESSION_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const ABSENT_AGENT_ID = '01JYYYYYYYYYYYYYYYYYYYYYYY'

/** 会话页上一切「能改动这条会话」的锚点。审计 / 归档态必须一个都不剩。 */
const MUTATION_TESTIDS = [
  'intent-composer',
  'intent-composer-submit',
  'intent-add-mount',
  'intent-open-commit',
  'intent-regenerate-draft',
] as const

interface SeededUser {
  username: string
  userId: string
  sessionToken: string
}

interface RawResponse {
  status: number
  body: string
}

interface SessionSummaryLite {
  id: string
  title: string
  status: 'active' | 'archived'
  ownerUserId?: string
}

interface SessionDetailLite {
  session: SessionSummaryLite & { inFlight: boolean }
}

interface ProvenanceRowLite {
  commitId: string
  sessionId: string
  sessionTitle: string
}

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

async function rawRequest(token: string, path: string, init?: RequestInit): Promise<RawResponse> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return { status: res.status, body: await res.text() }
}

async function jsonOf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await rawRequest(token, path, init)
  expect(res.status < 400, `${init?.method ?? 'GET'} ${path}: ${res.status} ${res.body}`).toBe(true)
  return JSON.parse(res.body) as T
}

/**
 * 把 body 里出现的 id 换成占位符再比较。
 *
 * 「同形」这件事不能只比状态码：两条 404 的 message 只要有一处不同（一条带
 * `'<id>'` 另一条不带、code 不同、details 多一个字段），调用方就能分辨「这个 id
 * 存在但我看不到」和「这个 id 根本不存在」——那正是存在性探针要的信号。
 */
function maskIds(text: string, ...ids: readonly string[]): string {
  let out = text
  for (const id of ids) out = out.split(id).join('<ID>')
  return out
}

/** RFC-099 的建号姿势：管理员建用户 → 用户名密码登录拿会话 token。
 *  ACL 的 PUT 是 tokenAccess: 'never'（routes/resourceAcl.ts:163），只有会话
 *  token 能过，所以这里一律用登录换来的 sessionToken，不用 PAT。 */
async function createUserAndLogin(opts: {
  username: string
  password: string
  role: 'admin' | 'user' | 'manager' | 'guest'
}): Promise<SeededUser> {
  const created = await rawRequest(daemon.token, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: opts.password,
    }),
  })
  expect(created.status, `createUser ${opts.username}: ${created.body}`).toBe(201)
  const { id } = JSON.parse(created.body) as { id: string }

  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  })
  expect(login.ok, `login ${opts.username}: ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { username: opts.username, userId: id, sessionToken }
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

/** RFC-231 起，所有 canonical 创建路径都是 creator-owner + private。要让第二个
 *  用户「确实看得见这个资源」（作为负向断言的正向前提），必须显式改 public。 */
async function makePublic(
  kind: 'agents' | 'skills' | 'mcps' | 'plugins' | 'workflows' | 'workgroups',
  id: string,
  token: string,
): Promise<void> {
  const acl = await jsonOf<{ aclRevision: number }>(token, `/api/${kind}/${id}/acl`)
  const res = await rawRequest(token, `/api/${kind}/${id}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      visibility: 'public',
      expectedResourceId: id,
      expectedAclRevision: acl.aclRevision,
    }),
  })
  expect(res.status, `make ${kind}/${id} public: ${res.body}`).toBe(200)
}

async function createSession(token: string, message: string): Promise<SessionSummaryLite> {
  return jsonOf<SessionSummaryLite>(token, '/api/intent-sessions', {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
}

/** 会话的结构性写（挂载 / 归档 / 重开）在有轮次在飞时一律 409，所以每个用例
 *  动手之前都要等这一轮 stub 落地。 */
async function awaitSettled(token: string, sessionId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await rawRequest(token, `/api/intent-sessions/${sessionId}`)
        if (res.status !== 200) return `http-${res.status}`
        return (JSON.parse(res.body) as SessionDetailLite).session.inFlight
          ? 'in-flight'
          : 'settled'
      },
      { timeout: 90_000, intervals: [250, 500, 1000] },
    )
    .toBe('settled')
}

async function mutationControlCounts(page: Page): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const id of MUTATION_TESTIDS) out[id] = await page.getByTestId(id).count()
  out.archiveButton = await page.getByRole('button', { name: 'Archive', exact: true }).count()
  out.reopenButton = await page.getByRole('button', { name: 'Reopen', exact: true }).count()
  return out
}

/** 会话详情页的 404 呈现：ErrorBanner 落在 .error-box（components/ErrorBanner.tsx:82）。 */
async function denialTextAt(page: Page, sessionId: string): Promise<string> {
  await page.goto(`${daemon.baseUrl}/intent/${sessionId}`)
  const banner = page.locator('.error-box').first()
  await expect(banner).toBeVisible()
  return (await banner.innerText()).trim()
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'intent' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// INTENT-45
// ---------------------------------------------------------------------------

test('INTENT-45 非成员看他人会话与看不存在的会话：状态码、响应体、页面文案逐字节同形', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'rfc319-i45-alice',
    password: 'longEnoughPassword',
    role: 'user',
  })
  const carol = await createUserAndLogin({
    username: 'rfc319-i45-carol',
    password: 'longEnoughPassword',
    role: 'user',
  })

  // 标题就是消息原文（services/intent/session.ts:279 title = message.slice(0, 80)），
  // 挑一个绝不会碰巧出现在别处的串，这样「carol 的 DOM 里不含它」是个真断言。
  const aliceGoal = 'rfc319-i45-secret-goal build a private auditing pipeline'
  const session = await createSession(alice.sessionToken, aliceGoal)
  await awaitSettled(alice.sessionToken, session.id)

  // 正向前提：这个 id 是**真的**。少了这一步，下面两条 404 可能只是「两个都不
  // 存在」，同形也就毫无意义。
  const asOwner = await rawRequest(alice.sessionToken, `/api/intent-sessions/${session.id}`)
  expect(asOwner.status, '会话本人读不到自己的会话，后面的同形比较没有意义').toBe(200)

  // ---- 读面 --------------------------------------------------------------
  const hiddenRead = await rawRequest(carol.sessionToken, `/api/intent-sessions/${session.id}`)
  const absentRead = await rawRequest(
    carol.sessionToken,
    `/api/intent-sessions/${ABSENT_SESSION_ID}`,
  )
  expect(hiddenRead.status).toBe(404)
  expect(absentRead.status).toBe(404)
  expect(
    maskIds(hiddenRead.body, session.id),
    '「存在但你没份」与「根本不存在」的响应体一旦有一个字节不同，拿 id 扫一遍' +
      '就能枚举出平台上有哪些意图会话',
  ).toBe(maskIds(absentRead.body, ABSENT_SESSION_ID))

  // ---- 写面（读同形还不够：403/409 一样能当探针用）------------------------
  const hiddenWrite = await rawRequest(
    carol.sessionToken,
    `/api/intent-sessions/${session.id}/archive`,
    { method: 'POST' },
  )
  const absentWrite = await rawRequest(
    carol.sessionToken,
    `/api/intent-sessions/${ABSENT_SESSION_ID}/archive`,
    { method: 'POST' },
  )
  expect(hiddenWrite.status).toBe(404)
  expect(absentWrite.status).toBe(404)
  expect(
    maskIds(hiddenWrite.body, session.id),
    '归档接口对「别人的会话」与「不存在的会话」必须同形，否则写面本身就是探针',
  ).toBe(maskIds(absentWrite.body, ABSENT_SESSION_ID))

  // ---- 浏览器面 ----------------------------------------------------------
  const carolSide = await openAs(browser, carol.sessionToken)
  try {
    const hiddenPage = await denialTextAt(carolSide.page, session.id)
    // 标题 / 目标原文不得出现在任何位置（页头、面包屑、错误详情折叠块）。
    await expect(
      carolSide.page.getByText(aliceGoal, { exact: false }),
      'carol 的页面上出现了 alice 的会话标题——404 页面把它要隐藏的东西直接印出来了',
    ).toHaveCount(0)
    const absentPage = await denialTextAt(carolSide.page, ABSENT_SESSION_ID)
    expect(
      maskIds(hiddenPage, session.id),
      '两次拒绝的页面文案必须逐字相同；不同就等于把「这个 id 存在」写在了界面上',
    ).toBe(maskIds(absentPage, ABSENT_SESSION_ID))
  } finally {
    await carolSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// INTENT-44
// ---------------------------------------------------------------------------

test('INTENT-44 管理员审计视图：历史一条不少，变更控件一个不剩，写面照样 404', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'rfc319-i44-alice',
    password: 'longEnoughPassword',
    role: 'user',
  })
  const carol = await createUserAndLogin({
    username: 'rfc319-i44-carol',
    password: 'longEnoughPassword',
    role: 'user',
  })

  const aliceGoal = 'rfc319-i44 build an auditor agent'
  const session = await createSession(alice.sessionToken, aliceGoal)
  await awaitSettled(alice.sessionToken, session.id)

  // carol 自己也建一条：这样她的列表非空，下面「all=1 没多出 alice 那条」才不是
  // 「列表整个坏了返回空数组」的假绿。
  const carolSession = await createSession(carol.sessionToken, 'rfc319-i44 carol own session')
  await awaitSettled(carol.sessionToken, carolSession.id)

  // ---- 列表面：all=1 只对 intent:audit 生效 -------------------------------
  const carolPlain = await rawRequest(carol.sessionToken, '/api/intent-sessions')
  const carolAll = await rawRequest(carol.sessionToken, '/api/intent-sessions?all=1')
  expect(carolPlain.status).toBe(200)
  expect(carolAll.status).toBe(200)
  expect(carolPlain.body).toContain(carolSession.id)
  expect(
    carolAll.body,
    'all=1 对没有 intent:audit 的账号必须是无操作——它一旦生效，任何登录用户' +
      '加一个查询参数就能翻遍全平台的意图会话',
  ).toBe(carolPlain.body)
  expect(carolAll.body).not.toContain(session.id)

  const adminAll = await rawRequest(daemon.token, '/api/intent-sessions?all=1')
  expect(adminAll.status).toBe(200)
  expect(adminAll.body, '管理员的 all=1 看不到别人的会话 ⇒ 审计能力整个丢了').toContain(session.id)
  expect(
    JSON.parse(adminAll.body) as SessionSummaryLite[],
    '审计列表必须带 ownerUserId，否则管理员看到一堆会话却不知道是谁的',
  ).toContainEqual(expect.objectContaining({ id: session.id, ownerUserId: alice.userId }))

  // ---- 浏览器面：先拿 owner 的基线，再看审计态 ---------------------------
  const aliceSide = await openAs(browser, alice.sessionToken)
  const adminSide = await openAs(browser, daemon.token)
  try {
    await aliceSide.page.goto(`${daemon.baseUrl}/intent/${session.id}`)
    await expect(aliceSide.page.getByTestId('intent-draft')).toBeVisible({ timeout: 60_000 })
    expect(
      await mutationControlCounts(aliceSide.page),
      '本人视图的基线不成立 ⇒ 下面「审计态全 0」是恒真断言，证明不了任何事',
    ).toEqual({
      'intent-composer': 1,
      'intent-composer-submit': 1,
      'intent-add-mount': 1,
      'intent-open-commit': 1,
      'intent-regenerate-draft': 1,
      archiveButton: 1,
      reopenButton: 0,
    })
    const ownerTurnCards = await aliceSide.page.locator('[data-testid^="intent-turn-"]').count()
    expect(ownerTurnCards).toBeGreaterThan(0)

    await adminSide.page.goto(`${daemon.baseUrl}/intent/${session.id}`)
    await expect(
      adminSide.page.getByText("You are auditing another user's intent session.", {
        exact: false,
      }),
      '审计态没有横幅 ⇒ 管理员分不清自己在看谁的会话，误操作没有任何提示',
    ).toBeVisible({ timeout: 60_000 })

    // 「完整历史可见」——按 owner 侧实际渲染出的轮次卡片数对账，不写死数字。
    await expect(adminSide.page.locator('[data-testid^="intent-turn-"]')).toHaveCount(
      ownerTurnCards,
    )
    await expect(
      adminSide.page.getByTestId('intent-turn-message'),
      '审计视图看不到用户原始诉求 ⇒ 这个视图无法用于审计',
    ).toContainText(aliceGoal)

    expect(
      await mutationControlCounts(adminSide.page),
      '审计视图渲染出任何一个变更控件 ⇒ 管理员一次误点就替别人改了资源，' +
        '而资源主人只会看到「已提交」',
    ).toEqual({
      'intent-composer': 0,
      'intent-composer-submit': 0,
      'intent-add-mount': 0,
      'intent-open-commit': 0,
      'intent-regenerate-draft': 0,
      archiveButton: 0,
      reopenButton: 0,
    })
  } finally {
    await aliceSide.context.close()
    await adminSide.context.close()
  }

  // ---- 写面：按钮不渲染 ≠ 改不动 -----------------------------------------
  const adminArchiveHidden = await rawRequest(
    daemon.token,
    `/api/intent-sessions/${session.id}/archive`,
    { method: 'POST' },
  )
  const adminArchiveAbsent = await rawRequest(
    daemon.token,
    `/api/intent-sessions/${ABSENT_SESSION_ID}/archive`,
    { method: 'POST' },
  )
  expect(adminArchiveHidden.status, '审计读旁路延伸到了写：管理员归档掉了别人的会话').toBe(404)
  expect(adminArchiveAbsent.status).toBe(404)
  expect(
    maskIds(adminArchiveHidden.body, session.id),
    '管理员的写面拒绝必须与「不存在」同形——不同形就等于把「这条会话存在」' +
      '写进了拒绝信息，同时也说明这条分支走的不是同一段守卫',
  ).toBe(maskIds(adminArchiveAbsent.body, ABSENT_SESSION_ID))

  // cancel-turn 走的是另一段守卫（routes/intentSessions.ts:910-915：先按审计权
  // 读出会话，再按 owner 拒绝），它的 message 不带 id，因此**不与不存在逐字节
  // 同形**；这不是泄露——能走到这条分支的人本来就有 intent:audit、本来就读得到
  // 这条会话。这里只锁「必须是 404、必须是同一个 code」。
  const adminCancel = await rawRequest(
    daemon.token,
    `/api/intent-sessions/${session.id}/cancel-turn`,
    { method: 'POST' },
  )
  expect(adminCancel.status, '管理员取消掉了别人正在跑的轮次').toBe(404)
  expect((JSON.parse(adminCancel.body) as { code: string }).code).toBe('intent-session-not-found')
})

// ---------------------------------------------------------------------------
// INTENT-43
// ---------------------------------------------------------------------------

test('INTENT-43 归档：整页转只读且写接口 409，重新打开后控件原样回来', async ({ browser }) => {
  const alice = await createUserAndLogin({
    username: 'rfc319-i43-alice',
    password: 'longEnoughPassword',
    role: 'user',
  })
  const session = await createSession(alice.sessionToken, 'rfc319-i43 build an auditor agent')
  await awaitSettled(alice.sessionToken, session.id)

  const side = await openAs(browser, alice.sessionToken)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/intent/${session.id}`)
    await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 60_000 })

    // (0) 活跃态基线。
    await expect(
      page.getByText('This session is archived.', { exact: false }),
      '还没归档就挂着归档横幅',
    ).toHaveCount(0)
    expect(await mutationControlCounts(page)).toEqual({
      'intent-composer': 1,
      'intent-composer-submit': 1,
      'intent-add-mount': 1,
      'intent-open-commit': 1,
      'intent-regenerate-draft': 1,
      archiveButton: 1,
      reopenButton: 0,
    })

    // (1) 归档 → 只读。
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(
      page.getByText('This session is archived. Reopen it before making further changes.', {
        exact: false,
      }),
      '归档后没有只读横幅 ⇒ 用户不知道自己为什么改不动，只会当成卡死',
    ).toBeVisible()
    expect(
      await mutationControlCounts(page),
      '归档后仍渲染变更控件 ⇒ 用户以为这条会话已封存，实际还能被继续提交',
    ).toEqual({
      'intent-composer': 0,
      'intent-composer-submit': 0,
      'intent-add-mount': 0,
      'intent-open-commit': 0,
      'intent-regenerate-draft': 0,
      archiveButton: 0,
      reopenButton: 1,
    })

    // (2) 列表上这条会话的阶段 chip 变归档态（否则用户在列表里认不出哪条封存了）。
    await page.goto(`${daemon.baseUrl}/intent`)
    await expect(page.getByTestId(`intent-stage-status-${session.id}`)).toContainText('Archived')

    // (3) 界面藏起来 ≠ 服务端拦得住：归档态的写接口必须自己 409。
    const archivedWrite = await rawRequest(
      alice.sessionToken,
      `/api/intent-sessions/${session.id}/messages`,
      { method: 'POST', body: JSON.stringify({ message: 'keep going' }) },
    )
    expect(archivedWrite.status, '归档只是前端藏了按钮，接口照收 ⇒ 归档形同虚设').toBe(409)
    expect((JSON.parse(archivedWrite.body) as { code: string }).code).toBe(
      'intent-session-archived',
    )

    // (4) 重新打开 → 控件原样回来（没有这一条，「永远只读」也能过前三步）。
    await page.goto(`${daemon.baseUrl}/intent/${session.id}`)
    await page.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect(
      page.getByText('This session is archived.', { exact: false }),
      '重新打开后横幅还在 ⇒ 用户以为没生效',
    ).toHaveCount(0)
    expect(
      await mutationControlCounts(page),
      '重新打开后控件没回来 ⇒ 归档变成了不可逆的删除',
    ).toEqual({
      'intent-composer': 1,
      'intent-composer-submit': 1,
      'intent-add-mount': 1,
      'intent-open-commit': 1,
      'intent-regenerate-draft': 1,
      archiveButton: 1,
      reopenButton: 0,
    })
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// INTENT-27
// ---------------------------------------------------------------------------

test('INTENT-27 挂载不可见资源与挂载不存在资源回同一个 404，可见的照常挂得上', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'rfc319-i27-alice',
    password: 'longEnoughPassword',
    role: 'user',
  })
  const carol = await createUserAndLogin({
    username: 'rfc319-i27-carol',
    password: 'longEnoughPassword',
    role: 'user',
  })

  const secretName = 'rfc319-i27-alice-secret'
  const sharedName = 'rfc319-i27-alice-shared'
  const createAgent = async (name: string): Promise<string> =>
    (
      await jsonOf<{ id: string }>(alice.sessionToken, '/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: 'rfc319 intent-27 fixture',
          outputs: ['answer'],
          readonly: true,
          bodyMd: 'fixture body',
        }),
      })
    ).id
  const secretAgentId = await createAgent(secretName) // RFC-231：默认就是 private
  const sharedAgentId = await createAgent(sharedName)
  await makePublic('agents', sharedAgentId, alice.sessionToken)

  const carolSession = await createSession(carol.sessionToken, 'rfc319-i27 carol session')
  await awaitSettled(carol.sessionToken, carolSession.id)

  // ---- 界面面：选择器里根本不该出现别人的私有资源 -------------------------
  const carolSide = await openAs(browser, carol.sessionToken)
  try {
    const { page } = carolSide
    await page.goto(`${daemon.baseUrl}/intent/${carolSession.id}`)
    await page.getByTestId('intent-add-mount').click()
    const picker = page.getByTestId('intent-mount-picker')
    await picker.focus() // MultiSelect 默认 openOnFocus（components/MultiSelect.tsx:290-292）
    // 正向对照先行：下拉确实开着、确实在渲染代理选项。没有它，下一条 count(0)
    // 可能只是「下拉压根没打开」。
    await expect(
      page.getByRole('option', { name: new RegExp(sharedName) }),
      '公开代理没出现在挂载选择器里 ⇒ 下面那条 count(0) 证明不了任何事',
    ).toHaveCount(1)
    await expect(
      page.getByRole('option', { name: new RegExp(secretName) }),
      '别人的私有代理出现在挂载选择器里 ⇒ 名字本身已经泄露，点一下还会把整份' +
        '资源 dump 进会话上下文喂给模型',
    ).toHaveCount(0)
  } finally {
    await carolSide.context.close()
  }

  // ---- 接口面：不可见 / 不存在必须同形 -----------------------------------
  const mount = (sessionId: string, resourceId: string): Promise<RawResponse> =>
    rawRequest(carol.sessionToken, `/api/intent-sessions/${sessionId}/mounts`, {
      method: 'POST',
      body: JSON.stringify({ resourceType: 'agent', resourceId }),
    })

  const invisible = await mount(carolSession.id, secretAgentId)
  const absent = await mount(carolSession.id, ABSENT_AGENT_ID)
  expect(invisible.status, '别人的私有代理被挂上了 —— 这是一次完整的越权读').toBe(404)
  expect(absent.status).toBe(404)
  expect(
    maskIds(invisible.body, secretAgentId),
    '「存在但你看不到」与「不存在」的挂载拒绝一旦不同形，挂载接口就是一台' + '资源 id 枚举机',
  ).toBe(maskIds(absent.body, ABSENT_AGENT_ID))
  // 这两条的 body 里本来就不含 id，顺手把字面量也钉住：任何一次「顺手把 id 写进
  // 报错信息」的改动都会在这里变红。
  expect(invisible.body).toBe(
    '{"ok":false,"code":"resource-not-found","message":"agent not found"}',
  )

  // 别人的会话：连挂载入口都不该认这个 sessionId。
  const foreignSession = await mount(ABSENT_SESSION_ID, sharedAgentId)
  const carolIntoAliceSession = await rawRequest(
    carol.sessionToken,
    `/api/intent-sessions/${carolSession.id}/mounts`,
    { method: 'POST', body: JSON.stringify({ resourceType: 'agent', resourceId: sharedAgentId }) },
  )
  expect(foreignSession.status).toBe(404)

  // ---- 正向对照：可见资源确实挂得上（否则上面全是「挂载整个坏了」）--------
  expect(
    carolIntoAliceSession.status,
    '可见资源都挂不上 ⇒ 上面三条 404 只能证明挂载功能坏了，证明不了权限',
  ).toBe(201)
})

// ---------------------------------------------------------------------------
// INTENT-X1
// ---------------------------------------------------------------------------

interface EntrySurface {
  label: string
  path: string
  entryTestId: string
  /** 页面确实渲染出来了的正向锚点：没有它，count(0) 可能只是页面报错。 */
  anchor: (page: Page) => Locator
}

async function assertEntryVisibility(
  browser: Browser,
  token: string,
  surfaces: readonly EntrySurface[],
  expected: 0 | 1,
): Promise<void> {
  const side = await openAs(browser, token)
  try {
    for (const surface of surfaces) {
      await side.page.goto(`${daemon.baseUrl}${surface.path}`)
      await expect(
        surface.anchor(side.page),
        `${surface.label}：页面本身没渲染出来，这一页的入口断言无效`,
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        side.page.getByTestId(surface.entryTestId),
        expected === 0
          ? `${surface.label}：没有 intent:write 却渲染了入口按钮 ⇒ 用户点进去只能吃 403`
          : `${surface.label}：有 intent:write 却没有入口按钮 ⇒ 功能整体不可达`,
      ).toHaveCount(expected)
      if (expected === 0) {
        // testid 只是锚点，不是契约。按可见文案再扫一遍，挡住「换了个 testid 重新
        // 落一个同样的按钮」这类改动。
        await expect(side.page.getByText('Build via intent', { exact: true })).toHaveCount(0)
        await expect(side.page.getByText('Modify via intent', { exact: true })).toHaveCount(0)
      }
    }
  } finally {
    await side.context.close()
  }
}

test('INTENT-X1 没有 intent:write：六类资源页的「用 AI 构建 / 修改」入口整体不挂载', async ({
  browser,
}) => {
  // guest 是产品里唯一「登录了、看得见资源、但没有 intent:*」的档位
  // （shared/schemas/permission.ts:914-923 GUEST_BASELINE）。角色预设只能加不能减，
  // 所以低权用户只能从 guest 造。
  const guest = await createUserAndLogin({
    username: 'rfc319-x1-guest',
    password: 'longEnoughPassword',
    role: 'guest',
  })
  const writer = await createUserAndLogin({
    username: 'rfc319-x1-writer',
    password: 'longEnoughPassword',
    role: 'user',
  })

  const agent = await jsonOf<{ id: string }>(daemon.token, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1-agent',
      description: 'rfc319 x1 fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'fixture body',
    }),
  })
  const skill = await jsonOf<{ id: string }>(daemon.token, '/api/skills', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1-skill',
      description: 'rfc319 x1 fixture',
      bodyMd: '# fixture\n',
    }),
  })
  const mcp = await jsonOf<{ id: string }>(daemon.token, '/api/mcps', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1-mcp',
      description: 'rfc319 x1 fixture',
      type: 'remote',
      config: { url: 'http://127.0.0.1:1/mcp', oauth: false },
      enabled: true,
    }),
  })
  const plugin = await jsonOf<{ id: string }>(daemon.token, '/api/plugins', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1-plugin',
      spec: daemon.stubOpencode,
      description: 'rfc319 x1 fixture',
      enabled: true,
    }),
  })
  const workflow = await jsonOf<{ id: string }>(daemon.token, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1-workflow',
      description: '',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    }),
  })
  const workgroup = await jsonOf<{ id: string }>(daemon.token, '/api/workgroups', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1-workgroup',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'Lead',
      maxRounds: 2,
      completionGate: false,
      members: [
        { memberType: 'agent', agentId: agent.id, displayName: 'Lead' },
        { memberType: 'agent', agentId: agent.id, displayName: 'Member' },
      ],
    }),
  })
  await makePublic('agents', agent.id, daemon.token)
  await makePublic('skills', skill.id, daemon.token)
  await makePublic('mcps', mcp.id, daemon.token)
  await makePublic('plugins', plugin.id, daemon.token)
  // 画廊页在「列表真空且有空态主行动」时会整块吞掉 headerActions
  // （components/gallery/ResourceGalleryPage.tsx:89）——不铺一条可见数据，
  // 有权账号那半边的正向对照会因为一个无关原因变绿。
  await makePublic('workflows', workflow.id, daemon.token)
  await makePublic('workgroups', workgroup.id, daemon.token)

  const detailAnchor = (page: Page): Locator => page.getByTestId('detail-more-actions')
  const surfaces: readonly EntrySurface[] = [
    {
      label: '代理详情',
      path: `/agents/${agent.id}`,
      entryTestId: 'agent-intent-entry',
      anchor: detailAnchor,
    },
    {
      label: '技能详情',
      path: `/skills/${skill.id}`,
      entryTestId: 'skill-intent-entry',
      anchor: detailAnchor,
    },
    {
      label: 'MCP 详情',
      path: `/mcps/${mcp.id}`,
      entryTestId: 'mcp-intent-entry',
      anchor: detailAnchor,
    },
    {
      label: '插件详情',
      path: `/plugins/${plugin.id}`,
      entryTestId: 'plugin-intent-entry',
      anchor: detailAnchor,
    },
    {
      label: '工作流列表',
      path: '/workflows',
      entryTestId: 'workflows-intent-entry',
      anchor: (page) => page.getByRole('heading', { name: 'Workflows', exact: true }),
    },
    {
      label: '工作组列表',
      path: '/workgroups',
      entryTestId: 'workgroups-intent-entry',
      anchor: (page) => page.getByRole('heading', { name: 'Workgroups', exact: true }),
    },
  ]

  await assertEntryVisibility(browser, guest.sessionToken, surfaces, 0)
  // 正向对照：同样六页、同样六个资源，换成有 intent:write 的账号，入口一个不少。
  await assertEntryVisibility(browser, writer.sessionToken, surfaces, 1)
})

test('INTENT-X1 工作流编辑器与工作组详情的入口同样按 intent:write 收放', async ({ browser }) => {
  // 这两处**不在**画廊页上，其中工作组详情用的是手写的 `canWriteIntent &&`
  // （routes/workgroups.detail.tsx:929），不是共享的 IntentEntryButton——
  // 只断言共享组件的用例覆盖不到它。工作流编辑器走共享组件，但入口藏在编辑器
  // 头部，与详情页是另一条渲染路径，一并锁住。
  const guest = await createUserAndLogin({
    username: 'rfc319-x1b-guest',
    password: 'longEnoughPassword',
    role: 'guest',
  })
  const writer = await createUserAndLogin({
    username: 'rfc319-x1b-writer',
    password: 'longEnoughPassword',
    role: 'user',
  })

  const agent = await jsonOf<{ id: string }>(daemon.token, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1b-agent',
      description: 'rfc319 x1b fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'fixture body',
    }),
  })
  const workflow = await jsonOf<{ id: string }>(daemon.token, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1b-workflow',
      description: '',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    }),
  })
  const workgroup = await jsonOf<{ id: string }>(daemon.token, '/api/workgroups', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-x1b-workgroup',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'Lead',
      maxRounds: 2,
      completionGate: false,
      members: [
        { memberType: 'agent', agentId: agent.id, displayName: 'Lead' },
        { memberType: 'agent', agentId: agent.id, displayName: 'Member' },
      ],
    }),
  })
  await makePublic('agents', agent.id, daemon.token)
  await makePublic('workflows', workflow.id, daemon.token)
  await makePublic('workgroups', workgroup.id, daemon.token)

  const check = async (token: string, expected: 0 | 1): Promise<void> => {
    const side = await openAs(browser, token)
    try {
      const { page } = side
      await page.goto(`${daemon.baseUrl}/workflows/${workflow.id}`)
      await expect(
        page.getByRole('heading', { name: 'rfc319-x1b-workflow', exact: true }),
        '工作流编辑器没打开，入口断言无效',
      ).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('workflow-intent-entry')).toHaveCount(expected)

      await page.goto(`${daemon.baseUrl}/workgroups/${workgroup.id}`)
      await page.getByTestId('workgroup-more-actions').click()
      const actions = page.getByRole('dialog')
      await expect(actions, '工作组的 More 弹窗没打开，入口断言无效').toBeVisible({
        timeout: 30_000,
      })
      await expect(
        actions.getByTestId('workgroup-intent-entry'),
        expected === 0
          ? '没有 intent:write 却在工作组动作列表里渲染了入口 ⇒ 点了只能吃 403'
          : '有 intent:write 却没有工作组入口 ⇒ 这条路径整体不可达',
      ).toHaveCount(expected)
    } finally {
      await side.context.close()
    }
  }

  await check(guest.sessionToken, 0)
  await check(writer.sessionToken, 1)
})

// ---------------------------------------------------------------------------
// INTENT-11 —— 唯一一条真正提交草稿的用例，因此声明在最后：intent stub 每轮产出
// 的都是同名代理 `e2e-auditor`，提交第二次会撞占用名。
// ---------------------------------------------------------------------------

test('INTENT-11 provenance 徽章：源会话可见者点得回去，不可见者 DOM 里一个都没有', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'rfc319-i11-alice',
    password: 'longEnoughPassword',
    role: 'user',
  })
  const carol = await createUserAndLogin({
    username: 'rfc319-i11-carol',
    password: 'longEnoughPassword',
    role: 'user',
  })

  const aliceGoal = 'rfc319-i11-private-goal build me an auditor agent'
  const aliceSide = await openAs(browser, alice.sessionToken)
  let sessionId = ''
  let agentId = ''
  try {
    const { page } = aliceSide
    await page.goto(`${daemon.baseUrl}/intent`)
    const composer = page.getByTestId('intent-create-inline')
    await composer.getByTestId('intent-create-message').fill(aliceGoal)
    await composer.getByRole('button', { name: 'Start building' }).click()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
    await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 60_000 })
    sessionId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    expect(sessionId).not.toBe('')

    await page.getByTestId('intent-open-commit').click()
    await page.getByTestId('intent-commit-next').click()
    await page.getByTestId('intent-commit-next').click()
    await page.getByTestId('intent-commit-submit').click()
    await expect(page.getByText('Committed', { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })

    const agents = await jsonOf<Array<{ id: string; name: string }>>(
      alice.sessionToken,
      '/api/agents',
    )
    const landed = agents.find((row) => row.name === 'e2e-auditor')
    expect(landed, '提交没有真的落下资源 ⇒ 后面整条 provenance 断言都是空的').toBeTruthy()
    agentId = landed?.id ?? ''

    // 源会话可见者：徽章在，而且点得回那一条会话（这是它存在的全部理由）。
    await page.goto(`${daemon.baseUrl}/agents/${agentId}`)
    const badge = page.getByTestId('intent-provenance-badge')
    await expect(badge, '会话本人看不到 provenance 徽章 ⇒ 追溯能力整个丢了').toBeVisible({
      timeout: 30_000,
    })
    await badge.click()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
    expect(new URL(page.url()).pathname, '徽章跳去了别的会话 ⇒ 追溯指向错误的来源').toBe(
      `/intent/${sessionId}`,
    )

    // 关键前提：把资源改成 public。不这么做的话，carol 连详情页都打不开，
    // 「徽章计数为 0」就变成了一条恒真断言。
    await makePublic('agents', agentId, alice.sessionToken)
  } finally {
    await aliceSide.context.close()
  }

  const carolSide = await openAs(browser, carol.sessionToken)
  try {
    const { page } = carolSide
    await page.goto(`${daemon.baseUrl}/agents/${agentId}`)
    // 正向前提：carol 确实看到了这个资源的完整详情页。
    await expect(page.getByRole('heading', { name: 'e2e-auditor', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId('detail-more-actions')).toBeVisible()

    await expect(
      page.getByTestId('intent-provenance-badge'),
      '看不到源会话的人却看到了 provenance 徽章 ⇒ 泄露了「这个资源是谁用意图' +
        '构建器做的、源会话在哪」；点进去再 404 兜底不算数，DOM 里出现就已经泄露',
    ).toHaveCount(0)
    await expect(
      page.getByText(aliceGoal, { exact: false }),
      'alice 的会话标题出现在 carol 的资源页上',
    ).toHaveCount(0)
    await expect(page.getByText('Intent-built', { exact: true })).toHaveCount(0)
  } finally {
    await carolSide.context.close()
  }

  // 接口面：不可见的源会话与「这个资源上根本没有 provenance」必须同形（都是 []），
  // 否则 provenance 端点会变成「谁用意图构建器建过东西」的探针。
  const carolOnReal = await rawRequest(
    carol.sessionToken,
    `/api/intent-provenance/agent/${agentId}`,
  )
  const carolOnAbsent = await rawRequest(
    carol.sessionToken,
    `/api/intent-provenance/agent/${ABSENT_AGENT_ID}`,
  )
  expect(carolOnReal.status).toBe(200)
  expect(carolOnAbsent.status).toBe(200)
  expect(
    maskIds(carolOnReal.body, agentId),
    'provenance 端点对「有来源但你看不到源会话」与「资源根本不存在」必须同形',
  ).toBe(maskIds(carolOnAbsent.body, ABSENT_AGENT_ID))
  expect(carolOnReal.body).toBe('[]')

  const aliceOnReal = await jsonOf<ProvenanceRowLite[]>(
    alice.sessionToken,
    `/api/intent-provenance/agent/${agentId}`,
  )
  expect(
    aliceOnReal.map((row) => row.sessionId),
    '源会话本人也读不到 provenance ⇒ 上面那条 [] 只能证明这条链路整个坏了',
  ).toEqual([sessionId])
})
