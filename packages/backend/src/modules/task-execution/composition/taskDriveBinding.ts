import type { TaskExecutionModule } from '../composition'
import type { TaskDriverLifecyclePort } from '../application/drive/taskDriveCoordinator'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskHostNewWorkAdmission } from '../application/ports/taskHostAdmission'
import type { ActiveTaskExecutionParticipant } from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskHostWriteBinding } from '../infrastructure/hostExecutionWriteTransaction'

/** One provider composition owns the complete process identity and host selection. */
export interface TaskExecutionProviderHostSelection {
  readonly daemonGeneration: string
  readonly admission: TaskHostNewWorkAdmission
  readonly writes: TaskHostWriteBinding
}

/** The legacy launch bridge carries the same module, persistence and driver. */
export interface TaskDriveBinding {
  readonly executionModule: TaskExecutionModule
  readonly persistence: TaskExecutionPersistence
  readonly driverLifecycle: TaskDriverLifecyclePort
}

/** Capture assembly callbacks without taking an admission or creating a receipt. */
export function captureTaskExecutionProviderHostSelection(
  selection: TaskExecutionProviderHostSelection | undefined,
): TaskExecutionProviderHostSelection | undefined {
  if (selection === undefined) return undefined
  const daemonGeneration = selection?.daemonGeneration
  const admission = selection?.admission
  const writes = selection?.writes
  const acquire = admission?.acquire
  const port = writes?.port
  const transactionFor = writes?.transactionFor
  if (
    typeof daemonGeneration !== 'string' ||
    daemonGeneration.trim().length === 0 ||
    typeof acquire !== 'function' ||
    typeof port?.capture !== 'function' ||
    typeof port.consumeNewWork !== 'function' ||
    typeof port.consumeRecovery !== 'function' ||
    typeof port.consumeIssuedAck !== 'function' ||
    typeof transactionFor !== 'function'
  )
    throw new Error('task-host-provider-selection-incomplete')
  return Object.freeze({
    daemonGeneration,
    admission: Object.freeze({ acquire: () => acquire.call(admission) }),
    writes: Object.freeze({
      // Each actual admission captures this original port and its opaque receipt.
      port,
      transactionFor: (tx: Parameters<TaskHostWriteBinding['transactionFor']>[0]) =>
        transactionFor.call(writes, tx),
    }),
  })
}

/** Validate and hold the complete binding before any launch or continuation effect. */
export function captureTaskDriveBinding(
  binding: TaskDriveBinding | undefined,
  explicitPersistence?: TaskExecutionPersistence,
): TaskDriveBinding | undefined {
  if (binding === undefined) return undefined
  const executionModule = binding?.executionModule
  const persistence = binding?.persistence
  const driverLifecycle = binding?.driverLifecycle
  if (
    executionModule === undefined ||
    executionModule === null ||
    persistence === undefined ||
    persistence === null ||
    typeof driverLifecycle?.attach !== 'function' ||
    typeof driverLifecycle.releaseAndFinalize !== 'function'
  )
    throw new Error('task-drive-binding-incomplete')
  if (explicitPersistence !== undefined && explicitPersistence !== persistence)
    throw new Error('task-drive-persistence-mismatch')
  return Object.freeze({ executionModule, persistence, driverLifecycle })
}

export function composeTaskDriveActivityParticipant(
  binding: TaskDriveBinding,
): ActiveTaskExecutionParticipant {
  const registry = binding.executionModule.runtimeRegistry
  return Object.freeze({
    isActive: (taskId: string) => registry.hasTask(taskId),
    awaitReleasedSettled: (taskId: string) => registry.awaitReleasedSettled(taskId),
  })
}
