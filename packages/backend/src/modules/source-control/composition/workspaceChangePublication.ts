// RFC-475 — binds the workspace change publication (application/workspaceChangePublication.ts)
// to one selected workspace scope and the RFC-321 transport; the commit and
// sub-workspace binders are this module's own. Assembly only: no filesystem,
// process or database access here.
import { publishWorkspaceChanges } from '../application/workspaceChangePublication'
import type { RepositoryGitWorkspaceScope } from '../application/ports/repositoryGitWorkspace'
import type {
  RepositoryPublicationLogger,
  WorkspaceChangePublicationParticipant,
  WorkspaceChangePublicationRequest,
} from '../application/ports/workspaceChangePublication'
import type { RepositoryPublicationTransport } from '../public/types'
import { bindRepositoryCommitParticipant } from './repositoryCommit'
import {
  bindRepositoryGitSubworkspace,
  requireRepositoryGitWorkspaceScope,
} from './repositoryGitWorkspaces'

export function bindWorkspaceChangePublication(input: {
  readonly workspace: RepositoryGitWorkspaceScope
  readonly transport: RepositoryPublicationTransport
  readonly log: RepositoryPublicationLogger
}): WorkspaceChangePublicationParticipant {
  requireRepositoryGitWorkspaceScope(input.workspace)
  const deps = Object.freeze({
    workspace: input.workspace,
    transport: input.transport,
    log: input.log,
    commits: bindRepositoryCommitParticipant,
    subworkspace: bindRepositoryGitSubworkspace,
  })
  return Object.freeze({
    publish: (request: WorkspaceChangePublicationRequest) => publishWorkspaceChanges(request, deps),
  })
}
