// RFC-061 PR-B T9-extra — wire event-applier emissions to actor wakes.
//
// In design.md §6 the actor loop wakes on `event-applied` reasons. The
// applier itself stays scope-pure (just mutates projection) — but
// somewhere outside the tx the orchestrator needs to translate every
// applied event into an actor wake. This module is that translator:
//
//   writeEvents() finishes a batch → calls wakeForEvents(batchedEvents)
//   wakeForEvents iterates → taskActorRegistry.wake(taskId, ...) per event
//
// Keeping it as a separate module (rather than baking the wake into
// writeEvents directly) means tests can call writeEvents without
// spinning up actors, and the production daemon can register the
// callback once at startup.

import type { Event } from '@agent-workflow/shared'

import { taskActorRegistry } from './actorRegistry'
import type { WakeReason } from './wakeQueue'

/**
 * Translate one event into a WakeReason. Most events become
 * `event-applied`; attempt-finished-* become `attempt-exit`; task-
 * canceled becomes `cancel`.
 *
 * Returns null when the event should NOT wake an actor (e.g. task-level
 * events whose state transitions are observers' jobs).
 */
export function eventToWakeReason(event: Event): WakeReason | null {
  switch (event.kind) {
    case 'attempt-finished-success':
      return { kind: 'attempt-exit', attemptId: event.attemptId ?? '', outcome: 'success' }
    case 'attempt-finished-envelope-fail':
      return {
        kind: 'attempt-exit',
        attemptId: event.attemptId ?? '',
        outcome: 'envelope-fail',
        reason: event.payload.reason,
      }
    case 'attempt-finished-crash':
      return {
        kind: 'attempt-exit',
        attemptId: event.attemptId ?? '',
        outcome: 'crash',
        ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {}),
        ...(event.payload.errorMessage !== undefined
          ? { errorMessage: event.payload.errorMessage }
          : {}),
      }
    case 'attempt-finished-timeout':
      return {
        kind: 'attempt-exit',
        attemptId: event.attemptId ?? '',
        outcome: 'timeout',
      }
    case 'attempt-canceled':
      return {
        kind: 'attempt-exit',
        attemptId: event.attemptId ?? '',
        outcome: 'canceled',
        ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
      }
    case 'task-canceled':
      return { kind: 'cancel', reason: event.payload.reason ?? 'task-canceled' }

    case 'logical-run-created':
    case 'logical-run-iter-bumped':
    case 'logical-run-completed':
    case 'logical-run-canceled':
    case 'attempt-started':
    case 'attempt-output-captured':
    case 'suspension-created':
    case 'suspension-resolved':
    case 'suspension-terminated':
      return { kind: 'event-applied', eventId: event.id }

    case 'attempt-subagent-tool-use':
    case 'attempt-subagent-output':
    case 'attempt-token-usage':
    case 'invariant-alert-detected':
    case 'invariant-alert-resolved':
    case 'task-created':
    case 'task-started':
    case 'task-paused':
    case 'task-completed':
    case 'task-failed':
    case 'task-resumed-after-daemon-restart':
      // No actor wake — these are observer-facing only.
      return null

    default: {
      const _exhaustive: never = event
      throw new Error(`unhandled EventKind in eventToWakeReason: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Fan a batch of just-applied events out to the actor registry. Returns
 * the number of wakes successfully delivered (drops on unknown taskId).
 *
 * Idempotent — calling twice on the same batch just enqueues duplicate
 * `event-applied` reasons, which the actor handles harmlessly (its next
 * scan-and-dispatch is identical).
 */
export function wakeForEvents(events: ReadonlyArray<Event>): number {
  let delivered = 0
  for (const e of events) {
    const reason = eventToWakeReason(e)
    if (!reason) continue
    if (taskActorRegistry.wake(e.taskId, reason)) {
      delivered++
    }
  }
  return delivered
}
