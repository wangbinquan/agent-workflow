// RFC-303 composition seam. Transitional routes/services may request this
// command, while application/domain stay free of concrete SQLite imports.
import type { DbClient } from '@/db/client'
import { createAcceptVerifiedWebhookDelivery } from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import { SqliteVerifiedWebhookDeliveryStore } from '@/modules/integration/infrastructure/sqliteVerifiedWebhookDeliveryStore'

export function composeVerifiedWebhookDeliveryAcceptance(db: DbClient) {
  return createAcceptVerifiedWebhookDelivery({
    store: new SqliteVerifiedWebhookDeliveryStore(db),
  })
}
