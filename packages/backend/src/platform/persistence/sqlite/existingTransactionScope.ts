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

  function assertCallablePropertyAvailable(property: PropertyKey): void {
    if (property === 'transaction') {
      throw new Error('nested SQLite transactions are not available in a live transaction scope')
    }
    if (
      property === 'then' ||
      property === 'catch' ||
      property === 'finally' ||
      property === 'execute'
    ) {
      throw new Error('asynchronous SQLite query execution is not available in a live scope')
    }
  }

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

    // The proxy wraps a safe facade rather than the Drizzle object itself.
    // Reflection can therefore preserve ordinary JS shape without recovering
    // raw own-property values such as `session`.
    const facade: object =
      typeof value === 'function'
        ? function guardedCallable(this: unknown, ...args: unknown[]): unknown {
            assertLive(lifetime)
            return wrap(Reflect.apply(value, wrap(this), args.map(wrapCallbackArgument)))
          }
        : Array.isArray(value)
          ? new Array(value.length)
          : Object.create(null)
    const view = new Proxy(facade, {
      get(_facade, property) {
        assertLive(lifetime)
        const member: unknown = Reflect.get(target, property, target)
        if (typeof member === 'function') {
          // Drizzle's entity discriminator walks `value.constructor`; retain
          // that identity as another guarded value instead of binding it as a
          // method of the prototype object.
          if (property === 'constructor') return wrap(member)
          assertCallablePropertyAvailable(property)
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
        const facadeDescriptor = Reflect.getOwnPropertyDescriptor(current, property)
        // Proxy invariants require exact descriptors for the facade's own
        // non-configurable keys (`length` on arrays, for example).
        if (facadeDescriptor?.configurable === false) return facadeDescriptor

        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
        if (descriptor === undefined) return facadeDescriptor
        if ('value' in descriptor) {
          const member = Reflect.get(target, property, target) as unknown
          if (typeof member === 'function') assertCallablePropertyAvailable(property)
          return {
            configurable: true,
            enumerable: descriptor.enumerable,
            writable: false,
            value: wrap(member),
          }
        }
        return {
          configurable: true,
          enumerable: descriptor.enumerable,
          get:
            descriptor.get === undefined
              ? undefined
              : () => {
                  assertLive(lifetime)
                  const member = Reflect.get(target, property, target) as unknown
                  if (typeof member === 'function') assertCallablePropertyAvailable(property)
                  return wrap(member)
                },
          set: undefined,
        }
      },
      ownKeys(current) {
        assertLive(lifetime)
        return [...new Set([...Reflect.ownKeys(current), ...Reflect.ownKeys(target)])]
      },
      getPrototypeOf() {
        assertLive(lifetime)
        return wrap(Reflect.getPrototypeOf(target)) as object | null
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
    views.set(view, view)
    return view
  }

  return wrap(transaction) as LiveDbTxSync
}
