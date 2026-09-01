/**
 * Provider-neutral repository workspace operations used by legacy HTTP and
 * service facades while bootstrap owns the concrete SQLite/PostgreSQL adapter.
 * No database client, SQL builder or provider handle crosses this boundary.
 */
export type {
  CachedRepositoryRecord,
  RepositoryCredentialSealingMutation,
  RepositoryGroupNodeRecord,
  RepositoryGroupRecord,
  RepositoryGroupSnapshot,
  RepositoryWorkspaceStore,
  WorktreeTaskRecord,
} from '../ports/repositoryWorkspaceStore'

export { invalidateRepositoryWorkspaceFacetCaches } from '../ports/repositoryWorkspaceStore'
