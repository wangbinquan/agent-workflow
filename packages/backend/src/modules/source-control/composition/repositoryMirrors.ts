// RFC-370 §10 V17 — the selected repository mirrors (see the port).
import { gitUrlCacheKeyWith, parseGitUrl } from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import {
  ensureCachedRepoIdentity,
  invalidateRepoFacetsCache,
  rowToCached,
} from '@/services/gitRepoCache'
import { getRepoFiles, getRepoRefs } from '@/services/repo'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { sha1Hex } from '@/util/hash'
import type {
  CachedRepositoryRecord,
  RepositoryWorkspaceStore,
} from '../ports/repositoryWorkspaceStore'
import type {
  RepositoryMirrors,
  RepositoryRemoteEffects,
} from '../application/ports/repositoryMirrors'

export function composeRepositoryMirrors(input: {
  readonly store: RepositoryWorkspaceStore
  readonly secretBox?: SecretBox
  readonly appHome?: string
  readonly now?: () => number
  /** Hosted: remote reads in the release's system volume. Absent: the
   * daemon's own mirror clones. */
  readonly remote?: RepositoryRemoteEffects
}): RepositoryMirrors {
  const registered = async (id: string): Promise<CachedRepositoryRecord> => {
    const row = await input.store.findCachedRepoById(id)
    if (row === null)
      throw new NotFoundError('cached-repo-not-found', `cached repo ${id} not found`)
    return row
  }
  const remote = input.remote
  if (remote === undefined) {
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
      refs: (id) => local(id, (path) => getRepoRefs(path)),
      files: (id) => local(id, getRepoFiles),
      local: { refs: (path) => getRepoRefs(path), files: getRepoFiles },
    }
  }
  const now = input.now ?? Date.now
  const remoteOf = (row: CachedRepositoryRecord): string => {
    const url = unsealRepoUrl(row, input.secretBox, input.store)
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
    invalidateRepoFacetsCache(input.store)
  }
  return {
    refs: async (id) => remote.refs(remoteOf(await registered(id))),
    files: async (id) => remote.files(remoteOf(await registered(id))),
    remoteRegistration: {
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
        const identity = await ensureCachedRepoIdentity(
          {
            store: input.store,
            ...(input.appHome === undefined ? {} : { appHome: input.appHome }),
            ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
            now,
          },
          { url },
        )
        await recordVerified(identity.cachedRepoId, facts.defaultBranch)
        return { cachedRepoId: identity.cachedRepoId, created: before === null }
      },
      async refresh(id) {
        const row = await registered(id)
        const facts = await remote.verify(remoteOf(row))
        await recordVerified(id, facts.defaultBranch)
        const updated = await registered(id)
        return {
          item: rowToCached(updated, await input.store.cachedRepoReferenceCount(id)),
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
