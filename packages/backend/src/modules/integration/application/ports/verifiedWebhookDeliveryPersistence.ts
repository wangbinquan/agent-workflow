// RFC-349 — provider-neutral durable ingress boundary. A verified delivery,
// its MR stream transition, and any terminal-control effect are committed as
// one asynchronous transaction by the selected provider adapter.
import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
} from '../acceptVerifiedWebhookDelivery'

export interface VerifiedWebhookDeliveryPersistencePort {
  accept(input: VerifiedWebhookDeliveryInput): Promise<AcceptedVerifiedDelivery>
}
