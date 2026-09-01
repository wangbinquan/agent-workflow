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

import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  killStaleRunProcessTree,
  type StaleRunKillOutcome,
  type StaleRunKillOpts,
} from '@/util/process'
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

export async function reapOrphanRuns(
  operations: TaskRecoveryOperations,
  dependencies: ReapOrphanRunsDependencies = {},
): Promise<ReapResult> {
  const now = Date.now()
  // RFC-097: 'pending' tasks are reaped too — boot runs before the HTTP server
  // listens, so any pending task here is an orphan (startTask inserts and
  // kicks in-process; a resume/retry that crashed mid-rollback leaves the
  // CAS-claimed task pending with nobody attached — the gap5 task-side
  // asymmetry this closes, mirroring the node_runs branch below which always
  // reaped pending rows).
  // RFC-333: commit -> wake leaves a `pending` task and one canonical pending
  // gate-continuation intent. The previous owner may still have a `running`
  // node row when SIGKILL lands: reap that row, but preserve the task, its
  // pending anchors and the durable successor for the continuous worker.
  // Legacy workgroup/dynamic-workflow task gates remain request-owned and keep
  // the historical orphan-reap behavior.
  const snapshot = await operations.loadBootOrphanSnapshot()
  const runningTasks = snapshot.tasks
  const runningRuns = snapshot.runs
  // A runner that exhausted TERM→KILL records a terminal row but deliberately
  // leaves its native-session lease held. Boot must prove that child gone too
  // before the subsequent lease repair can release/discard the holder.
  const heldLeaseRunIds = snapshot.heldLeaseRunIds
  const heldLeaseRuns = snapshot.heldLeaseRuns

  if (runningTasks.length === 0 && runningRuns.length === 0 && heldLeaseRuns.length === 0) {
    return { tasks: 0, runs: 0 }
  }

  for (const t of runningTasks) {
    // RFC-097: CAS from the observed status; a loss means something else
    // already settled the row — skip and log, same net as the node_runs
    // branch below.
    const won = await operations.interruptBootOrphanTask({
      taskId: t.id,
      from: t.status,
      now,
      failureCode: DAEMON_RESTART_ERROR_SUMMARY,
      errorMessage: 'daemon restarted while this task was running; please resume',
    })
    if (!won) {
      log.warn('orphan task reap lost a race — skipping', { taskId: t.id })
      continue
    }
    // RFC-108 T3 (AR-11): durable audit of the boot reap.
    await recordRecoveryEvent(operations, {
      taskId: t.id,
      kind: 'boot-reap',
      reason: DAEMON_RESTART_ERROR_SUMMARY,
      before: { status: t.status },
      after: { status: 'interrupted' },
      now,
    })
  }
  let runsReaped = 0
  const activeRunIds = new Set(runningRuns.map((run) => run.id))
  const processRows = [...runningRuns, ...heldLeaseRuns.filter((run) => !activeRunIds.has(run.id))]
  for (const r of processRows) {
    // RFC-098 WP-8: kill-then-flip. killStaleRunProcessTree applies both
    // PID-reuse noise gates (startedAt < 48h window + `ps -p pid -o command=`
    // must look like opencode/bun) before signaling. Ambiguous PID-reuse
    // outcomes fall through; a known child which survives KILL aborts.
    const killOutcome = await (dependencies.killStaleRunProcessTree ?? killStaleRunProcessTree)(r, {
      now,
    })
    const ownsHeldNativeLease = heldLeaseRunIds.includes(r.id)
    if (killOutcome === 'kill-failed') {
      log.error('orphan run child SURVIVED SIGKILL — still alive after reap (resume will refuse)', {
        nodeRunId: r.id,
        pid: r.pid,
      })
      throw new Error('orphan run child survived SIGKILL; boot recovery refused')
    } else if (ownsHeldNativeLease && killOutcome !== 'killed' && killOutcome !== 'not-alive') {
      // A held native session has a known writer identity but no per-row reap
      // proof for these outcomes. Releasing it would admit a second writer.
      log.error('held runtime-session child could not be proven reaped; boot recovery refused', {
        nodeRunId: r.id,
        pid: r.pid,
        killOutcome,
      })
      throw new Error('held runtime-session child reap was unproven; boot recovery refused')
    } else if (killOutcome === 'killed') {
      log.warn('orphan run had a live child process — group-killed (best-effort)', {
        nodeRunId: r.id,
        pid: r.pid,
      })
    }
    // Terminal child-unkillable rows need only the process barrier above; the
    // caller repairs their still-held native lease after every row is safe.
    if (!activeRunIds.has(r.id)) continue
    try {
      const interrupted = await operations.interruptNodeRun({
        nodeRunId: r.id,
        now,
      })
      if (interrupted) runsReaped += 1
      else {
        log.warn('orphan-reap skipped row', { nodeRunId: r.id })
      }
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
