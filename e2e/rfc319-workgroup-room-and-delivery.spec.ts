// RFC-319 —— 工作组「房间实时 / 发言 / 派单与交付」能力簇的用户面 e2e。
//
// 覆盖能力账本行：WG-29 / WG-30 / WG-31 / WG-32 / WG-33 / WG-35 / WG-36 / WG-37 / WG-38。
//
// 与既有工作组 spec 的分工（**务必不要重复**）：
//   · e2e/rfc319-workgroup-crud.spec.ts   —— 列表 / 新建 / 重命名 / 复制 / 删除，全在资源面；
//   · e2e/rfc319-workgroup-editor.spec.ts —— 详情编辑器的配置 / 成员 / 就绪性 / 离开守卫；
//   · e2e/rfc319-workgroup-acl.spec.ts    —— 可见性与授权档，房间只作为「看不看得见」的对象；
//   · e2e/workgroup-matrix.spec.ts        —— leader-worker / free-collab 全链，**全程 apiFetch**，
//                                            一次都不开浏览器，房间的界面契约它一格都没锁；
//   · e2e/rfc229-workgroup-message-quotes.spec.ts —— 消息引用的四格（预览上一条 / 点击跳转 +
//                                            聚焦 + 高亮 / 390px 不撑破气泡 / reduced-motion 立即跳）。
//     **本文件的 WG-37 只补它没做的两格**：①被引用的是一条**系统**消息时，引用头要落到
//     「System」而不是成员占位（`messageAuthorLabel` 的 system 分支——rfc229 的父消息一律是
//     member 作者，这一支在引用预览这条路径上从来没人走过）；②高亮是**一过性**的（1600ms 后
//     自行熄灭）而焦点留在目标上——rfc229 只断言高亮出现，熄灭那半截没人看，把
//     `RoomTimeline.tsx` 里那个 1600ms 的 setTimeout 删掉它照样全绿。
//     **没写进来的那一格**：`referenceUnavailable`（引用的原消息不在房间里）在产品里**不可达**
//     ——`workgroup_messages.trigger_message_id` 是指向本表的外键且 `ON DELETE SET NULL`，
//     悬空指针根本存不进库；而房间聚合是按 task 全量取消息的（room.ts:439-444 无分页无窗口），
//     所以「非空 trigger 却查不到」这个状态构造不出来。按 docs/dev-gotchas.md
//     §「变异不咬人有三种成因」的第 2 类处置：如实登记，不为了让它可测去改产品。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//  WG-29  房间发言是人推动一个已经停机的组任务的唯一手段。不带 @ 的话若只写进消息表而不
//         kickResume，任务就永远停在 awaiting_human——界面上消息发出去了、看起来一切正常，
//         实际没有任何人被叫醒（而 `pause.leaderIdle` 的文案正明写着「发一条消息即可继续」）。
//         带 @ 的话若 resolveMentions 失灵，被点名的人收不到卡，用户以为派活了其实没有。
//  WG-30  别名补全是「@ 到底该写谁」的唯一提示。弹层不出、或方向键 / Enter 不接管，用户只能
//         凭记忆手打别名——打错一个字符就静默变成一条谁也没 @ 到的黑板留言。
//  WG-31  人类成员的卡是「轮到你了」的唯一入口。交付若不落库，卡永远停在 dispatched、组任务
//         永远等一个已经交了的人；重复交付若不拒，同一张卡会被写出第二条结果消息，leader
//         的账本里凭空多一份自相矛盾的交付。
//  WG-32  取消是派错单之后唯一的收回手段。若允许取消已交付 / 已取消的卡，卡状态机被击穿
//         （delivered→canceled 在 lifecycle 的转移表里根本不存在），组任务的账本随之错乱。
//  WG-33  完成门是人对「agent 说完事了」的唯一否决点。驳回若能空评论提交，leader 下一轮拿到
//         的是一条空反馈，只能原样再宣布一次完成——用户陷入「点了驳回什么都没变」的循环。
//  WG-35  右栏花名册是「现在谁在忙」的唯一读数。四态若都读同一个数据源（或只读 assignments），
//         leader 轮 / 被 @ 轮执行时会显示「空闲」，与同屏的执行中 pill 自相矛盾。
//  WG-36  抽屉里的「运行历史」若不按成员收口，同一个 `__wg_member__` 节点上所有成员的回合会
//         混在一张列表里——用户点进 researcher 的会话，看到的是 builder 的历史。
//  WG-37  引用一条系统播报时若认不出作者，预览头会显示成「@?」这种占位，用户读不出自己在
//         回哪一句；高亮若不熄灭，读完之后整条消息一直亮着，下一次跳转反而分不清跳到了哪。
//  WG-38  「停止追问」是可逆的；房间是工作组任务唯一的恢复入口（普通任务靠画布上的开关，
//         工作组没有画布）。chip 不出或恢复按钮不发请求 = 这个停止变成了单程票。
//
// 判据取自（纯文本引用，勿改成外链）：
//   packages/backend/src/services/workgroup/taskActions.ts:196-266   —— postRoomMessage：@ 派单 + 无 @ 落黑板 + kickResumeIfResumable
//   packages/backend/src/services/workgroup/taskActions.ts:52-55     —— isWorkgroupKickResumable（awaiting_human / interrupted）
//   packages/backend/src/services/workgroup/taskActions.ts:509-524   —— resolveMentions（花名册 token、去重、顺序稳定）
//   packages/backend/src/services/workgroup/taskActions.ts:268-336   —— deliverAssignment：双形态归一 + dispatched→delivered CAS + 409
//   packages/backend/src/services/workgroup/taskActions.ts:338-430   —— confirmGate：approve / reject（ConfirmSchema 的 refine 要求 reject 必带 comment）
//   packages/backend/src/services/workgroup/taskActions.ts:432-479   —— cancelAssignment：open|dispatched → canceled，其余 409
//   packages/backend/src/services/workgroup/wake.ts:243-266          —— leader 的 new-content 唤醒（无 @ 消息把停机任务拉回引擎）
//   packages/backend/src/services/workgroup/room.ts:540-551          —— clarifyStops 聚合（directive='stop' 且 shardKey≠''）
//   packages/backend/src/services/workgroup/room.ts:186-270          —— deriveWorkgroupRunHistory + open-clarify 的 awaiting_human 投影
//   packages/frontend/src/components/workgroup/room/RoomComposer.tsx:88-118,124-160 —— @ 补全弹层 / commitMention / Esc 会话式关闭
//   packages/frontend/src/components/workgroup/room/DispatchCard.tsx:100-206        —— 卡片状态 chip / 交付入口 / 取消按钮
//   packages/frontend/src/components/workgroup/room/DeliverFormDialog.tsx:26-70     —— 结构化交付表单
//   packages/frontend/src/components/workgroup/room/RoomSideCards.tsx:73-160        —— 花名册四态 chip / ×N 徽标 / 在线点 / 进 session
//   packages/frontend/src/components/workgroup/room/RoomSideCards.tsx:279-300       —— clarifyStops chip + 恢复按钮
//   packages/frontend/src/components/workgroup/room/RoomTimeline.tsx:140-170        —— jumpToMessage：聚焦 + 1600ms 一过性高亮
//   packages/frontend/src/components/workgroup/room/RoomTimeline.tsx:392-406        —— referencedMessage / referenceUnavailable 两支
//   packages/frontend/src/components/workgroup/room/WorkgroupRoom.tsx:180-190       —— drawerRuns 的成员作用域收口
//   packages/frontend/src/components/workgroup/room/WorkgroupRoom.tsx:246-292       —— 完成门驳回对话框（空评论 disabled）
//   packages/frontend/src/lib/workgroup-room.ts:256-278                             —— deriveMemberPresence 四态
//   packages/frontend/src/lib/workgroup-room.ts:295-318                             —— countMemberActiveRuns（×N 的数据预言）
//   packages/frontend/src/lib/workgroup-room.ts:413-415                             —— isAssignmentCancelable
//
// 夹具形态（为什么必须用 workgroup-matrix 这个 stub）：
//   房间的写操作全部要求任务**非终态**，而 `basic` stub 的 leader 第一轮就宣布完成、任务当场
//   收敛，根本没有可发言的窗口。`workgroup-matrix` 的 `showcase-wg-lead` 给出三条可控形态：
//     · clarifyBudget=0  ⇒ 它的 <workflow-clarify> 被判 clarify-forbidden，走 drop-and-continue，
//                          连吃三次自动 nudge 后停在 awaiting_human / **leader-idle**——这正是
//                          「一条黑板留言就能唤醒」的那种停机（WG-29 要的就是它）；
//     · clarifyBudget=2  ⇒ 反问成立，任务停在 awaiting_human / **leader-clarify**，leader 被
//                          结构性抑制、不再自己动，房间因此是**安静**的（其余用例要的就是它）；
//     · goal 里带上它认的三句完成标记 ⇒ 第一轮直接宣布完成，任务停在 awaiting_review + 完成门
//                          待确认（WG-33 要的就是它）。
//   成员派单同理复用它认得的两个任务标题（research-release / implementation-v1-tests），于是
//   「人 @ 一个 agent 成员 → 真的跑出一条 member run」这条链是真跑的，不是伪造的行。
//
// 「服务端到底怎么样了」一律回读 GET /api/workgroup-tasks/{id}/room，不只信界面、也不只信回执。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(240_000)

// ---------------------------------------------------------------------------
// 类型（只声明本文件断言用得到的字段）
// ---------------------------------------------------------------------------

interface RoomMessage {
  id: string
  kind: string
  authorKind: string
  authorMemberId: string | null
  bodyMd: string
  templateKey: string | null
  templateParams: Record<string, unknown> | null
  mentionMemberIds: string[]
  assignmentId: string | null
  triggerMessageId: string | null
  createdAt: number
}

interface RoomAssignment {
  id: string
  source: string
  assigneeMemberId: string | null
  title: string
  status: string
  nodeRunId: string | null
  resultMessageId: string | null
}

interface RoomRunEntry {
  nodeRunId: string
  memberId: string
  kind: string
  status: string
}

interface RoomMember {
  id: string
  memberType: 'agent' | 'human'
  displayName: string
}

interface Room {
  taskStatus: string
  pauseReason: string | null
  clarifyStops: Array<{ nodeId: string; askerKey: string }>
  gate: {
    declaredDone: boolean
    awaitingConfirmation: boolean
    rejected: boolean
    summary: string | null
  }
  config: { members: RoomMember[] }
  messages: RoomMessage[]
  assignments: RoomAssignment[]
  runHistory: RoomRunEntry[]
  memberRuns: Record<string, { nodeRunId: string; status: string } | null>
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 必须与 packages/system-mocks/src/runtime/mode-workgroup-matrix.ts 的 `--agent` 分支同名。 */
const AGENT_NAMES = [
  'showcase-wg-lead',
  'showcase-wg-researcher',
  'showcase-wg-builder',
  'showcase-wg-spare',
] as const
/** stub 的 requirePrompt 判据：charter 必须带这一串，否则 leader 直接 exit 10。 */
const CHARTER = 'WG_MATRIX_CHARTER coordinate, verify, and revise after human feedback.'
const GOAL_PREFIX = 'WG_MATRIX_GOAL literal {{do_not_expand}}.'
/** stub 认得的三句完成标记同时出现 ⇒ leader 第一轮就宣布 done（于是走完成门）。 */
const GOAL_DONE = `${GOAL_PREFIX} research complete. implementation-code-v1 complete. implementation-tests-v1 complete.`
const GOAL_OPEN = `${GOAL_PREFIX} Investigate the rollback path before shipping.`
/** stub 在「完成门被驳回」分支上要求原样看到这一串，否则 exit 10。 */
const REJECTION_TOKEN = 'REVISE_AFTER_GATE_REJECTION'

let daemon: DaemonHandle
let stateDir = ''
let adminUserId = ''
/** clarifyBudget=0 —— 任务停在 leader-idle（可被一条黑板留言唤醒）。 */
let idleGroupId = ''
/** clarifyBudget=2 —— 任务停在 leader-clarify（leader 被抑制，房间安静）。 */
let quietGroupId = ''

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path} ⇒ ${res.status} ${body}`).toBe(true)
  return (body === '' ? undefined : JSON.parse(body)) as T
}

/** 只读一次服务端真值；每条「落库了吗」的断言都从这里取。 */
function roomOf(taskId: string): Promise<Room> {
  return api<Room>(`/api/workgroup-tasks/${encodeURIComponent(taskId)}/room`)
}

/** 拒绝路径要的是状态码与错误码，所以单独一条不做 expect(ok) 的读法。 */
async function rawPost(
  path: string,
  body?: unknown,
): Promise<{ status: number; code: string | null; text: string }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let code: string | null = null
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null
  } catch {
    code = null
  }
  return { status: res.status, code, text }
}

/** 轮询房间聚合到某个形态，再把那一份原样交回来逐字段对账。 */
async function waitForRoom(
  taskId: string,
  predicate: (room: Room) => boolean,
  message: string,
  timeout = 45_000,
): Promise<Room> {
  await expect
    .poll(async () => predicate(await roomOf(taskId)), { message, timeout, intervals: [300] })
    .toBe(true)
  return roomOf(taskId)
}

async function createGroup(input: {
  name: string
  clarifyBudget: number
  agentIds: Record<string, string>
}): Promise<string> {
  const group = await api<{ id: string }>('/api/workgroups', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      description: 'RFC-319 workgroup room fixture',
      instructions: CHARTER,
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: true, blackboard: true },
      maxRounds: 60,
      completionGate: true,
      clarifyBudget: input.clarifyBudget,
      fanOut: true,
      members: [
        {
          memberType: 'agent',
          agentId: input.agentIds['showcase-wg-lead'],
          displayName: 'lead',
          roleDesc: 'decompose and govern',
        },
        {
          memberType: 'agent',
          agentId: input.agentIds['showcase-wg-researcher'],
          displayName: 'researcher',
          roleDesc: 'read-only release research',
        },
        {
          memberType: 'agent',
          agentId: input.agentIds['showcase-wg-builder'],
          displayName: 'builder',
          roleDesc: 'implementation shards',
        },
        {
          memberType: 'agent',
          agentId: input.agentIds['showcase-wg-spare'],
          displayName: 'spare',
          roleDesc: 'stays idle on purpose',
        },
        {
          memberType: 'human',
          userId: adminUserId,
          displayName: 'owner',
          roleDesc: 'answer questions and approve completion',
        },
      ],
    }),
  })
  return group.id
}

async function launchTask(groupId: string, name: string, goal: string): Promise<string> {
  const task = await api<{ id: string }>(`/api/workgroups/${encodeURIComponent(groupId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ name, goal, scratch: true }),
  })
  return task.id
}

/** 起一个停在 leader-clarify 的安静房间（leader 结构性不再自己动）。 */
async function quietTask(name: string): Promise<string> {
  const taskId = await launchTask(quietGroupId, name, GOAL_OPEN)
  const room = await waitForRoom(
    taskId,
    (r) => r.taskStatus === 'awaiting_human',
    `${name} 没有停在 awaiting_human`,
  )
  expect(room.pauseReason, `${name} 的停机成因不是 leader-clarify ⇒ 房间不会保持安静`).toBe(
    'leader-clarify',
  )
  return taskId
}

/** 起一个停在完成门待确认的任务。 */
async function gateTask(name: string): Promise<string> {
  const taskId = await launchTask(quietGroupId, name, GOAL_DONE)
  const room = await waitForRoom(
    taskId,
    (r) => r.taskStatus === 'awaiting_review',
    `${name} 没有停在 awaiting_review`,
  )
  expect(room.gate.awaitingConfirmation, `${name} 的完成门没有打开 ⇒ 右栏不会渲染门卡片`).toBe(true)
  return taskId
}

function memberId(room: Room, displayName: string): string {
  const member = room.config.members.find((m) => m.displayName === displayName)
  if (member === undefined) throw new Error(`RFC-319 fixture roster has no @${displayName}`)
  return member.id
}

/** 人在房间里发言（夹具用；用户面的发言路径由 WG-29 亲自走界面）。 */
async function postMessage(taskId: string, body: string): Promise<void> {
  await api(`/api/workgroup-tasks/${encodeURIComponent(taskId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

/** 给人类成员 @owner 开一张 dispatched 卡，返回卡 id。 */
async function dispatchHumanCard(taskId: string, title: string): Promise<string> {
  const before = new Set((await roomOf(taskId)).assignments.map((a) => a.id))
  await postMessage(taskId, `@owner ${title}`)
  const room = await waitForRoom(
    taskId,
    (r) => r.assignments.some((a) => !before.has(a.id)),
    `@owner ${title} 没有开出派单卡`,
  )
  const card = room.assignments.find((a) => !before.has(a.id))
  if (card === undefined) throw new Error('RFC-319 fixture: human dispatch produced no card')
  return card.id
}

async function authPage(page: Page): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [daemon.baseUrl, daemon.token] as const,
  )
}

async function openRoom(page: Page, taskId: string): Promise<void> {
  await authPage(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=chatroom`)
  await expect(
    page.getByTestId('workgroup-room'),
    '聊天室根本没渲染 ⇒ 后面每一条断言都失去意义',
  ).toBeVisible()
}

function composer(page: Page): Locator {
  return page.getByTestId('workgroup-room-input')
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

/** 记录浏览器往某条 pathname 发过几次请求（用来证明「按不下去 = 一次都没发」）。 */
function countPosts(page: Page, pathname: string): { count: () => number; bodies: () => string[] } {
  let n = 0
  const bodies: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    if (new URL(request.url()).pathname !== pathname) return
    n += 1
    bodies.push(request.postData() ?? '')
  })
  return { count: () => n, bodies: () => bodies }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  stateDir = mkdtempSync(join(tmpdir(), 'rfc319-wgroom-state-'))
  daemon = await startDaemon({
    stubMode: 'workgroup-matrix',
    extraEnv: { WORKGROUP_MATRIX_STATE_DIR: stateDir },
  })
  adminUserId = (await api<{ user: { id: string } }>('/api/auth/me')).user.id
  const agentIds: Record<string, string> = {}
  for (const name of AGENT_NAMES) {
    agentIds[name] = (
      await api<{ id: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: 'RFC-319 workgroup room fixture agent',
          outputs: [],
          outputKinds: {},
          readonly: false,
          bodyMd: 'Fixture agent driven by the workgroup-matrix stand-in.',
        }),
      })
    ).id
  }
  idleGroupId = await createGroup({ name: 'rfc319-room-idle', clarifyBudget: 0, agentIds })
  quietGroupId = await createGroup({ name: 'rfc319-room-quiet', clarifyBudget: 2, agentIds })
})

test.afterEach(async ({ page }) => {
  // docs/dev-gotchas.md §「page.route 两把锁」的锁 B：先摘 handler、再趁 page 还活着把在飞的等完。
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (stateDir !== '') rmSync(stateDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// WG-29
// ---------------------------------------------------------------------------

test('RFC-319 WG-29: 房间发言的两条分支 —— 不带 @ 只落黑板并把停机的任务唤回引擎，带 @ 当场给被点名成员开一张派单卡 @nightly', async ({
  page,
}) => {
  const taskId = await launchTask(
    idleGroupId,
    'RFC-319 idle room',
    `${GOAL_PREFIX} Decide the rollback path.`,
  )
  const parked = await waitForRoom(
    taskId,
    (r) => r.taskStatus === 'awaiting_human',
    'WG-29 夹具任务没有停机',
    120_000,
  )
  expect(
    parked.pauseReason,
    '夹具没停在 leader-idle ⇒ 这条用例测的就不是「一条黑板留言把停机任务唤回引擎」那个场景',
  ).toBe('leader-idle')

  await openRoom(page, taskId)

  // ---- ① 不带 @：落黑板 + 唤醒 ----
  const before = await roomOf(taskId)
  const blackboard = 'RFC-319 blackboard note: the rollback window stays at 30 minutes.'
  await composer(page).fill(blackboard)
  await page.getByTestId('workgroup-room-send').click()

  await expect(
    page.getByTestId('workgroup-room-log'),
    '发出去的话没有出现在时间线上 ⇒ 用户不知道自己到底说没说出去',
  ).toContainText(blackboard)

  const afterChat = await waitForRoom(
    taskId,
    (r) => r.messages.some((m) => m.authorKind === 'human' && m.bodyMd === blackboard),
    '不带 @ 的发言没有落进房间消息表',
  )
  const chat = afterChat.messages.find((m) => m.authorKind === 'human' && m.bodyMd === blackboard)
  expect(chat?.kind, '无 @ 的发言被记成 dispatch ⇒ 黑板留言被误当成派单').toBe('chat')
  expect(chat?.mentionMemberIds, '无 @ 的发言解析出了被点名成员 ⇒ 花名册匹配失控').toEqual([])
  expect(chat?.assignmentId, '无 @ 的发言挂上了派单卡 ⇒ 平白给人开了张单').toBeNull()
  expect(
    afterChat.assignments.length,
    '一条不带 @ 的留言凭空开出了派单卡 ⇒ 黑板与派单两条语义串了',
  ).toBe(before.assignments.length)

  // 「唤醒」的服务端事实有两条，都必须成立：
  //   ① 任务离开 awaiting_human 重新跑起来（resumeTask 真的被踢了）；
  //   ② 引擎真的又铸出了一条 leader 回合（不是只把状态位翻了一下）。
  await expect
    .poll(async () => (await roomOf(taskId)).taskStatus, {
      message: '停机的任务没有被这条留言唤回引擎 ⇒ 用户发完消息后组任务永远停在那里',
      timeout: 30_000,
      intervals: [200],
    })
    .toBe('running')
  await expect
    .poll(async () => (await roomOf(taskId)).runHistory.length, {
      message: '任务状态翻了但引擎没有铸出新的 leader 回合 ⇒ 唤醒是假的',
      timeout: 60_000,
      intervals: [300],
    })
    .toBeGreaterThan(before.runHistory.length)

  // ---- ② 带 @：直接派单 ----
  const ownerMemberId = memberId(parked, 'owner')
  const dispatchBody = '@owner please confirm the maintenance window before we ship.'
  await expect(composer(page)).toBeEnabled()
  await composer(page).fill(dispatchBody)
  await page.getByTestId('workgroup-room-send').click()

  const afterDispatch = await waitForRoom(
    taskId,
    (r) => r.assignments.some((a) => a.title === dispatchBody),
    '带 @ 的发言没有开出派单卡',
  )
  const card = afterDispatch.assignments.find((a) => a.title === dispatchBody)
  expect(card?.source, '人 @ 出来的卡没有标成 human 来源 ⇒ 房间无法区分这活是谁派的').toBe('human')
  expect(card?.assigneeMemberId, '卡没派给被 @ 到的那个成员 ⇒ 活派给了别人').toBe(ownerMemberId)
  expect(card?.status, '人 @ 出来的卡不是 dispatched ⇒ 它不会进入任何人的待办').toBe('dispatched')

  const dispatchMessage = afterDispatch.messages.find(
    (m) => m.authorKind === 'human' && m.bodyMd === dispatchBody,
  )
  expect(dispatchMessage?.kind, '带 @ 的发言仍记成 chat ⇒ 时间线不会把卡挂到这条消息下面').toBe(
    'dispatch',
  )
  expect(dispatchMessage?.mentionMemberIds, '被点名的成员没被解析出来').toEqual([ownerMemberId])

  const cardId = card?.id ?? 'missing'
  await expect(
    page.getByTestId(`wg-card-${cardId}`),
    '派单卡没有在没刷新的房间里自己出现 ⇒ wg.assignment.updated 帧没有驱动房间重取',
  ).toBeVisible()
  await expect(page.getByTestId(`wg-card-${cardId}`)).toContainText('@owner')
  await expect(page.getByTestId(`wg-card-status-${cardId}`)).toHaveText('Dispatched')
})

// ---------------------------------------------------------------------------
// WG-30
// ---------------------------------------------------------------------------

test('RFC-319 WG-30: @ 花名册补全 —— 弹层随输入收敛、上下键换选中项、Enter 提交成「@别名 」，Esc 关掉后同一个 token 不会自己弹回来 @nightly', async ({
  page,
}) => {
  const taskId = await quietTask('RFC-319 mention room')
  const room = await roomOf(taskId)
  const rosterSize = room.config.members.length
  expect(rosterSize, '夹具花名册不是五个人 ⇒ 后面的候选条数断言失去区分度').toBe(5)

  await openRoom(page, taskId)
  const input = composer(page)
  const popup = page.getByTestId('workgroup-room-mentions')

  await expect(popup, '还没输入 @ 弹层就挂着 ⇒ 它挡住了正常打字').toBeHidden()
  await input.click()
  await input.pressSequentially('@')
  await expect(popup, '输入 @ 后花名册弹层没出现 ⇒ 用户只能靠记忆手打别名').toBeVisible()
  await expect(
    popup.getByRole('option'),
    '弹层没有把整份花名册列出来 ⇒ 候选来源不是 config.members',
  ).toHaveCount(rosterSize)

  // 键盘换选中项：active-descendant 模型下「选中」= aria-selected。
  const options = popup.getByRole('option')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(
    options.nth(1),
    '按下方向键后选中项没有前移 ⇒ 键盘用户无法在弹层里挑人',
  ).toHaveAttribute('aria-selected', 'true')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press('ArrowUp')
  await expect(options.nth(0), '方向键回不去 ⇒ 上下键只有一半生效').toHaveAttribute(
    'aria-selected',
    'true',
  )

  // 输入收敛：'spa' 只剩 @spare 一个候选。
  await input.pressSequentially('spa')
  await expect(popup.getByRole('option'), '弹层没有按输入收敛 ⇒ 候选过滤没接线').toHaveCount(1)
  await expect(popup.getByTestId('wg-mention-spare')).toBeVisible()

  // Enter 提交：草稿变成「@spare 」且光标落在末尾（后面接着打字才是连贯的）。
  await page.keyboard.press('Enter')
  await expect(input, 'Enter 没有把候选提交进草稿 ⇒ 补全等于没有').toHaveValue('@spare ')
  expect(
    await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    '提交后光标没有落在补全出来的别名末尾 ⇒ 用户接着打字会插到前面去',
  ).toBe('@spare '.length)
  await expect(popup, '提交之后弹层还开着 ⇒ 它会挡住紧接着要打的正文').toBeHidden()
  expect(
    await page.getByTestId('workgroup-room-log').textContent(),
    '补全过程中把消息发出去了 ⇒ 半截 @token 被当成一次真发言',
  ).not.toContain('@spare')

  // Esc 关闭：同一个 token 状态下不再自己弹回来；再多打一个字符才重开。
  await input.fill('')
  await input.pressSequentially('@re')
  await expect(popup).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popup, 'Esc 没有关掉弹层 ⇒ 用户没有办法把它收起来').toBeHidden()
  await page.keyboard.press('End')
  await expect(
    popup,
    '同一个 @token 上 Esc 之后弹层又自己弹回来了 ⇒ 这次关闭根本没被记住',
  ).toBeHidden()
  await input.pressSequentially('s')
  await expect(
    popup,
    '在同一个 token 上继续打字后弹层没有重开 ⇒ Esc 变成了永久关闭，补全再也回不来',
  ).toBeVisible()

  await input.fill('')
  expect(
    (await roomOf(taskId)).messages.filter((m) => m.authorKind === 'human').length,
    '整条补全用例里不该有任何一条人类消息落库',
  ).toBe(0)
})

// ---------------------------------------------------------------------------
// WG-31
// ---------------------------------------------------------------------------

test('RFC-319 WG-31: 人类成员卡交付 —— 快捷输入与结构化表单两种形态都把卡推到 delivered，同一张卡再交付一次被服务端 409 挡下 @nightly', async ({
  page,
}) => {
  const taskId = await quietTask('RFC-319 delivery room')
  const quickCardId = await dispatchHumanCard(taskId, 'confirm the rollback window')
  const formCardId = await dispatchHumanCard(taskId, 'write down the abort criteria')

  await openRoom(page, taskId)
  await expect(page.getByTestId(`wg-card-todo-${quickCardId}`)).toHaveText('Yours to deliver')
  await expect(page.getByTestId(`wg-card-status-${quickCardId}`)).toHaveText('Dispatched')

  // ---- 形态一：快捷输入 ----
  const quickBody = 'Rollback window confirmed: 30 minutes, ops on call.'
  await page.getByTestId(`wg-card-deliver-quick-${quickCardId}`).click()
  await page.getByTestId(`wg-card-quick-input-${quickCardId}`).fill(quickBody)
  await page.getByTestId(`wg-card-quick-submit-${quickCardId}`).click()

  const afterQuick = await waitForRoom(
    taskId,
    (r) => r.assignments.find((a) => a.id === quickCardId)?.status === 'delivered',
    '快捷交付之后卡没有落成 delivered ⇒ 组任务还在等一个已经交了的人',
  )
  const quickCard = afterQuick.assignments.find((a) => a.id === quickCardId)
  expect(
    quickCard?.resultMessageId,
    '交付了却没有把结果消息挂回卡上 ⇒ 卡片折不出结果',
  ).not.toBeNull()
  const quickDelivery = afterQuick.messages.find((m) => m.id === quickCard?.resultMessageId)
  expect(quickDelivery?.kind, '交付消息不是 delivery ⇒ leader 的账本读不到这份交付').toBe(
    'delivery',
  )
  expect(quickDelivery?.bodyMd, '快捷交付的正文没有原样落库').toBe(quickBody)

  await expect(page.getByTestId(`wg-card-status-${quickCardId}`)).toHaveText('Delivered')
  await expect(
    page.getByTestId(`wg-card-deliver-quick-${quickCardId}`),
    '交付完了界面还留着交付入口 ⇒ 用户会以为自己没交成、再交一遍',
  ).toBeHidden()

  // ---- 形态二：结构化表单 ----
  const summary = 'Abort criteria written down'
  const detail = 'Abort when error rate > 2% for 5 minutes, or replication lag > 60s.'
  await page.getByTestId(`wg-card-deliver-form-${formCardId}`).click()
  const dialog = page.getByTestId(`wg-deliver-form-dialog-${formCardId}`)
  await expect(dialog).toBeVisible()
  await expect(
    page.getByTestId(`wg-deliver-form-submit-${formCardId}`),
    '摘要为空时表单也能提交 ⇒ 会写出一条空交付',
  ).toBeDisabled()
  await page.getByTestId(`wg-deliver-summary-${formCardId}`).fill(summary)
  await page.getByTestId(`wg-deliver-detail-${formCardId}`).fill(detail)
  await page.getByTestId(`wg-deliver-form-submit-${formCardId}`).click()

  const afterForm = await waitForRoom(
    taskId,
    (r) => r.assignments.find((a) => a.id === formCardId)?.status === 'delivered',
    '表单交付之后卡没有落成 delivered',
  )
  const formCard = afterForm.assignments.find((a) => a.id === formCardId)
  const formDelivery = afterForm.messages.find((m) => m.id === formCard?.resultMessageId)
  expect(
    formDelivery?.bodyMd,
    '结构化交付没有按 summary + 空行 + detail 归一 ⇒ 两种形态在下游不是同一种东西',
  ).toBe(`${summary}\n\n${detail}`)
  await expect(dialog, '提交成功后表单没有关闭').toBeHidden()

  // ---- 拒绝闸：同一张卡不许交付第二次 ----
  const deliveriesBefore = afterForm.messages.filter((m) => m.kind === 'delivery').length
  const again = await rawPost(`/api/workgroup-tasks/${taskId}/assignments/${quickCardId}/deliver`, {
    body: 'second delivery that must be refused',
  })
  expect(again.status, `已交付的卡再交一次没有被拒：${again.text}`).toBe(409)
  expect(again.code, '重复交付的拒绝码不是 workgroup-delivery-conflict').toBe(
    'workgroup-delivery-conflict',
  )
  const afterRefusal = await roomOf(taskId)
  expect(
    afterRefusal.assignments.find((a) => a.id === quickCardId)?.status,
    '被拒的第二次交付仍然改动了卡状态',
  ).toBe('delivered')
  expect(
    afterRefusal.messages.filter((m) => m.kind === 'delivery').length,
    '被拒的第二次交付仍然写出了一条交付消息 ⇒ leader 会读到两份自相矛盾的交付',
  ).toBe(deliveriesBefore)
})

// ---------------------------------------------------------------------------
// WG-32
// ---------------------------------------------------------------------------

test('RFC-319 WG-32: 取消派单卡 —— dispatched 的卡两下确认才取消并留下系统留言；已交付 / 已取消的卡界面不给取消入口，接口也一律 409 @nightly', async ({
  page,
}) => {
  const taskId = await quietTask('RFC-319 cancel room')
  const cancelCardId = await dispatchHumanCard(taskId, 'draft the comms plan')
  const deliveredCardId = await dispatchHumanCard(taskId, 'sign off the checklist')
  await api(`/api/workgroup-tasks/${taskId}/assignments/${deliveredCardId}/deliver`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Checklist signed off.' }),
  })

  await openRoom(page, taskId)
  const card = page.getByTestId(`wg-card-${cancelCardId}`)
  await expect(page.getByTestId(`wg-card-status-${cancelCardId}`)).toHaveText('Dispatched')

  // ConfirmButton 是两下：第一下换成「Confirm?」，第二下才发请求。
  const cancelButton = card.getByRole('button', { name: 'Cancel' })
  await cancelButton.click()
  expect(
    (await roomOf(taskId)).assignments.find((a) => a.id === cancelCardId)?.status,
    '第一下点击就把卡取消了 ⇒ 破坏性动作没有二次确认',
  ).toBe('dispatched')
  await card.getByRole('button', { name: 'Confirm?' }).click()

  const afterCancel = await waitForRoom(
    taskId,
    (r) => r.assignments.find((a) => a.id === cancelCardId)?.status === 'canceled',
    '两下确认之后卡没有被取消',
  )
  await expect(page.getByTestId(`wg-card-status-${cancelCardId}`)).toHaveText('Canceled')
  const note = afterCancel.messages.find(
    (m) => m.templateKey === 'assignmentCanceledByMember' && m.assignmentId === cancelCardId,
  )
  expect(
    note,
    '取消之后房间里没有留下系统留言 ⇒ 同任务的其他人看不出这张卡为什么消失了',
  ).toBeDefined()
  await expect(
    page.getByTestId('workgroup-room-log'),
    '取消的系统留言没有渲染进时间线',
  ).toContainText('canceled by a task member')

  // 界面侧：终态卡不再给取消入口。
  await expect(
    page.getByTestId(`wg-card-${cancelCardId}`).getByRole('button', { name: 'Cancel' }),
    '已取消的卡还挂着取消按钮 ⇒ 用户会点一个必然 409 的动作',
  ).toHaveCount(0)
  await expect(
    page.getByTestId(`wg-card-${deliveredCardId}`).getByRole('button', { name: 'Cancel' }),
    '已交付的卡还挂着取消按钮',
  ).toHaveCount(0)

  // 服务端侧：open/dispatched 之外一律 409，且状态一格都不许动。
  const reCancel = await rawPost(
    `/api/workgroup-tasks/${taskId}/assignments/${cancelCardId}/cancel`,
  )
  expect(reCancel.status, `已取消的卡再取消一次没有被拒：${reCancel.text}`).toBe(409)
  expect(reCancel.code, '重复取消的拒绝码不是 workgroup-assignment-not-cancelable').toBe(
    'workgroup-assignment-not-cancelable',
  )
  const cancelDelivered = await rawPost(
    `/api/workgroup-tasks/${taskId}/assignments/${deliveredCardId}/cancel`,
  )
  expect(cancelDelivered.status, `已交付的卡被允许取消：${cancelDelivered.text}`).toBe(409)
  expect(cancelDelivered.code).toBe('workgroup-assignment-not-cancelable')

  const final = await roomOf(taskId)
  expect(final.assignments.find((a) => a.id === cancelCardId)?.status).toBe('canceled')
  expect(
    final.assignments.find((a) => a.id === deliveredCardId)?.status,
    '被拒的取消仍然把已交付的卡改成了 canceled ⇒ 卡状态机被击穿',
  ).toBe('delivered')
})

// ---------------------------------------------------------------------------
// WG-33
// ---------------------------------------------------------------------------

test('RFC-319 WG-33: 完成门 —— 空评论的驳回按钮按不下去也发不出请求，填了才提交；审批直接把任务收到 done @nightly', async ({
  page,
}) => {
  const rejectTaskId = await gateTask('RFC-319 gate reject room')
  const confirmCalls = countPosts(page, `/api/workgroup-tasks/${rejectTaskId}/confirm`)

  await openRoom(page, rejectTaskId)
  await expect(
    page.getByTestId('workgroup-room-gate'),
    '任务停在 awaiting_review 却没有渲染完成门卡片 ⇒ 用户根本看不到要他确认',
  ).toBeVisible()
  await expect(page.getByTestId('workgroup-room-gate')).toContainText(
    'leader-worker showcase v1 complete',
  )

  await page.getByTestId('workgroup-room-gate-reject').click()
  const dialog = page.getByTestId('workgroup-room-gate-reject-dialog')
  await expect(dialog).toBeVisible()
  const submit = page.getByTestId('workgroup-room-gate-reject-submit')
  await expect(submit, '空评论时驳回按钮是可点的 ⇒ 会把一条空反馈交给 leader').toBeDisabled()
  // 只断言「灰着」不够：灰只是画上去的也会绿。force 把点击真打进去，看请求发没发出。
  await submit.click({ force: true })
  await page.getByTestId('workgroup-room-gate-reject-comment').fill('   ')
  await expect(submit, '只输入空白也让驳回按钮解禁 ⇒ trim 没生效').toBeDisabled()
  await submit.click({ force: true })
  expect(confirmCalls.count(), '空 / 全空白评论时驳回请求居然发出去了 ⇒ 前端这道闸形同虚设').toBe(0)
  expect(
    (await roomOf(rejectTaskId)).gate.awaitingConfirmation,
    '还没提交完成门就已经不待确认了',
  ).toBe(true)

  await page
    .getByTestId('workgroup-room-gate-reject-comment')
    .fill(`${REJECTION_TOKEN}: the rollback runbook is still missing.`)
  await expect(submit, '填了评论驳回按钮仍然按不下去').toBeEnabled()
  await submit.click()
  await expect(dialog, '驳回成功后对话框没有关闭').toBeHidden()

  const rejected = await waitForRoom(
    rejectTaskId,
    (r) => r.gate.rejected,
    '驳回没有落到服务端的完成门状态上',
  )
  expect(rejected.gate.awaitingConfirmation, '驳回之后完成门还挂在待确认 ⇒ 门被点了两次').toBe(
    false,
  )
  expect(confirmCalls.count(), '驳回只应发出一次请求').toBe(1)

  // ---- 审批：另起一个停在门上的任务，走 approve 这一支 ----
  const approveTaskId = await gateTask('RFC-319 gate approve room')
  await openRoom(page, approveTaskId)
  await expect(page.getByTestId('workgroup-room-gate')).toBeVisible()
  await page.getByTestId('workgroup-room-gate-confirm').click()

  const approved = await waitForRoom(
    approveTaskId,
    (r) => r.taskStatus === 'done',
    '审批之后任务没有收到 done ⇒ 完成门放行不生效',
  )
  expect(approved.gate.awaitingConfirmation).toBe(false)
  await expect(
    page.getByTestId('workgroup-room-gate'),
    '任务已经 done，完成门卡片还挂在右栏',
  ).toBeHidden()
  await expect(
    page.getByTestId('workgroup-room-terminal-notice'),
    '任务收尾后房间没有转成只读 ⇒ 用户还会往一个已结束的任务里发言',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// WG-35
// ---------------------------------------------------------------------------

test('RFC-319 WG-35: 房间右栏花名册 —— 四种状态各按自己的数据源着色、并发实例出 ×N、人类成员带在线点、点成员名进 session 抽屉 @nightly', async ({
  page,
}) => {
  const taskId = await quietTask('RFC-319 roster room')
  // owner：两张真的人类待办卡 ⇒ 排队中 + ×2。
  await dispatchHumanCard(taskId, 'roster card one')
  await dispatchHumanCard(taskId, 'roster card two')
  const room = await roomOf(taskId)
  // builder / researcher：running 与 awaiting_human 两态在本夹具里没有稳定的自然造法
  // （真跑的 stub 成员回合 150ms 就结束，抓不住），直接把卡按这两个状态种进库——
  // 断言面仍然是「房间聚合 → 右栏 chip」这条真链路，只是把输入端固定住。
  const builderId = memberId(room, 'builder')
  const researcherId = memberId(room, 'researcher')
  const now = Date.now()
  runSqlite(
    dbPath(),
    `PRAGMA foreign_keys=ON;
     BEGIN IMMEDIATE;
     INSERT INTO workgroup_assignments
       (id, task_id, round, source, assignee_member_id, title, brief_md, status, created_at, updated_at)
     VALUES
       (${sqlLiteral(`z:rfc319:working:${taskId}`)},${sqlLiteral(taskId)},1,'leader',${sqlLiteral(builderId)},'seeded running card','seeded','running',${now},${now}),
       (${sqlLiteral(`z:rfc319:awaiting:${taskId}`)},${sqlLiteral(taskId)},1,'leader',${sqlLiteral(researcherId)},'seeded awaiting card','seeded','awaiting_human',${now},${now});
     COMMIT;`,
  )

  await openRoom(page, taskId)
  const rail = page.getByTestId('workgroup-room-members')
  await expect(rail).toBeVisible()

  await expect(
    page.getByTestId('wg-member-state-builder'),
    'running 的卡没有把成员显示成「工作中」⇒ 用户看不出谁在跑',
  ).toHaveText('Working')
  await expect(
    page.getByTestId('wg-member-state-researcher'),
    'awaiting_human 的卡没有显示成「等待回答」⇒ 卡住的成员和空闲的成员长得一样',
  ).toHaveText('Awaiting answer')
  await expect(
    page.getByTestId('wg-member-state-owner'),
    'dispatched 的人类待办没有把成员显示成「排队中」',
  ).toHaveText('Queued')
  await expect(
    page.getByTestId('wg-member-state-spare'),
    '什么都没有的成员没有显示成「空闲」⇒ 四态坍缩了',
  ).toHaveText('Idle')

  await expect(
    page.getByTestId('wg-member-active-runs-owner'),
    '一个成员身上挂着两张在途卡却没有 ×N 徽标 ⇒ 并发规模在单值 chip 下不可见',
  ).toHaveText('×2 active')
  await expect(
    page.getByTestId('wg-member-active-runs-builder'),
    '只有一张在途卡的成员也被打上了 ×N ⇒ 徽标失去意义',
  ).toHaveCount(0)
  await expect(page.getByTestId('wg-member-active-runs-spare')).toHaveCount(0)

  await expect(
    page.getByTestId('wg-member-owner').locator('.presence-dot'),
    '人类成员身上没有在线点 ⇒ 用户不知道要等的人在不在',
  ).toHaveCount(1)
  await expect(
    page.getByTestId('wg-member-builder').locator('.presence-dot'),
    'agent 成员也被画上了在线点 ⇒ 在线是「人」的属性，画到 agent 上是错的',
  ).toHaveCount(0)

  // 点成员名进 session 抽屉：只有当下有 run 的成员才可点。
  await expect(
    page.getByTestId('wg-member-open-session-spare'),
    '当下没有任何 run 的成员也被做成了可点按钮 ⇒ 点开会是一个空抽屉',
  ).toHaveCount(0)
  await page.getByTestId('wg-member-open-session-lead').click()
  const drawer = page.locator('.inspector')
  await expect(drawer, '点成员名没有打开 session 抽屉').toBeVisible()
  await expect(drawer.locator('.inspector__id code')).toHaveText('__wg_leader__')
})

// ---------------------------------------------------------------------------
// WG-36
// ---------------------------------------------------------------------------

test('RFC-319 WG-36: 运行日志与成员抽屉 —— 点哪一行开哪一条 run，抽屉里的历史只列同一个成员的回合，不把别人的 run 串进来 @nightly', async ({
  page,
}) => {
  const taskId = await quietTask('RFC-319 run log room')
  // 两条 researcher 回合 + 一条 builder 回合：同一个 __wg_member__ 节点上的三条 run，
  // 只有按成员收口才会在 researcher 的抽屉里得到 2 而不是 3。
  await postMessage(taskId, 'research-release\n@researcher first sweep of the release notes.')
  await waitForRoom(
    taskId,
    (r) => r.assignments.filter((a) => a.status === 'done').length >= 1,
    '第一条 researcher 派单没有跑完',
  )
  await postMessage(taskId, 'research-release\n@researcher second sweep of the release notes.')
  await waitForRoom(
    taskId,
    (r) => r.assignments.filter((a) => a.status === 'done').length >= 2,
    '第二条 researcher 派单没有跑完',
  )
  await postMessage(
    taskId,
    'implementation-v1-tests\n@builder PRIVATE_BUILD_CONSTRAINT and PUBLIC_RELEASE_CONSTRAINT both apply.',
  )
  const room = await waitForRoom(
    taskId,
    (r) => r.assignments.filter((a) => a.status === 'done').length >= 3,
    'builder 派单没有跑完',
  )

  const researcherId = memberId(room, 'researcher')
  const builderId = memberId(room, 'builder')
  const researcherRuns = room.runHistory.filter(
    (e) => e.memberId === researcherId && e.kind === 'assignment',
  )
  const builderRuns = room.runHistory.filter(
    (e) => e.memberId === builderId && e.kind === 'assignment',
  )
  expect(researcherRuns.length, '夹具没有给 researcher 造出两条成员回合').toBe(2)
  expect(builderRuns.length, '夹具没有给 builder 造出一条成员回合').toBe(1)

  await openRoom(page, taskId)
  await expect(
    page.getByTestId('workgroup-room-runlog'),
    '右栏没有运行记录卡 ⇒ 用户看不到这个任务跑过什么',
  ).toBeVisible()
  await expect(
    page.getByTestId('workgroup-room-runlog').getByRole('button'),
    '运行记录的行数与房间聚合的 runHistory 对不上 ⇒ 列表漏了回合',
  ).toHaveCount(room.runHistory.length)

  const target = researcherRuns[0]?.nodeRunId ?? 'missing'
  await page.getByTestId(`wg-runlog-${target}`).click()
  const drawer = page.locator('.inspector')
  await expect(drawer, '点运行记录的行没有打开抽屉').toBeVisible()
  await expect(
    drawer.locator('.inspector__id .muted'),
    '抽屉打开的不是刚点的那一条 run',
  ).toHaveText(`/ ${target.slice(-6)}`)

  await drawer.getByRole('tab', { name: 'Stats' }).click()
  const history = page.getByTestId('stats-history-list').getByRole('button')
  await expect(
    history,
    `抽屉里的运行历史列了 ${room.runHistory.filter((e) => e.kind === 'assignment').length} 条（全部成员回合）` +
      '而不是这个成员自己的两条 ⇒ 成员作用域收口失效，用户点进 researcher 看到的是 builder 的历史',
  ).toHaveCount(researcherRuns.length)

  // 再点历史里唯一那条**可点**的（当前这条是 disabled 的高亮行）：抽屉必须切到
  // 同一个成员的另一条回合，而不是别人的 run。
  const other = researcherRuns[1]?.nodeRunId ?? 'missing'
  expect(
    [target.slice(-6), other.slice(-6)],
    '守卫自证：researcher 两条 run 的后缀不能与 builder 那条撞车，否则下面的断言会放过串成员的情况',
  ).not.toContain(builderRuns[0]?.nodeRunId.slice(-6))
  const switchable = page.getByTestId('stats-history-list').locator('button:not([disabled])')
  await expect(
    switchable,
    '运行历史里除当前这条之外没有可切换的行 ⇒ 抽屉里根本换不了回合',
  ).toHaveCount(researcherRuns.length - 1)
  await switchable.first().click()
  await expect(
    drawer.locator('.inspector__id .muted'),
    '在历史里换一条之后抽屉切到的不是同一个成员的另一条回合',
  ).toHaveText(`/ ${other.slice(-6)}`)
})

// ---------------------------------------------------------------------------
// WG-37（只补 rfc229 没做的两格）
// ---------------------------------------------------------------------------

test('RFC-319 WG-37: 消息引用的两处缺口 —— 被引用的系统消息也认得出作者；跳转高亮是一过性的、熄灭时不把焦点一起收走 @nightly', async ({
  page,
}) => {
  const taskId = await quietTask('RFC-319 quote room')
  const room = await roomOf(taskId)
  const builderId = memberId(room, 'builder')
  // 房间开局那条**系统**消息（引擎在建任务时写入的目标播报）就是被引用的对象：
  // rfc229 的夹具只造过 member 作者的父消息，`messageAuthorLabel` 的 system 分支
  // （引用头显示「System」而不是「@?」）在引用预览这条路径上从来没人走过。
  const parent = room.messages[0]
  if (parent === undefined || parent.authorKind !== 'system') {
    throw new Error('RFC-319 fixture: 房间开局第一条不是系统消息，引用夹具的前提不成立')
  }
  const replyId = `z:rfc319:quote:reply:${taskId}`
  const replyBody = 'Schema map frozen; the export pipeline is untouched.'
  runSqlite(
    dbPath(),
    `PRAGMA foreign_keys=ON;
     BEGIN IMMEDIATE;
     INSERT INTO workgroup_messages
       (id, task_id, round, author_kind, author_member_id, author_user_id, kind, body_md,
        mentions_json, assignment_id, trigger_message_id, created_at)
     VALUES
       (${sqlLiteral(replyId)},${sqlLiteral(taskId)},1,'member',${sqlLiteral(builderId)},NULL,'result',${sqlLiteral(replyBody)},'[]',NULL,${sqlLiteral(parent.id)},${Date.now()});
     COMMIT;`,
  )
  // bun:sqlite 的 `exec()` 对多语句脚本里的约束错误**不抛**，事务被回滚而调用方看到
  // 的是「成功」（2026-08-25 实测）。所以夹具必须自证种进去了，否则下面每一条 UI
  // 断言都会红在一个假的原因上。
  const seeded = await roomOf(taskId)
  expect(
    seeded.messages.find((m) => m.id === replyId)?.triggerMessageId,
    '引用夹具没有落库 ⇒ 这条用例根本没有在测引用',
  ).toBe(parent.id)

  await openRoom(page, taskId)

  const reference = page.getByTestId(`wg-msg-reference-${replyId}`)
  await expect(
    reference,
    '带 triggerMessageId 的消息没有渲染出引用预览 ⇒ 回复看起来像凭空冒出来的一句话',
  ).toBeVisible()
  await expect(
    reference,
    '引用的是一条系统消息时作者头没有落到「System」⇒ 预览会显示成 @? 之类的占位',
  ).toContainText('Replying to System')
  await expect(reference, '引用预览里没有原消息的正文 ⇒ 用户还是得自己翻上去找').toContainText(
    parent.bodyMd.slice(0, 40),
  )

  const parentBubble = page.getByTestId(`wg-msg-${parent.id}`)
  await reference.click()
  await expect(parentBubble, '跳转之后目标消息没有拿到焦点 ⇒ 键盘用户跳完就丢了位置').toBeFocused()
  await expect(parentBubble, '跳转之后目标消息没有高亮 ⇒ 用户不知道自己跳到了哪一条').toHaveClass(
    /workgroup-room__msg--highlighted/,
  )
  await expect(
    parentBubble,
    '高亮一直不熄 ⇒ 读完之后整条消息永远亮着，下一次跳转反而分不出跳到了哪',
  ).not.toHaveClass(/workgroup-room__msg--highlighted/)
  await expect(parentBubble, '高亮熄灭时把焦点也一起收走了 ⇒ 用户刚跳到的位置又丢了').toBeFocused()
})

// ---------------------------------------------------------------------------
// WG-38
// ---------------------------------------------------------------------------

test('RFC-319 WG-38: 澄清静音的恢复 —— 停掉的 asker 在房间信息卡上留一条 chip，点「恢复追问」把指令翻回 continue、chip 当场消失 @nightly', async ({
  page,
}) => {
  const taskId = await quietTask('RFC-319 clarify stop room')
  const directivePath = `/api/tasks/${taskId}/nodes/__wg_leader__/clarify-directive`
  await api(directivePath, {
    method: 'POST',
    body: JSON.stringify({ directive: 'stop', shardKey: 'leader' }),
  })
  const stopped = await roomOf(taskId)
  expect(stopped.clarifyStops, '停止追问没有出现在房间聚合里 ⇒ 界面无从知道有人被静音了').toEqual([
    { nodeId: '__wg_leader__', askerKey: 'leader' },
  ])

  const directiveCalls = countPosts(page, directivePath)
  await openRoom(page, taskId)
  const chips = page.getByTestId('workgroup-room-clarify-stops')
  await expect(
    chips,
    '被静音的 asker 没有在房间信息卡上留下 chip ⇒ 这个停止在界面上完全隐形',
  ).toBeVisible()
  await expect(chips).toContainText('Ask-back stopped: leader')

  await page.getByTestId('workgroup-room-clarify-resume-leader').click()
  await expect
    .poll(() => directiveCalls.count(), {
      message: '点了「恢复追问」却没有发出任何指令请求 ⇒ 按钮是个摆设',
      timeout: 15_000,
    })
    .toBe(1)
  expect(
    JSON.parse(directiveCalls.bodies()[0] ?? '{}') as Record<string, unknown>,
    '恢复请求的 body 不是「把这一个 asker 翻回 continue」',
  ).toEqual({ directive: 'continue', shardKey: 'leader' })

  await expect(chips, '恢复之后 chip 还挂着 ⇒ 用户会以为自己没恢复成，反复去点').toBeHidden()
  expect(
    (await roomOf(taskId)).clarifyStops,
    '恢复之后服务端仍然把这个 asker 记成停止 ⇒ 它下一轮还是问不出来',
  ).toEqual([])
})
