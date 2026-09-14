import type { ProviderNeutralDatabase } from '@/db/query'
import { createLogger, type Logger } from '@/util/log'
import type { IntentMaintenancePersistence } from '../application/ports/intentPersistence'
import {
  createIntentScratchFilesystem,
  type IntentScratchFilesystem,
} from '../infrastructure/intentScratchFilesystem'
import { createIntentPersistence } from '../infrastructure/intentPersistence'
import type { IntentMaintenanceCommands } from '../public/commands'
import type { IntentBootRecoveryInput, IntentScratchSweepInput } from '../public/commands'
import { composeIntentApplyConvergence } from './applyMaintenance'

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

/**
 * RFC-359 —— 两个 provider 共用这一份。此处此前是一对，而两侧的**在飞 journal 从哪来**
 * 不一样：SQLite 那份从引擎的模块级集合现取（`activeIntentApplyJournalIds()`），
 * PostgreSQL 那份要求把**选中的那台 apply 引擎**当依赖注进来。后者才是对的——在飞集合是
 * 进程内的围栏，不是可以从 journal 行反推的东西；合一取强侧。
 */
export function composeIntentMaintenanceSnapshotQueriesFor(input: {
  readonly db: ProviderNeutralDatabase
  /** The exact selected apply-operations instance; its process-local fence must
   * not be reconstructed from persisted journal rows. */
  readonly activity: IntentApplyActivitySource
}): IntentMaintenanceSnapshotQueries {
  return composeIntentMaintenanceSnapshotQueries({
    persistence: createIntentPersistence(input.db),
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

/**
 * RFC-359 —— 维护侧（boot / hourly 的 journal 收敛）两个 provider 共用这一份装配。
 * 此处此前是一对：SQLite 走 `convergeIntentApplyJournal` + SQLite 工件生命周期，
 * PostgreSQL 走 `createPostgresqlIntentApplyJournalConvergence`。两者收敛的是同一张
 * `intent_apply_journal`、判的是同一套三态。
 */
export function composeIntentMaintenanceCommandsForDatabase(
  input: ProviderIntentMaintenanceCompositionInput & {
    readonly db: ProviderNeutralDatabase
    readonly pluginsDir: string
  },
): IntentMaintenanceCommands {
  const log = input.log ?? createLogger('intentMaintenance')
  return composeIntentMaintenanceCommandsForAppHome({
    persistence: createIntentPersistence(input.db),
    appHome: input.appHome,
    scratchDirectoryName: input.scratchDirectoryName,
    intentApplies: composeIntentApplyConvergence({
      db: input.db,
      appHome: input.appHome,
      pluginsDir: input.pluginsDir,
      log,
    }),
    resourcePackages: input.resourcePackages,
    log,
  })
}
