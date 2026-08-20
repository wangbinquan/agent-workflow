import { ulid } from 'ulid'
import { z } from 'zod'

import { NotFoundError, ValidationError } from '@/util/errors'
import type { EventObserverProgramPort } from '../composition/required-ports'
import {
  eventContentDigest,
  eventExactRefSchema,
  eventObservationSchema,
  eventSourceDescriptorSchema,
  eventSubjectSchema,
  eventSubscriberSchema,
  eventTypeDescriptorSchema,
  observerBatchSchema,
  subscriptionIdentity,
} from '../domain/model'
import type { EventStorePort } from './ports/eventStore'

const packageEventCatalogSchema = z.object({
  typeRef: z.object({ typeId: z.string().min(1), revision: z.number().int().positive() }),
  eventSources: z.array(
    z.object({
      sourceId: z.string().min(1),
      version: z.number().int().positive(),
      displayName: z.object({ 'zh-CN': z.string(), 'en-US': z.string() }),
      description: z.object({ 'zh-CN': z.string(), 'en-US': z.string() }),
      observationMode: z.enum(['passive', 'active', 'hybrid']),
      observerProgramRef: eventExactRefSchema.nullable(),
      pollIntervalMs: z.number().int(),
      batchSize: z.number().int(),
    }),
  ),
  eventTypes: z.array(
    z.object({
      eventTypeId: z.string().min(1),
      version: z.number().int().positive(),
      subjectTypeId: z.string().min(1),
      payloadSchemaId: z.string().min(1),
      displayName: z.object({ 'zh-CN': z.string(), 'en-US': z.string() }),
      description: z.object({ 'zh-CN': z.string(), 'en-US': z.string() }),
      deliveryClass: z.string().min(1),
      priority: z.number().int(),
      sourceRef: eventExactRefSchema,
    }),
  ),
})

export interface EventCenterServiceDependencies {
  readonly store: EventStorePort
  readonly typePackageDescriptorJsons: readonly string[]
  readonly observer: EventObserverProgramPort
  readonly now?: () => number
  readonly id?: () => string
  readonly workerId?: string
  readonly observerLeaseMs?: number
}

export class EventCenterService {
  readonly #store: EventStorePort
  readonly #observer: EventObserverProgramPort
  readonly #now: () => number
  readonly #id: () => string
  readonly #workerId: string
  readonly #observerLeaseMs: number

  constructor(deps: EventCenterServiceDependencies) {
    this.#store = deps.store
    this.#observer = deps.observer
    this.#now = deps.now ?? Date.now
    this.#id = deps.id ?? ulid
    this.#workerId = deps.workerId ?? `event-center-${ulid()}`
    this.#observerLeaseMs = deps.observerLeaseMs ?? 60_000

    for (const descriptorJson of deps.typePackageDescriptorJsons) {
      const catalog = packageEventCatalogSchema.parse(JSON.parse(descriptorJson) as unknown)
      const now = this.#now()
      for (const source of catalog.eventSources) {
        const descriptor = eventSourceDescriptorSchema.parse({
          schemaVersion: 1,
          sourceRef: { id: source.sourceId, revision: source.version },
          ownerTypeId: catalog.typeRef.typeId,
          displayName: source.displayName,
          description: source.description,
          observationMode: source.observationMode,
          observerProgramRef: source.observerProgramRef,
          pollIntervalMs: source.pollIntervalMs,
          batchSize: source.batchSize,
        })
        this.#store.registerSource(descriptor, eventContentDigest(descriptor), now)
      }
      for (const eventType of catalog.eventTypes) {
        const descriptor = eventTypeDescriptorSchema.parse({
          schemaVersion: 1,
          eventTypeRef: { id: eventType.eventTypeId, revision: eventType.version },
          sourceRef: eventType.sourceRef,
          ownerTypeId: catalog.typeRef.typeId,
          subjectTypeId: eventType.subjectTypeId,
          payloadSchemaId: eventType.payloadSchemaId,
          displayName: eventType.displayName,
          description: eventType.description,
          deliveryClass: eventType.deliveryClass,
          priority: eventType.priority,
        })
        if (this.#store.getSource(descriptor.sourceRef) === null) {
          throw new Error(
            `event type ${descriptor.eventTypeRef.id} references missing source ${descriptor.sourceRef.id}@${descriptor.sourceRef.revision}`,
          )
        }
        this.#store.registerEventType(descriptor, eventContentDigest(descriptor), now)
      }
    }
  }

  subscribe(input: unknown) {
    const parsed = z
      .object({
        eventTypeRef: eventExactRefSchema,
        subject: eventSubjectSchema,
        subscriber: eventSubscriberSchema,
      })
      .strict()
      .parse(input)
    const eventType = this.#store.getEventType(parsed.eventTypeRef)
    if (eventType === null) {
      throw new NotFoundError(
        'event-type-not-found',
        `event type not found: ${parsed.eventTypeRef.id}@${parsed.eventTypeRef.revision}`,
      )
    }
    if (eventType.subjectTypeId !== parsed.subject.typeId) {
      throw new ValidationError(
        'event-subject-type-invalid',
        `${eventType.eventTypeRef.id} expects ${eventType.subjectTypeId}`,
      )
    }
    const source = this.#store.getSource(eventType.sourceRef)
    if (source === null) {
      throw new NotFoundError('event-source-not-found', 'event source is unavailable')
    }
    const result = this.#store.subscribe({
      id: this.#id(),
      eventType,
      source,
      subject: parsed.subject,
      subscriber: parsed.subscriber,
      identityKey: subscriptionIdentity(parsed),
      now: this.#now(),
    })
    return {
      subscriptionId: result.record.id,
      created: result.created,
      observerTransition: result.observerTransition,
    } as const
  }

  unsubscribe(subscriptionId: string) {
    const result = this.#store.cancelSubscription(subscriptionId, this.#now())
    if (result === null) {
      const existing = this.#store
        .listSubscriptions()
        .find((subscription) => subscription.id === subscriptionId)
      if (existing === undefined) {
        throw new NotFoundError(
          'event-subscription-not-found',
          `event subscription not found: ${subscriptionId}`,
        )
      }
      return {
        subscriptionId,
        created: false,
        observerTransition: 'none' as const,
      }
    }
    return {
      subscriptionId,
      created: false,
      observerTransition: result.observerTransition,
    } as const
  }

  nudgeSource(input: unknown): boolean {
    const sourceRef = eventExactRefSchema.parse(input)
    const source = this.#store.getSource(sourceRef)
    if (source === null) {
      throw new NotFoundError(
        'event-source-not-found',
        `event source not found: ${sourceRef.id}@${sourceRef.revision}`,
      )
    }
    if (source.observationMode === 'passive') {
      throw new ValidationError(
        'event-source-not-observable',
        `event source is passive: ${sourceRef.id}@${sourceRef.revision}`,
      )
    }
    return this.#store.nudgeObserver(sourceRef, this.#now())
  }

  observe(input: unknown) {
    const observation = eventObservationSchema.parse(input)
    const eventType = this.#store.getEventType(observation.eventTypeRef)
    if (eventType === null) {
      throw new NotFoundError('event-type-not-found', 'event type is unavailable')
    }
    if (
      eventType.sourceRef.id !== observation.sourceRef.id ||
      eventType.sourceRef.revision !== observation.sourceRef.revision
    ) {
      throw new ValidationError(
        'event-source-mismatch',
        'event type and observation source revisions do not match',
      )
    }
    if (eventType.subjectTypeId !== observation.subject.typeId) {
      throw new ValidationError(
        'event-subject-type-invalid',
        `${eventType.eventTypeRef.id} expects ${eventType.subjectTypeId}`,
      )
    }
    return this.#store.recordObservation({
      eventId: this.#id(),
      observation,
      eventType,
      observedAt: this.#now(),
      nextId: this.#id,
    })
  }

  pendingDeliveries(input: unknown, limit: number) {
    const subscriber = eventSubscriberSchema.parse(input)
    return this.#store.listPendingDeliveries(subscriber, limit)
  }

  acceptDelivery(deliveryId: string): void {
    if (!this.#store.acceptDelivery(deliveryId, this.#now())) {
      throw new NotFoundError('event-delivery-not-found', `event delivery not found: ${deliveryId}`)
    }
  }

  listCatalog() {
    return { sources: this.#store.listSources(), eventTypes: this.#store.listEventTypes() }
  }

  listSubscriptions(subscriberRef?: string) {
    return this.#store.listSubscriptions(subscriberRef)
  }

  observerHealth() {
    return this.#store.listObserverActivations()
  }

  async runOneDueObserver(): Promise<'completed' | 'failed' | 'obsolete' | 'idle'> {
    const run = this.#store.claimDueObserver({
      now: this.#now(),
      leaseOwner: this.#workerId,
      leaseMs: this.#observerLeaseMs,
      runId: this.#id(),
    })
    if (run === null) return 'idle'
    try {
      const batch = observerBatchSchema.parse(
        await this.#observer.run({
          source: run.source,
          subjects: run.subjects,
          cursorJson: run.cursorJson,
        }),
      )
      const subjectKeys = new Set(
        run.subjects.map((subject) => `${subject.typeId}\u0000${subject.subjectRef}`),
      )
      const observations = batch.observations.map((observation) => {
        if (
          observation.sourceRef.id !== run.source.sourceRef.id ||
          observation.sourceRef.revision !== run.source.sourceRef.revision
        ) {
          throw new ValidationError(
            'observer-source-mismatch',
            'observer returned an observation for another source',
          )
        }
        if (
          !subjectKeys.has(`${observation.subject.typeId}\u0000${observation.subject.subjectRef}`)
        ) {
          throw new ValidationError(
            'observer-subject-out-of-batch',
            'observer returned an observation outside its subscribed subject batch',
          )
        }
        const eventType = this.#store.getEventType(observation.eventTypeRef)
        if (
          eventType === null ||
          eventType.sourceRef.id !== run.source.sourceRef.id ||
          eventType.sourceRef.revision !== run.source.sourceRef.revision
        ) {
          throw new ValidationError(
            'observer-event-type-invalid',
            'observer returned an unregistered event type for this source',
          )
        }
        return { eventId: this.#id(), observation, eventType }
      })
      return this.#store.settleObserver({
        run,
        now: this.#now(),
        cursorJson: batch.cursorJson,
        observations,
        nextId: this.#id,
        errorCode: null,
        errorDetail: null,
      })
    } catch (error) {
      return this.#store.settleObserver({
        run,
        now: this.#now(),
        cursorJson: run.cursorJson,
        observations: [],
        nextId: this.#id,
        errorCode: 'observer-execution-failed',
        errorDetail: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
      })
    }
  }
}
