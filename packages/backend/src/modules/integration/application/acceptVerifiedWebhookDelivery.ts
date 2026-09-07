// RFC-303 application contract: a verified normalized delivery and its MR
// stream/control intent are persisted as one atomic fact. HTTP and provider
// adapters stay outside; storage is reached through
// `./ports/verifiedWebhookDeliveryPersistence`, which owns the accept command
// and is shaped by the two types below.
import type { CodeHostEvent } from '@agent-workflow/shared'

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
