// RFC-370 §10 V17 — the selected repository mirrors (see the port). RFC-512: the reads, the registration and the
// refresh are application use cases (application/repositoryMirrors.ts); this assembly selects standalone or
// hosted and hands each its effects. RFC-527: two explicit assemblies. RFC-531: the deployment profile selects one (and
// the matching mirror refresh) instead of the daemon branching on whether the deployment has a remote.
import type { SecretBox } from '@/auth/secretBox'
import {
  ensureCachedRepoIdentity,
  invalidateRepoFacetsCache,
  rowToCached,
} from '../infrastructure/local/repositoryMirrorCache'
import { unsealRepoUrl } from '@/services/repoCredentials'
import {
  createKnownPathRepositoryReads,
  getRepoFiles,
  getRepoRefs,
} from '../infrastructure/local/repositoryIntrospection'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'
import type {
  RepositoryMirrors,
  RepositoryRemoteEffects,
} from '../application/ports/repositoryMirrors'
import {
  createLocalRepositoryMirrors,
  createRemoteRepositoryMirrors,
} from '../application/repositoryMirrors'

/** Standalone: the daemon's own mirror clones, read by directory (RFC-527: bootstrap selects it for a null remote). */
export function composeLocalRepositoryMirrors(input: {
  readonly store: RepositoryWorkspaceStore
}): RepositoryMirrors {
  return createLocalRepositoryMirrors({
    store: input.store,
    reads: { refs: (path) => getRepoRefs(path), files: getRepoFiles },
    // RFC-446: the `?path=` form reads only inside a registered mirror (the
    // check routes/repos.ts used to make before calling these).
    local: createKnownPathRepositoryReads(() => input.store.listKnownRepositoryPaths()),
  })
}

/** Hosted: remote reads in the release's system volume (RFC-527: bootstrap selects it for a hosted remote). */
export function composeRemoteRepositoryMirrors(input: {
  readonly store: RepositoryWorkspaceStore
  readonly remote: RepositoryRemoteEffects
  readonly secretBox?: SecretBox
  readonly appHome?: string
  readonly now?: () => number
}): RepositoryMirrors {
  const now = input.now ?? Date.now
  return createRemoteRepositoryMirrors({
    store: input.store,
    remote: input.remote,
    now,
    cache: {
      unsealUrl: (row) => unsealRepoUrl(row, input.secretBox, input.store),
      ensureIdentity: (url) =>
        ensureCachedRepoIdentity(
          {
            store: input.store,
            ...(input.appHome === undefined ? {} : { appHome: input.appHome }),
            ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
            now,
          },
          { url },
        ),
      invalidateFacets: () => invalidateRepoFacetsCache(input.store),
      project: rowToCached,
    },
  })
}
