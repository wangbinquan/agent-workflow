import type { EventObservationParticipant } from '@/modules/event-center/public/participants'
import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import {
  COLLABORATION_COMMITTED_EVENT_TYPES,
  decodeCollaborationCommittedEvent,
} from '../domain/collaborationCommittedEvent'
import { collaborationCommittedObservation } from '../public/events'

export const collaborationCommittedEventCodec = {
  eventTypes: COLLABORATION_COMMITTED_EVENT_TYPES,
  decode: decodeCollaborationCommittedEvent,
} as const

export function createCollaborationDurableConsumerDefinitions(input: {
  readonly events: EventObservationParticipant
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
