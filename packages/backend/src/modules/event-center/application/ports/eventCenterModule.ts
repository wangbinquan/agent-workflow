// RFC-436: the route-facing handle of Event Center. Its only production
// consumer is this module's own HTTP binding (`inbound/http/eventCenterRoutes`);
// bootstrap and integration reach the same type through `composition.ts`.
// Kept out of `public/`: an administration surface with no cross-context
// consumer is not part of the module contract (RFC-294 design §3.3).
import type {
  CommittedEventDeliveryPage,
  CommittedEventDeliveryState,
  CommittedEventFamily,
  CommittedEventProducer,
  ManualCommittedEventRetryInput,
  ManualCommittedEventRetryReceipt,
} from '@/platform/events/committed/types'
import type { EventObservationCommandPort } from '../../public/commands'
import type {
  EventCenterParticipant,
  EventObserverControlParticipant,
} from '../../public/participants'
import type {
  EventCenterCatalogQueryPort,
  EventCenterOperationsQueryPort,
} from '../../public/queries'
import type { EventCenterService } from '../eventCenterService'
import type { EventResponseRuleService, ResponseRuleWritePrincipal } from '../eventResponseRules'

export interface EventCenterModule {
  readonly initialize: () => Promise<void>
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
