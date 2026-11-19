import {
  discardConflictMergeWorkspace,
  finishConflictMerge,
  inspectConflictMerge,
  prepareConflictMerge,
  requireConflictMergeWorkspaceEffects,
} from '../application/conflictMerge'
import type { RepositoryGit } from '../application/repositoryCommit'
import type { ConflictMergeWorkspaceEffects } from '../application/ports/conflictMergeWorkspaceEffects'
import { createFileConflictMergeWorkspaceEffects } from '../infrastructure/local/fileConflictMergeWorkspaceEffects'

type NativeGitFixture = { readonly runGit?: RepositoryGit }
type BoundConflictOperation<
  F extends (input: never, effects: ConflictMergeWorkspaceEffects) => unknown,
> = (input: Parameters<F>[0] & NativeGitFixture) => ReturnType<F>

export function bindConflictMergeParticipant(
  input: { readonly effects?: ConflictMergeWorkspaceEffects } = {},
): {
  prepare: BoundConflictOperation<typeof prepareConflictMerge>
  inspect: BoundConflictOperation<typeof inspectConflictMerge>
  finish: BoundConflictOperation<typeof finishConflictMerge>
  discard: BoundConflictOperation<typeof discardConflictMergeWorkspace>
} {
  const selected = input.effects
  requireConflictMergeWorkspaceEffects(selected)
  const effects = selected === undefined ? createFileConflictMergeWorkspaceEffects() : selected
  const forOperation = (request: NativeGitFixture): ConflictMergeWorkspaceEffects => {
    if (selected !== undefined) return effects
    const runGit = request.runGit
    return runGit === undefined ? effects : createFileConflictMergeWorkspaceEffects(runGit)
  }
  return {
    prepare: (request) => prepareConflictMerge(request, forOperation(request)),
    inspect: (request) => inspectConflictMerge(request, forOperation(request)),
    finish: (request) => finishConflictMerge(request, forOperation(request)),
    discard: (request) => discardConflictMergeWorkspace(request, effects),
  }
}
