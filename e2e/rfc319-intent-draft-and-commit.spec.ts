// RFC-319 —— 意图构建器「草稿 / 工作上下文 / 提交」能力簇的用户面 e2e。
//
// 覆盖能力账本行：INTENT-13b（P1）/ INTENT-24 / INTENT-26 / INTENT-28 /
// INTENT-31 / INTENT-32 / INTENT-33 / INTENT-40 / INTENT-42。此前这一整段
// 只有「一路顺风提交成功」被走过（e2e/intent-builder.spec.ts）：历史修订读不读得回、
// 工作上下文加/减、草稿大纲的选中语义、过期草稿、提交回执与失败原文、以及
// **提交响应丢失后的重试**，一条防护都没有。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//  INTENT-13b 「每一次成功运行都会产生一版不可变的候选」是产品对用户的明文承诺
//             （intent.iterationKeepsHistory）。它若只保住了**修订号**而没保住
//             **内容**（历史行被当前草稿覆盖 / 被就地改写 / 校验结论按当前上下文
//             重算），用户回头想比较「上一版到底提了什么、当时为什么不能提交」时，
//             看到的是被今天的状态污染过的假历史 —— 而这恰恰是他决定要不要回退的
//             唯一依据。修订号递增只是间接推论，锁不住这件事。
//  INTENT-24  空闲态挂资源的按钮叫「Save and generate」：它承诺**保存并直接开跑
//             下一轮**。若只保存不生成，用户对着一个没变化的界面等，永远等不到把
//             新资源纳入考虑的候选；反过来若生成了但上下文没真的进去，AI 拿到的
//             还是旧闭包，改了个寂寞。
//  INTENT-26  移除是**逐项勾选**的。勾错/勾多一格，用户下一轮就少了一份关键资源
//             （或多留了一份不该给 AI 看的），而界面不会有任何提示 —— 只有断言
//             「被勾的那个走了、没勾的那个还在」才分得出「删对了」与「全删了」。
//  INTENT-28  一个 changeset 常常一次提议多个资源。大纲若不能逐条选中、或选中项
//             的预览不跟着换资源类型（工作流该给画布、agent 该给正文 diff），
//             用户就只能对着一坨 JSON 决定要不要把这批改动落进库。
//  INTENT-31  过期草稿是**服务端必拒**的（intent-baseline-stale）。界面若不显形，
//             用户会对着一个永远提交不了的草稿反复点；显形了但不给下一步，
//             他同样出不去。
//  INTENT-32  候选历史是「我改到第几版、哪一版真落地了、哪一版是我自己丢的」的
//             唯一读数。四种生命周期若混成一种（典型退化：全显示 Superseded），
//             用户分不出「已提交」和「被顶掉」，回头找那一版落地的方案时无从下手。
//  INTENT-33  提交记录是**落地面**的回执：哪些资源真的进了库、是原地改的还是复制的
//             （fromCopy）。失败的那次若不留错误原文，用户既不知道被拒的原因，
//             也无从判断要不要重试。
//  INTENT-40  「提交按下去、响应没回来」是真实网络下的常态。此时服务端**可能已经
//             落库**。重试若换了幂等身份，第二次就是一次全新的 apply —— 轻则报个
//             用户看不懂的冲突，重则同一批资源落地两遍。这条是本文件最值钱的一格：
//             它要求造出「响应丢了但服务端已经落库」的真实局面，再从**库里**
//             （不是界面上）确认只落了一次。
//  INTENT-42  提交对话框里显示的是「我确认的那一版」。底层草稿换了版本还让对话框
//             挂着，用户按下的确认就指向了他没看过的内容。
//
// 判据取自（纯文本引用，勿改成外链）：
//   packages/frontend/src/routes/intent.detail.tsx:229          draftIdentity = `${id}:${draftHash}`
//   packages/frontend/src/routes/intent.detail.tsx:238-252      提交对话框的身份守卫（identity 变 ⇒ 自动关闭）
//   packages/frontend/src/routes/intent.detail.tsx:260-271      选中 op 的初值（有阻断错误优先，否则第一条）
//   packages/frontend/src/routes/intent.detail.tsx:355-419      工作上下文条：计数 chip / 已挂载 chips / 管理入口
//   packages/frontend/src/routes/intent.detail.tsx:318-327      Rebase 按钮（仅 journey.reason === 'draft-stale'）
//   packages/frontend/src/routes/intent.detail.tsx:645-649      Stale chip + 过期横幅
//   packages/frontend/src/routes/intent.detail.tsx:660-727      op 大纲 + 选中项富预览卡
//   packages/frontend/src/routes/intent.detail.tsx:757-767      Commit 入口禁用条件与文案
//   packages/frontend/src/routes/intent.detail.tsx:774-812      提交记录列表（回执 / fromCopy / 错误原文）
//   packages/frontend/src/routes/intent.detail.tsx:814-844      候选历史列表与四种生命周期
//   packages/frontend/src/routes/intent.detail.tsx:1287-1295    clientMutationId 每次「打开对话框」铸一次
//   packages/frontend/src/components/IntentMountDialog.tsx:150-178  空闲 ⇒ Save and generate；运行中 ⇒ 排队/打断
//   packages/frontend/src/components/IntentMountDialog.tsx:186-207  已挂载项的移除勾选
//   packages/frontend/src/components/intent/IntentOpPreview.tsx:121-140 按资源类型分派预览
//   packages/backend/src/routes/intentSessions.ts:355-387       历史草稿逐行读**存下来的** changeset / validation
//   packages/backend/src/services/intent/turnEngine.ts:420-460  新修订 = 新行 + 旧行落 superseded
//   packages/backend/src/services/intent/iteration.ts:284-292   regenerate ⇒ 旧行落 discarded
//   packages/backend/src/services/intent/applyChangeset.ts:362-373 clientMutationId 命中 ⇒ 重放
//   packages/backend/src/services/intent/applyChangeset.ts:443-455 committed ⇒ 回放原 receipt
//   packages/backend/src/services/intent/applyChangeset.ts:481-495 失败落 `code: message` 到 journal.error
//   packages/backend/src/services/intent/applyChangeset.ts:1145-1160 commit ⇒ epoch+1、currentDraftId 清空
//   packages/backend/src/services/intent/journey.ts:48-52       currentDraft 的 epoch 不等 ⇒ draft-stale
//   packages/backend/src/services/intent/resolveChangeset.ts:144-148 未挂载目标 ⇒ 阻断性错误
//   packages/backend/src/services/intent/workingSet.ts:449-560  空闲提交 ⇒ 立即 activate + 起一轮
//   packages/backend/src/services/intent/session.ts:818-884     POST /mounts：推进纪元、**不**起新轮次
//
// 故障注入一律走请求层（page.route）且只 fulfill / continue / abort，
// 绝不 `route.fetch()`（见 docs/dev-gotchas.md 的两把锁）；要回源的真实响应
// 一律在 Node 侧用本文件自己的 `api()` 打。

import { expect, test, type Locator, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

/** 默认（create-agent）变体：一条 create op，提议名固定 `e2e-auditor`。 */
let daemon: DaemonHandle
/** workflow 变体：一次两条 op（agent + workflow），op 大纲才有第二行可点。 */
let workflowDaemon: DaemonHandle
/** update 变体：唯一能造出「目标未挂载 ⇒ 阻断性错误」与 fromCopy 的变体。 */
let updateDaemon: DaemonHandle
let sequence = 0

interface AgentRow {
  id: string
  name: string
  description: string
}

interface DraftDto {
  id: string
  revision: number
  draftHash: string
  contextRevision: number
  createdAt: number
  stale: boolean
  lifecycle: 'current' | 'committed' | 'discarded' | 'superseded'
  validation: { errors: string[] }
  changeset: unknown
}

interface CommitDto {
  journalId: string
  draftId: string
  state: 'prepared' | 'applying' | 'committed' | 'failed'
  receipt: null | {
    journalId: string
    commitSeq: number
    applied: Array<{ opId: string; resourceType: string; name: string; fromCopy: boolean }>
  }
  error: string | null
}

interface SessionDetail {
  session: {
    id: string
    turnSeq: number
    commitSeq: number
    contextRevision: number
    inFlight: boolean
    journey: { reason: string }
  }
  mounts: Array<{
    handle: string
    resourceType: string
    resourceId: string
    displayName: string | null
  }>
  workingSetChange: null | { id: string; state: string; resultingContextRevision: number | null }
  currentDraft: DraftDto | null
  drafts: DraftDto[]
  commits: CommitDto[]
}

async function api<T>(target: DaemonHandle, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${target.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return (body === '' ? undefined : JSON.parse(body)) as T
}

const detailOf = (target: DaemonHandle, sessionId: string): Promise<SessionDetail> =>
  api<SessionDetail>(target, `/api/intent-sessions/${sessionId}`)

const listAgents = (target: DaemonHandle): Promise<AgentRow[]> =>
  api<AgentRow[]>(target, '/api/agents')

async function seedAgent(
  target: DaemonHandle,
  name: string,
  description: string,
): Promise<AgentRow> {
  return api<AgentRow>(target, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({ name, description, outputs: ['answer'], bodyMd: 'Seeded body.' }),
  })
}

test.beforeAll(async () => {
  ;[daemon, workflowDaemon, updateDaemon] = await Promise.all([
    startDaemon({ stubMode: 'intent' }),
    startDaemon({ stubMode: 'intent', extraEnv: { STUB_INTENT_VARIANT: 'workflow' } }),
    startDaemon({ stubMode: 'intent', extraEnv: { STUB_INTENT_VARIANT: 'update' } }),
  ])
})

test.afterAll(async () => {
  await Promise.all(
    [daemon, workflowDaemon, updateDaemon].filter((d) => d !== undefined).map((d) => d.stop()),
  )
})

async function authPage(page: Page, target: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [target.baseUrl, target.token] as const,
  )
}

/** 从 /intent 的行内输入框起一个会话，等到草稿面板出现；返回会话 id。 */
async function createSessionAndAwaitDraft(
  page: Page,
  target: DaemonHandle,
  message: string,
): Promise<string> {
  await page.goto(`${target.baseUrl}/intent`)
  const composer = page.getByTestId('intent-create-inline')
  await composer.getByTestId('intent-create-message').fill(message)
  await composer.getByRole('button', { name: 'Start building' }).click()
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
  await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 90_000 })
  const id = /\/intent\/([0-9A-Z]+)/i.exec(page.url())?.[1]
  expect(id, `会话 id 未能从 URL 解析：${page.url()}`).toBeTruthy()
  return id as string
}

/** 从资源详情页的「Modify via intent」入口起会话——它把目标预挂载进新会话。 */
async function createUpdateSessionAndAwaitDraft(page: Page, target: AgentRow): Promise<string> {
  await page.goto(`${updateDaemon.baseUrl}/agents/${target.id}`)
  await page.getByTestId('agent-intent-entry').click()
  await page.waitForURL(/\/intent\?/)
  const dialog = page.getByRole('dialog')
  await dialog
    .getByTestId('intent-create-dialog')
    .getByTestId('intent-create-message')
    .fill(`rework rfc319-target:${target.name}`)
  await dialog.getByRole('button', { name: 'Start building' }).click()
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
  await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 90_000 })
  return /\/intent\/([0-9A-Z]+)/i.exec(page.url())?.[1] as string
}

const draftRevisionHeading = (page: Page, revision: number): Locator =>
  page.getByRole('heading', { name: `Draft changeset (revision ${revision})` })

/** 打开提交向导并停在第 1 步（明细）。 */
async function openCommitToDetails(page: Page): Promise<Locator> {
  await page.getByTestId('intent-open-commit').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Strategy')
  await page.getByTestId('intent-commit-next').click()
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Details')
  return dialog
}

/**
 * 打开提交向导，在第 0 步（策略）选「复制一份」，停在第 1 步（明细）。
 *
 * 「原地修改 vs 复制一份」这一步只在 changeset 里有 update 操作时才渲染
 * （intent.detail.tsx:1444-1466），所以这个 helper 只对 update 变体有意义。
 */
async function openCommitToCopyStrategy(page: Page): Promise<Locator> {
  await page.getByTestId('intent-open-commit').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Strategy')
  // Segmented 渲染成 role=radiogroup / role=radio（components/Segmented.tsx）。
  await dialog.getByRole('radio', { name: 'Create copy', exact: true }).click()
  await page.getByTestId('intent-commit-next').click()
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Details')
  return dialog
}

/**
 * 在工作上下文弹窗里勾一个资源。
 *
 * 用 `click()` 而不是 `focus()` 打开下拉：Esc 关掉下拉后输入框**仍持有焦点**，
 * 再 `focus()` 不会重新触发 onFocus，下拉打不开——MultiSelect 正是为此在字段上
 * 单挂了一个 onMouseDown 重开（components/MultiSelect.tsx:240-248）。连挑两个资源时
 * 这个差别就是「第二次找不到 option」。
 *
 * 关掉下拉后弹窗要把刚选中的挂载渲染成 chip，这次重渲染会把底部按钮从 DOM 上摘下来
 * 重挂——先等 chip 出现再动下一步，是真同步点而不是 sleep。
 */
async function pickMount(page: Page, dialog: Locator, nameRe: RegExp): Promise<void> {
  const picker = dialog.getByTestId('intent-mount-picker')
  await picker.click()
  await expect(picker).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('option', { name: nameRe }).click()
  await picker.press('Escape')
  await expect(dialog.locator('.multi-select .chip').filter({ hasText: nameRe })).toBeVisible({
    timeout: 15_000,
  })
}

/** 工作上下文条上「已挂载 N 个」的读数 chip。 */
const mountCountChip = (page: Page): Locator =>
  page.locator('.intent-working-context-bar__title-row .status-chip')

/** 「不可变」的那几格：detail 逐行**读存下来的列**，不随会话当前状态变化。 */
function immutableDraftFields(draft: DraftDto): Record<string, unknown> {
  return {
    id: draft.id,
    revision: draft.revision,
    draftHash: draft.draftHash,
    contextRevision: draft.contextRevision,
    createdAt: draft.createdAt,
    changeset: draft.changeset,
    validation: draft.validation,
  }
}

// ---------------------------------------------------------------------------
// INTENT-13b（P1 —— 进 PR 腿，不带 @nightly）
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-13b: 迭代之后每一版历史修订的内容仍能原样读回——changeset 与当时的校验结论逐字保留', async ({
  page,
}) => {
  await authPage(page, updateDaemon)
  const targetName = `rfc319-hist-${++sequence}`
  await seedAgent(updateDaemon, targetName, 'original description')

  // ── 修订 1：目标只在清单里可见、**未挂载** ⇒ 服务端把这一版判为有阻断性错误 ──
  //
  // 走 update 变体是为了让两版**内容真的不同**：默认变体每轮产出同一份 create
  // changeset，那样「第 1 版还在」和「把当前版复制成历史」看起来一模一样，
  // 断言就分辨不出退化。这里第 1 版带着 intent-target-not-mounted，第 2 版是干净的。
  const sessionId = await createSessionAndAwaitDraft(
    page,
    updateDaemon,
    `rework rfc319-target:${targetName}`,
  )
  await expect(draftRevisionHeading(page, 1)).toBeVisible()

  const v1 = (await detailOf(updateDaemon, sessionId)).drafts.find((d) => d.revision === 1)
  expect(v1, '第 1 版草稿没落库').toBeTruthy()
  expect(
    (v1 as DraftDto).validation.errors.join('\n'),
    '第 1 版本该带着「目标未挂载」的阻断性错误——它是本用例区分两版内容的唯一凭据',
  ).toContain('intent-target-not-mounted')
  const v1Snapshot = immutableDraftFields(v1 as DraftDto)

  // ── 修订 2：把目标挂进工作上下文，同一条 update 操作因此合法 ──
  await page.getByTestId('intent-add-mount').click()
  const mountDialog = page.getByRole('dialog')
  await pickMount(page, mountDialog, new RegExp(targetName))
  await mountDialog.getByTestId('intent-working-context-submit').click()
  await expect(draftRevisionHeading(page, 2)).toBeVisible({ timeout: 90_000 })

  const afterSecond = await detailOf(updateDaemon, sessionId)
  const v2 = afterSecond.drafts.find((d) => d.revision === 2) as DraftDto
  expect(
    v2.validation.errors,
    '目标挂上之后第 2 版仍报错 ⇒ 两版内容并没有真的分叉，后面的对账测不出东西',
  ).toEqual([])
  const v2Snapshot = immutableDraftFields(v2)

  // 关键：第 1 版**当时**的结论必须原样还在，而不是按今天的上下文重算。
  // 这条不成立 ⇒ 历史是假的：用户回头看「上一版为什么不能提交」，看到的是一片干净。
  const keptV1 = afterSecond.drafts.find((d) => d.id === v1Snapshot.id) as DraftDto | undefined
  expect(keptV1, '迭代一轮之后第 1 版整行不见了 ⇒ 历史修订根本没保留').toBeTruthy()
  expect(
    immutableDraftFields(keptV1 as DraftDto),
    '第 1 版的内容被改写了 ⇒ 「每次运行产生一版不可变候选」这句承诺是假的',
  ).toEqual(v1Snapshot)
  expect(
    (keptV1 as DraftDto).lifecycle,
    '被顶掉的那一版没标成 superseded ⇒ 用户分不出哪一版是当前的',
  ).toBe('superseded')

  // ── 修订 3：再迭代一次（用产品自己的 composer），两版历史都必须原封不动 ──
  await page.getByTestId('intent-composer').fill('Tighten the proposed body a bit more.')
  await page.getByTestId('intent-composer-submit').click()
  await expect(draftRevisionHeading(page, 3)).toBeVisible({ timeout: 90_000 })

  const afterThird = await detailOf(updateDaemon, sessionId)
  expect(
    afterThird.drafts.map((d) => d.revision),
    '三轮之后历史不是「3 / 2 / 1 各一行、按修订号倒序」',
  ).toEqual([3, 2, 1])
  expect(
    immutableDraftFields(afterThird.drafts.find((d) => d.id === v1Snapshot.id) as DraftDto),
    '第 3 轮之后第 1 版的内容被改写了',
  ).toEqual(v1Snapshot)
  expect(
    immutableDraftFields(afterThird.drafts.find((d) => d.id === v2Snapshot.id) as DraftDto),
    '第 3 轮之后第 2 版的内容被改写了',
  ).toEqual(v2Snapshot)
  // 负向对照：三行的身份/内容**互不相同**——否则上面的 toEqual 可能只是
  // 「三行长得都一样」的巧合。
  expect(new Set(afterThird.drafts.map((d) => d.id)).size, '三版共用了同一个草稿 id').toBe(3)
  expect(
    afterThird.drafts.find((d) => d.revision === 3)?.validation.errors,
    '最新一版本该是干净的',
  ).toEqual([])

  // 用户面：候选历史把三版都列出来（内容读回目前只在详情载荷里，界面不提供逐版查看）。
  const history = page.locator('.intent-session__draft-history ol > li')
  await expect(history, '界面上的候选历史没有把三版都列出来').toHaveCount(3)
  await expect(history.nth(2)).toContainText('Draft changeset (revision 1)')
})

// ---------------------------------------------------------------------------
// INTENT-24
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-24: 空闲态用「Save and generate」保存工作上下文，同一步就把下一轮跑起来 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  const mountName = `rfc319-ws-idle-${++sequence}`
  const mounted = await seedAgent(daemon, mountName, 'context for the next turn')

  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')
  await expect(draftRevisionHeading(page, 1)).toBeVisible()
  await expect(mountCountChip(page), '新会话的工作上下文本该是空的').toHaveText('0 mounted')
  await expect(page.getByText('No resources mounted yet')).toBeVisible()

  await page.getByTestId('intent-add-mount').click()
  const dialog = page.getByRole('dialog')

  // 空闲态**只有**一颗主按钮。运行中那两颗（排队 / 打断）此刻出现的话，用户会
  // 以为有一轮在跑，从而去点「停止当前轮次」——那会取消一个根本不存在的东西。
  const submit = dialog.getByTestId('intent-working-context-submit')
  await expect(submit, '空闲态的主按钮不是「保存并生成」').toHaveText('Save and generate')
  await expect(
    dialog.getByRole('button', { name: 'Refresh after this turn' }),
    '空闲态还给「排队到下一轮」⇒ 界面在描述一个不存在的运行中轮次',
  ).toHaveCount(0)
  await expect(
    dialog.getByRole('button', { name: 'Stop turn and refresh now' }),
    '空闲态还给「停止当前轮次」⇒ 同上',
  ).toHaveCount(0)
  await expect(submit, '什么都没选就能保存 ⇒ 白跑一轮 agent').toBeDisabled()

  await pickMount(page, dialog, new RegExp(mountName))
  await expect(
    dialog.getByText('1 to add · 0 to remove'),
    '不告诉用户这次到底要加几个减几个 ⇒ 他按下保存前无从复核',
  ).toBeVisible()
  await expect(submit, '选好了还不让保存').toBeEnabled()
  await submit.click()

  // ① 保存：资源真的进了工作上下文（下一轮 AI 能看到它）。
  await expect(page.getByRole('dialog'), '保存后弹窗没关').toHaveCount(0)
  await expect(mountCountChip(page), '保存后计数没变 ⇒ 挂载根本没落库').toHaveText('1 mounted', {
    timeout: 60_000,
  })
  await expect(
    page.locator('.intent-working-context-chip', { hasText: mountName }),
    '计数变了但列不出是哪一个 ⇒ 用户不知道 AI 现在能看见什么',
  ).toBeVisible()

  // ② 生成：按钮名里的 "and generate" 必须兑现——新一版候选跑出来。
  //    这条不成立 ⇒ 用户挂完资源对着旧候选干等，还得自己再想办法催一轮。
  await expect(
    draftRevisionHeading(page, 2),
    '保存了却没有开跑下一轮 ⇒「Save and generate」只兑现了一半',
  ).toBeVisible({ timeout: 90_000 })
  // 对话里要留下一条「为什么会有这一轮」的记录，否则时间线上凭空多出一轮。
  await expect(
    page.getByText('Working context refreshed: 1 added, 0 removed', { exact: false }),
  ).toBeVisible()

  // ③ 服务端真值：纪元推进了一格，变更单以 applied 收场并指向新纪元。
  const detail = await detailOf(daemon, sessionId)
  expect(detail.session.contextRevision, '挂载没有推进上下文纪元 ⇒ 旧草稿不会被判过期').toBe(1)
  expect(detail.workingSetChange?.state, '工作上下文变更单没有落到 applied').toBe('applied')
  expect(detail.workingSetChange?.resultingContextRevision).toBe(1)
  expect(
    detail.mounts.map((m) => m.resourceId),
    '会话挂载清单里没有刚挂上的资源 ⇒ AI 下一轮拿到的还是旧闭包',
  ).toEqual([mounted.id])
  expect(detail.drafts.map((d) => d.revision)).toEqual([2, 1])
})

// ---------------------------------------------------------------------------
// INTENT-26
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-26: 勾选移除后保存，只有被勾的那个离开工作上下文，没勾的原样留下 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  const keepName = `rfc319-ws-keep-${++sequence}`
  const dropName = `rfc319-ws-drop-${++sequence}`
  const keep = await seedAgent(daemon, keepName, 'must survive the removal')
  const drop = await seedAgent(daemon, dropName, 'must be removed')

  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  // 先把两个都挂上（一次保存，两条 addition）。
  await page.getByTestId('intent-add-mount').click()
  let dialog = page.getByRole('dialog')
  await pickMount(page, dialog, new RegExp(keepName))
  await pickMount(page, dialog, new RegExp(dropName))
  await expect(dialog.getByText('2 to add · 0 to remove')).toBeVisible()
  await dialog.getByTestId('intent-working-context-submit').click()
  await expect(mountCountChip(page)).toHaveText('2 mounted', { timeout: 60_000 })
  await expect(draftRevisionHeading(page, 2)).toBeVisible({ timeout: 90_000 })

  // ── 移除：逐项勾选，只勾一个 ──
  await page.getByTestId('intent-add-mount').click()
  dialog = page.getByRole('dialog')
  await expect(
    dialog.getByText('Checked resources will be removed when you save.'),
    '不说明勾选的含义 ⇒ 用户以为勾的是「保留这些」，一勾就把该留的删了',
  ).toBeVisible()
  const dropBox = dialog.getByRole('checkbox', { name: new RegExp(dropName) })
  const keepBox = dialog.getByRole('checkbox', { name: new RegExp(keepName) })
  await expect(dropBox, '打开时就预勾上 ⇒ 用户随手一保存就丢资源').not.toBeChecked()
  await expect(keepBox).not.toBeChecked()

  await dropBox.check()
  await expect(keepBox, '勾一个却把两个都勾上了 ⇒ 逐项勾选形同虚设').not.toBeChecked()
  await expect(
    dialog.getByText('0 to add · 1 to remove'),
    '摘要没如实反映「这次只减一个」',
  ).toBeVisible()
  await dialog.getByTestId('intent-working-context-submit').click()

  // ── 落地面：被勾的走了，没勾的还在 ──
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(mountCountChip(page), '移除后计数没减 ⇒ 勾选没生效').toHaveText('1 mounted', {
    timeout: 60_000,
  })
  await expect(
    page.locator('.intent-working-context-chip', { hasText: dropName }),
    '被勾掉的资源还挂在上面 ⇒ 用户以为已经把它从 AI 视野里拿走了，其实没有',
  ).toHaveCount(0)
  await expect(
    page.locator('.intent-working-context-chip', { hasText: keepName }),
    '没勾的那个也被顺手删了 ⇒ 下一轮 AI 少了一份关键资源，而界面不会说',
  ).toBeVisible()

  const detail = await detailOf(daemon, sessionId)
  expect(
    detail.mounts.map((m) => m.resourceId),
    '服务端挂载清单与界面对不上',
  ).toEqual([keep.id])
  expect(detail.mounts.some((m) => m.resourceId === drop.id)).toBe(false)
  expect(detail.session.contextRevision, '两次工作上下文改动本该各推进一格纪元').toBe(2)
  // 移除同样是「保存并生成」：这一步也必须真的跑出新一版。
  await expect(draftRevisionHeading(page, 3)).toBeVisible({ timeout: 90_000 })
})

// ---------------------------------------------------------------------------
// INTENT-28
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-28: 草稿 op 大纲逐条可选，选中项换成对应资源类型的富预览 @nightly', async ({
  page,
}) => {
  await authPage(page, workflowDaemon)
  await createSessionAndAwaitDraft(page, workflowDaemon, 'build a request-to-worker workflow')

  const outline = page.getByTestId('intent-op-outline-item')
  await expect(outline, '两条 op 的草稿只列出一条 ⇒ 有改动在用户视野外落进库').toHaveCount(2)

  // 大纲每一行要自报「做什么（Create/Update）· 叫什么 · 是什么类型」——三者缺一，
  // 用户都没法在不点开的情况下判断这批改动的范围。
  await expect(outline.nth(0)).toContainText('Create')
  await expect(outline.nth(0).locator('strong')).toHaveText('e2e-workflow-worker')
  await expect(outline.nth(0).locator('.intent-session__op-outline-meta')).toHaveText('Agent')
  await expect(outline.nth(1).locator('strong')).toHaveText('e2e-workflow-preview')
  await expect(outline.nth(1).locator('.intent-session__op-outline-meta')).toHaveText('Workflow')

  // 初值：无阻断错误时落在第一条，且**选中态是可见的**（aria-current + 高亮类）。
  // 不显形 ⇒ 用户不知道右边那张卡讲的是哪一条。
  await expect(outline.nth(0), '没有任何一条被标成当前项').toHaveAttribute('aria-current', 'true')
  await expect(outline.nth(0)).toHaveClass(/intent-session__op-outline-item--active/)
  await expect(outline.nth(1)).not.toHaveAttribute('aria-current', 'true')

  const card = page.getByTestId('intent-op-card')
  await expect(card, '选中的是 agent，卡片抬头却不是它').toContainText('Agent')
  await expect(card).toContainText('e2e-workflow-worker')
  await expect(
    page.getByTestId('intent-preview-agent'),
    'agent 操作没给字段/正文预览 ⇒ 用户只能读原始 JSON 决定要不要落库',
  ).toBeVisible()
  await expect(
    page.getByTestId('intent-preview-workflow'),
    '选中 agent 却渲染出工作流画布 ⇒ 预览没跟着选中项走',
  ).toHaveCount(0)

  // 换一条：预览必须整块换成工作流那一套（画布 + 节点/连线读数）。
  await outline.nth(1).click()
  await expect(outline.nth(1)).toHaveAttribute('aria-current', 'true')
  await expect(outline.nth(0), '点了第二条，第一条仍标着当前项 ⇒ 两条同时高亮').not.toHaveAttribute(
    'aria-current',
    'true',
  )
  await expect(card).toContainText('Workflow')
  await expect(card).toContainText('e2e-workflow-preview')
  const workflowPreview = page.getByTestId('intent-preview-workflow')
  await expect(workflowPreview, '工作流操作不给图 ⇒ 提交前没人能看出这张图连成什么样').toBeVisible()
  await expect(
    workflowPreview,
    '图的规模读数不对 ⇒ 用户无法一眼判断这次提议了多大一张图',
  ).toContainText('3 nodes')
  await expect(workflowPreview).toContainText('2 edges')
  await expect(page.getByTestId('intent-preview-canvas').locator('.react-flow__node')).toHaveCount(
    3,
  )
  await expect(
    page.getByTestId('intent-preview-agent'),
    '换到工作流后 agent 预览还留着 ⇒ 一张卡上叠了两个资源',
  ).toHaveCount(0)

  // 富预览是**镜头**不是替代品：精确载荷必须始终够得着。
  const raw = card.locator('details', { hasText: 'Raw JSON' })
  await raw.locator('summary').click()
  await expect(
    raw.locator('pre'),
    '原始载荷读不到 ⇒ 预览没覆盖到的字段（谁也说不清有多少）就成了盲区',
  ).toContainText('"e2e-workflow-preview"')

  // 切回第一条：选中态可以来回走，不是一次性的。
  await outline.nth(0).click()
  await expect(page.getByTestId('intent-preview-agent')).toBeVisible()
  await expect(page.getByTestId('intent-preview-workflow')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// INTENT-31
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-31: 别处改动工作上下文后草稿转过期——横幅显形、提交入口锁死、Rebase 推进纪元 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  const otherName = `rfc319-stale-${++sequence}`
  const other = await seedAgent(daemon, otherName, 'mounted by another writer')

  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')
  const before = await detailOf(daemon, sessionId)
  expect(before.session.contextRevision).toBe(0)
  expect(before.currentDraft?.stale, '刚生成的草稿不该是过期的').toBe(false)

  // 负向对照：过期前这三个信号必须全部缺席，否则它们是常显的，下面全恒真。
  await expect(
    page.locator('.intent-session__draft .status-chip', { hasText: 'Stale' }),
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Rebase' })).toHaveCount(0)
  await expect(page.getByTestId('intent-open-commit')).toBeEnabled()

  // ── 另一个写者（另一个标签页 / 脚本）把一个资源挂进了这个会话 ──
  //    POST /mounts 推进纪元但**不**起新轮次，于是当前草稿原地变成过期
  //    （services/intent/session.ts:818-884）。
  await api(daemon, `/api/intent-sessions/${sessionId}/mounts`, {
    method: 'POST',
    body: JSON.stringify({ resourceType: 'agent', resourceId: other.id }),
  })

  // 页面靠 WS 自己发现（用户没有刷新）。
  const staleChip = page.locator('.intent-session__draft .status-chip', { hasText: 'Stale' })
  await expect(
    staleChip,
    '上下文变了草稿却不标过期 ⇒ 用户对着一个服务端必拒的草稿反复点提交',
  ).toBeVisible({ timeout: 60_000 })
  await expect(staleChip, '过期没用警示色，读起来只是个普通标签').toHaveClass(/status-chip--warn/)
  // tone=warning 的 NoticeBanner 拿的是 role=status（只有 tone=error 才是 alert，
  // NoticeBanner.tsx:100-105），所以这里按告警底色定位，再逐句核对文案。
  const notice = page.locator('.notice-banner--warning').filter({
    hasText: 'The session context moved',
  })
  await expect(notice, '只挂个小标签不给解释 ⇒ 用户不知道发生了什么、该怎么办').toBeVisible()
  await expect(
    notice,
    '解释里没说清「现在提交不了」和「怎么往下走」⇒ 用户只知道出事了，不知道该干什么',
  ).toContainText('this draft cannot commit')

  // 提交入口锁死，并且说明为什么锁——只禁用不解释，用户会以为界面坏了。
  await expect(
    page.getByTestId('intent-open-commit'),
    '过期草稿仍可打开提交向导 ⇒ 用户走完三步才在最后一刻被服务端打回',
  ).toBeDisabled()
  await expect(
    page.getByText('Refresh the draft baseline before opening commit review.'),
  ).toBeVisible()

  // 服务端真值：禁用只是第一道门，绕过前端直接打 API 同样必须被拒。
  const staleDraft = (await detailOf(daemon, sessionId)).currentDraft as DraftDto
  expect(staleDraft.stale, '服务端并不认为它过期 ⇒ 界面与服务端各说各话').toBe(true)
  const rejected = await fetch(`${daemon.baseUrl}/api/intent-sessions/${sessionId}/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMutationId: `rfc319-intent31-commit-${Date.now()}`,
      draftRevision: staleDraft.revision,
      draftHash: staleDraft.draftHash,
      decisions: [],
    }),
  })
  expect(rejected.status).toBe(409)
  expect(((await rejected.json()) as { code: string }).code).toBe('intent-baseline-stale')

  // ── Rebase：重建上下文纪元 ──
  //
  // 它是这一态**唯一**出现的行动按钮。按下去必须真的推进纪元——不然它就是个
  // 什么都不做的装饰，用户点完仍卡在原地。
  const rebase = page.getByRole('button', { name: 'Rebase' })
  await expect(rebase, '过期态不给任何行动入口 ⇒ 用户被困在这一屏').toBeVisible()
  await expect(rebase).toBeEnabled()
  await rebase.click()
  await expect
    .poll(async () => (await detailOf(daemon, sessionId)).session.contextRevision, {
      timeout: 30_000,
      message: 'Rebase 没有推进上下文纪元 ⇒ 这颗按钮什么都没做',
    })
    .toBe(2)

  // ── 出路：改一次工作上下文 = 保存并生成，新一版落在新纪元上、不再过期 ──
  //    这同时是「上面那些过期信号不是常显」的负向对照。
  //
  //    先刷新：保存工作上下文带 expectedContextRevision 的乐观锁
  //    （workingSet.ts:486-494），刚刚 Rebase 把纪元推到了 2，页面手里那份必须是
  //    最新的才提交得上去。用户在这一态本来就会刷一下页面。
  await page.reload()
  await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('intent-add-mount').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: new RegExp(otherName) }).check()
  await dialog.getByTestId('intent-working-context-submit').click()
  await expect(draftRevisionHeading(page, 2)).toBeVisible({ timeout: 90_000 })
  await expect(staleChip, '新一版仍被判过期 ⇒ 这条会话再也提交不了了').toHaveCount(0)
  await expect(notice).toHaveCount(0)
  await expect(page.getByTestId('intent-open-commit')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Rebase' })).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// INTENT-32
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-32: 候选历史逐版列出四种生命周期（current / committed / discarded / superseded） @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  const landedName = `rfc319-intent32-${++sequence}`
  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  // v1 → 迭代 → v2（v1 被顶掉 = superseded）
  await page.getByTestId('intent-composer').fill('Make the candidate stricter.')
  await page.getByTestId('intent-composer-submit').click()
  await expect(draftRevisionHeading(page, 2)).toBeVisible({ timeout: 90_000 })

  // v2 → 丢弃重生成 → v3（v2 是用户**主动丢**的 = discarded，与被顶掉不同）
  await page.getByTestId('intent-regenerate-draft').click()
  await expect(draftRevisionHeading(page, 3)).toBeVisible({ timeout: 90_000 })

  // v3 → 提交（= committed）。stub 固定提议 e2e-auditor，改名以免与同 daemon 的
  // 其他用例撞 intent-name-conflict。
  const dialog = await openCommitToDetails(page)
  await dialog.getByPlaceholder('New name').fill(landedName)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  await expect(page.getByText('Continuing from checkpoint #1', { exact: true })).toBeVisible({
    timeout: 90_000,
  })

  // 从检查点继续 → v4（= current）
  await page.getByTestId('intent-composer').fill('Continue beyond the committed checkpoint.')
  await page.getByTestId('intent-composer-submit').click()
  await expect(draftRevisionHeading(page, 4)).toBeVisible({ timeout: 90_000 })

  const history = page.locator('.intent-session__draft-history ol > li')
  await expect(history, '候选历史没把四版都留下 ⇒ 用户改到第几版、丢过哪几版全无从查').toHaveCount(
    4,
  )
  await expect(
    page.locator('.intent-session__draft-history .intent-session__section-header .status-chip'),
    '历史标题上的条数读数与列表对不上',
  ).toHaveText('4')

  // 逐版对账：倒序（最新在上），四种生命周期各一格 + 各自的语义色。
  // 全混成一种（典型退化：一律 Superseded）⇒ 用户分不出「已落地」和「被顶掉」，
  // 回头想找那一版真正入库的方案时无从下手。
  const expected: Array<[number, string, RegExp]> = [
    [4, 'Current', /status-chip--info/],
    [3, 'Committed', /status-chip--success/],
    [2, 'Discarded', /status-chip--warn/],
    [1, 'Superseded', /status-chip--neutral/],
  ]
  for (const [index, [revision, label, tone]] of expected.entries()) {
    const row = history.nth(index)
    await expect(row, `候选历史第 ${index + 1} 行不是修订 ${revision}`).toContainText(
      `Draft changeset (revision ${revision})`,
    )
    await expect(
      row.locator('.status-chip'),
      `修订 ${revision} 的生命周期读数不是 ${label}`,
    ).toHaveText(label)
    await expect(row.locator('.status-chip'), `${label} 没有自己的语义色`).toHaveClass(tone)
  }

  // 服务端真值：界面读数来自 detail 的逐行投影，两边必须一致。
  const detail = await detailOf(daemon, sessionId)
  expect(
    detail.drafts.map((d) => [d.revision, d.lifecycle]),
    '服务端的生命周期投影与界面对不上',
  ).toEqual([
    [4, 'current'],
    [3, 'committed'],
    [2, 'discarded'],
    [1, 'superseded'],
  ])
  expect(
    (await listAgents(daemon)).filter((row) => row.name === landedName),
    '标成 committed 的那一版并没有真的落地',
  ).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// INTENT-33
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-33: 提交记录既给成功回执（落地了什么、是不是复制）也留下失败提交的错误原文 @nightly', async ({
  page,
}) => {
  await authPage(page, updateDaemon)
  const targetName = `rfc319-intent33-${++sequence}`
  const target = await seedAgent(updateDaemon, targetName, 'original description')
  const sessionId = await createUpdateSessionAndAwaitDraft(page, target)

  await expect(
    page.locator('.intent-session__commits'),
    '一次都没提交过就先摆出提交记录区 ⇒ 空区块只会让用户以为漏读了什么',
  ).toHaveCount(0)

  // ── ① 失败的一次：选「复制一份」但不改名 ⇒ 与原件重名，服务端拒收 ──
  let dialog = await openCommitToCopyStrategy(page)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 60_000 })

  // 失败不走 WS 广播（服务端在抛错前就退出了那条路径），用户看到提交记录的路径
  // 就是关掉向导、回到会话——这里照走一遍。
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()

  const commitCards = page.locator('.intent-session__commits .card')
  await expect(commitCards, '失败的提交没留下任何记录 ⇒ 用户回头查不到自己试过什么').toHaveCount(1)
  await expect(commitCards.first().locator('.status-chip')).toHaveText('Failed')
  await expect(commitCards.first().locator('.status-chip'), '失败没用危险色').toHaveClass(
    /status-chip--danger/,
  )
  await expect(
    commitCards.first().locator('p.mono'),
    '失败只报个状态不给原文 ⇒ 用户既不知道为什么被拒，也不知道要不要重试',
  ).toContainText(`agent name '${targetName}' is taken`)
  await expect(
    commitCards.first().locator('li'),
    '失败的提交却列出了「落地了哪些资源」⇒ 用户以为改动已经进库了',
  ).toHaveCount(0)

  // ── ② 成功的一次：同样选「复制一份」，这次给副本改名 ──
  const copyName = `${targetName}-copy`
  dialog = await openCommitToCopyStrategy(page)
  await dialog.getByPlaceholder('New name').fill(copyName)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  await expect(page.getByText('Committed', { exact: false }).first()).toBeVisible({
    timeout: 90_000,
  })

  await expect(commitCards, '新的一次提交没有追加成一条新记录').toHaveCount(2, { timeout: 60_000 })
  const success = commitCards.first()
  await expect(success.locator('.status-chip')).toHaveText('Committed')
  await expect(success.locator('.status-chip')).toHaveClass(/status-chip--success/)
  const applied = success.locator('li')
  await expect(applied, '成功的提交不列出落地了什么 ⇒ 回执等于没有').toHaveCount(1)
  await expect(
    applied.first(),
    '回执没点名落地的资源类型与名字 ⇒ 用户不知道库里多了什么',
  ).toContainText(`Agent · ${copyName}`)
  await expect(
    applied.first(),
    '复制出来的资源没标 copy ⇒ 用户以为原件被改了（或反过来），两者后果完全不同',
  ).toContainText('(copy)')

  // 失败那条必须原样留在下面：记录是流水账，不是「只显示最后一次」。
  await expect(commitCards.nth(1).locator('.status-chip')).toHaveText('Failed')
  await expect(commitCards.nth(1).locator('p.mono')).toContainText('is taken')

  // 落地面 + 服务端真值：确实是复制而不是就地改。
  const agents = await listAgents(updateDaemon)
  expect(
    agents.find((row) => row.id === target.id)?.description,
    '选了「复制一份」原件却被改了 ⇒ 别人正在用它，而界面只显示「已提交」',
  ).toBe('original description')
  const copy = agents.find((row) => row.name === copyName)
  expect(copy, '副本没落地').toBeTruthy()
  expect(copy?.id).not.toBe(target.id)

  const detail = await detailOf(updateDaemon, sessionId)
  expect(
    detail.commits.map((c) => c.state),
    '提交记录不是「最新在上」的两条',
  ).toEqual(['committed', 'failed'])
  expect(detail.commits[0]?.receipt?.applied[0]?.fromCopy, '回执里的 fromCopy 标记不对').toBe(true)
  expect(detail.commits[1]?.error, '失败记录的错误原文没入库').toContain('intent-name-conflict')
})

// ---------------------------------------------------------------------------
// INTENT-40
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-40: 提交响应丢失后原样重试，同一 clientMutationId 只在服务端落一次 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  const landedName = `rfc319-intent40-${++sequence}`
  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  // 提交一旦在服务端落地就会广播 intent.apply.committed，页面据此重取详情、
  // 发现 currentDraft 变 null 就把提交向导收掉（intent.detail.tsx:243-245）。
  // 但「响应丢了」的用户此刻**什么都不知道**——向导必须还在他眼前，重试才谈得上。
  // 所以把详情钉在提交前那一刻：这正是那位用户的浏览器实际持有的视图。
  const frozen = await detailOf(daemon, sessionId)
  await page.route(
    (url) => url.pathname === `/api/intent-sessions/${sessionId}`,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(frozen),
      })
    },
  )

  const mutationIds: string[] = []
  let attempt = 0
  await page.route(
    (url) => url.pathname === `/api/intent-sessions/${sessionId}/commit`,
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      mutationIds.push(String(body.clientMutationId))
      attempt += 1
      if (attempt > 1) {
        // 重试：原样送出去，让服务端自己决定这是新的一次还是重放。
        await route.continue()
        return
      }
      // 第一次：把**同一份请求**从 Node 侧送到服务端（handler 里禁用
      // route.fetch()，见 docs/dev-gotchas.md），落库成功后把响应丢掉——
      // 这就是「网断在回程」的形态：服务端已经改完了，浏览器一无所知。
      const landed = await fetch(`${daemon.baseUrl}/api/intent-sessions/${sessionId}/commit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(landed.status, '构造「响应丢失」前提失败：这一次提交本该在服务端成功').toBe(200)
      await route.abort('failed')
    },
  )

  const dialog = await openCommitToDetails(page)
  await dialog.getByPlaceholder('New name').fill(landedName)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()

  // ── 用户看到的：一次网络失败 ──
  await expect(
    dialog.getByRole('alert'),
    '响应丢了却不报错 ⇒ 用户以为提交成功走人，或者对着不动的界面干等',
  ).toContainText('Cannot reach the service.', { timeout: 60_000 })
  await expect(
    page.getByRole('dialog'),
    '报完错就把向导关了 ⇒ 用户手上那份确认没了，只能从头再走一遍三步',
  ).toBeVisible()

  // 事实上服务端已经落地了——这正是幂等重试要处理的局面。
  expect(
    (await listAgents(daemon)).filter((row) => row.name === landedName),
    '「响应丢失」的前提没构造出来：服务端其实什么都没落',
  ).toHaveLength(1)

  // ── 用户的动作：在同一个向导里再按一次提交 ──
  await page.getByTestId('intent-commit-submit').click()
  await expect(
    page.getByRole('dialog'),
    '重试没被认成同一次提交 ⇒ 用户拿到的是一个看不懂的冲突，而库里其实早就好了',
  ).toHaveCount(0, { timeout: 60_000 })

  expect(mutationIds, '重试没有发出第二次请求').toHaveLength(2)
  expect(
    mutationIds[0],
    '重试换了幂等身份 ⇒ 第二次是一次全新的 apply，同一批资源可能落地两遍',
  ).toBe(mutationIds[1])

  // ── 服务端真值：只落了一次 ──
  const detail = await detailOf(daemon, sessionId)
  expect(
    detail.commits,
    '重试在 journal 里另开了一条 ⇒ 一次用户确认变成了两次 apply 记录',
  ).toHaveLength(1)
  expect(detail.commits[0]?.state).toBe('committed')
  expect(detail.commits[0]?.receipt?.commitSeq).toBe(1)
  expect(detail.commits[0]?.receipt?.applied.map((a) => a.name)).toEqual([landedName])
  expect(detail.session.commitSeq, '提交序号被加了两次 ⇒ 检查点编号从此对不上').toBe(1)
  expect(
    (await listAgents(daemon)).filter((row) => row.name === landedName),
    '同一份改动落地了两遍 ⇒ 库里多出一个用户没打算建的资源',
  ).toHaveLength(1)

  // 解冻后回到真实视图：会话确实停在「已提交、可从检查点继续」。
  await page.unrouteAll({ behavior: 'wait' })
  await page.reload()
  await expect(page.locator('.intent-session__commits .card')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.getByText('Continuing from checkpoint #1', { exact: true })).toBeVisible()
})

// ---------------------------------------------------------------------------
// INTENT-42
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-42: 底层草稿换了修订时提交对话框自动关闭，只是会话状态变了则不关 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  const otherName = `rfc319-intent42-${++sequence}`
  const other = await seedAgent(daemon, otherName, 'mounted while the dialog is open')
  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  const opened = await detailOf(daemon, sessionId)
  const first = opened.currentDraft as DraftDto
  expect(first.revision).toBe(1)

  await page.getByTestId('intent-open-commit').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Strategy')

  // ── ① 另一处（另一个标签页 / 脚本）在同一会话上迭代出新一版 ──
  await api(daemon, `/api/intent-sessions/${sessionId}/iterations`, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'refine-current',
      clientMutationId: `rfc319-intent42-iterate-${Date.now()}`,
      expectedTurnSeq: opened.session.turnSeq,
      expectedContextRevision: opened.session.contextRevision,
      sourceDraftId: first.id,
      sourceDraftHash: first.draftHash,
      feedback: 'Another tab kept refining this candidate.',
    }),
  })

  // 底层换版本 ⇒ 对话框必须自己让开。它若挂着，用户按下的「确认」指向的是他
  // 从没看过的那一版内容（而服务端只认哈希，不认「用户以为」）。
  await expect(
    page.getByRole('dialog'),
    '草稿换了修订对话框还挂着 ⇒ 用户在旧内容上按确认，落地的是新的一版',
  ).toHaveCount(0, { timeout: 90_000 })
  await expect(draftRevisionHeading(page, 2)).toBeVisible({ timeout: 90_000 })

  // ── ② 负向对照：详情变了、但草稿身份没变 ⇒ 不许关 ──
  //
  // 关得太狠同样是 bug：用户填了半程的密钥 / 改名会被一次无关的后台更新清空。
  await page.getByTestId('intent-open-commit').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Strategy')

  await api(daemon, `/api/intent-sessions/${sessionId}/mounts`, {
    method: 'POST',
    body: JSON.stringify({ resourceType: 'agent', resourceId: other.id }),
  })
  // 先证明这次后台更新**真的**被页面读到了（否则下面「没关」什么都没证明）。
  await expect(
    mountCountChip(page),
    '页面根本没收到这次更新 ⇒ 后面那条「对话框没关」是空转',
  ).toHaveText('1 mounted', { timeout: 60_000 })
  await expect(
    page.getByRole('dialog'),
    '一次与草稿无关的会话更新就把向导关了 ⇒ 用户填到一半的明细被清空',
  ).toBeVisible()
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Strategy')

  const detail = await detailOf(daemon, sessionId)
  expect(detail.currentDraft?.id, '负向对照期间当前草稿其实换了 ⇒ 这一段测的不是它想测的东西').toBe(
    detail.drafts.find((d) => d.revision === 2)?.id,
  )
})
