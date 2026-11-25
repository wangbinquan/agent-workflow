import type { ExecutionIsolationWorkspace } from '../application/ports/executionKernel'
import { repoRelForcedPaths } from '@/platform/workspace/forcedWorkspacePaths'
// Private compatibility views for the remaining Task mechanics, never persistence authority.
import type {
  IsolationConflict,
  IsolationWorkspace,
  IsolationWorkspaceBinding,
  IsolationWorkspaceScope,
} from '@/modules/source-control/public/types'
import { requireIsolationWorkspaceScope } from '@/modules/source-control/public/participants'
import { type IsoHandle, type MergeBackConflict } from '@/platform/contracts/isolationWorkspace'
import type { Logger } from '@/platform/logging/logger'

type ScopeAcquisition = () => IsolationWorkspaceScope | Promise<IsolationWorkspaceScope>
interface WorkspaceRecord {
  readonly scope: IsolationWorkspaceScope
  workspace: IsolationWorkspace
}
const workspaces = new WeakMap<IsoHandle, WorkspaceRecord>()
const conflicts = new WeakMap<
  MergeBackConflict,
  {
    readonly scope: IsolationWorkspaceScope
    readonly value: IsolationConflict
  }
>()

/** The caller selects a session or factory explicitly; acquisition remains lazy. */
export function createIsolationWorkspacePort(
  acquire: (binding: IsolationWorkspaceBinding) => ReturnType<ScopeAcquisition>,
): ExecutionIsolationWorkspace {
  return {
    async acquire(binding) {
      const scope = await acquire(binding)
      requireIsolationWorkspaceScope(scope)
      return {
        chooseGeneration: (key, log) => scope.chooseGeneration(key, log),
        async create(input) {
          return workspaceView(scope, await scope.create(input))
        },
      }
    },
    snapshotIsolatedWorkspace,
    mergeIsolatedWorkspace,
    repoRelForcedPaths,
  }
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
      mountPath: repo.mount,
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
    mountPath: value.mount,
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
  // RFC-585: every production handle is created through a Source Control scope (`workspaceView`); the direct native
  // fallback for externally-created handles left the production tree with the implementation (tests bind it themselves).
  const record = workspaceRecord(handle)
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
  const record = workspaceRecord(handle)
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
  ...args: Parameters<IsolationWorkspaceScope['discard']> extends [
    IsolationWorkspace,
    ...infer Rest,
  ]
    ? Rest
    : never
): Promise<void | { readonly retained: true }> {
  const record = workspaceRecord(handle)
  passTopology(handle, record)
  return record.scope.discard(record.workspace, ...args)
}

type ScopeConflictInput = Parameters<IsolationWorkspaceScope['resolveConflict']>[1]
type ScopeConflictResult = Awaited<ReturnType<IsolationWorkspaceScope['resolveConflict']>>

export async function resolveIsolatedConflict(
  conflict: MergeBackConflict,
  input: {
    readonly containerPath: string
    readonly runAgent: ScopeConflictInput['runAgent']
    readonly log?: Logger
  },
): Promise<{
  readonly resolved: boolean
  readonly unresolved: ScopeConflictResult['unresolved']
  readonly resolveIsoPath: ScopeConflictResult['resolveWorkspaceRef']
}> {
  const record = conflicts.get(conflict)
  if (record === undefined) throw new TypeError('Task isolation conflict has no retained scope')
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
): Promise<Awaited<ReturnType<IsolationWorkspaceScope['completeHumanConflict']>>> {
  const record = workspaceRecord(handle)
  passTopology(handle, record)
  return await record.scope.completeHumanConflict(record.workspace, trees, log)
}
