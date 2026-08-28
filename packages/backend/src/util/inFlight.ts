/**
 * Coalesce only overlapping work for the same key.
 *
 * Unlike a TTL/result cache, the settled value is never retained: a request
 * that starts after completion always re-runs the loader and therefore sees
 * the latest durable state. The one-turn admission yield lets a network burst
 * register its waiters before a bun:sqlite loader starts blocking the event
 * loop.
 */
export interface InFlightCoalescer<Key, Value> {
  (key: Key, load: () => Promise<Value>): Promise<Value>
}

export function createInFlightCoalescer<Key, Value>(): InFlightCoalescer<Key, Value> {
  const pending = new Map<Key, Promise<Value>>()
  return (key, load) => {
    const existing = pending.get(key)
    if (existing !== undefined) return existing

    const created = new Promise<void>((resolve) => setImmediate(resolve)).then(load)
    pending.set(key, created)
    const cleanup = (): void => {
      if (pending.get(key) === created) pending.delete(key)
    }
    // Supplying both handlers makes the cleanup branch itself always fulfill;
    // callers still receive the original promise and its original rejection.
    void created.then(cleanup, cleanup)
    return created
  }
}
