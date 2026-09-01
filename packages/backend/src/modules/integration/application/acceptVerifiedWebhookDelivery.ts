// RFC-303 application command: persist a verified normalized delivery and its
// MR stream/control intent as one atomic fact. HTTP and provider adapters stay
// outside this command; storage is supplied through the exact port below.
import type { CodeHostEvent } from '@agent-workflow/shared'
import type { VerifiedWebhookDeliveryPersistencePort } from './ports/verifiedWebhookDeliveryPersistence'

export type VerifiedWebhookDeliveryInput = Readonly<{
  endpointId: string
  event: CodeHostEvent
  rawBodyBytes: Uint8Array
  rawBodyText: string
  eventHeader: string | null
  objectKind: string | null
  replay?: Readonly<{
    rootDeliveryId: string
    terminalRootRevision: number | null
  }>
}>

export type AcceptedVerifiedDelivery =
  | Readonly<{
      kind: 'inserted'
      deliveryId: string
      effectId: string | null
      controlAccepted: boolean
      streamRevision: number | null
    }>
  | Readonly<{
      kind: 'duplicate'
      deliveryId: string
      attemptCount: number
      effectId: string | null
    }>

export interface VerifiedWebhookDeliveryStore {
  accept(input: VerifiedWebhookDeliveryInput): AcceptedVerifiedDelivery
}

export function createAcceptVerifiedWebhookDelivery(deps: {
  store: VerifiedWebhookDeliveryStore
}): (input: VerifiedWebhookDeliveryInput) => AcceptedVerifiedDelivery {
  return (input) => deps.store.accept(input)
}

export function createAcceptVerifiedWebhookDeliveryAsync(deps: {
  persistence: VerifiedWebhookDeliveryPersistencePort
}): (input: VerifiedWebhookDeliveryInput) => Promise<AcceptedVerifiedDelivery> {
  return async (input) => await deps.persistence.accept(input)
}
