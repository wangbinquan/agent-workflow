// RFC-319 —— 设置分区外壳（CFG-03 / CFG-X5）、身份与出站凭据的**拆除**闸门
// （CFG-X4 / CFG-X3）、反代部署下的对外地址（CFG-X6）、在线状态的实时推送（UX-39）、
// 意图评审区的空态与工作上下文回填（INTENT-X5 / INTENT-X7），以及任务变更页签的
// 两薄片（TASK-35：结构化 diff 作用域切换 + 1 MiB 截断提示）。
//
// 这一批的共同点是「**没人会主动去点、坏了也不报错**」：
//
//   * 【CFG-03】设置分区导航在窄屏折叠成一条下拉。折叠这一半今天有覆盖，**「并可
//     切换」那一半从来没被执行过**——`e2e/rfc319-settings-sections.spec.ts:147-156`
//     的 `clickSectionNav` 写了 compact 分支，但全文件都在 1280 宽跑，那条分支
//     一次都没进过。它坏掉的形态是：手机上打开设置页，看得见分区名、点了没反应。
//   * 【CFG-X5】分区导航上的三种徽标是「你在别的分区还有事没办完」的**唯一**提示。
//     既有 CFG-07 只验了「脏」与「服务端已变」两格；**「结果未知」（danger）那一格
//     全仓没有任何用例看过**（`e2e/settings-outcome-unknown.spec.ts` 刻意只认告警条，
//     还在注释里把导航徽标排除掉了）。三格必须**互相分得开**，否则用户看到一个
//     感叹号，分不清是「别人改了」还是「我这次保存生死不明」——两者的正确动作相反。
//   * 【CFG-X4】OIDC provider 的增删改与连接测试的**正向**面已由
//     `e2e/rfc319-iam-oidc-and-acl.spec.ts` 的 IAM-11 走通（真假 IdP、真回环）。
//     本文件只补它没碰的那一片：**防自锁**。密码登录关掉之后，最后一个已启用的
//     provider 既不能删也不能停用——一旦漏掉，管理员点两下就把**所有人**关在门外，
//     而恢复手段只剩改数据库。判据必须两层：界面把入口关死 + 服务端 409，
//     只做前者等于任何一次 curl 都能把系统锁死。
//   * 【CFG-X3】codeHosts 的保存 / 测试连接 / TLS 开关 / URL 前缀已由 REPO-34 与
//     REPO-36 覆盖，**删除**这一格没有。而删除恰恰是最贵的一步：它会**连带撤销
//     所有人的个人推送凭据**，服务端为此设计了「先告诉你影响、再要求你带着影响
//     摘要重来一次」的两步确认。它坏掉的形态是一次点击静默吊销 N 个人的凭据，
//     下一次自动推送才在别人的任务里报错。
//   * 【CFG-X6】反代部署下 `publicBaseUrl` 是**要粘进 GitLab 的那条地址**的唯一来源
//     （`webhookEndpoints.ts:87-97` 明确禁止用 `c.req.url`）。没配的时候产品必须
//     **老实说「还给不出完整 URL」并给出路径**，而不是拿请求头拼一个看起来对、
//     实际打不到的地址出来。这条与 `/.well-known/mcp` 的规则**故意不同**
//     （`routes/publicOrigin.ts:17-24`），本用例把两者放在同一次请求里对照。
//   * 【UX-39】在线圆点随 `/ws/presence` 实时增删。既有 IAM-42 锁的是**权限门**
//     （撤权后 4403 关连接、圆点消失），**没有任何用例让第二个账号真的上线 / 下线过**。
//     它坏掉的形态是：圆点永远停在页面加载那一刻的快照，越看越像「大家都不在线」。
//   * 【INTENT-X5】评审区在没有候选时给的那段文案，是用户判断「我现在该去干嘛」的
//     唯一线索。四种可达状态必须各说各的话；混成一句「先描述目标」等于把正在生成、
//     正在追问、刚失败三种处境说成同一件事。
//   * 【INTENT-X7】工作上下文弹窗重开时要把**已排队/失败**的那条 delta 回填进表单。
//     不回填的后果不是「少了个便利」——用户会把想加的资源**再选一遍**提交，
//     而服务端只允许一条未决变更（`workingSet.ts:505-512`），于是他撞上 409，
//     或者（更坏）漏掉上一条里已经选好的资源，下一轮生成看不到它。
//   * 【TASK-35】变更页签的主链（真工作树 → 接口 → 面板）已由 REPO-X2 覆盖。
//     真缺的两薄片：**作用域切换**（今天只有 `e2e/rfc250-*` 用 `page.route` 灌假
//     数据点过那个下拉，从没走过真实的 `scope=node`）与 **1 MiB 截断提示**
//     （`util/git.ts:2258-2268`）。后者坏掉时用户拿到的是一份**被悄悄砍掉尾巴**的
//     diff，看起来完整。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链——外链会被 CI 的
// markdown link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/components/PageSectionNav.tsx:146-161,489-501  56rem 阈值 → compact/desktop 二选一
//   packages/frontend/src/components/PageSectionNav.tsx:282-301          Badge：tone → data-tone + aria-label
//   packages/frontend/src/routes/settings.tsx:205-231                    三态徽标的优先级：结果未知 > 服务端已变 > 脏
//   packages/frontend/src/routes/settings.tsx:240-250                    每个叶子都是真 Link（rail 形态）
//   packages/frontend/src/routes/settings.tsx:2180-2183                  lastEnabledProviderIsRequired / loginPolicyLocked
//   packages/frontend/src/routes/settings.tsx:2404-2421                  删除按钮的 disabled + title
//   packages/frontend/src/routes/settings.tsx:2447                       编辑弹窗的 preventDisable
//   packages/frontend/src/routes/settings.tsx:3086-3098                  Enabled 开关被 preventDisable 关死
//   packages/backend/src/services/oidcProviders.ts:213-230               PATCH enabled=false 的 last-enabled-oidc-required
//   packages/backend/src/services/oidcProviders.ts:255-270               DELETE 的 last-enabled-oidc-required
//   packages/frontend/src/components/settings/CodeHostsSection.tsx:317-359 删除的两步确认（impact → digest 重来）
//   packages/frontend/src/components/settings/CodeHostsSection.tsx:519-552 ConfirmDialog 的描述与 removeConfirmAgain
//   packages/backend/src/services/codeHost/connections.ts:503-557        remove()：撤销确认摘要 + 连带删除个人凭据
//   packages/backend/src/services/webhookEndpoints.ts:87-97              ingressUrl 只由 publicBaseUrl 拼，缺就是 null
//   packages/frontend/src/components/WebhookEndpointCard.tsx:416-440     有 URL 给复制按钮，没有就给告警条 + 路径
//   packages/backend/src/routes/publicOrigin.ts:17-24,77-94              /.well-known/mcp 与 webhook 入站 URL 的**不同**规则
//   packages/frontend/src/hooks/usePresence.ts:52-66,105-131             presence.changed 增量 → store → 圆点
//   packages/frontend/src/components/PresenceDot.tsx:14-28               online/offline/undefined 三态渲染
//   packages/backend/src/modules/identity-access/domain/userPresence.ts:9,26-48  连接计数 + 60s 宽限
//   packages/frontend/src/routes/intent.detail.tsx:624,1184-1212         draft===null 时按 journey.reason 选空态文案
//   packages/backend/src/services/intent/journey.ts:34-70                journey.reason 的唯一产地
//   packages/frontend/src/components/IntentMountDialog.tsx:61-82,103     未决 delta 回填 + replacesChangeId
//   packages/backend/src/services/intent/workingSet.ts:494-521           一条未决变更；replacesChangeId 才允许顶掉
//   packages/frontend/src/routes/tasks.detail.tsx:441-455,1248-1258      scope=node:<runId> → structural-diff 查询
//   packages/backend/src/services/structuralDiff/service.ts:215-330      node 作用域的 between / to-worktree 解析
//   packages/backend/src/services/structuralDiff/refSelect.ts:23-37      resolveNodeScope
//   packages/backend/src/util/git.ts:2258-2268                           worktreeDiff 的 1 MiB 上限 + truncated
//   packages/frontend/src/components/changes/ChangeReviewPanel.tsx:615-620 截断提示条
//
// 与既有覆盖的分工（务必不要重复）：
//   · `e2e/rfc319-settings-sections.spec.ts` —— CFG-01/02/05/07/09/23/26/27/35/36。
//     本文件的 CFG-03 只补它 `clickSectionNav` 里**从未被执行**的 compact 分支；
//     CFG-X5 只补它没验的 danger（结果未知）那一格与「三格互相分得开」。
//   · `e2e/settings-outcome-unknown.spec.ts` —— RES-08 的告警条与写屏障本身。
//     本文件不碰告警条，只看导航徽标。
//   · `e2e/rfc319-iam-oidc-and-acl.spec.ts` IAM-11 —— provider 的新增/编辑/删除/
//     连接测试**正向**面（含真假 IdP 起流）。本文件一条正向面都不重复。
//   · `e2e/rfc319-repo-groups-and-hosts.spec.ts` REPO-34 / REPO-36 —— codeHosts 的
//     保存 / 探活 / TLS 开关 / URL 前缀。本文件只走**删除**。
//   · `e2e/rfc319-webhook-endpoints.spec.ts` —— 端点全生命周期（该 daemon 一开始
//     就配好了 publicBaseUrl）。本文件反过来：从**没配**的状态出发。
//   · `e2e/rfc319-overview-and-docs.spec.ts` CFG-40 —— `/.well-known/mcp` 的 origin
//     派生（含 publicBaseUrl 压过转发头）。本文件不重复它，只把它与 webhook
//     入站 URL 的**规则差异**在同一次请求里对照出来。
//   · `e2e/rfc319-users-and-account.spec.ts` IAM-42 —— presence 的权限门。
//     本文件不碰权限，只让第二个账号真的上下线。
//   · `e2e/rfc319-worktree-and-commit.spec.ts` REPO-X2 —— 变更页签的主链。
//     本文件只补作用域切换与截断提示两片。
//
// 执行模型：三个 daemon（stub 行为互斥，都是 daemon 级 env），**不用 serial**
// （`docs/dev-gotchas.md`：serial 下第一条红之后其余 `did not run`，变异验证无法
// 按「红了几条」归因）。本文件只有 CFG-X5 用一次 `page.route`（把保存请求掐断，
// 复现「响应丢失」——这是产品里唯一进入 danger 徽标的路径），**零 `route.fetch()`**，
// `test.afterEach` 统一摘注入。
//
// ⚠️ 两处「按源码实际写、与账本措辞不符」的地方（详见交付报告 ⑤）：
//   * CFG-X6 的「MCP endpoint 的 origin」已被 CFG-40 完整覆盖（含 publicBaseUrl
//     压过转发头与子路径），本文件不重复；改为补它真正缺的那格——**没配
//     publicBaseUrl 时 webhook 端点卡片的诚实降级**，以及两条规则的差异对照。
//   * INTENT-X5 账本写「六种空状态（含 applied）」。`projectIntentJourney` 是
//     `journey.reason` 的**唯一**产地，而它**从不产出 `'applied'`**
//     （applied 那一档的 reason 是 `checkpoint-ready`），所以
//     `intent.detail.tsx:1197` 的 applied 分支在产品里不可达。本用例只锁四种
//     真正驱动得到的状态，不把不可达的分支写成期望。

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { initGitRepo, querySqlite, repoRemoteUrl, runGit, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)

const PASSWORD = 'Rfc319-Sid-2026!'

/** 反代部署下运维显式声明的对外地址（带子路径，覆盖最难的一种形态）。 */
const PUBLIC_BASE_URL = 'https://aw-proxy.rfc319.invalid/base'

let daemon: DaemonHandle
let intentDaemon: DaemonHandle
let taskDaemon: DaemonHandle

let scratchDir = ''
let intentHoldFile = ''
let intentFailFile = ''

const cleanupPaths: string[] = []

test.beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-sid-'))
  cleanupPaths.push(scratchDir)
  intentHoldFile = join(scratchDir, 'intent-hold')
  intentFailFile = join(scratchDir, 'intent-fail')
  ;[daemon, intentDaemon, taskDaemon] = await Promise.all([
    startDaemon(),
    startDaemon({
      stubMode: 'intent',
      extraEnv: {
        // questions 变体让「未作答」的那一轮吐追问 —— clarifying 空态的唯一来源。
        STUB_INTENT_VARIANT: 'questions',
        // 两个文件式开关：存在即生效，不存在即无害（stub 用 existsSync 判定），
        // 因此同一个 daemon 可以在不同用例里切换行为。
        STUB_INTENT_HOLD_FILE: intentHoldFile,
        STUB_INTENT_FAIL_FILE: intentFailFile,
      },
    }),
    startDaemon({ stubMode: 'slow', extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' } }),
  ])
})

test.afterAll(async () => {
  for (const handle of [daemon, intentDaemon, taskDaemon]) {
    if (handle !== undefined) await handle.stop()
  }
  for (const path of cleanupPaths) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

async function req(
  handle: DaemonHandle,
  path: string,
  init?: RequestInit & { token?: string },
): Promise<Response> {
  const { token, ...rest } = init ?? {}
  return fetch(`${handle.baseUrl}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token ?? handle.token}`,
      'Content-Type': 'application/json',
      ...(rest.headers ?? {}),
    },
  })
}

async function api<T>(
  handle: DaemonHandle,
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const res = await req(handle, path, init)
  const body = await res.text()
  expect(res.ok, `${init?.method ?? 'GET'} ${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function primeToken(target: Page, handle: DaemonHandle, token?: string): Promise<void> {
  await target.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: handle.baseUrl, tok: token ?? handle.token },
  )
}

async function openAs(
  browser: Browser,
  handle: DaemonHandle,
  token: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  await context.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: handle.baseUrl, tok: token },
  )
  return { context, page: await context.newPage() }
}

async function createUserAndLogin(
  handle: DaemonHandle,
  username: string,
): Promise<{ id: string; token: string }> {
  const created = await api<{ id: string }>(handle, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: `${username}@example.test`,
      displayName: username,
      role: 'user',
      password: PASSWORD,
    }),
  })
  const login = await fetch(`${handle.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  const body = await login.text()
  expect(login.ok, `login ${username}: ${login.status} ${body}`).toBe(true)
  return { id: created.id, token: (JSON.parse(body) as { sessionToken: string }).sessionToken }
}

function unique(prefix: string): string {
  return `${prefix}${process.pid}${Math.floor(Math.random() * 1e6)}`
}

// ---------------------------------------------------------------------------
// CFG-03 [P3] —— 窄屏折叠成 compact 下拉，**并且真能从这条下拉切分区**
// ---------------------------------------------------------------------------

test('RFC-319 CFG-03：窄屏把设置分区导航整条折叠成下拉，从下拉里选一个分区真的换页并改 URL，回到宽屏时选中的还是它 @nightly', async ({
  page,
}) => {
  await primeToken(page, daemon)
  // 390px = iPhone 逻辑宽度，远低于 PageSectionNav.tsx:148 的 56rem 阈值。
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${daemon.baseUrl}/settings?tab=git`)

  const nav = page.locator('nav.page-section-nav')
  await expect(
    nav,
    '窄屏下分区导航没有折叠 ⇒ 十一个分区的 rail 会把内容挤成一条，手机上根本没法用',
  ).toHaveAttribute('data-mode', 'compact', { timeout: 30_000 })

  // 「折叠」必须是**换掉**而不是**叠加**：rail 的真链接一条都不许留下。
  // 只断言下拉存在的话，rail 同时还在也照样绿。
  await expect(
    nav.locator('.page-section-nav__leaf'),
    'compact 形态下 rail 的分区链接还在 ⇒ 两套导航叠在一起，窄屏被撑出横向滚动条',
  ).toHaveCount(0)

  const compact = page.getByTestId('settings-compact-select')
  await expect(compact, '折叠了却没有下拉 ⇒ 用户在窄屏上失去了切换分区的**唯一**入口').toBeVisible()
  await expect(compact, '下拉不显示当前分区 ⇒ 用户不知道自己在看哪一块设置').toContainText('Git')

  // —— 「并可切换」：这条分支在既有 e2e 里从未被执行过。
  await compact.click()
  await page.getByRole('option', { name: /^GC\b/ }).click()

  await expect(
    page,
    '从 compact 下拉选了分区，URL 没跟着改 ⇒ 刷新 / 分享出去都会回到原来那一块',
  ).toHaveURL(/\/settings\?.*tab=gc/)
  await expect(
    page.locator('#settings-section-title-gc'),
    'URL 改了但面板没换 ⇒ 用户选了 GC，屏幕上还是 Git',
  ).toHaveText('GC', { timeout: 20_000 })
  await expect(
    page.getByTestId('settings-webhook-body-retention'),
    'GC 分区的控件没渲染 ⇒ 标题对了内容没对',
  ).toBeVisible()
  await expect(
    page.getByTestId('settings-task-commit-exclude-patterns'),
    '切走之后 Git 分区的控件还在 ⇒ 两个分区叠在一起',
  ).toHaveCount(0)
  await expect(
    compact,
    '切换之后下拉自己没更新 ⇒ 收起来之后用户读到的仍是上一个分区名',
  ).toContainText('GC')

  // —— 回到宽屏：形态换回 rail，且**当前分区跟着走**（不是重置回默认）。
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(nav, '宽屏没有换回 rail ⇒ 桌面端白白浪费一整条侧栏，还多一次点击').toHaveAttribute(
    'data-mode',
    'desktop',
    { timeout: 20_000 },
  )
  await expect(
    page.getByTestId('settings-compact-select'),
    '宽屏下 compact 下拉还在 ⇒ 同上，两套导航叠着',
  ).toHaveCount(0)
  await expect(
    nav.getByRole('link', { name: /^GC\b/ }),
    '换回宽屏后当前分区标记丢了 ⇒ 转屏一次就不知道自己在哪儿了',
  ).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#settings-section-title-gc')).toHaveText('GC')
})

// ---------------------------------------------------------------------------
// CFG-X5 [P3] —— 分区导航徽标的三格：脏 / 服务端已变 / 结果未知
// ---------------------------------------------------------------------------

/** 分区导航上某个叶子的徽标（不带 tone 过滤——tone 本身是被断言的对象）。 */
function navBadge(page: Page, label: string): Locator {
  return page
    .locator('nav.page-section-nav .page-section-nav__leaf', { hasText: label })
    .locator('.page-section-nav__badge')
}

test('RFC-319 CFG-X5：分区导航的三种徽标各挂各的分区、互相分得开——脏是圆点，服务端已变与结果未知都是感叹号但语气/文案不同 @nightly', async ({
  page,
}) => {
  await api(daemon, '/api/config', {
    method: 'PUT',
    body: JSON.stringify({ webhookDeliveryBodyRetentionDays: 30, maxConcurrentNodes: 4 }),
  })

  await primeToken(page, daemon)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)
  const retention = page.getByTestId('settings-webhook-body-retention')
  await expect(retention).toBeVisible({ timeout: 30_000 })

  // ① 脏：中性圆点。没有这一格，用户切走之后完全不知道那边还有没提交的改动。
  await retention.fill('11')
  const gcBadge = navBadge(page, 'GC')
  await expect(
    gcBadge,
    '改了值却不在导航上留标记 ⇒ 切到别的分区之后那份草稿就从视野里消失了',
  ).toHaveText('•')
  await expect(
    gcBadge,
    '「未保存」用了警示/危险的语气 ⇒ 与真正的冲突、真正的结果未知混为一谈',
  ).toHaveAttribute('data-tone', 'neutral')
  await expect(gcBadge).toHaveAttribute('aria-label', 'unsaved')

  // 负向对照（作用域）：没被碰过的分区一个徽标都不许有。
  await expect(
    navBadge(page, 'Appearance'),
    '没碰过的分区也挂上了徽标 ⇒ 徽标不是按分区算的，整条导航变成噪音',
  ).toHaveCount(0)

  // ② 服务端已变：同事在另一台机器上改了同一项。
  await api(daemon, '/api/config', {
    method: 'PUT',
    body: JSON.stringify({ webhookDeliveryBodyRetentionDays: 17 }),
  })

  // 页面要下一次拿到权威配置才可能发现冲突——用本分区之外的一次正常保存触发。
  await page
    .locator('nav.page-section-nav')
    .getByRole('link', { name: /^Limits\b/ })
    .click()
  const concurrency = page.getByRole('spinbutton', {
    name: /Max concurrent agent nodes \(global\)/,
  })
  await expect(concurrency).toBeVisible({ timeout: 20_000 })
  await concurrency.fill('5')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.form-actions__ok')).toBeVisible({ timeout: 20_000 })

  await expect(
    gcBadge,
    '同事改了我正在编辑的那一项，导航上却还是「未保存」⇒ 我回去一保存就把他的值冲掉',
  ).toHaveAttribute('data-tone', 'attention', { timeout: 20_000 })
  await expect(
    gcBadge,
    '「服务端已变」没有升级成感叹号 ⇒ 与普通的未保存长得一样，用户不会回头看',
  ).toHaveText('!')
  await expect(gcBadge).toHaveAttribute('aria-label', 'Server settings changed')

  // ③ 结果未知：把保存请求**掐断**（不是回 4xx——那是「已知失败」，走别的分支）。
  //    这是产品里唯一一条通向 danger 徽标的路径（settings.tsx:211-223）。
  let aborted = 0
  await page.route(`${daemon.baseUrl}/api/config`, async (route) => {
    const method = route.request().method()
    if (method === 'PUT' || method === 'PATCH') {
      aborted += 1
      await route.abort('connectionaborted')
      return
    }
    await route.continue()
  })
  await concurrency.fill('6')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const limitsBadge = navBadge(page, 'Limits')
  await expect(
    limitsBadge,
    '保存的结果生死不明，导航上却不是最高一档 ⇒ 用户以为只是「没保存」，' +
      '回头再点一次就可能把同一次写做两遍',
  ).toHaveAttribute('data-tone', 'danger', { timeout: 20_000 })
  await expect(limitsBadge).toHaveText('!')
  await expect(
    limitsBadge,
    '结果未知与服务端已变共用同一句无障碍文案 ⇒ 读屏用户完全分不清这两种处境',
  ).toHaveAttribute('aria-label', 'The previous save is still being reconciled with the server')
  expect(aborted, '保存请求没有被真的掐断，这一格的前提不成立').toBeGreaterThan(0)

  // ④ 三格是**按分区各算各的**，不是一个页面级开关：Limits 进了 danger，
  //    GC 仍然停在 attention，Appearance 仍然干净。
  await expect(
    gcBadge,
    'Limits 一出结果未知，GC 的徽标也跟着变了 ⇒ 徽标是页面级的，' +
      '用户无法判断到底哪一个分区出了事',
  ).toHaveAttribute('data-tone', 'attention')
  await expect(
    navBadge(page, 'Appearance'),
    '从头到尾没碰过的分区最后也挂上了徽标 ⇒ 同上',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// UX-39 [P3] —— 在线圆点随 /ws/presence 实时增删
// ---------------------------------------------------------------------------

/** 某个用户目录行上的在线点。行用 data-user-id 定位（UserDirectory.tsx:170）。 */
function presenceDot(page: Page, userId: string): Locator {
  return page.locator(`li.user-directory__item[data-user-id="${userId}"] .presence-dot`)
}

test('RFC-319 UX-39：另一个账号上线 / 下线时，管理员**不刷新**的用户目录上那颗圆点当场改变，且只改他那一颗 @nightly', async ({
  page,
  browser,
}) => {
  const bob = await createUserAndLogin(daemon, unique('rfc319ux39bob'))
  // carol 全程不登录：她是「这次变化只落在 bob 身上」的负向对照。
  const carol = await createUserAndLogin(daemon, unique('rfc319ux39carol'))
  const me = (await api<{ user: { id: string } }>(daemon, '/api/auth/me')).user

  await primeToken(page, daemon)
  await page.goto(`${daemon.baseUrl}/users`)

  // 前提自证：管理员自己这一屏是活的（他自己就握着一条 presence 连接）。
  // 这一句不成立时，下面的「bob 从离线变在线」会退化成一条空洞的绿。
  await expect(
    presenceDot(page, me.id),
    '管理员自己都没有在线点 ⇒ presence 通道压根没连上，这条用例后面什么都验不到',
  ).toHaveClass(/presence-dot--online/, { timeout: 30_000 })
  await expect(
    presenceDot(page, bob.id),
    'bob 从未登录过却被显示成在线 ⇒ 在线名单不是真的，谁在谁不在全靠猜',
  ).toHaveClass(/presence-dot--offline/)
  await expect(presenceDot(page, bob.id)).toHaveAttribute('aria-label', 'Offline')

  // —— 上线：bob 在另一个浏览器上下文里打开应用（AppShell 建立 /ws/presence）。
  const session = await openAs(browser, daemon, bob.token)
  try {
    await session.page.goto(`${daemon.baseUrl}/`)
    await expect(session.page.getByTestId('shell-navigation-desktop')).toBeVisible({
      timeout: 30_000,
    })

    await expect(
      presenceDot(page, bob.id),
      'bob 上线了，管理员**没刷新**的这一屏还写着离线 ⇒ 圆点只是页面加载那一刻的快照，' +
        '看久了会让人以为所有人都不在线',
    ).toHaveClass(/presence-dot--online/, { timeout: 60_000 })
    await expect(presenceDot(page, bob.id)).toHaveAttribute('aria-label', 'Online')

    // 只改他那一颗：carol 没登录过，不许被这次广播带成在线。
    await expect(
      presenceDot(page, carol.id),
      'bob 一上线，从没登录过的 carol 也变成在线 ⇒ 增量帧被当成了全量快照，' +
        '整张表的在线状态从此都是假的',
    ).toHaveClass(/presence-dot--offline/)
  } finally {
    await session.context.close()
  }

  // —— 下线：连接断开后进入 60s 宽限（userPresence.ts:9 的 PRESENCE_GRACE_MS，
  //    刻意抵消刷新 / 路由跳转造成的抖动），宽限到期才翻成离线。
  await expect(
    presenceDot(page, bob.id),
    'bob 关掉浏览器超过宽限期之后仍显示在线 ⇒ 在线名单只增不减，' +
      '任何人只要来过一次就永远「在线」',
  ).toHaveClass(/presence-dot--offline/, { timeout: 120_000 })
  await expect(
    presenceDot(page, me.id),
    'bob 下线把管理员自己也带成了离线 ⇒ 离线增量被当成全量清空',
  ).toHaveClass(/presence-dot--online/)
})

// ---------------------------------------------------------------------------
// CFG-X3 [P2] —— codeHosts 连接的删除：连带撤销个人推送凭据的两步确认
// ---------------------------------------------------------------------------

interface CodeHostWire {
  provider: string
  configured: boolean
  connectionGeneration: string | null
  endpointBindingDigest: string | null
  personalPushCredentialCount: number
  tokenHint: string
}

test('RFC-319 CFG-X3：删除 GitLab 连接会连带吊销别人的个人推送凭据——第一次确认只换来影响摘要，第二次确认才真的删，凭据同时消失 @nightly', async ({
  page,
}) => {
  const pusher = await createUserAndLogin(daemon, unique('rfc319cfgx3'))

  // 连接必须带 transportMappings，端点绑定摘要才有值——没有它就没有「个人凭据
  // 会被吊销」这件事，两步确认那条分支根本不可达（connections.ts:516-519）。
  await api(daemon, '/api/code-hosts/gitlab', {
    method: 'PUT',
    body: JSON.stringify({
      baseUrl: 'https://gitlab.rfc319.invalid/api/v4',
      token: 'rfc319-cfgx3-platform-token',
      transportMappings: [
        { sshHost: 'ssh.rfc319.invalid', httpBaseUrl: 'https://gitlab.rfc319.invalid' },
      ],
    }),
  })

  const binding = (
    await api<{ items: CodeHostWire[] }>(daemon, '/api/account/code-host-push-credentials', {
      token: pusher.token,
    })
  ).items.find((item) => item.provider === 'gitlab')
  expect(binding?.endpointBindingDigest, '连接没有端点绑定摘要 ⇒ 前提不成立').toBeTruthy()

  await api(daemon, '/api/account/code-host-push-credentials/gitlab', {
    method: 'PUT',
    token: pusher.token,
    body: JSON.stringify({
      token: 'rfc319-cfgx3-personal-token',
      connectionGeneration: binding!.connectionGeneration,
      endpointBindingDigest: binding!.endpointBindingDigest,
    }),
  })

  const before = (await api<CodeHostWire[]>(daemon, '/api/code-hosts')).find(
    (row) => row.provider === 'gitlab',
  )
  expect(before?.configured, '前提：连接应当已配置').toBe(true)
  expect(
    before?.personalPushCredentialCount,
    '个人凭据没有被算进连接的影响面 ⇒ 管理员删除时看不到任何警告',
  ).toBe(1)

  await primeToken(page, daemon)
  await page.goto(`${daemon.baseUrl}/settings?tab=codeHosts`)
  await expect(page.getByTestId('code-host-card-gitlab')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('code-host-remove-gitlab').click()
  const confirm = page.getByRole('dialog')
  await expect(confirm).toBeVisible()
  await expect(
    confirm,
    '删除确认框只字不提会吊销别人的个人凭据 ⇒ 管理员以为只是删掉自己填的那个平台令牌，' +
      '实际把每个人的推送都掐了',
  ).toContainText('revokes 1 personal push credential')

  // ① 第一次确认：服务端只交出影响摘要（409），**不许**就此删除。
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(
    confirm,
    '第一次确认就把连接删了 ⇒ 服务端准备的「带着影响摘要再来一次」形同虚设',
  ).toBeVisible()
  await expect(
    confirm,
    '第一次确认被拒之后不说原因 ⇒ 管理员看到一个点不动的删除按钮，只能刷新重来',
  ).toContainText('The server prepared a current confirmation for 1 personal credential')
  expect(
    (await api<CodeHostWire[]>(daemon, '/api/code-hosts')).find((r) => r.provider === 'gitlab')
      ?.configured,
    '弹窗还开着，连接却已经在服务端被删了 ⇒ 两步确认只是界面上的形式',
  ).toBe(true)

  // ② 第二次确认：这次带着服务端刚给的摘要，才真的落库。
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm, '第二次确认之后弹窗没关 ⇒ 删除没成功').toHaveCount(0, { timeout: 20_000 })

  await expect(
    page.getByTestId('code-host-remove-gitlab'),
    '连接删掉了，卡片上还留着删除按钮 ⇒ 界面没回到「未配置」，用户会以为还连着',
  ).toHaveCount(0, { timeout: 20_000 })
  const after = (await api<CodeHostWire[]>(daemon, '/api/code-hosts')).find(
    (row) => row.provider === 'gitlab',
  )
  expect(after?.configured, '连接没有真的从服务端消失').toBe(false)
  expect(after?.tokenHint, '连接删了却还留着平台令牌的尾号 ⇒ 密封值可能也还在').toBe('')

  // ③ 真正的代价必须兑现：那位用户的个人推送凭据一起没了。
  const remaining = await api<{ items: Array<{ provider: string; configured?: boolean }> }>(
    daemon,
    '/api/account/code-host-push-credentials',
    { token: pusher.token },
  )
  expect(
    remaining.items.some((item) => item.provider === 'gitlab' && item.configured === true),
    '连接删了，别人的个人凭据还挂在一个已经不存在的端点上 ⇒ 确认框里那句「会吊销」是空话，' +
      '而下一次推送才会在别人的任务里以一条看不懂的错误爆出来',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// CFG-X4 [P2] —— authentication 分区的防自锁：最后一个已启用 provider
// ---------------------------------------------------------------------------

interface OidcProviderWire {
  id: string
  slug: string
  displayName: string
  enabled: boolean
}

test('RFC-319 CFG-X4：关掉密码登录之后，最后一个已启用的 OIDC provider 在界面与服务端两层都删不掉也停不掉；把密码登录打开，同一个按钮当场松开 @nightly', async ({
  page,
}) => {
  const slug = unique('x4')
  let providerId: string | null = null
  try {
    await primeToken(page, daemon)
    await page.goto(`${daemon.baseUrl}/settings?tab=authentication`)
    await expect(page.locator('#settings-section-title-authentication')).toHaveText(
      'Authentication',
      { timeout: 30_000 },
    )

    // ① 一个 provider 都没有时，密码登录**必须**关不掉——否则登录页上一个可用的
    //    凭据方式都不剩，谁都进不来。
    const passwordSwitch = page.getByTestId('password-login-switch')
    await expect(
      passwordSwitch,
      '没有任何已启用的身份提供方，密码登录开关却是可点的 ⇒ 管理员点一下就把自己和所有人锁在门外',
    ).toBeDisabled()
    await expect(
      page.locator('.auth-login-policy__row', { hasText: 'Username and password sign-in' }),
      '关不掉却不说为什么 ⇒ 管理员只看到一个灰掉的开关，会以为是权限问题',
    ).toContainText('No identity provider is enabled')

    // ② 经界面加一个 provider（IAM-11 已验过它能起真实登录流，这里不重复）。
    await page.getByTestId('oidc-add-provider').click()
    const addDialog = page.getByRole('dialog')
    await addDialog.getByRole('textbox', { name: /^Slug/ }).fill(slug)
    await addDialog.getByRole('textbox', { name: /^Display name/ }).fill('RFC-319 CFG-X4 IdP')
    await addDialog
      .getByRole('textbox', { name: /^Issuer URL/ })
      .fill('https://idp.rfc319.invalid/realms/cfgx4')
    await addDialog.getByRole('textbox', { name: /^Client ID/ }).fill('rfc319-cfgx4-client')
    await addDialog.locator('input[type="password"]').fill('rfc319-cfgx4-secret')
    await addDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(addDialog).toHaveCount(0)

    providerId =
      (await api<OidcProviderWire[]>(daemon, '/api/oidc/providers')).find((p) => p.slug === slug)
        ?.id ?? null
    expect(providerId, '新建的 provider 没落库 ⇒ 后面的闸门无从验起').toBeTruthy()

    // 有了一个已启用的 provider，密码登录的开关才松开——这是①的正向对照。
    await expect(
      passwordSwitch,
      '加了一个已启用的 provider，密码登录开关仍然点不动 ⇒ 那道锁不是按「还有没有别的登录方式」算的',
    ).toBeEnabled({ timeout: 20_000 })

    // 此刻密码登录还开着，所以删除按钮**必须**是可点的（下面那道闸门的反面对照）。
    await expect(
      page.getByTestId(`oidc-delete-${providerId}`),
      '密码登录还开着就已经不让删 provider 了 ⇒ 闸门与登录策略无关，纯属拦人',
    ).toBeEnabled()

    // ③ 关掉密码登录（危险操作，走二次确认）。
    await passwordSwitch.click()
    const offDialog = page.getByRole('dialog')
    await expect(
      offDialog,
      '关闭密码登录没有二次确认 ⇒ 一次误点就把全站的密码入口关了',
    ).toContainText('Turn off username and password sign-in?')
    await offDialog.getByRole('button', { name: 'Turn off password sign-in', exact: true }).click()
    await expect(offDialog).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (await api<{ passwordLoginEnabled: boolean }>(daemon, '/api/oidc/login-policy'))
            .passwordLoginEnabled,
        { timeout: 20_000, message: '密码登录没有真的关掉，下面的闸门前提不成立' },
      )
      .toBe(false)

    // ④ 界面这一层：删除按钮关死，并说明原因。
    const deleteButton = page.getByTestId(`oidc-delete-${providerId}`)
    await expect(
      deleteButton,
      '密码登录已关，唯一的 provider 仍然可以删 ⇒ 点下去之后没有任何登录方式，' +
        '恢复手段只剩改数据库',
    ).toBeDisabled({ timeout: 20_000 })
    await expect(deleteButton, '关死了却不说为什么 ⇒ 管理员会以为是自己权限不够').toHaveAttribute(
      'title',
      'At least one enabled identity provider is required while password sign-in is off.',
    )

    // 编辑弹窗里的「启用」开关同样关死——绕过删除去停用是等价的自锁路径。
    await page.getByTestId(`oidc-edit-${providerId}`).click()
    const editDialog = page.getByRole('dialog')
    await expect(
      editDialog.getByRole('checkbox', { name: 'Enabled' }),
      '删不掉但停得掉 ⇒ 换一条路照样把所有登录方式关光',
    ).toBeDisabled()
    await editDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editDialog).toHaveCount(0)

    // ⑤ 服务端这一层：只关界面等于没关——任何一次 curl 都能绕过去。
    const deleteRes = await req(daemon, `/api/oidc/providers/${providerId}`, { method: 'DELETE' })
    expect(deleteRes.status, '界面关死了，DELETE 接口照删 ⇒ 防自锁只是一层化妆品').toBe(409)
    expect((await deleteRes.json()) as { code: string }).toMatchObject({
      code: 'last-enabled-oidc-required',
    })
    const disableRes = await req(daemon, `/api/oidc/providers/${providerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })
    expect(
      disableRes.status,
      '界面关死了，PATCH enabled=false 照样能停用 ⇒ 同上，换个动词就绕过去了',
    ).toBe(409)
    expect(
      (await api<OidcProviderWire[]>(daemon, '/api/oidc/providers')).find(
        (p) => p.id === providerId,
      )?.enabled,
      '被 409 拒绝的那次停用竟然改了状态 ⇒ 拒绝发生在写入之后',
    ).toBe(true)

    // ⑥ 把密码登录打开，闸门当场松开——证明这道闸是**条件**而不是一刀切。
    await page.getByTestId('password-login-switch').click()
    await expect
      .poll(
        async () =>
          (await api<{ passwordLoginEnabled: boolean }>(daemon, '/api/oidc/login-policy'))
            .passwordLoginEnabled,
        { timeout: 20_000, message: '密码登录没有被重新打开' },
      )
      .toBe(true)
    await expect(
      page.getByTestId(`oidc-delete-${providerId}`),
      '密码登录恢复之后仍然不让删 ⇒ provider 一旦建起来就永远删不掉了',
    ).toBeEnabled({ timeout: 20_000 })

    await page.getByTestId(`oidc-delete-${providerId}`).click()
    const confirm = page.getByRole('dialog')
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await api<OidcProviderWire[]>(daemon, '/api/oidc/providers')).some(
            (p) => p.id === providerId,
          ),
        { timeout: 20_000, message: '解除闸门之后仍然删不掉' },
      )
      .toBe(false)
    providerId = null
  } finally {
    // 无论中途在哪一步红，都必须把这台共享 daemon 的登录策略还原，
    // 否则后面用到密码登录的用例会全部陪绑。
    await req(daemon, '/api/oidc/login-policy', {
      method: 'PUT',
      body: JSON.stringify({ passwordLoginEnabled: true }),
    })
    if (providerId !== null) {
      await req(daemon, `/api/oidc/providers/${providerId}`, { method: 'DELETE' })
    }
  }
})

// ---------------------------------------------------------------------------
// INTENT-X5 [P3] —— 评审区空态按 journey.reason 切文案
// ---------------------------------------------------------------------------

interface IntentDetailLite {
  session: {
    turnSeq: number
    contextRevision: number
    inFlight: boolean
    journey: { reason: string }
  }
  currentDraft: unknown | null
  mounts: Array<{ resourceId: string }>
  workingSetChange: {
    id: string
    state: string
    delta: { additions: Array<{ resourceId: string }> }
  } | null
}

async function intentDetail(sessionId: string): Promise<IntentDetailLite> {
  return api<IntentDetailLite>(intentDaemon, `/api/intent-sessions/${sessionId}`)
}

async function startIntentSession(message: string): Promise<string> {
  const created = await api<{ id: string }>(intentDaemon, '/api/intent-sessions', {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  return created.id
}

async function waitForIntentReason(sessionId: string, reason: string): Promise<void> {
  await expect
    .poll(async () => (await intentDetail(sessionId)).session.journey.reason, {
      timeout: 120_000,
      message: `会话 ${sessionId} 没有落到 journey.reason=${reason}`,
    })
    .toBe(reason)
}

/** 评审区的空态卡片（`intent.detail.tsx:1201-1212`，无 testid，按类名定位）。 */
function reviewEmpty(page: Page): Locator {
  return page.locator('.intent-session__draft-empty')
}

test('RFC-319 INTENT-X5：没有候选可评审时，评审区按 journey.reason 换四段文案——正在生成 / 等你作答 / 生成失败 / 已归档，各说各的话 @nightly', async ({
  page,
}) => {
  await primeToken(page, intentDaemon)

  // —— ① 正在生成：把这一轮挂住，会话稳定停在 inFlight。
  writeFileSync(intentHoldFile, '', 'utf-8')
  let held = true
  let generatingSession = ''
  try {
    generatingSession = await startIntentSession('rfc319-x5: build an auditor agent')
    await waitForIntentReason(generatingSession, 'generation-running')

    await page.goto(`${intentDaemon.baseUrl}/intent/${generatingSession}`)
    await expect(page.getByTestId('intent-review-workspace')).toBeVisible({ timeout: 30_000 })
    await expect(
      reviewEmpty(page).getByRole('heading'),
      '正在生成时评审区却写着「先描述目标」⇒ 用户以为自己没提交，会再发一遍',
    ).toHaveText('Building your draft')
    await expect(reviewEmpty(page)).toContainText('Execution is visible in Build')
  } finally {
    if (held && existsSync(intentHoldFile)) unlinkSync(intentHoldFile)
    held = false
  }

  // —— ② 等你作答：同一个会话，放开之后 stub 吐一轮追问。
  await waitForIntentReason(generatingSession, 'answer-questions')
  await page.reload()
  await expect(
    reviewEmpty(page).getByRole('heading'),
    '轮到用户作答了，评审区仍写着「正在生成」⇒ 会话看起来卡死，实际是在等他回答',
  ).toHaveText('A decision is needed', { timeout: 30_000 })
  await expect(reviewEmpty(page)).toContainText('Answer the clarifying questions in Build')

  // —— ③ 生成失败：另起一个会话，让这一轮跑完却一个信封都不吐。
  writeFileSync(intentFailFile, '', 'utf-8')
  let failedSession = ''
  try {
    failedSession = await startIntentSession('rfc319-x5: this run will not emit an envelope')
    await waitForIntentReason(failedSession, 'generation-failed')
  } finally {
    if (existsSync(intentFailFile)) unlinkSync(intentFailFile)
  }

  await page.goto(`${intentDaemon.baseUrl}/intent/${failedSession}`)
  await expect(
    reviewEmpty(page).getByRole('heading'),
    '生成失败了评审区却不说 ⇒ 用户盯着一块空白等，不知道要去 Build 看证据并重试',
  ).toHaveText('Generation needs attention', { timeout: 30_000 })
  await expect(
    reviewEmpty(page),
    '失败文案不点明「没有资源被改动」⇒ 用户不敢重试，怕留下半截产物',
  ).toContainText('no resources were changed')

  // —— ④ 已归档：同一个会话归档之后，文案要从「去重试」改成「只读」。
  await api(intentDaemon, `/api/intent-sessions/${failedSession}/archive`, { method: 'POST' })
  await waitForIntentReason(failedSession, 'archived')
  await page.reload()
  await expect(
    reviewEmpty(page).getByRole('heading'),
    '归档之后仍写着「去重试」⇒ 用户点进 Build 才发现整个会话是只读的',
  ).toHaveText('Archived session', { timeout: 30_000 })
  await expect(reviewEmpty(page)).toContainText('read-only')
})

// ---------------------------------------------------------------------------
// INTENT-X7 [P3] —— 工作上下文弹窗重开时回填已排队的 delta
// ---------------------------------------------------------------------------

/**
 * 从 MultiSelect 的弹层里挑一行资源。
 *
 * 选项的可及名是「名称 + 描述」两行拼起来的（`MultiSelect.tsx:364-370`），
 * 所以 `exact: true` 永远匹配不上；按名称**前缀**锚，避免退化成一个能匹配到
 * 任意一行的宽松子串。列表 portal 到 body，因此从 `page` 而不是 dialog 起手。
 */
async function pickResource(page: Page, name: string): Promise<void> {
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click()
  // 多选弹层选完不会自己收起（还要继续选），而它 portal 到 body、正好盖住弹窗页脚。
  // Escape 只收弹层：Dialog 的 ESC 处理会尊重 `defaultPrevented`（Dialog.tsx:214-226），
  // 所以这一下不会把整个弹窗关掉——下一句就是这件事的守卫。
  await page.getByTestId('intent-mount-picker').press('Escape')
  await expect(
    page.getByRole('listbox', { name: 'Select resources' }),
    '资源弹层按 Escape 之后没收起 ⇒ 它会一直盖着弹窗页脚，用户点不到提交',
  ).toHaveCount(0)
  await expect(
    page.getByRole('dialog'),
    '收弹层的那一下把整个工作上下文弹窗也关了 ⇒ 用户每选一个资源就得重开一次',
  ).toBeVisible()
}

test('RFC-319 INTENT-X7：工作上下文弹窗重开时把已排队的那条 delta 原样回填进表单，接着加一个再提交是**顶掉**旧的那条而不是撞上「已有未决变更」 @nightly', async ({
  page,
}) => {
  const first = await api<{ id: string; name: string }>(intentDaemon, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: unique('rfc319x7first'),
      description: 'RFC-319 INTENT-X7 fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'fixture',
    }),
  })
  const second = await api<{ id: string; name: string }>(intentDaemon, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: unique('rfc319x7second'),
      description: 'RFC-319 INTENT-X7 fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'fixture',
    }),
  })

  await primeToken(page, intentDaemon)
  writeFileSync(intentHoldFile, '', 'utf-8')
  let sessionId = ''
  try {
    // 只有「这一轮还在飞」时才排得出 queued 的工作上下文变更。
    sessionId = await startIntentSession('rfc319-x7: keep this turn running')
    await waitForIntentReason(sessionId, 'generation-running')

    await page.goto(`${intentDaemon.baseUrl}/intent/${sessionId}`)
    await expect(page.getByTestId('intent-build-workspace')).toBeVisible({ timeout: 30_000 })

    // —— 负向对照：还没有任何未决变更时，弹窗一开是**空**的。
    await page.getByTestId('intent-add-mount').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const queueButton = dialog.getByRole('button', { name: 'Refresh after this turn', exact: true })
    await expect(
      queueButton,
      '什么都没选，提交按钮就是可点的 ⇒ 下面「重开即可提交」那一格会变成恒真',
    ).toBeDisabled()
    await expect(
      dialog.locator('.intent-working-context-dialog__summary'),
      '空表单也报出了待办条目 ⇒ 同上',
    ).toHaveCount(0)

    // 选第一个代理并排队。选项的可及名 = 「名称 + 描述」（MultiSelect.tsx:364-370
    // 把两行都放进 li），所以按前缀匹配而不是 exact。
    await dialog.getByTestId('intent-mount-picker').click()
    await pickResource(page, first.name)
    await expect(dialog.locator('.intent-working-context-dialog__summary')).toHaveText(
      '1 to add · 0 to remove',
    )
    await queueButton.click()
    await expect(dialog).toHaveCount(0, { timeout: 20_000 })

    await expect
      .poll(async () => (await intentDetail(sessionId)).workingSetChange?.state, {
        timeout: 30_000,
        message: '第一条工作上下文变更没有排上队',
      })
      .toBe('queued')
    const queued = (await intentDetail(sessionId)).workingSetChange!
    expect(
      queued.delta.additions.map((a) => a.resourceId),
      '排队的那条变更里不是我刚选的那个代理',
    ).toEqual([first.id])

    // —— 正题：重开弹窗，表单必须**已经**带着那条未决的 delta。
    await page.getByTestId('intent-add-mount').click()
    const reopened = page.getByRole('dialog')
    await expect(reopened).toBeVisible()
    await expect(
      reopened.locator('.intent-working-context-dialog__summary'),
      '重开弹窗时已排队的 delta 没有回填 ⇒ 用户看到一张空表单，' +
        '以为上次没提交成功，只会把同样的东西再选一遍',
    ).toHaveText('1 to add · 0 to remove')
    await expect(
      reopened.locator('.multi-select__field'),
      '回填的是数量不是内容 ⇒ 用户看不出上次到底排了哪个资源',
    ).toContainText(first.name)
    await expect(
      reopened.getByRole('button', { name: 'Refresh after this turn', exact: true }),
      '回填之后提交入口仍是灰的 ⇒ 用户改不动这条已排队的变更，只能整条丢弃重来',
    ).toBeEnabled()
    await expect(
      reopened.getByRole('button', { name: 'Discard pending update', exact: true }),
      '重开时没有「丢弃」出路 ⇒ 一条排错的变更会一直卡在会话顶上',
    ).toBeVisible()

    // 在回填的基础上再加一个，提交。
    await reopened.getByTestId('intent-mount-picker').click()
    await pickResource(page, second.name)
    await expect(reopened.locator('.intent-working-context-dialog__summary')).toHaveText(
      '2 to add · 0 to remove',
    )
    await reopened.getByRole('button', { name: 'Refresh after this turn', exact: true }).click()
    await expect(
      reopened,
      '第二次提交没关掉弹窗 ⇒ 多半是撞上了「已有未决变更」的 409：' +
        'replacesChangeId 没带上，用户根本改不了自己刚排的那条',
    ).toHaveCount(0, { timeout: 20_000 })

    const replaced = (await intentDetail(sessionId)).workingSetChange
    expect(replaced?.state, '顶掉之后没有留下一条新的排队变更').toBe('queued')
    expect(replaced?.id, '提交之后未决的还是原来那条 ⇒ 我这次的编辑压根没落库').not.toBe(queued.id)
    expect(
      [...(replaced?.delta.additions.map((a) => a.resourceId) ?? [])].sort(),
      '顶掉旧变更之后只剩新选的那个 ⇒ 回填出来的东西提交时被丢了，' +
        '下一轮生成看不到用户上次排进去的资源',
    ).toEqual([first.id, second.id].sort())
  } finally {
    if (existsSync(intentHoldFile)) unlinkSync(intentHoldFile)
  }

  // 放开之后这条变更必须真的活化——否则上面验的全是一堆没人消费的行。
  await expect
    .poll(async () => (await intentDetail(sessionId)).workingSetChange?.state, {
      timeout: 120_000,
      message: '排队的工作上下文变更在这一轮结束后没有被活化',
    })
    .toBe('applied')
  expect(
    [...(await intentDetail(sessionId)).mounts.map((m) => m.resourceId)].sort(),
    '活化之后两个代理没有都挂进工作上下文 ⇒ 回填的那一半在路上丢了',
  ).toEqual(expect.arrayContaining([first.id, second.id]))
})

// ---------------------------------------------------------------------------
// TASK-35 [P2] —— 变更页签：结构化 diff 的作用域切换 / 1 MiB 截断提示
// ---------------------------------------------------------------------------

const ALPHA_BASE = 'export function alphaOne(): number {\n  return 1\n}\n'
const BETA_BASE = 'export function betaOne(): number {\n  return 1\n}\n'

interface TaskDto {
  id: string
  status: string
  worktreePath: string
  baseCommit: string | null
}

interface NodeRunRow {
  id: string
  node_id: string
}

let taskFixtures: { agentId: string; workflowId: string } | null = null

async function seedTaskFixtures(): Promise<{ agentId: string; workflowId: string }> {
  if (taskFixtures !== null) return taskFixtures
  const name = unique('rfc319t35')
  const agent = await api<{ id: string }>(taskDaemon, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 TASK-35 fixture',
      outputs: ['answer'],
      readonly: false,
      bodyMd: '',
    }),
  })
  const workflow = await api<{ id: string }>(taskDaemon, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `${name}-wf`,
      description: 'RFC-319 TASK-35 fixture',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'node_one',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: name,
            promptTemplate: 'First writer.',
            position: { x: 0, y: 0 },
          },
          {
            id: 'node_two',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: name,
            promptTemplate: 'Second writer. upstream={{upstream}}',
            position: { x: 400, y: 0 },
          },
          {
            id: 'final_output',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'node_two', portName: 'answer' } }],
            position: { x: 800, y: 0 },
          },
        ],
        edges: [
          {
            id: 'one_to_two',
            source: { nodeId: 'node_one', portName: 'answer' },
            target: { nodeId: 'node_two', portName: 'upstream' },
          },
        ],
      },
    }),
  })
  taskFixtures = { agentId: agent.id, workflowId: workflow.id }
  return taskFixtures
}

/** 一个带 main 与两个 TypeScript 文件的夹具仓（结构化 diff 才有方法可数）。 */
function seedRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `aw-rfc319-sid-${label}-`))
  cleanupPaths.push(repo)
  writeFileSync(join(repo, 'README.md'), '# rfc-319 task-35 fixture\n', 'utf-8')
  writeFileSync(join(repo, 'alpha.ts'), ALPHA_BASE, 'utf-8')
  writeFileSync(join(repo, 'beta.ts'), BETA_BASE, 'utf-8')
  initGitRepo(repo, { email: 'e2e@test.local', message: 'rfc-319 task-35 seed' })
  return repo
}

async function runFixtureTask(label: string): Promise<TaskDto> {
  const fixtures = await seedTaskFixtures()
  const repo = seedRepo(label)
  const created = await req(taskDaemon, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: fixtures.workflowId,
      ref: 'main',
      inputs: {},
      name: `rfc319-task35-${label}`,
      repoUrl: repoRemoteUrl(repo),
    }),
  })
  const body = await created.text()
  expect(created.status, `POST /api/tasks: ${created.status} ${body}`).toBe(201)
  const taskId = (JSON.parse(body) as { id: string }).id
  await expect
    .poll(async () => (await api<TaskDto>(taskDaemon, `/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
      message: `任务 ${taskId} 没有跑完`,
    })
    .toBe('done')
  return api<TaskDto>(taskDaemon, `/api/tasks/${taskId}`)
}

function writeIntoWorktree(worktreePath: string, rel: string, contents: string): void {
  const target = join(worktreePath, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, 'utf-8')
}

interface StructuralDiffLite {
  summary: { files: number }
  files: Array<{ filePath: string }>
}

async function structuralDiff(taskId: string, query: string): Promise<StructuralDiffLite> {
  return api<StructuralDiffLite>(taskDaemon, `/api/tasks/${taskId}/structural-diff?${query}`)
}

test('RFC-319 TASK-35：变更页签的作用域下拉切到某个节点时，换上来的是那个节点自己写的那一份改动——别的节点的文件不在里面 @nightly', async ({
  page,
}) => {
  const task = await runFixtureTask('scope')
  expect(task.baseCommit, '任务没有基线提交 ⇒ 变更页签本来就不会渲染').toMatch(/^[0-9a-f]{40}$/)

  // 造两段「一个节点跑之前」的真实基线。
  // 注意：`node_runs.pre_snapshot` 今天没有生产写点（RFC-130 删掉 stash 快照后
  // `gitStashSnapshot` 零生产调用方），所以按生产会写的形态把它种进去，再走
  // **公共读接口**验证解析链——与 `e2e/rfc319-worktree-and-commit.spec.ts` 的
  // REPO-38c 同一套做法。这一格的产品缺陷已在交付报告 ⑤ 点名。
  writeIntoWorktree(
    task.worktreePath,
    'alpha.ts',
    `${ALPHA_BASE}\nexport function alphaTwo(): number {\n  return 2\n}\n`,
  )
  const afterFirst = runGit(['stash', 'create'], task.worktreePath).trim()
  expect(afterFirst, 'git stash create 没产出快照对象 ⇒ 种进去的会是个空值').toMatch(
    /^[0-9a-f]{40}$/,
  )
  writeIntoWorktree(
    task.worktreePath,
    'beta.ts',
    `${BETA_BASE}\nexport function betaTwo(): number {\n  return 2\n}\n`,
  )

  const dbFile = join(taskDaemon.home, 'db.sqlite')
  const runs = querySqlite<NodeRunRow>(
    dbFile,
    "SELECT id, node_id FROM node_runs WHERE task_id = ? AND node_id IN ('node_one','node_two') ORDER BY started_at ASC, id ASC",
    [task.id],
  )
  expect(
    runs.map((r) => r.node_id),
    '两个写节点没有各留下一条运行行',
  ).toEqual(['node_one', 'node_two'])
  const [runOne, runTwo] = runs
  runSqlite(
    dbFile,
    `UPDATE node_runs SET pre_snapshot = '${task.baseCommit}' WHERE id = '${runOne!.id}';` +
      `UPDATE node_runs SET pre_snapshot = '${afterFirst}' WHERE id = '${runTwo!.id}';`,
  )
  // 回读自证：`db.exec()` 对多语句脚本里的约束错误不抛异常（协议 §5.3）。
  const seeded = querySqlite<{ id: string; pre_snapshot: string | null }>(
    dbFile,
    'SELECT id, pre_snapshot FROM node_runs WHERE id IN (?, ?)',
    [runOne!.id, runTwo!.id],
  )
  expect(
    new Set(seeded.map((row) => row.pre_snapshot)),
    '快照没真的写进 node_runs ⇒ 节点作用域无从解析',
  ).toEqual(new Set([task.baseCommit, afterFirst]))

  // —— 服务端先自证：三个作用域各自算出不同的一份。
  const whole = await structuralDiff(task.id, 'scope=task')
  expect(
    whole.files.map((f) => f.filePath).sort(),
    '整任务作用域没有把两个文件都算进来 ⇒ 下面的对比失去意义',
  ).toEqual(['alpha.ts', 'beta.ts'])
  const firstScoped = await structuralDiff(
    task.id,
    `scope=node&nodeRunId=${encodeURIComponent(runOne!.id)}`,
  )
  expect(
    firstScoped.files.map((f) => f.filePath),
    '切到第一个节点却把第二个节点写的文件也算了进来 ⇒ 作用域是个装饰品，' +
      '审阅者永远只能看到整任务的合集',
  ).toEqual(['alpha.ts'])
  const secondScoped = await structuralDiff(
    task.id,
    `scope=node&nodeRunId=${encodeURIComponent(runTwo!.id)}`,
  )
  expect(
    secondScoped.files.map((f) => f.filePath),
    '切到第二个节点却带上了第一个节点的改动 ⇒ 同上，反向也不成立',
  ).toEqual(['beta.ts'])

  // —— 界面这一层：下拉真的把请求切过去，并把结果换上来。
  await primeToken(page, taskDaemon)
  await page.goto(`${taskDaemon.baseUrl}/tasks/${task.id}?tab=changes`)
  const panel = page.getByTestId('change-review')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(
    panel.locator('.changes__summary-line'),
    '整任务作用域的摘要不是两个文件 ⇒ 面板拿到的不是刚才那份结构化 diff',
  ).toHaveText('2 files · 2 method changes', { timeout: 30_000 })

  const scopeSelect = panel.locator('.changes__toolbar-field--scope [role="combobox"]')
  await expect(
    scopeSelect,
    '任务跑出了多个节点，变更页签却没有作用域下拉 ⇒ 只能整任务看，' +
      '一个节点写坏了要在别人的改动里翻',
  ).toBeVisible()
  await expect(scopeSelect).toContainText('Whole task')

  await scopeSelect.click()
  await page.getByRole('option', { name: /^node_two\b/ }).click()
  await expect(
    panel.locator('.changes__summary-line'),
    '下拉切到 node_two，摘要还是整任务的数字 ⇒ 选了等于没选',
  ).toHaveText('1 files · 1 method changes', { timeout: 30_000 })
  await expect(scopeSelect).toContainText('node_two')

  // 再切回整任务：数字必须回得去（不是一去不返的单向门）。
  await scopeSelect.click()
  await page.getByRole('option', { name: 'Whole task', exact: true }).click()
  await expect(
    panel.locator('.changes__summary-line'),
    '切回整任务之后数字回不来 ⇒ 作用域切换是单向的，用户只能刷新页面',
  ).toHaveText('2 files · 2 method changes', { timeout: 30_000 })
})

test('RFC-319 TASK-35：工作树累积 diff 超过 1 MiB 时，接口在正好 1 MiB 处截断并如实标注，变更页签把这件事写在脸上 @nightly', async ({
  page,
}) => {
  const task = await runFixtureTask('truncate')

  // —— 负向对照：小改动既不截断也不挂提示条。
  writeIntoWorktree(task.worktreePath, 'alpha.ts', `${ALPHA_BASE}\nexport const small = 1\n`)
  const small = await api<{ diff: string; truncated?: boolean }>(
    taskDaemon,
    `/api/tasks/${task.id}/diff`,
  )
  expect(
    small.truncated ?? false,
    '一个几十字节的改动就被标成截断 ⇒ 这条提示会天天出现，用户很快学会无视它',
  ).toBe(false)

  await primeToken(page, taskDaemon)
  await page.goto(`${taskDaemon.baseUrl}/tasks/${task.id}?tab=changes`)
  const panel = page.getByTestId('change-review')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(
    panel.locator('.changes__truncated'),
    '没超上限却挂着截断提示 ⇒ 同上，狼来了',
  ).toHaveCount(0)

  // —— 正题：把工作树推过 1 MiB。
  //
  // 刻意用 `.txt` 而不是 `.ts`：这一格验的是**文本 diff** 的上限，用源码后缀会顺带
  // 让结构化分析去解析一份 1.5 MiB 的文件，既拖慢用例又与本条无关。
  // 每行定长 63 字节 + 换行 = 64；24000 行 ≈ 1.46 MiB，稳过 1 MiB。
  const bulk = Array.from({ length: 24_000 }, (_unused, index) =>
    `rfc319-bulk-${String(index).padStart(6, '0')}`.padEnd(63, '.'),
  ).join('\n')
  writeIntoWorktree(task.worktreePath, 'bulk.txt', `${bulk}\n`)
  expect(bulk.length, '夹具本身没超过 1 MiB ⇒ 下面的截断判定没有前提').toBeGreaterThan(1024 * 1024)

  const big = await api<{ diff: string; truncated?: boolean }>(
    taskDaemon,
    `/api/tasks/${task.id}/diff`,
  )
  expect(
    big.truncated,
    'diff 超过 1 MiB 却没有标注截断 ⇒ 用户拿到的是一份被悄悄砍掉尾巴的改动，' + '而它看起来完整',
  ).toBe(true)
  expect(
    big.diff.length,
    '标了截断，正文却不是正好停在 1 MiB ⇒ 上限没有真的生效（util/git.ts:2258-2268）',
  ).toBe(1024 * 1024)

  await page.reload()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(
    panel.locator('.changes__truncated'),
    '接口说截断了，界面上一个字都不提 ⇒ 审阅者会以为自己看完了全部改动',
  ).toHaveText('⚠ Diff truncated at 1 MiB. View the worktree directly for the full output.', {
    timeout: 30_000,
  })
})

// ---------------------------------------------------------------------------
// CFG-X6 [P2] —— 反代部署：publicBaseUrl 是 webhook 入站地址的唯一来源
//
// 放**最后**：这一条会把 publicBaseUrl 写进 config.json，而 config 补丁没有
// 「删掉某个键」的语义，写进去就撤不回来（与 rfc319-overview-and-docs.spec.ts
// 的 CFG-40 同一个理由）。
// ---------------------------------------------------------------------------

test('RFC-319 CFG-X6：没配 publicBaseUrl 时 webhook 端点老实说「还给不出完整 URL」并给出路径，配上之后同一张卡片换成可复制的完整地址；转发头改不动它 @nightly', async ({
  page,
}) => {
  const endpoint = await api<{
    id: string
    provider: string
    urlToken: string
    ingressUrl: string | null
  }>(daemon, '/api/webhook-endpoints', {
    method: 'POST',
    body: JSON.stringify({ name: unique('rfc319x6ep') }),
  })
  expect(
    endpoint.ingressUrl,
    '运维还没声明对外地址，服务端就已经拼出了一条入站 URL ⇒ 它只能来自「谁来问就照着谁拼」，' +
      '而这条地址要粘进 GitLab 用上几个月',
  ).toBeNull()

  await primeToken(page, daemon)
  await page.goto(`${daemon.baseUrl}/webhooks`)
  const card = page.getByTestId(`webhook-endpoint-${endpoint.id}`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(
    card,
    '给不出完整 URL 时不说明原因 ⇒ 用户以为端点建坏了，会反复删了重建',
  ).toContainText('The full URL is not available yet')
  await expect(card, '连相对路径都不给 ⇒ 用户手上一点可用信息都没有').toContainText(
    `/webhooks/${endpoint.provider}/${endpoint.urlToken}`,
  )
  await expect(
    page.getByTestId(`webhook-endpoint-copy-url-${endpoint.id}`),
    '没有完整 URL 却给了复制按钮 ⇒ 复制到的是一条打不通的地址，' +
      '粘进 GitLab 之后每一条投递都石沉大海',
  ).toHaveCount(0)

  // —— 两条规则的差异（routes/publicOrigin.ts:17-24 明确写下的设计）：
  //    同一次请求带着反代头，`/.well-known/mcp` 会**采纳**它（读者此刻正握着这条连接），
  //    而 webhook 入站 URL **仍然是 null**（那条地址要长期有效，猜出来的比诚实的空更坏）。
  const proxied = await api<Array<{ id: string; ingressUrl: string | null }>>(
    daemon,
    '/api/webhook-endpoints',
    { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'guess.rfc319.invalid' } },
  )
  expect(
    proxied.find((row) => row.id === endpoint.id)?.ingressUrl,
    'webhook 入站 URL 吃了调用方发来的转发头 ⇒ 任何一次带头的请求都能让管理员抄走一条' +
      '指向别处的地址，而它看起来完全正常',
  ).toBeNull()
  const wellKnown = (await (
    await fetch(`${daemon.baseUrl}/.well-known/mcp`, {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'guess.rfc319.invalid' },
    })
  ).json()) as { endpoint: string }
  expect(
    wellKnown.endpoint,
    '发现文档也拒绝转发头 ⇒ 反代后面的读者拿到的是 daemon 内网地址，' +
      '而这一格与 webhook 的取舍本来就该相反',
  ).toBe('https://guess.rfc319.invalid/api/mcp')

  // —— 运维显式声明对外地址（带子路径的反代部署）。
  await api(daemon, '/api/config', {
    method: 'PUT',
    body: JSON.stringify({ publicBaseUrl: `${PUBLIC_BASE_URL}/` }),
  })

  await page.reload()
  await expect(
    page.getByTestId(`webhook-endpoint-url-${endpoint.id}`),
    '配好 publicBaseUrl 之后卡片仍说给不出 URL ⇒ 运维配了等于没配',
  ).toHaveText(`${PUBLIC_BASE_URL}/webhooks/${endpoint.provider}/${endpoint.urlToken}`, {
    timeout: 30_000,
  })
  await expect(
    page.getByTestId(`webhook-endpoint-copy-url-${endpoint.id}`),
    '有了完整 URL 却不给复制入口 ⇒ 用户只能手抄一串随机 token',
  ).toBeVisible()
  await expect(
    card,
    '完整 URL 出来了，「还给不出 URL」的告警条还挂着 ⇒ 两种状态叠在一起',
  ).not.toContainText('The full URL is not available yet')

  // 尾斜杠必须被归一化掉（webhookEndpoints.ts:96 的 `replace(/\/+$/,'')`），
  // 否则拼出来的是 `…/base//webhooks/…`，反代上多一段空路径就是 404。
  const configured = await api<Array<{ id: string; ingressUrl: string | null }>>(
    daemon,
    '/api/webhook-endpoints',
    { headers: { 'X-Forwarded-Host': 'guess.rfc319.invalid' } },
  )
  expect(
    configured.find((row) => row.id === endpoint.id)?.ingressUrl,
    '运维显式配的对外地址被调用方的转发头改写了，或者尾斜杠没归一化 ⇒ ' +
      '抄出去的地址要么指向别人，要么多一段空路径直接 404',
  ).toBe(`${PUBLIC_BASE_URL}/webhooks/${endpoint.provider}/${endpoint.urlToken}`)
})
