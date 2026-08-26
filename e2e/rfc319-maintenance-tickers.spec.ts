// RFC-319 —— 慢时钟维护拍的用户面验收
// （EVENT-28 / EVENT-X4 / OPS-X9 / OPS-X3 / OPS-X5）。
//
// 这五条能力此前被判「做不了」，理由是「要等一个小时」。按源码对账后结论相反：
// **它们全都在一次 `startDaemon` 的十几分钟里就会发生**，代价只是墙钟长——
//
//   * 投递保留 GC 的首拍不在 T0+1h，而在 **T0+8min**：装配点
//     `cli/start.ts:929` 的 `startWebhookDeliveryGc(db, getConfig)` 只给两个参数，
//     于是相位取 `services/daemonCadence.ts:96` 的 `webhookDeliveryGc = 8 * MINUTE_MS`；
//     `services/maintenanceTicker.ts:158-167` 让**首个周期拍落在 `T0 + phaseOffsetMs`**
//     而不是 `T0 + intervalMs`。
//   * 保留期清扫同理落在 **T0+16min**（`cli/start.ts:933-940` 不传 intervalMs /
//     phaseOffsetMs ⇒ `services/maintenanceRetention.ts:191-193` 取
//     `daemonCadence.ts:100` 的 `retentionSweep = 16 * MINUTE_MS`）。
//   * 两个自愈闭环（autoKill / autoRepair）的唯一触发器是各自的裸 `setInterval`
//     （`services/autoKill.ts:210`、`services/autoRepair.ts:191`），周期取
//     `daemonCadence.ts:31/:37` 的 `5 * MINUTE_MS`，**没有 boot 首拍、没有 env 覆盖、
//     没有手动端点**，所以只能等到 **T0+5min**。
//
// 因为「没有 boot 首拍」正是这几条的形态，本文件里每条用例都必须先证明
// **到点之前它确实没发生**，再证明到点之后发生了。少了前半段，一个
// 「启动就把表清空」的实现照样能把后半段跑绿——而那种实现会在生产上删掉
// 运维刚要去看的那批投递。所以两条腿缺一不可，慢也得慢着测。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链，见 CLAUDE.md）：
//
//   * 相位与首拍语义：packages/backend/src/services/maintenanceTicker.ts:158-176
//     （`phaseMs = min(phaseOffsetMs, intervalMs)`；`bootDelayMs` 未给 ⇒ 无 boot 拍）、
//     packages/backend/src/services/daemonCadence.ts:96/:100（8min / 16min 相位）、
//     :31/:37（autoKill / autoRepair 各 5min 周期）。
//   * 投递保留 GC 的三段判据：packages/backend/src/services/webhook/deliveryStore.ts:176-218
//     （body 段 `received_at < bodyCutoff AND body_json IS NOT NULL AND status NOT IN
//     ('received','processing')`；行段 `received_at < rowCutoff` + 同一状态白名单 +
//     两条 MR 控制面 NOT EXISTS），天数→毫秒 `services/webhook/webhookGc.ts:31-36`。
//   * 保留期清扫：packages/backend/src/services/maintenanceRetention.ts:98-127
//     （事件三胞胎按行 ts 过期**且宿主终态**才删；distill 宿主判据
//     `j.status in ('done','failed','canceled')`）、:129-165（webhook_trigger_fires
//     按 fired_at 过期，且 `NOT EXISTS` 那条任务未终态的行——实现门 P1-3：
//     supersede 的唯一事实源，吃掉未终态那行会让同一 MR 上两个活任务互相踩）。
//   * 心跳停滞自动杀：packages/backend/src/services/autoKill.ts:96-110
//     （`running` + pid 非空 + 最后事件早于 `now - heartbeatStallMs`）、:126-158
//     （quarantine → breaker → driver lease → killChild → recovery 审计）、
//     packages/backend/src/util/process.ts:258-301（`killStaleRunProcessTree`：
//     pid 活着 + 48h 窗口 + `spawn_binary_path` 命令行匹配三关才发信号）。
//     **注意 autoKill.ts:149-156 无论 outcome 是什么都会落一条 `heartbeat-kill`
//     recovery 事件**，所以本文件的判据是「子进程真的没了 + node_run 真的终态」，
//     那条事件只作为补充断言（且断言它的 `outcome=killed`）。
//   * 自动修复 + 限流 + 隔离：packages/backend/src/services/autoRepair.ts:56-120
//     （规则开关 → quarantine → 唯一可自动应用选项 → breaker → 应用 + 审计）、
//     packages/shared/src/diagnose-repair.ts:76-79（`selectAutoApplyOption`：
//     恰好一个 eligible+available 才动手）、
//     packages/backend/src/services/lifecycleRepair/options-S4.ts:17-77
//     （v1 唯一 `autoApplyEligible` 的选项 `S4.kick-task`：pending → interrupted → resume）、
//     packages/backend/src/services/recoveryBreaker.ts:23-84（滚动窗口计数，
//     `attempts > maxPerWindow` ⇒ 落 `auto_recovery_suspended` 并记 `quarantine` 事件）。
//
// 与既有 spec 的分工（刻意不重叠）：
//   * e2e/rfc319-ops-events-and-repo-sweeps.spec.ts 的 OPS-X4/OPS-X10 锁的是
//     **周期孤儿对账**那一拍（60s 下限 + PUT /api/config 热生效）。本文件不碰它，
//     并且把 `periodicOrphanReconcileMs` 显式关成 0——否则「run 被收掉了」这件事
//     可以被那条循环解释，归因就没了。
//   * e2e/rfc319-ops-boot-gates-and-sweepers.spec.ts 锁的是 **boot 一次性闸门**与
//     终态任务工作区 GC。本文件锁的恰恰是它证明不了的那半：**没有 boot 拍**的循环。
//   * e2e/crash-recovery.spec.ts 只借用它起「真子进程」的姿势（slow stub + 真任务），
//     断言的对象（心跳停滞自动杀）与它的 SIGKILL 恢复语义无交集。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { initGitRepo, querySqlite, repoRemoteUrl, runSqlite } from './command'
import { startDaemon, type DaemonHandle, type SpawnOptions } from './harness'

// 文件级预算按最慢那条给（投递 GC 8min + 保留清扫 16min + 余量）。
// 单条另有更紧的 `test.setTimeout()`，见各用例首行。`describe.configure` 与
// `test.setTimeout()` 都写是刻意的：仓内已有文件实测过文件级 `test.setTimeout()`
// 不生效（见 e2e/rfc319-ops-settings-panels.spec.ts 的同名注释），两者同写时
// 以体内那次为准、以这里为兜底，任何一层失效都不会把慢用例判成超时。
test.describe.configure({ timeout: 1_560_000 })

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// ---------------------------------------------------------------------------
// 进程与目录的生命周期
// ---------------------------------------------------------------------------

const liveDaemons: DaemonHandle[] = []
const scratchDirs: string[] = []

async function launch(opts: SpawnOptions = {}): Promise<DaemonHandle> {
  const daemon = await startDaemon(opts)
  liveDaemons.push(daemon)
  return daemon
}

function scratchDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aw-rfc319-mt-${tag}-`))
  scratchDirs.push(dir)
  return dir
}

/** 尽力而为删目录：刚退出的子进程在 macOS 上仍可能短暂握着 worktree 目录项。 */
function bestEffortRemove(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      /* 下一轮重试；三次都失败就留给系统临时目录清理 */
    }
  }
}

test.afterEach(async () => {
  while (liveDaemons.length > 0) {
    const daemon = liveDaemons.pop()
    if (daemon !== undefined) await daemon.stop()
  }
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) bestEffortRemove(dir)
  }
})

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

async function req(daemon: DaemonHandle, path: string, init?: RequestInit): Promise<Response> {
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
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

function databasePath(daemon: DaemonHandle): string {
  return join(daemon.home, 'db.sqlite')
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 进程 uptime（秒）——本文件所有「到点没到点」的判定都以它为时钟。 */
async function uptimeSeconds(daemon: DaemonHandle): Promise<number> {
  const res = await fetch(`${daemon.baseUrl}/health`)
  expect(res.ok, `health: ${res.status}`).toBe(true)
  return ((await res.json()) as { uptime: number }).uptime
}

/**
 * 「尺子」的那条腿：在 daemon uptime 到 `targetSeconds` 之前反复跑 `probe`。
 *
 * 用 uptime 而不是本地 `Date.now()` 起算，是因为相位是从**进程启动**那一刻算的
 * （`maintenanceTicker.ts` 在 boot 装配时就把 setTimeout 挂上了），而夹具落库、
 * 建仓、起任务都发生在 ready 之后若干秒。拿本地时钟当起点会系统性地高估余量。
 */
async function holdUntilUptime(
  daemon: DaemonHandle,
  targetSeconds: number,
  probe: () => Promise<void>,
): Promise<void> {
  for (;;) {
    const uptime = await uptimeSeconds(daemon)
    if (uptime >= targetSeconds) return
    await probe()
    const remainingSeconds = Math.max(1, Math.min(15, targetSeconds - uptime))
    await new Promise((resolve) => setTimeout(resolve, remainingSeconds * 1_000))
  }
}

// ===========================================================================
// EVENT-28 / EVENT-X4 / OPS-X9
// ===========================================================================

/** 投递行：id 直接当可读标签用（表的主键是 text，不校验 ULID 形状）。 */
const DELIVERY_AGED_BODY = '01RFC319DLVAGEDBODY00000'
const DELIVERY_EXPIRED_ROW = '01RFC319DLVEXPIREDROW000'
const DELIVERY_IN_FLIGHT = '01RFC319DLVINFLIGHT00000'
const DELIVERY_FRESH = '01RFC319DLVFRESH00000000'

const FIRE_ORPHAN = '01RFC319FIREORPHAN000000'
const FIRE_LIVE_TASK = '01RFC319FIRELIVETASK0000'
const FIRE_FRESH = '01RFC319FIREFRESH0000000'
const FIRE_LIVE_TASK_ID = '01RFC319FIRELIVETASKROW0'

const DISTILL_JOB_SETTLED = '01RFC319DISTILLJOBDONE00'
const DISTILL_JOB_LIVE = '01RFC319DISTILLJOBLIVE00'
const DISTILL_SESSION_EXPIRED = 'rfc319-distill-expired'
const DISTILL_SESSION_LIVE = 'rfc319-distill-live-host'
const DISTILL_SESSION_FRESH = 'rfc319-distill-fresh'

function deliveryInsert(id: string, receivedAt: number, status: string, body: string): string {
  return (
    'INSERT INTO webhook_deliveries' +
    ' (id, endpoint_id, event_type, repo_path, status, received_at, body_json)' +
    ` VALUES (${sqlText(id)}, ${sqlText('01RFC319ENDPOINT00000000')}, ${sqlText('push')},` +
    ` ${sqlText('rfc319/maintenance')}, ${sqlText(status)}, ${String(receivedAt)},` +
    ` ${sqlText(body)});`
  )
}

function fireInsert(id: string, firedAt: number, taskId: string | null): string {
  return (
    'INSERT INTO webhook_trigger_fires' +
    ' (id, delivery_id, trigger_id, stream_key, outcome, task_id, fired_at)' +
    ` VALUES (${sqlText(id)}, ${sqlText(DELIVERY_FRESH)}, ${sqlText('01RFC319TRIGGER000000000')},` +
    ` ${sqlText('rfc319/maintenance|mr:7')}, ${sqlText('launched')},` +
    ` ${taskId === null ? 'NULL' : sqlText(taskId)}, ${String(firedAt)});`
  )
}

function distillJobInsert(id: string, status: string, nextRunAt: number, now: number): string {
  return (
    'INSERT INTO memory_distill_jobs' +
    ' (id, debounce_key, source_kind, source_event_id, scope_resolved_json, status, attempts,' +
    ' next_run_at, created_at)' +
    ` VALUES (${sqlText(id)}, ${sqlText(`rfc319-${id}`)}, ${sqlText('feedback')},` +
    ` ${sqlText(`rfc319-src-${id}`)}, ${sqlText('{"scope":"global"}')}, ${sqlText(status)}, 0,` +
    ` ${String(nextRunAt)}, ${String(now)});`
  )
}

function distillEventInsert(jobId: string, sessionId: string, ts: number): string {
  return (
    'INSERT INTO memory_distill_events (distill_job_id, attempt_index, session_id, ts, kind, payload)' +
    ` VALUES (${sqlText(jobId)}, 0, ${sqlText(sessionId)}, ${String(ts)}, ${sqlText('text')},` +
    ` ${sqlText('{"text":"rfc319 retention fixture"}')});`
  )
}

/** 一条**未终态**的任务：EVENT-X4 的保留期不得吃掉指向它的那条 fire 行。 */
function liveTaskInsert(taskId: string, now: number): string {
  return (
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,' +
    ' base_branch, branch, status, inputs, started_at, running_ms, space_kind, repo_count)' +
    ` VALUES (${sqlText(taskId)}, ${sqlText('RFC-319 retention live-task fixture')},` +
    ` ${sqlText('rfc319-retention-wf')},` +
    ` ${sqlText('{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}')},` +
    ` ${sqlText('/rfc319/retention-fixture')}, ${sqlText('/rfc319/retention-fixture/wt')},` +
    ` ${sqlText('main')}, ${sqlText(`agent-workflow/${taskId}`)}, ${sqlText('awaiting_human')},` +
    ` ${sqlText('{}')}, ${String(now - MINUTE_MS)}, 0, ${sqlText('scratch')}, 1);`
  )
}

interface DeliveryProbe {
  readonly present: boolean
  readonly bodyPresent: boolean
}

async function readDelivery(daemon: DaemonHandle, id: string): Promise<DeliveryProbe> {
  const res = await req(daemon, `/api/webhook-deliveries/${id}`)
  if (res.status === 404) {
    await res.text()
    return { present: false, bodyPresent: false }
  }
  const row = await jsonOf<{ bodyJson: string | null }>(res, `read delivery ${id}`)
  return { present: true, bodyPresent: row.bodyJson !== null }
}

/**
 * 四条投递行的状态摘要，**全程走公共 HTTP 面**（`GET /api/webhook-deliveries/:id`,
 * routes/webhookDeliveries.ts:153-158）——用户看到的就是这个面：body 被置空以后
 * 详情页上那段原文没了、整行删掉以后详情页 404。
 */
async function deliverySnapshot(daemon: DaemonHandle): Promise<string> {
  const labels: ReadonlyArray<readonly [string, string]> = [
    ['aged', DELIVERY_AGED_BODY],
    ['expired', DELIVERY_EXPIRED_ROW],
    ['inflight', DELIVERY_IN_FLIGHT],
    ['fresh', DELIVERY_FRESH],
  ]
  const parts: string[] = []
  for (const [label, id] of labels) {
    const probe = await readDelivery(daemon, id)
    parts.push(`${label}:${!probe.present ? 'gone' : probe.bodyPresent ? 'body' : 'no-body'}`)
  }
  return parts.join(' ')
}

/** 三条 fire 行 + 三条事件流水行的存活摘要（这两张表没有公共读取面，走库）。 */
function retentionSnapshot(daemon: DaemonHandle): string {
  const db = databasePath(daemon)
  const fires = new Set(
    querySqlite<{ id: string }>(db, 'SELECT id FROM webhook_trigger_fires WHERE id IN (?, ?, ?);', [
      FIRE_ORPHAN,
      FIRE_LIVE_TASK,
      FIRE_FRESH,
    ]).map((row) => row.id),
  )
  const sessions = new Set(
    querySqlite<{ session_id: string }>(
      db,
      'SELECT session_id FROM memory_distill_events WHERE session_id IN (?, ?, ?);',
      [DISTILL_SESSION_EXPIRED, DISTILL_SESSION_LIVE, DISTILL_SESSION_FRESH],
    ).map((row) => row.session_id),
  )
  const mark = (present: boolean): string => (present ? 'kept' : 'gone')
  return [
    `fireOrphan:${mark(fires.has(FIRE_ORPHAN))}`,
    `fireLiveTask:${mark(fires.has(FIRE_LIVE_TASK))}`,
    `fireFresh:${mark(fires.has(FIRE_FRESH))}`,
    `evExpired:${mark(sessions.has(DISTILL_SESSION_EXPIRED))}`,
    `evLiveHost:${mark(sessions.has(DISTILL_SESSION_LIVE))}`,
    `evFresh:${mark(sessions.has(DISTILL_SESSION_FRESH))}`,
  ].join(' ')
}

const DELIVERIES_UNTOUCHED = 'aged:body expired:body inflight:body fresh:body'
const DELIVERIES_AFTER_GC = 'aged:no-body expired:gone inflight:body fresh:body'
const RETENTION_UNTOUCHED =
  'fireOrphan:kept fireLiveTask:kept fireFresh:kept evExpired:kept evLiveHost:kept evFresh:kept'
const RETENTION_AFTER_SWEEP =
  'fireOrphan:gone fireLiveTask:kept fireFresh:kept evExpired:gone evLiveHost:kept evFresh:kept'

test('RFC-319 EVENT-28/EVENT-X4/OPS-X9: 同一台 daemon 上投递保留 GC 到第 8 分钟才置空 body 与删过期行、保留期清扫到第 16 分钟才删 fire 与事件流水，到点前一行不动，在飞投递与未终态宿主永不被删 @nightly', async () => {
  // 墙钟预算：夹具 ~10s + 第 7 分钟的静默腿 + 第 8 分钟的投递 GC 拍
  // + 第 16 分钟的保留清扫拍 + 余量。典型 ~17min，最坏 ~21min。
  test.setTimeout(1_500_000)

  // 保留期全部收到「天」的下限附近，好让 36h / 72h 的夹具行同时落在两侧：
  // body 1 天、整行 2 天（`routes/config.ts` 的保存门要求 body ≤ row，这里也遵守）；
  // 事件流水与 fire 各 1 天。`periodicOrphanReconcileMs: 0` 是归因需要——
  // 关掉唯一一条会去动 running 行的别的循环。
  const daemon = await launch({
    configOverrides: {
      webhookDeliveryBodyRetentionDays: 1,
      webhookDeliveryRowRetentionDays: 2,
      eventStreamRetentionDays: 1,
      webhookTriggerFiresRetentionDays: 1,
      periodicOrphanReconcileMs: 0,
    },
  })

  const now = Date.now()
  const db = databasePath(daemon)

  // 夹具在 daemon **起来之后**才种：这几个 ticker 都没有 boot 拍，种在启动前也一样，
  // 但「重启修复投递」（deliveryStore.ts:120-147，boot 时把 received/processing 行
  // 收尾）会把 in-flight 那条改写掉，那条腿就没了。
  runSqlite(
    db,
    [
      // 36h：过了 body 期（24h）、没过整行期（48h）⇒ 只置空 body。
      deliveryInsert(DELIVERY_AGED_BODY, now - 36 * HOUR_MS, 'matched', '{"rfc319":"aged"}'),
      // 72h：两条线都过 ⇒ 整行删掉。
      deliveryInsert(DELIVERY_EXPIRED_ROW, now - 72 * HOUR_MS, 'failed', '{"rfc319":"expired"}'),
      // 36h 但仍在 `received`：状态白名单挡着，body 一个字都不许动。
      deliveryInsert(DELIVERY_IN_FLIGHT, now - 36 * HOUR_MS, 'received', '{"rfc319":"inflight"}'),
      // 5 分钟前：保留期内，两段都不该碰它。
      deliveryInsert(DELIVERY_FRESH, now - 5 * MINUTE_MS, 'matched', '{"rfc319":"fresh"}'),
      liveTaskInsert(FIRE_LIVE_TASK_ID, now),
      // 36h + 没有任务锚定 ⇒ 该删。
      fireInsert(FIRE_ORPHAN, now - 36 * HOUR_MS, null),
      // 36h 但锚着一条 awaiting_human 的任务 ⇒ 实现门 P1-3 要求保留。
      fireInsert(FIRE_LIVE_TASK, now - 36 * HOUR_MS, FIRE_LIVE_TASK_ID),
      // 5 分钟前 ⇒ 保留期内。
      fireInsert(FIRE_FRESH, now - 5 * MINUTE_MS, null),
      distillJobInsert(DISTILL_JOB_SETTLED, 'done', now - DAY_MS, now - 3 * DAY_MS),
      // 宿主还没终态（且 next_run_at 在一天后，调度器不会认领它）⇒ 它的事件不许删。
      distillJobInsert(DISTILL_JOB_LIVE, 'pending', now + DAY_MS, now - 3 * DAY_MS),
      distillEventInsert(DISTILL_JOB_SETTLED, DISTILL_SESSION_EXPIRED, now - 36 * HOUR_MS),
      distillEventInsert(DISTILL_JOB_LIVE, DISTILL_SESSION_LIVE, now - 36 * HOUR_MS),
      distillEventInsert(DISTILL_JOB_SETTLED, DISTILL_SESSION_FRESH, now - 5 * MINUTE_MS),
    ].join('\n'),
  )

  // `bun:sqlite` 的多语句 exec 遇到约束错误既不抛也不报（docs/dev-gotchas.md）——
  // 回读自证，否则下面所有「它还在」的断言都会跑在不存在的行上、恒真。
  expect(await deliverySnapshot(daemon), '投递夹具没落库 ⇒ 后面的红绿都没有意义').toBe(
    DELIVERIES_UNTOUCHED,
  )
  expect(retentionSnapshot(daemon), '保留期夹具没落库 ⇒ 后面的红绿都没有意义').toBe(
    RETENTION_UNTOUCHED,
  )

  // --- 尺子腿：到第 7 分钟为止，两拍都还没到 ⇒ 一行都不许动 ------------------
  // 这条腿是本用例存在的理由。少了它，「boot 时把过期行一次性清空」的实现
  // 也能把下面两条腿跑绿——而那正是 RFC-311 明确拒绝的形态（体积封顶类维护
  // 任务被刻意排到开机风暴之后，见 daemonCadence.ts:60-70 的 bootDelay 注释）。
  await holdUntilUptime(daemon, 420, async () => {
    expect(
      await deliverySnapshot(daemon),
      '投递保留 GC 的首拍相位是 8 分钟（daemonCadence.ts:96），第 8 分钟之前谁也不该动过期投递 ⇒ ' +
        '要么有人偷偷加了 boot 首拍、要么相位被改小了：运维刚收到告警去翻投递详情，body 已经没了',
    ).toBe(DELIVERIES_UNTOUCHED)
    expect(
      retentionSnapshot(daemon),
      '保留期清扫的首拍相位是 16 分钟（daemonCadence.ts:100），第 16 分钟之前 fire 与事件流水都不该少一行',
    ).toBe(RETENTION_UNTOUCHED)
  })

  // --- EVENT-28：第 8 分钟的投递保留 GC ---------------------------------------
  await expect
    .poll(async () => deliverySnapshot(daemon), {
      timeout: 180_000,
      intervals: [5_000],
      message:
        '投递保留 GC 的首拍（T0+8min）没有把 36h 的 body 置空 / 72h 的整行删掉，或者把不该动的动了：' +
        `期望 "${DELIVERIES_AFTER_GC}"。in-flight 那条（status=received）被清了 body 就是 ` +
        'deliveryStore.ts:187 的状态白名单坏了——正在处理的投递被抽掉原文之后无法重放',
    })
    .toBe(DELIVERIES_AFTER_GC)

  // 此刻投递 GC 已经**确凿地跑过**，而保留期清扫（16 分钟）还没到。
  // 这是 EVENT-X4/OPS-X9 那条腿最硬的尺子：同一进程、同一时刻，一个动了、一个没动。
  expect(
    retentionSnapshot(daemon),
    '投递 GC 已经跑完（第 8 分钟）而保留期清扫（第 16 分钟）此刻不该跑过 ⇒ ' +
      '两个维护任务共用了同一个相位/首拍，daemonCadence.ts 的错峰表就失效了',
  ).toBe(RETENTION_UNTOUCHED)

  // --- EVENT-X4 / OPS-X9：第 16 分钟的保留期清扫 ------------------------------
  await expect
    .poll(() => retentionSnapshot(daemon), {
      timeout: 600_000,
      intervals: [5_000],
      message:
        '保留期清扫的首拍（T0+16min）没有删掉过期的 fire / 事件流水，或者删了不该删的：' +
        `期望 "${RETENTION_AFTER_SWEEP}"。fireLiveTask 变成 gone 就是 ` +
        'maintenanceRetention.ts:141-158 的「未终态任务不许删」失守——supersede 的唯一' +
        '事实源被吃掉之后，同一条 MR 上的下一次触发不再取消旧任务，两个活任务同分支互踩；' +
        'evLiveHost 变成 gone 则是宿主终态判据失守，未完成的蒸馏会呈现成「完成但面板空白」',
    })
    .toBe(RETENTION_AFTER_SWEEP)

  // 收尾对账：保留期清扫不该越界去动投递表（它的判据里根本没有那张表）。
  expect(
    await deliverySnapshot(daemon),
    '保留期清扫跑完之后投递行的状态变了 ⇒ 两个 sweep 的作用域串了',
  ).toBe(DELIVERIES_AFTER_GC)
})

// ===========================================================================
// OPS-X3 / OPS-X5
// ===========================================================================

const REPAIR_TASK_CLEAN = '01RFC319REPAIRCLEAN00000'
const REPAIR_TASK_BREAKER = '01RFC319REPAIRBREAKER000'
const REPAIR_TASK_QUARANTINED = '01RFC319REPAIRQUARANTINE'

const TERMINAL_NODE_RUN_STATUSES = new Set([
  'done',
  'failed',
  'canceled',
  'interrupted',
  'exhausted',
])

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程在，只是不归我们管；ESRCH = 真没了。
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 一条 pending 且**确实卡住**的任务 + 一条 open 的 S4 告警。
 *
 * `started_at` 取 20 分钟前是必须的：`stuckTaskDetector.ts:349-368` 的 S4 判据是
 * 「pending 超过 5 分钟」，而它自己的 5 分钟拍会与 autoRepair 的拍几乎同时落地。
 * 夹具如果不是真的 S4，那一拍会把我们种的告警 resolve 掉，autoRepair 就无事可做——
 * 用例会以一种看不出原因的方式变红。`worktree_path` 非空同样是必须的：
 * 空路径 + 有准备行会被判成 `preparing`（RFC-287 G7 豁免），阈值抬到 45 分钟。
 */
function pendingTaskWithS4Alert(
  taskId: string,
  now: number,
  breaker: { attempts: number; windowStartedAt: number | null; suspended: boolean },
): string {
  const alertId = `${taskId.slice(0, 20)}ALRT`
  return [
    'INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,' +
      ' base_branch, branch, status, inputs, started_at, running_ms, space_kind, repo_count,' +
      ' auto_recovery_attempts, auto_recovery_window_started_at, auto_recovery_suspended)' +
      ` VALUES (${sqlText(taskId)}, ${sqlText('RFC-319 auto-repair fixture')},` +
      ` ${sqlText('rfc319-autorepair-wf')},` +
      ` ${sqlText('{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}')},` +
      ` ${sqlText('/rfc319/autorepair-fixture')},` +
      ` ${sqlText(`/rfc319/autorepair-fixture/${taskId}`)},` +
      ` ${sqlText('main')}, ${sqlText(`agent-workflow/${taskId}`)}, ${sqlText('pending')},` +
      ` ${sqlText('{}')}, ${String(now - 20 * MINUTE_MS)}, 0, ${sqlText('scratch')}, 1,` +
      ` ${String(breaker.attempts)},` +
      ` ${breaker.windowStartedAt === null ? 'NULL' : String(breaker.windowStartedAt)},` +
      ` ${breaker.suspended ? '1' : '0'});`,
    'INSERT INTO lifecycle_alerts (id, task_id, rule, severity, detail, detected_at, resolved_at)' +
      ` VALUES (${sqlText(alertId)}, ${sqlText(taskId)}, ${sqlText('S4')}, ${sqlText('warning')},` +
      ` ${sqlText('{"rule":"S4","message":"task pending too long without scheduler pickup"}')},` +
      ` ${String(now - 10 * MINUTE_MS)}, NULL);`,
  ].join('\n')
}

async function seedAgentAndWorkflow(daemon: DaemonHandle): Promise<string> {
  const agent = await jsonOf<{ id: string }>(
    await req(daemon, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-heartbeat-stall',
        description: 'RFC-319 OPS-X3 fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    }),
    'seed agent',
  )
  const workflow = await jsonOf<{ id: string }>(
    await req(daemon, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-heartbeat-stall-wf',
        description: 'RFC-319 OPS-X3 fixture',
        definition: {
          $schema_version: 1,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'agent_1',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-heartbeat-stall',
              promptTemplate: '{{topic}}',
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
              id: 'e1',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'agent_1', portName: 'topic' },
            },
            {
              id: 'e2',
              source: { nodeId: 'agent_1', portName: 'answer' },
              target: { nodeId: 'out_1', portName: 'answer' },
            },
          ],
        },
      }),
    }),
    'seed workflow',
  )
  return workflow.id
}

interface LiveChild {
  readonly runId: string
  readonly pid: number
  readonly taskId: string
}

/** 等到 daemon 真的 spawn 了一个 runtime 子进程，并把 pid 记进 node_runs。 */
async function waitForLiveChild(daemon: DaemonHandle, taskId: string): Promise<LiveChild> {
  const rows = await new Promise<Array<{ id: string; pid: number; spawn_binary_path: string }>>(
    (resolve, reject) => {
      const deadline = Date.now() + 120_000
      const tick = (): void => {
        const found = querySqlite<{ id: string; pid: number; spawn_binary_path: string }>(
          databasePath(daemon),
          "SELECT id, pid, spawn_binary_path FROM node_runs WHERE task_id = ? AND pid IS NOT NULL AND status = 'running';",
          [taskId],
        )
        if (found.length > 0) {
          resolve(found)
          return
        }
        if (Date.now() > deadline) {
          reject(
            new Error(
              `waitForLiveChild: 任务 ${taskId} 在 120s 内没有落下带 pid 的 running node_run`,
            ),
          )
          return
        }
        setTimeout(tick, 500)
      }
      tick()
    },
  )
  const row = rows[0]
  expect(row, '没有拿到 node_run 行').toBeDefined()
  if (row === undefined) throw new Error('unreachable')
  expect(
    row.spawn_binary_path,
    'node_runs.spawn_binary_path 是空的 ⇒ killStaleRunProcessTree 的命令行身份闸（util/process.ts:281-285）' +
      '会以 command-mismatch 拒杀，本用例测的那条链路根本走不到',
  ).toBeTruthy()
  return { runId: row.id, pid: row.pid, taskId }
}

function nodeRunStatus(daemon: DaemonHandle, runId: string): string {
  const rows = querySqlite<{ status: string }>(
    databasePath(daemon),
    'SELECT status FROM node_runs WHERE id = ?;',
    [runId],
  )
  return rows[0]?.status ?? '(missing)'
}

function taskStatus(daemon: DaemonHandle, taskId: string): string {
  const rows = querySqlite<{ status: string }>(
    databasePath(daemon),
    'SELECT status FROM tasks WHERE id = ?;',
    [taskId],
  )
  return rows[0]?.status ?? '(missing)'
}

function recoveryKinds(daemon: DaemonHandle, taskId: string): string[] {
  return querySqlite<{ kind: string }>(
    databasePath(daemon),
    'SELECT kind FROM recovery_events WHERE task_id = ? ORDER BY created_at, id;',
    [taskId],
  ).map((row) => row.kind)
}

/**
 * 一次自愈拍的全景摘要。
 *
 * 刻意把「终态是哪一个」折叠成 `settled` / `repaired`：被杀掉的子进程按退出方式
 * 可能落 failed 也可能落 canceled，S4 修完之后 resumeTask 成不成功也会让任务停在
 * 不同的状态上——本用例要锁的是「动没动」，不是「落在哪个终态」。原始状态在
 * 轮询失败时由 expect.poll 打印出来，也另有断言逐条兜底。
 */
function healSnapshot(daemon: DaemonHandle, child: LiveChild): string {
  const runStatus = nodeRunStatus(daemon, child.runId)
  const cleanStatus = taskStatus(daemon, REPAIR_TASK_CLEAN)
  return [
    `child:${isProcessAlive(child.pid) ? 'alive' : 'gone'}`,
    `run:${TERMINAL_NODE_RUN_STATUSES.has(runStatus) ? 'settled' : runStatus}`,
    `clean:${cleanStatus === 'pending' ? 'pending' : 'repaired'}`,
    `breaker:${taskStatus(daemon, REPAIR_TASK_BREAKER)}`,
    `quarantined:${taskStatus(daemon, REPAIR_TASK_QUARANTINED)}`,
  ].join(' ')
}

const HEAL_BEFORE = 'child:alive run:running clean:pending breaker:pending quarantined:pending'
const HEAL_AFTER = 'child:gone run:settled clean:repaired breaker:pending quarantined:pending'

test('RFC-319 OPS-X3/OPS-X5: 心跳停滞的 runtime 子进程与 S4 卡死任务都要等到第 5 分钟那一拍才被处置，限流触顶的转隔离、已隔离的一动不动 @nightly', async () => {
  // 墙钟预算：建仓 + 起任务 ~20s + 第 4 分钟的静默腿 + 第 5 分钟的自愈拍 + 余量。
  // 典型 ~6min，最坏 ~9min。
  test.setTimeout(900_000)

  const repoDir = scratchDir('ops')
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 maintenance ticker fixture\n', 'utf-8')
  initGitRepo(repoDir)

  const daemon = await launch({
    // slow stub：起来之后一言不发地睡 15 分钟，正是 autoKill 模块开头描述的
    // 「进程活着但事件流全静默」的形态。
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '900000' },
    configOverrides: {
      autoKillStalledChild: true,
      // 静默 60 秒就算停滞。用例在第 4 分钟断言「还没被杀」，那时已经静默 ~3.5 分钟，
      // 远超阈值——所以那条腿证明的确实是「拍没到」，而不是「还没到阈值」。
      heartbeatStallMs: 60_000,
      autoRepair: { S4: true },
      // 限流窗口收到 1：夹具里那条 attempts 已经是 1 的任务，这一拍会把它推到 2 > 1，
      // 于是触顶转隔离；干净那条 0 → 1，不触顶，照修。
      maxAutoRecoveriesPerWindow: 1,
      // 归因：关掉唯一另一条会去动 running node_run 的循环。
      periodicOrphanReconcileMs: 0,
      // 子进程被杀之后不许再开一轮——否则「那条 run 终态了」会被一次重试盖过去。
      defaultNodeRetries: 0,
      sessionRestartBudget: 0,
    },
  })

  const workflowId = await seedAgentAndWorkflow(daemon)
  const launched = await jsonOf<{ id: string }>(
    await req(daemon, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId,
        name: 'rfc319-heartbeat-stall-task',
        inputs: { topic: 'rfc319 stalled child' },
        repoUrl: repoRemoteUrl(repoDir),
        ref: 'main',
      }),
    }),
    'launch task',
  )
  const child = await waitForLiveChild(daemon, launched.id)
  expect(
    isProcessAlive(child.pid),
    `daemon 记下的 pid ${child.pid} 一开始就不在 ⇒ 本用例没有可杀的对象`,
  ).toBe(true)

  const now = Date.now()
  runSqlite(
    databasePath(daemon),
    [
      // 干净的一条：这一拍应当被 S4.kick-task 修掉。
      pendingTaskWithS4Alert(REPAIR_TASK_CLEAN, now, {
        attempts: 0,
        windowStartedAt: null,
        suspended: false,
      }),
      // 窗口内已经用掉 1 次：这一拍会把计数推到 2，越过 maxAutoRecoveriesPerWindow=1
      // ⇒ 落隔离标志、记一条 quarantine，且**不动任务**。
      pendingTaskWithS4Alert(REPAIR_TASK_BREAKER, now, {
        attempts: 1,
        windowStartedAt: now - MINUTE_MS,
        suspended: false,
      }),
      // 已经被隔离：连选项都不该去解析，一条 recovery 事件都不该有。
      pendingTaskWithS4Alert(REPAIR_TASK_QUARANTINED, now, {
        attempts: 0,
        windowStartedAt: null,
        suspended: true,
      }),
    ].join('\n'),
  )

  expect(healSnapshot(daemon, child), '自愈夹具没落库 ⇒ 后面的红绿都没有意义').toBe(HEAL_BEFORE)

  // --- 尺子腿：第 4 分钟之前，两条闭环都还没拍 ⇒ 什么都不该发生 --------------
  // 到这一刻子进程已经静默约 3.5 分钟（阈值 60 秒），三条 S4 告警也已经 open 了
  // 三分多钟。它们仍然完好无损的唯一解释就是「那一拍还没到」。
  await holdUntilUptime(daemon, 240, async () => {
    expect(
      healSnapshot(daemon, child),
      'autoKill / autoRepair 的周期都是 5 分钟且**没有 boot 首拍**（autoKill.ts:210、autoRepair.ts:191）——' +
        '第 5 分钟之前谁也不该被杀、被修：提前发生就意味着有人给自愈闭环加了开机即跑的路径，' +
        '而这两条闭环都是 DEFAULT OFF 的破坏性操作，开机风暴里跑它们没有任何护栏',
    ).toBe(HEAL_BEFORE)
    await Promise.resolve()
  })

  // --- OPS-X3 + OPS-X5：第 5 分钟那一拍 ---------------------------------------
  await expect
    .poll(() => healSnapshot(daemon, child), {
      timeout: 300_000,
      intervals: [5_000],
      message:
        `第 5 分钟的自愈拍没有得到期望的结局 "${HEAL_AFTER}"：` +
        'child 还 alive ⇒ 心跳停滞判据（autoKill.ts:96-110）或 killStaleRunProcessTree 的' +
        '三道闸没让信号发出去，一个死锁的子进程会一直占着 30 分钟的硬超时；' +
        'clean 还 pending ⇒ S4.kick-task 没被自动应用（autoRepair.ts:80-84 要求恰好一个可自动应用选项）；' +
        'breaker / quarantined 不再是 pending ⇒ 限流窗口或隔离标志失守，' +
        '一个确定性崩溃的任务会被无限重驱、每轮都烧真实模型开销',
    })
    .toBe(HEAL_AFTER)

  // --- OPS-X3 的补充判据：那条 recovery 事件必须说自己真的杀掉了 --------------
  // autoKill.ts:149-156 无论 outcome 是什么都会落一条 heartbeat-kill，所以只看
  // 「有没有这条事件」是个恒真断言；要看它的 outcome。
  const killEvents = querySqlite<{ after_json: string | null }>(
    databasePath(daemon),
    "SELECT after_json FROM recovery_events WHERE node_run_id = ? AND kind = 'heartbeat-kill';",
    [child.runId],
  )
  expect(killEvents.length, '没有为停滞子进程记下 heartbeat-kill 审计 ⇒ 这次杀是不可追溯的').toBe(1)
  expect(
    killEvents[0]?.after_json ?? '',
    'heartbeat-kill 审计里的 outcome 不是 killed ⇒ 进程虽然没了，但不是这条链路杀的（' +
      'window-expired / command-mismatch 都会留下同一条事件），归因是假的',
  ).toContain('"outcome":"killed"')

  // --- OPS-X5 的补充判据：三条任务各自留下了该留的审计 ------------------------
  expect(
    recoveryKinds(daemon, REPAIR_TASK_CLEAN),
    '被自动修复的任务没有留下 auto-repair 审计（autoRepair.ts:93-101）',
  ).toContain('auto-repair')
  const repairAudit = querySqlite<{ option_id: string; outcome: string }>(
    databasePath(daemon),
    'SELECT option_id, outcome FROM lifecycle_repair_audit WHERE task_id = ?;',
    [REPAIR_TASK_CLEAN],
  )
  expect(
    repairAudit.map((row) => row.option_id),
    '自动修复应用的不是 S4.kick-task ⇒ v1 只有它一个 autoApplyEligible（options-S4.ts:33），' +
      '出现别的 option_id 说明自动闭环开始猜了',
  ).toEqual(['S4.kick-task'])
  expect(
    recoveryKinds(daemon, REPAIR_TASK_BREAKER),
    '限流触顶的任务没有留下 quarantine 审计 ⇒ recoveryBreaker.ts:74-83 的转隔离没发生',
  ).toContain('quarantine')
  expect(
    querySqlite<{ suspended: number }>(
      databasePath(daemon),
      'SELECT auto_recovery_suspended AS suspended FROM tasks WHERE id = ?;',
      [REPAIR_TASK_BREAKER],
    )[0]?.suspended,
    '限流触顶之后 auto_recovery_suspended 没有置位 ⇒ 下一拍会再试一次，窗口形同虚设',
  ).toBe(1)
  expect(
    recoveryKinds(daemon, REPAIR_TASK_QUARANTINED),
    '已隔离的任务身上出现了 recovery 事件 ⇒ autoRepair.ts:62-65 的 quarantine 短路失守：' +
      '人把一个反复炸的任务隔离起来之后，自愈闭环仍然在动它',
  ).toEqual([])
})
