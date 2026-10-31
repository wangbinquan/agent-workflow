import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskClarifyContinuationPort } from '../application/ports/gateContinuationSupport'
import type { GateWorkspaceRollbackExecutor } from '../public/participants'
import { createGateContinuationPreDriveStep } from '@/services/humanGateContinuationEffects'

/** The provider constructs its continuation objects at the original composition point. */
export function composeGateContinuationPreDrive(input: {
  readonly persistence: TaskExecutionPersistence
  readonly rollbackExecutor: GateWorkspaceRollbackExecutor
  readonly clarifyConvergence: TaskClarifyContinuationPort
}) {
  return createGateContinuationPreDriveStep(input)
}
