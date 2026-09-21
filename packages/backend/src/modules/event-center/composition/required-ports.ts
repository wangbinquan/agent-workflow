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
import type {
  StartAgentTask,
  StartTask,
  StartWorkgroupTask,
  TriggerContext,
} from '@agent-workflow/shared'
import type { IdempotentCommandContext } from '@/modules/identity-access/public/participants'

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
  consume(delivery: EventDeliveryRecord, claim: EventDeliveryClaimScope): Promise<void>
  settle?(input: EventDeliverySettlement): Promise<boolean>
}

export interface EventDeliveryClaimScope {
  readonly deliveryId: string
  readonly leaseOwner: string
  readonly attemptCount: number
}

export interface EventDeliverySettlement {
  readonly delivery: EventDeliveryRecord
  readonly claim: EventDeliveryClaimScope
  readonly now: number
  readonly state: 'accepted' | 'pending' | 'dead-letter'
  readonly nextAttemptAt: number
  readonly error: string | null
}

export interface EventDeliveryRetryLimitsPort {
  current(): { readonly defaultNodeRetries: number; readonly sessionRestartBudget: number }
}

declare const eventAutomationOriginBrand: unique symbol
declare const eventAutomationDelegatedContextBrand: unique symbol

/** Durable EC-owned identity; callers cannot decompose it into mutable rule fields. */
export type EventAutomationOriginRef = string & {
  readonly [eventAutomationOriginBrand]: 'event-delivery+subscription+rule-revision+target-digest-v1'
}

export type EventAutomationPortId =
  | 'task-automation-work-start.v1'
  | 'employee-automation-work-start.v1'

export interface EventAutomationDelegatedContext<
  TPort extends EventAutomationPortId,
> extends IdempotentCommandContext {
  readonly [eventAutomationDelegatedContextBrand]: TPort
  readonly portId: TPort
  readonly origin: EventAutomationOriginRef
}

/**
 * Compatibility-frozen Task contract. It intentionally retains the existing
 * UTF-16/counting and collection behavior of Start* codecs; RFC-365 does not
 * introduce RFC-294's proposed 256-entry/UTF-8 budgets.
 */
export type TaskAutomationTargetV1 =
  | { readonly kind: 'workflow'; readonly refId: string; readonly payload: StartTask }
  | {
      readonly kind: 'agent'
      readonly refId: string
      readonly payload: StartAgentTask & { readonly agentId: string }
    }
  | {
      readonly kind: 'workgroup'
      readonly refId: string
      readonly payload: StartWorkgroupTask & { readonly workgroupId: string }
    }

export interface TaskAutomationWorkStartV1 {
  readonly version: 1
  readonly target: TaskAutomationTargetV1
  readonly trigger: TriggerContext
}

export interface TaskAutomationWorkStartPort {
  start(
    context: EventAutomationDelegatedContext<'task-automation-work-start.v1'>,
    input: TaskAutomationWorkStartV1,
  ): Promise<{ readonly taskId: string }>
}

export interface EmployeeAutomationWorkStartV1 {
  readonly version: 1
  readonly employeeId: string
  readonly intake: {
    readonly kind: 'body' | 'external-id'
    readonly target: Readonly<Record<string, string>>
    readonly body: string | null
    readonly externalId: string | null
    readonly uploads: readonly []
  }
}

export interface EmployeeAutomationWorkStartPort {
  start(
    context: EventAutomationDelegatedContext<'employee-automation-work-start.v1'>,
    input: EmployeeAutomationWorkStartV1,
  ): Promise<{ readonly caseId: string }>
}

export interface EventAutomationDelegatedContextFactory {
  create<TPort extends EventAutomationPortId>(input: {
    readonly ownerUserId: string
    readonly origin: EventAutomationOriginRef
    readonly portId: TPort
  }): Promise<EventAutomationDelegatedContext<TPort> | null>
}

/** Same-origin lookup offered by EC to the two target-owned providers. */
export interface EventAutomationOriginBindingPort {
  resolve(
    origin: EventAutomationOriginRef,
    portId: EventAutomationPortId,
  ): Promise<{
    readonly eventSubscriptionId: string
    readonly eventDeliveryId: string
  } | null>
}

export type {
  EventObservation,
  EventRoutingValue,
  FilteredEventSubscriptionDefinition,
} from '../domain/model'
