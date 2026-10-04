import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  IsolationConflict,
  IsolationWorkspace,
  IsolationWorkspaceBinding,
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
} from '../../application/ports/isolationWorkspace'
import {
  chooseIsoWorkspaceKey,
  completeHumanResolvedConflict,
  createNodeIso,
  discardIsolationWorkspace,
  isoKeyOf,
  mergeBackNodeIso,
  rebuildIsoHandle,
  resolveConflictWithAgent,
  snapshotNodeIsoFinal,
  undoPriorShardDeltaInIso,
  type IsoHandle,
  type MergeBackConflict,
} from '@/platform/workspace/local/isolation'
import { gitBlobHashes, gitChangedFiles, runGit } from '@/util/git'

function describeWorkspace(handle: IsoHandle): IsolationWorkspace {
  return {
    taskId: handle.taskId,
    key: handle.nodeRunId,
    dbNodeRunId: handle.dbNodeRunId,
    isolationRef: handle.containerPath,
    workspaceRef: handle.containerPath,
    passthrough: handle.passthrough,
    repositories: handle.repos.map((repo) => ({
      repositoryRef: repo.repoPath,
      canonicalRef: repo.canonWorktreePath,
      workspaceRef: repo.isoWorktreePath,
      mount: repo.worktreeDirName,
      baseBranch: repo.baseBranch,
      baseSnapshot: repo.baseSnapshot,
      taskBaseHead: repo.taskBaseHead,
      forcedRelativePaths: repo.forcedRepoRelPaths,
      submoduleBases: repo.subBases,
      poolRefs: repo.poolDirs,
      pendingSubResolutions: repo.pendingSubResolves,
    })),
  }
}

function nativeHandle(workspace: IsolationWorkspace): IsoHandle {
  return {
    taskId: workspace.taskId,
    nodeRunId: workspace.key,
    dbNodeRunId: workspace.dbNodeRunId,
    containerPath: workspace.workspaceRef,
    passthrough: workspace.passthrough,
    repos: workspace.repositories.map((repo) => ({
      repoPath: repo.repositoryRef,
      canonWorktreePath: repo.canonicalRef,
      isoWorktreePath: repo.workspaceRef,
      worktreeDirName: repo.mount,
      baseBranch: repo.baseBranch,
      baseSnapshot: repo.baseSnapshot,
      taskBaseHead: repo.taskBaseHead,
      forcedRepoRelPaths: repo.forcedRelativePaths,
      subBases: repo.submoduleBases,
      poolDirs: repo.poolRefs,
      pendingSubResolves: repo.pendingSubResolutions,
    })),
  }
}

/** Native topology mutations survive both completion and rejection. */
function retainTopology(workspace: IsolationWorkspace, handle: IsoHandle): void {
  for (let index = 0; index < handle.repos.length; index += 1) {
    const target = workspace.repositories[index]!
    const native = handle.repos[index]!
    target.forcedRelativePaths = native.forcedRepoRelPaths
    target.submoduleBases = native.subBases
    target.poolRefs = native.poolDirs
    target.pendingSubResolutions = native.pendingSubResolves
  }
}

function describeConflict(conflict: MergeBackConflict): IsolationConflict {
  return {
    mount: conflict.worktreeDirName,
    paths: conflict.paths,
    mergedTree: conflict.mergedTree,
    rawConflictOutput: conflict.rawConflictOutput,
    base: conflict.base,
    canonicalRef: conflict.canonWorktreePath,
    taskBaseHead: conflict.taskBaseHead,
    salvagedPaths: conflict.salvagedPaths,
    forcedRelativePaths: conflict.forcedRepoRelPaths,
  }
}

function nativeConflict(conflict: IsolationConflict): MergeBackConflict {
  return {
    worktreeDirName: conflict.mount,
    paths: conflict.paths,
    mergedTree: conflict.mergedTree,
    rawConflictOutput: conflict.rawConflictOutput,
    base: conflict.base,
    canonWorktreePath: conflict.canonicalRef,
    taskBaseHead: conflict.taskBaseHead,
    salvagedPaths: conflict.salvagedPaths,
    forcedRepoRelPaths: conflict.forcedRelativePaths,
  }
}

function bindLocalIsolationWorkspace(binding: IsolationWorkspaceBinding): IsolationWorkspaceScope {
  const canonRepos = binding.repositories.map((repo) => ({
    repoPath: repo.repositoryRef,
    worktreePath: repo.workspaceRef,
    worktreeDirName: repo.mount,
    baseBranch: repo.baseBranch,
  }))
  return Object.freeze<IsolationWorkspaceScope>({
    recoverKey: isoKeyOf,
    chooseGeneration: (baseKey, log) =>
      chooseIsoWorkspaceKey({
        appHome: binding.storageRootRef,
        taskId: binding.taskId,
        baseKey,
        canonRepos,
        ...(log === undefined ? {} : { log }),
      }),
    async create(input) {
      return describeWorkspace(
        await createNodeIso({
          appHome: binding.storageRootRef,
          taskId: binding.taskId,
          nodeRunId: input.key,
          dbNodeRunId: input.dbNodeRunId,
          canonRepos,
          ...(input.forcedContainerPaths === undefined
            ? {}
            : { forcedContainerPaths: input.forcedContainerPaths }),
          ...(input.submoduleMode === undefined ? {} : { submoduleMode: input.submoduleMode }),
          ...(input.submoduleJobs === undefined ? {} : { submoduleJobs: input.submoduleJobs }),
          ...(input.log === undefined ? {} : { log: input.log }),
        }),
      )
    },
    restore(input) {
      return describeWorkspace(
        rebuildIsoHandle({
          appHome: binding.storageRootRef,
          taskId: binding.taskId,
          nodeRunId: input.key,
          dbNodeRunId: input.dbNodeRunId,
          canonRepos,
          baseSnapshots: input.baseSnapshots,
          taskBaseHeads: input.taskBaseHeads,
          ...(input.forcedContainerPaths === undefined
            ? {}
            : { forcedContainerPaths: input.forcedContainerPaths }),
          ...(input.submodules === undefined
            ? {}
            : {
                submodules: Object.fromEntries(
                  Object.entries(input.submodules).map(([mount, topology]) => [
                    mount,
                    {
                      subBases: topology.submoduleBases,
                      ...(topology.poolRefs === undefined ? {} : { poolDirs: topology.poolRefs }),
                      ...(topology.pendingSubResolutions === undefined
                        ? {}
                        : { pendingSubResolves: topology.pendingSubResolutions }),
                    },
                  ]),
                ),
              }),
        }),
      )
    },
    head: (workspaceRef) => runGit(workspaceRef, ['rev-parse', 'HEAD']),
    submodulePresence: (workspaceRef) => existsSync(join(workspaceRef, '.gitmodules')),
    changedFiles: gitChangedFiles,
    blobHashes: gitBlobHashes,
    async snapshot(workspace, log, extraForcedContainerPaths) {
      const handle = nativeHandle(workspace)
      try {
        const trees = await snapshotNodeIsoFinal(handle, log, extraForcedContainerPaths)
        return { trees, workspace }
      } finally {
        retainTopology(workspace, handle)
      }
    },
    async merge(workspace, trees, log, resolveSubConflict) {
      const handle = nativeHandle(workspace)
      try {
        const result = await mergeBackNodeIso(
          handle,
          trees,
          log,
          resolveSubConflict === undefined
            ? undefined
            : (conflict) => resolveSubConflict(describeConflict(conflict)),
        )
        return { clean: result.clean, conflicts: result.conflicts.map(describeConflict), workspace }
      } finally {
        retainTopology(workspace, handle)
      }
    },
    undoShard: (input) =>
      undoPriorShardDeltaInIso(
        input.workspaceRef,
        input.priorNodeCommit,
        input.priorBaseCommit,
        input.log,
        input.forcedRelativePaths,
      ),
    discard: (workspace, log, writeWindow, onProgress) =>
      discardIsolationWorkspace(nativeHandle(workspace), log, writeWindow, onProgress),
    async resolveConflict(conflict, input) {
      const result = await resolveConflictWithAgent(nativeConflict(conflict), {
        containerPath: input.containerRef,
        runAgent: input.runAgent,
        ...(input.log === undefined ? {} : { log: input.log }),
      })
      return {
        resolved: result.resolved,
        unresolved: result.unresolved,
        resolveWorkspaceRef: result.resolveIsoPath,
      }
    },
    completeHumanConflict: (workspace, trees, log) =>
      completeHumanResolvedConflict(nativeHandle(workspace), trees, log),
  })
}

/** Construction and binding do not touch the filesystem or Git. */
export function createLocalIsolationWorkspaceFactory(): IsolationWorkspaceFactory {
  return Object.freeze({ bind: bindLocalIsolationWorkspace })
}
