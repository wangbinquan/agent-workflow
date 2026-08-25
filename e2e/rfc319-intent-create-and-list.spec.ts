// RFC-319 —— 意图构建器「会话创建 + 最近会话列表」能力簇的用户面 e2e。
//
// 覆盖能力账本行：INTENT-03 / INTENT-04 / INTENT-05 / INTENT-06 / INTENT-07 /
// INTENT-08 / INTENT-09。这些行此前全是 gap：意图构建器的 e2e 只走过一条
// 「创建 → 出草稿 → 提交」的顺风路径（e2e/intent-builder.spec.ts），创建**失败**、
// 创建**进行中**、以及列表页本身（空态 / 状态 chip / 分页）一条防护都没有。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//  INTENT-03  空白 composer 的示例语失效 —— 首次进来的用户面对一个空白框，
//             不知道该写多细；或者点了示例文本没进去 / 焦点没跟过去，
//             用户还得再点一次输入框、光标还落在开头。
//  INTENT-04  创建请求失败后如果不报错、或者 composer 不解锁，用户会看到
//             「点了没反应」的死界面，只能刷新，刚写的目标全丢；更糟的是
//             半个会话落在服务端变成僵尸行，列表里多出一条永远转圈的会话。
//  INTENT-05  创建是**非幂等**的（intent.tsx:157-159 的注释写明了这点）：
//             进行中若能关弹窗 / 点侧边栏 / 前进后退 / 刷新走掉，用户就会
//             得到一条自己看不见的会话；若能重复提交，就是一次输入建出两条
//             会话，两条都在跑 agent 烧 token。
//             其中「浏览器**前进**」是最容易漏的一格：@tanstack/history
//             1.161.6 无论 Back 还是 Forward 都用 history.go(1) 回滚，
//             对 Forward 是反的 —— 产品为此自己写了 pop 守卫
//             （intent.tsx:44-74），这条用例就是它的回归防护。
//  INTENT-06  16 KiB 上限若只写在前端、或计数器不跟着变，用户会一路粘贴到
//             提交才被服务端打回，前面写的全白费。
//  INTENT-07  空态若在数据到达前就先闪一次，用户会以为自己的会话全没了；
//             若有数据时还挂着空态，则是彻底的自相矛盾。
//  INTENT-08  卡片状态 chip 是列表页唯一能看出「这条会话进行到哪一步」的
//             东西。它若不随真实进度走（比如永远显示 Generate），用户会
//             反复点进去看，或者以为一条已经跑完的会话还卡着。
//  INTENT-09  keyset 分页若拼错（丢条 / 重条 / 顺序乱），第 13 条以后的会话
//             在界面上就等于不存在。
//
// 判据取自（纯文本引用，勿改成外链）：
//   packages/frontend/src/components/intent/IntentCreateComposer.tsx:108-141
//     —— locked 语义、examples 一键填入 + rAF 聚焦/光标置尾
//   packages/frontend/src/components/intent/IntentCreateComposer.tsx:123-136
//     —— submitPendingRef 同一 tick 防重复提交门
//   packages/frontend/src/components/intent/IntentCreateComposer.tsx:194-222
//     —— 两条 ErrorBanner（创建失败 / 导航失败）+ maxLength + 字数计数器
//   packages/frontend/src/routes/intent.tsx:44-74   —— 前进/后退 pop 守卫
//   packages/frontend/src/routes/intent.tsx:134-175 —— useBlocker + beforeunload
//   packages/frontend/src/routes/intent.tsx:178-188 —— keyset 分页 limit=12
//   packages/frontend/src/routes/intent.tsx:247-262 —— Dialog dismissDisabled
//   packages/frontend/src/components/intent/IntentSessionList.tsx:34-82
//     —— 空态 / 卡片 chip + 轮次·提交计数 / Load more
//   packages/frontend/src/components/intent/IntentJourneyProgress.tsx:22-67
//     —— 四阶段 chip 文案与语义色
//   packages/shared/src/schemas/intentSession.ts:12-16  —— 16 KiB 上限常量
//   packages/backend/src/routes/intentSessions.ts:242-291 —— page/limit/cursor
//   packages/backend/src/services/intent/session.ts:101-137 —— keyset 排序与游标
//   packages/backend/src/services/intent/session.ts:280-296 —— title 截断 / turnSeq=2
//   packages/backend/src/services/intent/journey.ts:34-70 —— 阶段投影
//   packages/backend/src/util/errors.ts:46-51 —— ValidationError ⇒ 422
//
// 故障注入一律走请求层（page.route），不改 stub 文件：本仓既有手法，且
// stub 是多条用例共用的编译产物。

import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, type DaemonHandle } from './harness'

/** composer-only 的几条用例共用一个 daemon；凡是要数「服务端有几条会话」的
 *  断言都写成**增量**（前后对比），不依赖这个 daemon 是干净的。 */
let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'intent' })
})
test.afterAll(async () => {
  await daemon.stop()
})

async function authPage(page: Page, targetDaemon: DaemonHandle = daemon): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [targetDaemon.baseUrl, targetDaemon.token] as const,
  )
}

interface SessionRow {
  id: string
  title: string
  inFlight: boolean
  turnSeq: number
  commitSeq: number
  status: 'active' | 'archived'
}

/** 服务端真值：分页读回全部会话（limit 上限 50，见 intentSessions.ts:245）。 */
async function apiListSessions(d: DaemonHandle): Promise<SessionRow[]> {
  const res = await fetch(`${d.baseUrl}/api/intent-sessions?page=1&limit=50`, {
    headers: { Authorization: `Bearer ${d.token}` },
  })
  expect(res.ok, `GET /api/intent-sessions ⇒ ${res.status}`).toBe(true)
  const body = (await res.json()) as { items: SessionRow[]; nextCursor: string | null }
  // 本文件所有用例的会话数都远小于 50；游标非空说明夹具规模超预期，
  // 后面「DOM 顺序 == 服务端顺序」的对账会静默失真。
  expect(body.nextCursor, '夹具会话数超过 50，服务端真值本身被截断了').toBeNull()
  return body.items
}

async function apiCreateSession(
  d: DaemonHandle,
  message: string,
): Promise<{ status: number; body: { id?: string; title?: string; code?: string } }> {
  const res = await fetch(`${d.baseUrl}/api/intent-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

async function apiArchiveSession(d: DaemonHandle, sessionId: string): Promise<void> {
  const res = await fetch(
    `${d.baseUrl}/api/intent-sessions/${encodeURIComponent(sessionId)}/archive`,
    { method: 'POST', headers: { Authorization: `Bearer ${d.token}` } },
  )
  expect(res.ok, `archive ${sessionId} ⇒ ${res.status}`).toBe(true)
}

/** 所有轮次落定后 updatedAt 才不再变化——列表顺序、分页游标都建立在它上面。 */
async function waitForAllTurnsSettled(d: DaemonHandle): Promise<void> {
  await expect
    .poll(async () => (await apiListSessions(d)).every((s) => !s.inFlight), {
      timeout: 120_000,
      intervals: [500],
      message: '还有会话的 agent 轮次没落定，列表顺序此时仍在漂移',
    })
    .toBe(true)
}

/** 分批种会话：一次全放会同时拉起十几个 runtime 子进程，CI 上没必要。 */
async function seedSessions(d: DaemonHandle, messages: readonly string[]): Promise<void> {
  const batch = 5
  for (let i = 0; i < messages.length; i += batch) {
    for (const message of messages.slice(i, i + batch)) {
      const created = await apiCreateSession(d, message)
      expect(created.status, `seed "${message}"`).toBe(201)
    }
    await waitForAllTurnsSettled(d)
  }
}

/**
 * 会话卡片 meta 的两格计数（轮次 / 提交）。
 *
 * 必须**逐格**断言，不能对整条 meta 写带词边界的正则：meta 里是三个并排元素
 * （两个 <span> + RelativeTime 的 <time>，IntentSessionList.tsx:60-64），JSX 把
 * 它们之间的空白全吃掉了，textContent 拼出来是 "2 turns0 commitsjust now" ——
 * `/\b2 turns?\b/` 里结尾那个 \b 落在 's' 与 '0' 之间，两边都是词字符，永远
 * 匹配不上。逐格 toHaveText 还顺带把「计数不是子串巧合」也钉住了
 * （"12 turns" 不会被当成 "2 turns"）。
 */
function metaCells(card: Locator): { turns: Locator; commits: Locator } {
  const cellsInCard = card.locator('.intent-session-card__meta > span')
  return { turns: cellsInCard.first(), commits: cellsInCard.nth(1) }
}

/** "1,234 / 16,384" ⇒ [1234, 16384]，不依赖浏览器的千分位写法。 */
function counterPair(text: string): [number, number] {
  const parts = text.split('/')
  expect(parts.length, `字数计数器不是 "已用 / 上限" 形状：${text}`).toBe(2)
  return [Number(parts[0]!.replace(/\D/g, '')), Number(parts[1]!.replace(/\D/g, ''))]
}

/**
 * 拦住 POST /api/intent-sessions，把「创建进行中」这个瞬态钉死成可断言的状态。
 * 只拦 POST：同路径的 GET（列表）必须照常放行，否则页面根本渲染不出来。
 */
async function installCreateGate(page: Page): Promise<{ posts: string[]; release: () => void }> {
  const posts: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === '/api/intent-sessions',
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      posts.push(route.request().url())
      await gate
      await route.continue()
    },
  )
  return { posts, release }
}

/** 刷新 / 关标签页守卫是否武装：@tanstack/history 的 beforeunload 监听器在
 *  该拦时会对事件 preventDefault()。合成事件探针把它变成确定性断言，
 *  避开 Playwright 对 beforeunload 原生弹窗的处理差异。 */
async function beforeUnloadIsGuarded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const probe = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(probe)
    return probe.defaultPrevented
  })
}

/** 「拦住了」和「还没来得及跳」从外部看一模一样，所以必须给路由一个真实的
 *  机会去跳再断言。每条用例末尾都配了一条解锁后的正向对照，证明这里的
 *  断言不是恒真。 */
async function settleNavigationAttempt(page: Page): Promise<void> {
  await page.waitForTimeout(800)
}

// ---------------------------------------------------------------------------
// INTENT-03
// ---------------------------------------------------------------------------

test('INTENT-03 空 composer 的示例语：一键填入、焦点与光标跟过去，且不在弹窗里重复出现 @nightly', async ({
  page,
}) => {
  await authPage(page)
  await page.goto(`${daemon.baseUrl}/intent`)

  const composer = page.getByTestId('intent-create-inline')
  const textarea = composer.getByTestId('intent-create-message')
  const submit = composer.getByRole('button', { name: 'Start building' })
  const examples = composer.locator('.intent-create__example')

  await expect(
    examples,
    '空 composer 不给示例 ⇒ 首次进来的用户对着空白框，不知道目标该写到什么粒度',
  ).toHaveCount(3)
  await expect(submit, '空目标就能提交 ⇒ 会建出一条没有目标的会话，agent 只能瞎猜').toBeDisabled()

  const picked = 'Build an implement → audit-by-file → fix workflow'
  await composer.getByRole('button', { name: picked }).click()

  await expect(textarea, '填进去的不是被点的那条 ⇒ 用户拿到的是另一个目标').toHaveValue(picked)
  await expect(
    textarea,
    '点完不聚焦 ⇒ 用户还得再点一次输入框才能接着改，一键填入白做',
  ).toBeFocused()
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLTextAreaElement | null
          return el === null ? null : [el.selectionStart, el.selectionEnd]
        }),
      { message: '光标没落到文末 ⇒ 接着敲字会插在示例句中间' },
    )
    .toEqual([picked.length, picked.length])
  await expect(
    examples,
    '已经有目标了示例还占着位置 ⇒ 界面继续推销别的目标，而且把 composer 撑高',
  ).toHaveCount(0)
  await expect(submit, '填完还是灰的 ⇒ 用户点了示例却发现开不了工').toBeEnabled()

  // 负向对照 1：手打文字同样让示例退场（否则上一条可能只是「点击时顺手隐藏」）。
  await textarea.fill('')
  await expect(examples, '清空后示例没回来 ⇒ 用户没法再借示例起步').toHaveCount(3)
  await textarea.fill('x')
  await expect(examples, '有目标了示例还在 ⇒ 隐藏逻辑只认点击不认输入').toHaveCount(0)

  // 负向对照 2：弹窗版 composer 不铺示例（variant === 'inline' 才渲染）。
  await page.goto(`${daemon.baseUrl}/intent?create=true`)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('intent-create-message')).toBeVisible()
  await expect(
    dialog.locator('.intent-create__example'),
    '弹窗里也铺一排示例 ⇒ 小屏上把提交按钮挤出可视区',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// INTENT-06
// ---------------------------------------------------------------------------

test('INTENT-06 目标 16 KiB 上限：计数器如实计数，键盘打不进第 16385 个字符，服务端按同一个数拒收 @nightly', async ({
  page,
}) => {
  await authPage(page)
  await page.goto(`${daemon.baseUrl}/intent`)

  const composer = page.getByTestId('intent-create-inline')
  const textarea = composer.getByTestId('intent-create-message')
  const counter = composer.locator('.intent-create__counter')

  expect(
    counterPair(await counter.innerText()),
    '空 composer 的计数器读数不对 ⇒ 用户一进来就拿到错的预算',
  ).toEqual([0, 16 * 1024])

  await textarea.fill('abcde')
  expect(
    counterPair(await counter.innerText())[0],
    '计数器不跟着输入走 ⇒ 那串数字是装饰，用户无法预判自己还能写多少',
  ).toBe(5)

  // UI 自己声明的上限：后面的服务端探针一律用它，客户端单方面放宽/收紧时这里会红。
  const cap = counterPair(await counter.innerText())[1]
  expect(cap).toBe(16 * 1024)

  await textarea.fill('a'.repeat(cap))
  expect(
    counterPair(await counter.innerText()),
    '刚好写满上限时计数器就不对 ⇒ 用户不知道自己已经到顶',
  ).toEqual([cap, cap])

  // 真正的用户路径：写满之后继续敲。浏览器的 maxlength 必须挡住这一下。
  await textarea.press('End')
  await textarea.press('X')
  expect(
    (await textarea.inputValue()).length,
    '写满后还能继续敲进去 ⇒ 超长内容一路带到提交才被服务端打回，前面全白写',
  ).toBe(cap)
  expect(counterPair(await counter.innerText()), '越界的字符没进值却进了计数').toEqual([cap, cap])

  // 服务端真值：上限是「允许值」不是「拒绝值」，越界才拒。
  const before = await apiListSessions(daemon)
  const atCap = await apiCreateSession(daemon, 'rfc319-cap-ok '.padEnd(cap, 'a').slice(0, cap))
  expect(atCap.status, '刚好 16 KiB 的目标被服务端拒了 ⇒ UI 承诺的上限是假的').toBe(201)

  const overCap = await apiCreateSession(daemon, 'a'.repeat(cap + 1))
  expect(overCap.status, '超一个字节仍被收下 ⇒ 上限只是前端摆设').toBe(422)
  expect(overCap.body.code).toBe('intent-invalid')

  const after = await apiListSessions(daemon)
  expect(
    after.length - before.length,
    '越界那次也落了库 ⇒ 用户列表里多出一条自己没打算建的会话',
  ).toBe(1)
})

// ---------------------------------------------------------------------------
// INTENT-04
// ---------------------------------------------------------------------------

test('INTENT-04 创建失败（服务端 422 / 断网）：报错读得懂、composer 立刻解锁、服务端不留僵尸会话 @nightly', async ({
  page,
}) => {
  await authPage(page)
  const before = await apiListSessions(daemon)
  const goal = 'rfc319 create-failure probe'

  // 一个 handler、三种模式：换模式不用 unroute（predicate 形式的 unroute 需要
  // 同一个函数引用，容易写错成「没解掉」）。
  let mode: 'pass' | 'server-422' | 'offline' = 'server-422'
  await page.route(
    (url) => url.pathname === '/api/intent-sessions',
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      if (mode === 'server-422') {
        // 让**真实服务端**产出这次 422：不伪造响应体，断言才落在真实契约上。
        await route.continue({ postData: JSON.stringify({ message: '' }) })
        return
      }
      if (mode === 'offline') {
        await route.abort('failed')
        return
      }
      await route.continue()
    },
  )

  await page.goto(`${daemon.baseUrl}/intent`)
  const composer = page.getByTestId('intent-create-inline')
  const textarea = composer.getByTestId('intent-create-message')
  const submit = composer.getByRole('button', { name: 'Start building' })
  await textarea.fill(goal)
  await submit.click()

  // ---- 1) 服务端 422 ----
  const banner = composer.getByRole('alert')
  await expect(banner, '创建被拒却不报错 ⇒ 用户看到「点了没反应」的死界面，只能刷新').toBeVisible()
  await expect(banner).toContainText('Request failed')
  await expect(
    banner.locator('.error-details__issues li').first(),
    '错误里连「哪个字段不合法」都没有 ⇒ 用户无从改起',
  ).toContainText('message')
  await banner.locator('details.error-details__raw > summary').last().click()
  await expect(
    banner.locator('details.error-details__raw pre').last(),
    '原始诊断被吞掉 ⇒ 用户报障时拿不出任何可追的线索',
  ).toContainText('invalid intent session payload')

  await expect(page, '失败了却已经跳走 ⇒ 用户落到一个不存在的会话页').toHaveURL(/\/intent$/)
  await expect(textarea, '失败后输入框仍锁着 ⇒ 用户被卡死，只能刷新丢掉刚写的目标').toBeEnabled()
  await expect(textarea, '失败后把输入清空 ⇒ 用户得把目标整段重写一遍').toHaveValue(goal)
  await expect(submit, '按钮永远停在 Creating… ⇒ 重试路径被自己堵死').toBeEnabled()
  await expect(submit).toHaveText('Start building')
  expect(
    (await apiListSessions(daemon)).map((s) => s.id),
    '失败的创建仍落了库 ⇒ 列表里多出一条永远转圈的僵尸会话',
  ).toEqual(before.map((s) => s.id))

  // ---- 2) 断网 ----
  mode = 'offline'
  await submit.click()
  await expect(banner, '断网时不报错 ⇒ 用户以为建好了，实际什么都没发生').toContainText(
    'Cannot reach the service.',
  )
  await expect(banner, '断网报错不给下一步 ⇒ 用户不知道是自己网断了还是产品坏了').toContainText(
    'Make sure the daemon is running and the network is reachable, then retry.',
  )
  await expect(textarea).toBeEnabled()
  await expect(textarea).toHaveValue(goal)
  expect(
    (await apiListSessions(daemon)).map((s) => s.id),
    '断网那次也留下了服务端行 ⇒ 僵尸会话',
  ).toEqual(before.map((s) => s.id))

  // ---- 3) 正向对照：上面两条「解锁了」不是空话，同一个按钮真能把会话建出来 ----
  mode = 'pass'
  await submit.click()
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i, { timeout: 30_000 })
  const after = await apiListSessions(daemon)
  expect(after.length - before.length, '恢复后仍建不出会话 ⇒ 前面的解锁只是视觉上的').toBe(1)
  const created = after.find((s) => !before.some((b) => b.id === s.id))
  expect(created?.title, '建出来的会话不是用户写的那个目标').toBe(goal)
})

// ---------------------------------------------------------------------------
// INTENT-05 —— 内联 composer：侧边栏 / 前进后退 / 刷新 + 防重复提交
// ---------------------------------------------------------------------------

test('INTENT-05 创建进行中：侧边栏跳转、浏览器前进后退、刷新全被锁死，重复提交只发一次 POST @nightly', async ({
  page,
}) => {
  await authPage(page)
  const before = await apiListSessions(daemon)
  const gate = await installCreateGate(page)

  try {
    // 用 SPA 导航把历史堆出 [/skills, /intent, /skills]，再退回中间那格 —— 这样
    // /intent 两侧都有历史项，Back 与 **Forward** 才都能被真正试到。
    await page.goto(`${daemon.baseUrl}/skills`)
    const intentNav = page.locator('.nav-group[data-group="workflows"] a', {
      hasText: 'Intent Builder',
    })
    const skillsNav = page.locator('.nav-group[data-group="agents"] a', { hasText: 'Skills' })
    await intentNav.click()
    await page.waitForURL(/\/intent$/)
    await skillsNav.click()
    await page.waitForURL(/\/skills$/)
    await page.evaluate(() => {
      window.history.back()
    })
    await page.waitForURL(/\/intent$/)

    const composer = page.getByTestId('intent-create-inline')
    const textarea = composer.getByTestId('intent-create-message')
    // 提交按钮的**可及名字在 pending 时会变**（IntentCreateComposer.tsx:181
    // `pending ? t('common.creating') : t('intent.startBuilding')`），所以这条
    // 用例必须按 type 定位——按名字定位会在最关键的那一刻「找不到元素」，
    // 断言就变成了「按钮不在」而不是「按钮被禁用」。
    const submit = composer.locator('button[type="submit"]')

    // 负向对照（此刻还没提交）：离开守卫必须是**没**武装的。
    expect(
      await beforeUnloadIsGuarded(page),
      '什么都没做就拦刷新 ⇒ 每次离开 /intent 都弹一个莫名其妙的确认框',
    ).toBe(false)

    await textarea.fill('rfc319 pending-lock probe')
    await submit.click()

    // ---- 进行中的界面状态 ----
    await expect(submit, '进行中按钮仍可点 ⇒ 一次输入能建出两条会话').toBeDisabled()
    await expect(submit, '进行中没有任何「在建」反馈 ⇒ 用户以为卡住了会再点').toHaveText(
      'Creating…',
    )
    await expect(textarea, '进行中还能改目标 ⇒ 改的内容和已发出的请求对不上').toBeDisabled()

    // ---- 防重复提交：绕开 disabled 直接触发表单提交（等价于极快的双击 / 连按回车）----
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('[data-testid="intent-create-inline"]')
      form?.requestSubmit()
      form?.requestSubmit()
      form?.requestSubmit()
    })
    await settleNavigationAttempt(page)
    expect(
      gate.posts.length,
      '同一次输入发出了多次创建 ⇒ 建出多条会话，每条都在跑 agent 烧 token',
    ).toBe(1)

    // ---- 离开路径 1：侧边栏 ----
    await skillsNav.click()
    await settleNavigationAttempt(page)
    await expect(page, '进行中被侧边栏带走 ⇒ 用户永远见不到刚建的那条会话').toHaveURL(/\/intent$/)

    // ---- 离开路径 2：浏览器后退 ----
    await page.evaluate(() => {
      window.history.back()
    })
    await settleNavigationAttempt(page)
    await expect(page, '进行中能后退走掉 ⇒ 同上，会话变成用户看不见的孤儿').toHaveURL(/\/intent$/)

    // ---- 离开路径 3：浏览器前进（@tanstack/history 回滚方向反了的那一格）----
    await page.evaluate(() => {
      window.history.forward()
    })
    await settleNavigationAttempt(page)
    await expect(
      page,
      '进行中能前进走掉 ⇒ pop 守卫只挡住了 Back，Forward 是条没上锁的后门',
    ).toHaveURL(/\/intent$/)

    // ---- 离开路径 4：刷新 / 关标签页 ----
    expect(
      await beforeUnloadIsGuarded(page),
      '进行中刷新不拦 ⇒ 一次误刷新就把这条会话丢给用户自己去列表里找',
    ).toBe(true)

    // ---- 解锁：同样这些路径必须立刻恢复正常 ----
    gate.release()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i, { timeout: 30_000 })
    expect(gate.posts.length, '解锁后又补发了一次创建').toBe(1)

    const after = await apiListSessions(daemon)
    expect(after.length - before.length, '锁了一路，最后建出的会话不是恰好一条').toBe(1)

    // 守卫是**异步**释放的（创建落地 → 状态回写 → 卸载守卫）。这里必须先等它真的松开
    // 再离开本页：若还锁着就直接 `page.goto`，浏览器会弹 beforeunload，而 Playwright 对
    // 未注册 handler 的对话框默认按「取消」处理 —— 于是这次跳转**静默失败**，页面根本没动，
    // 后面每一条断言都跑在旧页面上，最终以「waitForURL 超时」这种指不到原因的形态红。
    // 2026-08-25 的 Windows CI 实测就是这个形态（macOS / ubuntu 因为释放得更快而侥幸绿）。
    // 用 expect.poll 等真实信号，而不是靠机器够快。
    await expect.poll(async () => beforeUnloadIsGuarded(page), { timeout: 15_000 }).toBe(false)
    await page.goto(`${daemon.baseUrl}/intent`)
    expect(
      await beforeUnloadIsGuarded(page),
      '创建完成后仍拦刷新 ⇒ 用户此后每次离开都被无谓打断',
    ).toBe(false)
    await expect(
      skillsNav,
      '侧栏里的 Skills 入口够不到 —— 这一步是「解锁后导航恢复正常」的正向对照，' +
        '入口本身不可见时应当在这里报出来，而不是让下面的 waitForURL 静默等满超时',
    ).toBeVisible()
    await skillsNav.click()
    await page.waitForURL(/\/skills$/, { timeout: 15_000 })
  } finally {
    gate.release()
  }
})

// ---------------------------------------------------------------------------
// INTENT-05 —— 弹窗版 composer：所有关闭路径
// ---------------------------------------------------------------------------

test('INTENT-05 创建进行中：新建弹窗的关闭按钮 / Esc / 点遮罩 / 取消四条路径全被封死 @nightly', async ({
  page,
}) => {
  await authPage(page)
  const gate = await installCreateGate(page)

  try {
    await page.goto(`${daemon.baseUrl}/intent?create=true`)
    const dialog = page.getByRole('dialog')
    const goal = 'rfc319 dialog pending-lock probe'
    await dialog.getByTestId('intent-create-message').fill(goal)
    await dialog.getByRole('button', { name: 'Start building' }).click()

    const closeButton = dialog.getByRole('button', { name: 'Close' })
    await expect(closeButton, '进行中还能点 × ⇒ 用户以为取消了，服务端其实照建不误').toBeDisabled()
    await expect(
      dialog.getByRole('button', { name: 'Cancel' }),
      '进行中「取消」还亮着 ⇒ 它取消不了任何东西，只会骗用户',
    ).toBeDisabled()

    await page.keyboard.press('Escape')
    await settleNavigationAttempt(page)
    await expect(dialog, 'Esc 关掉了进行中的弹窗 ⇒ 会话在用户背后建出来').toBeVisible()

    await page.locator('.dialog__overlay').click({ position: { x: 4, y: 4 } })
    await settleNavigationAttempt(page)
    await expect(dialog, '点遮罩关掉了进行中的弹窗 ⇒ 同上，而且更容易误触').toBeVisible()
    await expect(
      dialog.getByTestId('intent-create-message'),
      '弹窗被重建过 ⇒ 用户写的目标在关闭尝试中被抹掉了',
    ).toHaveValue(goal)

    // 解锁后必须真的走完：证明上面四条不是「弹窗压根关不掉」的恒真断言。
    gate.release()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i, { timeout: 30_000 })
    await expect(dialog, '会话建好了弹窗还挂着 ⇒ 详情页被一层遮罩盖住').toHaveCount(0)
    expect(gate.posts.length).toBe(1)

    // 正向对照：空闲态的 Esc 本来就该关掉弹窗。
    await page.goto(`${daemon.baseUrl}/intent?create=true`)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('dialog'),
      '空闲态 Esc 也关不掉 ⇒ 上面「Esc 被封死」的断言其实什么都没证明',
    ).toHaveCount(0)
    await expect(page).toHaveURL(/\/intent$/)
  } finally {
    gate.release()
  }
})

// ---------------------------------------------------------------------------
// INTENT-07 + INTENT-09
// ---------------------------------------------------------------------------

test('INTENT-07 / INTENT-09 最近会话列表：空态只在真空时出现，13 条会话由两页按服务端顺序拼全 @nightly', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const listDaemon = await startDaemon({ stubMode: 'intent' })
  try {
    await authPage(page, listDaemon)

    // ---- 加载中不得先闪一次空态 ----
    let releaseList: () => void = () => {}
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    let gateArmed = true
    await page.route(
      (url) => url.pathname === '/api/intent-sessions',
      async (route) => {
        if (gateArmed && route.request().method() === 'GET') await listGate
        await route.continue()
      },
    )
    await page.goto(`${listDaemon.baseUrl}/intent`)
    await expect(page.getByTestId('loading-state'), '加载中没有任何进度反馈').toBeVisible()
    await expect(
      page.getByTestId('empty-state'),
      '数据还没到就先喊「没有会话」⇒ 用户以为自己所有的会话都没了',
    ).toHaveCount(0)
    gateArmed = false
    releaseList()

    // ---- 空态 ----
    const empty = page.getByTestId('empty-state')
    await expect(empty, '真的一条都没有时不给空态 ⇒ 页面下半截是一片无解释的空白').toBeVisible()
    await expect(empty).toContainText('No intent sessions yet')
    await expect(empty, '空态只有标题没有下一步 ⇒ 新用户不知道该干什么').toContainText(
      'Describe your goal and let AI assemble everything it needs.',
    )
    await expect(page.locator('a.intent-session-card')).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Load more tasks' }),
      '零条会话还给「加载更多」⇒ 点下去什么都不会发生',
    ).toHaveCount(0)

    // ---- 种够两页（后端 page size 12，见 intent.tsx:184）----
    const messages = Array.from(
      { length: 13 },
      (_, i) => `rfc319 list fixture ${String(i + 1).padStart(2, '0')}`,
    )
    await seedSessions(listDaemon, messages)

    await page.goto(`${listDaemon.baseUrl}/intent`)
    const cards = page.locator('a.intent-session-card')
    await expect(cards, '第一页没按 limit=12 截断 ⇒ 分页契约和服务端对不上').toHaveCount(12)
    // 负向对照：有数据时空态必须消失，否则前面那条空态断言恒真。
    await expect(
      page.getByTestId('empty-state'),
      '有 13 条会话还挂着「没有会话」⇒ 界面自相矛盾，用户不知道该信哪个',
    ).toHaveCount(0)

    const loadMore = page.getByRole('button', { name: 'Load more tasks' })
    await expect(loadMore, '还有第 13 条却不给入口 ⇒ 那条会话在界面上等于不存在').toBeVisible()

    const firstPageTitles = await page.locator('a.intent-session-card .card__title').allInnerTexts()
    await loadMore.click()
    await expect(cards, '点了加载更多没把剩下的接上').toHaveCount(13)

    const domTitles = await page.locator('a.intent-session-card .card__title').allInnerTexts()
    expect(
      domTitles.slice(0, firstPageTitles.length),
      '第二页把第一页顶掉了 ⇒ 用户刚看到的会话翻个页就没了',
    ).toEqual(firstPageTitles)
    expect(new Set(domTitles).size, '两页拼出来有重复行 ⇒ 同一条会话出现两次').toBe(13)

    const serverTitles = (await apiListSessions(listDaemon)).map((s) => s.title)
    expect(
      domTitles,
      '拼出来的列表与服务端顺序不一致 ⇒ keyset 游标漏条或错序，中间的会话被吃掉',
    ).toEqual(serverTitles)

    await expect(
      loadMore,
      '已经到底了还留着「加载更多」⇒ 用户反复点，以为还有没看到的会话',
    ).toHaveCount(0)
  } finally {
    await listDaemon.stop()
  }
})

// ---------------------------------------------------------------------------
// INTENT-08
// ---------------------------------------------------------------------------

test('INTENT-08 最近会话卡片：状态 chip 随真实进度从 Generate 走到 Review 再到 Apply，轮次/提交计数逐条独立 @nightly', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-intent-stage-'))
  const holdFile = join(holdDir, 'first-turn.hold')
  writeFileSync(holdFile, 'held')
  let stageDaemon: DaemonHandle | undefined
  try {
    stageDaemon = await startDaemon({
      stubMode: 'intent',
      // 第一条会话的 agent 轮次被扣住，"Generate" 这一格才有稳定的观察窗口。
      extraEnv: { STUB_INTENT_HOLD_FILE: holdFile },
    })
    await authPage(page, stageDaemon)

    const generating = await apiCreateSession(stageDaemon, 'rfc319 stage generating')
    expect(generating.status).toBe(201)
    const generatingId = generating.body.id!

    await page.goto(`${stageDaemon.baseUrl}/intent`)
    const chip = page.getByTestId(`intent-stage-status-${generatingId}`)
    const card = page
      .locator('a.intent-session-card')
      .filter({ hasText: 'rfc319 stage generating' })
    const cells = metaCells(card)

    // ---- 第 2 步：Generate ----
    await expect(
      chip,
      '在跑的会话不显示 Generate ⇒ 用户看不出它正在忙，只能反复点进去确认',
    ).toHaveText('Step 2/4 · Generate')
    await expect(chip, '在跑的状态没用「进行中」的语义色').toHaveClass(/status-chip--info/)
    await expect(chip, '在跑却没有活动指示点 ⇒ 静态截图上和已完成的会话没有区别').toHaveClass(
      /status-chip--with-dot/,
    )
    await expect(card, '在跑的卡片没被高亮 ⇒ 一屏会话里找不出哪条在动').toHaveClass(
      /card--highlighted/,
    )
    // 一条会话创建时就写下 2 个 turn（用户消息 + 预留的 agent 轮次，
    // services/intent/session.ts:295-296 的 `turnSeq: reserve ? 2 : 1`）。
    await expect(cells.turns, '轮次计数不对 ⇒ 用户无法判断这条会话已经来回了几轮').toHaveText(
      '2 turns',
    )
    await expect(cells.commits, '还没提交就显示有提交 ⇒ 用户以为改动已经落地了').toHaveText(
      '0 commits',
    )

    // ---- 第 3 步：Review（同时是「chip 不是写死的」的负向对照）----
    rmSync(holdFile, { force: true })
    await waitForAllTurnsSettled(stageDaemon)
    await page.reload()
    await expect(
      chip,
      '轮次跑完 chip 还停在 Generate ⇒ 用户以为它卡死了，实际草稿早就等着评审',
    ).toHaveText('Step 3/4 · Review')
    await expect(chip, '待评审没用「需要你处理」的语义色').toHaveClass(/status-chip--warn/)
    await expect(card, '已经跑完还高亮 ⇒ 高亮失去「正在动」的含义').not.toHaveClass(
      /card--highlighted/,
    )

    // ---- 第 4 步：Apply ----
    const composer = page.getByTestId('intent-create-inline')
    await composer.getByTestId('intent-create-message').fill('rfc319 stage apply')
    await composer.getByRole('button', { name: 'Start building' }).click()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
    const appliedId = new URL(page.url()).pathname.split('/').at(-1)!
    await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('intent-open-commit').click()
    await page.getByTestId('intent-commit-next').click()
    await page.getByTestId('intent-commit-next').click()
    await page.getByTestId('intent-commit-submit').click()
    await expect(page.getByText('Committed', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })

    await page.goto(`${stageDaemon.baseUrl}/intent`)
    const appliedChip = page.getByTestId(`intent-stage-status-${appliedId}`)
    const appliedCells = metaCells(
      page.locator('a.intent-session-card').filter({ hasText: 'rfc319 stage apply' }),
    )
    await expect(
      appliedChip,
      '已提交的会话不显示 Apply ⇒ 用户在列表上分不出哪些改动已经落地',
    ).toHaveText('Step 4/4 · Apply')
    await expect(appliedChip, '已落地没用成功语义色').toHaveClass(/status-chip--success/)
    await expect(appliedCells.commits, '提交计数没跟着提交走 ⇒ 那个数字是假的').toHaveText(
      '1 commits',
    )
    // 负向对照：计数是**逐条**的，不是全局的。提交只动 commitSeq，不产生新轮次，
    // 所以这条已提交会话的轮次数必须仍是 2。
    await expect(appliedCells.turns, '提交被算成了一个新轮次').toHaveText('2 turns')
    await expect(cells.commits, '没提交过的那条也显示 1 commits ⇒ 计数被算成了全局值').toHaveText(
      '0 commits',
    )

    // ---- 归档：阶段保留，但整条被标成只读 ----
    await apiArchiveSession(stageDaemon, generatingId)
    await page.reload()
    await expect(chip, '归档后 chip 与在用会话长得一样 ⇒ 用户点进去才发现是只读的').toHaveText(
      'Archived · Step 3/4 · Review',
    )
    await expect(chip, '归档没用中性色 ⇒ 它仍然在抢用户注意力').toHaveClass(/status-chip--neutral/)
  } finally {
    rmSync(holdFile, { force: true })
    if (stageDaemon !== undefined) await stageDaemon.stop()
    rmSync(holdDir, { recursive: true, force: true })
  }
})
