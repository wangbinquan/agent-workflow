import { captureTaskHostWriteContext } from '../application/taskHostWriteCapture'
import type { TaskResourceRecoveryGrant } from '../application/ports/taskRecoveryWritePurposes'
import {
  withTaskHostNewWork,
  withTaskHostRecovery,
  type TaskHostWriteBinding,
  type TaskHostWriteSelection,
} from './hostExecutionWriteTransaction'

export interface TaskResourceRecoveryWrite {
  readonly selection: Extract<TaskHostWriteSelection, { kind: 'selected' }>
  readonly write: typeof withTaskHostRecovery | typeof withTaskHostNewWork
}

/** Retain the original mapper and receiver before capture or any asynchronous work. */
export function captureTaskResourceRecoveryWrite(
  binding: TaskHostWriteBinding,
  grant: TaskResourceRecoveryGrant,
  purpose: 'boot' | 'periodic',
): TaskResourceRecoveryWrite {
  const port = binding?.port
  const transactionFor = binding?.transactionFor
  if (port === undefined || typeof transactionFor !== 'function') {
    throw new Error('task-recovery-write-selection-incomplete')
  }
  const capture = captureTaskHostWriteContext(port, grant)
  const originalBinding: TaskHostWriteBinding = Object.freeze({
    port,
    transactionFor(transaction: Parameters<TaskHostWriteBinding['transactionFor']>[0]) {
      return transactionFor.call(binding, transaction)
    },
  })
  return Object.freeze({
    selection: Object.freeze({ kind: 'selected', capture, binding: originalBinding }),
    write: purpose === 'boot' ? withTaskHostRecovery : withTaskHostNewWork,
  })
}
