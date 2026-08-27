import type { SpaceKind } from '@agent-workflow/shared'
import type {
  RepositoryPreparationStep,
  RepositoryPreparationStepOutcome,
  TaskDriveContext,
} from './taskDriveCoordinator'

export type RepositoryPreparationSource =
  | Readonly<{ kind: 'repo-group'; repoGroupId: string }>
  | Readonly<{ kind: 'cached-repo'; cachedRepoId: string }>

export interface RepositoryPreparationDescriptor {
  readonly taskId: string
  readonly workflowId: string
  readonly taskName: string
  readonly source: RepositoryPreparationSource
  readonly workingBranch: string | null
  readonly requestedRef: string | null
  readonly spaceKind: SpaceKind
  readonly gitCommitIdentity: Readonly<{ name: string; email: string }> | null
  readonly hasPriorAttempt: boolean
}

export type RepositoryPreparationDescriptorReadOutcome =
  | Readonly<{ kind: 'prepare'; descriptor: RepositoryPreparationDescriptor }>
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'terminal-won' }>

export interface RepositoryPreparationDescriptorReader {
  read(taskId: string): Promise<RepositoryPreparationDescriptorReadOutcome>
}

export interface RepositoryPreparationMechanicsPort {
  prepare(input: {
    readonly descriptor: RepositoryPreparationDescriptor
    readonly context: TaskDriveContext
  }): Promise<RepositoryPreparationStepOutcome>
}

/**
 * Phase-0 owner. Every launch/retry/recovery submission rehydrates from the
 * committed task projection; no route input or materialization lease crosses
 * the admission boundary.
 */
export class PersistedRepositoryPreparationStep implements RepositoryPreparationStep {
  constructor(
    private readonly reader: RepositoryPreparationDescriptorReader,
    private readonly mechanics: RepositoryPreparationMechanicsPort,
  ) {}

  async run(context: TaskDriveContext): Promise<RepositoryPreparationStepOutcome> {
    const persisted = await this.reader.read(context.taskId)
    if (persisted.kind !== 'prepare') return persisted
    if (persisted.descriptor.taskId !== context.taskId) {
      throw new Error('repository-preparation-descriptor-task-mismatch')
    }
    return await this.mechanics.prepare({ descriptor: persisted.descriptor, context })
  }
}
