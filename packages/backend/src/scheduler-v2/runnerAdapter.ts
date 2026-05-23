// RFC-061 PR-B T9 — runner adapter contract.
//
// The taskActor never directly spawns opencode; it returns SpawnRequests
// to the orchestrator which forwards them to a RunnerAdapter. The
// adapter is responsible for:
//   1. spawning the opencode subprocess
//   2. capturing its stdout envelope events
//   3. emitting `attempt-output-captured` events for each port
//   4. emitting `attempt-finished-*` event on exit
//   5. enqueueing the matching attempt-exit wake on the actor's queue
//
// Keeping this as an INTERFACE lets the actor be tested with a mock
// runner. The production wiring (calls existing services/runner.ts)
// lands in a follow-up commit alongside the daemon-startup cutover.

import type { SpawnRequest } from './taskActorTick'
import type { WakeReason } from './wakeQueue'

export interface RunnerAdapter {
  /**
   * Spawn an attempt. Returns a Promise that resolves once the
   * subprocess has been launched (NOT when it exits — exit notification
   * comes via the wake-queue `attempt-exit` reason).
   *
   * Throws synchronously if the spawn pre-flight check fails (e.g.
   * worktree missing, opencode binary unresolvable). Async failures
   * (process crash mid-flight) are reported via attempt-exit.
   */
  spawn(req: SpawnRequest): Promise<void>

  /**
   * Cancel an in-flight attempt. Best-effort SIGTERM. The runner is
   * responsible for emitting attempt-canceled when the subprocess
   * actually dies (likely promptly after SIGTERM but the timing is
   * runner-internal).
   */
  cancel(attemptId: string, reason: string): Promise<void>
}

/**
 * Wake queue contract — what the runner enqueues into. The actor's
 * queue is the consumer; the runner is one of several producers
 * (alongside the event-applier callback hook and timer ticks).
 */
export interface WakeProducer {
  enqueue(reason: WakeReason): void
}

/**
 * Mock runner for tests. Spawn just records the call; cancel records too.
 * Tests can manually invoke `simulateExit` to emit attempt-exit wakes.
 */
export class MockRunnerAdapter implements RunnerAdapter {
  readonly spawned: SpawnRequest[] = []
  readonly canceled: Array<{ attemptId: string; reason: string }> = []
  private exitProducer: WakeProducer | null = null

  bindWakeProducer(producer: WakeProducer): void {
    this.exitProducer = producer
  }

  async spawn(req: SpawnRequest): Promise<void> {
    this.spawned.push(req)
  }

  async cancel(attemptId: string, reason: string): Promise<void> {
    this.canceled.push({ attemptId, reason })
  }

  /**
   * Test hook: pretend the attempt finished. Emits the corresponding
   * attempt-exit wake into the bound producer queue.
   */
  simulateExit(
    attemptId: string,
    outcome: 'success' | 'envelope-fail' | 'crash' | 'timeout' | 'canceled',
    extras?: { exitCode?: number; reason?: string; errorMessage?: string },
  ): void {
    if (!this.exitProducer) {
      throw new Error(
        'MockRunnerAdapter.simulateExit: no wake producer bound — call bindWakeProducer first',
      )
    }
    this.exitProducer.enqueue({
      kind: 'attempt-exit',
      attemptId,
      outcome,
      ...(extras?.exitCode !== undefined ? { exitCode: extras.exitCode } : {}),
      ...(extras?.reason !== undefined ? { reason: extras.reason } : {}),
      ...(extras?.errorMessage !== undefined ? { errorMessage: extras.errorMessage } : {}),
    })
  }
}
