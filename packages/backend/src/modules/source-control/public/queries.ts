export type { WorkspacePresenceQueries } from '../application/ports/workspacePresence'
export type { RepositoryWorkspaceReadQueries } from '../application/ports/repositoryWorkspaceReadQueries'
export { selectRepositoryWorkspaceReadQueries } from '../composition/repositoryWorkspaceReadQueries'

/** Secret-free system projection; no repository persistence mechanism leaks. */
export interface RepositoryOverviewQueries {
  countCachedRepositories(): Promise<number>
}

// RFC-491: the task agent mount rule (RFC-487) is no longer offered here — its one production reader, the native
// compatibility run, left production for tests/helpers; source-control's own workspace contents read the domain rule.

export {
  existingRepositoryIds,
  repositoryExistsExpression,
} from '../infrastructure/repositoryIdentityQueries'
