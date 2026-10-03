// RFC-363 query lifetime; RFC-370 chooses complete workspace content effects.
import { ulid } from 'ulid'
import type { WorkspaceContentParticipant } from '../public/participants'
import type { AuthorizedWorkspaceSnapshotRef } from '../public/types'
import { decodeRepositoryLaunchRef } from '../domain/repositoryLaunchRef'
import type { WorkspaceContentEffectsFactory } from '../application/ports/workspaceContentEffects'
import { createFileWorkspaceContentEffects } from './local/fileWorkspaceContentEffects'

/**
 * Root-only binding from the current Task-owned workspace lookup. The authorized
 * reference is valid only in this query scope; it is not a durable preparation ref.
 * No Task row/database or root path crosses the public participant methods.
 */
export function createWorkspaceContentScope(
  workspaceRef: string,
  selected?: WorkspaceContentEffectsFactory,
) {
  const snapshot: AuthorizedWorkspaceSnapshotRef = decodeRepositoryLaunchRef(
    'workspace',
    `sc:workspace:v1:${ulid()}`,
  )
  const effects =
    selected === undefined
      ? createFileWorkspaceContentEffects(workspaceRef)
      : selected.bind(workspaceRef)
  let live = true
  function assertScope(reference: AuthorizedWorkspaceSnapshotRef) {
    if (!live || reference !== snapshot)
      throw new Error('workspace-content-scope-ended-or-mismatched')
  }
  const participant = Object.freeze<WorkspaceContentParticipant>({
    async list(reference, request) {
      assertScope(reference)
      const result = await effects.list(request)
      assertScope(reference)
      return result
    },
    async read(reference, request) {
      assertScope(reference)
      const result = await effects.read(request)
      assertScope(reference)
      return result
    },
  })
  return Object.freeze({
    snapshot,
    participant,
    close: () => {
      live = false
    },
  })
}
