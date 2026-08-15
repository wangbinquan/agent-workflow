// RFC-294 bridge for an already-open dbTxSync callback. This is deliberately
// platform-owned: module public contracts never expose Drizzle's transaction
// handle, and a scope cannot be reused after its synchronous callback exits.

import { ulid } from 'ulid'
import type { DbTxSync, NotPromise } from '@/db/txSync'
import type { TransactionScope } from '../transactionScope'

interface TransactionLifetime {
  open: boolean
}

interface SQLiteTransactionClaim {
  readonly transaction: DbTxSync
  readonly lifetime: TransactionLifetime
}

const claims = new WeakMap<TransactionScope, SQLiteTransactionClaim>()

export function withExistingSQLiteTransactionScope<T extends undefined>(
  transaction: DbTxSync,
  body: (scope: TransactionScope) => NotPromise<T>,
): void {
  const scope = Object.freeze({ transactionId: ulid() }) as TransactionScope
  const lifetime: TransactionLifetime = { open: true }
  const claim: SQLiteTransactionClaim = {
    transaction: createLiveTransactionView(transaction, lifetime),
    lifetime,
  }
  claims.set(scope, claim)
  try {
    const result: unknown = body(scope)
    if (result !== undefined) throw new Error('transaction scope callback must not return a value')
  } finally {
    lifetime.open = false
  }
}

export function withSQLiteTransaction<T extends undefined>(
  scope: TransactionScope,
  body: (transaction: DbTxSync) => NotPromise<T>,
): void {
  const claim = claims.get(scope)
  if (claim === undefined) throw new Error('transaction scope is not live')
  assertLive(claim.lifetime)
  const result: unknown = body(claim.transaction)
  if (result !== undefined) {
    throw new Error('SQLite transaction callback must not return a value')
  }
}

function assertLive(lifetime: TransactionLifetime): void {
  if (!lifetime.open) throw new Error('transaction scope is not live')
}

/**
 * Drizzle returns executable query builders from transaction methods. Guard
 * the whole object graph, not only the root handle, so neither a transaction
 * nor a prepared builder captured by adapter code remains usable after the
 * outer callback exits.
 */
function createLiveTransactionView(transaction: DbTxSync, lifetime: TransactionLifetime): DbTxSync {
  const views = new WeakMap<object, object>()
  const wrap = (value: unknown): unknown => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return value
    }
    const target = value as object
    const cached = views.get(target)
    if (cached !== undefined) return cached
    const view = new Proxy(target, {
      get(current, property) {
        assertLive(lifetime)
        const member: unknown = Reflect.get(current, property, current)
        if (typeof member === 'function') {
          return (...args: unknown[]) => {
            assertLive(lifetime)
            return wrap(Reflect.apply(member, current, args))
          }
        }
        return wrap(member)
      },
      set(current, property, next) {
        assertLive(lifetime)
        return Reflect.set(current, property, next, current)
      },
    })
    views.set(target, view)
    return view
  }
  return wrap(transaction) as DbTxSync
}
