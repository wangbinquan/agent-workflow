import { ulid } from 'ulid'

import type { Permission } from '@agent-workflow/shared'

import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
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
  type EventResponseTarget,
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

/**
 * RFC-317 T30（DE-04）—— 每类响应目标要求的启动权限点；`null` = 该类无额外要求。
 *
 * 写成 `Record<EventResponseTarget['kind'], …>` 而不是「一个可选映射」：新增一类
 * 目标时**两个装配根都编译不过**，逼作者当场决定这类要不要权限门，而不是默认落进
 * 「不需要」。值类型是 shared 的 `Permission` 联合，所以权限点本身也是编译期校验的。
 */
export type TargetLaunchPermissions = Readonly<
  Record<EventResponseTarget['kind'], Permission | null>
>

/** Trusted projection built by an authenticated inbound adapter. */
export interface ResponseRuleWritePrincipal {
  readonly userId: string
  readonly canOverrideOwner: boolean
  /**
   * 该主体是否持有某个权限点。**具体点名哪一个由注入的表决定**——原先这里是
   * `canLaunchDigitalEmployee: boolean`，等于 event-center 在自己的契约里写死了
   * 「数字员工」这一类目标、以及另一个 context 的权限点字符串
   * `'development-missions:launch'`；第二类目标需要权限门时只能回来改这个接口。
   */
  readonly hasPermission: (permission: Permission) => boolean
}

export class EventResponseRuleService {
  readonly #rules: EventResponseRuleStorePort
  readonly #events: EventStorePort
  readonly #targetLaunchPermissions: TargetLaunchPermissions
  readonly #now: () => number
  readonly #id: () => string

  constructor(input: {
    readonly rules: EventResponseRuleStorePort
    readonly events: EventStorePort
    readonly targetLaunchPermissions: TargetLaunchPermissions
    readonly now?: () => number
    readonly id?: () => string
  }) {
    this.#rules = input.rules
    this.#events = input.events
    this.#targetLaunchPermissions = input.targetLaunchPermissions
    this.#now = input.now ?? Date.now
    this.#id = input.id ?? ulid
  }

  async list(): Promise<readonly EventResponseRuleRecord[]> {
    return await this.#rules.list()
  }

  async get(id: string): Promise<EventResponseRuleRecord> {
    const rule = await this.#rules.get(id)
    if (rule === null) {
      throw new NotFoundError(
        'event-response-rule-not-found',
        `event response rule not found: ${id}`,
      )
    }
    return rule
  }

  async create(
    input: unknown,
    principal: ResponseRuleWritePrincipal,
  ): Promise<EventResponseRuleRecord> {
    const draft = await this.#validatedDraft(input)
    this.#requireTargetLaunchPermission(draft, principal)
    const eventType = (await this.#events.getEventType(draft.eventTypeRef))!
    return await this.#rules.create({
      id: this.#id(),
      ownerUserId: principal.userId,
      sourceRef: eventType.sourceRef,
      subjectTypeId: eventType.subjectTypeId,
      draft,
      now: this.#now(),
    })
  }

  async update(
    id: string,
    input: unknown,
    principal: ResponseRuleWritePrincipal,
  ): Promise<EventResponseRuleRecord> {
    await this.#requireOwnedRule(id, principal)
    const draft = await this.#validatedDraft(input)
    this.#requireTargetLaunchPermission(draft, principal)
    const eventType = (await this.#events.getEventType(draft.eventTypeRef))!
    const updated = await this.#rules.update({
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

  async remove(id: string, principal: ResponseRuleWritePrincipal): Promise<void> {
    await this.#requireOwnedRule(id, principal)
    if (!(await this.#rules.remove(id))) {
      throw new NotFoundError(
        'event-response-rule-not-found',
        `event response rule not found: ${id}`,
      )
    }
  }

  async #requireOwnedRule(
    id: string,
    principal: ResponseRuleWritePrincipal,
  ): Promise<EventResponseRuleRecord> {
    const rule = await this.#rules.get(id)
    if (rule === null || (rule.ownerUserId !== principal.userId && !principal.canOverrideOwner)) {
      throw new NotFoundError(
        'event-response-rule-not-found',
        `event response rule not found: ${id}`,
      )
    }
    return rule
  }

  #requireTargetLaunchPermission(
    draft: EventResponseRuleDraft,
    principal: ResponseRuleWritePrincipal,
  ): void {
    const required = this.#targetLaunchPermissions[draft.target.kind]
    if (required === null || principal.hasPermission(required)) return
    throw new ForbiddenError('forbidden', `missing permission: ${required}`, {
      requiredPermission: required,
    })
  }

  async #validatedDraft(input: unknown): Promise<EventResponseRuleDraft> {
    const parsed = eventResponseRuleDraftSchema.safeParse(input)
    if (!parsed.success) {
      throw new ValidationError(
        'event-response-rule-invalid',
        'event response rule is invalid',
        parsed.error.flatten(),
      )
    }
    const draft = parsed.data
    const eventType = await this.#events.getEventType(draft.eventTypeRef)
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
    async list() {
      return (await rules.list()).map(definitionOf)
    },
    async match(observation: EventObservation) {
      return (await rules.matching(observation)).map((rule) => ({
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
    async canConsume(ref) {
      return ref.startsWith(subscriberPrefix)
    },
    async consume(delivery) {
      const ruleId = delivery.subscriber.subscriberRef.slice(subscriberPrefix.length)
      const rule = await input.rules.get(ruleId)
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
        await input.rules.recordResult({
          id: rule.id,
          state: 'launched',
          error: null,
          now: now(),
        })
      } catch (error) {
        await input.rules.recordResult({
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
