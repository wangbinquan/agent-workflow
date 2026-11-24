export type { WorkspacePresenceQueries } from '../application/ports/workspacePresence'
export type { RepositoryWorkspaceReadQueries } from '../application/ports/repositoryWorkspaceReadQueries'
export { selectRepositoryWorkspaceReadQueries } from '../composition/repositoryWorkspaceReadQueries'

// RFC-491: the task agent mount rule (RFC-487) is no longer offered here — its one production reader, the native
// compatibility run, left production for tests/helpers; source-control's own workspace contents read the domain rule.

// RFC-565: `existingRepositoryIds` and the SQL fragment `repositoryExistsExpression` left the public (their signatures carry
// a database handle). Bootstrap takes them from source-control's composition and hands the bound read to memory and the
// fragment to Task Execution's knowledge read.
