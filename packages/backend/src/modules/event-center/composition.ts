import type { DbClient } from '@/db/client'
import { EventCenterService } from './application/eventCenterService'
import type { EventObserverProgramPort } from './composition/required-ports'
import { createSqliteEventStore } from './infrastructure/sqliteEventStore'
import type { EventObservationCommandPort } from './public/commands'
import type { EventCenterParticipant, EventObserverControlParticipant } from './public/participants'
import type { EventCenterQueryPort } from './public/queries'

export interface EventCenterModule {
  readonly commands: EventObservationCommandPort
  readonly participant: EventCenterParticipant
  readonly observerControl: EventObserverControlParticipant
  readonly queries: EventCenterQueryPort
  readonly worker: {
    runOneDueObserver(): Promise<'completed' | 'failed' | 'obsolete' | 'idle'>
  }
}

export interface ComposeEventCenterOptions {
  readonly db: DbClient
  readonly typePackageDescriptorJsons: readonly string[]
  readonly observer?: EventObserverProgramPort
  readonly now?: () => number
  readonly id?: () => string
  readonly workerId?: string
  readonly observerLeaseMs?: number
}

export function composeEventCenter(options: ComposeEventCenterOptions): EventCenterModule {
  const service = new EventCenterService({
    store: createSqliteEventStore(options.db),
    typePackageDescriptorJsons: options.typePackageDescriptorJsons,
    observer: options.observer ?? {
      async run(input) {
        throw new Error(
          `observer program unavailable: ${input.source.observerProgramRef?.id ?? input.source.sourceRef.id}`,
        )
      },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.observerLeaseMs === undefined ? {} : { observerLeaseMs: options.observerLeaseMs }),
  })

  const participant: EventCenterParticipant = {
    subscribe: (input) => service.subscribe(input),
    unsubscribe: (subscriptionId) => service.unsubscribe(subscriptionId),
    observe: (input) => service.observe(input),
    pendingDeliveries: (subscriber, limit) =>
      service.pendingDeliveries(subscriber, limit).map((delivery) => ({
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        eventTypeRef: delivery.eventTypeRef,
        sourceRef: delivery.sourceRef,
        subject: delivery.subject,
        deliveryClass: delivery.deliveryClass,
        priority: delivery.priority,
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
      catalogJson: () => JSON.stringify(service.listCatalog()),
      subscriptionsJson: (subscriberRef) =>
        JSON.stringify(service.listSubscriptions(subscriberRef ?? undefined)),
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
    worker: { runOneDueObserver: () => service.runOneDueObserver() },
  }
}
