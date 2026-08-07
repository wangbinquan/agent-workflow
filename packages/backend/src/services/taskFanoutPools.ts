// RFC-266 — the per-task FAN-OUT SUB-POOL registry.
//
// `config.multiProcessSubprocessConcurrency` caps how many shards of one task's
// fan-out run at once, INSIDE the daemon-wide agent pool (a shard takes an
// agent-pool slot first, then one of these). Before RFC-266 the semaphore was a
// per-runTask local `new Semaphore(...)` that nothing outside the scheduler
// could reach, so a settings change could not apply to a task already running —
// and, because the value was never threaded off the config at all, every
// fan-out silently ran at the hard-coded default of 4.
//
// The registry gives PUT /api/config a handle on every live task's pool so a
// saved value takes effect immediately (resizeAllTaskFanoutSems), matching the
// daemon-wide pools in processNodeConcurrency.ts.
//
// Why a plain Map (not the WeakMap<DbClient> the daemon pools use): the key is
// a task id string, and hot-apply must ENUMERATE every entry — a WeakMap can do
// neither. Entries are bounded by gcTaskFanoutSem below.
//
// LIFECYCLE (inherited verbatim from taskWriteLocks.ts, which paid for this
// rule): `gcTaskFanoutSem` may be called ONLY from runTask's finally. Deleting
// from an HTTP path would race the scheduler's cached reference
// (SchedulerState holds the instance for the whole run): delete + recreate
// while the scheduler still holds the old instance silently splits one pool
// into two, so a task would run at double its configured shard concurrency. A
// task that dies without reaching the finally leaks at most one idle Semaphore
// object, which the next run of the same task id reuses — accepted, documented,
// and self-healing.

import { Semaphore } from '@/util/semaphore'

const pools = new Map<string, Semaphore>()

/**
 * The one fan-out sub-pool for a task. get-or-create + resize-on-read (a
 * relaunch/resume re-reads the current config value), never replaced while
 * anyone may hold a reference — see the module doc.
 */
export function getTaskFanoutSem(taskId: string, capacity: number): Semaphore {
  const existing = pools.get(taskId)
  if (existing !== undefined) {
    if (existing.capacity !== capacity) existing.resize(capacity)
    return existing
  }
  const created = new Semaphore(capacity)
  pools.set(taskId, created)
  return created
}

/**
 * RFC-266 hot-apply: push a newly saved capacity into every RUNNING task's
 * pool. Growing drains each FIFO immediately; shrinking never preempts an
 * in-flight shard.
 */
export function resizeAllTaskFanoutSems(capacity: number): void {
  for (const sem of pools.values()) {
    if (sem.capacity !== capacity) sem.resize(capacity)
  }
}

/**
 * Drop the registry entry when idle. ONLY runTask's finally may call this (see
 * module doc). If anything still holds or queues on the pool at that moment the
 * entry survives and is reused by the next get-or-create — self-healing, never
 * split-brain.
 */
export function gcTaskFanoutSem(taskId: string): void {
  const sem = pools.get(taskId)
  if (sem !== undefined && sem.available === sem.capacity && sem.queueLength === 0) {
    pools.delete(taskId)
  }
}

/** Test-only visibility. */
export function taskFanoutPoolCount(): number {
  return pools.size
}
