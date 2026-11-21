// RFC-512 — registered repository reads, remote registration and refresh (RFC-370 §10 V17) as use cases. The
// effects come from the assembly: the mirror directory reads, the known-path reads and the mirror cache.
import { gitUrlCacheKeyWith, parseGitUrl } from '@agent-workflow/shared'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { sha1Hex } from '@/util/hash'
import type {
  CachedRepositoryRecord,
  RepositoryWorkspaceStore,
} from '../ports/repositoryWorkspaceStore'
import type {
  RepositoryDirectoryReads,
  RepositoryMirrorCache,
  RepositoryMirrors,
  RepositoryRemoteEffects,
} from './ports/repositoryMirrors'

/** A registered repository by id; an unknown id is a 404. */
export async function readRegisteredRepository(
  store: Pick<RepositoryWorkspaceStore, 'findCachedRepoById'>,
  id: string,
): Promise<CachedRepositoryRecord> {
  const row = await store.findCachedRepoById(id)
  if (row === null) throw new NotFoundError('cached-repo-not-found', `cached repo ${id} not found`)
  return row
}

/** Standalone: the daemon's own mirror clones, read by directory. */
export function createLocalRepositoryMirrors(input: {
  readonly store: Pick<RepositoryWorkspaceStore, 'findCachedRepoById'>
  /** Reads inside one mirror directory. */
  readonly reads: RepositoryDirectoryReads
  /** RFC-446: the `?path=` form, which reads only inside a registered mirror. */
  readonly local: RepositoryDirectoryReads
}): RepositoryMirrors {
  const registered = (id: string) => readRegisteredRepository(input.store, id)
  const local = async <T>(id: string, read: (path: string) => Promise<T>): Promise<T> => {
    const row = await registered(id)
    try {
      return await read(row.localPath)
    } catch (error) {
      // The wire never carries a mirror's local path (RFC-204: a historical
      // slug can embed a token); the repository id names it instead.
      if (error instanceof DomainError)
        throw new DomainError(error.code, `cached repo '${id}': ${error.code}`, error.status)
      throw error
    }
  }
  return {
    refs: (id) => local(id, (path) => input.reads.refs(path)),
    files: (id) => local(id, (path) => input.reads.files(path)),
    local: input.local,
    registration: { kind: 'mirror-cache' },
  }
}

/** Hosted: the remote is read and verified where Git and the deployment's credentials live. */
export function createRemoteRepositoryMirrors(input: {
  readonly store: Pick<
    RepositoryWorkspaceStore,
    'findCachedRepoById' | 'findCachedRepoByHash' | 'updateCachedRepo' | 'cachedRepoReferenceCount'
  >
  readonly remote: RepositoryRemoteEffects
  readonly cache: RepositoryMirrorCache
  /** Chosen once by the assembly and shared with the identity row. */
  readonly now: () => number
}): RepositoryMirrors {
  const registered = (id: string) => readRegisteredRepository(input.store, id)
  const remote = input.remote
  const now = input.now
  const remoteOf = (row: CachedRepositoryRecord): string => {
    const url = input.cache.unsealUrl(row)
    if (url === null)
      throw new DomainError(
        'repo-url-unavailable',
        `cached repo '${row.id}' has no readable URL (sealed with a different secret.key?), so its remote cannot be read`,
        409,
        { url: row.urlRedacted },
      )
    return url
  }
  /** A verified remote counts as fetched: the platform reached it just now. */
  const recordVerified = async (id: string, defaultBranch: string | null): Promise<void> => {
    await input.store.updateCachedRepo(id, { defaultBranch, lastFetchedAt: now() })
    input.cache.invalidateFacets()
  }
  return {
    refs: async (id) => remote.refs(remoteOf(await registered(id))),
    files: async (id) => remote.files(remoteOf(await registered(id))),
    registration: {
      kind: 'remote',
      async register(url) {
        const parsed = parseGitUrl(url)
        if (parsed === null)
          throw new ValidationError('repo-url-invalid', 'unsupported or malformed Git URL')
        const facts = await remote.verify(url)
        const before = await input.store.findCachedRepoByHash(
          gitUrlCacheKeyWith(parsed, sha1Hex).hash,
        )
        // The same identity row a hosted URL launch records; the content is
        // fetched by each task inside its own volume.
        const identity = await input.cache.ensureIdentity(url)
        await recordVerified(identity.cachedRepoId, facts.defaultBranch)
        return { cachedRepoId: identity.cachedRepoId, created: before === null }
      },
      async refresh(id) {
        const row = await registered(id)
        const facts = await remote.verify(remoteOf(row))
        await recordVerified(id, facts.defaultBranch)
        const updated = await registered(id)
        return {
          item: input.cache.project(updated, await input.store.cachedRepoReferenceCount(id)),
          fetchOk: true,
          fetchError: null,
          submoduleSyncOk: updated.lastSubmoduleSyncOk ?? true,
          submoduleSyncError: updated.lastSubmoduleSyncError ?? null,
          hasSubmodules: updated.hasSubmodules ?? false,
        }
      },
    },
  }
}
