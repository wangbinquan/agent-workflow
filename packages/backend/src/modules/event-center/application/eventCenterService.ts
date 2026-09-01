import { ulid } from 'ulid'
import { z } from 'zod'
import { createTriggerContext } from '@agent-workflow/shared'

import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type {
  CustomEventObserverProgramPort,
  EventDeliveryConsumerPort,
  EventDeliveryRetryLimitsPort,
  EventObserverProgramPort,
  EventRoutingSubscriptionDirectoryPort,
} from '../composition/required-ports'
import type { CustomEventSourceStorePort } from './ports/customEventSourceStore'
import {
  customEventSourceDraftDigest,
  customEventSourceDraftSchema,
  customEventTypeId,
} from '../domain/customEventSource'
import {
  eventContentDigest,
  eventExactRefSchema,
  eventObservationSchema,
  eventSourceDescriptorSchema,
  eventSubjectSchema,
  eventSubscriberSchema,
  eventTypeDescriptorSchema,
  eventTypeContentDigest,
  observerBatchSchema,
  subscriptionIdentity,
} from '../domain/model'
import type { EventDeliveryStatusRecord } from '../domain/model'
import type { EventObservationInput } from '../public/types'
import type { EventStorePort } from './ports/eventStore'

const packageEventCatalogSchema = z.object({
  typeRef: z.object({ typeId: z.string().min(1), revision: z.number().int().positive() }),
  eventSources: z.array(
    z.object({
      sourceId: z.string().min(1),
      version: z.number().int().positive(),
      ownerTypeId: z.string().min(1).optional(),
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
      priority: z.number().int().min(0).max(100_000).optional(),
      sourceRef: eventExactRefSchema,
      catalogVisibility: z.enum(['public', 'internal', 'compatibility']).optional(),
      triggerParameters: z
        .object({
          namespace: z.string().min(1),
          fields: z.array(
            z
              .object({
                fieldId: z.string().min(1),
                displayName: z.object({ 'zh-CN': z.string(), 'en-US': z.string() }),
                description: z.object({ 'zh-CN': z.string(), 'en-US': z.string() }),
              })
              .strict(),
          ),
        })
        .strict()
        .nullable()
        .optional(),
    }),
  ),
})

export interface EventCenterServiceDependencies {
  readonly store: EventStorePort
  readonly customSources: CustomEventSourceStorePort
  readonly typePackageDescriptorJsons: readonly string[]
  readonly observer: EventObserverProgramPort
  readonly customObserver: CustomEventObserverProgramPort
  readonly routingSubscriptions: EventRoutingSubscriptionDirectoryPort
  readonly deliveryConsumers: readonly EventDeliveryConsumerPort[]
  readonly deliveryRetryLimits: EventDeliveryRetryLimitsPort
  readonly now?: () => number
  readonly id?: () => string
  readonly workerId?: string
  readonly observerLeaseMs?: number
  readonly deliveryLeaseMs?: number
}

export class EventCenterService {
  readonly #store: EventStorePort
  readonly #customSources: CustomEventSourceStorePort
  readonly #observer: EventObserverProgramPort
  readonly #customObserver: CustomEventObserverProgramPort
  readonly #routingSubscriptions: EventRoutingSubscriptionDirectoryPort
  readonly #deliveryConsumers: readonly EventDeliveryConsumerPort[]
  readonly #deliveryRetryLimits: EventDeliveryRetryLimitsPort
  readonly #now: () => number
  readonly #id: () => string
  readonly #workerId: string
  readonly #observerLeaseMs: number
  readonly #deliveryLeaseMs: number
  readonly #typePackageDescriptorJsons: readonly string[]

  constructor(deps: EventCenterServiceDependencies) {
    this.#store = deps.store
    this.#customSources = deps.customSources
    this.#observer = deps.observer
    this.#customObserver = deps.customObserver
    this.#routingSubscriptions = deps.routingSubscriptions
    this.#deliveryConsumers = deps.deliveryConsumers
    this.#deliveryRetryLimits = deps.deliveryRetryLimits
    this.#now = deps.now ?? Date.now
    this.#id = deps.id ?? ulid
    this.#workerId = deps.workerId ?? `event-center-${ulid()}`
    this.#observerLeaseMs = deps.observerLeaseMs ?? 60_000
    this.#deliveryLeaseMs = deps.deliveryLeaseMs ?? 60_000
    this.#typePackageDescriptorJsons = deps.typePackageDescriptorJsons
  }

  async initialize(): Promise<void> {
    for (const descriptorJson of this.#typePackageDescriptorJsons) {
      const catalog = packageEventCatalogSchema.parse(JSON.parse(descriptorJson) as unknown)
      const now = this.#now()
      for (const source of catalog.eventSources) {
        const descriptor = eventSourceDescriptorSchema.parse({
          schemaVersion: 1,
          sourceRef: { id: source.sourceId, revision: source.version },
          ownerTypeId: source.ownerTypeId ?? catalog.typeRef.typeId,
          displayName: source.displayName,
          description: source.description,
          observationMode: source.observationMode,
          observerProgramRef: source.observerProgramRef,
          pollIntervalMs: source.pollIntervalMs,
          batchSize: source.batchSize,
        })
        await this.#store.registerSource(descriptor, eventContentDigest(descriptor), now)
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
          ...(eventType.priority === undefined ? {} : { priority: eventType.priority }),
          ...(eventType.catalogVisibility === undefined
            ? {}
            : { catalogVisibility: eventType.catalogVisibility }),
          triggerParameters: eventType.triggerParameters ?? null,
        })
        if ((await this.#store.getSource(descriptor.sourceRef)) === null) {
          throw new Error(
            `event type ${descriptor.eventTypeRef.id} references missing source ${descriptor.sourceRef.id}@${descriptor.sourceRef.revision}`,
          )
        }
        await this.#store.registerEventType(descriptor, eventTypeContentDigest(descriptor), now)
      }
    }
  }

  async subscribe(input: unknown) {
    const parsed = z
      .object({
        eventTypeRef: eventExactRefSchema,
        subject: eventSubjectSchema,
        subscriber: eventSubscriberSchema,
        replayLatest: z.boolean().default(true),
      })
      .strict()
      .parse(input)
    const eventType = await this.#store.getEventType(parsed.eventTypeRef)
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
    const source = await this.#store.getSource(eventType.sourceRef)
    if (source === null) {
      throw new NotFoundError('event-source-not-found', 'event source is unavailable')
    }
    if (!(await this.#customSources.acceptsNewSubscriptions(source.sourceRef))) {
      throw new ConflictError(
        'event-source-retired',
        `event source is retired: ${source.sourceRef.id}@${source.sourceRef.revision}`,
      )
    }
    const result = await this.#store.subscribe({
      id: this.#id(),
      eventType,
      source,
      subject: parsed.subject,
      subscriber: parsed.subscriber,
      identityKey: subscriptionIdentity(parsed),
      replayLatest: parsed.replayLatest,
      now: this.#now(),
    })
    return {
      subscriptionId: result.record.id,
      created: result.created,
      observerTransition: result.observerTransition,
    } as const
  }

  async unsubscribe(subscriptionId: string) {
    const result = await this.#store.cancelSubscription(subscriptionId, this.#now())
    if (result === null) {
      const existing = (await this.#store.listSubscriptions()).find(
        (subscription) => subscription.id === subscriptionId,
      )
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

  async nudgeSource(input: unknown): Promise<boolean> {
    const sourceRef = eventExactRefSchema.parse(input)
    const source = await this.#store.getSource(sourceRef)
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
    return await this.#store.nudgeObserver(sourceRef, this.#now())
  }

  async observe(input: EventObservationInput) {
    let routingFacts: unknown = null
    if (input.routingFactsJson !== undefined && input.routingFactsJson !== null) {
      try {
        routingFacts = JSON.parse(input.routingFactsJson) as unknown
      } catch {
        throw new ValidationError(
          'event-routing-facts-invalid',
          'event routing facts must be valid JSON',
        )
      }
    }
    const { routingFactsJson: _routingFactsJson, ...transport } = input
    const observation = eventObservationSchema.parse({ ...transport, routingFacts })
    const eventType = await this.#store.getEventType(observation.eventTypeRef)
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
    return await this.#store.recordObservation({
      eventId: this.#id(),
      observation,
      eventType,
      observedAt: this.#now(),
      nextId: this.#id,
      routingSubscriptions: await this.#matchedRoutingSubscriptions(observation),
      triggerContext: this.#triggerContext(eventType, observation),
    })
  }

  async pendingDeliveries(input: unknown, limit: number) {
    const subscriber = eventSubscriberSchema.parse(input)
    return await this.#store.listPendingDeliveries(subscriber, limit)
  }

  async acceptDelivery(deliveryId: string): Promise<void> {
    if (!(await this.#store.acceptDelivery(deliveryId, this.#now()))) {
      throw new NotFoundError('event-delivery-not-found', `event delivery not found: ${deliveryId}`)
    }
  }

  async listCatalog() {
    const subscriptionCounts = new Map(await this.#store.activeSubscriptionCountsBySource())
    for (const subscription of await this.#routingSubscriptions.list()) {
      if (subscription.state !== 'active') continue
      const key = `${subscription.sourceRef.id}@${subscription.sourceRef.revision}`
      subscriptionCounts.set(key, (subscriptionCounts.get(key) ?? 0) + 1)
    }
    const eventTypes = (await this.#store.listEventTypes()).filter(
      (eventType) => (eventType.catalogVisibility ?? 'public') === 'public',
    )
    const publicSourceKeys = new Set(
      eventTypes.map((eventType) => `${eventType.sourceRef.id}@${eventType.sourceRef.revision}`),
    )
    return {
      sources: (await this.#store.listSources())
        .filter((source) =>
          publicSourceKeys.has(`${source.sourceRef.id}@${source.sourceRef.revision}`),
        )
        .map((source) => ({
          ...source,
          subscriptionCount:
            subscriptionCounts.get(`${source.sourceRef.id}@${source.sourceRef.revision}`) ?? 0,
        })),
      eventTypes,
    }
  }

  async listSubscriptions(subscriberRef?: string) {
    const exact = await this.#store.listSubscriptions(subscriberRef)
    const filtered = await this.#filteredSubscriptions(subscriberRef)
    return [...exact, ...filtered].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async listSubscriptionPage(input: { page: number; limit: number; subscriberRef?: string }) {
    const filtered = await this.#filteredSubscriptions(input.subscriberRef)
    const offset = (input.page - 1) * input.limit
    // At most every filtered definition can sort ahead of the requested page.
    // Fetch only that bounded displacement window from the large exact ledger,
    // then merge the complete (already materialized) routing directory in
    // memory. No scan of the exact subscription table is needed.
    const exactOffset = Math.max(0, offset - filtered.length)
    const exact = await this.#store.listSubscriptionPage({
      limit: input.limit + filtered.length,
      offset: exactOffset,
      ...(input.subscriberRef === undefined ? {} : { subscriberRef: input.subscriberRef }),
    })
    const merged = [...exact.items, ...filtered].sort((left, right) => {
      const byTime = right.updatedAt - left.updatedAt
      return byTime === 0 ? right.id.localeCompare(left.id) : byTime
    })
    const total = exact.total + filtered.length
    return {
      items: merged.slice(offset - exactOffset, offset - exactOffset + input.limit),
      total,
      page: input.page,
      pageCount: Math.max(1, Math.ceil(total / input.limit)),
    }
  }

  async #filteredSubscriptions(subscriberRef?: string) {
    return (await this.#routingSubscriptions.list())
      .filter(
        (subscription) =>
          subscriberRef === undefined || subscription.subscriber.subscriberRef === subscriberRef,
      )
      .map((subscription) => ({
        id: subscription.id,
        mode: 'filtered' as const,
        sourceRef: subscription.sourceRef,
        eventTypeRefs: subscription.eventTypeRefs,
        subjectTypeId: subscription.subjectTypeId,
        subscriber: subscription.subscriber,
        origin: {
          kind: 'routing-rule' as const,
          ref: subscription.id,
          definitionRevision: subscription.definitionRevision,
        },
        displayName: subscription.displayName,
        selector: subscription.selector,
        state: subscription.state,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      }))
  }

  async listDeliveryStatuses(limit = 200) {
    return (await this.#store.listDeliveryStatusPage({ limit, offset: 0 })).items
  }

  async listDeliveryStatusPage(input: {
    page: number
    limit: number
    state?: EventDeliveryStatusRecord['state']
    subscriberRef?: string
  }) {
    const result = await this.#store.listDeliveryStatusPage({
      limit: input.limit,
      offset: (input.page - 1) * input.limit,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.subscriberRef === undefined ? {} : { subscriberRef: input.subscriberRef }),
    })
    return {
      ...result,
      page: input.page,
      pageCount: Math.max(1, Math.ceil(result.total / input.limit)),
    }
  }

  async listEventRecordPage(input: { page: number; limit: number; sourceId?: string }) {
    const result = await this.#store.listEventRecordPage({
      limit: input.limit,
      offset: (input.page - 1) * input.limit,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    })
    return {
      ...result,
      page: input.page,
      pageCount: Math.max(1, Math.ceil(result.total / input.limit)),
    }
  }

  async observerHealth() {
    return await this.#store.listObserverActivations()
  }

  async listCustomSources() {
    return (await this.#customSources.list()).map((record) => {
      const draftDigest = customEventSourceDraftDigest(record.draft)
      return {
        id: record.id,
        displayName: record.draft.displayName,
        description: record.draft.description,
        pollIntervalMs: record.draft.pollIntervalMs,
        batchSize: record.draft.batchSize,
        ingestionMode: record.draft.ingestionMode,
        eventTypeCount: record.draft.eventTypes.length,
        publishedRevision: record.publishedRevision,
        state:
          record.retiredAt !== null
            ? ('retired' as const)
            : record.publishedRevision === null
              ? ('draft' as const)
              : record.publishedDigest === draftDigest
                ? ('published' as const)
                : ('changed' as const),
        updatedAt: record.updatedAt,
      }
    })
  }

  async getCustomSource(id: string) {
    const record = await this.#customSources.get(id)
    if (record === null) {
      throw new NotFoundError(
        'custom-event-source-not-found',
        `custom event source not found: ${id}`,
      )
    }
    return record
  }

  async createCustomSource(input: unknown, ownerUserId: string | null) {
    const draft = customEventSourceDraftSchema.parse(input)
    return await this.#customSources.create({
      id: this.#id(),
      draft,
      ownerUserId,
      now: this.#now(),
    })
  }

  async updateCustomSource(id: string, input: unknown) {
    const draft = customEventSourceDraftSchema.parse(input)
    const updated = await this.#customSources.update({ id, draft, now: this.#now() })
    if (updated === null) {
      const existing = await this.#customSources.get(id)
      if (existing === null) {
        throw new NotFoundError(
          'custom-event-source-not-found',
          `custom event source not found: ${id}`,
        )
      }
      throw new ConflictError('custom-event-source-retired', 'retired event sources are read-only')
    }
    return updated
  }

  async validateCustomSource(id: string) {
    const record = await this.getCustomSource(id)
    if (record.retiredAt !== null) {
      throw new ConflictError('custom-event-source-retired', 'retired event sources are read-only')
    }
    const revision = (record.publishedRevision ?? 0) + 1
    try {
      return await this.#customObserver.validate({
        sourceRef: { id, revision },
        draft: record.draft,
        now: this.#now(),
      })
    } catch (error) {
      throw new ValidationError(
        'custom-event-source-fixture-failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async publishCustomSource(id: string, actorUserId: string | null) {
    const record = await this.getCustomSource(id)
    if (record.retiredAt !== null) {
      throw new ConflictError('custom-event-source-retired', 'retired event sources are read-only')
    }
    const revision = (record.publishedRevision ?? 0) + 1
    const sourceRef = { id, revision }
    const receipt = await this.validateCustomSource(id)
    const digest = customEventSourceDraftDigest(record.draft)
    if (receipt.draftDigest !== digest) {
      throw new ConflictError(
        'custom-event-source-draft-changed',
        'event source draft changed while its fixture was running',
      )
    }
    const source = eventSourceDescriptorSchema.parse({
      schemaVersion: 1,
      sourceRef,
      ownerTypeId: 'event-center.custom',
      displayName: record.draft.displayName,
      description: record.draft.description,
      observationMode: 'active',
      observerProgramRef: sourceRef,
      pollIntervalMs: record.draft.pollIntervalMs,
      batchSize: record.draft.batchSize,
    })
    const eventTypes = record.draft.eventTypes.map((event) =>
      eventTypeDescriptorSchema.parse({
        schemaVersion: 1,
        eventTypeRef: { id: customEventTypeId(id, event.eventKey), revision },
        sourceRef,
        ownerTypeId: 'event-center.custom',
        subjectTypeId: event.subjectTypeId,
        payloadSchemaId: event.payloadSchemaId,
        displayName: event.displayName,
        description: event.description,
        deliveryClass: event.deliveryClass,
        triggerParameters: event.triggerParameters,
      }),
    )
    return await this.#customSources.publish({
      id,
      revision,
      draft: record.draft,
      digest,
      validationReceipt: receipt,
      source,
      eventTypes,
      actorUserId,
      now: this.#now(),
    })
  }

  async retireCustomSource(id: string): Promise<void> {
    if (!(await this.#customSources.retire(id, this.#now()))) {
      if ((await this.#customSources.get(id)) === null) {
        throw new NotFoundError(
          'custom-event-source-not-found',
          `custom event source not found: ${id}`,
        )
      }
    }
  }

  async runOneDueObserver(): Promise<'completed' | 'failed' | 'obsolete' | 'idle'> {
    const run = await this.#store.claimDueObserver({
      now: this.#now(),
      leaseOwner: this.#workerId,
      leaseMs: this.#observerLeaseMs,
      runId: this.#id(),
    })
    if (run === null) return 'idle'
    try {
      const custom = await this.#customSources.getPublished(run.source.sourceRef)
      const observer = custom === null ? this.#observer : this.#customObserver
      const batch = observerBatchSchema.parse(
        await observer.run({
          source: run.source,
          subjects: run.subjects,
          cursorJson: run.cursorJson,
        }),
      )
      const subjectKeys = new Set(
        run.subjects.map((subject) => `${subject.typeId}\u0000${subject.subjectRef}`),
      )
      const observations = await Promise.all(
        batch.observations.map(async (observation) => {
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
          const eventType = await this.#store.getEventType(observation.eventTypeRef)
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
          return {
            eventId: this.#id(),
            observation,
            eventType,
            routingSubscriptions: await this.#matchedRoutingSubscriptions(observation),
            triggerContext: this.#triggerContext(eventType, observation),
          }
        }),
      )
      return await this.#store.settleObserver({
        run,
        now: this.#now(),
        cursorJson: batch.cursorJson,
        observations,
        nextId: this.#id,
        errorCode: null,
        errorDetail: null,
      })
    } catch (error) {
      return await this.#store.settleObserver({
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

  async runOneNotification(
    deliveryId?: string,
  ): Promise<'completed' | 'retried' | 'dead-letter' | 'idle'> {
    const subscriberKinds = [
      ...new Set(this.#deliveryConsumers.map((consumer) => consumer.subscriberKind)),
    ]
    const delivery = await this.#store.claimNotificationDelivery({
      ...(deliveryId === undefined ? {} : { deliveryId }),
      subscriberKinds,
      now: this.#now(),
      leaseOwner: this.#workerId,
      leaseMs: this.#deliveryLeaseMs,
    })
    if (delivery === null) return 'idle'

    let consumer: EventDeliveryConsumerPort | undefined
    for (const candidate of this.#deliveryConsumers) {
      if (
        candidate.subscriberKind === delivery.subscriber.kind &&
        (await candidate.canConsume(delivery.subscriber.subscriberRef))
      ) {
        consumer = candidate
        break
      }
    }
    if (consumer === undefined) {
      await this.#settleDelivery({
        deliveryId: delivery.deliveryId,
        attemptCount: delivery.attemptCount,
        state: 'dead-letter',
        nextAttemptAt: this.#now(),
        error: `event delivery consumer unavailable: ${delivery.subscriber.kind}/${delivery.subscriber.subscriberRef}`,
      })
      return 'dead-letter'
    }

    try {
      await consumer.consume(delivery)
      await this.#settleDelivery({
        deliveryId: delivery.deliveryId,
        attemptCount: delivery.attemptCount,
        state: 'accepted',
        nextAttemptAt: this.#now(),
        error: null,
      })
      return 'completed'
    } catch (error) {
      const limits = this.#deliveryRetryLimits.current()
      const maxAttempts =
        1 +
        Math.max(0, Math.trunc(limits.defaultNodeRetries)) +
        Math.max(0, Math.trunc(limits.sessionRestartBudget))
      const terminal = delivery.attemptCount >= maxAttempts
      const now = this.#now()
      const nextAttemptAt = terminal
        ? now
        : now + Math.min(30_000, 1_000 * 2 ** Math.max(0, delivery.attemptCount - 1))
      await this.#settleDelivery({
        deliveryId: delivery.deliveryId,
        attemptCount: delivery.attemptCount,
        state: terminal ? 'dead-letter' : 'pending',
        nextAttemptAt,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      })
      return terminal ? 'dead-letter' : 'retried'
    }
  }

  async #settleDelivery(input: {
    readonly deliveryId: string
    readonly attemptCount: number
    readonly state: 'accepted' | 'pending' | 'dead-letter'
    readonly nextAttemptAt: number
    readonly error: string | null
  }): Promise<void> {
    if (
      !(await this.#store.settleNotificationDelivery({
        ...input,
        leaseOwner: this.#workerId,
        now: this.#now(),
      }))
    ) {
      throw new ConflictError(
        'event-delivery-lease-lost',
        `event delivery lease was lost: ${input.deliveryId}`,
      )
    }
  }

  async #matchedRoutingSubscriptions(observation: z.infer<typeof eventObservationSchema>) {
    const matches = await this.#routingSubscriptions.match(observation)
    const seen = new Set<string>()
    return matches.map((match) => {
      const definition = match.definition
      eventExactRefSchema.parse(definition.sourceRef)
      eventExactRefSchema.parse(match.eventTypeRef)
      eventSubscriberSchema.parse(definition.subscriber)
      z.string().min(1).max(500).parse(match.materializedSubscriptionId)
      if (definition.state !== 'active') {
        throw new ValidationError(
          'event-routing-subscription-inactive',
          `routing directory matched an inactive subscription: ${definition.id}`,
        )
      }
      if (
        definition.sourceRef.id !== observation.sourceRef.id ||
        definition.sourceRef.revision !== observation.sourceRef.revision ||
        match.eventTypeRef.id !== observation.eventTypeRef.id ||
        match.eventTypeRef.revision !== observation.eventTypeRef.revision ||
        definition.subjectTypeId !== observation.subject.typeId ||
        !definition.eventTypeRefs.some(
          (ref) =>
            ref.id === observation.eventTypeRef.id &&
            ref.revision === observation.eventTypeRef.revision,
        )
      ) {
        throw new ValidationError(
          'event-routing-subscription-mismatch',
          `routing directory returned a mismatched subscription: ${definition.id}`,
        )
      }
      if (seen.has(match.materializedSubscriptionId)) {
        throw new ValidationError(
          'event-routing-subscription-duplicate',
          `routing directory returned duplicate materialization: ${match.materializedSubscriptionId}`,
        )
      }
      seen.add(match.materializedSubscriptionId)
      return match
    })
  }

  #triggerContext(
    eventType: z.infer<typeof eventTypeDescriptorSchema>,
    observation: z.infer<typeof eventObservationSchema>,
  ) {
    const contract = eventType.triggerParameters
    if (contract === null) {
      if (observation.triggerParameters !== null) {
        throw new ValidationError(
          'event-trigger-parameters-undeclared',
          `event type does not declare trigger parameters: ${eventType.eventTypeRef.id}`,
        )
      }
      return null
    }
    if (observation.triggerParameters === null) {
      throw new ValidationError(
        'event-trigger-parameters-missing',
        `event observation is missing trigger parameters: ${eventType.eventTypeRef.id}`,
      )
    }
    return createTriggerContext({
      namespace: contract.namespace,
      definitionRef: eventType.eventTypeRef,
      availableFields: contract.fields.map((field) => field.fieldId),
      values: observation.triggerParameters,
    })
  }
}
