// RFC-319 —— 意图构建器「提交明细步」与「提交冲突拒绝」的用户面覆盖
// （能力账本 INTENT-30 / 35 / 36 / 37 / 38 / 41，此前全部为 gap）。
//
// 失效形态（这几条不成立时用户会遭遇什么）：
//
//  ① 明细步不把 secret 槽当必填 ⇒ 提交向导放行，落地一个凭据为空的 MCP /
//     script 节点。界面只显示「已提交」，直到某个任务真的去跑它才炸，而那时
//     用户已经不在这个上下文里了。
//  ② 凭据豁免不逐项勾选 ⇒ 「看起来像凭据的明文」被静默带进入库资源；扫描器
//     存在的唯一意义就是让人**看见并逐条认领**，一键放行等于没有扫描器。
//  ③ humanBinding 不给 UserPicker（或绑了不生效）⇒ 占位真人成员被**静默丢弃**
//     （resolveChangeset.ts:667 无绑定即 drop），工作组少一个人而没有任何提示。
//  ④ finalName 槽失效 ⇒ 撞上重名的草稿永远提交不了，用户唯一的出路（改名）没了。
//  ⑤ 阻断性校验错误不显形 ⇒ 用户对着一个服务端**必拒**的草稿反复点提交，
//     错在哪、该让 AI 改什么，界面一个字都不说。
//  ⑥ 四种提交冲突任一漏掉 ⇒ 旧标签页/并发轮次把**过期的草稿**写进库：用户以为
//     提交的是自己刚看到的那一版，实际落地的是另一版。
//
// 判据源码位置（纯文本引用，禁止外链）：
//   packages/frontend/src/routes/intent.detail.tsx:1345-1347  requiredDetailsMissing（secret/waiver 才是必填）
//   packages/frontend/src/routes/intent.detail.tsx:1397       「下一步」在明细未填满时禁用
//   packages/frontend/src/routes/intent.detail.tsx:1407       「提交」在明细未填满时禁用
//   packages/frontend/src/routes/intent.detail.tsx:1473-1550  secret / waiver / human / name 四类槽的表单
//   packages/frontend/src/routes/intent.detail.tsx:1592-1601  复核步逐槽 Provided / Required / Default 读数
//   packages/frontend/src/routes/intent.detail.tsx:650-659    阻断性错误红横幅（NoticeBanner tone=error）
//   packages/frontend/src/routes/intent.detail.tsx:425-436    评审页签红色计数徽章（badgeTone danger）
//   packages/frontend/src/routes/intent.detail.tsx:60-67      REVIEW_FIRST_REASONS（含 draft-invalid）
//   packages/frontend/src/routes/intent.detail.tsx:254-258    工作区页签初值：每会话只按首读的 journey.reason 定一次
//   packages/backend/src/services/intent/journey.ts:44-52     reason 投影：inFlight ⇒ generation-running；否则草稿有错 ⇒ draft-invalid
//   packages/frontend/src/routes/intent.detail.tsx:757-762    错误未清空时 Commit 入口禁用
//   packages/backend/src/services/intent/resolveChangeset.ts:437-449  intent-secret-required
//   packages/backend/src/services/intent/resolveChangeset.ts:420-435  未豁免的凭据发现 ⇒ intent-secret-value-forbidden
//   packages/backend/src/services/intent/resolveChangeset.ts:666-678  humanBinding 未绑定 ⇒ 成员被丢弃
//   packages/backend/src/services/intent/resolveChangeset.ts:491-505  finalName 覆盖名字（并重跑命名文法）
//   packages/backend/src/services/intent/resolveChangeset.ts:526-538  intent-name-conflict
//   packages/backend/src/services/intent/resolveChangeset.ts:373-389  intent-slot-unknown（服务端只认自己签发的槽）
//   packages/backend/src/services/intent/resolveChangeset.ts:411-415  intent-draft-invalid
//   packages/backend/src/services/intent/resolveChangeset.ts:144-148  inventory-only 目标 ⇒ 阻断性错误
//   packages/backend/src/services/intent/applyChangeset.ts:376        intent-session-archived
//   packages/backend/src/services/intent/applyChangeset.ts:379        intent-turn-in-flight
//   packages/backend/src/services/intent/applyChangeset.ts:394-399    intent-draft-hash-mismatch
//   packages/backend/src/services/intent/applyChangeset.ts:405-413    intent-draft-superseded
//
// 关于 secret / secretWaiver / humanBinding 三类槽：
//   现行 intent stub（packages/system-mocks/src/runtime/mode-intent.ts）只产出
//   agent / workflow(agent-single) / update-agent 三种 changeset，**造不出**带
//   sentinel 的 mcp env、script env、凭据形状明文、或 workgroup 的 human 成员，
//   因此服务端在真链路里根本不会签发这三类槽。本文件按 RFC-319 的环境约束
//   （不改 stub，只用 page.route 做请求层注入）把这三类槽注入**详情 GET 的
//   响应**，锁的是它们唯一没有 e2e 防护的那一段：**明细步的用户面闸门**。
//   服务端那一侧已有单元覆盖：packages/backend/tests/rfc234-resolve-bundle.test.ts:132
//   （槽签发）、:238 与 :397（未填 secret / 未豁免 / 重名一律抛）。
//   INTENT-35 结尾还额外断言：注入的槽提交上去会被服务端以 intent-slot-unknown
//   顶回来——即「前端凭空造槽」本身不是一条可用的绕过路径。
//
// 本文件里**每一次成功提交都必须走 finalName 槽改名**：stub 固定提议
// `e2e-auditor`，不改名的话前一条用例落地的资源会让后一条撞 intent-name-conflict。

import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })

// 拆环境前先把在飞的 route handler 等完（docs/dev-gotchas.md 有整节）。本仓前端普遍是
// 「useQuery 挂载打一次 → WS 连上后 reconcile 再补打一次」，第二次的 handler 常常只比正文
// 结束点早几十毫秒；机器一忙就翻成负数，页面已关而 handler 还在 `route.fetch()` 里飞，
// 于是抛 "Target page, context or browser has been closed"——Route 动词里只有 fetch() 没被
// `_raceWithTargetClose` 包住。必须是 'wait'（趁 page 还活着等它跑完），
// 'ignoreErrors' 只是把错吞掉，那等于「重跑就过了」。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})
test.setTimeout(180_000)

/** 默认（create-agent）变体；HOLD 文件默认不存在 ⇒ 每一轮都立即返回。 */
let daemon: DaemonHandle
/** update 变体：只有 update 型操作才能造出「目标未挂载」的阻断性校验错误。 */
let updateDaemon: DaemonHandle
let holdDir: string
let holdFile: string
/**
 * updateDaemon 的 HOLD 开关（与 daemon 的分开，免得两个 daemon 互相挂住）。
 *
 * INTENT-30 要断言的是「工作区页签的初值」，而初值只在**详情第一次可读**的那一刻
 * 按 journey.reason 定一次（intent.detail.tsx:254-258）。不挂住这一轮的话，「首次
 * 可读」落在生成中还是落在草稿已就绪，纯看机器快慢——见 INTENT-30 用例内的说明。
 */
let updateHoldFile: string
let sequence = 0

interface AgentRow {
  id: string
  name: string
  description: string
}

interface SlotDto {
  kind: 'secret' | 'secretWaiver' | 'humanBinding' | 'finalName'
  slotId: string
  opId: string
  jsonPointer?: string
  displayName?: string
}

interface DraftDto {
  id: string
  revision: number
  draftHash: string
  slots: SlotDto[]
  validation: { errors: string[] }
  changeset: { ops: Array<{ opId: string }> }
}

interface SessionDetail {
  session: { status: string; inFlight: boolean }
  currentDraft: DraftDto | null
  drafts: DraftDto[]
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

const agentNames = async (target: DaemonHandle): Promise<string[]> =>
  (await api<AgentRow[]>(target, '/api/agents')).map((row) => row.name)

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
  holdDir = mkdtempSync(join(tmpdir(), 'aw-intent-commit-'))
  holdFile = join(holdDir, 'turn.hold')
  updateHoldFile = join(holdDir, 'update-turn.hold')
  daemon = await startDaemon({
    stubMode: 'intent',
    // 文件不存在时 stub 的等待循环立即退出（mode-intent.ts:198-205），所以这只是
    // 给「让某一轮挂住」留的开关，平时零成本。
    extraEnv: { STUB_INTENT_HOLD_FILE: holdFile },
  })
  updateDaemon = await startDaemon({
    stubMode: 'intent',
    // 同样默认不存在 ⇒ 平时零成本；只有 INTENT-30 会临时写出它来钉死时序。
    extraEnv: { STUB_INTENT_VARIANT: 'update', STUB_INTENT_HOLD_FILE: updateHoldFile },
  })
})

test.afterAll(async () => {
  rmSync(holdDir, { recursive: true, force: true })
  if (daemon !== undefined) await daemon.stop()
  if (updateDaemon !== undefined) await updateDaemon.stop()
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
  await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 60_000 })
  const id = /\/intent\/([0-9A-Z]+)/i.exec(page.url())?.[1]
  expect(id, `会话 id 未能从 URL 解析：${page.url()}`).toBeTruthy()
  return id as string
}

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
 * 提交向导的「上一步」。
 *
 * 它是这套向导里唯一没有 data-testid 的按钮（intent.detail.tsx:1383-1391），
 * 所以按可见文案（intent.commitBack = 'Back'）定位 —— 文案本身也是它对用户的
 * 契约。限定在弹窗内以免撞上页面上别的「Back」。
 */
const commitBackButton = (dialog: Locator): Locator =>
  dialog.getByRole('button', { name: 'Back', exact: true })

/**
 * 展开错误横幅里的「Raw error message」并返回那段 <pre>。
 *
 * intent-* 的错误码没有 exact 文案（i18n/errors.ts 三级解析落到 misc 域），
 * 标题一律是 'Request failed'——**唯一**能告诉用户「被拒的到底是哪一条」的
 * 就是这段原文。只断言横幅出现而不断言原文，等于允许把四种冲突显示成同一
 * 句废话。
 */
async function rawErrorText(scope: Locator): Promise<Locator> {
  const details = scope.locator('details.error-details__raw')
  await expect(details).toBeVisible({ timeout: 30_000 })
  await details.locator('summary').click()
  return details.locator('pre')
}

// ── 请求层注入 ────────────────────────────────────────────────────────────────

const SESSION_DETAIL_PATH = /^\/api\/intent-sessions\/[0-9A-Za-z]{26}$/
const isSessionDetailUrl = (url: URL): boolean => SESSION_DETAIL_PATH.test(url.pathname)

/**
 * 把额外的槽注入到「当前草稿」上。
 *
 * 只动 slots 一个字段，其余全部取自真实响应（先 route.fetch() 再改写），所以
 * 会话状态、轮次、校验结果依然是服务端的真值——注入的仅是 stub 造不出的那几类槽。
 */
async function injectSlots(page: Page, make: (opId: string) => SlotDto[]): Promise<void> {
  await page.route(isSessionDetailUrl, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    const upstream = await route.fetch()
    if (upstream.status() !== 200) {
      await route.fulfill({ response: upstream })
      return
    }
    const body = JSON.parse(await upstream.text()) as SessionDetail
    const current = body.currentDraft
    if (current !== null) {
      const opId = current.changeset.ops[0]?.opId ?? 'op-1'
      const slots = [...make(opId), ...current.slots]
      current.slots = slots
      for (const draft of body.drafts) if (draft.id === current.id) draft.slots = slots
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

// ── INTENT-35：secret 槽 ─────────────────────────────────────────────────────

test('INTENT-35 提交明细步：密码型 secret 槽没填满就进不了复核，也提交不了 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  await injectSlots(page, (opId) => [
    {
      kind: 'secret',
      slotId: `secret:${opId}:/config/env/API_KEY`,
      opId,
      jsonPointer: '/config/env/API_KEY',
    },
  ])
  await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  const dialog = await openCommitToDetails(page)

  // 字段必须自报「我是哪个操作的哪个字段」：一个没有出处的密码框，用户无从判断
  // 该往里填哪把钥匙，只能瞎填 —— 而瞎填出来的资源同样会「提交成功」。
  await expect(dialog.getByText('e2e-auditor · Agent · /config/env/API_KEY')).toBeVisible()
  const secretInput = dialog.getByPlaceholder('Real secret value (never enters the AI context)')
  await expect(secretInput).toHaveAttribute('type', 'password')

  // 闸门：空着就不许进复核。这条不成立 ⇒ 落地一个凭据为空的资源，
  // 界面显示「已提交」，真正跑它的那次任务才炸。
  const next = page.getByTestId('intent-commit-next')
  await expect(next, 'secret 未填时「下一步」必须禁用').toBeDisabled()
  await expect(dialog.getByTestId('intent-commit-review')).toHaveCount(0)

  // 负向对照：填上就必须放行 —— 否则「永远禁用」也能让上面那条断言过。
  await secretInput.fill('sk-live-rfc319-not-a-real-key')
  await expect(next, '填好 secret 后「下一步」必须恢复可用').toBeEnabled()
  await next.click()
  const review = dialog.getByTestId('intent-commit-review')
  await expect(review).toBeVisible()
  // 复核步的逐槽读数是用户在按下提交前最后一次核对的机会。
  await expect(review.locator('li', { hasText: 'Secret' })).toContainText('Provided')

  // 服务端只认自己签发的槽：前端凭空造出来的槽不是绕过路径。
  // 这一条不成立 ⇒ 任何改过的前端都能把任意值塞进任意 JSON 指针。
  await page.getByTestId('intent-commit-submit').click()
  await expect(await rawErrorText(dialog)).toContainText('was not issued')
  expect(
    await agentNames(daemon),
    '被拒的提交不得留下任何资源 —— 半截落地比直接失败更难收拾',
  ).not.toContain('e2e-auditor')
})

// ── INTENT-36：凭据豁免 ──────────────────────────────────────────────────────

test('INTENT-36 提交明细步：凭据豁免必须逐项显式勾选，未勾选一律挡在复核之前 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  await injectSlots(page, (opId) => [
    {
      kind: 'secretWaiver',
      slotId: `waiver:${opId}:/${opId}/payload/bodyMd`,
      opId,
      jsonPointer: `/${opId}/payload/bodyMd`,
    },
  ])
  await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  const dialog = await openCommitToDetails(page)

  const waiver = dialog.getByRole('checkbox', {
    name: /I confirm this is not a real credential/,
  })
  await expect(waiver).not.toBeChecked()
  // 必须指出「像凭据的东西在哪」：只说「有一处可疑」而不说是哪一处，
  // 用户没有任何办法判断该不该放行，只会一路勾过去。
  await expect(dialog.getByText('/bodyMd', { exact: false })).toBeVisible()

  const next = page.getByTestId('intent-commit-next')
  await expect(next, '未勾选豁免时「下一步」必须禁用').toBeDisabled()
  await expect(dialog.getByTestId('intent-commit-review')).toHaveCount(0)

  // 负向对照：逐项勾完就放行。
  await waiver.check()
  await expect(next, '勾选豁免后「下一步」必须恢复可用').toBeEnabled()
  await next.click()
  await expect(
    dialog.getByTestId('intent-commit-review').locator('li', { hasText: 'Credential waiver' }),
  ).toContainText('Provided')

  // 反向：退回明细步取消勾选，闸门必须重新锁死 —— 否则「勾一次就永久放行」，
  // 用户在复核步改了主意也拦不住。
  //
  // 「上一步」按钮没有 data-testid（intent.detail.tsx:1383-1391 只给 next /
  // submit 挂了 testid），所以按可见文案定位；它同时也是这颗按钮对用户的契约。
  await commitBackButton(dialog).click()
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Details')
  await waiver.uncheck()
  await expect(next, '取消勾选后「下一步」必须重新禁用').toBeDisabled()
})

// ── INTENT-37：humanBinding ─────────────────────────────────────────────────

test('INTENT-37 提交明细步：占位真人成员用 UserPicker 绑定，不绑就是「默认丢弃」 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  await injectSlots(page, (opId) => [
    { kind: 'humanBinding', slotId: `human:${opId}:Alex`, opId, displayName: 'Alex' },
  ])
  await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  const dialog = await openCommitToDetails(page)

  // 槽必须点名是**哪个**占位成员：一个工作组可以有多个占位人，绑错人和没绑
  // 一样糟，而两者都不会报错。
  await expect(dialog.getByText('Placeholder member "Alex"')).toBeVisible()
  await expect(
    dialog.getByText('Bind a platform user, or leave empty to drop the member.'),
  ).toBeVisible()

  // 先看未绑定时的读数：它必须明确显示「不是已提供」。这条不成立 ⇒ 用户以为
  // 人已经绑上了，实际提交后这名成员被静默丢弃（resolveChangeset.ts:667）。
  await page.getByTestId('intent-commit-next').click()
  const review = dialog.getByTestId('intent-commit-review')
  const humanRow = review.locator('li', { hasText: 'Human binding' })
  await expect(humanRow).toContainText('Default')
  await expect(humanRow, '未绑定绝不能显示成「已提供」').not.toContainText('Provided')

  // 负向对照：真去挑一个人，读数必须翻成「已提供」。
  await commitBackButton(dialog).click()
  await expect(dialog.getByTestId('intent-commit-step-heading')).toHaveText('Details')
  const picker = dialog.getByRole('combobox')
  await picker.click()
  await page.getByRole('option', { name: /@e2e_admin/ }).click()
  // 选中的人要以 chip 的形式留在字段里 —— 选完不显形等于没有可复查的输入。
  await expect(dialog.getByText('E2E Administrator')).toBeVisible()
  await page.getByTestId('intent-commit-next').click()
  await expect(review.locator('li', { hasText: 'Human binding' })).toContainText('Provided')
})

// ── INTENT-30：阻断性校验错误 ────────────────────────────────────────────────

test('INTENT-30 草稿含阻断性校验错误：红横幅逐条列出、评审页签红计数、Commit 入口禁用、服务端同样拒收 @nightly', async ({
  page,
}) => {
  await authPage(page, updateDaemon)
  const name = `rfc319-intent30-${++sequence}`
  await seedAgent(updateDaemon, name, 'original description')

  const buildTab = page.getByRole('tab', { name: 'Build workspace' })
  const reviewTab = page.getByRole('tab', { name: 'Draft review workspace' })
  const badge = reviewTab.locator('.tabs__tab-badge')

  // ── 前置：把这一轮挂住，钉死「详情第一次可读时会话处在什么状态」 ──────────
  //
  // 工作区页签的初值**只**在详情第一次可读的那一刻按 journey.reason 定一次，
  // 之后同一会话再不自动切换（intent.detail.tsx:254-258 的 once-per-session ref；
  // REVIEW_FIRST_REASONS 见 :60-67）。所以「用户落在哪个页签」取决于首读时的
  // reason，而**不**取决于草稿最终长什么样。
  //
  // 不挂住这一轮的话，首读到底撞上 `generation-running`（⇒ Build）还是撞上
  // 草稿已就绪的 `draft-invalid`（⇒ Review），纯粹取决于「浏览器发出首个详情
  // GET 并拿到响应」和「stub 这一轮跑完」谁快 —— 本机快，首读落在生成中；CI 的
  // macOS 腿慢，首读落在草稿之后。这正是本用例此前在 CI 上红的原因（本机注入
  // 1.5s 的首个详情 GET 延迟即可 100% 复现：build=false / review=true）。
  // 挂住这一轮 ⇒ 首读时**必然**还没有任何草稿 ⇒ reason 必然不在
  // REVIEW_FIRST_REASONS 里 ⇒ 初值必然是 Build，与机器快慢无关。
  writeFileSync(updateHoldFile, 'held')
  let sessionId = ''
  try {
    // 不走资源详情页的「Modify via intent」入口 ⇒ 目标只在清单里可见、未挂载，
    // 服务端据此把草稿判为有阻断性错误（resolveChangeset.ts:144-148）。
    await page.goto(`${updateDaemon.baseUrl}/intent`)
    const composer = page.getByTestId('intent-create-inline')
    await composer.getByTestId('intent-create-message').fill(`rework rfc319-target:${name}`)
    await composer.getByRole('button', { name: 'Start building' }).click()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
    const parsed = /\/intent\/([0-9A-Z]+)/i.exec(page.url())?.[1]
    expect(parsed, `会话 id 未能从 URL 解析：${page.url()}`).toBeTruthy()
    sessionId = parsed as string

    // 「Cancel generation」只在 detail.session.inFlight 为真时渲染
    // （intent.detail.tsx:309-317）。它可见 = 详情已经读到了，且读到的是**生成中**
    // —— 这就是上面那段初值论证的前提，必须显式钉住，不能默认。
    await expect(
      page.getByRole('button', { name: 'Cancel generation' }),
      '挂住的那一轮里详情必须已可读且处于生成中，否则下面的页签初值断言测的不是它想测的东西',
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('intent-draft'), '挂住期间不该有任何草稿').toHaveCount(0)

    // 窄布局才有页签：宽屏两栏同时可见，TabBar 被 CSS 收起；窄屏下未选中的那一栏
    // 整个 display:none（styles.css:25386 起的 max-width:1080px 断点，
    // :25392-25394 放出页签、:25405-25407 藏掉未选中的栏）。这也是下面所有
    // 评审栏内容都必须先点开评审页签才断言的原因。
    await page.setViewportSize({ width: 900, height: 1000 })
    await expect(buildTab, '生成中首读 ⇒ 初值必须落在 Build 页签').toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(reviewTab).toHaveAttribute('aria-selected', 'false')
    // 草稿还没落地就先亮红角标 ⇒ 用户被一个还不存在的「问题」催着去看空的评审栏。
    await expect(badge, '还没有草稿时不得有任何计数徽章').toHaveCount(0)
  } finally {
    rmSync(updateHoldFile, { force: true })
  }

  // ── ① 评审页签的红色计数徽章 ───────────────────────────────────────────────
  //
  // 窄屏上右栏整个是隐藏的，用户此刻停在 Build 页签（刚刚断言过），这颗徽章是
  // 「有东西要处理」的**唯一**信号：它不显形 ⇒ 用户对着一个已经生成完、但服务端
  // 必拒的草稿干等，界面上没有任何东西提示他去看评审栏。
  await expect(badge).toHaveText('1', { timeout: 60_000 })
  await expect(badge, '徽章必须是危险色，中性色读起来只是「有 1 条内容」').toHaveAttribute(
    'data-tone',
    'danger',
  )
  // 契约的另一半，也是本用例真正的回归防线：草稿**带着阻断性错误落地**这件事
  // 本身不得改动页签选中态。它若被改成「一落地就自动跳评审栏」，用户正在 Build
  // 栏敲的追加指令会被当场从视野里挪走（页签是互斥的，右栏一亮左栏就整个隐藏）。
  await expect(buildTab, '草稿落地不得抢走页签选中态').toHaveAttribute('aria-selected', 'true')
  await expect(reviewTab).toHaveAttribute('aria-selected', 'false')

  // ── ② 跟着徽章切过去：红横幅 + Commit 入口禁用 ────────────────────────────
  await reviewTab.click()
  // 红横幅：tone=error 的 NoticeBanner 渲染成 role=alert（NoticeBanner.tsx:103）。
  const banner = page.getByRole('alert').filter({ hasText: 'blocking validation errors' })
  await expect(banner).toBeVisible({ timeout: 30_000 })
  await expect(banner).toHaveClass(/notice-banner--error/)
  // 逐条列出，而不是只报个数：只说「有 1 个错误」，用户既不知道错在哪，
  // 也没法告诉 AI 该改什么，只能一直重生成。
  await expect(banner.locator('li')).toContainText('inventory-only')
  await expect(banner.locator('li')).toContainText('intent-target-not-mounted')
  // 大纲上也要挂到具体那条操作上（多操作草稿里这是唯一的定位手段）。
  await expect(page.getByTestId('intent-op-outline-item')).toContainText('1 issues')
  // Commit 入口禁用 + 说明为什么。只禁用不解释，用户会以为界面坏了、反复点。
  await expect(page.getByTestId('intent-open-commit')).toBeDisabled()
  await expect(
    page.getByText('Resolve the validation issues above before opening commit review.'),
  ).toBeVisible()

  // ── ③ 初值契约的另一支：首读就是 draft-invalid 时必须直接落在评审栏 ────────
  //
  // 上面锁的是「首读=生成中」那一支；刷新（= 从列表页/书签重新进入这个会话）走的
  // 是另一支：首读时草稿已在、且带阻断性错误 ⇒ reason='draft-invalid' ∈
  // REVIEW_FIRST_REASONS（intent.detail.tsx:60-67）⇒ 直接落在评审栏。
  // 这一支不成立 ⇒ 一个「已知必被服务端拒收」的会话，用户重新进来时被扔回 Build
  // 栏，窄屏上要自己想到去点评审页签才看得见错在哪。
  await page.reload()
  await expect(reviewTab, '重新进入一个草稿已失效的会话必须直接落在评审栏').toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 60_000 },
  )
  await expect(buildTab).toHaveAttribute('aria-selected', 'false')
  // 直接落在评审栏 ⇒ 红横幅不点任何东西就该在眼前（这才是这一支存在的意义）。
  await expect(banner).toBeVisible({ timeout: 30_000 })

  // ④ 服务端真值：禁用只是第一道门，绕过前端直接打 API 也必须被拒。
  //    这条不成立 ⇒ 禁用按钮就是全部防线，任何脚本/旧标签页都能把非法草稿入库。
  const detail = await api<SessionDetail>(updateDaemon, `/api/intent-sessions/${sessionId}`)
  const draft = detail.currentDraft
  expect(draft).not.toBeNull()
  const res = await fetch(`${updateDaemon.baseUrl}/api/intent-sessions/${sessionId}/commit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${updateDaemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientMutationId: `rfc319-intent30-commit-${Date.now()}`,
      draftRevision: (draft as DraftDto).revision,
      draftHash: (draft as DraftDto).draftHash,
      decisions: [],
    }),
  })
  expect(res.status).toBe(422)
  expect(((await res.json()) as { code: string }).code).toBe('intent-draft-invalid')

  // 落地面：目标一个字节没动。
  const after = (await api<AgentRow[]>(updateDaemon, '/api/agents')).find(
    (row) => row.name === name,
  )
  expect(after?.description, '被拒的草稿不得改到目标资源').toBe('original description')
})

test('INTENT-30 负向对照：目标已挂载、草稿无错误时，横幅与徽章都不许出现，Commit 入口可用 @nightly', async ({
  page,
}) => {
  await authPage(page, updateDaemon)
  const name = `rfc319-intent30-ok-${++sequence}`
  const target = await seedAgent(updateDaemon, name, 'original description')

  // 「Modify via intent」入口会把目标预挂载进新会话 —— 同一条 update 操作因此合法。
  await page.goto(`${updateDaemon.baseUrl}/agents/${target.id}`)
  await page.getByTestId('agent-intent-entry').click()
  await page.waitForURL(/\/intent\?/)
  const createDialog = page.getByRole('dialog')
  await createDialog
    .getByTestId('intent-create-dialog')
    .getByTestId('intent-create-message')
    .fill(`rework rfc319-target:${name}`)
  await createDialog.getByRole('button', { name: 'Start building' }).click()
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
  await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 60_000 })

  // 上一条用例的三个信号在这里必须全部缺席：否则它们是常显的，上一条恒绿。
  // 宽屏下两栏同时可见，Commit 入口是真的可见可用（不是只在 DOM 里）。
  await expect(
    page.getByRole('alert').filter({ hasText: 'blocking validation errors' }),
  ).toHaveCount(0)
  const openCommit = page.getByTestId('intent-open-commit')
  await expect(openCommit).toBeVisible()
  await expect(openCommit).toBeEnabled()
  await expect(
    page.getByText('Resolve the validation issues above before opening commit review.'),
  ).toHaveCount(0)
  // 徽章那一条要在窄屏下看（宽屏本来就没有页签，测不出差别）。
  await page.setViewportSize({ width: 900, height: 1000 })
  await expect(
    page.getByRole('tab', { name: 'Draft review workspace' }).locator('.tabs__tab-badge'),
  ).toHaveCount(0)
})

// ── INTENT-41：四种提交冲突拒绝 ──────────────────────────────────────────────

test('INTENT-41 提交冲突：草稿哈希不匹配时拒收；不篡改时同一向导必须能提交成功 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')
  const landedName = `rfc319-intent41-hash-${++sequence}`

  const commitPath = /\/api\/intent-sessions\/[0-9A-Za-z]{26}\/commit$/
  const tamper = async (route: Route): Promise<void> => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    await route.continue({
      // 格式仍合法（否则会被 zod 判成 intent-invalid，测不到冲突分支），只是内容不对。
      postData: JSON.stringify({ ...body, draftHash: `sha256:${'0'.repeat(64)}` }),
    })
  }
  await page.route(commitPath, tamper)

  let dialog = await openCommitToDetails(page)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  // 这条不成立 ⇒ 「我确认的是哪一版」这个前提没人校验，用户在 A 版上点的确认
  // 可以把 B 版写进库。
  await expect(await rawErrorText(dialog)).toContainText('confirmed draft hash does not match')
  expect(await agentNames(daemon)).not.toContain(landedName)

  // 负向对照：把篡改摘掉，同一份草稿必须真的能提交并落地 —— 否则「提交永远失败」
  // 也能让上面那条断言过。
  await page.unroute(commitPath, tamper)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  dialog = await openCommitToDetails(page)
  await dialog.getByPlaceholder('New name').fill(landedName)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  await expect(page.getByText('Committed', { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })
  expect(await agentNames(daemon)).toContain(landedName)
})

test('INTENT-41 提交冲突：确认的修订已被更新的修订取代时拒收（旧标签页形态） @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  const first = (await api<SessionDetail>(daemon, `/api/intent-sessions/${sessionId}`)).currentDraft
  expect(first?.revision).toBe(1)

  // 再迭代一轮：revision 2 成为当前草稿，revision 1 退居历史。
  await page.getByTestId('intent-composer').fill('Make the candidate stricter.')
  await page.getByTestId('intent-composer-submit').click()
  await expect(page.getByRole('heading', { name: /Draft changeset \(revision 2\)/ })).toBeVisible({
    timeout: 60_000,
  })

  // 请求层把「本次确认的是哪一版」改回 revision 1 —— 即一个还停在旧版上的标签页。
  const commitPath = /\/api\/intent-sessions\/[0-9A-Za-z]{26}\/commit$/
  await page.route(commitPath, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    await route.continue({
      postData: JSON.stringify({
        ...body,
        draftRevision: (first as DraftDto).revision,
        draftHash: (first as DraftDto).draftHash,
      }),
    })
  })

  const dialog = await openCommitToDetails(page)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  // 哈希是对的（它确实是 revision 1 的哈希），但它已经不是当前版本。
  // 这条不成立 ⇒ 用户在旧标签页看到的旧方案会覆盖掉新的那一版，而两个页面
  // 都会显示「已提交」。
  await expect(await rawErrorText(dialog)).toContainText('a newer draft revision exists')
  expect(await agentNames(daemon)).not.toContain('e2e-auditor')
})

test('INTENT-41 提交冲突：会话已归档时拒收 @nightly', async ({ page }) => {
  await authPage(page, daemon)
  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  const dialog = await openCommitToDetails(page)
  await page.getByTestId('intent-commit-next').click()
  await expect(dialog.getByTestId('intent-commit-review')).toBeVisible()

  // 归档一落地，前端就会把整个提交入口摘掉（intent.detail.tsx:862 的 canEdit 门），
  // 于是「归档后仍按下提交」这一幕只能发生在**另一个标签页刚归档**的时候。
  // 这里冻结本页的详情 GET 来复现那一幕：页面停在归档前的状态，提交请求照发。
  const frozen = await api<SessionDetail>(daemon, `/api/intent-sessions/${sessionId}`)
  await page.route(isSessionDetailUrl, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(frozen),
    })
  })
  await api(daemon, `/api/intent-sessions/${sessionId}/archive`, { method: 'POST' })

  await page.getByTestId('intent-commit-submit').click()
  // 这条不成立 ⇒ 一个已经被归档（= 用户宣告作废）的方案还能被写进库。
  await expect(await rawErrorText(dialog)).toContainText('session is archived')
  expect(await agentNames(daemon)).not.toContain('e2e-auditor')
})

test('INTENT-41 提交冲突：生成轮次还在跑时拒收 @nightly', async ({ page }) => {
  await authPage(page, daemon)
  const sessionId = await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  const dialog = await openCommitToDetails(page)
  await page.getByTestId('intent-commit-next').click()
  await expect(dialog.getByTestId('intent-commit-review')).toBeVisible()

  // 让下一轮挂住（stub 在 HOLD 文件存在期间不返回，mode-intent.ts:198-205）。
  writeFileSync(holdFile, 'held')
  try {
    await api(daemon, `/api/intent-sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: 'keep refining while I commit' }),
    })
    await expect
      .poll(
        async () =>
          (await api<SessionDetail>(daemon, `/api/intent-sessions/${sessionId}`)).session.inFlight,
        { timeout: 30_000 },
      )
      .toBe(true)

    await page.getByTestId('intent-commit-submit').click()
    // 这条不成立 ⇒ 提交和生成并发：入库的是旧草稿，而几秒后新草稿覆盖界面，
    // 用户完全无法判断库里到底是哪一版。
    await expect(await rawErrorText(dialog)).toContainText('a generation turn is running')
  } finally {
    rmSync(holdFile, { force: true })
  }
  expect(await agentNames(daemon)).not.toContain('e2e-auditor')
})

// ── INTENT-38：finalName 解重名 ─────────────────────────────────────────────
//
// 放在最后：本条会长期占用 `e2e-auditor` 这个名字（stub 固定提议它），
// 之后任何不改名的提交都会撞冲突。

test('INTENT-38 提交明细步：重名被服务端挡下，用 finalName 槽改名后才落地 @nightly', async ({
  page,
}) => {
  await authPage(page, daemon)
  await seedAgent(daemon, 'e2e-auditor', 'seeded by rfc319 to occupy the name')
  await createSessionAndAwaitDraft(page, daemon, 'build me an auditor agent')

  // ① 不改名 ⇒ 服务端点名是哪个名字被占了。
  let dialog = await openCommitToDetails(page)
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  // 这条不成立 ⇒ 要么静默覆盖了别人同名的资源，要么只回一句「提交失败」，
  // 用户既不知道撞的是哪个名字，也不知道该怎么绕过。
  await expect(await rawErrorText(dialog)).toContainText("agent name 'e2e-auditor' is taken")
  const occupant = (await api<AgentRow[]>(daemon, '/api/agents')).filter(
    (row) => row.name === 'e2e-auditor',
  )
  expect(occupant, '重名冲突不得铸出第二个同名资源').toHaveLength(1)
  expect(occupant[0]?.description, '原有同名资源被覆盖是这一步最坏的失效').toBe(
    'seeded by rfc319 to occupy the name',
  )

  // ② 改名后必须落地。失败的那次提交已经把本次向导的幂等身份烧成 failed
  //    （applyChangeset.ts:1251 settleFailed → 同一 clientMutationId 重放即
  //    intent-apply-failed-replay），所以用户的重试路径是**关掉再打开**向导；
  //    这也是重开会重新铸 clientMutationId 的原因（intent.detail.tsx:1287-1295）。
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const renamed = `rfc319-intent38-renamed-${++sequence}`
  dialog = await openCommitToDetails(page)
  await dialog.getByPlaceholder('New name').fill(renamed)
  await page.getByTestId('intent-commit-next').click()
  await expect(
    dialog.getByTestId('intent-commit-review').locator('li', { hasText: 'Final name' }),
  ).toContainText('Provided')
  await page.getByTestId('intent-commit-submit').click()
  await expect(page.getByText('Committed', { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })

  // 两边都读：新名字落地了，且占位那条一个字节没动。
  const agents = await api<AgentRow[]>(daemon, '/api/agents')
  const landed = agents.find((row) => row.name === renamed)
  expect(landed, '改名后仍未落地 ⇒ finalName 槽形同虚设，重名草稿永远提交不了').toBeTruthy()
  expect(landed?.description).toBe('audits code for e2e')
  expect(
    agents.find((row) => row.name === 'e2e-auditor')?.description,
    '改名提交不得动到原来占用该名字的资源',
  ).toBe('seeded by rfc319 to occupy the name')
})
