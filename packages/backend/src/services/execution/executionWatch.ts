// RFC-243 T5 — terminal-state observation seam (design §1.4). A multicast,
// in-process registry resolved from the lifecycle write path for ALL FOUR task
// terminal statuses (done/failed/canceled/interrupted) — deliberately separate
// from `registerTerminalTaskHook` (single-slot, done|canceled-only, RFC-202
// sweep semantics), which stays untouched.
//
// Consumers get three defenses against missed signals:
//   1. register-then-read: an immediate DB read BEFORE and AFTER registration
//      closes the "went terminal while we were subscribing" window;
//   2. poll fallback (default 20s) covers crash/restart windows and any writer
//      that bypasses the in-process notifier;
//   3. a deleted row resolves as `missing` (never hangs) — RFC-243 §4.2 maps
//      that to `child-deleted` on the consuming side.
//
// Module discipline: this file must import NOTHING from task/scheduler/
// lifecycle services (lifecycle.ts imports US for the emission) — db schema and
// shared only.
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'

export type TerminalWatchResult =
  | { kind: 'terminal'; status: TaskStatus }
  | { kind: 'missing' }
  | { kind: 'aborted' }

type Resolver = (r: TerminalWatchResult) => void

const watchers = new Map<string, Set<Resolver>>()

/**
 * Post-commit emission point — called by `setTaskStatus` after a terminal CAS
 * write lands. Never throws; never blocks the committed status write.
 */
export function notifyTaskTerminal(taskId: string, to: TaskStatus): void {
  if (!isTerminalTaskStatus(to)) return
  const set = watchers.get(taskId)
  if (set === undefined) return
  watchers.delete(taskId)
  for (const resolve of [...set]) {
    try {
      resolve({ kind: 'terminal', status: to })
    } catch {
      // resolver failures are the consumer's problem, not the writer's
    }
  }
}

/** Test-only: drop all registrations (fresh-module semantics without re-import). */
export function resetTaskTerminalWatchersForTests(): void {
  watchers.clear()
}

async function readTerminal(db: DbClient, taskId: string): Promise<TerminalWatchResult | null> {
  const rows = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return { kind: 'missing' }
  const status = row.status as TaskStatus
  return isTerminalTaskStatus(status) ? { kind: 'terminal', status } : null
}

/**
 * Resolve when `taskId` reaches any terminal status (or is deleted / the
 * caller aborts). Safe to call for already-terminal tasks — resolves on the
 * immediate read without registering anything.
 */
export async function watchTaskTerminal(
  db: DbClient,
  taskId: string,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<TerminalWatchResult> {
  const pollMs = opts.pollMs ?? 20_000
  const immediate = await readTerminal(db, taskId)
  if (immediate !== null) return immediate
  if (opts.signal?.aborted === true) return { kind: 'aborted' }

  return await new Promise<TerminalWatchResult>((resolve) => {
    let settled = false
    let cleanup = () => {}
    const finish = (r: TerminalWatchResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(r)
    }
    const entry: Resolver = finish
    let set = watchers.get(taskId)
    if (set === undefined) {
      set = new Set()
      watchers.set(taskId, set)
    }
    set.add(entry)
    const timer = setInterval(() => {
      void readTerminal(db, taskId)
        .then((r) => {
          if (r !== null) finish(r)
        })
        .catch(() => {
          // transient read failure — next poll retries
        })
    }, pollMs)
    const onAbort = (): void => finish({ kind: 'aborted' })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    cleanup = () => {
      clearInterval(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const s = watchers.get(taskId)
      if (s !== undefined) {
        s.delete(entry)
        if (s.size === 0) watchers.delete(taskId)
      }
    }
    // Second read AFTER registration: a transition that committed between the
    // first read and `set.add(entry)` fired its notify into an empty set — this
    // read closes that window deterministically instead of waiting for poll.
    void readTerminal(db, taskId)
      .then((r) => {
        if (r !== null) finish(r)
      })
      .catch(() => {})
  })
}
