// RFC-319 —— 定时任务（Scheduled Tasks）的用户面验收
// （EVENT-39 / EVENT-40 / EVENT-41 / EVENT-43 / EVENT-44 / EVENT-45 / EVENT-47 /
//   EVENT-X1 / EVENT-X3）。
//
// 这一域的共同点是**无人值守**：用户配好一条规则就走开了，之后再也不会盯着它。
// 于是这里的每一种失效都以「什么都没发生」或「悄悄发生了不该发生的事」呈现，
// 而不是一个红色横幅：
//
//   * 【EVENT-39】弹窗里预告「下次 10 月 3 日 14:17」，服务端却按别的时区排了另一
//     个时刻 —— 用户按预告安排了下游工作，实际却在半夜跑了。时区不是装饰：
//     `ScheduleDialog.tsx:22` 把**创建者浏览器的 IANA 时区**写进 spec，服务端的
//     `scheduleTime.ts:159-188` 就按那个时区解释 HH:MM。两头对不上，没人会发现。
//   * 【EVENT-40】「立即运行」本该只是试跑一次，如果它顺手推进了 `next_run_at` /
//     覆盖了「上次运行」/ 动了失败水位，用户每按一次就把真正的排期往后推一格，
//     或者反过来：手动试跑失败几次就把自动排期给停了。语义边界写在
//     `services/scheduledTasks.ts:1240-1256`（run-now 只 fireSchedule，不记账）。
//   * 【EVENT-41】开关关了但服务端还留着 `next_run_at` ⇒ 用户以为已经停了，它却在
//     半夜自己跑起来；反过来重新打开却不重算时刻 ⇒ 开了等于没开。清空与重算见
//     `services/scheduledTasks.ts:697-705`。
//   * 【EVENT-43】目标坏掉之后每 30 秒失败一次，永远失败下去：日志被刷屏、下游被
//     反复惊动，而没有任何人在看。自动停用是这条链的刹车，判据在
//     `services/scheduledTaskScheduler.ts:120-156`（一条 SQL 原子 +1 并停用，
//     `WHERE enabled=1 RETURNING` 保证只停一次）。停两次意味着重复通知/重复审计。
//   * 【EVENT-44】详情页的运行历史是用户回答「它到底跑没跑、跑成什么样」的唯一入口。
//     它空着或者对不上任务列表，用户就只能靠猜。
//   * 【EVENT-45】列表是这一域的总控台。搜不到、切不动视图、行高塌掉或者横向溢出，
//     用户就得靠肉眼在几十行里找那一条。
//   * 【EVENT-47】历史遗留 / 被写坏的行如果还摆着一个能点的「立即运行」，用户点下去
//     只会拿到一个看不懂的 500；正确形态是**禁用它并说清要修什么**。降级三态见
//     `services/scheduledTasks.ts:81-114` 与 `lib/schedule-view.ts:21-28`。
//   * 【EVENT-X1】总开关是管理员的急停闸。关了却还在跑 = 急停闸失灵；关了以后再打开
//     却不恢复 = 一次误操作把全平台的排期永久废掉。它是 per-tick 热读，不是启动期
//     快照：`services/scheduledTaskScheduler.ts:230-233`。
//   * 【EVENT-X3】删除只有一次机会。少一道确认就是误删，多一道却删不掉就是删不干净。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链）：
//   * 轮询与认领（CAS 推进 next_run_at）：packages/backend/src/services/scheduledTaskScheduler.ts:40-85
//   * 成功记账（重置连败 + firedAt 守卫）：packages/backend/src/services/scheduledTaskScheduler.ts:87-118
//   * 失败记账与一次性自动停用：packages/backend/src/services/scheduledTaskScheduler.ts:120-156
//   * tick 周期 30s / 默认阈值 10：packages/backend/src/services/scheduledTaskScheduler.ts:22-25
//   * 总开关与阈值的 per-tick 热读：packages/backend/src/services/scheduledTaskScheduler.ts:218-241
//   * 创建时排下次触发：packages/backend/src/services/scheduledTasks.ts:500-510
//   * 停用清空 / 重启用重算并清零连败：packages/backend/src/services/scheduledTasks.ts:693-706
//   * run-now 的语义边界（不动节奏字段）：packages/backend/src/services/scheduledTasks.ts:1240-1256
//   * 逐字段容错三态（degraded / legacy）：packages/backend/src/services/scheduledTasks.ts:81-114、142-181
//   * 删除路由：packages/backend/src/routes/scheduledTasks.ts:236-262
//   * 配置字段与默认值：packages/shared/src/schemas/config.ts:253-256
//   * 时刻计算（interval 网格 / 预设按 spec 时区）：packages/shared/src/scheduleTime.ts:142-197
//   * 弹窗字段与预览：packages/frontend/src/components/ScheduleDialog.tsx:22、96-108、150-157、333-344
//   * 列表行（开关 / 修复徽标 / 立即运行）：packages/frontend/src/routes/scheduled.tsx:306-462
//   * 详情页（启停 / 删除 / 降级横幅 / 自动停用 / 运行历史）：
//     packages/frontend/src/routes/scheduled.$id.tsx:98-254
//   * 立即运行的可用性判据与不可用原因：packages/frontend/src/lib/schedule-view.ts:21-28、
//     packages/frontend/src/components/ScheduledRunNowAction.tsx:42-69
//
// 与既有用例的分工（务必不要重复）：
//   * e2e/scheduled-task-firing.spec.ts —— EVENT-42「到点自己开工」的完整链路。
//     本文件不再重复「自动触发」本身，只在 EVENT-X1 / EVENT-43 里把 tick 当成
//     被观测的对象（总开关是否挡住它、失败到阈值它做了什么）。
//   * e2e/task-wizard.spec.ts 的
//     'scheduled agent (?schedule=1): save-as-scheduled is primary; run-now fires a task'
//     —— 只填了 schedule-name 就保存（默认 daily 09:00），并断言 launchKind==='agent'
//     与 run-now 能跑出一个 done 的任务。本文件的 EVENT-39 覆盖它没碰的四种频率、
//     时区与下次触发预览；EVENT-40 覆盖它没碰的「节奏字段一格不动」。
//   * e2e/rfc244-task-operations.spec.ts —— 已用真 daemon 证明 run-now 对
//     `enabled:false` 的定时任务有效（API 层）。本文件只补它的浏览器路径。
//   * e2e/rfc246-operations-surfaces.spec.ts 的
//     'desktop Scheduled and Repos keep dense rows, business views, and no overflow'
//     —— 用 page.route 假造的 28 行做排版验收。本文件 EVENT-45 不重做那套排版检查，
//     只用**真 API 建出来的行**把「搜索 / 视图 / 稠密 / 不溢出」在真实数据上过一遍。
//   * e2e/rfc250-interaction-integrity.spec.ts —— 降级行的禁用与 aria 断言建立在
//     **整族 page.route 假造**之上。本文件 EVENT-47 用真 daemon + 真损坏数据复核
//     同一条结论，并额外要求详情页说出**具体的解析原因**。

import { expect, test, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'

import { querySqlite, runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

// 浏览器时区固定在一个**非 UTC、非本机默认**的时区上。EVENT-39 的核心断言之一是
// 「spec 里记下来的时区就是创建者的时区」——如果这里跟着 runner 走，UTC runner 上
// 一个把时区写死成 'UTC' 的实现也能蒙混过关。
const CREATOR_TZ = 'Asia/Tokyo'
test.use({ timezoneId: CREATOR_TZ })

test.setTimeout(120_000)

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) {
    // 兜底：任何一条用例中途失败都不许把总开关 / 阈值留在被改过的状态上。
    await putConfig({ scheduledTasksEnabled: true, scheduledTasksMaxFailures: 10 }).catch(() => {})
    await daemon.stop()
  }
})

// ---------------------------------------------------------------------------
// Helpers —— 事实源优先级：服务端 API > 磁盘 DB > 页面 DOM。
// 任何「下次触发时刻」都取服务端返回值，绝不在测试进程里另算一份再比对。
// ---------------------------------------------------------------------------

interface ScheduleSpecWire {
  kind: 'interval' | 'daily' | 'weekly' | 'monthly'
  every?: number
  unit?: string
  at?: string
  daysOfWeek?: number[]
  dayOfMonth?: number
  timezone?: string
}

interface ScheduledTaskWire {
  id: string
  name: string
  launchKind: string
  launchPayload: Record<string, unknown> | null
  scheduleSpec: ScheduleSpecWire | null
  migrationNeeded: boolean
  migrationError: { launchPayload: string | null; scheduleSpec: string | null } | null
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: 'launched' | 'failed' | null
  lastError: string | null
  lastTaskId: string | null
  consecutiveFailures: number
  createdAt: number
  updatedAt: number
}

interface TaskSummaryWire {
  id: string
  name: string
  status: string
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

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: HTTP ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function putConfig(patch: Record<string, unknown>): Promise<void> {
  const res = await req('/api/config', { method: 'PUT', body: JSON.stringify(patch) })
  await jsonOf<Record<string, unknown>>(res, `PUT /api/config ${JSON.stringify(patch)}`)
}

/** 最简可启动工作流：一个文本输入直连一个输出端口，没有任何 agent 节点。 */
async function createWorkflow(name: string): Promise<{ id: string }> {
  return jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 scheduled-tasks fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'echo', bind: { nodeId: 'in_1', portName: 'topic' } }],
              position: { x: 320, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_out',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'out_1', portName: 'echo' },
            },
          ],
        },
      }),
    }),
    `create workflow ${name}`,
  )
}

async function createAgent(name: string): Promise<{ id: string }> {
  return jsonOf<{ id: string }>(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 scheduled-tasks fixture agent',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    }),
    `create agent ${name}`,
  )
}

/**
 * 远期 spec：`interval every 30 days` ⇒ `next_run_at = 创建时刻 + 30 天`。
 * 除非用例自己把 `next_run_at` 改到过去，否则后台 tick 绝不会碰这些夹具行——
 * 用日历预设（daily 09:00 之类）就做不到这一点：如果用例恰好在 08:59 跑，
 * 下一个槽只有一分钟远，tick 会在用例中途真的启动一个任务。
 */
const FAR_FUTURE_SPEC = { kind: 'interval' as const, every: 30, unit: 'days' as const }

async function createSchedule(body: {
  name: string
  workflowId: string
  enabled?: boolean
  scheduleSpec?: unknown
}): Promise<ScheduledTaskWire> {
  return jsonOf<ScheduledTaskWire>(
    await req('/api/scheduled-tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: body.name,
        launchKind: 'workflow',
        scheduleSpec: body.scheduleSpec ?? FAR_FUTURE_SPEC,
        enabled: body.enabled ?? true,
        launchPayload: {
          workflowId: body.workflowId,
          name: `${body.name}-run`,
          scratch: true,
          inputs: { topic: 'rfc319' },
        },
      }),
    }),
    `create scheduled task ${body.name}`,
  )
}

async function readSchedule(id: string): Promise<ScheduledTaskWire> {
  return jsonOf<ScheduledTaskWire>(
    await req(`/api/scheduled-tasks/${id}`),
    `read scheduled task ${id}`,
  )
}

async function scheduleStatus(id: string): Promise<number> {
  return (await req(`/api/scheduled-tasks/${id}`)).status
}

async function tasksOf(scheduleId: string): Promise<TaskSummaryWire[]> {
  return jsonOf<TaskSummaryWire[]>(
    await req(`/api/tasks?scheduledTaskId=${scheduleId}`),
    `list tasks of schedule ${scheduleId}`,
  )
}

async function runNow(id: string): Promise<{ taskId: string }> {
  return jsonOf<{ taskId: string }>(
    await req(`/api/scheduled-tasks/${id}/run-now`, { method: 'POST', body: '{}' }),
    `run-now ${id}`,
  )
}

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

/**
 * 直接改库，用来造出「HTTP 面造不出来」的状态：失败水位、被写坏的 launch_payload、
 * 已经到点的 `next_run_at`。id 是 ULID（26 位大写字母数字），先校形再拼进 SQL。
 */
function plantScheduleColumns(id: string, sets: Record<string, number | string | null>): void {
  expect(id, 'planting against a non-ULID id would mean a malformed SQL literal').toMatch(
    /^[0-9A-Z]{26}$/,
  )
  const assignments = Object.entries(sets).map(([column, value]) => {
    if (value === null) return `${column} = NULL`
    if (typeof value === 'number') return `${column} = ${value}`
    return `${column} = '${value.replace(/'/g, "''")}'`
  })
  runSqlite(dbPath(), `UPDATE scheduled_tasks SET ${assignments.join(', ')} WHERE id = '${id}';`)
}

function readScheduleColumns(id: string): Record<string, unknown> {
  const rows = querySqlite<Record<string, unknown>>(
    dbPath(),
    `SELECT enabled, next_run_at, consecutive_failures, updated_at FROM scheduled_tasks WHERE id = ?;`,
    [id],
  )
  expect(rows.length, `scheduled_tasks row ${id} disappeared`).toBe(1)
  return rows[0]!
}

/**
 * 合法 JSON、但不是任何一种合法启动体。读取面据此把行判成 degraded
 * （`services/scheduledTasks.ts:89-114`），触发面据此在启动**之前**抛
 * `schedule-payload-invalid`（`services/scheduledTasks.ts:914-921`）——
 * 也就是 recordFailure 那条分支的一个确定性替身。
 */
const BROKEN_PAYLOAD = JSON.stringify({ rfc319: 'launch payload shape is not valid' })

async function waitForSchedule(
  id: string,
  predicate: (row: ScheduledTaskWire) => boolean,
  timeoutMs: number,
  what: string,
): Promise<ScheduledTaskWire> {
  const deadline = Date.now() + timeoutMs
  let last: ScheduledTaskWire = await readSchedule(id)
  while (Date.now() < deadline) {
    last = await readSchedule(id)
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${what} — 超时 ${timeoutMs}ms；最后一次读到 ${JSON.stringify(last)}`)
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, token: daemon.token },
  )
}

async function openScheduledList(page: Page): Promise<void> {
  await page.goto(`${daemon.baseUrl}/scheduled`)
  await expect(page.getByTestId('scheduled-table')).toBeVisible()
}

async function openScheduledDetail(page: Page, id: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/scheduled/${id}`)
  await expect(page.getByTestId('scheduled-detail')).toBeVisible()
}

/** 两击确认控件（ConfirmButton.tsx:72-90）：第一击只是上膛，第二击才提交。 */
async function confirmTwice(button: Locator): Promise<void> {
  await button.click()
  await expect(button).toHaveClass(/btn--armed/)
  await button.click()
}

function tag(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

// ---------------------------------------------------------------------------
// EVENT-39 —— 新建定时任务：四种频率 + 时区 + 下次触发预览
// ---------------------------------------------------------------------------

/**
 * 取「创建者时区此刻的整点 + hours」作为 HH:MM。
 *
 * 这是在挑**输入**，不是在预测输出：唯一的目的是让目标时刻离现在至少两小时，
 * 从而排除「弹窗算预览」与「服务端算 next_run_at」之间那两秒里正好跨过目标时刻
 * 的可能。跨过去了两边就会各自指向相邻的两个槽，断言会以为产品坏了。
 */
function atHoursFromNow(hours: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CREATOR_TZ,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const raw = Number(parts.find((p) => p.type === 'hour')!.value)
  const hour = raw === 24 ? 0 : raw
  return `${String((hour + hours) % 24).padStart(2, '0')}:17`
}

/**
 * 走一遍用户真实路径：向导（agent + scratch）→「保存为定时任务」→ 频率弹窗 → 保存。
 * 返回弹窗在保存前预告的第一条触发时刻的**原样文案**（保存后弹窗就没了，只能先取）。
 */
async function createScheduleViaWizard(
  page: Page,
  opts: { agentId: string; name: string; fillSchedule: (dialog: Locator) => Promise<void> },
): Promise<{ previewFirst: string }> {
  await page.goto(`${daemon.baseUrl}/tasks/new?schedule=1&kind=agent&agentId=${opts.agentId}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('wizard-space-scratch').click()
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill(`${opts.name}-task`)
  await page.getByTestId('wizard-description').fill('rfc319 EVENT-39 fixture')
  await page.getByTestId('stepper-next').click()

  await page.getByTestId('wizard-save-scheduled').click()
  const dialog = page.getByTestId('schedule-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('schedule-name').fill(opts.name)
  await opts.fillSchedule(dialog)

  const previewItems = dialog.getByTestId('schedule-preview').locator('li')
  // 预览为空 = 用户在按下保存之前拿不到任何「它会在什么时候跑」的信息，
  // 只能保存完再回列表上找答案。
  await expect(previewItems, '频率填完了却预告不出任何一次触发时刻').toHaveCount(3)
  const previewFirst = ((await previewItems.first().textContent()) ?? '').trim()

  await page.getByTestId('schedule-save').click()
  await page.waitForURL(/\/scheduled$/, { timeout: 20_000 })
  return { previewFirst }
}

async function findScheduleByName(name: string): Promise<ScheduledTaskWire> {
  const rows = await jsonOf<ScheduledTaskWire[]>(
    await req('/api/scheduled-tasks'),
    'list scheduled tasks',
  )
  const found = rows.find((row) => row.name === name)
  expect(found, `保存后列表里找不到名为 ${name} 的定时任务`).toBeDefined()
  return found!
}

/**
 * 用**页面自己的格式化器**把服务端返回的 epoch 渲染一遍，再和弹窗预告的第一条比。
 * 两者都在同一个浏览器上下文（同 locale、同时区）里成型，所以这条断言比较的只有
 * 「时刻本身」，测试进程一次都没有自己算过时间。
 */
async function renderLikePreview(page: Page, epoch: number): Promise<string> {
  return page.evaluate(
    (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    epoch,
  )
}

test('EVENT-39 新建定时任务：四种频率逐字段落成服务端的 scheduleSpec，时区随创建者，下次触发时刻与弹窗预告的第一条指向同一时刻', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const suffix = tag()
  const agent = await createAgent(`evt39-agent-${suffix}`)
  await primeAuth(page)

  // ---- interval ----------------------------------------------------------
  const intervalName = `evt39-interval-${suffix}`
  await createScheduleViaWizard(page, {
    agentId: agent.id,
    name: intervalName,
    fillSchedule: async (dialog) => {
      await page.getByTestId('schedule-kind-interval').click()
      await page.getByTestId('schedule-every').fill('30')
      // 单位下拉是 Select（Select.tsx:415-440，role=combobox + 传送门 listbox）。
      // 只在 interval 分支里出现，所以弹窗内唯一。
      await dialog.getByRole('combobox').click()
      await page.getByRole('option', { name: 'minutes', exact: true }).click()
    },
  })
  const interval = await findScheduleByName(intervalName)
  // 落库的必须是「每 30 分钟」。落成默认的「每 6 小时」意味着用户在弹窗里选的东西
  // 根本没进请求——而列表上的摘要是照着 spec 画的，用户看不出差别，只会在半天后
  // 发现「怎么才跑了两次」。
  expect(interval.scheduleSpec, 'interval 的频率没有逐字段落库').toEqual({
    kind: 'interval',
    every: 30,
    unit: 'minutes',
  })
  expect(interval.launchKind, '向导里选的执行主体没跟着定时任务一起存下来').toBe('agent')
  expect(interval.enabled, '新建的定时任务默认就该是启用的，否则用户以为配好了其实没排上').toBe(
    true,
  )
  // interval 的下次触发 = 创建时刻 + 间隔（scheduleTime.ts:143-153，锚点即创建时刻）。
  // 两个数都来自服务端同一次写入，所以这里可以要求**精确相等**：差一格就意味着
  // 用户选的间隔在服务端被换成了别的值。
  expect(
    interval.nextRunAt,
    '「每 30 分钟」的第一次触发没有落在创建时刻 + 30 分钟上 ⇒ 服务端排的节奏与用户选的不是一回事',
  ).toBe(interval.createdAt + 30 * 60_000)

  // ---- daily -------------------------------------------------------------
  const dailyAt = atHoursFromNow(3)
  const dailyName = `evt39-daily-${suffix}`
  const dailyPreview = await createScheduleViaWizard(page, {
    agentId: agent.id,
    name: dailyName,
    fillSchedule: async () => {
      await page.getByTestId('schedule-kind-daily').click()
      await page.getByTestId('schedule-at').fill(dailyAt)
    },
  })
  const daily = await findScheduleByName(dailyName)
  expect(daily.scheduleSpec, 'daily 的时刻或时区没有逐字段落库').toEqual({
    kind: 'daily',
    at: dailyAt,
    timezone: CREATOR_TZ,
  })
  expect(
    await renderLikePreview(page, daily.nextRunAt!),
    '弹窗预告的第一次触发时刻与服务端真正排下的时刻不是同一个 ⇒ 用户按预告安排下游工作，实际会在别的时间跑',
  ).toBe(dailyPreview.previewFirst)

  // ---- weekly ------------------------------------------------------------
  const weeklyAt = atHoursFromNow(4)
  const weeklyName = `evt39-weekly-${suffix}`
  const weeklyPreview = await createScheduleViaWizard(page, {
    agentId: agent.id,
    name: weeklyName,
    fillSchedule: async () => {
      await page.getByTestId('schedule-kind-weekly').click()
      await page.getByTestId('schedule-at').fill(weeklyAt)
      // 默认已选周一（ScheduleDialog.tsx:78），再加一个周四 ⇒ 多选必须都留下。
      await expect(page.getByTestId('schedule-dow-1')).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('schedule-dow-4').click()
      await expect(page.getByTestId('schedule-dow-4')).toHaveAttribute('aria-pressed', 'true')
    },
  })
  const weekly = await findScheduleByName(weeklyName)
  // 只落下一个星期几 = 用户勾的「周一和周四」被静默砍成一天，一周少跑一次。
  expect(weekly.scheduleSpec, 'weekly 勾选的多个星期几没有全部落库').toEqual({
    kind: 'weekly',
    daysOfWeek: [1, 4],
    at: weeklyAt,
    timezone: CREATOR_TZ,
  })
  expect(
    await renderLikePreview(page, weekly.nextRunAt!),
    'weekly：弹窗预告与服务端排下的第一次触发时刻不一致',
  ).toBe(weeklyPreview.previewFirst)

  // ---- monthly -----------------------------------------------------------
  const monthlyAt = atHoursFromNow(5)
  const monthlyName = `evt39-monthly-${suffix}`
  const monthlyPreview = await createScheduleViaWizard(page, {
    agentId: agent.id,
    name: monthlyName,
    fillSchedule: async () => {
      await page.getByTestId('schedule-kind-monthly').click()
      await page.getByTestId('schedule-at').fill(monthlyAt)
      await page.getByTestId('schedule-dom').fill('21')
    },
  })
  const monthly = await findScheduleByName(monthlyName)
  expect(monthly.scheduleSpec, 'monthly 的号数 / 时刻 / 时区没有逐字段落库').toEqual({
    kind: 'monthly',
    dayOfMonth: 21,
    at: monthlyAt,
    timezone: CREATOR_TZ,
  })
  expect(
    await renderLikePreview(page, monthly.nextRunAt!),
    'monthly：弹窗预告与服务端排下的第一次触发时刻不一致',
  ).toBe(monthlyPreview.previewFirst)

  // 四条都真的出现在总控台上——保存成功却不在列表里，等于用户无从管理它。
  await openScheduledList(page)
  await page.getByTestId('scheduled-search').fill(suffix)
  await expect(page.locator('.scheduled-operations__row')).toHaveCount(4)
  for (const id of [interval.id, daily.id, weekly.id, monthly.id]) {
    await expect(
      page.getByTestId(`scheduled-row-${id}`),
      '保存成功的定时任务没有出现在 /scheduled 列表里 ⇒ 用户既看不到也管不了它',
    ).toBeVisible()
  }
})

// ---------------------------------------------------------------------------
// EVENT-40 —— 立即运行（run now）
// ---------------------------------------------------------------------------

/** run-now 明令不得触碰的六个「节奏 / 记账」字段。 */
function cadenceFields(row: ScheduledTaskWire): Record<string, unknown> {
  return {
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastTaskId: row.lastTaskId,
    consecutiveFailures: row.consecutiveFailures,
  }
}

test('EVENT-40 立即运行：下次触发时刻、上次结果与失败水位一格不动，只多出一个任务；已暂停的定时任务在详情页也照样跑得动', async ({
  page,
}) => {
  const suffix = tag()
  const wf = await createWorkflow(`evt40-wf-${suffix}`)
  const schedule = await createSchedule({ name: `evt40-${suffix}`, workflowId: wf.id })

  // 预置一份**非零**的节奏 / 记账状态。全 null 的行上做「前后相等」是空断言：
  // 一个把这些字段清零的实现也能通过。
  const plantedLastRunAt = Date.UTC(2026, 0, 2, 3, 4, 5)
  plantScheduleColumns(schedule.id, {
    consecutive_failures: 3,
    last_status: 'failed',
    last_error: 'rfc319-evt40-planted',
    last_run_at: plantedLastRunAt,
  })
  const before = await readSchedule(schedule.id)
  expect(before.consecutiveFailures).toBe(3)

  await primeAuth(page)
  await openScheduledList(page)
  await confirmTwice(page.getByTestId(`scheduled-run-now-${schedule.id}`))
  await page.waitForURL(/\/tasks\/[A-Z0-9]{26}(?:[?#]|$)/i, { timeout: 30_000 })
  const firstTaskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

  const after = await readSchedule(schedule.id)
  // 推进了 next_run_at ⇒ 用户每按一次「立即运行」就把真正的排期往后推一格；
  // 覆盖了 last_* ⇒ 手动试跑把「上一次自动运行的结果」擦掉，出问题时无从追溯；
  // 动了失败水位 ⇒ 手动试跑失败几次就能把自动排期整个停掉（或反过来把真实的
  // 连败记录清零，让自动停用永远不触发）。
  expect(
    cadenceFields(after),
    '「立即运行」动了定时任务自己的节奏 / 记账字段 —— 手动试跑本该只是试跑',
  ).toEqual(cadenceFields(before))

  const tasksAfterFirst = await tasksOf(schedule.id)
  expect(
    tasksAfterFirst.map((t) => t.id),
    '「立即运行」没有产出一个挂在这条定时任务名下的任务 ⇒ 用户点了却什么都没发生',
  ).toEqual([firstTaskId])

  // 已暂停的定时任务：run-now 是**手动覆写**，必须仍然可用——否则用户想验证一条
  // 暂停中的规则「改好没有」，就只能先把它打开、冒着它自己跑起来的风险。
  await jsonOf<ScheduledTaskWire>(
    await req(`/api/scheduled-tasks/${schedule.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    }),
    'disable schedule',
  )
  const beforePaused = await readSchedule(schedule.id)
  expect(beforePaused.enabled).toBe(false)

  await openScheduledDetail(page, schedule.id)
  const detailRunNow = page.getByTestId('scheduled-run-now')
  await expect(
    detailRunNow,
    '已暂停的定时任务把「立即运行」也一并禁掉了 ⇒ 用户无法手动验证一条暂停中的规则',
  ).toBeEnabled()
  await confirmTwice(detailRunNow)
  await page.waitForURL(/\/tasks\/[A-Z0-9]{26}(?:[?#]|$)/i, { timeout: 30_000 })
  const secondTaskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!
  expect(secondTaskId).not.toBe(firstTaskId)

  const afterPaused = await readSchedule(schedule.id)
  expect(
    cadenceFields(afterPaused),
    '对已暂停的定时任务按「立即运行」之后节奏字段被改动了',
  ).toEqual(cadenceFields(beforePaused))
  expect(
    afterPaused.enabled,
    '「立即运行」把一条暂停中的定时任务顺手启用了 ⇒ 用户只想试跑一次，结果它从此每天自己跑',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// EVENT-41 —— 启停开关（列表与详情两处）
// ---------------------------------------------------------------------------

test('EVENT-41 启停开关：列表里关掉就清空下次触发时刻，详情页重新打开则按频率重算时刻并把失败水位清零', async ({
  page,
}) => {
  const suffix = tag()
  const wf = await createWorkflow(`evt41-wf-${suffix}`)
  const schedule = await createSchedule({ name: `evt41-${suffix}`, workflowId: wf.id })
  expect(schedule.nextRunAt).not.toBeNull()

  await primeAuth(page)
  await openScheduledList(page)

  const rowSwitch = page.getByTestId(`scheduled-enable-${schedule.id}`)
  await expect(rowSwitch).toBeChecked()
  await rowSwitch.click()
  await expect(rowSwitch).not.toBeChecked()

  const disabled = await waitForSchedule(
    schedule.id,
    (row) => !row.enabled,
    15_000,
    '列表里的开关关掉了，服务端却仍然认为它是启用的',
  )
  // 只翻 enabled 而留着 next_run_at，行为上等于没关：轮询的 WHERE 是
  // `enabled=1 AND next_run_at<=now`（scheduledTaskScheduler.ts:45-51），
  // 任何一次误重启用都会让这条陈旧的时刻立刻到点。
  expect(
    disabled.nextRunAt,
    '关掉之后服务端还留着「下次触发时刻」⇒ 用户以为已经停了，它却随时可能自己跑起来',
  ).toBeNull()

  // 预置一段失败历史，好让「重新启用清零」这条断言有内容可清。
  plantScheduleColumns(schedule.id, { consecutive_failures: 4 })

  await openScheduledDetail(page, schedule.id)
  const toggle = page.getByTestId('scheduled-toggle')
  await expect(toggle, '详情页的启停按钮应当显示「可以启用」').toHaveText('Enable')
  await toggle.click()
  await expect(toggle, '启用成功后按钮没有翻面 ⇒ 用户不知道这一下到底生效没有').toHaveText(
    'Disable',
  )

  const reEnabled = await waitForSchedule(
    schedule.id,
    (row) => row.enabled,
    15_000,
    '详情页点了启用，服务端却仍然是停用状态',
  )
  // 重新启用却不重算时刻 ⇒ 开关打开了但永远不会到点，等于开了个假的。
  expect(reEnabled.nextRunAt, '重新启用之后没有重新排出下次触发时刻 ⇒ 开了等于没开').not.toBeNull()
  expect(
    reEnabled.nextRunAt!,
    '重算出来的下次触发时刻落在过去 ⇒ 它会在下一个 tick 立刻补跑',
  ).toBeGreaterThan(Date.now())
  // 不清零 ⇒ 一条修好后重新启用的规则带着旧的连败计数上路，再失败一次就被自动
  // 停用，用户会觉得「刚打开就又坏了」。
  expect(
    reEnabled.consecutiveFailures,
    '重新启用没有把失败水位清零 ⇒ 修好的规则带着旧账重新上路，很快又被自动停用',
  ).toBe(0)
})

// ---------------------------------------------------------------------------
// EVENT-44 —— 详情页的运行历史
// ---------------------------------------------------------------------------

test('EVENT-44 详情页运行历史：从「还没跑过」变成两行，每行对得上服务端的任务清单，点进去就是那个任务', async ({
  page,
}) => {
  const suffix = tag()
  const wf = await createWorkflow(`evt44-wf-${suffix}`)
  const schedule = await createSchedule({ name: `evt44-${suffix}`, workflowId: wf.id })

  await primeAuth(page)
  await openScheduledDetail(page, schedule.id)
  // 一条从没跑过的规则必须明说「还没跑过」。摆一张空表格或者干脆什么都不画，
  // 用户会以为是页面没加载出来，进而重复点「立即运行」。
  await expect(
    page.getByText('No runs yet.'),
    '一条从未运行过的定时任务没有明说「还没跑过」',
  ).toBeVisible()
  await expect(page.getByTestId('scheduled-history')).toHaveCount(0)

  const first = await runNow(schedule.id)
  const second = await runNow(schedule.id)
  expect(second.taskId).not.toBe(first.taskId)

  await openScheduledDetail(page, schedule.id)
  const historyRows = page.getByTestId('scheduled-history').locator('tbody tr')
  await expect(
    historyRows,
    '跑过两次，运行历史却不是两行 ⇒ 用户没法回答「它到底跑了几次」',
  ).toHaveCount(2)

  // 历史表里的每一行都必须指向服务端确实记在这条定时任务名下的任务。
  // 少一行 = 有一次运行被藏起来了；多一行 = 别的任务被算到了这条规则头上。
  const expectedIds = (await tasksOf(schedule.id)).map((t) => t.id).sort()
  expect(expectedIds).toHaveLength(2)
  const renderedHrefs = await historyRows
    .locator('a')
    .evaluateAll((anchors) =>
      anchors.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''),
    )
  expect(
    renderedHrefs.map((href) => href.split('/').pop()!).sort(),
    '运行历史里的行与服务端记在这条定时任务名下的任务对不上',
  ).toEqual(expectedIds)

  // 点第一行必须落到**它自己指向的那个任务**。断言只比 pathname：任务详情页有自己
  // 的分区查询串，把它算进比较里只会把「换了个分区」误判成「跳错了任务」。
  await historyRows.first().locator('a').click()
  await expect
    .poll(() => new URL(page.url()).pathname, {
      timeout: 20_000,
      message: '点开运行历史的一行没有落到它指向的那个任务 ⇒ 历史成了一张点不动的死表',
    })
    .toBe(renderedHrefs[0]!)
})

// ---------------------------------------------------------------------------
// EVENT-45 —— 列表的搜索 / 视图切换 / 稠密行 / 无横向溢出
// ---------------------------------------------------------------------------

test('EVENT-45 定时任务列表：搜索只留下命中的行，「已暂停」视图只留下关掉的那条，行高保持稠密且整页不横向溢出', async ({
  page,
}) => {
  const suffix = tag()
  const token = `evt45-${suffix}`
  const wf = await createWorkflow(`evt45-wf-${suffix}`)
  const enabledA = await createSchedule({ name: `${token}-alpha`, workflowId: wf.id })
  const enabledB = await createSchedule({ name: `${token}-bravo`, workflowId: wf.id })
  const paused = await createSchedule({
    name: `${token}-charlie`,
    workflowId: wf.id,
    enabled: false,
  })

  await primeAuth(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openScheduledList(page)

  const rows = page.locator('.scheduled-operations__row')
  // 搜不出来 = 用户在几十条规则里只能靠肉眼找。这里用真 API 建出来的三条，
  // 搜索必须**恰好**命中它们：多出一行说明搜索没起作用，少一行说明它在过滤真数据时漏了。
  await page.getByTestId('scheduled-search').fill(token)
  await expect(rows, '按名字搜索没有把结果收敛到命中的那几条').toHaveCount(3)
  for (const id of [enabledA.id, enabledB.id, paused.id]) {
    await expect(page.getByTestId(`scheduled-row-${id}`)).toBeVisible()
  }

  // 「已暂停」视图是用户找回「我关掉的那些」的唯一入口；它必须与搜索叠加生效，
  // 而不是把搜索条件冲掉。
  await page.getByTestId('scheduled-view-paused').click()
  await expect(rows, '「已暂停」视图没有把启用中的规则滤掉（或把搜索条件冲掉了）').toHaveCount(1)
  await expect(page.getByTestId(`scheduled-row-${paused.id}`)).toBeVisible()
  await expect(page.getByTestId(`scheduled-row-${enabledA.id}`)).toHaveCount(0)

  await page.getByTestId('scheduled-view-all').click()
  await expect(rows).toHaveCount(3)

  // 稠密行：一屏能看到的规则条数直接决定这张总控台好不好用。行高被撑开一倍，
  // 用户就得多滚一倍的屏才能扫完同样多的规则。
  const box = await page.getByTestId(`scheduled-row-${enabledA.id}`).boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height, '定时任务行被撑高，列表不再稠密').toBeGreaterThanOrEqual(56)
  expect(box!.height, '定时任务行被撑高，列表不再稠密').toBeLessThanOrEqual(64)

  // 横向溢出意味着「下次触发」「操作」这些右侧列被推出视口，用户要横向滚动才
  // 够得到开关和「立即运行」——在 1280 宽的桌面上这是明确的排版事故。
  const fits = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
    const doc = document.documentElement
    return {
      documentFits: doc.scrollWidth <= doc.clientWidth,
      mainFits: main !== null && main.scrollWidth <= main.clientWidth,
    }
  })
  expect(fits, '定时任务列表把整页撑得横向溢出，右侧的操作列要横向滚动才够得到').toEqual({
    documentFits: true,
    mainFits: true,
  })
})

// ---------------------------------------------------------------------------
// EVENT-47 —— 降级 / 需修复的历史定时任务
// ---------------------------------------------------------------------------

test('EVENT-47 配置已经读不出来的定时任务：列表禁掉「立即运行」并说明原因，详情页给出具体的解析理由，同列表其它行照常渲染', async ({
  page,
}) => {
  const suffix = tag()
  const token = `evt47-${suffix}`
  const wf = await createWorkflow(`evt47-wf-${suffix}`)
  const broken = await createSchedule({ name: `${token}-broken`, workflowId: wf.id })
  const healthy = await createSchedule({ name: `${token}-healthy`, workflowId: wf.id })

  // 把 launch_payload 写成**不是 JSON** 的内容——历史遗留行、手工改库、被截断的
  // 备份恢复都会长成这样。读取面必须逐字段容错（scheduledTasks.ts:89-114）。
  plantScheduleColumns(broken.id, { launch_payload: '{ this is not json' })
  const brokenRow = await readSchedule(broken.id)
  expect(
    brokenRow.launchPayload,
    '被写坏的启动配置没有被判成不可用 ⇒ 后面的禁用与提示都无从谈起',
  ).toBeNull()
  expect(brokenRow.migrationError?.launchPayload ?? '').toContain('invalid-json')

  await primeAuth(page)
  await openScheduledList(page)
  await page.getByTestId('scheduled-search').fill(token)
  await expect(page.locator('.scheduled-operations__row')).toHaveCount(2)

  // 一行坏数据不许拖垮整张表——旧实现里任何一行解析失败就整表 500，
  // 用户会看到「定时任务全都不见了」，而实际上只有一条坏了。
  await expect(
    page.getByTestId(`scheduled-row-${healthy.id}`),
    '一条坏行把同列表其它规则也一起弄消失了',
  ).toBeVisible()
  await expect(page.getByTestId(`scheduled-run-now-${healthy.id}`)).toBeEnabled()

  await expect(
    page.getByTestId(`scheduled-repair-${broken.id}`),
    '读不出配置的定时任务在列表上没有任何标记 ⇒ 用户根本不知道这一条已经不能用了',
  ).toBeVisible()

  const brokenRunNow = page.getByTestId(`scheduled-run-now-${broken.id}`)
  // 摆一个能点的「立即运行」，用户点下去只会拿到一个看不懂的服务端错误。
  await expect(
    brokenRunNow,
    '配置读不出来的定时任务还摆着一个能点的「立即运行」⇒ 点下去必然失败',
  ).toBeDisabled()
  const describedBy = await brokenRunNow.getAttribute('aria-describedby')
  expect(
    describedBy,
    '按钮被禁用却没有挂上「为什么不能用」的说明 ⇒ 读屏用户只知道点不动',
  ).not.toBeNull()
  // React 的 useId() 生成的 id 带非 CSS 标识符字符（«r3» 之类），只能用属性选择器取。
  await expect(
    page.locator(`[id="${describedBy!}"]`),
    '禁用原因是空的 —— 用户看得到按钮变灰，却不知道要修什么',
  ).toHaveText('Run now unavailable: restore the task launch configuration first.')

  await openScheduledDetail(page, broken.id)
  const banner = page.getByTestId('scheduled-degraded-banner')
  await expect(banner, '详情页对一条读不出配置的定时任务只字不提').toBeVisible()
  // 只说「坏了」不说「哪里坏了」，用户只能删掉重建。带上逐字段的解析原因才谈得上「可修复」。
  await expect(
    banner,
    '降级横幅没有带出具体的解析原因 ⇒ 用户不知道是 JSON 坏了还是格式变了，只能整条删掉重建',
  ).toContainText('invalid-json')
  await expect(
    page.getByTestId('scheduled-edit-config'),
    '降级的定时任务没有保留「重填任务配置」的修复入口 ⇒ 提示了问题却没给出路',
  ).toBeVisible()
  await expect(
    page.getByTestId('scheduled-run-now'),
    '详情页的「立即运行」对一条读不出配置的规则仍然可点',
  ).toBeDisabled()
})

// ---------------------------------------------------------------------------
// EVENT-X3 —— 删除定时任务
// ---------------------------------------------------------------------------

test('EVENT-X3 删除定时任务：第一次点击只是待确认（服务端仍在），第二次才真的删掉并回到列表', async ({
  page,
}) => {
  const suffix = tag()
  const wf = await createWorkflow(`evtx3-wf-${suffix}`)
  const schedule = await createSchedule({ name: `evtx3-${suffix}`, workflowId: wf.id })

  await primeAuth(page)
  await openScheduledDetail(page, schedule.id)

  // 这个删除按钮是 `ConfirmButton`，而 ConfirmButton 上膛时会把**可访问名与可见
  // 文案一起换成「Delete?」**（ConfirmButton.tsx:98-102）。所以这里不能按名字取它
  // ——按名字取到的 locator 一上膛就不再匹配，第二击会打在空处。改用结构定位：
  // 详情页页眉里唯一的 danger 按钮就是它（scheduled.$id.tsx:138-144）。
  const deleteButton = page.locator('[data-testid="scheduled-detail"] .page__actions .btn--danger')
  await expect(deleteButton).toHaveText('Delete')

  // 第一击只上膛。少了这道确认，用户在动作密集的详情页上一次误点就永久删掉一条
  // 排期——定时任务没有回收站。
  await deleteButton.click()
  await expect(deleteButton, '删除按钮点一下就直接执行了，没有二次确认').toHaveText('Delete?')
  expect(
    await scheduleStatus(schedule.id),
    '第一次点击就把定时任务删掉了 ⇒ 「确认」只是画上去的',
  ).toBe(200)

  await deleteButton.click()
  await page.waitForURL(/\/scheduled$/, { timeout: 20_000 })
  // 确认之后必须真的删掉。停在原地或者只是从列表里隐藏，用户会重复点删除，
  // 而那条规则仍然会到点自己跑。
  expect(
    await scheduleStatus(schedule.id),
    '确认删除之后服务端仍然留着这条定时任务 ⇒ 它还会继续到点自己跑',
  ).toBe(404)
  await expect(
    page.getByTestId('scheduled-table').or(page.getByTestId('scheduled-empty')),
  ).toBeVisible()
  await expect(
    page.getByTestId(`scheduled-row-${schedule.id}`),
    '删掉的定时任务还留在列表上',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// EVENT-X1 / EVENT-43 —— 与后台 tick 耦合的两条（@nightly）
//
// 【为什么打 @nightly】这两条的观察窗口由**真实 tick 周期**决定：
// `SCHEDULE_TICK_MS = 30_000`（scheduledTaskScheduler.ts:22），而 daemon 没有把
// `intervalMs` 暴露成任何配置（cli/start.ts:1476-1480 用的是默认值），所以「一个
// tick 之内什么都没发生」这件事最少要观察 30 秒以上，没有任何测试技巧能缩短它，
// 除非改生产代码加旋钮 —— 而本 RFC 是零生产改动。同域的
// e2e/scheduled-task-firing.spec.ts 已按同一理由分档，这里沿用。
// 每条用例都自带完整的配置准备与还原，不依赖同文件其它用例的执行顺序。
// ---------------------------------------------------------------------------

/** 任何长于一个 tick 周期的窗口都必然跨过至少一次 tick。40s 留了 10s 余量。 */
const ONE_TICK_WINDOW_MS = 40_000

test('EVENT-X1 定时任务总开关：关掉之后已经到点的排期一个 tick 都不会被认领；打开之后同一行立刻被认领并如实记账 @nightly', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const suffix = tag()
  const wf = await createWorkflow(`evtx1-wf-${suffix}`)
  const probe = await createSchedule({ name: `evtx1-${suffix}`, workflowId: wf.id })
  // 第二条保持健康：总开关只该关掉**自动**触发，手动「立即运行」是管理员在停摆
  // 期间验证 / 补跑的唯一手段，必须仍然可用。
  const manual = await createSchedule({ name: `evtx1-manual-${suffix}`, workflowId: wf.id })

  await putConfig({ scheduledTasksEnabled: false, scheduledTasksMaxFailures: 10 })
  try {
    // 造一个「已经到点」的排期：next_run_at 落在过去 ⇒ 轮询的 WHERE 一定命中它
    // （scheduledTaskScheduler.ts:45-51）。payload 换成不可启动的形状，这样即便
    // 真的被认领了，也只会留下一条失败记账而不会启动任何进程——观察成本最低，
    // 而认领这件事本身照样看得见（next_run_at 会被 CAS 推进）。
    plantScheduleColumns(probe.id, {
      launch_payload: BROKEN_PAYLOAD,
      next_run_at: Date.now() - 5_000,
    })
    const armed = await readSchedule(probe.id)
    expect(armed.nextRunAt!).toBeLessThan(Date.now())
    expect(armed.enabled).toBe(true)

    // ---- 关：整整一个 tick 周期内一个字节都不许动 -------------------------
    await new Promise((resolve) => setTimeout(resolve, ONE_TICK_WINDOW_MS))
    const silent = await readSchedule(probe.id)
    // 总开关是管理员的急停闸：出了事（比如下游被打爆）他关掉它，就必须立刻全平台
    // 停止自动触发。挡不住 = 急停闸失灵，而管理员会以为自己已经止住了血。
    expect(
      silent.nextRunAt,
      '总开关关着，已经到点的排期却仍然被认领（下次触发时刻被推进了）⇒ 管理员的急停闸挡不住任何东西',
    ).toBe(armed.nextRunAt)
    expect(silent.lastStatus, '总开关关着，排期却仍然产生了一次触发记账').toBeNull()
    expect(silent.consecutiveFailures, '总开关关着，失败水位却在上涨').toBe(0)
    expect(silent.enabled, '总开关不该改动单条排期自己的启停状态').toBe(true)

    // 总开关关的是**自动**触发（那个 return 在 tick 里，scheduledTaskScheduler.ts:231），
    // 手动「立即运行」走的是路由，不经过 tick。把它一起关掉，管理员在停摆期间就
    // 既不能验证修复、也不能补跑任何一条排期，只能先把急停闸放开——那等于没有急停闸。
    const manualRun = await runNow(manual.id)
    expect(
      manualRun.taskId,
      '总开关关着的时候连手动「立即运行」也跑不了 ⇒ 管理员在停摆期间无法验证修复，也无法补跑',
    ).toBeTruthy()
    expect((await tasksOf(manual.id)).map((t) => t.id)).toEqual([manualRun.taskId])
    // 手动补跑同样不许动这条排期自己的节奏字段（与 EVENT-40 同一条边界）。
    const manualRow = await readSchedule(manual.id)
    expect(manualRow.lastStatus, '手动补跑把定时任务的「上次运行」记账给写了').toBeNull()

    // ---- 开：同一行、同样的状态，只有开关变了 -----------------------------
    // 这一段同时是上一段的**阳性对照**：证明上面那 40 秒的「什么都没发生」是总开关
    // 挡住的，而不是后台循环本来就已经死了 —— 否则那条断言等于什么都没验证。
    await putConfig({ scheduledTasksEnabled: true })
    const fired = await waitForSchedule(
      probe.id,
      (row) => row.lastStatus !== null,
      120_000,
      '总开关重新打开之后，一条已经到点的排期仍然没有被认领 —— 一次误操作就把全平台的排期永久废掉了',
    )
    expect(fired.lastStatus, '重新打开后这一次触发没有被如实记账').toBe('failed')
    expect(
      fired.lastError,
      '触发失败却没有留下原因 ⇒ 用户在界面上只看到「失败」两个字',
    ).not.toBeNull()
    expect(
      fired.consecutiveFailures,
      '触发失败之后失败水位没有上涨 ⇒ 自动停用的刹车永远不会踩下去',
    ).toBe(1)
    expect(
      fired.nextRunAt!,
      '认领之后没有把下次触发时刻向前推 ⇒ 同一行会被每个 tick 反复认领，变成每 30 秒一次的无限触发',
    ).toBeGreaterThan(armed.nextRunAt!)

    // 用户面：失败必须显示在详情页上，而不是只躺在库里。
    await primeAuth(page)
    await openScheduledDetail(page, probe.id)
    await expect(
      page.getByText('Failed', { exact: true }).first(),
      '触发失败了，详情页的「上次运行」却不显示失败',
    ).toBeVisible()
  } finally {
    await putConfig({ scheduledTasksEnabled: true, scheduledTasksMaxFailures: 10 })
  }
})

test('EVENT-43 连续失败到达配置的阈值当场自动停用，而且只停这一次——停用之后不再被认领、失败水位不再上涨 @nightly', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const suffix = tag()
  const wf = await createWorkflow(`evt43-wf-${suffix}`)

  // 阈值从**配置**取（scheduledTaskScheduler.ts:234 每个 tick 热读）。这里设成 2，
  // 而代码里的内置默认是 10（scheduledTaskScheduler.ts:25）——所以「第 2 次失败就
  // 停用」这件事本身就证明了配置真的接上了线；配置没接线的实现会一直数到 10。
  await putConfig({ scheduledTasksEnabled: true, scheduledTasksMaxFailures: 2 })
  try {
    const target = await createSchedule({ name: `evt43-target-${suffix}`, workflowId: wf.id })
    // 见证行：与 target 同时到点、同样注定失败。它的作用只有一个——在后面那段
    // 「target 一动不动」的窗口里证明 **tick 确实跑过了**。没有它，「什么都没发生」
    // 既可能是「停用生效了」，也可能是「后台循环已经死了」，两者无法区分。
    const witness = await createSchedule({ name: `evt43-witness-${suffix}`, workflowId: wf.id })

    const dueAt = Date.now() - 5_000
    // target 预置到「阈值 − 1」：再失败一次就正好越线。这条用例锁的是**越线那一刻
    // 的停用动作**，不是调度器把水位一格格数上去的节奏（那属于 EVENT-42 的链路，
    // 已由 e2e/scheduled-task-firing.spec.ts 覆盖），所以直接把水位落库，
    // 而不是靠 sleep 等它自己失败 N 次。
    plantScheduleColumns(target.id, {
      launch_payload: BROKEN_PAYLOAD,
      consecutive_failures: 1,
      next_run_at: dueAt,
    })
    plantScheduleColumns(witness.id, {
      launch_payload: BROKEN_PAYLOAD,
      consecutive_failures: 0,
      next_run_at: dueAt,
    })

    const stopped = await waitForSchedule(
      target.id,
      (row) => !row.enabled,
      120_000,
      '连续失败已经越过配置的阈值，这条排期却还在启用状态 —— 它会每 30 秒失败一次，永远失败下去，而没有任何人在看',
    )
    expect(
      stopped.consecutiveFailures,
      '停用发生在别的计数上 ⇒ 自动停用读的不是配置里的阈值（内置默认是 10）',
    ).toBe(2)
    expect(stopped.lastStatus).toBe('failed')
    expect(
      stopped.lastError,
      '自动停用了却没留下失败原因 ⇒ 用户第二天只看到规则被关了，不知道为什么',
    ).not.toBeNull()

    // 用户面：被系统关掉与被人手动关掉，在界面上必须区分得出来，否则用户会直接
    // 再打开一次，然后眼睁睁看着它再被关掉。
    await primeAuth(page)
    await openScheduledDetail(page, target.id)
    await expect(
      page.getByTestId('scheduled-auto-disabled'),
      '系统自动停用了一条排期，详情页却不说是自动停用的 ⇒ 用户会以为是别人手动关的，直接再打开一次',
    ).toBeVisible()

    // ---- 只停这一次 --------------------------------------------------------
    // 把 target 重新摆成「已经到点」，但它现在是停用状态。轮询的 WHERE 带
    // `enabled=1`，所以它不该再被认领；失败记账的 WHERE 也带 `enabled=1`
    // （scheduledTaskScheduler.ts:145），所以水位也不该再涨。
    // 与此同时把见证行也摆成到点，用它来证明这段窗口里 tick 真的跑过。
    const frozen = readScheduleColumns(target.id)
    const replantedNext = Date.now() - 5_000
    plantScheduleColumns(target.id, { next_run_at: replantedNext })
    plantScheduleColumns(witness.id, { next_run_at: Date.now() - 5_000 })

    const witnessMoved = await waitForSchedule(
      witness.id,
      (row) => row.consecutiveFailures >= 2,
      120_000,
      '见证行没有被认领 —— 这段窗口里 tick 根本没跑，下面对 target 的「一动不动」断言将失去意义',
    )
    expect(witnessMoved.consecutiveFailures).toBeGreaterThanOrEqual(2)

    const after = readScheduleColumns(target.id)
    expect(
      after['enabled'],
      '已经自动停用的排期又被改动了启停状态 ⇒ 停用不是终点，用户关不住它',
    ).toBe(frozen['enabled'])
    expect(
      after['consecutive_failures'],
      '已经停用的排期失败水位还在上涨 ⇒ 它仍然在被认领、被触发，停用形同虚设',
    ).toBe(2)
    expect(
      after['next_run_at'],
      '已经停用的排期下次触发时刻还被推进 ⇒ 轮询没有按 enabled 过滤，停用挡不住认领',
    ).toBe(replantedNext)
    expect(
      after['updated_at'],
      '已经停用的排期在这段窗口里仍然被写过 ⇒ 停用动作重复发生（重复审计 / 重复通知）',
    ).toBe(frozen['updated_at'])
  } finally {
    await putConfig({ scheduledTasksEnabled: true, scheduledTasksMaxFailures: 10 })
  }
})
