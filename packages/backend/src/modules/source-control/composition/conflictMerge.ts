import {
  discardConflictMergeWorkspace,
  finishConflictMerge,
  inspectConflictMerge,
  prepareConflictMerge,
  requireConflictMergeWorkspaceEffects,
} from '../application/conflictMerge'
import type { ConflictMergeWorkspaceEffects } from '../application/ports/conflictMergeWorkspaceEffects'

export { createFileConflictMergeWorkspaceEffects } from '../infrastructure/local/fileConflictMergeWorkspaceEffects'

type BoundConflictOperation<
  F extends (input: never, effects: ConflictMergeWorkspaceEffects) => unknown,
> = (input: Parameters<F>[0]) => ReturnType<F>

/** RFC-527: the effects are the deployment's selection (standalone: the local ones the composition hands out). */
export function bindConflictMergeParticipant(input: {
  readonly effects: ConflictMergeWorkspaceEffects
}): {
  prepare: BoundConflictOperation<typeof prepareConflictMerge>
  inspect: BoundConflictOperation<typeof inspectConflictMerge>
  finish: BoundConflictOperation<typeof finishConflictMerge>
  discard: BoundConflictOperation<typeof discardConflictMergeWorkspace>
} {
  const effects = input.effects
  requireConflictMergeWorkspaceEffects(effects)
  return {
    prepare: (request) => prepareConflictMerge(request, effects),
    inspect: (request) => inspectConflictMerge(request, effects),
    finish: (request) => finishConflictMerge(request, effects),
    discard: (request) => discardConflictMergeWorkspace(request, effects),
  }
}
