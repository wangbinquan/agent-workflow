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

import { and, eq, isNotNull, max } from 'drizzle-orm'

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
 * Running node_runs with a live pid whose latest event (or startedAt when it has
 * none yet) is older than `now - stallMs` — i.e. the child has gone quiet.
 */
export async function findStalledRunningChildren(
  db: DbClient,
  stallMs: number,
  now: number,
): Promise<StalledRun[]> {
  const rows = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      pid: nodeRuns.pid,
      startedAt: nodeRuns.startedAt,
      spawnBinaryPath: nodeRuns.spawnBinaryPath,
      lastTs: max(nodeRunEvents.ts),
    })
    .from(nodeRuns)
    .leftJoin(nodeRunEvents, eq(nodeRunEvents.nodeRunId, nodeRuns.id))
    .where(and(eq(nodeRuns.status, 'running'), isNotNull(nodeRuns.pid)))
    .groupBy(nodeRuns.id)
  const cutoff = now - stallMs
  return rows.filter((r) => (r.lastTs ?? r.startedAt ?? 0) < cutoff)
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
