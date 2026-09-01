import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '../../src/db/client'
import { nodeRuns, runtimeSessionLeases, tasks } from '../../src/db/schema'
import { dbTxSync } from '../../src/db/txSync'
import type { TaskRecoveryOperations } from '../../src/modules/task-execution/application/ports/taskRecoveryOperations'
import { createSqliteTaskRecoveryOperations } from '../../src/modules/task-execution/infrastructure/sqliteTaskRecoveryOperations'
import { terminalizeTaskExecutionIntentsTx } from '../../src/modules/task-execution/infrastructure/sqliteTerminalizeExecutionIntent'

const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_NODE_RUN_STATUSES)

/** Test composition mirrors daemon provider selection explicitly; recovery
 * services never accept a DbClient compatibility shape. */
export function taskRecoveryOperations(db: DbClient): TaskRecoveryOperations {
  return createSqliteTaskRecoveryOperations(db, {
    async interruptBootOrphanTask(input) {
      return dbTxSync(db, (tx) => {
        const interrupted = tx
          .update(tasks)
          .set({
            status: 'interrupted',
            finishedAt: input.now,
            errorSummary: input.failureCode,
            errorMessage: input.errorMessage,
          })
          .where(and(eq(tasks.id, input.taskId), eq(tasks.status, input.from)))
          .returning({ id: tasks.id })
          .all()
        if (interrupted.length !== 1) return false
        terminalizeTaskExecutionIntentsTx({
          tx,
          taskId: input.taskId,
          state: 'failed',
          failureCode: input.failureCode,
          now: input.now,
        })
        return true
      })
    },

    async interruptNodeRun(input) {
      const interrupted = await db
        .update(nodeRuns)
        .set({
          status: 'interrupted',
          finishedAt: input.now,
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        })
        .where(
          and(eq(nodeRuns.id, input.nodeRunId), inArray(nodeRuns.status, ['running', 'pending'])),
        )
        .returning({ id: nodeRuns.id })
      return interrupted.length === 1
    },

    async repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId) {
      return dbTxSync(db, (tx) => {
        const lease = tx
          .select()
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId))
          .get()
        if (
          lease === undefined ||
          lease.leaseNodeRunId === null ||
          lease.leaseNonceDigest === null
        ) {
          return 0
        }
        const run = tx
          .select({
            status: nodeRuns.status,
            sessionId: nodeRuns.opencodeSessionId,
            failureCode: nodeRuns.failureCode,
          })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, nodeRunId))
          .get()
        if (run === undefined || !TERMINAL_RUN_STATUSES.has(run.status)) return 0
        if (
          run.failureCode !== 'runtime-session-identity-invalid' &&
          !lease.resetPending &&
          run.sessionId === lease.sessionId
        ) {
          const released = tx
            .update(runtimeSessionLeases)
            .set({ leaseNodeRunId: null, leaseNonceDigest: null, leasedAt: null })
            .where(
              and(
                eq(runtimeSessionLeases.protocol, lease.protocol),
                eq(runtimeSessionLeases.sessionId, lease.sessionId),
                eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId),
              ),
            )
            .returning({ sessionId: runtimeSessionLeases.sessionId })
            .all()
          return released.length === 1 ? 1 : 0
        }
        tx.update(nodeRuns)
          .set({ opencodeSessionId: null })
          .where(and(eq(nodeRuns.id, nodeRunId), eq(nodeRuns.opencodeSessionId, lease.sessionId)))
          .run()
        const discarded = tx
          .delete(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, lease.protocol),
              eq(runtimeSessionLeases.sessionId, lease.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId),
            ),
          )
          .returning({ sessionId: runtimeSessionLeases.sessionId })
          .all()
        return discarded.length === 1 ? 1 : 0
      })
    },

    async interruptPeriodicTaskIfIdle(input) {
      const interrupted = await db
        .update(tasks)
        .set({ status: 'interrupted', finishedAt: input.now, errorSummary: input.failureCode })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.status, 'running')))
        .returning({ id: tasks.id })
      return interrupted.length === 1
    },
  })
}
