// RFC-447 — the repository-group management operations the HTTP surface uses
// (RFC-248 / RFC-249 directory trees). Composition binds them to the
// repository workspace store and to the deployment's URL import (a hosted
// deployment registers a verified remote; a standalone daemon clones into its
// mirror cache).
import type {
  CreateRepoGroup,
  RepoGroup,
  RepoGroupLayoutResponse,
  RepoGroupNodeInput,
} from '@agent-workflow/shared'
import type { RepositoryGroupSnapshot } from '../../ports/repositoryWorkspaceStore'

/** The one read a group's flattening needs; every repository workspace store
 * provides it. Kept this narrow so the public layout query does not expose the
 * whole store. */
export interface RepositoryGroupSnapshotReader {
  readRepositoryGroupSnapshot(): Promise<RepositoryGroupSnapshot>
}

/** What deleting a group detached, archived and disabled. */
export interface RepositoryGroupDeletion {
  readonly archivedMemories: number
  readonly detachedReferences: number
  readonly disabledSchedules: number
}

/** A draft's flattened layout; repositories still to be imported by URL are
 * counted but not listed. */
export type RepositoryGroupPreview = RepoGroupLayoutResponse & {
  readonly pendingImports: number
  readonly pendingRepoPaths: string[]
}

export interface RepositoryGroupDraft {
  readonly name?: string
  readonly nodes: readonly RepoGroupNodeInput[]
}

export interface RepositoryGroups {
  list(): Promise<RepoGroup[]>
  get(id: string): Promise<RepoGroup>
  /** The group's flattened layout (directory nodes, repositories, depth). */
  layout(id: string): Promise<RepoGroupLayoutResponse>
  preview(draft: RepositoryGroupDraft): Promise<RepositoryGroupPreview>
  create(group: CreateRepoGroup, actorUserId: string | null): Promise<RepoGroup>
  /** Full replacement; `expectedVersion` fences a concurrent edit. */
  update(id: string, group: CreateRepoGroup, expectedVersion?: number): Promise<RepoGroup>
  /** Without `force`, a group still referenced by another group or an enabled
   * schedule is refused. */
  remove(id: string, options: { readonly force: boolean }): Promise<RepositoryGroupDeletion>
}
