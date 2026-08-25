// RFC-319 —— 工作组「建 / 看 / 找 / 改名 / 复制 / 删」这一圈用户面 e2e。
//
// 覆盖能力账本 WG-01 / WG-02 / WG-03 / WG-04 / WG-16 / WG-17 / WG-18 七行
// （账本里全部是 gap）。工作组既有的 e2e 只跑「已经建好的组怎么执行任务」
// （workgroup-matrix / business-workgroup-scenarios）与「详情页自动保存」
// （rfc225-workgroup-autosave），**资源本身的生命周期一条都没锁**：新建对话框、
// 列表画廊、搜索、改名、复制、删除全靠单测与人工点。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//   * WG-04 —— 快速新建是**唯一**的建组入口。确认键的禁用判据一旦松掉，用户
//     会带着空名 / 以 `_` 开头的名字提交，然后吃一个服务端 422；判据一旦紧过头
//     （比如把描述也当必填），用户就再也建不出组。更隐蔽的一格是「创建成功却
//     不跳详情」：组建好了但用户停在列表上，会以为没成功而再点一次，于是撞
//     `workgroup-name-in-use`，界面上看起来就是「建不了组」。描述字段掉了也
//     没有任何报错——它只是**悄悄不落库**。
//   * WG-01 —— 画廊卡片是用户在启动任务前唯一能看到的组概况。模式 chip、成员数、
//     leader、人类成员、Private 徽章、归属人，每一格错都直接误导决策：把别人的
//     私有组显示成公开、把自由协作显示成 Leader-Worker、把「没有 leader 所以
//     根本启动不了」的组渲染出启动按钮（用户点进向导才吃 `workgroup-not-ready`）。
//     反向也一样致命：就绪的组不给启动入口，用户会以为功能坏了。
//   * WG-02 —— 搜索过滤的是**卡片上可见的事实**（含模式 / 成员数 / leader /
//     归属人），不只是标题。它若退化成只搜标题，用户按「Free collaboration」
//     找组会一条都搜不到；无匹配时若不给空态与「清空搜索」，用户面对空白页
//     只能手动删输入框——而清空后若不复原列表 / 不把焦点还回搜索框，就是一次
//     彻底的死界面。
//   * WG-03 —— 空态是新用户的第一屏。空态若不给主行动按钮，用户在一个空白页面
//     上找不到「新建」；按钮若不看权限一律渲染，没有 `workgroups:create` 的账号
//     点下去只能吃 403。有数据之后空态若还挂着，界面自相矛盾；页头与空态若同时
//     渲染两个「新建」，Dialog 的焦点归还会指向已经卸载的那一个。
//   * WG-16 —— 改名对话框同时改名称与描述，必须**一次落库**。拆成两笔的话中间
//     失败会留下「名字改了描述没改」的半截状态。重名（同一 owner 名字域）必须
//     整笔回退：若服务端放行，两个同名组会让按名字选组的调用节点无法消歧；
//     若前端不报错只是静默失败，用户以为改好了，实际服务端还是旧名字。
//   * WG-17 —— 复制必须钉在**确切那一版**上：源在你点复制的瞬间被别人改了，
//     还照旧复制就等于复制了一份你没看过的内容。副本必须落成**你自己的私有**
//     资源——若继承源的 `public`，用户以为「复制一份自己改」，实际把改动直接
//     暴露给全平台。名字必须自动取 `-copy` 阶梯，否则复制当场撞 owner 名字唯一约束。
//   * WG-18 —— 删除是不可逆的。三道闸各挡一类事故：输入名称确认挡误点（服务端
//     也必须自己校验，前端跳过对话框直接打接口不能得逞）；版本 fence 挡「别人
//     刚改过你却按旧版本删」；非终态任务引用挡「删掉一个正在跑任务的组」——
//     那会让运行中的任务失去它的组定义。任何一道松掉，用户丢的都是不可恢复的数据。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/workgroups.tsx:68-91        快速新建 mutation + 成功后跳详情
//   packages/frontend/src/routes/workgroups.tsx:94-175       画廊卡片投影（模式/成员/leader/人类/徽章/就绪）
//   packages/frontend/src/routes/workgroups.tsx:177-190      唯一一个 createAction 在空态与页头间搬家
//   packages/frontend/src/routes/workgroups.tsx:204-221      emptyAction / 空态文案 / 搜索占位
//   packages/frontend/src/routes/workgroups.tsx:231-236      非法名的内联错误只在非空输入时出
//   packages/frontend/src/components/gallery/ResourceGalleryPage.tsx:82-95   isGenuineEmpty / headerActions 互斥 / 清空后回焦
//   packages/frontend/src/components/gallery/ResourceGalleryPage.tsx:114-156 空态 / 计数 / 搜索框 / 无匹配空态 + Clear search
//   packages/frontend/src/components/gallery/GalleryCard.tsx:100-116         启动入口按 launch + tasks:execute
//   packages/frontend/src/lib/resource-card-filter.ts:11-21   title / subtitle / searchText 三面过滤
//   packages/frontend/src/components/ResourceBadges.tsx:26-40 Private chip + 归属人徽章
//   packages/frontend/src/components/QuickCreateDialog.tsx:88-101 确认键禁用判据
//   packages/frontend/src/lib/workgroup-form.ts:54-72         buildQuickCreatePayload（折叠后判名）
//   packages/frontend/src/routes/workgroups.detail.tsx:649-652 renameCanSave（合法 ∧ 真的改了）
//   packages/frontend/src/routes/workgroups.detail.tsx:1047-1082 RenameDialog → 一次 editDrafts（immediate）
//   packages/frontend/src/routes/workgroups.detail.tsx:611-635 copyResource：ensureSaved + exact-revision
//   packages/frontend/src/routes/workgroups.detail.tsx:545-563 del：confirm + expectedVersion
//   packages/frontend/src/routes/workgroups.detail.tsx:1023-1045 ConfirmDialog 的 confirmInput 接线
//   packages/frontend/src/components/ConfirmDialog.tsx:83-95   confirmMatched 精确相等 + 键盘也走同一道门
//   packages/backend/src/routes/workgroups.ts:213-235          DELETE：404 → govern → parse → confirm → 业务闸
//   packages/backend/src/services/deleteConfirm.ts:44-66       delete-confirm-required / -mismatch
//   packages/backend/src/services/workgroups.ts:445-446        改名资格 + owner 名字域唯一
//   packages/backend/src/services/workgroups.ts:908-928        assertNameChangeAllowedInTx ⇒ workgroup-name-in-use
//   packages/backend/src/services/workgroups.ts:264-291        copy：exact-revision fence + nextResourceCopyName
//   packages/backend/src/services/workgroups.ts:557-568        delete 版本 fence
//   packages/backend/src/services/workgroups.ts:570-585        非终态任务引用 ⇒ workgroup-in-use
//   packages/backend/src/services/resourceCopyName.ts:60-76    -copy / -copy-N 阶梯
//   packages/shared/src/schemas/workgroup.ts:483-503           workgroupLaunchReadiness
//   packages/shared/src/schemas/workgroup.ts:532-536           workgroupHasHumanMember
//   packages/shared/src/schemas/permission.ts:915-923          GUEST_BASELINE 有 workgroups:read、没有 :create
//   packages/shared/src/lifecycle.ts:203-208                   TERMINAL_TASK_STATUSES
//
// 执行模型：全文件共用一个 daemon。stub 用 `slow` 模式并挂上
// `STUB_OPENCODE_HOLD_FILE`（packages/system-mocks/src/runtime/mode-slow.ts:62-73）：
// 只有 WG-18 需要「一条**确定性**停在非终态的任务」，它在动手前才把 hold 文件
// 建出来；其余用例期间该文件不存在，stub 完全不受影响。
// 每条用例各自开一个新用户做夹具，所以「列表里有几条」永远是这条用例自己种的，
// 不受其他用例影响（RFC-231：所有 canonical 创建路径都是 creator-owner + private）。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

const PASSWORD = 'Rfc319WorkgroupPass!1'

let daemon: DaemonHandle
let holdDir: string
let holdFile: string
let sequence = 0

interface SeededUser {
  username: string
  userId: string
  token: string
}

interface WorkgroupMemberRow {
  id: string
  memberType: 'agent' | 'human'
  agentId: string | null
  userId: string | null
  displayName: string
  roleDesc: string
}

interface WorkgroupRow {
  id: string
  name: string
  description: string
  mode: 'leader_worker' | 'free_collab' | 'dynamic_workflow'
  leaderMemberId: string | null
  members: WorkgroupMemberRow[]
  version: number
  ownerUserId?: string | null
  visibility?: 'public' | 'private'
  snapshotHash?: string
  updatedAt: number
}

interface TaskRow {
  id: string
  status: string
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function raw(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
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

async function json<T>(token: string, path: string, init: RequestInit | undefined, what: string) {
  const res = await raw(token, path, init)
  expect(res.status < 400, `${what}: HTTP ${res.status} ${res.body}`).toBe(true)
  return JSON.parse(res.body) as T
}

/** DELETE 的 body 需要一个合法 ULID 形状的 clientMutationId
 *  （schemas/workgroup.ts:433-440 的 WorkgroupMutationIdSchema）。 */
function newMutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = '01'
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

async function seedUser(role: 'user' | 'guest', tag: string): Promise<SeededUser> {
  const username = `rfc319-wg-${tag}-${++sequence}`
  const created = await json<{ id: string }>(
    daemon.token,
    '/api/users',
    {
      method: 'POST',
      // 邮箱不是可选项：RFC-320 起任务的 git 提交身份取自创建者账号，缺邮箱的
      // 账号连启动都过不去（getUserGitCommitIdentity.ts:31-34 的
      // `git-identity-email-missing`）。WG-18 要真的起一条任务。
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role,
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
  return { username, userId: created.id, token: sessionToken }
}

async function seedAgent(owner: SeededUser, name: string): Promise<string> {
  const agent = await json<{ id: string }>(
    owner.token,
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 workgroup CRUD fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '',
      }),
    },
    `seed agent ${name}`,
  )
  return agent.id
}

async function seedWorkgroup(
  owner: SeededUser,
  body: Record<string, unknown>,
): Promise<WorkgroupRow> {
  return json<WorkgroupRow>(
    owner.token,
    '/api/workgroups',
    { method: 'POST', body: JSON.stringify(body) },
    `seed workgroup ${String(body.name)}`,
  )
}

/** RFC-231 起所有 canonical 创建路径都是 creator-owner + private；要让别的账号
 *  「确实看得见」某个组（作为负向断言的正向前提）必须显式改 public。 */
async function setVisibility(
  owner: SeededUser,
  workgroupId: string,
  visibility: 'public' | 'private',
): Promise<void> {
  const acl = await json<{ aclRevision: number }>(
    owner.token,
    `/api/workgroups/${workgroupId}/acl`,
    undefined,
    'read workgroup acl',
  )
  const res = await raw(owner.token, `/api/workgroups/${workgroupId}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      visibility,
      expectedResourceId: workgroupId,
      expectedAclRevision: acl.aclRevision,
    }),
  })
  expect(res.status, `set ${workgroupId} ${visibility}: ${res.body}`).toBe(200)
}

async function getWorkgroup(token: string, id: string): Promise<WorkgroupRow> {
  return json<WorkgroupRow>(token, `/api/workgroups/${id}`, undefined, `read workgroup ${id}`)
}

async function listWorkgroups(token: string): Promise<WorkgroupRow[]> {
  return json<WorkgroupRow[]>(token, '/api/workgroups', undefined, 'list workgroups')
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

/**
 * 画廊卡片上一格一格的 chip 文本（`.gallery-card__meta` 的直接子 span）。
 *
 * 取 `textContent` 而非 `innerText`：`.status-chip` 带
 * `text-transform: lowercase`（packages/frontend/src/styles.css:6847），
 * innerText 会把渲染后的小写还回来，于是断言锁的就变成了那条 CSS 而不是文案本身。
 */
async function metaChips(page: Page, cardName: string): Promise<string[]> {
  return page
    .getByTestId(`workgroup-card-${cardName}`)
    .locator('.gallery-card__meta > span')
    .allTextContents()
}

async function badgeChips(page: Page, cardName: string): Promise<string[]> {
  return page
    .getByTestId(`workgroup-card-${cardName}`)
    .locator('.gallery-card__badges > span')
    .allTextContents()
}

test.beforeAll(async () => {
  // hold 文件此刻**不存在** —— stub 只在文件存在时才扣住一回合
  // （mode-slow.ts:62-73），所以除 WG-18 外的用例完全不受影响。
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-wgcrud-hold-'))
  holdFile = join(holdDir, 'hold')
  daemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: holdFile },
  })
})

test.afterAll(async () => {
  try {
    rmSync(holdFile, { force: true })
  } catch {
    /* best-effort */
  }
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(holdDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// ---------------------------------------------------------------------------
// WG-04
// ---------------------------------------------------------------------------

test('WG-04 快速新建：空名与非法名不给提交，合法输入落成 private 组并直接进详情页', async ({
  browser,
}) => {
  const owner = await seedUser('user', 'wg04')
  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workgroups`)

    // 正向前提：这个账号确实有建组入口。少了这一步，下面「点开对话框」失败
    // 会被误读成权限问题而不是回归。
    const newButton = page.getByTestId('workgroup-new-button')
    await expect(
      newButton,
      '有 workgroups:create 的账号在空列表上找不到新建入口 ⇒ 新用户第一屏就是死路',
    ).toBeVisible({ timeout: 60_000 })
    await newButton.click()

    const dialog = page.getByTestId('workgroup-create-dialog')
    await expect(dialog, '点「新建工作组」没有弹出对话框 ⇒ 建组入口点了没反应').toBeVisible()
    const nameInput = page.getByTestId('workgroup-create-name')
    const descriptionInput = page.getByTestId('workgroup-create-description')
    const confirm = page.getByTestId('workgroup-create-confirm')

    // (1) 空名基线：确认键必须是禁用的。这条不成立，用户会提交一个空名并吃
    // 服务端 422，而对话框上没有任何字段级提示告诉他哪里错了。
    await expect(
      confirm,
      '名称还是空的时候「创建工作组」可点 ⇒ 用户提交后只会拿到一个服务端报错',
    ).toBeDisabled()
    await expect(
      dialog.getByRole('alert'),
      '一个字都没输就报错 ⇒ 新建对话框一打开就是红的，看起来像坏了',
    ).toHaveCount(0)

    // (2) 非法名：`_` 开头是框架内建行（__workgroup_host__）保留的形状
    //     （schemas/resourceName.ts:56 的 `(?!_)`）。必须当场给内联错误，
    //     而不是让用户提交后才知道。
    await nameInput.fill('_reserved-prefix')
    await expect(
      dialog.getByRole('alert'),
      '以 _ 开头的名字没有内联错误 ⇒ 用户要提交一次才知道这个前缀是保留的',
    ).toHaveText(
      'Name must not start with _ or contain control characters, and is at most 128 characters.',
    )
    await expect(
      confirm,
      '非法名字仍然可以提交 ⇒ 前端判据形同虚设，错误全部推给服务端',
    ).toBeDisabled()

    // (3) 合法输入：名称 + 描述。
    const name = `rfc319-wg04-${owner.username}`
    const description = 'Release train crew for the RFC-319 coverage batch'
    await nameInput.fill(name)
    await descriptionInput.fill(description)
    await expect(confirm, '名称合法后确认键仍然禁用 ⇒ 这个账号根本建不出工作组').toBeEnabled()
    await confirm.click()

    // (4) 用户可见后果：直接落在这个新组的详情页上，而不是停在列表页。
    //     停在列表 = 用户以为没建成 → 再点一次 → 撞 workgroup-name-in-use。
    await expect(
      page.getByRole('heading', { level: 1 }),
      '创建成功后没有跳进新组详情页 ⇒ 用户看不到「建好了」，会重复提交并撞重名',
    ).toHaveText(name, { timeout: 30_000 })

    // (5) 服务端真值对账：这个 owner 名下恰好一条，字段逐格落库。
    const rows = await listWorkgroups(owner.token)
    expect(
      rows.map((row) => row.name),
      '新建后服务端不是恰好一条该名字的组 ⇒ 要么没落库，要么建重了',
    ).toEqual([name])
    const created = rows[0] as WorkgroupRow
    expect(created.description, '描述被悄悄丢弃 ⇒ 用户填的说明没有任何报错地消失了').toBe(
      description,
    )
    expect(created.ownerUserId, '新建的组不归创建者 ⇒ 他将无法改名 / 删除自己刚建的组').toBe(
      owner.userId,
    )
    expect(
      created.visibility,
      '快速新建出来的组默认 public ⇒ 用户随手建的组对全平台可见，他不会知道',
    ).toBe('private')
    expect(created.version, '新组的初始版本不是 1 ⇒ 后续所有版本 fence 的基线就错了').toBe(1)
    expect(
      { mode: created.mode, members: created.members.length },
      '快速新建应当只收名称+描述，其余走后端默认（leader_worker / 空名单）',
    ).toEqual({ mode: 'leader_worker', members: 0 })
    expect(page.url(), '浏览器地址没停在新组详情上 ⇒ 刷新会回到别处').toContain(
      `/workgroups/${created.id}`,
    )
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-01
// ---------------------------------------------------------------------------

test('WG-01 列表画廊：模式/成员数/leader/人类成员/可见性/归属人逐格对账，未就绪的组不给启动入口', async ({
  browser,
}) => {
  const owner = await seedUser('user', 'wg01')
  const prefix = `rfc319-wg01-${owner.username}`
  const agentId = await seedAgent(owner, `${prefix}-agent`)

  // 五个组按「一个格子一个对照」铺开：模式三种、成员数 0/1/2/3、
  // 有无 leader、有无人类成员、private/public。
  const lw = await seedWorkgroup(owner, {
    name: `${prefix}-lw`,
    description: 'Ships the release train',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [
      { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: 'Coordinates' },
      { memberType: 'agent', agentId, displayName: 'Builder', roleDesc: 'Implements' },
      { memberType: 'human', userId: owner.userId, displayName: 'Ops', roleDesc: 'Confirms' },
    ],
  })
  const fc = await seedWorkgroup(owner, {
    name: `${prefix}-fc`,
    description: '',
    mode: 'free_collab',
    members: [
      { memberType: 'agent', agentId, displayName: 'Alpha', roleDesc: '' },
      { memberType: 'agent', agentId, displayName: 'Beta', roleDesc: '' },
    ],
  })
  const dw = await seedWorkgroup(owner, {
    name: `${prefix}-dw`,
    description: 'Generated per goal',
    mode: 'dynamic_workflow',
    members: [{ memberType: 'agent', agentId, displayName: 'Solo', roleDesc: '' }],
  })
  const noLeader = await seedWorkgroup(owner, {
    name: `${prefix}-noleader`,
    description: 'Roster without a designated leader',
    mode: 'leader_worker',
    members: [{ memberType: 'agent', agentId, displayName: 'Worker', roleDesc: '' }],
  })
  const quick = await seedWorkgroup(owner, {
    name: `${prefix}-quick`,
    description: 'Just created, no members yet',
    mode: 'leader_worker',
    members: [],
  })
  // 自由协作组改成 public——「Private 徽章只在私有组上出现」这条断言必须有一个
  // 公开组做对照，否则「所有卡片都印 Private」也能过。
  //
  // 公开行对**全平台**可见（services/resourceAcl.ts:544-551），会污染同一个
  // daemon 上后面那些数条数 / 判空态的用例，所以用完必须收回去（finally）。
  await setVisibility(owner, fc.id, 'public')

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(page.getByTestId('gallery-grid')).toBeVisible({ timeout: 60_000 })
    const visible = await listWorkgroups(owner.token)
    expect(
      visible.length,
      '这个新账号看到的组数不等于它自己种下的 5 条 ⇒ 夹具被别的用例污染了，下面的对账不可信',
    ).toBe(5)
    await expect(
      page.getByTestId('gallery-count'),
      '页面上的条数与服务端可见集合对不上 ⇒ 用户看到的是一份残缺的清单',
    ).toHaveText('5 items')

    // ---- 元信息 chip 逐格对账 ------------------------------------------
    expect(
      await metaChips(page, lw.name),
      'Leader-Worker 组的 chip 行不完整：模式 / 成员数 / leader / 人类成员，' +
        '任意一格错都会让用户按错误的概况挑组',
    ).toEqual(['Leader-Worker', '3 members', 'Leader · Lead', 'Has humans'])
    expect(
      await metaChips(page, fc.name),
      '自由协作组印出了 leader 或人类成员 chip ⇒ 用户以为这个组有人主持 / 有人把关，' +
        '实际两者都没有',
    ).toEqual(['Free collaboration', '2 members'])
    expect(
      await metaChips(page, dw.name),
      '单成员组的成员数用了复数（"1 members"）⇒ 计数文案的单复数规则坏了',
    ).toEqual(['Dynamic workflow', '1 member'])
    expect(
      await metaChips(page, quick.name),
      '刚快速新建、还没加人的组不该凭空多出成员 / leader chip',
    ).toEqual(['Leader-Worker', '0 members'])

    // ---- 可见性 / 归属人徽章 -------------------------------------------
    expect(
      await badgeChips(page, lw.name),
      '私有组缺 Private 徽章或缺归属人 ⇒ 用户分不清哪些组只有自己看得见、哪些是别人的',
    ).toEqual(['Private', owner.username])
    expect(
      await badgeChips(page, fc.name),
      '公开组仍然印着 Private ⇒ 徽章不看真实 visibility，用户会以为自己的组没暴露',
    ).toEqual([owner.username])

    // ---- 描述 / 空描述 ---------------------------------------------------
    await expect(
      page.getByTestId(`workgroup-card-${lw.name}`).locator('.gallery-card__desc'),
      '卡片不显示描述 ⇒ 组之间只能靠名字区分',
    ).toHaveText('Ships the release train')
    await expect(
      page.getByTestId(`workgroup-card-${fc.name}`).locator('.gallery-card__desc'),
      '没有描述的卡片留白 ⇒ 用户不知道是「没填」还是「没加载出来」',
    ).toHaveText('(no description)')

    // ---- 启动入口 = workgroupLaunchReadiness，正反两侧都要立 ------------
    await expect(
      page.getByTestId(`workgroup-card-${lw.name}-launch`),
      '已就绪的组不给启动入口 ⇒ 用户得先点进详情页才能发起任务，列表页的启动能力丢了',
    ).toHaveCount(1)
    await expect(
      page.getByTestId(`workgroup-card-${dw.name}-launch`),
      '动态工作流组只要有 agent 成员就该可启动（它不需要 leader）',
    ).toHaveCount(1)
    await expect(
      page.getByTestId(`workgroup-card-${noLeader.name}-launch`),
      '缺 leader 的 Leader-Worker 组渲染出启动按钮 ⇒ 用户点进向导才吃 workgroup-not-ready',
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`workgroup-card-${quick.name}-launch`),
      '一个成员都没有的组渲染出启动按钮 ⇒ 同上，一次注定失败的点击',
    ).toHaveCount(0)

    // 两种「不能启动」的原因必须给出**不同**的下一步，否则提示等于没说
    await expect(
      page.getByTestId(`workgroup-card-${noLeader.name}`).locator('.gallery-card__action-hint'),
      '缺 leader 的组没告诉用户「去选一个 leader」⇒ 他只知道启动键不见了',
    ).toHaveText('Choose a leader to launch')
    await expect(
      page.getByTestId(`workgroup-card-${quick.name}`).locator('.gallery-card__action-hint'),
      '空名单的组该提示「先加一个 Agent」，而不是和缺 leader 混为一谈',
    ).toHaveText('Add an agent to launch')

    // ---- 卡片是真链接：点标题进详情 -------------------------------------
    await page.getByTestId(`workgroup-card-${lw.name}`).locator('.gallery-card__name').click()
    await expect(
      page.getByRole('heading', { level: 1 }),
      '点卡片进不去详情页 ⇒ 画廊只是一张只读海报，用户没有任何后续操作入口',
    ).toHaveText(lw.name, { timeout: 30_000 })
  } finally {
    await side.context.close()
    // 把公开对照收回私有：它是全平台可见的，留着会成为后续用例的隐形夹具。
    await setVisibility(owner, fc.id, 'private')
  }
})

// ---------------------------------------------------------------------------
// WG-02
// ---------------------------------------------------------------------------

test('WG-02 列表搜索：按卡片可见事实过滤、无匹配给空态、清空搜索复原列表并把焦点还回搜索框', async ({
  browser,
}) => {
  const owner = await seedUser('user', 'wg02')
  const prefix = `rfc319-wg02-${owner.username}`
  const agentId = await seedAgent(owner, `${prefix}-agent`)

  const lw = await seedWorkgroup(owner, {
    name: `${prefix}-alpha`,
    description: 'Handles the audit sweep',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [{ memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' }],
  })
  const fc = await seedWorkgroup(owner, {
    name: `${prefix}-bravo`,
    description: 'Leaderless brainstorming crew',
    mode: 'free_collab',
    members: [{ memberType: 'agent', agentId, displayName: 'Alpha', roleDesc: '' }],
  })
  const dwGroup = await seedWorkgroup(owner, {
    name: `${prefix}-charlie`,
    description: 'Orchestrated on demand',
    mode: 'dynamic_workflow',
    members: [{ memberType: 'agent', agentId, displayName: 'Solo', roleDesc: '' }],
  })

  // 这个账号在界面上应当看到的全集 = 自己的三条 + 别人放公开的（同一个 daemon 上
  // 其他用例可能留下 public 行）。因此期望值一律**从服务端算**，不写死数字——
  // 写死会让这条用例的绿变成「其他用例恰好没留公开组」的副产品。
  const visible = await listWorkgroups(owner.token)
  const freeCollabCount = visible.filter((row) => row.mode === 'free_collab').length
  const leadHeadedCount = visible.filter(
    (row) =>
      row.mode === 'leader_worker' &&
      row.members.some((m) => m.id === row.leaderMemberId && m.displayName === 'Lead'),
  ).length
  for (const seeded of [lw, fc, dwGroup]) {
    expect(
      visible.map((row) => row.id),
      `种下的 ${seeded.name} 不在这个账号的可见列表里 ⇒ 夹具本身就没建成`,
    ).toContain(seeded.id)
  }

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workgroups`)
    const count = page.getByTestId('gallery-count')
    const search = page.getByTestId('gallery-search')
    await expect(
      count,
      '页面上的条数与服务端可见集合对不上 ⇒ 用户看到的是一份残缺（或多出别人）的清单',
    ).toHaveText(`${visible.length} items`, { timeout: 60_000 })

    // (1) 按标题片段过滤。用完整的唯一名字，保证「只剩一条」是这条用例自己的事实。
    await search.fill(fc.name)
    await expect(count, '按名字搜不到唯一那条 ⇒ 名字搜索这条最基本的路径断了').toHaveText('1 item')
    await expect(
      page.getByTestId(`workgroup-card-${fc.name}`),
      '搜到的那条卡片没渲染 ⇒ 计数与实际内容对不上',
    ).toHaveCount(1)
    await expect(
      page.getByTestId(`workgroup-card-${lw.name}`),
      '被过滤掉的卡片仍留在 DOM 里 ⇒ 搜索只是视觉遮挡，键盘 / 读屏用户照样会走到它',
    ).toHaveCount(0)

    // (2) 按**卡片上可见的事实**过滤（模式 chip 的文案）——这是过滤器与
    //     「只搜标题」的分水岭：三个组的名字 / 描述里都没有 "Free collaboration"。
    await search.fill('Free collaboration')
    await expect(
      count,
      '按模式 chip 的文案搜不到对应的组 ⇒ 过滤退化成只搜标题，' +
        '用户没法按「这是个自由协作组」来找',
    ).toHaveText(freeCollabCount === 1 ? '1 item' : `${freeCollabCount} items`)
    await expect(page.getByTestId(`workgroup-card-${fc.name}`)).toHaveCount(1)
    await expect(
      page.getByTestId(`workgroup-card-${lw.name}`),
      '按模式过滤时其他模式的组也留下了 ⇒ 过滤没有真的按这格事实收窄',
    ).toHaveCount(0)
    await expect(page.getByTestId(`workgroup-card-${dwGroup.name}`)).toHaveCount(0)

    // (3) 按 leader chip 过滤——同样只出现在 chip 上，不在标题 / 描述里。
    await search.fill('Leader · Lead')
    await expect(count, 'leader chip 的内容没进过滤面 ⇒ 用户没法按「谁在主持」找组').toHaveText(
      leadHeadedCount === 1 ? '1 item' : `${leadHeadedCount} items`,
    )
    await expect(page.getByTestId(`workgroup-card-${lw.name}`)).toHaveCount(1)
    await expect(
      page.getByTestId(`workgroup-card-${fc.name}`),
      '没有 leader 的自由协作组也被「Leader · Lead」搜了出来 ⇒ 过滤面被污染了',
    ).toHaveCount(0)

    // (4) 无匹配：必须给空态 + 一键清空，而不是一片空白。
    await search.fill('zzz-no-such-workgroup')
    const noMatches = page.getByTestId('gallery-no-matches')
    await expect(
      noMatches,
      '搜不到东西时页面一片空白 ⇒ 用户分不清是「没有匹配」还是「加载失败」',
    ).toBeVisible()
    await expect(noMatches).toContainText('No matches')
    await expect(
      page.getByTestId('gallery-grid'),
      '无匹配时网格还在 ⇒ 空态与残留卡片同时出现，界面自相矛盾',
    ).toHaveCount(0)

    // (5) 清空搜索：列表复原 + 焦点回到搜索框（否则用户要再点一次输入框）。
    const clear = noMatches.getByRole('button', { name: 'Clear search', exact: true })
    await expect(clear, '无匹配空态里没有「清空搜索」⇒ 用户只能手动全选删除输入框').toHaveCount(1)
    await clear.click()
    await expect(count, '清空搜索后列表没复原 ⇒ 一次搜索就把列表弄丢了').toHaveText(
      `${visible.length} items`,
    )
    await expect(search, '清空后输入框里还留着旧关键词 ⇒ 「清空」名不副实').toHaveValue('')
    await expect(search, '清空后焦点没还给搜索框 ⇒ 用户想重新输入还得再点一次').toBeFocused()
    for (const row of [lw, fc, dwGroup]) {
      await expect(
        page.getByTestId(`workgroup-card-${row.name}`),
        `清空搜索后 ${row.name} 没回来 ⇒ 过滤是有副作用的，列表被永久裁剪了`,
      ).toHaveCount(1)
    }
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-03
// ---------------------------------------------------------------------------

test('WG-03 列表空态：主行动按钮随建组权限出现，有数据后空态消失且按钮搬回页头', async ({
  browser,
}) => {
  const owner = await seedUser('user', 'wg03')
  const guest = await seedUser('guest', 'wg03guest')

  // 空态用例的前提必须自己立起来：同一个 daemon 上任何一条 public 组都会出现在
  // 这两个新账号眼里，那时候「看到空态」根本不可能，红出来的却是一句看不懂的
  // 「元素不可见」。这里先把前提说清楚。
  for (const who of [owner, guest]) {
    expect(
      (await listWorkgroups(who.token)).map((row) => row.name),
      `新账号 ${who.username} 一开始就能看到组 ⇒ 空态用例的前提不成立（有别的用例留下了 public 行）`,
    ).toEqual([])
  }

  const ownerSide = await openAs(browser, owner.token)
  const guestSide = await openAs(browser, guest.token)
  try {
    // ---- (1) 有 workgroups:create 的空列表：空态 + 空态里的主行动 --------
    await ownerSide.page.goto(`${daemon.baseUrl}/workgroups`)
    const empty = ownerSide.page.getByTestId('workgroups-empty')
    await expect(
      empty,
      '一条组都没有时不出空态 ⇒ 新用户看到的是一张没有任何解释的白页',
    ).toBeVisible({ timeout: 60_000 })
    await expect(empty).toContainText('No workgroups yet.')
    await expect(
      empty,
      '空态只有标题没有下一步说明 ⇒ 用户不知道工作组是干什么的、该先做什么',
    ).toContainText('Create a collaborative team, then configure its members and operating mode.')
    await expect(
      empty.getByTestId('workgroup-new-button'),
      '空态里没有「新建工作组」⇒ 用户在空白页上找不到唯一的出口',
    ).toHaveCount(1)
    await expect(
      ownerSide.page.locator('.page__header .page__actions'),
      '空态与页头同时挂着主行动 ⇒ 页面出现两个「新建」，Dialog 的焦点归还会指向已卸载的那个',
    ).toHaveCount(0)
    await expect(
      ownerSide.page.getByTestId('gallery-search'),
      '空列表上还渲染搜索框 ⇒ 让用户去搜一个空列表',
    ).toHaveCount(0)

    // ---- (2) 负向对照（权限）：guest 有 workgroups:read、没有 :create ----
    //      同一个空态，主行动必须**一个都不剩**。
    await guestSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      guestSide.page.getByTestId('workgroups-empty'),
      'guest 打不开工作组列表 ⇒ 只读账号连清单都看不到，越权判据把读面也一起收了',
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      guestSide.page.getByTestId('workgroup-new-button'),
      '没有 workgroups:create 的账号看到了「新建工作组」⇒ 点下去只能吃 403',
    ).toHaveCount(0)

    // ---- (3) 负向对照（数据）：有了一条组，空态必须消失、按钮回到页头 ----
    const agentId = await seedAgent(owner, `rfc319-wg03-${owner.username}-agent`)
    const created = await seedWorkgroup(owner, {
      name: `rfc319-wg03-${owner.username}-first`,
      description: 'First group',
      mode: 'leader_worker',
      leaderDisplayName: 'Lead',
      members: [{ memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' }],
    })
    await ownerSide.page.reload()
    await expect(
      ownerSide.page.getByTestId(`workgroup-card-${created.name}`),
      '新建的组没出现在列表里 ⇒ 建完之后用户找不到它',
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      ownerSide.page.getByTestId('workgroups-empty'),
      '有数据了还挂着「还没有工作组」⇒ 界面在自我否定',
    ).toHaveCount(0)
    await expect(
      ownerSide.page.locator('.page__header .page__actions').getByTestId('workgroup-new-button'),
      '有数据后「新建」没回到页头 ⇒ 用户再也建不了第二个组',
    ).toHaveCount(1)

    // guest 依然看不到这条（它是 private）——顺带确认上面的空态不是「列表整个坏了」
    await guestSide.page.reload()
    await expect(
      guestSide.page.getByTestId('workgroups-empty'),
      '别人的私有组出现在了 guest 的列表里 ⇒ 空态是对的，可见性判据坏了',
    ).toBeVisible({ timeout: 60_000 })
  } finally {
    await ownerSide.context.close()
    await guestSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-16
// ---------------------------------------------------------------------------

test('WG-16 重命名：名称+描述一次原子落库，撞上同 owner 重名时整笔回退', async ({ browser }) => {
  const owner = await seedUser('user', 'wg16')
  const prefix = `rfc319-wg16-${owner.username}`
  const agentId = await seedAgent(owner, `${prefix}-agent`)
  const alpha = await seedWorkgroup(owner, {
    name: `${prefix}-alpha`,
    description: 'original description',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [{ memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' }],
  })
  // 同一个 owner 名字域里的第二条 —— 重名冲突的对照物。
  const beta = await seedWorkgroup(owner, {
    name: `${prefix}-beta`,
    description: 'the name that is already taken',
    mode: 'leader_worker',
    members: [],
  })

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workgroups/${alpha.id}`)
    await expect(page.getByTestId('workgroup-draft-phase'), '详情页没加载出来').toHaveText(
      'Saved',
      {
        timeout: 60_000,
      },
    )

    async function openRenameDialog(): Promise<void> {
      await page.getByTestId('workgroup-more-actions').click()
      await page.getByTestId('workgroup-rename-button').click()
      await expect(page.getByTestId('workgroup-rename-dialog')).toBeVisible()
    }

    await openRenameDialog()
    const renameName = page.getByTestId('workgroup-rename-name')
    const renameDescription = page.getByTestId('workgroup-rename-description')
    const renameConfirm = page.getByTestId('workgroup-rename-confirm')

    // (1) 对话框预填当前值，且「什么都没改」时保存键禁用。预填丢了，用户会以为
    //     这是个空白的新建框；禁用判据丢了，一次误点会白白推高版本号，把别人
    //     手上的 expectedVersion 全部作废。
    await expect(
      renameName,
      '重命名对话框没有预填当前名字 ⇒ 用户要自己重新打一遍，打错就是一次意外改名',
    ).toHaveValue(alpha.name)
    await expect(renameDescription).toHaveValue('original description')
    await expect(
      renameConfirm,
      '一个字都没改就能保存 ⇒ 空改动也会推高版本号，让别人正在编辑的会话变成冲突',
    ).toBeDisabled()

    // (2) 非法名字挡在提交前（与新建对话框同一条名字规则）。
    await renameName.fill('_reserved')
    await expect(
      renameConfirm,
      '以 _ 开头的名字仍可保存 ⇒ 前端判据不设防，用户改完才被服务端打回',
    ).toBeDisabled()

    // (3) 正向：名称与描述一起改，一次保存。
    const renamed = `${prefix}-renamed`
    await renameName.fill(renamed)
    await renameDescription.fill('rewritten description')
    await expect(renameConfirm).toBeEnabled()
    await renameConfirm.click()
    await expect(
      page.getByTestId('workgroup-draft-phase'),
      '保存后状态没回到 Saved ⇒ 用户不知道改名到底成没成',
    ).toHaveText('Saved', { timeout: 30_000 })
    await expect(
      page.getByRole('heading', { level: 1 }),
      '页头标题没跟着改名走 ⇒ 用户看到的还是旧名字，会以为没保存成功',
    ).toHaveText(renamed)

    const afterRename = await getWorkgroup(owner.token, alpha.id)
    expect(
      { name: afterRename.name, description: afterRename.description },
      '名称与描述没有一起落库 ⇒ 改名对话框把两个字段拆成了两笔写，中间失败就留半截状态',
    ).toEqual({ name: renamed, description: 'rewritten description' })
    expect(
      afterRename.version,
      '一次改名推高了不止一个版本 ⇒ 名称与描述不是同一笔事务写进去的',
    ).toBe(alpha.version + 1)

    // (4) 重名冲突：改成同 owner 名下已存在的名字，必须整笔回退。
    await openRenameDialog()
    await page.getByTestId('workgroup-rename-name').fill(beta.name)
    await page.getByTestId('workgroup-rename-description').fill('should not be persisted')
    await page.getByTestId('workgroup-rename-confirm').click()

    await expect(
      page.getByTestId('workgroup-draft-phase'),
      '撞重名后界面仍显示已保存 ⇒ 用户以为改好了，服务端其实还是旧名字',
    ).toHaveText('Save failed', { timeout: 30_000 })
    await expect(
      page.getByTestId('workgroup-draft-notices'),
      '保存失败没有任何横幅 ⇒ 只有一个不起眼的 chip 变色，用户不会注意到',
    ).toContainText('Workgroup save failed')

    const afterConflict = await getWorkgroup(owner.token, alpha.id)
    expect(
      {
        name: afterConflict.name,
        description: afterConflict.description,
        version: afterConflict.version,
      },
      '重名被拒后描述却写进去了 / 版本被推高 ⇒ 这一笔不是原子的，留下了半截状态',
    ).toEqual({
      name: renamed,
      description: 'rewritten description',
      version: alpha.version + 1,
    })
    const betaAfter = await getWorkgroup(owner.token, beta.id)
    expect(betaAfter.name, '冲突处理动了**另一条**组的名字 ⇒ 改名把无辜的第三方改坏了').toBe(
      beta.name,
    )
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-17
// ---------------------------------------------------------------------------

test('WG-17 复制：exact-revision 复制出 -copy 私有副本，陈旧版本一律拒绝', async ({ browser }) => {
  const owner = await seedUser('user', 'wg17')
  const bystander = await seedUser('user', 'wg17other')
  const prefix = `rfc319-wg17-${owner.username}`
  const agentId = await seedAgent(owner, `${prefix}-agent`)
  const source = await seedWorkgroup(owner, {
    name: `${prefix}-src`,
    description: 'the original charter',
    instructions: 'Always ship with tests.',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [
      { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: 'Coordinates' },
      { memberType: 'agent', agentId, displayName: 'Builder', roleDesc: 'Implements' },
    ],
  })
  // 源改成 public：副本「必须是私有」这条断言需要一个**会继承出错**的前提，
  // 源本来就是 private 的话该断言恒真。
  await setVisibility(owner, source.id, 'public')
  const sourceRevision = await getWorkgroup(owner.token, source.id)

  // 正向前提：第二个账号确实看得见这个公开的源。少了这一步，下面「他看不见副本」
  // 可能只是「他什么都看不见」。
  const bystanderBefore = await listWorkgroups(bystander.token)
  expect(
    bystanderBefore.map((row) => row.id),
    '公开的源组对别的账号不可见 ⇒ 后面「副本不可见」的对照失去意义',
  ).toContain(source.id)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workgroups/${source.id}`)
    await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', { timeout: 60_000 })

    await page.getByTestId('workgroup-more-actions').click()
    const copyAction = page.getByTestId('workgroup-copy-action')
    await expect(
      copyAction,
      '有 workgroups:create 的账号在动作面板里找不到「复制」⇒ 复制能力在界面上消失了',
    ).toBeVisible()
    await copyAction.click()

    const copyName = `${prefix}-src-copy`
    await expect(
      page.getByRole('heading', { level: 1 }),
      '复制后没跳到副本详情页 ⇒ 用户不知道副本建在哪，只能回列表自己找',
    ).toHaveText(copyName, { timeout: 30_000 })

    const rows = await listWorkgroups(owner.token)
    const copy = rows.find((row) => row.name === copyName)
    expect(
      copy,
      `复制没有按 -copy 阶梯取名（现有：${rows.map((r) => r.name).join(', ')}）⇒ ` +
        '副本要么没建出来，要么撞上了 owner 名字唯一约束',
    ).toBeDefined()
    const copyRow = copy as WorkgroupRow
    expect(page.url(), '地址栏没停在副本上 ⇒ 刷新会回到源，用户会以为复制没生效').toContain(
      `/workgroups/${copyRow.id}`,
    )

    // 副本 = 源的内容 + 复制者的归属 + 私有可见性。
    expect(
      {
        description: copyRow.description,
        mode: copyRow.mode,
        members: copyRow.members.map((m) => `${m.memberType}:${m.displayName}:${m.roleDesc}`),
      },
      '副本没有原样带上源的内容 ⇒ 「复制一份来改」拿到的是个残缺的组',
    ).toEqual({
      description: 'the original charter',
      mode: 'leader_worker',
      members: ['agent:Lead:Coordinates', 'agent:Builder:Implements'],
    })
    const copyLeader = copyRow.members.find((m) => m.id === copyRow.leaderMemberId)
    expect(
      copyLeader?.displayName,
      '副本没继承 leader 指派 ⇒ 复制出来的 Leader-Worker 组直接不可启动',
    ).toBe('Lead')
    expect(copyRow.ownerUserId, '副本不归复制者 ⇒ 他改不动自己刚复制出来的组').toBe(owner.userId)
    expect(
      copyRow.visibility,
      '副本继承了源的 public ⇒ 用户以为「复制一份自己改」，实际改动对全平台可见',
    ).toBe('private')
    expect(copyRow.version, '副本的版本不是从 1 起算 ⇒ 它不是一条全新的资源行').toBe(1)

    // 源必须原封不动。
    const sourceAfter = await getWorkgroup(owner.token, source.id)
    expect(
      { name: sourceAfter.name, version: sourceAfter.version, visibility: sourceAfter.visibility },
      '复制动了源 ⇒ 一次「复制」把原件改了',
    ).toEqual({ name: source.name, version: sourceRevision.version, visibility: 'public' })

    // 负向对照：别人看得见公开的源，但看不见这份私有副本；直接取 id 也是 404。
    const bystanderRows = await listWorkgroups(bystander.token)
    expect(
      bystanderRows.map((row) => row.id),
      '别人的私有副本出现在了第三方的列表里 ⇒ 复制把内容泄露给了全平台',
    ).not.toContain(copyRow.id)
    const probe = await raw(bystander.token, `/api/workgroups/${copyRow.id}`)
    expect(probe.status, '拿着 id 就能直接读到别人的私有副本 ⇒ 列表过滤只是障眼法').toBe(404)

    // 阶梯：再复制一次源，名字必须让到 -copy-2 而不是撞车。
    const second = await json<WorkgroupRow>(
      owner.token,
      `/api/workgroups/${source.id}/copy`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: sourceRevision.version,
          expectedSnapshotHash: sourceRevision.snapshotHash,
        }),
      },
      'second copy',
    )
    expect(
      second.name,
      '第二次复制没有让到 -copy-2 ⇒ 用户第二次点复制就会撞 owner 名字唯一约束',
    ).toBe(`${prefix}-src-copy-2`)

    // 陈旧版本必须被拒，且**不能**留下半个副本。
    const beforeStale = (await listWorkgroups(owner.token)).length
    const stale = await raw(owner.token, `/api/workgroups/${source.id}/copy`, {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion: sourceRevision.version + 1,
        expectedSnapshotHash: sourceRevision.snapshotHash,
      }),
    })
    expect(
      stale.status,
      '按一个不存在的版本也能复制 ⇒ 源在你点复制的瞬间被别人改了，你复制到的是没看过的内容',
    ).toBe(409)
    expect((JSON.parse(stale.body) as { code: string }).code).toBe('resource-operation-stale')
    expect(
      (await listWorkgroups(owner.token)).length,
      '被拒的复制仍然落了一行 ⇒ 拒绝只是嘴上说说',
    ).toBe(beforeStale)

    const staleHash = await raw(owner.token, `/api/workgroups/${source.id}/copy`, {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion: sourceRevision.version,
        expectedSnapshotHash: 'f'.repeat(64),
      }),
    })
    expect(
      staleHash.status,
      '版本号对上就放行、不校验内容指纹 ⇒ 同版本号下的内容改写会被静默复制',
    ).toBe(409)
  } finally {
    await side.context.close()
    // 公开的源同样是全平台可见的夹具，用完收回（同 WG-01 的理由）。
    await setVisibility(owner, source.id, 'private')
  }
})

// ---------------------------------------------------------------------------
// WG-18
// ---------------------------------------------------------------------------

test('WG-18 删除：输入名称确认 + 版本 fence + 非终态任务引用拒删', async ({ browser }) => {
  // 这条用例要真的起一个任务并把它扣在运行中，比其余用例慢得多。
  test.setTimeout(180_000)

  const owner = await seedUser('user', 'wg18')
  const prefix = `rfc319-wg18-${owner.username}`
  const agentId = await seedAgent(owner, `${prefix}-agent`)
  const victim = await seedWorkgroup(owner, {
    name: `${prefix}-victim`,
    description: 'deleted through the UI',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [{ memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' }],
  })
  const busy = await seedWorkgroup(owner, {
    name: `${prefix}-busy`,
    description: 'referenced by a live task',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [{ memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' }],
  })

  // ---- (A) 服务端自己就得挡住「跳过对话框直接打接口」---------------------
  const noConfirm = await raw(owner.token, `/api/workgroups/${victim.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ expectedVersion: victim.version, clientMutationId: newMutationId() }),
  })
  expect(
    noConfirm.status,
    '不带 confirm 也能删 ⇒ 输入名称确认只是前端装饰，任何脚本 / 模型调用都能直接删掉资源',
  ).toBe(422)
  expect((JSON.parse(noConfirm.body) as { code: string }).code).toBe('delete-confirm-required')

  const wrongConfirm = await raw(owner.token, `/api/workgroups/${victim.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: `${victim.name}-typo`,
      expectedVersion: victim.version,
      clientMutationId: newMutationId(),
    }),
  })
  expect(wrongConfirm.status, '名字打错也能删 ⇒ 「输入名称确认」这道闸根本不比较内容').toBe(422)
  expect((JSON.parse(wrongConfirm.body) as { code: string }).code).toBe('delete-confirm-mismatch')

  // ---- (B) 版本 fence：名字对、版本不对，一样不许删 ---------------------
  const staleVersion = await raw(owner.token, `/api/workgroups/${victim.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: victim.name,
      expectedVersion: victim.version + 1,
      clientMutationId: newMutationId(),
    }),
  })
  expect(
    staleVersion.status,
    '按一个陈旧 / 臆造的版本也能删 ⇒ 别人刚改过这个组，你手上的页面还是旧的，一点删除就把新内容抹了',
  ).toBe(409)
  expect((JSON.parse(staleVersion.body) as { code: string }).code).toBe('resource-operation-stale')
  expect(
    (await getWorkgroup(owner.token, victim.id)).id,
    '三次被拒的删除里有一次真的删掉了 ⇒ 拒绝路径与删除路径并不共用同一道闸',
  ).toBe(victim.id)

  // ---- (C) 非终态任务引用：先把一条任务**确定性**地扣在运行中 -----------
  writeFileSync(holdFile, '')
  const task = await json<TaskRow>(
    owner.token,
    `/api/workgroups/${busy.id}/tasks`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-live-task`,
        goal: 'Hold this turn open so the delete refusal is deterministic.',
        scratch: true,
        expectedWorkgroupId: busy.id,
        expectedWorkgroupVersion: busy.version,
      }),
    },
    'launch workgroup task',
  )
  // stub 起来后先落 `<hold>.started` 再进等待循环（mode-slow.ts:64-73）：
  // 看到它就说明这一回合确实在飞，不靠 sleep 猜时序。
  await expect
    .poll(() => existsSync(`${holdFile}.started`), {
      timeout: 120_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true)
  const liveTask = await json<TaskRow>(
    owner.token,
    `/api/tasks/${task.id}`,
    undefined,
    'read live task',
  )
  expect(
    ['pending', 'running'],
    `任务没有停在非终态（实际 ${liveTask.status}）⇒ 下面的「拒删」断言会变成空洞绿`,
  ).toContain(liveTask.status)

  const refused = await raw(owner.token, `/api/workgroups/${busy.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: busy.name,
      expectedVersion: busy.version,
      clientMutationId: newMutationId(),
    }),
  })
  expect(
    refused.status,
    '正在跑任务的组也能删 ⇒ 运行中的任务当场失去它的组定义，用户看到的是一条无法解释的失败',
  ).toBe(409)
  const refusedBody = JSON.parse(refused.body) as {
    code: string
    details?: { referenceCount?: number }
  }
  expect(refusedBody.code).toBe('workgroup-in-use')
  expect(
    refusedBody.details?.referenceCount,
    '拒绝信息里不说还有几条任务在引用 ⇒ 用户不知道要去收拾什么才能删',
  ).toBe(1)
  expect(
    (await getWorkgroup(owner.token, busy.id)).id,
    '被拒的删除还是把组删了 ⇒ 引用检查跑在删除之后',
  ).toBe(busy.id)

  // 任务落到终态后，同一笔删除必须放行——否则「引用拒删」就变成了永久锁死。
  await json(owner.token, `/api/tasks/${task.id}/cancel`, { method: 'POST' }, 'cancel live task')
  rmSync(holdFile, { force: true })
  await expect
    .poll(
      async () => {
        const row = await json<TaskRow>(
          owner.token,
          `/api/tasks/${task.id}`,
          undefined,
          'poll task',
        )
        return row.status
      },
      { timeout: 90_000, intervals: [250, 500, 1000] },
    )
    .toMatch(/^(done|failed|canceled|interrupted)$/)

  const allowed = await raw(owner.token, `/api/workgroups/${busy.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: busy.name,
      expectedVersion: busy.version,
      clientMutationId: newMutationId(),
    }),
  })
  expect(
    allowed.status,
    '任务已经终态了还是删不掉 ⇒ 「引用拒删」变成永久锁死，这个组再也删不了',
  ).toBe(204)

  // ---- (D) 浏览器面：确认框只认逐字相同的名字 ---------------------------
  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workgroups/${victim.id}`)
    await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', { timeout: 60_000 })
    await page.getByTestId('workgroup-more-actions').click()
    await page.getByTestId('workgroup-delete-button').click()

    const confirmDialog = page.locator('.confirm-dialog')
    await expect(confirmDialog, '删除没有二次确认 ⇒ 动作面板上误点一下资源就没了').toBeVisible()
    await expect(confirmDialog).toContainText(`Delete ${victim.name}?`)
    const confirmInput = page.getByTestId('confirm-input')
    const confirmButton = confirmDialog.getByRole('button', { name: 'Delete', exact: true })

    await expect(
      confirmButton,
      '还没输入任何名字，删除键就是可点的 ⇒ 输入名称确认形同虚设',
    ).toBeDisabled()
    await confirmInput.fill(`${victim.name}x`)
    await expect(
      confirmButton,
      '名字只是「差不多」就放行 ⇒ 用户很容易删掉同名前缀的另一个组',
    ).toBeDisabled()

    await confirmInput.fill(victim.name)
    await expect(confirmButton, '逐字输对了还是不给删 ⇒ 这个组永远删不掉').toBeEnabled()
    await confirmButton.click()

    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe('/workgroups')
    await expect(
      page.getByTestId(`workgroup-card-${victim.name}`),
      '删完之后卡片还留在列表里 ⇒ 用户会以为没删掉而再点一次',
    ).toHaveCount(0)
    const gone = await raw(owner.token, `/api/workgroups/${victim.id}`)
    expect(gone.status, '界面上消失了但服务端还在 ⇒ 「删除」只是前端把它藏起来了').toBe(404)
  } finally {
    await side.context.close()
  }
})
