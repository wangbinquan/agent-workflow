// RFC-447 — how a repository-group write imports a URL. A hosted deployment registers a verified remote instead of cloning
// (RFC-370 §10 V17); a standalone daemon clones (or reuses) the mirror in its cache, waiting at most the configured git clone
// budget, read once per create / replace.
// RFC-612 (RFC-294 S10 remainder): the choice depends on the selected mirrors implementation, so it lives here (moved from
// `composition/repositoryGroups.ts`); the composition only binds the use cases.
import type { RepositoryMirrors } from '../application/ports/repositoryMirrors'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'
import { resolveCachedRepo, type GitRepoCacheDeps } from './local/repositoryMirrorCache'

/** A standalone daemon's URL import: clone (or reuse) the mirror and return its registered id. */
export function localRepositoryUrlImport(
  cache: GitRepoCacheDeps,
): (url: string) => Promise<string> {
  return async (url) => (await resolveCachedRepo(cache, { url })).cached.id
}

/** The URL import of one write; a standalone daemon reads the clone budget each time (falsy means the cache default). */
export function repositoryUrlImportFor(input: {
  readonly store: RepositoryWorkspaceStore
  readonly mirrors: RepositoryMirrors
  readonly cloneTimeoutMs: () => Promise<number | undefined>
}): () => Promise<(url: string) => Promise<string>> {
  const { store } = input
  const mirrors = input.mirrors.registration
  if (mirrors.kind === 'remote') {
    const register = async (url: string) => (await mirrors.register(url)).cachedRepoId
    return async () => register
  }
  return async () => {
    const cloneTimeoutMs = await input.cloneTimeoutMs()
    return localRepositoryUrlImport({ store, ...(cloneTimeoutMs ? { cloneTimeoutMs } : {}) })
  }
}
