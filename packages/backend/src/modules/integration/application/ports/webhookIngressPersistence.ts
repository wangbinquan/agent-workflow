import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
} from '../acceptVerifiedWebhookDelivery'
import type { WebhookDeliveryPersistencePort } from './webhookDeliveryPersistence'
import type { WebhookEndpointRecord } from './webhookEndpointAdministration'

// RFC-434: the webhook ingress persistence the inbound webhook route calls. Moved out of composition so the public
// contract can export it; the composition builds it from the provider-neutral persistence adapters.
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
