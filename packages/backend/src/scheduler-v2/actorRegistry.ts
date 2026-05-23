// RFC-061 PR-B T9 — taskActor registry.
//
// Daemon-process-wide Map<taskId, ActorState>. The daemon's task launcher
// inserts on launch; the wake-loop deletes on terminal state (task-
// completed / task-failed / task-canceled). Event-applier callbacks +
// runner exit handlers route wake events through this registry.
//
// Single-instance lock comes from the daemon's flock at startup
// (services/daemon.ts); inside the daemon process the Map is sufficient.

import { WakeQueue, type WakeReason } from './wakeQueue'

export interface ActorState {
  taskId: string
  queue: WakeQueue
  abortController: AbortController
  /** True while the actor's main loop is consuming wake events. */
  running: boolean
  /** Last wake event seq processed — debug / metrics. */
  lastProcessedSeq: number
  /** Wall-clock of last processed wake — staleness detector. */
  lastProcessedAt: number
}

class TaskActorRegistry {
  private readonly actors = new Map<string, ActorState>()

  /**
   * Register a new actor for a task. Idempotent: re-registering on the
   * same taskId returns the existing actor unchanged (re-entrant launch
   * during daemon resume must not create a second queue).
   */
  register(taskId: string): ActorState {
    const existing = this.actors.get(taskId)
    if (existing) return existing
    const state: ActorState = {
      taskId,
      queue: new WakeQueue(taskId),
      abortController: new AbortController(),
      running: false,
      lastProcessedSeq: -1,
      lastProcessedAt: 0,
    }
    this.actors.set(taskId, state)
    return state
  }

  /** Look up an actor; returns undefined if not registered. */
  get(taskId: string): ActorState | undefined {
    return this.actors.get(taskId)
  }

  has(taskId: string): boolean {
    return this.actors.has(taskId)
  }

  /**
   * Send a wake event to a specific task's actor. Returns true if the
   * actor is registered, false if not (lets the caller decide whether
   * absence is an error).
   */
  wake(taskId: string, reason: WakeReason): boolean {
    const a = this.actors.get(taskId)
    if (!a) return false
    a.queue.enqueue(reason)
    return true
  }

  /**
   * Wake every registered actor. Used for daemon-wide signals like
   * timer ticks or shutdown.
   */
  wakeAll(reason: WakeReason): number {
    let count = 0
    for (const a of this.actors.values()) {
      a.queue.enqueue(reason)
      count++
    }
    return count
  }

  /**
   * Abort + close + remove an actor. Used on terminal task state.
   * Idempotent: deregister on an unknown taskId is a no-op.
   */
  deregister(taskId: string, reason: string): boolean {
    const a = this.actors.get(taskId)
    if (!a) return false
    a.queue.enqueue({ kind: 'cancel', reason })
    a.abortController.abort()
    a.queue.close()
    this.actors.delete(taskId)
    return true
  }

  /** Daemon shutdown: abort + close every actor. */
  deregisterAll(reason: string): number {
    let count = 0
    for (const taskId of this.actors.keys()) {
      this.deregister(taskId, reason)
      count++
    }
    return count
  }

  /** Diagnostic: number of registered actors. */
  size(): number {
    return this.actors.size
  }

  /** Test helper: enumerate registered task IDs. */
  taskIds(): string[] {
    return Array.from(this.actors.keys())
  }
}

/**
 * Global registry instance. There's one per daemon process; tests should
 * create their own instance via `new TaskActorRegistry()` if isolation
 * matters (e.g. parallel test files).
 */
export const taskActorRegistry = new TaskActorRegistry()

export { TaskActorRegistry }
