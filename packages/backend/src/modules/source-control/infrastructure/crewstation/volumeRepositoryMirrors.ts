// RFC-370 §9.2 V3 — the repository mirror registry of one task volume.
//
// Inside the task image there is no database: the volume itself is the
// registry. A mirror of URL hash `H` is the directory `<volume>/repos/H-<slug>`
// that the standalone mirror cache (`resolveCachedRepo`) creates with its own
// temp-dir + rename cold path, so that very primitive (recursive submodules,
// fetch, fast-forward of requested branches) runs unchanged over the volume.
// Only the cached-repository reads/writes that primitive performs are served;
// every other store capability belongs to the control plane.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runGit } from '@/util/git'
import type {
  CachedRepositoryRecord,
  RepositoryWorkspaceStore,
} from '../../ports/repositoryWorkspaceStore'

/** A cold clone in flight (`<hash>-<slug>~partial~<ulid>`) is never a mirror. */
const PARTIAL = '~'

async function defaultBranchOf(dir: string): Promise<string | null> {
  const head = await runGit(dir, ['symbolic-ref', '--short', 'HEAD'])
  const local = head.stdout.trim()
  if (head.exitCode === 0 && local !== '' && local !== 'HEAD') return local
  const origin = await runGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const remote = origin.stdout.trim().replace(/^origin\//, '')
  return origin.exitCode === 0 && remote !== '' ? remote : null
}

export function createVolumeRepositoryMirrorStore(volumeRoot: string): RepositoryWorkspaceStore {
  const repos = join(volumeRoot, 'repos')
  const unsupported = (capability: string) => () => {
    throw new Error(`volume-repository-store-unsupported: ${capability}`)
  }
  const mirrorOf = (hash: string): string | null => {
    if (!existsSync(repos)) return null
    const names = readdirSync(repos).filter(
      (name) => name.startsWith(`${hash}-`) && !name.includes(PARTIAL),
    )
    if (names.length > 1) throw new Error('volume-repository-mirror-ambiguous')
    return names.length === 0 ? null : join(repos, names[0]!)
  }
  return {
    runtimeIdentity: {},
    async findCachedRepoByHash(hash) {
      const localPath = mirrorOf(hash)
      if (localPath === null) return null
      return {
        id: hash,
        urlHash: hash,
        urlEnc: null,
        urlRedacted: null,
        localPath,
        defaultBranch: await defaultBranchOf(localPath).catch(() => null),
        // A present directory was fetched before; an invalid one is re-cloned
        // in place by the mirror primitive itself.
        lastFetchedAt: 1,
        createdAt: 0,
        hasSubmodules: null,
        lastSubmoduleSyncOk: null,
        lastSubmoduleSyncError: null,
        lastAutoRefreshAt: null,
      } satisfies CachedRepositoryRecord
    },
    // The directory is the record: writes have nothing further to persist.
    insertCachedRepo: async () => true,
    updateCachedRepo: async () => true,
    upsertCachedRepo: async () => undefined,
    cachedRepoReferenceCount: async () => 0,
    cachedRepoReferenceCounts: async () => new Map(),
    invalidateCachedRepoFacets: () => undefined,
    findCachedRepoById: unsupported('findCachedRepoById'),
    countCachedRepos: unsupported('countCachedRepos'),
    listCachedRepos: unsupported('listCachedRepos'),
    listCachedRepoPage: unsupported('listCachedRepoPage'),
    listDueCachedRepos: unsupported('listDueCachedRepos'),
    stampAutoRefreshed: unsupported('stampAutoRefreshed'),
    listKnownRepositoryPaths: unsupported('listKnownRepositoryPaths'),
    groupsReferencingRepo: unsupported('groupsReferencingRepo'),
    detachRepoFromAllGroups: unsupported('detachRepoFromAllGroups'),
    deleteCachedRepoAndDetachGroups: unsupported('deleteCachedRepoAndDetachGroups'),
    readCredentialSealingSnapshot: unsupported('readCredentialSealingSnapshot'),
    applyCredentialSealingMutation: unsupported('applyCredentialSealingMutation'),
    compactAfterCredentialScrub: unsupported('compactAfterCredentialScrub'),
    readRepositoryGroupSnapshot: unsupported('readRepositoryGroupSnapshot'),
    createRepositoryGroup: unsupported('createRepositoryGroup'),
    updateRepositoryGroup: unsupported('updateRepositoryGroup'),
    deleteRepositoryGroup: unsupported('deleteRepositoryGroup'),
    findWorktreeTask: unsupported('findWorktreeTask'),
  }
}
