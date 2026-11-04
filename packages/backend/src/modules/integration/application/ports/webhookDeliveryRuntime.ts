// RFC-437：自 `composition/webhookIngress.ts` 移入端口——投递审计绑定与重放用例都依赖它。
import type { WebhookDeliveryQueries } from './webhookDeliveryQueries'
import type { WebhookIngressPersistence } from './webhookIngressPersistence'

/** Provider-neutral audit/replay seam; transports never select or inspect a database provider. */
export interface WebhookDeliveryRuntime extends WebhookIngressPersistence {
  readonly queries: WebhookDeliveryQueries
}
