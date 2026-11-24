import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createAuthorizedIntentPersistence,
  createIntentPersistence,
} from '../infrastructure/intentPersistence'
import type { IntentAgentQueriesFactory } from '../infrastructure/intentSqlPersistence'
import type { IntentContextResourceAuthorizationFactoryDependency } from '../infrastructure/intentSqlProgramRunner'

export { createIntentPersistence }

/**
 * RFC-359 W7 —— 生产装配，两个 provider 共用一条：上下文变更不可能漏掉 RC 绑定，
 * 授权会话与 Intent 程序跑在**同一笔**中立事务里。
 */
export function composeIntentPersistence(input: {
  readonly db: PersistenceDb
  readonly contextAuthorization: IntentContextResourceAuthorizationFactoryDependency
  /** RFC-568: Resource Catalog's agent read factory (agent port names), handed over by bootstrap. */
  readonly createAgentExecutionQueries: IntentAgentQueriesFactory
}) {
  return createAuthorizedIntentPersistence(input)
}

export type { IntentPersistence } from '../application/ports/intentPersistence'
