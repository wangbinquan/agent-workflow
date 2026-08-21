import type { DbClient } from '@/db/client'
import type { EventCenterCodeHostDeliveryDispatcher } from '@/services/webhook/dispatcherTypes'
import {
  createCodeHostEventDeliveryAdapter,
  createCodeHostEventRoutingAdapter,
} from './application/adapters/event-center-adapter'
import { createSqliteCodeHostEventResponseDirectory } from './infrastructure/sqliteCodeHostEventResponseDirectory'
import type { DigitalEmployeeWorkStartPort } from './public/participants'
import type { CodeHostEventContinuationPort } from './application/ports/codeHostEventResponse'

export interface DeferredDigitalEmployeeWorkStart {
  readonly participant: DigitalEmployeeWorkStartPort
  bind(participant: DigitalEmployeeWorkStartPort): void
}

/** Bootstrap-local late binding; no ambient singleton or business fallback exists. */
export function createDeferredDigitalEmployeeWorkStart(): DeferredDigitalEmployeeWorkStart {
  let bound: DigitalEmployeeWorkStartPort | null = null
  return {
    participant: {
      launch(input) {
        if (bound === null) {
          throw new Error('digital employee work-start participant is not bound')
        }
        return bound.launch(input)
      },
    },
    bind(participant) {
      bound = participant
    },
  }
}

export function createCodeHostWebhookRoutingDirectory(
  db: DbClient,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventRoutingAdapter(
    createSqliteCodeHostEventResponseDirectory(db),
    continuation,
  )
}

export function createCodeHostWebhookDeliveryConsumer(
  db: DbClient,
  dispatcher: EventCenterCodeHostDeliveryDispatcher,
  continuation?: CodeHostEventContinuationPort,
) {
  return createCodeHostEventDeliveryAdapter(
    createSqliteCodeHostEventResponseDirectory(db),
    {
      dispatch: (input) => dispatcher.dispatchSubscription(input),
    },
    continuation,
  )
}
