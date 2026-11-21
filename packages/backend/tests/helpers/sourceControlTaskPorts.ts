// RFC-395 II-b package O1: provider tests use the same Task-owned ports as bootstrap.
// RFC-527: the preparation and maintenance compositions take their effects as required inputs; these helpers give the
// local ones the compositions used to build when a test gave none (a test's own effects are kept).
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import {
  type composeWorkspaceMaintenanceCommand,
  createNodeWorkspaceMaintenanceFilesystem,
} from '@/modules/source-control/composition'
import {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
  type composeRepositoryPreparation,
} from '@/modules/source-control/composition/repositoryPreparation'

export function withSourceControlTaskPorts<T extends { readonly db: PersistenceDb }>(
  input: T,
): NoInfer<T> & { taskPorts: ReturnType<typeof composeSourceControlTaskPorts> } {
  return { ...input, taskPorts: composeSourceControlTaskPorts(input.db) }
}

type PreparationInput = Parameters<typeof composeRepositoryPreparation>[0]

/** The preparation input with the Task-owned ports and, for each effect a test did not give, the local effect. */
export function withLocalRepositoryPreparation<
  T extends Omit<PreparationInput, 'taskPorts' | 'preparationEffects' | 'scratchEffects'> & {
    readonly preparationEffects?: PreparationInput['preparationEffects']
    readonly scratchEffects?: PreparationInput['scratchEffects']
  },
>(input: T): NoInfer<T> & PreparationInput {
  const ported = withSourceControlTaskPorts(input)
  return {
    ...ported,
    scratchEffects: input.scratchEffects ?? composeLocalScratchWorkspaceEffects(ported),
    preparationEffects:
      input.preparationEffects ?? composeLocalRepositoryPreparationEffects(ported),
  }
}

type MaintenanceInput = Parameters<typeof composeWorkspaceMaintenanceCommand>[0]

/**
 * The maintenance command input with the Task-owned ports; without a given filesystem, the local one over the app home,
 * the materializing check and the path invalidation (the three are only its arguments).
 */
export function withWorkspaceMaintenancePorts(
  input: Omit<MaintenanceInput, 'workspaceGc' | 'workspacePrune' | 'filesystem'> & {
    readonly db: PersistenceDb
    readonly appHome: string
    readonly isMaterializingTask: (taskId: string) => boolean
    readonly invalidateWorkspacePath: (path: string) => void
    readonly filesystem?: MaintenanceInput['filesystem']
  },
): MaintenanceInput {
  const { db, appHome, isMaterializingTask, invalidateWorkspacePath, filesystem, ...rest } = input
  return {
    ...rest,
    ...composeSourceControlTaskPorts(db),
    filesystem:
      filesystem ??
      createNodeWorkspaceMaintenanceFilesystem({
        appHome,
        isMaterializingTask,
        invalidateWorkspacePath,
      }),
  }
}

export function withRepositorySnapshotPorts<T extends { readonly transaction: PersistenceDb }>(
  input: T,
) {
  return { ...input, taskPorts: composeSourceControlTaskPorts(input.transaction) }
}
