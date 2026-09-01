import type {
  EventDeliveryConsumerPort,
  EventObservation,
  EventRoutingSubscriptionDirectoryPort,
  EventRoutingValue,
  FilteredEventSubscriptionDefinition,
} from '@/modules/event-center/composition/required-ports'
import { sha256Hex } from '@/util/hash'
import type {
  CodeHostEventContinuationPort,
  CodeHostEventResponseDirectoryPort,
  CodeHostEventWorkStartPort,
} from '../ports/codeHostEventResponse'
import { codeHostWebhookRoutingFactsSchema } from '../../domain/codeHostWebhookEvent'
import { CODE_HOST_EVENT_SOURCE_REF, codeHostEventTypeRef } from '../../public/events'

function eventCenterDefinition(
  definition: Awaited<ReturnType<CodeHostEventResponseDirectoryPort['list']>>[number],
): FilteredEventSubscriptionDefinition {
  return {
    id: definition.id,
    definitionRevision: definition.definitionRevision,
    sourceRef: CODE_HOST_EVENT_SOURCE_REF,
    eventTypeRefs: definition.eventTypes.map(codeHostEventTypeRef),
    subjectTypeId: 'code-host.repository',
    subscriber: { kind: 'automation', subscriberRef: definition.id },
    displayName: definition.displayName,
    selector: {
      kind: definition.selector.kind,
      config: definition.selector.config as EventRoutingValue,
    },
    state: definition.state,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  }
}

/** Provider adapter for Event Center's exact, consumer-owned routing SPI. */
export function createCodeHostEventRoutingAdapter(
  directory: CodeHostEventResponseDirectoryPort,
  continuation?: CodeHostEventContinuationPort,
): EventRoutingSubscriptionDirectoryPort {
  return {
    async list() {
      return (await directory.list()).map(eventCenterDefinition)
    },
    async match(observation: EventObservation) {
      if (
        observation.sourceRef.id !== CODE_HOST_EVENT_SOURCE_REF.id ||
        observation.sourceRef.revision !== CODE_HOST_EVENT_SOURCE_REF.revision ||
        !observation.eventTypeRef.id.startsWith('code-host.event.')
      ) {
        return []
      }
      const facts = codeHostWebhookRoutingFactsSchema.parse(observation.routingFacts)
      const compatibilityType = codeHostEventTypeRef(facts.eventType)
      if (
        observation.eventTypeRef.id !== compatibilityType.id ||
        observation.eventTypeRef.revision !== compatibilityType.revision
      ) {
        return []
      }
      const starts = (await directory.matching(facts)).map((definition) => ({
        definition: eventCenterDefinition(definition),
        eventTypeRef: codeHostEventTypeRef(facts.eventType),
        materializedSubscriptionId: `route:${definition.id}:${sha256Hex(
          `${definition.definitionRevision}\u0000${facts.eventType}\u0000${observation.subject.subjectRef}`,
        )}`,
      }))
      if (continuation === undefined || facts.mrIid === undefined) return starts
      const matched = await continuation.match({
        provider: facts.provider,
        repoPath: facts.repoPath,
        mrIid: facts.mrIid,
      })
      if (matched === null) return starts
      const subscriberRef = `development-mission:${matched.continuationRef}`
      return [
        ...starts,
        {
          definition: {
            id: subscriberRef,
            definitionRevision: matched.definitionRevision,
            sourceRef: CODE_HOST_EVENT_SOURCE_REF,
            eventTypeRefs: [codeHostEventTypeRef(facts.eventType)],
            subjectTypeId: 'code-host.repository',
            subscriber: { kind: 'automation' as const, subscriberRef },
            displayName: matched.displayName,
            selector: {
              kind: 'code-host.mr-continuation',
              config: {
                provider: facts.provider,
                repoPath: facts.repoPath,
                mrIid: facts.mrIid,
              },
            },
            state: 'active' as const,
            createdAt: observation.occurredAt,
            updatedAt: observation.occurredAt,
          },
          eventTypeRef: codeHostEventTypeRef(facts.eventType),
          materializedSubscriptionId: `route:${subscriberRef}:${matched.definitionRevision}`,
        },
      ]
    },
  }
}

/** One delivery starts only its named rule; no endpoint-wide compatibility rescan exists. */
export function createCodeHostEventDeliveryAdapter(
  directory: CodeHostEventResponseDirectoryPort,
  workStart: CodeHostEventWorkStartPort,
  continuation?: CodeHostEventContinuationPort,
): EventDeliveryConsumerPort {
  const continuationPrefix = 'development-mission:'
  return {
    subscriberKind: 'automation',
    async canConsume(subscriberRef) {
      return (
        (await directory.has(subscriberRef)) ||
        (continuation !== undefined && subscriberRef.startsWith(continuationPrefix))
      )
    },
    async consume(delivery) {
      const facts = codeHostWebhookRoutingFactsSchema.parse(delivery.routingFacts)
      if (delivery.subscriber.subscriberRef.startsWith(continuationPrefix)) {
        if (continuation === undefined) {
          throw new Error('code-host event continuation consumer is unavailable')
        }
        await continuation.consume({
          continuationRef: delivery.subscriber.subscriberRef.slice(continuationPrefix.length),
          eventDeliveryId: delivery.deliveryId,
          occurredAt: delivery.occurredAt,
        })
        return
      }
      if (delivery.triggerContext === null) {
        throw new Error(`event delivery has no trigger context: ${delivery.deliveryId}`)
      }
      await workStart.dispatch({
        deliveryId: facts.deliveryId,
        eventDeliveryId: delivery.deliveryId,
        eventSubscriptionId: delivery.subscriptionId,
        triggerId: delivery.subscriber.subscriberRef,
        triggerContext: delivery.triggerContext,
      })
    },
  }
}
