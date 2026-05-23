// RFC-061 PR-B T9 — per-task wake queue.
//
// Each taskActor consumes wake events in order. The queue is a bounded
// async iterator: producers (event-applier callbacks, attempt-exit
// hooks, daemon shutdown) `enqueue()`, the actor `for await` over the
// queue. Closing the queue (via abort) ends the iteration.
//
// design.md §6: wake reasons cover state changes, attempt exits, timer
// ticks, and cancel. The queue itself is reason-agnostic — it just
// streams typed messages to the actor.

import type { Scope } from '@agent-workflow/shared'

export interface AttemptExitWake {
  kind: 'attempt-exit'
  attemptId: string
  outcome: 'success' | 'envelope-fail' | 'crash' | 'timeout' | 'canceled'
  exitCode?: number
  errorMessage?: string
  /** When outcome === 'envelope-fail' or 'crash', the runner's reason text. */
  reason?: string
}

export interface EventAppliedWake {
  kind: 'event-applied'
  eventId: string
  /** Optional scope hint so the actor can short-circuit ready-scan to one area. */
  scopeHint?: Scope
}

export interface TimerWake {
  kind: 'timer'
  purpose: 'retry-backoff' | 'invariant-scan'
}

export interface CancelWake {
  kind: 'cancel'
  reason: string
}

export type WakeReason = AttemptExitWake | EventAppliedWake | TimerWake | CancelWake

export interface WakeEvent {
  taskId: string
  reason: WakeReason
  /** Monotonic enqueue counter so observer / metrics can detect drops. */
  seq: number
}

/**
 * Per-task wake queue. Single-consumer (one taskActor per task); multi-
 * producer (event-applier, runner exit handler, timers, cancel).
 * Backed by a Promise-resolver chain so producers never block.
 */
export class WakeQueue {
  private readonly buffer: WakeEvent[] = []
  private readonly resolvers: Array<(ev: WakeEvent | null) => void> = []
  private closed = false
  private seq = 0

  constructor(public readonly taskId: string) {}

  enqueue(reason: WakeReason): void {
    if (this.closed) return
    const ev: WakeEvent = {
      taskId: this.taskId,
      reason,
      seq: this.seq++,
    }
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver(ev)
    } else {
      this.buffer.push(ev)
    }
  }

  /**
   * Take the next wake event; returns null if the queue has been closed
   * with no remaining buffered events.
   */
  async next(): Promise<WakeEvent | null> {
    if (this.closed && this.buffer.length === 0) return null
    const buffered = this.buffer.shift()
    if (buffered !== undefined) return buffered
    return await new Promise<WakeEvent | null>((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  /** Mark the queue closed; existing buffered events still drain. */
  close(): void {
    if (this.closed) return
    this.closed = true
    // Resolve any pending readers with null (signals end-of-stream).
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()
      r?.(null)
    }
  }

  /** Diagnostic / test access — how many events are buffered right now. */
  get bufferedCount(): number {
    return this.buffer.length
  }

  /** True when close() has been called. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Drain the queue synchronously (test helper). */
  drainSync(): WakeEvent[] {
    const out = this.buffer.slice()
    this.buffer.length = 0
    return out
  }
}
