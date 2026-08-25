// RFC-319 —— agent.md 导入的**两条阻断路**、代理配置包导出、内置数字员工模板端点、
// MCP runtime playground 的两个终止入口，以及从记忆页发起融合时的提交前校验。
//
// 覆盖能力账本 AGENT-29、AGENT-30、AGENT-38、AGENT-46、RES-26、MEM-X11 六行
// （账本里全部 status='gap'）。六行的 `tier` **全部**是 `'nightly'`，所以每条 test 标题
// 末尾都带 ` @nightly`——PR 腿跑的是 `--grep-invert '@nightly'`，账本守卫
// `tierWiringMismatches` 会双向逐字核对这个 tag 与 `tier: 'nightly'` 是否一致。
//
// 本批分到手的另外四行（RES-24 / RES-25 / MEM-49 / MEM-X4）经逐条核对**已经有防护**
// 或**在产品里不成立**，故不在此文件里重写一遍；逐条依据写在交付报告里，账本由主 session
// 统一改。
//
// ## 与既有 e2e 的分工（**刻意不重叠**，逐条核对过）
//
//   * `e2e/agent-import.spec.ts` —— agent.md 导入的**粘贴**成功路（响应式 / a11y / 只改草稿）。
//     它一次都没造出过 409 `import-ref-ambiguous`，也没造出过阻断性警告或端口冲突。
//   * `e2e/rfc319-agent-and-resource-config.spec.ts` 的 AGENT-28 —— 导入的**上传**腿
//     （扩展名闸 + 文件名兜底）。它到达审阅页之后直接 Apply 成功，本文件补的正是那一步
//     **被挡住**的两种形态与「挡住之后怎么出去」。
//   * `packages/frontend/tests/agent-import-dialog.test.tsx` —— 同样三条分支的组件单测，
//     但 `onResolve` 是**手写的 mock**，抛的是测试自己 new 出来的 `ApiError`。本文件让
//     真的服务端（真 schema、真 ACL、真事务）产出那个 409，并把**选中的那一份**一路带到
//     `POST /api/agents` 落库——单测照不到「前端拼的 selections 与服务端要的形状是否一致」。
//   * `e2e/rfc319-resource-management-rest.spec.ts` 的 RES-38 —— 同一个公共组件
//     `ResourcePackageExportButton` 在 **MCP / 插件**上的脏态禁用 + 空 fence 422 + 陈旧
//     fence 409。代理是这个组件的第四个调用点，而**代理的 fence 是两段式的**
//     （`expectedUpdatedAt` + `expectedAclRevision`，见 `resourcePackage/preview.ts` 的
//     `expectTokenOf`）——「给了就必须给全」与「不认识的字段一律拒」这两条分支在单字段的
//     MCP / 插件上**永远走不到**，RES-38 一次都没照到。
//   * `e2e/mcp-runtime-playground.spec.ts` —— 开对话框 / 两种 runtime / 发首条消息 /
//     失败诊断 / ESC 关闭不改后端。它**从没按过**「取消当前轮」与「立即结束」这两颗按钮
//     （footer 里只有 `session.status==='active'` 时才渲染的那两颗）。
//   * `e2e/mcp-acl-session-termination.spec.ts` 的 RES-28 —— 会话被**第三方**（ACL 撤权）
//     终止。本文件走的是**本人主动**终止的两条路，且全程从界面按下去。
//   * `e2e/rfc319-de-and-resource-lifecycle.spec.ts` 的 RES-46 —— FuseDialog 的
//     **from-skill** 入口 + `needMemories` 本地拦截。本文件只走**from-memories** 入口，
//     锁它独有的 `needSkill` 与 `noManagedSkills` 空态——那两条在 from-skill 入口下
//     整块不渲染（`FuseDialog.tsx:160-187` 的 `entry.kind === 'from-memories'` 闸），
//     两份文件互为补集。仓内两处 spec 头注都写着 `fusion.noManagedSkills` 未覆盖。
//
// ## 各条断言失效时**用户会遭遇什么**（这是用例存在的理由，不是断言在做什么）
//
//   * AGENT-29 —— 同名资源在多人实例里是常态（名字只在 owner 域内唯一）。歧义不逐项让人
//     选定就放行 ⇒ 导入的代理会**静默绑到另一个人的那一份** MCP 上：正文一模一样、名字
//     一模一样，运行期却连着别人的端点、带着别人的密钥。而更坏的一档是「让选了、但选择
//     没被采纳」，所以本条以「落库的那个 id 就是被选中的那一份」收尾。
//   * AGENT-30 —— 阻断性警告的语义是「这份文件我根本没解析成功」。它不挡住 Apply
//     ⇒ 用户会拿到一个只剩正文、frontmatter 全丢的草稿，然后一路存进去。端口 sidecar
//     冲突则更隐蔽：导入只声明 `outputs` 时，一个用户早已弃用的孤儿映射会被**悄悄复活**，
//     新端口从此带着一段谁也没在编辑的旧配置（kind / 提升名）。挡住之后还必须给出口——
//     只报错不给路的结果是用户卡在弹窗里，不知道该去哪儿清理。
//   * AGENT-38 —— 导出的是「所见即所得」的那一版。脏态还让导出 ⇒ 用户拿到的 zip 里是旧
//     内容；两段式 fence 只给一半却放行 ⇒ 另一维的漂移完全看不见（代理的 ACL 改动只推
//     `aclRevision`，不推 `updatedAt`），调用方以为自己有保护、实际只护住了一半。
//   * AGENT-46 —— 这个端点是数字员工「实现工具」选谁的**唯一**目录。它把上一代模板一起
//     吐出来 ⇒ 岗位工具会被绑到 v1 契约的代理上，运行期契约对不上；它漏掉执行契约声明
//     ⇒ 整个平台按契约挑代理的逻辑一条都匹配不到，注册工具时下拉是空的。
//   * RES-26 —— playground 会话是一个**活着的模型进程**。「取消当前轮」按下去没真的把
//     进程掐掉 ⇒ 用户以为停了，它还在对着真 MCP 发调用；「立即结束」按下去只是关了弹窗
//     ⇒ 进程与私有会话目录继续占着，而用户已经离开这个页面了。
//   * MEM-X11 —— 从记忆页发起融合时，目标技能是**必填**且必须由用户挑。本地拦截失灵
//     ⇒ 用户拿到一次服务端 4xx（而且是在他以为已经提交之后）；空态换成一个空下拉
//     ⇒ 用户对着一个点不出任何东西的选择器，不知道是自己没权限还是页面坏了。
//
// ## 源码锚点（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check 逐条
// ## 请求，见 CLAUDE.md §opencode 源码自取规则）
//
//   packages/backend/src/services/importRefs.ts:306-338         2+ 可见候选 ⇒ 409 import-ref-ambiguous
//   packages/backend/src/services/importRefs.ts:310-330         带 selections 的第二次解析：按 id + aclRevision 复核
//   packages/backend/src/services/importRefs.ts:377-445         候选快照只含**可见**行 + owner 用户名
//   packages/frontend/src/components/ImportRefMappingFields.tsx:93-111  hasEveryImportRefSelection
//   packages/frontend/src/components/AgentImportDialog.tsx:153-166      canApply 的五个合取项
//   packages/frontend/src/components/AgentImportDialog.tsx:335-345      409 ⇒ 把候选停在 ambiguities 上
//   packages/frontend/src/lib/agent-import-warnings.ts:19-27            yaml-parse-failed ⇒ blocking:true
//   packages/frontend/src/lib/agent-import-merge.ts:47-69               importOrphanSidecarConflicts
//   packages/frontend/src/components/AgentImportDialog.tsx:725-745      端口冲突横幅 + 「去修端口」
//   packages/frontend/src/routes/agents.detail.tsx:224-238              代理导出入口的 fence 与禁用条件
//   packages/backend/src/routes/resourcePackages.ts:117-155             parseRootFence：数值域 + 空串拒绝
//   packages/backend/src/services/resourcePackage/export.ts:249-282     给全 / 不认识 / 不相等 三条闸
//   packages/backend/src/services/resourcePackage/preview.ts:250-254    agent 的两段式 CAS token
//   packages/backend/src/routes/agents.ts:118-135                       内置数字员工模板端点
//   packages/backend/src/services/digitalEmployeeAgentTemplates.ts:415-423  只回 V2 且 builtin+public
//   packages/backend/src/services/systemResources.ts:58-60              GET /api/agents 剔除 builtin
//   packages/frontend/src/components/mcps/McpRuntimeTestDialog.tsx:341-370  取消 / 结束两颗按钮的渲染条件
//   packages/backend/src/services/mcpRuntimeTest.ts:1201-1256           cancel：running ⇒ 记 cancelRequestedAt + abort
//   packages/backend/src/services/mcpRuntimeTest.ts:216-222             cancelRequested && !ending ⇒ turn=canceled
//   packages/backend/src/services/mcpRuntimeTest.ts:1281-1321           end：session ⇒ ending / endReason='user'
//   packages/frontend/src/components/fusion/FuseDialog.tsx:112-123      needSkill / needMemories 本地拦截
//   packages/frontend/src/components/fusion/FuseDialog.tsx:160-187      from-memories 独有的目标技能字段 + 空态
//   packages/system-mocks/src/runtime/mode-slow.ts:62-73                STUB_OPENCODE_HOLD_FILE 的两个信号
//
// ## 执行模型
//
//   全文件共用一个 daemon（`stubMode:'slow'` + `STUB_OPENCODE_HOLD_FILE`）。hold 文件是
//   RES-26 的前提：取消 / 结束都只在**某一回合还在飞**的时候才有按钮，靠「跑得够慢」去赌
//   会在忙碌 runner 上翻车（docs/dev-gotchas.md §「MCP runtime-test 的提示词不带 RFC-200
//   信封」实测过两次「修 flaky」都只是把窗口调宽）。其余五条一次运行时子进程都不拉起，
//   所以共用这个 daemon 没有副作用。
//
//   每条 test 自己 seed 自己的资源（`nextSlug` 保证不撞名），互不依赖，因此可以整批并发
//   注入变异后按「红了哪几条」逐条归因——`mode: 'serial'` 会毁掉这个性质，故**不用**
//   （本文件里 "serial" 一词只出现在本行注释里）。一次 `page.route` 都不注入
//   （"route.fetch(" 同样只出现在本注释段），所有拒绝分支都由**真的**被拒动作产生。

import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

const PASSWORD = 'Rfc319ImportPlay!1'

/** `services/digitalEmployeeAgentTemplates.ts` 的两代稳定 id（外星于 ULID 时间空间）。 */
const LEGACY_DE_TEMPLATE_IDS = [
  '00000000000000DECODEWRITER',
  '00000000000000DEDIAGNOSE',
  '00000000000000DEPIPEFIX',
  '00000000000000DEREVIEWFIX',
  '00000000000000DECONFLICTFIX',
  '00000000000000DEFEATUREDEV',
  '00000000000000DEISSUEFIX',
  '00000000000000DEPLANANALYZE',
] as const
const V2_DE_TEMPLATE_IDS = [
  '00000000000001DECODEWRITER',
  '00000000000001DEDIAGNOSE',
  '00000000000001DEPIPEFIX',
  '00000000000001DEREVIEWFIX',
  '00000000000001DECONFLICTFIX',
  '00000000000001DEFEATUREDEV',
  '00000000000001DEISSUEFIX',
  '00000000000001DEPLANANALYZE',
] as const

let daemon: DaemonHandle
let daemonHome: string
let fixtureDir: string
let holdDir: string
let holdFile: string
let sequence = 0

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string
  name: string
  builtin?: boolean | null
  ownerUserId: string | null
  visibility?: string
  mcp: string[]
  outputs: string[]
  updatedAt: number
  aclRevision: number | null
  frontmatterExtra: Record<string, unknown>
}

interface McpRow {
  id: string
  name: string
  operationConfigHash: string
}

interface TurnRow {
  id: string
  status: string
  failureCode: string | null
  cancelRequestedAt: number | null
}

interface SessionRow {
  id: string
  status: string
  endReason: string | null
  inFlightTurnId: string | null
  turns: TurnRow[]
}

// ---------------------------------------------------------------------------
// 请求封装
// ---------------------------------------------------------------------------

async function raw(
  path: string,
  init?: RequestInit,
  token: string = daemon.token,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return { status: response.status, body: await response.text() }
}

async function json<T>(
  path: string,
  init: RequestInit | undefined,
  what: string,
  token: string = daemon.token,
): Promise<T> {
  const response = await raw(path, init, token)
  expect(response.status < 400, `${what}: HTTP ${response.status} ${response.body}`).toBe(true)
  return JSON.parse(response.body) as T
}

function errorOf(body: string): { code?: string; message?: string } {
  try {
    return JSON.parse(body) as { code?: string; message?: string }
  } catch {
    return {}
  }
}

function nextSlug(prefix: string): string {
  sequence += 1
  return `rfc319-${prefix}-${sequence}`
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function seedMcp(name: string, token: string = daemon.token): Promise<McpRow> {
  return json<McpRow>(
    '/api/mcps',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'rfc319 import/playground fixture',
        type: 'remote',
        // 只有 RES-26 会真的拨号，而那条用例关心的是**会话生命周期**、不是连通性：
        // 一个必然连不上的回环端口正好让回合停在 stub 的 hold 上。
        config: { url: 'http://127.0.0.1:1/mcp', timeoutMs: 1_000, oauth: false },
        enabled: true,
      }),
    },
    `seed mcp ${name}`,
    token,
  )
}

async function seedAgent(body: Record<string, unknown>): Promise<AgentRow> {
  return json<AgentRow>(
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        outputs: ['answer'],
        description: 'rfc319 import/playground fixture',
        bodyMd: '',
        ...body,
      }),
    },
    `seed agent ${String(body.name)}`,
  )
}

async function seedUser(tag: string): Promise<{ username: string; token: string }> {
  const username = `rfc319-imp-${tag}`
  await json<{ id: string }>(
    '/api/users',
    {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: PASSWORD,
      }),
    },
    `seed user ${username}`,
  )
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  expect(login.ok, `login ${username}: HTTP ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { username, token: sessionToken }
}

function getAgent(id: string): Promise<AgentRow> {
  return json<AgentRow>(`/api/agents/${id}`, undefined, `read agent ${id}`)
}

// ---------------------------------------------------------------------------
// 浏览器封装
// ---------------------------------------------------------------------------

async function primeAuth(page: Page, token: string = daemon.token): Promise<void> {
  await page.addInitScript(
    ([baseUrl, tok]) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    [daemon.baseUrl, token] as const,
  )
}

function countRequests(page: Page, method: string, pathname: string): () => number {
  let seen = 0
  page.on('request', (request) => {
    if (request.method() === method && new URL(request.url()).pathname === pathname) seen += 1
  })
  return () => seen
}

function waitForResponseOn(page: Page, method: string, pathname: string, timeout = 30_000) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === pathname,
    { timeout },
  )
}

/**
 * 打开 `/agents/new` 的导入弹窗并把一段 agent.md 粘进去、走到审阅页。
 *
 * 每次打开都停在「上传文件」那一页（`freshSelectPhase`），所以粘贴前必须先切页签。
 */
async function pasteIntoImportReview(page: Page, markdown: string): Promise<void> {
  await page.getByTestId('agent-import-open').click()
  await expect(page.getByTestId('agent-import-dialog')).toBeVisible()
  await page.getByRole('tab', { name: 'Paste text', exact: true }).click()
  await page.getByTestId('agent-import-textarea').fill(markdown)
  await page.getByTestId('agent-import-parse').click()
  await expect(page.getByTestId('agent-import-review-heading')).toBeFocused()
}

/** 资源详情页 More 弹窗（导出 / 权限 / 删除都住在里面）。 */
async function openMoreActions(page: Page): Promise<void> {
  await page.getByTestId('detail-more-actions').click()
  await expect(
    page.getByTestId('detail-actions-dialog'),
    'More 弹窗打不开 ⇒ 导出入口整个够不着',
  ).toBeVisible()
}

/** 打开某条 MCP 的 runtime playground 弹窗。 */
async function openPlayground(page: Page, mcpId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/mcps/${mcpId}`)
  const probeTab = page.getByRole('tab', { name: 'Tools & probe', exact: true })
  await expect(probeTab).toBeVisible({ timeout: 60_000 })
  if ((await probeTab.getAttribute('aria-selected')) !== 'true') await probeTab.click()
  await page.getByTestId('mcp-runtime-test-open').click()
  await expect(page.getByTestId('mcp-runtime-test-dialog')).toBeVisible()
}

/** 当前 runtime-test 会话（没有则 null——端点用 204 表达「没有」）。 */
async function currentSession(mcpId: string): Promise<SessionRow | null> {
  const response = await raw(`/api/mcps/${mcpId}/runtime-test-session`)
  expect(
    response.status === 200 || response.status === 204,
    `read current runtime-test session: HTTP ${response.status} ${response.body}`,
  ).toBe(true)
  return response.status === 204 ? null : (JSON.parse(response.body) as SessionRow)
}

function readSession(mcpId: string, sessionId: string): Promise<SessionRow> {
  return json<SessionRow>(
    `/api/mcps/${mcpId}/runtime-test-sessions/${sessionId}`,
    undefined,
    `read runtime-test session ${sessionId}`,
  )
}

/** 等 stub **真的起来**：它落 `<hold>.started` 之后就一直挂着，回合确定性地停在飞行中。 */
async function waitForHeldTurn(): Promise<void> {
  await expect.poll(() => existsSync(`${holdFile}.started`), { timeout: 120_000 }).toBe(true)
}

function clearHoldStartedMarker(): void {
  rmSync(`${holdFile}.started`, { force: true })
}

function releaseHold(): void {
  rmSync(holdFile, { force: true })
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  daemonHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-import-play-'))
  // 「样例已经提供过」的标记：不种 RFC-307 的 demo 内容。MEM-X11 的空态判据是
  // 「一个可写的托管技能都没有」，多出来的 demo 技能会让它直接失效。
  writeFileSync(join(daemonHome, '.demo-seeded'), `${String(Date.now())}\n`)
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-import-hold-'))
  holdFile = join(holdDir, 'hold')
  writeFileSync(holdFile, '')
  daemon = await startDaemon({
    home: daemonHome,
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: holdFile },
  })
  fixtureDir = mkdtempSync(join(tmpdir(), 'rfc319-import-play-files-'))
})

test.afterEach(async ({ page }) => {
  // 本文件一条注入都没有，但仍按 docs/dev-gotchas.md §「page.route 两把锁」的锁 B
  // 无条件摘一次：将来任何人往这里加注入时，不必再想起补这一句。
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  releaseHold()
  if (daemon !== undefined) await daemon.stop()
  for (const dir of [daemonHome, fixtureDir, holdDir]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// AGENT-29 —— 同名多份资源的导入引用歧义
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-29: 同名的两份 MCP 让导入停在归属选择上——没选定就应用不了，选定之后落库的是被选中的那一份 @nightly', async ({
  page,
}) => {
  const shared = nextSlug('a29-shared-mcp')
  const bob = await seedUser(`a29-${sequence}`)
  // 名字只在 owner 域内唯一（`mcps_owner_name_unique`），所以两个人可以各有一份同名 MCP。
  // 管理员持 `resource-acl:bypass`，两份对他都可见 ⇒ 这正是歧义的定义。
  const mine = await seedMcp(shared)
  const theirs = await seedMcp(shared, bob.token)
  expect(mine.id, '两份夹具落成了同一行 ⇒ 后面「选中的是哪一份」无从谈起').not.toBe(theirs.id)

  const agentName = nextSlug('a29-agent')
  const markdown = [
    '---',
    `name: ${agentName}`,
    'description: RFC-319 AGENT-29 ambiguous reference fixture',
    'outputs: [answer]',
    `mcp: [${shared}]`,
    '---',
    'Probe the referenced MCP and report what it exposes.',
  ].join('\n')

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  const resolveCount = countRequests(page, 'POST', '/api/agents/import-resolve')
  await pasteIntoImportReview(page, markdown)

  const dialog = page.getByTestId('agent-import-dialog')
  const apply = page.getByTestId('agent-import-apply')

  // ① 第一次 Apply：服务端解析不出唯一归属，弹窗必须**停在**审阅页并把候选摆出来。
  await expect(
    page.getByTestId('agent-import-reference-mapping'),
    '还没提交就已经在问归属 ⇒ 后面「歧义被服务端判出来」这条因果说不通',
  ).toHaveCount(0)
  await apply.click()
  await expect(
    page.getByTestId('agent-import-reference-mapping'),
    '同名两份却直接放行 ⇒ 导入的代理会静默绑到另一个人的那一份 MCP 上，' +
      '名字与正文一模一样，运行期却连着别人的端点',
  ).toBeVisible()
  await expect(
    page.getByTestId('agent-import-result-heading'),
    '歧义没解决就跳到了「已应用」 ⇒ 用户根本没机会选，草稿里已经躺着一个任选的 id',
  ).toHaveCount(0)
  expect(
    resolveCount(),
    '第一次 Apply 一个解析请求都没发 ⇒ 上面那块归属选择器可能只是前端自己脑补的',
  ).toBe(1)

  // ② 没选定之前，Apply 必须真的按不动。
  //    docs/dev-gotchas.md §「要证明置灰的东西真的点不动」：只断言 disabled 锁不住
  //    「禁用只是画上去的」这种退化，必须 force 把点击真的打进去。
  await expect(
    apply,
    '歧义未解决时 Apply 仍可点 ⇒ 用户可以跳过选择，绑定重新变成任选',
  ).toBeDisabled()
  await apply.click({ force: true })
  await expect(page.getByTestId('agent-import-result-heading')).toHaveCount(0)
  expect(resolveCount(), '被禁用的 Apply 还是把解析请求发出去了').toBe(1)

  // ③ 挑**对方那一份**。候选的副标题是 `{visibility} · {id}`（`importRefs.candidateDescription`），
  //    所以可以按 id 精确定位到具体是哪一行，而不是靠「第几个」。
  const mapping = dialog.getByTestId(`agent-import-mapping-mcp-${shared}`)
  await expect(
    mapping,
    '歧义项没有按 `<类型>-<名字>` 落 testid ⇒ 一次导入撞上多个歧义时，用户分不清在选哪一条',
  ).toBeVisible()
  const selector = dialog.getByRole('combobox', { name: `MCP: ${shared}` })
  await selector.click()
  const listbox = page.getByRole('listbox', { name: `MCP: ${shared}` })
  await expect(
    listbox.getByRole('option'),
    '候选数不是 2 ⇒ 服务端要么少报了一份（那这次导入本来就该绑错），要么多报了不可见的行',
  ).toHaveCount(2)
  await listbox.getByRole('option').filter({ hasText: theirs.id }).click()
  await expect(listbox).toHaveCount(0)

  // ④ 选定之后 Apply 才活过来，并且这一次真的过了。
  await expect(apply, '选定了归属 Apply 还是灰的 ⇒ 这条导入路径对用户来说等于死路').toBeEnabled()
  await apply.click()
  await expect(page.getByTestId('agent-import-result-heading')).toBeFocused()
  expect(
    resolveCount(),
    '带着选择的第二次解析没发出去 ⇒ 前端可能是拿第一次的失败结果自己拼了个绑定',
  ).toBe(2)
  await page.getByTestId('agent-import-view-form').click()
  await expect(dialog).toHaveCount(0)

  // ⑤ 收尾：真的建出来，落库的那个 mcp id 必须是**被选中的那一份**。
  //    只断言「有一个 id」是恒真的——两份候选都能满足它。
  const created = waitForResponseOn(page, 'POST', '/api/agents')
  await page.getByTestId('agent-create-button').click()
  expect((await created).status(), '选定归属之后创建仍被拒 ⇒ 前端拼的选择服务端不认').toBe(201)
  const row = (await created).json() as Promise<AgentRow>
  const persisted = await getAgent((await row).id)
  expect(
    persisted.mcp,
    '落库的不是被选中的那一份 ⇒ 用户明确选了 B，系统却绑了 A——两条记录名字一模一样，' +
      '事后没有任何办法从界面上看出绑错了',
  ).toEqual([theirs.id])
})

// ---------------------------------------------------------------------------
// AGENT-30 —— 阻断性警告 + 端口 sidecar 冲突
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-30: 解析失败与端口孤儿冲突各自挡住「应用到草稿」，冲突还给一条真能落到端口页的出口 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  const dialog = page.getByTestId('agent-import-dialog')
  const apply = page.getByTestId('agent-import-apply')

  // ── 第一段：YAML 解析失败 = 阻断性警告 ──────────────────────────────────
  // 正文照样解析得出来（`parseAgentMarkdown` 把 body 单独取走），所以 itemCount > 0——
  // 也就是说 Apply 被挡住的**唯一**原因就是这条阻断性警告，归因不会混。
  await pasteIntoImportReview(
    page,
    ['---', 'name: [unterminated', 'description: "still broken', '---', 'Body survives.'].join(
      '\n',
    ),
  )
  await expect(
    dialog.getByTestId('agent-import-warning'),
    'frontmatter 根本没解析成功却一声不吭 ⇒ 用户会拿到一个只剩正文、' +
      'frontmatter 全丢的草稿，然后一路存进去',
  ).toContainText('yaml-parse-failed:')
  await expect(
    apply,
    '解析失败还让应用 ⇒ 这份 agent.md 里声明的端口 / 依赖 / 权限全部静默丢失',
  ).toBeDisabled()
  await apply.click({ force: true })
  await expect(
    page.getByTestId('agent-import-result-heading'),
    '被禁用的 Apply 仍然把这份解析失败的内容应用到了草稿上',
  ).toHaveCount(0)
  // 阻断态下不该出现「非阻断警告」那张卡把人引偏（两者是不同的严重度）。
  await expect(dialog.getByTestId('agent-import-port-conflict')).toHaveCount(0)
  await page.getByTestId('agent-import-back').click()
  await expect(page.getByTestId('agent-import-textarea')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // ── 第二段：先造出一个孤儿 sidecar ──────────────────────────────────────
  // `outputKinds` 里有一条 `ghost`，而 `outputs` 里没有它——这正是「用户弃用了某个端口、
  // 映射却留在库里」的形状。第一次导入是**合法**的（它自己带了 outputKinds），所以
  // 这一步必须成功，否则第二段的前提不成立。
  await pasteIntoImportReview(
    page,
    [
      '---',
      `name: ${nextSlug('a30-agent')}`,
      'description: RFC-319 AGENT-30 orphan sidecar fixture',
      'outputs: [answer]',
      'outputKinds:',
      '  answer: markdown',
      '  ghost: markdown',
      '---',
      'Seed a draft that carries one orphan output mapping.',
    ].join('\n'),
  )
  await expect(
    apply,
    '自带 outputKinds 的导入也被挡住 ⇒ 第二段的前提造不出来，' +
      '后面那条「冲突」断言会变成对空气的断言',
  ).toBeEnabled()
  await apply.click()
  await expect(page.getByTestId('agent-import-result-heading')).toBeFocused()
  await page.getByTestId('agent-import-view-form').click()
  await expect(dialog).toHaveCount(0)

  // ── 第三段：只声明 outputs 的第二次导入 ⇒ 孤儿冲突 ──────────────────────
  await pasteIntoImportReview(
    page,
    [
      '---',
      'description: RFC-319 AGENT-30 outputs-only import',
      'outputs: [answer, ghost]',
      '---',
      'Declare ghost as a live port without saying anything about its kind.',
    ].join('\n'),
  )
  const conflict = dialog.getByTestId('agent-import-port-conflict')
  await expect(
    conflict,
    '只声明 outputs 的导入会把弃用的孤儿映射悄悄复活 ⇒ 新端口从此带着一段' +
      '谁也没在编辑的旧配置（kind / 提升名），而界面上什么都没说',
  ).toBeVisible()
  await expect(
    conflict,
    '冲突横幅没有点名是哪一条映射 ⇒ 用户被挡住了却不知道该去清理什么',
  ).toContainText('outputKinds:ghost')
  await expect(
    apply,
    '端口冲突只是提示、不挡应用 ⇒ 那条孤儿映射照样被接管，提示等于没有',
  ).toBeDisabled()
  await apply.click({ force: true })
  await expect(page.getByTestId('agent-import-result-heading')).toHaveCount(0)

  // ── 第四段：「去修端口」必须真的把人送到端口页，而且那里看得见要修的东西 ──
  await conflict.getByTestId('agent-import-fix-ports').click()
  await expect(
    dialog,
    '点了「去修端口」弹窗还开着 ⇒ 它盖在表单上，用户根本够不到端口编辑器',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('agent-tab-ports'),
    '「去修端口」没有把页签切到 Ports ⇒ 这颗按钮只是关了弹窗，用户还得自己找',
  ).toHaveAttribute('aria-selected', 'true')
  const orphans = page.getByTestId('agent-panel-ports').locator('.agent-port-orphans')
  await expect(
    orphans,
    '端口页上根本看不到那条孤儿映射 ⇒ 用户被送到了一个空手而归的地方',
  ).toContainText('ghost')
})

// ---------------------------------------------------------------------------
// AGENT-38 —— 代理的配置包导出（两段式 fence）
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-38: 代理导出配置包——草稿脏时入口按不动，保存后能落盘；两段式 fence 少一半 422、串类型 422、陈旧 409 @nightly', async ({
  page,
}) => {
  const agent = await seedAgent({ name: nextSlug('a38-export'), description: 'before the edit' })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible({ timeout: 60_000 })
  const exportCount = countRequests(page, 'GET', `/api/agents/${agent.id}/export-package`)

  // ---- 脏态：导出入口必须按不动，且**真的**发不出请求 ----
  await page.getByLabel('Description', { exact: true }).fill('edited but not saved')
  await openMoreActions(page)
  const exportItem = page.getByTestId('export-package-agent')
  await expect(
    exportItem,
    '有未保存改动时还能导出 ⇒ 用户拿到的 zip 里是**旧**内容，而他刚刚才改过——' +
      '「所见即所得」当场破功',
  ).toBeDisabled()
  await expect(
    exportItem,
    '禁用了却不说为什么 ⇒ 用户会以为导出功能坏了，而只要先按一下保存',
  ).toContainText('Save the current changes before exporting.')
  await exportItem.click({ force: true })

  // ---- 保存之后才允许导出 ----
  await page.keyboard.press('Escape')
  const saved = waitForResponseOn(page, 'PUT', `/api/agents/${agent.id}`)
  await page.getByTestId('agent-save-button').click()
  expect((await saved).status()).toBe(200)
  expect(
    exportCount(),
    '脏态下的那次点击把导出请求发出去了 ⇒ 用户拿到的是一个与眼前内容不符的包',
  ).toBe(0)

  await openMoreActions(page)
  await expect(exportItem, '保存之后导出仍然按不动 ⇒ 这条能力对所有人都等于不存在').toBeEnabled()
  const downloadedTo = join(fixtureDir, 'rfc319-agent-export.awpkg.zip')
  const [exported, download] = await Promise.all([
    waitForResponseOn(page, 'GET', `/api/agents/${agent.id}/export-package`, 60_000),
    page.waitForEvent('download'),
    exportItem.click(),
  ])
  expect(exported.status(), '导出请求没成 ⇒ 用户点了个寂寞').toBe(200)
  const savedRow = await getAgent(agent.id)
  const fenceParams = new URL(exported.url()).searchParams
  // 代理的 fence 是**两段式**的（`expectTokenOf`）：`updatedAt` 只被内容写路径推进，
  // `aclRevision` 只被授权写路径推进。少带一维 ⇒ 那一维的漂移完全看不见。
  expect(
    {
      expectedUpdatedAt: fenceParams.get('expectedUpdatedAt'),
      expectedAclRevision: fenceParams.get('expectedAclRevision'),
    },
    '导出请求没带全两段式 fence ⇒ 导的是「导出那一刻恰好在库里的那版」，不是用户看到的那版',
  ).toEqual({
    expectedUpdatedAt: String(savedRow.updatedAt),
    expectedAclRevision: String(savedRow.aclRevision ?? 0),
  })
  expect(
    download.suggestedFilename(),
    '下载下来的文件名不带资源身份 ⇒ 一次导十个包，用户分不清哪个是哪个',
  ).toBe(`agent-${agent.name}.awpkg.zip`)
  await download.saveAs(downloadedTo)
  const bytes = readFileSync(downloadedTo)
  expect(
    bytes.subarray(0, 2).toString('latin1'),
    '落盘的不是一个 zip ⇒ 拿去导入必然失败，而失败点会远在天边',
  ).toBe('PK')
  expect(bytes.byteLength).toBeGreaterThan(200)

  // ---- fence 的三条拒绝分支（服务端权威实施）----
  // ① 只给一半：单字段的 MCP / 插件永远走不到这一支，代理是它唯一的用户面。
  const half = await raw(
    `/api/agents/${agent.id}/export-package?expectedUpdatedAt=${savedRow.updatedAt}`,
  )
  expect(
    half.status,
    '两段式 fence 只给一半却放行 ⇒ 另一维的漂移完全看不见，调用方以为自己有保护、实际只护住一半',
  ).toBe(422)
  expect(errorOf(half.body).code).toBe('package-invalid')
  expect(
    errorOf(half.body).message ?? '',
    '拒了却不说少了哪一维 ⇒ 调用方只能靠猜去补参数',
  ).toContain('expectedAclRevision')

  // ② 串了别的类型的 fence：静默忽略会让「我明明传了 expectedConfigHash」变成一次没有保护的导出。
  const foreign = await raw(
    `/api/agents/${agent.id}/export-package?expectedUpdatedAt=${savedRow.updatedAt}` +
      `&expectedAclRevision=${savedRow.aclRevision ?? 0}&expectedConfigHash=whatever`,
  )
  expect(
    foreign.status,
    '拿 MCP 的 fence 字段来导代理却被放行 ⇒ 调用方拿错了类型，系统还替他装作有保护',
  ).toBe(422)
  expect(errorOf(foreign.body).code).toBe('package-invalid')

  // ③ 陈旧 fence：在导出者背后把这条代理改掉，旧 fence 必须 409。
  await json<AgentRow>(
    `/api/agents/${agent.id}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        description: 'changed again',
        expectedUpdatedAt: savedRow.updatedAt,
        expectedAclRevision: savedRow.aclRevision ?? 0,
      }),
    },
    'mutate the agent behind the exporter',
  )
  const stale = await raw(
    `/api/agents/${agent.id}/export-package?expectedUpdatedAt=${savedRow.updatedAt}` +
      `&expectedAclRevision=${savedRow.aclRevision ?? 0}`,
  )
  expect(stale.status, '拿着旧 fence 照样导出 ⇒ 用户按着旧标签点导出，静默拿到的是新版本').toBe(409)
  expect(errorOf(stale.body).code).toBe('package-root-changed')

  // 反向对照：换成当下的 fence 就该导得出来——否则上面三条 4xx 可能只是端点整个坏了。
  const fresh = await getAgent(agent.id)
  const ok = await raw(
    `/api/agents/${agent.id}/export-package?expectedUpdatedAt=${fresh.updatedAt}` +
      `&expectedAclRevision=${fresh.aclRevision ?? 0}`,
  )
  expect(ok.status, '带对 fence 也导不出来 ⇒ 上面三条拒绝证明不了任何东西').toBe(200)
})

// ---------------------------------------------------------------------------
// AGENT-46 —— 内置数字员工代理模板端点
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-46: 内置数字员工模板端点只回当代那八条、每条都带执行契约，且它们一条都不混进普通代理列表 @nightly', async () => {
  const templates = await json<AgentRow[]>(
    '/api/agents/builtins/digital-employee-templates',
    undefined,
    'list built-in digital employee templates',
  )

  // ① 逐条 id 相等（含顺序）。四个 DE spec 的 beforeAll 都在打这个端点、按契约挑代理，
  //    但它们只在「找不到」时 throw——目录本身多了 / 少了 / 换了一代，谁都不会红。
  expect(
    templates.map((row) => row.id),
    '内置模板目录与当代的八条稳定 id 对不上 ⇒ 岗位工具会被绑到别的代理上，' +
      '而注册时看起来一切正常',
  ).toEqual([...V2_DE_TEMPLATE_IDS])

  // ② 上一代的八条 id 一条都不许出现。它们仍在库里（`ensure…` 会一并 seed），
  //    只是不该进这个目录——混进来 ⇒ 工具被绑到 v1 契约的代理上，运行期契约对不上。
  const legacyLeaked = templates
    .map((row) => row.id)
    .filter((id) => (LEGACY_DE_TEMPLATE_IDS as readonly string[]).includes(id))
  expect(
    legacyLeaked,
    '上一代模板混进了当代目录 ⇒ 用户在下拉里看到两份长得一样的选项，选中旧的那份则契约版本对不上',
  ).toEqual([])

  // ③ 每一条都必须是框架自有的内置行，并且**带着执行契约声明**——那是平台按契约
  //    挑代理的唯一依据（四个 DE spec 的 `findAgent(contractId)` 就靠它），漏掉一条
  //    就等于那个岗位没有可用的实现工具。
  //
  //    ⚠️ 契约 id **不是**主键：`development.implement-change` 被三条模板共享
  //    （code-writing / business-implementation / issue-repair），区分它们的是
  //    `digitalEmployeeTemplate`。所以这里逐条比**整张映射表**，而不是「契约互不相同」
  //    —— 后者按源码实际是假的，照账本字面写会得到一条永远红的用例。
  const declaredTable = templates.map((row) => {
    expect(row.builtin, `${row.id} 不是内置行 ⇒ 它会同时出现在用户的代理列表里并且可被改坏`).toBe(
      true,
    )
    expect(row.ownerUserId, `${row.id} 不归框架所有 ⇒ 某个用户可以改掉全平台的实现工具`).toBe(
      '__system__',
    )
    const extra = row.frontmatterExtra as {
      digitalEmployeeTemplate?: string
      executionContracts?: Array<{ contractId: string; version: number }>
    }
    expect(
      extra.executionContracts,
      `${row.id} 没有声明执行契约 ⇒ 按契约挑代理的逻辑一条都匹配不到，注册工具时下拉是空的`,
    ).toBeDefined()
    for (const entry of extra.executionContracts ?? []) {
      expect(
        entry.version,
        `${row.id} 声明的仍是 v${String(entry.version)} 契约 ⇒ 这个端点吐的其实是上一代模板`,
      ).toBe(2)
    }
    return {
      id: row.id,
      template: extra.digitalEmployeeTemplate,
      contracts: (extra.executionContracts ?? []).map((entry) => entry.contractId),
    }
  })
  expect(
    declaredTable,
    '模板 id → 岗位 → 执行契约的对应表变了 ⇒ 按契约挑实现工具会挑到另一个岗位的代理，' +
      '而注册界面上两者长得一模一样',
  ).toEqual([
    {
      id: V2_DE_TEMPLATE_IDS[0],
      template: 'code-writing',
      contracts: ['development.implement-change'],
    },
    {
      id: V2_DE_TEMPLATE_IDS[1],
      template: 'problem-diagnosis',
      contracts: ['development.classify-pipeline-failures'],
    },
    {
      id: V2_DE_TEMPLATE_IDS[2],
      template: 'pipeline-repair',
      contracts: ['development.repair-pipeline-failures'],
    },
    {
      id: V2_DE_TEMPLATE_IDS[3],
      template: 'review-repair',
      contracts: ['development.resolve-review-feedback'],
    },
    {
      id: V2_DE_TEMPLATE_IDS[4],
      template: 'conflict-repair',
      contracts: ['development.resolve-merge-conflicts'],
    },
    {
      id: V2_DE_TEMPLATE_IDS[5],
      template: 'business-implementation',
      contracts: ['development.implement-change'],
    },
    {
      id: V2_DE_TEMPLATE_IDS[6],
      template: 'issue-repair',
      contracts: ['development.implement-change'],
    },
    {
      id: V2_DE_TEMPLATE_IDS[7],
      template: 'implementation-planning',
      contracts: ['development.plan-implementation'],
    },
  ])
  expect(
    new Set(declaredTable.map((entry) => entry.template)).size,
    '两条模板占了同一个岗位键 ⇒ 岗位与实现工具的对应关系塌成一条，另一个岗位永远拿不到实现',
  ).toBe(V2_DE_TEMPLATE_IDS.length)

  // ④ 这八条在普通代理列表里**一条都不出现**（`excludeBuiltinAgents`），但按 id
  //    仍然读得到——「列表里没有」不能是因为「它们根本不存在」。
  const listed = await json<AgentRow[]>('/api/agents', undefined, 'list ordinary agents')
  const listedIds = new Set(listed.map((row) => row.id))
  const leakedIntoList = [...V2_DE_TEMPLATE_IDS].filter((id) => listedIds.has(id))
  expect(
    leakedIntoList,
    '内置模板混进了普通代理列表 ⇒ 用户会去编辑 / 删除它们，而它们是全平台数字员工的基础设施',
  ).toEqual([])
  for (const id of V2_DE_TEMPLATE_IDS) {
    const row = await getAgent(id)
    expect(row.id, `${id} 按 id 都读不到 ⇒ 上一条「不在列表里」只是因为它压根不存在`).toBe(id)
  }
})

// ---------------------------------------------------------------------------
// RES-26 —— playground 取消当前轮 / 主动结束会话
// ---------------------------------------------------------------------------

test('RFC-319 RES-26: playground 的「取消当前轮」与「立即结束」各自真的改了服务端——一个把回合标成取消，一个把会话收成 user 结束 @nightly', async ({
  page,
}) => {
  const cancelMcp = await seedMcp(nextSlug('res26-cancel'))
  const endMcp = await seedMcp(nextSlug('res26-end'))
  await primeAuth(page)

  // ── 第一段：取消当前轮 ────────────────────────────────────────────────
  clearHoldStartedMarker()
  await openPlayground(page, cancelMcp.id)
  const cancelDialog = page.getByTestId('mcp-runtime-test-dialog')
  await cancelDialog
    .getByTestId('mcp-runtime-test-composer')
    .fill('List the tools without making a write call.')
  await cancelDialog.getByTestId('mcp-runtime-test-start').click()

  // 前提必须是**确定性**的：两颗按钮只在某个回合还在飞的时候才渲染
  //（`session.status==='active' && inFlightTurnId!==null`）。stub 落 `<hold>.started`
  // 之后就一直挂着，所以这一回合确定性地停在飞行中，而不是靠「跑得够慢」去赌。
  await waitForHeldTurn()
  const liveSession = await currentSession(cancelMcp.id)
  expect(liveSession, '会话根本没建起来 ⇒ 后面「取消它」什么也证明不了').not.toBeNull()
  const cancelSessionId = liveSession!.id
  expect(
    liveSession!.status,
    '前提：会话得先是活的、且有一回合在飞，否则取消按钮压根不该出现',
  ).toBe('active')
  expect(liveSession!.inFlightTurnId).not.toBeNull()

  const cancelButton = cancelDialog.getByTestId('mcp-runtime-test-cancel-turn')
  await expect(
    cancelButton,
    '有回合在飞却没有「取消当前轮」 ⇒ 用户对着一个还在对真 MCP 发调用的进程，没有任何刹车',
  ).toBeVisible()
  await cancelButton.click()

  // 取消的判据是 turn 落到 `canceled`（`resultTurnStatus`: cancelRequested 且会话没在结束）。
  // 只断言「不是 running」是不够的——stub 自己死掉、超时、失败都满足它。
  await expect
    .poll(async () => (await readSession(cancelMcp.id, cancelSessionId)).turns.at(-1)?.status, {
      message:
        '按了「取消当前轮」，回合却没落成 canceled ⇒ 要么进程根本没被掐断（用户以为停了，' +
        '它还在对着真 MCP 发调用），要么这次取消被记成了别的收场，事后分不清谁掐的',
      timeout: 90_000,
    })
    .toBe('canceled')
  const canceled = await readSession(cancelMcp.id, cancelSessionId)
  expect(
    canceled.turns.at(-1)?.cancelRequestedAt,
    '回合收尾了但没记下「是被用户取消的」 ⇒ 事后审计分不清它是被掐断的还是自己失败的',
  ).not.toBeNull()
  expect(
    canceled.inFlightTurnId,
    '取消之后会话还挂着一个在飞的回合 ⇒ 界面会一直显示「运行中」，用户以为没停下来',
  ).toBeNull()
  // 界面侧同样要把这次取消如实呈现（`turnOutcome.canceled`，warning 而不是 error）。
  // 服务端此刻已经是终态了，这里等的只是弹窗那条 1.5s 轮询把它取回来——Windows 腿的
  // 进程创建更慢，给足余量，别把「轮询晚了一拍」判成产品缺陷。
  await expect(
    cancelDialog.getByTestId('mcp-runtime-test-turn-issue'),
    '取消完界面不说话 ⇒ 用户不知道刚才那次点击到底生效了没有',
  ).toContainText('The last turn was canceled', { timeout: 30_000 })

  // ── 第二段：主动结束会话（另起一台 MCP：一个 owner 在同一台上只能有一个活会话）──
  clearHoldStartedMarker()
  await openPlayground(page, endMcp.id)
  const endDialog = page.getByTestId('mcp-runtime-test-dialog')
  await endDialog.getByTestId('mcp-runtime-test-composer').fill('Describe the mounted MCP.')
  await endDialog.getByTestId('mcp-runtime-test-start').click()
  await waitForHeldTurn()
  const endLive = await currentSession(endMcp.id)
  expect(endLive, '第二台上的会话没建起来 ⇒ 「结束」这一段没有前提').not.toBeNull()
  const endSessionId = endLive!.id
  expect(endLive!.status).toBe('active')

  await endDialog.getByTestId('mcp-runtime-test-end').click()
  const confirm = page.getByRole('dialog', { name: 'End the MCP test now?' })
  await expect(
    confirm,
    '「立即结束」不问一句就执行 ⇒ 手滑一下，正在跑的测试连同它的历史一起没了',
  ).toBeVisible()
  await confirm.getByRole('button', { name: 'End test now', exact: true }).click()

  await expect
    .poll(async () => (await readSession(endMcp.id, endSessionId)).status, { timeout: 90_000 })
    .toBe('ended')
  const ended = await readSession(endMcp.id, endSessionId)
  expect(
    ended.endReason,
    '会话结束了却没记成用户主动结束 ⇒ 与「闲置超时」「被撤权」混成一团，事后说不清它为什么断',
  ).toBe('user')
  expect(
    ended.turns.at(-1)?.status,
    '结束时那个在飞的回合没被收掉 ⇒ 模型进程与私有会话目录继续占着，而用户已经离开了',
  ).toBe('interrupted')

  // 界面侧：结束之后两颗终止按钮都不该再在场，取而代之的是「已结束」的说明。
  await expect(
    endDialog.getByTestId('mcp-runtime-test-end'),
    '会话都结束了「立即结束」还挂在那里 ⇒ 用户会再点一次，然后收到一个莫名其妙的错',
  ).toHaveCount(0)
  await expect(endDialog.getByTestId('mcp-runtime-test-cancel-turn')).toHaveCount(0)
  await expect(endDialog, '结束之后界面不说明状态 ⇒ 用户不知道还能不能再开一次').toContainText(
    'This test has ended.',
    { timeout: 30_000 },
  )
})

// ---------------------------------------------------------------------------
// MEM-X11 —— FuseDialog 的提交前校验与「没有可选托管技能」空态
// ---------------------------------------------------------------------------

test('RFC-319 MEM-X11: 从记忆页发起融合——没挑目标技能就提交被本地拦下且一个请求都不发；一个可写托管技能都没有时给的是空态而不是空下拉 @nightly', async ({
  page,
}) => {
  const title = `RFC-319 MEM-X11 memory ${nextSlug('memx11')}`
  const memory = await json<{ memory: { id: string } }>(
    '/api/memories',
    {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'global',
        scopeId: null,
        title,
        bodyMd: 'Prefer tabs over spaces in this repository.',
      }),
    },
    'seed memory',
  )
  await json(
    `/api/memories/${memory.memory.id}/promote`,
    { method: 'POST', body: JSON.stringify({ action: 'approve' }) },
    'approve memory',
  )

  // 前提：这个实例里一个托管技能都没有（beforeAll 已按 `.demo-seeded` 关掉示例播种，
  // 本文件也从不创建技能）。它不成立 ⇒ 下面那条空态断言会变成对空气的断言。
  const skills = await json<Array<{ sourceKind: string }>>(
    '/api/skills',
    undefined,
    'list skills for the empty-state precondition',
  )
  expect(
    skills.filter((skill) => skill.sourceKind === 'managed'),
    '这个实例里已经有托管技能了 ⇒ 「没有可选托管技能」这一态造不出来，本条的空态断言无效',
  ).toEqual([])

  await primeAuth(page)
  const fusionPosts = countRequests(page, 'POST', '/api/fusions')
  await page.goto(`${daemon.baseUrl}/memory`)
  const row = page.getByTestId(`memory-row-${memory.memory.id}`)
  await expect(row, '刚批准的记忆没出现在已批准库里 ⇒ 后面根本勾不上它').toBeVisible({
    timeout: 60_000,
  })
  await row.getByTestId(`memory-row-${memory.memory.id}-select`).check()

  const launch = page.getByTestId('memory-fuse-button')
  await expect(launch, '勾了记忆却没有融合入口 ⇒ 从记忆页发起融合这条路整个不存在').toBeVisible()
  await launch.click()
  const dialog = page.getByRole('dialog', { name: 'Fuse memories into a skill' })
  await expect(dialog).toBeVisible()

  // ① 「没有可选托管技能」空态：这块字段必须在场（它是必填项），但里面不是一个
  //    点不出任何东西的下拉，而是一句说明。用 `getByLabel` 写这条会整类漏掉——
  //    空态渲染的是一段 `<p>`，不是可标注的表单控件。
  await expect(
    dialog.getByText('Target skill', { exact: false }),
    '从记忆页进来却没有「目标技能」这一格 ⇒ 用户没有任何办法指定融合去处',
  ).toBeVisible()
  await expect(
    dialog.getByText('No managed skills you can write.', { exact: true }),
    '一个可写的托管技能都没有时给的是空下拉 ⇒ 用户对着一个点不出任何东西的选择器，' +
      '不知道是自己没权限还是页面坏了',
  ).toBeVisible()
  await expect(
    dialog.getByRole('combobox', { name: 'Target skill' }),
    '空态下还渲染了下拉 ⇒ 上面那句说明只是叠在旁边，选择器照样在骗人',
  ).toHaveCount(0)

  // ② 没挑目标技能就提交：本地拦下，**一个请求都不发**。
  //    （from-skill 入口不会走到这一支——那边 skillId 一开始就被入口钉死了。）
  await dialog.getByTestId('fusion-intent').fill('RFC-319 MEM-X11: consolidate this rule')
  await dialog.getByRole('button', { name: 'Start fusion', exact: true }).click()
  await expect(
    dialog.getByText('Pick a target skill.', { exact: true }),
    '没挑目标技能就提交却没有任何提示 ⇒ 用户点了按钮什么都没发生，只能反复点',
  ).toBeVisible()
  expect(
    fusionPosts(),
    '没挑目标技能也把融合请求发出去了 ⇒ 用户在以为已经提交之后才收到一次服务端 4xx',
  ).toBe(0)
  // 弹窗必须留在原地——把人关掉再报错等于让他从头再来一遍。
  await expect(dialog, '本地校验失败顺手把弹窗关了 ⇒ 刚填的意图与刚勾的记忆全部作废').toBeVisible()
  await expect(dialog.getByTestId('fusion-intent')).toHaveValue(
    'RFC-319 MEM-X11: consolidate this rule',
  )
})
