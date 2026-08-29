// RFC-341 — synchronous, exact-ref post-commit projection and worker nudge.

import type { DbClient } from '@/db/client'
import { createLogger } from '@/util/log'
import type { CommittedEventCodecRegistry } from './dispatcherWorker'
import { getStoredCommittedEvents } from './sqliteStore'
import type {
  CommittedEventConsumerDefinition,
  CommittedEventEnvelopeV1,
  CommittedEventRef,
} from './types'

const log = createLogger('after-commit-event-pump')

export interface AfterCommitEventPump {
  publishNow(eventRefs: readonly CommittedEventRef[]): void
  nudge(eventRefs?: readonly CommittedEventRef[]): void
}

export function createAfterCommitEventPump(input: {
  readonly db: DbClient
  readonly codecs: CommittedEventCodecRegistry
  readonly projectors: readonly CommittedEventConsumerDefinition[]
  readonly nudgeDispatcher: () => void
  readonly nudgeContinuation?: () => void
  readonly onProjectionError?: (input: {
    event: CommittedEventEnvelopeV1
    consumerId: string
    error: unknown
  }) => void
  readonly dedupeLimit?: number
}): AfterCommitEventPump {
  const projectors = input.projectors.filter((projector) => projector.deliveryClass === 'ephemeral')
  if (projectors.length !== input.projectors.length) {
    throw new Error('after-commit event pump accepts ephemeral projectors only')
  }
  const dedupeLimit = input.dedupeLimit ?? 2_048
  const projected = new Map<string, string>()

  const remember = (eventId: string, digest: string): boolean => {
    const previous = projected.get(eventId)
    if (previous !== undefined) {
      if (previous !== digest) throw new Error(`committed event digest changed in pump: ${eventId}`)
      return false
    }
    projected.set(eventId, digest)
    while (projected.size > dedupeLimit) {
      const oldest = projected.keys().next().value as string | undefined
      if (oldest === undefined) break
      projected.delete(oldest)
    }
    return true
  }

  const nudge = (): void => {
    input.nudgeDispatcher()
    input.nudgeContinuation?.()
  }

  return {
    publishNow(eventRefs) {
      const dispatchable = eventRefs.filter((eventRef) => eventRef.deliveryMode === 'dispatchable')
      const stored = [
        ...getStoredCommittedEvents(
          input.db,
          dispatchable.map((eventRef) => eventRef.eventId),
        ),
      ].sort((a, b) => {
        if (a.envelope.eventGroupId !== b.envelope.eventGroupId) {
          return a.envelope.eventGroupId.localeCompare(b.envelope.eventGroupId)
        }
        return a.envelope.eventGroupOrdinal - b.envelope.eventGroupOrdinal
      })
      for (const event of stored) {
        if (!remember(event.envelope.eventId, event.payloadDigest)) continue
        const envelope = input.codecs.decode(event.envelope)
        for (const projector of projectors) {
          if (!projector.eventTypes.includes(envelope.type)) continue
          try {
            const result = projector.handle(envelope)
            if (result instanceof Promise) {
              throw new Error(`ephemeral projector returned Promise: ${projector.id}`)
            }
          } catch (error) {
            input.onProjectionError?.({ event: envelope, consumerId: projector.id, error })
            log.warn('committed event immediate projection failed', {
              eventId: envelope.eventId,
              consumerId: projector.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
      nudge()
    },
    nudge,
  }
}
