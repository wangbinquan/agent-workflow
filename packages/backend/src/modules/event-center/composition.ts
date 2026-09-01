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
import { createPostgresqlEventStore } from './infrastructure/postgresqlEventStore'
import { createPostgresqlCustomEventSourceStore } from './infrastructure/postgresqlCustomEventSourceStore'
import { createPostgresqlEventResponseRuleStore } from './infrastructure/postgresqlEventResponseRuleStore'
import type { CustomEventSourceStorePort } from './application/ports/customEventSourceStore'
import type { EventStorePort } from './application/ports/eventStore'
import type { EventResponseRuleStorePort } from './application/ports/responseRuleStore'
import type { EventObservationCommandPort } from './public/commands'
import type { EventCenterParticipant, EventObserverControlParticipant } from './public/participants'
import type { EventCenterCatalogQueryPort, EventCenterOperationsQueryPort } from './public/queries'
import type { CommittedEventDeliveryPersistencePort } from '@/platform/events/committed/persistence'
import { createSqliteCommittedEventDeliveryPersistence } from '@/platform/events/committed/sqlitePersistence'
import { createPostgresqlCommittedEventDeliveryPersistence } from '@/platform/events/committed/postgresqlPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  CommittedEventDeliveryPage,
  CommittedEventDeliveryState,
  CommittedEventFamily,
  CommittedEventProducer,
  ManualCommittedEventRetryInput,
  ManualCommittedEventRetryReceipt,
} from '@/platform/events/committed/types'

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
      retire(id: string): ReturnType<EventCenterService['retireCustomSource']>
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
      remove(
        id: string,
        principal: ResponseRuleWritePrincipal,
      ): ReturnType<EventResponseRuleService['remove']>
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
  readonly committedEvents: {
    readonly queries: {
      deliveryPage(input: {
        page: number
        limit: number
        stage: 'producer-publication' | 'consumer-delivery' | null
        state: CommittedEventDeliveryState | null
        producer: CommittedEventProducer | null
        family: CommittedEventFamily | null
        aggregateId: string | null
        consumerId: string | null
      }): Promise<CommittedEventDeliveryPage>
    }
    readonly commands: {
      retry(input: ManualCommittedEventRetryInput): Promise<ManualCommittedEventRetryReceipt>
    }
  }
}

/**
 * Keep the legacy synchronous HTTP app factory usable while Event Center
 * persistence performs its asynchronous catalog registration. Production
 * bootstrap awaits and injects the concrete module; direct SQLite route tests
 * use this facade, whose every operation waits for the same initialization
 * promise before touching the service.
 */
export function deferEventCenterModule(pending: Promise<EventCenterModule>): EventCenterModule {
  const resolve = async (): Promise<EventCenterModule> => await pending
  const participant: EventCenterParticipant = {
    subscribe: async (input) => await (await resolve()).participant.subscribe(input),
    unsubscribe: async (subscriptionId) =>
      await (await resolve()).participant.unsubscribe(subscriptionId),
    observe: async (input) => await (await resolve()).participant.observe(input),
    pendingDeliveries: async (subscriber, limit) =>
      await (await resolve()).participant.pendingDeliveries(subscriber, limit),
    acceptDelivery: async (deliveryId) =>
      await (await resolve()).participant.acceptDelivery(deliveryId),
  }

  const deferred: EventCenterModule = {
    commands: {
      observe: async (input) => await participant.observe(input),
    },
    participant: Object.freeze(participant),
    observerControl: {
      nudgeSource: async (sourceRef) =>
        await (await resolve()).observerControl.nudgeSource(sourceRef),
    },
    queries: {
      catalog: {
        catalogJson: async () => await (await resolve()).queries.catalog.catalogJson(),
        subscriptionsJson: async (subscriberRef) =>
          await (await resolve()).queries.catalog.subscriptionsJson(subscriberRef),
        subscriptionPageJson: async (input) =>
          await (await resolve()).queries.catalog.subscriptionPageJson(input),
      },
      operations: {
        deliveryStatuses: async () => await (await resolve()).queries.operations.deliveryStatuses(),
        deliveryStatusPage: async (input) =>
          await (await resolve()).queries.operations.deliveryStatusPage(input),
        eventRecordPage: async (input) =>
          await (await resolve()).queries.operations.eventRecordPage(input),
        observerHealth: async () => await (await resolve()).queries.operations.observerHealth(),
      },
    },
    customSources: {
      commands: {
        create: async (input, ownerUserId) =>
          await (await resolve()).customSources.commands.create(input, ownerUserId),
        update: async (id, input) =>
          await (await resolve()).customSources.commands.update(id, input),
        validate: async (id) => await (await resolve()).customSources.commands.validate(id),
        publish: async (id, actorUserId) =>
          await (await resolve()).customSources.commands.publish(id, actorUserId),
        retire: async (id) => await (await resolve()).customSources.commands.retire(id),
      },
      queries: {
        list: async () => await (await resolve()).customSources.queries.list(),
        get: async (id) => await (await resolve()).customSources.queries.get(id),
      },
    },
    responseRules: {
      commands: {
        create: async (input, principal) =>
          await (await resolve()).responseRules.commands.create(input, principal),
        update: async (id, input, principal) =>
          await (await resolve()).responseRules.commands.update(id, input, principal),
        remove: async (id, principal) =>
          await (await resolve()).responseRules.commands.remove(id, principal),
      },
      queries: {
        list: async () => await (await resolve()).responseRules.queries.list(),
        get: async (id) => await (await resolve()).responseRules.queries.get(id),
      },
    },
    worker: {
      runOneDueObserver: async () => await (await resolve()).worker.runOneDueObserver(),
      runOneNotification: async (deliveryId) =>
        await (await resolve()).worker.runOneNotification(deliveryId),
    },
    committedEvents: {
      queries: {
        deliveryPage: async (input) =>
          await (await resolve()).committedEvents.queries.deliveryPage(input),
      },
      commands: {
        retry: async (input) => await (await resolve()).committedEvents.commands.retry(input),
      },
    },
  }
  return Object.freeze(deferred)
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

export interface EventCenterPersistence {
  readonly events: EventStorePort
  readonly customSources: CustomEventSourceStorePort
  readonly responseRules: EventResponseRuleStorePort
  readonly committedEvents: CommittedEventDeliveryPersistencePort
}

export type ComposeEventCenterWithPortsOptions = Omit<ComposeEventCenterOptions, 'db'> & {
  readonly persistence: EventCenterPersistence
}

export async function composeEventCenterWithPorts(
  options: ComposeEventCenterWithPortsOptions,
): Promise<EventCenterModule> {
  const eventStore = options.persistence.events
  const customSources = options.persistence.customSources
  const responseRuleStore = options.persistence.responseRules
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
  const externalDirectory =
    options.routingSubscriptions ??
    ({
      async list() {
        return []
      },
      async match() {
        return []
      },
    } satisfies EventRoutingSubscriptionDirectoryPort)
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
      async list() {
        return [...(await responseDirectory.list()), ...(await externalDirectory.list())]
      },
      async match(observation) {
        return [
          ...(await responseDirectory.match(observation)),
          ...(await externalDirectory.match(observation)),
        ]
      },
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
  await service.initialize()

  const participant: EventCenterParticipant = {
    subscribe: async (input) => await service.subscribe(input),
    unsubscribe: async (subscriptionId) => await service.unsubscribe(subscriptionId),
    observe: async (input) => await service.observe(input),
    pendingDeliveries: async (subscriber, limit) =>
      (await service.pendingDeliveries(subscriber, limit)).map((delivery) => ({
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
    acceptDelivery: async (deliveryId) => await service.acceptDelivery(deliveryId),
  }

  return {
    commands: { observe: participant.observe },
    participant,
    observerControl: { nudgeSource: async (sourceRef) => await service.nudgeSource(sourceRef) },
    queries: {
      catalog: {
        catalogJson: async () => JSON.stringify(await service.listCatalog()),
        subscriptionsJson: async (subscriberRef) =>
          JSON.stringify(await service.listSubscriptions(subscriberRef ?? undefined)),
        subscriptionPageJson: async (input) =>
          JSON.stringify(
            await service.listSubscriptionPage({
              page: input.page,
              limit: input.limit,
              ...(input.subscriberRef === null ? {} : { subscriberRef: input.subscriberRef }),
            }),
          ),
      },
      operations: {
        deliveryStatuses: async () =>
          (await service.listDeliveryStatuses()).map((delivery) => ({
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
        deliveryStatusPage: async (input) => {
          const page = await service.listDeliveryStatusPage({
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
        eventRecordPage: async (input) => {
          const page = await service.listEventRecordPage({
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
        observerHealth: async () =>
          (await service.observerHealth()).map((activation) => ({
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
    committedEvents: {
      queries: {
        deliveryPage: async (input) =>
          await options.persistence.committedEvents.deliveryPage(input),
      },
      commands: {
        retry: async (input) => await options.persistence.committedEvents.retry(input),
      },
    },
  }
}

export async function composeEventCenter(
  options: ComposeEventCenterOptions,
): Promise<EventCenterModule> {
  const { db, ...shared } = options
  return await composeEventCenterWithPorts({
    ...shared,
    persistence: {
      events: createSqliteEventStore(db),
      customSources: createSqliteCustomEventSourceStore(db),
      responseRules: createSqliteEventResponseRuleStore(db),
      committedEvents: createSqliteCommittedEventDeliveryPersistence(db),
    },
  })
}

export async function composePostgresqlEventCenter(
  options: Omit<ComposeEventCenterOptions, 'db'> & {
    readonly db: PostgresqlDatabaseClient
  },
): Promise<EventCenterModule> {
  const { db, ...shared } = options
  return await composeEventCenterWithPorts({
    ...shared,
    persistence: {
      events: createPostgresqlEventStore(db),
      customSources: createPostgresqlCustomEventSourceStore(db),
      responseRules: createPostgresqlEventResponseRuleStore(db),
      committedEvents: createPostgresqlCommittedEventDeliveryPersistence(db),
    },
  })
}
