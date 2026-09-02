// RFC-319 —— 技能资源的用户面 e2e：手动新建 / 名字校验 / ZIP 错误态 / SKILL.md 保护 /
// 版本历史与对比 / 三类资源列表的搜索计数空态 / 三类资源详情的离开守卫 / 无写权时的
// 入口收敛 / 页签徽标。
//
// 覆盖能力账本 RES-01、RES-02、RES-05、RES-11、RES-12、RES-42、RES-43、RES-45、RES-X5
// 九行（账本里全部是 gap）。全部是 P2 / P3，所以每条 test 标题末尾都带 ` @nightly`
// ——PR 腿跑的是 `--grep-invert '@nightly'`（.github/workflows/e2e-full-nightly.yml:4-5），
// 这些用例只在夜跑的全量腿上跑；账本的 `tierWiringMismatches` 守卫会逐字核对这个 tag
// 与 `tier: 'nightly'` 是否一致（packages/backend/tests/architecture/capabilityLedger.ts:118-142）。
//
// 与既有 e2e 的分工（**刻意不重叠**）：
//   * `e2e/skill-lifecycle.spec.ts` —— 同为 RFC-319，但**整文件不开浏览器**：它在合同层
//     （编译后的 daemon + 真 SQLite + 真技能目录）验组合保存 / OCC 冲突（RES-07/09）、
//     文件树读写删（RES-10）、版本回滚（RES-13）、删除双闸（RES-14/29）、私有可见性
//     （RES-15）、PAT 脱敏（RES-44）。本文件**一次都不重复这些接口断言**，只做它们各自的
//     用户面：技能是文件系统事实源，接口证明「写进去了」，浏览器才能证明「用户点得到、
//     看得懂、点错了会被拦住」。唯一的例外是 RES-11 的接口旁路（见该用例注释里的理由）。
//   * `e2e/skill-import.spec.ts` 的
//     `real ZIP reaches responsive review and stable result with clean axe/focus contracts`
//     ——只走 ZIP 导入的**成功路**（select → review → commit → result），外加响应式几何、
//     焦点与 axe。它一次都没让 parse 失败过，也从没遇到过「包里一个技能都没有」。
//     本文件的 RES-05 补的正是那两条错误分支与它们的重试出口，不碰成功路。
//   * `e2e/a11y.spec.ts` 的 `/skills/new local tabs pass a11y` ——只切页签跑 axe，从不填表
//     提交；`/skills/$id` 那条也只跑 axe。本文件不做 a11y，只做行为。
//   * `e2e/rfc305-user-permissions.spec.ts` 的
//     `guest browser exposes public resources without mutation or task affordances`
//     ——它把 guest 的写入口断言全部落在 **agent** 详情（agent-save-button /
//     acl-dialog-button / detail-delete-button），`/skills` `/mcps` `/plugins` 在那条用例里
//     只是导航路径快照数组里的三个字符串，从没被 goto 过。本文件的 RES-45 补的就是这三张
//     详情页本身。
//   * `e2e/rfc319-mcp-management.spec.ts` ——MCP / 插件的**新建、保存、探测、停用、抢写**。
//     它从不碰列表页的搜索框，也从不制造未保存改动去撞守卫。本文件的 RES-42 / RES-43 在
//     MCP / 插件上只做「列表搜索」与「离开守卫」这两件它没做过的事。
//   * `split-search` / `split-count` / `split-empty` / `skill-tab-edit` / `skill-tab-files` /
//     `skill-tab-history` / `skill-panel-history` / `skill-new-path` / `skill-create-button`
//     这些 testid，在本文件之前的全仓 e2e 里**一次都没出现过**。
//
// 各条断言失效时**用户会遭遇什么**（这是每条用例存在的理由，不是断言在做什么）：
//
//   * RES-01 —— 手动页签是不导包、不写文件的人建技能的唯一入口。它若把正文丢了，用户会
//     得到一条只有名字的空技能，并且是在**几天后某个任务真的去加载它**时才发现——那时
//     人早就不记得自己当初在框里写过什么了。
//   * RES-02 —— 技能名字直接决定 `/skills/:name` 与运行期加载路径。带空格 / 大写的名字若
//     放过去，用户会拿到一条**建得出来却引用不到**的技能：列表里看得见，代理里选得上，
//     跑起来找不到。挡的位置必须在按钮上（点不下去），而不是等服务端回一句 400——后者
//     意味着用户已经把整张表填完了才被告知第一格填错。
//   * RES-05 —— 导入是批量操作，失败是常态（包传坏了、包里根本不是技能）。这两种失败必须
//     长得不一样、并且各自留一条出路：解不开的包若不给重试，用户只能刷新整页从头选文件；
//     「包里没技能」若还把「导入 0 个」的按钮亮着，用户会点下去、等一圈、什么也没发生，
//     然后开始怀疑是不是自己没选对文件。
//   * RES-11 —— SKILL.md 是技能的正文本体，只能从 Edit 页签改。文件树若允许新建同名文件，
//     用户会以为自己在加一个新文件，实际**把正文截断成空**；若允许删除，用户会一键删掉
//     整条技能的内容而列表里那条技能还在——一条内容为空的技能被代理加载时不会报错，只会
//     悄悄什么都不做。
//   * RES-12 —— 版本历史是「我上次到底改了什么、要不要回去」的唯一依据。列表若不标出哪一版
//     是当前版，用户会对着一串 v1/v2/v3 猜；对比弹窗若拿不出真正的差异（空 diff、或拿错了
//     两版），用户会在**看不清代价**的情况下按下回滚。
//   * RES-42 —— 左栏是这三类资源的唯一导航。搜索若漏掉可见事实（类型、版本号、拥有者），
//     用户在几十条清单里找那台「remote 的」会一无所获、转而重建一条重复的；计数若不跟着
//     过滤走，用户会以为自己搜漏了；真空列表与「筛没了」若长得一样，新用户会以为系统坏了，
//     老用户会以为自己的资源被删了。
//   * RES-43 —— 详情页没有自动保存。守卫若不拦，用户点一下左栏另一张卡片，刚写的描述 /
//     配置就**无声消失**，而且没有任何提示说它消失过。留守与丢弃必须各自生效：留守回不到
//     原页 = 守卫白拦；丢弃后草稿还在 = 用户以为自己放弃了改动，下次保存却把它带了出去。
//   * RES-43（技能特有的 outcome-unknown）—— 保存请求发出去了、回应丢了，服务端到底写没写
//     没人知道。这一档**不能给「丢弃」**：丢弃意味着「以本地为准继续」，而本地和服务端此刻
//     可能不是一回事；也不能放人走，因为一走就再也没有那个「复核」入口。给了 Discard，
//     用户会用它把一次**可能已经生效**的写入从视野里抹掉。
//   * RES-45 —— 只读者看见一排点不动 / 点了就 403 的按钮，等于每次都要试一次才知道自己不能做。
//     更糟的是 ACL 与删除入口：把它们显示给无权者，是在暗示「这条资源你管得了」。
//   * RES-X5 —— 三个页签只有一个是当前可见的。徽标是**另外两个页签里有事**的唯一信号：
//     徽标不出现，用户会带着 Files 里一个改了一半的文件直接离开；徽标出现在错的页签上，
//     用户会去 Edit 里翻半天找不到自己改了什么。而 History 在草稿未落定时必须拒绝开门——
//     版本列表描述的是**已保存**的历史，在一份脏草稿旁边并排显示，用户会以为自己看到的
//     v3 就是屏幕上这份内容。
//
// 源码锚点（可复跑核对，纯文本引用；禁 GitHub 外链见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/skills.new.tsx:104-109        创建按钮的 disabled 表达式（含 SKILL_NAME_RE）
//   packages/frontend/src/routes/skills.new.tsx:124-137        data-testid="skill-create-button"
//   packages/shared/src/schemas/skill.ts:7                     SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
//   packages/frontend/src/components/skills/ImportZipPanel.tsx:196-216   parse 失败 → 回 select 相 + parseError
//   packages/frontend/src/components/skills/ImportZipPanel.tsx:364-374   parseError 的 ErrorBanner + Retry 按钮
//   packages/frontend/src/components/skills/ImportZipPanel.tsx:475-503   rows 为空 → 「无候选」EmptyState（此时**不渲染**提交按钮）
//   packages/frontend/src/components/skills/ImportZipPanel.tsx:536-570   提交按钮只在 rows.length > 0 时存在
//   packages/backend/src/modules/resource-catalog/infrastructure/legacy/skill-zip.ts
//                                                              zip-decode-failed 的唯一来源（RFC-345 T9 迁位）
//   packages/frontend/src/i18n/en-US.ts:8004                   errors['zip-decode-failed'] 有 exact 译文 ⇒ 只显示标题
//   packages/frontend/src/components/SkillFileTree.tsx:100-110 validateNewPath：主文件保护挡在 stage 之前
//   packages/frontend/src/components/SkillFileTree.tsx:127-131 isPathReadonly（readonlyPaths + 词法判定）
//   packages/frontend/src/components/SkillFileTree.tsx:213-224 只有非只读路径才渲染「Mark for deletion」
//   packages/shared/src/skill-md.ts:35-44                      isProtectedSkillMainFile（前后端共用的词法闸）
//   packages/backend/src/services/skill.ts:934-951             assertNotSkillMainFile → ConflictError('skill-md-protected')
//   packages/frontend/src/components/skill/SkillVersionHistory.tsx:128-183  版本行 / current 标记 / Compare 按钮
//   packages/frontend/src/components/skill/SkillVersionHistory.tsx:190-208  diff 弹窗
//   packages/backend/src/services/skillVersion.ts:132-160      gitStyleDirDiff：真 unified diff
//   packages/frontend/src/components/split/ResourceSplitPage.tsx:362-399    split-count / split-search / split-empty
//   packages/frontend/src/lib/resource-card-filter.ts:10-21    过滤面 = title ∪ subtitle ∪ searchText
//   packages/frontend/src/routes/skills.tsx:51-55              技能卡片的 searchText（版本号 / private / 拥有者）
//   packages/frontend/src/routes/mcps.tsx:71-80                MCP 卡片的 searchText（类型 / 探测态 / 停用 / 拥有者）
//   packages/frontend/src/components/split/UnsavedChangesGuard.tsx:104-119  busy ⇒ 一律拦
//   packages/frontend/src/components/split/UnsavedChangesGuard.tsx:196-222  busy 时**不渲染** Discard
//   packages/frontend/src/routes/skills.detail.tsx:156-172     outcomeUnknown 时取 busy 令牌（不可诚实丢弃）
//   packages/frontend/src/routes/skills.detail.tsx:254-330     historyBlockedForNav + 三个页签的徽标优先级
//   packages/frontend/src/routes/skills.detail.tsx:877-909     History 面板：被拦时只给复核 / 丢弃入口
//   packages/frontend/src/routes/skills.detail.tsx:903-948     acl / save / del 三个入口的权限门
//   packages/frontend/src/lib/write-outcome.ts:46-52           非 4xx 的写失败一律 unknown
//   packages/frontend/src/lib/edit-scope.ts:115-128            再编辑一次会清掉 definitive 的 submitError（但保留 staleRemote）
//   packages/frontend/src/lib/edit-scope.ts:310-336            applyOrdinaryRemoteRead：脏 + 远端第三值 ⇒ staleRemote
//   packages/frontend/src/components/DetailHeaderActions.tsx:88-96          More 菜单的存在条件
//
// 执行模型：主体共用一个 daemon（stub 模式，不跑任何任务），全部请求走管理员会话。
// RES-42 需要一份**真空**的资源列表来分辨「一条都没有」与「筛没了」，所以它单独起第二个
// daemon（`emptyDaemon`），用完在 afterAll 里一起停掉。
//
// 关于 `page.route`：只有 RES-43 的 outcome-unknown 那一条用注入，且严格遵守
// docs/dev-gotchas.md §「e2e 里凡是 `page.route` 拦 API 的」——handler 里只有 `fulfill`，
// 一次 `route.fetch()` 都没有；匹配用 URL 谓词精确到本轮那一条 pathname；并且全文件
// `test.afterEach` 里 `unrouteAll({ behavior: 'wait' })`，先摘 handler 再趁 page 还活着
// 把在飞的等完。

import { expect, test, type Page } from '@playwright/test'
import { zipSync } from 'fflate'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

let daemon: DaemonHandle
/** 只给 RES-42 用的第二个 daemon：它的三张资源列表必须真的是空的。 */
let emptyDaemon: DaemonHandle | undefined
let sequence = 0

interface IdRow {
  id: string
}
interface SkillRow extends IdRow {
  name: string
  contentVersion: number
}
interface SkillContentRow {
  description: string
  bodyMd: string
  token: string
  contentVersion: number
}

function nextName(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

async function req(
  path: string,
  init?: RequestInit,
  token?: string,
  base?: string,
): Promise<Response> {
  return fetch(`${base ?? daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function json<T>(
  path: string,
  init: RequestInit | undefined,
  what: string,
  token?: string,
  base?: string,
): Promise<T> {
  const response = await req(path, init, token, base)
  const body = await response.text()
  expect(response.ok, `${what}: HTTP ${response.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

/** 种夹具时用哪个 daemon（凭据与 baseUrl 必须成对，分开传过一次 401）。 */
function on(target?: DaemonHandle): { token: string; base: string } {
  const handle = target ?? daemon
  return { token: handle.token, base: handle.baseUrl }
}

async function seedSkill(
  name: string,
  description = 'rfc319 fixture',
  bodyMd = 'Fixture body.',
  target?: DaemonHandle,
): Promise<SkillRow> {
  const { token, base } = on(target)
  return json<SkillRow>(
    '/api/skills',
    { method: 'POST', body: JSON.stringify({ name, description, bodyMd }) },
    `seed skill ${name}`,
    token,
    base,
  )
}

function readSkillContent(id: string): Promise<SkillContentRow> {
  return json<SkillContentRow>(`/api/skills/${id}/content`, undefined, `read content ${id}`)
}

async function seedRemoteMcp(name: string, target?: DaemonHandle): Promise<IdRow> {
  const { token, base } = on(target)
  return json<IdRow>(
    '/api/mcps',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'rfc319 fixture',
        type: 'remote',
        config: { url: 'http://127.0.0.1:1/mcp', oauth: false, timeoutMs: 5_000 },
        enabled: true,
      }),
    },
    `seed remote mcp ${name}`,
    token,
    base,
  )
}

async function seedLocalMcp(name: string, target?: DaemonHandle): Promise<IdRow> {
  const { token, base } = on(target)
  return json<IdRow>(
    '/api/mcps',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'rfc319 fixture',
        type: 'local',
        config: { command: [daemon.stubOpencode], timeoutMs: 5_000 },
        enabled: true,
      }),
    },
    `seed local mcp ${name}`,
    token,
    base,
  )
}

async function seedPlugin(name: string): Promise<IdRow> {
  return json<IdRow>(
    '/api/plugins',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        spec: daemon.stubOpencode,
        description: 'rfc319 fixture',
        enabled: true,
      }),
    },
    `seed plugin ${name}`,
  )
}

/** 把一条资源改成 public——否则无写权的旁观者连看都看不见（RES-45 的前置）。 */
async function publish(resourceBase: string): Promise<void> {
  const acl = await json<{ aclRevision: number; resourceId?: string }>(
    `${resourceBase}/acl`,
    undefined,
    `read acl ${resourceBase}`,
  )
  await json(
    `${resourceBase}/acl`,
    {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: resourceBase.slice(resourceBase.lastIndexOf('/') + 1),
        expectedAclRevision: acl.aclRevision,
      }),
    },
    `publish ${resourceBase}`,
  )
}

/** 建一个只有三类资源读权的账号（guest 预设），并登录拿会话。 */
async function seedReadOnlyUser(): Promise<string> {
  const username = nextName('rfc319_skill_reader')
  const password = 'longEnoughPassword'
  await json(
    '/api/users',
    {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: 'RFC-319 read-only viewer',
        email: `${username}@example.com`,
        role: 'guest',
        password,
      }),
    },
    `seed read-only user ${username}`,
  )
  const login = await json<{ sessionToken: string }>(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
    `login ${username}`,
  )
  return login.sessionToken
}

async function prime(page: Page, token: string, baseUrl: string): Promise<void> {
  await page.addInitScript(
    ({ base, sessionToken }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', base)
      window.localStorage.setItem('agent-workflow.token', sessionToken)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { base: baseUrl, sessionToken: token },
  )
}

const primeAdmin = (page: Page): Promise<void> => prime(page, daemon.token, daemon.baseUrl)

function skillMarkdown(name: string, description: string): Uint8Array {
  return new TextEncoder().encode(
    `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.\n`,
  )
}

/** 某个页签上的徽标（`tabs__tab-badge`）。不存在时 count 为 0。 */
function tabBadge(page: Page, tabTestId: string) {
  return page.getByTestId(tabTestId).locator('.tabs__tab-badge')
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (emptyDaemon !== undefined) await emptyDaemon.stop()
  if (daemon !== undefined) await daemon.stop()
})

// docs/dev-gotchas.md §「e2e 里凡是 `page.route` 拦 API 的」——先摘掉全部 handler，
// 再趁 page 还活着把已经在跑的等完。必须是 'wait'：'ignoreErrors' 只是把错吞掉，
// 那等于「重跑就过了」。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// RES-01 + RES-02 —— 手动页签建技能 + 名称格式校验
// ---------------------------------------------------------------------------

test('RFC-319 RES-01/RES-02: 手动页签建出的托管技能内容真的落库，名字不合格式时创建按钮压根按不下去 @nightly', async ({
  page,
}) => {
  const name = nextName('rfc319-manual')
  const description = 'Created from the manual tab, not from a ZIP.'
  const bodyMd = 'Line one of the manual body.\nLine two of the manual body.'

  // 记下所有发往 `POST /api/skills` 的请求：RES-02 的判据是「挡在请求之前」，
  // 只断言按钮灰着并不能排除「按钮灰着但表单还是提交了」。
  const creates: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/skills') {
      creates.push(request.url())
    }
  })

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/skills/new`)

  // 三个建法（手动 / ZIP / 配置包）的面板是**同时挂载**的（TabPanels 用 hidden 隐藏而不
  // 卸载，见 components/split/TabPanels.tsx:1-4），所以取字段必须限定在手动那一格里，
  // 否则同名 label 会撞上另外两格的表单。
  const managedPanel = page.locator('#skills-new-panel-managed')
  const nameInput = managedPanel.getByLabel(/^Name/)
  const createButton = page.getByTestId('skill-create-button')
  await expect(
    createButton,
    '手动页签上没有「创建技能」按钮 ⇒ 不导包的人没有任何自助建技能的入口',
  ).toBeVisible()
  await expect(
    createButton,
    '名字还没填，创建按钮就是可点的 ⇒ 用户点下去只会拿到一条服务端 400，' + '而错在哪一格要自己猜',
  ).toBeDisabled()

  // 带空格 + 大写：SKILL_NAME_RE 不接受。
  await nameInput.fill('Bad Name')
  await expect(
    createButton,
    '名字里有空格 / 大写也照样能提交 ⇒ 库里会多一条名字不合法的技能：列表里看得见、' +
      '代理里选得上，跑起来按 /skills/:name 找不到',
  ).toBeDisabled()
  // 表单声明的规则必须和后端 / 运行期加载用的是**同一条**（packages/shared/src/schemas/skill.ts:7）。
  // 断言的是属性字面量而不是 `input.validity.patternMismatch`：本仓这几个名字正则形如
  // `[a-z0-9_-]`，末尾那个未转义的 `-` 在 `v` 标志下是语法错误，而当前 HTML 规范要求浏览器
  // 用 `v` 编译 `pattern`——编译失败时约束被**静默丢弃**，于是 `patternMismatch` 恒为 false。
  // 也就是说，此刻真正拦住用户的只有下面这个 disabled 的按钮；native 校验是聋的。
  // 这里不去断言那个聋态（那等于把缺陷锁进用例），只锁「表单和共享规则是同一条字符串」。
  await expect(
    nameInput,
    '新建表单声明的名字规则与 SKILL_NAME_RE 不是同一条 ⇒ 两处规则一旦分叉，' +
      '按钮这道闸放行的名字后端会拒、或者反过来把合法名字挡在门外',
  ).toHaveAttribute('pattern', '^[a-z0-9][a-z0-9_-]*$')

  await nameInput.fill(name)
  await expect(
    createButton,
    '换成合法的 kebab-case 之后按钮还是灰的 ⇒ 用户被一条永远填不掉的校验卡死在新建页',
  ).toBeEnabled()

  await managedPanel.getByLabel('Description', { exact: true }).fill(description)
  await managedPanel.getByLabel('SKILL.md body (Markdown)', { exact: true }).fill(bodyMd)

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/skills' &&
      response.status() < 400,
  )
  await createButton.click()
  const id = ((await (await created).json()) as SkillRow).id

  await expect(
    page,
    '创建成功之后没有跳进新技能的详情 ⇒ 用户不知道自己刚建的东西在哪，只能回列表里找',
  ).toHaveURL(`${daemon.baseUrl}/skills/${id}`)
  await expect(
    page.getByRole('heading', { level: 2, name, exact: true }),
    '详情页标题不是刚输入的名字 ⇒ 用户无从确认自己落在了正确的那条技能上',
  ).toBeVisible()

  // 技能的事实源是文件系统（~/.agent-workflow/skills/{id}/files/SKILL.md），
  // 这里读回来的是解析后的 SKILL.md 本体——不是页面自己的缓存。
  const persisted = await readSkillContent(id)
  expect(
    persisted.description,
    '描述没写进 SKILL.md frontmatter ⇒ 用户填的说明在下次打开时消失',
  ).toBe(description)
  expect(
    persisted.bodyMd,
    '正文没写进 SKILL.md ⇒ 建出来的是一条空技能，直到某个任务真的加载它才会暴露',
  ).toBe(bodyMd)
  expect(persisted.contentVersion, '新建技能不是从 v1 起步 ⇒ 版本线一开始就对不上').toBe(1)

  expect(
    creates.length,
    `整个流程只应发出一次创建请求，实际发出了 ${creates.length} 次 ⇒ ` +
      '不合法的名字那次也被提交了出去（或者一次点击提交了两遍）',
  ).toBe(1)

  await page.goto(`${daemon.baseUrl}/skills`)
  const card = page.getByTestId(`split-card-${id}`)
  await expect(card, '新建的技能没有出现在左栏列表里 ⇒ 用户下次回来就找不到它了').toBeVisible()
  await expect(card, '卡片上没有版本徽标 ⇒ 用户在列表层面看不出哪条技能被改过多少轮').toContainText(
    'Content v1',
  )
})

// ---------------------------------------------------------------------------
// RES-05 —— ZIP 解析失败 / 包内无候选技能的错误态与重试
// ---------------------------------------------------------------------------

test('RFC-319 RES-05: ZIP 解不开与包里没技能是两种错，各自给出可重试的出口而不是把人卡死 @nightly', async ({
  page,
}) => {
  // ① 一个**真的 zip 被截断**的包：末尾的中央目录记录被切掉，fflate 解不出来。
  //    （随便一段随机字节也能触发同一个码，但截断更贴近真实事故：传输中断 / 复制没传完。）
  const intact = zipSync({
    'rfc319-zip-skill/SKILL.md': skillMarkdown('rfc319-zip-skill', 'A complete candidate.'),
  })
  const truncated = intact.slice(0, Math.floor(intact.length / 2))
  // ② 一个结构完整、但里面一个技能都没有的包：一个顶层散文件（名字压根不是合法技能名）
  //    加一个没有 SKILL.md 的目录。两个顶层条目 ⇒ 不触发 wrapper 剥壳
  //    （packages/shared/src/skill-zip.ts:119-127），于是两种拒绝理由各出现一次。
  const noCandidates = zipSync({
    'readme.txt': new TextEncoder().encode('this archive contains no skill at all\n'),
    'notes/todo.txt': new TextEncoder().encode('a directory without any SKILL.md\n'),
  })

  const parses: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/skills/import-zip/parse') {
      parses.push(request.url())
    }
  })

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/skills/new`)
  await page.getByTestId('skills-tab-zip').click()
  await expect(page.getByTestId('zip-select-phase')).toBeVisible()

  // --- ① 解不开的包 -------------------------------------------------------
  await page.getByTestId('zip-file-input').setInputFiles({
    name: 'truncated-pack.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(truncated),
  })
  await page.getByTestId('zip-parse-button').click()

  const parseError = page.getByText('Failed to decode the zip.', { exact: true })
  await expect(
    parseError,
    '包解不开却没有任何可见的错误 ⇒ 用户会盯着一个什么都没发生的页面反复点「检查」',
  ).toBeVisible()
  await expect(
    page.getByTestId('zip-review-phase'),
    '解不开的包竟然进了审查相 ⇒ 用户会对着一份根本没读出来的清单做导入决定',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('zip-select-phase'),
    '失败之后离开了选择相 ⇒ 用户既回不去也换不了文件，只剩刷新整页一条路',
  ).toBeVisible()

  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await expect(
    retry,
    '解析失败没有重试入口 ⇒ 一次网络抖动就要求用户从头把文件再选一遍',
  ).toBeVisible()
  await retry.click()
  await expect
    .poll(() => parses.length, { message: '点了重试却没有第二次解析请求 ⇒ 那个按钮是画上去的' })
    .toBe(2)
  await expect(
    parseError,
    '重试之后错误提示消失了但什么也没发生 ⇒ 用户会误以为这次成功了',
  ).toBeVisible()

  // --- ② 结构完整但没有候选技能 -------------------------------------------
  // 换文件时面板会先弹确认（已选的包属于未保存状态），这一步本身也是产品行为。
  await page.getByTestId('zip-file-input').setInputFiles({
    name: 'no-candidates-pack.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(noCandidates),
  })
  const replaceConfirm = page.getByRole('dialog', { name: 'Unsaved changes' })
  await expect(
    replaceConfirm,
    '换掉已选的包时不确认 ⇒ 用户手滑重选一次，上一份已经审好的决定就没了',
  ).toBeVisible()
  await replaceConfirm.getByRole('button', { name: 'Discard changes', exact: true }).click()

  await page.getByTestId('zip-parse-button').click()
  await expect(
    page.getByTestId('zip-review-phase'),
    '包能解开却没进审查相 ⇒ 用户看不到「里面到底有什么」的那一屏',
  ).toBeVisible()
  await expect(
    page.getByText('No importable skills', { exact: true }),
    '包里一个技能都没有，页面却不说 ⇒ 用户对着一张空清单猜是不是自己选错了文件',
  ).toBeVisible()
  await expect(
    page.getByTestId('zip-commit-button'),
    '没有候选却还留着导入按钮 ⇒ 用户点下去、等一圈、什么也没发生',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('zip-review-phase'),
    '被拒的条目数没有报出来 ⇒ 用户不知道包里那些文件为什么没被当成技能',
  ).toContainText('2 rejected entries')
  await expect(
    page.getByTestId('zip-review-phase'),
    '不逐条说明拒绝理由 ⇒ 用户只知道「没识别出来」，无从判断是目录层级错了还是名字非法',
  ).toContainText('skill-name-invalid')
  await expect(
    page.getByTestId('zip-review-phase'),
    '两种拒绝理由被压成同一句 ⇒ 「名字不合法」与「目录里没有 SKILL.md」要修的地方完全不同',
  ).toContainText('skill-md-missing')
})

// ---------------------------------------------------------------------------
// RES-11 —— SKILL.md 主文件保护
// ---------------------------------------------------------------------------

test('RFC-319 RES-11: SKILL.md 在文件树里既建不出同名、也删不掉，绕道接口同样被 409 挡住 @nightly', async ({
  page,
}) => {
  const skill = await seedSkill(nextName('rfc319-mainfile'), 'main file guard fixture', 'Body.')
  const beforeContent = await readSkillContent(skill.id)
  await json(
    `/api/skills/${skill.id}/file?path=${encodeURIComponent('references/notes.md')}`,
    { method: 'PUT', body: JSON.stringify({ content: 'notes\n' }) },
    'seed a deletable sibling file',
  )

  // 页面上任何一次真正的文件写入都会打到这两个路径；主文件那次点击必须一次都不打。
  const fileWrites: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname === `/api/skills/${skill.id}/file` && request.method() !== 'GET') {
      fileWrites.push(`${request.method()} ${request.url()}`)
    }
  })

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/skills/${skill.id}`)
  await page.getByTestId('skill-tab-files').click()
  const filesPanel = page.getByTestId('skill-panel-files')
  await expect(filesPanel).toBeVisible()

  // --- 建不出同名 ---------------------------------------------------------
  await page.getByTestId('skill-new-path').fill('SKILL.md')
  await filesPanel.getByRole('button', { name: 'Add to changes', exact: true }).click()
  await expect(
    filesPanel.getByText('SKILL.md is edited in the Edit tab, not the file tree', { exact: true }),
    '文件树接受了名为 SKILL.md 的新文件 ⇒ 用户以为自己在加一个新文件，实际把技能正文' +
      '截断成空，而列表里那条技能看上去毫无异常',
  ).toBeVisible()
  expect(fileWrites, '被拒的新建仍然发出了写请求 ⇒ 前端那道闸只是装饰，真正拦住它的是运气').toEqual(
    [],
  )

  // 输入框里留着一个没被采纳的路径 = 未保存的命令状态，保存必须被挡住。
  await expect(
    page.getByTestId('skill-save-button'),
    '框里还留着一个没被采纳的路径，保存却是可点的 ⇒ 用户会以为那一行也一起存进去了',
  ).toBeDisabled()
  await expect(page.getByTestId('skill-save-button')).toHaveAttribute(
    'title',
    'Add the typed file path to changes, or clear it first.',
  )

  // --- 删不掉 -------------------------------------------------------------
  await page.getByTestId('skill-new-path').fill('')
  await filesPanel.getByRole('button', { name: 'references/notes.md' }).click()
  await expect(
    filesPanel.getByRole('button', { name: 'Mark for deletion', exact: true }),
    '普通文件都没有删除入口 ⇒ 下面那条「主文件没有删除入口」证明不了任何事',
  ).toBeVisible()

  await filesPanel.getByRole('button', { name: 'SKILL.md' }).click()
  await expect(
    filesPanel.getByRole('button', { name: 'Mark for deletion', exact: true }),
    'SKILL.md 也给了删除入口 ⇒ 用户一键就能删掉整条技能的内容，而列表里它还在：' +
      '一条空技能被代理加载时不报错，只是悄悄什么都不做',
  ).toHaveCount(0)
  await expect(
    filesPanel.locator('textarea'),
    'SKILL.md 在文件树里可编辑 ⇒ 同一份正文有两个入口，两边各存一次就会互相覆盖',
  ).toBeDisabled()

  // --- 绕开界面直接打接口 -------------------------------------------------
  // 这一段刻意留在浏览器用例里：界面上的保护若只是「按钮不给点」，那么任何一个
  // 自动化脚本 / 旧版前端 / 手写 curl 都能把正文清掉。两层必须同时成立才算真保护。
  // （e2e/skill-lifecycle.spec.ts 的 RES-10 只验普通文件的读写删，从没碰过主文件。）
  for (const alias of ['SKILL.md', './SKILL.md', 'skill.md']) {
    const write = await req(`/api/skills/${skill.id}/file?path=${encodeURIComponent(alias)}`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'clobbered', expectedToken: beforeContent.token }),
    })
    expect(write.status, `PUT '${alias}' 没有被 409 挡住 ⇒ 换个写法就能把技能正文覆盖掉`).toBe(409)
    expect(await write.text()).toContain('skill-md-protected')

    const remove = await req(
      `/api/skills/${skill.id}/file?path=${encodeURIComponent(alias)}&expectedToken=${encodeURIComponent(beforeContent.token)}`,
      { method: 'DELETE' },
    )
    expect(remove.status, `DELETE '${alias}' 没有被 409 挡住 ⇒ 技能正文可以被删掉`).toBe(409)
  }

  const afterContent = await readSkillContent(skill.id)
  expect(
    afterContent.bodyMd,
    '几轮攻击之后技能正文变了 ⇒ 上面那些 409 里至少有一条其实写进去了',
  ).toBe(beforeContent.bodyMd)
})

// ---------------------------------------------------------------------------
// RES-12 —— 版本历史列表 + 版本对比弹窗
// ---------------------------------------------------------------------------

test('RFC-319 RES-12: 版本历史列出每一版并标出当前版，对比弹窗给的是两版之间真正的差异 @nightly', async ({
  page,
}) => {
  const firstBody = 'The body as it was written on day one.'
  const secondBody = 'The body after the second edit.'
  const skill = await seedSkill(nextName('rfc319-versions'), 'version history fixture', firstBody)
  const v1 = await readSkillContent(skill.id)
  await json(
    `/api/skills/${skill.id}/save`,
    { method: 'POST', body: JSON.stringify({ bodyMd: secondBody, expectedToken: v1.token }) },
    'seed second version',
  )
  const current = await readSkillContent(skill.id)
  expect(current.contentVersion, '两次写入之后版本号没有前进 ⇒ 后面的对账全部失去意义').toBe(2)

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/skills/${skill.id}`)
  await page.getByTestId('skill-tab-history').click()
  const historyPanel = page.getByTestId('skill-panel-history')
  await expect(
    historyPanel.getByRole('heading', { name: 'Version history', exact: true }),
    '干净的技能也进不去 History ⇒ 用户永远看不到自己改过什么',
  ).toBeVisible()

  // 版本行按 versionIndex 倒序（services/skillVersion.ts:762-764），所以第 0 行是最新的 v2。
  // 「当前版」标记要认那枚 chip 本身，不能拿整行文本找 'current'——历史行上的按钮文案
  // 「Compare to current」里也有这个词，那样断言会永远为真 / 永远为假。
  const rows = historyPanel.locator('tbody tr')
  const currentChip = '.chip--managed'
  await expect(
    rows,
    '版本行数与实际存下的版本数不一致 ⇒ 用户以为某一版从没存在过，或者对着一个不存在的版本回滚',
  ).toHaveCount(2)
  await expect(rows.nth(0), '最新的一行不是 v2 ⇒ 版本列表的顺序不是「新的在上」').toContainText(
    'v2',
  )
  await expect(rows.nth(1), '第二行不是 v1').toContainText('v1')
  await expect(
    rows.nth(0).locator(currentChip),
    '当前版没有被标出来 ⇒ 用户对着一串 v1/v2/v3 猜「我现在看到的是哪一版」',
  ).toHaveText('current')
  await expect(
    rows.nth(1).locator(currentChip),
    '历史版被误标成当前版 ⇒ 用户会以为自己已经在那一版上，从而跳过一次本该做的回滚',
  ).toHaveCount(0)
  await expect(
    rows.nth(0).getByRole('button'),
    '当前版也给了「对比 / 回滚」按钮 ⇒ 用户会把自己回滚到自己，白白多出一条噪音版本',
  ).toHaveCount(0)

  await rows.nth(1).getByRole('button', { name: 'Compare to current', exact: true }).click()
  const diffDialog = page.getByRole('dialog', { name: 'Skill diff: v1 → v2' })
  await expect(diffDialog, '点了对比什么都没弹 ⇒ 用户只能靠记忆判断要不要回滚').toBeVisible()
  await expect(
    diffDialog,
    'diff 里没有被删掉的旧正文 ⇒ 用户看不到回滚会**拿回**什么',
  ).toContainText(`-${firstBody}`)
  await expect(
    diffDialog,
    'diff 里没有新增的当前正文 ⇒ 用户看不到回滚会**丢掉**什么',
  ).toContainText(`+${secondBody}`)
  await expect(
    diffDialog,
    'diff 没有落在 SKILL.md 上 ⇒ 对比的根本不是这条技能的正文',
  ).toContainText('SKILL.md')
})

// ---------------------------------------------------------------------------
// RES-42 —— 三类资源列表的搜索 / 计数 / 空态
// ---------------------------------------------------------------------------

test('RFC-319 RES-42: 三类资源列表页的搜索、计数与空态各自说真话 @nightly', async ({ page }) => {
  // 「一条都没有」与「筛没了」必须能分辨，所以这一条用一个全新的 daemon：
  // 主 daemon 上早就堆满了别的用例的夹具。
  emptyDaemon = await startDaemon()
  const base = emptyDaemon.baseUrl
  await prime(page, emptyDaemon.token, base)

  // --- 真空列表 -----------------------------------------------------------
  await page.goto(`${base}/plugins`)
  await expect(
    page.getByTestId('split-empty'),
    '一条插件都没有时不给空态 ⇒ 新用户对着一片空白，不知道是没数据还是没加载出来',
  ).toBeVisible()
  await expect(
    page.getByTestId('split-empty'),
    '空态说的不是「还没有插件」⇒ 用户分不清是自己没建过，还是被过滤掉了',
  ).toContainText('No plugins registered.')
  await expect(
    page.getByTestId('split-count'),
    '空列表的计数不是 0 ⇒ 计数与列表在说两件事',
  ).toHaveText('0 items')

  // --- 搜索与计数（技能）--------------------------------------------------
  const alpha = await seedSkill('rfc319-list-alpha', 'The alpha fixture.', 'Body.', emptyDaemon)
  const beta = await seedSkill('rfc319-list-beta', 'The beta fixture.', 'Body.', emptyDaemon)
  await page.goto(`${base}/skills`)
  await expect(page.getByTestId(`split-card-${alpha.id}`)).toBeVisible()
  await expect(page.getByTestId(`split-card-${beta.id}`)).toBeVisible()
  await expect(
    page.getByTestId('split-count'),
    '计数与实际卡片数对不上 ⇒ 用户以为自己搜漏了、或者以为系统藏了东西',
  ).toHaveText('2 items')

  const search = page.getByTestId('split-search')
  await search.fill('alpha')
  await expect(
    page.getByTestId(`split-card-${beta.id}`),
    '搜索没有真的过滤 ⇒ 在几十条清单里搜等于白搜',
  ).toHaveCount(0)
  await expect(page.getByTestId(`split-card-${alpha.id}`)).toBeVisible()
  await expect(
    page.getByTestId('split-count'),
    '过滤之后计数不跟着走 ⇒ 「2 items」配一张卡片，用户会以为剩下那条被吞了',
  ).toHaveText('1 item')

  // 卡片上肉眼可见的事实（版本徽标）也必须可搜——否则「按版本找」在界面上看得见、
  // 搜起来却查无此物。
  await search.fill('Content v1')
  await expect(
    page.getByTestId('split-count'),
    '卡片上写着的版本徽标搜不出来 ⇒ 搜索面比「看得见的东西」还窄，用户无从预期它能搜到什么',
  ).toHaveText('2 items')

  await search.fill('no-such-resource-anywhere')
  await expect(
    page.getByTestId('split-empty'),
    '筛没了却不给任何反馈 ⇒ 用户以为列表挂了',
  ).toBeVisible()
  await expect(
    page.getByTestId('split-empty'),
    '「筛没了」与「一条都没有」说的是同一句话 ⇒ 老用户会以为自己的技能被删了',
  ).toContainText('No matches')
  const clear = page.getByRole('button', { name: 'Clear search', exact: true })
  await expect(clear, '筛没了之后不给一键清空 ⇒ 用户要手动把搜索框删干净才能回到全量').toBeVisible()
  await clear.click()
  await expect(
    page.getByTestId('split-count'),
    '清空搜索之后没有回到全量 ⇒ 用户以为资源真的少了',
  ).toHaveText('2 items')

  // --- 搜索面覆盖「类型」这类只出现在徽标里的事实（MCP）-------------------
  const localMcp = await seedLocalMcp('rfc319-list-local-mcp', emptyDaemon)
  const remoteMcp = await seedRemoteMcp('rfc319-list-remote-mcp', emptyDaemon)
  await page.goto(`${base}/mcps`)
  await expect(page.getByTestId(`split-card-${localMcp.id}`)).toBeVisible()
  await expect(page.getByTestId(`split-card-${remoteMcp.id}`)).toBeVisible()

  // 「Remote」只出现在卡片徽标上，名字与描述里都没有这个词——所以这一条锁的正是
  // searchText 这一维，而不是标题匹配碰巧命中。
  await page.getByTestId('split-search').fill('Remote')
  await expect(
    page.getByTestId(`split-card-${localMcp.id}`),
    '按类型搜把 local 的那条也留下了 ⇒ 类型这一维根本没进搜索面',
  ).toHaveCount(0)
  await expect(
    page.getByTestId(`split-card-${remoteMcp.id}`),
    '按类型搜不到 remote 的那条 ⇒ 用户找不到它，转而重建一条重复的 MCP',
  ).toBeVisible()
  await expect(page.getByTestId('split-count')).toHaveText('1 item')
})

// ---------------------------------------------------------------------------
// RES-43 —— 三类资源详情的未保存离开守卫
// ---------------------------------------------------------------------------

test('RFC-319 RES-43: 技能 / MCP / 插件详情的未保存改动都拦得住离开，留守与丢弃各自生效 @nightly', async ({
  page,
}) => {
  const originalSkillDescription = 'The description as saved.'
  const skillA = await seedSkill(nextName('rfc319-guard-a'), originalSkillDescription, 'Body.')
  const skillB = await seedSkill(nextName('rfc319-guard-b'), 'Neighbour skill.', 'Body.')
  const mcpA = await seedRemoteMcp(nextName('rfc319-guard-mcp-a'))
  const mcpB = await seedRemoteMcp(nextName('rfc319-guard-mcp-b'))
  const pluginA = await seedPlugin(nextName('rfc319-guard-plugin-a'))
  const pluginB = await seedPlugin(nextName('rfc319-guard-plugin-b'))

  await primeAdmin(page)

  const guard = page.getByTestId('unsaved-guard-dialog')
  const stay = page.getByTestId('unsaved-stay')
  const discard = page.getByTestId('unsaved-discard')

  // --- 技能：拦 → 留守 → 再拦 → 丢弃 -------------------------------------
  await page.goto(`${daemon.baseUrl}/skills/${skillA.id}`)
  const skillDescription = page.getByTestId('skill-description-input')
  await expect(skillDescription).toHaveValue(originalSkillDescription)
  await skillDescription.fill('An edit that was never saved.')
  await expect(
    page.getByTestId(`split-card-dot-${skillA.id}`),
    '左栏卡片上没有未保存圆点 ⇒ 用户切走之前得不到任何「这里还有东西没存」的提示',
  ).toBeVisible()

  await page.getByTestId(`split-card-${skillB.id}`).click()
  await expect(
    guard,
    '点另一张卡片就直接切走了 ⇒ 刚写的描述无声消失，而且没有任何提示说它消失过',
  ).toBeVisible()
  await expect(
    guard,
    '拦住了却不说为什么 ⇒ 用户只看到一个突然弹出的框，不知道自己有什么没存',
  ).toContainText('You have unsaved changes. Leaving this page will discard them.')
  await expect(
    stay,
    '弹框打开时焦点没落在「留在本页」上 ⇒ 键盘用户一个回车就把改动丢了',
  ).toBeFocused()

  await stay.click()
  await expect(page, '选了「留在本页」还是走了 ⇒ 这个按钮是假的，守卫等于没拦').toHaveURL(
    `${daemon.baseUrl}/skills/${skillA.id}`,
  )
  await expect(
    skillDescription,
    '留守之后草稿没了 ⇒ 「留在本页」保住了页面却没保住内容，比直接放行还糟',
  ).toHaveValue('An edit that was never saved.')

  await page.getByTestId(`split-card-${skillB.id}`).click()
  await expect(guard).toBeVisible()
  await discard.click()
  await expect(page, '明确选了「丢弃」还是走不了 ⇒ 用户被自己的草稿锁死在这一页').toHaveURL(
    `${daemon.baseUrl}/skills/${skillB.id}`,
  )

  await page.getByTestId(`split-card-${skillA.id}`).click()
  await expect(
    page.getByTestId('skill-description-input'),
    '「丢弃」之后草稿还在 ⇒ 用户以为自己放弃了这次修改，下一次保存却把它一起带了出去',
  ).toHaveValue(originalSkillDescription)

  // --- MCP ----------------------------------------------------------------
  await page.goto(`${daemon.baseUrl}/mcps/${mcpA.id}`)
  const mcpDescription = page
    .getByTestId('mcp-panel-config')
    .getByLabel('Description', { exact: true })
  await mcpDescription.fill('An MCP edit that was never saved.')
  await page.getByTestId(`split-card-${mcpB.id}`).click()
  await expect(
    guard,
    'MCP 详情的未保存改动不拦 ⇒ 用户刚填的连接参数在切卡片时无声消失',
  ).toBeVisible()
  await stay.click()
  await expect(page).toHaveURL(`${daemon.baseUrl}/mcps/${mcpA.id}`)
  await expect(mcpDescription).toHaveValue('An MCP edit that was never saved.')
  await page.getByTestId(`split-card-${mcpB.id}`).click()
  await discard.click()
  await expect(page).toHaveURL(`${daemon.baseUrl}/mcps/${mcpB.id}`)

  // --- 插件 ---------------------------------------------------------------
  await page.goto(`${daemon.baseUrl}/plugins/${pluginA.id}`)
  const pluginDescription = page.locator('#plugin-field-description')
  await pluginDescription.fill('A plugin edit that was never saved.')
  await page.getByTestId(`split-card-${pluginB.id}`).click()
  await expect(guard, '插件详情的未保存改动不拦 ⇒ 同样的静默丢失，只是换了一类资源').toBeVisible()
  await stay.click()
  await expect(page).toHaveURL(`${daemon.baseUrl}/plugins/${pluginA.id}`)
  await expect(pluginDescription).toHaveValue('A plugin edit that was never saved.')
  await page.getByTestId(`split-card-${pluginB.id}`).click()
  await discard.click()
  await expect(page).toHaveURL(`${daemon.baseUrl}/plugins/${pluginB.id}`)
})

// ---------------------------------------------------------------------------
// RES-43（技能特有档）+ RES-X5 —— outcome-unknown 的强制留守与页签徽标
// ---------------------------------------------------------------------------

test('RFC-319 RES-43/RES-X5: 保存结果未知时既不许离开也不给「丢弃」，页签转红且 History 只剩复核入口 @nightly', async ({
  page,
}) => {
  const skill = await seedSkill(nextName('rfc319-unknown'), 'Before the failed save.', 'Body.')
  const neighbour = await seedSkill(nextName('rfc319-unknown-neighbour'), 'Neighbour.', 'Body.')

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/skills/${skill.id}`)
  const description = page.getByTestId('skill-description-input')
  await expect(description).toHaveValue('Before the failed save.')
  await description.fill('A write whose fate nobody knows.')

  // 这一条锁的是界面的哪一段：`aggregate.outcomeUnknown`（skills.detail.tsx:156-172 取
  // busy 令牌、:254-268 让 History 拒绝开门、:1005-1023 弹告警条）以及守卫在 busy 下
  // **不渲染 Discard**（UnsavedChangesGuard.tsx:196-222）。
  //
  // 怎么确定性地造出这个状态：
  //   ① 保存请求回 500。非 4xx 的写失败一律判 `unknown`——4xx 才证明服务端拒绝了，
  //      500 只证明处理器被碰到过，可能已经提交（write-outcome.ts:46-52）。
  //   ② 紧接着的自动对账要读一份稳定快照，把 content 读也打成 500，对账拿不到答案，
  //      于是 `ambiguousSubmit` 留在原地——这正是产品定义的「结果未知」。
  // 两个 handler 都只 fulfill、绝不 route.fetch()；匹配用 URL 谓词精确到这两条 pathname。
  const fault = {
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: false,
      code: 'rfc319-injected-server-fault',
      message: 'injected: the response never came back',
    }),
  }
  await page.route(
    (url) => url.pathname === `/api/skills/${skill.id}/save`,
    (route) => route.fulfill(fault),
  )
  await page.route(
    (url) => url.pathname === `/api/skills/${skill.id}/content`,
    (route) => route.fulfill(fault),
  )

  await page.getByTestId('skill-save-button').click()

  await expect(
    page.getByText('Save result unknown', { exact: true }).first(),
    '保存结果未知时页面不说 ⇒ 用户会当成一次普通失败直接重试，而上一次可能已经写进去了',
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Recheck server state', exact: true }).first(),
    '不给「复核服务端状态」的入口 ⇒ 用户唯一能做的就是猜，或者刷新页面把证据丢掉',
  ).toBeVisible()

  // --- 页签徽标：Edit 转红，Files 干净 ------------------------------------
  await expect(
    tabBadge(page, 'skill-tab-edit'),
    'Edit 页签没有转红 ⇒ 用户切到别的页签之后，再也看不到「这里有一次结果未知的写入」',
  ).toHaveAttribute('data-tone', 'danger')
  await expect(tabBadge(page, 'skill-tab-edit')).toHaveAttribute(
    'aria-label',
    'Save result unknown',
  )
  await expect(
    tabBadge(page, 'skill-tab-files'),
    'Files 页签也跟着报警 ⇒ 用户会去翻一个根本没出事的页签',
  ).toHaveCount(0)

  // --- History 拒绝开门，且只给复核入口 -----------------------------------
  await page.getByTestId('skill-tab-history').click()
  const historyPanel = page.getByTestId('skill-panel-history')
  await expect(
    historyPanel.getByText('Version history needs a stable Skill', { exact: true }),
    '结果未知时还照常列出版本历史 ⇒ 用户会把某个「已保存版本」当成屏幕上这份内容',
  ).toBeVisible()
  await expect(
    historyPanel.getByText('Recheck the unknown save result before viewing versions.', {
      exact: true,
    }),
    '拦住了却不说为什么 ⇒ 用户以为版本历史坏了',
  ).toBeVisible()
  await expect(
    historyPanel.getByRole('heading', { name: 'Version history', exact: true }),
    '版本表仍然渲染出来了 ⇒ 「拒绝开门」只是加了一句提示，用户照样能在脏状态下回滚',
  ).toHaveCount(0)
  await expect(
    historyPanel.getByRole('button', { name: 'Discard all changes', exact: true }),
    '结果未知时给了「丢弃全部改动」⇒ 丢弃意味着「以本地为准」，而此刻本地和服务端' +
      '可能不是一回事',
  ).toHaveCount(0)
  await expect(
    tabBadge(page, 'skill-tab-history'),
    'History 页签没有报警 ⇒ 用户点进去才发现进不去',
  ).toHaveAttribute('data-tone', 'danger')

  // --- 强制留守：拦得住，且不给「丢弃」 -----------------------------------
  await page.getByTestId(`split-card-${neighbour.id}`).click()
  const guard = page.getByTestId('unsaved-guard-dialog')
  await expect(
    guard,
    '结果未知时还能一走了之 ⇒ 那个「复核」入口随页面一起消失，用户再也无法知道' +
      '上一次写入到底生效没有',
  ).toBeVisible()
  await expect(
    guard,
    '拦截文案说的还是「未保存改动」⇒ 用户以为丢掉的只是自己刚打的字，而不是一次' +
      '可能已经落库的写入',
  ).toContainText('A save is still in progress. Wait for it to finish before leaving this page.')
  await expect(
    page.getByTestId('unsaved-discard'),
    '结果未知时仍然给了「丢弃改动」⇒ 用户会用它把一次**可能已经生效**的写入从视野里抹掉',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('unsaved-stay'),
    '连「留在本页」都没有 ⇒ 弹框成了一个无处可去的死胡同',
  ).toBeVisible()

  await page.getByTestId('unsaved-stay').click()
  await expect(page, '留守之后仍然离开了这条技能 ⇒ 强制留守形同虚设').toHaveURL(
    `${daemon.baseUrl}/skills/${skill.id}`,
  )
})

// ---------------------------------------------------------------------------
// RES-45 —— 无写权时三类资源详情隐藏新建 / 保存 / 删除 / 权限入口
// ---------------------------------------------------------------------------

test('RFC-319 RES-45: 无写权的用户在三类资源详情里看不到新建 / 保存 / 删除 / 权限入口 @nightly', async ({
  page,
}) => {
  const skillName = nextName('rfc319-readonly')
  const mcpName = nextName('rfc319-readonly-mcp')
  const pluginName = nextName('rfc319-readonly-plugin')
  const skill = await seedSkill(skillName, 'Public read-only fixture.', 'Body.')
  const mcp = await seedRemoteMcp(mcpName)
  const plugin = await seedPlugin(pluginName)
  await publish(`/api/skills/${skill.id}`)
  await publish(`/api/mcps/${mcp.id}`)
  await publish(`/api/plugins/${plugin.id}`)

  const viewerToken = await seedReadOnlyUser()
  await prime(page, viewerToken, daemon.baseUrl)

  const surfaces = [
    {
      list: '/skills',
      detail: `/skills/${skill.id}`,
      card: `split-card-${skill.id}`,
      title: skillName,
      save: 'skill-save-button',
    },
    {
      list: '/mcps',
      detail: `/mcps/${mcp.id}`,
      card: `split-card-${mcp.id}`,
      title: mcpName,
      save: 'mcp-save-button',
    },
    {
      list: '/plugins',
      detail: `/plugins/${plugin.id}`,
      card: `split-card-${plugin.id}`,
      title: pluginName,
      save: 'plugin-save-button',
    },
  ] as const

  for (const surface of surfaces) {
    await page.goto(`${daemon.baseUrl}${surface.list}`)
    await expect(
      page.getByTestId(surface.card),
      `${surface.list}：公开资源对只读者不可见 ⇒ 后面「入口都藏起来了」可能只是因为页面根本没加载`,
    ).toBeVisible()
    await expect(
      page.getByTestId('split-new-button'),
      `${surface.list}：无建权的用户仍然看得见「新建」⇒ 每次都要点进去、填完、才被 403 告知不行`,
    ).toHaveCount(0)

    await page.goto(`${daemon.baseUrl}${surface.detail}`)
    await expect(
      page.getByRole('heading', { level: 2, name: surface.title, exact: true }),
      `${surface.detail}：详情页没渲染出这条资源 ⇒ 这一轮的「入口都不见了」什么也证明不了`,
    ).toBeVisible()
    await expect(
      page.getByTestId(surface.save),
      `${surface.detail}：无写权仍然看得见「保存」⇒ 用户改了一屏、点下去、吃一个 403，` +
        '而改动去哪了没人告诉他',
    ).toHaveCount(0)

    await page.getByTestId('detail-more-actions').click()
    const moreDialog = page.getByTestId('detail-actions-dialog')
    await expect(
      moreDialog,
      `${surface.detail}：More 菜单打不开 ⇒ 下面两条断言会因为「什么都没渲染」而假绿`,
    ).toBeVisible()
    await expect(
      moreDialog.getByTestId('acl-dialog-button'),
      `${surface.detail}：无权者看得见权限面板入口 ⇒ 这是在暗示「这条资源你管得了」`,
    ).toHaveCount(0)
    await expect(
      moreDialog.getByTestId('detail-delete-button'),
      `${surface.detail}：无权者看得见删除入口 ⇒ 一条别人的资源摆着一个红色删除按钮，` +
        '点下去才知道不行',
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
  }
})

// ---------------------------------------------------------------------------
// RES-X5 —— 脏 / 陈旧徽标的落点，与「有未保存改动时禁止进 History」
// ---------------------------------------------------------------------------

test('RFC-319 RES-X5: 脏与陈旧徽标各自只落在出问题的那个页签，有未保存改动时 History 拒绝开门 @nightly', async ({
  page,
}) => {
  const skill = await seedSkill(nextName('rfc319-badges'), 'The saved description.', 'Body.')
  await json(
    `/api/skills/${skill.id}/file?path=${encodeURIComponent('references/notes.md')}`,
    { method: 'PUT', body: JSON.stringify({ content: 'saved notes\n' }) },
    'seed a file to dirty',
  )

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/skills/${skill.id}`)
  const description = page.getByTestId('skill-description-input')
  await expect(description).toHaveValue('The saved description.')

  await expect(
    tabBadge(page, 'skill-tab-edit'),
    '什么都没改，Edit 页签就挂着徽标 ⇒ 徽标变成常亮的噪音，真出事时没人再看它',
  ).toHaveCount(0)
  await expect(tabBadge(page, 'skill-tab-files')).toHaveCount(0)
  await expect(tabBadge(page, 'skill-tab-history')).toHaveCount(0)

  // --- 脏徽标只落在被改的那个页签 ----------------------------------------
  await description.fill('A description edit that is not saved yet.')
  await expect(
    tabBadge(page, 'skill-tab-edit'),
    '改了描述，Edit 页签却不挂徽标 ⇒ 用户切到 Files 之后就再也看不到「Edit 里还有东西没存」',
  ).toHaveText('•')
  await expect(tabBadge(page, 'skill-tab-edit')).toHaveAttribute('aria-label', 'unsaved')
  await expect(
    tabBadge(page, 'skill-tab-files'),
    '只改了描述，Files 页签也挂上徽标 ⇒ 用户会去 Files 里翻半天找不到自己改了什么',
  ).toHaveCount(0)

  // --- 有未保存改动时 History 拒绝开门 -----------------------------------
  await expect(
    tabBadge(page, 'skill-tab-history'),
    '草稿未落定时 History 页签毫无提示 ⇒ 用户点进去才发现进不去',
  ).toHaveAttribute('aria-label', 'Save or discard all pending changes before viewing versions.')
  await page.getByTestId('skill-tab-history').click()
  const historyPanel = page.getByTestId('skill-panel-history')
  await expect(
    historyPanel.getByText('Version history needs a stable Skill', { exact: true }),
    '带着未保存草稿也照常列出版本历史 ⇒ 版本表描述的是**已保存**的历史，' +
      '和一份脏草稿并排放着，用户会以为屏幕上这份内容就是列表里的最新一版',
  ).toBeVisible()
  await expect(
    historyPanel.getByRole('heading', { name: 'Version history', exact: true }),
    '版本表仍然渲染出来了 ⇒ 「拒绝开门」只是加了一句提示，用户照样能在脏状态下回滚',
  ).toHaveCount(0)
  await expect(
    historyPanel.getByRole('button', { name: 'Discard all changes', exact: true }),
    '拦住了却不给出路 ⇒ 用户要自己一格一格把改动改回去才能看到版本历史',
  ).toBeVisible()

  // --- Files 也脏起来：两个页签各挂各的 ----------------------------------
  await page.getByTestId('skill-tab-files').click()
  const filesPanel = page.getByTestId('skill-panel-files')
  await filesPanel.getByRole('button', { name: 'references/notes.md' }).click()
  const fileEditor = filesPanel.locator('textarea')
  await expect(fileEditor).toHaveValue('saved notes\n')
  await fileEditor.fill('notes edited but not saved\n')
  await expect(
    tabBadge(page, 'skill-tab-files'),
    '改了文件内容，Files 页签却不挂徽标 ⇒ 用户会带着一个改了一半的文件直接离开',
  ).toHaveText('•')
  await expect(
    tabBadge(page, 'skill-tab-edit'),
    'Edit 的徽标被 Files 的改动顶掉了 ⇒ 两处未保存只报一处，另一处静默丢失',
  ).toHaveText('•')

  // --- 陈旧徽标：服务端在草稿之后又变过 -----------------------------------
  // 造法全程用真实产品行为，不注入任何请求：另一个人（这里是接口）先把描述改掉，
  // 页面手里的 OCC 令牌因此作废；点保存吃 409，随后的自动对账读回一份稳定快照，
  // 发现远端既不是基线也不是草稿——这就是 `staleRemote`。
  const currentContent = await readSkillContent(skill.id)
  await json(
    `/api/skills/${skill.id}/save`,
    {
      method: 'POST',
      body: JSON.stringify({
        description: 'Someone else changed this while you were typing.',
        expectedToken: currentContent.token,
      }),
    },
    'change the description behind the page',
  )

  await page.getByTestId('skill-tab-edit').click()
  await page.getByTestId('skill-save-button').click()
  await expect(
    page.getByText(
      'The stable server state differs from the submitted change. Your local draft was kept.',
      { exact: true },
    ),
    '抢写被拒之后不说明发生了什么 ⇒ 用户只知道「保存失败」，不知道是自己手慢了',
  ).toBeVisible()
  await expect(
    page.getByText('The server changed since this draft began. Review before saving.', {
      exact: true,
    }),
    '不提示服务端已经变过 ⇒ 用户会直接再存一次，把别人刚写的内容盖掉',
  ).toBeVisible()

  // 再敲一个字：definitive 的报错随之作废（edit-scope.ts:115-128），但「远端已变」
  // 这件事不会因为你多打了一个字就不成立——于是徽标应当从「红=保存失败」降为
  // 「黄=远端已变，存之前先看一眼」。
  await description.fill('A description edit that is not saved yet, again.')
  await expect(
    tabBadge(page, 'skill-tab-edit'),
    '再编辑一次之后 Edit 页签只剩一个普通的脏点 ⇒ 「服务端已经变过」这条更重要的事实' +
      '被降级成了「你有未保存改动」，用户会毫无戒心地覆盖掉别人的内容',
  ).toHaveAttribute(
    'aria-label',
    'The server changed since this draft began. Review before saving.',
  )
  await expect(tabBadge(page, 'skill-tab-edit')).toHaveAttribute('data-tone', 'attention')
  await expect(
    tabBadge(page, 'skill-tab-files'),
    '文件那边什么都没发生，却跟着 Edit 一起变成了「远端已变」⇒ 用户会去核对一个根本' +
      '没被人动过的文件',
  ).toHaveText('•')
})
