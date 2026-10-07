// RFC-328 — exact execution capability threaded from durable claim to runner.
//
// The context is deliberately internal to the task-execution module.  Public
// REST/MCP contracts never serialize it, and callers cannot reconstruct one
// from a task id or an epoch number.

import { assertOwnershipToken, type OwnershipToken } from '../domain/ownership'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TaskExecutionContextRef } from './ports/taskExecutionTopology'
import type { TaskExecutionPersistence } from './ports/taskExecutionPersistence'
import { assertTaskHostWriteCapture, type TaskHostWriteCapture } from './taskHostWriteCapture'

const taskExecutionContextBrand: unique symbol = Symbol('rfc328.task-execution-context')
const trustedContexts = new WeakSet<object>()
const hostWriteCaptures = new WeakMap<object, TaskHostWriteCapture>()
const taskExecutionContextStorage = new AsyncLocalStorage<TaskExecutionContext>()

export interface TaskExecutionContext {
  readonly intentId: string
  readonly token: OwnershipToken
  readonly persistence: TaskExecutionPersistence
  /** Composition-only compatibility value. Application code never interprets it. */
  readonly legacyConnection?: unknown
  readonly [taskExecutionContextBrand]: true
}

export function createTaskExecutionContext<
  TCompatibility extends object = Record<never, never>,
>(input: {
  intentId: string
  token: OwnershipToken
  persistence: TaskExecutionPersistence
  legacyConnection?: unknown
  /** Composition-only fields used while legacy infrastructure callers converge. */
  compatibility?: TCompatibility
  /** Composition captures the original host receipt before the first async admission. */
  hostWriteCapture?: TaskHostWriteCapture
}): TaskExecutionContext & TCompatibility {
  assertOwnershipToken(input.token)
  if (input.intentId.length === 0) throw new Error('task execution context requires intent id')
  if (input.hostWriteCapture !== undefined) assertTaskHostWriteCapture(input.hostWriteCapture)
  const context = Object.freeze({
    intentId: input.intentId,
    token: input.token,
    persistence: input.persistence,
    ...(input.legacyConnection === undefined ? {} : { legacyConnection: input.legacyConnection }),
    ...(input.compatibility ?? ({} as TCompatibility)),
    [taskExecutionContextBrand]: true as const,
  })
  trustedContexts.add(context)
  if (input.hostWriteCapture !== undefined) hostWriteCaptures.set(context, input.hostWriteCapture)
  return context as TaskExecutionContext & TCompatibility
}

export function assertTaskExecutionContext(
  context: TaskExecutionContextRef,
  expectedTaskId?: string,
): void {
  if (!trustedContexts.has(context)) throw new Error('untrusted-task-execution-context')
  assertOwnershipToken(context.token)
  if (expectedTaskId !== undefined && context.token.taskId !== expectedTaskId) {
    throw new Error('task-execution-context-task-mismatch')
  }
}

export function runWithTaskExecutionContext<T>(context: TaskExecutionContextRef, run: () => T): T {
  assertTaskExecutionContext(context)
  return taskExecutionContextStorage.run(context as TaskExecutionContext, run)
}

export function currentTaskExecutionContext(
  expectedTaskId?: string,
): TaskExecutionContext | undefined {
  const context = taskExecutionContextStorage.getStore()
  if (context === undefined) return undefined
  assertTaskExecutionContext(context)
  if (expectedTaskId !== undefined && context.token.taskId !== expectedTaskId) return undefined
  return context
}

/** Return only the receipt bound to this original Task context. */
export function taskExecutionHostWriteCapture(
  context: TaskExecutionContextRef,
): TaskHostWriteCapture | undefined {
  assertTaskExecutionContext(context)
  return hostWriteCaptures.get(context)
}
