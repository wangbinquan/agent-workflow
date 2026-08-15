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
  readonly transaction: LiveDbTxSync
  readonly lifetime: TransactionLifetime
}

export type LiveDbTxSync = DbTxSync & {
  /** Nested transactions would receive an unguarded Drizzle handle. */
  readonly transaction: never
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
  body: (transaction: LiveDbTxSync) => NotPromise<T>,
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
function createLiveTransactionView(
  transaction: DbTxSync,
  lifetime: TransactionLifetime,
): LiveDbTxSync {
  const views = new WeakMap<object, object>()

  function wrapCallbackArgument(argument: unknown): unknown {
    if (typeof argument !== 'function') return argument
    return function guardedCallback(this: unknown, ...args: unknown[]): unknown {
      assertLive(lifetime)
      return Reflect.apply(argument, wrap(this), args.map(wrap))
    }
  }

  function wrap(value: unknown): unknown {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return value
    }
    const target = value as object
    const cached = views.get(target)
    if (cached !== undefined) return cached

    // The proxy wraps an empty facade rather than the Drizzle object itself.
    // Reflection therefore cannot recover raw own-property values such as
    // `session`, while normal method calls are forwarded to the real target.
    const facade: object =
      typeof value === 'function'
        ? function guardedCallable(this: unknown, ...args: unknown[]): unknown {
            assertLive(lifetime)
            return wrap(Reflect.apply(value, wrap(this), args.map(wrapCallbackArgument)))
          }
        : Object.create(null)
    const view = new Proxy(facade, {
      get(_facade, property) {
        assertLive(lifetime)
        const member: unknown = Reflect.get(target, property, target)
        if (typeof member === 'function') {
          if (property === 'transaction') {
            throw new Error(
              'nested SQLite transactions are not available in a live transaction scope',
            )
          }
          if (
            property === 'then' ||
            property === 'catch' ||
            property === 'finally' ||
            property === 'execute'
          ) {
            throw new Error('asynchronous SQLite query execution is not available in a live scope')
          }
          return (...args: unknown[]) => {
            assertLive(lifetime)
            return wrap(Reflect.apply(member, target, args.map(wrapCallbackArgument)))
          }
        }
        return wrap(member)
      },
      has(_facade, property) {
        assertLive(lifetime)
        return Reflect.has(target, property)
      },
      getOwnPropertyDescriptor(current, property) {
        assertLive(lifetime)
        return Reflect.getOwnPropertyDescriptor(current, property)
      },
      ownKeys(current) {
        assertLive(lifetime)
        return Reflect.ownKeys(current)
      },
      getPrototypeOf(current) {
        assertLive(lifetime)
        return Reflect.getPrototypeOf(current)
      },
      isExtensible(current) {
        assertLive(lifetime)
        return Reflect.isExtensible(current)
      },
      set() {
        assertLive(lifetime)
        throw new Error('live SQLite transaction views are immutable')
      },
      defineProperty() {
        assertLive(lifetime)
        throw new Error('live SQLite transaction views are immutable')
      },
      deleteProperty() {
        assertLive(lifetime)
        throw new Error('live SQLite transaction views are immutable')
      },
      setPrototypeOf() {
        assertLive(lifetime)
        throw new Error('live SQLite transaction views are immutable')
      },
      preventExtensions() {
        assertLive(lifetime)
        throw new Error('live SQLite transaction views are immutable')
      },
    })
    views.set(target, view)
    return view
  }

  return wrap(transaction) as LiveDbTxSync
}
