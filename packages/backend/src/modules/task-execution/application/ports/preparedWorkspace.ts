import type { PlannedRepo, PlannedDirectoryNode } from '@agent-workflow/shared'

/** Task-private receiving facts for workspace admission and old-task recovery.
 * The root structurally binds SC results; Task imports no SC implementation or
 * legacy service type. This does not replace RFC-362's offered participants. */
interface WorktreeCleanupProvenance {
  repoPath: string
  worktreePath: string
  branch: string
  branchRef: string
  branchBefore: string | null
  branchAfter: string
}

export interface ResolvedRepoSource {
  repoPath: string
  baseBranch: string | undefined
  /** First concrete commit persisted by the preparation operation; display keeps baseBranch. */
  resolvedCommit?: string
  /** RAW source URL — may carry credentials. Redact before logging/persisting. */
  repoUrl: string | null
  /** RFC-204: the cached mirror this resolved to (deterministic ref key). */
  cachedRepoId: string | null
  /** RFC-068: path-mode opt-in fetch error message. null when feature was off or succeeded. */
  pathFetchError: string | null
  /** RFC-068: URL-mode FF warnings. Empty when nothing relevant. */
  ffWarnings: Array<{ branch: string; warning: string }>
}

export interface MaterializedRepo {
  repoIndex: number
  repoPath: string
  repoUrl: string | null
  cachedRepoId: string | null
  baseBranch: string
  branch: string
  baseCommit: string | null
  worktreePath: string
  worktreeDirName: string
  /** RFC-248: 相对任务根的挂载路径；'' = 挂根。取代 worktreeDirName 成为规范 key。 */
  mountPath: string
  /** RFC-248 D17: '' = 整仓；否则该成员是 sparse 检出。 */
  subdir: string
  /** RFC-248 D11: 只读成员不快照 / 不进 diff / 不推送。 */
  readonly: boolean
  /** RFC-308: installed per-worktree platform exclude profile receipt. */
  workspaceProfileVersion?: 1 | null
  workspaceProfileDigest?: string | null
  submoduleInitOk: boolean
  submoduleInitError: string | null
  hasSubmodules: boolean
}

export interface MaterializedSpace {
  kind: 'scratch' | 'single' | 'multi' | 'group'
  /** RFC-165: persisted `tasks.space_kind` value, decided at materialize time.
   *  RFC-243: 'inherited' = a child execution's synthesized space pointing into
   *  its parent's call-node iso (never produced by materializeSpace itself). */
  spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
  taskId: string
  /** Multi: the container dir; single: the worktree; scratch: the repo dir; '' on failure. */
  worktreePath: string
  branch: string
  baseCommit: string | null
  earlyError: string | null
  resolvedSources: ResolvedRepoSource[]
  repos: MaterializedRepo[]
  /** RFC-249: frozen canonical directory paths; empty for non-group legacy handoffs. */
  nodePaths: string[]
  /** Explicit ownership lease consumed by startTask or the multipart route. */
  cleanup: MaterializedSpaceCleanup
}

export interface WorkspaceCleanupHookEvent {
  stage: 'worktree-remove' | 'branch-restore' | 'owned-root-remove'
  taskId: string
  path: string
  repoPath?: string
  branch?: string
}

export interface WorkspaceCleanupFailure extends WorkspaceCleanupHookEvent {
  message: string
}

export interface WorkspaceCleanupReport {
  taskId: string
  complete: boolean
  failures: WorkspaceCleanupFailure[]
}

export interface MaterializedSpaceCleanup {
  taskId: string
  /** Scratch/multi/fusion ephemeral root only; never a URL cache or user source. */
  ownedRoot: string | null
  /** Exact provenance emitted by createWorktree; never inferred after the fact. */
  worktrees: WorktreeCleanupProvenance[]
  state: 'owned' | 'committed' | 'cleaned'
  report: WorkspaceCleanupReport | null
}

export interface PlannedSpaceLayout {
  readonly repos: PlannedRepo[]
  readonly nodes: PlannedDirectoryNode[]
}
