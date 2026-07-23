// P-4-07: daemon-restart orphan reaping.
//
// When the daemon starts, any task or node_run rows still in `running` are
// orphans from a prior daemon process. We can't tell whether the previous
// process was SIGKILLed (process.kill -0 won't help across PID reuse), so we
// optimistically flip them to `interrupted` and mark the task error so the
// UI shows what happened.
//
// RFC-098 WP-8 (audit S-15): we DO now reap still-alive opencode children.
// Each orphaned node_runs row carries the child's pid (runner writes it at
// spawn); when that pid is still alive — gated by the startedAt window and a
// `ps` command-shape check against PID reuse — we group-kill it (TERM→KILL)
// BEFORE flipping the row to interrupted. A known child which survives KILL
// aborts the boot barrier. Otherwise the
// survivor keeps writing into the worktree while the user resumes on top of
// it. Rows with pid NULL (pre-RFC-098 / never-spawned) take the old
// flip-only path.

import { inArray } from 'drizzle-orm'
import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns, tasks } from '@/db/schema'
import { transitionNodeRunStatus, trySetTaskStatus } from '@/services/lifecycle'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  killStaleRunProcessTree,
  type StaleRunKillOutcome,
  type StaleRunKillOpts,
} from '@/util/process'
import { readPidFromLock, type Lock } from '@/util/lock'
import { createLogger } from '@/util/log'

const log = createLogger('orphans')

export interface ReapResult {
  tasks: number
  runs: number
}

export interface ReapOrphanRunsDependencies {
  killStaleRunProcessTree?: (
    run: { pid: number | null; startedAt: number | null; spawnBinaryPath?: string | null },
    opts?: StaleRunKillOpts,
  ) => Promise<StaleRunKillOutcome>
}

declare const PRIOR_DAEMON_SANDBOX_DEAD_CAPABILITY: unique symbol

/** Opaque, one-shot proof minted only after the boot orphan reap succeeds. */
export interface PriorDaemonSandboxDeadCapability {
  readonly [PRIOR_DAEMON_SANDBOX_DEAD_CAPABILITY]: true
}

interface CapabilityBinding {
  pid: number
  lockPath: string
}

const issuedSandboxDeathCapabilities = new WeakMap<object, CapabilityBinding>()

function issuePriorDaemonSandboxDeadCapability(lock: Lock): PriorDaemonSandboxDeadCapability {
  if (lock.pid !== process.pid || readPidFromLock(lock.path) !== process.pid) {
    throw new Error('cannot prove current daemon lock ownership')
  }
  const capability = Object.freeze({})
  issuedSandboxDeathCapabilities.set(capability, {
    pid: lock.pid,
    lockPath: lock.path,
  })
  return capability as PriorDaemonSandboxDeadCapability
}

/**
 * Consume an issued proof exactly once and revalidate that the daemon lock
 * which excluded the prior daemon is still held by this process.
 */
export function consumePriorDaemonSandboxDeadCapability(
  capability: PriorDaemonSandboxDeadCapability,
): boolean {
  if (typeof capability !== 'object' || capability === null) return false
  const binding = issuedSandboxDeathCapabilities.get(capability)
  if (binding === undefined) return false
  issuedSandboxDeathCapabilities.delete(capability)
  return binding.pid === process.pid && readPidFromLock(binding.lockPath) === binding.pid
}

export async function reapOrphanRuns(
  db: DbClient,
  dependencies: ReapOrphanRunsDependencies = {},
): Promise<ReapResult> {
  const now = Date.now()
  // RFC-097: 'pending' tasks are reaped too — boot runs before the HTTP server
  // listens, so any pending task here is an orphan (startTask inserts and
  // kicks in-process; a resume/retry that crashed mid-rollback leaves the
  // CAS-claimed task pending with nobody attached — the gap5 task-side
  // asymmetry this closes, mirroring the node_runs branch below which always
  // reaped pending rows).
  const runningTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ['running', 'pending'] as const))
  const runningRuns = await db
    .select()
    .from(nodeRuns)
    .where(inArray(nodeRuns.status, ['running', 'pending'] as const))

  if (runningTasks.length === 0 && runningRuns.length === 0) {
    return { tasks: 0, runs: 0 }
  }

  for (const t of runningTasks) {
    // RFC-097: CAS from the observed status; a loss means something else
    // already settled the row — skip and log, same net as the node_runs
    // branch below.
    const won = await trySetTaskStatus({
      db,
      taskId: t.id,
      to: 'interrupted',
      allowedFrom: [t.status as 'running' | 'pending'],
      extra: {
        finishedAt: now,
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        errorMessage: 'daemon restarted while this task was running; please resume',
      },
      reason: 'reapOrphanRuns',
    })
    if (!won) {
      log.warn('orphan task reap lost a race — skipping', { taskId: t.id })
      continue
    }
    // RFC-108 T3 (AR-11): durable audit of the boot reap.
    await recordRecoveryEvent(db, {
      taskId: t.id,
      kind: 'boot-reap',
      reason: DAEMON_RESTART_ERROR_SUMMARY,
      before: { status: t.status },
      after: { status: 'interrupted' },
      now,
    })
  }
  let runsReaped = 0
  for (const r of runningRuns) {
    // RFC-098 WP-8: kill-then-flip. killStaleRunProcessTree applies both
    // PID-reuse noise gates (startedAt < 48h window + `ps -p pid -o command=`
    // must look like opencode/bun) before signaling. Ambiguous PID-reuse
    // outcomes fall through; a known child which survives KILL aborts.
    const killOutcome = await (dependencies.killStaleRunProcessTree ?? killStaleRunProcessTree)(r, {
      now,
    })
    if (killOutcome === 'kill-failed') {
      // RFC-224: a live known child invalidates the prior-daemon sandbox-death
      // proof. Leave its row non-terminal and abort boot rather than minting a
      // capability that could authorize store scrub/removal under a live writer.
      log.error('orphan run child SURVIVED SIGKILL — still alive after reap (resume will refuse)', {
        nodeRunId: r.id,
        pid: r.pid,
      })
      throw new Error('orphan run child survived SIGKILL; boot recovery refused')
    } else if (killOutcome === 'killed') {
      log.warn('orphan run had a live child process — group-killed (best-effort)', {
        nodeRunId: r.id,
        pid: r.pid,
      })
    }
    try {
      await transitionNodeRunStatus({
        db,
        nodeRunId: r.id,
        event: { kind: 'mark-interrupted' },
        extra: { finishedAt: now },
      })
      runsReaped += 1
    } catch (err) {
      // CAS lost / row already terminal: another writer beat us (e.g.
      // graceful shutdown landed first). Skip silently — orphans reap is
      // best-effort cleanup.
      log.warn('orphan-reap skipped row', {
        nodeRunId: r.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { tasks: runningTasks.length, runs: runsReaped }
}

/**
 * The sole production issuer for the RFC-224 recovery capability. A successful
 * reap proves all persisted known outer groups are non-live; bwrap's mandatory
 * `--die-with-parent --unshare-pid` contract covers system invocations which
 * intentionally have no node-run row. The live current-daemon lock proves the
 * prior daemon itself is gone and remains excluded through capability use.
 */
export async function reapOrphanRunsForStoreRecovery(
  db: DbClient,
  currentDaemonLock: Lock,
  dependencies: ReapOrphanRunsDependencies = {},
): Promise<{
  reap: ReapResult
  priorDaemonSandboxDead: PriorDaemonSandboxDeadCapability
}> {
  const reap = await reapOrphanRuns(db, dependencies)
  return {
    reap,
    priorDaemonSandboxDead: issuePriorDaemonSandboxDeadCapability(currentDaemonLock),
  }
}
