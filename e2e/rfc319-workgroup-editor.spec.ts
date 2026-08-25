// RFC-319 —— 工作组详情编辑器「配置 / 成员 / 就绪性 / 模式 / 离开守卫」能力簇的用户面 e2e。
//
// 覆盖能力账本行：WG-07 / WG-10 / WG-11 / WG-12 / WG-13 / WG-14 / WG-23。
//
// 与 e2e/rfc225-workgroup-autosave.spec.ts 的分工（**务必不要重复**）：
// rfc225 已经锁住了「改 instructions → 收到 PUT 回执 → revision.version=2 →
// header 出 `· v2` → chip 回到 Saved」这一条顺风路径，以及 header 的 More 动作
// 菜单、390px 几何、axe、copy 动作。本文件**不再重复那条链**，只补它没碰的面：
//   · WG-07：保存**过程中**的中间态（Saving）与「版本只在回执落地后才前进」——
//            rfc225 是等 PUT 完成后一次性断言终态，中间那格没人看；
//   · WG-13：instructions 之外的七个配置字段（maxRounds / outputContract /
//            三开关 / completionGate / clarifyBudget / fanOut）落库 + 刷新回读；
//   · WG-10 / WG-11 / WG-12 / WG-14 / WG-23：rfc225 一条都没有。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//  WG-07  编辑器没有「保存」按钮，用户唯一的凭据就是 header 的 `· vN` 与状态
//         chip。若版本在请求**发出时**就先自增，用户看到 v2 却可能什么都没落库；
//         若保存中不显示 Saving，用户在慢网下只看到「Unsaved changes」凝固不动，
//         会以为编辑器坏了、反复重打一遍。
//  WG-13  七个配置字段是工作组的全部行为旋钮。任何一个「界面翻了、库里没变」，
//         用户下次启动任务时拿到的是旧规则，而界面从头到尾显示已保存 ——
//         这是最典型的静默丢数据。刷新回读那一步是必需的：只断回执等于相信
//         服务端自己报的分数。
//  WG-10  成员增删与 leader 指派是工作组唯一的编排入口。加进去的 agent 若丢了
//         agentId，启动时才会炸；set-leader 若没落库，任务起来没人派活；移除后
//         焦点若掉回 <body>，键盘用户当场失去位置，得从头 Tab 一遍。
//  WG-11  别名是 @提及与花名册的键。重复 / 含 @ / 含逗号 / 含空白若能存进去，
//         轻则派活派错人，重则整个协议解析错位；human 成员指向被停用的账号则
//         意味着任务永远等一个不会来的人。这些规则若只有服务端拦、界面不拦，
//         用户填完整张表才吃 422；若只有界面拦、服务端不拦，绕过界面就能写进去。
//  WG-12  三种模式的语义差异全靠这几处 UI 表达。free_collab 若不把三开关显示成
//         强制 ON，用户会以为自己关掉的开关生效了；若「强制 ON」是靠改存储实现的，
//         切回 leader_worker 时用户原本的设置就被抹掉了。dynamic_workflow 若还留着
//         开关段与「加人类成员」，用户会配一堆在该模式下根本不起作用的东西。
//  WG-14  就绪性提示是「为什么不能启动」的唯一解释。它若不出现，启动按钮就是一个
//         无解释的灰按钮；它若在配齐后不消失，用户会以为自己永远没配好。
//  WG-23  成员面板的半截草稿不参与离开守卫的话，用户切走再回来发现刚填的成员没了，
//         而且期间自动保存一直被这份草稿堵着、界面却不解释。
//
// 判据取自（纯文本引用，勿改成外链）：
//   packages/frontend/src/routes/workgroups.detail.tsx:212-217   —— blockReason：transient-member / invalid
//   packages/frontend/src/routes/workgroups.detail.tsx:523-543   —— onSetLeader / onRemoveMember 焦点交接 / onAddMember
//   packages/frontend/src/routes/workgroups.detail.tsx:654-661   —— readiness 由**草稿**计算（不是服务端回执）
//   packages/frontend/src/routes/workgroups.detail.tsx:714-727   —— 启动按钮 disabled={!readiness.ready || launchDisabled}
//   packages/frontend/src/routes/workgroups.detail.tsx:774-798   —— readiness 横幅：reasons + warnings
//   packages/frontend/src/routes/workgroups.detail.tsx:840-861   —— 加成员按钮；dynamic_workflow 隐藏「加人类成员」
//   packages/frontend/src/routes/workgroups.detail.tsx:1111-1125 —— UnsavedChangesGuard 接线与 onDiscard
//   packages/frontend/src/components/workgroup/WorkgroupForm.tsx:52-58    —— fc / dyn 判定
//   packages/frontend/src/components/workgroup/WorkgroupForm.tsx:138-166  —— fc 强制 ON + 通知（不改存储）
//   packages/frontend/src/components/workgroup/WorkgroupForm.tsx:167-226  —— maxRounds / completionGate / clarifyBudget / fanOut
//   packages/frontend/src/components/workgroup/WorkgroupContextPanel.tsx:283-326 —— 别名/角色输入 + set-leader / remove
//   packages/frontend/src/components/workgroup/WorkgroupDraftStatus.tsx:56-79    —— phase chip 文案（含 blocked）
//   packages/frontend/src/components/workgroup/WorkgroupMemberGallery.tsx:90-137 —— 成员卡 testid 与 leader 徽标
//   packages/frontend/src/components/split/UnsavedChangesGuard.tsx:100-106,155-195 —— blocker + 留下/放弃
//   packages/frontend/src/lib/workgroup-form.ts:39,472-496       —— 别名禁用字符与逐行校验
//   packages/shared/src/schemas/workgroup.ts:483-503             —— workgroupLaunchReadiness 单一事实源
//   packages/backend/src/routes/workgroups.ts:180-208            —— PUT 全量替换 + 版本围栏
//   packages/backend/src/services/workgroups.ts:1007,1039        —— agent 成员 id 必须真实存在
//   packages/backend/src/services/workgroups.ts:1109-1132,1134-1158 —— human 成员必须是活跃账号（预检 + 事务内复查）
//
// 所有「服务端到底存了什么」的断言一律回读 GET /api/workgroups/{id}，不只信回执。

import { expect, test, type Locator, type Page } from '@playwright/test'
import type { WorkgroupDetail } from '@agent-workflow/shared'

import { startDaemon, type DaemonHandle } from './harness'

// 不用 serial：五条用例各自 seed 自己的工作组、互不依赖。serial 会在第一条红掉时
// 把后面几条标成 skipped，CI 上就只能看到一条失败、其余全被藏起来。
test.setTimeout(180_000)

let daemon: DaemonHandle
/** 两个 fixture agent：一个当 leader，一个当 worker（也是「加成员」用例挑的那个）。 */
let leadAgentId = ''
let workerAgentId = ''
const LEAD_AGENT_NAME = 'rfc319-wg-lead-agent'
const WORKER_AGENT_NAME = 'rfc319-wg-worker-agent'
/** 活跃的平台用户 —— human 成员用它；另一个建完就停用，用来试「必须活跃」这条。 */
const HUMAN_USERNAME = 'rfc319wghuman'
const HUMAN_DISPLAY_NAME = 'Reviewer'
const DISABLED_USERNAME = 'rfc319wgdisabled'
let humanUserId = ''
let disabledUserId = ''

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

/** 只读一次服务端真值。所有「落库了吗」的断言都走这里，不信界面也不只信回执。 */
async function readWorkgroup(id: string): Promise<WorkgroupDetail> {
  return api<WorkgroupDetail>(`/api/workgroups/${encodeURIComponent(id)}`)
}

interface SeedMember {
  memberType: 'agent' | 'human'
  agentId?: string
  userId?: string
  displayName: string
  roleDesc?: string
}

async function seedWorkgroup(input: {
  name: string
  members?: SeedMember[]
  leaderDisplayName?: string
  mode?: 'leader_worker' | 'free_collab' | 'dynamic_workflow'
}): Promise<WorkgroupDetail> {
  return api<WorkgroupDetail>('/api/workgroups', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      description: 'RFC-319 workgroup editor fixture',
      instructions: 'base instructions',
      mode: input.mode ?? 'leader_worker',
      ...(input.leaderDisplayName === undefined
        ? {}
        : { leaderDisplayName: input.leaderDisplayName }),
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 8,
      completionGate: false,
      clarifyBudget: 0,
      fanOut: false,
      members: (input.members ?? []).map((member) => ({ roleDesc: '', ...member })),
    }),
  })
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

/**
 * 把「这一刻共发出过几次保存」变成可断言的数字 —— 用来证明「被阻断时一次都没发」。
 *
 * **每个用例只许调用一次**并把返回的读数器存起来：它每调一次就挂一个新的
 * request 监听器、从 0 起数，重复调用会让「前后两次读数相等」变成 0 === 0 的
 * 恒真断言（本文件第一版就踩了这个坑）。
 */
function countPuts(page: Page, workgroupId: string): () => number {
  let sent = 0
  page.on('request', (request) => {
    if (request.method() !== 'PUT') return
    if (new URL(request.url()).pathname !== `/api/workgroups/${workgroupId}`) return
    sent += 1
  })
  return () => sent
}

/**
 * 等过自动保存的去抖窗口（useWorkflowEditorDraft.ts:525 默认 1000ms）再数请求。
 * 少于这个时长的等待下断言「一次都没发」是假红保护：那一刻本来就还没到发送时机。
 */
async function settleAutosaveWindow(page: Page): Promise<void> {
  await page.waitForTimeout(1_800)
}

/** 等一次真实落地的保存，并把回执交回调用方逐字段对账。 */
async function waitForSave(
  page: Page,
  workgroupId: string,
  action: () => Promise<void>,
): Promise<{ version: number; workgroup: WorkgroupDetail }> {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/workgroups/${workgroupId}`,
  )
  await action()
  const response = await pending
  expect(response.ok(), `保存被服务端拒了：${response.status()}`).toBe(true)
  const receipt = (await response.json()) as {
    revision: { version: number }
    workgroup: WorkgroupDetail
  }
  return { version: receipt.revision.version, workgroup: receipt.workgroup }
}

/** 刷新 / 关标签页守卫是否武装：合成一个可取消的 beforeunload，看它被不被拦。 */
async function beforeUnloadIsGuarded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const probe = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(probe)
    return probe.defaultPrevented
  })
}

/** 「拦住了」和「还没来得及跳」从外部看一样，所以要给路由一个真实的机会去跳。 */
async function settleNavigationAttempt(page: Page): Promise<void> {
  await page.waitForTimeout(800)
}

function draftPhase(page: Page): Locator {
  return page.getByTestId('workgroup-draft-phase')
}

function headerMeta(page: Page): Locator {
  return page.locator('.editor-page-header .page__meta')
}

/** 共享 Select（RFC-036 popover + 搜索框）：开→搜→点选项。原生 <select> 用不了。 */
async function pickAgentInSelect(page: Page, agentName: string): Promise<void> {
  await page.getByTestId('workgroup-agent-name-input').click()
  await page.getByTestId('workgroup-agent-name-input-search').fill(agentName)
  await page.getByRole('option').filter({ hasText: agentName }).first().click()
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  for (const name of [LEAD_AGENT_NAME, WORKER_AGENT_NAME]) {
    const agent = await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 workgroup editor fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '',
      }),
    })
    if (name === LEAD_AGENT_NAME) leadAgentId = agent.id
    else workerAgentId = agent.id
  }
  humanUserId = (
    await api<{ id: string }>('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: HUMAN_USERNAME,
        displayName: HUMAN_DISPLAY_NAME,
        role: 'user',
        password: 'Rfc319WgHuman#1',
      }),
    })
  ).id
  disabledUserId = (
    await api<{ id: string }>('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: DISABLED_USERNAME,
        displayName: 'Retired',
        role: 'user',
        password: 'Rfc319WgGone#1',
      }),
    })
  ).id
  await api(`/api/users/${disabledUserId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'disabled' }),
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// WG-07 + WG-13
// ---------------------------------------------------------------------------

test('WG-07 / WG-13 配置自动保存：版本只在回执落地后前进，七个字段逐个落库并在刷新后回读 @nightly', async ({
  page,
}) => {
  const group = await seedWorkgroup({
    name: 'rfc319-wg-config',
    leaderDisplayName: 'Lead',
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead' },
      { memberType: 'agent', agentId: workerAgentId, displayName: 'Builder' },
      // human 成员在场，completionGate / clarifyBudget 两个控件才不是灰的
      // （WorkgroupForm.tsx:193,211 的 `!hasHumanMember` 门）。
      { memberType: 'human', userId: humanUserId, displayName: HUMAN_DISPLAY_NAME },
    ],
  })
  await authPage(page)

  // ---- 1) 保存中的那一格：请求已发出、回执还没回来 ----
  let releaseSave: () => void = () => {}
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve
  })
  let gateArmed = true
  await page.route(
    (url) => url.pathname === `/api/workgroups/${group.id}`,
    async (route) => {
      if (gateArmed && route.request().method() === 'PUT') await saveGate
      await route.continue()
    },
  )

  await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
  await expect(
    headerMeta(page),
    'header 不显示 id · 版本 ⇒ 用户无从判断自己在编辑哪一版',
  ).toContainText(`${group.id} · v1`)
  await expect(draftPhase(page), '刚进来就不是「已保存」⇒ 用户以为自己一进门就欠着改动').toHaveText(
    'Saved',
  )

  const sawPut = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === `/api/workgroups/${group.id}`,
  )
  await page.getByTestId('workgroup-field-instructions').fill('rfc319 charter v2')
  await sawPut
  await expect(
    draftPhase(page),
    '保存进行中没有任何反馈 ⇒ 慢网下用户只看到状态凝固，会以为编辑器坏了、把内容重打一遍',
  ).toHaveText('Saving')
  await expect(
    headerMeta(page),
    '回执还没回来版本号就先前进 ⇒ 用户看到 v2 却可能什么都没落库，事后无法自证',
  ).toContainText(`${group.id} · v1`)
  expect(
    (await readWorkgroup(group.id)).version,
    '请求还被扣着，服务端却已经是 v2 ⇒ 上面那条「未前进」断言测的不是同一件事',
  ).toBe(1)

  gateArmed = false
  releaseSave()
  await expect(draftPhase(page), '回执落地后仍不回到「已保存」⇒ 用户永远看不到保存成功').toHaveText(
    'Saved',
  )
  await expect(
    headerMeta(page),
    '回执落地了版本号却不动 ⇒ header 上的版本是个死数字',
  ).toContainText(`${group.id} · v2`)

  // ---- 2) 七个配置字段逐个落库 ----
  const maxRoundsSave = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-field-max-rounds').fill('42')
  })
  expect(maxRoundsSave.workgroup.maxRounds, '改了最大轮次却没进回执 ⇒ 任务仍按旧上限跑').toBe(42)

  const contractSave = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-output-contract-discussion').click()
  })
  expect(
    contractSave.workgroup.outputContract,
    '交付契约没落库 ⇒ 完成判定仍要求零文件改动，讨论型工作组永远被判未完成',
  ).toBe('discussion')

  const dmSave = await waitForSave(page, group.id, async () => {
    await page.getByRole('checkbox', { name: /Direct messages/ }).click()
  })
  expect(dmSave.workgroup.switches.directMessages, '开关翻了没落库 ⇒ 成员之间仍然 @不到人').toBe(
    true,
  )
  expect(
    dmSave.workgroup.switches.blackboard,
    '只翻了一个开关，另一个也跟着变 ⇒ 保存写的是整段而不是用户改的那一项',
  ).toBe(false)

  const gateSave = await waitForSave(page, group.id, async () => {
    await page.getByRole('checkbox', { name: /Completion gate/ }).click()
  })
  expect(
    gateSave.workgroup.completionGate,
    '完成确认门没落库 ⇒ leader 宣布完成就直接结单，人类根本没机会确认',
  ).toBe(true)

  const fanOutSave = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-field-fanout').click()
  })
  expect(fanOutSave.workgroup.fanOut, '扇出开关没落库 ⇒ 用户开了并发派发，实际还是一个一个来').toBe(
    true,
  )

  const budgetSave = await waitForSave(page, group.id, async () => {
    await page.getByRole('spinbutton', { name: /Ask-back limit/ }).fill('3')
  })
  expect(
    budgetSave.workgroup.clarifyBudget,
    '反问预算没落库 ⇒ 用户设的「最多问 3 次」不生效，要么永远不问要么问个不停',
  ).toBe(3)

  // ---- 3) 服务端真值 + 刷新回读（只信回执等于信服务端自己报的分数）----
  const persisted = await readWorkgroup(group.id)
  expect(
    {
      instructions: persisted.instructions,
      maxRounds: persisted.maxRounds,
      outputContract: persisted.outputContract,
      switches: persisted.switches,
      completionGate: persisted.completionGate,
      clarifyBudget: persisted.clarifyBudget,
      fanOut: persisted.fanOut,
      version: persisted.version,
    },
    '任一字段没落库 ⇒ 界面显示已保存、下次启动却按旧规则跑，属于静默丢数据',
  ).toEqual({
    instructions: 'rfc319 charter v2',
    maxRounds: 42,
    outputContract: 'discussion',
    switches: { shareOutputs: true, directMessages: true, blackboard: false },
    completionGate: true,
    clarifyBudget: 3,
    fanOut: true,
    // v1 起步，上面恰好 7 次保存。多一次 = 有字段被重复写，少一次 = 有编辑被吞。
    version: 8,
  })
  expect(persisted.name, '只改配置字段却把名字也改了 ⇒ 全量替换的 PUT 把没碰过的字段一起冲了').toBe(
    'rfc319-wg-config',
  )

  await page.reload()
  await expect(headerMeta(page)).toContainText(`${group.id} · v8`)
  await expect(
    page.getByTestId('workgroup-field-instructions'),
    '刷新后 charter 回读不出来 ⇒ 用户下次进来看到的是旧内容，会再改一遍',
  ).toHaveValue('rfc319 charter v2')
  await expect(page.getByTestId('workgroup-field-max-rounds')).toHaveValue('42')
  await expect(page.getByRole('spinbutton', { name: /Ask-back limit/ })).toHaveValue('3')
  await expect(
    page.getByTestId('workgroup-output-contract-discussion'),
    '刷新后分段控件没停在已保存的那一格 ⇒ 用户以为自己没改成功，会再点一次',
  ).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('checkbox', { name: /Direct messages/ })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /Completion gate/ })).toBeChecked()
  await expect(page.getByTestId('workgroup-field-fanout')).toBeChecked()
  // 负向对照：没碰过的那个开关刷新后仍是关的，证明上面几条不是「一律 checked」。
  await expect(
    page.getByRole('checkbox', { name: /Broadcast messages/ }),
    '没动过的开关自己变成开 ⇒ 回读把默认值当成了用户设置',
  ).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// WG-10 + WG-14
// ---------------------------------------------------------------------------

test('WG-10 / WG-14 成员增删与 leader 指派：就绪性提示逐条消失、启动按钮随之解禁、移除后焦点交给邻卡 @nightly', async ({
  page,
}) => {
  const group = await seedWorkgroup({ name: 'rfc319-wg-readiness' })
  await authPage(page)
  await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)

  const banner = page.getByTestId('workgroup-readiness-banner')
  const launch = page.getByTestId('workgroup-launch-button')

  // ---- 0) 零成员：两条阻断原因都要说出来 ----
  await expect(
    page.getByTestId('workgroup-members-empty'),
    '空花名册不给空态 ⇒ 左栏一片空白，用户不知道要从哪里加人',
  ).toBeVisible()
  await expect(banner, '零成员却不提示 ⇒ 启动按钮是个没有解释的灰按钮').toBeVisible()
  await expect(banner).toContainText('No agent members yet — the group cannot launch.')
  await expect(
    banner,
    '只说了缺 agent 没说缺 leader ⇒ 用户加完 agent 才发现还差一步，来回试',
  ).toContainText('Leader-Worker mode needs one agent member designated as leader.')
  await expect(launch, '没配齐就能点启动 ⇒ 任务起来立刻 422，用户白等一轮').toBeDisabled()

  // ---- 1) 加一个 agent 成员 ----
  await page.getByTestId('workgroup-add-agent-member').click()
  await expect(page.getByTestId('workgroup-panel-add')).toBeVisible()
  await pickAgentInSelect(page, WORKER_AGENT_NAME)
  await expect(
    page.getByTestId('workgroup-member-displayname-input'),
    '选完 agent 别名不自动填 ⇒ 用户还得自己想一个不重名的代号',
  ).toHaveValue(WORKER_AGENT_NAME)
  await page.getByTestId('workgroup-member-role-input').fill('Implements the plan.')
  const added = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-add-agent-confirm').click()
  })
  expect(added.workgroup.members.length, '点了「添加」成员没进花名册').toBe(1)
  expect(
    added.workgroup.members[0]?.agentId,
    '成员进去了但 agentId 是空的 ⇒ 启动时才炸，编辑器上完全看不出来',
  ).toBe(workerAgentId)
  expect(added.workgroup.members[0]?.roleDesc).toBe('Implements the plan.')
  await expect(
    page.locator('.workgroup-panel__title'),
    '加完不切到新成员 ⇒ 用户不知道加成功没有，还得自己去左栏找',
  ).toHaveText(WORKER_AGENT_NAME)

  // 负向对照：这一条原因必须**消失**，剩下的那条必须还在。
  await expect(
    banner,
    '加了 agent 还在喊「没有 agent 成员」⇒ 提示不跟着草稿走，用户不知道自己做对了没有',
  ).not.toContainText('No agent members yet')
  await expect(banner).toContainText(
    'Leader-Worker mode needs one agent member designated as leader.',
  )
  await expect(launch, '还没指定 leader 就解禁 ⇒ 任务起来没人派活').toBeDisabled()

  // ---- 2) 指定 leader ----
  const leaderSaved = await waitForSave(page, group.id, async () => {
    await page.getByTestId(`workgroup-set-leader-${WORKER_AGENT_NAME}`).click()
  })
  expect(
    leaderSaved.workgroup.leaderMemberId,
    'set-leader 没落库 ⇒ 界面显示有 leader，服务端仍是无主的',
  ).toBe(leaderSaved.workgroup.members[0]?.id)
  await expect(
    page.locator('.workgroup-mrail').getByTestId('workgroup-leader-badge'),
    '成员卡上没有 leader 徽标 ⇒ 一屏成员里看不出谁是头',
  ).toBeVisible()

  // 阻断原因清零，但「只有 leader 没有干活的人」这条**建议**必须出现。
  await expect(
    banner,
    '只剩 leader 一个人也不提醒 ⇒ 任务起来 leader 只能空转到触顶，用户等一小时才看出问题',
  ).toContainText('The roster only contains the leader')
  await expect(banner).not.toContainText('needs one agent member designated as leader')
  await expect(
    launch,
    '建议级警告把启动按钮也锁死了 ⇒ 用户明知故犯的合法配置被挡在门外',
  ).toBeEnabled()

  // ---- 3) 加一个 human 成员：建议级警告随之消失 ----
  await page.getByTestId('workgroup-add-human-member').click()
  await page.getByTestId('workgroup-member-user-input').fill(HUMAN_USERNAME)
  await page.getByTestId(`workgroup-member-user-option-${HUMAN_USERNAME}`).click()
  await expect(
    page.getByTestId('workgroup-member-displayname-input'),
    '挑完用户别名不自动填 ⇒ 用户得自己把带空格的显示名改成合法别名',
  ).toHaveValue(HUMAN_DISPLAY_NAME)
  const humanAdded = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-add-human-confirm').click()
  })
  expect(
    humanAdded.workgroup.members.find((m) => m.memberType === 'human')?.userId,
    'human 成员的 userId 没落库 ⇒ 反问 / 确认永远找不到人',
  ).toBe(humanUserId)
  await expect(banner, '有人可派了警告还挂着 ⇒ 提示失去意义，用户以后一律无视它').toHaveCount(0)
  await expect(launch).toBeEnabled()

  // 正向对照：解禁的按钮真能把用户送进启动向导，而不只是变亮。
  await launch.click()
  await expect(page, '启动按钮点了不跳 ⇒ 上面所有「已解禁」的断言只证明了颜色').toHaveURL(
    new RegExp(`/tasks/new\\?.*workgroupId=${group.id}`),
  )
  await page.goBack()
  await expect(headerMeta(page)).toContainText(group.id)

  // ---- 4) 移除 human 成员：焦点交给邻卡，警告回归 ----
  await page.getByTestId(`workgroup-card-open-${HUMAN_DISPLAY_NAME}`).click()
  const removeButton = page.getByRole('button', { name: 'Remove', exact: true })
  await removeButton.click() // 第一下只是「武装」两段式确认
  await expect(
    page.getByRole('button', { name: 'Confirm?', exact: true }),
    '删除成员一击即中 ⇒ 误点就把人删了，而且没有撤销',
  ).toBeVisible()
  const removed = await waitForSave(page, group.id, async () => {
    await page.getByRole('button', { name: 'Confirm?', exact: true }).click()
  })
  expect(
    removed.workgroup.members.map((m) => m.displayName),
    '移除没落库',
  ).toEqual([WORKER_AGENT_NAME])
  await expect
    .poll(
      async () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null),
      { message: '移除后焦点掉回 body ⇒ 键盘用户当场失去位置，得从头 Tab 一遍' },
    )
    .toBe(`workgroup-card-open-${WORKER_AGENT_NAME}`)
  await expect(
    banner,
    '把人移走了警告不回来 ⇒ 就绪性提示只算过一次，之后一直显示陈旧结论',
  ).toContainText('The roster only contains the leader')

  const finalState = await readWorkgroup(group.id)
  expect(finalState.members.length).toBe(1)
  expect(finalState.leaderMemberId, '移除别人把 leader 也弄丢了').toBe(finalState.members[0]?.id)
})

// ---------------------------------------------------------------------------
// WG-11
// ---------------------------------------------------------------------------

test('WG-11 成员校验：重复别名 / @ / 逗号 / 空白当场拦住且一次保存都不发；human 必须活跃、agent 必须真实存在（服务端同样拦） @nightly', async ({
  page,
}) => {
  const group = await seedWorkgroup({
    name: 'rfc319-wg-validation',
    leaderDisplayName: 'Lead',
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead' },
      { memberType: 'agent', agentId: workerAgentId, displayName: 'Builder' },
    ],
  })
  await authPage(page)
  const putCount = countPuts(page, group.id)
  await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
  await expect(draftPhase(page)).toHaveText('Saved')
  const putsAfterLoad = putCount()

  // ---- 1) 「加成员」面板的逐字符规则 ----
  await page.getByTestId('workgroup-add-agent-member').click()
  await pickAgentInSelect(page, WORKER_AGENT_NAME)
  const alias = page.getByTestId('workgroup-member-displayname-input')
  const confirm = page.getByTestId('workgroup-add-agent-confirm')
  await expect(confirm, '选完 agent、别名合法却仍不让提交 ⇒ 正常路径被自己堵死').toBeEnabled()

  await alias.fill('Lead')
  await expect(
    page.locator('.form-field__error'),
    '别名撞车不报错 ⇒ 花名册里两个同名成员，@提及分不清是谁',
  ).toHaveText('Display names must be unique within the group.')
  await expect(confirm, '别名撞车还能提交 ⇒ 派活会派给错的人').toBeDisabled()

  for (const [bad, why] of [
    ['Lead@Ops', '别名里的 @ 会被当成提及分隔符，整条提及解析错位'],
    ['Lead,Ops', '别名里的逗号会把花名册列表切成两半'],
    ['Lead Ops', '别名里的空白会把一个成员读成两个'],
  ] as const) {
    await alias.fill(bad)
    await expect(page.locator('.form-field__error'), why).toHaveText(
      'Display name must not contain @, comma or whitespace.',
    )
    await expect(confirm, `「${bad}」还能提交 ⇒ ${why}`).toBeDisabled()
  }

  // 负向对照：合法别名下错误消失、按钮恢复 —— 证明上面几条不是「按钮一直是灰的」。
  await alias.fill('Auditor')
  await expect(page.locator('.form-field__error')).toHaveCount(0)
  await expect(confirm).toBeEnabled()

  // 半截草稿本身会堵住自动保存，且必须**说明原因**。
  await expect(
    draftPhase(page),
    '有半截成员草稿时仍显示「已保存」⇒ 用户以为一切就绪，其实配置全卡在本地',
  ).toHaveText('Waiting for corrections')
  await expect(page.getByTestId('workgroup-draft-notices')).toContainText(
    'Finish adding the member to resume autosave',
  )
  await settleAutosaveWindow(page)
  expect(
    putCount(),
    '别名不合法 / 草稿没填完期间仍在往服务端发保存 ⇒ 服务端会拿到半成品或直接 422',
  ).toBe(putsAfterLoad)
  // 把草稿收掉（Close 不算收掉 —— 未完成的 add 草稿故意留在面板拥有者里，
  // WorkgroupContextPanel.tsx:86-89），否则下一段的阻断原因会一直是这一条。
  await waitForSave(page, group.id, async () => {
    await confirm.click()
  })
  await expect(
    draftPhase(page),
    '成员加完了自动保存还堵着 ⇒ 用户此后所有编辑都不再落库，界面却只说「等你修」',
  ).toHaveText('Saved')

  // ---- 2) 已有成员改成重复别名：自动保存被阻断，且一次都不发 ----
  await page.getByTestId('workgroup-card-open-Builder').click()
  const before = putCount()
  await page.getByTestId('workgroup-member-displayname-input').fill('Lead')
  await expect(
    draftPhase(page),
    '把已有成员改成重名却照样保存 ⇒ 服务端 422，而界面上什么都没发生',
  ).toHaveText('Waiting for corrections')
  await expect(page.getByTestId('workgroup-draft-notices')).toContainText(
    'Autosave will resume after you fix this',
  )
  await settleAutosaveWindow(page)
  expect(putCount(), '被阻断期间仍发出了保存请求 ⇒ 服务端会吃到一份重名花名册或一记 422').toBe(
    before,
  )

  // 正向对照：改回合法值后自动保存立刻恢复并真的落库。
  const fixed = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-member-displayname-input').fill('Builder2')
  })
  expect(
    fixed.workgroup.members.map((m) => m.displayName).sort(),
    '改回合法值后保存没恢复 ⇒ 用户被永久卡住，只能刷新丢掉改动',
  ).toEqual(['Auditor', 'Builder2', 'Lead'])
  await expect(draftPhase(page)).toHaveText('Saved')

  // ---- 3) agent 只能从真实存在的列表里挑，编不出一个不存在的 ----
  await page.getByTestId('workgroup-add-agent-member').click()
  await page.getByTestId('workgroup-agent-name-input').click()
  await page.getByTestId('workgroup-agent-name-input-search').fill('rfc319-no-such-agent')
  await expect(
    page.locator('.select__empty'),
    '搜不到还不说话 ⇒ 用户以为自己打错字，反复重打',
  ).toHaveText('No matches')
  await expect(
    page.getByRole('option'),
    '选择器能凭空造出一个 agent ⇒ 引用一个不存在的 agent，启动时才炸',
  ).toHaveCount(0)
  await page.keyboard.press('Escape')

  // ---- 4) 被停用的账号在用户选择器里挑不动 ----
  await page.getByTestId('workgroup-panel-close').click()
  await page.getByTestId('workgroup-add-human-member').click()
  await page.getByTestId('workgroup-member-user-input').fill(DISABLED_USERNAME)
  const disabledOption = page.getByTestId(`workgroup-member-user-option-${DISABLED_USERNAME}`)
  await expect(disabledOption).toBeVisible()
  await expect(
    disabledOption,
    '停用的账号还能被选成成员 ⇒ 任务永远等一个不会来的人，直到超时',
  ).toBeDisabled()
  // 正向对照：活跃账号在同一个选择器里是可选的。
  await page.getByTestId('workgroup-member-user-input').fill(HUMAN_USERNAME)
  await expect(page.getByTestId(`workgroup-member-user-option-${HUMAN_USERNAME}`)).toBeEnabled()

  // ---- 5) 服务端是同一套规则的兜底：绕开界面直接 PUT 一样被拒 ----
  const current = await readWorkgroup(group.id)
  const putRaw = async (members: unknown[]): Promise<{ status: number; code?: string }> => {
    const res = await fetch(`${daemon.baseUrl}/api/workgroups/${current.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: current.version,
        // Crockford base32（无 I / L / O / U），否则请求在到达业务规则之前
        // 就被 WorkgroupMutationIdSchema 打回，这一段测的就不是它想测的东西了。
        clientMutationId: '01JRF319WGVAKDATN0NPQRSTVW',
        snapshot: {
          name: current.name,
          description: current.description,
          instructions: current.instructions,
          mode: current.mode,
          outputContract: current.outputContract,
          switches: current.switches,
          maxRounds: current.maxRounds,
          completionGate: current.completionGate,
          clarifyBudget: current.clarifyBudget,
          fanOut: current.fanOut,
          members,
        },
      }),
    })
    const body = (await res.json().catch(() => ({}))) as { code?: string }
    return { status: res.status, code: body.code }
  }

  const withDisabledHuman = await putRaw([
    { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead', roleDesc: '' },
    { memberType: 'human', userId: disabledUserId, displayName: 'Retired', roleDesc: '' },
  ])
  expect(
    withDisabledHuman,
    '服务端收下了指向停用账号的成员 ⇒ 界面那道拦截只是装饰，脚本 / 导入路径能直接写进去',
  ).toEqual({ status: 422, code: 'workgroup-member-user-invalid' })

  const withGhostAgent = await putRaw([
    {
      memberType: 'agent',
      agentId: '01JRF319GH0STAGENTQRSTVWXY',
      displayName: 'Ghost',
      roleDesc: '',
    },
  ])
  expect(
    withGhostAgent,
    '服务端收下了不存在的 agent 引用 ⇒ 工作组看起来配好了，一启动就整体失败',
  ).toEqual({ status: 422, code: 'workgroup-member-agent-invalid' })

  expect(
    (await readWorkgroup(group.id)).members.map((m) => m.displayName).sort(),
    '两次被拒的写入还是改了花名册 ⇒ 拒绝不是原子的',
  ).toEqual(['Auditor', 'Builder2', 'Lead'])
})

// ---------------------------------------------------------------------------
// WG-12
// ---------------------------------------------------------------------------

test('WG-12 模式切换的 UI 后果：free_collab 把三开关显示成强制 ON 却不改存储、dynamic_workflow 抹掉开关段与「加人类成员」 @nightly', async ({
  page,
}) => {
  const group = await seedWorkgroup({
    name: 'rfc319-wg-modes',
    leaderDisplayName: 'Lead',
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead' },
      { memberType: 'agent', agentId: workerAgentId, displayName: 'Builder' },
    ],
  })
  await authPage(page)
  // 只挂一次读数器（见 countPuts 的注释：重复调用会把后面的对比变成恒真）。
  const putCount = countPuts(page, group.id)
  await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)

  const share = page.getByRole('checkbox', { name: /Share outputs/ })
  const dm = page.getByRole('checkbox', { name: /Direct messages/ })
  const blackboard = page.getByRole('checkbox', { name: /Broadcast messages/ })
  const fcNotice = page.getByTestId('workgroup-fc-switches-notice')
  const addHuman = page.getByTestId('workgroup-add-human-member')

  // ---- 起点 leader_worker：三开关可改、按存储值显示 ----
  await expect(fcNotice, 'leader_worker 也挂着 free_collab 的强制提示 ⇒ 提示失去指向').toHaveCount(
    0,
  )
  await expect(share).toBeChecked()
  await expect(
    dm,
    '存的是关，界面显示开 ⇒ 用户以为私聊已开，实际成员之间 @不到人',
  ).not.toBeChecked()
  await expect(dm, 'leader_worker 下开关就是灰的 ⇒ 用户根本改不了协作方式').toBeEnabled()
  await expect(page.getByTestId('workgroup-field-fanout')).toBeVisible()
  await expect(addHuman).toBeVisible()
  // 正向对照：leader_worker 下「设为 leader」**在**，后面 free_collab 里断它消失
  // 才有意义（否则那条 toHaveCount(0) 可能只是选择器本来就没匹配上任何东西）。
  await page.getByTestId('workgroup-card-open-Builder').click()
  await expect(page.getByTestId('workgroup-set-leader-Builder')).toBeVisible()
  await page.getByTestId('workgroup-panel-close').click()

  // ---- free_collab：三个开关一律显示为开且改不动，并说明为什么 ----
  const toFc = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-mode-free_collab').click()
  })
  expect(toFc.workgroup.mode).toBe('free_collab')
  await expect(
    fcNotice,
    'free_collab 不解释「为什么开关是灰的」⇒ 用户以为界面坏了，反复点',
  ).toHaveText(
    'Free collaboration forces all three switches on; switching back to Leader-Worker restores your settings.',
  )
  for (const [locator, name] of [
    [share, 'Share outputs'],
    [dm, 'Direct messages'],
    [blackboard, 'Broadcast messages'],
  ] as const) {
    await expect(
      locator,
      `free_collab 下「${name}」没显示成开 ⇒ 界面与实际协作行为对不上`,
    ).toBeChecked()
    await expect(
      locator,
      `free_collab 下「${name}」还能改 ⇒ 用户关掉它以为生效了，运行时却照旧全开`,
    ).toBeDisabled()
  }
  await expect(
    page.getByTestId('workgroup-field-fanout'),
    'free_collab 还留着 leader 扇出开关 ⇒ 一个没有 leader 的模式在配 leader 的能力',
  ).toHaveCount(0)

  // 关键：强制 ON 是**显示层**的事，存储不许被改写。
  const duringFc = await readWorkgroup(group.id)
  expect(
    duringFc.switches,
    'free_collab 把「强制 ON」写进了库 ⇒ 用户切回 leader_worker 时原本关掉的开关全被抹成开',
  ).toEqual({ shareOutputs: true, directMessages: false, blackboard: false })

  // 成员面板在无 leader 的模式下不该提供「设为 leader」。
  await page.getByTestId('workgroup-card-open-Builder').click()
  await expect(
    page.getByTestId('workgroup-set-leader-Builder'),
    'free_collab 还给「设为 leader」⇒ 点了没有任何效果，纯误导',
  ).toHaveCount(0)
  await page.getByTestId('workgroup-panel-close').click()

  // ---- 切回 leader_worker：用户原来的设置必须原样回来 ----
  await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-mode-leader_worker').click()
  })
  await expect(fcNotice).toHaveCount(0)
  await expect(share).toBeChecked()
  await expect(
    dm,
    '切回来发现自己关掉的开关变成了开 ⇒ free_collab 那趟把用户设置改写了',
  ).not.toBeChecked()
  await expect(dm, '切回来开关还是灰的 ⇒ 用户再也改不动协作方式').toBeEnabled()

  // ---- dynamic_workflow：整段开关 + 「加人类成员」消失 ----
  const toDyn = await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-mode-dynamic_workflow').click()
  })
  expect(toDyn.workgroup.mode).toBe('dynamic_workflow')
  await expect(
    share,
    'dynamic_workflow 还留着聊天室开关 ⇒ 用户在配一堆该模式下根本不读的设置',
  ).toHaveCount(0)
  await expect(dm).toHaveCount(0)
  await expect(blackboard).toHaveCount(0)
  await expect(page.getByTestId('workgroup-field-max-rounds')).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: /Completion gate/ })).toHaveCount(0)
  await expect(
    addHuman,
    'dynamic_workflow 还给「加人类成员」⇒ 用户加进去后保存被拒，只能自己猜是哪一步错了',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('workgroup-add-agent-member'),
    '连「加 agent 成员」也一起藏了 ⇒ 该模式下的花名册再也编辑不了',
  ).toBeVisible()

  // ---- 反向：有 human 成员时切 dynamic_workflow 必须当场说明，而不是静默失败 ----
  await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-mode-leader_worker').click()
  })
  await page.getByTestId('workgroup-add-human-member').click()
  await page.getByTestId('workgroup-member-user-input').fill(HUMAN_USERNAME)
  await page.getByTestId(`workgroup-member-user-option-${HUMAN_USERNAME}`).click()
  await waitForSave(page, group.id, async () => {
    await page.getByTestId('workgroup-add-human-confirm').click()
  })
  await page.getByTestId('workgroup-config-entry').click()
  const putsBeforeConflict = putCount()
  await page.getByTestId('workgroup-mode-dynamic_workflow').click()
  await expect(
    page.locator('.form-field__error'),
    '带着人类成员切 dynamic_workflow 不解释 ⇒ 自动保存无声停摆，用户只看到一个转不动的编辑器',
  ).toHaveText(
    'Dynamic-workflow groups allow agent members only — remove the human members before saving.',
  )
  await expect(draftPhase(page)).toHaveText('Waiting for corrections')
  await settleAutosaveWindow(page)
  expect(putCount(), '明知不合法还把它发出去 ⇒ 服务端 422，界面上又是一次无声失败').toBe(
    putsBeforeConflict,
  )
  expect(
    (await readWorkgroup(group.id)).mode,
    '被阻断的模式切换居然落了库 ⇒ 用户的工作组变成了一个自己没批准的形态',
  ).toBe('leader_worker')
})

// ---------------------------------------------------------------------------
// WG-23
// ---------------------------------------------------------------------------

test('WG-23 未保存离开守卫：干净时不打扰，成员面板的半截草稿拦住侧栏跳转与刷新，「留下」保住草稿、「放弃」才放行 @nightly', async ({
  page,
}) => {
  const group = await seedWorkgroup({
    name: 'rfc319-wg-guard',
    leaderDisplayName: 'Lead',
    members: [{ memberType: 'agent', agentId: leadAgentId, displayName: 'Lead' }],
  })
  await authPage(page)
  await page.goto(`${daemon.baseUrl}/workgroups/${group.id}`)
  await expect(draftPhase(page)).toHaveText('Saved')

  const workflowsNav = page.locator('[data-tour="nav-/workflows"]')
  const guard = page.getByTestId('unsaved-guard-dialog')

  // ---- 负向对照：干净的编辑器不该拦任何东西 ----
  expect(
    await beforeUnloadIsGuarded(page),
    '什么都没改就拦刷新 ⇒ 每次离开工作组页都弹一个莫名其妙的确认框',
  ).toBe(false)
  await workflowsNav.click()
  await expect(page, '干净状态下侧栏跳转被拦 ⇒ 用户被困在自己没改过的页面上').toHaveURL(
    /\/workflows$/,
  )
  await page.goBack()
  await expect(headerMeta(page)).toContainText(group.id)

  // ---- 半截成员草稿：既堵自动保存，也必须堵离开 ----
  await page.getByTestId('workgroup-add-agent-member').click()
  await page.getByTestId('workgroup-member-displayname-input').fill('HalfTyped')
  await expect(
    draftPhase(page),
    '半截草稿时状态仍是「已保存」⇒ 用户以为没事，切走才发现刚填的没了',
  ).toHaveText('Waiting for corrections')
  expect(
    await beforeUnloadIsGuarded(page),
    '半截草稿时刷新不拦 ⇒ 一次误刷新就把刚填的成员抹掉，且毫无提示',
  ).toBe(true)

  await workflowsNav.click()
  await expect(
    guard,
    '半截草稿时侧栏跳转直接走掉 ⇒ 用户填的成员被静默丢弃，页面上一句解释都没有',
  ).toBeVisible()
  await expect(guard).toContainText(
    'You have unsaved changes. Leaving this page will discard them.',
  )

  await page.getByTestId('unsaved-stay').click()
  await expect(guard).toHaveCount(0)
  // 「拦住了」和「还没来得及跳」从外部看一样，所以先给路由一个真实的跳走机会。
  await settleNavigationAttempt(page)
  await expect(page, '选了「留下」还是走了 ⇒ 这个对话框只是走个过场').toHaveURL(
    new RegExp(`/workgroups/${group.id}$`),
  )
  await expect(
    page.getByTestId('workgroup-member-displayname-input'),
    '「留下」之后草稿被清空 ⇒ 拦是拦住了，要保的东西还是没了',
  ).toHaveValue('HalfTyped')

  // ---- 「放弃」才放行，且必须真的放行（否则上面几条就是恒真断言）----
  await workflowsNav.click()
  await expect(guard).toBeVisible()
  await page.getByTestId('unsaved-discard').click()
  await expect(page, '选了「放弃更改」还走不掉 ⇒ 用户被自己的草稿永久锁在这一页').toHaveURL(
    /\/workflows$/,
  )

  // 放弃的是本地草稿，不是已保存的内容：服务端花名册必须原样。
  const after = await readWorkgroup(group.id)
  expect(
    after.members.map((m) => m.displayName),
    '半截草稿居然被写进了服务端 ⇒ 花名册里多出一个用户没确认过的成员',
  ).toEqual(['Lead'])
  expect(after.version, '一次都没保存过版本却前进了').toBe(1)
})
