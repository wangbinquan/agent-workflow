// RFC-108 T20 (AR-05a) — heartbeat-driven stalled-child auto-kill (DEFAULT OFF).
//
// The per-node hard timeout (T4) eventually kills a wedged node at 30 min, but a
// child whose opencode process is alive yet emitting NO events (deadlocked /
// waiting on a vanished prompt) wastes that whole window. When
// `autoKillStalledChild` is enabled, this kills such a child as soon as its
// event stream has been silent past `heartbeatStallMs`, reusing T9's fail-safe
// `killStaleRunProcessTree` (PID-reuse window + binary-identity gate) so it never
// signals an unrelated recycled pid. Every guard gates it: quarantine,
// circuit-breaker, driver lease, recovery audit. After the child dies the
// runner's exit handler marks the node — this module only pulls the trigger.
//
// findStalledRuns / killChild are injected so the loop is unit-testable;
// startHeartbeatKillLoop wires the real query + killStaleRunProcessTree.

import { and, desc, eq, isNotNull } from 'drizzle-orm'

import { loadConfig } from '@/config'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
import { withDriverLease } from '@/services/driverLease'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  type BreakerConfig,
  isAutoRecoverySuspended,
  recordAutoRecoveryAttempt,
} from '@/services/recoveryBreaker'
import { killStaleRunProcessTree } from '@/util/process'
import { createLogger } from '@/util/log'
import { DAEMON_CADENCE } from './daemonCadence'

const log = createLogger('auto-kill')
const HOLDER = 'heartbeat-kill'

export interface StalledRun {
  id: string
  taskId: string
  pid: number | null
  startedAt: number | null
  spawnBinaryPath: string | null
  lastTs: number | null
}

/**
 * RFC-314 D1 —— 求「最后一次活动」时读多少行事件。
 *
 * 此前是 `LEFT JOIN node_run_events + max(ts) + GROUP BY`：一条语句把**每个 running
 * run 的全部事件**走一遍索引求 max，再走 TEMP B-TREE 分组。生产量级实测（78.6 万行库、
 * 20 个 running run、单 run 最大 10.8 万事件）**单条 194.9ms**——而 daemon 只有一条同步
 * 连接，这 0.2 秒里全站不响应。
 *
 * 为什么是「最后 N 行里取 max」而不是「取最后一行」：子代理事件由 `subagentLiveCapture`
 * 回灌，携带 opencode 的**原始 ts**，可能早于插入序。只看最后一行会低估活跃度，而这里的
 * 后果是**杀掉一个真实进程**。`stuckTaskDetector.ts` 的同名判据只取最后一行是刻意的——
 * 那边的后果只是一条 lifecycle alert。200 行足以吸收一个轮询间隔的回灌量；真要构造出
 * 「连续 200 条都是回灌的旧 ts」才会低估，而 stall 阈值是分钟～小时级。
 *
 * 为什么不加 `(node_run_id, ts)` 索引：node_run_events 是全仓最热的写表，实测给它加三个
 * 索引会让 5000 条 INSERT 的 WAL 页写从 59 涨到 756（×12.8）。窗口法零索引成本。
 */
const STALL_TS_WINDOW_ROWS = 200

/**
 * 一个 run 最近一次活动的时间戳：按 id 反向取 `STALL_TS_WINDOW_ROWS` 行（走
 * `idx_events_node`，EXPLAIN 无排序器），在窗口内取 max(ts)。无事件返回 null。
 */
async function latestEventTsWithinWindow(db: DbClient, nodeRunId: string): Promise<number | null> {
  const rows = await db
    .select({ ts: nodeRunEvents.ts })
    .from(nodeRunEvents)
    .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    .orderBy(desc(nodeRunEvents.id))
    .limit(STALL_TS_WINDOW_ROWS)
  let latest: number | null = null
  for (const row of rows) {
    if (latest === null || row.ts > latest) latest = row.ts
  }
  return latest
}

/**
 * Running node_runs with a live pid whose latest event (or startedAt when it has
 * none yet) is older than `now - stallMs` — i.e. the child has gone quiet.
 *
 * RFC-314 D1：语句数是 O(并发 running run 数)（上界 `maxConcurrentNodes`），**不随事件
 * 量增长**——这是刻意接受的 N+1，它的 N 是并发度而不是数据量，形态与 stuckTaskDetector
 * 的逐 run 查询一致。
 */
export async function findStalledRunningChildren(
  db: DbClient,
  stallMs: number,
  now: number,
): Promise<StalledRun[]> {
  const runs = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      pid: nodeRuns.pid,
      startedAt: nodeRuns.startedAt,
      spawnBinaryPath: nodeRuns.spawnBinaryPath,
    })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.status, 'running'), isNotNull(nodeRuns.pid)))
  const cutoff = now - stallMs
  const stalled: StalledRun[] = []
  for (const run of runs) {
    const lastTs = await latestEventTsWithinWindow(db, run.id)
    if ((lastTs ?? run.startedAt ?? 0) < cutoff) stalled.push({ ...run, lastTs })
  }
  return stalled
}

export interface HeartbeatKillDeps {
  db: DbClient
  breaker: BreakerConfig
  enabled: boolean
  findStalledRuns: () => Promise<StalledRun[]>
  /** Kill the child; returns the killStaleRunProcessTree outcome. */
  killChild: (run: StalledRun) => Promise<string>
  now?: () => number
}

export interface HeartbeatKillResult {
  killed: Array<{ taskId: string; nodeRunId: string }>
  skipped: Array<{ taskId: string; nodeRunId: string; reason: string }>
}

export async function runHeartbeatKillOnce(deps: HeartbeatKillDeps): Promise<HeartbeatKillResult> {
  const out: HeartbeatKillResult = { killed: [], skipped: [] }
  if (!deps.enabled) return out
  const { db, breaker, findStalledRuns, killChild } = deps
  const now = deps.now ?? Date.now
  const skip = (r: StalledRun, reason: string): void => {
    out.skipped.push({ taskId: r.taskId, nodeRunId: r.id, reason })
  }

  for (const run of await findStalledRuns()) {
    if (await isAutoRecoverySuspended(db, run.taskId)) {
      skip(run, 'quarantined')
      continue
    }
    const { suspended } = await recordAutoRecoveryAttempt(db, run.taskId, breaker, now())
    if (suspended) {
      skip(run, 'breaker-tripped')
      continue
    }
    const outcome = await withDriverLease(run.taskId, HOLDER, 'heartbeat-kill', async () => {
      const o = await killChild(run)
      await recordRecoveryEvent(db, {
        taskId: run.taskId,
        nodeRunId: run.id,
        kind: 'heartbeat-kill',
        reason: `stalled child pid ${run.pid ?? '?'} (outcome=${o})`,
        after: { outcome: o },
        now: now(),
      })
      return o
    })
    if (outcome === 'killed') out.killed.push({ taskId: run.taskId, nodeRunId: run.id })
    else skip(run, `not-killed:${outcome ?? 'lease-held'}`)
  }
  return out
}

export interface HeartbeatKillLoopHandle {
  stop: () => void
}

/**
 * Periodic heartbeat-kill ticker. DEFAULT OFF: each tick early-outs in O(1) when
 * `autoKillStalledChild` is false (the default), so it's free until enabled.
 */
export function startHeartbeatKillLoop(opts: {
  db: DbClient
  configPath: string
  intervalMs?: number
}): HeartbeatKillLoopHandle {
  const intervalMs = opts.intervalMs ?? DAEMON_CADENCE.autoKill
  let inFlight = false
  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      const cfg = loadConfig(opts.configPath)
      if (cfg.autoKillStalledChild !== true) return
      const now = Date.now()
      await runHeartbeatKillOnce({
        db: opts.db,
        enabled: true,
        breaker: {
          maxPerWindow: cfg.maxAutoRecoveriesPerWindow,
          windowMs: cfg.autoRecoveryWindowMs,
        },
        findStalledRuns: () => findStalledRunningChildren(opts.db, cfg.heartbeatStallMs, now),
        killChild: (run) =>
          killStaleRunProcessTree({
            pid: run.pid,
            startedAt: run.startedAt,
            spawnBinaryPath: run.spawnBinaryPath,
          }),
      })
    } catch (err) {
      log.warn('heartbeat-kill tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(timer) }
}
