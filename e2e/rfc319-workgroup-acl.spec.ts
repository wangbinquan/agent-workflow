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
//   * WG-21 —— 治理动作（改名 / 删除 / 改权限）留在 owner 手里，内容写留在
//     owner 与 `write` 档手里：只读的人看得见、但改不动。这条一旦破，任何一个
//     被加进授权名单的人就能把别人的工作组改名、删掉或者改写成员，而 owner 只会
//     看到资源凭空变了样。「403 了」还不够：必须同时证明**同一个端点对 owner
//     （以及 `write` 档在它够得着的那一条上）是通的**，否则一条「端点整个坏了」
//     的回归也能让这些断言全绿。
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
// 基线：RFC-324「资源授权分档」之后的契约
// ---------------------------------------------------------------------------
// RFC-324 把「授权」从一份平面的用户名单改成 **read / write 两档**，并把写面从
// 「有方法级权限点就能改」收紧成「权限点 ∧ 行级授权档」。本文件按分档后的契约
// 编写。它在工作组域具体锁住这些事实：
//
//   1. **授权有深度，且安全默认是浅的。** 通过界面新加进名单的人一律落 `read`
//      （AclPanel.tsx:405-410），只有把她显式提到 `write`，`GET /acl` 的
//      `grants` 里那一行才变 `write`（WG-19b §(2)/(4)）。断的是**服务端 wire**，
//      不是界面上那个 aria-checked——界面侧的默认档已由
//      `e2e/rfc324-graded-grants.spec.ts` 逐字锁住，这里不重复。
//      这条一旦破，「加个人让他看看」会静默变成「把编辑权发出去」。
//   2. **面板对非 owner 是只读投影，而且能读到档位。** `write` 档的人打得开
//      面板、读得到 owner 与**逐人的授权深度**（"Read-only" / "Can edit"），
//      但 `acl-save` / `acl-transfer-owner` / `acl-visibility-*` /
//      `acl-members-input` 一个都不渲染（WG-19a §(5)）。这一段是本文件里
//      **唯一非恒真**的只读面板对照：面板确实挂载了，四条 count(0) 才有意义。
//   3. **详情页的三种门各挂各的。** `workgroups.detail.tsx:191-194` 把入口分成
//      三档：权限入口挂方法级点（`canManageAcl`，故意不藏，好让被授权人看得到
//      自己是被谁、以什么档位授权的）、内容写入口挂 `canUpdate = 点 ∧ canEdit`、
//      删除挂 `canDelete = 点 ∧ canManage`。于是 `read` 档在详情页看得到权限与
//      导出入口、但看不到「添加成员 / 改名 / 删除」（WG-21 §界面半段）。
//   4. **写面拒绝码按门分流。** 内容写 → `resource-read-only`；治理写（删除 /
//      改名 / 改权限）→ `resource-govern-owner-only`；`write` 档把改名夹在内容
//      PUT 的 body 里 → `resource-rename-owner-only`（WG-21）。三个码是**三条
//      不同的用户文案**，混成一个就等于把「你没有编辑权」和「这件事只有所有者
//      能做」讲成同一句话，被授权人会以为自己该去申请编辑权。
//   5. **不重复覆盖的边界。** 本文件的定位是**工作组域**的 WG-19～WG-22 / WG-X1。
//      两条通用 ACL 行为由别处逐字锁住，这里不再写第二遍：
//        - `e2e/rfc324-graded-grants.spec.ts` 的
//          「只读授权者的编辑器是只读的且零自动保存；升档与降档都不需要刷新页面」
//          锁了新加授权在**界面上**默认 read（aria-checked）、工作流编辑器的只读
//          徽标 / 编辑控件、以及经 WS 的实时升降档。
//        - `e2e/rfc099-ownership-acl.spec.ts` 的
//          「private agent disappears for strangers; granting via AclPanel
//          restores read-only access」锁了**代理域**的只读面板与 owner-transfer
//          嵌套弹窗。
//   6. **一处有意不锁的现状（登记在案，不是遗漏）。** `read` 档在详情页
//      **看得见** `workgroup-acl-button`（挂 `canManageAcl`，detail.tsx:980），
//      但承载面板的那个 Dialog 仍挂 `canUpdate`（detail.tsx:1012），所以点下去
//      弹不出面板——一个死按钮。本文件断的是「入口在」+「零可写权限控件」，
//      **不**断「面板打不开」：那样会把这个缺陷锁成契约，日后把只读面板补上
//      反而变红。两条断言在缺陷修好前后都成立，且都指向真正要防的那件事——
//      非 owner 永远碰不到写权限的控件。
//
// ---------------------------------------------------------------------------
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link
// check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/backend/src/routes/workgroups.ts:61-70          loadVisibleWorkgroup：缺失与不可见同一个 404
//   packages/backend/src/routes/workgroups.ts:199-203        PUT：先 404 再 requireResourceEdit（内容写）
//   packages/backend/src/routes/workgroups.ts:222-223        DELETE：requireResourceGovern 排在 confirm 校验之前
//   packages/backend/src/routes/workgroups.ts:257-258        rename：requireResourceGovern
//   packages/backend/src/routes/resourceAcl.ts:146-147       GET /acl：不可见 → 同形 404
//   packages/backend/src/routes/resourceAcl.ts:163           PUT /acl：tokenAccess:'never'（只有会话 token 能过）
//   packages/backend/src/services/resourceAcl.ts:621-632     requireResourceGovern → 403 resource-govern-owner-only
//   packages/backend/src/services/resourceAcl.ts:643-659     requireResourceEdit → 先 404 后 403 resource-read-only
//   packages/backend/src/services/resourceAcl.ts:776         updateResourceAcl 的第一道门就是 requireResourceGovern
//   packages/backend/src/services/resourceAccessPolicy.ts:133-159 canViewAccess / canEditAccess / canGovernAccess
//   packages/backend/src/services/resourceAccessPolicy.ts:175-186 assertNameUnchangedForEditor → resource-rename-owner-only
//   packages/backend/src/services/workgroups.ts:443          保存事务内对 write 档做改名围栏（拿 in-tx 当前名比）
//   packages/backend/src/services/workgroups.ts:398          保存事务内只围栏 diffNewAgentMemberIds（新增引用）
//   packages/backend/src/services/workgroups.ts:708-725      diffNewAgentMemberIds：存量 agentId 全部豁免
//   packages/backend/src/services/workgroups.ts:984-990      prepareAgentMembers 的 grandfatheredIds
//   packages/backend/src/services/resourceRefs.ts:341-349    missingRefsError → 422 acl-missing-refs，只回显输入 token
//   packages/shared/src/schemas/resourceAcl.ts:179-183       ResourceGrantSchema：{user, level}
//   packages/shared/src/schemas/resourceAcl.ts:194-224       GET /acl 响应：grants + canManage + canEdit + aclRevision
//   packages/shared/src/schemas/resourceAcl.ts:237-257       PUT /acl body：grants 全量替换 + 强制 OCC 围栏
//   packages/frontend/src/components/AclPanel.tsx:405-410    UserPicker 新加的人一律落 level:'read'
//   packages/frontend/src/components/AclPanel.tsx:498-540    canManage 才渲染档位 Segmented + 移除；否则只读 StatusChip
//   packages/frontend/src/components/AclPanel.tsx:571-586    可见性：canManage 才是分段控件，否则只读 chip
//   packages/frontend/src/components/AclPanel.tsx:607-614    acl-save 仅在 canManage 时渲染
//   packages/frontend/src/components/AclPanel.tsx:449-458    acl-transfer-owner 仅在 canManage 时渲染
//   packages/frontend/src/hooks/useResourceAccess.ts:87-89   判定未到时 canEdit/canManage 乐观为真；到手后按真值
//   packages/frontend/src/routes/workgroups.detail.tsx:191-194 canManageAcl / canUpdate / canDelete 三种门
//   packages/frontend/src/routes/workgroups.detail.tsx:844-850 workgroup-add-agent-member（canUpdate &&）
//   packages/frontend/src/routes/workgroups.detail.tsx:939-954 workgroup-intent-entry（手写 canWriteIntent &&）
//   packages/frontend/src/routes/workgroups.detail.tsx:960-972 workgroup-rename-button（canUpdate &&）
//   packages/frontend/src/routes/workgroups.detail.tsx:980-991 workgroup-acl-button（canManageAcl &&）
//   packages/frontend/src/routes/workgroups.detail.tsx:997-1003 workgroup-delete-button（canDelete &&）
//   packages/frontend/src/routes/workgroups.detail.tsx:1012-1018 workgroup-acl-dialog 仍挂 canUpdate（见上文第 6 条）
//   packages/frontend/src/routes/workgroups.tsx:192-199      workgroups-intent-entry
//   packages/frontend/src/components/IntentEntryButton.tsx:32 无 intent:write → return null
//   packages/frontend/src/components/gallery/ResourceGalleryPage.tsx:89 列表真空会吞掉 headerActions
//   packages/frontend/src/components/ErrorBanner.tsx:82      拒绝文案落在 .error-box
//   packages/shared/src/schemas/permission.ts:915-923        GUEST_BASELINE：只有六类 :read，不含 intent:*
//
// 执行模型：本文件所有用例共用一个 daemon（默认 stub）。playwright.config.ts 把
// fullyParallel 留在默认 false，因此文件内用例按声明顺序串行。每个用例自带独立的
// 用户 / 代理 / 工作组夹具，互不共享可变状态。

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

type GrantLevel = 'read' | 'write'

/**
 * GET /api/{res}/:id/acl 的响应（shared/schemas/resourceAcl.ts:194-224）。
 *
 * RFC-324 之后授权名单是 `grants: {user, level}[]`——**必填**，没有兼容分支。
 * 早先这里为了同时吃下 RFC-324 前的平面 `users: UserPublic[]` 留了一个可选
 * 字段，结果是「授权深度」这件事在夹具层就被抹平了，断言最多只能断到「名单里
 * 有这个人」——而 RFC-324 要防的恰恰是「名单里有他、但深度悄悄从 read 变成
 * write」。删掉那个分支之后，下面的 `granteeLevelsOf()` 逐条带出深度。
 */
interface AclLite {
  resourceId: string
  ownerUserId: string | null
  owner: UserPublicLite | null
  visibility: 'public' | 'private'
  grants: Array<{ user: UserPublicLite; level: GrantLevel }>
  canManage: boolean
  canEdit: boolean
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

/**
 * 授权名单：逐条 `[userId, level]`，顺序即服务端下发顺序。
 *
 * 刻意带上 level 而不是只回 id：RFC-324 之后「谁在名单上」只是一半事实，另一半
 * 是「他拿到多深」。只断 id 的话，一次把所有人静默升成 `write` 的回归可以全绿
 * 通过——而那正是「加个人让他看看」变成「把编辑权发出去」的形态。
 */
function granteeLevelsOf(acl: AclLite): Array<[string, GrantLevel]> {
  return acl.grants.map((g) => [g.user.id, g.level])
}

/** ACL 的 PUT 是全量替换 + 强制 OCC 围栏（shared/schemas/resourceAcl.ts:237-257）。 */
async function putAcl(
  token: string,
  kind: AclKind,
  id: string,
  patch: {
    visibility?: 'public' | 'private'
    ownerUserId?: string
    /** 全量替换——省略等于「名单不动」，给空数组才是「清空」。 */
    grants?: Array<{ userId: string; level: GrantLevel }>
  },
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

/** 详情页 header 的 More 弹窗——所有资源级动作（含权限入口）都挂在这里。 */
async function openWorkgroupActions(page: Page): Promise<Locator> {
  await page.getByTestId('workgroup-more-actions').click()
  const actions = page.getByTestId('workgroup-actions-dialog')
  await expect(actions, 'More 弹窗没打开 ⇒ 后面每一条 count(0) 都是恒真断言').toBeVisible({
    timeout: 30_000,
  })
  return actions
}

/** More → 权限，并等面板真的挂上来。只有 owner / `write` 档走得通这条（见文件头第 6 条）。 */
async function openWorkgroupAcl(page: Page): Promise<void> {
  await openWorkgroupActions(page)
  await page.getByTestId('workgroup-acl-button').click()
  await expect(page.getByTestId('workgroup-acl-dialog')).toBeVisible()
  await expect(page.getByTestId('acl-panel')).toBeVisible()
}

/**
 * 权限面板里**一个可写控件都没有**：保存 / 转让 / 可见性分段 / 加人搜索框。
 *
 * 四条一起断而不是只断 `acl-save`：它们是四条互相独立的越权路径——能保存就能
 * 改写名单，能转让就能把资源整个拿走，能点可见性就能把别人的工作组改成私有再
 * 把 owner 关在外面，能用加人搜索框就能给自己的同伙发授权。少断一条就等于把
 * 那一条留在门外。
 */
async function expectNoAclWriteControls(page: Page, who: string): Promise<void> {
  await expect(
    page.getByTestId('acl-save'),
    `${who} 的面板渲染了保存按钮 ⇒ 任何看得见这个工作组的人都能改写它的权限名单`,
  ).toHaveCount(0)
  await expect(
    page.getByTestId('acl-transfer-owner'),
    `${who} 的面板渲染了转让所有者 ⇒ 看得见的人能把资源的所有权转走`,
  ).toHaveCount(0)
  await expect(
    page.getByTestId('acl-visibility-private'),
    `${who} 的面板渲染了可见性分段控件 ⇒ 别人能把你的工作组改成私有把你自己关在外面`,
  ).toHaveCount(0)
  await expect(page.getByTestId('acl-visibility-public')).toHaveCount(0)
  await expect(
    page.getByTestId('acl-members-input'),
    `${who} 的面板渲染了加人搜索框 ⇒ 被授权人能顺手把别人也加进这份名单`,
  ).toHaveCount(0)
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

test('WG-19a ACL 面板的可见性开关：public→private→public 双向生效，read 档与 write 档的面板全程只读', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({ username: 'rfc319-wg19a-alice', role: 'user' })
  const carol = await createUserAndLogin({ username: 'rfc319-wg19a-carol', role: 'user' })
  // RFC-324：`write` 档才是「能改内容、但管不了权限」的那个形态，也是本用例里
  // 唯一打得开面板的非 owner——它让下面那组 count(0) 不是恒真断言。
  const dave = await createUserAndLogin({ username: 'rfc319-wg19a-dave', role: 'user' })

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
  const daveSide = await openAs(browser, dave.sessionToken)
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
    expect(granteeLevelsOf(afterPrivate), '切私有不该顺手给任何人发授权').toEqual([])

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

    // (4) `read` 档（carol 现在是公开可见、零 grant，也就是 access='read'）：
    //     权限入口**渲染**，但点开之后一个可写权限控件都没有。
    //
    //     入口渲染是 RFC-324 的明文承诺，不是疏漏：`workgroups.detail.tsx:191`
    //     把它挂在方法级权限点上而不是行级档位上，理由写在那行注释里——把它藏
    //     起来，被授权人就再也看不到自己是被谁、以什么档位授权的。所以这里断的
    //     是 `toBeVisible()`（正向），一旦有人把它重新藏回 `canUpdate` 就变红。
    //
    //     面板本身在 `read` 档下暂时挂不上（承载它的 Dialog 仍挂 `canUpdate`，
    //     detail.tsx:1012），因此这四条 count(0) 在**今天**是靠「什么都没渲染」
    //     成立的。它们真正要防的是另一件事——面板一旦对只读者开放（那是个该修
    //     的缺陷），可写控件绝不能跟着一起开放。非恒真的那一份对照在 (5)：
    //     `write` 档的面板确实挂载了，同样四条仍然是 0。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    const carolActions = await openWorkgroupActions(carolSide.page)
    await expect(
      carolActions.getByTestId('export-package-workgroup'),
      'More 弹窗里一个动作都没有 ⇒ 说明内容整个没渲染，而不是入口被权限收掉了',
    ).toBeVisible()
    await expect(
      carolSide.page.getByTestId('workgroup-acl-button'),
      'read 档看不到权限入口 ⇒ 被授权人无从知道自己是被谁、以什么档位授权的，' +
        '想申请编辑权也不知道该找谁（detail.tsx:188-191 明文要求这个入口不随档位隐藏）',
    ).toBeVisible()
    await carolSide.page.getByTestId('workgroup-acl-button').click()
    await expectNoAclWriteControls(carolSide.page, 'read 档')

    // (5) `write` 档：面板真的打得开，而且是一份**能读到档位**的只读投影。
    //     「看得见 ≠ 管得了」的原意落在这里——她改得动内容，却一个权限控件都
    //     碰不到。
    await putAcl(alice.sessionToken, 'workgroups', group.id, {
      grants: [
        { userId: carol.userId, level: 'read' },
        { userId: dave.userId, level: 'write' },
      ],
    })
    await daveSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(daveSide.page)
    const davePanel = daveSide.page.getByTestId('acl-panel')
    await expect(davePanel, '非 owner 看不到 owner 是谁 ⇒ 想要授权都不知道该找谁').toContainText(
      alice.username,
    )
    await expect(
      davePanel,
      '只读面板必须仍然把当前可见性显示出来（纯文本），否则用户连现状都看不到',
    ).toContainText('Everyone')
    // 逐人档位：两行必须**互不相同**，否则「档位显示出来了」可以靠一个恒定文案
    // 蒙混过关。读不到深度的名单正是 RFC-324 要终结的那个形状——授权双方都在猜
    // 这一笔授权到底给出了什么。
    await expect(
      daveSide.page.getByTestId(`acl-grant-${dave.userId}`),
      'write 档的人在面板里读不到自己是「可编辑」⇒ 她不知道自己改得动这份内容，' +
        '真改了才发现，或者明明有权却不敢动',
    ).toContainText('Can edit')
    await expect(
      daveSide.page.getByTestId(`acl-grant-${carol.userId}`),
      '只读授权在面板里显示成了可编辑（或反过来）⇒ owner 照着一份错的名单做决定，' +
        '以为只发了阅读权，实际发出去的是编辑权',
    ).toContainText('Read-only')
    await expectNoAclWriteControls(daveSide.page, 'write 档')
  } finally {
    await aliceSide.context.close()
    await carolSide.context.close()
    await daveSide.context.close()
  }
})

test('WG-19b ACL 面板的逐用户授权：加人默认落 read、提到 write 才拿到内容写、移出后彻底看不见', async ({
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

    // (2) 服务端事实：名单里恰好多了这一个人、**落在 `read` 档**，可见性
    //     **没被顺手改掉**。
    //
    //     断服务端 wire 而不是界面上的 aria-checked：界面侧「新加的人默认停在
    //     只读」已由 `e2e/rfc324-graded-grants.spec.ts` 逐字锁住，这里要防的是
    //     另一半——界面显示只读、发出去的载荷却是 `write`。这一档之差就是
    //     「加个人让他看看」和「把编辑权发出去」的差别，而 owner 在界面上看不出
    //     任何异样。
    const afterGrant = await readAcl(alice.sessionToken, 'workgroups', group.id)
    expect(
      granteeLevelsOf(afterGrant),
      '面板收下了授权但服务端名单没变 ⇒ 被授权人还是看不见，owner 只能被迫改成公开' +
        '（把一个本该只给一个人看的工作组暴露给全平台）；' +
        '落成 write 则更糟——owner 以为只给了阅读权，对方却能改写内容',
    ).toEqual([[carol.userId, 'read']])
    expect(
      afterGrant.visibility,
      '加人的同时把可见性也顺手改了 ⇒ 一次「只给某人看」变成了对全平台公开',
    ).toBe('private')

    // (3) 可见后果：carol 现在看得见了；她有权限入口（看得到自己被谁授权），
    //     但 `read` 档一个内容写入口都没有。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups`)
    await expect(
      carolSide.page.getByTestId(`workgroup-card-${wgName}`),
      '授权后被授权人仍然看不到 ⇒ 授权名单形同虚设',
    ).toBeVisible({ timeout: 30_000 })

    await carolSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    const carolActions = await openWorkgroupActions(carolSide.page)
    await expect(
      carolActions.getByTestId('workgroup-acl-button'),
      'read 档看不到权限入口 ⇒ 被授权人无从知道自己是被谁、以什么档位授权的',
    ).toBeVisible()
    await carolSide.page.keyboard.press('Escape')
    await expect(carolActions).toHaveCount(0)
    await expect(
      carolSide.page.getByTestId('workgroup-add-agent-member'),
      'read 档渲染了「添加成员」⇒ 只读授权者一路填完表单，保存那一刻才吃 403；' +
        '这正是 RFC-324 要终结的那个体感（docs/audit-backlog.md:108）',
    ).toHaveCount(0)
    // 这一条 count(0) 的非恒真对照就在下一步：同一个人、同一页、同一个 testid，
    // 提到 write 之后必须出现。

    // (4) 提档：owner 把 carol 从 read 提到 write。服务端那一行必须跟着变，
    //     carol 重新打开详情页也必须真的拿到内容写入口。少了这一步，一个
    //     「档位控件点了不落库」的回归可以让 (2) 与 (3) 全绿通过——而那意味着
    //     owner 以为自己发出了编辑权，对方却永远改不动。
    await aliceSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(aliceSide.page)
    await aliceSide.page.getByTestId(`acl-level-write-${carol.userId}`).click()
    await aliceSide.page.getByTestId('acl-save').click()
    await expect(aliceSide.page.getByTestId('acl-panel')).toHaveCount(0)
    expect(
      granteeLevelsOf(await readAcl(alice.sessionToken, 'workgroups', group.id)),
      '把人提到「可编辑」之后服务端还是 read ⇒ owner 明明授了编辑权，' +
        '对方每次保存仍然吃 403，两边都不知道问题出在哪',
    ).toEqual([[carol.userId, 'write']])

    await carolSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await expect(
      carolSide.page.getByTestId('workgroup-add-agent-member'),
      'write 档仍然没有内容写入口 ⇒「可编辑」这一档在界面上根本不存在，' +
        '同时也说明 (3) 的那条 count(0) 只是整页没渲染',
    ).toBeVisible({ timeout: 30_000 })

    // (5) 取消授权：名单清空，carol 的列表里这张卡也跟着消失。少了这一步，
    //     一个「只进不出」的名单也能通过前面全部断言——而那意味着授权一旦发出
    //     就永远收不回来。
    await aliceSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await openWorkgroupAcl(aliceSide.page)
    await aliceSide.page.getByTestId(`acl-members-remove-${carol.username}`).click()
    await aliceSide.page.getByTestId('acl-save').click()
    await expect(aliceSide.page.getByTestId('acl-panel')).toHaveCount(0)
    expect(
      granteeLevelsOf(await readAcl(alice.sessionToken, 'workgroups', group.id)),
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

test('WG-21 read 档看得见改不动、write 档只够得着内容：四条写路径按门分流成三个拒绝码，界面同步收口', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({ username: 'rfc319-wg21-alice', role: 'user' })
  const carol = await createUserAndLogin({ username: 'rfc319-wg21-carol', role: 'user' })
  const dave = await createUserAndLogin({ username: 'rfc319-wg21-dave', role: 'user' })

  const agentId = await createAgent(alice.sessionToken, 'rfc319-wg21-agent')
  const wgName = 'rfc319-wg21-group'
  const group = await createWorkgroup(alice.sessionToken, wgName, [
    { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
  ])
  // 让 carol **看得见**——公开可见性即可，拒绝因此必须是 403 而不是 404
  //（404 是给完全看不见的人的，那一半在 WG-20）。公开可见与 `read` 档授权在
  // 这两个门前面完全等价（都解析成 access='read'），少一个依赖就少一个能把本
  // 用例带红的无关故障源。dave 则显式拿 `write`：RFC-324 之后「非 owner」不再
  // 是一种人，档位才是决定写面的东西。
  await putAcl(alice.sessionToken, 'workgroups', group.id, {
    visibility: 'public',
    grants: [{ userId: dave.userId, level: 'write' }],
  })

  const seen = await jsonOf<WorkgroupDetailLite>(carol.sessionToken, `/api/workgroups/${group.id}`)
  expect(seen.id, '非 owner 读不到这个工作组 ⇒ 下面的 403 只能说明她看不见，不是写面被拦住').toBe(
    group.id,
  )

  const renameBody = (newName: string, version: number): string =>
    JSON.stringify({ newName, expectedVersion: version, clientMutationId: nextMutationId() })
  /** DeleteWorkgroupSchema 也是版本围栏 + type-to-confirm；治理门排在这两项校验
   *  之前（routes/workgroups.ts:222-223），但仍然发一份**完全合法**的 body，
   *  这样 403 只可能来自权限，不会被一条 422 参数错误顶掉。 */
  const deleteBody = (name: string, version: number): string =>
    JSON.stringify({ expectedVersion: version, clientMutationId: nextMutationId(), confirm: name })
  const codeOf = (res: RawResponse): string => (JSON.parse(res.body) as { code: string }).code

  // ---- read 档：三条写路径 + 权限面全部 403，且**按门分流成两个码** -------
  //
  // 拒绝码不是内部细节，是三条不同的用户文案：`resource-read-only` 该翻成
  // 「你对这份资源只有只读权限，去找 owner 要编辑权或者自己拷一份」，
  // `resource-govern-owner-only` 该翻成「删除 / 改名 / 改权限只有所有者能做」。
  // 混成一个码，只读者会一直去申请一个根本不存在的「删除权」。
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
    codeOf(granteePut),
    '内容写的拒绝码变了 ⇒ 前端翻不出「你只有只读权限」，' +
      '只能显示一条通用错误（audit-backlog:489-499 记的「此资源可能已删除」就是这么来的）',
  ).toBe('resource-read-only')

  const granteeDelete = await rawRequest(carol.sessionToken, `/api/workgroups/${group.id}`, {
    method: 'DELETE',
    body: deleteBody(wgName, seen.version),
  })
  expect(granteeDelete.status, '非 owner 删掉了别人的工作组 —— 不可逆的越权').toBe(403)
  expect(
    codeOf(granteeDelete),
    '删除的拒绝码退回成内容写的码 ⇒ 用户以为「要个编辑权就能删」，' + '而删除永远只属于所有者',
  ).toBe('resource-govern-owner-only')

  const granteeRename = await rawRequest(carol.sessionToken, `/api/workgroups/${group.id}/rename`, {
    method: 'POST',
    body: renameBody('rfc319-wg21-hijacked', seen.version),
  })
  expect(granteeRename.status, '非 owner 改掉了别人工作组的名字').toBe(403)
  expect(codeOf(granteeRename), '改名是治理动作，不能落在内容写那个码上').toBe(
    'resource-govern-owner-only',
  )

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
  expect(
    codeOf(granteeAcl),
    '改权限是治理动作里最要紧的一条，拒绝码必须和删除 / 改名同门；' +
      '落成 resource-read-only 等于告诉对方「去要个编辑权就能改权限」',
  ).toBe('resource-govern-owner-only')

  // ---- write 档：够得着内容，够不着治理 -----------------------------------
  //
  // 这一段是 RFC-324 真正的分野。少了它，上面四条 403 与「压根没有 write 这一档」
  // 无法区分；而多出来的三条拒绝正是「可编辑」不能顺手变成「可接管」的那条线。
  const daveSeen = await jsonOf<WorkgroupDetailLite>(
    dave.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  const davePut = await putWorkgroup(dave.sessionToken, group.id, daveSeen.version, {
    ...snapshotOf(daveSeen),
    maxRounds: daveSeen.maxRounds + 1,
  })
  expect(
    davePut.status,
    'write 档也写不进内容 ⇒「可编辑」这一档根本没落地，' +
      '同时也说明上面那条 read 档 403 证明不了任何事',
  ).toBe(200)
  const daveCommitted = await jsonOf<WorkgroupDetailLite>(
    alice.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  expect(daveCommitted.maxRounds, 'write 档拿到 200 但内容没落库 ⇒ 保存是假的').toBe(
    daveSeen.maxRounds + 1,
  )

  // 改名夹在内容 PUT 的 body 里——几乎每个资源都在同一份 body 里收名字，所以
  // 「编辑权只覆盖内容」挡不住路由层，只能在保存事务里拿 in-tx 当前名去比
  //（services/workgroups.ts:443）。这一条一旦破，任何一个被授予编辑权的人
  // 都能顺手把别人的工作组改名，而 owner 只会看到资源凭空换了个名字。
  const daveRenameInBody = await putWorkgroup(dave.sessionToken, group.id, daveCommitted.version, {
    ...snapshotOf(daveCommitted),
    name: 'rfc319-wg21-dave-hijacked',
  })
  expect(daveRenameInBody.status, 'write 档把改名夹在内容 body 里就改成了 ⇒ 改名围栏形同虚设').toBe(
    403,
  )
  expect(
    codeOf(daveRenameInBody),
    '夹带改名的拒绝码必须自成一条 ⇒ 否则用户看到「你只有只读权限」，' +
      '而他明明刚刚才成功保存过内容，只会以为系统坏了',
  ).toBe('resource-rename-owner-only')

  const daveRename = await rawRequest(dave.sessionToken, `/api/workgroups/${group.id}/rename`, {
    method: 'POST',
    body: renameBody('rfc319-wg21-dave-renamed', daveCommitted.version),
  })
  expect(daveRename.status, 'write 档走 rename 端点改掉了别人工作组的名字').toBe(403)
  expect(codeOf(daveRename), '改名端点对 write 档也必须是治理门').toBe('resource-govern-owner-only')

  const daveDelete = await rawRequest(dave.sessionToken, `/api/workgroups/${group.id}`, {
    method: 'DELETE',
    body: deleteBody(daveCommitted.name, daveCommitted.version),
  })
  expect(daveDelete.status, 'write 档删掉了别人的工作组 ⇒ 一次编辑授权等于送出删除权').toBe(403)
  expect(codeOf(daveDelete), '删除对 write 档也必须是治理门').toBe('resource-govern-owner-only')

  const daveAcl = await rawRequest(dave.sessionToken, `/api/workgroups/${group.id}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      ownerUserId: dave.userId,
      expectedResourceId: group.id,
      expectedAclRevision: (await readAcl(dave.sessionToken, 'workgroups', group.id)).aclRevision,
    }),
  })
  expect(daveAcl.status, 'write 档把资源所有权转给了自己 ⇒ 编辑授权变成了接管授权').toBe(403)
  expect(codeOf(daveAcl), '改权限对 write 档也必须是治理门').toBe('resource-govern-owner-only')

  // 可见后果：所有被拒的路径之后，名字与所有者一个字节都没动。
  const untouched = await jsonOf<WorkgroupDetailLite>(
    alice.sessionToken,
    `/api/workgroups/${group.id}`,
  )
  expect(
    [untouched.name, untouched.maxRounds, untouched.version],
    '拒绝返回了 403，但改动其实已经落库 ⇒ 拒绝只是个门面。' +
      '（`maxRounds` / `version` 停在 write 档那次合法保存之后的值——' +
      '被拒的六条一次都没再往前推它。）',
  ).toEqual([wgName, daveCommitted.maxRounds, daveCommitted.version])
  expect(
    (await readAcl(alice.sessionToken, 'workgroups', group.id)).ownerUserId,
    '所有者已经被换掉了 ⇒ 上面那两条改权限 403 是假的',
  ).toBe(alice.userId)
  expect(
    granteeLevelsOf(await readAcl(alice.sessionToken, 'workgroups', group.id)),
    '被拒的 PUT /acl 还是把名单改了 ⇒ 403 只挡住了返回值，没挡住写入',
  ).toEqual([[dave.userId, 'write']])

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

  // ---- 界面半段：详情页的三种门与上面这三个码逐一对应 ---------------------
  //
  // RFC-324 之前这一段没有对应行为可断：`workgroups.detail.tsx` 只看方法级权限
  // 点，任何登录用户都会看到「添加成员 / 改名 / 删除 / 权限」四个入口，一路填完
  // 才吃 403（`docs/audit-backlog.md:108` 记的就是这个）。现在三个入口各挂各的
  // 门（detail.tsx:191-194），于是「后端 403」在界面上有了对应的「入口根本不
  // 渲染」——用户不再有机会走进一条注定被拒的路。
  const carolSide = await openAs(browser, carol.sessionToken)
  const daveSide = await openAs(browser, dave.sessionToken)
  try {
    // read 档：治理与内容写入口全无，只留下读得到的那些。
    await carolSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    const carolActions = await openWorkgroupActions(carolSide.page)
    await expect(
      carolActions.getByTestId('export-package-workgroup'),
      '弹窗里一个动作都没有 ⇒ 说明内容整个没渲染，而不是入口被权限收掉了',
    ).toBeVisible()
    await expect(
      carolActions.getByTestId('workgroup-acl-button'),
      'read 档连权限入口都没有 ⇒ 被授权人无从知道自己是被谁、以什么档位授权的',
    ).toBeVisible()
    await expect(
      carolActions.getByTestId('workgroup-rename-button'),
      'read 档渲染了改名入口 ⇒ 用户打开改名弹窗、输完新名字，保存那一刻才吃 403',
    ).toHaveCount(0)
    await expect(
      carolActions.getByTestId('workgroup-delete-button'),
      'read 档渲染了删除入口 ⇒ 用户会一路走到「输入名称以确认删除」，' +
        '以为自己真的删得掉别人的工作组',
    ).toHaveCount(0)
    await carolSide.page.keyboard.press('Escape')
    await expect(carolActions).toHaveCount(0)
    await expect(
      carolSide.page.getByTestId('workgroup-add-agent-member'),
      'read 档渲染了「添加成员」⇒ 一路挑完代理、填完角色说明，保存才发现改不动',
    ).toHaveCount(0)

    // write 档：内容写入口回来了，治理入口仍然没有。这一对照让上面四条 count(0)
    // 不是恒真断言——同一页、同一批 testid，只有档位变了。
    await daveSide.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    const daveActions = await openWorkgroupActions(daveSide.page)
    await expect(
      daveActions.getByTestId('workgroup-rename-button'),
      'write 档没有改名入口 ⇒ 说明这些 testid 在这一页上整体不渲染，' +
        '上面那几条 read 档 count(0) 什么也证明不了',
    ).toBeVisible()
    await expect(
      daveActions.getByTestId('workgroup-delete-button'),
      'write 档渲染了删除入口 ⇒ 界面把「可编辑」讲成了「可删除」，' +
        '而后端会在最后一刻用 resource-govern-owner-only 拒掉',
    ).toHaveCount(0)
    await daveSide.page.keyboard.press('Escape')
    await expect(daveActions).toHaveCount(0)
    await expect(
      daveSide.page.getByTestId('workgroup-add-agent-member'),
      'write 档没有「添加成员」⇒ 编辑授权在界面上等于没发',
    ).toBeVisible()
  } finally {
    await carolSide.context.close()
    await daveSide.context.close()
  }
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
