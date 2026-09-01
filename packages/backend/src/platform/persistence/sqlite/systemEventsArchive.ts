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

// System Operations SQLite event-archive adapter. Transport and maintenance orchestration consume
// its closed receipts through the compatibility surface.

import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
import type {
  EventsArchiveRow,
  EventsArchiveStore,
} from '@/platform/background/eventsArchiveStorePort'
export { readArchivedEvents } from '@/platform/background/eventsArchiveReader'
import { MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import { readMaintenanceValue, writeMaintenanceValue } from './systemMaintenanceState'

const log = createLogger('events-archive')

const HOUR_MS = 60 * 60 * 1000

/** Concrete SQLite query adapter. The archive mechanism below never receives
 * a DbClient and is shared by the PostgreSQL owner adapter. */
export function createSqliteEventsArchiveStore(db: DbClient): EventsArchiveStore {
  const store: EventsArchiveStore = {
    readState: (key) => readMaintenanceValue(db, key),
    writeState: (key, value, now) => writeMaintenanceValue(db, key, value, now),
    async averageRecentPayloadBytes(limit) {
      const sampled = (await db.all(
        sql`SELECT AVG(LENGTH(payload)) AS avg FROM (
          SELECT ${nodeRunEvents.payload} AS payload
          FROM ${nodeRunEvents}
          ORDER BY ${nodeRunEvents.id} DESC
          LIMIT ${limit}
        ) sampled`,
      )) as Array<{ avg: number | null }>
      return sampled[0]?.avg ?? null
    },
    async maxEventId() {
      const rows = await db
        .select({ value: sql<number | null>`max(${nodeRunEvents.id})` })
        .from(nodeRunEvents)
      return rows[0]?.value ?? 0
    },
    async countEventIds(input) {
      const conditions = [
        gt(nodeRunEvents.id, input.afterId),
        lte(nodeRunEvents.id, input.throughId),
      ]
      if (input.nodeRunId !== undefined) {
        conditions.push(eq(nodeRunEvents.nodeRunId, input.nodeRunId))
      }
      const rows = await db
        .select({ value: count(nodeRunEvents.id) })
        .from(nodeRunEvents)
        .where(and(...conditions))
      return rows[0]?.value ?? 0
    },
    async listDistinctNodeRunIds(input) {
      const rows = await db
        .selectDistinct({ nodeRunId: nodeRunEvents.nodeRunId })
        .from(nodeRunEvents)
        .where(and(gt(nodeRunEvents.id, input.afterId), lte(nodeRunEvents.id, input.throughId)))
      return rows.map((row) => row.nodeRunId)
    },
    async countEventsByNodeRunIds(nodeRunIds) {
      const rows = await db
        .select({ nodeRunId: nodeRunEvents.nodeRunId, value: count(nodeRunEvents.id) })
        .from(nodeRunEvents)
        .where(inArray(nodeRunEvents.nodeRunId, nodeRunIds))
        .groupBy(nodeRunEvents.nodeRunId)
      return rows.map((row) => ({ nodeRunId: row.nodeRunId, count: row.value }))
    },
    async countAllEvents() {
      const rows = await db.select({ value: count(nodeRunEvents.id) }).from(nodeRunEvents)
      return rows[0]?.value ?? 0
    },
    async oldestEvent() {
      const rows = await db
        .select({ id: nodeRunEvents.id, nodeRunId: nodeRunEvents.nodeRunId })
        .from(nodeRunEvents)
        .orderBy(asc(nodeRunEvents.id))
        .limit(1)
      return rows[0] ?? null
    },
    async countEventsForNodeRun(nodeRunId) {
      const rows = await db
        .select({ value: count(nodeRunEvents.id) })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      return rows[0]?.value ?? 0
    },
    async findTaskIdForNodeRun(nodeRunId) {
      const rows = await db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return rows[0]?.taskId ?? null
    },
    async listOldestEvents(nodeRunId, limit) {
      return (await db
        .select({
          id: nodeRunEvents.id,
          ts: nodeRunEvents.ts,
          kind: nodeRunEvents.kind,
          payload: nodeRunEvents.payload,
          sessionId: nodeRunEvents.sessionId,
          parentSessionId: nodeRunEvents.parentSessionId,
        })
        .from(nodeRunEvents)
        .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
        .orderBy(asc(nodeRunEvents.id))
        .limit(limit)) as readonly EventsArchiveRow[]
    },
    async deleteNodeRunEventsThrough(nodeRunId, lastId) {
      await db
        .delete(nodeRunEvents)
        .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), lte(nodeRunEvents.id, lastId)))
    },
    async deleteNodeRunEventsRange(input) {
      await db
        .delete(nodeRunEvents)
        .where(
          and(
            eq(nodeRunEvents.nodeRunId, input.nodeRunId),
            gt(nodeRunEvents.id, input.afterId),
            lte(nodeRunEvents.id, input.throughId),
          ),
        )
    },
  }
  return Object.freeze(store)
}

export interface ArchiveRunResult {
  perGroupArchived: number
  globalArchived: number
  /** Exact remaining row estimate carried by the RFC-338 Worker cursor. */
  remainingRows: number
  files: string[]
}

export type EventsArchiveFaultPoint =
  | 'after-journal-prepare'
  | 'after-file-append'
  | 'after-db-delete'
  | 'after-journal-finalize'

export interface EventsArchiveOptions {
  /** Test-only window override used by the RFC-311 scale corpus. */
  scanWindowIds?: number
  /** Worker slice budget. */
  rowBudgetRows?: number
  /**
   * Row count captured by the Worker immediately before this archive pass.
   * Supplying it avoids repeating an O(table) COUNT for every 5k continuation.
   * Legacy callers omit it and retain the exact one-pass COUNT behavior.
   */
  knownGlobalRows?: number
  /** RFC-338 fault injection at every mixed DB/FS linearization point. */
  onFault?: (point: EventsArchiveFaultPoint) => void
}

interface ArchiveAppendJournalV1 {
  readonly version: 1
  readonly nodeRunId: string
  readonly offset: number
  readonly length: number
  readonly digest: string
  readonly firstId: number
  readonly lastId: number
  readonly rowCount: number
}

interface ArchiveBatchResult {
  readonly file: string | null
  readonly archived: number
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
const PENDING_APPEND_KEY = 'events_archive_pending_append_v1'

/**
 * One archival pass. Returns counters for tests / log lines.
 */
/** RFC-311（proposal C3）——把字节预算折算成有效行数阈值：按最近 1000 行的
 *  平均 payload 宽度采样（O(1000)，零写放大），与行数阈值取 min。生产事故
 *  形态正是「行数没到水位、字节已到 2.2GB」。每行外加 ~48B 固定列开销。 */
export interface ArchiveThresholds {
  perNodeRunRows: number
  globalRows: number
  /** 可选：既有调用方/测试仍可传二键形态（bytes 视为关闭）。 */
  perNodeRunBytes?: number
  globalBytes?: number
}

async function effectiveRowThresholds(
  store: EventsArchiveStore,
  thresholds: ArchiveThresholds,
): Promise<{ perNodeRunRows: number; globalRows: number }> {
  const { perNodeRunRows, globalRows } = thresholds
  const perNodeRunBytes = thresholds.perNodeRunBytes ?? 0
  const globalBytes = thresholds.globalBytes ?? 0
  if (perNodeRunBytes <= 0 && globalBytes <= 0) return { perNodeRunRows, globalRows }
  const averagePayloadBytes = await store.averageRecentPayloadBytes(1_000)
  const avgRowBytes = Math.max(64, Math.round(Number(averagePayloadBytes ?? 0)) + 48)
  const derive = (bytes: number, rows: number): number =>
    bytes > 0 ? Math.min(rows, Math.max(1_000, Math.floor(bytes / avgRowBytes))) : rows
  return {
    perNodeRunRows: derive(perNodeRunBytes, perNodeRunRows),
    globalRows: derive(globalBytes, globalRows),
  }
}

export async function archiveEventsWithStore(
  store: EventsArchiveStore,
  config: { eventsArchiveThresholds: ArchiveThresholds },
  logsDir: string,
  /** 测试注入:把扫描窗口调小到几十行，才测得出窗口边界有没有漏行。 */
  opts: EventsArchiveOptions = {},
): Promise<ArchiveRunResult> {
  const scanWindowIds = opts.scanWindowIds ?? ARCHIVE_SCAN_WINDOW_IDS
  const rowBudgetRows = opts.rowBudgetRows ?? ARCHIVE_TICK_BUDGET_ROWS
  if (!Number.isInteger(rowBudgetRows) || rowBudgetRows < 1) {
    throw new Error('events-archive-row-budget-invalid')
  }
  if (
    opts.knownGlobalRows !== undefined &&
    (!Number.isSafeInteger(opts.knownGlobalRows) || opts.knownGlobalRows < 0)
  ) {
    throw new Error('events-archive-known-global-rows-invalid')
  }
  const recovered = await recoverPendingArchiveAppendFromState(store, logsDir)
  const { perNodeRunRows, globalRows } = await effectiveRowThresholds(
    store,
    config.eventsArchiveThresholds,
  )
  const result: ArchiveRunResult = {
    perGroupArchived: recovered.archived,
    globalArchived: 0,
    remainingRows: 0,
    files: [],
  }
  const touched = new Set<string>()
  if (recovered.file !== null) touched.add(recovered.file)
  let budget = Math.max(0, rowBudgetRows - recovered.archived)

  // --- Per-node-run pass (RFC-311: incremental) ---------------------------
  // The old shape GROUP BY'd the ENTIRE table every hour (O(all rows) even as
  // an index-only scan). Rows are append-only from the archiver's viewpoint,
  // so a run can only cross the threshold by RECEIVING NEW ROWS: scanning
  // only rows above the last-seen high water finds every newly-over-limit
  // run. First pass (no watermark) scans everything once and clears backlog.
  // The watermark only advances on a fully successful pass, so a failed
  // archive attempt gets rescanned next tick.
  const highWaterRaw = await store.readState(HIGH_WATER_KEY)
  const highWaterParsed = highWaterRaw === null ? Number.NaN : Number(highWaterRaw)
  const highWater = Number.isFinite(highWaterParsed) ? highWaterParsed : 0
  const maxId = await store.maxEventId()

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
    const candidates = await store.listDistinctNodeRunIds({
      afterId: scanFrom,
      throughId: scanTo,
    })

    // 候选的**总量**分块一次性算。此前是每个候选发一条 count ——分窗之后同一个
    // run 会被反复问,实测把一轮从 6 秒劣化到 260 秒(10M 事件库)。一条分组
    // 语句顶一整块候选,既短又不重复。
    const overs: Array<{ nodeRunId: string; own: number }> = []
    for (const chunk of chunked(candidates, ARCHIVE_COUNT_CHUNK)) {
      const rows = await store.countEventsByNodeRunIds(chunk)
      for (const row of rows) {
        if (row.count > perNodeRunRows) {
          overs.push({ nodeRunId: row.nodeRunId, own: row.count })
        }
      }
    }
    candidateBudget -= candidates.length

    for (const over of overs) {
      if (budget <= 0) break
      const toDrop = Math.min(over.own - perNodeRunRows, budget)
      const batch = await archiveOldestForNode(store, over.nodeRunId, toDrop, logsDir, opts)
      budget -= batch.archived
      if (batch.file !== null) {
        result.perGroupArchived += batch.archived
        touched.add(batch.file)
      }
      if (batch.archived === 0) break
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
    await store.writeState(HIGH_WATER_KEY, String(advancedTo))
  }

  // --- Global pass --------------------------------------------------------
  // Legacy callers still count once per standalone pass. The RFC-338 Worker,
  // however, resumes this function every 5k rows: repeating that whole-table
  // COUNT on every continuation froze a 10M-row deployment for 300-450ms per
  // slice. Its durable cursor therefore carries a bounded-window count. Rows
  // removed by the per-run pass are subtracted before the global cap is used.
  // Concurrent appends beyond the count snapshot are deliberately deferred to
  // the next scheduled run; rows are never deleted without first being archived.
  const removedBeforeGlobal = rowBudgetRows - budget
  let total: number
  if (opts.knownGlobalRows === undefined) {
    total = await store.countAllEvents()
  } else {
    total = Math.max(0, opts.knownGlobalRows - removedBeforeGlobal)
  }
  while (total > globalRows && budget > 0) {
    // Find the oldest event row, then archive its node_run's oldest chunk.
    const head = await store.oldestEvent()
    if (head === null) break
    const overflow = total - globalRows
    // Don't drop more than this node_run actually owns at the head.
    const own = await store.countEventsForNodeRun(head.nodeRunId)
    const toDrop = Math.min(overflow, own, budget)
    if (toDrop <= 0) break
    const batch = await archiveOldestForNode(store, head.nodeRunId, toDrop, logsDir, opts)
    budget -= batch.archived
    if (batch.file === null || batch.archived === 0) break
    result.globalArchived += batch.archived
    touched.add(batch.file)
    total -= batch.archived
  }

  result.remainingRows = total
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

/** SQLite compatibility adapter retained for existing callers and tests. */
export async function archiveEvents(
  db: DbClient,
  config: { eventsArchiveThresholds: ArchiveThresholds },
  logsDir: string,
  opts: EventsArchiveOptions = {},
): Promise<ArchiveRunResult> {
  return await archiveEventsWithStore(createSqliteEventsArchiveStore(db), config, logsDir, opts)
}

/**
 * Archive the oldest `count` rows for one node_run. Returns the JSONL file
 * path that was written to (or null if the node_run is unknown / orphaned).
 */
async function archiveOldestForNode(
  store: EventsArchiveStore,
  nodeRunId: string,
  toDrop: number,
  logsDir: string,
  opts: EventsArchiveOptions,
): Promise<ArchiveBatchResult> {
  if (toDrop <= 0) return { file: null, archived: 0 }
  const taskId = await store.findTaskIdForNodeRun(nodeRunId)

  // RFC-311: both branches advance in bounded batches and delete by ID RANGE
  // (`node_run_id = ? AND id <= ?` rides idx_events_node with two bound
  // params) — the old one-shot `IN (<toDrop ids>)` exceeded SQLite's 32766
  // bound-parameter limit on any real backlog and made the archiver fail
  // every hour (audit L3-4).
  if (taskId === null) {
    // Orphan event rows — delete them so they don't block the global cap.
    let remaining = toDrop
    while (remaining > 0) {
      const batch = await store.listOldestEvents(nodeRunId, Math.min(remaining, ARCHIVE_BATCH_ROWS))
      const lastId = batch.at(-1)?.id
      if (lastId === undefined) break
      await store.deleteNodeRunEventsThrough(nodeRunId, lastId)
      remaining -= batch.length
      if (batch.length < ARCHIVE_BATCH_ROWS) break
    }
    return { file: null, archived: toDrop - remaining }
  }

  const file = jsonlPath(logsDir, taskId, nodeRunId)
  mkdirSync(dirname(file), { recursive: true })
  let dropped = 0
  let wroteAny = false
  while (dropped < toDrop) {
    const rows = await store.listOldestEvents(
      nodeRunId,
      Math.min(toDrop - dropped, ARCHIVE_BATCH_ROWS),
    )
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
    const firstId = rows[0]!.id
    const lastId = rows.at(-1)!.id
    const encoded = Buffer.from(buf, 'utf-8')
    const journal: ArchiveAppendJournalV1 = {
      version: 1,
      nodeRunId,
      offset: existsSync(file) ? statSync(file).size : 0,
      length: encoded.byteLength,
      digest: sha256Hex(encoded),
      firstId,
      lastId,
      rowCount: rows.length,
    }

    // RFC-338 AC-7/AC-8: persist the exact append offset/digest before the
    // mixed FS/DB effect. Recovery can distinguish no append, a partial
    // append, a complete append before delete, and a committed delete before
    // receipt. This keeps the legacy single JSONL path while making retries
    // lossless and duplicate-free.
    await store.writeState(PENDING_APPEND_KEY, JSON.stringify({ version: 1, taskId, nodeRunId }))
    writeArchiveJournal(file, journal)
    opts.onFault?.('after-journal-prepare')
    appendAndSync(file, encoded)
    verifyJournalAppend(file, journal)
    opts.onFault?.('after-file-append')
    wroteAny = true
    await store.deleteNodeRunEventsThrough(nodeRunId, lastId)
    opts.onFault?.('after-db-delete')
    finalizeArchiveJournal(file)
    await store.writeState(PENDING_APPEND_KEY, '')
    opts.onFault?.('after-journal-finalize')
    dropped += rows.length
    if (rows.length < ARCHIVE_BATCH_ROWS) break
  }
  return { file: wroteAny ? file : null, archived: dropped }
}

function archiveJournalPath(file: string): string {
  return `${file}.append-journal.json`
}

function writeArchiveJournal(file: string, journal: ArchiveAppendJournalV1): void {
  const path = archiveJournalPath(file)
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(journal))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

function appendAndSync(file: string, contents: Uint8Array): void {
  const fd = openSync(file, 'a')
  try {
    let offset = 0
    while (offset < contents.byteLength) {
      offset += writeSync(fd, contents, offset, contents.byteLength - offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readFileRange(file: string, offset: number, length: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const out = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, out, read, length - read, offset + read)
      if (n === 0) break
      read += n
    }
    return out.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function verifyJournalAppend(file: string, journal: ArchiveAppendJournalV1): void {
  if (!existsSync(file)) throw new Error('events-archive-append-missing')
  const size = statSync(file).size
  if (size !== journal.offset + journal.length) {
    throw new Error('events-archive-append-length-mismatch')
  }
  const appended = readFileRange(file, journal.offset, journal.length)
  if (appended.byteLength !== journal.length || sha256Hex(appended) !== journal.digest) {
    throw new Error('events-archive-append-digest-mismatch')
  }
}

function parseArchiveJournal(file: string): ArchiveAppendJournalV1 | null {
  const path = archiveJournalPath(file)
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ArchiveAppendJournalV1>
  if (
    value.version !== 1 ||
    typeof value.nodeRunId !== 'string' ||
    !Number.isSafeInteger(value.offset) ||
    value.offset! < 0 ||
    !Number.isSafeInteger(value.length) ||
    value.length! < 1 ||
    typeof value.digest !== 'string' ||
    !Number.isSafeInteger(value.firstId) ||
    !Number.isSafeInteger(value.lastId) ||
    value.firstId! < 1 ||
    value.lastId! < value.firstId! ||
    !Number.isSafeInteger(value.rowCount) ||
    value.rowCount! < 1
  ) {
    throw new Error('events-archive-journal-invalid')
  }
  return value as ArchiveAppendJournalV1
}

async function pendingJournalDbRows(
  store: EventsArchiveStore,
  journal: ArchiveAppendJournalV1,
): Promise<number> {
  return await store.countEventIds({
    nodeRunId: journal.nodeRunId,
    afterId: journal.firstId - 1,
    throughId: journal.lastId,
  })
}

async function recoverPendingArchiveAppend(
  store: EventsArchiveStore,
  nodeRunId: string,
  file: string,
): Promise<number> {
  const journal = parseArchiveJournal(file)
  if (journal === null) return 0
  if (journal.nodeRunId !== nodeRunId) throw new Error('events-archive-journal-owner-mismatch')

  const dbRows = await pendingJournalDbRows(store, journal)
  const fileExists = existsSync(file)
  const fileSize = fileExists ? statSync(file).size : 0
  const appendComplete =
    fileExists &&
    fileSize === journal.offset + journal.length &&
    sha256Hex(readFileRange(file, journal.offset, journal.length)) === journal.digest

  if (appendComplete) {
    if (dbRows > 0) {
      await store.deleteNodeRunEventsRange({
        nodeRunId,
        afterId: journal.firstId - 1,
        throughId: journal.lastId,
      })
    }
    finalizeArchiveJournal(file)
    return dbRows
  }

  // A short/partial append is safe to roll back only while every selected DB
  // row is still present. If any row is already gone, fail closed: truncating
  // could destroy the only surviving copy.
  if (dbRows !== journal.rowCount) throw new Error('events-archive-recovery-ambiguous')
  if (fileSize < journal.offset) throw new Error('events-archive-base-truncated')
  if (fileSize > journal.offset + journal.length) {
    throw new Error('events-archive-recovery-overlap')
  }
  if (fileExists && fileSize !== journal.offset) truncateSync(file, journal.offset)
  finalizeArchiveJournal(file)
  return 0
}

async function recoverPendingArchiveAppendFromState(
  store: EventsArchiveStore,
  logsDir: string,
): Promise<ArchiveBatchResult> {
  const raw = await store.readState(PENDING_APPEND_KEY)
  if (raw === null || raw === '') return { file: null, archived: 0 }
  let pointer: { version: 1; taskId: string; nodeRunId: string }
  try {
    const value = JSON.parse(raw) as Partial<typeof pointer>
    if (
      value.version !== 1 ||
      typeof value.taskId !== 'string' ||
      value.taskId === '' ||
      typeof value.nodeRunId !== 'string' ||
      value.nodeRunId === ''
    ) {
      throw new Error('invalid')
    }
    pointer = value as typeof pointer
  } catch {
    throw new Error('events-archive-pending-pointer-invalid')
  }

  const file = jsonlPath(logsDir, pointer.taskId, pointer.nodeRunId)
  const journal = parseArchiveJournal(file)
  if (journal === null) {
    // Crash after publishing the DB pointer but before the FS journal, or
    // after finalizing the journal but before clearing the pointer.
    await store.writeState(PENDING_APPEND_KEY, '')
    return { file: null, archived: 0 }
  }
  const archived = await recoverPendingArchiveAppend(store, pointer.nodeRunId, file)
  await store.writeState(PENDING_APPEND_KEY, '')
  return { file, archived }
}

function finalizeArchiveJournal(file: string): void {
  const path = archiveJournalPath(file)
  if (existsSync(path)) unlinkSync(path)
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
