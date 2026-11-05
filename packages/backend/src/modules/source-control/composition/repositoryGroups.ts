// RFC-447 — the repository-group operations (see the port). The URL import
// that used to be assembled in routes/repoGroups.ts lives here: a hosted
// deployment registers a verified remote instead of cloning (RFC-370 §10 V17);
// a standalone daemon clones into its mirror cache, waiting at most the
// configured git clone budget, read once per create / replace.
import { resolveCachedRepo, type GitRepoCacheDeps } from '@/services/gitRepoCache'
import {
  createRepoGroup,
  deleteRepoGroup,
  getRepoGroup,
  getRepoGroupLayoutResponse,
  listRepoGroups,
  previewRepoGroupLayout,
  updateRepoGroup,
  type RepoGroupDeps,
} from '../application/repositoryGroups'
import type { RepositoryGroups } from '../application/ports/repositoryGroups'
import type { RepositoryMirrors } from '../application/ports/repositoryMirrors'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'

/** A standalone daemon's URL import: clone (or reuse) the mirror and return
 * its registered id. */
export function localRepositoryUrlImport(
  cache: GitRepoCacheDeps,
): (url: string) => Promise<string> {
  return async (url) => (await resolveCachedRepo(cache, { url })).cached.id
}

export function composeRepositoryGroups(input: {
  readonly store: RepositoryWorkspaceStore
  readonly mirrors: RepositoryMirrors
  /** The configured git clone wait budget; falsy means the cache default. */
  readonly cloneTimeoutMs: () => Promise<number | undefined>
}): RepositoryGroups {
  const { store } = input
  const remote = input.mirrors.remoteRegistration
  const writeDeps = async (): Promise<RepoGroupDeps> => {
    if (remote !== undefined) {
      return {
        store,
        importRepositoryUrl: async (url) => (await remote.register(url)).cachedRepoId,
      }
    }
    const cloneTimeoutMs = await input.cloneTimeoutMs()
    return {
      store,
      importRepositoryUrl: localRepositoryUrlImport({
        store,
        ...(cloneTimeoutMs ? { cloneTimeoutMs } : {}),
      }),
    }
  }
  return {
    list: () => listRepoGroups(store),
    get: (id) => getRepoGroup(store, id),
    layout: (id) => getRepoGroupLayoutResponse(store, id),
    preview: (draft) => previewRepoGroupLayout(store, draft),
    create: async (group, actorUserId) => createRepoGroup(await writeDeps(), group, actorUserId),
    update: async (id, group, expectedVersion) =>
      updateRepoGroup(await writeDeps(), id, group, expectedVersion),
    remove: (id, options) => deleteRepoGroup(store, id, options),
  }
}
