// RFC-451 — the cached-repository management surface over the selected mirrors and the local mirror cache.
// The branches and settings are the ones the `/api/cached-repos` route used to assemble itself.
// RFC-612 (RFC-294 S10 remainder): moved unchanged from `composition/` — it implements the `CachedRepositoryOperations` port
// (a remote registration refreshes through the mirrors, the local mirror cache fetches the clone), so it is infrastructure.

import type { SecretBox } from '@/platform/contracts/secretBox'
import type { CachedRepositoryOperations } from '../application/ports/cachedRepositoryOperations'
import type { RepositoryMirrors } from '../application/ports/repositoryMirrors'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'
import {
  getBatchSnapshot,
  retryBatchRow,
  startBatchImport,
  type RepositoryBatchImports,
} from './local/repositoryBatchImport'
import {
  deleteCachedRepo,
  listCachedRepos,
  listCachedReposPage,
  refreshCachedRepo,
} from './local/repositoryMirrorCache'

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
  /** RFC-548: the daemon's one set of batch imports (the realtime owner lookup and the GC ticker read the same one). */
  readonly batchImports: RepositoryBatchImports
  readonly appHome?: string | undefined
  readonly secretBox?: SecretBox | undefined
}): CachedRepositoryOperations {
  const { store, configuration, batchImports } = input
  const mirrors = input.mirrors.registration
  const registration =
    mirrors.kind === 'remote' ? { register: (url: string) => mirrors.register(url) } : {}
  const local = {
    store,
    ...(input.appHome === undefined ? {} : { appHome: input.appHome }),
    ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
  }
  const operations: CachedRepositoryOperations = {
    list: () => listCachedRepos(store),
    page: (query) => listCachedReposPage(store, query),
    async refresh(id) {
      if (mirrors.kind === 'remote') return await mirrors.refresh(id)
      // The mirror cache fetches the clone (RFC-527: the `mirror-cache` registration).
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
        batchImports,
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
    batchSnapshot: (batchId) => getBatchSnapshot(batchImports, batchId),
    retryBatchRow: (batchId, rowId, request) =>
      retryBatchRow(
        batchImports,
        { ...local, ...registration },
        batchId,
        rowId,
        request.url === undefined ? {} : { url: request.url },
      ),
  }
  return Object.freeze(operations)
}
