// RFC-333 T8 — legacy bootstrap wiring for the gate-continuation pre-drive
// phase.  The bounded contexts meet through their purpose-specific ports; this
// file is the temporary composition bridge tracked by RFC-294 W4.

import { GateContinuationEffectStep } from '@/modules/task-execution/application/drive/gateContinuationEffectStep'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import {
  TaskExecutionError,
  type GateWorkspaceRollbackExecutor,
} from '@/modules/task-execution/public/participants'
import type { TaskClarifyContinuationPort } from '@/modules/task-execution/application/ports/gateContinuationSupport'

type GatePreDriveContext = Parameters<InstanceType<typeof GateContinuationEffectStep>['run']>[0]

export function createGateContinuationPreDriveStep(input: {
  readonly persistence: Pick<
    TaskExecutionPersistence,
    'gateContinuationEffects' | 'gateContinuationPreDrive'
  >
  readonly rollbackExecutor: GateWorkspaceRollbackExecutor
  readonly clarifyConvergence: TaskClarifyContinuationPort
}): {
  run(context: GatePreDriveContext): Promise<{ kind: 'ready' }>
} {
  const effects = new GateContinuationEffectStep(
    input.persistence.gateContinuationEffects,
    input.rollbackExecutor,
  )
  return {
    async run(context) {
      const inspected = await input.persistence.gateContinuationPreDrive.inspect({
        taskId: context.taskId,
        intentId: context.execution.intentId,
        token: context.execution.token,
      })
      if (inspected.kind === 'clarify') {
        const clarify = inspected.continuation
        try {
          if (clarify.gateRef !== `clarify:${clarify.originNodeRunId}`) {
            throw new TaskExecutionError(
              'task-continuation-conflict',
              `clarify continuation '${context.execution.intentId}' changed its gate reference`,
            )
          }
          await input.clarifyConvergence.finish({
            operationId: clarify.operationId,
            expectedTaskId: context.taskId,
            expectedOriginNodeRunId: clarify.originNodeRunId,
            expectedContinuationRef: context.execution.intentId,
          })
          if (
            await input.persistence.gateContinuationPreDrive.hasUndispatchedClarifyWork({
              taskId: context.taskId,
              originNodeRunId: clarify.originNodeRunId,
            })
          ) {
            throw new TaskExecutionError(
              'task-execution-recovery-required',
              `clarify continuation '${context.execution.intentId}' still has undispatched durable work`,
            )
          }
        } catch (error) {
          await input.persistence.gateContinuationPreDrive.releaseClarifyForRetry({
            taskId: context.taskId,
            intentId: context.execution.intentId,
            token: context.execution.token,
            now: Date.now(),
          })
          throw error
        }
      }
      return await effects.run(context)
    },
  }
}
