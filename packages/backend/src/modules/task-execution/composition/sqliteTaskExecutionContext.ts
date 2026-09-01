import type { DbClient } from '@/db/client'
import {
  assertTaskExecutionContext,
  createTaskExecutionContext as createProviderTaskExecutionContext,
  currentTaskExecutionContext as currentProviderTaskExecutionContext,
  runWithTaskExecutionContext,
  type TaskExecutionContext,
} from '../application/taskExecutionContext'
import type { OwnershipToken } from '../domain/ownership'
import { createSqliteTaskExecutionPersistence } from './taskExecutionPersistence'

export interface SqliteTaskExecutionContext extends TaskExecutionContext {
  readonly db: DbClient
}

export function createTaskExecutionContext(input: {
  readonly intentId: string
  readonly token: OwnershipToken
  readonly db: DbClient
}): SqliteTaskExecutionContext {
  const context = createProviderTaskExecutionContext({
    intentId: input.intentId,
    token: input.token,
    persistence: createSqliteTaskExecutionPersistence(input.db),
    legacyConnection: input.db,
    compatibility: { db: input.db },
  })
  return context
}

export function currentTaskExecutionContext(
  expectedTaskId?: string,
): SqliteTaskExecutionContext | undefined {
  const context = currentProviderTaskExecutionContext(expectedTaskId)
  if (context === undefined || context.legacyConnection === undefined) return undefined
  return context as SqliteTaskExecutionContext
}

export { assertTaskExecutionContext, runWithTaskExecutionContext }
