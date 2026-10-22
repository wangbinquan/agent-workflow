// RFC-370 v3 V5 — Task Execution's hosted restore normalization (standalone
// RFC-213 semantics). A restored snapshot is not a crash of this instance:
//   · every task that still owns a live worktree gets auto_recovery_suspended,
//     so no automatic resume/repair acts on backup-era rows;
//   · runs and tasks that were running are interrupted (manual resume stays the
//     user's informed choice), through the shared lifecycle kernels;
//   · every unsettled hosted execution binding requests cancellation with
//     reason `restored`: its submit/cancel intent belonged to the backed-up
//     instance, and boot recovery cancels and settles it instead of adopting it;
//   · platform recovery requests still in flight end as failed: resuming a
//     task now is the user's informed choice, not a backup-era request's.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { DAEMON_RESTART_ERROR_SUMMARY, LIVE_WORKTREE_TASK_STATUSES } from '@agent-workflow/shared'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedRestoreNormalizationParticipant } from '@/modules/system-operations/public/participants'
import { setNodeRunStatusTx } from './nodeRunLifecycleTransition'
import { terminalizeTaskExecutionIntentsUncheckedInTx } from './taskExecutionIntentTerminalPersistence'
import { writeTaskRuntimeLifecycleInTx } from './taskRuntimeLifecyclePersistence'

export const RESTORE_INTERRUPTION_MESSAGE =
  'Interrupted by a database restore; resume manually after checking the workspace.'

export function createHostedRestoreTaskNormalization(): HostedRestoreNormalizationParticipant {
  return {
    name: 'task-execution',
    async normalize(tx: PersistenceDb, { now }) {
      const { tasks, nodeRuns, hostedExecutionBindings, hostedRecoveryRequests } = tablesOf(tx)
      const suspended = await tx
        .update(tasks)
        .set({ autoRecoverySuspended: true })
        .where(
          and(
            eq(tasks.autoRecoverySuspended, false),
            inArray(tasks.status, [...LIVE_WORKTREE_TASK_STATUSES]),
          ),
        )
        .returning({ id: tasks.id })
      const runs = await tx
        .select({ id: nodeRuns.id, taskId: nodeRuns.taskId, nodeId: nodeRuns.nodeId })
        .from(nodeRuns)
        .where(eq(nodeRuns.status, 'running'))
      const changes = new Map<string, TaskNodeChangeV1[]>()
      for (const run of runs) {
        await setNodeRunStatusTx({
          tx,
          nodeRunId: run.id,
          to: 'interrupted',
          allowedFrom: ['running'],
          extra: { finishedAt: now, errorMessage: RESTORE_INTERRUPTION_MESSAGE },
          reason: 'database-restore',
        })
        const list = changes.get(run.taskId) ?? []
        list.push({
          nodeRunId: run.id,
          nodeId: run.nodeId,
          status: 'interrupted',
          cause: 'database-restore',
        })
        changes.set(run.taskId, list)
      }
      const running = await tx
        .select({ id: tasks.id, errorSummary: tasks.errorSummary })
        .from(tasks)
        .where(eq(tasks.status, 'running'))
      let interrupted = 0
      for (const task of running) {
        const written = await writeTaskRuntimeLifecycleInTx(tx, {
          taskId: task.id,
          from: 'running',
          to: 'interrupted',
          extra: {
            finishedAt: now,
            errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
            errorMessage: RESTORE_INTERRUPTION_MESSAGE,
          },
          now,
          workspacePruneDecision: { prune: false },
          previousErrorSummary: task.errorSummary,
          nodeChanges: changes.get(task.id) ?? [],
        })
        if (written === null) continue
        await terminalizeTaskExecutionIntentsUncheckedInTx(tx, {
          taskId: task.id,
          state: 'failed',
          failureCode: 'database-restored',
          now,
        })
        interrupted++
      }
      // No run of the restored database adopts a backup-era execution, so an
      // earlier user / timeout reason is replaced: only `restored` is final.
      const bindings = await tx
        .update(hostedExecutionBindings)
        .set({ cancelRequested: true, cancelReason: 'restored', updatedAt: now })
        .where(
          and(
            ne(hostedExecutionBindings.state, 'settled'),
            or(
              isNull(hostedExecutionBindings.cancelReason),
              ne(hostedExecutionBindings.cancelReason, 'restored'),
            ),
          ),
        )
        .returning({ executionId: hostedExecutionBindings.executionId })
      const recoveries = await tx
        .update(hostedRecoveryRequests)
        .set({ state: 'failed', reason: 'database-restored', updatedAt: now })
        .where(inArray(hostedRecoveryRequests.state, ['admitted', 'executing']))
        .returning({ requestId: hostedRecoveryRequests.requestId })
      return {
        suspendedTasks: suspended.length,
        interruptedTasks: interrupted,
        interruptedNodeRuns: runs.length,
        cancelledBindings: bindings.length,
        failedRecoveryRequests: recoveries.length,
      }
    },
  }
}
