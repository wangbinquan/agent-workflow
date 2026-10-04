// Private compatibility views for the remaining Task mechanics, never persistence authority.
import type {
  IsolationConflict,
  IsolationWorkspace,
  IsolationWorkspaceBinding,
  IsolationWorkspaceScope,
} from '@/modules/source-control/public/types'
import {
  requireIsolationWorkspaceScope,
  selectIsolationWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import {
  type completeHumanResolvedConflict,
  discardIsolationWorkspace,
  mergeBackNodeIso,
  resolveConflictWithAgent,
  snapshotNodeIsoFinal,
  type IsoHandle,
  type MergeBackConflict,
} from '@/platform/workspace/local/isolation'
import type { Logger } from '@/util/log'

type ScopeAcquisition = () => IsolationWorkspaceScope | Promise<IsolationWorkspaceScope>
interface WorkspaceRecord {
  readonly scope: IsolationWorkspaceScope
  workspace: IsolationWorkspace
}
const bindings = new WeakMap<object, ScopeAcquisition>()
const workspaces = new WeakMap<IsoHandle, WorkspaceRecord>()
const conflicts = new WeakMap<
  MergeBackConflict,
  {
    readonly scope: IsolationWorkspaceScope
    readonly value: IsolationConflict
  }
>()

export function bindIsolatedRunWorkspace<T extends object>(
  binding: T,
  acquire: ScopeAcquisition,
): T {
  bindings.set(binding, acquire)
  return binding
}

/** Legacy direct callers select the whole native scope; Task supplies its scene acquisition. */
export async function scopeForIsolatedRun(
  binding: object,
  nativeBinding: IsolationWorkspaceBinding,
): Promise<IsolationWorkspaceScope> {
  const acquire = bindings.get(binding)
  const scope =
    acquire === undefined
      ? await selectIsolationWorkspaceFactory().bind(nativeBinding)
      : await acquire()
  requireIsolationWorkspaceScope(scope)
  return scope
}

export function workspaceView(
  scope: IsolationWorkspaceScope,
  workspace: IsolationWorkspace,
): IsoHandle {
  const handle: IsoHandle = {
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
  workspaces.set(handle, { scope, workspace })
  return handle
}

export function workspaceRecord(handle: IsoHandle): WorkspaceRecord {
  const record = workspaces.get(handle)
  if (record === undefined) throw new TypeError('Task isolation workspace has no retained scope')
  return record
}

function passTopology(handle: IsoHandle, record: WorkspaceRecord): void {
  for (const [index, repo] of handle.repos.entries()) {
    const value = record.workspace.repositories[index]!
    value.forcedRelativePaths = repo.forcedRepoRelPaths
    value.submoduleBases = repo.subBases
    value.poolRefs = repo.poolDirs
    value.pendingSubResolutions = repo.pendingSubResolves
  }
}

function retainTopology(handle: IsoHandle, record: WorkspaceRecord): void {
  for (const [index, repo] of handle.repos.entries()) {
    const value = record.workspace.repositories[index]!
    repo.forcedRepoRelPaths = value.forcedRelativePaths
    repo.subBases = value.submoduleBases
    repo.poolDirs = value.poolRefs
    repo.pendingSubResolves = value.pendingSubResolutions
  }
}

function conflictView(scope: IsolationWorkspaceScope, value: IsolationConflict): MergeBackConflict {
  const result: MergeBackConflict = {
    worktreeDirName: value.mount,
    paths: value.paths,
    mergedTree: value.mergedTree,
    rawConflictOutput: value.rawConflictOutput,
    base: value.base,
    canonWorktreePath: value.canonicalRef,
    taskBaseHead: value.taskBaseHead,
    salvagedPaths: value.salvagedPaths,
    forcedRepoRelPaths: value.forcedRelativePaths,
  }
  conflicts.set(result, { scope, value })
  return result
}

export async function snapshotIsolatedWorkspace(
  handle: IsoHandle,
  log?: Logger,
  forcedPaths?: string[],
): Promise<Record<string, string>> {
  const record = workspaces.get(handle)
  // Preserve the old direct helper contract for externally-created native handles.
  if (record === undefined) return snapshotNodeIsoFinal(handle, log, forcedPaths)
  passTopology(handle, record)
  try {
    const result = await record.scope.snapshot(record.workspace, log, forcedPaths)
    record.workspace = result.workspace
    return result.trees
  } finally {
    retainTopology(handle, record)
  }
}

export async function mergeIsolatedWorkspace(
  handle: IsoHandle,
  trees: Record<string, string>,
  log?: Logger,
  resolveSubConflict?: (conflict: MergeBackConflict) => Promise<{ resolved: boolean }>,
): Promise<{ clean: boolean; conflicts: MergeBackConflict[] }> {
  const record = workspaces.get(handle)
  if (record === undefined) return mergeBackNodeIso(handle, trees, log, resolveSubConflict)
  passTopology(handle, record)
  try {
    const result = await record.scope.merge(
      record.workspace,
      trees,
      log,
      resolveSubConflict === undefined
        ? undefined
        : (conflict) => resolveSubConflict(conflictView(record.scope, conflict)),
    )
    record.workspace = result.workspace
    return {
      clean: result.clean,
      conflicts: result.conflicts.map((conflict) => conflictView(record.scope, conflict)),
    }
  } finally {
    retainTopology(handle, record)
  }
}

/** This is the admitted act; the Task cleanup shell owns admission and receipts. */
export async function discardIsolatedWorkspace(
  handle: IsoHandle,
  ...args: Parameters<typeof discardIsolationWorkspace> extends [IsoHandle, ...infer Rest]
    ? Rest
    : never
): Promise<void> {
  const record = workspaces.get(handle)
  if (record === undefined) return discardIsolationWorkspace(handle, ...args)
  passTopology(handle, record)
  await record.scope.discard(record.workspace, ...args)
}

export async function resolveIsolatedConflict(
  conflict: MergeBackConflict,
  input: Parameters<typeof resolveConflictWithAgent>[1],
): Promise<Awaited<ReturnType<typeof resolveConflictWithAgent>>> {
  const record = conflicts.get(conflict)
  if (record === undefined) return resolveConflictWithAgent(conflict, input)
  const result = await record.scope.resolveConflict(record.value, {
    containerRef: input.containerPath,
    runAgent: input.runAgent,
    ...(input.log === undefined ? {} : { log: input.log }),
  })
  return {
    resolved: result.resolved,
    unresolved: result.unresolved,
    resolveIsoPath: result.resolveWorkspaceRef,
  }
}

export async function completeIsolatedHumanConflict(
  handle: IsoHandle,
  trees: Record<string, string>,
  log?: Logger,
): Promise<Awaited<ReturnType<typeof completeHumanResolvedConflict>>> {
  const record = workspaceRecord(handle)
  passTopology(handle, record)
  return await record.scope.completeHumanConflict(record.workspace, trees, log)
}
