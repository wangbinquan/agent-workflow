import type { EventObservationInput, EventObservationReceipt } from './types'

/** Verified webhook/internal ingress narrows to this one idempotent command. */
export interface EventObservationCommandPort {
  observe(input: EventObservationInput): EventObservationReceipt
}
