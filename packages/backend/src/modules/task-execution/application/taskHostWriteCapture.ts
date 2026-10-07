import type {
  TaskHostWriteContext,
  TaskHostWriteReceipt,
  TaskHostWriteTransaction,
} from './ports/taskHostWriteContext'

declare const taskHostWriteCaptureBrand: unique symbol

/** The original admitted receipt travels through Task without exposing its host. */
export interface TaskHostWriteCapture {
  readonly [taskHostWriteCaptureBrand]: true
}

interface CapturedTaskHostWriteContext {
  readonly port: TaskHostWriteContext
  readonly receipt: TaskHostWriteReceipt
  readonly newWork: TaskHostWriteContext['consumeNewWork']
  readonly recovery: TaskHostWriteContext['consumeRecovery']
  readonly issuedAck: TaskHostWriteContext['consumeIssuedAck']
}

const capturedContexts = new WeakMap<TaskHostWriteCapture, CapturedTaskHostWriteContext>()

export function captureTaskHostWriteContext(
  port: TaskHostWriteContext,
  grant: { readonly generation: string; readonly reference: object },
): TaskHostWriteCapture {
  if (port === undefined) throw new Error('task-host-write-capture-incomplete')
  const capture = port.capture
  const newWork = port.consumeNewWork
  const recovery = port.consumeRecovery
  const issuedAck = port.consumeIssuedAck
  if (
    [capture, newWork, recovery, issuedAck].some((operation) => typeof operation !== 'function')
  ) {
    throw new Error('task-host-write-capture-incomplete')
  }
  const receipt = capture.call(port, {
    generation: grant.generation,
    reference: grant.reference,
  })
  const value = Object.freeze({}) as TaskHostWriteCapture
  capturedContexts.set(value, { port, receipt, newWork, recovery, issuedAck })
  return value
}

function capturedContext(capture: TaskHostWriteCapture): CapturedTaskHostWriteContext {
  const context = capturedContexts.get(capture)
  if (context === undefined) throw new Error('task-host-write-capture-unavailable')
  return context
}

export function assertTaskHostWriteCapture(
  capture: TaskHostWriteCapture,
  expectedPort?: TaskHostWriteContext,
): void {
  const context = capturedContext(capture)
  if (expectedPort !== undefined && context.port !== expectedPort) {
    throw new Error('task-host-write-capture-binding-mismatch')
  }
}

export function consumeTaskHostNewWork(
  capture: TaskHostWriteCapture,
  transaction: TaskHostWriteTransaction,
): Promise<void> {
  const context = capturedContext(capture)
  return context.newWork.call(context.port, transaction, context.receipt)
}

export function consumeTaskHostRecovery(
  capture: TaskHostWriteCapture,
  transaction: TaskHostWriteTransaction,
): Promise<void> {
  const context = capturedContext(capture)
  return context.recovery.call(context.port, transaction, context.receipt)
}

export function consumeTaskHostIssuedAck(
  capture: TaskHostWriteCapture,
  transaction: TaskHostWriteTransaction,
): Promise<void> {
  const context = capturedContext(capture)
  return context.issuedAck.call(context.port, transaction, context.receipt)
}
