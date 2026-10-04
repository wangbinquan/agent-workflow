import type {
  RepositoryGitOptions,
  RepositoryGitOutcome,
} from '@/modules/source-control/public/types'
import type {
  AutomationWorkspaceEffectsFactory,
  AutomationWorkspaceFileFacts,
} from './automationWorkspaceEffects'

type Completion<T> = T | Promise<T>

/** Action-scene mechanics share the complete selected content-reference interpreter. */
export interface ActionWorkspaceEffects {
  readonly contents: AutomationWorkspaceEffectsFactory
  allocate(storageRootReference?: string): Completion<string>
  cloneBaseline(
    workspaceReference: string,
    baselineReference: string,
  ): Promise<RepositoryGitOutcome>
  run(
    workspaceReference: string,
    args: readonly string[],
    options?: RepositoryGitOptions,
  ): Promise<RepositoryGitOutcome>
  installPlatformExclude(workspaceReference: string): Completion<void>
  requireEntry(reference: string): Completion<AutomationWorkspaceFileFacts>
  discard(workspaceReference: string): Completion<void>
}
