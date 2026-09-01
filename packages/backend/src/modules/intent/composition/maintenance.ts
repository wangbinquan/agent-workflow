import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLogger, type Logger } from '@/util/log'
import type { IntentMaintenancePersistence } from '../application/ports/intentPersistence'
import {
  createIntentScratchFilesystem,
  type IntentScratchFilesystem,
} from '../infrastructure/intentScratchFilesystem'
import { createPostgresqlIntentPersistence } from '../infrastructure/postgresqlIntentPersistence'
import { createSqliteIntentApplyArtifactLifecycle } from '../infrastructure/sqliteIntentApplyArtifactLifecycle'
import {
  activeIntentApplyJournalIds,
  convergeIntentApplyJournal,
} from '../infrastructure/sqliteIntentApplyOperations'
import { createSqliteIntentPersistence } from '../infrastructure/sqliteIntentPersistence'
import type { IntentMaintenanceCommands } from '../public/commands'
import type { IntentBootRecoveryInput, IntentScratchSweepInput } from '../public/commands'
import { composePostgresqlIntentApplyConvergence } from './postgresqlApplyMaintenance'

export interface IntentApplyConvergence {
  converge(input: {
    readonly activeJournalIds: readonly string[]
  }): Promise<{ readonly failed: number; readonly rolledForward: number }>
}

export interface ResourcePackageApplyConvergence {
  converge(input: {
    readonly activeApplyIds: readonly string[]
  }): Promise<{ readonly failed: number; readonly rolledForward: number }>
}

export interface IntentMaintenanceLog {
  info(message: string, fields: Readonly<Record<string, unknown>>): void
  warn(message: string, fields: Readonly<Record<string, unknown>>): void
}

export interface IntentMaintenanceCompositionDependencies {
  readonly persistence: IntentMaintenancePersistence
  readonly scratch: IntentScratchFilesystem
  readonly intentApplies: IntentApplyConvergence
  readonly resourcePackages: ResourcePackageApplyConvergence
  readonly log?: IntentMaintenanceLog
}

/**
 * Closed admission-time snapshot used by the maintenance scheduler. Intent
 * keeps both the process-local apply fence and boot-recovery persistence
 * behind its composition root; platform code never reaches into adapters.
 */
export interface IntentMaintenanceSnapshotQueries {
  activeApplyJournalIds(): readonly string[]
  bootTurnIds(): Promise<readonly string[]>
}

export interface IntentApplyActivitySource {
  activeJournalIds(): readonly string[]
}

function composeIntentMaintenanceSnapshotQueries(input: {
  readonly persistence: Pick<IntentMaintenancePersistence, 'listTurnIdsForBootRecovery'>
  readonly activity: IntentApplyActivitySource
}): IntentMaintenanceSnapshotQueries {
  return Object.freeze({
    activeApplyJournalIds: () => Object.freeze([...input.activity.activeJournalIds()]),
    bootTurnIds: () => input.persistence.listTurnIdsForBootRecovery(),
  })
}

export function composeSqliteIntentMaintenanceSnapshotQueries(
  db: DbClient,
): IntentMaintenanceSnapshotQueries {
  return composeIntentMaintenanceSnapshotQueries({
    persistence: createSqliteIntentPersistence(db),
    activity: { activeJournalIds: activeIntentApplyJournalIds },
  })
}

export function composePostgresqlIntentMaintenanceSnapshotQueries(input: {
  readonly db: PostgresqlDatabaseClient
  /** The exact selected apply-operations instance; its process-local fence must
   * not be reconstructed from persisted journal rows. */
  readonly activity: IntentApplyActivitySource
}): IntentMaintenanceSnapshotQueries {
  return composeIntentMaintenanceSnapshotQueries({
    persistence: createPostgresqlIntentPersistence(input.db),
    activity: input.activity,
  })
}

export function composeIntentMaintenanceCommands(
  dependencies: IntentMaintenanceCompositionDependencies,
): IntentMaintenanceCommands {
  return Object.freeze({
    scratch: Object.freeze({
      async sweep(input: IntentScratchSweepInput) {
        const cutoff = (input.now ?? Date.now()) - input.retentionHours * 3_600_000
        const staleTurnIds = dependencies.scratch.staleTurnIds(cutoff)
        const running = await dependencies.persistence.listRunningTurnIds(staleTurnIds)
        const failed: string[] = []
        let removed = 0
        for (const turnId of staleTurnIds) {
          if (running.has(turnId)) continue
          try {
            dependencies.scratch.remove(turnId)
            removed += 1
            dependencies.log?.info('intent-scratch-swept', { turnId })
          } catch (error) {
            failed.push(turnId)
            dependencies.log?.warn('intent-scratch-sweep-failed', {
              turnId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        await dependencies.persistence.markScratchSwept({
          cutoff,
          excludedTurnIds: [...running, ...failed],
        })
        return { removed }
      },
    }),
    recovery: Object.freeze({
      bootTurnIds: () => dependencies.persistence.listTurnIdsForBootRecovery(),
      async recover(input: IntentBootRecoveryInput) {
        const orphanedTurns = await dependencies.persistence.recoverTurnsOnBoot({
          turnIds: input.recoverTurnIds,
          now: input.now ?? Date.now(),
          reason: 'intent-run-daemon-restart',
        })
        const [intent, bundles, queuedSessionIds] = await Promise.all([
          dependencies.intentApplies.converge({
            activeJournalIds: input.activeIntentApplyJournalIds,
          }),
          dependencies.resourcePackages.converge({
            activeApplyIds: input.activeBundleApplyIds,
          }),
          dependencies.persistence.listQueuedWorkingSetSessionIds(),
        ])
        return {
          failed: intent.failed + bundles.failed,
          rolledForward: intent.rolledForward + bundles.rolledForward,
          queuedWorkingSets: queuedSessionIds.length,
          orphanedTurns,
          queuedSessionIds,
        }
      },
    }),
  })
}

export function composeIntentMaintenanceCommandsForAppHome(
  input: Omit<IntentMaintenanceCompositionDependencies, 'scratch'> & {
    readonly appHome: string
    readonly scratchDirectoryName: string
  },
): IntentMaintenanceCommands {
  return composeIntentMaintenanceCommands({
    ...input,
    scratch: createIntentScratchFilesystem({
      appHome: input.appHome,
      directoryName: input.scratchDirectoryName,
    }),
  })
}

interface ProviderIntentMaintenanceCompositionInput {
  readonly appHome: string
  readonly scratchDirectoryName: string
  readonly resourcePackages: ResourcePackageApplyConvergence
  readonly log?: Logger
}

/** SQLite mechanism binding for the provider-neutral maintenance commands. */
export function composeSqliteIntentMaintenanceCommandsForAppHome(
  input: ProviderIntentMaintenanceCompositionInput & { readonly db: DbClient },
): IntentMaintenanceCommands {
  const log = input.log ?? createLogger('intentMaintenance')
  const artifacts = createSqliteIntentApplyArtifactLifecycle({
    db: input.db,
    appHome: input.appHome,
  })
  return composeIntentMaintenanceCommandsForAppHome({
    persistence: createSqliteIntentPersistence(input.db),
    appHome: input.appHome,
    scratchDirectoryName: input.scratchDirectoryName,
    intentApplies: {
      converge: ({ activeJournalIds }) =>
        convergeIntentApplyJournal(input.db, artifacts, log, { activeJournalIds }),
    },
    resourcePackages: input.resourcePackages,
    log,
  })
}

/** PostgreSQL mechanism binding for the same provider-neutral commands. */
export function composePostgresqlIntentMaintenanceCommandsForAppHome(
  input: ProviderIntentMaintenanceCompositionInput & {
    readonly db: PostgresqlDatabaseClient
    readonly pluginsDir: string
  },
): IntentMaintenanceCommands {
  const log = input.log ?? createLogger('intentMaintenance')
  return composeIntentMaintenanceCommandsForAppHome({
    persistence: createPostgresqlIntentPersistence(input.db),
    appHome: input.appHome,
    scratchDirectoryName: input.scratchDirectoryName,
    intentApplies: composePostgresqlIntentApplyConvergence({
      db: input.db,
      appHome: input.appHome,
      pluginsDir: input.pluginsDir,
      log,
    }),
    resourcePackages: input.resourcePackages,
    log,
  })
}
