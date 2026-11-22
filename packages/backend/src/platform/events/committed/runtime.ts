import type { AfterCommitEventPump } from './afterCommitEventPump'
import type { CommittedEventRef } from './types'
import { afterCommitEventPumpSlotOf } from '@/platform/persistence/sessionTables'
import { createLogger } from '@/util/log'

const log = createLogger('committed-event-runtime')

/**
 * RFC-537: the owning session attaches its pump to its own database. The pump rides on the handle's session context
 * (the client, its transactions and its native session share one), so a writer reaches the pump of the database it
 * committed on — there is no process-level pump. The returned release clears only the exact pump it attached.
 */
export function attachAfterCommitEventPump(handle: object, pump: AfterCommitEventPump): () => void {
  const slot = afterCommitEventPumpSlotOf(handle)
  if (slot === undefined) throw new Error('after-commit-event-pump-handle-unbound')
  slot.pump = pump
  return () => {
    if (slot.pump === pump) slot.pump = null
  }
}

/**
 * Project and nudge one already-committed receipt on the database it was committed to. An absent pump is valid
 * during boot and isolated tests: durable deliveries remain the recovery path.
 */
export async function publishCommittedEventsAfterCommit(
  handle: object,
  eventRefs: readonly CommittedEventRef[],
): Promise<boolean> {
  const pump = afterCommitEventPumpSlotOf(handle)?.pump ?? null
  if (eventRefs.length === 0) return pump !== null
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
