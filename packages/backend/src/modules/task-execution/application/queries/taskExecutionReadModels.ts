import type { TaskStatus } from '@agent-workflow/shared'

export interface TaskStatusProjectionSnapshot {
  readonly taskId: string
  readonly status: TaskStatus
  readonly errorSummary: string | null
}

export interface TaskStatusProjectionReadModel {
  find(taskId: string): Promise<TaskStatusProjectionSnapshot | null>
}

export interface TaskCallGraphWorkspace {
  readonly taskId: string
  readonly worktreePath: string
  readonly repos: readonly {
    readonly worktreeDirName: string
    readonly worktreePath: string
  }[]
}

export interface TaskCallGraphWorkspaceReadModel {
  find(taskId: string): Promise<TaskCallGraphWorkspace | null>
}

export interface TaskExecutionReadModels {
  readonly statusProjection: TaskStatusProjectionReadModel
  readonly callGraphWorkspace: TaskCallGraphWorkspaceReadModel
}
