// RFC-341/RFC-349 — exact-ref post-commit projection and worker nudge.
// Projectors are awaited serially because provider-backed PostgreSQL reads are
// asynchronous and event-group order is part of the projection contract.

import { createLogger } from '@/util/log'
import type { CommittedEventCodecRegistry } from './dispatcherWorker'
import type { CommittedEventDeliveryPersistencePort } from './persistence'
import type {
  CommittedEventConsumerDefinition,
  CommittedEventEnvelopeV1,
  CommittedEventProjectionLedger,
  CommittedEventRef,
} from './types'
import { createCommittedEventProjectionLedger } from './types'

const log = createLogger('after-commit-event-pump')

export interface AfterCommitEventPump {
  publishNow(eventRefs: readonly CommittedEventRef[]): Promise<void>
  nudge(eventRefs?: readonly CommittedEventRef[]): void
}

export function createAfterCommitEventPump(input: {
  readonly persistence: CommittedEventDeliveryPersistencePort
  readonly codecs: CommittedEventCodecRegistry
  readonly projectors: readonly CommittedEventConsumerDefinition[]
  readonly nudgeDispatcher: () => void
  readonly onProjectionError?: (input: {
    event: CommittedEventEnvelopeV1
    consumerId: string
    error: unknown
  }) => void
  readonly projectionLedger?: CommittedEventProjectionLedger
  readonly dedupeLimit?: number
}): AfterCommitEventPump {
  const projectors = input.projectors.filter((projector) => projector.deliveryClass === 'ephemeral')
  if (projectors.length !== input.projectors.length) {
    throw new Error('after-commit event pump accepts ephemeral projectors only')
  }
  const dedupeLimit = input.dedupeLimit ?? 2_048
  const projectionLedger =
    input.projectionLedger ?? createCommittedEventProjectionLedger(dedupeLimit)
  let projectionTail: Promise<void> = Promise.resolve()

  const nudge = (): void => {
    input.nudgeDispatcher()
  }

  const project = async (
    stored: Awaited<ReturnType<CommittedEventDeliveryPersistencePort['getStored']>>,
  ): Promise<void> => {
    const ordered = [...stored].sort((a, b) => {
      if (a.envelope.eventGroupId !== b.envelope.eventGroupId) {
        return a.envelope.eventGroupId.localeCompare(b.envelope.eventGroupId)
      }
      return a.envelope.eventGroupOrdinal - b.envelope.eventGroupOrdinal
    })
    for (const event of ordered) {
      const envelope = input.codecs.decode(event.envelope)
      for (const projector of projectors) {
        if (!projector.eventTypes.includes(envelope.type)) continue
        if (
          !projectionLedger.begin({
            eventId: envelope.eventId,
            consumerId: projector.id,
            payloadDigest: event.payloadDigest,
          })
        ) {
          continue
        }
        try {
          await projector.handle(envelope)
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
  }

  return {
    async publishNow(eventRefs) {
      const dispatchable = eventRefs.filter((eventRef) => eventRef.deliveryMode === 'dispatchable')
      const ids = dispatchable.map((eventRef) => eventRef.eventId)
      const current = projectionTail.then(async () => {
        try {
          await project(await input.persistence.getStored(ids))
        } finally {
          // Durable delivery must be woken even when the immediate read or an
          // ephemeral projection fails.
          nudge()
        }
      })
      projectionTail = current.catch(() => undefined)
      await current
    },
    nudge,
  }
}
