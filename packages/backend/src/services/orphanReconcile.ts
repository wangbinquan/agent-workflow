// RFC-108 T17 (AR-10) — periodic post-boot orphan reconciler.
//
// `reapOrphanRuns` only runs ONCE at boot and optimistically flips EVERY running
// row (it assumes a daemon restart). This is its live-daemon counterpart: a
// periodic sweep that flips only node_runs whose LIVENESS EVIDENCE CHAIN is
// provably broken. A startedAt grace avoids racing a just-spawned run.
// reap-to-interrupted is the safe default action (auto-RESUME of the reconciled
// task stays gated behind T18's autoResumeOnBoot-style opt-in).
//
// RFC-230 — the judgment used to be `pid === null || !isProcessAlive(pid)`.
// That equated "no process" with "dead", which is only true for runs whose
// liveness is carried by a child process. wrapper rows (git / loop / fanout)
// are bookkeeping rows for a subgraph being driven by a scheduler coroutine and
// NEVER get a pid, so every wrapper whose inner scope outlived the 60s grace was
// reaped mid-flight; its finalize then hit the terminal guard and failed the
// whole task with `scheduler error`. The judgment now goes through
// services/runLiveness.ts: driver → process → delegated → conservative-alive.
// Two consequences worth stating out loud:
//   - a task still owned by an in-process scheduler is off limits entirely
//     (same rule lifecycleRepair has honored since RFC-097 audit S-23; this
//     sweep was the only background writer bypassing it), and
//   - a wrapper that genuinely lost its driver IS now reaped — for the right
//     reason (inner runs all terminal) rather than by the accident of having
//     no pid.
//
// The process probe and the driver gate are injected so the sweep is
// unit-testable without real processes; the provider session's orphan-reconcile
// loop (modules/task-execution/composition/providerBackground.ts) wires the real
// isProcessAlive + binary-identity check and the real activeTasks registry.

import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  type LivenessReason,
  type LivenessRunRow,
  resolveRunLiveness,
} from '@/services/runLiveness'
import {
  isProcessAlive,
  killStaleRunProcessTree,
  pidCommandContainsBinary,
  type StaleRunKillOutcome,
  type StaleRunKillOpts,
} from '@/util/process'
import { createLogger } from '@/util/log'
import {
  isTerminalTaskStatus,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
} from '@agent-workflow/shared'
import type { WorkflowDefinition } from '@agent-workflow/shared'

const log = createLogger('orphan-reconcile')

export interface ReconcileRun extends LivenessRunRow {
  taskId: string
  startedAt: number | null
}

/**
 * Real process probe: is the run's child still alive AND still the binary we
 * spawned (a recycled pid is not our child)?
 *
 * RFC-230: this is now a PROBE ONLY. It is called exclusively for rows that
 * carry a pid, i.e. rows that provably spawned. The old `pid === null ⇒ gone`
 * shortcut — which judged every pid-less bookkeeping row dead — is gone; that
 * classification lives in runLiveness.classifyRunLiveness.
 */
export function probeRunProcessAlive(pid: number, spawnBinaryPath: string | null): boolean {
  if (!isProcessAlive(pid)) return false
  if (
    typeof spawnBinaryPath === 'string' &&
    spawnBinaryPath.length > 0 &&
    !pidCommandContainsBinary(pid, spawnBinaryPath)
  ) {
    return false
  }
  return true
}

export interface ReconcileDeps {
  operations: TaskRecoveryOperations
  /** Only reconcile runs whose startedAt is older than now-graceMs (anti-race). */
  graceMs: number
  /** Injected process probe. Defaults to the real one. */
  probeProcessAlive?: (pid: number, spawnBinaryPath: string | null) => boolean
  /** Required provider-neutral driver gate — is an in-process scheduler attached? */
  taskHasDriver: (taskId: string) => boolean
  /**
   * A boolean liveness miss cannot distinguish a dead PID from a live recycled
   * or command-mismatched PID. A held native-session lease needs the stronger
   * kill/not-alive proof before it can admit another writer.
   */
  reapHeldNativeSessionProcess?: (
    run: { pid: number | null; startedAt: number | null; spawnBinaryPath?: string | null },
    opts?: StaleRunKillOpts,
  ) => Promise<StaleRunKillOutcome>
  now?: number
}

export interface ReconcileResult {
  reapedRuns: string[]
  reapedTasks: string[]
  /** RFC-230 — why each candidate was reaped (audit breadcrumb, additive). */
  reasons: Record<string, LivenessReason>
}

/**
 * Flip running node_runs whose liveness evidence chain is broken to
 * `interrupted`, then flip any task with no remaining active runs to
 * `interrupted` too. Records a `periodic-reap` recovery_event per task.
 */
export async function reconcileDeadRunningRuns(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { operations } = deps
  const now = deps.now ?? Date.now()
  const probeProcess = deps.probeProcessAlive ?? probeRunProcessAlive
  const hasDriver = deps.taskHasDriver
  const out: ReconcileResult = { reapedRuns: [], reapedTasks: [], reasons: {} }
  const candidates = await operations.listPeriodicReconcileCandidates(now - deps.graceMs)

  const byTask = new Map<string, ReconcileRun[]>()
  for (const run of candidates) {
    const list = byTask.get(run.taskId)
    if (list === undefined) byTask.set(run.taskId, [run])
    else list.push(run)
  }

  const affectedTasks = new Set<string>()
  for (const [taskId, taskCandidates] of byTask) {
    // RFC-230 ① driver gate. An in-process scheduler owning this task means
    // every row under it has a live owner; a background sweep has no business
    // pronouncing them dead (RFC-097 audit S-23's rule, now applied here too).
    if (hasDriver(taskId)) continue
    const snapshot = await operations.loadPeriodicReconcileSnapshot(taskId)
    const definition = loadTaskDefinition(snapshot?.workflowSnapshot ?? null)
    if (definition === null) {
      // The ONE remaining conservative-alive case (RFC-230 §2.3 after the Codex
      // P1-1 revision): with an unparseable snapshot we cannot even classify a
      // row's evidence source, so we refuse to judge. Every other "no evidence"
      // case is decided, not deferred.
      log.warn('orphan reconcile: task snapshot unresolvable — refusing to judge', { taskId })
      continue
    }
    const rows: LivenessRunRow[] = (snapshot?.runs ?? []).map((run) => ({
      id: run.id,
      nodeId: run.nodeId,
      status: run.status,
      pid: run.pid,
      spawnBinaryPath: run.spawnBinaryPath,
      parentNodeRunId: run.parentNodeRunId,
      childTaskId: run.childTaskId,
    }))

    // RFC-243 §4.1 — cross-task delegation probe: batch-read the child tasks
    // referenced by this task's call rows once per tick. Terminal AND missing
    // both map to 'settled' (evidence lapses; the parent's resume replay owns
    // the finalize).
    const probeChildTask = (childTaskId: string): 'active' | 'settled' => {
      const st = snapshot?.childTaskStatuses[childTaskId]
      if (st === undefined) return 'settled'
      return isTerminalTaskStatus(st) ? 'settled' : 'active'
    }
    for (const run of taskCandidates) {
      const verdict = resolveRunLiveness({
        row: run,
        rows,
        definition,
        taskHasDriver: false, // already gated above
        probeProcess,
        probeChildTask,
      })
      if (verdict.alive) continue
      const heldNativeLeaseId = await operations.findHeldRuntimeSessionId(run.id)
      if (heldNativeLeaseId !== null) {
        const reapOutcome = await (deps.reapHeldNativeSessionProcess ?? killStaleRunProcessTree)(
          run,
          { now },
        )
        if (reapOutcome !== 'not-alive' && reapOutcome !== 'killed') {
          // A held native-session lease is only keyed by the concrete native
          // id. Marking this run interrupted would let the scheduler retry
          // with a different id while the old child may still be writing the
          // same worktree. Keep both run and task owned until a structured
          // reap proves the child gone.
          log.error('periodic reap could not prove held native-session child gone', {
            nodeRunId: run.id,
            sessionId: heldNativeLeaseId,
            reason: verdict.reason,
            reapOutcome,
          })
          continue
        }
      }
      // RFC-230 (Codex 设计门 P2-2): the gate above and this write are separated
      // by awaits, so a resume could have registered a driver in between and
      // re-taken ownership of this very row. Re-check immediately before the
      // write — it is an in-process Map lookup, and it collapses the window to
      // "between this check and the CAS". Full atomicity would need a task
      // ownership epoch shared with startTask/resumeKick; recorded as a residual
      // in design §5 rather than half-built here.
      if (hasDriver(taskId)) continue
      const ok = await operations.interruptNodeRun({
        nodeRunId: run.id,
        now,
        errorMessage: 'orphan-reconcile',
      })
      if (!ok) continue
      await operations.repairRuntimeSessionLeaseAfterOrphanReap(run.id)
      out.reapedRuns.push(run.id)
      out.reasons[run.id] = verdict.reason
      affectedTasks.add(run.taskId)
      // RFC-230 AC2 (Codex 设计门 P2-4): audit the REAP ITSELF, not only the
      // task flip. A wrapper reaped while sibling work stays pending never
      // flips the task, and the old code left no trace of it at all.
      await recordRecoveryEvent(operations, {
        taskId: run.taskId,
        nodeRunId: run.id,
        kind: 'periodic-reap',
        reason: `orphan-reconcile: ${verdict.reason}`,
        before: { status: 'running' },
        after: { status: 'interrupted' },
        now,
      })
    }
  }

  for (const taskId of affectedTasks) {
    // The driver gate applies to the task row too: a live scheduler's task must
    // never be pronounced interrupted underneath it.
    if (hasDriver(taskId)) continue
    const flipped = await operations.interruptPeriodicTaskIfIdle({
      taskId,
      now,
      failureCode: 'orphan-reconcile',
    })
    if (!flipped) continue
    out.reapedTasks.push(taskId)
    await recordRecoveryEvent(operations, {
      taskId,
      kind: 'periodic-reap',
      // RFC-230: state WHY, per run — 'process-gone' vs 'inner-all-terminal'
      // are very different stories for whoever reads the audit later.
      reason: `orphan-reconcile: ${summarizeReasons(out, taskId, byTask)}`,
      after: { status: 'interrupted' },
      now,
    })
  }
  return out
}

function summarizeReasons(
  out: ReconcileResult,
  taskId: string,
  byTask: ReadonlyMap<string, ReconcileRun[]>,
): string {
  const ids = (byTask.get(taskId) ?? [])
    .map((r) => r.id)
    .filter((id) => out.reasons[id] !== undefined)
  const counts = new Map<LivenessReason, number>()
  for (const id of ids) {
    const reason = out.reasons[id] as LivenessReason
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts].map(([reason, n]) => `${reason}×${n}`).join(', ')
}

function loadTaskDefinition(snapshot: string | null): WorkflowDefinition | null {
  if (typeof snapshot !== 'string' || snapshot.length === 0) return null
  try {
    const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(snapshot))
    return parsed.success ? migrateWorkflowDefinitionToLatest(parsed.data) : null
  } catch {
    return null
  }
}
