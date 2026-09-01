import type {
  EventDeliveryRecord,
  EventObservation,
  EventSourceDescriptor,
  EventSubject,
  EventSubscriber,
  FilteredEventSubscriptionDefinition,
  MatchedFilteredEventSubscription,
  ObserverBatch,
} from '../domain/model'
import type {
  CustomEventSourceDraft,
  CustomEventSourceValidationReceipt,
} from '../domain/customEventSource'
import type { EventResponseTarget } from '../domain/responseRule'
import type { TriggerContext } from '@agent-workflow/shared'

export interface EventObserverProgramPort {
  run(input: {
    readonly source: EventSourceDescriptor
    readonly subjects: readonly EventSubject[]
    readonly cursorJson: string | null
  }): Promise<ObserverBatch>
}

export interface CustomEventObserverProgramPort extends EventObserverProgramPort {
  validate(input: {
    readonly sourceRef: { readonly id: string; readonly revision: number }
    readonly draft: CustomEventSourceDraft
    readonly now: number
  }): Promise<CustomEventSourceValidationReceipt>
}

/** Integration-owned selectors stay outside the Event Center bounded context. */
export interface EventRoutingSubscriptionDirectoryPort {
  list(): Promise<readonly FilteredEventSubscriptionDefinition[]>
  match(observation: EventObservation): Promise<readonly MatchedFilteredEventSubscription[]>
}

/** A subscriber adapter consumes one durable transport delivery, never an ingress callback. */
export interface EventDeliveryConsumerPort {
  readonly subscriberKind: EventSubscriber['kind']
  canConsume(subscriberRef: string): Promise<boolean>
  consume(delivery: EventDeliveryRecord): Promise<void>
}

export interface EventDeliveryRetryLimitsPort {
  current(): { readonly defaultNodeRetries: number; readonly sessionRestartBudget: number }
}

/** Source-neutral WorkStart boundary implemented by task/digital-employee owners. */
export interface EventAutomationWorkStartPort {
  launch(input: {
    readonly ownerUserId: string
    readonly target: EventResponseTarget
    readonly eventSubscriptionId: string
    readonly eventDeliveryId: string
    readonly triggerContext: TriggerContext
  }): Promise<
    | { readonly kind: 'orchestration'; readonly taskId: string }
    | { readonly kind: 'digital-employee'; readonly caseId: string }
  >
}

export type {
  EventObservation,
  EventRoutingValue,
  FilteredEventSubscriptionDefinition,
} from '../domain/model'
