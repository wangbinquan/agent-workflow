// RFC-294 bridge for an already-open dbTxSync callback. This is deliberately
// platform-owned: module public contracts never expose Drizzle's transaction
// handle, and a scope cannot be reused after its synchronous callback exits.

import { ulid } from 'ulid'
import type { DbTxSync } from '@/db/txSync'
import type { TransactionScope } from '../transactionScope'

interface SQLiteTransactionClaim {
  readonly transaction: DbTxSync
  open: boolean
}

const claims = new WeakMap<TransactionScope, SQLiteTransactionClaim>()

export function withExistingSQLiteTransactionScope(
  transaction: DbTxSync,
  body: (scope: TransactionScope) => void,
): void {
  const scope = Object.freeze({ transactionId: ulid() }) as TransactionScope
  const claim: SQLiteTransactionClaim = { transaction, open: true }
  claims.set(scope, claim)
  try {
    const result: unknown = body(scope)
    if (result !== undefined) throw new Error('transaction scope callback must not return a value')
  } finally {
    claim.open = false
  }
}

export function withSQLiteTransaction(
  scope: TransactionScope,
  body: (transaction: DbTxSync) => void,
): void {
  const claim = claims.get(scope)
  if (claim === undefined || !claim.open) {
    throw new Error('transaction scope is not live')
  }
  const result: unknown = body(claim.transaction)
  if (result !== undefined) {
    throw new Error('SQLite transaction callback must not return a value')
  }
}
