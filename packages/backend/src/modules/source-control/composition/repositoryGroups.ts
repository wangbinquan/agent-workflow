// RFC-447 — the repository-group operations (see the port), bound to the use cases. The URL import that used to be assembled
// in routes/repoGroups.ts is chosen in infrastructure (`repositoryUrlImport.ts`, RFC-612).
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
import { repositoryUrlImportFor } from '../infrastructure/repositoryUrlImport'

export function composeRepositoryGroups(input: {
  readonly store: RepositoryWorkspaceStore
  readonly mirrors: RepositoryMirrors
  /** The configured git clone wait budget; falsy means the cache default. */
  readonly cloneTimeoutMs: () => Promise<number | undefined>
}): RepositoryGroups {
  const { store } = input
  const urlImport = repositoryUrlImportFor(input)
  const writeDeps = async (): Promise<RepoGroupDeps> => ({
    store,
    importRepositoryUrl: await urlImport(),
  })
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
