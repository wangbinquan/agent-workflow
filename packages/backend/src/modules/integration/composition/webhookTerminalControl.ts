// RFC-303 composition seam. Transitional routes/services may request this
// command, while application/domain stay free of concrete SQLite imports.
import type { DbClient } from '@/db/client'
import {
  createAcceptVerifiedWebhookDelivery,
  createAcceptVerifiedWebhookDeliveryAsync,
} from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import {
  createSqliteVerifiedWebhookDeliveryPersistence,
  SqliteVerifiedWebhookDeliveryStore,
} from '@/modules/integration/infrastructure/sqliteVerifiedWebhookDeliveryStore'
import { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '@/modules/integration/application/mrTerminalControlWorker'
import { composeTaskSourceTermination } from '@/modules/task-execution/composition/sourceTermination'
import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import type {
  MrLaunchGuardPersistencePort,
  MrTerminalEffectPersistencePort,
} from '../application/ports/mrTerminalControlPersistence'
import {
  createSqliteMrLaunchGuardPersistence,
  createSqliteMrTerminalEffectPersistence,
} from '../infrastructure/sqliteMrTerminalControlPersistence'
import {
  createPostgresqlMrLaunchGuardPersistence,
  createPostgresqlMrTerminalEffectPersistence,
} from '../infrastructure/postgresqlMrTerminalControlPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'
import type { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type { VerifiedWebhookDeliveryPersistencePort } from '../application/ports/verifiedWebhookDeliveryPersistence'
import { createPostgresqlVerifiedWebhookDeliveryPersistence } from '../infrastructure/postgresqlVerifiedWebhookDeliveryPersistence'
import { InMemoryWebhookLaunchSupervisor } from '../infrastructure/inMemoryWebhookLaunchSupervisor'

export function composeVerifiedWebhookDeliveryAcceptance(db: DbClient) {
  return createAcceptVerifiedWebhookDelivery({
    store: new SqliteVerifiedWebhookDeliveryStore(db),
  })
}

export function composeVerifiedWebhookDeliveryAcceptanceWithPersistence(
  persistence: VerifiedWebhookDeliveryPersistencePort,
) {
  return createAcceptVerifiedWebhookDeliveryAsync({ persistence })
}

export function composeSqliteVerifiedWebhookDeliveryAcceptance(db: DbClient) {
  return composeVerifiedWebhookDeliveryAcceptanceWithPersistence(
    createSqliteVerifiedWebhookDeliveryPersistence(db),
  )
}

export function composePostgresqlVerifiedWebhookDeliveryAcceptance(db: PostgresqlDatabaseClient) {
  return composeVerifiedWebhookDeliveryAcceptanceWithPersistence(
    createPostgresqlVerifiedWebhookDeliveryPersistence(db),
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
      launchGuards: createSqliteMrLaunchGuardPersistence(db),
      terminalEffects: createSqliteMrTerminalEffectPersistence(db),
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
      launchGuards: createPostgresqlMrLaunchGuardPersistence(input.db),
      terminalEffects: createPostgresqlMrTerminalEffectPersistence(input.db),
    },
    taskTermination: input.taskTermination,
  })
}
