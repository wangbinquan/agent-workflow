// RFC-499 (RFC-294 S10 step 6): the standalone preparation and scratch effects, moved here unchanged from
// composition/repositoryPreparation.ts; the hosted pair is infrastructure/crewstation/repositoryPreparation.ts.
import type { SecretBox } from '@/platform/contracts/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { RepositoryPreparationEffectFactory } from '../../application/ports/repositoryPreparationEffects'
import type { ScratchWorkspaceEffects } from '../../application/ports/scratchWorkspaceEffects'
import { createFileRepositoryPreparationEffects } from './fileRepositoryPreparationEffects'
import { createFileScratchWorkspaceEffects } from './fileScratchWorkspaceEffects'
import { composeRepositoryWorkspaceStore } from '../repositoryWorkspaceStore'
import type { WorkspaceCleanupHookEvent } from '../workspaceMaterializer'
import type { RepositoryWorkspaceTaskPorts } from '../../composition/required-ports'

/** What the local preparation and scratch effects are built from (the root's own preparation input). */
export interface RepositoryPreparationInput {
  readonly taskPorts: RepositoryWorkspaceTaskPorts
  readonly db: PersistenceDb
  readonly appHome: string
  readonly secretBox?: SecretBox | undefined
  readonly workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
  readonly cloneTimeoutMs?: number | undefined
  readonly preparationConfiguration?: Readonly<{
    read(): { readonly cloneTimeoutMs?: number } | Promise<{ readonly cloneTimeoutMs?: number }>
  }>
}

/** RFC-432: the standalone preparation effects — native clones and worktrees under the app home. */
export function composeLocalRepositoryPreparationEffects(
  input: RepositoryPreparationInput,
): RepositoryPreparationEffectFactory {
  return {
    create(request) {
      const cloneTimeoutMs =
        input.preparationConfiguration === undefined
          ? (request.cloneTimeoutMs ?? input.cloneTimeoutMs)
          : request.cloneTimeoutMs
      return createFileRepositoryPreparationEffects({
        taskId: request.taskId,
        appHome: input.appHome,
        repositoryWorkspace: composeRepositoryWorkspaceStore(input.db, input.taskPorts),
        ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
        ...(cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs }),
        ...(request.workingBranch === undefined ? {} : { workingBranch: request.workingBranch }),
        gitCommitIdentity: request.gitCommitIdentity,
        signal: request.signal,
        ...(input.workspaceCleanupHook === undefined
          ? {}
          : { workspaceCleanupHook: input.workspaceCleanupHook }),
        assertCurrent: request.assertCurrent,
      })
    },
  }
}

/** RFC-432: the standalone scratch effects — throw-away workspaces under `appHome/scratch`. */
export function composeLocalScratchWorkspaceEffects(
  input: RepositoryPreparationInput,
): ScratchWorkspaceEffects {
  return createFileScratchWorkspaceEffects(input)
}
