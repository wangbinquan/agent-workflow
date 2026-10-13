import type { AfterCommitEventPump } from './afterCommitEventPump'
import type { CommittedEventRef } from './types'
import { createLogger } from '@/util/log'

const log = createLogger('committed-event-runtime')

let activePump: AfterCommitEventPump | null = null

/** Bootstrap-owned process binding for exact post-commit receipts. */
export function registerAfterCommitEventPump(pump: AfterCommitEventPump | null): void {
  activePump = pump
}

/** A late stop can release only the exact pump that its owning root registered. */
export function releaseAfterCommitEventPump(pump: AfterCommitEventPump): boolean {
  if (activePump !== pump) return false
  activePump = null
  return true
}

/**
 * Project and nudge one already-committed receipt. An absent pump is valid
 * during boot and isolated tests: durable deliveries remain the recovery path.
 */
export async function publishCommittedEventsAfterCommit(
  eventRefs: readonly CommittedEventRef[],
): Promise<boolean> {
  if (eventRefs.length === 0) return activePump !== null
  const pump = activePump
  if (pump === null) return false
  try {
    await pump.publishNow(eventRefs)
  } catch (error) {
    log.warn('post-commit event pump failed; durable delivery will retry', {
      eventIds: eventRefs.map((event) => event.eventId),
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return true
}
