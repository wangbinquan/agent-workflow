import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
} from '../acceptVerifiedWebhookDelivery'
import type { WebhookDeliveryPersistencePort } from './webhookDeliveryPersistence'
import type { WebhookEndpointRecord } from './webhookEndpointAdministration'

// RFC-434: the webhook ingress persistence the inbound webhook route calls; the composition builds it from the
// provider-neutral persistence adapters. RFC-437: the ingress binding now lives in this module, so the type is no
// longer re-exported through public/commands.
/** The two endpoint reads verified ingress needs; the endpoint administration port satisfies it. */
export interface WebhookIngressEndpointReads {
  get(id: string): Promise<WebhookEndpointRecord | null>
  getByUrlToken(urlToken: string): Promise<WebhookEndpointRecord | null>
}

export interface WebhookIngressPersistence {
  readonly endpoints: WebhookIngressEndpointReads
  readonly deliveries: WebhookDeliveryPersistencePort
  acceptVerifiedDelivery(input: VerifiedWebhookDeliveryInput): Promise<AcceptedVerifiedDelivery>
}
