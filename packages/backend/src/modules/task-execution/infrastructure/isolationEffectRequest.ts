import { sha256Hex } from '@/util/hash'

/** Epoch-1 effect requests keep their wire keys and insertion order across mount projection. */
export function isolationCreateRequest(
  isoKeyRunId: string,
  repos: readonly { mountPath: string; worktreePath: string }[],
  forcedContainerPaths: readonly string[],
) {
  return {
    v: 1,
    isoKeyRunId,
    repos: repos.map((repo) => ({
      worktreeDirName: repo.mountPath,
      worktreePathDigest: sha256Hex(repo.worktreePath),
    })),
    forcedContainerPaths,
  }
}

export function isolationMergeRequest(
  nodeRunId: string,
  via: 'live' | 'replay',
  suppliedNodeTrees: boolean,
  repos: readonly { mountPath: string; baseSnapshot: string }[],
) {
  return {
    v: 1,
    nodeRunId,
    via,
    suppliedNodeTrees,
    repos: repos.map((repo) => ({
      worktreeDirName: repo.mountPath,
      baseSnapshot: repo.baseSnapshot,
    })),
  }
}

export function isolationCleanupRequest(
  dbNodeRunId: string,
  isoKey: string,
  repos: readonly { mountPath: string; isoWorktreePath: string }[],
) {
  return {
    v: 1,
    dbNodeRunId,
    isoKey,
    repos: repos.map((repo) => ({
      worktreeDirName: repo.mountPath,
      isoWorktreePathDigest: sha256Hex(repo.isoWorktreePath),
    })),
  }
}
