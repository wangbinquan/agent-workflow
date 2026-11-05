// RFC-451 — the cached-repository management surface (`/api/cached-repos`): list, page, refresh, remove and the batch
// import. Composition binds the store, the selected mirrors (a hosted deployment verifies the remote again; a standalone
// daemon clones and fetches its mirror cache), the configured clone timeout and the batch limits; routes depend only on this.

import type {
  BatchImportSnapshot,
  CachedRepo,
  CachedRepoPage,
  CachedRepoPageQuery,
} from '@agent-workflow/shared'
import type { RepositoryRefresh } from './repositoryMirrors'

/** A local mirror refresh: fetch plus the submodule pass it triggers. */
export interface CachedRepositoryRefresh {
  readonly item: CachedRepo
  readonly fetchOk: boolean
  readonly fetchError: string | null
  readonly submoduleSyncOk: boolean
  readonly submoduleSyncError: string | null
  readonly hasSubmodules: boolean
}

export interface CachedRepositoryOperations {
  /** Every registered mirror (the unpaged legacy shape). */
  list(): Promise<CachedRepo[]>
  /** One page with facets; filters and the keyset cursor run in the store. */
  page(query: CachedRepoPageQuery): Promise<CachedRepoPage>
  refresh(id: string): Promise<CachedRepositoryRefresh | RepositoryRefresh>
  /** Refuses with `cached-repo-has-references` while tasks or repo groups reference the mirror, unless forced. */
  remove(
    id: string,
    options: { readonly force: boolean },
  ): Promise<{ readonly deletedLocalPath: string }>
  /** Queues the batch and returns its first snapshot; clones run in the background. */
  startBatchImport(
    request: { readonly urls: string[] },
    initiator: { readonly userId: string },
  ): Promise<BatchImportSnapshot>
  batchSnapshot(batchId: string): BatchImportSnapshot | null
  retryBatchRow(
    batchId: string,
    rowId: string,
    request: { readonly url?: string },
  ): BatchImportSnapshot
}
