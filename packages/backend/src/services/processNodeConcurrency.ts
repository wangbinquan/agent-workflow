// Daemon-wide agent-node concurrency budget.
//
// One DbClient belongs to one daemon. Keying by that object gives every task in
// the daemon the same limiter while WeakMap keeps isolated test/embedded DBs
// independent and collectible. Re-reading a changed setting resizes the same
// object so active and newly launched tasks never split into separate budgets.

import { Semaphore } from '@/util/semaphore'

const limiters = new WeakMap<object, Semaphore>()

export function getProcessNodeSemaphore(daemonScope: object, capacity: number): Semaphore {
  const existing = limiters.get(daemonScope)
  if (existing !== undefined) {
    if (existing.capacity !== capacity) existing.resize(capacity)
    return existing
  }
  const created = new Semaphore(capacity)
  limiters.set(daemonScope, created)
  return created
}
