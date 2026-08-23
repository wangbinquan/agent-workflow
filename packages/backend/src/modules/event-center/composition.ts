import type { DbClient } from '@/db/client'
import { EventCenterService } from './application/eventCenterService'
import {
  createEventResponseDeliveryConsumer,
  createEventResponseRoutingDirectory,
  EventResponseRuleService,
  type TargetLaunchPermissions,
  type ResponseRuleWritePrincipal,
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
      create(
        input: unknown,
        principal: ResponseRuleWritePrincipal,
      ): ReturnType<EventResponseRuleService['create']>
      update(
        id: string,
        input: unknown,
        principal: ResponseRuleWritePrincipal,
      ): ReturnType<EventResponseRuleService['update']>
      remove(id: string, principal: ResponseRuleWritePrincipal): void
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

/**
 * RFC-317 T30（DE-04）—— 每类响应目标的启动权限门，**装配层的数据**。
 *
 * 原先这张对应关系散在 `EventResponseRuleService` 的判据里：
 * `if (draft.target.kind === 'digital-employee' && !principal.canLaunchDigitalEmployee)`
 * 外加写死的 `'development-missions:launch'`。也就是说 event-center 的**应用层**
 * 认识了「数字员工」这一类目标，还认识了 development-automation 的权限词汇——第二类
 * 目标要加权限门，只能回来改那段判据和 `ResponseRuleWritePrincipal` 接口。
 *
 * 现在判据只问「这一类要哪个权限点」，对应关系作为数据落在装配层：跨 context 的词汇
 * 本来就该在装配处相遇，而不是渗进领域判据。类型是**穷尽** `Record`，所以
 * `eventResponseTargetSchema` 加一类目标时这里编译不过，逼作者当场决定它的权限门。
 */
export const DEFAULT_TARGET_LAUNCH_PERMISSIONS: TargetLaunchPermissions = {
  workflow: null,
  agent: null,
  workgroup: null,
  'digital-employee': 'development-missions:launch',
}

export interface ComposeEventCenterOptions {
  readonly db: DbClient
  readonly typePackageDescriptorJsons: readonly string[]
  /**
   * RFC-317 T30（DE-04）—— 每类响应目标的启动权限门。省略时用
   * `DEFAULT_TARGET_LAUNCH_PERMISSIONS`；给了就整表覆盖。
   */
  readonly targetLaunchPermissions?: TargetLaunchPermissions
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
    targetLaunchPermissions: options.targetLaunchPermissions ?? DEFAULT_TARGET_LAUNCH_PERMISSIONS,
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
        create: (input, principal) => responseRules.create(input, principal),
        update: (id, input, principal) => responseRules.update(id, input, principal),
        remove: (id, principal) => responseRules.remove(id, principal),
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
