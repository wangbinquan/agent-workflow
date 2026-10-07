import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  TaskHostWriteContext,
  TaskHostWriteTransaction,
} from '../application/ports/taskHostWriteContext'
import {
  assertTaskHostWriteCapture,
  consumeTaskHostNewWork,
  consumeTaskHostRecovery,
  consumeTaskHostIssuedAck,
  type TaskHostWriteCapture,
} from '../application/taskHostWriteCapture'
import {
  withTaskExecutionWrite,
  withTaskExecutionSerializable,
  type TaskExecutionTransaction,
} from './ownedTaskExecution'

export interface TaskHostWriteBinding {
  readonly port: TaskHostWriteContext
  transactionFor(transaction: TaskExecutionTransaction): TaskHostWriteTransaction
}

export type TaskHostWriteSelection =
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'selected'
      capture: TaskHostWriteCapture
      binding: TaskHostWriteBinding
    }>

export interface TaskHostWriteInput<T> {
  readonly db: ProviderNeutralDatabase
  readonly selection: TaskHostWriteSelection
  readonly isolation?: 'write' | 'serializable'
  readonly body: (transaction: TaskExecutionTransaction) => Promise<T>
}

function write<T>(
  input: TaskHostWriteInput<T>,
  consume: (capture: TaskHostWriteCapture, transaction: TaskHostWriteTransaction) => Promise<void>,
): Promise<T> {
  const transaction =
    input.isolation === 'serializable' ? withTaskExecutionSerializable : withTaskExecutionWrite
  const selection = input.selection
  if (selection.kind === 'native') return transaction(input.db, input.body)
  if (selection.capture === undefined || selection.binding === undefined) {
    throw new Error('task-host-write-selection-incomplete')
  }
  const binding = selection.binding
  const transactionFor = binding.transactionFor
  if (binding.port === undefined || typeof transactionFor !== 'function') {
    throw new Error('task-host-write-selection-incomplete')
  }
  assertTaskHostWriteCapture(selection.capture, binding.port)
  const capture = selection.capture
  const body = input.body
  return transaction(input.db, async (originalTransaction) => {
    const result = await body(originalTransaction)
    await consume(capture, transactionFor.call(binding, originalTransaction))
    return result
  })
}

export function withTaskHostNewWork<T>(input: TaskHostWriteInput<T>): Promise<T> {
  return write(input, consumeTaskHostNewWork)
}

export function withTaskHostRecovery<T>(input: TaskHostWriteInput<T>): Promise<T> {
  return write(input, consumeTaskHostRecovery)
}

export function withTaskHostIssuedAck<T>(input: TaskHostWriteInput<T>): Promise<T> {
  return write(input, consumeTaskHostIssuedAck)
}
