import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLogger, type Logger } from '@/util/log'
import {
  createResourcePackageApplyActivityQuery,
  createResourcePackageApplyActivityRegistry,
  type ResourcePackageApplyActivitySource,
  type ResourcePackageApplyArtifactRecoveryPort,
  type ResourcePackageApplyActivityTracker,
  type ResourcePackageApplyMaintenanceLog,
} from '../application/resourcePackageMaintenance'
import { createPostgresqlResourcePackageApplyArtifactRecovery } from '../infrastructure/postgresqlResourcePackageMaintenance'
import { createResourcePackageApplyJournalPort } from '../infrastructure/resourcePackageApplyJournal'
import { createResourcePackageOperationArtifactRecovery } from '../infrastructure/resourcePackageOperationRecovery'
import { createVersionedResourcePackageArtifactRecovery } from '../infrastructure/resourcePackageArtifactRecovery'
import { createResourcePackageRecoveryScene } from '../infrastructure/resourcePackageRecovery'
import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import type { ResourcePackageApplyActivityQuery } from '../public/queries'
import type { ResourcePackageRecoveryEffectsFactory } from '../application/package/recoveryContentEffects'
import { selectedResourcePackageRecoveryEffects } from '../infrastructure/recoveryContentEffects'

export type { ResourcePackageApplyArtifactRecoveryPort }

export interface ResourcePackageApplyMaintenance {
  readonly scene: AtomicApplyRecoveryScene<'resource-package'>
  readonly activity: ResourcePackageApplyActivityQuery
}

export interface PostgresqlResourcePackageApplyMaintenance extends ResourcePackageApplyMaintenance {
  /** Provider-private writer used by the PostgreSQL apply owner around a claimed journal. */
  readonly activityTracker: ResourcePackageApplyActivityTracker
}

function maintenanceLog(log: Logger): ResourcePackageApplyMaintenanceLog {
  return Object.freeze({
    warn(message: string, fields: Readonly<Record<string, string>>) {
      log.warn(message, fields)
    },
  })
}

export function composeResourcePackageApplyMaintenance(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir: string
  readonly activitySource?: ResourcePackageApplyActivitySource
  readonly artifacts?: ResourcePackageApplyArtifactRecoveryPort
  readonly recoveryEffectsFactory?: ResourcePackageRecoveryEffectsFactory
  readonly now?: () => number
  readonly log?: Logger
}): PostgresqlResourcePackageApplyMaintenance {
  const activity = createResourcePackageApplyActivityRegistry()
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  if (
    input.artifacts !== undefined &&
    input.artifacts !== null &&
    input.recoveryEffectsFactory !== undefined
  )
    throw new Error('resource-package-recovery-selections-conflict')
  const effectsFactory =
    input.artifacts === undefined || input.artifacts === null
      ? selectedResourcePackageRecoveryEffects(input.recoveryEffectsFactory, input.appHome)
      : undefined
  const recovery = {
    journal: createResourcePackageApplyJournalPort(input.db),
    artifacts:
      input.artifacts ??
      createVersionedResourcePackageArtifactRecovery(
        createPostgresqlResourcePackageApplyArtifactRecovery({
          db: input.db,
          appHome: input.appHome,
          pluginsDir: input.pluginsDir,
          effectsFactory,
        }),
        createResourcePackageOperationArtifactRecovery({
          db: input.db,
          appHome: input.appHome,
          pluginsDir: input.pluginsDir,
          effectsFactory,
          log: maintenanceLog(log),
        }),
      ),
    ...(input.now === undefined ? {} : { now: input.now }),
    log: maintenanceLog(log),
  }
  return Object.freeze({
    scene: createResourcePackageRecoveryScene(recovery),
    activity:
      input.activitySource === undefined
        ? activity.query
        : createResourcePackageApplyActivityQuery(input.activitySource),
    activityTracker: activity.tracker,
  })
}
