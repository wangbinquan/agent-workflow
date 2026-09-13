import type { ProviderNeutralDatabase } from '@/db/query'
import {
  assertTaskExecutionContext,
  createTaskExecutionContext as createProviderTaskExecutionContext,
  currentTaskExecutionContext as currentProviderTaskExecutionContext,
  runWithTaskExecutionContext,
  type TaskExecutionContext,
} from '../application/taskExecutionContext'
import type { OwnershipToken } from '../domain/ownership'
import { createTaskExecutionPersistence } from './taskExecutionPersistence'

/**
 * RFC-359 AC-6：`db` 放宽到中立客户端。这份「兼容上下文」本来就只是把 db 原样别在
 * `legacyConnection` / `compatibility` 上给旧调用方取用，持久化那一格也换成了按 provider
 * 分派的中立工厂 `createTaskExecutionPersistence`，函数体零方言。名字里的 Sqlite 暂留——
 * 它是 `rfc349-provider-cutover` 账本里那条边的键，改名要连账本一起动。
 */
export interface SqliteTaskExecutionContext extends TaskExecutionContext {
  readonly db: ProviderNeutralDatabase
}

export function createTaskExecutionContext(input: {
  readonly intentId: string
  readonly token: OwnershipToken
  readonly db: ProviderNeutralDatabase
}): SqliteTaskExecutionContext {
  const context = createProviderTaskExecutionContext({
    intentId: input.intentId,
    token: input.token,
    persistence: createTaskExecutionPersistence(input.db),
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
