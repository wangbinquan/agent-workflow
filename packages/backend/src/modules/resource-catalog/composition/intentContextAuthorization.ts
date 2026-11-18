import {
  createIntentContextCurrentAuthorityResolver,
  createIntentContextResourceAuthorizationSession,
  type IntentContextResourceAuthorityPair,
} from '../application/participants/intentContextResourceAuthorization'
import type { IntentContextResourceAuthorizationSession } from '../public/participants'
import { createIntentContextResourceAuthorizationReadPort } from '../infrastructure/intentContextResourceAuthorization'
import type { ResourceCatalogTransaction } from '../infrastructure/resourceCatalogTransaction'

export interface IntentContextResourceAuthorizationFactory {
  inTransaction(
    transaction: ResourceCatalogTransaction,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSession
}

/**
 * RFC-359 W4-D20 —— 异步装配一份，两个 provider 共用：外部 Intent 宿主交进自己的事务。
 *
 * RFC-359 W8：SQLite 曾有一份同步孪生（`composeSqliteIntentContextResourceAuthorizationSyncFactory`
 * → `createIntentContextResourceAuthorizationSyncSession` → `createIntentContextResourceAuthorizationSyncReadPort`），
 * 供还跑在 `dbTxSync` 回调里的 Intent 宿主用。W7 合掉 IntentSqlProgramRunner 后两个 SQLite
 * bootstrap（`server.ts` / `cli/start.ts`）都改指本工厂，那条同步链自己写下的退役条件成立，整条已删。
 *
 * RFC-504：逐次核对授权上下文的解析器迁入 application（`createIntentContextCurrentAuthorityResolver`），这里只接线。
 */
export function composeIntentContextResourceAuthorizationFactory(): IntentContextResourceAuthorizationFactory {
  return Object.freeze({
    inTransaction(
      transaction: ResourceCatalogTransaction,
      pair: IntentContextResourceAuthorityPair,
    ) {
      return createIntentContextResourceAuthorizationSession(
        createIntentContextCurrentAuthorityResolver(pair),
        createIntentContextResourceAuthorizationReadPort(transaction),
      )
    },
  })
}
