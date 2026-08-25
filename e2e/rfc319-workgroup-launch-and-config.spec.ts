// RFC-319 —— 工作组的「启动 / 运行中配置 / 引用完整性」这一圈用户面 e2e。
//
// 覆盖能力账本 WG-05 / WG-09 / WG-15 / WG-24 / WG-34 / WG-41 / WG-43 / WG-44 /
// WG-45 九行（账本里全部是 gap）。既有的工作组 e2e 只覆盖「资源本身怎么建怎么改」
// （rfc319-workgroup-crud / -editor / -acl）与「已经跑起来的组怎么协作」
// （workgroup-matrix / business-workgroup-scenarios），**从组到任务的这一跳**
// ——启动入口、启动前的闸、启动后的改配置、以及三条非人工的启动通路（定时 /
// webhook / 收件箱回流）——一条都没锁。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//   * WG-15 —— 这是本批最值钱的一格。成员 agent 引用的受管技能在本次启动被隔离
//     之后，组本身看起来完全正常（成员齐、leader 有、就绪性横幅不亮），但它**跑不了**。
//     完整性横幅与禁用的启动键是用户唯一能知道「为什么」的地方；横幅不亮 = 用户
//     反复点启动、反复吃 422，而 422 的文案里刻意不含资源名（ACL 闭包不外泄）。
//     反过来禁用判据若只在前端，绕过界面的任何调用方（定时 / webhook / API）都会
//     把一条注定失败的任务铸出来，占着 worktree 直到有人去清。
//   * WG-24 —— 卡片与详情页的启动入口是「组 → 任务」的全部入口。深链丢了
//     `workgroupId` 用户会落在一个空向导上；详情页丢了 `workgroupVersion` 就丢了
//     RFC-225 的编辑器交接 fence——用户在向导里慢慢填目标的这段时间里别人改了组，
//     启动的会是他没看过的那一版。
//   * WG-34 —— 任务改的是**自己那份配置副本**。回写到组资源上，等于一次临时调参
//     污染了所有后续任务；反过来只改副本却没落库，用户在对话框里调完 maxRounds
//     发现任务还是按旧上限收场。空 patch 与并发改名单是两道独立的闸：前者挡
//     「点了保存却什么都没改」的空写（空写同样会往房间里插一条系统消息，把讨论
//     记录冲淡），后者挡「两个人同时改名单，后写的把先写的那一格整段冲掉」。
//   * WG-41 —— 角标是用户唯一不需要主动去找的通知面。工作组这一路数错，用户不会
//     知道有一张卡在等他交付、或者有一个完成门在等他确认——任务就那么停着。
//     更糟的是数**多**了：把别人任务里的待办算进我的角标，等于泄露了任务存在性。
//   * WG-43 / WG-44 —— 无人值守的两条启动通路。它们不经过向导，所以向导里的所有
//     校验一格都不生效；目标 id 若没冻进 payload（或者冻的是名字），组一改名这条
//     定时任务就再也起不来了，而没有任何人在看。
//   * WG-45 —— 五条拒绝路径必须各自可辨。三条都回同一句话时，用户拿到「启动失败」
//     之后无从下手：是组变了？是名单不全？还是成员 agent 被别人删了？
//   * WG-05 —— 资源包是跨实例搬运工作组的唯一通路。成员 agent 若没跟着重新接线，
//     导入出来的组会指向**源实例**的 agent id：本机根本没有那一行，组看着建成功了，
//     启动时才在 `agent-missing` 上炸。
//   * WG-09 —— 详情页是唯一订阅 `/ws/workgroups` 的页面。帧掉了，用户在两个标签页
//     里各改各的，后保存的那一页会一路撞版本冲突；组被别人删了这一页还照常「保存中」，
//     每一次自动保存都在往一个不存在的资源上写。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/backend/src/routes/workgroups.ts:105-124          GET :id/resource-status（成员 agent 闭包的顾问式判定）
//   packages/backend/src/routes/workgroups.ts:271-328          POST :id/tasks：退役键 → sourceTaskId 可见性 → schema → startExecution
//   packages/backend/src/services/workgroup/launch.ts:189-262  404 → id fence → version fence → 就绪性 → agent-missing → 闭包完整性
//   packages/backend/src/services/agentResourceIntegrity.ts:186-300 evaluateAgentResourceIntegrity（skill-unavailable 等七个 issue code）
//   packages/backend/src/services/agentResourceIntegrity.ts:330-355 assertAgentResourceIntegrity ⇒ 422 agent-resources-invalid（不外泄资源名）
//   packages/backend/src/services/skillBootVerify.ts:293-301   live 树与已提交版本不一致 ⇒ 本次启动隔离
//   packages/backend/src/services/workgroup/configActions.ts:117-125 终态任务不给改配置
//   packages/backend/src/services/workgroup/configActions.ts:271-285 changes 为空 ⇒ 422 workgroup-config-empty
//   packages/backend/src/services/workgroup/configActions.ts:186-200 移除 leader ⇒ 422 workgroup-config-leader-immutable
//   packages/backend/src/services/workgroup/configActions.ts:206-213 重名成员 ⇒ 422 workgroup-config-duplicate-member
//   packages/backend/src/services/workgroup/configActions.ts:286-311 fresh 行合并 + 名单快照比对 ⇒ 409 workgroup-config-conflict
//   packages/backend/src/services/workgroup/room.ts:340-434    pending-count：dispatched 人类卡 + awaiting_confirmation 完成门，按任务可见性过滤
//   packages/backend/src/services/workgroup/taskActions.ts:190-221 @成员 ⇒ 直接派单（source='human'，status='dispatched'）
//   packages/backend/src/services/scheduledTasks.ts:373-390    定时 workgroup payload：可见性校验 + 服务端刷新 workgroupName
//   packages/shared/src/schemas/scheduledTask.ts:99-105        ScheduledWorkgroupPayloadSchema：一次性 fence 键 z.never()
//   packages/backend/src/services/scheduleLaunch.ts:63-79      run-now / 到点触发都补 expectedWorkgroupId
//   packages/backend/src/services/webhook/webhookDispatch.ts:543-560 webhook workgroup 渲染：goal 模板 + 空间字段
//   packages/backend/src/services/webhook/webhookDispatch.ts:657-670 fire 走 startExecution 并补 expectedWorkgroupId
//   packages/frontend/src/routes/workgroups.detail.tsx:319-331 resourceStatusQuery（真打 /resource-status，不是本地推断）
//   packages/frontend/src/routes/workgroups.detail.tsx:687-696 launchDisabled 含 resourceStatusQuery.data?.ok === false
//   packages/frontend/src/routes/workgroups.detail.tsx:795-802 workgroup-resource-integrity-banner
//   packages/frontend/src/routes/workgroups.detail.tsx:570-591 launch mutation → /tasks/new?kind=workgroup&workgroupId=&workgroupVersion=
//   packages/frontend/src/routes/workgroups.tsx:157-160        画廊卡片的 launch search（只带 kind + workgroupId）
//   packages/frontend/src/routes/tasks.new.tsx:1545-1556       immediateGuards：expectedWorkgroupId + expectedWorkgroupVersion
//   packages/frontend/src/hooks/useWorkgroupSync.ts:22-41      三种帧各自的失效目标
//   packages/frontend/src/components/shell/InboxFooterButton.tsx:44-57 三路 pending-count 求和
//   packages/frontend/src/components/shell/InboxDrawer.tsx:190-222 工作组待办行与 d/g 拆分
//   packages/frontend/src/components/workgroup/WorkgroupTaskConfigDialog.tsx:117-145 空 patch ⇒ 提交键禁用 + 提示
//   packages/frontend/src/components/ResourcePackageImportDialog.tsx:886-898 expectedRootType 不符的提示横幅
//   packages/backend/src/services/resourcePackage/closure.ts:100-127 工作组闭包带上 workgroup_members
//
// ## 执行模型
//
// 全文件共用一个 daemon，跑在一个自带的 home 上（写了 `.demo-seeded` 标记，于是
// RFC-307 的样例内容不会被种下——`[demo] reviewer` 是 `__system__` 名下的 public 行，
// 会让「这个账号看到几张卡片」永远不可断言）。
//
// **beforeAll 里刻意重启了一次 daemon**：WG-15 需要一个「成员 agent 的引用闭包坏了」
// 的状态，而这个状态在产品里只有一条真实通路——受管技能的 live 目录与已提交版本的
// 内容哈希对不上，于是**下一次启动**的快照复验把它隔离掉
// （skillBootVerify.ts:293-301 → skill.ts:75-83 → agentResourceIntegrity.ts:230-243）。
// 把技能删掉只会得到 `skill-not-found`（而且删除本身被引用守卫挡着），转私有连
// issue 都不产生（完整性判定不看 ACL）。所以 beforeAll 的顺序是：起 daemon → 播技能、
// 引用它的 agent、以及以该 agent 为成员的工作组 → 停 daemon → 在 home 里改坏那份
// live SKILL.md → 用同一个 home 重新起 daemon。这是用例自己制造的环境状态，不是产品缺陷。
//
// stub 用默认的 `basic` 模式：它是 workgroup-aware 的（mode-basic.ts:52-60 —— leader
// 一回合就 `wg_decision {action:'done'}`），所以「启动到 done」与「停在完成门上」
// 两种终局都能确定性地造出来，不依赖任何具名的夹具 agent。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

const PASSWORD = 'Rfc319WgLaunchPass!1'

let daemon: DaemonHandle
let daemonHome: string
let workDir: string
let sequence = 0

/** WG-15 的夹具：一个成员 agent 的受管技能会在第二次启动时被隔离的工作组。 */
let broken: { skillId: string; agentId: string; workgroupId: string }

interface SeededUser {
  username: string
  userId: string
  token: string
}

interface WorkgroupMemberRow {
  id: string
  memberType: 'agent' | 'human'
  agentId: string | null
  agentName: string | null
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
  instructions: string
  maxRounds: number
  completionGate: boolean
  outputContract?: 'files' | 'discussion'
  switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  version: number
  ownerUserId?: string | null
  visibility?: 'public' | 'private'
  updatedAt: number
}

interface TaskRow {
  id: string
  status: string
  workgroupId?: string | null
  scheduledTaskId?: string | null
  errorMessage?: string | null
}

interface RoomRow {
  taskId: string
  taskStatus: string
  config: {
    workgroupId: string
    workgroupName: string
    mode: string
    goal: string
    instructions: string
    maxRounds: number
    completionGate: boolean
    clarifyBudget?: number
    fanOut?: boolean
    outputContract?: 'files' | 'discussion'
    switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
    members: WorkgroupMemberRow[]
  }
  gate: {
    declaredDone: boolean
    awaitingConfirmation: boolean
    rejected: boolean
    summary: string | null
  }
  messages: Array<{ id: string; kind: string; bodyMd: string }>
  assignments: Array<{ id: string; assigneeMemberId: string | null; status: string }>
}

interface WorkgroupResourceStatus {
  ok: boolean
  issues: Array<{ code: string; rootAgentId: string; refKind: string; direct: boolean }>
}

interface PendingCount {
  deliveries: number
  gates: number
  total: number
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

/** 断言一次拒绝的**状态码与错误码**，并把服务端原文带进失败信息里。 */
function expectRejection(
  res: { status: number; body: string },
  status: number,
  code: string,
  why: string,
): Record<string, unknown> {
  const parsed = JSON.parse(res.body) as { code?: string; details?: Record<string, unknown> }
  expect({ status: res.status, code: parsed.code }, `${why}（服务端原文：${res.body}）`).toEqual({
    status,
    code,
  })
  return parsed.details ?? {}
}

/** DELETE / rename 的 body 需要一个合法 ULID 形状的 clientMutationId
 *  （schemas/workgroup.ts:433-440 的 WorkgroupMutationIdSchema）。 */
function newMutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = '01'
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

async function seedUser(tag: string): Promise<SeededUser> {
  const username = `rfc319-wgl-${tag}-${++sequence}`
  const created = await json<{ id: string }>(
    daemon.token,
    '/api/users',
    {
      method: 'POST',
      // 邮箱不是可选项：RFC-320 起任务的 git 提交身份取自创建者账号，缺邮箱的
      // 账号连启动都过不去（getUserGitCommitIdentity.ts:31-34 的
      // `git-identity-email-missing`）。本文件的多数用例都要真的起任务。
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
  return { username, userId: created.id, token: sessionToken }
}

async function seedAgent(
  token: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const agent = await json<{ id: string }>(
    token,
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 workgroup launch fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '',
        ...extra,
      }),
    },
    `seed agent ${name}`,
  )
  return agent.id
}

async function seedWorkgroup(token: string, body: Record<string, unknown>): Promise<WorkgroupRow> {
  return json<WorkgroupRow>(
    token,
    '/api/workgroups',
    { method: 'POST', body: JSON.stringify(body) },
    `seed workgroup ${String(body.name)}`,
  )
}

async function getWorkgroup(token: string, id: string): Promise<WorkgroupRow> {
  return json<WorkgroupRow>(token, `/api/workgroups/${id}`, undefined, `read workgroup ${id}`)
}

async function resourceStatus(token: string, id: string): Promise<WorkgroupResourceStatus> {
  return json<WorkgroupResourceStatus>(
    token,
    `/api/workgroups/${id}/resource-status`,
    undefined,
    `read workgroup resource-status ${id}`,
  )
}

async function launchTask(
  token: string,
  workgroupId: string,
  body: Record<string, unknown>,
): Promise<TaskRow> {
  return json<TaskRow>(
    token,
    `/api/workgroups/${workgroupId}/tasks`,
    { method: 'POST', body: JSON.stringify(body) },
    `launch workgroup task ${workgroupId}`,
  )
}

async function getTask(token: string, taskId: string): Promise<TaskRow> {
  return json<TaskRow>(token, `/api/tasks/${taskId}`, undefined, `read task ${taskId}`)
}

async function roomOf(token: string, taskId: string): Promise<RoomRow> {
  return json<RoomRow>(
    token,
    `/api/workgroup-tasks/${taskId}/room`,
    undefined,
    `read room ${taskId}`,
  )
}

/** 轮询到目标状态；超时后把最后一次读到的状态与错误原文一起报出来。 */
async function waitForTaskStatus(
  token: string,
  taskId: string,
  want: string,
  timeout = 120_000,
): Promise<TaskRow> {
  let last: TaskRow = { id: taskId, status: 'unknown' }
  await expect
    .poll(
      async () => {
        last = await getTask(token, taskId)
        return last.status
      },
      {
        timeout,
        message: `任务 ${taskId} 没有走到 ${want}（最后一次读到的状态在下方）`,
      },
    )
    .toBe(want)
  expect(last.errorMessage ?? null, `任务停在 ${want} 但带着错误信息`).toBe(null)
  return last
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

async function primeAuth(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ([baseUrl, tok]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [daemon.baseUrl, token] as const,
  )
}

/** 一个「停在完成门上」的工作组任务：leader 一回合宣布完成，完成门把它扣在
 *  `awaiting_review` 上等人确认。WG-34 / WG-41 共用。 */
async function launchGatedTask(tag: string): Promise<{
  owner: SeededUser
  group: WorkgroupRow
  taskId: string
  humanMemberId: string
  spareAgentId: string
}> {
  const owner = await seedUser(tag)
  const prefix = `rfc319-${tag}-${owner.username}`
  const leadAgentId = await seedAgent(owner.token, `${prefix}-lead`)
  const spareAgentId = await seedAgent(owner.token, `${prefix}-spare`)
  const group = await seedWorkgroup(owner.token, {
    name: `${prefix}-group`,
    description: 'gated workgroup fixture',
    mode: 'leader_worker',
    instructions: 'rfc319 charter',
    leaderDisplayName: 'Lead',
    maxRounds: 4,
    // 完成门只有在名单里真的有人的时候才生效
    // （schemas/workgroup.ts:549-554 的 resolveCompletionGate）。
    completionGate: true,
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead', roleDesc: 'Coordinates' },
      { memberType: 'human', userId: owner.userId, displayName: 'Ops', roleDesc: 'Confirms' },
    ],
  })
  const task = await launchTask(owner.token, group.id, {
    name: `${prefix}-task`,
    goal: 'ship the rfc319 fixture',
    scratch: true,
  })
  await waitForTaskStatus(owner.token, task.id, 'awaiting_review')
  const room = await roomOf(owner.token, task.id)
  expect(
    room.gate.awaitingConfirmation,
    '任务停在 awaiting_review 上，完成门却不是「等待确认」⇒ 夹具没造出想要的状态',
  ).toBe(true)
  const human = room.config.members.find((m) => m.memberType === 'human')
  expect(human, '任务配置快照里没有人类成员 ⇒ 夹具没造出想要的状态').toBeTruthy()
  return {
    owner,
    group,
    taskId: task.id,
    humanMemberId: (human as WorkgroupMemberRow).id,
    spareAgentId,
  }
}

async function exportPackage(token: string, path: string, file: string): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status, `${path}: export-package 必须回一个包`).toBe(200)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return file
}

/** 预览里渲染出来的条目 slug（从 Segmented 选项的 testid 反推）。 */
async function previewSlugs(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="package-action-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''))
  const slugs = new Set<string>()
  for (const id of ids) {
    const withoutPrefix = id.slice('package-action-'.length)
    const cut = withoutPrefix.lastIndexOf('-')
    if (cut > 0) slugs.add(withoutPrefix.slice(0, cut))
  }
  return [...slugs].sort()
}

test.beforeAll(async () => {
  daemonHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-wglaunch-'))
  workDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-wglaunch-pkg-'))
  // 「样例已经提供过」的标记：不种 RFC-307 的 demo 内容，见文件头 §执行模型。
  writeFileSync(join(daemonHome, '.demo-seeded'), `${String(Date.now())}\n`)

  const first = await startDaemon({ home: daemonHome })
  daemon = first

  const skill = await json<{ id: string; name: string }>(
    first.token,
    '/api/skills',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-wg15-doomed-skill',
        description: 'WG-15 fixture: quarantined on the next boot',
        bodyMd: '# doomed\n',
      }),
    },
    'seed doomed skill',
  )
  const brokenAgentId = await seedAgent(first.token, 'rfc319-wg15-lead', {
    skills: [{ kind: 'managed', skillId: skill.id }],
  })
  const healthyWorkerId = await seedAgent(first.token, 'rfc319-wg15-worker')
  const brokenGroup = await seedWorkgroup(first.token, {
    name: 'rfc319-wg15-broken',
    description: 'a member agent whose skill closure breaks on the next boot',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [
      { memberType: 'agent', agentId: brokenAgentId, displayName: 'Lead', roleDesc: 'Coordinates' },
      {
        memberType: 'agent',
        agentId: healthyWorkerId,
        displayName: 'Builder',
        roleDesc: 'Implements',
      },
    ],
  })
  broken = { skillId: skill.id, agentId: brokenAgentId, workgroupId: brokenGroup.id }
  await first.stop()

  // 改坏 live 目录：下一次启动的快照复验会算出与已提交版本不同的哈希并隔离它。
  appendFileSync(
    join(daemonHome, 'skills', skill.id, 'files', 'SKILL.md'),
    '\n<!-- rfc319 WG-15 tamper -->\n',
    'utf-8',
  )

  daemon = await startDaemon({ home: daemonHome })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const dir of [daemonHome, workDir]) {
    try {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// `page.route` 的 handler 必须在 page 还活着的时候等干净：先摘 handler，再等在飞的
// callback 跑完。必须是 'wait' 而不是 'ignoreErrors'——后者只是把错吞掉，
// 那等于「重跑就过了」。见 docs/dev-gotchas.md §e2e 里凡是 page.route 拦 API 的。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// WG-05 —— 从资源包新建工作组
// ---------------------------------------------------------------------------

test('RFC-319 WG-05: 从资源包新建工作组：成员 agent 一起新建并重新接线到新 agent，根类型不符时当场说明 @nightly', async ({
  browser,
}) => {
  const owner = await seedUser('wg05')
  const prefix = `rfc319-wg05-${owner.username}`
  const srcAgentId = await seedAgent(owner.token, `${prefix}-agent`)
  const srcGroup = await seedWorkgroup(owner.token, {
    name: `${prefix}-src`,
    description: 'exported and re-imported as a resource package',
    mode: 'leader_worker',
    instructions: 'rfc319 wg05 charter',
    leaderDisplayName: 'Lead',
    maxRounds: 7,
    members: [
      { memberType: 'agent', agentId: srcAgentId, displayName: 'Lead', roleDesc: 'Coordinates' },
    ],
  })
  const groupPackage = await exportPackage(
    owner.token,
    `/api/workgroups/${srcGroup.id}/export-package`,
    join(workDir, `${prefix}-group.zip`),
  )
  const agentPackage = await exportPackage(
    owner.token,
    `/api/agents/${srcAgentId}/export-package`,
    join(workDir, `${prefix}-agent.zip`),
  )

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workgroups`)

    // (1) 导入入口挂在快速新建对话框的「另一种建法」里——这是它唯一的入口，
    //     丢了的话用户手上的 zip 包在界面上完全无处可用。
    await page.getByTestId('workgroup-new-button').click()
    await page.getByTestId('workgroup-create-package').click()
    const fileInput = page.getByTestId('package-import-file')
    await expect(fileInput, '「从资源包导入」点开没有出现选包的入口').toBeAttached()

    await fileInput.setInputFiles(groupPackage)
    await page.getByTestId('package-import-preview').click()
    await expect(page.getByTestId('package-import-commit')).toBeVisible({ timeout: 30_000 })

    // (2) 工作组包必须把**成员 agent**一起带出来。只带工作组这一条的话，导入方
    //     建出来的组会指向源实例的 agent id，本机根本没有那一行。
    const slugs = await previewSlugs(page)
    expect(
      slugs.filter((slug) => slug.startsWith('workgroup-')).length,
      `包里没有工作组这一条（实测 slug：${slugs.join(', ')}）`,
    ).toBe(1)
    expect(
      slugs.filter((slug) => slug.startsWith('agent-')).length,
      `包里没有把成员 agent 一起带出来（实测 slug：${slugs.join(', ')}）⇒ 导入出来的组会指向源实例的 agent id`,
    ).toBe(1)
    const groupSlug = slugs.find((slug) => slug.startsWith('workgroup-')) as string
    const agentSlug = slugs.find((slug) => slug.startsWith('agent-')) as string

    // (3) 根类型一致时**不该**有类型提示横幅——它是本页 expectedRootType 的负向对照，
    //     少了它，下面 (6) 的「横幅出现」可能只是因为横幅永远都在。
    await expect(
      page.getByTestId('package-import-root-mismatch'),
      '导入的就是工作组包，却仍提示「这个包创建的是另一种资源」⇒ 提示与实际类型无关',
    ).toHaveCount(0)

    const newGroupName = `${prefix}-imported`
    const newAgentName = `${prefix}-imported-agent`
    await page.getByTestId(`package-action-${groupSlug}-new`).click()
    await page.getByTestId(`package-name-${groupSlug}`).fill(newGroupName)
    await page.getByTestId(`package-action-${agentSlug}-new`).click()
    await page.getByTestId(`package-name-${agentSlug}`).fill(newAgentName)
    await page.getByTestId('package-import-commit').click()
    await expect(page.getByTestId('package-import-report')).toBeVisible({ timeout: 60_000 })

    // (4) 落库真值对账：新组、新 agent 各一份，且**原来那两条一个字节都没动**。
    const groups = await json<WorkgroupRow[]>(owner.token, '/api/workgroups', undefined, 'list wg')
    const imported = groups.find((row) => row.name === newGroupName)
    expect(imported, '选了「新建」却没有建出工作组').toBeTruthy()
    expect(
      groups.find((row) => row.name === srcGroup.name)?.id,
      '选「新建」不许动同名的既有资源——那是别人正在用的东西',
    ).toBe(srcGroup.id)
    const agents = await json<Array<{ id: string; name: string }>>(
      owner.token,
      '/api/agents',
      undefined,
      'list agents',
    )
    const importedAgent = agents.find((row) => row.name === newAgentName)
    expect(importedAgent, '选了「新建」却没有建出成员 agent').toBeTruthy()

    // (5) 这一条是本用例的全部价值：新组的成员必须指向**新** agent。指回源 agent
    //     的话，用户以为「导入了一份自己的」，实际两个组共用同一行；跨实例导入时
    //     那个 id 在本机根本不存在，组要到启动时才在 agent-missing 上炸。
    const importedRow = imported as WorkgroupRow
    expect(
      importedRow.members.map((m) => ({ displayName: m.displayName, agentId: m.agentId })),
      '导入出来的组成员没有重新接线到新建的那个 agent ⇒ 跨实例导入必然在启动时炸',
    ).toEqual([{ displayName: 'Lead', agentId: importedAgent?.id }])
    expect(
      {
        mode: importedRow.mode,
        instructions: importedRow.instructions,
        maxRounds: importedRow.maxRounds,
        leader: importedRow.members.find((m) => m.id === importedRow.leaderMemberId)?.displayName,
      },
      '导入丢了模式 / 章程 / 轮次上限 / leader 指派 ⇒ 搬过来的是一个空壳',
    ).toEqual({
      mode: 'leader_worker',
      instructions: 'rfc319 wg05 charter',
      maxRounds: 7,
      leader: 'Lead',
    })

    // (6) 回执上的「打开导入的资源」必须真的落在这个新组上。
    await page.getByTestId('package-import-open-root').click()
    await expect(
      page.getByRole('heading', { level: 1 }),
      '「打开导入的资源」没有落在新建出来的那个组上 ⇒ 用户导入完找不到东西在哪',
    ).toHaveText(newGroupName, { timeout: 30_000 })
    expect(page.url()).toContain(`/workgroups/${importedRow.id}`)

    // (7) expectedRootType 的正向：把一个**代理包**喂进工作组的导入口，必须当场
    //     说清楚「你打开的是工作组创建面，这个包的根是代理」。少了这句话，用户在
    //     工作组页面上导入完，会在工作组列表里到处找一个根本不会出现在那里的东西。
    await page.goto(`${daemon.baseUrl}/workgroups`)
    await page.getByTestId('workgroup-new-button').click()
    await page.getByTestId('workgroup-create-package').click()
    await page.getByTestId('package-import-file').setInputFiles(agentPackage)
    await page.getByTestId('package-import-preview').click()
    await expect(
      page.getByTestId('package-import-root-mismatch'),
      '把代理包喂进工作组导入口，界面一声不吭 ⇒ 用户导完在工作组列表里空找一场',
    ).toContainText('this package root is Agent')
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-09 —— 详情页的实时同步
// ---------------------------------------------------------------------------

test('RFC-319 WG-09: 工作组详情页的实时同步：另一个标签页改完这一页不刷新就跟上，组被删当场报废 @nightly', async ({
  browser,
}) => {
  const owner = await seedUser('wg09')
  const prefix = `rfc319-wg09-${owner.username}`
  const agentId = await seedAgent(owner.token, `${prefix}-agent`)
  const group = await seedWorkgroup(owner.token, {
    name: `${prefix}-group`,
    description: 'watched from two tabs',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    maxRounds: 5,
    members: [
      { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: '' },
      { memberType: 'agent', agentId, displayName: 'Builder', roleDesc: '' },
    ],
  })

  const watcher = await openAs(browser, owner.token)
  const editor = await openAs(browser, owner.token)
  try {
    const detailPath = `/api/workgroups/${group.id}`
    let detailFetches = 0
    watcher.page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.pathname === detailPath) detailFetches += 1
    })

    await watcher.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await expect(watcher.page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', {
      timeout: 60_000,
    })
    await expect(watcher.page.getByTestId('workgroup-field-max-rounds')).toHaveValue('5')
    // 观察页面必须始终**没被重载过**：留一个哨兵，后面每一步都验它还在。
    // 「刷新之后就对了」和「它自己会跟上」是两件完全不同的事。
    await watcher.page.evaluate(() => {
      ;(window as unknown as { __rfc319Wg09?: number }).__rfc319Wg09 = 1
    })

    // ---- workgroup.updated：另一个标签页改完，这一页不刷新就跟上 ----------
    await editor.page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await expect(editor.page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', {
      timeout: 60_000,
    })
    await editor.page.getByTestId('workgroup-field-max-rounds').fill('11')
    await expect(editor.page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', {
      timeout: 30_000,
    })
    expect(
      (await getWorkgroup(owner.token, group.id)).maxRounds,
      '编辑页那一改压根没落库 ⇒ 下面的「另一页跟上了吗」测的不是同一件事',
    ).toBe(11)

    await expect(
      watcher.page.getByTestId('workgroup-field-max-rounds'),
      '另一个标签页改完，这一页还显示旧值 ⇒ 两页各改各的，后保存的那一页会一路撞版本冲突',
    ).toHaveValue('11', { timeout: 30_000 })
    await expect(
      watcher.page.locator('.editor-resource-meta__revision'),
      '这一页的版本号没跟着远端走 ⇒ 它手上的 expectedVersion 已经过期而它不知道',
    ).toContainText(`${group.id} · v2`, { timeout: 30_000 })
    expect(
      await watcher.page.evaluate(
        () => (window as unknown as { __rfc319Wg09?: number }).__rfc319Wg09,
      ),
      '观察页被重载过 ⇒ 上面那条「跟上了」证明的是刷新，不是实时同步',
    ).toBe(1)

    // 上面这一格至少要真的走过网络：重取次数必须已经涨过，否则「跟上了」也可能
    // 只是本地状态自己变了。
    expect(
      detailFetches,
      '整段实时同步期间这一页一次都没重新拉过工作组 ⇒ 上面的「跟上了」不是服务端真值',
    ).toBeGreaterThan(0)

    // ---- workgroup.acl.updated -------------------------------------------
    //
    // **刻意不在这里断言**，理由是实测出来的产品行为，不是遗漏：
    // ACL 写在提交后调 `triggerRevalidation(db, 'resource-acl-changed')`
    // （services/resourceAcl.ts:944），它**同步**地把每一条活连接标成
    // `revalidating`（ws/connections.ts:283-288）；紧接着 ACL 路由的
    // `afterUpdate` 才广播 `workgroup.acl.updated`（routes/workgroups.ts:337-341），
    // 而广播路径对 `revalidating` 的连接是**直接丢帧**（ws/registry.ts:1090），
    // `workgroups` 通道又没有实现 `resync` 钩子去补发。于是这一帧在同一次 ACL 写
    // 里必然自己把自己挡掉——本用例最初就是按「它应该让本页重新对账」写的，
    // 实跑证明重取次数一次都不涨。详见报告里的产品缺陷条目；这里不把缺陷
    // 写成期望，也不假装它被覆盖了。

    // ---- workgroup.deleted：被删当场报废 ---------------------------------
    const current = await getWorkgroup(owner.token, group.id)
    const del = await raw(owner.token, `/api/workgroups/${group.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        confirm: current.name,
        expectedVersion: current.version,
        clientMutationId: newMutationId(),
      }),
    })
    expect(del.status, `delete: ${del.body}`).toBe(204)

    await expect(
      watcher.page.getByTestId('workgroup-draft-phase'),
      '组被别人删了，这一页还显示「已保存」⇒ 它每一次自动保存都在往一个不存在的资源上写',
    ).toHaveText('Deleted', { timeout: 30_000 })
    await expect(
      watcher.page.getByTestId('workgroup-draft-notices'),
      '被删之后没有任何横幅告诉用户发生了什么，也没有「另存为副本」的退路',
    ).toContainText('Workgroup deleted')
    expect(
      await watcher.page.evaluate(
        () => (window as unknown as { __rfc319Wg09?: number }).__rfc319Wg09,
      ),
      '观察页被重载过 ⇒ 「被删当场报废」证明的是刷新，不是实时帧',
    ).toBe(1)
  } finally {
    await watcher.context.close()
    await editor.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-15 —— 引用资源完整性
// ---------------------------------------------------------------------------

test('RFC-319 WG-15: 成员 agent 的技能闭包坏掉：完整性横幅亮起、启动键禁用、绕过界面直接打接口同样被拒 @nightly', async ({
  page,
}) => {
  // 前提：beforeAll 改坏了那份技能的 live 目录并重启了 daemon，本次启动的快照
  // 复验应当把它隔离掉。这是用例自己制造的环境状态，不是产品缺陷。
  await expect
    .poll(
      async () => {
        const status = await resourceStatus(daemon.token, broken.workgroupId)
        return {
          ok: status.ok,
          issues: status.issues.map((i) => ({
            code: i.code,
            refKind: i.refKind,
            direct: i.direct,
            root: i.rootAgentId,
          })),
        }
      },
      {
        timeout: 30_000,
        message:
          '成员 agent 的受管技能被隔离了，工作组的完整性判定却说没事 ⇒ 这道闸只看 agent 自己，没有走成员闭包',
      },
    )
    .toEqual({
      ok: false,
      issues: [{ code: 'skill-unavailable', refKind: 'skill', direct: true, root: broken.agentId }],
    })

  // 健康对照组：同一个 daemon 上、同样两名 agent 成员、同样的 leader。
  // 没有它，下面每一条「坏组亮红」都可能只是因为这一格永远亮着。
  const healthyLead = await seedAgent(daemon.token, `rfc319-wg15-ok-lead-${++sequence}`)
  const healthyWorker = await seedAgent(daemon.token, `rfc319-wg15-ok-worker-${++sequence}`)
  const healthy = await seedWorkgroup(daemon.token, {
    name: `rfc319-wg15-healthy-${sequence}`,
    description: 'intact resource closure',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [
      { memberType: 'agent', agentId: healthyLead, displayName: 'Lead', roleDesc: '' },
      { memberType: 'agent', agentId: healthyWorker, displayName: 'Builder', roleDesc: '' },
    ],
  })
  expect(
    await resourceStatus(daemon.token, healthy.id),
    '闭包完好的组也被判成有问题 ⇒ 判据不是「引用坏了」，而是把所有组一律判红',
  ).toEqual({ ok: true, issues: [] })

  await primeAuth(page, daemon.token)

  // ---- 坏的那个组 ----------------------------------------------------------
  await page.goto(`${daemon.baseUrl}/workgroups/${broken.workgroupId}`)
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', { timeout: 60_000 })
  await expect(
    page.getByTestId('workgroup-resource-integrity-banner'),
    '成员 agent 的技能已经不可用，详情页却什么都不说 ⇒ 用户只会反复点启动、反复吃一个不解释原因的 422',
  ).toContainText('Member Agents have 1 missing or unavailable resource references.')
  // 就绪性是另一道闸（名单形状），这个组是完全就绪的。它若也亮着，上面那条断言
  // 锁的就不是完整性门。
  await expect(
    page.getByTestId('workgroup-readiness-banner'),
    '名单完全就绪的组却亮了就绪性横幅 ⇒ 这条用例锁的不是完整性门',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('workgroup-launch-button'),
    '闭包坏了启动键还能点 ⇒ 用户点下去只会铸出一条注定失败的任务，还占着一个 worktree',
  ).toBeDisabled()

  // 禁用键只是第一道闸。绕过界面直接打接口——定时任务 / webhook / 任何脚本走的
  // 都是这条路——必须同样被拒，而且拒绝理由里不带资源名（闭包是隐式授权的）。
  const rejected = await raw(daemon.token, `/api/workgroups/${broken.workgroupId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-wg15-blocked',
      goal: 'should never start',
      scratch: true,
    }),
  })
  const details = expectRejection(
    rejected,
    422,
    'agent-resources-invalid',
    '闭包坏了却仍然启动得起来 ⇒ 禁用键只是画上去的，任何非界面调用方都能绕过去',
  )
  expect(
    details.issues,
    '拒绝理由里没有逐条说明是哪一类引用坏了 ⇒ 用户拿到一句「资源不合法」无从下手',
  ).toEqual([
    { code: 'skill-unavailable', refKind: 'skill', rootAgentId: broken.agentId, direct: true },
  ])
  expect(
    rejected.body.includes('rfc319-wg15-doomed-skill'),
    '拒绝理由里带上了被隐式授权的技能名 ⇒ 闭包内的资源名泄漏给了不一定看得见它的启动者',
  ).toBe(false)

  // ---- 健康对照组：同一页面、同样的控件，必须完全放行 ----------------------
  await page.goto(`${daemon.baseUrl}/workgroups/${healthy.id}`)
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', { timeout: 60_000 })
  await expect(
    page.getByTestId('workgroup-resource-integrity-banner'),
    '闭包完好的组也亮红横幅 ⇒ 横幅与真实完整性无关，用户很快就会学会无视它',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('workgroup-launch-button'),
    '闭包完好的组启动键也是灰的 ⇒ 这道闸把所有人都挡住了',
  ).toBeEnabled()
})

// ---------------------------------------------------------------------------
// WG-24 —— 从工作组启动任务
// ---------------------------------------------------------------------------

test('RFC-319 WG-24: 从卡片与详情页启动：深链带上组 id 与版本 fence，向导预选到这个组，目标一路落进房间并跑到 done @nightly', async ({
  browser,
}) => {
  const owner = await seedUser('wg24')
  const prefix = `rfc319-wg24-${owner.username}`
  const leadAgentId = await seedAgent(owner.token, `${prefix}-lead`)
  const workerAgentId = await seedAgent(owner.token, `${prefix}-worker`)
  const group = await seedWorkgroup(owner.token, {
    name: `${prefix}-group`,
    description: 'launched from the gallery and the detail header',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    // 完成门开着的话任务会停在 awaiting_review 等人确认；这条用例锁的是
    // 「向导 → 引擎」这一整条链路走得通，所以让它自己收场。
    completionGate: false,
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead', roleDesc: 'Coordinates' },
      { memberType: 'agent', agentId: workerAgentId, displayName: 'Builder', roleDesc: '' },
    ],
  })

  const side = await openAs(browser, owner.token)
  try {
    const { page } = side

    // (1) 画廊卡片上的启动入口：只带 kind + workgroupId（列表页手上没有版本）。
    await page.goto(`${daemon.baseUrl}/workgroups`)
    await page.getByTestId(`workgroup-card-${group.name}-launch`).click()
    await expect(page.getByTestId('task-wizard')).toBeVisible({ timeout: 30_000 })
    const fromCard = new URL(page.url())
    expect(
      {
        kind: fromCard.searchParams.get('kind'),
        workgroupId: fromCard.searchParams.get('workgroupId'),
      },
      '卡片上的「启动」没有把组带进向导 ⇒ 用户点完落在一个空向导上，还得自己再选一次',
    ).toEqual({ kind: 'workgroup', workgroupId: group.id })

    // (2) 详情页的启动键：额外带上**当前版本**。这是 RFC-225 的编辑器交接 fence——
    //     用户在向导里慢慢填目标的这段时间里别人改了组，启动的就得是他没看过的那一版。
    await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
    await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved', { timeout: 60_000 })
    await page.getByTestId('workgroup-launch-button').click()
    await expect(page.getByTestId('task-wizard')).toBeVisible({ timeout: 30_000 })
    const fromDetail = new URL(page.url())
    expect(
      {
        kind: fromDetail.searchParams.get('kind'),
        workgroupId: fromDetail.searchParams.get('workgroupId'),
        workgroupVersion: fromDetail.searchParams.get('workgroupVersion'),
      },
      '详情页的启动深链丢了版本 ⇒ 编辑器交接的 fence 整个失效，用户会启动一版他没看过的组',
    ).toEqual({
      kind: 'workgroup',
      workgroupId: group.id,
      workgroupVersion: String(group.version),
    })

    // (3) 向导确实**预选**到这个组，而不是只把参数塞进 URL 就完事。
    const taskName = `${prefix}-task`
    const goal = 'coordinate one round and wrap up the rfc319 fixture'
    let launchBody: Record<string, unknown> | null = null
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (
        request.method() === 'POST' &&
        url.pathname === `/api/workgroups/${group.id}/tasks` &&
        launchBody === null
      ) {
        try {
          launchBody = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>
        } catch {
          launchBody = {}
        }
      }
    })

    await page.getByTestId('wizard-space-scratch').click()
    await page.getByTestId('stepper-next').click()
    await page.getByTestId('wizard-task-name').fill(taskName)
    await page.getByTestId('wizard-goal').fill(goal)
    await page.getByTestId('stepper-next').click()
    const summaryKind = page.getByTestId('wizard-summary-kind')
    await expect(
      summaryKind,
      '确认页说不出这是一次工作组启动 ⇒ 用户在最后一步无法确认自己启动的是什么',
    ).toContainText('Workgroup')
    await expect(
      summaryKind,
      '确认页说不出启动的是哪一个组 ⇒ 深链里的预选没有真的选进表单',
    ).toContainText(group.name)

    await page.getByTestId('wizard-launch').click()
    await page.waitForURL(/\/tasks\/[A-Z0-9]{26}$/i, { timeout: 30_000 })
    const taskId = /\/tasks\/([A-Z0-9]{26})/i.exec(page.url())?.[1] as string

    // (4) 深链里的版本必须一路带进启动 body——否则 fence 只是 URL 上的装饰。
    expect(
      launchBody,
      '启动请求里没有 expectedWorkgroupId / expectedWorkgroupVersion ⇒ 交接 fence 只写在 URL 上，服务端根本没被要求校验',
    ).toMatchObject({
      expectedWorkgroupId: group.id,
      expectedWorkgroupVersion: group.version,
    })

    // (5) 任务真的跑完，而且向导里填的两格真的落进了任务自己的配置快照。
    const finished = await waitForTaskStatus(owner.token, taskId, 'done')
    expect(
      finished.workgroupId,
      '跑出来的任务没有挂在这个工作组上 ⇒ 任务列表 / 房间入口都找不到它的组',
    ).toBe(group.id)
    const room = await roomOf(owner.token, taskId)
    expect(
      { goal: room.config.goal, name: room.config.workgroupName },
      '向导里填的目标没有落进任务配置 ⇒ 组成员每一轮拿到的目标不是用户写的那个',
    ).toEqual({ goal, name: group.name })
    expect(
      room.config.members.map((m) => m.displayName).sort(),
      '任务的成员快照与组名单对不上 ⇒ 启动时冻结的名单错了',
    ).toEqual(['Builder', 'Lead'])
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-34 —— 运行中改任务配置
// ---------------------------------------------------------------------------

test('RFC-319 WG-34: 运行中改任务配置：六类标量逐格落库且不回写组资源，成员增删各自留痕与拒绝码 @nightly', async () => {
  const fx = await launchGatedTask('wg34a')
  const cfgPath = `/api/workgroup-tasks/${fx.taskId}/config`
  const beforeRoom = await roomOf(fx.owner.token, fx.taskId)

  // ---- (1) 六类标量一次改完，逐格落库 -------------------------------------
  const patch = {
    switches: { shareOutputs: false, directMessages: true, blackboard: true },
    maxRounds: 9,
    completionGate: false,
    clarifyBudget: 1,
    fanOut: true,
    outputContract: 'discussion' as const,
  }
  const applied = await json<{ changes: string[] }>(
    fx.owner.token,
    cfgPath,
    { method: 'PUT', body: JSON.stringify(patch) },
    'patch scalars',
  )
  expect(
    [...applied.changes].sort(),
    '回执没有逐条说明改了什么 ⇒ 房间里的变更记录会漏掉其中几格，事后无人能复盘',
  ).toEqual(
    [
      'switches updated',
      'maxRounds → 9',
      'completionGate → false',
      'clarifyBudget → 1',
      'fanOut → true',
      'outputContract → discussion',
    ].sort(),
  )

  const after = await roomOf(fx.owner.token, fx.taskId)
  expect(
    {
      switches: after.config.switches,
      maxRounds: after.config.maxRounds,
      completionGate: after.config.completionGate,
      clarifyBudget: after.config.clarifyBudget,
      fanOut: after.config.fanOut,
      outputContract: after.config.outputContract,
    },
    '任一格没落库 ⇒ 用户在对话框里调完，任务还是按旧参数收场，而界面显示已保存',
  ).toEqual(patch)
  // 没被 patch 触及的字段一格不动——PUT 走的是「只合并自己那几个键」，
  // 整段覆盖的话目标 / 章程 / 名单会被一起冲掉。
  expect(
    {
      goal: after.config.goal,
      instructions: after.config.instructions,
      workgroupId: after.config.workgroupId,
      members: after.config.members.length,
    },
    '改了几个开关，目标 / 章程 / 名单跟着变了 ⇒ 这个 PUT 写的是整段而不是用户改的那几格',
  ).toEqual({
    goal: beforeRoom.config.goal,
    instructions: beforeRoom.config.instructions,
    workgroupId: beforeRoom.config.workgroupId,
    members: beforeRoom.config.members.length,
  })

  // (2) 任务改的是**自己那份副本**。回写到组资源上等于一次临时调参污染了
  //     所有后续任务，而组的编辑页不会显示是谁改的。
  const resourceRow = await getWorkgroup(fx.owner.token, fx.group.id)
  expect(
    {
      maxRounds: resourceRow.maxRounds,
      completionGate: resourceRow.completionGate,
      switches: resourceRow.switches,
      version: resourceRow.version,
    },
    '改任务配置把工作组资源也改了 ⇒ 一次临时调参污染了这个组之后的每一条任务',
  ).toEqual({
    maxRounds: fx.group.maxRounds,
    completionGate: fx.group.completionGate,
    switches: fx.group.switches,
    version: fx.group.version,
  })

  // ---- (3) 加人：名单增长 + 房间里留痕 ------------------------------------
  const addRes = await json<{ changes: string[] }>(
    fx.owner.token,
    cfgPath,
    {
      method: 'PUT',
      body: JSON.stringify({
        addMembers: [
          {
            memberType: 'agent',
            agentId: fx.spareAgentId,
            displayName: 'Auditor',
            roleDesc: 'Reviews',
          },
        ],
      }),
    },
    'add member',
  )
  expect(addRes.changes, '加人没有出现在回执里').toEqual(['added @Auditor (agent)'])
  const withAuditor = await roomOf(fx.owner.token, fx.taskId)
  const auditor = withAuditor.config.members.find((m) => m.displayName === 'Auditor')
  if (auditor === undefined) throw new Error('加进来的成员没有出现在任务名单里')
  expect(
    { memberType: auditor.memberType, agentId: auditor.agentId },
    '加进来的成员没有绑定 canonical agent id ⇒ 引擎解析不出它是谁，这个成员永远轮不到发言',
  ).toEqual({ memberType: 'agent', agentId: fx.spareAgentId })
  expect(
    withAuditor.messages.filter((m) => m.kind === 'system').map((m) => m.bodyMd),
    '中途改名单没有在房间里留下系统消息 ⇒ 成员突然多了一个，没人知道是谁什么时候加的',
  ).toContain('config updated: added @Auditor (agent)')

  // ---- (4) 拒绝分支：各自有可辨的错误码 -----------------------------------
  expectRejection(
    await raw(fx.owner.token, cfgPath, {
      method: 'PUT',
      body: JSON.stringify({
        addMembers: [
          {
            memberType: 'agent',
            agentId: fx.spareAgentId,
            displayName: 'Auditor',
            roleDesc: '',
          },
        ],
      }),
    }),
    422,
    'workgroup-config-duplicate-member',
    '同名成员被放行 ⇒ 房间里出现两个 @Auditor，派单与 @提及全部无法消歧',
  )

  const leaderMemberId = withAuditor.config.members.find((m) => m.displayName === 'Lead')?.id
  expect(leaderMemberId, '任务名单里找不到 leader ⇒ 夹具坏了').toBeTruthy()
  expectRejection(
    await raw(fx.owner.token, cfgPath, {
      method: 'PUT',
      body: JSON.stringify({ removeMemberIds: [leaderMemberId] }),
    }),
    422,
    'workgroup-config-leader-immutable',
    'leader 被允许中途移除 ⇒ leader_worker 任务当场失去主持人，剩下的回合无人派单',
  )

  // ---- (5) 移除刚加的那位：名单收缩，且只收缩这一格 -----------------------
  const removeRes = await json<{ changes: string[] }>(
    fx.owner.token,
    cfgPath,
    { method: 'PUT', body: JSON.stringify({ removeMemberIds: [auditor.id] }) },
    'remove member',
  )
  expect(removeRes.changes, '移除没有出现在回执里').toEqual(['removed @Auditor'])
  const removed = await roomOf(fx.owner.token, fx.taskId)
  expect(
    removed.config.members.map((m) => m.displayName).sort(),
    '移除一个成员把别的成员也带走了（或者根本没移除）',
  ).toEqual(['Lead', 'Ops'])
})

test('RFC-319 WG-34: 运行中改任务配置的两道闸：无改动不给提交（前端禁用 + 服务端 422），任务收场之后连入口都不给 @nightly', async ({
  browser,
}) => {
  const fx = await launchGatedTask('wg34b')
  const cfgPath = `/api/workgroup-tasks/${fx.taskId}/config`

  // ---- 闸一：空 patch ------------------------------------------------------
  // 空写同样会往房间里插一条「config updated:」系统消息、同样会踢一次引擎，
  // 所以它不是无害的 no-op——服务端必须自己挡住，前端只是第一道。
  expectRejection(
    await raw(fx.owner.token, cfgPath, { method: 'PUT', body: '{}' }),
    422,
    'workgroup-config-empty',
    '一个空 patch 被当成一次真改动 ⇒ 房间里凭空多出一条「配置已更新」，讨论记录被冲淡',
  )
  // 一堆**不认识的键**同样等于空：白名单外的字段被 zod 剥掉之后 changes 仍是空的。
  // 这一条挡的是「schema 一放宽，任何拼错的键名都会变成一次成功的空写」。
  const room = await roomOf(fx.owner.token, fx.taskId)
  expectRejection(
    await raw(fx.owner.token, cfgPath, {
      method: 'PUT',
      body: JSON.stringify({ mode: 'free_collab', leaderMemberId: 'x', goal: 'nope' }),
    }),
    422,
    'workgroup-config-empty',
    '白名单外的键（mode / leader / goal）被当成一次改动 ⇒ 中途改配置的白名单形同虚设',
  )
  expect(
    (await roomOf(fx.owner.token, fx.taskId)).config.mode,
    '白名单外的 mode 竟然被写进去了 ⇒ 任务中途换了协作模式，引擎的状态机与已有卡片全部失配',
  ).toBe(room.config.mode)

  const side = await openAs(browser, fx.owner.token)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/tasks/${fx.taskId}`)
    await page.getByTestId('workgroup-room-config-btn').click()
    const dialog = page.getByTestId('workgroup-room-config-dialog')
    await expect(dialog, '房间里点「修改配置」没有弹出对话框').toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId('wg-config-empty-hint'),
      '一格都没改却不说明为什么保存键是灰的 ⇒ 用户只会以为对话框坏了',
    ).toBeVisible()
    await expect(
      page.getByTestId('wg-config-submit'),
      '一格都没改就能提交 ⇒ 用户点下去只会拿到一个服务端 422',
    ).toBeDisabled()

    // 改一格，闸就该放行——否则上面那条禁用断言可能只是「这个键永远是灰的」。
    await page.getByTestId('wg-config-max-rounds').fill(String(room.config.maxRounds + 3))
    await expect(
      page.getByTestId('wg-config-submit'),
      '改了一格保存键仍然禁用 ⇒ 这个对话框根本提交不了',
    ).toBeEnabled()
    await page.getByTestId('wg-config-submit').click()
    await expect(dialog, '提交成功后对话框没有关闭 ⇒ 用户不知道到底存没存上').toHaveCount(0, {
      timeout: 30_000,
    })
    expect(
      (await roomOf(fx.owner.token, fx.taskId)).config.maxRounds,
      '对话框里改的轮次上限没有落库 ⇒ 界面关了、任务还是按旧上限跑',
    ).toBe(room.config.maxRounds + 3)
  } finally {
    await side.context.close()
  }

  // ---- 闸二：任务收场之后不许再改 -----------------------------------------
  //
  // 中途改配置是**给还在跑的任务改航向**。任务已经收场了还能改，改的就是一份
  // 谁都不会再读的 JSON，却仍然往房间里插一条「配置已更新」——事后复盘的人
  // 会以为这次运行里真的发生过这次调参。
  //
  // （账本这一行还写着「并发 roster 变更 409」。那道闸确实在
  // configActions.ts:296-303，但它**在 HTTP 面上不可达**：实测六轮 × 八路并发
  // PUT 全部返回 200（48/48 串行），因为整个 handler 在两次 await 之间就跑完了。
  // 产品为此专门留了 `beforeWriteTransaction` 这个确定性竞态缝
  // （configActions.ts:110，用法见 packages/backend/tests/rfc164-workgroups.test.ts:405-430），
  // 那是它该待的层。这里不写一条靠运气才红的用例。）
  await json<{ taskStatus?: string }>(
    fx.owner.token,
    `/api/workgroup-tasks/${fx.taskId}/confirm`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
    'approve completion gate',
  )
  const finished = await waitForTaskStatus(fx.owner.token, fx.taskId, 'done')
  expect(finished.status, '完成门批准之后任务没有收场 ⇒ 下面这条终态闸测的不是终态').toBe('done')

  expectRejection(
    await raw(fx.owner.token, cfgPath, {
      method: 'PUT',
      body: JSON.stringify({ maxRounds: 2 }),
    }),
    409,
    'workgroup-task-terminal',
    '任务都结束了还能改它的配置 ⇒ 改的是一份没人会再读的 JSON，房间里却多出一条「配置已更新」，复盘时看起来像真的调过参',
  )

  const closed = await openAs(browser, fx.owner.token)
  try {
    await closed.page.goto(`${daemon.baseUrl}/tasks/${fx.taskId}`)
    await expect(
      closed.page.getByTestId('workgroup-room-info'),
      '终态任务的房间打不开 ⇒ 下面那条「没有入口」是恒真的',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      closed.page.getByTestId('workgroup-room-config-btn'),
      '任务已经收场，房间里还挂着「修改配置」⇒ 用户点进去改半天，保存时才吃一个 409',
    ).toHaveCount(0)
  } finally {
    await closed.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-41 —— 收件箱的工作组待办
// ---------------------------------------------------------------------------

test('RFC-319 WG-41: 收件箱工作组待办：待我交付的卡与可确认的完成门各记一格，非成员一格都看不到 @nightly', async ({
  browser,
}) => {
  const fx = await launchGatedTask('wg41')
  const collaborator = await seedUser('wg41-collab')
  const stranger = await seedUser('wg41-stranger')

  // 协作者是**任务成员**但不是工作组的人类成员：他看得见完成门（那是任务级的），
  // 看不见派给别人别名的那张卡（那是成员级的）。这一对反差正是这条计数的语义。
  const addCollab = await raw(fx.owner.token, `/api/tasks/${fx.taskId}/members`, {
    method: 'PUT',
    body: JSON.stringify({ members: [{ userId: collaborator.userId, role: 'collaborator' }] }),
  })
  expect(addCollab.status < 400, `add collaborator: ${addCollab.status} ${addCollab.body}`).toBe(
    true,
  )

  const countOf = (token: string) =>
    json<PendingCount>(token, '/api/workgroup-tasks/pending-count', undefined, 'pending-count')

  // (1) 起手：只有一个待确认的完成门。
  expect(
    await countOf(fx.owner.token),
    '任务停在完成门上，待办计数却是 0 ⇒ 没人会知道有一个门在等他确认，任务就那么停着',
  ).toEqual({ deliveries: 0, gates: 1, total: 1 })

  // (2) 在房间里 @ 人类成员 ⇒ 一张待交付的卡。
  const posted = await json<{ assignmentIds: string[] }>(
    fx.owner.token,
    `/api/workgroup-tasks/${fx.taskId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ body: '@Ops please sanity-check the release notes' }),
    },
    'post dispatch message',
  )
  expect(posted.assignmentIds.length, '@人类成员没有派出卡片 ⇒ 待交付这一格永远是 0').toBe(1)

  expect(
    await countOf(fx.owner.token),
    '派给我的卡没有算进待办 ⇒ 我不会知道有一张卡在等我交付',
  ).toEqual({ deliveries: 1, gates: 1, total: 2 })
  expect(
    await countOf(collaborator.token),
    '协作者被算上了别人别名的那张卡（或者看不到任务级的完成门）⇒ 计数不是按成员身份算的',
  ).toEqual({ deliveries: 0, gates: 1, total: 1 })
  expect(
    await countOf(stranger.token),
    '与这个任务毫无关系的账号也被算上了待办 ⇒ 计数没有按任务可见性过滤，等于泄露任务存在性',
  ).toEqual({ deliveries: 0, gates: 0, total: 0 })

  // (3) 角标与抽屉：用户真正看到的那一格。
  const mine = await openAs(browser, fx.owner.token)
  const theirs = await openAs(browser, collaborator.token)
  const nobody = await openAs(browser, stranger.token)
  try {
    await mine.page.goto(`${daemon.baseUrl}/tasks`)
    await expect(
      mine.page.getByTestId('inbox-footer-badge'),
      '一张待交付的卡 + 一个待确认的完成门 ⇒ 角标应当亮出 2',
    ).toHaveText('2', { timeout: 30_000 })
    await mine.page.getByTestId('inbox-footer-button').click()
    await expect(
      mine.page.getByTestId('inbox-row-workgroups-breakdown'),
      '抽屉里没有把「待交付」与「待确认」拆开 ⇒ 用户点进去才知道该干什么',
    ).toHaveText('1 to deliver · 1 to confirm')

    await theirs.page.goto(`${daemon.baseUrl}/tasks`)
    await expect(
      theirs.page.getByTestId('inbox-footer-badge'),
      '协作者的角标数错了 ⇒ 待办计数没有按「这张卡是不是派给我的」区分',
    ).toHaveText('1', { timeout: 30_000 })
    await theirs.page.getByTestId('inbox-footer-button').click()
    await expect(theirs.page.getByTestId('inbox-row-workgroups-breakdown')).toHaveText(
      '0 to deliver · 1 to confirm',
    )

    await nobody.page.goto(`${daemon.baseUrl}/tasks`)
    await nobody.page.getByTestId('inbox-footer-button').click()
    await expect(
      nobody.page.getByTestId('inbox-drawer'),
      '陌生人的收件箱抽屉打不开 ⇒ 下面那条「没有工作组待办行」是恒真的',
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      nobody.page.getByTestId('inbox-row-workgroups'),
      '与这个任务毫无关系的账号，收件箱里却列出了工作组待办',
    ).toHaveCount(0)
  } finally {
    await mine.context.close()
    await theirs.context.close()
    await nobody.context.close()
  }
})

// ---------------------------------------------------------------------------
// WG-43 —— 定时任务以工作组形态启动
// ---------------------------------------------------------------------------

test('RFC-319 WG-43: 定时任务以工作组形态启动：目标 id 冻进 payload、一次性 fence 键拒收、列表按执行主体筛得出来、run-now 真跑出一条组任务 @nightly', async ({
  page,
}) => {
  const prefix = `rfc319-wg43-${++sequence}`
  const leadAgentId = await seedAgent(daemon.token, `${prefix}-lead`)
  const workerAgentId = await seedAgent(daemon.token, `${prefix}-worker`)
  const group = await seedWorkgroup(daemon.token, {
    name: `${prefix}-group`,
    description: 'fired by a schedule',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    completionGate: false,
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead', roleDesc: '' },
      { memberType: 'agent', agentId: workerAgentId, displayName: 'Builder', roleDesc: '' },
    ],
  })

  // 远期 spec：`interval every 30 days` ⇒ 后台 tick 在用例期间绝不会碰它，
  // 触发只可能来自这条用例自己按的 run-now。
  const farFuture = { kind: 'interval' as const, every: 30, unit: 'days' as const }

  // (1) 一次性 fence 键必须被拒。它们是「本次提交」的 OCC 值：存进一条会反复
  //     触发的定时行里，组一旦被编辑过，之后每一次触发都会 409 —— 而没有人在看。
  for (const forbidden of ['expectedWorkgroupVersion', 'expectedWorkgroupId'] as const) {
    expectRejection(
      await raw(daemon.token, '/api/scheduled-tasks', {
        method: 'POST',
        body: JSON.stringify({
          name: `${prefix}-rejected-${forbidden}`,
          launchKind: 'workgroup',
          scheduleSpec: farFuture,
          launchPayload: {
            workgroupId: group.id,
            name: `${prefix}-run`,
            goal: 'never stored',
            scratch: true,
            [forbidden]: forbidden === 'expectedWorkgroupId' ? group.id : 1,
          },
        }),
      }),
      422,
      'scheduled-task-invalid',
      `定时 payload 收下了一次性的 ${forbidden} ⇒ 组被编辑一次之后，这条定时任务从此每次都静默失败`,
    )
  }

  // (2) 正常创建：服务端把**当前组名**刷进 payload 作为展示快照，identity 仍是 id。
  const schedule = await json<{
    id: string
    launchKind: string
    launchPayload: Record<string, unknown>
    enabled: boolean
    nextRunAt: number | null
  }>(
    daemon.token,
    '/api/scheduled-tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-schedule`,
        launchKind: 'workgroup',
        scheduleSpec: farFuture,
        launchPayload: {
          workgroupId: group.id,
          name: `${prefix}-run`,
          goal: 'run the rfc319 group on a schedule',
          scratch: true,
        },
      }),
    },
    'create workgroup schedule',
  )
  expect(
    {
      launchKind: schedule.launchKind,
      workgroupId: schedule.launchPayload.workgroupId,
      workgroupName: schedule.launchPayload.workgroupName,
    },
    '定时行没有把 canonical 组 id 冻进 payload（或者只冻了名字）⇒ 组一改名这条定时任务就再也起不来',
  ).toEqual({ launchKind: 'workgroup', workgroupId: group.id, workgroupName: group.name })
  expect(schedule.nextRunAt !== null, '新建的定时任务没有排下一次触发 ⇒ 它永远不会自己跑起来').toBe(
    true,
  )

  // (3) 对照行：同一份列表里放一条 agent 形态的定时任务，下面的筛选才有分辨力。
  const contrastAgentId = await seedAgent(daemon.token, `${prefix}-solo`)
  const contrast = await json<{ id: string }>(
    daemon.token,
    '/api/scheduled-tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-agent-schedule`,
        launchKind: 'agent',
        scheduleSpec: farFuture,
        launchPayload: {
          agentId: contrastAgentId,
          name: `${prefix}-agent-run`,
          description: 'rfc319 contrast row',
          scratch: true,
        },
      }),
    },
    'create agent schedule',
  )

  await primeAuth(page, daemon.token)
  await page.goto(`${daemon.baseUrl}/scheduled`)
  await expect(page.getByTestId('scheduled-table')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('scheduled-search').fill(prefix)
  await expect(page.locator('.scheduled-operations__row')).toHaveCount(2)
  await expect(
    page.getByTestId(`scheduled-row-${schedule.id}`),
    '工作组形态的定时任务不在列表里 ⇒ 用户既看不到也管不了它',
  ).toContainText('Workgroup')

  // 按执行主体筛：工作组这一档必须只留下工作组行。筛选失效时用户在几十条规则里
  // 找不到「哪些是工作组任务」，而这三种主体的排障方式完全不同。
  await page.getByTestId('scheduled-filter-button').click()
  const filterDialog = page.getByTestId('scheduled-filter-dialog')
  await expect(filterDialog).toBeVisible()
  await filterDialog.getByRole('radio', { name: 'Workgroup', exact: true }).click()
  await filterDialog.getByRole('button', { name: 'Apply filters' }).click()
  await expect(
    page.getByTestId(`scheduled-row-${schedule.id}`),
    '按「工作组」筛之后，工作组那条自己没了',
  ).toBeVisible()
  await expect(
    page.getByTestId(`scheduled-row-${contrast.id}`),
    '按「工作组」筛之后，agent 形态那条还留着 ⇒ 执行主体筛选形同虚设',
  ).toHaveCount(0)

  // (4) run-now：真的按这条 payload 铸出一条**工作组**任务并跑完。
  const fired = await json<{ taskId: string }>(
    daemon.token,
    `/api/scheduled-tasks/${schedule.id}/run-now`,
    { method: 'POST', body: '{}' },
    'run-now',
  )
  const task = await waitForTaskStatus(daemon.token, fired.taskId, 'done')
  expect(
    { workgroupId: task.workgroupId, scheduledTaskId: task.scheduledTaskId },
    '定时触发出来的任务没有挂在这个组 / 这条定时任务上 ⇒ 运行历史与组入口都对不上号',
  ).toEqual({ workgroupId: group.id, scheduledTaskId: schedule.id })
  expect(
    (await roomOf(daemon.token, fired.taskId)).config.goal,
    '定时 payload 里存的目标没有传进任务 ⇒ 组成员每一轮拿到的是空目标',
  ).toBe('run the rfc319 group on a schedule')
})

// ---------------------------------------------------------------------------
// WG-44 —— Webhook 触发工作组任务
// ---------------------------------------------------------------------------

test('RFC-319 WG-44: Webhook 触发工作组任务：事件变量渲染进组目标、fire 记 launched，任务带着 workgroupId 跑到 done @nightly', async () => {
  const prefix = `rfc319-wg44-${++sequence}`
  const repoPath = `rfc319/wg44-${sequence}`
  const leadAgentId = await seedAgent(daemon.token, `${prefix}-lead`)
  const workerAgentId = await seedAgent(daemon.token, `${prefix}-worker`)
  const group = await seedWorkgroup(daemon.token, {
    name: `${prefix}-group`,
    description: 'fired by a webhook delivery',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    completionGate: false,
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead', roleDesc: '' },
      { memberType: 'agent', agentId: workerAgentId, displayName: 'Builder', roleDesc: '' },
    ],
  })

  const endpoint = await json<{ id: string; urlToken: string; secret: string }>(
    daemon.token,
    '/api/webhook-endpoints',
    { method: 'POST', body: JSON.stringify({ name: `${prefix}-endpoint`, provider: 'gitlab' }) },
    'create endpoint',
  )
  const trigger = await json<{ id: string }>(
    daemon.token,
    '/api/webhook-triggers',
    {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-trigger`,
        endpointId: endpoint.id,
        enabled: true,
        repoScope: { kind: 'exact', paths: [repoPath] },
        eventTypes: ['pipeline_failed'],
        maxConsecutiveFires: 5,
        // 事件仓库并未注册进平台，所以走临时工作区；临时工作区与
        // autoRegisterRepos 互斥（没有事件仓库可注册）。
        autoRegisterRepos: false,
        launchKind: 'workgroup',
        launchRefId: group.id,
        launchPayload: {
          scratch: true,
          goal: 'Triage {{trigger.webhook.repo_path}} (pipeline {{trigger.webhook.pipeline_status}})',
        },
      }),
    },
    'create workgroup trigger',
  )

  const delivery = await fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gitlab-token': endpoint.secret,
      'x-gitlab-event': 'Pipeline Hook',
      'x-gitlab-event-uuid': `${prefix}-uuid`,
    },
    body: JSON.stringify({
      object_kind: 'pipeline',
      user: { username: 'rfc319-bot' },
      project: {
        path_with_namespace: repoPath,
        web_url: `https://gitlab.invalid/${repoPath}`,
        git_http_url: `https://gitlab.invalid/${repoPath}.git`,
        git_ssh_url: `git@gitlab.invalid:${repoPath}.git`,
      },
      object_attributes: {
        id: sequence,
        ref: 'main',
        status: 'failed',
        sha: `sha${sequence}`,
        url: `https://gitlab.invalid/${repoPath}/-/pipelines/${sequence}`,
      },
    }),
  })
  expect(delivery.status, `delivery: ${await delivery.text()}`).toBe(200)

  // 投递是异步分发的：等一条真的 fire 记录落库。
  let fires: Array<{ outcome: string; taskId: string | null; error: string | null }> = []
  await expect
    .poll(
      async () => {
        fires = await json(
          daemon.token,
          `/api/webhook-triggers/${trigger.id}/fires`,
          undefined,
          'read fires',
        )
        return fires.length
      },
      {
        timeout: 60_000,
        message: '一条完全命中的流水线失败事件没有触发任何一次 fire ⇒ 工作组这条启动通路整条不通',
      },
    )
    .toBe(1)
  const fire = fires[0] as { outcome: string; taskId: string | null; error: string | null }
  expect(
    { outcome: fire.outcome, error: fire.error },
    'webhook 命中了却没有把工作组任务启动起来（触发历史里的原文在下方）',
  ).toEqual({ outcome: 'launched', error: null })
  expect(fire.taskId, 'fire 记了 launched 却没有记下任务 id ⇒ 排障时找不到那条任务').toBeTruthy()

  const taskId = fire.taskId as string
  const task = await waitForTaskStatus(daemon.token, taskId, 'done')
  expect(
    task.workgroupId,
    'webhook 启动出来的任务没有挂在这个工作组上 ⇒ 房间入口 / 组维度的统计全都看不到它',
  ).toBe(group.id)

  // 模板变量必须**渲染过**：没渲染的话组成员每一轮拿到的是一串 `{{…}}` 字面量。
  expect(
    (await roomOf(daemon.token, taskId)).config.goal,
    '事件变量没有渲染进组目标 ⇒ 成员每一轮拿到的是一串 {{trigger.webhook.…}} 字面量',
  ).toBe(`Triage ${repoPath} (pipeline failed)`)
})

// ---------------------------------------------------------------------------
// WG-45 —— 启动时的 fence 与拒绝路径
// ---------------------------------------------------------------------------

test('RFC-319 WG-45: 启动的五条拒绝路径各有可辨的状态码与原因：版本 409、未就绪 422、成员 agent 已删 422 agent-missing、退役键 422、越权重放 404 @nightly', async () => {
  const owner = await seedUser('wg45')
  const prefix = `rfc319-wg45-${owner.username}`
  const leadAgentId = await seedAgent(owner.token, `${prefix}-lead`)
  const doomedAgentId = await seedAgent(owner.token, `${prefix}-doomed`)

  const ready = await seedWorkgroup(owner.token, {
    name: `${prefix}-ready`,
    description: 'launch-ready',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    completionGate: false,
    members: [{ memberType: 'agent', agentId: leadAgentId, displayName: 'Lead', roleDesc: '' }],
  })
  const body = (extra: Record<string, unknown> = {}) => ({
    name: `${prefix}-task`,
    goal: 'should be refused',
    scratch: true,
    ...extra,
  })

  // ---- ① 版本 fence：组在你按下启动之前被改过 ------------------------------
  const bumped = await raw(owner.token, `/api/workgroups/${ready.id}/rename`, {
    method: 'POST',
    body: JSON.stringify({
      newName: ready.name,
      description: 'edited between the deep link and the launch',
      expectedVersion: ready.version,
      clientMutationId: newMutationId(),
    }),
  })
  expect(bumped.status < 400, `bump workgroup: ${bumped.status} ${bumped.body}`).toBe(true)
  const nowVersion = (await getWorkgroup(owner.token, ready.id)).version
  expect(nowVersion, '组没有真的被改到新版本 ⇒ 下面这条 fence 断言是恒真的').toBeGreaterThan(
    ready.version,
  )

  const staleDetails = expectRejection(
    await raw(owner.token, `/api/workgroups/${ready.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body({ expectedWorkgroupVersion: ready.version })),
    }),
    409,
    'resource-operation-stale',
    '拿着过期版本也能启动 ⇒ 用户在向导里慢慢填目标的时候别人改了组，启动的是他没看过的那一版',
  )
  expect(
    {
      resource: staleDetails.resource,
      expected: staleDetails.expectedVersion,
      current: staleDetails.currentVersion,
    },
    '版本冲突没有说清「你以为的是哪一版、现在是哪一版」⇒ 用户不知道该不该重来一次',
  ).toEqual({ resource: 'workgroup', expected: ready.version, current: nowVersion })

  // 同一个请求换成**当前**版本必须放行——否则上面那条只证明「带 fence 就一律拒」。
  const accepted = await raw(owner.token, `/api/workgroups/${ready.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify(body({ expectedWorkgroupVersion: nowVersion, name: `${prefix}-ok` })),
  })
  expect(
    accepted.status,
    `带着当前版本也启动不了 ⇒ fence 把所有人都挡住了（${accepted.body}）`,
  ).toBe(201)
  const replaySourceTaskId = (JSON.parse(accepted.body) as TaskRow).id

  // ---- ② 名单未就绪：缺 leader ---------------------------------------------
  const noLeader = await seedWorkgroup(owner.token, {
    name: `${prefix}-noleader`,
    description: 'no designated leader',
    mode: 'leader_worker',
    members: [{ memberType: 'agent', agentId: leadAgentId, displayName: 'Worker', roleDesc: '' }],
  })
  const notReady = expectRejection(
    await raw(owner.token, `/api/workgroups/${noLeader.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body()),
    }),
    422,
    'workgroup-not-ready',
    '没有 leader 的 leader_worker 组也能启动 ⇒ 任务起来之后没人派单，第一回合就卡死',
  )
  expect(
    notReady.reasons,
    '未就绪没有说清缺的是什么 ⇒ 用户不知道该去加人还是去指定 leader',
  ).toEqual(['leader-missing'])

  // ---- ③ 成员 agent 被删：与「未就绪」同码，但原因必须可辨 -------------------
  //
  // 名单对 agent 删除是**宽容**的（保存时不拦），所以这个组在界面上看起来完全正常。
  // 启动是最后一道闸；它若放行，任务会在 worktree 都建好之后才在引擎里炸。
  const doomedGroup = await seedWorkgroup(owner.token, {
    name: `${prefix}-doomed-group`,
    description: 'its member agent gets deleted',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [{ memberType: 'agent', agentId: doomedAgentId, displayName: 'Lead', roleDesc: '' }],
  })
  const doomedRow = await json<{ name: string; updatedAt: number; aclRevision?: number }>(
    owner.token,
    `/api/agents/${doomedAgentId}`,
    undefined,
    'read doomed agent',
  )
  const deleted = await raw(owner.token, `/api/agents/${doomedAgentId}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: doomedRow.name,
      expectedUpdatedAt: doomedRow.updatedAt,
      expectedAclRevision: doomedRow.aclRevision ?? 0,
    }),
  })
  expect(deleted.status < 400, `delete member agent: ${deleted.status} ${deleted.body}`).toBe(true)
  const missing = expectRejection(
    await raw(owner.token, `/api/workgroups/${doomedGroup.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body()),
    }),
    422,
    'workgroup-not-ready',
    '成员 agent 已经被删了还能启动 ⇒ 任务会在建完 worktree 之后才在引擎里炸',
  )
  // 名字这一格给的是**被删掉那个 agent 的名字**（launch.ts:249-251 取
  // `member.agentName`），不是成员在组里的别名——用户要去找的是那个 agent。
  expect(
    { reasons: missing.reasons, names: missing.missingAgentNames },
    '成员 agent 缺失与「缺 leader」用了同一句话 ⇒ 用户看不出到底是哪一类问题、也不知道缺的是谁',
  ).toEqual({ reasons: ['agent-missing'], names: [doomedRow.name] })

  // ---- ④ 退役键：静默降级比报错更坏 -----------------------------------------
  expectRejection(
    await raw(owner.token, `/api/workgroups/${ready.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-retired`,
        goal: 'should be refused',
        scratch: true,
        repoPath: '/tmp/rfc319-retired',
      }),
    }),
    422,
    'start-task-path-retired',
    '退役的 repoPath 被静默剥掉 ⇒ 用户以为任务跑在他指定的目录上，实际跑在一个空白临时空间里',
  )

  // ---- ⑤ sourceTaskId 越权重放：不可见与不存在同形 --------------------------
  //
  // sourceTaskId 由调用方控制。不校验可见性的话，「能启动某个组但看不见任务 X」的
  // 人可以传 X 的 id，让服务端按 X 冻结的仓库构成物化——而且泄漏形式是「任务成功
  // 启动」，完全不像一次越权。
  const outsider = await seedUser('wg45-outsider')
  const outsiderAgentId = await seedAgent(outsider.token, `${prefix}-outsider-agent`)
  const outsiderGroup = await seedWorkgroup(outsider.token, {
    name: `${prefix}-outsider-group`,
    description: 'belongs to somebody else',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    members: [{ memberType: 'agent', agentId: outsiderAgentId, displayName: 'Lead', roleDesc: '' }],
  })
  expectRejection(
    await raw(outsider.token, `/api/workgroups/${outsiderGroup.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name: `${prefix}-replay`,
        goal: 'replay somebody else layout',
        sourceTaskId: replaySourceTaskId,
      }),
    }),
    404,
    'task-not-found',
    '陌生人可以按别人任务的 id 重放布局 ⇒ 越权读的形式是「任务成功启动」，事后完全看不出来',
  )
  // 同一个 id 交给**看得见它**的人，必须不是同一条拒绝——否则上面那条 404 可能
  // 只是因为 sourceTaskId 这条路整个不通。
  const ownReplay = await raw(owner.token, `/api/workgroups/${ready.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      name: `${prefix}-own-replay`,
      goal: 'replay my own layout',
      sourceTaskId: replaySourceTaskId,
    }),
  })
  const ownCode =
    ownReplay.status >= 400
      ? ((JSON.parse(ownReplay.body) as { code?: string }).code ?? null)
      : null
  expect(
    ownCode,
    '任务的主人重放自己的任务也吃 task-not-found ⇒ 上面那条越权断言锁的是「这条路不通」，不是可见性',
  ).not.toBe('task-not-found')
})
