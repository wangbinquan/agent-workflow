import type { OwnCodeHostPushCredentialList } from '@agent-workflow/shared'
import type { OwnRepositoryCredentialSubject } from './types'

export type { WorkspacePresenceQueries } from '../application/ports/workspacePresence'
export type { RepositoryWorkspaceReadQueries } from '../application/ports/repositoryWorkspaceReadQueries'
export { selectRepositoryWorkspaceReadQueries } from '../composition/repositoryWorkspaceReadQueries'

export interface OwnRepositoryTransportCredentialQueries {
  list(subject: OwnRepositoryCredentialSubject): Promise<OwnCodeHostPushCredentialList>
}

/** Secret-free system projection; no repository persistence mechanism leaks. */
export interface RepositoryOverviewQueries {
  countCachedRepositories(): Promise<number>
}

export { repoRelForcedPaths } from '../domain/forcedWorkspacePaths'
