import { ulid } from 'ulid'

import { NotFoundError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type {
  EventAutomationWorkStartPort,
  EventDeliveryConsumerPort,
  EventRoutingSubscriptionDirectoryPort,
} from '../composition/required-ports'
import type { EventObservation } from '../domain/model'
import {
  assertResponseTargetContract,
  eventResponseRuleDraftSchema,
  type EventResponseRuleDraft,
  type EventResponseRuleRecord,
} from '../domain/responseRule'
import type { EventStorePort } from './ports/eventStore'
import type { EventResponseRuleStorePort } from './ports/responseRuleStore'

const subscriberPrefix = 'event-response-rule:'

function subscriberRef(id: string): string {
  return `${subscriberPrefix}${id}`
}

function materializedSubscriptionId(
  rule: EventResponseRuleRecord,
  subject: EventObservation['subject'],
): string {
  return `route:${subscriberRef(rule.id)}:${sha256Hex(
    `${rule.updatedAt}\u0000${subject.typeId}\u0000${subject.subjectRef}`,
  )}`
}

function definitionOf(rule: EventResponseRuleRecord) {
  return {
    id: rule.id,
    definitionRevision: String(rule.updatedAt),
    sourceRef: rule.sourceRef,
    eventTypeRefs: [rule.eventTypeRef],
    subjectTypeId: rule.subjectTypeId,
    subscriber: { kind: 'automation' as const, subscriberRef: subscriberRef(rule.id) },
    displayName: { 'zh-CN': rule.name, 'en-US': rule.name },
    selector: {
      kind: 'event.subject',
      config: {
        match: rule.subjectMatch,
        pattern: rule.subjectPattern,
      },
    },
    state: rule.enabled ? ('active' as const) : ('paused' as const),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  }
}

export class EventResponseRuleService {
  readonly #rules: EventResponseRuleStorePort
  readonly #events: EventStorePort
  readonly #now: () => number
  readonly #id: () => string

  constructor(input: {
    readonly rules: EventResponseRuleStorePort
    readonly events: EventStorePort
    readonly now?: () => number
    readonly id?: () => string
  }) {
    this.#rules = input.rules
    this.#events = input.events
    this.#now = input.now ?? Date.now
    this.#id = input.id ?? ulid
  }

  list(): readonly EventResponseRuleRecord[] {
    return this.#rules.list()
  }

  get(id: string): EventResponseRuleRecord {
    const rule = this.#rules.get(id)
    if (rule === null) {
      throw new NotFoundError(
        'event-response-rule-not-found',
        `event response rule not found: ${id}`,
      )
    }
    return rule
  }

  create(input: unknown, ownerUserId: string): EventResponseRuleRecord {
    const draft = this.#validatedDraft(input)
    const eventType = this.#events.getEventType(draft.eventTypeRef)!
    return this.#rules.create({
      id: this.#id(),
      ownerUserId,
      sourceRef: eventType.sourceRef,
      subjectTypeId: eventType.subjectTypeId,
      draft,
      now: this.#now(),
    })
  }

  update(id: string, input: unknown): EventResponseRuleRecord {
    this.get(id)
    const draft = this.#validatedDraft(input)
    const eventType = this.#events.getEventType(draft.eventTypeRef)!
    const updated = this.#rules.update({
      id,
      sourceRef: eventType.sourceRef,
      subjectTypeId: eventType.subjectTypeId,
      draft,
      now: this.#now(),
    })
    if (updated === null) {
      throw new NotFoundError(
        'event-response-rule-not-found',
        `event response rule not found: ${id}`,
      )
    }
    return updated
  }

  remove(id: string): void {
    if (!this.#rules.remove(id)) {
      throw new NotFoundError(
        'event-response-rule-not-found',
        `event response rule not found: ${id}`,
      )
    }
  }

  #validatedDraft(input: unknown): EventResponseRuleDraft {
    const draft = eventResponseRuleDraftSchema.parse(input)
    const eventType = this.#events.getEventType(draft.eventTypeRef)
    if (eventType === null) {
      throw new NotFoundError(
        'event-type-not-found',
        `event type not found: ${draft.eventTypeRef.id}@${draft.eventTypeRef.revision}`,
      )
    }
    if (eventType.triggerParameters === null) {
      throw new ValidationError(
        'event-response-contract-missing',
        'this event type has no task input contract and cannot start new work',
      )
    }
    if ((eventType.catalogVisibility ?? 'public') !== 'public') {
      throw new ValidationError(
        'event-response-event-not-public',
        'non-public event facts cannot be selected as response events',
      )
    }
    assertResponseTargetContract({
      target: draft.target,
      triggerParameters: eventType.triggerParameters,
    })
    return draft
  }
}

export function createEventResponseRoutingDirectory(
  rules: EventResponseRuleStorePort,
): EventRoutingSubscriptionDirectoryPort {
  return {
    list: () => rules.list().map(definitionOf),
    match(observation: EventObservation) {
      return rules.matching(observation).map((rule) => ({
        definition: definitionOf(rule),
        eventTypeRef: observation.eventTypeRef,
        materializedSubscriptionId: materializedSubscriptionId(rule, observation.subject),
      }))
    },
  }
}

export function createEventResponseDeliveryConsumer(input: {
  readonly rules: EventResponseRuleStorePort
  readonly workStart: EventAutomationWorkStartPort
  readonly now?: () => number
}): EventDeliveryConsumerPort {
  const now = input.now ?? Date.now
  return {
    subscriberKind: 'automation',
    canConsume: (ref) => ref.startsWith(subscriberPrefix),
    async consume(delivery) {
      const ruleId = delivery.subscriber.subscriberRef.slice(subscriberPrefix.length)
      const rule = input.rules.get(ruleId)
      if (rule === null || !rule.enabled) return
      // A rule edit is a new deterministic definition. A delivery selected by
      // an older definition must never run the newly edited target. The old
      // delivery settles as obsolete; future observations match the new id.
      if (delivery.subscriptionId !== materializedSubscriptionId(rule, delivery.subject)) return
      if (delivery.triggerContext === null) {
        throw new ValidationError(
          'event-response-trigger-context-missing',
          `event delivery has no declared task input contract: ${delivery.deliveryId}`,
        )
      }
      try {
        await input.workStart.launch({
          ownerUserId: rule.ownerUserId,
          target: rule.target,
          eventSubscriptionId: delivery.subscriptionId,
          eventDeliveryId: delivery.deliveryId,
          triggerContext: delivery.triggerContext,
        })
        input.rules.recordResult({ id: rule.id, state: 'launched', error: null, now: now() })
      } catch (error) {
        input.rules.recordResult({
          id: rule.id,
          state: 'failed',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          now: now(),
        })
        throw error
      }
    },
  }
}
