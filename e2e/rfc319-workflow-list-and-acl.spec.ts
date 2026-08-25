// RFC-319 —— 工作流的「找 / 看 / 分享 / 清理」这一圈用户面 e2e。
//
// 覆盖能力账本 WF-03 / WF-04 / WF-05 / WF-06 / WF-08 / WF-48 / WF-50 / WF-51 /
// WF-53 九行（账本里全部是 gap 或 partial）。
//
// 与既有工作流 e2e 的分工（**刻意不重叠**）：
//   * `e2e/workflow-editor.spec.ts` —— 画布内的创作动作（拖拽新增、撤销、连线、
//     四模式工作区、axe），加上 RFC-319 T31 那条删除用例（逐字确认 + 版本 CAS +
//     真删）。它从来没打开过 `/workflows` **列表**，也没有断言过任何卡片内容。
//   * `e2e/ux-consistency.spec.ts:394` 与 `e2e/visual-regression.spec.ts:1748` ——
//     全仓 e2e 仅有的两处 `workflow-card` 断言，都只是 `toBeVisible`；后者的
//     nightly workflow 路径过滤不含 `packages/backend/**`，所以 RFC-311 那种
//     **服务端投影**改动根本不会触发它，对 WF-03 不构成兜底。
//   * `e2e/rfc324-graded-grants.spec.ts` —— 只读档在**编辑器**里的形态（只读徽标、
//     零自动保存、升降档不刷新页面即生效）。本文件不重复那条链，只接着往下走它
//     没走的两步：只读者的**逃生出口**（另存副本，WF-48）与工作流这一类资源的
//     **可见性**变化（WF-51）。
//   * `e2e/rfc099-ownership-acl.spec.ts:245-283` —— 工作流段落只做了面板 smoke 与
//     移交弹窗的焦点/Escape 语义，一次 `acl-save` 都没点过，也没有被授权者视角的
//     复核；agent 段落才有完整可见性链。WF-51 把工作流补到同粒度。
//   * `e2e/rfc305-user-permissions.spec.ts:557-582` —— guest 的工作流面只断言了
//     「新建按钮不在」「create 参数被清」「editor-layout--read-only 类在」与画布
//     宽度。WF-08 接着补它没管的三件事：调色板 / Inspector 是否真的不渲染、More
//     菜单里改名 / 删除 / 权限三项是否真的够不着、整场会话是否真的一发写请求都没有。
//   * `e2e/rfc319-agent-delete-and-refs.spec.ts` —— 同形状的四道拒删闸，但那是
//     **代理**；工作流的两条拒绝分支（`workflow-in-use` /
//     `workflow-scheduled-referenced`）在本文件之前全仓 e2e 零命中。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//   * WF-03 —— 列表是用户挑工作流的唯一界面。节点数错 ⇒ 用户凭「这个流程有多大」
//     去挑，挑到的却是另一个（RFC-311 C2 把 nodeCount 从「前端数 definition」改成
//     「服务端算」，那次改动之后前端拿到的是一个它无法自证的数字）；版本号错 ⇒
//     两个标签页里同一份工作流显示同一版，用户以为自己看的是最新的，实际在改旧的；
//     Private 徽章漏了 ⇒ 用户以为随手建的工作流只有自己看得见（或反过来，把私有的
//     当成全员可见而不去授权）；归属人漏了 ⇒ 多人实例里同名工作流分不清是谁的；
//     倒序错了 ⇒ 刚改完的工作流沉到列表底部，用户回到列表找不到自己刚才在弄的那个。
//   * WF-04 —— 工作流一多，搜索就是唯一的导航。搜不到 ⇒ 用户只能滚动翻页找；
//     无匹配时不给空态 ⇒ 一片空白，分不清「没匹配」还是「加载挂了」；不给「清空
//     搜索」或清空后不复原 / 不回焦 ⇒ 一次搜索就把列表弄丢了。
//   * WF-05 —— 三种非常态必须**长得不一样**。读不到却画成真空态 ⇒ 用户认定「我
//     没有工作流」，转身去重建一个已经存在的（这是本行最贵的一种红）；真空态不给
//     新建入口 ⇒ 新用户第一屏就是死路；重试按钮不真的重发请求 ⇒ 那是个装饰。
//   * WF-06 —— 卡片上的「启动」是从「我要跑这个」到「真的跑起来」最短的一条路。
//     深链丢了工作流 ⇒ 用户落到向导第一步还得自己再挑一次（在一个装了几十个工作流
//     的实例上，他多半会挑错）；预选了却停在第一步 ⇒ 白点一次。
//   * WF-08 —— 无写权用户看到一个**看起来能改**的编辑器，是产品在骗他：他拖了半天
//     画布，直到某次保存才吃 403。更糟的是那发自动保存本身——它会在用户毫无动作时
//     发出去（docs/audit-backlog.md:489-499 记的那一发）。所以判据不是「按钮灰了」，
//     是「那些控件根本不渲染」且「整场会话对这份工作流零写请求」。
//   * WF-48 —— 复制是只读授权者唯一的逃生出口（`acl.levelDescription.read` 逐字
//     写着 "view, use, reference, launch and copy"）。它坏掉 ⇒ 只读者除了求人升档
//     无路可走。而复制必须按**精确修订版**成立：围栏松掉 ⇒ 用户以为复制的是屏幕上
//     那一版，实际复制的是别人刚推上去的另一版，而且没有任何提示。
//   * WF-50 —— 删除是不可逆的。放行一个还被非终态任务引用的工作流 ⇒ 正在跑的任务
//     失去它的定义；放行一个还被定时任务引用的 ⇒ 那条**无人值守**的定时任务到点
//     只会失败，没有人在现场。反向也必须成立：引用解掉之后必须真的删得掉，否则
//     「引用拒删」就成了永久锁死。
//   * WF-51 —— 「授权给别人用但别让他改」是这套 ACL 存在的理由。授权后对方看不见
//     ⇒ 授权等于没做；对方看得见却能改 ⇒ 授权把内容交出去了；移交归属之后原主人
//     还能管权限 ⇒ 「移交」是假的；撤销之后对方还看得见 ⇒ 撤权是假的。撤销后的
//     直链还必须与「这个 id 从来不存在」逐字同形，否则 id 的存在性从错误信息里漏出去。
//   * WF-53 —— `aw-skill-fusion` 是框架自己要跑的基础设施，不是用户的一行。它出现
//     在列表里 ⇒ 用户会去改它 / 删它，把融合功能弄坏；判别式若退化成「按名字一刀切」
//     ⇒ 用户自建的同名工作流会跟着一起消失，而他完全不知道为什么（RFC-104 把判别式
//     从 owner+名字换成 `builtin` 列，正是为了让这两件事不再纠缠）。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/workflows.tsx:139-184           列表卡片投影（排序 / searchText / badges / meta / launch / testid）
//   packages/frontend/src/routes/workflows.tsx:189-199            createAction（workflow-new-button）
//   packages/frontend/src/routes/workflows.tsx:204-228            headerActions / emptyAction 的权限门与空态文案接线
//   packages/frontend/src/components/gallery/ResourceGalleryPage.tsx:114-123  loading / 真空态
//   packages/frontend/src/components/gallery/ResourceGalleryPage.tsx:125-156  gallery-count / gallery-search / 无匹配空态
//   packages/frontend/src/components/gallery/ResourceGalleryPage.tsx:90-102   clearSearch：清空 + 焦点还给搜索框
//   packages/frontend/src/components/gallery/GalleryCard.tsx:101-114          「启动」链接与 `${testid}-launch`
//   packages/frontend/src/components/ResourceBadges.tsx:28-40                 private chip + owner badge 的渲染条件
//   packages/frontend/src/lib/resource-card-filter.ts:15-20                   title / subtitle / searchText 三面过滤
//   packages/frontend/src/routes/workflows.edit.tsx:306-314                   canUpdate = 方法级权限点 ∧ 行级授权档
//   packages/frontend/src/routes/workflows.edit.tsx:389-415                   heal 自动保存的双重写权守卫
//   packages/frontend/src/routes/workflows.edit.tsx:766-811                   handleCopy：ensureSaved → 冻结修订版 → POST /copy
//   packages/frontend/src/routes/workflows.edit.tsx:1096-1103                 canUpdate 才渲染调色板轨
//   packages/frontend/src/routes/workflows.edit.tsx:1220-1291                 More 里五项各自的门
//   packages/frontend/src/routes/workflows.edit.tsx:1473-1484                 只读 / 治理拒绝码**不算**访问丢失
//   packages/frontend/src/components/AclPanel.tsx:395-423                     新加成员一律落 read 档
//   packages/frontend/src/components/AclPanel.tsx:497-539                     canManage 才有档位控件与移除键；否则只出档位 chip
//   packages/frontend/src/components/AclPanel.tsx:216-256                     save：带 OCC 围栏；移交后弹窗**不**关
//   packages/frontend/src/components/ConfirmDialog.tsx:96-108                 只有 fulfilled 才关；reject 留在原地并显错
//   packages/frontend/src/routes/tasks.new.tsx:274-283                        深链带对象时初始步落 STEP_SPACE
//   packages/frontend/src/routes/tasks.new.tsx:2282-2297                      wizard-object-<kind> 选择器
//   packages/backend/src/routes/workflows.ts:85-115                           GET /api/workflows：先剥 builtin，再按 ACL 过滤，服务端算 nodeCount
//   packages/backend/src/routes/workflows.ts:165-193                          POST /:id/copy 的权限点与序列化透镜
//   packages/backend/src/routes/workflows.ts:233-259                          DELETE 顺序：404 → 可见性 → builtin → 治理 → confirm → 业务闸
//   packages/backend/src/services/workflow.ts:263-333                         copyWorkflow：ACL → builtin → 精确修订版围栏 → 改名 → INSERT
//   packages/backend/src/services/workflow.ts:706-721                         workflow-in-use（只拦非终态任务）
//   packages/backend/src/services/workflow.ts:723-761                         workflow-scheduled-referenced（不看 enabled，按可见性披露名单）
//   packages/backend/src/services/workflow.ts:1057-1075                       assertPrincipalCanGovernInTx → resource-govern-owner-only
//   packages/backend/src/services/resourceAccessPolicy.ts:88-102              四值梯子 own > write > read > none
//   packages/backend/src/services/resourceAcl.ts:747-755                      移交归属时把前任 owner 自动补成 read 档
//   packages/backend/src/services/systemResources.ts:53-84                    isBuiltinRow / excludeBuiltinWorkflows / assertNotBuiltin
//   packages/backend/src/services/fusion.ts:398-450                           aw-skill-fusion 内建行的播种（每次启动幂等）
//   packages/backend/src/services/demoSeed.ts:100-101                         `.demo-seeded` 标记门
//   packages/shared/src/schemas/permission.ts:914-922                         guest 预设只有六类资源的 read
//   packages/shared/src/schemas/permission.ts:1030-1032                       user 预设自带 resource-acl:private（否则看不见授权）
//   packages/system-mocks/src/runtime/mode-slow.ts:62-73                      STUB_OPENCODE_HOLD_FILE：把「回合还在飞」做成确定性
//
// 执行模型：全文件共用一个 daemon。stub 用 `slow` 模式并挂上
// `STUB_OPENCODE_HOLD_FILE`：只有 WF-50 需要「一条**确定性**停在非终态的任务」，
// 它在动手前才把 hold 文件建出来；其余用例期间该文件不存在，stub 完全不受影响。
// 每条用例各自开一个新用户做夹具——RFC-231 起所有 canonical 创建路径都是
// creator-owner + private，加上 GET /api/workflows 会先剥掉 framework built-in，
// 所以「这个账号在列表里看到几条」永远只等于它自己种的那几条。
//
// 一处**刻意的环境设置**：daemon 跑在一个预先写好 `.demo-seeded` 标记的 home 上，
// 于是 RFC-307 的样例内容不会被种下。理由不是「样例碍事」，而是它把本文件要验的
// 状态**变得不可达**：两个样例工作流是 `__system__` 名下的 **public** 行
// （demoSeed.ts:365、:430），对每个账号都可见，于是任何账号的工作流列表都永远不为空
// ——WF-05 的真空态与 WF-03 / WF-04 的「看到的恰好是自己建的那几条」就再也走不到。
// 而「样例已经被删掉的实例」是产品明文支持的一等状态（demoSeed.ts:11-17 规则 1：
// deleted stays deleted），这里模拟的正是它。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

const PASSWORD = 'Rfc319WorkflowPass!1'

/** RFC-223 PR-4 的确定性内建 id（services/systemResources.ts:44）。 */
const BUILTIN_FUSION_WORKFLOW_ID = '00000000000000000000000002'
const BUILTIN_FUSION_WORKFLOW_NAME = 'aw-skill-fusion'

let daemon: DaemonHandle
let holdDir: string
let holdFile: string
let daemonHome: string
let sequence = 0

interface SeededUser {
  username: string
  userId: string
  token: string
}

interface WorkflowRow {
  id: string
  name: string
  description: string
  version: number
  updatedAt: number
  nodeCount?: number
  ownerUserId?: string | null
  visibility?: 'public' | 'private'
  builtin?: boolean
}

interface WorkflowDetailRow extends WorkflowRow {
  snapshotHash: string
  definition: Record<string, unknown>
}

interface RefusalBody {
  code: string
  message?: string
  details?: {
    referenceCount?: number
    scheduledCount?: number
    visibleScheduled?: Array<{ id: string; name: string }>
    hiddenCount?: number
  }
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

async function json<T>(
  token: string,
  path: string,
  init: RequestInit | undefined,
  what: string,
): Promise<T> {
  const res = await raw(token, path, init)
  expect(res.status < 400, `${what}: HTTP ${res.status} ${res.body}`).toBe(true)
  return JSON.parse(res.body) as T
}

/** 工作流写入面的 body 都需要一个合法 ULID 形状的 clientMutationId
 *  （schemas/workflow.ts:441-475）。 */
function newMutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = '01'
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

/** 每条用例一个专属短标签；工作流名与用户名共用它但**不互相包含**——
 *  WF-04 要证明「按归属人搜到的是 searchText 而不是标题」。 */
function nextTag(prefix: string): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

async function seedUser(tag: string, role: 'user' | 'guest' = 'user'): Promise<SeededUser> {
  const username = `rfc319w-u-${tag}`
  const created = await json<{ id: string }>(
    daemon.token,
    '/api/users',
    {
      method: 'POST',
      // 邮箱不是可选项：RFC-320 起任务的 git 提交身份取自创建者账号，缺邮箱的账号
      // 连启动都过不去。WF-50 要真的起一条任务。
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

/**
 * 一份只含 `count` 个 input 节点的合法定义。
 *
 * 刻意不放 agent 节点：`createWorkflow` 只做 schema 解析与引用检查
 * （services/workflow.ts:169-238），不跑图校验，所以这种最小定义能把「节点数」
 * 这个唯一被断言的量做成一个可自由拨动的旋钮，而不用为每个数字去建代理。
 */
function definitionWithInputs(count: number): Record<string, unknown> {
  return {
    $schema_version: 5,
    inputs: Array.from({ length: count }, (_unused, i) => ({
      kind: 'text',
      key: `k${i + 1}`,
      label: `K${i + 1}`,
      required: false,
    })),
    nodes: Array.from({ length: count }, (_unused, i) => ({
      id: `in_${i + 1}`,
      kind: 'input',
      inputKey: `k${i + 1}`,
      position: { x: i * 220, y: 0 },
    })),
    edges: [],
  }
}

async function seedWorkflow(
  owner: SeededUser,
  name: string,
  description: string,
  nodeCount: number,
): Promise<WorkflowDetailRow> {
  return json<WorkflowDetailRow>(
    owner.token,
    '/api/workflows',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
        definition: definitionWithInputs(nodeCount),
      }),
    },
    `seed workflow ${name}`,
  )
}

async function getWorkflow(token: string, id: string): Promise<WorkflowDetailRow> {
  return json<WorkflowDetailRow>(token, `/api/workflows/${id}`, undefined, `read workflow ${id}`)
}

async function listWorkflows(token: string): Promise<WorkflowRow[]> {
  return json<WorkflowRow[]>(token, '/api/workflows', undefined, 'list workflows')
}

/** 像编辑器那样保存一次：完整 draft snapshot + expectedVersion + clientMutationId。 */
async function saveWorkflow(
  owner: SeededUser,
  current: WorkflowDetailRow,
  next: { name?: string; description?: string; definition?: Record<string, unknown> },
): Promise<{ status: number; body: string }> {
  return raw(owner.token, `/api/workflows/${current.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      expectedVersion: current.version,
      clientMutationId: newMutationId(),
      snapshot: {
        name: next.name ?? current.name,
        description: next.description ?? current.description,
        definition: next.definition ?? current.definition,
      },
    }),
  })
}

async function deleteWorkflowRequest(
  actor: SeededUser,
  workflow: Pick<WorkflowRow, 'id' | 'name' | 'version'>,
): Promise<{ status: number; body: string }> {
  return raw(actor.token, `/api/workflows/${workflow.id}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: workflow.name,
      expectedVersion: workflow.version,
      clientMutationId: newMutationId(),
    }),
  })
}

/** 全量替换授权名单；`grants` 是 RFC-324 的载荷形状（不是旧的 `userIds`）。 */
async function putAcl(
  actor: SeededUser,
  workflowId: string,
  body: {
    visibility?: 'public' | 'private'
    grants?: Array<{ userId: string; level: 'read' | 'write' }>
    ownerUserId?: string
  },
): Promise<{ status: number; body: string }> {
  const acl = await json<{ resourceId: string; aclRevision: number }>(
    actor.token,
    `/api/workflows/${workflowId}/acl`,
    undefined,
    'read acl before write',
  )
  return raw(actor.token, `/api/workflows/${workflowId}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      ...body,
      expectedResourceId: acl.resourceId,
      expectedAclRevision: acl.aclRevision,
    }),
  })
}

/**
 * 把一条工作流转成公开，并登记到「用例结束后转回私有」的清单里。
 *
 * ⚠️ 公开行对**每一个**账号可见（`visibleRowsCondition` 的第一个析取项就是
 * `COALESCE(visibility,'public')='public'`，resourceAcl.ts:406-422）。本文件多条
 * 用例都断言「这个账号看到的恰好是它自己建的那几条」，所以任何一条用例留下的公开行
 * 都会把**后面每一条**用例的计数拧错。实测过这个形态：WF-03 转公开之后，WF-04 的
 * 首条计数断言从 3 变成 4；只跑 WF-04+WF-05 时 WF-05 又从 1 变成 2。症状是「换个
 * 顺序 / 换个子集跑，结果就不一样」——最难归因的那一种。
 *
 * 因此规矩是：用例之间不共享任何可见状态，谁转的公开谁负责转回去。
 */
async function makePublicForThisTest(owner: SeededUser, workflowId: string): Promise<void> {
  const res = await putAcl(owner, workflowId, { visibility: 'public' })
  expect(res.status, `把工作流 ${workflowId} 转公开失败：${res.body}`).toBe(200)
  publicisedInTest.push({ owner, id: workflowId })
}

const publicisedInTest: Array<{ owner: SeededUser; id: string }> = []

/** 只统计**这个账号名下**的工作流——被别人授权 / 公开给他的不算。 */
async function workflowsOwnedBy(user: SeededUser): Promise<WorkflowRow[]> {
  return (await listWorkflows(user.token)).filter((w) => w.ownerUserId === user.userId)
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

/** 卡片右下角的事实 chip（节点数 / 版本）。 */
async function metaChips(page: Page, name: string): Promise<string[]> {
  return page
    .getByTestId(`workflow-card-${name}`)
    .locator('.gallery-card__meta > span')
    .allTextContents()
}

/** 卡片标题下的归属 chip（Private 徽章 / 归属人）。 */
async function badgeChips(page: Page, name: string): Promise<string[]> {
  return page
    .getByTestId(`workflow-card-${name}`)
    .locator('.gallery-card__badges > *')
    .allTextContents()
}

/** 网格里卡片标题的**渲染顺序**。 */
async function cardOrder(page: Page): Promise<string[]> {
  return page.getByTestId('gallery-grid').locator('.gallery-card__name').allTextContents()
}

/**
 * 编辑器右上角 More，返回动作弹窗。
 *
 * 已经开着就不再点一次：弹窗的 overlay 会拦住 More 按钮的 pointer 事件，
 * 于是「连着看两项动作」这种再普通不过的用法会退化成一次 15s 的点击超时，
 * 而失败信息指向的是 helper 而不是判据。
 */
async function openWorkflowActions(page: Page) {
  const dialog = page.getByTestId('workflow-actions-dialog')
  if ((await dialog.count()) === 0) {
    await page.getByTestId('workflow-more-actions').click()
  }
  await expect(
    dialog,
    '编辑器 More 打不开 ⇒ 复制 / 改名 / 权限 / 删除四项一项都够不着',
  ).toBeVisible()
  return dialog
}

/** More → Permissions，返回权限弹窗。 */
async function openWorkflowAcl(page: Page) {
  await openWorkflowActions(page)
  await page.getByTestId('workflow-acl-button').click()
  const dialog = page.getByTestId('workflow-acl-dialog')
  await expect(dialog.getByTestId('acl-panel')).toBeVisible()
  return dialog
}

test.beforeAll(async () => {
  // hold 文件此刻**不存在** —— stub 只在文件存在时才扣住一回合
  // （mode-slow.ts:62-73），所以除 WF-50 外的用例完全不受影响。
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-wf-hold-'))
  holdFile = join(holdDir, 'hold')

  // 自带 home，并在 daemon 起来之前写下「样例已经提供过」的标记：见文件头
  // §执行模型。`home` 一旦由调用方提供，harness 就不再负责清理（keepHome），
  // 所以 afterAll 里自己删。
  daemonHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-wf-home-'))
  writeFileSync(join(daemonHome, '.demo-seeded'), `${String(Date.now())}\n`)

  daemon = await startDaemon({
    home: daemonHome,
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: holdFile },
  })
})

// 见 `makePublicForThisTest` 的注释：公开是**全局**可见状态，不许跨用例外溢。
// 用 raw 而不是 json：被转公开的工作流可能已经在用例里被删掉（或归属已移交），
// 那种情况下静默跳过即可——清理不该把一条已经绿了的用例弄红。
test.afterEach(async () => {
  for (const row of publicisedInTest.splice(0)) {
    const acl = await raw(row.owner.token, `/api/workflows/${row.id}/acl`)
    if (acl.status !== 200) continue
    const parsed = JSON.parse(acl.body) as { resourceId: string; aclRevision: number }
    await raw(row.owner.token, `/api/workflows/${row.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: parsed.resourceId,
        expectedAclRevision: parsed.aclRevision,
      }),
    })
  }
})

test.afterAll(async () => {
  try {
    rmSync(holdFile, { force: true })
  } catch {
    /* best-effort */
  }
  if (daemon !== undefined) await daemon.stop()
  for (const dir of [holdDir, daemonHome]) {
    try {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// WF-03
// ---------------------------------------------------------------------------

test('WF-03 工作流列表卡片：节点数 / 版本 / 私有徽章 / 归属人逐格正确，保存一次后节点数与版本跟着变且该卡排到最前', async ({
  browser,
}) => {
  const tag = nextTag('wf03')
  const owner = await seedUser(tag)
  const prefix = `rfc319w-${tag}`

  const alpha = await seedWorkflow(owner, `${prefix}-alpha`, 'Reads the release diff', 2)
  // 描述留空：卡片必须落到 `(no description)` 斜体兜底，而不是渲染一个空行——
  // 空行会让用户以为描述加载失败。
  const bravo = await seedWorkflow(owner, `${prefix}-bravo`, '', 1)
  const charlie = await seedWorkflow(owner, `${prefix}-charlie`, 'Merges shard results', 3)
  // charlie 转公开：Private 徽章必须是**有条件**渲染的，否则它等于一个常量装饰。
  await makePublicForThisTest(owner, charlie.id)

  // 服务端真值：这个账号看得见的**恰好**是它自己种的三条。这一格同时锁住两件事:
  // framework built-in（aw-skill-fusion）被 excludeBuiltinWorkflows 剥掉了,
  // 别的账号的私有工作流也照 ACL 过滤掉了。任何一边漏了，下面所有计数都会错。
  expect(
    (await listWorkflows(owner.token)).map((w) => w.name).sort(),
    '这个新账号看到的工作流不等于它自己建的三条 ⇒ 要么 framework 内建行漏进了用户列表，' +
      '要么别人的私有工作流对他可见',
  ).toEqual([alpha.name, bravo.name, charlie.name].sort())

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workflows`)

    await expect(
      page.getByTestId('gallery-count'),
      '页面上的条数与服务端可见集合对不上 ⇒ 用户看到的是一份残缺（或多出别人）的清单',
    ).toHaveText('3 items', { timeout: 60_000 })

    // (1) 事实 chip 逐格。断的是**整个数组**而不是 contains：多一格和少一格
    //     同样是事故（一个凭空的数字用户会当真，一个消失的数字用户会去别处猜）。
    await expect
      .poll(() => metaChips(page, alpha.name), { timeout: 30_000 })
      .toEqual([
        // 节点数是「这个流程有多大」的唯一速览，且 RFC-311 C2 之后它由**服务端**
        // 计算——前端无从自证，错了也不会有任何别的症状。
        '2 nodes',
        // 版本号错 ⇒ 两个标签页显示同一版，用户以为在改最新的，实际在改旧的。
        'v1',
      ])
    await expect
      .poll(() => metaChips(page, bravo.name), { timeout: 30_000 })
      .toEqual([
        // 单数形态单独锁一格：i18n 复数键漏了会渲染成 "1 nodes"，那是产品在说
        // 一句不通的话。
        '1 node',
        'v1',
      ])
    expect(await metaChips(page, charlie.name)).toEqual(['3 nodes', 'v1'])

    // (2) 归属 chip 逐格。
    expect(
      await badgeChips(page, alpha.name),
      '私有徽章或归属人掉了 ⇒ 用户以为随手建的工作流对全平台可见（或反过来），' +
        '多人实例里同名工作流也分不清是谁的',
    ).toEqual(['Private', owner.username])
    expect(
      await badgeChips(page, charlie.name),
      '公开工作流也挂着 Private 徽章 ⇒ 这个徽章是常量装饰，用户再也无法一眼分辨' +
        '哪些工作流是共享出去的',
    ).toEqual([owner.username])

    // (3) 描述与它的兜底。
    await expect(
      page.getByTestId(`workflow-card-${alpha.name}`).locator('.gallery-card__desc'),
      '卡片不显示描述 ⇒ 名字相近的一批工作流只能靠点进去逐个辨认',
    ).toHaveText('Reads the release diff')
    await expect(
      page.getByTestId(`workflow-card-${bravo.name}`).locator('.gallery-card__desc'),
      '没有描述时渲染成空行 ⇒ 用户以为描述加载失败，而不是「本来就没写」',
    ).toHaveText('(no description)')

    // (4) updatedAt 倒序：先证明当前渲染顺序**就是**服务端 updatedAt 的降序，
    //     再用一次真实保存把最旧的那条顶到最前——「刚改完的排最前」是用户回到列表
    //     时唯一依赖的定位方式。
    const expectedOrder = (await listWorkflows(owner.token))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((w) => w.name)
    expect(
      await cardOrder(page),
      '卡片顺序与服务端 updatedAt 降序不一致 ⇒ 列表的排序承诺是假的',
    ).toEqual(expectedOrder)

    // 把 alpha（最先建、因而最旧的一条）改一次：节点数 2 → 4、版本 1 → 2。
    const saved = await saveWorkflow(owner, alpha, {
      description: 'Reads the release diff (revised)',
      definition: definitionWithInputs(4),
    })
    expect(saved.status, `保存 alpha 失败：${saved.body}`).toBe(200)

    await page.reload()
    await expect(page.getByTestId('gallery-count')).toHaveText('3 items', { timeout: 60_000 })
    await expect
      .poll(() => metaChips(page, alpha.name), { timeout: 30_000 })
      .toEqual([
        // 服务端重算的节点数没跟上 ⇒ 用户改完流程回到列表，看到的仍是改动前的规模。
        '4 nodes',
        // 版本号没前进 ⇒ 用户无法判断自己手里这一版是不是最新的。
        'v2',
      ])
    expect(
      (await cardOrder(page))[0],
      '刚保存过的工作流没有排到最前 ⇒ 用户回到列表要在几十张卡片里重新找自己刚才在弄的那个',
    ).toBe(alpha.name)
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-04
// ---------------------------------------------------------------------------

test('WF-04 工作流列表搜索：按名称 / 描述 / 卡片可见事实过滤，无匹配给空态与「清空搜索」', async ({
  browser,
}) => {
  const tag = nextTag('wf04')
  const owner = await seedUser(tag)
  // 工作流名**不含**用户名：下面要用 owner 的显示名去搜，若名字里带着它，
  // 搜到就分不清是命中了标题还是命中了 searchText 里的归属人。
  const prefix = `rfc319w-${tag}`

  const alpha = await seedWorkflow(owner, `${prefix}-alpha`, 'Nightly regression sweep', 2)
  const bravo = await seedWorkflow(owner, `${prefix}-bravo`, 'Release note drafting', 1)
  const charlie = await seedWorkflow(owner, `${prefix}-charlie`, 'Shard result merging', 3)
  // 让 Private 成为一个**有区分力**的搜索词：三条里只有两条是私有的。
  await makePublicForThisTest(owner, charlie.id)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workflows`)

    const count = page.getByTestId('gallery-count')
    const search = page.getByTestId('gallery-search')
    await expect(count).toHaveText('3 items', { timeout: 60_000 })

    // (1) 按标题片段（最基本的那条路径）。
    await search.fill('-bravo')
    await expect(count, '按名字片段搜不到 ⇒ 搜索这条最基本的路径断了').toHaveText('1 item')
    await expect(
      page.getByTestId(`workflow-card-${alpha.name}`),
      '被过滤掉的卡片仍留在 DOM 里 ⇒ 搜索只是视觉遮挡，键盘 / 读屏用户照样会走到它',
    ).toHaveCount(0)
    await expect(page.getByTestId(`workflow-card-${bravo.name}`)).toHaveCount(1)

    // (2) 按描述里的词——名字里一个字都没有。
    await search.fill('regression')
    await expect(
      count,
      '按描述搜不到 ⇒ 用户凭「那个跑夜间回归的流程」去找，只能一张张翻卡片',
    ).toHaveText('1 item')
    await expect(page.getByTestId(`workflow-card-${alpha.name}`)).toHaveCount(1)

    // (3) 按**卡片上可见、标题与描述里都没有的事实**过滤——这是过滤器与「只搜标题」
    //     的分水岭。三条：节点数、私有徽章、归属人。
    await search.fill('3 nodes')
    await expect(
      count,
      '按节点数搜不到 ⇒ 过滤退化成只搜标题，卡片上写着的事实用户却搜不出来',
    ).toHaveText('1 item')
    await expect(page.getByTestId(`workflow-card-${charlie.name}`)).toHaveCount(1)

    await search.fill('Private')
    await expect(
      count,
      '按 Private 搜到的条数不等于私有工作流的条数 ⇒ 「哪些还没共享出去」这个问题在界面上无解',
    ).toHaveText('2 items')
    await expect(
      page.getByTestId(`workflow-card-${charlie.name}`),
      '公开的工作流也被 Private 搜了出来 ⇒ 可见性在过滤面上被混为一谈',
    ).toHaveCount(0)

    await search.fill(owner.username)
    await expect(
      count,
      '按归属人搜不到他名下的工作流 ⇒ 多人实例里「这几个是谁的」只能靠一格一格看',
    ).toHaveText('3 items')

    // (4) 无匹配：必须给空态 + 一键清空，而不是一片空白。
    await search.fill('zzz-no-such-workflow')
    const noMatches = page.getByTestId('gallery-no-matches')
    await expect(
      noMatches,
      '搜不到东西时页面一片空白 ⇒ 用户分不清是「没有匹配」还是「加载失败」',
    ).toBeVisible()
    await expect(noMatches).toContainText('No matches')
    await expect(
      page.getByTestId('workflows-empty'),
      '无匹配时却渲染成「你还没有工作流」⇒ 用户会去重建一个已经存在的工作流',
    ).toHaveCount(0)
    await expect(
      page.getByTestId('gallery-grid'),
      '无匹配空态与残留网格同时出现 ⇒ 界面自相矛盾',
    ).toHaveCount(0)
    await expect(count, '无匹配时条数没归零 ⇒ 那个数字与眼前的页面对不上').toHaveText('0 items')

    // (5) 清空搜索：列表复原 + 焦点回到搜索框（否则用户想重新输入还得再点一次）。
    const clear = noMatches.getByRole('button', { name: 'Clear search', exact: true })
    await expect(clear, '无匹配空态里没有「清空搜索」⇒ 用户只能手动全选删除输入框').toHaveCount(1)
    await clear.click()
    await expect(count, '清空搜索后列表没复原 ⇒ 一次搜索就把列表弄丢了').toHaveText('3 items')
    await expect(search, '清空后输入框里还留着旧关键词 ⇒ 「清空」名不副实').toHaveValue('')
    await expect(search, '清空后焦点没还给搜索框 ⇒ 用户想重新输入还得再点一次').toBeFocused()
    for (const row of [alpha, bravo, charlie]) {
      await expect(
        page.getByTestId(`workflow-card-${row.name}`),
        `清空搜索后 ${row.name} 没回来 ⇒ 过滤是有副作用的，列表被永久裁剪了`,
      ).toHaveCount(1)
    }
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-05
// ---------------------------------------------------------------------------

test('WF-05 工作流列表的加载 / 读不到 / 真空三态：各自长得不一样，且重试真的把列表拉回来', async ({
  browser,
}) => {
  const tag = nextTag('wf05')

  // ---- (A) 加载态与故障态：一个已经有工作流的账号 ------------------------
  const owner = await seedUser(tag)
  const only = await seedWorkflow(owner, `rfc319w-${tag}-only`, 'the only one', 1)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side

    // 只拦**集合**那一条；详情 / ACL / 用户名批查都必须原样放行，否则红掉时
    // 分不清是列表三态坏了还是别的请求被误伤。
    let mode: 'hold' | 'fail' | 'pass' = 'hold'
    let releaseHold: (() => void) | null = null
    const held = new Promise<void>((resolveHold) => {
      releaseHold = resolveHold
    })
    await page.route(
      (url) => url.pathname === '/api/workflows',
      async (route) => {
        if (mode === 'hold') await held
        if (mode === 'fail') {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'internal-error', message: 'injected list failure' }),
          })
          return
        }
        await route.continue()
      },
    )

    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(
      page.getByTestId('workflows-loading'),
      '列表还在飞的时候页面既没有加载态也没有内容 ⇒ 用户面对空白，会以为「我没有工作流」' +
        '而去重建一个',
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId('workflows-empty'),
      '还在加载就先把真空态画出来了 ⇒ 慢网络下每次打开列表都会先看到一句「你还没有工作流」',
    ).toHaveCount(0)

    mode = 'pass'
    expect(releaseHold, 'route 处理器没有装上 ⇒ 上面的加载态断言是空洞绿').not.toBeNull()
    ;(releaseHold as unknown as () => void)()
    await expect(page.getByTestId('gallery-count')).toHaveText('1 item', { timeout: 60_000 })
    await expect(page.getByTestId(`workflow-card-${only.name}`)).toHaveCount(1)

    // ---- 故障态 -----------------------------------------------------------
    mode = 'fail'
    await page.reload()
    const banner = page.getByRole('alert').first()
    await expect(
      banner,
      '列表读失败却没有任何提示 ⇒ 用户面对空列表，会认定「我没有工作流」',
    ).toBeVisible({ timeout: 60_000 })
    await expect(banner, '故障横幅不说是什么故障 ⇒ 用户既不知道该重试还是该找管理员').toContainText(
      'Internal server error.',
    )
    await expect(
      page.getByTestId('workflows-empty'),
      '读不到被画成了真空态 ⇒ 用户会去重建一个已经存在的工作流，然后撞重名；' +
        '这是本行最贵的一种红',
    ).toHaveCount(0)
    await expect(
      page.getByTestId('gallery-count'),
      '读不到却还报了个条数 ⇒ 那个数字是凭空的，用户会当真',
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`workflow-card-${only.name}`),
      '故障态下还渲染出卡片 ⇒ 显示的是过期缓存却没有任何标记',
    ).toHaveCount(0)

    // 重试必须**真的重发请求**并把列表拉回来——只摆一个按钮等于没有恢复路径。
    mode = 'pass'
    await banner.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      page.getByTestId('gallery-count'),
      '点了重试列表没回来 ⇒ 这个按钮是装饰，用户只能刷新整页（还未必知道可以）',
    ).toHaveText('1 item', { timeout: 30_000 })
    await expect(
      page.getByRole('alert'),
      '恢复之后故障横幅还挂着 ⇒ 用户不敢相信眼前这份列表是新的',
    ).toHaveCount(0)
  } finally {
    await side.context.close()
  }

  // ---- (B) 真空态（一条工作流都没有的新账号）------------------------------
  const newcomer = await seedUser(nextTag('wf05e'))
  const fresh = await openAs(browser, newcomer.token)
  try {
    const { page } = fresh
    await page.goto(`${daemon.baseUrl}/workflows`)
    const empty = page.getByTestId('workflows-empty')
    await expect(
      empty,
      '新账号打开工作流页没有任何空态 ⇒ 第一屏是一片空白，用户不知道下一步该做什么',
    ).toBeVisible({ timeout: 60_000 })
    await expect(empty).toContainText('No workflows yet.')
    await expect(
      empty,
      '真空态少了引导说明 ⇒ 用户知道「没有」，但不知道工作流是用来干什么的',
    ).toContainText('Create a reusable automation, then refine its nodes and connections.')
    await expect(
      page.getByTestId('gallery-search'),
      '一条都没有还摆着搜索框 ⇒ 用户点进去搜什么都搜不到，以为界面坏了',
    ).toHaveCount(0)
    await expect(
      empty.getByRole('button', { name: 'Clear search', exact: true }),
      '真空态也挂着「清空搜索」⇒ 用户点了什么都不会发生（与无匹配空态混成了一种）',
    ).toHaveCount(0)

    // 真空态里的新建入口必须**可点且真的打开创建弹窗**——只渲染一个按钮不算出路。
    const newButton = page.getByTestId('workflow-new-button')
    await expect(newButton, '空列表上找不到新建入口 ⇒ 新用户第一屏就是死路').toBeVisible()
    await newButton.click()
    await expect(
      page.getByTestId('workflow-create-dialog'),
      '真空态的新建按钮点了没反应 ⇒ 新用户在第一屏就被卡死，且无从判断是自己点错了',
    ).toBeVisible()
  } finally {
    await fresh.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-06
// ---------------------------------------------------------------------------

test('WF-06 卡片「启动」深链：跳到任务向导且工作流已预选，不用再挑一次', async ({ browser }) => {
  const tag = nextTag('wf06')
  const owner = await seedUser(tag)
  const target = await seedWorkflow(owner, `rfc319w-${tag}-target`, 'launched from the card', 1)
  // 第二条只为制造「挑错的可能」：预选若丢了，用户回到第一步面对的是一个多选项的
  // 下拉，而不是一个显而易见的唯一答案。
  const decoy = await seedWorkflow(owner, `rfc319w-${tag}-decoy`, 'must not be preselected', 1)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workflows`)
    const launch = page.getByTestId(`workflow-card-${target.name}-launch`)
    await expect(
      launch,
      '卡片上没有「启动」⇒ 用户要先点进编辑器再找启动键，从「我要跑这个」到跑起来多了两步',
    ).toBeVisible({ timeout: 60_000 })
    await launch.click()

    await page.waitForURL(/\/tasks\/new/, { timeout: 30_000 })
    const search = new URL(page.url()).searchParams
    expect(
      search.get('kind'),
      '深链没带执行方式 ⇒ 向导会落到默认那一档，用户点的是「启动这个工作流」，' +
        '到手的却是另一种任务',
    ).toBe('workflow')
    expect(
      search.get('workflow'),
      '深链没带工作流 id ⇒ 用户落到向导还得自己再挑一次；装了几十个工作流的实例上他多半会挑错',
    ).toBe(target.id)

    // 带对象的深链必须**跳过**第一步（tasks.new.tsx:274-283）：停在第一步等于白点一次。
    await expect(
      page.getByTestId('task-wizard'),
      '向导没渲染出来 ⇒ 「启动」把用户送到了一个空白页',
    ).toBeVisible({ timeout: 30_000 })
    const back = page.getByTestId('stepper-back')
    await expect(
      back,
      '深链之后仍停在第一步（没有「上一步」可点）⇒ 预选等于没做，用户还是要自己挑一次',
    ).toBeVisible()

    // 退回第一步，确认预选**真的**落在这个工作流上，而不是只在 URL 里躺着。
    await back.click()
    const picker = page.getByTestId('wizard-object-workflow')
    await expect(picker, '第一步没有工作流选择器 ⇒ 无法复核预选到底落在谁身上').toBeVisible()
    await expect(
      picker,
      '选择器里显示的不是卡片上那个工作流 ⇒ 用户会照着向导一路点下去，跑起来的却是别的流程',
    ).toContainText(target.name)
    await expect(picker, '选择器里显示的是另一个工作流 ⇒ 深链把用户送错了对象').not.toContainText(
      decoy.name,
    )
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-08
// ---------------------------------------------------------------------------

test('WF-08 无 workflows:create/update 权限：列表没有新建入口，编辑器只读且整场零写请求', async ({
  browser,
}) => {
  const tag = nextTag('wf08')
  const owner = await seedUser(tag)
  const guest = await seedUser(nextTag('wf08g'), 'guest')
  const shared = await seedWorkflow(owner, `rfc319w-${tag}-shared`, 'readable by everyone', 2)
  // guest 预设没有 `resource-acl:private`，所以只有 public 行对他可见
  // （permission.ts:914-922 / resourceAccessPolicy.ts:99）。
  await makePublicForThisTest(owner, shared.id)

  const side = await openAs(browser, guest.token)
  try {
    const { page } = side

    // 整场会话里，任何对**工作流域**的写请求都记下来。全程必须一条都没有。
    const writes: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (!pathname.startsWith('/api/workflows')) return
      const method = request.method()
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
      writes.push(`${method} ${pathname}`)
    })

    // ---- 列表面 -----------------------------------------------------------
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(
      page.getByTestId(`workflow-card-${shared.name}`),
      '公开工作流对无写权用户不可见 ⇒ 只读账号连「看」都做不到，权限档位失去意义',
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId('workflow-new-button'),
      '没有创建权限却渲染新建入口 ⇒ 用户填完一整个表单才在提交时吃 403',
    ).toHaveCount(0)
    await expect(
      page.getByTestId(`workflow-card-${shared.name}-launch`),
      'guest 没有 tasks:execute 却看得到「启动」⇒ 点下去落到一个他无权提交的向导',
    ).toHaveCount(0)

    // ---- 编辑器面 ---------------------------------------------------------
    await page.goto(`${daemon.baseUrl}/workflows/${shared.id}`)
    await expect(page.getByRole('heading', { name: shared.name, exact: true })).toBeVisible({
      timeout: 60_000,
    })
    await expect(
      page.getByTestId('workflow-readonly-badge'),
      '只读用户看不到任何只读说明 ⇒ 他会以为界面坏了（拖不动、改不了，却没人告诉他为什么）',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.locator('.editor-sidebar'),
      '只读编辑器仍渲染出节点调色板 ⇒ 用户拖一个节点上去，得到的是一个永远保存不了的草稿',
    ).toHaveCount(0)
    await expect(
      page.getByTestId('workflow-undo'),
      '只读编辑器仍渲染撤销 / 重做 ⇒ 那两个键操作的是一份没人会接收的本地改动',
    ).toHaveCount(0)
    await expect(page.getByTestId('workflow-redo')).toHaveCount(0)
    await expect(
      page.getByTestId('workflow-validate'),
      'guest 没有 workflows:execute 却看得到「校验」⇒ 点下去只会拿到 403',
    ).toHaveCount(0)

    // 点一下画布上的节点：只读态下不能弹出任何可编辑的 Inspector。
    const node = page.locator('.canvas-node').first()
    await expect(node, '画布没渲染出节点 ⇒ 下面的 Inspector 断言会变成空洞绿').toBeVisible({
      timeout: 30_000,
    })
    await node.click()
    await expect(
      page.locator('[data-inspector-content]'),
      '只读用户点节点仍打开 Inspector ⇒ 他会在里面改一通字段，直到保存才发现全部白改',
    ).toHaveCount(0)
    await expect(page.getByTestId('workflow-editor-inspector-surface')).toHaveCount(0)

    // More 里只应剩下导出：改名 / 删除 / 权限 / 复制四项都够不着。
    const actions = await openWorkflowActions(page)
    await expect(
      actions.getByTestId('workflow-rename-button'),
      '无写权用户点得到「改名」⇒ 那是一个必然 403 的按钮',
    ).toHaveCount(0)
    await expect(
      actions.getByTestId('workflow-delete-button'),
      '无删除权用户点得到「删除」⇒ 最不可逆的动作挂在一个没有权限的账号上',
    ).toHaveCount(0)
    await expect(
      actions.getByTestId('workflow-acl-button'),
      '无 workflows:update 却点得到「权限」⇒ 面板打开也存不了，是个坏掉的入口',
    ).toHaveCount(0)
    await expect(
      actions.getByTestId('workflow-copy-action'),
      '无 workflows:create 却点得到「复制」⇒ 复制会在 POST 时 403',
    ).toHaveCount(0)
    await expect(
      actions.getByTestId('export-package-workflow'),
      '只读用户连导出都没有 ⇒ More 是一个空菜单，那个按钮不如不放',
    ).toBeVisible()

    // ---- 整场零写请求 ------------------------------------------------------
    // 「只读」不是「按钮灰了」，是「一发写请求都没有」。heal 自动保存在用户毫无
    // 动作时就会发出去（workflows.edit.tsx:389-415 的双重守卫正是为它加的），
    // 所以这条断言必须覆盖**整场会话**，而不是某一次点击。
    await page.waitForTimeout(2_000)
    expect(
      writes,
      '无写权用户的会话里出现了对工作流的写请求 ⇒ 那多半是打开页面就自动发出的 heal 保存，' +
        '用户什么都没做就吃一个 403（文案还说这份工作流可能已删除）',
    ).toEqual([])
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-48
// ---------------------------------------------------------------------------

test('WF-48 只读授权者另存为私有副本：精确修订版围栏拦下陈旧复制，成功的副本归自己且原作者看不见', async ({
  browser,
}) => {
  const tag = nextTag('wf48')
  const alice = await seedUser(`${tag}-a`)
  const carol = await seedUser(`${tag}-c`)
  const source = await seedWorkflow(alice, `rfc319w-${tag}-source`, 'alice keeps the original', 2)
  const granted = await putAcl(alice, source.id, {
    grants: [{ userId: carol.userId, level: 'read' }],
  })
  expect(granted.status, `授权 carol 失败：${granted.body}`).toBe(200)

  // ---- (A) 精确修订版围栏：版本对、哈希错，也必须整笔拒绝 -----------------
  // RFC-199 B3 的原话是「版本单独不足以做防御性对账」。围栏若只比版本，
  // 用户复制的就可能是一份与屏幕上不同的内容，而且没有任何提示。
  const current = await getWorkflow(carol.token, source.id)
  const tamperedHash = `${current.snapshotHash.startsWith('a') ? 'b' : 'a'}${current.snapshotHash.slice(1)}`
  const staleCopy = await raw(carol.token, `/api/workflows/${source.id}/copy`, {
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: current.version,
      expectedSnapshotHash: tamperedHash,
    }),
  })
  expect(
    staleCopy.status,
    '版本号对上、内容哈希对不上也照复制 ⇒ 围栏只比了版本，用户复制到的可能是另一份内容',
  ).toBe(409)
  expect((JSON.parse(staleCopy.body) as RefusalBody).code).toBe('resource-operation-stale')
  expect(
    (await workflowsOwnedBy(carol)).length,
    '被拒的复制仍然建出了一行 ⇒ 围栏检查跑在写入之后',
  ).toBe(0)

  // ---- (B) 浏览器面：在途复制遭遇并发保存，错误必须停在弹窗里 -------------
  const side = await openAs(browser, carol.token)
  try {
    const { page } = side

    // carol 是只读授权者：整场会话对**源工作流**的写请求必须为零。
    // 「另存为副本」正是 RFC-324 给她的逃生出口，它不能顺手把源工作流写脏。
    const sourceWrites: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname !== `/api/workflows/${source.id}`) return
      const method = request.method()
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
      sourceWrites.push(`${method} ${pathname}`)
    })

    await page.goto(`${daemon.baseUrl}/workflows/${source.id}`)
    await expect(
      page.getByTestId('workflow-readonly-badge'),
      '只读授权者的编辑器没有落到只读态 ⇒ 后面「复制是他唯一出路」的前提就不成立',
    ).toBeVisible({ timeout: 60_000 })

    // 复制的入口挂 `workflows:create`，**不**挂行级写权——这是只读者唯一的出路。
    let actions = await openWorkflowActions(page)
    await expect(
      actions.getByTestId('workflow-copy-action'),
      '只读授权者连「复制」都没有 ⇒ 除了求人升档他无路可走，' +
        '而 acl.levelDescription.read 逐字承诺了 copy',
    ).toBeVisible()

    // 真实竞态：把这一发 POST 扣在网络层，期间由 alice 推进一次版本，再放行。
    // 客户端此刻手里的 expectedVersion 已经过期——这是「屏幕上那一版」与「服务端
    // 那一版」分叉的确切时刻。
    let raced = false
    await page.route(
      (url) => url.pathname === `/api/workflows/${source.id}/copy`,
      async (route) => {
        if (raced || route.request().method() !== 'POST') {
          await route.continue()
          return
        }
        raced = true
        const bumped = await saveWorkflow(alice, await getWorkflow(alice.token, source.id), {
          description: 'alice edits it while carol is copying',
        })
        expect(bumped.status, `制造并发保存失败：${bumped.body}`).toBe(200)
        await route.continue()
      },
    )

    await actions.getByTestId('workflow-copy-action').click()
    // 按 class 而不是 role：编辑器整棵树都在 `ManagedLiveRegionProvider` 里，
    // NoticeBanner 在那种情况下**故意不挂** `role="alert"`（改由统一的 live region
    // 播报，见 NoticeBanner.tsx:103），所以 `getByRole('alert')` 在编辑器内一定落空。
    const copyBanner = actions.locator('.notice-banner--error')
    await expect(
      copyBanner,
      '复制被服务端拒绝，弹窗里却什么都不显示 ⇒ 用户看到的是「点了没反应」，' +
        '他会再点一次（或者以为已经复制好了）',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      copyBanner,
      '拒绝原因不说是「资源已变化」⇒ 用户不知道该刷新重来，只会反复点同一个按钮',
    ).toContainText('The resource changed since this operation started; refresh and retry.')
    expect(new URL(page.url()).pathname, '复制失败却把用户导航走了 ⇒ 他会以为副本已经建好了').toBe(
      `/workflows/${source.id}`,
    )
    expect(
      (await workflowsOwnedBy(carol)).length,
      '被拒的复制仍然建出了一行 ⇒ 用户手里多了一份他并不知情、内容也不确定的副本',
    ).toBe(0)

    // ---- (C) 刷新后重来：副本归自己、私有、v1，且原作者看不见 -------------
    await page.unroute((url) => url.pathname === `/api/workflows/${source.id}/copy`)
    await page.reload()
    await expect(page.getByTestId('workflow-readonly-badge')).toBeVisible({ timeout: 60_000 })
    actions = await openWorkflowActions(page)
    const copyResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/workflows/${source.id}/copy`,
    )
    await actions.getByTestId('workflow-copy-action').click()
    expect(
      (await copyResponse).status(),
      '刷新之后同一笔复制还是不放行 ⇒ 「围栏拒绝」变成了永久锁死，只读者永远拿不到副本',
    ).toBe(201)

    const copies = await workflowsOwnedBy(carol)
    expect(copies.length, '复制成功了但 carol 名下没有这一行 ⇒ 副本没落到她名下').toBe(1)
    const copy = copies[0] as WorkflowRow
    expect(
      copy.ownerUserId,
      '副本的归属人不是复制的人 ⇒ 他改不了自己刚复制出来的东西（治理权仍在原主人手上）',
    ).toBe(carol.userId)
    expect(
      copy.visibility,
      '副本默认公开 ⇒ 一次「另存为副本」把别人的私有工作流内容广播给了全平台',
    ).toBe('private')
    expect(copy.version, '副本不是从 v1 开始 ⇒ 它带着源工作流的历史，版本号失去意义').toBe(1)
    expect(
      copy.name,
      '副本没有可区分的名字 ⇒ 列表里出现两行同名工作流，用户分不清哪个是自己的',
    ).toBe(`${source.name}-copy`)
    await expect(page, '复制成功后没有跳到副本 ⇒ 用户以为什么都没发生，回头会再复制一次').toHaveURL(
      `${daemon.baseUrl}/workflows/${copy.id}`,
    )
    await expect(
      page.getByTestId('workflow-readonly-badge'),
      '自己的副本还是只读 ⇒ 这个逃生出口通向的是另一间同样锁着的屋子',
    ).toHaveCount(0, { timeout: 30_000 })

    expect(
      (await raw(alice.token, `/api/workflows/${copy.id}`)).status,
      '原作者看得见别人复制出去的私有副本 ⇒ 复制把 ACL 一起继承过来了',
    ).toBe(404)

    expect(
      sourceWrites,
      '只读授权者的复制过程往源工作流发了写请求 ⇒ 「另存为副本」把别人的原件改脏了',
    ).toEqual([])
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-50
// ---------------------------------------------------------------------------

test('WF-50 删除被引用的工作流：非终态任务与定时任务各自拒绝并说明原因，解引用后才放行', async ({
  browser,
}) => {
  // 这条用例要真的起一个任务并把它扣在运行中，比其余用例慢一些。实测墙钟仍在个位数
  // 秒级（本机 ~4s），所以它留在 PR 腿：与它同形的 `rfc319-agent-delete-and-refs.spec.ts`
  // 的 AGENT-11（同样起真任务 + hold 文件）也在 PR 腿。预算给到 240s 是为了兜住
  // 负载中的 CI 机器，不是这条用例的正常耗时。
  test.setTimeout(240_000)

  const tag = nextTag('wf50')
  const owner = await seedUser(tag)
  const prefix = `rfc319w-${tag}`

  const agent = await json<{ id: string }>(
    owner.token,
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-agent`,
        description: 'RFC-319 workflow-in-use fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    },
    'seed agent',
  )
  const workflow = await json<WorkflowDetailRow>(
    owner.token,
    '/api/workflows',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-flow`,
        description: 'RFC-319 workflow delete-refusal fixture',
        definition: {
          $schema_version: 5,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'agent_1',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: `${prefix}-agent`,
              promptTemplate: 'Explain {{topic}} briefly.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
              position: { x: 640, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_agent',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'agent_1', portName: 'topic' },
            },
            {
              id: 'e_agent_out',
              source: { nodeId: 'agent_1', portName: 'answer' },
              target: { nodeId: 'out_1', portName: 'answer' },
            },
          ],
        },
      }),
    },
    'seed workflow',
  )

  // ---- (A) 非终态任务 ----------------------------------------------------
  // 先把一条任务**确定性**地扣在非终态：stub 起来后先落 `<hold>.started`
  // 再进等待循环（mode-slow.ts:62-73），看到它就说明这一回合确实在飞，不靠 sleep 猜时序。
  //
  // `.started` 先删掉：hold 的 env 是**整个 daemon**的，任何一次 stub 调用都会落这个
  // 文件。今天本文件只有这一处起任务，所以它必然是新鲜的；但只要以后有人在前面加一条
  // 会跑 agent 的用例，下面那条 poll 就会立刻返回 true，而「任务确实还在飞」这个前提
  // 就悄悄没了（之后的 409 断言仍然会因为任务已终态而红，只是红在离原因很远的地方）。
  rmSync(`${holdFile}.started`, { force: true })
  writeFileSync(holdFile, '')
  const task = await json<{ id: string; status: string }>(
    owner.token,
    '/api/tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow.id,
        name: `${prefix}-live-task`,
        scratch: true,
        inputs: { topic: 'holding this turn open' },
      }),
    },
    'launch workflow task',
  )
  await expect
    .poll(() => existsSync(`${holdFile}.started`), {
      timeout: 150_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true)
  const live = await json<{ status: string }>(
    owner.token,
    `/api/tasks/${task.id}`,
    undefined,
    'read live task',
  )
  expect(
    ['pending', 'running'],
    `任务没有停在非终态（实际 ${live.status}）⇒ 下面的「拒删」断言会变成空洞绿`,
  ).toContain(live.status)

  const refusedByTask = await deleteWorkflowRequest(owner, workflow)
  expect(
    refusedByTask.status,
    '还有任务在跑的工作流也能删 ⇒ 那条任务当场失去它的定义，用户看到的是一条无法解释的失败',
  ).toBe(409)
  expect((JSON.parse(refusedByTask.body) as RefusalBody).code).toBe('workflow-in-use')
  expect(
    (await raw(owner.token, `/api/workflows/${workflow.id}`)).status,
    '被拒的删除还是把工作流删了 ⇒ 引用检查跑在删除之后',
  ).toBe(200)

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workflows/${workflow.id}`)
    await expect(page.getByRole('heading', { name: workflow.name, exact: true })).toBeVisible({
      timeout: 60_000,
    })

    const openDeleteConfirm = async () => {
      await openWorkflowActions(page)
      await page.getByTestId('workflow-delete-button').click()
      const dialog = page.getByRole('dialog', { name: 'Delete workflow' })
      await expect(dialog).toBeVisible()
      await page.getByTestId('confirm-input').fill(workflow.name)
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      return dialog
    }

    let dialog = await openDeleteConfirm()
    await expect(
      dialog,
      '拒删之后对话框自己关了 ⇒ 用户看不到失败原因，只看到「什么都没发生」',
    ).toBeVisible()
    await expect(
      dialog,
      '界面上不说是「还有任务在引用」⇒ 用户会以为是权限或系统故障，跑去问管理员',
    ).toContainText('Tasks still reference this workflow; it cannot be deleted.')
    await expect(
      dialog,
      '下一步提示掉了 ⇒ 用户知道被拦，但要自己猜「先把那些任务收拾掉」',
    ).toContainText('Delete the referencing tasks first.')
    expect(new URL(page.url()).pathname, '拒删之后却离开了编辑器 ⇒ 用户以为删成功了').toBe(
      `/workflows/${workflow.id}`,
    )
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // 任务落终态后这道闸必须放行——终态任务的工作流快照已冻结，继续拦着
    // 就是把工作流永久锁死。
    await json(owner.token, `/api/tasks/${task.id}/cancel`, { method: 'POST' }, 'cancel live task')
    rmSync(holdFile, { force: true })
    await expect
      .poll(
        async () =>
          (
            await json<{ status: string }>(
              owner.token,
              `/api/tasks/${task.id}`,
              undefined,
              'poll task',
            )
          ).status,
        { timeout: 120_000, intervals: [250, 500, 1000] },
      )
      .toMatch(/^(done|failed|canceled|interrupted)$/)

    // ---- (B) 定时任务 -----------------------------------------------------
    // 刻意用**停用**的定时任务：①它绝不会在用例期间自己触发，从而把这道闸与上面
    // 那条非终态任务闸彻底隔开；②它同时锁住一条更强的语义——引用判定不看 enabled。
    // 停用只是「现在不跑」，随时可以重新启用，那时引用早已悬空。
    const schedule = await json<{ id: string; name: string }>(
      owner.token,
      '/api/scheduled-tasks',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `${prefix}-nightly`,
          launchKind: 'workflow',
          enabled: false,
          scheduleSpec: { kind: 'monthly', dayOfMonth: 28, at: '03:00', timezone: 'UTC' },
          launchPayload: {
            workflowId: workflow.id,
            name: `${prefix}-nightly-run`,
            scratch: true,
            inputs: { topic: 'scheduled' },
          },
        }),
      },
      'seed scheduled task',
    )

    const refusedBySchedule = await deleteWorkflowRequest(
      owner,
      await getWorkflow(owner.token, workflow.id),
    )
    expect(
      refusedBySchedule.status,
      '被定时任务引用的工作流也能删 ⇒ 到点触发只会失败，而定时任务是无人值守的，' +
        '没有人会看到那次失败',
    ).toBe(409)
    const scheduleBody = JSON.parse(refusedBySchedule.body) as RefusalBody
    expect(scheduleBody.code).toBe('workflow-scheduled-referenced')
    expect(
      scheduleBody.details?.visibleScheduled?.map((s) => s.name),
      '不说是哪条定时任务在引用 ⇒ 用户要在定时列表里一条条翻 payload 才能找到',
    ).toEqual([schedule.name])
    expect(
      scheduleBody.details?.hiddenCount,
      '把看不见的引用也算成 0 ⇒ 用户按名单改完仍然删不掉，且完全不知道为什么',
    ).toBe(0)

    await page.reload()
    await expect(page.getByRole('heading', { name: workflow.name, exact: true })).toBeVisible({
      timeout: 60_000,
    })
    dialog = await openDeleteConfirm()
    await expect(
      dialog,
      '界面上不说是「定时任务还指着它」⇒ 用户翻遍任务列表也找不到原因',
    ).toContainText('This workflow is still referenced by scheduled task(s)')
    await expect(dialog, '拒绝信息里不点名那条定时任务 ⇒ 用户无从下手').toContainText(
      `Referenced by: ${schedule.name}.`,
    )
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // ---- (C) 负向对照：引用都解掉之后必须真的删得掉 -----------------------
    const scheduleGone = await raw(owner.token, `/api/scheduled-tasks/${schedule.id}`, {
      method: 'DELETE',
    })
    expect(scheduleGone.status, `删除夹具定时任务失败：${scheduleGone.body}`).toBe(204)

    await page.reload()
    await expect(page.getByRole('heading', { name: workflow.name, exact: true })).toBeVisible({
      timeout: 60_000,
    })
    await openWorkflowActions(page)
    await page.getByTestId('workflow-delete-button').click()
    const finalDialog = page.getByRole('dialog', { name: 'Delete workflow' })
    await page.getByTestId('confirm-input').fill(workflow.name)
    await finalDialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      page,
      '引用全部解掉之后还是删不掉 ⇒ 「引用拒删」变成永久锁死，这个工作流再也清理不了',
    ).toHaveURL(/\/workflows(\?.*)?$/, { timeout: 30_000 })
    expect(
      (await raw(owner.token, `/api/workflows/${workflow.id}`)).status,
      '界面跳走了但服务端还在 ⇒ 「删除」只是前端把它藏起来了',
    ).toBe(404)
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-51
// ---------------------------------------------------------------------------

test('WF-51 工作流权限面板：授权让对方看得见但改不动、移交归属把治理权换手、撤销后回到与不存在同形', async ({
  browser,
}) => {
  const tag = nextTag('wf51')
  const alice = await seedUser(`${tag}-a`)
  const carol = await seedUser(`${tag}-c`)
  const wf = await seedWorkflow(alice, `rfc319w-${tag}-flow`, 'alice owns this', 2)

  const aliceSide = await openAs(browser, alice.token)
  const carolSide = await openAs(browser, carol.token)
  try {
    const alicePage = aliceSide.page
    const carolPage = carolSide.page

    // ---- (1) 授权之前：陌生人既看不见，直链也与「不存在」逐字同形 ---------
    await carolPage.goto(`${daemon.baseUrl}/workflows`)
    await expect(
      carolPage.getByTestId('workflows-empty'),
      'carol 的列表不是空的 ⇒ 夹具前提不成立（她本来就不该看见任何东西）',
    ).toBeVisible({ timeout: 60_000 })

    const denialShownTo = async (id: string): Promise<string> => {
      await carolPage.goto(`${daemon.baseUrl}/workflows/${id}`)
      const banner = carolPage.getByRole('alert').first()
      await expect(banner).toBeVisible({ timeout: 30_000 })
      // 名字不得出现在任何位置（标题、面包屑、错误详情）。
      await expect(carolPage.getByText(wf.name)).toHaveCount(0)
      return (await banner.innerText()).trim()
    }
    const hiddenButReal = await denialShownTo(wf.id)
    const neverExisted = await denialShownTo('01JZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(
      hiddenButReal,
      '私有工作流的直链必须与「这个 id 从来不存在」逐字同形；两者一旦不同，' +
        'id 的存在性就从错误信息里泄漏出去了（403 本身就是「它存在」的信号）',
    ).toBe(neverExisted)

    // ---- (2) alice 在面板里把 carol 加进来 --------------------------------
    await alicePage.goto(`${daemon.baseUrl}/workflows/${wf.id}`)
    const aclDialog = await openWorkflowAcl(alicePage)
    // 用完整用户名搜：本文件每条用例都种用户，共同前缀会命中一大票人，
    // 结果列表一旦被截断，要点的那一条就不在里面了。
    await aclDialog.getByTestId('acl-members-input').fill(carol.username)
    // 结果列表是 portal 到 document.body 的，所以按 page 而不是 dialog 定位。
    await alicePage.getByTestId(`acl-members-option-${carol.username}`).click()
    await alicePage.getByTestId('acl-save').click()
    await expect(
      alicePage.getByTestId('acl-panel'),
      '保存成功后弹窗还挂着 ⇒ 用户不知道到底存没存上，会再点一次',
    ).toHaveCount(0)

    // ---- (3) 被授权者：看得见、进得去、改不动 ------------------------------
    await carolPage.goto(`${daemon.baseUrl}/workflows`)
    await expect(
      carolPage.getByTestId(`workflow-card-${wf.name}`),
      '授权之后对方的列表里还是没有这张卡片 ⇒ 授权等于没做，用户会反复重授',
    ).toBeVisible({ timeout: 60_000 })
    expect(
      await badgeChips(carolPage, wf.name),
      '别人共享给我的工作流不标出归属人 ⇒ 我看到一份来路不明的东西，出问题也不知道找谁',
    ).toEqual(['Private', alice.username])

    await carolPage.goto(`${daemon.baseUrl}/workflows/${wf.id}`)
    await expect(
      carolPage.getByTestId('workflow-readonly-badge'),
      '被授权者的编辑器没有只读标记 ⇒ 他会改一通，直到保存才发现全部白改',
    ).toBeVisible({ timeout: 60_000 })
    let carolActions = await openWorkflowActions(carolPage)
    await expect(
      carolActions.getByTestId('workflow-rename-button'),
      '只读授权者点得到「改名」⇒ 改名是治理动作，它必然 403，这个入口是坏的',
    ).toHaveCount(0)

    // 权限面板对被授权者必须是**只读视图**：他要看得到自己被谁、以什么档位授权，
    // 但不能改。藏起来更糟——那样他连「我为什么改不了」都无从得知。
    const carolAcl = await openWorkflowAcl(carolPage)
    await expect(carolAcl.getByTestId('acl-owner-row')).toContainText(alice.username)
    await expect(
      carolAcl.getByTestId('acl-save'),
      '被授权者的权限面板里有保存键 ⇒ 任何被授权的人都能改授权名单，授权就没有边界了',
    ).toHaveCount(0)
    await expect(
      carolAcl.getByTestId('acl-transfer-owner'),
      '被授权者点得到「移交归属」⇒ 他可以把别人的资源转到自己名下',
    ).toHaveCount(0)
    await expect(
      carolAcl.getByTestId(`acl-grant-${carol.userId}`),
      '被授权者在面板里看不到自己的档位 ⇒ 他不知道自己是只读还是可编辑，' + '只能靠试出来',
    ).toContainText('Read-only')
    // 面板的页脚按钮与 Dialog 自带的 × 都叫 "Close"，按 role 取会命中两个；
    // 这里只是收拾弹窗，不是判据，用 Escape 最省事。
    await carolPage.keyboard.press('Escape')
    await expect(carolPage.getByTestId('acl-panel')).toHaveCount(0)

    // ⚠️ 治理闸的**服务端**兜底。前台仍然把「删除」渲染给了这个只读授权者
    // （workflows.edit.tsx:312 的 canDelete 只看方法级权限点 `workflows:delete`，
    // 而 user 预设人人都有），所以他点得到、也能把名字敲对。这里断言的是：即便
    // 走到那一步，服务端也必须整笔拒绝并说明理由。这条断言若红掉，任何被授权的人
    // 都能把别人的工作流删掉——那是本行最贵的一种损失。
    await openWorkflowActions(carolPage)
    await carolPage.getByTestId('workflow-delete-button').click()
    const carolDelete = carolPage.getByRole('dialog', { name: 'Delete workflow' })
    await expect(carolDelete).toBeVisible()
    await carolPage.getByTestId('confirm-input').fill(wf.name)
    await carolDelete.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      carolDelete,
      '被授权者的删除被静默吞掉 ⇒ 他不知道是没删成还是删成了',
    ).toContainText(
      'Deleting, renaming, transferring and permission changes are reserved for the resource owner.',
    )
    expect(
      (await raw(alice.token, `/api/workflows/${wf.id}`)).status,
      '被授权者真的把别人的工作流删掉了 ⇒ 授权把治理权也一起交出去了',
    ).toBe(200)
    await carolPage.getByRole('button', { name: 'Cancel', exact: true }).click()

    // ---- (3b) write 档：能改内容，但**依然**删不掉 ------------------------
    // 为什么必须单独有这一段：上面那条走的是 `read` 档，而对 read 档来说
    // 「内容写门」与「治理门」**同时**为假——把治理判据误写成内容写判据
    //（`canGovernAccess` → `canEditAccess`，services/workflow.ts:1069）拦得住它，
    // 于是那条断言分辨不出这个错误（实测：只做这一处变异，上面整段照样绿）。
    // 唯一能分辨的是 `write` 档：它该能改内容、但绝不该能删。RFC-324 刚把授权拆成
    // 两档，这正是新引入、也最容易被写错的那一格——一个被请来帮忙改工作流的人，
    // 不该顺手就能把它删掉。
    await putAcl(alice, wf.id, { grants: [{ userId: carol.userId, level: 'write' }] })

    const beforeWrite = await getWorkflow(alice.token, wf.id)
    const writeContent = await saveWorkflow(carol, beforeWrite, {
      description: 'edited by a write-level grantee',
    })
    expect(
      writeContent.status,
      'write 档改不动内容 ⇒ 这一档等于没有，用户只能被迫转移归属或升成管理员',
    ).toBe(200)

    const afterWrite = await getWorkflow(alice.token, wf.id)
    const writeDelete = await deleteWorkflowRequest(carol, afterWrite)
    expect(
      writeDelete.status,
      'write 档把别人的工作流删掉了 ⇒ 「可编辑」被当成了「可治理」，' +
        '请来帮忙改一版的人顺手就能删掉整条工作流',
    ).toBe(403)
    expect((JSON.parse(writeDelete.body) as { code: string }).code).toBe(
      'resource-govern-owner-only',
    )
    expect(
      (await raw(alice.token, `/api/workflows/${wf.id}`)).status,
      '拒绝返回了 403，但行其实已经没了 ⇒ 拒绝只是个门面',
    ).toBe(200)

    // 复原成 read 档，后面的移交段沿用原来的前提。
    await putAcl(alice, wf.id, { grants: [{ userId: carol.userId, level: 'read' }] })

    // 上面两次 putAcl 是**经 API** 改的，每次都会推进 aclRevision；而 alice 这一页的
    // 权限面板还揣着打开时那一版。ACL 的写是带 OCC 围栏的（expectedAclRevision），
    // 所以不刷新就去点「移交归属」，那次 PUT 会被服务端按陈旧修订拒掉——表现为
    // 「点了没反应、归属人没换」，而不是任何报错。这不是产品缺陷，是本用例自己在
    // 背后动了状态，必须让页面重新取一次。
    await alicePage.reload()

    // ---- (4) 移交归属：治理权真的换手，前任自动降为只读 --------------------
    const transferPanel = await openWorkflowAcl(alicePage)
    await transferPanel.getByTestId('acl-transfer-owner').click()
    const transferDialog = alicePage.getByTestId('acl-transfer-dialog')
    await expect(transferDialog).toBeVisible()
    await transferDialog.getByTestId('acl-transfer-input').fill(carol.username)
    await alicePage.getByTestId(`acl-transfer-option-${carol.username}`).click()
    await transferDialog.getByTestId('acl-transfer-confirm').click()

    // 移交之后面板**不关**（AclPanel.tsx:254-256），因为它刚在用户眼皮底下变了样。
    await expect(
      transferPanel.getByTestId('acl-owner-row'),
      '移交之后面板里的归属人没换 ⇒ 用户不知道移交到底成没成，会再移交一次',
    ).toContainText(carol.username, { timeout: 30_000 })
    await expect(
      transferPanel.getByTestId('acl-save'),
      '移交之后前任还能改授权名单 ⇒ 「移交」是假的，治理权没有真的换手',
    ).toHaveCount(0, { timeout: 30_000 })
    await expect(
      transferPanel.getByTestId('acl-transfer-owner'),
      '移交之后前任还能再移交一次 ⇒ 他可以把资源转给任何人，包括转回自己',
    ).toHaveCount(0)

    await alicePage.reload()
    await expect(
      alicePage.getByTestId('workflow-readonly-badge'),
      '移交之后前任的编辑器仍是可编辑态 ⇒ 他会继续改，而服务端已经不接受他的写了' +
        '（acl.transferHint 逐字承诺「你仍是被授权用户」，那就是只读档）',
    ).toBeVisible({ timeout: 60_000 })

    await carolPage.goto(`${daemon.baseUrl}/workflows/${wf.id}`)
    await expect(
      carolPage.getByTestId('workflow-readonly-badge'),
      '接手归属之后新主人还是只读 ⇒ 移交把资源交给了一个动不了它的人',
    ).toHaveCount(0, { timeout: 60_000 })
    carolActions = await openWorkflowActions(carolPage)
    await expect(
      carolActions.getByTestId('workflow-rename-button'),
      '新主人改不了名字 ⇒ 治理权只换了一半',
    ).toBeVisible()

    // ---- (5) 撤销授权：对方立刻回到「与不存在同形」------------------------
    const revokePanel = await openWorkflowAcl(carolPage)
    await revokePanel.getByTestId(`acl-members-remove-${alice.username}`).click()
    await carolPage.getByTestId('acl-save').click()
    await expect(carolPage.getByTestId('acl-panel')).toHaveCount(0)

    await alicePage.goto(`${daemon.baseUrl}/workflows`)
    await expect(
      alicePage.getByTestId(`workflow-card-${wf.name}`),
      '撤销授权之后对方的列表里还留着这张卡片 ⇒ 撤权是假的',
    ).toHaveCount(0, { timeout: 60_000 })
    await alicePage.goto(`${daemon.baseUrl}/workflows/${wf.id}`)
    const aliceBanner = alicePage.getByRole('alert').first()
    await expect(
      aliceBanner,
      '撤权之后直链还打得开 ⇒ 只是列表过滤了一下，资源本身还是敞开的',
    ).toBeVisible({ timeout: 30_000 })
    expect(
      (await aliceBanner.innerText()).trim(),
      '撤权后的直链与「这个 id 从来不存在」不同形 ⇒ 被撤权的人仍能从错误信息里确认' +
        '这份工作流存在',
    ).toBe(neverExisted)
  } finally {
    await aliceSide.context.close()
    await carolSide.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-53
// ---------------------------------------------------------------------------

test('WF-53 内置工作流 aw-skill-fusion：列表隐藏、改 / 删 / 复制 / 改权限一律拒绝，同名的用户自建工作流照常可见', async ({
  browser,
}) => {
  const tag = nextTag('wf53')
  const owner = await seedUser(tag)

  // ---- (A) 内建行确实在，只是不进用户列表 --------------------------------
  const builtin = await getWorkflow(owner.token, BUILTIN_FUSION_WORKFLOW_ID)
  expect(
    builtin.name,
    '内建融合工作流不在（或改了名）⇒ 夹具前提不成立，下面所有「隐藏 / 只读」断言都会变成空洞绿',
  ).toBe(BUILTIN_FUSION_WORKFLOW_NAME)
  expect(
    (await listWorkflows(owner.token)).map((w) => w.id),
    '框架自己要跑的基础设施出现在用户列表里 ⇒ 用户会去改它 / 删它，把融合功能弄坏',
  ).not.toContain(BUILTIN_FUSION_WORKFLOW_ID)

  // ---- (B) 四条写入面一律 403 builtin-readonly ---------------------------
  const write = await saveWorkflow(owner, builtin, { description: 'tampered' })
  expect(write.status, '内建工作流可以被保存 ⇒ 任何用户都能改掉框架赖以运行的定义').toBe(403)
  expect((JSON.parse(write.body) as RefusalBody).code).toBe('builtin-readonly')

  const remove = await deleteWorkflowRequest(owner, builtin)
  expect(remove.status, '内建工作流可以被删除 ⇒ 融合功能会在下一次使用时整条断掉').toBe(403)
  expect((JSON.parse(remove.body) as RefusalBody).code).toBe('builtin-readonly')

  const copied = await raw(owner.token, `/api/workflows/${BUILTIN_FUSION_WORKFLOW_ID}/copy`, {
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: builtin.version,
      expectedSnapshotHash: builtin.snapshotHash,
    }),
  })
  expect(
    copied.status,
    '内建工作流可以被复制 ⇒ 用户列表里会冒出一份框架内部定义的副本，' +
      '它既没人维护、也会随框架升级而失效',
  ).toBe(403)
  expect((JSON.parse(copied.body) as RefusalBody).code).toBe('builtin-readonly')

  const reacl = await putAcl(owner, BUILTIN_FUSION_WORKFLOW_ID, { visibility: 'private' })
  expect(
    reacl.status,
    '内建工作流的可见性可以被改 ⇒ 有人把它转成私有，别人的融合任务当场 404',
  ).toBe(403)
  expect((JSON.parse(reacl.body) as RefusalBody).code).toBe('builtin-readonly')

  // ---- (C) 判别式是 `builtin` 列，不是名字 -------------------------------
  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(
      page.getByTestId('workflows-empty'),
      '一条工作流都没建，列表却不是空的 ⇒ 内建行漏进了用户列表',
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId(`workflow-card-${BUILTIN_FUSION_WORKFLOW_NAME}`),
      '内建融合工作流出现在卡片列表里 ⇒ 用户会点进去改它',
    ).toHaveCount(0)

    // 同名的**用户自建**工作流必须照常可见：RFC-104 把判别式从「owner + 保留名」
    // 换成 `builtin` 列，正是为了让这两件事不再纠缠。判别式若退化成按名字一刀切，
    // 用户建的这一条会凭空消失，而他完全不知道为什么。
    const mine = await seedWorkflow(owner, BUILTIN_FUSION_WORKFLOW_NAME, 'my own, same name', 1)
    await page.reload()
    const card = page.getByTestId(`workflow-card-${BUILTIN_FUSION_WORKFLOW_NAME}`)
    await expect(
      card,
      '用户自建的同名工作流也被隐藏了 ⇒ 保留名成了禁用名，用户建出来的东西凭空消失',
    ).toHaveCount(1, { timeout: 60_000 })
    expect(
      await metaChips(page, BUILTIN_FUSION_WORKFLOW_NAME),
      '列表里那张同名卡片不是用户自己那一行 ⇒ 隐藏与显示挑错了对象',
    ).toEqual(['1 node', 'v1'])
    expect(
      await badgeChips(page, BUILTIN_FUSION_WORKFLOW_NAME),
      '用户自建行没有归属徽章 ⇒ 它被当成了框架资源',
    ).toEqual(['Private', owner.username])
    expect(
      (await listWorkflows(owner.token)).map((w) => w.id),
      '服务端集合里出现的不是用户自己那一行 ⇒ 名字与内建标记仍然纠缠在一起',
    ).toEqual([mine.id])
  } finally {
    await side.context.close()
  }
})
