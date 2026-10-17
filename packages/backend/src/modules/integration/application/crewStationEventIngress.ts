// RFC-370 H8 / v3 V8 — hosted code-host event ingress.
//
// `receive` makes a CrewStation delivery durable before it is acknowledged.
// `runPending` then works through the frozen targets one at a time: a target's
// channel and its endpoint decide whether the event is admitted through the
// same verified-delivery fact as a direct webhook, and an admitted target
// publishes its two observations and finalizes its delivery with the shared
// outcome. A failing target is retried later without holding back the others.
import type {
  EventObservationInput,
  EventObservationReceipt,
} from '@/modules/event-center/public/types'
import { ConflictError, DomainError } from '@/util/errors'
import { codeHostEventObservations } from '../public/events'
import type {
  CrewStationEventInboxPort,
  CrewStationInboundDelivery,
  CrewStationPendingTarget,
  CrewStationTargetDecision,
} from './ports/crewStationEventInbox'
import { webhookDeliveryOutcome } from './webhookDeliveryOutcome'

export interface CrewStationEventPublisher {
  observe(input: EventObservationInput): Promise<EventObservationReceipt>
  wakeTerminalControl(effectId: string | null): void
}

/** What one frozen target becomes; the decision is the same on every retry. */
export function decideCrewStationTarget(
  target: CrewStationPendingTarget,
): CrewStationTargetDecision {
  const endpointId = target.endpointId
  if (target.endpoint === null)
    return { kind: 'close', stage: 'source-deleted', reason: 'Frozen logical endpoint was deleted' }
  if (!target.endpoint.enabled || target.endpoint.provider !== target.provider)
    return {
      kind: 'close',
      stage: 'rejected',
      reason: 'Frozen logical endpoint is disabled or changed provider',
    }
  const normalized = target.normalized
  if (!normalized.ok)
    return {
      kind: 'close',
      stage: normalized.reason === 'unsupported-event' ? 'ignored' : 'rejected',
      reason: normalized.detail,
    }
  if (target.channel === 'shadow')
    return {
      kind: 'close',
      stage: 'shadow',
      reason: `normalized:${normalized.event.eventType}; no business admission`,
    }
  const event = normalized.event
  return {
    kind: 'admit',
    delivery: { ...target.delivery, endpointId, event },
    observations: (deliveryId) =>
      codeHostEventObservations({ endpointId, deliveryId, event, occurredAt: target.occurredAt }),
  }
}

export interface CrewStationEventIngressCommands {
  receive(delivery: CrewStationInboundDelivery): Promise<void>
  /** Returns the number of targets it worked on. */
  runPending(publisher: CrewStationEventPublisher, limit?: number): Promise<number>
}

export function createCrewStationEventIngress(deps: {
  readonly inbox: CrewStationEventInboxPort
}): CrewStationEventIngressCommands {
  const processTarget = async (targetId: string, publisher: CrewStationEventPublisher) => {
    const admitted = await deps.inbox.admit(targetId, decideCrewStationTarget)
    if (admitted === null) return
    publisher.wakeTerminalControl(admitted.effectId)
    for (const [index, observation] of admitted.observations.entries()) {
      if (admitted.published.includes(index)) continue
      // observe is idempotent by the observation's dedupe key: a crash after it
      // commits and before the receipt below is repaired by that same key.
      const receipt = await publisher.observe(observation)
      await deps.inbox.recordPublication({
        targetId,
        index,
        receipt,
        finalize: (receipts, effectId) =>
          webhookDeliveryOutcome({
            deliveryCount: receipts.reduce((total, entry) => total + entry.deliveryCount, 0),
            effectId,
          }),
      })
    }
  }
  return Object.freeze({
    async receive(delivery: CrewStationInboundDelivery) {
      const outcome = await deps.inbox.record(delivery)
      if (outcome.kind === 'conflict')
        throw new ConflictError(
          'event-identity-content-conflict',
          'this delivery or event was already received with different content',
        )
      if (outcome.kind === 'unroutable')
        throw new DomainError(outcome.code, outcome.code, outcome.status)
    },
    async runPending(publisher: CrewStationEventPublisher, limit = 32) {
      const due = await deps.inbox.due(Math.max(1, Math.min(limit, 100)))
      for (const targetId of due) {
        try {
          await processTarget(targetId, publisher)
        } catch (error) {
          // The deferral runs under the execution fence too: an instance that
          // lost authority neither records an error nor retires another's work.
          await deps.inbox.defer(
            targetId,
            error instanceof Error ? error.message.slice(0, 2000) : 'event-worker-error',
          )
        }
      }
      return due.length
    },
  })
}
