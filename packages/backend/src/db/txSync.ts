// RFC-093 — dbTxSync: the ONLY sanctioned way to get transactional atomicity
// in this codebase (audit S-10, design/RFC-093-db-tx-sync/design.md).
//
// Why this exists: bun:sqlite's Database.transaction is a SYNCHRONOUS wrapper.
// An async callback hands a pending promise back at its first await, the
// wrapper sees the callback "return" and COMMITs immediately — every statement
// after that await runs in autocommit, and a later throw rolls back nothing.
// `db.transaction(async (tx) => …)` therefore LOOKS safe and provides zero
// atomicity (verified in scheduler-audit-s10-async-transaction-decorative
// .test.ts; the RFC-052 approve half-commit incident recorded in
// lifecycleRepair/options-R2.ts was exactly this class).
//
// dbTxSync enforces a synchronous body twice over:
//   - type level: a Promise-returning callback makes the NotPromise<T> return
//     type collapse to `never` → compile error;
//   - runtime: a smuggled thenable throws INSIDE the transaction, so drizzle
//     ROLLBACKs — failing loud instead of half-committing.
//
// Inside the callback use drizzle's synchronous execution surface:
// `tx.select(…).all()` / `.get()`, `tx.update(…).run()`, `tx.insert(…).run()`,
// `tx.delete(…).run()`. Never `await`.

import { observeDbTransaction, type DbClient } from './client'

/** The drizzle bun-sqlite transaction handle (sync execution surface). */
export type DbTxSync = Parameters<Parameters<DbClient['transaction']>[0]>[0]

/** Collapses Promise-returning callbacks to `never` at the type level. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T

export function dbTxSync<T>(db: DbClient, fn: (tx: DbTxSync) => NotPromise<T>): T {
  const startedAt = performance.now()
  try {
    return db.transaction(
      (tx) => {
        const result: unknown = fn(tx)
        if (
          result instanceof Promise ||
          (result !== null &&
            typeof result === 'object' &&
            typeof (result as { then?: unknown }).then === 'function')
        ) {
          // Fail LOUD inside the transaction: this throw makes drizzle ROLLBACK,
          // so a runtime-smuggled async callback can never half-committing.
          throw new Error(
            'dbTxSync callback returned a Promise — async bodies COMMIT at their first await under bun:sqlite (audit S-10). Use the synchronous drizzle surface (.all()/.run()/.get()) inside dbTxSync.',
          )
        }
        return result as T
      },
      // RFC-338 AC-2: every sanctioned write transaction reserves the writer
      // before taking a read snapshot. A deferred read-then-write transaction
      // can otherwise fail its upgrade immediately with SQLITE_BUSY_SNAPSHOT,
      // bypassing busy_timeout while a short maintenance commit is in flight.
      // BEGIN IMMEDIATE waits at the boundary, where the request connection's
      // busy timeout works and the Worker can finish its bounded transaction.
      { behavior: 'immediate' },
    )
  } finally {
    observeDbTransaction(db, performance.now() - startedAt)
  }
}
