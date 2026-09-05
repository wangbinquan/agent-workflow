import type { DbTxSync } from '@/db/txSync'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import {
  createIntentContextResourceAuthorizationSession,
  createIntentContextResourceAuthorizationSyncSession,
  type IntentContextResourceAuthorizationSyncSession,
} from '../application/participants/intentContextResourceAuthorization'
import type {
  IntentContextResourceAuthorizationSession,
  ResourceRequestContext,
} from '../public/participants'
import {
  createIntentContextResourceAuthorizationReadPort,
  createIntentContextResourceAuthorizationSyncReadPort,
} from '../infrastructure/intentContextResourceAuthorization'
import type { ResourceCatalogTransaction } from '../infrastructure/resourceCatalogTransaction'

export interface IntentContextResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: DirectAuthenticatedAuthority
}

/** Provider-private SQLite seam for a synchronous dbTxSync owner. */
export interface SqliteIntentContextResourceAuthorizationSyncFactory {
  inTransaction(
    transaction: DbTxSync,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSyncSession
}

export interface IntentContextResourceAuthorizationFactory {
  inTransaction(
    transaction: ResourceCatalogTransaction,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSession
}

function currentAuthorityResolver(pair: IntentContextResourceAuthorityPair) {
  return Object.freeze({
    resolve(authority: ResourceRequestContext): DirectAuthenticatedAuthority {
      if (authority !== pair.authority) {
        throw new Error('foreign-intent-context-resource-authority')
      }
      return pair.actor
    },
  })
}

/** SQLite-only composition seam that never returns a Promise inside dbTxSync. */
export function composeSqliteIntentContextResourceAuthorizationSyncFactory(): SqliteIntentContextResourceAuthorizationSyncFactory {
  return Object.freeze({
    inTransaction(transaction: DbTxSync, pair: IntentContextResourceAuthorityPair) {
      return createIntentContextResourceAuthorizationSyncSession(
        currentAuthorityResolver(pair),
        createIntentContextResourceAuthorizationSyncReadPort(transaction),
      )
    },
  })
}

/**
 * RFC-359 W4-D20 —— 异步装配一份，两个 provider 共用：外部 Intent 宿主交进自己的事务。
 * SQLite 的同步装配（下面那个）仍在，因为 Intent 宿主在 SQLite 上还跑在 `dbTxSync` 回调里。
 */
export function composeIntentContextResourceAuthorizationFactory(): IntentContextResourceAuthorizationFactory {
  return Object.freeze({
    inTransaction(
      transaction: ResourceCatalogTransaction,
      pair: IntentContextResourceAuthorityPair,
    ) {
      return createIntentContextResourceAuthorizationSession(
        currentAuthorityResolver(pair),
        createIntentContextResourceAuthorizationReadPort(transaction),
      )
    },
  })
}
