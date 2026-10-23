import type { TaskWorkgroupConfig } from '../../domain/taskWorkgroupConfig'
import type { TaskSubject } from '../../domain/taskSubject'
import type { TaskStatus } from '@agent-workflow/shared'

import type { TaskRepositoryMount } from '../../domain/taskRepository'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

/** Frozen execution-owned task row; provider storage rows never cross this seam. */
export interface TaskEngineTaskSnapshot {
  readonly id: string
  readonly subject: TaskSubject
  readonly workflowId: string
  readonly name: string
  readonly workflowSnapshot: string
  readonly workflowVersion: number | null
  readonly repoPath: string
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly workingBranch: string | null
  readonly worktreePath: string
  readonly baseBranch: string
  readonly branch: string
  readonly parentTaskId: string | null
  readonly invocationDepth: number
  readonly baseCommit: string | null
  readonly status: TaskStatus
  readonly inputs: string
  readonly ownerUserId: string | null
  readonly gitUserName: string | null
  readonly gitUserEmail: string | null
  readonly autoCommitPush: boolean
  readonly repoCount: number
  readonly repoGroupName: string | null
  readonly triggerContextJson: string | null
  readonly refClosureJson: string | null
  readonly workgroupId: string | null
  readonly workgroupConfig: TaskWorkgroupConfig | null
  readonly executionLineageId: string | null
  readonly platformInputPathsJson: string | null
}

export type TaskEngineRepositorySnapshot = TaskRepositoryMount

export interface TaskEngineCollaboratorSnapshot {
  readonly userId: string | null
  readonly role: string
}

export interface TaskEngineDriveSnapshot {
  readonly task: TaskEngineTaskSnapshot
  readonly repositories: readonly TaskEngineRepositorySnapshot[]
  readonly collaborators: readonly TaskEngineCollaboratorSnapshot[]
}

/** Named async reads and the exact owner-fenced workspace-profile write. */
export interface TaskEngineApplicationPersistence {
  load(taskId: string): Promise<TaskEngineDriveSnapshot | null>
  findStatus(taskId: string): Promise<TaskStatus | null>
  updateWorkspaceProfile(input: {
    readonly taskId: string
    readonly repoIndex: number
    readonly version: number
    readonly digest: string
    readonly executionContext?: TaskExecutionContextRef
    readonly now: number
  }): Promise<boolean>
}
