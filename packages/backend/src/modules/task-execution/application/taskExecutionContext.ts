// RFC-328 — exact execution capability threaded from durable claim to runner.
//
// The context is deliberately internal to the task-execution module.  Public
// REST/MCP contracts never serialize it, and callers cannot reconstruct one
// from a task id or an epoch number.

import { assertOwnershipToken, type OwnershipToken } from '../domain/ownership'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DbClient } from '@/db/client'
import type { TaskExecutionContextRef } from './ports/taskExecutionTopology'

const taskExecutionContextBrand: unique symbol = Symbol('rfc328.task-execution-context')
const trustedContexts = new WeakSet<object>()
const taskExecutionContextStorage = new AsyncLocalStorage<TaskExecutionContext>()

export interface TaskExecutionContext {
  readonly intentId: string
  readonly token: OwnershipToken
  /** Daemon-internal connection used by deeply nested effect adapters. */
  readonly db: DbClient
  readonly [taskExecutionContextBrand]: true
}

export function createTaskExecutionContext(input: {
  intentId: string
  token: OwnershipToken
  db: DbClient
}): TaskExecutionContext {
  assertOwnershipToken(input.token)
  if (input.intentId.length === 0) throw new Error('task execution context requires intent id')
  const context = Object.freeze({
    intentId: input.intentId,
    token: input.token,
    db: input.db,
    [taskExecutionContextBrand]: true as const,
  })
  trustedContexts.add(context)
  return context
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
