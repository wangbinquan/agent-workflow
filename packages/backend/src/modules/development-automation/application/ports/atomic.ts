/**
 * Provider-neutral guard for pure decision callbacks used by SQLite adapters.
 * Provider adapters own the transaction; application callbacks cannot await
 * or perform external I/O inside that boundary.
 */
export type AtomicDecision<T> = T extends PromiseLike<unknown> ? never : T
