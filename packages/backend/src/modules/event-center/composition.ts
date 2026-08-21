import type { DbClient } from '@/db/client'
import { EventCenterService } from './application/eventCenterService'
import {
  createEventResponseDeliveryConsumer,
  createEventResponseRoutingDirectory,
  EventResponseRuleService,
} from './application/eventResponseRules'
import type {
  EventAutomationWorkStartPort,
  EventDeliveryConsumerPort,
  EventDeliveryRetryLimitsPort,
  EventObserverProgramPort,
  EventRoutingSubscriptionDirectoryPort,
} from './composition/required-ports'
import { createCustomEventObserverProgram } from './infrastructure/customEventObserverProgram'
import { createSqliteCustomEventSourceStore } from './infrastructure/sqliteCustomEventSourceStore'
import { createSqliteEventStore } from './infrastructure/sqliteEventStore'
import { createSqliteEventResponseRuleStore } from './infrastructure/sqliteEventResponseRuleStore'
import type { EventObservationCommandPort } from './public/commands'
import type { EventCenterParticipant, EventObserverControlParticipant } from './public/participants'
import type { EventCenterCatalogQueryPort, EventCenterOperationsQueryPort } from './public/queries'

export { runEventCenterCycle, startEventCenterWorker } from './application/eventCenterWorker'

export interface EventCenterModule {
  readonly commands: EventObservationCommandPort
  readonly participant: EventCenterParticipant
  readonly observerControl: EventObserverControlParticipant
  readonly queries: {
    readonly catalog: EventCenterCatalogQueryPort
    readonly operations: EventCenterOperationsQueryPort
  }
  readonly customSources: {
    readonly commands: {
      create(
        input: unknown,
        ownerUserId: string | null,
      ): ReturnType<EventCenterService['createCustomSource']>
      update(id: string, input: unknown): ReturnType<EventCenterService['updateCustomSource']>
      validate(id: string): ReturnType<EventCenterService['validateCustomSource']>
      publish(
        id: string,
        actorUserId: string | null,
      ): ReturnType<EventCenterService['publishCustomSource']>
      retire(id: string): void
    }
    readonly queries: {
      list(): ReturnType<EventCenterService['listCustomSources']>
      get(id: string): ReturnType<EventCenterService['getCustomSource']>
    }
  }
  readonly responseRules: {
    readonly commands: {
      create(input: unknown, ownerUserId: string): ReturnType<EventResponseRuleService['create']>
      update(id: string, input: unknown): ReturnType<EventResponseRuleService['update']>
      remove(id: string): void
    }
    readonly queries: {
      list(): ReturnType<EventResponseRuleService['list']>
      get(id: string): ReturnType<EventResponseRuleService['get']>
    }
  }
  readonly worker: {
    runOneDueObserver(): Promise<'completed' | 'failed' | 'obsolete' | 'idle'>
    runOneNotification(
      deliveryId?: string,
    ): Promise<'completed' | 'retried' | 'dead-letter' | 'idle'>
  }
}

export interface ComposeEventCenterOptions {
  readonly db: DbClient
  readonly typePackageDescriptorJsons: readonly string[]
  readonly observer?: EventObserverProgramPort
  readonly routingSubscriptions?: EventRoutingSubscriptionDirectoryPort
  readonly deliveryConsumers?: readonly EventDeliveryConsumerPort[]
  readonly deliveryRetryLimits?: EventDeliveryRetryLimitsPort
  readonly automationWorkStart?: EventAutomationWorkStartPort
  readonly now?: () => number
  readonly id?: () => string
  readonly workerId?: string
  readonly observerLeaseMs?: number
  readonly deliveryLeaseMs?: number
}

export function composeEventCenter(options: ComposeEventCenterOptions): EventCenterModule {
  const eventStore = createSqliteEventStore(options.db)
  const customSources = createSqliteCustomEventSourceStore(options.db)
  const responseRuleStore = createSqliteEventResponseRuleStore(options.db)
  const responseRules = new EventResponseRuleService({
    rules: responseRuleStore,
    events: eventStore,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.id === undefined ? {} : { id: options.id }),
  })
  const customObserver = createCustomEventObserverProgram({
    store: customSources,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const responseDirectory = createEventResponseRoutingDirectory(responseRuleStore)
  const externalDirectory = options.routingSubscriptions ?? { list: () => [], match: () => [] }
  const service = new EventCenterService({
    store: eventStore,
    customSources,
    typePackageDescriptorJsons: options.typePackageDescriptorJsons,
    observer: options.observer ?? {
      async run(input) {
        throw new Error(
          `observer program unavailable: ${input.source.observerProgramRef?.id ?? input.source.sourceRef.id}`,
        )
      },
    },
    customObserver,
    routingSubscriptions: {
      list: () => [...responseDirectory.list(), ...externalDirectory.list()],
      match: (observation) => [
        ...responseDirectory.match(observation),
        ...externalDirectory.match(observation),
      ],
    },
    deliveryConsumers: [
      ...(options.automationWorkStart === undefined
        ? []
        : [
            createEventResponseDeliveryConsumer({
              rules: responseRuleStore,
              workStart: options.automationWorkStart,
              ...(options.now === undefined ? {} : { now: options.now }),
            }),
          ]),
      ...(options.deliveryConsumers ?? []),
    ],
    deliveryRetryLimits: options.deliveryRetryLimits ?? {
      current: () => ({ defaultNodeRetries: 3, sessionRestartBudget: 1 }),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.observerLeaseMs === undefined ? {} : { observerLeaseMs: options.observerLeaseMs }),
    ...(options.deliveryLeaseMs === undefined ? {} : { deliveryLeaseMs: options.deliveryLeaseMs }),
  })

  const participant: EventCenterParticipant = {
    subscribe: (input) => service.subscribe(input),
    unsubscribe: (subscriptionId) => service.unsubscribe(subscriptionId),
    observe: (input) => service.observe(input),
    pendingDeliveries: (subscriber, limit) =>
      service.pendingDeliveries(subscriber, limit).map((delivery) => ({
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        subscriptionId: delivery.subscriptionId,
        eventTypeRef: delivery.eventTypeRef,
        sourceRef: delivery.sourceRef,
        subject: delivery.subject,
        deliveryClass: delivery.deliveryClass,
        occurredAt: delivery.occurredAt,
        summary: delivery.summary,
        payloadArtifactRef: delivery.payloadArtifactRef,
      })),
    acceptDelivery: (deliveryId) => service.acceptDelivery(deliveryId),
  }

  return {
    commands: { observe: participant.observe },
    participant,
    observerControl: { nudgeSource: (sourceRef) => service.nudgeSource(sourceRef) },
    queries: {
      catalog: {
        catalogJson: () => JSON.stringify(service.listCatalog()),
        subscriptionsJson: (subscriberRef) =>
          JSON.stringify(service.listSubscriptions(subscriberRef ?? undefined)),
        subscriptionPageJson: (input) =>
          JSON.stringify(
            service.listSubscriptionPage({
              page: input.page,
              limit: input.limit,
              ...(input.subscriberRef === null ? {} : { subscriberRef: input.subscriberRef }),
            }),
          ),
      },
      operations: {
        deliveryStatuses: () =>
          service.listDeliveryStatuses().map((delivery) => ({
            deliveryId: delivery.deliveryId,
            eventId: delivery.eventId,
            subscriptionId: delivery.subscriptionId,
            subscriber: delivery.subscriber,
            eventTypeRef: delivery.eventTypeRef,
            subject: delivery.subject,
            state: delivery.state,
            attemptCount: delivery.attemptCount,
            nextAttemptAt: delivery.nextAttemptAt,
            lastError: delivery.lastError,
            createdAt: delivery.createdAt,
          })),
        deliveryStatusPage: (input) => {
          const page = service.listDeliveryStatusPage({
            page: input.page,
            limit: input.limit,
            ...(input.state === null ? {} : { state: input.state }),
            ...(input.subscriberRef === null ? {} : { subscriberRef: input.subscriberRef }),
          })
          return {
            ...page,
            items: page.items.map((delivery) => ({
              deliveryId: delivery.deliveryId,
              eventId: delivery.eventId,
              subscriptionId: delivery.subscriptionId,
              subscriber: delivery.subscriber,
              eventTypeRef: delivery.eventTypeRef,
              subject: delivery.subject,
              state: delivery.state,
              attemptCount: delivery.attemptCount,
              nextAttemptAt: delivery.nextAttemptAt,
              lastError: delivery.lastError,
              createdAt: delivery.createdAt,
            })),
          }
        },
        eventRecordPage: (input) => {
          const page = service.listEventRecordPage({
            page: input.page,
            limit: input.limit,
            ...(input.sourceId === null ? {} : { sourceId: input.sourceId }),
          })
          return {
            ...page,
            items: page.items.map((event) => ({
              eventId: event.eventId,
              eventTypeRef: event.eventTypeRef,
              sourceRef: event.sourceRef,
              subject: event.subject,
              occurredAt: event.occurredAt,
              observedAt: event.observedAt,
              summary: event.summary,
              payloadArtifactRef: event.payloadArtifactRef,
            })),
          }
        },
        observerHealth: () =>
          service.observerHealth().map((activation) => ({
            sourceRef: activation.sourceRef,
            subscriberCount: activation.subscriberCount,
            state: activation.state,
            nextScanAt: activation.nextScanAt,
            lastSuccessAt: activation.lastSuccessAt,
            lastErrorCode: activation.lastErrorCode,
          })),
      },
    },
    customSources: {
      commands: {
        create: (input, ownerUserId) => service.createCustomSource(input, ownerUserId),
        update: (id, input) => service.updateCustomSource(id, input),
        validate: (id) => service.validateCustomSource(id),
        publish: (id, actorUserId) => service.publishCustomSource(id, actorUserId),
        retire: (id) => service.retireCustomSource(id),
      },
      queries: {
        list: () => service.listCustomSources(),
        get: (id) => service.getCustomSource(id),
      },
    },
    responseRules: {
      commands: {
        create: (input, ownerUserId) => responseRules.create(input, ownerUserId),
        update: (id, input) => responseRules.update(id, input),
        remove: (id) => responseRules.remove(id),
      },
      queries: {
        list: () => responseRules.list(),
        get: (id) => responseRules.get(id),
      },
    },
    worker: {
      runOneDueObserver: () => service.runOneDueObserver(),
      runOneNotification: (deliveryId) => service.runOneNotification(deliveryId),
    },
  }
}
