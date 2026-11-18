import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLogger, type Logger } from '@/util/log'
import type { IntentMaintenancePersistence } from '../application/ports/intentPersistence'
import type { IntentScratchStore } from '../application/ports/intentScratchStore'
import { createFileIntentScratchStore } from '../infrastructure/local/fileIntentScratchStore'
import { createIntentPersistence } from '../infrastructure/intentPersistence'
import type { IntentMaintenanceCommands } from '../public/commands'
import { INTENT_SCRATCH_DIRNAME } from '../domain/scratchDirectory'
import {
  createIntentMaintenanceCommands,
  type IntentMaintenanceLog,
} from '../application/maintenanceCommands'

export interface IntentMaintenanceCompositionDependencies {
  readonly persistence: IntentMaintenancePersistence
  readonly scratch: IntentScratchStore
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
  readonly db: PersistenceDb
  /** The exact selected apply-operations instance; its process-local fence must
   * not be reconstructed from persisted journal rows. */
  readonly activity: IntentApplyActivitySource
}): IntentMaintenanceSnapshotQueries {
  return composeIntentMaintenanceSnapshotQueries({
    persistence: createIntentPersistence(input.db),
    activity: input.activity,
  })
}

// RFC-503：两条维护命令的实现迁入 `application/maintenanceCommands.ts`；这里只交进程时钟（仍在调用时取）。
export function composeIntentMaintenanceCommands(
  dependencies: IntentMaintenanceCompositionDependencies,
): IntentMaintenanceCommands {
  return createIntentMaintenanceCommands({ ...dependencies, now: () => Date.now() })
}

export function composeIntentMaintenanceCommandsForAppHome(
  input: Omit<IntentMaintenanceCompositionDependencies, 'scratch'> & {
    readonly appHome: string
    readonly scratchDirectoryName: string
    readonly scratch?: IntentScratchStore
  },
): IntentMaintenanceCommands {
  return composeIntentMaintenanceCommands({
    ...input,
    scratch:
      input.scratch ??
      createFileIntentScratchStore({
        appHome: input.appHome,
        directoryName: input.scratchDirectoryName,
      }),
  })
}

interface ProviderIntentMaintenanceCompositionInput {
  readonly appHome: string
  readonly scratchDirectoryName?: string
  readonly scratch?: IntentScratchStore
  readonly log?: Logger
}

/** Intent 自有 turn / working-set 恢复；journal 收敛由维护图的 AtomicApply 注册表驱动。 */
export function composeIntentMaintenanceCommandsForDatabase(
  input: ProviderIntentMaintenanceCompositionInput & {
    readonly db: PersistenceDb
  },
): IntentMaintenanceCommands {
  const log = input.log ?? createLogger('intentMaintenance')
  return composeIntentMaintenanceCommandsForAppHome({
    persistence: createIntentPersistence(input.db),
    appHome: input.appHome,
    scratchDirectoryName: input.scratchDirectoryName ?? INTENT_SCRATCH_DIRNAME,
    ...(input.scratch === undefined ? {} : { scratch: input.scratch }),
    log,
  })
}
