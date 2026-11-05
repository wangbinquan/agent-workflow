// RFC-451 — composes the cached-repository management surface over the selected mirrors and the local mirror cache.
// The branches and settings are the ones the `/api/cached-repos` route used to assemble itself.

import type { SecretBox } from '@/auth/secretBox'
import type { CachedRepositoryOperations } from '../application/ports/cachedRepositoryOperations'
import type { RepositoryMirrors } from '../application/ports/repositoryMirrors'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'
import {
  getBatchSnapshot,
  retryBatchRow,
  startBatchImport,
} from '../infrastructure/local/repositoryBatchImport'
import {
  deleteCachedRepo,
  listCachedRepos,
  listCachedReposPage,
  refreshCachedRepo,
} from '../infrastructure/local/repositoryMirrorCache'

/** The settings these operations read per call (the daemon's live configuration). */
export interface CachedRepositorySettingsSnapshot {
  readonly gitCloneTimeoutMs?: number | undefined
  readonly repoBatchImportConcurrency?: number | undefined
  readonly repoBatchImportRetentionMs?: number | undefined
}
export interface CachedRepositorySettings {
  read(): CachedRepositorySettingsSnapshot | Promise<CachedRepositorySettingsSnapshot>
}

export function composeCachedRepositoryOperations(input: {
  readonly store: RepositoryWorkspaceStore
  readonly mirrors: RepositoryMirrors
  readonly configuration: CachedRepositorySettings
  readonly appHome?: string | undefined
  readonly secretBox?: SecretBox | undefined
}): CachedRepositoryOperations {
  const { store, configuration } = input
  const remote = input.mirrors.remoteRegistration
  const registration =
    remote === undefined ? {} : { register: (url: string) => remote.register(url) }
  const local = {
    store,
    ...(input.appHome === undefined ? {} : { appHome: input.appHome }),
    ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
  }
  const operations: CachedRepositoryOperations = {
    list: () => listCachedRepos(store),
    page: (query) => listCachedReposPage(store, query),
    async refresh(id) {
      if (remote !== undefined) return await remote.refresh(id)
      // RFC-208: `gitCloneTimeoutMs` was dead config — the schema accepted it but
      // nothing ever passed it to `cloneTimeoutMs`, so an operator tightening the
      // window had no effect. Manual refresh shells out to `git fetch` against a
      // remote host, which is exactly the call that needs a bound.
      const cfg = await configuration.read()
      return await refreshCachedRepo(
        { ...local, ...(cfg.gitCloneTimeoutMs ? { cloneTimeoutMs: cfg.gitCloneTimeoutMs } : {}) },
        id,
      )
    },
    remove: (id, options) => deleteCachedRepo({ store }, id, { force: options.force }),
    async startBatchImport(request, initiator) {
      const cfg = await configuration.read()
      const result = startBatchImport(
        {
          ...local,
          ...(cfg.repoBatchImportConcurrency === undefined
            ? {}
            : { concurrency: cfg.repoBatchImportConcurrency }),
          ...(cfg.repoBatchImportRetentionMs === undefined
            ? {}
            : { retentionMs: cfg.repoBatchImportRetentionMs }),
          ...registration,
        },
        { urls: request.urls },
        // RFC-285 B6②：发起者归属（WS 升级门判定依据）。
        { userId: initiator.userId },
      )
      return result.snapshot
    },
    batchSnapshot: (batchId) => getBatchSnapshot(batchId),
    retryBatchRow: (batchId, rowId, request) =>
      retryBatchRow(
        { ...local, ...registration },
        batchId,
        rowId,
        request.url === undefined ? {} : { url: request.url },
      ),
  }
  return Object.freeze(operations)
}
