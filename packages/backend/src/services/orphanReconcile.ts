// RFC-108 T17 (AR-10) — periodic post-boot orphan reconciler.
//
// `reapOrphanRuns` only runs ONCE at boot and optimistically flips EVERY running
// row (it assumes a daemon restart). This is its live-daemon counterpart: a
// periodic sweep that flips only node_runs whose child process is PROVABLY gone
// — pid null, pid not alive, or pid alive but running a different command than
// the binary we spawned (recycled). A startedAt grace avoids racing a just-
// spawned run. reap-to-interrupted is the safe default action (auto-RESUME of
// the reconciled task stays gated behind T18's autoResumeOnBoot-style opt-in).
//
// The liveness probe is injected so the sweep logic is unit-testable without
// real processes; startOrphanReconcileLoop wires the real isProcessAlive +
// binary-identity check.

import { and, eq, inArray, lt } from 'drizzle-orm'

import { loadConfig } from '@/config'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { transitionNodeRunStatus, trySetTaskStatus } from '@/services/lifecycle'
import { recordRecoveryEvent } from '@/services/recovery'
import { isProcessAlive, pidCommandContainsBinary } from '@/util/process'
import { createLogger } from '@/util/log'

const log = createLogger('orphan-reconcile')

export interface ReconcileRun {
  id: string
  taskId: string
  status: string
  pid: number | null
  spawnBinaryPath: string | null
}

/** Real liveness probe: the run's process is GONE if no pid, dead pid, or the
 *  live pid is running a different binary than we spawned (recycled). */
export function runProcessGone(run: ReconcileRun): boolean {
  if (run.pid === null) return true
  if (!isProcessAlive(run.pid)) return true
  if (
    typeof run.spawnBinaryPath === 'string' &&
    run.spawnBinaryPath.length > 0 &&
    !pidCommandContainsBinary(run.pid, run.spawnBinaryPath)
  ) {
    return true
  }
  return false
}

export interface ReconcileDeps {
  db: DbClient
  /** Only reconcile runs whose startedAt is older than now-graceMs (anti-race). */
  graceMs: number
  /** Returns true when the run's child process is gone. */
  isGone: (run: ReconcileRun) => boolean
  now?: number
}

export interface ReconcileResult {
  reapedRuns: string[]
  reapedTasks: string[]
}

/**
 * Flip running node_runs whose process is gone to `interrupted`, then flip any
 * task with no remaining active runs to `interrupted` too. Records a
 * `periodic-reap` recovery_event per task.
 */
export async function reconcileDeadRunningRuns(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { db, isGone } = deps
  const now = deps.now ?? Date.now()
  const out: ReconcileResult = { reapedRuns: [], reapedTasks: [] }
  const candidates = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      status: nodeRuns.status,
      pid: nodeRuns.pid,
      spawnBinaryPath: nodeRuns.spawnBinaryPath,
      startedAt: nodeRuns.startedAt,
    })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.status, 'running'), lt(nodeRuns.startedAt, now - deps.graceMs)))

  const affectedTasks = new Set<string>()
  for (const run of candidates) {
    if (!isGone(run)) continue
    const ok = await transitionNodeRunStatus({
      db,
      nodeRunId: run.id,
      event: { kind: 'mark-interrupted' },
      extra: { finishedAt: now, errorMessage: 'orphan-reconcile' },
    })
      .then(() => true)
      .catch(() => false)
    if (!ok) continue
    out.reapedRuns.push(run.id)
    affectedTasks.add(run.taskId)
  }

  for (const taskId of affectedTasks) {
    const stillActive = await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), inArray(nodeRuns.status, ['running', 'pending'])))
      .limit(1)
    if (stillActive.length > 0) continue // task still has live work
    const flipped = await trySetTaskStatus({
      db,
      taskId,
      to: 'interrupted',
      allowedFrom: ['running'],
      extra: { finishedAt: now, errorSummary: 'orphan-reconcile' },
      reason: 'reconcileDeadRunningRuns',
    })
    if (!flipped) continue
    out.reapedTasks.push(taskId)
    await recordRecoveryEvent(db, {
      taskId,
      kind: 'periodic-reap',
      reason: 'orphan-reconcile: child process gone',
      after: { status: 'interrupted' },
      now,
    })
  }
  return out
}

export interface OrphanReconcileLoopHandle {
  stop: () => void
}

/** Periodic reconciler ticker. `periodicOrphanReconcileMs <= 0` disables it. */
export function startOrphanReconcileLoop(opts: {
  db: DbClient
  configPath: string
  graceMs?: number
}): OrphanReconcileLoopHandle {
  const graceMs = opts.graceMs ?? 60_000
  let inFlight = false
  let timer: ReturnType<typeof setInterval> | null = null
  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      await reconcileDeadRunningRuns({ db: opts.db, graceMs, isGone: runProcessGone })
    } catch (err) {
      log.warn('orphan reconcile tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      inFlight = false
    }
  }
  let intervalMs = 10 * 60 * 1000
  try {
    const cfg = loadConfig(opts.configPath)
    intervalMs = cfg.periodicOrphanReconcileMs
  } catch {
    // unreadable config → default cadence
  }
  if (intervalMs > 0) {
    timer = setInterval(() => void tick(), intervalMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return {
    stop: () => {
      if (timer !== null) clearInterval(timer)
    },
  }
}
