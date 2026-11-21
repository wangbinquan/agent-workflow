import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLogger, type Logger } from '@/util/log'
import {
  createResourcePackageApplyActivityQuery,
  createResourcePackageApplyActivityRegistry,
  type ResourcePackageApplyActivitySource,
  type ResourcePackageApplyArtifactRecoveryPort,
  type ResourcePackageApplyActivityTracker,
  type ResourcePackageApplyMaintenanceLog,
  requireExclusiveRecoverySelection,
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
/** RFC-525: the worker keeps the conflict check where it chooses between a selected recovery and the local one. */
export { requireExclusiveRecoverySelection }

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

/**
 * RFC-525 — the local versioned artifact recovery the maintenance composition used to build when the caller gave none;
 * a selected recovery-content effects factory stands in for the local file effects, as before.
 */
export function composeLocalResourcePackageArtifactRecovery(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly pluginsDir: string
  readonly recoveryEffectsFactory?: ResourcePackageRecoveryEffectsFactory
  readonly log?: Logger
}): ResourcePackageApplyArtifactRecoveryPort {
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  const effectsFactory = selectedResourcePackageRecoveryEffects(
    input.recoveryEffectsFactory,
    input.appHome,
  )
  return createVersionedResourcePackageArtifactRecovery(
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
  )
}

export function composeResourcePackageApplyMaintenance(input: {
  readonly db: PersistenceDb
  readonly activitySource?: ResourcePackageApplyActivitySource
  /** RFC-525: the selected recovery, or the local one (`composeLocalResourcePackageArtifactRecovery`). */
  readonly artifacts: ResourcePackageApplyArtifactRecoveryPort
  readonly now?: () => number
  readonly log?: Logger
}): PostgresqlResourcePackageApplyMaintenance {
  const activity = createResourcePackageApplyActivityRegistry()
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  const recovery = {
    journal: createResourcePackageApplyJournalPort(input.db),
    artifacts: input.artifacts,
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
