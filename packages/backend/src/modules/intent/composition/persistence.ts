import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createAuthorizedIntentPersistence,
  createIntentPersistence,
} from '../infrastructure/intentPersistence'
import type { IntentContextResourceAuthorizationFactoryDependency } from '../infrastructure/intentSqlProgramRunner'

export { createIntentPersistence }

/**
 * RFC-359 W7 —— 生产装配，两个 provider 共用一条：上下文变更不可能漏掉 RC 绑定，
 * 授权会话与 Intent 程序跑在**同一笔**中立事务里。
 */
export function composeIntentPersistence(input: {
  readonly db: ProviderNeutralDatabase
  readonly contextAuthorization: IntentContextResourceAuthorizationFactoryDependency
}) {
  return createAuthorizedIntentPersistence(input)
}

export type { IntentPersistence } from '../application/ports/intentPersistence'
