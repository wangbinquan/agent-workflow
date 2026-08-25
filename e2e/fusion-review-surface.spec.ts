// RFC-319 —— 记忆融合（fusion）的**用户面**：记忆页「融合」页签 + 融合详情页的
// 运行中 / 驳回 / 取消 / 失败四态 + 发起前的本地校验 + 待审徽章计数。
// 覆盖 INTENT-50 / INTENT-51 / INTENT-52 / INTENT-55 / INTENT-56 / INTENT-57 / INTENT-X9。
//
// **刻意不重复**（已被别处锁住，本文件只把它们当夹具用，不再断言）：
//   * INTENT-48 从技能详情页选记忆发起、INTENT-53 待审批页的变更日志 / 已吸收 /
//     已跳过三栏、INTENT-54 批准后技能版本 +1 且记忆转 fused 不再被注入
//     —— e2e/fusion-lifecycle.spec.ts；
//   * INTENT-58 三个读面的可见性隔离、INTENT-X3 跨用户 approve/reject/cancel 被拒
//     —— e2e/fusion-access.spec.ts。
//   所以这里的融合一律用 API 发起（发起路径不是本文件的断言对象），把机器时间全留给
//   上面那七条还没人管的行为。
//
// 一次融合会**改写托管技能的正文并递增它的版本**，而技能正文是往后每一次任务都要读的
// 东西。审批面本身失效不会报错，只会安静地跑偏，具体失效形态：
//
//   * 「融合」页签的空态 / 错误态互斥失守 ⇒ 拉取失败时页面照样写着「没有待审批的融合」，
//     等着人审的融合就此彻底消失在视野里，没人会再去找它；
//   * 详情页运行中不轮询 ⇒ 融合早就跑到待审批，页面还停在「agent 正在工作」，
//     用户以为卡死了，转头去点取消，一轮真实的 agent 工作被白扔；
//   * 运行中缺澄清入口 ⇒ merger 节点是**强制反问**的，第一轮必然停在问题上；没有那条
//     链接，用户在融合页面前干等，而任务其实在等他回答，永远等不到；
//   * 驳回不递增 iteration / 不清掉上一轮提案 ⇒ 页面把已经作废的变更日志和 diff 继续
//     摆在审批位上，用户批准的是一份自己刚刚否掉的东西；
//   * 取消少一道确认、或确认了却没停下引擎任务 ⇒ 误点直接丢掉一轮工作，或者 UI 说
//     「已取消」而 agent 进程还在工作树里继续写；
//   * 失败态不显示原因、还留着审批按钮 ⇒ 用户对着一个注定 409 的按钮反复点，真正的
//     失败原因只留在服务端，接手的人得从头复现一遍；
//   * 待审徽章算错 ⇒ 它是个数字，错了没有任何症状，只是导航上多/少一个点。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链）：
//   packages/backend/src/services/fusion.ts:120-129    融合状态机转移表
//   packages/backend/src/services/fusion.ts:733-808    reconcileFusion：任务终态 → 融合状态
//   packages/backend/src/services/fusion.ts:793-802    D12「每条已选记忆必须恰好被交代一次」
//   packages/backend/src/services/fusion.ts:1575       reject 的 nextIter = row.iteration + 1
//   packages/backend/src/services/fusion.ts:1660-1672  reject 清空上一轮提案字段
//   packages/backend/src/services/fusion.ts:1737-1777  cancelFusion + 连带取消引擎任务
//   packages/backend/src/routes/fusions.ts:115-132     GET /api/fusions/pending-count
//   packages/frontend/src/routes/fusions.detail.tsx:30,44-46   运行中 2s 轮询
//   packages/frontend/src/routes/fusions.detail.tsx:147-160    运行中提示条 + 澄清链接
//   packages/frontend/src/routes/fusions.detail.tsx:163-168    失败态错误区
//   packages/frontend/src/routes/fusions.detail.tsx:215-233    审批区（仅 awaiting_approval）
//   packages/frontend/src/routes/fusions.detail.tsx:127-137    取消按钮（仅非终态）
//   packages/frontend/src/components/memory/MemoryFusionList.tsx:33-62  空态 / 错误重试 / 列表
//   packages/frontend/src/components/fusion/FuseDialog.tsx:112-123      发起前的本地校验
//   packages/frontend/src/components/shell/MemoryPendingBadge.tsx:39-52 徽章计数来源
//   packages/frontend/src/routes/memory.tsx:219-225                     「融合」页签的徽章位
//   packages/system-mocks/src/runtime/mode-fusion.ts                    唯一能推到待审批的 stub

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const SKILL_NAME = 'rfc319-review-surface-skill'
const KEEP_TITLE = 'rfc319-review-surface-keep'
const DOOMED_TITLE = 'rfc319-review-surface-doomed'
const REJECT_FEEDBACK = 'Group the two preferences under one heading and keep the examples.'
/** 证明「详情页是自己轮询翻过去的」——只要中途发生过导航，这个标记就没了。 */
const STAY_PUT_MARK = '__rfc319FusionDetailStayedPut'

let daemon: DaemonHandle
let skillId: string
let keepMemoryId: string
let doomedMemoryId: string
let fusionAId: string
let fusionBId: string

interface FusionView {
  id: string
  status: string
  iteration: number
  currentTaskId: string | null
  decisionReason: string | null
  changelog: string | null
  incorporatedMemoryIds: string[] | null
  error: string | null
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await req(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function fusionOf(id: string): Promise<FusionView> {
  return api<FusionView>(`/api/fusions/${id}`)
}

async function seedApprovedMemory(title: string, bodyMd: string): Promise<string> {
  const created = await api<{ memory: { id: string } }>('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ scopeType: 'global', scopeId: null, title, bodyMd }),
  })
  // 手工建的记忆初始是 candidate；融合只吃 approved（createFusion 的
  // `fusion-memory-not-approved`，services/fusion.ts:592）。
  await api(`/api/memories/${created.memory.id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  return created.memory.id
}

async function openApp(page: Page, path: string): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}${path}`)
}

/** 轮询到一个非空值，超时时用给定的话说明「等的是什么」。 */
async function pollFor<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  let last: T | null = null
  await expect
    .poll(
      async () => {
        last = await read()
        return last !== null
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  expect(last, what).not.toBeNull()
  return last as T
}

/**
 * 等融合到某个状态。**连 error 一起断言**：只报「期望 X、实得 Y」等于把真正的原因
 * 留在服务端，接手的人要从头复现一遍才能看到它。
 */
async function waitForFusionStatus(id: string, expected: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await fusionOf(id)
        return row.status === expected
          ? expected
          : `${row.status}: ${row.error ?? '(no error recorded)'}`
      },
      { timeout: 180_000 },
    )
    .toBe(expected)
}

/**
 * 回答融合那一轮**强制**反问。
 *
 * 反问本身不是这条 spec 要覆盖的能力（e2e/clarify.spec.ts 已经锁住它），但它是产品的
 * 硬契约：merger 节点跑在强制 ask-back 模式下，第一轮直接出 `<workflow-output>` 会被
 * 以 `clarify-required-output-emitted` 当场判失败。所以每一轮迭代都必须真的答一次，
 * 融合才走得到待审批——`directive: 'stop'` 是把节点从强制反问里放出来的那个开关。
 */
async function answerFusionClarify(fusionId: string): Promise<void> {
  const taskId = await pollFor(
    async () => (await fusionOf(fusionId)).currentTaskId,
    `融合 ${fusionId} 没有关联任务`,
  )
  const session = await pollFor(async () => {
    const rows = await api<Array<{ intermediaryNodeRunId: string; iteration: number }>>(
      `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
    )
    return rows[0] ?? null
  }, `融合 ${fusionId} 的任务没有停在反问上`)
  await api(`/api/clarify/${session.intermediaryNodeRunId}/answers`, {
    method: 'POST',
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-merge',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      directive: 'stop',
      ifMatchIteration: session.iteration,
    }),
  })
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'fusion' })

  skillId = (
    await api<{ id: string }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: SKILL_NAME,
        description: 'RFC-319 fusion review-surface fixture',
        bodyMd: '# fixture\n\nOriginal skill body.\n',
      }),
    })
  ).id
  keepMemoryId = await seedApprovedMemory(
    KEEP_TITLE,
    'Always use two spaces for indentation in this repository.',
  )
  doomedMemoryId = await seedApprovedMemory(
    DOOMED_TITLE,
    'Prefer trailing commas in multi-line literals.',
  )
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// INTENT-50 —— 发起前的本地校验
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-50: 未选记忆 / 未选技能时，发起融合被本地拦下——不发请求、不清空已写的意图', async ({
  page,
}) => {
  const launches: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/fusions') {
      launches.push(request.url())
    }
  })

  // ① 从技能详情页进：技能已经锁定，缺的是记忆。
  await openApp(page, `/skills/${skillId}`)
  await page.getByRole('button', { name: 'Fuse memories', exact: true }).click()
  await expect(page.getByTestId('fusion-memory-picker')).toBeVisible()
  const intent = page.getByTestId('fusion-intent')
  await intent.fill('RFC-319 local-validation probe')
  await page.getByRole('button', { name: 'Start fusion', exact: true }).click()

  await expect(
    page.getByText('Select at least one memory.', { exact: true }),
    '一条记忆都没选也能提交 ⇒ 用户吃到的是服务端 zod 的 `invalid fusion payload`，' +
      '既看不出缺什么，也已经白跑了一次往返',
  ).toBeVisible()
  await expect(
    intent,
    '校验把对话框重置了 ⇒ 用户刚写好的融合意图被清空，得从头再写一遍',
  ).toHaveValue('RFC-319 local-validation probe')

  // ② 从记忆页进：记忆已经选好，缺的是目标技能。
  await openApp(page, '/memory?tab=all')
  await page.getByTestId(`memory-row-${keepMemoryId}-select`).check()
  await page.getByTestId('memory-fuse-button').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Start fusion', exact: true }).click()
  await expect(
    page.getByText('Pick a target skill.', { exact: true }),
    '没选目标技能也能提交 ⇒ 同上，而且「融合进哪个技能」是这次操作里最不能猜的一项',
  ).toBeVisible()

  // 负向对照：两次都不许真的打出去。本地校验的意义就在于**没有请求**。
  expect(
    launches,
    '本地校验没拦住，POST /api/fusions 已经发出 ⇒ 校验形同虚设，错误改由服务端 4xx 回答',
  ).toEqual([])
})

// ---------------------------------------------------------------------------
// INTENT-51 / INTENT-X9 —— 空态、错误重试、以及「没有待审时不显示徽章」
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-51 / INTENT-X9: 没有待审融合时是空态且无徽章；列表拉取失败时给得出重试，且绝不冒充空态', async ({
  page,
}) => {
  expect(
    (await api<{ count: number }>('/api/fusions/pending-count')).count,
    '还没有任何融合，服务端却报出待审计数 ⇒ 后面的徽章断言都失去基线',
  ).toBe(0)

  await openApp(page, '/memory?tab=fusion')
  await expect(page.getByTestId('memory-fusion-empty')).toBeVisible()
  await expect(page.getByText('No fusions awaiting approval', { exact: true })).toBeVisible()
  await expect(
    page.getByTestId('memory-fusion-list'),
    '空态与列表同时在场 ⇒ 页面自相矛盾，用户不知道到底有没有东西等他审',
  ).toHaveCount(0)
  await expect(
    page.getByTestId('memory-section-fusion').locator('.page-section-nav__badge'),
    '零待审也挂徽章 ⇒ 导航上永远有个红点，用户点进来什么都没有，徽章从此被无视',
  ).toHaveCount(0)

  // 请求层故障注入：只掐列表端点（/api/fusions），不碰 pending-count。
  let failList = true
  await page.route(
    (url) => url.pathname === '/api/fusions',
    async (route) => {
      if (!failList) {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'fusion-list-unavailable',
          message: 'injected by rfc319 e2e',
        }),
      })
    },
  )
  await page.reload()

  const errorBox = page.getByTestId('memory-fusion-error')
  await expect(errorBox).toBeVisible()
  await expect(
    page.getByTestId('memory-fusion-empty'),
    '拉取失败却显示「没有待审批的融合」 ⇒ 等着人审的融合彻底从视野里消失，没人会再去找它',
  ).toHaveCount(0)

  const retry = errorBox.getByRole('button', { name: 'Retry', exact: true })
  await expect(
    retry,
    '错误态没有重试入口 ⇒ 一次瞬时失败要靠整页刷新才能恢复，而用户根本不知道该刷新',
  ).toBeVisible()

  failList = false
  await retry.click()
  await expect(page.getByTestId('memory-fusion-empty')).toBeVisible()
  await expect(
    errorBox,
    '重试成功了报错还赖着不走 ⇒ 用户无从判断当前看到的是新数据还是残留的错误',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// INTENT-52 —— 运行中提示条 + 澄清入口 + 2s 轮询自动进入待审批
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-52: 融合运行中把人指向澄清收件箱，答完之后详情页自己翻到待审批（不用刷新）', async ({
  page,
}) => {
  fusionAId = (
    await api<{ id: string }>('/api/fusions', {
      method: 'POST',
      body: JSON.stringify({
        skillId,
        memoryIds: [keepMemoryId],
        intent: 'RFC-319 review surface: consolidate the lint preferences',
      }),
    })
  ).id

  await openApp(page, `/fusions/${fusionAId}`)

  await expect(
    page.getByText(
      'The skill-merger agent is working. If it asks questions, answer them in Clarifications.',
      { exact: true },
    ),
    '运行中没有任何提示 ⇒ 页面一片空白，用户不知道该等还是该动手',
  ).toBeVisible()
  const clarifyLink = page.getByRole('link', { name: 'Open clarifications', exact: true })
  await expect(
    clarifyLink,
    'merger 节点是强制反问的，第一轮必然停在问题上；没有这条入口，用户在融合页干等，' +
      '而任务其实在等他回答，永远等不到',
  ).toBeVisible()
  await expect(clarifyLink).toHaveAttribute('href', '/clarify')
  await expect(
    page.getByRole('button', { name: 'Approve & apply', exact: true }),
    '还在跑就给出审批按钮 ⇒ 用户会去批准一份根本还不存在的提案',
  ).toHaveCount(0)

  // 从这里开始，本用例不允许发生任何导航 / 刷新——否则「自动进入待审批」证明不了轮询。
  await page.evaluate((key) => {
    const w = window as unknown as Record<string, number>
    w[key] = 1
  }, STAY_PUT_MARK)

  await answerFusionClarify(fusionAId)

  await expect(
    page.getByRole('heading', { name: 'Proposed change (current → proposed)' }),
    '详情页不轮询 ⇒ 融合早就跑到待审批，页面还停在「agent 正在工作」，' +
      '用户以为卡死了，转头去点取消，一轮真实的 agent 工作被白扔',
  ).toBeVisible({ timeout: 180_000 })
  await expect(page.getByRole('button', { name: 'Approve & apply', exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'The skill-merger agent is working. If it asks questions, answer them in Clarifications.',
      { exact: true },
    ),
    '已经待审批了还挂着「正在工作」 ⇒ 提示条与按钮互相打架',
  ).toHaveCount(0)

  const survived = await page.evaluate(
    (key) => (window as unknown as Record<string, number | undefined>)[key],
    STAY_PUT_MARK,
  )
  expect(
    survived,
    '这段中间发生过导航 / 刷新 ⇒ 上面那条断言证明的是「刷新之后能看到」，' +
      '而不是 INTENT-52 要的「自己轮询翻过去」',
  ).toBe(1)

  expect((await fusionOf(fusionAId)).status).toBe('awaiting_approval')
})

// ---------------------------------------------------------------------------
// INTENT-51 / INTENT-X9 —— 列表行、徽章计数、点行进详情
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-51 / INTENT-X9: 待审融合出现在记忆页「融合」页签，徽章与服务端计数一致，点行进得去详情', async ({
  page,
}) => {
  const pending = await api<{ count: number }>('/api/fusions/pending-count')
  expect(pending.count, '有一个融合在等审批，服务端却不计数 ⇒ 徽章永远不会亮').toBe(1)

  await openApp(page, '/memory?tab=fusion')

  const row = page.getByTestId(`memory-fusion-row-${fusionAId}`)
  await expect(
    row,
    '待审融合不进「融合」页签 ⇒ 它只剩一个没人记得住的 /fusions/:id 直链，等于丢了',
  ).toBeVisible()
  await expect(row).toContainText(SKILL_NAME)
  await expect(
    row,
    '行上不写清「审的是什么、几条记忆」 ⇒ 一排同名技能的行之间无从分辨',
  ).toContainText('Awaiting approval · 1 memories')
  await expect(
    page.getByTestId('memory-fusion-empty'),
    '有数据却同时显示空态 ⇒ 页面自相矛盾',
  ).toHaveCount(0)

  const badge = page.getByTestId('memory-section-fusion').locator('.page-section-nav__badge')
  await expect(
    badge,
    '徽章数与 /api/fusions/pending-count 对不上 ⇒ 这个数字错了不会有任何症状，' +
      '只是导航上多/少一个点，而用户就是照它决定要不要点进来',
  ).toHaveText(String(pending.count))

  await row.click()
  await page.waitForURL(new RegExp(`/fusions/${fusionAId}$`))
  await expect(
    page.getByRole('heading', { name: 'Changelog', exact: true }),
    '点了行没落到这次融合自己的详情页 ⇒ 列表只是个装饰',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// INTENT-55 —— 驳回：写反馈 → 带着反馈重跑下一轮
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-55: 驳回并写下反馈 → 融合带着反馈重跑下一轮（iteration+1），上一轮提案不再摆在审批位上', async ({
  page,
}) => {
  const before = await fusionOf(fusionAId)
  expect(before.status).toBe('awaiting_approval')
  expect(before.iteration).toBe(1)

  await openApp(page, `/fusions/${fusionAId}`)
  await page.getByRole('button', { name: 'Request changes', exact: true }).click()

  const submit = page.getByRole('button', { name: 'Send & re-run', exact: true })
  await expect(
    submit,
    '空反馈也能提交 ⇒ agent 一条修改指示都没拿到就又跑一轮，结果只会和上一轮一样',
  ).toBeDisabled()
  await page.getByPlaceholder('What should the agent change?').fill(REJECT_FEEDBACK)
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect
    .poll(async () => (await fusionOf(fusionAId)).iteration, { timeout: 120_000 })
    .toBe(before.iteration + 1)

  const after = await fusionOf(fusionAId)
  expect(after.status, '驳回之后融合没有重新跑起来 ⇒ 用户的反馈石沉大海').toBe('running')
  expect(after.decisionReason, '反馈没落库 ⇒ agent 拿不到「要改什么」，重跑等于重复上一轮').toBe(
    REJECT_FEEDBACK,
  )
  expect(after.currentTaskId, '重跑复用了上一轮那个已经结束的任务 ⇒ 新一轮根本没被执行').not.toBe(
    before.currentTaskId,
  )
  expect(
    after.changelog,
    '驳回没清掉上一轮的变更日志 ⇒ 页面把已经作废的结论继续摆着，用户会照它做判断',
  ).toBeNull()
  expect(after.incorporatedMemoryIds, '同上：已吸收清单必须随提案一起作废').toBeNull()

  await expect(page.getByText('Iteration 2', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Approve & apply', exact: true }),
    '重跑期间还留着审批按钮 ⇒ 用户可能批准一份自己刚刚否掉的提案',
  ).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: 'Changelog', exact: true }),
    '重跑期间还摆着上一轮的变更日志 ⇒ 同上',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// INTENT-56 —— 取消：二次确认 + 真的把引擎任务停下来
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-56: 取消要点两次——单击只是预备；确认之后连引擎任务一起停，服务端也不再接受审批', async ({
  page,
}) => {
  const running = await fusionOf(fusionAId)
  expect(running.status).toBe('running')
  const engineTaskId = running.currentTaskId
  expect(engineTaskId, '融合在跑却没有引擎任务 ⇒ 下面「取消把任务也停了」无从谈起').not.toBeNull()

  await openApp(page, `/fusions/${fusionAId}`)
  await page.getByRole('button', { name: 'Cancel fusion', exact: true }).click()

  // 立刻回读：ConfirmButton 只armed 4 秒，这一步必须抢在超时之前。
  const afterFirstClick = await fusionOf(fusionAId)
  expect(
    afterFirstClick.status,
    '单击就取消 ⇒ 二次确认形同虚设，一次误点直接丢掉一轮真实的 agent 工作',
  ).toBe('running')

  const armed = page.getByRole('button', { name: 'Cancel this fusion?', exact: true })
  await expect(armed, '按钮没有进入确认态 ⇒ 用户不知道自己按下去会发生什么').toBeVisible()
  await armed.click()

  await expect
    .poll(async () => (await fusionOf(fusionAId)).status, { timeout: 120_000 })
    .toBe('canceled')
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${engineTaskId}`)).status, {
      timeout: 120_000,
    })
    .toBe('canceled')

  await expect(
    page.locator('.chip--fusion-canceled'),
    '取消之后状态没翻 ⇒ 页面继续显示「运行中」，用户以为还在跑',
  ).toHaveText('Canceled')
  await expect(
    page.getByRole('button', { name: 'Cancel fusion', exact: true }),
    '终态还留着取消按钮 ⇒ 点了必然 409，只能让人怀疑是不是没取消成功',
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve & apply', exact: true })).toHaveCount(0)

  // 按钮消失不是唯一防线：服务端必须同口径拒绝。
  const refused = await req(`/api/fusions/${fusionAId}/approve`, { method: 'POST' })
  expect(refused.status, '已取消的融合还能被批准 ⇒ 取消只是 UI 上的错觉').toBe(409)
  expect(((await refused.json()) as { code?: string }).code).toBe('fusion-not-awaiting')
})

// ---------------------------------------------------------------------------
// INTENT-57 —— 失败态：摆出原因，且一个审批入口都不给
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-57: 融合失败时把失败原因摆在页面上，且不再提供任何审批入口', async ({
  page,
}) => {
  // 造一个**真实**的失败，不是 route 伪造的：
  // 审批期间把一条参与融合的记忆归档，再驳回重跑——重跑的 prompt 只带得动仍是
  // approved 的那条（services/fusion.ts:1560-1568），agent 的结果清单于是漏掉一条
  // 已选记忆，reconcile 按 D12「每条已选记忆必须被恰好交代一次」判失败
  // （services/fusion.ts:793-802）。这条路径本身就是产品里真会发生的事故。
  fusionBId = (
    await api<{ id: string }>('/api/fusions', {
      method: 'POST',
      body: JSON.stringify({
        skillId,
        memoryIds: [keepMemoryId, doomedMemoryId],
        intent: 'RFC-319 failed-state fixture',
      }),
    })
  ).id
  await answerFusionClarify(fusionBId)
  await waitForFusionStatus(fusionBId, 'awaiting_approval')

  await api(`/api/memories/${doomedMemoryId}/archive`, { method: 'POST' })
  await api(`/api/fusions/${fusionBId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ feedback: 'RFC-319: re-run after one selected memory was archived.' }),
  })
  await answerFusionClarify(fusionBId)
  await waitForFusionStatus(fusionBId, 'failed')

  const failed = await fusionOf(fusionBId)
  expect(
    failed.error,
    '失败了却没记下原因 ⇒ 页面只能显示一个空的错误区，用户和接手的人都得从头复现',
  ).toContain(doomedMemoryId)

  await openApp(page, `/fusions/${fusionBId}`)
  await expect(
    page.getByRole('heading', { name: 'Error', exact: true }),
    '失败态不摆出错误区 ⇒ 用户只看到一个什么都没有的页面，不知道发生了什么',
  ).toBeVisible()
  await expect(
    page.locator('pre.readonly-pre'),
    '错误区不写出到底哪条记忆没被交代 ⇒ 用户无从下手修',
  ).toContainText(doomedMemoryId)

  // 负向对照：失败态下三个动作入口一个都不许在 DOM 里。
  await expect(
    page.getByRole('button', { name: 'Approve & apply', exact: true }),
    '失败了还给审批按钮 ⇒ 用户对着一个注定 409 的按钮反复点，以为是自己网络不好',
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Request changes', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel fusion', exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: 'Changelog', exact: true }),
    '失败了还摆着变更日志 ⇒ 一份从未生效的结论被当成既成事实读',
  ).toHaveCount(0)

  const refused = await req(`/api/fusions/${fusionBId}/approve`, { method: 'POST' })
  expect(refused.status, '失败的融合还能被批准 ⇒ 一份没跑完的提案会被写进技能正文').toBe(409)
  expect(((await refused.json()) as { code?: string }).code).toBe('fusion-not-awaiting')
})
