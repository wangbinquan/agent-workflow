// P-5-01: hourly archival of node_run_events to JSONL on disk.
//
// Scans node_run_events; any node_run whose row count exceeds
// `perNodeRunRows` has its oldest rows dumped to
// `${logsDir}/{taskId}/{nodeRunId}.jsonl` (append-only) and deleted from
// the DB. After per-group passes, if the total row count still exceeds
// `globalRows`, the globally-oldest rows are archived in the same way
// until the total fits.
//
// The events endpoint (getNodeRunEvents) transparently falls back to the
// JSONL file, so the UI sees a single seamless stream.

import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
import { MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
import { readMaintenanceNumber, writeMaintenanceValue } from '@/services/maintenanceState'
import { createLogger } from '@/util/log'

const log = createLogger('events-archive')

const HOUR_MS = 60 * 60 * 1000

export interface ArchiveRunResult {
  perGroupArchived: number
  globalArchived: number
  files: string[]
}

/**
 * One archival pass. Returns counters for tests / log lines.
 */
/** RFC-311：单批行数上限——SELECT 物化与删除都按批推进，绝不再构造
 *  「toDrop 个绑定参数的巨型 IN」（超过 SQLite 32766 参数上限直接报错，
 *  归档器曾因此每小时失败、事件表只涨不缩——审计 L3-4 的死循环）。 */
const ARCHIVE_BATCH_ROWS = 5_000
/** 单轮 tick 的归档行数预算：超额留给下一轮，避免单 tick 在同步连接上
 *  连续占用事件循环过久（每批之间已让出）。 */
const ARCHIVE_TICK_BUDGET_ROWS = 200_000
/** 单条扫描语句覆盖的 id 区间宽度(RFC-311 G3)。它约束的是**一条语句冻结
 *  daemon 的时长**,不是本轮总工作量——后者仍由上面的行预算决定。50 万这个
 *  10 万这个宽度在 10M 事件库上实测约 40ms/条,刚好落在慢查询阈值(50ms)以下;
 *  500 万时曾实测 210ms/条、无窗时 1190ms/条。 */
const ARCHIVE_SCAN_WINDOW_IDS = 100_000
/** 一轮最多考察多少个候选 run。行预算管的是「删多少」,这条管的是「查多少」——
 *  backlog 首轮的候选量以百万计,没有这条的话一轮会把几百万个 run 全查一遍。 */
const ARCHIVE_TICK_CANDIDATE_RUNS = 50_000
/** 单条分组计数语句一次问多少个 run(绑定参数上限之下的安全值)。 */
const ARCHIVE_COUNT_CHUNK = 5_000

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}
/** maintenance_state 键：per-run pass 的增量扫描水位（上次扫过的 max(id)）。 */
const HIGH_WATER_KEY = 'events_archive_high_water'

/**
 * One archival pass. Returns counters for tests / log lines.
 */
/** RFC-311（proposal C3）——把字节预算折算成有效行数阈值：按最近 1000 行的
 *  平均 payload 宽度采样（O(1000)，零写放大），与行数阈值取 min。生产事故
 *  形态正是「行数没到水位、字节已到 2.2GB」。每行外加 ~48B 固定列开销。 */
interface ArchiveThresholds {
  perNodeRunRows: number
  globalRows: number
  /** 可选：既有调用方/测试仍可传二键形态（bytes 视为关闭）。 */
  perNodeRunBytes?: number
  globalBytes?: number
}

async function effectiveRowThresholds(
  db: DbClient,
  thresholds: ArchiveThresholds,
): Promise<{ perNodeRunRows: number; globalRows: number }> {
  const { perNodeRunRows, globalRows } = thresholds
  const perNodeRunBytes = thresholds.perNodeRunBytes ?? 0
  const globalBytes = thresholds.globalBytes ?? 0
  if (perNodeRunBytes <= 0 && globalBytes <= 0) return { perNodeRunRows, globalRows }
  const sampled = (await db.all(
    sql`SELECT AVG(LENGTH(payload)) AS avg FROM (
      SELECT payload FROM node_run_events ORDER BY id DESC LIMIT 1000
    )`,
  )) as Array<{ avg: number | null }>
  const avgRowBytes = Math.max(64, Math.round(sampled[0]?.avg ?? 0) + 48)
  const derive = (bytes: number, rows: number): number =>
    bytes > 0 ? Math.min(rows, Math.max(1_000, Math.floor(bytes / avgRowBytes))) : rows
  return {
    perNodeRunRows: derive(perNodeRunBytes, perNodeRunRows),
    globalRows: derive(globalBytes, globalRows),
  }
}

export async function archiveEvents(
  db: DbClient,
  config: { eventsArchiveThresholds: ArchiveThresholds },
  logsDir: string,
  /** 测试注入:把扫描窗口调小到几十行，才测得出窗口边界有没有漏行。 */
  opts: { scanWindowIds?: number } = {},
): Promise<ArchiveRunResult> {
  const scanWindowIds = opts.scanWindowIds ?? ARCHIVE_SCAN_WINDOW_IDS
  const { perNodeRunRows, globalRows } = await effectiveRowThresholds(
    db,
    config.eventsArchiveThresholds,
  )
  const result: ArchiveRunResult = { perGroupArchived: 0, globalArchived: 0, files: [] }
  const touched = new Set<string>()
  let budget = ARCHIVE_TICK_BUDGET_ROWS

  // --- Per-node-run pass (RFC-311: incremental) ---------------------------
  // The old shape GROUP BY'd the ENTIRE table every hour (O(all rows) even as
  // an index-only scan). Rows are append-only from the archiver's viewpoint,
  // so a run can only cross the threshold by RECEIVING NEW ROWS: scanning
  // only rows above the last-seen high water finds every newly-over-limit
  // run. First pass (no watermark) scans everything once and clears backlog.
  // The watermark only advances on a fully successful pass, so a failed
  // archive attempt gets rescanned next tick.
  const highWater = (await readMaintenanceNumber(db, HIGH_WATER_KEY)) ?? 0
  const maxIdRow = await db
    .select({ m: sql<number | null>`max(${nodeRunEvents.id})` })
    .from(nodeRunEvents)
  const maxId = maxIdRow[0]?.m ?? 0

  // RFC-311 G3 —— 扫描按 id 区间**分窗**。此前这条 GROUP BY 的上界是开的:
  // 首轮(水位=0)等于把整张表扫一遍,10M 事件库实测**单条语句 1.19 秒**——
  // 而 daemon 只有一条同步连接,这 1.19 秒里整站没有响应。分窗把「单条语句的
  // 时长」与「本轮总工作量」解耦:每条语句只看一个 id 窗口,轮次总量仍由
  // ARCHIVE_TICK_BUDGET_ROWS 约束,于是首轮 backlog 变成一串可打断的短语句。
  let scanFrom = highWater
  let advancedTo = highWater
  let candidateBudget = ARCHIVE_TICK_CANDIDATE_RUNS
  while (scanFrom < maxId && budget > 0 && candidateBudget > 0) {
    const scanTo = Math.min(maxId, scanFrom + scanWindowIds)
    // 窗口里出现过新事件的 run 就是候选。注意这里拿的是**候选集**而不是计数:
    // 同一个 run 会横跨多个窗口,窗口内计数不是它的总量。
    const candidates = (
      await db
        .selectDistinct({ nodeRunId: nodeRunEvents.nodeRunId })
        .from(nodeRunEvents)
        .where(and(gt(nodeRunEvents.id, scanFrom), lte(nodeRunEvents.id, scanTo)))
    ).map((row) => row.nodeRunId)

    // 候选的**总量**分块一次性算。此前是每个候选发一条 count ——分窗之后同一个
    // run 会被反复问,实测把一轮从 6 秒劣化到 260 秒(10M 事件库)。一条分组
    // 语句顶一整块候选,既短又不重复。
    const overs: Array<{ nodeRunId: string; own: number }> = []
    for (const chunk of chunked(candidates, ARCHIVE_COUNT_CHUNK)) {
      const rows = await db
        .select({ nodeRunId: nodeRunEvents.nodeRunId, n: count(nodeRunEvents.id) })
        .from(nodeRunEvents)
        .where(inArray(nodeRunEvents.nodeRunId, chunk))
        .groupBy(nodeRunEvents.nodeRunId)
      for (const row of rows) {
        if (row.n > perNodeRunRows) overs.push({ nodeRunId: row.nodeRunId, own: row.n })
      }
    }
    candidateBudget -= candidates.length

    for (const over of overs) {
      if (budget <= 0) break
      const toDrop = Math.min(over.own - perNodeRunRows, budget)
      const file = await archiveOldestForNode(db, over.nodeRunId, toDrop, logsDir)
      budget -= toDrop
      if (file !== null) {
        result.perGroupArchived += toDrop
        touched.add(file)
      }
    }
    // 只有整窗处理完(没被预算截断)才认这一窗:被截断的那一窗下轮重扫,
    // 宁可重做也不能让水位跳过没处理的行。
    if (budget <= 0) break
    advancedTo = scanTo
    scanFrom = scanTo
  }
  // Advance the watermark only when the pass was not budget-truncated, so
  // deferred work is rescanned rather than silently skipped.
  if (budget > 0 && advancedTo > highWater) {
    await writeMaintenanceValue(db, HIGH_WATER_KEY, String(advancedTo))
  }

  // --- Global pass --------------------------------------------------------
  // COUNT(*) once per hour is acceptable under the RFC-311 page-cache budget;
  // a running counter would drift (taskDelete cascades also remove rows).
  const totalRow = await db.select({ n: count(nodeRunEvents.id) }).from(nodeRunEvents)
  let total = totalRow[0]?.n ?? 0
  while (total > globalRows && budget > 0) {
    // Find the oldest event row, then archive its node_run's oldest chunk.
    const oldest = await db
      .select({ id: nodeRunEvents.id, nodeRunId: nodeRunEvents.nodeRunId })
      .from(nodeRunEvents)
      .orderBy(asc(nodeRunEvents.id))
      .limit(1)
    if (oldest.length === 0) break
    const head = oldest[0]!
    const overflow = total - globalRows
    // Don't drop more than this node_run actually owns at the head.
    const ownCount = await db
      .select({ n: count(nodeRunEvents.id) })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, head.nodeRunId))
    const own = ownCount[0]?.n ?? 0
    const toDrop = Math.min(overflow, own, budget)
    if (toDrop <= 0) break
    const file = await archiveOldestForNode(db, head.nodeRunId, toDrop, logsDir)
    budget -= toDrop
    if (file === null) break
    result.globalArchived += toDrop
    touched.add(file)
    total -= toDrop
  }

  result.files = [...touched]
  if (result.perGroupArchived > 0 || result.globalArchived > 0) {
    log.info('archived events', {
      perGroupArchived: result.perGroupArchived,
      globalArchived: result.globalArchived,
      files: result.files.length,
    })
  }
  return result
}

/**
 * Archive the oldest `count` rows for one node_run. Returns the JSONL file
 * path that was written to (or null if the node_run is unknown / orphaned).
 */
async function archiveOldestForNode(
  db: DbClient,
  nodeRunId: string,
  toDrop: number,
  logsDir: string,
): Promise<string | null> {
  if (toDrop <= 0) return null
  const owner = await db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const taskId = owner[0]?.taskId

  // RFC-311: both branches advance in bounded batches and delete by ID RANGE
  // (`node_run_id = ? AND id <= ?` rides idx_events_node with two bound
  // params) — the old one-shot `IN (<toDrop ids>)` exceeded SQLite's 32766
  // bound-parameter limit on any real backlog and made the archiver fail
  // every hour (audit L3-4).
  if (taskId === undefined) {
    // Orphan event rows — delete them so they don't block the global cap.
    let remaining = toDrop
    while (remaining > 0) {
      const batch = await db
        .select({ id: nodeRunEvents.id })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
        .orderBy(asc(nodeRunEvents.id))
        .limit(Math.min(remaining, ARCHIVE_BATCH_ROWS))
      const lastId = batch.at(-1)?.id
      if (lastId === undefined) break
      await db
        .delete(nodeRunEvents)
        .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), lte(nodeRunEvents.id, lastId)))
      remaining -= batch.length
      if (batch.length < ARCHIVE_BATCH_ROWS) break
    }
    return null
  }

  const file = jsonlPath(logsDir, taskId, nodeRunId)
  mkdirSync(dirname(file), { recursive: true })
  let dropped = 0
  let wroteAny = false
  while (dropped < toDrop) {
    const rows = await db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .orderBy(asc(nodeRunEvents.id))
      .limit(Math.min(toDrop - dropped, ARCHIVE_BATCH_ROWS))
    if (rows.length === 0) break
    let buf = ''
    for (const r of rows) {
      // 实现门 P1-4:sessionId / parentSessionId **必须**跟着落盘。会话树
      // (services/sessionView.ts 的 parseSessionTree)完全靠这两列建树,丢了它们
      // 就不只是「少了历史」——deriveRootSessionId 会退化成「取残留事件里的第一个
      // sessionId」,那通常是子代理会话,于是整棵对话树以子代理为根渲染。
      // 字节水位把归档从「生产从未触发」变成长会话常态,这条不能等。
      buf +=
        JSON.stringify({
          id: r.id,
          ts: r.ts,
          kind: r.kind,
          payload: r.payload,
          sessionId: r.sessionId,
          parentSessionId: r.parentSessionId,
        }) + '\n'
    }
    // Append BEFORE delete: a crash between the two duplicates rows into the
    // JSONL (the reader tolerates that — ids are monotonic and consumers
    // filter `id > since`), it never loses them.
    appendFileSync(file, buf, 'utf-8')
    wroteAny = true
    const lastId = rows.at(-1)!.id
    await db
      .delete(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), lte(nodeRunEvents.id, lastId)))
    dropped += rows.length
    if (rows.length < ARCHIVE_BATCH_ROWS) break
  }
  return wroteAny ? file : null
}

/**
 * Read archived JSONL events (id > since) up to `limit` rows. Returns []
 * if the file does not exist. The `payload` field is the raw stored string
 * (matching the DB column) — callers parse it themselves so we don't lose
 * the original bytes for stdout-style concatenation.
 */
export async function readArchivedEvents(
  logsDir: string,
  taskId: string,
  nodeRunId: string,
  since: number,
  limit: number,
): Promise<
  Array<{
    id: number
    ts: number
    kind: string
    payload: string
    sessionId: string | null
    parentSessionId: string | null
  }>
> {
  const file = jsonlPath(logsDir, taskId, nodeRunId)
  if (!existsSync(file)) return []
  // 实现门 P1-2:此前 `Bun.file(file).text()` 把整个 JSONL 读成一个字符串,`limit`
  // 再小也不能少读一个字节。字节水位(C3)把 per-run 有效阈值从 5 万行压到几千行,
  // 于是「几十 MB 的归档文件」从罕见变成常态,而这条路径每次列表/详情请求都会走
  // ——同步单连接的 daemon 上,这就是本 RFC 要治的那类「一次大搬运卡住全站」。
  // 改成流式按行消费 + 到 limit 立刻停(提前 return 会 cancel 流)。
  return await readJsonlLines(file, since, limit)
}

async function readJsonlLines(
  file: string,
  since: number,
  limit: number,
): Promise<
  Array<{
    id: number
    ts: number
    kind: string
    payload: string
    sessionId: string | null
    parentSessionId: string | null
  }>
> {
  const out: Array<{
    id: number
    ts: number
    kind: string
    payload: string
    sessionId: string | null
    parentSessionId: string | null
  }> = []
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of Bun.file(file).stream()) {
    pending += decoder.decode(chunk, { stream: true })
    let nl = pending.indexOf('\n')
    while (nl !== -1) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      pushLine(line, since, limit, out)
      if (out.length >= limit) return out
      nl = pending.indexOf('\n')
    }
  }
  pending += decoder.decode()
  if (pending !== '' && out.length < limit) pushLine(pending, since, limit, out)
  return out
}

function pushLine(
  line: string,
  since: number,
  limit: number,
  out: Array<{
    id: number
    ts: number
    kind: string
    payload: string
    sessionId: string | null
    parentSessionId: string | null
  }>,
): void {
  if (line === '' || out.length >= limit) return
  try {
    const obj = JSON.parse(line) as {
      id: number
      ts: number
      kind: string
      payload: string
      sessionId?: string | null
      parentSessionId?: string | null
    }
    if (obj.id <= since) return
    out.push({
      id: obj.id,
      ts: obj.ts,
      kind: obj.kind,
      payload: obj.payload,
      // 老归档文件没有这两个键 ⇒ null(向后兼容,不需要迁移已落盘的 JSONL)。
      sessionId: obj.sessionId ?? null,
      parentSessionId: obj.parentSessionId ?? null,
    })
  } catch {
    // skip corrupt line
  }
}

function jsonlPath(logsDir: string, taskId: string, nodeRunId: string): string {
  return join(logsDir, taskId, `${nodeRunId}.jsonl`)
}

/**
 * Start the hourly archive ticker. `loadConfig` is called each tick so
 * config changes apply without restart, matching worktree-GC's pattern.
 *
 * RFC-311 余项（2026-08-21 生产对账）：**boot 后必须先跑一拍**。此前这里只有
 * `setInterval(1h)`，于是平均重启间隔短于一个周期的部署（发版 / 崩溃 / watchdog）
 * 一次都不会归档——生产实测跑着含字节水位的 v0.18.11，事件表照样长到 78.6 万行
 * / 1.72GB。首拍延迟 30s 是为了让开机风暴（迁移、备份、恢复、boot 巡检）先过去：
 * 一轮归档在 2.6GB 库上实测 4-6s，撞在启动上没有必要。
 */
export function startEventsArchiver(
  db: DbClient,
  loadConfig: () => Pick<Config, 'eventsArchiveThresholds'>,
  logsDir: string,
  intervalMs: number = HOUR_MS,
  bootDelayMs: number = MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS,
  // RFC-322：boot 首拍（体积封顶，见 MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS）与相位
  // 正交——前者管「重启频繁的部署也得跑一次」，后者管「别和另外 13 个同刻引爆」。
  phaseOffsetMs: number = MAINTENANCE_PHASE.eventsArchive,
): { stop: () => void } {
  return startMaintenanceTicker({
    job: 'eventsArchive',
    intervalMs,
    phaseOffsetMs,
    bootDelayMs,
    onTick: () =>
      archiveEvents(db, loadConfig(), logsDir).catch((err: unknown) => {
        log.error('archiveEvents failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }),
  })
}
