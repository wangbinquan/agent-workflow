// RFC-499 (RFC-294 S10 step 6): the standalone effects moved to infrastructure/local/repositoryPreparation.ts and
// the preparation binding to infrastructure/repositoryPreparationBridge.ts. This file only assembles: without
// supplied effects it picks the local ones (a fallback RFC-294 S12 replaces with required injection).
import type { RepositoryPreparationEffectFactory } from '../application/ports/repositoryPreparationEffects'
import type { ScratchWorkspaceEffects } from '../application/ports/scratchWorkspaceEffects'
import {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
  type RepositoryPreparationInput,
} from '../infrastructure/local/repositoryPreparation'
import { createRepositoryPreparationBridge } from '../infrastructure/repositoryPreparationBridge'

export {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
} from '../infrastructure/local/repositoryPreparation'
export type { RepositoryPreparationInput } from '../infrastructure/local/repositoryPreparation'

/** The preparation binding; the local effects stand in for any selection the caller did not supply. */
export function composeRepositoryPreparation(
  input: RepositoryPreparationInput & {
    readonly preparationEffects?: RepositoryPreparationEffectFactory
    readonly scratchEffects?: ScratchWorkspaceEffects
  },
) {
  return createRepositoryPreparationBridge({
    ...input,
    scratchEffects: input.scratchEffects ?? composeLocalScratchWorkspaceEffects(input),
    preparationEffects: input.preparationEffects ?? composeLocalRepositoryPreparationEffects(input),
  })
}
