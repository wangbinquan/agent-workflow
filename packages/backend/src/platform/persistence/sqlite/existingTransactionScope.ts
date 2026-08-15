// RFC-294 bridge for an already-open dbTxSync callback. This is deliberately
// platform-owned: module public contracts never expose Drizzle's transaction
// handle, and a scope cannot be reused after its synchronous callback exits.

import { ulid } from 'ulid'
import type { DbTxSync, NotPromise } from '@/db/txSync'
import type { TransactionScope } from '../transactionScope'

interface SQLiteTransactionClaim {
  readonly transaction: DbTxSync
  open: boolean
}

const claims = new WeakMap<TransactionScope, SQLiteTransactionClaim>()

export function withExistingSQLiteTransactionScope<T>(
  transaction: DbTxSync,
  body: (scope: TransactionScope) => NotPromise<T>,
): T {
  const scope = Object.freeze({ transactionId: ulid() }) as TransactionScope
  const claim: SQLiteTransactionClaim = { transaction, open: true }
  claims.set(scope, claim)
  try {
    const result: unknown = body(scope)
    if (
      result instanceof Promise ||
      (result !== null &&
        typeof result === 'object' &&
        typeof (result as { then?: unknown }).then === 'function')
    ) {
      throw new Error('transaction scope callback must be synchronous')
    }
    return result as T
  } finally {
    claim.open = false
  }
}

export function requireSQLiteTransaction(scope: TransactionScope): DbTxSync {
  const claim = claims.get(scope)
  if (claim === undefined || !claim.open) {
    throw new Error('transaction scope is not live')
  }
  return claim.transaction
}
