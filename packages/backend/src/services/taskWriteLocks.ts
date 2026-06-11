// RFC-098 B1 (audit S-9 / WP-5) — the per-task WORKTREE WRITE LOCK registry.
//
// Before this module the scheduler's writer serialization lived in a
// per-runTask local `new Semaphore(1)` (SchedulerState.writeSem) that HTTP
// entry points could never reach — submitClarifyAnswers / review iterate /
// cross-clarify answers all ran `rollbackToSnapshot` (reset --hard + clean
// -fd) straight against the worktree while an in-flight writer node might be
// mid-write (S-9: three ready-made backdoors through the "writers serialize"
// guarantee). The registry gives every code path that mutates a task's
// worktree THE SAME lock instance.
//
// Lifecycle (adversarial-review revision #1 — do NOT add other delete paths):
// `gcTaskWriteSem` may be called ONLY from runTask's finally. An HTTP-side gc
// would race the scheduler's cached reference (SchedulerState.writeSem holds
// the instance for the whole run): delete + recreate while the scheduler
// still holds the old instance silently splits the mutex back into two — the
// exact S-9 pathology this module removes. A task that parked, got rolled
// back over HTTP and never resumes leaks at most one idle Semaphore object;
// accepted and documented.

import { Semaphore } from '@/util/semaphore'

const locks = new Map<string, Semaphore>()

/** The one write lock for a task's worktree(s). getOrCreate — never replaced
 *  while anyone may hold a reference (see module doc). */
export function getTaskWriteSem(taskId: string): Semaphore {
  let sem = locks.get(taskId)
  if (sem === undefined) {
    sem = new Semaphore(1)
    locks.set(taskId, sem)
  }
  return sem
}

/**
 * Drop the registry entry when idle. ONLY runTask's finally may call this
 * (adversarial-review revision #1): if an HTTP rollback still holds/queues
 * the lock at that moment the entry survives and is reused by the next
 * getOrCreate — self-healing, never split-brain.
 */
export function gcTaskWriteSem(taskId: string): void {
  const sem = locks.get(taskId)
  if (sem === undefined) return
  if (sem.available === sem.capacity && sem.queueLength === 0) {
    locks.delete(taskId)
  }
}

/** Test-only visibility. */
export function taskWriteLockCount(): number {
  return locks.size
}
