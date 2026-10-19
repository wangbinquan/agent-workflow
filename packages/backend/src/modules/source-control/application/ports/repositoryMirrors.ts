// RFC-370 §10 V17 — how registered repositories (`cached_repos`) are read,
// registered and refreshed.
//
// A standalone daemon keeps one mirror clone per URL on its own disk: the
// launch pickers read it, registration clones it and a refresh fetches it. A
// hosted deployment has no git and no persistent disk in the service
// container, and clones only inside each task's own volume; there the pickers
// read the remote from the release's system volume, registration verifies the
// remote before recording the same identity row a hosted URL launch records,
// and a refresh verifies it again.
import type { CachedRepo, RepoFilesResponse, RepoRefsResponse } from '@agent-workflow/shared'

/** What the remote answered while being verified. */
export interface RepositoryRemoteFacts {
  /** The branch the remote's HEAD names; null for an empty repository. */
  readonly defaultBranch: string | null
}

/** Remote reads that run where Git and the deployment's credentials live. */
export interface RepositoryRemoteEffects {
  refs(url: string): Promise<RepoRefsResponse>
  files(url: string): Promise<RepoFilesResponse>
  verify(url: string): Promise<RepositoryRemoteFacts>
}

export interface RepositoryRegistration {
  readonly cachedRepoId: string
  /** False when the URL was already registered. */
  readonly created: boolean
}

export interface RepositoryRefresh {
  readonly item: CachedRepo
  readonly fetchOk: boolean
  readonly fetchError: string | null
  readonly submoduleSyncOk: boolean
  readonly submoduleSyncError: string | null
  readonly hasSubmodules: boolean
}

export interface RepositoryMirrors {
  /** Branches, tags and recent commits of a registered repository. */
  refs(cachedRepoId: string): Promise<RepoRefsResponse>
  /** Repo-relative files of its default branch. */
  files(cachedRepoId: string): Promise<RepoFilesResponse>
  /** The same reads by a mirror directory on the daemon's own disk (the
   * legacy `?path=` form); absent where that disk holds no mirror (hosted). */
  readonly local?: {
    refs(path: string): Promise<RepoRefsResponse>
    files(path: string): Promise<RepoFilesResponse>
  }
  /** Present when registration verifies a remote instead of cloning a mirror
   * (hosted); absent, the mirror cache clones and fetches. */
  readonly remoteRegistration?: {
    register(url: string): Promise<RepositoryRegistration>
    refresh(cachedRepoId: string): Promise<RepositoryRefresh>
  }
}
