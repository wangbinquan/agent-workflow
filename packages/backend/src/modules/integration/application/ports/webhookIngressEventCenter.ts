// RFC-558 (RFC-294 S9 step 13): the three Event Center operations webhook ingress and delivery replay use — record an
// observation, run one notification, nudge the code-host activity source. Integration owns this narrow port; the
// assembly root hands the Event Center module, which satisfies it structurally (the same object as before).
import type { EventObservationParticipant } from '@/modules/event-center/public/participants'
import type { EventExactRef } from '@/modules/event-center/public/types'

export interface WebhookIngressEventCenter {
  readonly commands: EventObservationParticipant
  readonly worker: {
    runOneNotification(
      deliveryId?: string,
    ): Promise<'completed' | 'retried' | 'dead-letter' | 'idle'>
  }
  readonly observerControl: {
    nudgeSource(sourceRef: EventExactRef): Promise<boolean>
  }
}
