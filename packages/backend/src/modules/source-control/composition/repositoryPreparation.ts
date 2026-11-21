// RFC-499 (RFC-294 S10 step 6): the standalone effects moved to infrastructure/local/repositoryPreparation.ts and
// the preparation binding to infrastructure/repositoryPreparationBridge.ts. This file only assembles and hands out the
// local effects; RFC-527 (RFC-294 S12): both effect selections are required — standalone callers give the local ones.
import type { RepositoryPreparationEffectFactory } from '../application/ports/repositoryPreparationEffects'
import type { ScratchWorkspaceEffects } from '../application/ports/scratchWorkspaceEffects'
import type { RepositoryPreparationInput } from '../infrastructure/local/repositoryPreparation'
import { createRepositoryPreparationBridge } from '../infrastructure/repositoryPreparationBridge'

export {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
} from '../infrastructure/local/repositoryPreparation'
export type { RepositoryPreparationInput } from '../infrastructure/local/repositoryPreparation'

/** The preparation binding over the caller's effect selections. */
export function composeRepositoryPreparation(
  input: RepositoryPreparationInput & {
    readonly preparationEffects: RepositoryPreparationEffectFactory
    readonly scratchEffects: ScratchWorkspaceEffects
  },
) {
  return createRepositoryPreparationBridge(input)
}
