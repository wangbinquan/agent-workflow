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

import { and, asc, count, eq, gt, lte, sql } from 'drizzle-orm'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
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
/** maintenance_state 键：per-run pass 的增量扫描水位（上次扫过的 max(id)）。 */
const HIGH_WATER_KEY = 'events_archive_high_water'

/**
 * One archival pass. Returns counters for tests / log lines.
 */
export async function archiveEvents(
  db: DbClient,
  config: Pick<Config, 'eventsArchiveThresholds'>,
  logsDir: string,
): Promise<ArchiveRunResult> {
  const { perNodeRunRows, globalRows } = config.eventsArchiveThresholds
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
  const groups = await db
    .select({ nodeRunId: nodeRunEvents.nodeRunId, n: count(nodeRunEvents.id) })
    .from(nodeRunEvents)
    .where(gt(nodeRunEvents.id, highWater))
    .groupBy(nodeRunEvents.nodeRunId)

  for (const g of groups) {
    if (budget <= 0) break
    // Range count on idx_events_node — O(log n + own rows in index).
    const ownRow = await db
      .select({ n: count(nodeRunEvents.id) })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, g.nodeRunId))
    const own = ownRow[0]?.n ?? 0
    if (own <= perNodeRunRows) continue
    const toDrop = Math.min(own - perNodeRunRows, budget)
    const file = await archiveOldestForNode(db, g.nodeRunId, toDrop, logsDir)
    budget -= toDrop
    if (file !== null) {
      result.perGroupArchived += toDrop
      touched.add(file)
    }
  }
  // Advance the watermark only when the pass was not budget-truncated, so
  // deferred work is rescanned rather than silently skipped.
  if (budget > 0) await writeMaintenanceValue(db, HIGH_WATER_KEY, String(maxId))

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
      buf += JSON.stringify({ id: r.id, ts: r.ts, kind: r.kind, payload: r.payload }) + '\n'
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
): Promise<Array<{ id: number; ts: number; kind: string; payload: string }>> {
  const file = jsonlPath(logsDir, taskId, nodeRunId)
  if (!existsSync(file)) return []
  const text = await Bun.file(file).text()
  const out: Array<{ id: number; ts: number; kind: string; payload: string }> = []
  let cursor = 0
  while (cursor < text.length && out.length < limit) {
    const nl = text.indexOf('\n', cursor)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(cursor, end)
    cursor = end + 1
    if (line === '') continue
    try {
      const obj = JSON.parse(line) as {
        id: number
        ts: number
        kind: string
        payload: string
      }
      if (obj.id <= since) continue
      out.push({ id: obj.id, ts: obj.ts, kind: obj.kind, payload: obj.payload })
    } catch {
      // skip corrupt line
    }
  }
  return out
}

function jsonlPath(logsDir: string, taskId: string, nodeRunId: string): string {
  return join(logsDir, taskId, `${nodeRunId}.jsonl`)
}

/**
 * Start the hourly archive ticker. `loadConfig` is called each tick so
 * config changes apply without restart, matching worktree-GC's pattern.
 */
export function startEventsArchiver(
  db: DbClient,
  loadConfig: () => Pick<Config, 'eventsArchiveThresholds'>,
  logsDir: string,
  intervalMs: number = HOUR_MS,
): { stop: () => void } {
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    archiveEvents(db, loadConfig(), logsDir)
      .catch((err: unknown) => {
        log.error('archiveEvents failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  return { stop: () => clearInterval(handle) }
}
