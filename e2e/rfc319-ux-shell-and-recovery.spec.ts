// RFC-319 —— 前端横切：外壳、进出场与恢复路径
// （UX-04 / 09 / 11 / 32 / 38 / 43 / 44 / X2 / X4）。
//
// 这一组管的是**用户进得来、回得去、断了能接上**。它们的共同点是：坏掉的时候没有任何
// 服务端错误可查，症状全在浏览器里，而且往往被当成「网络卡了一下」：
//
//   * 【UX-04】分享出去的深链接带着查询串（`?path=docs/report.md` 这种 Markdown 预览
//     链接）。未登录的人点开 → 登录 → 落回去时查询串被吃掉，页面变成「链接无效」。
//     用户只知道「他发我的链接是坏的」，发链接的人怎么试都是好的（他已经登录了）。
//     反方向同样致命：`?redirect=` 是从 URL 上来的，不设防就是一个开放重定向。
//   * 【UX-09】全新部署的第一步：守护进程打印一条带一次性 token 的 URL。这条 URL 会被
//     粘进聊天窗、留在浏览器历史和地址栏里。token 必须**在任何请求发出之前**从可见 URL
//     上抹掉，同时人要被送到 `/setup/admin` 去建第一个管理员——抹早了进不去，抹晚了
//     泄露，两边都错不得。
//   * 【UX-11】`/api/auth/me` 解不出来时，页面**不能抢跑**：既不能拿着空权限把已授权
//     路由渲染出来（它的每个查询都只会 403），也不能白屏。正确形态是一条可重试的横幅，
//     重试成功后正常进入。
//   * 【UX-32】WS 断了要自己接回来，而且**接回来之后要补上断线期间错过的那一段**。
//     只重连不补偿的症状最阴：连接指示是好的，列表却永远停在断线那一刻。
//   * 【UX-38】敲错一个 URL：不能白屏、不能把人踢回登录页、外壳要还在、点一下能回去。
//   * 【UX-43】引导巡览的进度写在浏览器里。刷新丢进度 = 用户被打回第一步；退出巡览没
//     清干净 = 他下次打开任何页面都被那层蒙版罩住，且没有别的出口。
//   * 【UX-44】首启欢迎屏上只有一个主行动。它通不到那三条引导流程，新装的平台第一屏
//     就是一个死按钮。
//   * 【UX-X2】纯 http 的局域网部署不是安全上下文，`navigator.clipboard` 根本不存在。
//     「复制」按钮必须走 execCommand 兜底并把焦点还回来——尤其是**只显示一次**的 PAT
//     明文，复制失败 = 这次签发白做，而令牌已经在服务端存在了。
//   * 【UX-X4】列表里的相对时间靠一个共享的 30s 时钟自己往前走。它停了，用户会对着
//     一个写着「just now」的十分钟前的行做判断。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链）：
//   * 深链接存原样：packages/frontend/src/routes/__root.tsx:38-48（`location.href` 而非 pathname）
//   * 开放重定向防线：packages/frontend/src/routes/auth.tsx:29-32（`^\/(?![/\\])`）
//   * 登录后落回：packages/frontend/src/routes/auth.tsx:206
//   * 预览页的「链接无效」态：packages/frontend/src/routes/tasks.preview.tsx:71-77
//   * 一次性 token 解析与擦除：packages/frontend/src/lib/bootstrap-token.ts:18-29
//     与 packages/frontend/src/routes/__root.tsx:24-37
//   * 交接页跳转：packages/frontend/src/routes/auth.tsx:168、:34-36
//   * 授权未解出时的挂起态：packages/frontend/src/components/shell/AppShell.tsx:108-124、224-252
//   * WS 重连与退避：packages/frontend/src/hooks/useWebSocket.ts:236-247、249-254
//   * 重连补偿：packages/frontend/src/hooks/useWsInvalidation.ts:117-124
//     与 packages/frontend/src/hooks/useMemoryWs.ts:69-73（`reconcileOnOpen: broadSurface`）
//   * 巡览进度持久化：packages/frontend/src/components/tour/SpotlightTour.tsx:66-103、119-133
//   * 首启屏与三条流程：packages/frontend/src/components/Onboarding.tsx:93、124-150
//     与 packages/frontend/src/routes/onboarding.tsx:24-28
//   * 剪贴板兜底：packages/frontend/src/lib/clipboard.ts:11-21、23-66
//   * 共享 30s 时钟：packages/frontend/src/hooks/useNowTick.ts:11-36
//     与 packages/frontend/src/components/RelativeTime.tsx:20-48
//
// 与既有用例的分工（务必不要重复）：
//   * e2e/identity-access.spec.ts IAM-05/06 —— 「登录表单能进应用 + 三类拒绝可读」。
//     本文件 UX-04 覆盖的是它**没有**碰的一侧：`?redirect=` 由守卫**自己生成**、且必须
//     连查询串一起原样带回来；以及那个参数本身不能被用来打外站。
//   * e2e/identity-access.spec.ts IAM-01/03 —— 交接页本身（已用 localStorage 预置凭据）。
//     本文件 UX-09 覆盖的是它前面那一段：**从 URL 上的 token 走进来**并把它擦掉。
//   * e2e/live-list-updates.spec.ts UX-30 —— WS 连着时的实时更新。本文件 UX-32 覆盖的是
//     连接**断掉又接回来**的那一段，且刻意让变更发生在断线窗口内。
//   * e2e/tour-spotlight.spec.ts —— 巡览的步进语义（点击式步进 / 锚点定位）。
//     本文件 UX-43 只覆盖它没碰的两件事：进度写不写得住、退出清不清得干净。
//   * e2e/rfc319-overview-and-docs.spec.ts —— 首启屏出现/消失的条件与权限门。
//     本文件 UX-44 覆盖的是它下游：那个唯一主行动**通到哪里**。
//   * e2e/rfc319-agent-delete-and-refs.spec.ts AGENT-X2 —— 列表读失败三态。本文件不重复。
//
// 两条纪律的自证（本文件里这两个词只出现在注释中）：
//   * 不用 `describe.configure({ mode: 'serial' })` —— 变异验证要靠「红了几条」归因，
//     serial 下第一条红之后其余 did not run，归因不出来。
//   * `page.route` 的 handler 里没有 `route.fetch()` —— 用 `fulfill` / `fallback`，
//     并在 afterEach 里 `unrouteAll({ behavior: 'wait' })`。

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(150_000)

interface RecordedSocket {
  url: string
  socket: WebSocket
}

declare global {
  interface Window {
    /** UX-32 —— 测试侧记录的所有 WebSocket 实例（由 addInitScript 注入的壳收集）。 */
    __rfc319Sockets?: RecordedSocket[]
    /** UX-32 —— 置真时，指向 `/ws/memories` 的新连接一律构造失败，模拟链路仍然断着。 */
    __rfc319BlockMemoryWs?: boolean
  }
}

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test.afterEach(async ({ page }) => {
  // 先摘掉全部 handler，再趁 page 还活着把已经在飞的等完（docs/dev-gotchas.md 锁 B）。
  await page.unrouteAll({ behavior: 'wait' })
})

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function primeToken(target: Page, token: string, baseUrl = daemon.baseUrl): Promise<void> {
  await target.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: baseUrl, tok: token },
  )
}

/** 只装 baseUrl / 语言，**不装凭据** —— 未登录路径要的正是这个起点。 */
async function primeAnonymous(target: Page, baseUrl = daemon.baseUrl): Promise<void> {
  await target.addInitScript(
    ({ url }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: baseUrl },
  )
}

async function api(
  path: string,
  init?: RequestInit,
  token: string = daemon.token,
  baseUrl: string = daemon.baseUrl,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
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

let userSequence = 0

async function seedUser(role: 'admin' | 'user'): Promise<{ username: string; password: string }> {
  userSequence += 1
  const username = `rfc319-ux-${role}-${userSequence}`
  const password = 'Rfc319UxShell!2026'
  const created = await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      displayName: username,
      role,
      password,
    }),
  })
  expect(created.status, `create ${username}: ${await created.text().catch(() => '')}`).toBe(201)
  return { username, password }
}

async function signInWithForm(
  target: Page,
  who: { username: string; password: string },
): Promise<void> {
  const form = target.getByTestId('auth-password-form')
  await expect(form).toBeVisible({ timeout: 30_000 })
  await form.getByLabel(/^Username/).fill(who.username)
  await form.getByLabel(/^Password/).fill(who.password)
  await form.getByRole('button', { name: 'Sign in' }).click()
}

// --------------------------------------------------------------------------
// UX-04 —— 深链接经登录回环后原样恢复；`?redirect=` 不能被用来打外站
// --------------------------------------------------------------------------

test('RFC-319 UX-04: 未登录点开带查询串的深链接，登录后原样回到那一页（不退化成「链接无效」），而外站地址一律不采信 @nightly', async ({
  page,
}) => {
  const who = await seedUser('user')
  await primeAnonymous(page)

  // 一条真实会被分享出去的链接：Markdown 预览完全由查询串决定看什么
  // （routes/tasks.preview.tsx:37-40 的 validateSearch → resolvePreviewSource）。
  // 任务 id 是否存在与本条无关：`?path=` 丢了，页面立刻退化成「链接无效」。
  const deepPath = '/tasks/rfc319-ux04-task/preview'
  const deepHref = `${deepPath}?path=docs%2Freport.md&title=Q3+report`

  await page.goto(`${daemon.baseUrl}${deepHref}`)
  await expect(page, '未登录直击深链接没有被送到登录页').toHaveURL(/\/auth\?/)

  // ① 守卫**自己生成**的那个 redirect 必须是完整的相对 href，不是光秃秃的 pathname。
  const handedBack = new URL(page.url()).searchParams.get('redirect')
  expect(handedBack, '登录页没有收到任何回跳目标 ⇒ 深链接在这一步就丢了').not.toBeNull()
  const handedBackUrl = new URL(handedBack ?? '', daemon.baseUrl)
  expect(handedBackUrl.pathname, '回跳目标的路径都不对').toBe(deepPath)
  expect(
    handedBackUrl.searchParams.get('path'),
    '回跳目标只留下了路径、把查询串吃掉了 ⇒ 登录之后用户会落在一张「链接无效」上，' +
      '而分享链接的人（他已登录）怎么试都是好的',
  ).toBe('docs/report.md')

  // ② 走完登录，人必须落回**那一页**，而且那一页真的拿到了参数。
  await signInWithForm(page, who)
  await expect(page, '登录后没有回到原目标页').toHaveURL(new RegExp(`${deepPath}\\?`))
  const landed = new URL(page.url())
  expect(landed.searchParams.get('path'), '登录后回到了目标页，但查询串在半路被吃掉了').toBe(
    'docs/report.md',
  )
  await expect(
    page.getByTestId('md-preview-invalid'),
    '深链接过了登录回环之后退化成「链接无效」⇒ 这正是 RFC-105 修的那个形态',
  ).toHaveCount(0, { timeout: 30_000 })
  await expect(
    page.locator('.md-preview__title'),
    '预览页没有按 ?title= / ?path= 认出自己在看什么',
  ).toHaveText('Q3 report')

  // ③ 反方向：`?redirect=` 来自 URL，不设防就是一个开放重定向——
  //    「登录后自动跳去攻击者的站点」是钓鱼最省事的一步。
  await page.goto(`${daemon.baseUrl}/auth?redirect=${encodeURIComponent('https://evil.example/x')}`)
  await signInWithForm(page, who)
  await expect(page, '登录后跟着一个外站地址走了 ⇒ 登录页可以被拿去做开放重定向').toHaveURL(
    /\/agents(\?|$)/,
  )

  // ④ 同一道防线的另一半：**协议相对**地址。`//evil.example/x` 不以 `http` 开头、
  //    却被浏览器当成「跳到另一个主机」——`safeInternalRedirect` 的
  //    `/^\/(?![/\\])/` 里那个 lookahead 就是专为它写的（反斜杠变体同理）。
  //    只试 `https://…` 会漏掉这半边：把 lookahead 去掉、只留 `/^\//`，绝对地址那条
  //    照样被拒、用例照样绿，而 `//evil.example` 已经放行了。（2026-08-26 变异实测）
  for (const hostile of ['//evil.example/x', '/\\evil.example/x']) {
    await page.goto(`${daemon.baseUrl}/auth?redirect=${encodeURIComponent(hostile)}`)
    await signInWithForm(page, who)
    await expect(
      page,
      `登录后跟着 ${hostile} 走了 ⇒ 协议相对/反斜杠形态绕过了开放重定向防线`,
    ).toHaveURL(/\/agents(\?|$)/)
  }
})

// --------------------------------------------------------------------------
// UX-09 —— 首启：bootstrap token 落地 → 地址栏擦除 → /setup/admin
// --------------------------------------------------------------------------

test('RFC-319 UX-09: 带一次性 token 的首启链接进来后，地址栏当场不再有它，人被送到建管理员那一屏，且原本要去的页面被记住 @nightly', async ({
  page,
}) => {
  // `bootstrap` 模式刻意不替我们完成交接，留下那条一次性凭据。
  const fresh = await startDaemon({ authMode: 'bootstrap' })
  try {
    const oneTime = fresh.bootstrapToken
    expect(oneTime, '全新守护进程没有打印一次性 token ⇒ 这条首启路径根本走不通').not.toBeNull()
    await primeAnonymous(page, fresh.baseUrl)

    // 守护进程打印的形态是「URL + ?token=」。这里刻意落在一个**深页面**上，
    // 因为真实场景里管理员常常是点着别人发的链接进来的。
    await page.goto(
      `${fresh.baseUrl}/memory?tab=approval-queue&token=${encodeURIComponent(oneTime ?? '')}`,
    )

    // ① 人被送到建首个管理员那一屏。
    await expect(page, '带着一次性 token 进来却没有被送去建管理员').toHaveURL(
      /\/setup\/admin(\?|$)/,
      { timeout: 30_000 },
    )
    await expect(
      page.getByRole('button', { name: 'Complete secure handoff' }),
      '交接页没有渲染出来 ⇒ 新部署的第一屏是空的',
    ).toBeVisible({ timeout: 30_000 })

    // ② 地址栏上**当场**不再有那条凭据。它会留在浏览器历史、被粘进聊天窗、
    //    被同事看见——这条链上任何一环没擦干净都是泄露。
    const finalUrl = page.url()
    expect(finalUrl.includes('token='), `地址栏里还留着一次性凭据的参数：${finalUrl}`).toBe(false)
    expect(finalUrl.includes(oneTime ?? ' never'), '地址栏里还留着一次性凭据的明文').toBe(false)

    // ③ 原本要去的那一页被记住了——交接完不该把人丢在默认页。
    const carried = new URL(finalUrl).searchParams.get('redirect')
    expect(carried, '首启链接指向的目标页在交接这一步被丢掉 ⇒ 管理员建完账号得自己再找一遍路').toBe(
      '/memory?tab=approval-queue',
    )

    // ④ 凭据被擦掉的是**可见 URL**，不是它本身：交接页此刻必须真的持有它，
    //    否则这一屏是个走不下去的死胡同。
    const held = await page.evaluate(() => window.localStorage.getItem('agent-workflow.token'))
    expect(held, '可见 URL 擦干净了，凭据也一起丢了 ⇒ 交接页点下去只会失败').toBe(oneTime)
  } finally {
    await fresh.stop()
  }
})

// --------------------------------------------------------------------------
// UX-11 —— 权威解不出来时的挂起态
// --------------------------------------------------------------------------

test('RFC-319 UX-11: 当前账号权限解不出来时，页面不抢跑也不白屏——只给一条可重试的横幅，重试成功后正常进入 @nightly', async ({
  page,
}) => {
  await primeToken(page, daemon.token)

  const requested: string[] = []
  page.on('request', (request) => {
    requested.push(new URL(request.url()).pathname)
  })

  let failing = true
  await page.route(
    (url) => url.pathname === '/api/auth/me',
    async (route) => {
      if (!failing) {
        await route.fallback()
        return
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'internal-error', message: 'rfc319 injected authority read' }),
      })
    },
  )

  await page.goto(`${daemon.baseUrl}/memory?tab=approval-queue`)

  const banner = page.getByTestId('authority-refresh-error')
  await expect(
    banner,
    '权限读不出来时既没有横幅也没有加载态 ⇒ 用户对着一片空白，不知道是没数据还是坏了',
  ).toBeVisible({ timeout: 30_000 })

  // 抢跑的两种形态都要挡住：把路由渲染出来（它的查询只会 403），
  // 或者干脆去打那些注定被拒的接口。
  await expect(
    page.getByTestId('app-shell-route-content'),
    '权限还没解出来就把已授权路由挂了上去 ⇒ 用户看到的是一屏注定 403 的空面板',
  ).toHaveCount(0)
  expect(
    requested.filter((path) => path.startsWith('/api/memories')),
    '权限未解出就已经去打受权限保护的接口 ⇒ 每一发都只会被拒，且用户看不到原因',
  ).toEqual([])

  // 恢复路径必须是**页面上的**那个按钮，不是「刷新整页」。
  failing = false
  await banner.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    page.getByTestId('memory-section-panel'),
    '点了重试仍然进不去 ⇒ 这条横幅只是报丧，没有出路',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByTestId('authority-refresh-error'),
    '已经进去了，横幅还挂着 ⇒ 用户不敢相信眼前这一屏是好的',
  ).toHaveCount(0)

  // 上面那条「一发都没打过」如果永远成立就是一句空话——这一页正常打开时**必然**
  // 会打 /api/memories*。钉住它，那条前置断言才有意义。
  await expect
    .poll(() => requested.filter((path) => path.startsWith('/api/memories')).length, {
      message: '进去之后也没有打过 /api/memories ⇒ 前面那条「一发都没打」是恒真的',
      timeout: 20_000,
    })
    .toBeGreaterThan(0)
})

// --------------------------------------------------------------------------
// UX-32 —— WS 断线重连 + 重连后的补偿
// --------------------------------------------------------------------------

test('RFC-319 UX-32: 实时通道断掉后自己接回来，并补上断线那一段错过的变更——不是「连着但永远停在断线那一刻」 @nightly', async ({
  page,
}) => {
  await primeToken(page, daemon.token)
  // 记录每一条被创建的 WebSocket，并留一个开关让「重连」在一段时间内持续失败：
  // 变更必须确确实实发生在**断线窗口内**，否则这条用例会被普通的实时推送蒙混过关
  //（那一段由 e2e/live-list-updates.spec.ts UX-30 负责）。
  await page.addInitScript(() => {
    const Native = window.WebSocket
    const opened: RecordedSocket[] = []
    window.__rfc319Sockets = opened
    class Recorded extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (window.__rfc319BlockMemoryWs === true && String(url).includes('/ws/memories')) {
          throw new Error('rfc319: memory channel is still down')
        }
        super(url, protocols)
        opened.push({ url: String(url), socket: this })
      }
    }
    window.WebSocket = Recorded as unknown as typeof WebSocket
  })

  const memorySockets = async (): Promise<number> =>
    page.evaluate(
      () => (window.__rfc319Sockets ?? []).filter((s) => s.url.includes('/ws/memories')).length,
    )

  await page.goto(`${daemon.baseUrl}/memory?tab=approval-queue`)
  await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
  await expect.poll(memorySockets, { message: '页面根本没有建立实时通道', timeout: 30_000 }).toBe(1)

  // 拔线：先把新连接堵死，再关掉现有那条。
  await page.evaluate(() => {
    window.__rfc319BlockMemoryWs = true
    for (const s of window.__rfc319Sockets ?? []) {
      if (s.url.includes('/ws/memories')) s.socket.close()
    }
  })
  // 等关闭握手真的走完再造变更。`close()` 只是把 readyState 推到 CLOSING，
  // 期间到达的帧仍可能被派发——那样这条用例会被一次普通实时推送蒙混过关。
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.__rfc319Sockets ?? [])
            .filter((s) => s.url.includes('/ws/memories'))
            .every((s) => s.socket.readyState === WebSocket.CLOSED),
        ),
      { message: '实时通道没有真的断开 ⇒ 下面的断线窗口不成立', timeout: 20_000 },
    )
    .toBe(true)

  const title = `rfc319-ux32-${Date.now().toString(36)}`
  const created = await jsonOf<{ memory: { id: string } }>(
    await api('/api/memories', {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'global',
        scopeId: null,
        title,
        bodyMd: 'RFC-319 UX-32 offline-window fixture.',
      }),
    }),
    'create memory during the outage',
  )
  expect(created.memory.id.length, '夹具没建出来').toBeGreaterThan(0)

  // 断线期间这条变更当然看不见——先钉住这个前提，
  // 否则下面那条「它出现了」可能只是某个轮询顺手带回来的。
  expect(await memorySockets(), '通道明明堵着却又连上了 ⇒ 下面的断线窗口不成立').toBe(1)
  await expect(
    page.getByText(title),
    '通道断着，界面却已经拿到了断线期间的变更 ⇒ 这条用例测不到补偿',
  ).toHaveCount(0)

  // 接回来。
  await page.evaluate(() => {
    window.__rfc319BlockMemoryWs = false
  })
  await expect
    .poll(memorySockets, {
      message: '通道断了就再也没接回来 ⇒ 用户面前是一个永远静止的页面，且没有任何提示',
      timeout: 40_000,
    })
    .toBeGreaterThanOrEqual(2)

  // 补偿：重连本身不够，断线期间错过的那一段必须补回来。
  await expect(
    page.getByText(title),
    '重连了却不补断线期间错过的变更 ⇒ 连接指示是好的、数据永远停在断线那一刻，' +
      '这是所有失效形态里最难被发现的一种',
  ).toBeVisible({ timeout: 40_000 })
})

// --------------------------------------------------------------------------
// UX-38 —— 未知路由
// --------------------------------------------------------------------------

test('RFC-319 UX-38: 敲错一个 URL 不白屏、不被踢回登录页，外壳还在、点一下就能回到正常页面 @nightly', async ({
  page,
}) => {
  await primeToken(page, daemon.token)

  const unknown = '/rfc319-no-such-page'
  await page.goto(`${daemon.baseUrl}${unknown}`)

  // ① 不许把人踢去登录（已登录用户被要求重新登录，是最容易被当成「掉线」的假故障）。
  await expect(page, '未知路由把已登录的用户送去了登录页 ⇒ 一个打错的字看起来像掉线').toHaveURL(
    new RegExp(`${unknown}$`),
  )

  // ② 外壳还在，人还能走出去。
  await expect(
    page.getByTestId('desktop-sidebar'),
    '未知路由连外壳都没了 ⇒ 用户只能靠浏览器后退，且不知道自己还登着',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByTestId('app-shell-route-content'),
    '未知路由被当成「权限未解出」挂起 ⇒ 页面停在加载态，永远等不到东西',
  ).toHaveCount(1)

  // ③ 不许拿别的页面来冒充。静默落到首页/列表页比报错更糟：
  //    用户以为链接是对的，实际看的是另一份数据。
  await expect(
    page.getByTestId('homepage'),
    '未知路由被静默画成了首页 ⇒ 用户以为链接有效，看的却是别的东西',
  ).toHaveCount(0)
  await expect(page.getByTestId('split-cards')).toHaveCount(0)

  // ④ 走得出去：点侧栏就回到正常页面（不需要刷新、不需要手敲 URL）。
  await page.getByTestId('desktop-sidebar').getByRole('link', { name: 'Agents' }).click()
  await expect(page, '从未知路由点侧栏走不出去').toHaveURL(/\/agents(\?|$)/)
  await expect(page.getByTestId('split-cards')).toBeVisible({ timeout: 30_000 })
})

// --------------------------------------------------------------------------
// UX-43 —— 引导巡览：进度持久化与退出
// --------------------------------------------------------------------------

test('RFC-319 UX-43: 引导巡览的进度写得住——刷新还在原步；退出之后彻底清干净，刷新也不会又罩上来 @nightly', async ({
  page,
}) => {
  await primeToken(page, daemon.token)
  await page.goto(`${daemon.baseUrl}/agents/new`)

  // 把巡览放在第 3 步（`tourScript.ts` first-task 的 index 2，`/agents/new`，
  // 是一条带 Next 的普通步）。这里不用 addInitScript 播种：那样每次 reload 都会
  // 重新写一遍 localStorage，「刷新还在原步」就变成了恒真。
  await page.evaluate(() => {
    window.localStorage.setItem('aw-tour', JSON.stringify({ tourId: 'first-task', stepIndex: 2 }))
  })
  await page.reload()

  const bubble = page.getByTestId('spotlight-tour-bubble')
  await expect(
    bubble,
    '浏览器里存着的巡览进度没有被读出来 ⇒ 用户刷新一下就被打回第一步',
  ).toBeVisible({ timeout: 30_000 })
  await expect(bubble).toContainText('Step 3 of 9')

  // 往前一步，进度必须**当场**落到浏览器里，而不是等到某个收尾时刻。
  await page.getByTestId('spotlight-tour-next').click()
  await expect(bubble).toContainText('Step 4 of 9')
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('aw-tour')), {
      message: '走了一步，进度没有写进浏览器 ⇒ 关掉标签页这一步就白走了',
      timeout: 10_000,
    })
    .toBe(JSON.stringify({ tourId: 'first-task', stepIndex: 3 }))

  await page.reload()
  await expect(
    page.getByTestId('spotlight-tour-bubble'),
    '刷新之后巡览没有回到刚才那一步',
  ).toContainText('Step 4 of 9', { timeout: 30_000 })

  // 退出：蒙版要走干净，且**下一次打开任何页面都不能再罩上来**。
  await page.getByTestId('spotlight-tour-skip').click()
  await expect(
    page.getByTestId('spotlight-tour'),
    '点了退出巡览，蒙版还在 ⇒ 用户被罩住且没有别的出口',
  ).toHaveCount(0)
  expect(
    await page.evaluate(() => window.localStorage.getItem('aw-tour')),
    '退出巡览没有清掉存档 ⇒ 下次打开又被罩上，用户会以为退出按钮是坏的',
  ).toBeNull()

  await page.reload()
  await expect(page.getByTestId('agent-tab-ports')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('spotlight-tour'), '退出之后刷新一下巡览又回来了').toHaveCount(0)
})

// --------------------------------------------------------------------------
// UX-44 —— 首启欢迎屏的唯一主行动通到那三条引导流程
// --------------------------------------------------------------------------

test('RFC-319 UX-44: 首启欢迎屏上那个唯一的主行动真的通到三条引导流程，而且点一条真的开始走 @nightly', async ({
  page,
}) => {
  // 首启屏只在「既没有代理也没有工作流」的实例上出现，所以必须用一个干净的守护进程：
  // 共用的那个会被别的用例种上资源。
  const fresh = await startDaemon()
  try {
    await primeToken(page, fresh.token, fresh.baseUrl)
    await page.goto(`${fresh.baseUrl}/`)

    const hero = page.getByTestId('onboarding-hero')
    await expect(hero, '空实例上没有首启屏 ⇒ 新装的平台第一屏无从下手').toBeVisible({
      timeout: 30_000,
    })

    // 首启屏摆出的三条学习路线，和 `/onboarding` 上那三张卡必须是同一批
    //（同一个 `guide.track.*` 事实源）。摆一套、通到另一套 = 用户点进去发现对不上。
    const heroTracks = await page.locator('.onboarding__step h2').allInnerTexts()
    expect(
      heroTracks.map((t) => t.trim()),
      '首启屏摆出的学习路线与产品实际提供的三条对不上',
    ).toEqual([
      'Build an agent that can do work',
      'Chain agents into a pipeline',
      'Let a team of agents collaborate',
    ])

    // 唯一的主行动。它是个死按钮 = 新装平台的第一屏是一堵墙。
    const start = page.getByTestId('onboarding-start')
    await expect(start).toBeVisible()
    await start.click()
    await expect(page, '首启屏的主行动没有通到引导页').toHaveURL(/\/onboarding(\?|$)/)

    const flows = page.getByTestId('guide-flows')
    await expect(flows, '引导页上一条流程都没有 ⇒ 主行动通到了一片空白').toBeVisible({
      timeout: 30_000,
    })
    for (const [flowId, heading] of [
      ['first-task', 'Build an agent that can do work'],
      ['build-workflow', 'Chain agents into a pipeline'],
      ['use-workgroup', 'Let a team of agents collaborate'],
    ] as const) {
      await expect(
        page.getByTestId(`guide-flow-${flowId}`),
        `引导页缺了 ${flowId} 这条流程 ⇒ 首启屏承诺过它`,
      ).toContainText(heading)
      await expect(
        page.getByTestId(`guide-start-${flowId}`),
        `${flowId} 这条流程没有开始按钮 ⇒ 它只是一段介绍文字`,
      ).toBeVisible()
    }

    // 点下去要**真的开始走**，不是把按钮点亮一下。
    await page.getByTestId('guide-start-build-workflow').click()
    await expect(
      page.getByTestId('spotlight-tour-bubble'),
      '点了「开始」什么都没发生 ⇒ 三张卡是三个装饰',
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('spotlight-tour-bubble')).toContainText('Step 1 of')
  } finally {
    await fresh.stop()
  }
})

// --------------------------------------------------------------------------
// UX-X2 —— 非安全上下文的剪贴板兜底与焦点归还
// --------------------------------------------------------------------------

test('RFC-319 UX-X2: 局域网 http 部署上没有剪贴板 API 时，「复制」仍然真的复制、焦点回到按钮上、不留下任何残渣 @nightly', async ({
  page,
}) => {
  // 纯 http 的 LAN 部署不是安全上下文，浏览器**根本不暴露** navigator.clipboard。
  // Playwright 没法让 127.0.0.1 变成不安全上下文，所以按 e2e/insecure-context-save.spec.ts
  // 的既有做法，精确摘掉那一个受 [SecureContext] 门控的入口，别的一律不动。
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'clipboard', {
      get: () => undefined,
      configurable: true,
    })
  })
  await primeToken(page, daemon.token)
  await page.goto(`${daemon.baseUrl}/account?section=tokens`)

  const panel = page.locator(
    'section.account-section-panel[aria-labelledby="account-section-title-tokens"]',
  )
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('token-create-open').click()
  await expect(page.getByTestId('token-create-dialog')).toBeVisible()
  await page.getByTestId('token-create-name').fill(`rfc319-ux-x2-${Date.now().toString(36)}`)
  await page.getByTestId('token-create-confirm').click()

  const created = page.getByTestId('token-created-dialog')
  await expect(created).toBeVisible({ timeout: 30_000 })
  const secret = (await page.getByTestId('token-created-value').innerText()).trim()
  expect(secret, '揭示阶段没给出明文 ⇒ 下面测的东西不存在').toMatch(/^aws_pat_[A-Za-z0-9]+$/)

  // 前提自证：这一页确实处在「没有剪贴板 API」的形态里，否则下面走的是另一条路。
  expect(
    await page.evaluate(() => navigator.clipboard === undefined),
    '预置没生效 ⇒ 这条用例其实在测安全上下文那条路，兜底一行都没跑到',
  ).toBe(true)

  // 先把系统剪贴板写成一个已知的哨兵值。不这么做的话，「读回来正好是明文」这件事
  // 也可能是上一条用例留下的残值。
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: daemon.baseUrl,
  })
  const reader = await page.context().newPage()
  try {
    await reader.goto(`${daemon.baseUrl}/auth`)
    await reader.evaluate(() => navigator.clipboard.writeText('rfc319-ux-x2-sentinel'))

    await page.getByTestId('token-copy').click()

    // ① 复制真的成功了。失败态是另一段文案（clipboard.ts 返回 false 时），
    //    所以这条断言分得清「复制成功」和「按钮点了但什么都没发生」。
    await expect(
      created.getByRole('status').filter({ hasText: 'Copied' }),
      '没有剪贴板 API 时复制静默失败 ⇒ 这条只显示一次的明文就此丢失，而令牌已经在服务端存在了',
    ).toBeVisible({ timeout: 15_000 })
    await expect(created.getByText('Copy failed — select the text above manually.')).toHaveCount(0)

    // ①b 「回执说成功」还不够——回执只反映 execCommand 的返回值。真正要问的是
    //     系统剪贴板里现在到底是什么：贴出来必须是那条明文，不是哨兵、也不是空串。
    await expect
      .poll(() => reader.evaluate(() => navigator.clipboard.readText()), {
        message:
          '按钮报了「已复制」，剪贴板里却不是那条明文 ⇒ 用户去粘贴时才发现什么都没有，' +
          '而这条 PAT 只显示这一次',
        timeout: 15_000,
      })
      .toBe(secret)
  } finally {
    await reader.close()
  }

  // ② 焦点回到用户按下的那个按钮上。兜底要往 DOM 里塞一个 <textarea> 并 select()，
  //    不还回来的话弹窗的焦点陷阱会另选一个控件，键盘用户当场迷路。
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null),
    '复制之后焦点没有回到那个按钮 ⇒ 键盘用户被扔到弹窗里另一个位置',
  ).toBe('token-copy')

  // ③ 不留残渣：那块用于选中的 <textarea> 必须被摘掉。
  await expect(
    created.locator('textarea'),
    '兜底用的隐藏输入框留在了弹窗里 ⇒ Tab 会停在一个看不见的控件上，读屏也会念到它',
  ).toHaveCount(0)
})

// --------------------------------------------------------------------------
// UX-X4 —— 列表层相对时间靠共享 30s 时钟自己往前走
// --------------------------------------------------------------------------

test('RFC-319 UX-X4: 停在列表页不动，行上的相对时间自己往前走（数据没变、只有标签变） @nightly', async ({
  page,
}) => {
  const name = `rfc319-ux-x4-${Date.now().toString(36)}`
  const skill = await jsonOf<{ id: string }>(
    await api('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 UX-X4 shared-clock fixture',
        bodyMd: '# rfc319 ux-x4\n',
      }),
    }),
    'seed skill',
  )

  await primeToken(page, daemon.token)
  // 假时钟必须在导航之前装好，否则页面里的 setInterval 注册的是真定时器。
  await page.clock.install()
  await page.goto(`${daemon.baseUrl}/skills`)

  const card = page.getByTestId(`split-card-${skill.id}`)
  await expect(card, '刚建的技能没有出现在列表里 ⇒ 下面测的东西不存在').toBeVisible({
    timeout: 30_000,
  })
  const stamp = card.locator('time')
  await expect(stamp, '列表行上根本没有相对时间 ⇒ 这条能力在这一页不成立').toHaveText('just now', {
    timeout: 30_000,
  })
  const machineReadable = await stamp.getAttribute('datetime')
  expect(machineReadable, '相对时间没有带机器可读的时间戳').not.toBeNull()

  // 不刷新、不导航、不点任何东西——只让时间过去。
  await page.clock.fastForward('03:00')

  await expect(
    stamp,
    '停在页面上时相对时间不会自己前进 ⇒ 用户会对着一个写着「just now」的三分钟前的行下判断',
  ).toHaveText('3 min ago', { timeout: 15_000 })
  expect(
    await stamp.getAttribute('datetime'),
    '标签变了、底下的时间戳也跟着变了 ⇒ 变的不是时钟而是数据，这条用例测错了东西',
  ).toBe(machineReadable)
  await expect(
    stamp,
    '相对时间前进了，但绝对时间没有留在无障碍通道里 ⇒ 读屏用户只能听到「3 min ago」',
  ).toHaveAttribute('aria-label', /3 min ago（.+）/)
})
