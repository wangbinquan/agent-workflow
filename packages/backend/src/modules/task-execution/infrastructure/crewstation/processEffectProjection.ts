import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionEffectAttempts, taskExecutionEffects } from '@/db/schema'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  ProcessEffectProjection,
  ProcessEffectOutcome,
} from '../../application/ports/processEffectProjection'
import { requestHash } from '../../domain/executionEffect'
import { sha256Hex } from '../../domain/digest'
import { assertTaskOwnerTx, withTaskExecutionSerializable } from '../ownedTaskExecution'

export interface HostedProcessReceipt {
  readonly executionId: string
  readonly businessTaskId: string
  readonly subtaskId: string
  readonly attempt: number
}

/** Remote receipts use the existing effect/attempt journal. A remote process
 * is never assigned a fake PID, and native process recovery cannot claim it. */
export function createHostedProcessEffectProjection<Outcome extends ProcessEffectOutcome>(input: {
  readonly db: ProviderNeutralDatabase
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
      await withTaskExecutionSerializable(input.db, async (tx) => {
        await input.fence.assertHeld(tx, lease)
        await assertTaskOwnerTx(tx, record.token, record.now)
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
        await tx
          .update(taskExecutionEffectAttempts)
          .set({
            receiptJson: JSON.stringify({ v: 1, phase: 'crewstation-accepted', ...record.receipt }),
            updatedAt: record.now,
          })
          .where(eq(taskExecutionEffectAttempts.id, record.attemptId))
        const rows = await tx
          .update(nodeRuns)
          .set({
            pid: null,
            spawnBinaryPath: null,
            spawnLaunchNonce: null,
            ...(record.runtimeParamsJson === undefined
              ? {}
              : { runtimeParamsJson: record.runtimeParamsJson }),
          })
          .where(and(eq(nodeRuns.id, record.nodeRunId), eq(nodeRuns.taskId, record.token.taskId)))
          .returning({ id: nodeRuns.id })
        if (rows.length !== 1) throw new Error('hosted-execution-node-receipt-fenced')
      })
    },
    settlementReceipt: (outcome) =>
      JSON.stringify({ v: 1, phase: 'crewstation-result', ...outcome }),
  }
}
