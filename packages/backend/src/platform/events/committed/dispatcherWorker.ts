// RFC-341 — bounded durable committed-event delivery driver.

import type { DbClient } from '@/db/client'
import { createLogger } from '@/util/log'
import {
  acceptCommittedEventDelivery,
  claimNextCommittedEventDelivery,
  rejectCommittedEventDelivery,
} from './sqliteStore'
import {
  createCommittedEventProjectionLedger,
  type CommittedEventConsumerDefinition,
  type CommittedEventEnvelopeV1,
  type CommittedEventProjectionLedger,
} from './types'

const log = createLogger('committed-event-dispatcher')

export type CommittedEventDeliveryOutcome = 'completed' | 'retried' | 'dead-letter' | 'idle'

export interface CommittedEventCodecRegistry {
  readonly eventTypes: readonly string[]
  decode(envelope: unknown): CommittedEventEnvelopeV1
}

/** Bootstrap helper for joining producer-owned closed codecs without leaking a
 * catch-all decoder into either bounded context. Duplicate ownership fails at
 * composition time; unknown types fail before any consumer is invoked. */
export function combineCommittedEventCodecRegistries(
  ...registries: readonly CommittedEventCodecRegistry[]
): CommittedEventCodecRegistry {
  const ownerByType = new Map<string, CommittedEventCodecRegistry>()
  for (const registry of registries) {
    for (const eventType of registry.eventTypes) {
      if (ownerByType.has(eventType)) {
        throw new Error(`committed event codec type has multiple owners: ${eventType}`)
      }
      ownerByType.set(eventType, registry)
    }
  }
  return Object.freeze({
    eventTypes: Object.freeze([...ownerByType.keys()]),
    decode(envelope: unknown): CommittedEventEnvelopeV1 {
      const eventType =
        envelope !== null &&
        typeof envelope === 'object' &&
        typeof (envelope as { type?: unknown }).type === 'string'
          ? (envelope as { type: string }).type
          : null
      const owner = eventType === null ? undefined : ownerByType.get(eventType)
      if (owner === undefined) {
        throw new Error(`committed event codec type is unknown: ${eventType ?? '<missing>'}`)
      }
      return owner.decode(envelope)
    },
  })
}

export function assertCommittedEventRegistry(input: {
  readonly codecs: CommittedEventCodecRegistry
  readonly consumers: readonly CommittedEventConsumerDefinition[]
}): void {
  const knownTypes = new Set(input.codecs.eventTypes)
  if (knownTypes.size !== input.codecs.eventTypes.length) {
    throw new Error('committed event codec registry contains duplicate event types')
  }
  const consumers = new Set<string>()
  const durableCoverage = new Set<string>()
  for (const consumer of input.consumers) {
    if (consumer.id.length === 0 || consumers.has(consumer.id)) {
      throw new Error(`committed event consumer id is missing or duplicated: '${consumer.id}'`)
    }
    consumers.add(consumer.id)
    if (consumer.eventTypes.length === 0) {
      throw new Error(`committed event consumer has no event types: ${consumer.id}`)
    }
    for (const eventType of consumer.eventTypes) {
      if (!knownTypes.has(eventType)) {
        throw new Error(
          `committed event consumer '${consumer.id}' declares unknown type '${eventType}'`,
        )
      }
      if (consumer.deliveryClass !== 'ephemeral') durableCoverage.add(eventType)
    }
    if (consumer.deliveryClass === 'ephemeral' && consumer.settle !== 'projection-attempted') {
      throw new Error(`ephemeral committed event consumer '${consumer.id}' has durable settle mode`)
    }
    if (consumer.deliveryClass !== 'ephemeral' && consumer.settle === 'projection-attempted') {
      throw new Error(`durable committed event consumer '${consumer.id}' has ephemeral settle mode`)
    }
  }
  for (const eventType of knownTypes) {
    if (!durableCoverage.has(eventType)) {
      throw new Error(`committed event type has no durable consumer: ${eventType}`)
    }
  }
}

export interface CommittedEventDispatcher {
  runOne(): Promise<CommittedEventDeliveryOutcome>
  drain(maxSteps?: number): Promise<Readonly<{ steps: number; madeProgress: boolean }>>
}

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : 'committed-event-consumer-error'
}

export function createCommittedEventDispatcher(input: {
  readonly db: DbClient
  readonly workerId: string
  readonly codecs: CommittedEventCodecRegistry
  readonly consumers: readonly CommittedEventConsumerDefinition[]
  readonly maxAttempts?: () => number
  readonly now?: () => number
  readonly leaseMs?: number
  readonly projectionLedger?: CommittedEventProjectionLedger
  readonly onProjectionError?: (input: {
    event: CommittedEventEnvelopeV1
    consumerId: string
    error: unknown
  }) => void
}): CommittedEventDispatcher {
  assertCommittedEventRegistry({ codecs: input.codecs, consumers: input.consumers })
  const now = input.now ?? Date.now
  const durableConsumers = new Map(
    input.consumers
      .filter((consumer) => consumer.deliveryClass !== 'ephemeral')
      .map((consumer) => [consumer.id, consumer] as const),
  )
  const ephemeralProjectors = input.consumers.filter(
    (consumer) => consumer.deliveryClass === 'ephemeral',
  )
  const projectionLedger = input.projectionLedger ?? createCommittedEventProjectionLedger()
  const projectEphemeral = (envelope: CommittedEventEnvelopeV1, payloadDigest: string): void => {
    for (const projector of ephemeralProjectors) {
      if (!projector.eventTypes.includes(envelope.type)) continue
      try {
        if (
          !projectionLedger.begin({
            eventId: envelope.eventId,
            consumerId: projector.id,
            payloadDigest,
          })
        ) {
          continue
        }
        const result = projector.handle(envelope)
        if (result instanceof Promise) {
          throw new Error(`ephemeral projector returned Promise: ${projector.id}`)
        }
      } catch (error) {
        input.onProjectionError?.({ event: envelope, consumerId: projector.id, error })
        log.warn('committed event recovery projection failed', {
          eventId: envelope.eventId,
          consumerId: projector.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return {
    async runOne() {
      const claim = claimNextCommittedEventDelivery({
        db: input.db,
        workerId: input.workerId,
        now: now(),
        ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
      })
      if (claim === null) return 'idle'
      try {
        const envelope = input.codecs.decode(claim.event.envelope)
        projectEphemeral(envelope, claim.event.payloadDigest)
        const consumer = durableConsumers.get(claim.consumerId)
        if (consumer === undefined) {
          throw Object.assign(
            new Error(`committed event consumer is not registered: ${claim.consumerId}`),
            { code: 'committed-event-consumer-missing' },
          )
        }
        if (!consumer.eventTypes.includes(envelope.type)) {
          throw Object.assign(
            new Error(
              `committed event consumer '${consumer.id}' does not accept '${envelope.type}'`,
            ),
            { code: 'committed-event-consumer-type-mismatch' },
          )
        }
        await consumer.handle(envelope)
        acceptCommittedEventDelivery({ db: input.db, claim, now: now() })
        return 'completed'
      } catch (error) {
        return rejectCommittedEventDelivery({
          db: input.db,
          claim,
          errorCode: errorCode(error),
          errorSummary: error instanceof Error ? error.message : String(error),
          maxAttempts: Math.max(1, Math.trunc(input.maxAttempts?.() ?? 5)),
          now: now(),
        })
      }
    },
    async drain(maxSteps = 32) {
      if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
        throw new Error('committed event drain maxSteps must be a positive integer')
      }
      let steps = 0
      for (; steps < maxSteps; steps += 1) {
        if ((await this.runOne()) === 'idle') break
      }
      return { steps, madeProgress: steps > 0 }
    },
  }
}
