// RFC-319 —— 工作组的权限面：ACL 面板、私有不可见、非 owner 写面拒绝、
// 新增引用的 ACL 围栏，以及意图构建器入口。
//
// 覆盖能力账本 WG-19 / WG-20 / WG-21 / WG-22 / WG-X1 五行。它们锁的都是
// 「谁看得见这个工作组、谁改得动它」，而失效形态各不相同、且**全部静默**：
//
//   * WG-19 —— ACL 面板是这套权限模型**唯一**的用户入口。可见性分段控件或
//     授权名单一旦坏掉（不渲染、保存不落库），用户以为自己把工作组设成了私有 /
//     只授权给某人，实际上什么都没变。所以本文件不满足于「点得动」，每一步都
//     回头读 `GET /acl` 对账服务端事实，并在第二个浏览器里验收可见后果。
//   * WG-20 —— 私有工作组对无关用户必须**完全不可见**：列表里没有、详情与
//     「这个 id 从来不存在」**逐字节同形**。只比状态码挡不住「同样 404、
//     但一个 message 带 id 一个不带」——那一个字节就是存在性探针，拿一串 id
//     扫一遍就能枚举出平台上有哪些工作组、谁在做什么。写面（PUT/DELETE/rename）
//     同样要同形：403 本身就是「这个 id 存在」的信号。
//   * WG-21 —— 内容写与治理动作（改名 / 删除）都留在 owner 手里：被授权人
//     看得见、但改不动。这条一旦破，任何一个被加进授权名单的人就能把别人的
//     工作组改名、删掉或者改写成员，而 owner 只会看到资源凭空变了样。
//     「403 了」还不够：必须同时证明**同一个端点对 owner 是通的**，否则一条
//     「端点整个坏了」的回归也能让这些断言全绿。
//   * WG-22 —— 新增成员引用一个自己看不见的私有代理，必须 422 拒绝：否则用户
//     可以把别人的私有代理拉进自己的工作组，启动时按隐式闭包授权真的把它跑起来
//     ——一次完整的越权使用，形式上却是「工作组保存成功」。同时**存量引用必须
//     豁免**：否则一个接手了他人工作组的 owner 连「改一行说明」都做不到，
//     工作组直接变成死档。拒绝信息还必须只回显调用方**输入的 id**，回显解析出的
//     `row.name` 等于把私有代理的名字泄露出去。
//   * WG-X1 —— 意图构建器入口没有 `intent:write` 却渲染，用户点进去只能吃 403；
//     渲染了却导航参数不对（丢 mountId / 丢 hint），用户进到一个空会话，
//     「修改这个工作组」变成「从零新建」。「不渲染」的断言天然容易恒真，
//     因此每一条都配一个**同页、同资源**的正向对照。
//
// ---------------------------------------------------------------------------
// 基线：本文件按 **origin/main** 编写并验证
// ---------------------------------------------------------------------------
// 本仓工作树里同时躺着并发 session 的 RFC-324（分档资源授权）在制品——它把
// 「授权」从一个平面的用户名单改成 read / write 两档，并把前端写面从「有权限点
// 就能编辑」收紧成「权限点 ∧ 行级授权档」。**本文件刻意不依赖它**：断言全部
// 按 `origin/main` 的现状写，用干净 main 构建出来的二进制跑绿。
//
// RFC-324 落地后需要回来补 / 改的，逐条如下：
//   1. WG-19b 现在只断「加进名单 / 移出名单」这一层——main 的 UserPicker 是一份
//      平面名单，`acl-level-read-<userId>` / `acl-level-write-<userId>` 尚不存在。
//      届时应补：新加进名单的人**必须**落 `read`（安全默认，且与 main 的
//      「授权 = 可见可用」逐字同义），把某人提到 `write` 后 `GET /acl` 的 `grants`
//      里该行变 `write`。
//   2. 两条只读面板断言（WG-19a §(4)、WG-19b §(3)）届时还应能读到**自己的授权
//      深度**（"Read-only" / "Can edit"）；main 的只读分支只渲染一个 displayName
//      chip，没有档位可断。
//   3. WG-19b §(3)「被授权人打开只读面板」在 RFC-324 下会**打不开**：
//      `workgroup-acl-button` 届时挂 `canUpdate = 权限点 ∧ resourceAccess.canEdit`，
//      `read` 档拿不到。届时该段要换成 `write` 档账号（canEdit 真、canManage 假），
//      才是「能编辑内容但管不了权限」的那个形态。
//   4. WG-21 现在断的是「非 owner（公开可见）三条写路径 + 权限面全 403」，
//      拒绝码是 main 的 `forbidden`。RFC-324 把这一个门拆成两个：内容写走
//      `resource-read-only`、治理写走 `resource-govern-owner-only`，两处字面量
//      都要改；并且要补 `write` 档的分野——write 档 PUT 内容 200（正向对照）、
//      PUT body 里夹带改名 → 403 `resource-rename-owner-only`、write 档
//      DELETE / rename 仍 403。
//   5. WG-21 的**界面半段**在 main 上没有对应行为可断，已整条删除：main 的
//      `workgroups.detail.tsx:182-184` 只看权限点（`usePermission('workgroups:update')`），
//      任何登录用户都会渲染出「添加成员 / 改名 / 删除 / 权限」四个入口，保存时才吃
//      403（`docs/audit-backlog.md:108` 记的就是这个）。RFC-324 把它改成
//      `usePermission(...) && resourceAccess.canEdit` 之后应补：只读授权者身上
//      `workgroup-add-agent-member` / `workgroup-rename-button` /
//      `workgroup-delete-button` / `workgroup-acl-button` 四条 count(0)，
//      并以同弹窗内的 `export-package-workgroup` 可见作为正向锚点。
//   6. `GET /acl` 的响应形状会从 `users: UserPublic[]` 变成
//      `grants: {user, level}[]` 并新增 `canEdit`；`PUT /acl` 的授权载荷从
//      `userIds: string[]` 变成 `grants: {userId, level}[]`。本文件的读面已经用
//      `granteeIdsOf()` 抹平了两版，写面只用 visibility / ownerUserId（两版一致），
//      唯一走授权写入的地方是 WG-19b 的**界面**操作——由被测前端自己决定发哪种
//      载荷，因此不需要改。
//
// ---------------------------------------------------------------------------
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link
// check 逐条请求，见 CLAUDE.md §opencode 源码自取规则；行号按 origin/main）：
//   packages/backend/src/routes/workgroups.ts:56-61         loadVisibleWorkgroup：缺失与不可见同一个 404
//   packages/backend/src/routes/workgroups.ts:194-195       PUT：先 404 再 requireResourceOwner
//   packages/backend/src/routes/workgroups.ts:214-223       DELETE：owner 门排在 confirm 校验之前
//   packages/backend/src/routes/workgroups.ts:249-250       rename：requireResourceOwner
//   packages/backend/src/routes/resourceAcl.ts:146-148      GET /acl：不可见 → 同形 404
//   packages/backend/src/routes/resourceAcl.ts:163          PUT /acl：tokenAccess:'never'（只有会话 token 能过）
//   packages/backend/src/services/resourceAcl.ts:475-481    isResourceOwner：授权 ≠ 所有者
//   packages/backend/src/services/resourceAcl.ts:487-497    requireResourceOwner → 先 404 后 403 'forbidden'
//   packages/backend/src/services/workgroups.ts:393-394     保存事务内只围栏 diffNewAgentMemberIds（新增引用）
//   packages/backend/src/services/workgroups.ts:702-719     diffNewAgentMemberIds：存量 agentId 全部豁免
//   packages/backend/src/services/workgroups.ts:963-970     prepareAgentMembers 的 grandfatheredIds
//   packages/backend/src/services/resourceRefs.ts:341-349   missingRefsError → 422 acl-missing-refs，只回显输入 token
//   packages/shared/src/schemas/resourceAcl.ts:163-183      PUT /acl body：ownerUserId / visibility / userIds + OCC 围栏
//   packages/frontend/src/components/AclPanel.tsx:363-385   可见性分段控件仅在 canManage 时渲染
//   packages/frontend/src/components/AclPanel.tsx:387-410   授权名单：canManage 才是 UserPicker，否则只读 chip
//   packages/frontend/src/components/AclPanel.tsx:421-441   acl-save / acl-transfer-owner 仅在 canManage 时渲染
//   packages/frontend/src/routes/workgroups.detail.tsx:182-186 canUpdate / canDelete / canWriteIntent
//   packages/frontend/src/routes/workgroups.detail.tsx:930-946 workgroup-intent-entry（手写 canWriteIntent &&）
//   packages/frontend/src/routes/workgroups.detail.tsx:977-984 workgroup-acl-button
//   packages/frontend/src/routes/workgroups.tsx:192-199      workgroups-intent-entry
//   packages/frontend/src/components/IntentEntryButton.tsx:32 无 intent:write → return null
//   packages/frontend/src/components/gallery/ResourceGalleryPage.tsx:89 列表真空会吞掉 headerActions
//   packages/frontend/src/components/ErrorBanner.tsx:82      拒绝文案落在 .error-box
//   packages/shared/src/schemas/permission.ts:915-923        GUEST_BASELINE：只有六类 :read，不含 intent:*
//
// 执行模型：本文件所有用例共用一个 daemon（默认 stub）。playwright.config.ts 把
// fullyParallel 留在默认 false，因此文件内用例按声明顺序串行。每个用例自带独立的
// 用户 / 代理 / 工作组夹具，互不共享可变状态。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

let daemon: DaemonHandle

/**
 * 26 位、字母表合法、但从未被铸造过的 id——404 同形比较的「对照组」。
 * 路由对 :id 没有格式校验（routes/workgroups.ts:89 直接进 loadVisibleWorkgroup），
 * 所以它走的是和真 id 完全相同的代码路径。
 */
const ABSENT_WORKGROUP_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const ABSENT_AGENT_ID = '01JYYYYYYYYYYYYYYYYYYYYYYY'

const PASSWORD = 'longEnoughPassword'

interface SeededUser {
  username: string
  userId: string
  sessionToken: string
}

interface RawResponse {
  status: number
  body: string
}

interface UserPublicLite {
  id: string
  username: string
  displayName: string
}

/**
 * GET /api/{res}/:id/acl 的响应（shared/schemas/resourceAcl.ts:141-159）。
 *
 * `users` 与 `grants` 二选一：main 下发平面名单 `users`，RFC-324 下发带档位的
 * `grants`。两个字段都标成可选、统一用 `granteeIdsOf()` 读——**夹具**因此不绑定
 * 任何一版；下面的**断言**仍然全部按 main 写（见文件头「基线」）。
 */
interface AclLite {
  resourceId: string
  ownerUserId: string | null
  owner: UserPublicLite | null
  visibility: 'public' | 'private'
  users?: UserPublicLite[]
  grants?: Array<{ user: UserPublicLite; level: 'read' | 'write' }>
  canManage: boolean
  aclRevision: number
}

interface WorkgroupMemberLite {
  id: string
  memberType: 'agent' | 'human'
  agentId?: string | null
  userId: string | null
  displayName: string
  roleDesc: string
}

interface WorkgroupDetailLite {
  id: string
  name: string
  description: string
  instructions: string
  mode: 'leader_worker' | 'free_collab' | 'dynamic_workflow'
  outputContract: 'files' | 'discussion'
  leaderMemberId: string | null
  switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  maxRounds: number
  completionGate: boolean
  clarifyBudget?: number
  fanOut?: boolean
  members: WorkgroupMemberLite[]
  version: number
}

interface DraftMemberLite {
  memberType: 'agent' | 'human'
  agentId?: string
  userId?: string
  displayName: string
  roleDesc: string
}

interface DraftSnapshotLite {
  name: string
  description: string
  instructions: string
  mode: WorkgroupDetailLite['mode']
  outputContract: WorkgroupDetailLite['outputContract']
  leaderDisplayName?: string
  switches: WorkgroupDetailLite['switches']
  maxRounds: number
  completionGate: boolean
  clarifyBudget: number
  fanOut: boolean
  members: DraftMemberLite[]
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
 *  ACL 的 PUT 是 tokenAccess:'never'（routes/resourceAcl.ts:163），只有会话
 *  token 能过，所以这里一律用登录换来的 sessionToken，不用 PAT。 */
async function createUserAndLogin(opts: {
  username: string
  role: 'admin' | 'user' | 'manager' | 'guest'
}): Promise<SeededUser> {
  const created = await rawRequest(daemon.token, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: PASSWORD,
    }),
  })
  expect(created.status, `createUser ${opts.username}: ${created.body}`).toBe(201)
  const { id } = JSON.parse(created.body) as { id: string }

  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: PASSWORD }),
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

type AclKind = 'workgroups' | 'agents'

async function readAcl(token: string, kind: AclKind, id: string): Promise<AclLite> {
  return jsonOf<AclLite>(token, `/api/${kind}/${id}/acl`)
}

/** 授权名单的当前持有者 id，抹平 main 的 `users` 与 RFC-324 的 `grants`。 */
function granteeIdsOf(acl: AclLite): string[] {
  if (acl.users !== undefined) return acl.users.map((u) => u.id)
  return (acl.grants ?? []).map((g) => g.user.id)
}

/** ACL 的 PUT 是全量替换 + 强制 OCC 围栏（shared/schemas/resourceAcl.ts:163-183）。 */
async function putAcl(
  token: string,
  kind: AclKind,
  id: string,
  patch: { visibility?: 'public' | 'private'; ownerUserId?: string },
): Promise<AclLite> {
  const current = await readAcl(token, kind, id)
  return jsonOf<AclLite>(token, `/api/${kind}/${id}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      ...patch,
      expectedResourceId: id,
      expectedAclRevision: current.aclRevision,
    }),
  })
}

async function createAgent(token: string, name: string): Promise<string> {
  const created = await jsonOf<{ id: string }>(token, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'rfc319 workgroup-acl fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'fixture body',
    }),
  })
  return created.id
}

/** RFC-231 起所有 canonical 创建路径都是 creator-owner + private。 */
async function createWorkgroup(
  token: string,
  name: string,
  members: DraftMemberLite[],
): Promise<WorkgroupDetailLite> {
  return jsonOf<WorkgroupDetailLite>(token, '/api/workgroups', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: members[0]?.displayName ?? 'Lead',
      maxRounds: 2,
      completionGate: false,
      members,
    }),
  })
}

/** WorkgroupMutationIdSchema：26 位 Crockford base32，首位 0-7。 */
let mutationSeq = 0
function nextMutationId(): string {
  mutationSeq += 1
  return `01K${String(mutationSeq).padStart(23, '0')}`
}

/** 把服务端详情还原成一份「原样不动」的可编辑快照（PUT 是全量替换）。 */
function snapshotOf(detail: WorkgroupDetailLite): DraftSnapshotLite {
  const leader = detail.members.find((m) => m.id === detail.leaderMemberId)
  return {
    name: detail.name,
    description: detail.description,
    instructions: detail.instructions,
    mode: detail.mode,
    outputContract: detail.outputContract,
    ...(leader === undefined ? {} : { leaderDisplayName: leader.displayName }),
    switches: detail.switches,
    maxRounds: detail.maxRounds,
    completionGate: detail.completionGate,
    clarifyBudget: detail.clarifyBudget ?? 3,
    fanOut: detail.fanOut ?? false,
    members: detail.members.map((m) =>
      m.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: m.agentId ?? '',
            displayName: m.displayName,
            roleDesc: m.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: m.userId ?? '',
            displayName: m.displayName,
            roleDesc: m.roleDesc,
          },
    ),
  }
}

function putWorkgroup(
  token: string,
  id: string,
  expectedVersion: number,
  snapshot: DraftSnapshotLite,
): Promise<RawResponse> {
  return rawRequest(token, `/api/workgroups/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      expectedVersion,
      clientMutationId: nextMutationId(),
      snapshot,
    }),
  })
}

/** 详情页的拒绝呈现：ErrorBanner 落在 .error-box（components/ErrorBanner.tsx:82）。 */
async function denialTextAt(page: Page, workgroupId: string): Promise<string> {
  await page.goto(`${daemon.baseUrl}/workgroups/${workgroupId}`)
  const banner = page.locator('.error-box').first()
  await expect(banner).toBeVisible()
  return (await banner.innerText()).trim()
}

async function openWorkgroupAcl(page: Page): Promise<void> {
  await page.getByTestId('workgroup-more-actions').click()
  await expect(page.getByTestId('workgroup-actions-dialog')).toBeVisible()
  await page.getByTestId('workgroup-acl-button').click()
  await expect(page.getByTestId('workgroup-acl-dialog')).toBeVisible()
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// WG-19
// ---------------------------------------------------------------------------

test('WG-19a ACL 面板的可见性开关：public→private→public 双向生效，非 owner 的面板全程只读', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({ username: 'rfc319-wg19a-alice', role: 'user' })
  const carol = await createUserAndLogin({ username: 'rfc319-wg19a-carol', role: 'user' })

  const agentId = await createAgent(alice.sessionToken, 'rfc319-wg19a-agent')
  const wgName = 'rfc319-wg19a-group'
  const group = await createWorkgroup(alice.sessionToken, wgName, [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
    { memberType: 'agent', agentId, displayName: 'Worker', roleDesc: '' },
  ])
  // 从 public 起步，才谈得上「证明 public → private 这一次切换真的生效」。
  await putAcl(alice.sessionToken, 'workgroups', group.id, { visibility: 'public' })

  const aliceSide = await openAs(browser, alice.sessionToken)
  const carolSide = await openAs(browser, carol.sessionToken)
  try {
    // (0) 正向前提：公开时 carol 的列表里确实有这张卡。没有这一步，(2) 的
    //     「卡片消失了」可能只是列表整个坏了。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      carolSide.page.getByTestId(`workgroup-card-${wgName}`),
      '公开工作组在无关用户的列表里都看不到 ⇒ 后面「私有后消失」证明不了任何事',
    ).toBeVisible({ timeout: 30_000 })

    // (1) owner 打开面板：owner 行是自己，可见性分段控件停在 public。
    await aliceSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(aliceSide.page)
    await expect(
      aliceSide.page.getByTestId('acl-panel'),
      'ACL 面板不显示 owner ⇒ 用户无法判断这份权限是谁在管，转让 / 求授权都无从下手',
    ).toContainText(alice.username)
    await expect(
      aliceSide.page.getByTestId('acl-visibility-public'),
      '分段控件没有反映服务端当前的可见性 ⇒ 用户照着一个错的现状做决定，' +
        '「点一下私有」可能反而把私有资源改成了公开',
    ).toHaveAttribute('aria-checked', 'true')

    // (2) 切私有 → 保存。成功保存会关闭弹窗（AclPanel onSaved）。
    await aliceSide.page.getByTestId('acl-visibility-private').click()
    await aliceSide.page.getByTestId('acl-save').click()
    await expect(
      aliceSide.page.getByTestId('acl-panel'),
      '保存成功后弹窗不关 ⇒ 用户分不清是保存了还是卡住了，多半会再点一次',
    ).toHaveCount(0)

    const afterPrivate = await readAcl(alice.sessionToken, 'workgroups', group.id)
    expect(
      afterPrivate.visibility,
      '面板收下了「私有」但服务端还是 public ⇒ 用户以为已经收口，实际全平台可见',
    ).toBe('private')
    expect(granteeIdsOf(afterPrivate), '切私有不该顺手给任何人发授权').toEqual([])

    // 可见后果：carol 的列表里这张卡没了。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      carolSide.page.getByTestId(`workgroup-card-${wgName}`),
      '私有化后无关用户的列表里还留着这张卡 ⇒ 可见性开关是个摆设',
    ).toHaveCount(0)

    // (3) 再切回 public —— 必须走**同一个面板**，且服务端与列表都跟着回来。
    //     少了这个反方向，「一旦私有就再也改不回来」也能通过前两步；而那正是
    //     用户会当成数据丢失的形态（工作组在同事那里永远消失了）。
    await aliceSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(aliceSide.page)
    await expect(
      aliceSide.page.getByTestId('acl-visibility-private'),
      '重新打开面板时分段控件没停在刚存下的私有 ⇒ 面板显示的是过期状态',
    ).toHaveAttribute('aria-checked', 'true')
    await aliceSide.page.getByTestId('acl-visibility-public').click()
    await aliceSide.page.getByTestId('acl-save').click()
    await expect(aliceSide.page.getByTestId('acl-panel')).toHaveCount(0)
    expect(
      (await readAcl(alice.sessionToken, 'workgroups', group.id)).visibility,
      '私有改不回公开 ⇒ 可见性变成了单向阀门，同事那边等于永久失去这个工作组',
    ).toBe('public')

    await carolSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      carolSide.page.getByTestId(`workgroup-card-${wgName}`),
      '改回公开后无关用户仍然看不到 ⇒ 服务端改了、读面没跟上',
    ).toBeVisible({ timeout: 30_000 })

    // (4) 非 owner 的面板必须是只读的：能读到 owner 与当前可见性，但一个可写
    //     控件都不渲染。看得见 ≠ 管得了——权限本身只有 owner 能改。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(carolSide.page)
    const carolPanel = carolSide.page.getByTestId('acl-panel')
    await expect(carolPanel).toBeVisible()
    await expect(carolPanel, '非 owner 看不到 owner 是谁 ⇒ 想要授权都不知道该找谁').toContainText(
      alice.username,
    )
    await expect(
      carolPanel,
      '只读面板必须仍然把当前可见性显示出来（纯文本），否则用户连现状都看不到',
    ).toContainText('Everyone')
    await expect(
      carolSide.page.getByTestId('acl-save'),
      '非 owner 的面板渲染了保存按钮 ⇒ 任何看得见这个工作组的人都能改写它的权限名单',
    ).toHaveCount(0)
    await expect(
      carolSide.page.getByTestId('acl-transfer-owner'),
      '非 owner 的面板渲染了转让所有者 ⇒ 看得见的人能把资源的所有权转走',
    ).toHaveCount(0)
    await expect(
      carolSide.page.getByTestId('acl-visibility-private'),
      '非 owner 的面板渲染了可见性分段控件 ⇒ 别人能把你的工作组改成私有把你自己关在外面',
    ).toHaveCount(0)
    await expect(carolSide.page.getByTestId('acl-visibility-public')).toHaveCount(0)
  } finally {
    await aliceSide.context.close()
    await carolSide.context.close()
  }
})

test('WG-19b ACL 面板的逐用户授权：私有工作组加一个人，服务端名单与对方的可见性同时变', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({ username: 'rfc319-wg19b-alice', role: 'user' })
  const carol = await createUserAndLogin({ username: 'rfc319-wg19b-carol', role: 'user' })

  const agentId = await createAgent(alice.sessionToken, 'rfc319-wg19b-agent')
  const wgName = 'rfc319-wg19b-group'
  // RFC-231：canonical 创建路径默认就是 private，正是本条要覆盖的起点。
  const group = await createWorkgroup(alice.sessionToken, wgName, [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
  ])

  const aliceSide = await openAs(browser, alice.sessionToken)
  const carolSide = await openAs(browser, carol.sessionToken)
  try {
    // (0) 授权前：carol 看不见（这是「授权之后看得见」的对照基线）。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      carolSide.page.getByRole('heading', { name: 'Workgroups', exact: true }),
      '列表页没渲染出来，下面那条 count(0) 是恒真断言',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      carolSide.page.getByTestId(`workgroup-card-${wgName}`),
      '还没授权，无关用户就已经看得见私有工作组了 ⇒ 这条用例的起点不成立',
    ).toHaveCount(0)

    // (1) owner 通过 UserPicker 把 carol 加进授权名单并保存。
    await aliceSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(aliceSide.page)
    await aliceSide.page.getByTestId('acl-members-input').click()
    await aliceSide.page.getByTestId('acl-members-input').fill(carol.username)
    await aliceSide.page.getByTestId(`acl-members-option-${carol.username}`).click()
    await aliceSide.page.getByTestId('acl-save').click()
    await expect(aliceSide.page.getByTestId('acl-panel')).toHaveCount(0)

    // (2) 服务端事实：名单里恰好多了这一个人，可见性**没被顺手改掉**。
    const afterGrant = await readAcl(alice.sessionToken, 'workgroups', group.id)
    expect(
      granteeIdsOf(afterGrant),
      '面板收下了授权但服务端名单没变 ⇒ 被授权人还是看不见，owner 只能被迫改成公开' +
        '（把一个本该只给一个人看的工作组暴露给全平台）',
    ).toEqual([carol.userId])
    expect(
      afterGrant.visibility,
      '加人的同时把可见性也顺手改了 ⇒ 一次「只给某人看」变成了对全平台公开',
    ).toBe('private')

    // (3) 可见后果：carol 现在看得见了，而且她的面板里能读到自己在名单上。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      carolSide.page.getByTestId(`workgroup-card-${wgName}`),
      '授权后被授权人仍然看不到 ⇒ 授权名单形同虚设',
    ).toBeVisible({ timeout: 30_000 })

    await carolSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(carolSide.page)
    const carolPanel = carolSide.page.getByTestId('acl-panel')
    await expect(
      carolPanel,
      '只读面板不显示授权名单 ⇒ 被授权人不知道还有谁能看到这个工作组',
    ).toContainText(carol.username)
    await expect(
      carolPanel,
      '只读面板必须显示当前可见性，否则被授权人以为这是个公开资源，' +
        '会把里面的内容当公开信息转述出去',
    ).toContainText('Private')
    await expect(
      carolSide.page.getByTestId('acl-save'),
      '被授权人的面板渲染了保存按钮 ⇒ 被加进名单的人可以反过来改写名单',
    ).toHaveCount(0)

    // (4) 取消授权：名单清空，carol 的列表里这张卡也跟着消失。少了这一步，
    //     一个「只进不出」的名单也能通过前面全部断言——而那意味着授权一旦发出
    //     就永远收不回来。
    await aliceSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(aliceSide.page)
    await aliceSide.page.getByTestId(`acl-members-remove-${carol.username}`).click()
    await aliceSide.page.getByTestId('acl-save').click()
    await expect(aliceSide.page.getByTestId('acl-panel')).toHaveCount(0)
    expect(
      granteeIdsOf(await readAcl(alice.sessionToken, 'workgroups', group.id)),
      '授权收不回来 ⇒ 误授权无法补救，只能删掉整个工作组重建',
    ).toEqual([])

    await carolSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      carolSide.page.getByTestId(`workgroup-card-${wgName}`),
      '取消授权后对方仍然看得见 ⇒ 撤销只是界面上的，服务端读面没跟上',
    ).toHaveCount(0)
  } finally {
    await aliceSide.context.close()
    await carolSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-20
// ---------------------------------------------------------------------------

test('WG-20 私有工作组对无关用户完全不可见：列表过滤 + 详情/ACL/写面与「不存在」逐字节同形', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({ username: 'rfc319-wg20-alice', role: 'user' })
  const carol = await createUserAndLogin({ username: 'rfc319-wg20-carol', role: 'user' })

  const agentId = await createAgent(alice.sessionToken, 'rfc319-wg20-agent')
  // 名字挑一个绝不会碰巧出现在别处的串，这样「carol 的 DOM 里不含它」是个真断言。
  const secretName = 'rfc319-wg20-secret-migration-warroom'
  const openName = 'rfc319-wg20-open-group'
  const secret = await createWorkgroup(alice.sessionToken, secretName, [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
  ])
  const open = await createWorkgroup(alice.sessionToken, openName, [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
  ])
  await putAcl(alice.sessionToken, 'workgroups', open.id, { visibility: 'public' })

  // 正向前提：这个 id 是**真的**、而且默认就是 private。少了这一步，下面两条
  // 404 可能只是「两个都不存在」，同形也就毫无意义。
  const asOwner = await rawRequest(alice.sessionToken, `/api/workgroups/${secret.id}`)
  expect(asOwner.status, 'owner 读不到自己的工作组，后面的同形比较没有意义').toBe(200)
  expect((await readAcl(alice.sessionToken, 'workgroups', secret.id)).visibility).toBe('private')

  // ---- 列表面 -------------------------------------------------------------
  const carolList = await jsonOf<Array<{ id: string }>>(carol.sessionToken, '/api/workgroups')
  const carolIds = carolList.map((row) => row.id)
  expect(
    carolIds,
    '公开工作组不在无关用户的列表里 ⇒ 下面那条 not.toContain 只能证明列表整个坏了',
  ).toContain(open.id)
  expect(
    carolIds,
    '私有工作组出现在无关用户的列表里 ⇒ 名字、成员构成、更新时间一并泄露',
  ).not.toContain(secret.id)

  // ---- 读面 + 写面：都必须与「不存在」同形 -------------------------------
  const pairs: Array<{ label: string; path: (id: string) => string; init?: RequestInit }> = [
    { label: '详情 GET', path: (id) => `/api/workgroups/${id}` },
    { label: 'ACL GET', path: (id) => `/api/workgroups/${id}/acl` },
    {
      label: 'PUT（内容写）',
      path: (id) => `/api/workgroups/${id}`,
      init: {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: 1,
          clientMutationId: nextMutationId(),
          snapshot: snapshotOf(secret),
        }),
      },
    },
    {
      label: 'DELETE',
      path: (id) => `/api/workgroups/${id}`,
      init: {
        method: 'DELETE',
        body: JSON.stringify({
          expectedVersion: 1,
          clientMutationId: nextMutationId(),
          confirm: secretName,
        }),
      },
    },
    {
      label: 'rename',
      path: (id) => `/api/workgroups/${id}/rename`,
      init: {
        method: 'POST',
        body: JSON.stringify({
          newName: 'rfc319-wg20-renamed',
          expectedVersion: 1,
          clientMutationId: nextMutationId(),
        }),
      },
    },
  ]
  for (const probe of pairs) {
    const hidden = await rawRequest(carol.sessionToken, probe.path(secret.id), probe.init)
    const absent = await rawRequest(carol.sessionToken, probe.path(ABSENT_WORKGROUP_ID), probe.init)
    expect(hidden.status, `${probe.label}：不可见资源必须 404，403 本身就是「它存在」`).toBe(404)
    expect(absent.status, `${probe.label}：不存在的 id 必须 404`).toBe(404)
    expect(
      maskIds(hidden.body, secret.id),
      `${probe.label}：「存在但你没份」与「根本不存在」的响应体一旦有一个字节不同，` +
        '拿一串 id 扫一遍就能枚举出平台上有哪些工作组',
    ).toBe(maskIds(absent.body, ABSENT_WORKGROUP_ID))
    // body 里本来就不含 id，顺手把字面量也钉住：任何一次「顺手把 id / 名字写进
    // 报错信息」的改动都会在这里变红。
    expect(hidden.body, `${probe.label}：拒绝信息里出现了 id 或名字 ⇒ 拒绝本身成了信息泄露`).toBe(
      '{"ok":false,"code":"workgroup-not-found","message":"workgroup not found"}',
    )
  }

  // ---- 浏览器面 ----------------------------------------------------------
  const carolSide = await openAs(browser, carol.sessionToken)
  try {
    const { page } = carolSide
    await page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      page.getByTestId(`workgroup-card-${openName}`),
      '公开卡片都不渲染 ⇒ 下面那条 count(0) 是恒真断言',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId(`workgroup-card-${secretName}`),
      '私有工作组的卡片出现在无关用户的画廊里 ⇒ 列表过滤失效',
    ).toHaveCount(0)
    await expect(
      page.getByText(secretName, { exact: false }),
      '私有工作组的名字出现在无关用户的页面上（哪怕只在搜索计数 / 隐藏节点里）',
    ).toHaveCount(0)

    const hiddenPage = await denialTextAt(page, secret.id)
    await expect(
      page.getByText(secretName, { exact: false }),
      '404 页面把它要隐藏的名字直接印出来了',
    ).toHaveCount(0)
    const absentPage = await denialTextAt(page, ABSENT_WORKGROUP_ID)
    expect(
      maskIds(hiddenPage, secret.id),
      '两次拒绝的页面文案必须逐字相同；不同就等于把「这个 id 存在」写在了界面上',
    ).toBe(maskIds(absentPage, ABSENT_WORKGROUP_ID))
  } finally {
    await carolSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-21
// ---------------------------------------------------------------------------

test('WG-21 非 owner 看得见但改不动：PUT / DELETE / rename / 改权限全 403，同样几条对 owner 是通的', async () => {
  const alice = await createUserAndLogin({ username: 'rfc319-wg21-alice', role: 'user' })
  const carol = await createUserAndLogin({ username: 'rfc319-wg21-carol', role: 'user' })

  const agentId = await createAgent(alice.sessionToken, 'rfc319-wg21-agent')
  const wgName = 'rfc319-wg21-group'
  const group = await createWorkgroup(alice.sessionToken, wgName, [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
  ])
  // 让 carol **看得见**——公开可见性即可，拒绝因此必须是 403 而不是 404
  //（404 是给完全看不见的人的，那一半在 WG-20）。
  //
  // 刻意**不**走「把 carol 加进授权名单」这条路：本用例要隔离的是
  // `requireResourceOwner`（routes/workgroups.ts:194/214/249 三处同一个门），
  // 「carol 凭什么看得见」是无关变量。公开可见与被授权在这个门前面完全等价
  //（isResourceOwner 只比 ownerUserId），少一个依赖就少一个能把本用例带红的
  // 无关故障源。RFC-324 落地后「被授权人」会分出 read/write 两档、档位才是决定
  // 写面的东西，那时需要按档位补一版（见文件头第 3 条）。
  await putAcl(alice.sessionToken, 'workgroups', group.id, { visibility: 'public' })

  const seen = await jsonOf<WorkgroupDetailLite>(carol.sessionToken, `/api/workgroups/${group.id}`)
  expect(seen.id, '非 owner 读不到这个工作组 ⇒ 下面的 403 只能说明她看不见，不是写面被拦住').toBe(
    group.id,
  )

  const renameBody = (newName: string, version: number): string =>
    JSON.stringify({ newName, expectedVersion: version, clientMutationId: nextMutationId() })
  /** DeleteWorkgroupSchema 也是版本围栏 + type-to-confirm；owner 门排在这两项校验
   *  之前（routes/workgroups.ts:214-223），但仍然发一份**完全合法**的 body，
   *  这样 403 只可能来自权限，不会被一条 422 参数错误顶掉。 */
  const deleteBody = (name: string, version: number): string =>
    JSON.stringify({ expectedVersion: version, clientMutationId: nextMutationId(), confirm: name })

  // ---- 非 owner：三条写路径 + 权限面全部 403 -----------------------------
  const granteePut = await putWorkgroup(carol.sessionToken, group.id, seen.version, {
    ...snapshotOf(seen),
    maxRounds: seen.maxRounds + 1,
  })
  expect(
    granteePut.status,
    '非 owner 改动了工作组内容 ⇒「看得见」被悄悄扩成了「可编辑」，' +
      'owner 会看到自己的工作组被别人改了成员 / 轮次而毫无提示',
  ).toBe(403)
  expect(
    (JSON.parse(granteePut.body) as { code: string }).code,
    '拒绝码变了 ⇒ 前端翻不出「只有所有者能修改」，只能显示一条通用错误',
  ).toBe('forbidden')

  const granteeDelete = await rawRequest(carol.sessionToken, `/api/workgroups/${group.id}`, {
    method: 'DELETE',
    body: deleteBody(wgName, seen.version),
  })
  expect(granteeDelete.status, '非 owner 删掉了别人的工作组 —— 不可逆的越权').toBe(403)
  expect((JSON.parse(granteeDelete.body) as { code: string }).code).toBe('forbidden')

  const granteeRename = await rawRequest(carol.sessionToken, `/api/workgroups/${group.id}/rename`, {
    method: 'POST',
    body: renameBody('rfc319-wg21-hijacked', seen.version),
  })
  expect(granteeRename.status, '非 owner 改掉了别人工作组的名字').toBe(403)
  expect((JSON.parse(granteeRename.body) as { code: string }).code).toBe('forbidden')

  // 非 owner 也不能改权限（否则她可以自己把自己变成 owner）。
  const granteeAcl = await rawRequest(carol.sessionToken, `/api/workgroups/${group.id}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      ownerUserId: carol.userId,
      expectedResourceId: group.id,
      expectedAclRevision: (await readAcl(carol.sessionToken, 'workgroups', group.id)).aclRevision,
    }),
  })
  expect(granteeAcl.status, '被授权人把资源的所有权转给了自己 ⇒ 一次授权等于送出整个资源').toBe(403)

  // 可见后果：四次被拒之后，服务端的文档一个字节都没动。
  const untouched = await jsonOf<WorkgroupDetailLite>(
    alice.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  expect(
    [untouched.name, untouched.maxRounds, untouched.version],
    '拒绝返回了 403，但改动其实已经落库 ⇒ 拒绝只是个门面',
  ).toEqual([wgName, seen.maxRounds, seen.version])
  expect(
    (await readAcl(alice.sessionToken, 'workgroups', group.id)).ownerUserId,
    '所有者已经被换掉了 ⇒ 上一条 403 是假的',
  ).toBe(alice.userId)

  // ---- owner 正向对照：同样三个端点对 owner 是通的 -----------------------
  // 没有这一段，上面四条 403 也可能只是「这些端点整个坏了」。
  const ownerPut = await putWorkgroup(alice.sessionToken, group.id, untouched.version, {
    ...snapshotOf(untouched),
    maxRounds: untouched.maxRounds + 1,
  })
  expect(ownerPut.status, 'owner 自己也写不进去 ⇒ 上面那条 PUT 403 证明不了权限').toBe(200)
  const committed = await jsonOf<WorkgroupDetailLite>(
    alice.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  expect(committed.maxRounds, '返回 200 但内容没落库 ⇒ 保存是假的').toBe(untouched.maxRounds + 1)

  const ownerRename = await rawRequest(alice.sessionToken, `/api/workgroups/${group.id}/rename`, {
    method: 'POST',
    body: renameBody('rfc319-wg21-owner-renamed', committed.version),
  })
  expect(ownerRename.status, 'owner 自己也改不了名 ⇒ 上面那条 rename 403 证明不了权限').toBe(200)

  const throwaway = await createWorkgroup(alice.sessionToken, 'rfc319-wg21-throwaway', [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
  ])
  const ownerDelete = await rawRequest(alice.sessionToken, `/api/workgroups/${throwaway.id}`, {
    method: 'DELETE',
    body: deleteBody(throwaway.name, throwaway.version),
  })
  expect(ownerDelete.status, 'owner 自己也删不掉 ⇒ 上面那条 DELETE 403 证明不了权限').toBe(204)
})

// ---------------------------------------------------------------------------
// WG-22
// ---------------------------------------------------------------------------

test('WG-22 新增成员引用不可见的私有代理 → 422 acl-missing-refs；存量引用豁免，可见引用照常加得上', async () => {
  const alice = await createUserAndLogin({ username: 'rfc319-wg22-alice', role: 'user' })
  const bob = await createUserAndLogin({ username: 'rfc319-wg22-bob', role: 'user' })

  // RFC-231：canonical 创建路径默认 private，所以 bob 这两个代理天生对 alice 不可见。
  const secretExistingName = 'rfc319-wg22-bob-existing'
  const secretNewName = 'rfc319-wg22-bob-new'
  const sharedName = 'rfc319-wg22-shared'
  const secretExistingId = await createAgent(bob.sessionToken, secretExistingName)
  const secretNewId = await createAgent(bob.sessionToken, secretNewName)
  const sharedId = await createAgent(alice.sessionToken, sharedName)
  await putAcl(alice.sessionToken, 'agents', sharedId, { visibility: 'public' })

  // bob 建一个引用了自己私有代理的工作组，然后把**所有权转给 alice**。这是
  // 「存量引用」在真实产品里的来路：接手他人资源的人，天然会继承一批自己看不见
  // 的引用。（main 上工作组的写面是 owner-only，所以只有转让才能让一个看不见
  // 该引用的人成为它的写入者。）
  const group = await createWorkgroup(bob.sessionToken, 'rfc319-wg22-group', [
    { memberType: 'agent', agentId: sharedId, displayName: 'Lead', roleDesc: '' },
    { memberType: 'agent', agentId: secretExistingId, displayName: 'Legacy', roleDesc: '' },
  ])
  await putAcl(bob.sessionToken, 'workgroups', group.id, { ownerUserId: alice.userId })
  expect(
    (await readAcl(alice.sessionToken, 'workgroups', group.id)).ownerUserId,
    '转让没生效 ⇒ 下面 alice 的每一次 PUT 都会先撞 owner 门，测不到引用围栏',
  ).toBe(alice.userId)

  // 前提对账：alice 确实看不见 bob 的这两个私有代理（否则「新增被拒」只是巧合）。
  const aliceAgents = await jsonOf<Array<{ id: string }>>(alice.sessionToken, '/api/agents')
  const aliceAgentIds = aliceAgents.map((row) => row.id)
  expect(aliceAgentIds, '公开代理都看不到 ⇒ 代理列表本身坏了').toContain(sharedId)
  expect(aliceAgentIds, '别人的私有代理出现在列表里 ⇒ 这条用例的前提不成立').not.toContain(
    secretNewId,
  )
  expect(aliceAgentIds).not.toContain(secretExistingId)

  const seen = await jsonOf<WorkgroupDetailLite>(alice.sessionToken, `/api/workgroups/${group.id}`)
  const base = snapshotOf(seen)

  // (1) 存量引用豁免：原样保存一次必须通过——名单里还挂着 alice 看不见的
  //     secretExisting。这条一旦破，接手了他人工作组的 owner 连「改一行说明」
  //     都做不到，工作组直接变成死档。
  const unchanged = await putWorkgroup(alice.sessionToken, group.id, seen.version, {
    ...base,
    instructions: 'rfc319-wg22 edited by the new owner',
  })
  expect(
    unchanged.status,
    '存量的不可见引用把原样保存也拦下了 ⇒ 新 owner 碰哪儿都是 422' +
      '（services/workgroups.ts:963-970 的 grandfatheredIds 就是为这个存在）',
  ).toBe(200)

  const afterEdit = await jsonOf<WorkgroupDetailLite>(
    alice.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  expect(afterEdit.instructions).toBe('rfc319-wg22 edited by the new owner')

  // (2) 新增一个指向不可见私有代理的成员 → 422。
  const withSecret = await putWorkgroup(alice.sessionToken, group.id, afterEdit.version, {
    ...snapshotOf(afterEdit),
    members: [
      ...snapshotOf(afterEdit).members,
      { memberType: 'agent', agentId: secretNewId, displayName: 'Smuggled', roleDesc: '' },
    ],
  })
  expect(
    withSecret.status,
    '别人的私有代理被拉进了工作组 ⇒ 启动时按隐式闭包授权真的会把它跑起来，' +
      '这是一次完整的越权使用，而形式上只是「保存成功」',
  ).toBe(422)
  const denial = JSON.parse(withSecret.body) as {
    code: string
    message: string
    details?: { missing?: Array<{ type: string; name: string }> }
  }
  expect(denial.code, '拒绝码变了 ⇒ 前端翻不出「你没有其中部分引用资源的访问权限」').toBe(
    'acl-missing-refs',
  )
  expect(
    denial.details?.missing,
    '拒绝必须逐条点名是哪个引用不可用，否则用户面对一个 64 人的名单无从下手；' +
      '而且只能回显调用方**输入的 id**',
  ).toEqual([{ type: 'agent', name: secretNewId }])
  expect(
    withSecret.body,
    '拒绝信息里回显了私有代理的名字 ⇒ 422 成了「用 id 换名字」的元数据探针' +
      '（resourceRefs.ts:341-349 的 D1/P2-2）',
  ).not.toContain(secretNewName)

  // 可见后果：整份保存被整体拒绝，成员没有部分落地。
  const afterDenial = await jsonOf<WorkgroupDetailLite>(
    alice.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  expect(
    afterDenial.members.map((m) => m.displayName),
    '422 之后名单里多了一个人 ⇒ 拒绝不是原子的，写了一半',
  ).toEqual(['Lead', 'Legacy'])
  expect(afterDenial.version, '422 之后版本号还是涨了 ⇒ 事务没回滚').toBe(afterEdit.version)

  // (2b) 引用一个**根本不存在**的代理 id 同样必须被拒——否则名单里会落下一个
  //      悬空成员，工作组保存成功、启动时才炸。注意这条与 (2) 的**错误码不同**
  //      （不存在走 workgroup-member-agent-invalid 的存在性校验，不可见走
  //      acl-missing-refs 的 ACL 围栏）：成员引用面因此能区分「不存在」与
  //      「存在但你看不到」，与 WG-20 对工作组本身要求的同形不是一回事。这里
  //      只锁「两者都必须 422、都不得落库」，如实记录现状，不替它背书。
  const withAbsentAgent = await putWorkgroup(alice.sessionToken, group.id, afterDenial.version, {
    ...snapshotOf(afterDenial),
    members: [
      ...snapshotOf(afterDenial).members,
      { memberType: 'agent', agentId: ABSENT_AGENT_ID, displayName: 'Dangling', roleDesc: '' },
    ],
  })
  expect(
    withAbsentAgent.status,
    '悬空的成员引用被保存下来了 ⇒ 工作组看起来正常，启动那一刻才发现成员不存在',
  ).toBe(422)

  // (3) 正向对照：换成可见的公开代理，同一个位置加得上。没有这一条，(2) 只能
  //     证明「新增成员这条路整个坏了」。
  const withShared = await putWorkgroup(alice.sessionToken, group.id, afterDenial.version, {
    ...snapshotOf(afterDenial),
    members: [
      ...snapshotOf(afterDenial).members,
      { memberType: 'agent', agentId: sharedId, displayName: 'Extra', roleDesc: '' },
    ],
  })
  expect(
    withShared.status,
    '可见代理也加不进去 ⇒ 上面那条 422 只能证明新增成员坏了，证明不了 ACL 围栏',
  ).toBe(200)
  const finalDetail = await jsonOf<WorkgroupDetailLite>(
    alice.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  expect(finalDetail.members.map((m) => m.displayName)).toEqual(['Lead', 'Legacy', 'Extra'])
})

// ---------------------------------------------------------------------------
// WG-X1
// ---------------------------------------------------------------------------

test('WG-X1 意图构建器入口：有 intent:write 时列表/详情各挂一个且导航参数正确，没有时整体不挂载', async ({
  browser,
}) => {
  // guest 是产品里唯一「登录了、看得见资源、但没有 intent:*」的档位
  // （shared/schemas/permission.ts:915-923 GUEST_BASELINE）。角色预设只能加不能减，
  // 所以低权账号只能从 guest 造。
  const guest = await createUserAndLogin({ username: 'rfc319-wgx1-guest', role: 'guest' })
  const writer = await createUserAndLogin({ username: 'rfc319-wgx1-writer', role: 'user' })

  const agentId = await createAgent(daemon.token, 'rfc319-wgx1-agent')
  const wgName = 'rfc319-wgx1-group'
  const group = await createWorkgroup(daemon.token, wgName, [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
  ])
  // 画廊页在「列表真空且有空态主行动」时会整块吞掉 headerActions
  // （components/gallery/ResourceGalleryPage.tsx:89）——不铺一条可见数据，
  // 有权账号那半边的正向对照会因为一个无关原因变绿。
  await putAcl(daemon.token, 'workgroups', group.id, { visibility: 'public' })

  // ---- 有 intent:write：两个入口都在，而且导航参数把目标带过去了 ----------
  const writerSide = await openAs(browser, writer.sessionToken)
  try {
    const { page } = writerSide

    await page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(page.getByRole('heading', { name: 'Workgroups', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByTestId('workgroups-intent-entry').click()
    await page.waitForURL(/\/intent/)
    expect(
      new URL(page.url()).searchParams.get('hint'),
      '列表入口没把「要造的是工作组」带进会话 ⇒ 用户进到一个通用会话，' +
        'AI 还要再问一轮「你想造什么」',
    ).toBe('workgroup')
    const createDialog = page.getByTestId('intent-create-dialog')
    await expect(createDialog, '入口点了没打开创建面 ⇒ 这个按钮等于死链').toBeVisible()
    // 必须限定在弹窗里：同一个 testid 在页面顶部的 inline 创建器上也有一份，
    // 而那一份不受 hint 参数影响。
    await expect(
      createDialog.getByTestId('intent-create-hint-workgroup'),
      '创建面没有预选「工作组」⇒ 上面那条 hint 参数其实没被消费',
    ).toHaveAttribute('aria-checked', 'true')

    await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await page.getByTestId('workgroup-more-actions').click()
    await expect(page.getByTestId('workgroup-actions-dialog')).toBeVisible()
    await page.getByTestId('workgroup-intent-entry').click()
    await page.waitForURL(/\/intent/)
    const modifyUrl = new URL(page.url())
    expect(
      [modifyUrl.searchParams.get('mountType'), modifyUrl.searchParams.get('mountId')],
      '详情入口没带上挂载目标 ⇒「修改这个工作组」静默退化成「从零新建一个」，' +
        '用户要到提交时才发现改的不是原来那个',
    ).toEqual(['workgroup', group.id])
    await expect(
      page.getByTestId('intent-modify-target'),
      '会话没显示挂载目标 ⇒ 用户无从确认自己改的是哪一个',
    ).toContainText('Workgroup')
  } finally {
    await writerSide.context.close()
  }

  // ---- 没有 intent:write：同样两页、同一个资源，入口一个都不挂载 ----------
  const guestSide = await openAs(browser, guest.sessionToken)
  try {
    const { page } = guestSide

    await page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      page.getByRole('heading', { name: 'Workgroups', exact: true }),
      '工作组列表页本身没渲染出来，这一页的入口断言无效',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId(`workgroup-card-${wgName}`),
      '列表真空会让画廊整块吞掉 headerActions（ResourceGalleryPage.tsx:89），' +
        '那样下面的 count(0) 就成了恒真断言',
    ).toBeVisible()
    await expect(
      page.getByTestId('workgroups-intent-entry'),
      '没有 intent:write 却渲染了列表入口 ⇒ 用户点进去只能吃 403',
    ).toHaveCount(0)

    await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await page.getByTestId('workgroup-more-actions').click()
    const actions = page.getByTestId('workgroup-actions-dialog')
    await expect(actions, 'More 弹窗没打开，下面的 count(0) 是恒真断言').toBeVisible({
      timeout: 30_000,
    })
    await expect(
      actions.getByTestId('export-package-workgroup'),
      '弹窗里一个动作都没有 ⇒ 说明内容整个没渲染，而不是入口被权限收掉了',
    ).toBeVisible()
    await expect(
      page.getByTestId('workgroup-intent-entry'),
      '没有 intent:write 却在工作组动作列表里渲染了入口 ⇒ 点了只能吃 403',
    ).toHaveCount(0)

    // testid 只是锚点，不是契约。按可见文案再扫一遍，挡住「换了个 testid 重新
    // 落一个同样的按钮」这类改动。
    await expect(page.getByText('Build via intent', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Modify via intent', { exact: true })).toHaveCount(0)
  } finally {
    await guestSide.context.close()
  }
})
