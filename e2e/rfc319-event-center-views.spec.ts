// RFC-319 —— 事件中心的「界面与审计视图」用户面验收
// （EVENT-24 / 25 / 26 / 29 / 32 / 33 / 34 / X6 / X7）。
//
// 这一批锁的全是**只读观测面**：总览卡片、来源树、订阅审计、投递审计、事件记录审计。
// 只读面失效的方式和写面完全不同，而且更安静：
//
//   ① 过滤器「看起来生效了」。用户点了「已确认」，列表刷新了、行数变了，于是他相信
//      屏幕上剩下的就是全部已确认的投递。真实故障是过滤条件根本没传到服务端（或传错了
//      维度），剩下的那一屏其实是别的东西——**没有任何报错**，用户拿着一个错误的结论去
//      排查线上问题。所以本文件里每一条过滤断言都必须同时验两件事：
//      **该留的留下了** 且 **该走的真的不在了**（换个筛选条件，结果集合真的换了一批）。
//   ② 汇总数字对不上任何东西。四张卡片是用户对「事件中心现在忙不忙」的唯一直觉来源，
//      而它们各自的口径（有效订阅要不要算已取消的、待处理投递算不算 claimed）没有任何
//      外部反馈能纠正——错了就一直错，且错得很像对的。
//   ③ 兼容重定向落错了页签。老书签 /webhooks?tab=triggers 是很多人手里唯一的入口；
//      它跳到 /events 但落在「事件总览」而不是「实时订阅」，用户会以为触发规则被删了。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown
// link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//
//   * 事件中心四页签与 search 归一化：packages/frontend/src/routes/events.tsx:35-63、506-548
//   * 四张汇总卡片的口径：packages/frontend/src/routes/events.tsx:589-612
//     （待处理投递只数**当前页** items，且只认 pending / claimed）
//   * 来源树的观察器健康三分支：packages/frontend/src/routes/events.tsx:667-700
//   * 有效订阅数 = 各来源 subscriptionCount 之和：packages/frontend/src/routes/events.tsx:512-515、593-595
//   * subscriptionCount = 精确活跃 + 路由目录活跃：
//     packages/backend/src/modules/event-center/application/eventCenterService.ts:318-344
//   * 订阅审计：统一分页 + 消费者精确筛选：packages/frontend/src/routes/events.tsx:900-995
//     服务端合并（exact 表 + 路由目录）：eventCenterService.ts:352-403
//     SQL 侧只取 mode='exact' 且 subscriberRef 用 eq：
//     packages/backend/src/modules/event-center/infrastructure/sqliteEventStore.ts:575-597
//   * 投递记录：状态 Segmented + 消费者筛选 + 分页：packages/frontend/src/routes/events.tsx:1030-1135
//     服务端过滤：sqliteEventStore.ts:829-868（state / subscriberRef 均为 eq）
//   * 全局事件记录：只出 catalogVisibility='public' 的事件类型：
//     sqliteEventStore.ts:894-937（两处 join 都带 eq(catalogVisibility,'public')）
//   * 事件来源下拉的选项源 = catalog.sources：packages/frontend/src/routes/events.tsx:1155-1172
//   * Webhook 投递审计的三个过滤维度：packages/frontend/src/components/webhooks/DeliveriesPanel.tsx:98-140、166-231
//   * 仓库下拉的选项源 = /api/webhook-deliveries/repos（投递里出现过的仓库，非平台仓库表）：
//     packages/backend/src/routes/webhookDeliveries.ts:121-146（递归 CTE loose index scan，天然升序）
//   * 服务端过滤 + ULID tie-break 翻页：packages/backend/src/routes/webhookDeliveries.ts:56-118
//   * 投递详情：原始 body + 终态控制审计 + 不可见任务计数：
//     packages/backend/src/routes/webhookDeliveries.ts:148-238（hiddenTargetCount 的两条分支）
//     渲染：packages/frontend/src/components/webhooks/DeliveriesPanel.tsx:395-540
//   * canViewTask（不可见任务的判据）：packages/backend/src/services/taskCollab.ts:39-48
//   * 触发规则启停开关 / 删除：packages/frontend/src/components/webhooks/TriggersPanel.tsx:735-800
//   * 停用后不再进入匹配（enabled=true 是 SQL 级筛选）：
//     packages/backend/src/services/webhook/webhookDispatch.ts:1180-1185
//   * 删除的 fires / streams 级联（FK ON DELETE CASCADE + 运行时 foreign_keys=ON）：
//     packages/backend/src/db/schema.ts:1412-1466、packages/backend/src/db/client.ts:243-250
//     服务层只删主行：packages/backend/src/services/webhookTriggers.ts:373-381
//   * /webhooks 三条兼容重定向：packages/frontend/src/routes/webhooks.tsx:26-53
//   * 触发规则草稿撤销 / 重做：packages/frontend/src/components/webhooks/webhookDraftHistory.ts:16-105
//     接线：packages/frontend/src/components/webhooks/TriggersPanel.tsx:964-989、1461-1484
//
// 与既有 spec 的分工（刻意不重叠）：
//   * e2e/rfc319-ui-primitives-a11y.spec.ts UX-X7 —— 同样站在 `/events?tab=deliveries`
//     的 Webhook 投递面板上，但它锁的是 **Pagination / FilterBar 两个原语本身**
//     （翻页键 / 跳页表单 / 状态分段 / 一键清除）。本文件的 EVENT-25 一次都不碰那四件事，
//     只补它没做的：**事件类型 / 仓库两个维度的过滤语义**、**仓库下拉的选项来源**、
//     以及**翻页前后两页行集合互不相交**（UX-X7 只数了行数，没验过 ULID tie-break）。
//   * e2e/rfc319-ui-primitives-a11y.spec.ts UX-15 —— 仓库下拉的**键盘状态机**。
//     本文件只读它的选项集合，不碰方向键 / type-ahead。
//   * e2e/rfc319-webhook-endpoints.spec.ts —— 端点配置面与入口面（EVENT-01…13）。
//   * e2e/webhook-trigger-matching.spec.ts —— EVENT-18/19（五维匹配 / 熔断）。本文件的
//     EVENT-24 借用同样的「建规则 → 投递 → 看 fires」姿势，但断言的是**启停与删除**，
//     不重复匹配语义。
//   * e2e/webhook-mr-runtime-races.spec.ts —— EVENT-14 与终态控制的**运行时竞态**。
//     本文件的 EVENT-26 只读它产出的那张审计表在**界面上**长什么样，且额外验了
//     rfc319-ui-primitives / mr-runtime-races 都没验过的「不可见任务计数」。
//   * packages/frontend/tests/webhook-draft-history.test.ts —— 撤销/重做**类本身**的单测。
//     本文件的 EVENT-X7 验的是它和向导控件的**接线**（按钮禁用态、打字合并、重做分支截断）。

import { expect, test, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'

import { querySqlite, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(240_000)

// ---------------------------------------------------------------------------
// 语料常量 —— 每一条断言的期望值都来自这里，不从服务端回读（回读等于恒真）。
// ---------------------------------------------------------------------------

/** 事件中心页内所有分页列表的页大小（events.tsx:161 EVENT_AUDIT_PAGE_SIZE）。 */
const EVENT_PAGE_SIZE = 50
/** Webhook 投递审计不传 limit ⇒ 后端默认 50（webhookDeliveries.ts:50）。 */
const WEBHOOK_PAGE_SIZE = 50

const ALPHA = 'rfc319-consumer-alpha'
const BRAVO = 'rfc319-consumer-bravo'
const CHARLIE = 'rfc319-consumer-charlie'

/** 精确订阅：alpha 52 条（employee-case）/ bravo 6 条（system，其中 1 条取消）/ charlie 3 条。 */
const ALPHA_SUBSCRIPTIONS = 52
const BRAVO_SUBSCRIPTIONS = 6
const CHARLIE_SUBSCRIPTIONS = 3
const CANCELLED_SUBSCRIPTIONS = 1
/** 来源树上「有效订阅」应显示的数字：已取消的那一条不算。 */
const ACTIVE_APPROVAL_SUBSCRIPTIONS =
  ALPHA_SUBSCRIPTIONS + BRAVO_SUBSCRIPTIONS + CHARLIE_SUBSCRIPTIONS - CANCELLED_SUBSCRIPTIONS

/** 事件投递：alpha 52（48 待处理 / 2 处理中 / 1 已确认 / 1 处理失败）、bravo 3、charlie 3。 */
const ALPHA_DELIVERIES = 52
const ALPHA_CLAIMED = 2
const ALPHA_ACCEPTED = 1
const ALPHA_DEAD_LETTER = 1
const ALPHA_PENDING = ALPHA_DELIVERIES - ALPHA_CLAIMED - ALPHA_ACCEPTED - ALPHA_DEAD_LETTER
const BRAVO_DELIVERIES = 3
const CHARLIE_DELIVERIES = 3
const DEAD_LETTER_ERROR = 'rfc319 handler exploded'

/** 全局事件记录：approval 来源的公开事件条数 = 三个消费者的观察总数。 */
const APPROVAL_EVENTS = ALPHA_DELIVERIES + BRAVO_DELIVERIES + CHARLIE_DELIVERIES

/** Webhook 投递语料（按 receivedAt 由旧到新）。 */
const DELTA_TAG_DELIVERIES = 1
const BRAVO_PUSH_DELIVERIES = 3
const BRAVO_PIPELINE_DELIVERIES = 2
const ALPHA_AUDIT_DELIVERIES = 52
const BRAVO_AUDIT_DELIVERIES = BRAVO_PUSH_DELIVERIES + BRAVO_PIPELINE_DELIVERIES
/** 下拉选项应当**恰好**是这五个仓库，且升序（webhookDeliveries.ts:132-143 的 min() 递归）。 */
const DELIVERED_REPOS = [
  'alpha/audit',
  'bravo/audit',
  'delta/audit',
  'mr/audit',
  'trigger/audit',
] as const

const PLAIN_USER = 'rfc319_ec_viewer'
const PLAIN_PASSWORD = 'Rfc319EventCenter!1'

let daemon: DaemonHandle
let sequence = 0

/** beforeAll 里记下来、各用例直接引用的固定物。 */
let plainUserToken = ''
let mrTriggerId = ''
let mrTriggerName = ''
let toggleTriggerId = ''
let toggleEndpoint: MintedEndpoint
let mrClosedDeliveryId = ''
let mrOpenedDeliveryId = ''
let mrLaunchedTaskId = ''
let prunedDeliveryId = ''
let alphaDeliveryIds: string[] = []
let charlieDeliveryIds: string[] = []
let acceptedDeliveryId = ''
let deadLetterDeliveryId = ''

interface MintedEndpoint {
  id: string
  urlToken: string
  secret: string
}

// ---------------------------------------------------------------------------
// 夹具辅助
// ---------------------------------------------------------------------------

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function api<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const res = await req(path, init, token)
  const body = await res.text()
  expect(res.ok, `${init?.method ?? 'GET'} ${path}: HTTP ${res.status} ${body}`).toBe(true)
  return (body === '' ? null : JSON.parse(body)) as T
}

/** GitLab 事件体共用的 project 块；四个字段缺一不可（gitlabAdapter.ts:108-116）。 */
function project(repoPath: string): Record<string, unknown> {
  return {
    id: 42,
    path_with_namespace: repoPath,
    web_url: `https://gitlab.invalid/${repoPath}`,
    git_http_url: `https://gitlab.invalid/${repoPath}.git`,
    git_ssh_url: `git@gitlab.invalid:${repoPath}.git`,
  }
}

function pushBody(repoPath: string): string {
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'push',
    user: { username: 'rfc319-human' },
    project: project(repoPath),
    ref: 'refs/heads/main',
    before: `before${String(n)}`,
    after: `after${String(n)}`,
  })
}

function tagPushBody(repoPath: string): string {
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'tag_push',
    user: { username: 'rfc319-human' },
    project: project(repoPath),
    ref: 'refs/tags/v1',
    before: `before${String(n)}`,
    after: `after${String(n)}`,
  })
}

function pipelineFailedBody(repoPath: string): string {
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'pipeline',
    user: { username: 'rfc319-human' },
    project: project(repoPath),
    object_attributes: { id: n, status: 'failed', ref: 'main', sha: `sha${String(n)}` },
  })
}

/** `last_commit.id` 是 EVENT-26 用来证明「详情里那段 body 就是我发进去的原文」的锚。 */
const MR_CLOSE_COMMIT = 'rfc319-mr-close-commit'

function mergeRequestBody(action: 'open' | 'close'): string {
  return JSON.stringify({
    object_kind: 'merge_request',
    user: { id: 7001, username: 'rfc319-dev', name: 'RFC-319 Dev' },
    project: project('mr/audit'),
    object_attributes: {
      id: 4201,
      iid: 1,
      action,
      state: action === 'close' ? 'closed' : 'opened',
      title: 'rfc319 terminal control MR',
      source_branch: 'feature/rfc319',
      target_branch: 'main',
      url: 'https://gitlab.invalid/mr/audit/-/merge_requests/1',
      last_commit: { id: action === 'close' ? MR_CLOSE_COMMIT : 'rfc319-mr-open-commit' },
    },
  })
}

async function createEndpoint(name: string): Promise<MintedEndpoint> {
  return api<MintedEndpoint>('/api/webhook-endpoints', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

async function deliver(
  endpoint: MintedEndpoint,
  eventHeader: string,
  body: string,
): Promise<{ deliveryId: string }> {
  const res = await fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gitlab-token': endpoint.secret,
      'x-gitlab-event': eventHeader,
      'x-gitlab-event-uuid': `rfc319-ec-${String(++sequence)}`,
    },
    body,
  })
  const text = await res.text()
  expect(res.status, `webhook ingress rejected: ${res.status} ${text}`).toBe(200)
  return JSON.parse(text) as { deliveryId: string }
}

interface FireRow {
  id: string
  triggerId: string
  streamKey: string
  outcome: string
  taskId: string | null
}

async function firesOf(triggerId: string): Promise<FireRow[]> {
  return api<FireRow[]>(`/api/webhook-triggers/${triggerId}/fires`)
}

/** 投递的分发是异步的：等它离开 received / processing 才能对 fires 做否定断言。 */
async function waitForTerminalDelivery(deliveryId: string): Promise<{
  status: string
  statusReason: string | null
}> {
  let last: { status: string; statusReason: string | null } = {
    status: 'received',
    statusReason: null,
  }
  await expect
    .poll(
      async () => {
        const row = await api<{ status: string; statusReason: string | null }>(
          `/api/webhook-deliveries/${deliveryId}`,
        )
        last = { status: row.status, statusReason: row.statusReason }
        return last.status
      },
      {
        timeout: 60_000,
        message: `投递 ${deliveryId} 迟迟没有离开 received/processing —— 分发链路卡住了`,
      },
    )
    .not.toMatch(/^(received|processing)$/)
  return last
}

async function createSubscription(
  subjectRef: string,
  subscriberKind: 'employee-case' | 'system',
  subscriberRef: string,
): Promise<string> {
  const receipt = await api<{ subscriptionId: string }>('/api/event-center/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      eventTypeRef: { id: 'approval.status.changed', revision: 1 },
      subject: { typeId: 'external-approval', subjectRef },
      subscriber: { kind: subscriberKind, subscriberRef },
    }),
  })
  return receipt.subscriptionId
}

async function observe(subjectRef: string, dedupeKey: string, summary: string): Promise<string[]> {
  const receipt = await api<{ deliveryIds: string[] }>('/api/event-center/observations', {
    method: 'POST',
    body: JSON.stringify({
      sourceRef: { id: 'development.approval-state', revision: 1 },
      eventTypeRef: { id: 'approval.status.changed', revision: 1 },
      subject: { typeId: 'external-approval', subjectRef },
      occurredAt: Date.now(),
      dedupeKey,
      summary,
      payloadArtifactRef: null,
      triggerParameters: { subject_ref: subjectRef },
    }),
  })
  return receipt.deliveryIds
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 直接改投递状态。
 *
 * 平台自己的通知 worker 只认领 subscriberKind ∈ 已注册消费者的种类（当前只有
 * `automation`，见 eventCenterService.ts:668-676 与 cli/start.ts:820-822），所以
 * `employee-case` / `system` 两种消费者的投递不会被后台改动——种下的状态是稳定的。
 * 种完必须回读自证：`db.exec()` 对多语句脚本里的约束错误不抛异常（docs/dev-gotchas.md）。
 */
function setDeliveryState(ids: readonly string[], state: string, lastError?: string): void {
  if (ids.length === 0) throw new Error('setDeliveryState: 空 id 列表')
  const now = Date.now()
  const list = ids.map(sqlText).join(', ')
  runSqlite(
    dbPath(),
    `UPDATE event_deliveries SET state = ${sqlText(state)},` +
      ` accepted_at = ${state === 'accepted' ? String(now) : 'NULL'},` +
      ` dead_letter_at = ${state === 'dead-letter' ? String(now) : 'NULL'},` +
      ` claimed_by = ${state === 'claimed' ? sqlText('rfc319-worker') : 'NULL'},` +
      ` claim_expires_at = ${state === 'claimed' ? String(now + 600_000) : 'NULL'},` +
      ` last_error = ${lastError === undefined ? 'NULL' : sqlText(lastError)}` +
      ` WHERE id IN (${list});`,
  )
  const rows = querySqlite<{ id: string; state: string }>(
    dbPath(),
    `SELECT id, state FROM event_deliveries WHERE id IN (${list})`,
  )
  expect(rows.length, `种投递状态后回读行数对不上：${state}`).toBe(ids.length)
  for (const row of rows) expect(row.state, `投递 ${row.id} 的状态没有落库`).toBe(state)
}

async function primeAuth(page: Page, token?: string): Promise<void> {
  await page.addInitScript(
    ([baseUrl, tok]) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    [daemon.baseUrl, token ?? daemon.token] as const,
  )
}

function exactText(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`)
}

/** 打开一个自绘下拉并选中某个选项（Select.tsx:524-590，选项走 mousedown 提交）。 */
async function chooseOption(page: Page, triggerTestid: string, label: string): Promise<void> {
  await page.getByTestId(triggerTestid).click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  await listbox
    .locator('li[role="option"]')
    .filter({ has: page.locator('.select__option-label').filter({ hasText: exactText(label) }) })
    .click()
  await expect(listbox).toBeHidden()
}

/** 读一个自绘下拉的**全部**选项文案（下拉必须处于打开态之外——本函数自己开关）。 */
async function optionLabels(page: Page, triggerTestid: string): Promise<string[]> {
  await page.getByTestId(triggerTestid).click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  const labels = await listbox.locator('li[role="option"] .select__option-label').allInnerTexts()
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  return labels.map((text) => text.trim())
}

async function openEventsTab(page: Page, tab: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/events?tab=${tab}`)
  await expect(page.getByTestId('event-center-page')).toBeVisible()
}

/** 「投递记录」（消费者视角）—— deliveries 页签的默认视图。 */
async function openDeliveryRecords(page: Page): Promise<Locator> {
  await openEventsTab(page, 'deliveries')
  await expect(page.getByTestId('event-delivery-view-consumer')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  return page.getByTestId('event-delivery-list')
}

/** 「事件记录」（全局来源视角）。 */
async function openSourceEvents(page: Page): Promise<Locator> {
  await openEventsTab(page, 'deliveries')
  await page.getByTestId('event-delivery-view-source').click()
  const list = page.getByTestId('event-source-audit-list')
  await expect(list).toBeVisible()
  return list
}

/** 「Webhook事件」—— 适配器自己的原始入站审计面板。 */
async function openWebhookAudit(page: Page): Promise<Locator> {
  await openEventsTab(page, 'deliveries')
  await page.getByTestId('event-delivery-view-webhook').click()
  const panel = page.getByTestId('webhook-deliveries-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('webhook-deliveries-table')).toBeVisible()
  return panel
}

/** 「订阅审计」—— subscriptions 页签的第二个视图。 */
async function openSubscriptionAudit(page: Page): Promise<Locator> {
  await openEventsTab(page, 'subscriptions')
  await page.getByTestId('event-subscription-view-audit').click()
  const list = page.getByTestId('event-subscription-list')
  await expect(list).toBeVisible()
  return list
}

/** 汇总卡片的数字（events.tsx:589-612 的四张 Card）。 */
function summaryValue(page: Page, title: string): Locator {
  return page
    .locator('.event-center-summary .card')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) })
    .locator('.card__body strong')
}

/** 来源树上的一行来源。 */
function sourceRow(page: Page, displayName: string): Locator {
  return page
    .getByTestId('event-source-tree')
    .locator('li.event-source-tree__source')
    .filter({
      has: page.locator('.event-source-tree__source-row strong').filter({
        hasText: exactText(displayName),
      }),
    })
}

/** 当前列表页里每一行的 `data-testid`（Webhook 投递表用它做行身份）。 */
async function rowTestids(rows: Locator): Promise<string[]> {
  return rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''))
}

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  daemon = await startDaemon()

  // --- 只读观测账号（EVENT-26 的「不可见任务计数」要一个看不见别人任务的人）------
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: PLAIN_USER,
      displayName: 'RFC-319 Event Viewer',
      email: `${PLAIN_USER}@example.com`,
      role: 'user',
      password: PLAIN_PASSWORD,
    }),
  })
  const loginResponse = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: PLAIN_USER, password: PLAIN_PASSWORD }),
  })
  const loginBody = await loginResponse.text()
  expect(loginResponse.ok, `只读账号登录失败：${loginResponse.status} ${loginBody}`).toBe(true)
  plainUserToken = (JSON.parse(loginBody) as { sessionToken: string }).sessionToken

  // --- 事件中心：订阅 ---------------------------------------------------------
  // alpha 用 employee-case（列表里会渲染「查看任务」入口），bravo / charlie 用 system
  // （不渲染），两者一起把 events.tsx:963-971 的那条分支两边都走到。
  const alphaSubjects: string[] = []
  for (let i = 1; i <= ALPHA_SUBSCRIPTIONS; i += 1) {
    const subject = `appr-a-${String(i).padStart(3, '0')}`
    alphaSubjects.push(subject)
    await createSubscription(subject, 'employee-case', ALPHA)
  }
  const bravoSubjects: string[] = []
  const bravoSubscriptionIds: string[] = []
  for (let i = 1; i <= BRAVO_SUBSCRIPTIONS; i += 1) {
    const subject = `appr-b-${String(i).padStart(3, '0')}`
    bravoSubjects.push(subject)
    bravoSubscriptionIds.push(await createSubscription(subject, 'system', BRAVO))
  }
  const charlieSubjects: string[] = []
  for (let i = 1; i <= CHARLIE_SUBSCRIPTIONS; i += 1) {
    const subject = `appr-c-${String(i).padStart(3, '0')}`
    charlieSubjects.push(subject)
    await createSubscription(subject, 'system', CHARLIE)
  }
  // 取消最后一条 bravo 订阅：审计列表仍要列出它（已取消），汇总卡片不许再数它。
  await api(`/api/event-center/subscriptions/${bravoSubscriptionIds.at(-1)}`, { method: 'DELETE' })

  // --- 事件中心：观察 → 事件记录 + 投递 --------------------------------------
  alphaDeliveryIds = []
  for (let i = 1; i <= ALPHA_DELIVERIES; i += 1) {
    alphaDeliveryIds.push(
      ...(await observe(alphaSubjects[i - 1]!, `rfc319-a-${String(i)}`, `alpha approval ${i}`)),
    )
  }
  expect(alphaDeliveryIds.length, 'alpha 的投递条数与用例预期不一致').toBe(ALPHA_DELIVERIES)
  for (let i = 1; i <= BRAVO_DELIVERIES; i += 1) {
    await observe(bravoSubjects[i - 1]!, `rfc319-b-${String(i)}`, `bravo approval ${i}`)
  }
  charlieDeliveryIds = []
  for (let i = 1; i <= CHARLIE_DELIVERIES; i += 1) {
    charlieDeliveryIds.push(
      ...(await observe(charlieSubjects[i - 1]!, `rfc319-c-${String(i)}`, `charlie approval ${i}`)),
    )
  }
  expect(charlieDeliveryIds.length, 'charlie 的投递条数与用例预期不一致').toBe(CHARLIE_DELIVERIES)

  // alpha 的四种处理状态：**取最新的四条**，让它们必定落在投递记录的第一页上。
  acceptedDeliveryId = alphaDeliveryIds.at(-1)!
  deadLetterDeliveryId = alphaDeliveryIds.at(-4)!
  setDeliveryState([acceptedDeliveryId], 'accepted')
  setDeliveryState([alphaDeliveryIds.at(-2)!, alphaDeliveryIds.at(-3)!], 'claimed')
  setDeliveryState([deadLetterDeliveryId], 'dead-letter', DEAD_LETTER_ERROR)

  // --- Webhook 侧：一条工作流 + 三个端点 ---------------------------------------
  const workflow = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-event-center-workflow',
      description: 'RFC-319 event center fixture',
      definition: {
        $schema_version: 5,
        inputs: [{ key: 'topic', label: 'Topic', kind: 'text' }],
        nodes: [],
        edges: [],
      },
    }),
  })
  const mrEndpoint = await createEndpoint('rfc319-ec-mr')
  toggleEndpoint = await createEndpoint('rfc319-ec-toggle')
  const auditEndpoint = await createEndpoint('rfc319-ec-audit')

  // --- EVENT-26 的终态控制语料：真的开一个 MR、真的关掉它 ----------------------
  mrTriggerName = 'rfc319-mr-terminal-rule'
  const mrTrigger = await api<{ id: string }>('/api/webhook-triggers', {
    method: 'POST',
    body: JSON.stringify({
      name: mrTriggerName,
      endpointId: mrEndpoint.id,
      enabled: true,
      repoScope: { kind: 'exact', paths: ['mr/audit'] },
      eventTypes: ['mr_opened'],
      cancelOnMrTerminal: true,
      maxConsecutiveFires: 100,
      autoRegisterRepos: false,
      launchKind: 'workflow',
      launchRefId: workflow.id,
      launchPayload: { scratch: true, inputs: { topic: { kind: 'template', template: 'mr' } } },
    }),
  })
  mrTriggerId = mrTrigger.id
  mrOpenedDeliveryId = (await deliver(mrEndpoint, 'Merge Request Hook', mergeRequestBody('open')))
    .deliveryId
  await expect
    .poll(async () => (await firesOf(mrTriggerId)).length, {
      timeout: 60_000,
      message: 'mr_opened 没有点火 ⇒ EVENT-26 的终态控制语料无从产生',
    })
    .toBe(1)
  const mrFire = (await firesOf(mrTriggerId))[0]!
  expect(mrFire.outcome, 'mr_opened 的点火结果不是 launched').toBe('launched')
  mrLaunchedTaskId = mrFire.taskId ?? ''
  expect(mrLaunchedTaskId, 'mr_opened 点火后没有任务 id').not.toBe('')
  await expect
    .poll(
      () =>
        querySqlite<{ status: string }>(
          dbPath(),
          `SELECT status FROM tasks WHERE id = ${sqlText(mrLaunchedTaskId)}`,
        )[0]?.status ?? 'missing',
      { timeout: 120_000, message: 'MR 任务迟迟没有收尾' },
    )
    .toMatch(/^(done|failed|canceled)$/)
  mrClosedDeliveryId = (await deliver(mrEndpoint, 'Merge Request Hook', mergeRequestBody('close')))
    .deliveryId
  await expect
    .poll(
      async () =>
        (
          await api<{ terminalControl: { status: string } | null }>(
            `/api/webhook-deliveries/${mrClosedDeliveryId}`,
          )
        ).terminalControl?.status ?? 'none',
      { timeout: 120_000, message: 'mr_closed 的终态控制迟迟没有结清' },
    )
    .toBe('succeeded')

  // --- EVENT-24 的启停 / 删除语料：一条真的点过火的规则 ------------------------
  const toggleTrigger = await api<{ id: string }>('/api/webhook-triggers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-toggle-rule',
      endpointId: toggleEndpoint.id,
      enabled: true,
      repoScope: { kind: 'exact', paths: ['trigger/audit'] },
      eventTypes: ['push'],
      maxConsecutiveFires: 100,
      autoRegisterRepos: false,
      launchKind: 'workflow',
      launchRefId: workflow.id,
      launchPayload: { scratch: true, inputs: { topic: { kind: 'template', template: 'push' } } },
    }),
  })
  toggleTriggerId = toggleTrigger.id
  await deliver(toggleEndpoint, 'Push Hook', pushBody('trigger/audit'))
  await expect
    .poll(async () => (await firesOf(toggleTriggerId)).length, {
      timeout: 60_000,
      message: '启停语料的第一次点火没有落库',
    })
    .toBe(1)

  // --- Webhook 投递审计语料（最后种，让 alpha/audit 占满第一页）----------------
  prunedDeliveryId = (await deliver(auditEndpoint, 'Tag Push Hook', tagPushBody('delta/audit')))
    .deliveryId
  for (let i = 0; i < BRAVO_PUSH_DELIVERIES; i += 1) {
    await deliver(auditEndpoint, 'Push Hook', pushBody('bravo/audit'))
  }
  for (let i = 0; i < BRAVO_PIPELINE_DELIVERIES; i += 1) {
    await deliver(auditEndpoint, 'Pipeline Hook', pipelineFailedBody('bravo/audit'))
  }
  // 分小批并发：端点级限流是 300/min（rateLimiter.ts:41），52 条远在闸下；
  // 批内先后不定不影响任何断言（本文件只验两页的**集合**互不相交，不验顺序）。
  for (let i = 0; i < ALPHA_AUDIT_DELIVERIES; i += 4) {
    await Promise.all(
      Array.from({ length: Math.min(4, ALPHA_AUDIT_DELIVERIES - i) }, () =>
        deliver(auditEndpoint, 'Push Hook', pushBody('alpha/audit')),
      ),
    )
  }

  // 自证：三条语料线的规模都必须与常量一致，否则后面每一条断言都在测别的东西。
  const seededRepos = await api<string[]>('/api/webhook-deliveries/repos')
  expect(seededRepos, '投递语料涉及的仓库集合与用例常量不一致').toEqual([...DELIVERED_REPOS])
  const seededAlpha = await api<{ total: number }>(
    '/api/webhook-deliveries?limit=1&repoPath=alpha/audit',
  )
  expect(seededAlpha.total, 'alpha/audit 的投递条数与用例常量不一致').toBe(ALPHA_AUDIT_DELIVERIES)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// `page.route` 的 handler 必须在 page 还活着的时候等干净（docs/dev-gotchas.md）。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// EVENT-29 —— 事件总览：四张汇总卡片 + 来源树 + 事件目录 + 观察器健康
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-29: 事件总览的来源树按观察方式分出三种健康态，四张汇总卡片各自的口径都咬得住——已取消的订阅不再计入、已确认的投递退出待处理 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await openEventsTab(page, 'overview')

  // --- (a) 事件目录：树上每个来源都完全展开，子项是可注入任务的参数合同 --------
  const tree = page.getByTestId('event-source-tree')
  await expect(tree).toBeVisible()
  const catalog = await api<{
    sources: Array<{ sourceRef: { id: string }; subscriptionCount: number }>
    eventTypes: unknown[]
  }>('/api/event-center/catalog')
  await expect(
    tree.locator('li.event-source-tree__source'),
    '来源树上的来源条数与目录对不上 ⇒ 有来源在界面上整个消失了',
  ).toHaveCount(catalog.sources.length)
  await expect(
    tree.locator('li.event-source-tree__event'),
    '树上的事件条目数与目录里的事件类型总数对不上 ⇒ 有事件类型没人能在界面上看见，' +
      '而它恰恰是「这条事件能不能配自动化」的唯一依据',
  ).toHaveCount(catalog.eventTypes.length)
  // 「已登记事件」数的是事件类型，不是来源数——两者都是小整数，写错了肉眼分不出来。
  await expect(summaryValue(page, 'Registered events')).toHaveText(
    String(catalog.eventTypes.length),
  )
  expect(
    catalog.eventTypes.length,
    '事件类型数恰好等于来源数 ⇒ 这条用例区分不出「卡片数错了对象」，需要换语料',
  ).not.toBe(catalog.sources.length)

  const codeHost = sourceRow(page, 'Code platform')
  const approval = sourceRow(page, 'External approval state observation')
  const taskLifecycle = sourceRow(page, 'Orchestration task lifecycle')

  // 参数合同：代码平台事件必须把可注入的任务参数条数写在子项上，否则用户在配规则时
  // 只能靠猜「这条事件能给我什么」。
  await expect(
    codeHost
      .locator('li.event-source-tree__event')
      .filter({ hasText: 'Branch pushed' })
      .locator('small'),
    '事件子项没有给出 trigger.* 参数命名空间与条数 ⇒ 配规则时无从知道能引用哪些字段',
  ).toHaveText(/^trigger\.code_host\.\* · \d+ task parameters$/)

  // --- (b) 观察器健康：三种观察方式渲染三种不同的状态 ------------------------
  await expect(
    approval.locator('.event-source-tree__source-row .status-chip'),
    '有订阅在等的主动来源没有显示「正在轮询」 ⇒ 用户无法判断这条来源到底有没有在工作',
  ).toHaveText('Polling')
  await expect(
    codeHost.locator('.event-source-tree__source-row .status-chip'),
    '没有任何精确订阅的按需来源没有显示「按需停止」 ⇒ 「有人关注才轮询」这条产品承诺在界面上不可见',
  ).toHaveText('Stopped on demand')
  await expect(
    taskLifecycle.locator('.event-source-tree__source-row .status-chip'),
    '纯推送来源被显示成了轮询相关状态 ⇒ passive 来源本来就没有观察器，这会把用户引去查一个不存在的轮询',
  ).toHaveText('Awaiting push')
  await expect(
    summaryValue(page, 'Running observers'),
    '「运行中的观察器」不等于 1 ⇒ 语料里只有 approval 一条来源有订阅，' +
      '这个数字要么把没订阅的来源也算了，要么根本没数 state==="active"',
  ).toHaveText('1')

  // --- (c) 有效订阅：已取消的那一条不许再被计入 ------------------------------
  await expect(
    approval.locator('.event-source-tree__source-row small'),
    `approval 来源的有效订阅数不是 ${String(ACTIVE_APPROVAL_SUBSCRIPTIONS)} ⇒ ` +
      '要么把已取消的订阅也数进去了（那用户会以为还有人在等这条事件、迟迟不敢下线来源），' +
      '要么少数了一批消费者',
  ).toHaveText(`Push + polling · ${String(ACTIVE_APPROVAL_SUBSCRIPTIONS)} active subscriptions`)

  // 卡片必须等于树上各来源的和：写错聚合字段（例如只取第一条来源）时这里立刻分叉。
  const perSource = await tree
    .locator('.event-source-tree__source-row small')
    .evaluateAll((nodes) =>
      nodes.map((node) => Number(/(\d+) active subscriptions/.exec(node.textContent ?? '')?.[1])),
    )
  const sumOfSources = perSource.reduce((total, value) => total + value, 0)
  expect(
    perSource.length,
    '来源行上没有解析出「N active subscriptions」 ⇒ 这条断言退化成恒真了',
  ).toBe(catalog.sources.length)
  await expect(
    summaryValue(page, 'Active subscriptions'),
    '「有效订阅」卡片与来源树上各行之和对不上 ⇒ 卡片与它下面那棵树在讲两个故事',
  ).toHaveText(String(sumOfSources))

  // --- (d) 待处理投递：只认 pending / claimed --------------------------------
  // 用 charlie 的三条投递做因果实验：它们在第一页上（最新的一批里），且没有任何
  // 别的用例读它们。逐个状态翻一遍，卡片必须跟着动/不动。
  const pendingCard = summaryValue(page, 'Pending deliveries')
  const baseline = Number(await pendingCard.innerText())
  expect(baseline, '基线读数不是数字').toBeGreaterThanOrEqual(CHARLIE_DELIVERIES)

  setDeliveryState(charlieDeliveryIds, 'accepted')
  await page.reload()
  await expect(
    summaryValue(page, 'Pending deliveries'),
    `${String(CHARLIE_DELIVERIES)} 条投递被确认后「待处理投递」没有跟着减少 ⇒ ` +
      '这个数字与真实待办脱节：用户看着一个永不下降的积压数，无法判断消费者是不是卡住了',
  ).toHaveText(String(baseline - CHARLIE_DELIVERIES))

  setDeliveryState(charlieDeliveryIds, 'claimed')
  await page.reload()
  await expect(
    summaryValue(page, 'Pending deliveries'),
    '「处理中」的投递没有被计入待处理 ⇒ 正在被消费者持有的投递从积压里凭空消失，' +
      '一个卡在 claimed 上的 worker 会让积压看起来已经清零',
  ).toHaveText(String(baseline))

  setDeliveryState(charlieDeliveryIds, 'dead-letter', 'rfc319 overview probe')
  await page.reload()
  await expect(
    summaryValue(page, 'Pending deliveries'),
    '「处理失败」的投递仍被算作待处理 ⇒ 死信会永远挂在积压数里，把这张卡片变成一个只涨不跌的噪音',
  ).toHaveText(String(baseline - CHARLIE_DELIVERIES))

  setDeliveryState(charlieDeliveryIds, 'pending')
  await page.reload()
  await expect(
    summaryValue(page, 'Pending deliveries'),
    '把投递改回待处理后卡片没有回到基线 ⇒ 这个数字不是从投递状态算出来的',
  ).toHaveText(String(baseline))
})

// ---------------------------------------------------------------------------
// EVENT-32 —— 订阅审计：统一分页 + 消费者标识精确筛选 + 状态渲染
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-32: 订阅审计把精确关注与条件响应并进同一份分页里，消费者标识是精确匹配而非前缀，已取消的订阅仍要列出并标成已取消 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const list = await openSubscriptionAudit(page)
  const rows = list.locator('article.node-tool-row')
  const filter = page.getByTestId('event-subscription-subscriber-filter')
  const total = page.locator('.event-center-audit__total')
  const pagination = page.getByTestId('event-subscription-pagination')

  // --- (a) 统一分页：两种模式的订阅出现在同一份列表里 ------------------------
  // 触发规则派生出来的是 filtered 订阅，数字员工的关注是 exact 订阅。它们分列两张表
  // 的话，用户要在两个地方各查一遍才能回答「谁在等这条事件」。
  await expect(
    rows.filter({ hasText: mrTriggerName }),
    '触发规则派生的条件响应订阅没有出现在订阅审计里 ⇒ 「谁在等什么」缺了一半，' +
      '而缺的正好是会真的启动工作的那一半',
  ).toHaveCount(1)
  await expect(
    rows.filter({ hasText: mrTriggerName }).locator('small'),
    '条件响应订阅没有被标成 Filtered response ⇒ 用户分不出哪条是数字员工的关注、哪条是自动化规则',
  ).toContainText('Filtered response')
  await expect(
    rows.filter({ hasText: 'Exact attention' }).first(),
    '同一页里看不到任何精确关注 ⇒ 「统一分页」没有成立',
  ).toBeVisible()

  // --- (b) 按消费者标识筛选：留下的对、筛掉的真的不在了 ----------------------
  await filter.fill(ALPHA)
  await expect(total).toHaveText(`${String(ALPHA_SUBSCRIPTIONS)} subscriptions`)
  await expect(rows).toHaveCount(EVENT_PAGE_SIZE)
  await expect(
    list,
    `筛 ${ALPHA} 之后列表里还留着 ${BRAVO} 的订阅 ⇒ 筛选没有真的收窄，` +
      '用户会把别人的订阅当成自己的',
  ).not.toContainText(BRAVO)
  await expect(
    list,
    '按消费者筛选之后条件响应订阅还在 ⇒ 筛选只作用于精确订阅那一半，合并列表被筛出了一个混合结果',
  ).not.toContainText(mrTriggerName)
  await expect(pagination.locator('.pagination__label')).toHaveText('Page 1 of 2')
  await pagination.getByRole('button', { name: 'Next' }).click()
  await expect(rows, '第二页的行数不是余数 ⇒ 页码动了但数据没跟着换页').toHaveCount(
    ALPHA_SUBSCRIPTIONS - EVENT_PAGE_SIZE,
  )

  // --- (c) 精确匹配，不是前缀匹配 -------------------------------------------
  // 三个消费者标识都以 `rfc319-consumer` 开头。若服务端用了 LIKE，这一筛会命中全部 61 条，
  // 用户便会以为自己查到的是某一个消费者的订阅，实际是所有人的。
  await filter.fill('rfc319-consumer')
  await expect(
    list,
    '用三个消费者标识的公共前缀去筛，居然筛出了订阅 ⇒ 消费者筛选退化成了前缀/模糊匹配，' +
      '「精确输入消费者标识」这句提示是骗人的',
  ).toContainText('No subscriptions match this filter.')
  await expect(rows).toHaveCount(0)

  // --- (d) 状态渲染：已取消的订阅仍要列出 ------------------------------------
  await filter.fill(BRAVO)
  await expect(total).toHaveText(`${String(BRAVO_SUBSCRIPTIONS)} subscriptions`)
  await expect(
    rows.locator('.status-chip', { hasText: 'Cancelled' }),
    '已取消的订阅在审计里看不到「已取消」 ⇒ 审计的意义正是解释「为什么这个消费者不再收到投递」，' +
      '它消失或伪装成有效，这个问题就无解了',
  ).toHaveCount(CANCELLED_SUBSCRIPTIONS)
  await expect(rows.locator('.status-chip', { hasText: 'Active' })).toHaveCount(
    BRAVO_SUBSCRIPTIONS - CANCELLED_SUBSCRIPTIONS,
  )

  // --- (e) 消费者种类决定后续入口 -------------------------------------------
  await expect(
    rows.getByRole('link', { name: 'View task' }),
    'system 类消费者的订阅上渲染了「查看任务」 ⇒ 点过去是一个不存在的员工任务',
  ).toHaveCount(0)
  await filter.fill(ALPHA)
  await expect(
    rows.getByRole('link', { name: 'View task' }),
    'employee-case 类消费者的订阅上没有「查看任务」入口 ⇒ 从「谁在等」到「他在干什么」断了',
  ).toHaveCount(EVENT_PAGE_SIZE)
})

// ---------------------------------------------------------------------------
// EVENT-33 —— 投递记录：按处理状态与消费者筛选 + 分页
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-33: 投递记录的四档处理状态各自筛出互不重叠的子集，消费者筛选与状态筛选可叠加，失败原因跟着死信一起显示 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const list = await openDeliveryRecords(page)
  const rows = list.locator('article.node-tool-row')
  const total = page.locator('.event-center-audit__total')
  const subscriber = page.getByTestId('event-delivery-subscriber-filter')
  const pagination = page.getByTestId('event-delivery-pagination')
  const stateFilter = page.getByRole('radiogroup', { name: 'Filter by processing state' })

  // 先锁定到一个消费者，让所有断言都不受别的用例新增投递的干扰。
  await subscriber.fill(ALPHA)
  await expect(total).toHaveText(`${String(ALPHA_DELIVERIES)} deliveries`)
  await expect(rows).toHaveCount(EVENT_PAGE_SIZE)
  await expect(pagination.locator('.pagination__label')).toHaveText('Page 1 of 2')
  await pagination.getByRole('button', { name: 'Next' }).click()
  await expect(rows, '第二页的行数不是余数 ⇒ 翻页只改了页码').toHaveCount(
    ALPHA_DELIVERIES - EVENT_PAGE_SIZE,
  )

  // --- (a) 四档状态各自筛出正确的子集，且加起来正好是全部 --------------------
  const expected: ReadonlyArray<readonly [string, number]> = [
    ['Pending', ALPHA_PENDING],
    ['Processing', ALPHA_CLAIMED],
    ['Accepted', ALPHA_ACCEPTED],
    ['Failed', ALPHA_DEAD_LETTER],
  ]
  let sum = 0
  for (const [label, count] of expected) {
    await stateFilter.getByRole('radio', { name: label, exact: true }).click()
    await expect(
      total,
      `按「${label}」筛出的条数不是 ${String(count)} ⇒ 状态筛选传错了维度，` +
        '用户以为自己在看某一档，其实看到的是别的一档',
    ).toHaveText(`${String(count)} deliveries`)
    await expect(rows).toHaveCount(count)
    sum += count
  }
  expect(
    sum,
    '四档状态的条数之和不等于该消费者的全部投递 ⇒ 有投递落在四档之外（用户永远筛不到它）',
  ).toBe(ALPHA_DELIVERIES)

  // --- (b) 筛掉的那些**真的**不在了 ------------------------------------------
  // 「已确认」只有一条。除它以外的 51 条 id 一个都不许出现在列表里——否则「筛出来还有行」
  // 这种断言就只是在证明页面还能渲染。
  await stateFilter.getByRole('radio', { name: 'Accepted', exact: true }).click()
  await expect(rows).toHaveCount(ALPHA_ACCEPTED)
  await expect(list, '已确认那一条的投递 id 不在结果里 ⇒ 筛出来的根本不是它').toContainText(
    acceptedDeliveryId,
  )
  const listText = (await list.innerText()).trim()
  const leaked = alphaDeliveryIds.filter((id) => id !== acceptedDeliveryId && listText.includes(id))
  expect(
    leaked,
    `按「已确认」筛完之后，未确认的投递仍然留在列表里：${leaked.slice(0, 3).join(', ')} ⇒ ` +
      '过滤器只是换了个总数，行还是原来那批',
  ).toEqual([])

  // --- (c) 死信要带着失败原因一起显示 ---------------------------------------
  await stateFilter.getByRole('radio', { name: 'Failed', exact: true }).click()
  await expect(rows).toHaveCount(ALPHA_DEAD_LETTER)
  await expect(
    rows.locator('.status-chip'),
    '处理失败的投递没有渲染成 Failed ⇒ 一条永远不会再被处理的投递在界面上和待处理长得一样',
  ).toHaveText('Failed')
  await expect(
    rows.locator('small'),
    '死信没有带出 lastError ⇒ 用户看到「失败」却没有任何可以据以修复的线索',
  ).toContainText(DEAD_LETTER_ERROR)
  await expect(list).toContainText(deadLetterDeliveryId)

  // --- (d) 消费者 × 状态可叠加，且叠加后的空集有明确空态 ---------------------
  await subscriber.fill(BRAVO)
  await stateFilter.getByRole('radio', { name: 'All', exact: true }).click()
  await expect(total).toHaveText(`${String(BRAVO_DELIVERIES)} deliveries`)
  await expect(
    list,
    `切到 ${BRAVO} 之后列表里还留着 ${ALPHA} 的投递 ⇒ 消费者筛选没生效`,
  ).not.toContainText(ALPHA)
  await stateFilter.getByRole('radio', { name: 'Accepted', exact: true }).click()
  await expect(
    list,
    'bravo 没有任何已确认投递，界面却没有落到空态 ⇒ 两个筛选维度不是取交集',
  ).toContainText('No event deliveries yet.')
  await expect(rows).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// EVENT-34 —— 全局事件记录审计：按来源筛选 + 分页 + 只出公开事件
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-34: 全局事件记录只列公开目录里的事件、按来源筛选换出的是另一批行，来源下拉的选项来自事件目录而不是记录里出现过的来源 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const list = await openSourceEvents(page)
  const rows = list.locator('article.node-tool-row')
  const total = page.locator('.event-center-audit__total')
  const pagination = page.getByTestId('event-source-audit-pagination')

  // --- (a) 下拉选项来自事件目录（四个来源），不是「记录里出现过的来源」---------
  // 语料里只有两个来源真的产生过事件；下拉却必须把四个来源都列出来，否则一个刚接入、
  // 还没产生过事件的来源就永远选不中，用户无法确认「它到底有没有在发事件」。
  const catalog = await api<{
    sources: Array<{ sourceRef: { id: string }; displayName: Record<string, string> }>
  }>('/api/event-center/catalog')
  const expectedOptions = [
    'All sources',
    ...catalog.sources.map((source) => source.displayName['en-US'] ?? ''),
  ]
  expect(
    await optionLabels(page, 'event-source-audit-filter'),
    '事件来源下拉的选项集合与事件目录对不上 ⇒ 有来源在筛选器里选不到',
  ).toEqual(expectedOptions)

  // --- (b) 只出 catalogVisibility='public' 的事件类型 -------------------------
  // Webhook 每收一条投递会发布**两条**事件记录：一条兼容层的 `code-host.event.*`
  // （catalogVisibility='compatibility'）和一条公开的 `code-host.*`。审计面只应看见后者；
  // 前者泄漏出来的样子是行标题变成裸 id（目录里查不到 → eventName 退回 ref.id）。
  await chooseOption(page, 'event-source-audit-filter', 'Code platform')
  const codeHostAll = querySqlite<{ n: number }>(
    dbPath(),
    "SELECT count(*) AS n FROM event_records WHERE source_id = 'code-host.activity'",
  )[0]!.n
  const codeHostHidden = querySqlite<{ n: number }>(
    dbPath(),
    'SELECT count(*) AS n FROM event_records r' +
      ' JOIN event_type_catalog c ON c.event_type_id = r.event_type_id' +
      ' AND c.revision = r.event_type_revision' +
      " WHERE r.source_id = 'code-host.activity' AND c.catalog_visibility <> 'public'",
  )[0]!.n
  expect(
    codeHostHidden,
    '语料里没有任何非公开事件记录 ⇒ 这条「只出公开事件」的断言退化成恒真，需要换语料',
  ).toBeGreaterThan(0)
  await expect(
    total,
    `代码平台的事件记录条数不是「全部 ${String(codeHostAll)} 减去非公开的 ${String(codeHostHidden)}」 ⇒ ` +
      '内部/兼容层事件被端到了全局审计面上，用户会把同一次推送数成两次',
  ).toHaveText(`${String(codeHostAll - codeHostHidden)} source events`)
  await expect(
    list,
    '列表里出现了兼容层事件类型的裸 id ⇒ 这些行本不该出现在公开审计里，' +
      '而且它们连一个像样的名字都没有',
  ).not.toContainText('code-host.event.')

  // --- (c) 换一个来源，结果集合真的换了一批 ---------------------------------
  await expect(rows.locator('strong').first()).toHaveText('Branch pushed')
  await chooseOption(page, 'event-source-audit-filter', 'External approval state observation')
  await expect(
    total,
    `审批来源的事件条数不是 ${String(APPROVAL_EVENTS)} ⇒ 来源筛选没有按 sourceId 收窄`,
  ).toHaveText(`${String(APPROVAL_EVENTS)} source events`)
  await expect(
    list,
    '切到审批来源之后列表里还留着「Branch pushed」 ⇒ 来源筛选换了总数却没换行',
  ).not.toContainText('Branch pushed')
  await expect(
    rows.locator('small').first(),
    '事件行没有标出它来自哪个来源 ⇒ 「全部来源」视图下用户分不清每一行的出处',
  ).toContainText('External approval state observation')

  // --- (d) 分页：换页换的是数据 ---------------------------------------------
  await expect(rows).toHaveCount(EVENT_PAGE_SIZE)
  await expect(pagination.locator('.pagination__label')).toHaveText('Page 1 of 2')
  // 只取行内的摘要 span（`div > span`）：状态 chip 也是 span，但它挂在 article 下，
  // 且每行都是同一句「已入库」——把它算进去，去重断言就退化成恒假。
  const firstPageSummaries = await rows.locator('div > span').allInnerTexts()
  await pagination.getByRole('button', { name: 'Next' }).click()
  await expect(rows).toHaveCount(APPROVAL_EVENTS - EVENT_PAGE_SIZE)
  const secondPageSummaries = await rows.locator('div > span').allInnerTexts()
  expect(
    secondPageSummaries.filter((summary) => firstPageSummaries.includes(summary)),
    '第二页出现了第一页已经列过的事件 ⇒ 深翻页会重复计数，审计不再可信',
  ).toEqual([])

  // --- (e) 回到「全部来源」：两个来源的行都要回来 ----------------------------
  await chooseOption(page, 'event-source-audit-filter', 'All sources')
  // 只断言「代码平台的行回来了」，不断言它排第一：任务生命周期事件是后台任务收尾时
  // 才发布的，谁排最新并不确定。
  await expect(
    rows.filter({ hasText: 'Branch pushed' }).first(),
    '清掉来源筛选之后代码平台的事件没有回到列表里 ⇒ 「全部来源」被当成了某一个来源',
  ).toBeVisible()
  const allTotal = Number(/^(\d+)/.exec((await total.innerText()).trim())?.[1])
  expect(
    allTotal,
    '「全部来源」的条数比两个已知来源之和还少 ⇒ 不加筛选的视图反而漏了事件，' +
      '而这是用户唯一能全局回答「这条事实到底有没有入库」的地方',
  ).toBeGreaterThanOrEqual(APPROVAL_EVENTS + (codeHostAll - codeHostHidden))
})

// ---------------------------------------------------------------------------
// EVENT-25 —— Webhook 投递审计：事件类型 / 仓库两维过滤 + 仓库下拉选项源 + 翻页
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-25: 投递审计按事件类型与仓库分别收窄且两者可叠加，仓库下拉列的是投递里出现过的仓库（含没落在当前页的那一个），翻页前后两页互不相交 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const panel = await openWebhookAudit(page)
  const rows = panel.locator('tbody tr')
  const repoCells = panel.locator('tbody tr td:nth-child(2)')
  const total = panel.getByTestId('webhook-deliveries-total')
  const pagination = panel.getByTestId('webhook-deliveries-pagination')

  // --- (a) 仓库下拉的选项来源 -----------------------------------------------
  // 选项必须来自 /api/webhook-deliveries/repos（投递里出现过的**全部**仓库），
  // 而不是当前这一页已加载的行。语料刻意让 delta/audit 只有一条、且是最早的一条：
  // 它绝不会出现在第一页，但必须出现在下拉里——否则「只在某天来过一次的仓库」永远筛不到。
  await expect(
    repoCells,
    '第一页不是被最新的一批投递占满 ⇒ 语料的时间序变了，下面那条「不在页上但在下拉里」的断言失去意义',
  ).toHaveCount(WEBHOOK_PAGE_SIZE)
  const firstPageRepos = new Set(await repoCells.allInnerTexts())
  expect(
    firstPageRepos.has('delta/audit'),
    'delta/audit 出现在了第一页 ⇒ 语料的时间序变了，需要重新安排',
  ).toBe(false)
  expect(
    await optionLabels(page, 'webhook-delivery-filter-repo'),
    '仓库下拉的选项不是「投递里出现过的全部仓库、升序」 ⇒ 要么漏了不在当前页上的仓库' +
      '（那个仓库就永远筛不到），要么把从没来过投递的仓库也列了进来（选了等于空页）',
  ).toEqual(['All repositories', ...DELIVERED_REPOS])

  // --- (b) 事件类型过滤：留下的对、筛掉的不在 --------------------------------
  await chooseOption(page, 'webhook-delivery-filter-event', 'Pipeline failed')
  await expect(
    total,
    `按「流水线失败」筛出的条数不是 ${String(BRAVO_PIPELINE_DELIVERIES)} ⇒ 事件类型没有传到服务端`,
  ).toHaveText(`${String(BRAVO_PIPELINE_DELIVERIES)} total`)
  await expect(rows).toHaveCount(BRAVO_PIPELINE_DELIVERIES)
  await expect(
    panel.locator('tbody'),
    '按事件类型筛完之后，别的事件类型仍然留在表里 ⇒ 用户会把推送当成流水线失败',
  ).not.toContainText('alpha/audit')
  await expect(rows.locator('td:first-child strong')).toHaveText([
    'Pipeline failed',
    'Pipeline failed',
  ])

  // 换一个事件类型，结果集合必须整批换掉（不是「还有行」）。
  await chooseOption(page, 'webhook-delivery-filter-event', 'Tag push')
  await expect(total).toHaveText(`${String(DELTA_TAG_DELIVERIES)} total`)
  await expect(rows.locator('td:first-child strong')).toHaveText(['Tag push'])
  await expect(repoCells).toHaveText(['delta/audit'])

  // --- (c) 仓库过滤 + 与事件类型叠加 ----------------------------------------
  await chooseOption(page, 'webhook-delivery-filter-event', 'All events')
  await chooseOption(page, 'webhook-delivery-filter-repo', 'bravo/audit')
  await expect(total).toHaveText(`${String(BRAVO_AUDIT_DELIVERIES)} total`)
  const bravoRepos = await repoCells.allInnerTexts()
  expect(
    bravoRepos.filter((repo) => repo !== 'bravo/audit'),
    '按仓库筛完之后表里还有别的仓库的行 ⇒ 仓库筛选没生效，' +
      '而这正是「这个仓库到底有没有把事件送进来」的唯一答案来源',
  ).toEqual([])
  await chooseOption(page, 'webhook-delivery-filter-event', 'Push')
  await expect(
    total,
    '仓库与事件类型叠加后的条数不是两者的交集 ⇒ 后设的那个维度把前一个覆盖掉了',
  ).toHaveText(`${String(BRAVO_PUSH_DELIVERIES)} total`)
  await expect(rows).toHaveCount(BRAVO_PUSH_DELIVERIES)
  await expect(rows.locator('td:first-child strong')).toHaveText(['Push', 'Push', 'Push'])

  // --- (d) 翻页：两页的行集合互不相交 ---------------------------------------
  // receivedAt 只有秒级精度（schema.ts:1392-1394 的 unixepoch()*1000），52 条投递挤在
  // 同一秒里：排序完全靠 id（ULID）这个 tie-break。它一旦被去掉，OFFSET 翻页会跨页重/漏，
  // 而界面上一切正常——两页各自都「有行」。
  await chooseOption(page, 'webhook-delivery-filter-event', 'All events')
  await chooseOption(page, 'webhook-delivery-filter-repo', 'alpha/audit')
  await expect(total).toHaveText(`${String(ALPHA_AUDIT_DELIVERIES)} total`)
  await expect(pagination.locator('.pagination__label')).toHaveText('Page 1 of 2')
  await expect(rows).toHaveCount(WEBHOOK_PAGE_SIZE)
  const firstPage = await rowTestids(rows)
  await pagination.getByRole('button', { name: 'Next' }).click()
  await expect(rows).toHaveCount(ALPHA_AUDIT_DELIVERIES - WEBHOOK_PAGE_SIZE)
  const secondPage = await rowTestids(rows)
  const repeated = secondPage.filter((id) => firstPage.includes(id))
  expect(
    repeated,
    `第二页重复了第一页已经列过的投递：${repeated.join(', ')} ⇒ 同一秒内的投递没有稳定排序，` +
      '翻页会重复也会漏，而漏掉的那一条正是用户在找的那次失败',
  ).toEqual([])
  expect(
    new Set([...firstPage, ...secondPage]).size,
    '两页去重之后凑不齐这个仓库的全部投递 ⇒ 翻页漏掉了行',
  ).toBe(ALPHA_AUDIT_DELIVERIES)
})

// ---------------------------------------------------------------------------
// EVENT-26 —— 投递详情：原始 body + 终态控制审计 + 不可见任务计数
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-26: 投递详情原样保留入站 body 并给出终态控制的逐任务结果，看不见那些任务的人只拿到一个计数、拿不到任务 id @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const panel = await openWebhookAudit(page)

  // --- (a) 无终态控制的普通投递：不许凭空长出一张审计表 ----------------------
  await chooseOption(page, 'webhook-delivery-filter-repo', 'mr/audit')
  await expect(panel.locator('tbody tr')).toHaveCount(2)
  await panel.getByTestId(`webhook-delivery-detail-${mrOpenedDeliveryId}`).click()
  const dialog = page.getByTestId('webhook-delivery-detail-dialog')
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByTestId('webhook-terminal-control-audit'),
    'mr_opened 这条投递并没有终态控制事实，详情里却渲染了终态控制审计 ⇒ ' +
      '用户会以为有任务被这次事件围栏/取消过',
  ).toHaveCount(0)
  await dialog.locator('.dialog__close').click()
  await expect(dialog).toBeHidden()

  // --- (b) 原始 body：详情里那段就是发进来的原文 ----------------------------
  await panel.getByTestId(`webhook-delivery-detail-${mrClosedDeliveryId}`).click()
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByTestId('webhook-delivery-body'),
    '详情里的 body 不是入站原文 ⇒ 排查一条「为什么没匹配」时，用户读到的是平台归一化之后的东西，' +
      '而分歧往往就在归一化那一步',
  ).toContainText(`"id": "${MR_CLOSE_COMMIT}"`)
  await expect(
    dialog.getByTestId('webhook-delivery-body'),
    '存下来的 body 没有被格式化 ⇒ 一行几 KB 的 JSON 在弹窗里等于不可读',
  ).toContainText('"object_kind": "merge_request"')

  // --- (c) 终态控制审计：逐任务结果 -----------------------------------------
  const audit = dialog.getByTestId('webhook-terminal-control-audit')
  await expect(audit).toBeVisible()
  const facts = audit.locator('dl > div')
  await expect(
    facts.filter({ hasText: 'Control fact' }).locator('dd'),
    'MR 被关闭产生的控制事实没有显示成「MR / PR closed」 ⇒ 用户分不清这次是关闭、合并还是重开',
  ).toHaveText('MR / PR closed')
  await expect(facts.filter({ hasText: 'Settlement' }).locator('dd')).toHaveText('Settled')
  await expect(
    facts.filter({ hasText: 'Stream revision' }).locator('dd'),
    '控制事实没有带出流水修订号 ⇒ 同一个 MR 上多次开/关的先后顺序无从判断',
  ).toHaveText('2')
  await expect(facts.filter({ hasText: 'Matched tasks' }).locator('dd')).toHaveText('1')
  const targetRow = audit.locator('table.data-table tbody tr')
  await expect(targetRow).toHaveCount(1)
  await expect(
    targetRow.getByRole('link', { name: mrLaunchedTaskId }),
    '终态控制命中的任务没有渲染成可点的链接 ⇒ 从「这次关闭动了哪些任务」到那个任务本身断了',
  ).toHaveAttribute('href', new RegExp(`/tasks/${mrLaunchedTaskId}$`))
  await expect(targetRow.locator('td').nth(1)).toHaveText('Already terminal')
  await expect(targetRow.locator('td').nth(2)).toHaveText('No active owner')
  await expect(targetRow.locator('td').nth(3)).toHaveText('Retained')
  await expect(
    audit.getByTestId('webhook-terminal-control-hidden-targets'),
    '管理员能看见全部命中任务，却还是被提示「有任务被权限藏起来了」 ⇒ 这条提示会让人以为自己漏看了什么',
  ).toHaveCount(0)
  await dialog.locator('.dialog__close').click()
  await expect(dialog).toBeHidden()

  // --- (d) 保留期清空 body 之后要说清楚，而不是空白一片 ---------------------
  runSqlite(
    dbPath(),
    `UPDATE webhook_deliveries SET body_json = NULL WHERE id = ${sqlText(prunedDeliveryId)};`,
  )
  expect(
    querySqlite<{ n: number }>(
      dbPath(),
      `SELECT count(*) AS n FROM webhook_deliveries WHERE id = ${sqlText(prunedDeliveryId)} AND body_json IS NULL`,
    )[0]!.n,
    '把 body 置空的种子没有落库',
  ).toBe(1)
  await chooseOption(page, 'webhook-delivery-filter-repo', 'delta/audit')
  await panel.getByTestId(`webhook-delivery-detail-${prunedDeliveryId}`).click()
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByTestId('webhook-delivery-body'),
    'body 被保留期清掉之后详情里是一片空白 ⇒ 用户分不清是「平台没存下来」还是「本来就没有 body」',
  ).toHaveText('(raw body pruned by the retention policy)')
  await dialog.locator('.dialog__close').click()
  await expect(dialog).toBeHidden()
})

test('RFC-319 EVENT-26: 看不见那个任务的人在终态控制审计里只拿到一个「被权限隐藏」的计数，任务 id 一个字都不外泄 @nightly', async ({
  page,
}) => {
  // 任务归属管理员，这个账号既不是 owner 也没有 tasks:read:all（USER_BASELINE 不含它），
  // 于是 canViewTask 判否（taskCollab.ts:39-48）。
  await primeAuth(page, plainUserToken)
  const panel = await openWebhookAudit(page)
  await chooseOption(page, 'webhook-delivery-filter-repo', 'mr/audit')
  await panel.getByTestId(`webhook-delivery-detail-${mrClosedDeliveryId}`).click()
  const dialog = page.getByTestId('webhook-delivery-detail-dialog')
  await expect(dialog).toBeVisible()

  const audit = dialog.getByTestId('webhook-terminal-control-audit')
  await expect(
    audit,
    '只读账号完全看不到终态控制审计 ⇒ 投递审计对所有成员开放（RFC-260 D2），' +
      '这里整块消失等于把「这条投递做了什么」也一起藏了',
  ).toBeVisible()
  await expect(
    audit.locator('dl > div').filter({ hasText: 'Matched tasks' }).locator('dd'),
    '命中任务的**总数**也被藏起来了 ⇒ 用户连「有东西被我看不见」都不知道，' +
      '会把这次终态控制当成什么都没做',
  ).toHaveText('1')
  await expect(
    audit.getByTestId('webhook-terminal-control-hidden-targets'),
    '有任务因权限不可见，界面却没有说明 ⇒ 同一条投递在两个人屏幕上显示不同的结论，而且没人知道为什么',
  ).toHaveText('1 matched task(s) are hidden by task access controls.')
  await expect(
    audit.locator('table.data-table'),
    '不可见任务仍然被渲染进了逐任务结果表 ⇒ 越权泄漏',
  ).toHaveCount(0)
  expect(
    (await dialog.innerText()).includes(mrLaunchedTaskId),
    '不可见任务的 id 出现在了弹窗文本里 ⇒ 泄漏的是「哪个任务被这次 MR 关闭动过」，' +
      '而这恰恰是任务可见性要挡住的东西',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// EVENT-24 —— 触发规则启停开关 / 删除（fires 与 stream 级联）
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-24: 关掉触发规则的开关后同样的事件不再点火，重新打开又能点，删除规则连带清掉它的点火历史与熔断计数 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await openEventsTab(page, 'subscriptions')
  const card = page.getByTestId(`webhook-trigger-${toggleTriggerId}`)
  await expect(card).toBeVisible()
  const toggle = page.getByTestId(`webhook-trigger-enable-${toggleTriggerId}`)
  await expect(toggle).toBeChecked()

  // --- (a) 关掉开关 ⇒ 同一条事件不再点火 -------------------------------------
  // 用 click 而不是 uncheck：这个开关是**受控**的，勾选态要等 PUT 回来 + 列表
  // invalidate 之后才翻转，`uncheck()` 会在点完的下一拍就判定「状态没变」而失败。
  await toggle.click()
  await expect
    .poll(
      async () =>
        (await api<{ enabled: boolean }>(`/api/webhook-triggers/${toggleTriggerId}`)).enabled,
      { timeout: 30_000, message: '开关关掉了，服务端却还认为规则是启用的' },
    )
    .toBe(false)
  await expect(toggle).not.toBeChecked()

  const whileDisabled = await deliver(toggleEndpoint, 'Push Hook', pushBody('trigger/audit'))
  const disabledOutcome = await waitForTerminalDelivery(whileDisabled.deliveryId)
  expect(
    disabledOutcome,
    '规则停用期间的同一条事件仍然被匹配上了 ⇒ 「关掉开关」没有真的止住自动启动，' +
      '而用户关它通常正是因为它在乱开工作',
  ).toEqual({ status: 'ignored', statusReason: 'no-trigger-matched' })
  expect(
    (await firesOf(toggleTriggerId)).length,
    '规则停用期间多出了一条点火记录 ⇒ 停用只是界面上的样子',
  ).toBe(1)

  // --- (b) 打开开关 ⇒ 又能点火 ----------------------------------------------
  await toggle.click()
  await expect
    .poll(
      async () =>
        (await api<{ enabled: boolean }>(`/api/webhook-triggers/${toggleTriggerId}`)).enabled,
      { timeout: 30_000, message: '开关打开了，服务端却还认为规则是停用的' },
    )
    .toBe(true)
  await deliver(toggleEndpoint, 'Push Hook', pushBody('trigger/audit'))
  await expect
    .poll(async () => (await firesOf(toggleTriggerId)).length, {
      timeout: 60_000,
      message: '重新启用之后规则再也不点火了 ⇒ 停用变成了不可逆操作',
    })
    .toBe(2)
  const fires = await firesOf(toggleTriggerId)
  expect(
    fires.map((fire) => fire.outcome),
    '重新启用后的那次点火没有真的启动工作',
  ).toEqual(['launched', 'launched'])

  // 点火历史在界面上要看得到（否则「为什么开了工/为什么没开工」只能查日志）。
  await page.reload()
  await page.getByTestId(`webhook-trigger-fires-${toggleTriggerId}`).click()
  const firesDialog = page.getByTestId('webhook-fires-dialog')
  await expect(firesDialog).toBeVisible()
  await expect(firesDialog.locator('tbody tr')).toHaveCount(2)
  await expect(
    firesDialog.locator('tbody tr td:first-child code').first(),
    '点火历史没有给出事件流标识 ⇒ 熔断是按事件流计数的，看不到它就无法解释「为什么被暂停了」',
  ).toHaveText('trigger/audit|branch:main')
  await expect(firesDialog.locator('tbody tr .status-chip').first()).toHaveText('Launched')
  await firesDialog.locator('.dialog__close').click()
  await expect(firesDialog).toBeHidden()

  // --- (c) 删除 ⇒ fires 与 stream 一起级联清掉 ------------------------------
  const streamsBefore = querySqlite<{ n: number }>(
    dbPath(),
    `SELECT count(*) AS n FROM webhook_trigger_streams WHERE trigger_id = ${sqlText(toggleTriggerId)}`,
  )[0]!.n
  expect(streamsBefore, '删除之前这条规则本来就没有熔断计数 ⇒ 级联断言退化成恒真').toBe(1)

  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await card.getByRole('button', { name: 'Confirm delete?', exact: true }).click()
  await expect(card, '确认删除之后规则卡片还在 ⇒ 用户会以为没删掉、再点一次').toHaveCount(0)
  expect((await req(`/api/webhook-triggers/${toggleTriggerId}`)).status).toBe(404)
  expect(
    querySqlite<{ n: number }>(
      dbPath(),
      `SELECT count(*) AS n FROM webhook_trigger_fires WHERE trigger_id = ${sqlText(toggleTriggerId)}`,
    )[0]!.n,
    '规则删了，它的点火历史还留着 ⇒ 这些行再也没有界面能列出它们，只会一直占着库，' +
      '而同名新规则的历史会和它们混在一起',
  ).toBe(0)
  expect(
    querySqlite<{ n: number }>(
      dbPath(),
      `SELECT count(*) AS n FROM webhook_trigger_streams WHERE trigger_id = ${sqlText(toggleTriggerId)}`,
    )[0]!.n,
    '规则删了，它的熔断计数还留着 ⇒ 重建一条同 id 的规则会继承一个陌生的连续点火数，' +
      '第一次事件就可能被直接熔断',
  ).toBe(0)
})

// ---------------------------------------------------------------------------
// EVENT-X6 —— /webhooks → /events 兼容重定向
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-X6: 老的 /webhooks 三个页签各自落到事件中心对应的页签上，且不在浏览历史里留下一个会把人弹回来的中转页 @nightly', async ({
  page,
}) => {
  await primeAuth(page)

  const cases: ReadonlyArray<readonly [string, string, string, string]> = [
    // 老地址、新 tab、新页签的 testid、落地后必须出现的内容锚
    ['/webhooks?tab=endpoints', 'sources', 'event-center-tab-sources', 'webhook-endpoints'],
    [
      '/webhooks?tab=triggers',
      'subscriptions',
      'event-center-tab-subscriptions',
      'webhook-triggers-panel',
    ],
    [
      '/webhooks?tab=deliveries',
      'deliveries',
      'event-center-tab-deliveries',
      'event-delivery-list',
    ],
    // 不带 tab / 带非法 tab 都归一化到默认的 endpoints ⇒ sources
    ['/webhooks', 'sources', 'event-center-tab-sources', 'webhook-endpoints'],
    ['/webhooks?tab=bogus', 'sources', 'event-center-tab-sources', 'webhook-endpoints'],
  ]

  for (const [from, tab, tabTestid, anchor] of cases) {
    await page.goto(`${daemon.baseUrl}${from}`)
    await expect(page.getByTestId('event-center-page')).toBeVisible()
    expect(
      new URL(page.url()).pathname + new URL(page.url()).search,
      `${from} 没有落到 /events?tab=${tab} ⇒ 老书签把人带到了事件中心的另一块，` +
        '用户会以为自己配的东西不见了',
    ).toBe(`/events?tab=${tab}`)
    await expect(
      page.getByTestId(tabTestid),
      `${from} 落地后高亮的不是 ${tab} 页签 ⇒ 地址对了、界面还停在别处`,
    ).toHaveAttribute('aria-selected', 'true')
    await expect(
      page.getByTestId(anchor),
      `${from} 落地后没有渲染出它本来要去看的东西（${anchor}）`,
    ).toBeVisible()
  }

  // replace: true —— 中转页不许进历史。否则用户按一次「后退」会被重定向再推回来，
  // 界面上表现为「后退键坏了」。
  await page.goto(`${daemon.baseUrl}/events?tab=overview`)
  await expect(page.getByTestId('event-source-tree')).toBeVisible()
  await page.goto(`${daemon.baseUrl}/webhooks?tab=triggers`)
  expect(new URL(page.url()).search).toBe('?tab=subscriptions')
  await page.goBack()
  await expect(page.getByTestId('event-center-page')).toBeVisible()
  expect(
    new URL(page.url()).pathname + new URL(page.url()).search,
    '后退没有回到上一个真实页面 ⇒ 兼容重定向把自己留在了历史里，用户被弹回同一个页签',
  ).toBe('/events?tab=overview')
})

// ---------------------------------------------------------------------------
// EVENT-X7 —— 触发规则向导的草稿撤销 / 重做
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-X7: 触发规则向导里连续打字算一步、换控件算另一步，撤销逐步回退、重做逐步前进，撤销之后再改一次就把重做分支截断 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await openEventsTab(page, 'subscriptions')
  await page.getByTestId('webhook-trigger-new').click()

  const dialog = page.getByTestId('webhook-trigger-dialog')
  await expect(dialog).toBeVisible()
  const undo = page.getByTestId('webhook-trigger-undo')
  const redo = page.getByTestId('webhook-trigger-redo')
  const name = page.getByTestId('wt-name')
  const scope = dialog.getByRole('radiogroup', { name: 'Repo scope' })
  const prefix = page.getByTestId('wt-scope-prefix')

  // --- (a) 空历史：两个键都不许可点 -----------------------------------------
  await expect(
    undo,
    '刚打开的向导上「撤销」是可点的 ⇒ 点下去要么什么都不发生、要么把用户带回一个他没见过的状态',
  ).toBeDisabled()
  await expect(redo).toBeDisabled()
  // 新规则草稿的默认仓库范围是「前缀」（TriggersPanel.tsx:162 EMPTY_DRAFT.scopeKind），
  // 所以前缀输入框一开始就在——这条用例改动的是**离开**这个默认值。
  await expect(prefix, '新建向导的默认仓库范围变了 ⇒ 下面这几步换的不是同一个状态').toBeVisible()

  // --- (b) 打字：整段输入合并成一步 -----------------------------------------
  await name.fill('rfc319 undo rule')
  await expect(
    undo,
    '打了字之后「撤销」仍然不可点 ⇒ 用户改错了名字只能自己一个字一个字删',
  ).toBeEnabled()
  await expect(redo).toBeDisabled()

  // --- (c) 换控件：另一步（原子）--------------------------------------------
  await scope.getByRole('radio', { name: 'All', exact: true }).click()
  await expect(
    prefix,
    '把仓库范围切到「全部仓库」之后前缀输入框还在 ⇒ 这一步在界面上不可见，撤销也就无从验证',
  ).toHaveCount(0)

  // --- (d) 撤销：一步一步回退 -----------------------------------------------
  await undo.click()
  await expect(
    prefix,
    '撤销一次没有把仓库范围退回去 ⇒ 撤销要么什么都没做，要么一次退了不止一步',
  ).toBeVisible()
  await expect(
    name,
    '撤销把仓库范围那一步和打字那一步一起退掉了 ⇒ 「一次撤销撤多少」不可预期，用户不敢用它',
  ).toHaveValue('rfc319 undo rule')
  await expect(redo).toBeEnabled()

  await undo.click()
  await expect(name, '第二次撤销没有把名字退回空 ⇒ 连续打字没有被合并成可回退的一步').toHaveValue(
    '',
  )
  await expect(
    undo,
    '退到最初状态之后「撤销」还可点 ⇒ 再点下去会退到一个不存在的更早状态',
  ).toBeDisabled()

  // --- (e) 重做：一步一步前进 -----------------------------------------------
  await redo.click()
  await expect(redo).toBeEnabled()
  await expect(name, '重做一次没有把名字恢复回来 ⇒ 误撤销之后无法挽回').toHaveValue(
    'rfc319 undo rule',
  )
  await expect(prefix, '重做一次就把两步都恢复了 ⇒ 重做与撤销的步长不对称').toBeVisible()
  await redo.click()
  await expect(prefix, '第二次重做没有恢复仓库范围那一步').toHaveCount(0)
  await expect(redo, '重做到底之后「重做」还可点 ⇒ 再点会前进到一个不存在的状态').toBeDisabled()

  // --- (f) 撤销之后再改一次 ⇒ 重做分支被截断 --------------------------------
  // 不截断的话，用户「撤销 → 改成别的 → 重做」会把刚被撤掉的旧改动盖回他刚写的新内容上。
  await undo.click()
  await expect(prefix).toBeVisible()
  await expect(redo).toBeEnabled()
  await name.fill('rfc319 undo rule v2')
  await expect(
    redo,
    '撤销之后又做了新的修改，「重做」却仍然可点 ⇒ 点下去会把一个已经被放弃的分支盖回来，' +
      '用户刚写的内容凭空消失',
  ).toBeDisabled()
  await expect(undo).toBeEnabled()
})
