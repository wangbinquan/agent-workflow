import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import {
  COLLABORATION_COMMITTED_EVENT_TYPES,
  decodeCollaborationCommittedEvent,
  type CollaborationCommittedV1,
} from '../domain/collaborationCommittedEvent'
import {
  COLLABORATION_COMMITTED_EVENT_REF,
  COLLABORATION_COMMITTED_SOURCE_REF,
} from '../public/events'

interface CollaborationCommittedObservationInput {
  readonly sourceRef: { readonly id: string; readonly revision: number }
  readonly eventTypeRef: { readonly id: string; readonly revision: number }
  readonly subject: { readonly typeId: string; readonly subjectRef: string }
  readonly occurredAt: number
  readonly dedupeKey: string
  readonly summary: string
  readonly payloadArtifactRef: string | null
  readonly routingFactsJson?: string | null
  readonly triggerParameters?: Readonly<Record<string, string>> | null
}

interface CollaborationCommittedObservationParticipant {
  observe(input: CollaborationCommittedObservationInput): unknown
}

function collaborationCommittedObservation(
  event: CollaborationCommittedV1,
): CollaborationCommittedObservationInput {
  const gate = event.payload.gate
  return {
    sourceRef: COLLABORATION_COMMITTED_SOURCE_REF,
    eventTypeRef: COLLABORATION_COMMITTED_EVENT_REF,
    subject: { typeId: 'platform.task', subjectRef: gate.taskId },
    occurredAt: Date.parse(event.occurredAt),
    dedupeKey: event.eventId,
    summary: `${event.family}/${event.type}: ${gate.gateId}`,
    payloadArtifactRef: null,
    routingFactsJson: JSON.stringify({
      taskId: gate.taskId,
      family: event.family,
      eventType: event.type,
      gateKind: gate.gateKind,
      gateId: gate.gateId,
      roundId: gate.roundId,
    }),
    triggerParameters: {
      task_id: gate.taskId,
      family: event.family,
      event_type: event.type,
      gate_kind: gate.gateKind,
    },
  }
}

export const collaborationCommittedEventCodec = {
  eventTypes: COLLABORATION_COMMITTED_EVENT_TYPES,
  decode: decodeCollaborationCommittedEvent,
} as const

export function createCollaborationDurableConsumerDefinitions(input: {
  readonly events: CollaborationCommittedObservationParticipant
  readonly nudgeContinuation: () => void
  readonly enqueueReviewDistill: (input: {
    taskId: string
    sourceEventId: string
  }) => Promise<void> | void
}): readonly CommittedEventConsumerDefinition[] {
  return [
    {
      id: 'event-center.collaboration',
      eventTypes: COLLABORATION_COMMITTED_EVENT_TYPES,
      deliveryClass: 'critical',
      settle: 'durable-effect-recorded',
      handle(value) {
        input.events.observe(
          collaborationCommittedObservation(decodeCollaborationCommittedEvent(value)),
        )
      },
    },
    {
      id: 'collaboration-continuation-nudge',
      eventTypes: ['collaboration.human-gate-decision-committed.v1'],
      deliveryClass: 'rebuildable',
      settle: 'delivery-accepted',
      handle(value) {
        const event = decodeCollaborationCommittedEvent(value)
        if (
          event.type === 'collaboration.human-gate-decision-committed.v1' &&
          event.payload.continuationRef !== null
        ) {
          input.nudgeContinuation()
        }
      },
    },
    {
      id: 'review-distill-enqueue',
      eventTypes: ['collaboration.human-gate-decision-committed.v1'],
      deliveryClass: 'rebuildable',
      settle: 'durable-effect-recorded',
      async handle(value) {
        const event = decodeCollaborationCommittedEvent(value)
        if (
          event.type === 'collaboration.human-gate-decision-committed.v1' &&
          event.family === 'review' &&
          event.payload.distillSourceEventId !== null
        ) {
          await input.enqueueReviewDistill({
            taskId: event.payload.gate.taskId,
            sourceEventId: event.payload.distillSourceEventId,
          })
        }
      },
    },
  ]
}
