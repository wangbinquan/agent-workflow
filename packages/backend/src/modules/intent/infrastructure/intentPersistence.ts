// RFC-359 W7 —— Intent 持久化的装配入口：一份实现，两个 provider。
//
// 合掉的是 `sqliteIntentPersistence.ts` / `postgresqlIntentPersistence.ts`（各 21 行）。两份逐行对位，
// 只有 db 的类型与两个 runner 的类名不同——**它们存在的唯一理由就是引用各自 provider 的 runner 类名**。
// runner 合一（`intentSqlProgramRunner.ts`）之后这对自动消失：实现体本来就是共享的
// `IntentSqlPersistence`（`intentSqlPersistence.ts`，provider-无关的 Intent 表协议）。

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { IntentPersistence } from '../application/ports/intentPersistence'
import { IntentSqlPersistence, type IntentAgentQueriesFactory } from './intentSqlPersistence'
import {
  AuthorizedIntentSqlProgramRunner,
  PlainIntentSqlProgramRunner,
  type IntentContextResourceAuthorizationFactoryDependency,
} from './intentSqlProgramRunner'

/** RFC-568: both constructions take Resource Catalog's agent read factory (bootstrap hands it over). */
export function createIntentPersistence(
  db: PersistenceDb,
  createAgentExecutionQueries: IntentAgentQueriesFactory,
): IntentPersistence {
  return new IntentSqlPersistence(new PlainIntentSqlProgramRunner(db), createAgentExecutionQueries)
}

export function createAuthorizedIntentPersistence(input: {
  readonly db: PersistenceDb
  readonly contextAuthorization: IntentContextResourceAuthorizationFactoryDependency
  readonly createAgentExecutionQueries: IntentAgentQueriesFactory
}): IntentPersistence {
  return new IntentSqlPersistence(
    new AuthorizedIntentSqlProgramRunner(input.db, input.contextAuthorization),
    input.createAgentExecutionQueries,
  )
}
