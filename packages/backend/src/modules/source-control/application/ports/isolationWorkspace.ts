import type { MergeConflictEntry, MergeConflictManifest } from '../../domain/isolationConflict'
import type { Logger } from '@/util/log'

type Effect<T> = T | Promise<T>

/** Only the selected adapter interprets workspace, repository and storage references. */
export interface IsolationCanonicalRepository {
  readonly repositoryRef: string
  readonly workspaceRef: string
  readonly mount: string
  readonly baseBranch: string
}

export interface IsolationWorkspaceBinding {
  readonly taskId: string
  readonly storageRootRef: string
  readonly repositories: readonly IsolationCanonicalRepository[]
  readonly generation?: string
}

export interface IsolationRepository {
  readonly repositoryRef: string
  readonly canonicalRef: string
  readonly workspaceRef: string
  readonly mount: string
  readonly baseBranch: string
  readonly baseSnapshot: string
  readonly taskBaseHead: string
  forcedRelativePaths: string[]
  submoduleBases: Record<string, string>
  poolRefs: Record<string, string>
  pendingSubResolutions: string[]
}

/** This value carries everything needed after restart; no native handle is required. */
export interface IsolationWorkspace {
  readonly taskId: string
  readonly key: string
  readonly dbNodeRunId: string
  readonly isolationRef: string
  readonly workspaceRef: string
  readonly passthrough: boolean
  readonly repositories: IsolationRepository[]
}

export interface IsolationCreateInput {
  readonly key: string
  readonly dbNodeRunId: string
  readonly forcedContainerPaths?: string[]
  readonly submoduleMode?: 'auto' | 'always' | 'never'
  readonly submoduleJobs?: number
  readonly log?: Logger
}

export interface IsolationRestoreInput {
  readonly key: string
  readonly dbNodeRunId: string
  readonly workspaceRef?: string | null
  readonly baseSnapshots: Record<string, string>
  readonly taskBaseHeads: Record<string, string>
  readonly forcedContainerPaths?: string[]
  readonly submodules?: Record<
    string,
    {
      readonly submoduleBases: Record<string, string>
      readonly poolRefs?: Record<string, string>
      readonly pendingSubResolutions?: string[]
    }
  >
}

export interface IsolationConflict {
  readonly mount: string
  readonly paths: string[]
  readonly mergedTree: string
  readonly rawConflictOutput: string
  readonly base: string
  readonly canonicalRef: string
  readonly taskBaseHead: string
  readonly salvagedPaths: string[]
  readonly forcedRelativePaths: string[]
}

export interface IsolationCanonicalWriteWindow {
  run<T>(act: () => Promise<T>): Promise<T>
}

/** One complete receiver retained for one effective canonical scene. */
export interface IsolationWorkspaceScope {
  recoverKey(workspaceRef: string | null, rowId: string): Effect<string>
  chooseGeneration(
    baseKey: string,
    log?: Logger,
  ): Effect<{
    readonly key: string
    readonly generation: number
    readonly reclaimed: number
  }>
  create(input: IsolationCreateInput): Effect<IsolationWorkspace>
  restore(input: IsolationRestoreInput): Effect<IsolationWorkspace>
  head(workspaceRef: string): Effect<{
    readonly stdout: string
    readonly stderr: string
    readonly exitCode: number
  }>
  submodulePresence(workspaceRef: string): Effect<boolean>
  changedFiles(workspaceRef: string, baseline: string): Effect<string[]>
  blobHashes(workspaceRef: string, paths: string[]): Effect<Record<string, string>>
  snapshot(
    workspace: IsolationWorkspace,
    log?: Logger,
    extraForcedContainerPaths?: string[],
  ): Effect<{ readonly trees: Record<string, string>; readonly workspace: IsolationWorkspace }>
  merge(
    workspace: IsolationWorkspace,
    trees: Record<string, string>,
    log?: Logger,
    resolveSubConflict?: (conflict: IsolationConflict) => Promise<{ resolved: boolean }>,
  ): Effect<{
    readonly clean: boolean
    readonly conflicts: IsolationConflict[]
    readonly workspace: IsolationWorkspace
  }>
  undoShard(input: {
    readonly workspaceRef: string
    readonly priorNodeCommit: string | undefined
    readonly priorBaseCommit: string | undefined
    readonly forcedRelativePaths?: string[]
    readonly log?: Logger
  }): Effect<boolean>
  /** Admission is decided by Task before its receipt fence; this is the admitted act. */
  discard(
    workspace: IsolationWorkspace,
    log?: Logger,
    writeWindow?: IsolationCanonicalWriteWindow,
    onProgress?: (partialFailures: number) => void,
  ): Effect<void>
  resolveConflict(
    conflict: IsolationConflict,
    input: {
      readonly containerRef: string
      readonly runAgent: (
        prompt: string,
        workspaceRef: string,
        manifest: MergeConflictManifest,
      ) => Promise<void>
      readonly log?: Logger
    },
  ): Effect<{
    readonly resolved: boolean
    readonly unresolved: MergeConflictEntry[]
    readonly resolveWorkspaceRef: string | null
  }>
  completeHumanConflict(
    workspace: IsolationWorkspace,
    trees: Record<string, string>,
    log?: Logger,
  ): Effect<{ readonly allResolved: boolean; readonly unresolvedRepos: string[] }>
}

export interface IsolationWorkspaceFactory {
  bind(binding: IsolationWorkspaceBinding): Effect<IsolationWorkspaceScope>
}
