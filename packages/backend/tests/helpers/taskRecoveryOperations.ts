import { patchNodeRunFixture, patchTaskFixture, readNodeRunFixtures } from './model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskRecoveryOperations } from '../../src/modules/task-execution/application/ports/taskRecoveryOperations'
import { createTaskRecoveryOperations } from '../../src/modules/task-execution/infrastructure/taskRecoveryOperations'
import { terminalizeTaskExecutionIntentsUncheckedInTx } from '../../src/modules/task-execution/infrastructure/taskExecutionIntentTerminalPersistence'
import { databaseSessionFor } from '../../src/platform/persistence/databaseTransaction'

const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_NODE_RUN_STATUSES)

/** Test composition mirrors daemon provider selection explicitly; recovery
 * services never accept a provider-branded compatibility shape. */
export function taskRecoveryOperations(db: PersistenceDb): TaskRecoveryOperations {
  return createTaskRecoveryOperations(db, {
    async interruptBootOrphanTask(input) {
      // RFC-359：同步孪生 `terminalizeTaskExecutionIntentsTx` 退役，这条夹具跟着搬到中立事务口。
      return await databaseSessionFor(db).transaction(async (tx) => {
        const interrupted = await patchTaskFixture(
          tx,
          { id: input.taskId, status: input.from },
          {
            status: 'interrupted',
            finishedAt: input.now,
            errorSummary: input.failureCode,
            errorMessage: input.errorMessage,
          },
        )
        if (interrupted !== 1) return false
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
      const interrupted = await patchNodeRunFixture(
        db,
        { id: input.nodeRunId, status: ['running', 'pending'] },
        {
          status: 'interrupted',
          finishedAt: input.now,
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        },
      )
      return interrupted === 1
    },

    async repairRuntimeSessionLeaseAfterOrphanReap(nodeRunId) {
      // RFC-359 AC-6：从 SQLite 专属的同步事务 `dbTxSync` 搬到中立事务口。
      // 事务体逐条改成 await：`.get()` → `(await …limit(1))[0]`，`.all()` / `.run()` → 直接 await。
      return await databaseSessionFor(db).transaction(async (tx) => {
        const { runtimeSessionLeases } = tablesOf(tx)
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
          await readNodeRunFixtures(tx, { id: nodeRunId }, { limit: 1 }).then((rows) =>
            rows.map((row) => ({
              status: row.status,
              sessionId: row.opencodeSessionId,
              failureCode: row.failureCode,
            })),
          )
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
        await patchNodeRunFixture(
          tx,
          { id: nodeRunId, opencodeSessionId: lease.sessionId },
          { opencodeSessionId: null },
        )
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
      const interrupted = await patchTaskFixture(
        db,
        { id: input.taskId, status: 'running' },
        { status: 'interrupted', finishedAt: input.now, errorSummary: input.failureCode },
      )
      return interrupted === 1
    },
  })
}
