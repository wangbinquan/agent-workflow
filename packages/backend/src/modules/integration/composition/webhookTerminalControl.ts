// RFC-303 composition seam. Transitional routes/services may request this
// command, while application/domain stay free of concrete SQLite imports.
import type { DbClient } from '@/db/client'
import { createAcceptVerifiedWebhookDeliveryAsync } from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import { createVerifiedWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/verifiedWebhookDeliveryPersistence'
import { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '@/modules/integration/application/mrTerminalControlWorker'
import { composeTaskSourceTermination } from '@/modules/task-execution/composition/sourceTermination'
import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import type {
  MrLaunchGuardPersistencePort,
  MrTerminalEffectPersistencePort,
} from '../application/ports/mrTerminalControlPersistence'
import {
  createMrLaunchGuardPersistence,
  createMrTerminalEffectPersistence,
} from '../infrastructure/mrTerminalControlPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'
import type { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type { VerifiedWebhookDeliveryPersistencePort } from '../application/ports/verifiedWebhookDeliveryPersistence'
import { InMemoryWebhookLaunchSupervisor } from '../infrastructure/inMemoryWebhookLaunchSupervisor'

export function composeVerifiedWebhookDeliveryAcceptanceWithPersistence(
  persistence: VerifiedWebhookDeliveryPersistencePort,
) {
  return createAcceptVerifiedWebhookDeliveryAsync({ persistence })
}

/** RFC-359 W4-D2：已验证投递的接收一份实现，两个 provider 共用；旧名保留为装配别名。 */
export function composeSqliteVerifiedWebhookDeliveryAcceptance(db: DbClient) {
  return composeVerifiedWebhookDeliveryAcceptanceWithPersistence(
    createVerifiedWebhookDeliveryPersistence(db),
  )
}

export function composePostgresqlVerifiedWebhookDeliveryAcceptance(db: PostgresqlDatabaseClient) {
  return composeVerifiedWebhookDeliveryAcceptanceWithPersistence(
    createVerifiedWebhookDeliveryPersistence(db),
  )
}

export interface MrTerminalControlPersistence {
  readonly launchGuards: MrLaunchGuardPersistencePort
  readonly terminalEffects: MrTerminalEffectPersistencePort
}

export interface MrTerminalControlTaskTermination {
  readonly participant: TaskSourceTerminationParticipant
  readonly mintCapability: typeof mintSourceTerminationEffectCapability
}

/** Provider-neutral bootstrap seam; no database client escapes this boundary. */
export function composeMrTerminalControlWithPorts(input: {
  readonly persistence: MrTerminalControlPersistence
  readonly taskTermination: MrTerminalControlTaskTermination
}): MrTerminalControl {
  const launchGuards = new MrLaunchGuardCoordinator(
    input.persistence.launchGuards,
    new InMemoryWebhookLaunchSupervisor(),
  )
  const worker = new MrTerminalControlWorker(
    input.persistence.terminalEffects,
    launchGuards,
    input.taskTermination.participant,
    input.taskTermination.mintCapability,
  )
  return {
    reserveLaunch: (input) => launchGuards.reserve(input),
    wake: (effectId) => worker.wake(effectId),
    reconcileOnBoot: () => worker.reconcileOnBoot(),
    stop: () => worker.stop(),
    resume: () => worker.resume(),
  }
}

/** Legacy SQLite bootstrap retained until the final provider-selection pass. */
export function composeMrTerminalControl(db: DbClient): MrTerminalControl {
  return composeMrTerminalControlWithPorts({
    persistence: {
      launchGuards: createMrLaunchGuardPersistence(db),
      terminalEffects: createMrTerminalEffectPersistence(db),
    },
    taskTermination: composeTaskSourceTermination(db),
  })
}

export function composePostgresqlMrTerminalControl(input: {
  readonly db: PostgresqlDatabaseClient
  readonly taskTermination: MrTerminalControlTaskTermination
}): MrTerminalControl {
  return composeMrTerminalControlWithPorts({
    persistence: {
      launchGuards: createMrLaunchGuardPersistence(input.db),
      terminalEffects: createMrTerminalEffectPersistence(input.db),
    },
    taskTermination: input.taskTermination,
  })
}
