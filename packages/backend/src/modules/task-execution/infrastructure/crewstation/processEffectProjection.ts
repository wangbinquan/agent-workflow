import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  ProcessEffectProjection,
  ProcessEffectOutcome,
} from '../../application/ports/processEffectProjection'
import { lockNodeRunTaskRootInTx, writeNodeRunTablesInTx } from '../nodeRunWriteProtocol'
import { requestHash } from '../../domain/executionEffect'
import { sha256Hex } from '../../domain/digest'
import { assertTaskOwnerTx, withTaskExecutionAggregateWrite } from '../ownedTaskExecution'

export interface HostedProcessReceipt {
  readonly executionId: string
  readonly businessTaskId: string
  readonly subtaskId: string
  readonly attempt: number
}

/** Remote receipts use the existing effect/attempt journal. A remote process
 * is never assigned a fake PID, and native process recovery cannot claim it. */
export function createHostedProcessEffectProjection<Outcome extends ProcessEffectOutcome>(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly request: unknown
  readonly writerWorkspace?: string
}): ProcessEffectProjection<HostedProcessReceipt, Outcome> {
  return {
    describe: () => ({
      requestHash: requestHash(input.request),
      resourceKeys:
        input.writerWorkspace === undefined
          ? []
          : [`workspace:${sha256Hex(input.writerWorkspace)}`],
      recoveryClass: 'crewstation-v3-execution',
      classifierVersion: 'crewstation-v3-result',
      transportPolicyVersion: 'crewstation-v3-request-key',
    }),
    async recordSpawnReceipt(record) {
      const lease = input.fence.current()
      await withTaskExecutionAggregateWrite(input.db, async (tx) => {
        await input.fence.assertHeld(tx, lease)
        await assertTaskOwnerTx(tx, record.token, record.now)
        const taskId = await lockNodeRunTaskRootInTx(tx, record.nodeRunId)
        if (taskId !== record.token.taskId) throw new Error('hosted-execution-node-receipt-fenced')
        const { taskExecutionEffects, taskExecutionEffectAttempts } = tablesOf(tx)
        const attempt = (
          await tx
            .select({ taskId: taskExecutionEffects.taskId })
            .from(taskExecutionEffectAttempts)
            .innerJoin(
              taskExecutionEffects,
              eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
            )
            .where(
              and(
                eq(taskExecutionEffectAttempts.id, record.attemptId),
                eq(taskExecutionEffectAttempts.effectId, record.effectId),
                eq(taskExecutionEffectAttempts.state, 'acting'),
                eq(taskExecutionEffectAttempts.epoch, record.token.epoch),
              ),
            )
            .limit(1)
        )[0]
        if (attempt?.taskId !== record.token.taskId)
          throw new Error('hosted-execution-owner-receipt-fenced')
        const updated = await tx
          .update(taskExecutionEffectAttempts)
          .set({
            receiptJson: JSON.stringify({ v: 1, phase: 'crewstation-accepted', ...record.receipt }),
            updatedAt: record.now,
          })
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, record.attemptId),
              eq(taskExecutionEffectAttempts.state, 'acting'),
              eq(taskExecutionEffectAttempts.epoch, record.token.epoch),
            ),
          )
          .returning({ id: taskExecutionEffectAttempts.id })
        if (updated.length !== 1) throw new Error('hosted-execution-owner-receipt-fenced')
        await writeNodeRunTablesInTx(tx, record.nodeRunId, {
          runtime: { pid: null, spawnBinaryPath: null, spawnLaunchNonce: null },
          config:
            record.runtimeParamsJson === undefined
              ? undefined
              : { runtimeParamsJson: record.runtimeParamsJson },
        })
      })
    },
    settlementReceipt: (outcome) =>
      JSON.stringify({ v: 1, phase: 'crewstation-result', ...outcome }),
  }
}
