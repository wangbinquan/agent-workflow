// RFC-243 T5 — terminal-state observation seam (design §1.4). A multicast,
// in-process registry resolved by the committed task-lifecycle consumer for
// ALL FOUR task terminal statuses (done/failed/canceled/interrupted).
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
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import type { TaskStatusProjectionReadModel } from '../public/types'
import { createTaskExecutionReadModels } from './taskExecutionReadModels'
import { startInterval } from '@/platform/background/intervalTimer'

export type TerminalWatchResult =
  | { kind: 'terminal'; status: TaskStatus }
  | { kind: 'missing' }
  | { kind: 'aborted' }

type Resolver = (r: TerminalWatchResult) => void

type LegacySqliteTaskStatusSource = Parameters<typeof createTaskExecutionReadModels>[0]

function statusReader(
  source: TaskStatusProjectionReadModel | LegacySqliteTaskStatusSource,
): TaskStatusProjectionReadModel {
  return 'find' in source ? source : createTaskExecutionReadModels(source).statusProjection
}

async function readTerminal(
  reader: TaskStatusProjectionReadModel,
  taskId: string,
): Promise<TerminalWatchResult | null> {
  const row = await reader.find(taskId)
  if (row === null) return { kind: 'missing' }
  const status = row.status
  return isTerminalTaskStatus(status) ? { kind: 'terminal', status } : null
}

/**
 * RFC-535: one terminal watch per daemon session (built next to its child-task budget). The child-call nodes and the
 * action executions wait on it; the session's committed task-lifecycle consumer notifies it. There is no process-level
 * registry — two sessions never wake each other's waiters.
 */
export interface TaskTerminalWatch {
  /**
   * Durable-consumer emission point. Never throws and never blocks the already
   * committed status write.
   */
  notify(taskId: string, to: TaskStatus): void
  /**
   * Resolve when `taskId` reaches any terminal status (or is deleted / the
   * caller aborts). Safe to call for already-terminal tasks — resolves on the
   * immediate read without registering anything.
   */
  watch(
    source: TaskStatusProjectionReadModel | LegacySqliteTaskStatusSource,
    taskId: string,
    opts?: { signal?: AbortSignal; pollMs?: number },
  ): Promise<TerminalWatchResult>
}

export function createTaskTerminalWatch(): TaskTerminalWatch {
  const watchers = new Map<string, Set<Resolver>>()
  return Object.freeze<TaskTerminalWatch>({
    notify(taskId, to) {
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
    },
    async watch(source, taskId, opts = {}) {
      const pollMs = opts.pollMs ?? 20_000
      const reader = statusReader(source)
      const immediate = await readTerminal(reader, taskId)
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
        const timer = startInterval({
          owner: 'task-execution.execution-watch',
          everyMs: pollMs,
          tick: () => {
            void readTerminal(reader, taskId)
              .then((r) => {
                if (r !== null) finish(r)
              })
              .catch(() => {
                // transient read failure — next poll retries
              })
          },
        })
        const onAbort = (): void => finish({ kind: 'aborted' })
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        cleanup = () => {
          timer.stop()
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
        void readTerminal(reader, taskId)
          .then((r) => {
            if (r !== null) finish(r)
          })
          .catch(() => {})
      })
    },
  })
}
