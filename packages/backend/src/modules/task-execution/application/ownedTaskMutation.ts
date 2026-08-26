// RFC-328 — execution-plane mutation gateway for non-lifecycle rows.

import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync, type NotPromise } from '@/db/txSync'
import { taskExecutionModule } from '../composition'
import {
  assertTaskExecutionContext,
  currentTaskExecutionContext,
  type TaskExecutionContext,
} from './taskExecutionContext'

export function withTaskExecutionMutation<T>(input: {
  db: DbClient
  taskId: string
  context?: TaskExecutionContext
  now?: number
  run: (tx: DbTxSync | DbClient) => T
}): T {
  const context = input.context ?? currentTaskExecutionContext(input.taskId)
  if (context === undefined) return input.run(input.db)
  assertTaskExecutionContext(context, input.taskId)
  return taskExecutionModule.ownership.withOwnedTaskTx({
    db: input.db,
    token: context.token,
    now: input.now ?? Date.now(),
    run: (tx) => input.run(tx),
  })
}

export function withCurrentTaskExecutionMutation<T>(input: {
  db: DbClient
  now?: number
  run: (tx: DbTxSync | DbClient) => T
}): T {
  const context = currentTaskExecutionContext()
  if (context === undefined) return input.run(input.db)
  return withTaskExecutionMutation({
    ...input,
    taskId: context.token.taskId,
    context,
  })
}

/**
 * Transactional companion for a multi-row business mutation.  A worker gets
 * the ownership CAS and all projection writes in one SQLite transaction;
 * control/repair callers without an execution context retain their existing
 * ordinary transaction semantics.
 */
export function withTaskExecutionTransaction<T>(input: {
  db: DbClient
  taskId: string
  context?: TaskExecutionContext
  now?: number
  run: (tx: DbTxSync) => T
}): T {
  const context = input.context ?? currentTaskExecutionContext(input.taskId)
  if (context === undefined) {
    return dbTxSync(input.db, (tx) => input.run(tx) as NotPromise<T>)
  }
  assertTaskExecutionContext(context, input.taskId)
  return taskExecutionModule.ownership.withOwnedTaskTx({
    db: input.db,
    token: context.token,
    now: input.now ?? Date.now(),
    run: (tx) => input.run(tx) as NotPromise<T>,
  })
}

export function withCurrentTaskExecutionTransaction<T>(input: {
  db: DbClient
  now?: number
  run: (tx: DbTxSync) => T
}): T {
  const context = currentTaskExecutionContext()
  if (context === undefined) {
    return dbTxSync(input.db, (tx) => input.run(tx) as NotPromise<T>)
  }
  return withTaskExecutionTransaction({
    ...input,
    taskId: context.token.taskId,
    context,
  })
}
