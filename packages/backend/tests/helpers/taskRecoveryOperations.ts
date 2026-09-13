import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '../../src/db/query'
import { nodeRuns, runtimeSessionLeases, tasks } from '../../src/db/schema'
import type { TaskRecoveryOperations } from '../../src/modules/task-execution/application/ports/taskRecoveryOperations'
import { createTaskRecoveryOperations } from '../../src/modules/task-execution/infrastructure/taskRecoveryOperations'
import { terminalizeTaskExecutionIntentsUncheckedInTx } from '../../src/modules/task-execution/infrastructure/taskExecutionIntentTerminalPersistence'
import { databaseSessionFor } from '../../src/platform/persistence/databaseTransaction'

const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_NODE_RUN_STATUSES)

/** Test composition mirrors daemon provider selection explicitly; recovery
 * services never accept a provider-branded compatibility shape. */
export function taskRecoveryOperations(db: ProviderNeutralDatabase): TaskRecoveryOperations {
  return createTaskRecoveryOperations(db, {
    async interruptBootOrphanTask(input) {
      // RFC-359：同步孪生 `terminalizeTaskExecutionIntentsTx` 退役，这条夹具跟着搬到中立事务口。
      return await databaseSessionFor(db).transaction(async (tx) => {
        const interrupted = await tx
          .update(tasks)
          .set({
            status: 'interrupted',
            finishedAt: input.now,
            errorSummary: input.failureCode,
            errorMessage: input.errorMessage,
          })
          .where(and(eq(tasks.id, input.taskId), eq(tasks.status, input.from)))
          .returning({ id: tasks.id })
        if (interrupted.length !== 1) return false
        await terminalizeTaskExecutionIntentsUncheckedInTx(tx, {
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
      // RFC-359 AC-6：从 SQLite 专属的同步事务 `dbTxSync` 搬到中立事务口。
      // 事务体逐条改成 await：`.get()` → `(await …limit(1))[0]`，`.all()` / `.run()` → 直接 await。
      return await databaseSessionFor(db).transaction(async (tx) => {
        const lease = (
          await tx
            .select()
            .from(runtimeSessionLeases)
            .where(eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId))
            .limit(1)
        )[0]
        if (
          lease === undefined ||
          lease.leaseNodeRunId === null ||
          lease.leaseNonceDigest === null
        ) {
          return 0
        }
        const run = (
          await tx
            .select({
              status: nodeRuns.status,
              sessionId: nodeRuns.opencodeSessionId,
              failureCode: nodeRuns.failureCode,
            })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, nodeRunId))
            .limit(1)
        )[0]
        if (run === undefined || !TERMINAL_RUN_STATUSES.has(run.status)) return 0
        if (
          run.failureCode !== 'runtime-session-identity-invalid' &&
          !lease.resetPending &&
          run.sessionId === lease.sessionId
        ) {
          const released = await tx
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
          return released.length === 1 ? 1 : 0
        }
        await tx
          .update(nodeRuns)
          .set({ opencodeSessionId: null })
          .where(and(eq(nodeRuns.id, nodeRunId), eq(nodeRuns.opencodeSessionId, lease.sessionId)))
        const discarded = await tx
          .delete(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, lease.protocol),
              eq(runtimeSessionLeases.sessionId, lease.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId),
            ),
          )
          .returning({ sessionId: runtimeSessionLeases.sessionId })
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
