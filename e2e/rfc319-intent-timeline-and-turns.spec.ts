// RFC-319 —— 意图构建器「对话时间线 + 轮次控制」能力簇的用户面 e2e。
//
// 覆盖能力账本行：INTENT-12 / 16 / 17 / 18 / 19 / 21 / 23 / X4。这八行此前全是
// gap：既有的 e2e（e2e/intent-builder.spec.ts、e2e/intent-apply-mode.spec.ts、
// e2e/rfc319-intent-create-and-list.spec.ts）只走过「创建 → 出草稿 → 提交」这条
// 顺风路径，**轮次控制面一条防护都没有**——追问、挂载建议、取消、打断、重试、
// 执行详情、回到最新，七个入口在浏览器里从未被点过。
//
// 各条失效形态（这些断言红掉时用户会遭遇什么）：
//
//  INTENT-12  时间线是这个产品唯一的「发生过什么」的记录。任何一类 turn 掉进
//             默认分支（只剩一行 meta、正文空白），用户就再也看不出上一轮到底
//             问了什么、答了什么、批准了什么——而这些决定会直接进下一轮的
//             agent 上下文。
//  INTENT-16  取消若只是把按钮置灰、后台那条 runtime 子进程照跑，用户就是在
//             对着一个假开关烧 token；更糟的是它跑完还会把结果写回来，覆盖掉
//             用户以为已经作废的那一轮。本文件为此**在解除 hold 之后**回查那条
//             turn 的错误码是否仍是 `intent-run-aborted`：子进程若还活着，
//             settle 会把它改写成 `intent-context-superseded` 或直接产出草稿。
//  INTENT-17  失败轮如果只显示一个错误码，用户唯一能做的就是重开会话；诊断卡片
//             （分类标题 + 下一步建议 + 三行证据 + scratch 保留提示）与「Retry
//             turn」是这条路唯一的出口。重试若不带上失败轮的身份（sourceTurnId /
//             expectedTurnSeq），并发下会重跑错轮。
//  INTENT-18  追问是**阻塞**的：没答完，composer 就不让发。单选若不互斥、多选若
//             不能多选、或者答案在提交时丢字段，用户回答的和 agent 收到的就是
//             两回事，而这件事在界面上完全看不出来。
//  INTENT-19  「一次原子提交」是这条能力的全部价值：答案与逐项批准/拒绝必须走
//             **同一个** POST /current-action，服务端在**同一个事务**里落一条
//             answers turn（同时带 answers 与 mountDecisions）并只推进一次
//             contextRevision。拆成两次请求（先 /answers 再 /mount-approvals）
//             会产生一个中间态：答案已入库、挂载还没批，此时 agent 已被唤起，
//             拿到的是半份上下文。本文件因此把断言落在「整个会话变更面上只观测
//             到一次请求」，而不是各断各的。
//  INTENT-21  执行详情是失败时唯一能看的现场。事件数若不是真数、live/complete
//             若不随真实捕获状态走、truncated/incomplete 若不出告警，用户会把
//             一份**残缺**的事件流当成完整证据去判因。
//  INTENT-23  「停止本轮并立即刷新」的承诺有两半：停（当前轮真的死）与刷新
//             （新一轮带着新上下文起来）。少了前一半就是两轮并发烧 token，
//             少了后一半用户得自己再发一次消息。
//  INTENT-X4  时间线自动贴底是为了看最新；用户往回翻历史时若被新到的 turn 拽回
//             底部，就没法读完一句话。反过来「回到最新」按钮若点了不回底、或者
//             回底之后不重新贴底，用户此后每来一轮都要手动滚一次。
//
// 判据源码位置（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/intent.detail.tsx:470-518   六类 turn 卡片与 data-testid
//   packages/frontend/src/routes/intent.detail.tsx:208-220   贴底 / 「回到最新」的 rAF 效应
//   packages/frontend/src/routes/intent.detail.tsx:453-458   96px 贴底判定（onScroll）
//   packages/frontend/src/routes/intent.detail.tsx:520-534   回到最新按钮：smooth 回底 + 重新贴底
//   packages/frontend/src/routes/intent.detail.tsx:308-317   Cancel generation（仅 canEdit && inFlight）
//   packages/frontend/src/routes/intent.detail.tsx:1215-1252 失败诊断卡片 + Retry turn
//   packages/frontend/src/routes/intent.detail.tsx:970-1182  IntentCurrentAction：答案 + 逐项决定 → 一次 POST
//   packages/frontend/src/routes/intent.detail.tsx:1004-1010 incomplete 门（未答完 / 未选候选即禁用提交）
//   packages/frontend/src/routes/intent.detail.tsx:897-959   answers / mount-approval 的语义渲染
//   packages/frontend/src/components/intent/IntentTurnSession.tsx:45-98 执行详情面板
//   packages/frontend/src/components/IntentMountDialog.tsx:155-176 「停止本轮并立即刷新」
//   packages/frontend/src/lib/intent-failure-diagnostic.ts:39-90 诊断分类与证据行
//   packages/backend/src/routes/intentSessions.ts:409-459    mountSuggestions 候选按同类型同名解析
//   packages/backend/src/routes/intentSessions.ts:500-503    retrySource = 最后一条 agent 错误轮
//   packages/backend/src/routes/intentSessions.ts:739-789    working-set：interrupt ⇒ 取消当前轮 + 立即激活
//   packages/backend/src/routes/intentSessions.ts:900-932    cancel-turn
//   packages/backend/src/services/intent/iteration.ts:440-600 reserveIntentCurrentAction 的单事务语义
//   packages/backend/src/services/intent/iteration.ts:306-359 reserveExactIntentRetry 的身份校验
//   packages/backend/src/services/intent/turnEngine.ts:181-218 cancelIntentTurn（abort 优先，DB 兜底）
//   packages/backend/src/services/intent/turnEngine.ts:718-730 intent-envelope-missing
//   packages/backend/src/services/intent/turnSession.ts:20-58 捕获上限与 effectiveCaptureState
//   packages/backend/src/services/intent/maintenance.ts:16-56 daemon 重启把 live 捕获降级为 incomplete
//
// 夹具：`STUB_INTENT_VARIANT=questions`（本 RFC 新增，见
// packages/system-mocks/src/runtime/mode-intent.ts）让 stub 先追问一轮再产出
// changeset，`STUB_INTENT_MOUNT_REQUESTS=1` additionally 带上三条挂载建议；
// `STUB_INTENT_FAIL_FILE` 造一次「跑完了没吐信封」的真实失败；
// `STUB_INTENT_FILLER_BYTES` 把事件捕获推过上限。故障注入一律走 stub 与请求层，
// 不改任何生产代码。

import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

// 每条用例都要真起 runtime 子进程跑好几轮，90s 的全局预算不够。用
// `describe.configure` 而不是文件级 `test.setTimeout()`：后者在本文件实测**没有**
// 抬高预算（仍报 `Test timeout of 90000ms exceeded`）。
test.describe.configure({ timeout: 240_000 })

// stub 内置的三条挂载建议（mode-intent.ts 的 MOUNT_REQUESTS），调用方按名字备好资源。
const SUGGESTED_AGENT = 'e2e-intent-suggested-agent'
const SUGGESTED_WORKFLOW = 'e2e-intent-suggested-workflow'
const MISSING_SKILL = 'e2e-intent-missing-skill'

// stub 内置的两条追问（mode-intent.ts 的 CLARIFY_QUESTIONS）。
const Q_SCOPE = 'Which repositories should the auditor cover?'
const Q_SECTIONS = 'Which report sections must the auditor emit?'

interface TurnLite {
  id: string
  seq: number
  role: 'user' | 'agent'
  kind: 'message' | 'answers' | 'mount-approval' | 'running' | 'questions' | 'changeset' | 'error'
  content: Record<string, unknown>
  execution: {
    captureState: 'live' | 'complete' | 'truncated' | 'incomplete'
    lastEventSeq: number
    eventBytes: number
    incompleteReason: string | null
  } | null
}

interface MountLite {
  handle: string
  resourceType: string
  resourceId: string
  displayName: string | null
}

interface SuggestionLite {
  resourceType: string
  name: string
  reason: string | null
  candidates: Array<{ resourceId: string; name: string; description: string | null }>
}

interface DetailLite {
  session: {
    id: string
    title: string
    inFlight: boolean
    turnSeq: number
    contextRevision: number
  }
  mounts: MountLite[]
  mountSuggestions: {
    sourceTurnId: string
    sourceTurnSeq: number
    items: SuggestionLite[]
  } | null
  turns: TurnLite[]
  currentDraft: { id: string; revision: number } | null
  retrySource: { turnId: string; turnSeq: number } | null
}

/** 浏览器侧观测到的一次会话变更请求。 */
interface RecordedMutation {
  method: string
  pathname: string
  body: string
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

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

async function apiJson<T>(d: DaemonHandle, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${d.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  expect(res.ok, `${init?.method ?? 'GET'} ${path} ⇒ ${res.status} ${text}`).toBe(true)
  return JSON.parse(text) as T
}

async function createSession(d: DaemonHandle, message: string): Promise<string> {
  const created = await apiJson<{ id: string }>(d, '/api/intent-sessions', {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  return created.id
}

async function detailOf(d: DaemonHandle, sessionId: string): Promise<DetailLite> {
  return apiJson<DetailLite>(d, `/api/intent-sessions/${sessionId}`)
}

/** 轮次落定前一切派生态（retrySource / 卡片种类 / 挂载建议）都还在漂移。 */
async function waitForSettled(
  d: DaemonHandle,
  sessionId: string,
  message = '这一轮迟迟没落定',
): Promise<DetailLite> {
  await expect
    .poll(async () => (await detailOf(d, sessionId)).session.inFlight, {
      timeout: 90_000,
      intervals: [400],
      message,
    })
    .toBe(false)
  return detailOf(d, sessionId)
}

function lastAgentTurn(detail: DetailLite): TurnLite | undefined {
  return [...detail.turns].reverse().find((turn) => turn.role === 'agent')
}

/**
 * 把这条会话**全部**变更入口挂上观测。
 *
 * 逐条 pathname 精确匹配（不是 `**\/api/intent-sessions/**` 这种通配），既满足
 * 「谓词精确到单条 pathname」的要求，又能回答 INTENT-19 真正要问的那个问题：
 * 提交一次「答案 + 挂载决定」时，服务端到底收到了几个请求。少列一条入口，
 * 「只发了一次」就会退化成「我只数了自己期待的那一次」。
 */
const MUTATION_SUBPATHS = [
  'messages',
  'answers',
  'iterations',
  'current-action',
  'mount-approvals',
  'mounts',
  'working-set',
  'rebase',
  'retry',
  'cancel-turn',
  'commit',
  'archive',
  'reopen',
] as const

async function recordMutations(page: Page, sessionId: string): Promise<RecordedMutation[]> {
  const paths = new Set(MUTATION_SUBPATHS.map((sub) => `/api/intent-sessions/${sessionId}/${sub}`))
  const seen: RecordedMutation[] = []
  await page.route(
    (url) => paths.has(url.pathname),
    async (route) => {
      const request = route.request()
      if (request.method() !== 'GET') {
        seen.push({
          method: request.method(),
          pathname: new URL(request.url()).pathname,
          body: request.postData() ?? '',
        })
      }
      await route.continue()
    },
  )
  return seen
}

function onlyMutation(seen: readonly RecordedMutation[], why: string): RecordedMutation {
  expect(
    seen.map((entry) => `${entry.method} ${entry.pathname}`),
    why,
  ).toHaveLength(1)
  return seen[0]!
}

/** 时间线上每张卡片的 turn 种类，按 DOM 顺序。 */
async function timelineKinds(page: Page): Promise<string[]> {
  return page
    .locator('.intent-session__timeline .intent-turn-card')
    .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.testid ?? '?'))
}

/** 「回到最新」与贴底判定都读这个滚动容器（intent.detail.tsx:446-458）。 */
function conversation(page: Page): Locator {
  return page.getByTestId('intent-build-workspace')
}

async function seedAgent(d: DaemonHandle, name: string, description: string): Promise<string> {
  const created = await apiJson<{ id: string }>(d, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({ name, description, outputs: ['answer'], bodyMd: 'Stub fixture agent.' }),
  })
  return created.id
}

async function seedWorkflow(d: DaemonHandle, name: string, description: string): Promise<string> {
  const created = await apiJson<{ id: string }>(d, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      definition: {
        $schema_version: 5,
        inputs: [{ kind: 'text', key: 'k1', label: 'K1', required: false }],
        nodes: [{ id: 'in_1', kind: 'input', inputKey: 'k1', position: { x: 0, y: 0 } }],
        edges: [],
      },
    }),
  })
  return created.id
}

// ---------------------------------------------------------------------------
// 共享 daemon
// ---------------------------------------------------------------------------

/** 追问 + 挂载建议（INTENT-12 / INTENT-19）。 */
let suggestDaemon: DaemonHandle
/** 只追问、不建议挂载（INTENT-18）。 */
let questionsDaemon: DaemonHandle
/** 首轮挂住不放，用于取消 / 打断（INTENT-16 / INTENT-23）。 */
let holdDaemon: DaemonHandle
/** 普通 intent stub（INTENT-X4）。 */
let plainDaemon: DaemonHandle

let suggestFailFile = ''
let holdFile = ''
let scratchDir = ''

/** 三条挂载建议里两条要有真实资源，第三条故意没有（零候选告警）。 */
let suggestedAgentId = ''
let suggestedWorkflowAId = ''
let suggestedWorkflowBId = ''

test.beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-intent-turns-'))
  suggestFailFile = join(scratchDir, 'suggest.fail')
  holdFile = join(scratchDir, 'hold.turn')

  suggestDaemon = await startDaemon({
    stubMode: 'intent',
    extraEnv: {
      STUB_INTENT_VARIANT: 'questions',
      STUB_INTENT_MOUNT_REQUESTS: '1',
      STUB_INTENT_FAIL_FILE: suggestFailFile,
    },
  })
  questionsDaemon = await startDaemon({
    stubMode: 'intent',
    extraEnv: { STUB_INTENT_VARIANT: 'questions' },
  })
  holdDaemon = await startDaemon({
    stubMode: 'intent',
    extraEnv: { STUB_INTENT_HOLD_FILE: holdFile },
  })
  plainDaemon = await startDaemon({ stubMode: 'intent' })

  suggestedAgentId = await seedAgent(suggestDaemon, SUGGESTED_AGENT, 'existing auditor persona')
  // 同名两条：workflows.name 没有唯一索引（db/schema.ts:474 明写「not unique」），
  // 这正是「一条建议对上多个候选」在产品里成立的原因。描述不同才好在下拉里分辨。
  suggestedWorkflowAId = await seedWorkflow(
    suggestDaemon,
    SUGGESTED_WORKFLOW,
    'candidate A review pipeline',
  )
  suggestedWorkflowBId = await seedWorkflow(
    suggestDaemon,
    SUGGESTED_WORKFLOW,
    'candidate B review pipeline',
  )
})

test.afterAll(async () => {
  rmSync(holdFile, { force: true })
  rmSync(suggestFailFile, { force: true })
  await Promise.all([
    suggestDaemon.stop(),
    questionsDaemon.stop(),
    holdDaemon.stop(),
    plainDaemon.stop(),
  ])
  rmSync(scratchDir, { recursive: true, force: true })
})

test.afterEach(async ({ page }) => {
  // 先摘 handler，再趁 page 还活着等完在飞的那次回调（docs/dev-gotchas.md 的锁 B）。
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// INTENT-12
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-12: 时间线按语义渲染 message / questions / answers / changeset / mount-approval / error 六类 turn @nightly', async ({
  page,
}) => {
  await authPage(page, suggestDaemon)
  const goal = 'rfc319 timeline palette'
  const sessionId = await createSession(suggestDaemon, goal)
  await waitForSettled(suggestDaemon, sessionId, '首轮追问没落定')

  await page.goto(`${suggestDaemon.baseUrl}/intent/${sessionId}`)

  // ---- 1) 用户消息：正文是用户真写的那句话，不是标题或占位 ----
  const messageCard = page.getByTestId('intent-turn-message')
  await expect(messageCard, '用户消息没进时间线 ⇒ 会话开头是一片空白').toHaveCount(1)
  await expect(
    messageCard.locator('.card__meta > span'),
    '卡片不说明这是谁的哪类发言 ⇒ 一屏卡片全长一个样',
  ).toHaveText('Me · Message')
  await expect(messageCard.locator('p'), '消息正文没渲染 ⇒ 用户看不到自己提的目标').toHaveText(goal)

  // ---- 2) 追问：条数 + 每条题面 ----
  const questionsCard = page.getByTestId('intent-turn-questions')
  await expect(questionsCard.locator('.card__meta > span')).toHaveText('Builder agent · Questions')
  await expect(
    questionsCard.locator('.intent-turn-semantic > p'),
    '追问卡片不报条数 ⇒ 用户不知道还有几个决定要做',
  ).toHaveText('2 clarifying questions')
  await expect(
    questionsCard.locator('.intent-turn-semantic li'),
    '追问正文掉进默认分支 ⇒ 卡片上只剩一行 meta，用户根本不知道被问了什么',
  ).toHaveText([Q_SCOPE, Q_SECTIONS])

  // ---- 3) 作答 + 挂载决定（一次提交），产出 answers 卡片 ----
  const action = page.getByTestId('intent-current-action')
  await action.getByRole('radio', { name: 'Only this repository' }).check()
  await action.getByRole('checkbox', { name: 'findings' }).check()
  await action.getByRole('checkbox', { name: 'remediation' }).check()
  await action
    .getByRole('combobox', { name: `Matching resource for ${SUGGESTED_WORKFLOW}` })
    .click()
  await page.getByRole('option', { name: /candidate A review pipeline/ }).click()
  await action.getByRole('button', { name: 'Submit and continue' }).click()

  const answersCard = page.getByTestId('intent-turn-answers')
  await expect(answersCard, '作答没变成一条历史 ⇒ 决定过程不可追').toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(answersCard.locator('.card__meta > span')).toHaveText('Me · Answers')
  await expect(
    answersCard.locator('dt'),
    '答案卡片只列答案不列问题 ⇒ 回头看时不知道这些选项当初回答的是什么',
  ).toHaveText([Q_SCOPE, Q_SECTIONS])
  await expect(
    answersCard.locator('dd'),
    '多选答案没按用户勾选的原样列出 ⇒ 用户无法核对 agent 收到的是不是自己选的',
  ).toHaveText(['Only this repository', 'findings, remediation'])

  // ---- 4) changeset：摘要 + 变更数 chip ----
  const changesetCard = page.getByTestId('intent-turn-changeset')
  await expect(changesetCard, '追问答完没有继续生成 ⇒ 会话卡在半路').toHaveCount(1, {
    timeout: 60_000,
  })
  await expect(
    changesetCard.locator('p'),
    'changeset 卡片不写摘要与变更数 ⇒ 时间线上分不出哪一轮提出了什么',
  ).toHaveText('stub intent build: one auditor agent 1 changes')

  // ---- 5) mount-approval：批准 / 拒绝两栏 ----
  // 这条 turn 由 POST /mount-approvals 产出（UI 走的是合并后的 current-action，
  // 老入口仍在契约里，时间线必须认得它渲染出来的那条历史）。
  const settledAfterChangeset = await waitForSettled(suggestDaemon, sessionId)
  const batch = settledAfterChangeset.mountSuggestions
  expect(batch, 'changeset 轮没有带出挂载建议 ⇒ 这条用例的前提没成立').not.toBeNull()
  await apiJson(suggestDaemon, `/api/intent-sessions/${sessionId}/mount-approvals`, {
    method: 'POST',
    body: JSON.stringify({
      sourceTurnId: batch!.sourceTurnId,
      expectedTurnSeq: batch!.sourceTurnSeq,
      expectedContextRevision: settledAfterChangeset.session.contextRevision,
      decisions: batch!.items.map((item) =>
        item.resourceType === 'agent'
          ? {
              resourceType: 'agent',
              name: item.name,
              action: 'approve',
              resourceId: suggestedAgentId,
            }
          : { resourceType: item.resourceType, name: item.name, action: 'reject' },
      ),
    }),
  })

  const approvalCard = page.getByTestId('intent-turn-mount-approval')
  await expect(approvalCard, '批准挂载没留下历史 ⇒ 谁在哪一轮放行了什么资源无从查').toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(approvalCard.locator('.card__meta > span')).toHaveText('Me · Mount approval')
  await expect(
    approvalCard.locator('strong'),
    '批准卡片不分「挂上了」与「跳过了」⇒ 两类决定被混成一堆',
  ).toHaveText(['Mounted', 'Skipped'])
  await expect(approvalCard.locator('li')).toHaveText([
    `${SUGGESTED_AGENT} · Agent`,
    `${SUGGESTED_WORKFLOW} · Workflow`,
    `${MISSING_SKILL} · Skill`,
  ])

  // ---- 6) error：诊断卡片 ----
  writeFileSync(suggestFailFile, 'fail')
  try {
    await page.getByTestId('intent-composer').fill('rfc319 make this turn fail')
    await page.getByTestId('intent-composer-submit').click()
    const errorCard = page.getByTestId('intent-turn-error')
    await expect(errorCard, '失败轮没有卡片 ⇒ 时间线上只剩一段静默').toHaveCount(1, {
      timeout: 60_000,
    })
    await expect(errorCard.locator('.card__meta > span')).toHaveText('Builder agent · Error')
    await expect(
      errorCard.getByTestId('intent-turn-error-diagnostic'),
      '失败轮不给诊断 ⇒ 用户只能重开会话',
    ).toBeVisible()
  } finally {
    rmSync(suggestFailFile, { force: true })
  }

  // ---- 7) 顺序与计数：六类各就各位，且与服务端轮次数对得上 ----
  await expect
    .poll(async () => timelineKinds(page), {
      timeout: 30_000,
      message: '时间线的卡片种类或顺序与真实轮次对不上',
    })
    .toEqual([
      'intent-turn-message',
      'intent-turn-questions',
      'intent-turn-answers',
      'intent-turn-changeset',
      'intent-turn-mount-approval',
      'intent-turn-message',
      'intent-turn-error',
    ])
  const finalDetail = await waitForSettled(suggestDaemon, sessionId)
  await expect(
    page.locator('.intent-session__conversation > .intent-session__section-header .status-chip'),
    '轮次计数与服务端的真实轮数对不上 ⇒ 那个数字是装饰',
  ).toHaveText(`${finalDetail.turns.length} turns`)
})

// ---------------------------------------------------------------------------
// INTENT-16
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-16: 取消生成——服务端轮次落成 intent-run-aborted，子进程真的死了（解除 hold 后不再改写结果） @nightly', async ({
  page,
}) => {
  writeFileSync(holdFile, 'held')
  await authPage(page, holdDaemon)
  const sessionId = await createSession(holdDaemon, 'rfc319 cancel generation')
  await page.goto(`${holdDaemon.baseUrl}/intent/${sessionId}`)

  // ---- 进行中的界面 ----
  await expect(
    page.getByTestId('intent-turn-running'),
    '在跑的轮次不进时间线 ⇒ 用户看不到「它正在做」',
  ).toHaveCount(1)
  await expect(page.getByTestId('loading-state')).toBeVisible()
  const cancel = page.getByRole('button', { name: 'Cancel generation' })
  await expect(cancel, '生成中不给取消入口 ⇒ 一轮跑错只能干等到超时').toBeVisible()
  await page.getByTestId('intent-composer').fill('should stay blocked')
  await expect(
    page.getByTestId('intent-composer-submit'),
    '生成中还能再发一轮 ⇒ 同一会话两轮并发',
  ).toBeDisabled()

  const before = await detailOf(holdDaemon, sessionId)
  expect(before.session.inFlight, '还没点取消，这一轮就已经不在飞了 ⇒ 前提没成立').toBe(true)
  const runningTurnId = lastAgentTurn(before)!.id

  // ---- 取消 ----
  const seen = await recordMutations(page, sessionId)
  await cancel.click()
  await expect
    .poll(async () => (await detailOf(holdDaemon, sessionId)).session.inFlight, {
      timeout: 30_000,
      message: '点了取消，服务端那一轮还挂在 in-flight ⇒ 按钮只是界面动作',
    })
    .toBe(false)
  expect(
    onlyMutation(seen, '取消发出的请求不是恰好一次 cancel-turn').pathname,
    '取消打到了别的入口',
  ).toBe(`/api/intent-sessions/${sessionId}/cancel-turn`)

  const canceled = await detailOf(holdDaemon, sessionId)
  const canceledTurn = canceled.turns.find((turn) => turn.id === runningTurnId)!
  expect(canceledTurn.kind, '被取消的轮次没落成错误轮').toBe('error')
  expect(canceledTurn.content.code, '取消没有留下可辨认的原因码').toBe('intent-run-aborted')

  // ---- 界面同步收敛 ----
  await expect(page.getByTestId('loading-state'), '取消后还在转圈 ⇒ 用户以为它还在跑').toHaveCount(
    0,
  )
  await expect(cancel, '取消完按钮还挂着 ⇒ 再点一次只会拿到「没有在飞的轮次」').toHaveCount(0)
  const abortedCard = page.getByTestId('intent-turn-error-diagnostic')
  await expect(
    abortedCard.locator('.status-chip'),
    '取消后时间线不说明这一轮为什么停了 ⇒ 历史上只剩一条无来由的失败',
  ).toHaveText('intent-run-aborted')
  await expect(
    abortedCard.locator('p').first(),
    '停下来的轮次不给下一步 ⇒ 用户不知道能不能接着来',
  ).toHaveText(
    "Open this turn's execution events, then retry. Use the evidence below if it repeats.",
  )

  // ---- 子进程是不是真的死了 ----
  // hold 解除后，若那条 runtime 子进程还活着，它会走完并 settle：inFlight 槽已经
  // 被取消让出，settle 会把这条 turn 改写成 intent-context-superseded；若槽还在，
  // 它甚至会产出一份草稿。两种形态都会让下面的断言红。
  rmSync(holdFile, { force: true })
  await page.waitForTimeout(3_000)
  const afterRelease = await detailOf(holdDaemon, sessionId)
  expect(
    afterRelease.turns.find((turn) => turn.id === runningTurnId)?.content.code,
    '解除 hold 后那条轮次被改写了 ⇒ 取消只停了界面，子进程还在跑完并回写结果',
  ).toBe('intent-run-aborted')
  expect(afterRelease.currentDraft, '被取消的那一轮最后还是产出了草稿 ⇒ 它根本没停').toBeNull()
  expect(afterRelease.turns.length, '取消之后凭空多出了轮次').toBe(canceled.turns.length)

  // ---- 正向对照：会话没有被取消卡死，下一轮照常能跑 ----
  await page.getByTestId('intent-composer').fill('rfc319 continue after cancel')
  await page.getByTestId('intent-composer-submit').click()
  await expect(
    page.getByTestId('intent-draft'),
    '取消之后会话再也发不出下一轮 ⇒ 取消把会话弄死了',
  ).toBeVisible({ timeout: 60_000 })
})

// ---------------------------------------------------------------------------
// INTENT-17
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-17: 失败轮的诊断卡片（分类标题 + 建议 + 三行证据）与「Retry turn」重跑成功 @nightly', async ({
  page,
}) => {
  const failFile = join(scratchDir, 'retry.fail')
  writeFileSync(failFile, 'fail')
  const failDaemon = await startDaemon({
    stubMode: 'intent',
    extraEnv: { STUB_INTENT_FAIL_FILE: failFile },
  })
  try {
    await authPage(page, failDaemon)
    const sessionId = await createSession(failDaemon, 'rfc319 failing turn')
    const failed = await waitForSettled(failDaemon, sessionId, '失败轮没落定')
    const failedTurn = lastAgentTurn(failed)!
    expect(failedTurn.kind, '注入的失败没有把这一轮打成错误轮 ⇒ 前提没成立').toBe('error')
    expect(failedTurn.content.code).toBe('intent-envelope-missing')

    await page.goto(`${failDaemon.baseUrl}/intent/${sessionId}`)
    const card = page.getByTestId('intent-turn-error-diagnostic')
    await expect(card, '失败轮没有诊断卡片').toBeVisible()
    await expect(
      card.locator('.status-chip'),
      '诊断不带原始错误码 ⇒ 用户报障时说不清是哪一类失败',
    ).toHaveText('intent-envelope-missing')
    await expect(
      card.locator('.intent-turn-error__heading strong'),
      '诊断标题没有把失败分类翻成人话 ⇒ 卡片上只剩一个错误码',
    ).toHaveText('Assistant output stopped before the result envelope')
    await expect(
      card.locator('p').first(),
      '诊断不给下一步 ⇒ 用户只知道坏了，不知道能做什么',
    ).toHaveText(
      'Retry with a smaller turn and require each batch to submit a complete envelope first.',
    )
    const evidence = card.locator('.intent-turn-error__evidence li')
    await expect(evidence, '诊断证据行缺失 ⇒ 判因只能靠猜').toHaveCount(3)
    await expect(evidence.nth(0)).toHaveText(/^Assistant text: .+ observed, .+ retained$/)
    await expect(evidence.nth(1)).toHaveText(/^Last event: normalized .+; runtime .+$/)
    // stub 只吐一条 text 事件就退出，没有 runtime 终局事件——分类器正是据此把这
    // 一类失败判成 `assistant-stopped-without-envelope`（intent-failure-diagnostic.ts:134-135）。
    await expect(evidence.nth(2)).toHaveText('Runtime terminal result: not observed')
    await expect(
      card.getByText(/diagnostic scratch is retained/),
      '失败现场保留了却不告诉用户 ⇒ 没人知道还能去捞',
    ).toBeVisible()
    // 评审面同步进入「需要处理」态，而不是继续显示「等待草稿」。
    await expect(page.getByRole('heading', { name: 'Generation needs attention' })).toBeVisible()

    // ---- 重试 ----
    rmSync(failFile, { force: true })
    const seen = await recordMutations(page, sessionId)
    const retry = card.getByRole('button', { name: 'Retry turn' })
    await expect(retry, '失败轮不给重跑入口 ⇒ 用户只能另开一个会话').toBeVisible()
    await retry.click()

    await expect(
      page.getByTestId('intent-draft'),
      '重跑之后仍然出不来草稿 ⇒ 「Retry turn」是个死按钮',
    ).toBeVisible({ timeout: 60_000 })
    const request = onlyMutation(seen, '一次重跑发出的请求不是恰好一条 /retry')
    expect(request.pathname).toBe(`/api/intent-sessions/${sessionId}/retry`)
    const payload = JSON.parse(request.body) as Record<string, unknown>
    expect(payload.sourceTurnId, '重跑没带上失败轮的身份 ⇒ 并发下会重跑错的那一轮').toBe(
      failedTurn.id,
    )
    expect(payload.expectedTurnSeq, '重跑没带上乐观锁 ⇒ 会话被别处推进后仍会照跑').toBe(
      failedTurn.seq,
    )

    const after = await waitForSettled(failDaemon, sessionId)
    expect(lastAgentTurn(after)?.kind, '重跑之后最后一轮仍不是成功的 changeset').toBe('changeset')
    expect(
      after.turns.some((turn) => turn.id === failedTurn.id && turn.kind === 'error'),
      '重跑把失败轮从历史里抹掉了 ⇒ 出过什么事再也查不到',
    ).toBe(true)
    expect(after.retrySource, '重跑成功后仍然指着一个可重跑的失败轮').toBeNull()
    await expect(
      page.getByRole('button', { name: 'Retry turn' }),
      '重跑成功后旧失败卡片还留着重跑按钮 ⇒ 点下去只会撞 409',
    ).toHaveCount(0)
  } finally {
    rmSync(failFile, { force: true })
    await failDaemon.stop()
  }
})

// ---------------------------------------------------------------------------
// INTENT-18
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-18: AI 追问——单选互斥、多选可多选，答完才放行，答案原样进服务端 @nightly', async ({
  page,
}) => {
  await authPage(page, questionsDaemon)
  const sessionId = await createSession(questionsDaemon, 'rfc319 answer questions')
  await waitForSettled(questionsDaemon, sessionId, '追问轮没落定')
  await page.goto(`${questionsDaemon.baseUrl}/intent/${sessionId}`)

  const action = page.getByTestId('intent-current-action')
  await expect(action, '有待答追问却不给作答面 ⇒ 会话卡死，用户无从推进').toBeVisible()
  const submit = action.getByRole('button', { name: 'Submit and continue' })
  await expect(submit, '一个问题都没答就能提交 ⇒ 空答案被当成用户的决定送进下一轮').toBeDisabled()
  await expect(
    page.getByTestId('intent-composer-submit'),
    '有待答追问时还能直接发消息 ⇒ 追问被绕过，agent 拿不到它要的决定',
  ).toBeDisabled()

  // ---- 多选：可以同时成立，也能取消 ----
  // 先答这一题、后答单选题，是为了让「只答了一题就放行」这条门有机会被观测到：
  // 两题都答完之后再断言禁用，是一条永远不会红的假断言。
  const sections = action.getByRole('group', { name: Q_SECTIONS })
  const findings = sections.getByRole('checkbox', { name: 'findings' })
  const severity = sections.getByRole('checkbox', { name: 'severity' })
  const remediation = sections.getByRole('checkbox', { name: 'remediation' })
  await findings.check()
  await severity.check()
  await expect(findings, '多选题选了第二项第一项就没了 ⇒ 它其实是单选').toBeChecked()
  await expect(severity).toBeChecked()
  await findings.uncheck()
  await expect(findings, '多选题的勾选取消不掉 ⇒ 选错了只能重开会话').not.toBeChecked()
  await remediation.check()
  await expect(submit, '还有一道题一个选项都没选就放行 ⇒ 空答案会被当成用户的决定').toBeDisabled()

  // ---- 单选：互斥 ----
  const scope = action.getByRole('group', { name: Q_SCOPE })
  const onlyThis = scope.getByRole('radio', { name: 'Only this repository' })
  const everyRepo = scope.getByRole('radio', { name: 'Every repository in the group' })
  await onlyThis.check()
  await expect(onlyThis).toBeChecked()
  await everyRepo.check()
  await expect(everyRepo).toBeChecked()
  await expect(onlyThis, '单选题选了第二项第一项还亮着 ⇒ 两个互斥答案同时成立').not.toBeChecked()
  await expect(submit, '两题都答完了仍不放行 ⇒ 用户被自己的答案挡在门外').toBeEnabled()

  // ---- 提交：请求体与服务端历史都必须是用户勾的那几项 ----
  const seen = await recordMutations(page, sessionId)
  await submit.click()
  await expect(action, '提交后作答面还挂着 ⇒ 用户会以为没提交成功而再答一遍').toHaveCount(0, {
    timeout: 30_000,
  })

  const request = onlyMutation(seen, '一次作答发出的请求不是恰好一条 /current-action')
  expect(request.pathname).toBe(`/api/intent-sessions/${sessionId}/current-action`)
  const payload = JSON.parse(request.body) as {
    answers: Array<{ id: string; picked: string[] }>
    decisions: unknown[]
  }
  expect(payload.answers, '提交的答案不是用户勾的那几项 ⇒ agent 收到的和用户答的是两回事').toEqual([
    { id: 'q-scope', picked: ['Every repository in the group'] },
    { id: 'q-sections', picked: ['severity', 'remediation'] },
  ])
  expect(payload.decisions, '这一轮没有挂载建议，却凭空带上了挂载决定').toEqual([])

  const after = await waitForSettled(questionsDaemon, sessionId)
  const answersTurn = after.turns.find((turn) => turn.kind === 'answers')
  expect(answersTurn, '作答没落成一条 answers 轮 ⇒ 下一轮 agent 读不到这些决定').toBeTruthy()
  expect(answersTurn!.content.answers, '落库的答案与用户勾选的不一致').toEqual([
    { id: 'q-scope', picked: ['Every repository in the group'] },
    { id: 'q-sections', picked: ['severity', 'remediation'] },
  ])
  expect(lastAgentTurn(after)?.kind, '答完追问没有继续生成 ⇒ 追问变成死路').toBe('changeset')
  await expect(
    page.getByTestId('intent-draft'),
    '答完之后草稿没出来 ⇒ 用户答了半天什么也没换来',
  ).toBeVisible({ timeout: 60_000 })
})

// ---------------------------------------------------------------------------
// INTENT-19
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-19: 挂载建议逐项批准/拒绝（多候选下拉 / 单候选 / 零候选告警），与作答**一次**原子提交 @nightly', async ({
  page,
}) => {
  await authPage(page, suggestDaemon)
  const sessionId = await createSession(suggestDaemon, 'rfc319 mount suggestions')
  const asked = await waitForSettled(suggestDaemon, sessionId, '追问轮没落定')
  expect(
    asked.mountSuggestions?.items.map((item) => `${item.resourceType}:${item.name}`),
    '三条挂载建议没有全部到达前端 ⇒ 这条用例的前提没成立',
  ).toEqual([
    `agent:${SUGGESTED_AGENT}`,
    `workflow:${SUGGESTED_WORKFLOW}`,
    `skill:${MISSING_SKILL}`,
  ])
  expect(asked.mounts, '会话一开始不该挂着任何资源').toHaveLength(0)

  await page.goto(`${suggestDaemon.baseUrl}/intent/${sessionId}`)
  const action = page.getByTestId('intent-current-action')
  const items = action.locator('.intent-session__mount-suggestion')
  await expect(items, '挂载建议没逐条渲染 ⇒ 用户只能整批盲批').toHaveCount(3)
  await expect(
    items.locator('.intent-session__mount-suggestion-heading strong'),
    '建议项不写资源名 ⇒ 用户不知道自己在批准什么',
  ).toHaveText([SUGGESTED_AGENT, SUGGESTED_WORKFLOW, MISSING_SKILL])
  await expect(
    items.nth(0).locator('p'),
    '建议不给理由 ⇒ 用户没有判断依据，只能一律放行',
  ).toHaveText('Reuse the existing auditor persona')

  // ---- 单候选：默认就挂，且把要挂的那一个摊开给用户看 ----
  const agentDecision = action.getByRole('radiogroup', { name: `Decision for ${SUGGESTED_AGENT}` })
  await expect(
    agentDecision.getByRole('radio', { name: 'Mount' }),
    '唯一候选也不预选「挂载」⇒ 每条建议都要用户多点一次',
  ).toHaveAttribute('aria-checked', 'true')
  await expect(
    items.nth(0).locator('.intent-session__mount-candidate'),
    '单候选不显示到底会挂上哪个资源 ⇒ 同名资源撞车时用户批了个盲盒',
  ).toContainText('existing auditor persona')

  // ---- 零候选：告警 + 「挂载」不可选，且默认落到「跳过」----
  const missingDecision = action.getByRole('radiogroup', { name: `Decision for ${MISSING_SKILL}` })
  await expect(
    items
      .nth(2)
      .getByText('No matching resource is currently available to you; this item will be skipped.'),
    '拿不到候选却不告警 ⇒ 用户以为挂上了，下一轮 agent 却看不到它',
  ).toBeVisible()
  const missingMount = missingDecision.getByRole('radio', { name: 'Mount' })
  await expect(missingMount, '零候选还让选「挂载」⇒ 提交时必然 404').toBeDisabled()
  // 「灰着」与「灰着也点不动」是两件事（docs/dev-gotchas.md）：不 force 的点击会被
  // Playwright 的可操作性检查挡下来，那样这条断言什么都没锁住。
  await missingMount.click({ force: true })
  await expect(
    missingDecision.getByRole('radio', { name: 'Skip' }),
    '零候选项被点成了「挂载」⇒ 置灰只是画上去的',
  ).toHaveAttribute('aria-checked', 'true')

  // ---- 多候选：必须自己选一个，选之前不放行 ----
  const scope = action.getByRole('group', { name: Q_SCOPE })
  await scope.getByRole('radio', { name: 'Only this repository' }).check()
  const sections = action.getByRole('group', { name: Q_SECTIONS })
  await sections.getByRole('checkbox', { name: 'findings' }).check()
  const submit = action.getByRole('button', { name: 'Submit and continue' })
  await expect(
    submit,
    '多候选还没选就能提交 ⇒ 服务端拿到一个空 resourceId，整批决定被打回',
  ).toBeDisabled()

  const picker = action.getByRole('combobox', {
    name: `Matching resource for ${SUGGESTED_WORKFLOW}`,
  })
  await expect(picker, '多候选不给下拉 ⇒ 用户没有选择权').toBeVisible()
  await picker.click()
  const options = page.getByRole('option')
  await expect(
    options.filter({ hasText: /candidate [AB] review pipeline/ }),
    '同名的两个候选没有全列出来 ⇒ 用户只能挂到系统替他选的那个',
  ).toHaveCount(2)
  await page.getByRole('option', { name: /candidate B review pipeline/ }).click()
  await expect(submit, '选完候选仍不放行 ⇒ 用户被自己的决定挡住').toBeEnabled()

  // ---- 一次原子提交 ----
  const seen = await recordMutations(page, sessionId)
  await submit.click()
  await expect(action, '提交后作答面还挂着').toHaveCount(0, { timeout: 30_000 })

  const request = onlyMutation(
    seen,
    '「答案 + 挂载决定」不是一次请求发出去的 ⇒ 中间态里答案已入库、挂载还没批，' +
      '而下一轮 agent 已经被唤起，拿到的是半份上下文',
  )
  expect(request.pathname, '这一次提交没走合并入口').toBe(
    `/api/intent-sessions/${sessionId}/current-action`,
  )
  const payload = JSON.parse(request.body) as {
    answers: Array<{ id: string; picked: string[] }>
    decisions: Array<Record<string, unknown>>
  }
  expect(payload.answers, '同一个请求里没有带上答案 ⇒ 原子性只剩一半').toEqual([
    { id: 'q-scope', picked: ['Only this repository'] },
    { id: 'q-sections', picked: ['findings'] },
  ])
  expect(payload.decisions, '同一个请求里没有带上逐项批准/拒绝 ⇒ 原子性只剩一半').toEqual([
    {
      resourceType: 'agent',
      name: SUGGESTED_AGENT,
      action: 'approve',
      resourceId: suggestedAgentId,
    },
    {
      resourceType: 'workflow',
      name: SUGGESTED_WORKFLOW,
      action: 'approve',
      resourceId: suggestedWorkflowBId,
    },
    { resourceType: 'skill', name: MISSING_SKILL, action: 'reject' },
  ])

  // ---- 服务端真值：一条轮次同时承载答案与决定，上下文只推进一次 ----
  const after = await detailOf(suggestDaemon, sessionId)
  const answersTurn = after.turns.find((turn) => turn.kind === 'answers')!
  expect(answersTurn.content.answers, 'answers 轮没带答案').toBeTruthy()
  expect(
    answersTurn.content.mountDecisions,
    '答案与挂载决定落在了不同的轮次 ⇒ 它们不是一次事务写的',
  ).toBeTruthy()
  expect(
    after.turns.filter((turn) => turn.kind === 'mount-approval'),
    '挂载决定另外产生了一条 mount-approval 轮 ⇒ 这次提交被拆成了两笔',
  ).toHaveLength(0)
  expect(
    after.session.contextRevision - asked.session.contextRevision,
    '上下文被推进了不止一次 ⇒ 两条决定各改了一次上下文，中间那一刻是不一致的',
  ).toBe(1)
  expect(
    after.mounts.map((mount) => mount.resourceId).sort(),
    '最终挂上的资源与用户逐项的决定对不上',
  ).toEqual([suggestedAgentId, suggestedWorkflowBId].sort())
  expect(
    after.mounts.some((mount) => mount.resourceId === suggestedWorkflowAId),
    '用户在下拉里选的是 B，挂上去的却包含 A ⇒ 候选选择没生效',
  ).toBe(false)

  // ---- 界面同步：工作上下文条把两条挂载显示出来 ----
  await expect(
    page.locator('.intent-working-context-bar__title-row .status-chip'),
    '批准了挂载，工作上下文却没变 ⇒ 用户不知道下一轮 agent 能看到什么',
  ).toHaveText('2 mounted')
  await expect(page.locator('.intent-working-context-chip')).toHaveText([
    SUGGESTED_AGENT,
    SUGGESTED_WORKFLOW,
  ])
})

// ---------------------------------------------------------------------------
// INTENT-21
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-21: 每轮的执行详情面板——live/complete/incomplete 三态、事件数取自真实捕获、用户轮没有面板 @nightly', async ({
  page,
}) => {
  const execHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-intent-exec-'))
  const execHold = join(scratchDir, 'exec.hold')
  writeFileSync(execHold, 'held')
  let execDaemon = await startDaemon({
    stubMode: 'intent',
    home: execHome,
    extraEnv: { STUB_INTENT_HOLD_FILE: execHold },
  })
  try {
    await authPage(page, execDaemon)
    const sessionId = await createSession(execDaemon, 'rfc319 execution panel')
    await page.goto(`${execDaemon.baseUrl}/intent/${sessionId}`)

    // ---- live：在跑的那一轮默认展开，状态是 Live ----
    const runningCard = page.getByTestId('intent-turn-running')
    const livePanel = runningCard.locator('.intent-turn-session')
    await expect(livePanel, '在跑的轮次没有执行详情 ⇒ 卡住时没有任何现场可看').toBeVisible()
    await expect(
      livePanel.locator('.status-chip'),
      '在跑却不报 Live ⇒ 用户分不出「还在写」与「写完了」',
    ).toHaveText('Live')
    await expect(
      livePanel.getByRole('button', { name: /Execution/ }),
      '在跑的那一轮不默认展开 ⇒ 最需要看现场的时候要多点一次',
    ).toHaveAttribute('aria-expanded', 'true')

    // ---- 用户轮没有执行详情（负向对照：面板不是每张卡都挂一个）----
    await expect(
      page.getByTestId('intent-turn-message').locator('.intent-turn-session'),
      '用户消息也挂了执行详情 ⇒ 那个面板与真实执行无关',
    ).toHaveCount(0)

    // ---- complete：落定后状态转 Complete，事件数与服务端捕获对得上 ----
    rmSync(execHold, { force: true })
    const settled = await waitForSettled(execDaemon, sessionId)
    const agentTurn = lastAgentTurn(settled)!
    expect(agentTurn.execution?.captureState, '轮次落定了捕获状态还停在 live').toBe('complete')
    expect(
      agentTurn.execution!.lastEventSeq,
      '一轮跑完一个事件都没捕获到 ⇒ 现场是空的',
    ).toBeGreaterThan(0)

    const donePanel = page.getByTestId(`intent-turn-session-${agentTurn.id}`)
    await expect(donePanel.locator('.status-chip'), '跑完了还报 Live ⇒ 状态是写死的').toHaveText(
      'Complete',
      { timeout: 30_000 },
    )
    await expect(
      donePanel.locator('.intent-turn-session__count'),
      '面板上的事件数与服务端真实捕获数对不上 ⇒ 那个数字是装饰',
    ).toHaveText(`${agentTurn.execution!.lastEventSeq} events`)

    // ---- 折叠面板真的会去取事件流 ----
    // 先刷新：`IntentTurnSession` 的展开态是 `useState(props.defaultOpen)`（只认
    // 首次挂载），刚才那条轮次是**在跑的时候**挂载的，所以此刻仍然开着——这是
    // 产品行为，不是缺陷。折叠默认值只有在重新进入页面时才观察得到。
    const sessionViewPath = `/api/intent-sessions/${sessionId}/turns/${agentTurn.id}/session`
    const fetched: string[] = []
    await page.route(
      (url) => url.pathname === sessionViewPath,
      async (route) => {
        fetched.push(route.request().method())
        await route.continue()
      },
    )
    await page.reload()
    const toggle = donePanel.getByRole('button', { name: /Execution/ })
    await expect(
      toggle,
      '重新进入页面后，落定的轮次默认就展开 ⇒ 一屏全是展开的事件流',
    ).toHaveAttribute('aria-expanded', 'false')
    expect(fetched.length, '面板还收着就已经去拉事件流 ⇒ 一屏 N 条轮次会打出 N 个请求').toBe(0)
    await toggle.click()
    await expect(toggle, '点了展开没展开').toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(() => fetched.length, {
        timeout: 30_000,
        message: '展开执行详情没有去取这一轮的事件流 ⇒ 面板里是空的或旧的',
      })
      .toBeGreaterThan(0)
    await toggle.click()
    await expect(toggle, '再点一次收不回去').toHaveAttribute('aria-expanded', 'false')
    await page.unrouteAll({ behavior: 'wait' })

    // ---- incomplete：daemon 崩在轮次中间，重启后捕获降级为 incomplete + 告警 ----
    writeFileSync(execHold, 'held')
    const crashedSessionId = await createSession(execDaemon, 'rfc319 execution crash')
    await expect
      .poll(async () => (await detailOf(execDaemon, crashedSessionId)).session.inFlight, {
        timeout: 30_000,
        message: '第二条会话没有进入在飞状态 ⇒ 崩溃恢复的前提没成立',
      })
      .toBe(true)
    await execDaemon.killChild('SIGKILL')
    rmSync(execHold, { force: true })
    execDaemon = await startDaemon({ stubMode: 'intent', home: execHome })
    await authPage(page, execDaemon)

    const recovered = await detailOf(execDaemon, crashedSessionId)
    const recoveredTurn = lastAgentTurn(recovered)!
    expect(recoveredTurn.content.code, '重启后没把孤儿轮次结算掉').toBe('intent-run-daemon-restart')
    expect(
      recoveredTurn.execution?.captureState,
      '进程崩在半路，捕获却仍被当成完整的 ⇒ 用户会拿一份残缺事件流去判因',
    ).toBe('incomplete')

    await page.goto(`${execDaemon.baseUrl}/intent/${crashedSessionId}`)
    const brokenPanel = page.getByTestId(`intent-turn-session-${recoveredTurn.id}`)
    await expect(
      brokenPanel.locator('.status-chip'),
      '残缺的捕获在界面上和完整的长得一样',
    ).toHaveText('Incomplete')
    await brokenPanel.getByRole('button', { name: /Execution/ }).click()
    await expect(
      brokenPanel.getByText(
        'Some execution events could not be saved; this does not change the turn result.',
      ),
      '捕获残缺却不告警 ⇒ 用户把缺失的事件当成「没发生过」',
    ).toBeVisible()
  } finally {
    rmSync(execHold, { force: true })
    await execDaemon.stop()
    rmSync(execHome, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// INTENT-23
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-23: 「停止本轮并立即刷新」——当前轮落成 aborted，新一轮带着新挂载立刻起来 @nightly', async ({
  page,
}) => {
  writeFileSync(holdFile, 'held')
  await authPage(page, holdDaemon)
  const contextAgent = `e2e-intent-refresh-${Date.now().toString(36)}`
  await seedAgent(holdDaemon, contextAgent, 'context added mid-turn')
  const sessionId = await createSession(holdDaemon, 'rfc319 interrupt and refresh')
  await page.goto(`${holdDaemon.baseUrl}/intent/${sessionId}`)

  const before = await detailOf(holdDaemon, sessionId)
  expect(before.session.inFlight, '打断的前提是有一轮在飞').toBe(true)
  expect(before.mounts, '会话一开始不该挂着资源 —— 否则下面的「挂上了」是恒真的').toHaveLength(0)
  const interruptedTurnId = lastAgentTurn(before)!.id

  await page.getByTestId('intent-add-mount').click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByText(
      'You can queue this context for the next turn, or stop the current turn and refresh immediately.',
    ),
    '生成中打开工作上下文却不解释两个选项的区别 ⇒ 用户不知道点哪个',
  ).toBeVisible()
  const picker = dialog.getByTestId('intent-mount-picker')
  await picker.focus()
  await page.getByRole('option', { name: new RegExp(contextAgent) }).click()
  await picker.press('Escape')
  // 选中后弹窗要重渲染一次；等它落定再点，否则会撞上「element was detached」。
  await expect(dialog.getByText(new RegExp(contextAgent))).toBeVisible({ timeout: 15_000 })

  const seen = await recordMutations(page, sessionId)
  await dialog.getByTestId('intent-working-context-interrupt').click()

  await expect
    .poll(
      async () => {
        const detail = await detailOf(holdDaemon, sessionId)
        return detail.turns.find((turn) => turn.id === interruptedTurnId)?.kind ?? 'running'
      },
      {
        timeout: 30_000,
        message: '点了「停止本轮并立即刷新」，被打断的那一轮还在跑 ⇒ 两轮并发烧 token',
      },
    )
    .toBe('error')

  const request = onlyMutation(seen, '一次打断发出的请求不是恰好一条 /working-set')
  expect(request.pathname).toBe(`/api/intent-sessions/${sessionId}/working-set`)
  expect(
    (JSON.parse(request.body) as { mode?: string }).mode,
    '按钮发出的不是 interrupt ⇒ 点的是「停止并刷新」，做的是「排队等下一轮」',
  ).toBe('interrupt')

  const afterInterrupt = await detailOf(holdDaemon, sessionId)
  expect(
    afterInterrupt.turns.find((turn) => turn.id === interruptedTurnId)?.content.code,
    '被打断的那一轮没有落成「被中止」',
  ).toBe('intent-run-aborted')
  expect(
    afterInterrupt.mounts.map((mount) => mount.displayName),
    '打断了但新上下文没挂上 ⇒ 「刷新」这一半没有发生',
  ).toEqual([contextAgent])
  expect(
    afterInterrupt.session.contextRevision - before.session.contextRevision,
    '上下文没有推进 ⇒ 新一轮读到的还是旧上下文',
  ).toBeGreaterThan(0)
  const nextTurn = lastAgentTurn(afterInterrupt)!
  expect(nextTurn.id, '打断之后没有立刻起新一轮 ⇒ 用户得自己再发一次消息').not.toBe(
    interruptedTurnId,
  )
  expect(nextTurn.kind, '新一轮没有在飞').toBe('running')
  expect(afterInterrupt.session.inFlight).toBe(true)

  // ---- 界面同步 + 新一轮真的跑完 ----
  await expect(
    page.locator('.intent-working-context-bar__title-row .status-chip'),
    '工作上下文条没跟上 ⇒ 用户不知道刷新有没有生效',
  ).toHaveText('1 mounted', { timeout: 30_000 })
  rmSync(holdFile, { force: true })
  await expect(
    page.getByTestId('intent-draft'),
    '刷新起来的那一轮跑不出草稿 ⇒ 打断把会话弄停了',
  ).toBeVisible({ timeout: 60_000 })
})

// ---------------------------------------------------------------------------
// INTENT-X4
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-X4: 翻历史时新 turn 不抢滚动位置，「回到最新」点一下回底并重新贴底 @nightly', async ({
  page,
}) => {
  await authPage(page, plainDaemon)
  const sessionId = await createSession(plainDaemon, 'rfc319 return to latest')
  await waitForSettled(plainDaemon, sessionId)
  for (const text of ['rfc319 scroll fill 1', 'rfc319 scroll fill 2', 'rfc319 scroll fill 3']) {
    await apiJson(plainDaemon, `/api/intent-sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    })
    await waitForSettled(plainDaemon, sessionId)
  }

  // 媒体特性先自证生效，否则「立即跳」那一支根本没被走到，用例是恒绿的假保护
  // （docs/dev-gotchas.md §test.use({ reducedMotion }) 在本仓不生效）。
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${plainDaemon.baseUrl}/intent/${sessionId}`)
  expect(
    await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    '浏览器没有报告 reduced-motion ⇒ 这条用例根本没走到那一支',
  ).toBe(true)

  const timeline = conversation(page)
  await expect(page.locator('.intent-turn-card')).toHaveCount(8)
  const returnLatest = page.getByRole('button', { name: 'Return to latest' })

  const metrics = async (): Promise<{ scrollTop: number; distanceToBottom: number }> =>
    timeline.evaluate((el) => ({
      scrollTop: el.scrollTop,
      distanceToBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }))

  /**
   * 「最新一轮在不在可视区里」——这才是用户真正在意的量。
   *
   * 不用「离底距离 ≈ 0」当判据：最后一轮的执行详情面板默认展开，事件流是异步
   * 到达的，卡片会在回底之后继续长高（实测 +220px）。那会让一条正确的产品行为
   * 被判红，而它本身与「有没有回到最新」无关。
   */
  const newestTurnInView = async (): Promise<boolean> =>
    timeline.evaluate((el) => {
      const cards = el.querySelectorAll<HTMLElement>('.intent-turn-card')
      const last = cards[cards.length - 1]
      if (last === undefined) return false
      const view = el.getBoundingClientRect()
      const card = last.getBoundingClientRect()
      return card.top < view.bottom && card.bottom > view.top
    })

  const initial = await metrics()
  expect(
    initial.scrollTop,
    '时间线根本不需要滚动 ⇒ 这条用例的前提没成立（回到最新按钮永远不会出现）',
  ).toBeGreaterThan(0)
  expect(
    initial.distanceToBottom,
    '打开会话没有停在最新一轮 ⇒ 用户每次进来都要自己滚到底',
  ).toBeLessThan(96)
  await expect(returnLatest, '已经贴在底部还挂着「回到最新」⇒ 按钮永远在，等于没有').toHaveCount(0)
  expect(await newestTurnInView(), '打开会话时最新一轮不在可视区里').toBe(true)

  // ---- 往回翻历史 ----
  await timeline.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(
    returnLatest,
    '只是往回翻了一下就弹出「回到最新」⇒ 读历史时始终有个按钮压在内容上',
  ).toHaveCount(0)
  // 负向对照：翻到顶之后最新一轮**必须**离开可视区，否则下面「回到最新」的断言恒真。
  expect(
    await newestTurnInView(),
    '滚到最顶端了，最新一轮还在可视区里 ⇒ 这个观测量分辨不出任何事',
  ).toBe(false)

  // ---- 新一轮到达：不许把用户拽回底部，但要给出回去的入口 ----
  await apiJson(plainDaemon, `/api/intent-sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message: 'rfc319 arrives while reading history' }),
  })
  await expect(
    returnLatest,
    '新一轮到了却不给「回到最新」⇒ 用户不知道下面有新内容，也没有一键回去的路',
  ).toBeVisible({ timeout: 30_000 })
  const whileReading = await metrics()
  expect(whileReading.scrollTop, '新一轮到达把正在读历史的用户拽回了底部 ⇒ 一句话都读不完').toBe(0)
  expect(await newestTurnInView(), '新一轮到达时视图被拉到了最新一轮上').toBe(false)

  // ---- 点一下回到底部并重新贴底 ----
  await returnLatest.click()
  await expect
    .poll(newestTurnInView, {
      timeout: 15_000,
      message: '点了「回到最新」，最新一轮仍然不在可视区里 ⇒ 按钮点了个寂寞',
    })
    .toBe(true)
  await expect(returnLatest, '回到底部之后按钮还挂着 ⇒ 它不再有意义却一直挡着内容').toHaveCount(0)

  // ---- 重新贴底：此后新到的轮次不再需要用户手动滚 ----
  //
  // 判据是「时间线自己跟着往下走了」，不是「离底距离归零」：最后一轮的执行详情
  // 面板默认展开且异步填充，贴底滚完之后内容还会继续长高（实测 +471px），
  // 拿离底距离当判据会把一条正确的产品行为判红。丢了贴底状态的形态恰恰相反 ——
  // scrollTop 一动不动，而且「回到最新」会再次弹出来。
  const afterReturn = await metrics()
  await waitForSettled(plainDaemon, sessionId)
  await apiJson(plainDaemon, `/api/intent-sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message: 'rfc319 after returning to latest' }),
  })
  await expect
    .poll(async () => page.locator('.intent-turn-card').count(), {
      timeout: 30_000,
      message: '回到最新之后新一轮没有进时间线',
    })
    .toBeGreaterThan(10)
  await expect
    .poll(async () => (await metrics()).scrollTop, {
      timeout: 15_000,
      message:
        '回到最新之后新一轮到达，时间线却纹丝不动 ⇒ 贴底状态没有被恢复，' +
        '此后每来一轮都要用户再手动滚一次',
    })
    .toBeGreaterThan(afterReturn.scrollTop)

  // 这里**不**断言「按钮不再出现」：最后一轮的执行详情面板异步长高，会把离底
  // 距离顶过产品自己的 96px 贴底阈值（intent.detail.tsx:455），于是 onScroll 把
  // 贴底标记清掉、按钮合法地再次弹出。那是内容增长的后果，与「点击有没有恢复
  // 贴底」无关；照着写会把一条正确的产品行为钉成期望。真正区分两者的判据是上面
  // 那条：贴底状态没恢复时 scrollTop 会**一动不动**（正如前面「读历史时新一轮
  // 到达」那一步观测到的 0）。
})

// ---------------------------------------------------------------------------
// INTENT-X8 补漏 —— 「排队中的上下文后继」这一半。
//
// INTENT-21 已经锁住了另一半：daemon 崩在轮次中间，重启把孤儿轮结算掉、捕获降级
// 为 incomplete。但那条链路只走到「把死掉的那一轮收尾」为止。真正会让用户看到
// **永远转圈**的是它的后半段：
//
//   人在生成中打开工作上下文，选了「排队到下一轮」（`IntentMountDialog.tsx:160-168`
//   的 `after-current`）。这条变更落成一行 `state='queued'`，它的执行时机被挂在
//   **当前轮跑完时的那次唤醒上**（`dispatcher.ts:130-137` 的 finally）。进程要是
//   在这中间死掉，那次唤醒就永远不会发生——排队的那条变更没有任何人再碰它，会话
//   的旅程停在 `working-set-queued`（`journey.ts:38-39` 的 step 2「生成中」），
//   界面上是一枚「Refresh queued」的芯片和一条不会结束的生成。
//
// 兜住它的是 boot 上的 `resumeQueuedIntentWorkingSets`（`cli/start.ts:1041`，
// 实现在 `dispatcher.ts:148-171`）：它把所有 `queued` 行重新领一遍并派发后继。
// 这条用例锁的就是这一步——判据不是「没报错」，而是**排队时选的那个资源最后
// 真的挂上了、而且是重启之后自己挂上的**。
//
// 顺序上有一处必须成立：孤儿轮先结算、后继才领得走（`activateIntentWorkingSetChange`
// 在 `session.inFlightTurnId !== null` 时直接返回 null，workingSet.ts:300/333）。
// 这两步在 boot 上就是相邻两行（start.ts:1039-1041），谁被挪到前面都会让这条用例红。
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-X8: daemon 崩在生成中时，排队中的工作上下文后继在重启后被接着跑完——会话不会永远停在「生成中」 @nightly', async ({
  page,
}) => {
  const queuedHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-intent-queued-'))
  const queuedHold = join(scratchDir, 'queued.hold')
  writeFileSync(queuedHold, 'held')
  let queuedDaemon = await startDaemon({
    stubMode: 'intent',
    home: queuedHome,
    extraEnv: { STUB_INTENT_HOLD_FILE: queuedHold },
  })

  /** 这条会话当前那行工作上下文变更的状态（`routes/intentSessions.ts:488-489`）。 */
  const workingSetState = async (d: DaemonHandle, sessionId: string): Promise<string | null> => {
    const detail = await apiJson<{ workingSetChange: { state: string } | null }>(
      d,
      `/api/intent-sessions/${sessionId}`,
    )
    return detail.workingSetChange?.state ?? null
  }

  try {
    await authPage(page, queuedDaemon)
    const contextAgent = `e2e-intent-queued-${Date.now().toString(36)}`
    await seedAgent(queuedDaemon, contextAgent, 'queued successor fixture')
    const sessionId = await createSession(queuedDaemon, 'rfc319 queued working context')
    await page.goto(`${queuedDaemon.baseUrl}/intent/${sessionId}`)

    const before = await detailOf(queuedDaemon, sessionId)
    expect(before.session.inFlight, '排队的前提是有一轮正在飞').toBe(true)
    expect(before.mounts, '会话一开始不该挂着资源 —— 否则下面的「挂上了」是恒真的').toHaveLength(0)
    const turnsBefore = before.turns.length

    // ---- 排队（而不是打断）----
    await page.getByTestId('intent-add-mount').click()
    const dialog = page.getByRole('dialog')
    const picker = dialog.getByTestId('intent-mount-picker')
    await picker.focus()
    await page.getByRole('option', { name: new RegExp(contextAgent) }).click()
    await picker.press('Escape')
    // 选中后弹窗会重渲染一次；等它落定再点，否则会撞上「element was detached」。
    await expect(dialog.getByText(new RegExp(contextAgent))).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Refresh after this turn', exact: true }).click()

    // 落成一行 queued，而且当前那一轮**没有**被打断——「排队」与「立即刷新」是
    // 弹窗里并排的两个按钮，接错线的话用户点的是「不打断」、发生的却是「打断」。
    await expect
      .poll(async () => workingSetState(queuedDaemon, sessionId), {
        timeout: 30_000,
        message: '选了「排队到下一轮」，服务端却没有一行排队中的变更',
      })
      .toBe('queued')
    expect(
      (await detailOf(queuedDaemon, sessionId)).session.inFlight,
      '「排队到下一轮」把当前轮打断了 ⇒ 用户点的是不打断的那个按钮',
    ).toBe(true)
    await expect(
      page.getByText('Refresh queued', { exact: true }),
      '排上队了界面却不说 ⇒ 人不知道自己那次改动到底进没进去',
    ).toBeVisible({ timeout: 30_000 })

    // ---- 崩在这里：那次「当前轮跑完时的唤醒」永远不会发生 ----
    await queuedDaemon.killChild('SIGKILL')
    rmSync(queuedHold, { force: true })
    queuedDaemon = await startDaemon({ stubMode: 'intent', home: queuedHome })

    // ① 排队的那条变更被接着做完，选的那个资源真的挂上了。
    //    没人接手时它会一直是 'queued'，而 mounts 永远是空的。
    await expect
      .poll(async () => workingSetState(queuedDaemon, sessionId), {
        timeout: 120_000,
        message: '重启之后那行变更还停在排队中 ⇒ 没有任何东西会再碰它，会话就永远停在「生成中」',
      })
      .toBe('applied')
    const recovered = await waitForSettled(
      queuedDaemon,
      sessionId,
      '重启之后这条会话一直停在生成中 ⇒ 用户看到的就是一个永远转圈的会话',
    )
    expect(
      recovered.mounts.map((mount) => mount.displayName),
      '排队时选的那个资源没有挂上 ⇒ 那次改动被静默丢弃，而用户以为它已经生效了',
    ).toContain(contextAgent)
    // ② 后继**真的跑了一轮**，不是只把 DB 里的挂载表改了一下就算数：
    //    排队的语义是「下一轮带着新上下文重跑」，少了这一半用户还得自己再发一次。
    expect(
      recovered.turns.length,
      '重启之后没有任何新轮次 ⇒ 上下文换了、却没有人拿它重跑，等于什么都没发生',
    ).toBeGreaterThan(turnsBefore)

    // ③ 界面这一路：重新进这一页，排队芯片不见了、挂载芯片在，而这一切用户
    //    一步都没有操作过。
    await authPage(page, queuedDaemon)
    await page.goto(`${queuedDaemon.baseUrl}/intent/${sessionId}`)
    await expect(
      page.locator('.intent-working-context-chip'),
      '恢复之后页面上仍看不到那个挂载 ⇒ 用户只能靠自己重新加一遍',
    ).toHaveText([contextAgent])
    await expect(
      page.getByText('Refresh queued', { exact: true }),
      '已经做完了还挂着「Refresh queued」⇒ 界面停在一个不存在的等待上',
    ).toHaveCount(0)
  } finally {
    rmSync(queuedHold, { force: true })
    await queuedDaemon.stop()
    rmSync(queuedHome, { recursive: true, force: true })
  }
})
