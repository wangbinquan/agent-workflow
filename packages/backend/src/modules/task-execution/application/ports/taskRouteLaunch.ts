// RFC-486: the ports the task launch use case consumes — the caller-owned workspace lease and the Resource Catalog
// projection the workgroup arm reads. Implemented in infrastructure, wired by composition.

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  type GitCommitIdentity,
  type TaskStartOptions,
  type Workgroup,
} from '@agent-workflow/shared'
import type { TaskWorkspaceLaunchLane } from './workspaceLaunch'
import { type Actor } from '@/auth/actor'
import type { AgentLaunchResourceIntegrityParticipant } from '@/modules/resource-catalog/public/participants'
import type { WorkspaceCleanupReport } from './preparedWorkspace'
import type { TaskExecutionResourceAuthority } from './taskExecutionResourceSnapshots'

export interface TaskRouteWorkspaceRepository {
  readonly repoIndex: number
  readonly repoPath: string
  /** Credential-free display URL. Workspace composition must redact before returning it. */
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly baseBranch: string
  readonly branch: string
  readonly workingBranch: string | null
  readonly baseCommit: string | null
  readonly worktreePath: string
  readonly worktreeDirName: string
  readonly mountPath: string
  readonly subdir: string
  readonly readonly: boolean
  readonly workspaceProfileVersion: number | null
  readonly workspaceProfileDigest: string | null
  readonly hasSubmodules: boolean | null
  readonly submoduleInitOk: boolean | null
  readonly submoduleInitError: string | null
}

/**
 * A real, caller-owned materialization lease. The participant must prepare the
 * repository/scratch/group workspace and may not return a synthetic no-op
 * workspace. TaskExecution consumes the lease exactly once: `commit` after its
 * PostgreSQL transaction, or `rollback` after any pre-commit failure.
 */
export interface TaskRoutePreparedWorkspace {
  /** Exact id from the prepare request; prevents cross-request lease reuse. */
  readonly taskId: string
  readonly kind: 'scratch' | 'single' | 'multi' | 'group'
  readonly spaceKind: 'local' | 'remote' | 'scratch' | 'internal'
  readonly repoPath: string
  /** Credential-free display URL. */
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly repoGroupId: string | null
  readonly repoGroupName: string | null
  readonly worktreePath: string
  readonly baseBranch: string
  readonly branch: string
  readonly baseCommit: string | null
  readonly earlyError: string | null
  readonly repositories: readonly TaskRouteWorkspaceRepository[]
  readonly nodePaths: readonly string[]
  /** Private adapter joins source/plan admission to the existing Task transaction. */
  admit(transaction: PersistenceDb): Promise<TaskWorkspaceLaunchLane>
  /** Non-throwing lease promotion after the owning database commit. */
  commit(): void
  rollback(): Promise<WorkspaceCleanupReport>
}

export interface TaskRouteWorkspaceParticipant {
  prepare(
    input: Readonly<{
      actor: Actor
      authority: TaskExecutionResourceAuthority['authority']
      taskId: string
      task: TaskStartOptions
      gitCommitIdentity: GitCommitIdentity | null
      sourceTerminationSignal?: AbortSignal
      /**
       * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）：只交占位工作区，真正的物化
       * 留给驱动的第 0 步。由启动请求带进来（见 `RootTaskLaunchRequest`）。
       */
      defer?: boolean
    }>,
  ): Promise<TaskRoutePreparedWorkspace>
}

/** Resource Catalog projection required by the Workgroup launch arm. */
export interface WorkgroupRouteLaunchResources {
  loadVisible(actor: Actor, workgroupId: string): Promise<Workgroup | null>
  loadExistingAgentIds(agentIds: readonly string[]): Promise<readonly string[]>
  readonly integrity: AgentLaunchResourceIntegrityParticipant
}
