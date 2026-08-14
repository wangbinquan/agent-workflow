// RFC-303 composition seam. Transitional routes/services may request this
// command, while application/domain stay free of concrete SQLite imports.
import type { DbClient } from '@/db/client'
import { createAcceptVerifiedWebhookDelivery } from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import { SqliteVerifiedWebhookDeliveryStore } from '@/modules/integration/infrastructure/sqliteVerifiedWebhookDeliveryStore'
import { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '@/modules/integration/application/mrTerminalControlWorker'
import { composeTaskSourceTermination } from '@/modules/task-execution/composition/sourceTermination'
import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'

export function composeVerifiedWebhookDeliveryAcceptance(db: DbClient) {
  return createAcceptVerifiedWebhookDelivery({
    store: new SqliteVerifiedWebhookDeliveryStore(db),
  })
}

export function composeMrTerminalControl(db: DbClient): MrTerminalControl {
  const launchGuards = new MrLaunchGuardCoordinator(db)
  const taskTermination = composeTaskSourceTermination(db)
  const worker = new MrTerminalControlWorker(
    db,
    launchGuards,
    taskTermination.participant,
    taskTermination.mintCapability,
  )
  return {
    reserveLaunch: (input) => launchGuards.reserve(input),
    wake: (effectId) => worker.wake(effectId),
    reconcileOnBoot: () => worker.reconcileOnBoot(),
    stop: () => worker.stop(),
  }
}
