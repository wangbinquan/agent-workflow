import type { TaskStatus, Task } from '@agent-workflow/shared'

/** 删除场景需要的树、工作区与生命周期投影，不暴露原始 Task 行。 */
export interface TaskDeletionContext {
  readonly id: string
  readonly status: TaskStatus
  readonly spaceKind: Task['spaceKind']
  readonly worktreePath: string
  readonly repoPath: string
  readonly parentTaskId: string | null
  readonly parentNodeRunId: string | null
}

export interface TaskDeletionWorkspaces {
  readonly tasks: readonly {
    readonly id: string
    readonly spaceKind: Task['spaceKind']
    readonly repoPath: string
    readonly worktreePath: string
  }[]
  readonly repositories: readonly {
    readonly taskId: string
    readonly repoPath: string
    readonly worktreePath: string
  }[]
}

export interface TaskDeletionQueries {
  read(taskId: string): Promise<TaskDeletionContext | undefined>
  status(taskId: string): Promise<{ readonly status: TaskStatus } | undefined>
  workspaces(taskIds: readonly string[]): Promise<TaskDeletionWorkspaces>
  nonTerminalDescendant(rootId: string): Promise<{ id: string; status: string } | null>
}

/** 与调用方现有删除事务共用句柄；子树枚举、删除与父链物化值更新顺序由调用方保持。 */
export interface TaskDeletionParticipant {
  status(taskId: string): Promise<{ readonly status: TaskStatus } | undefined>
  cascade(
    taskId: string,
  ): Promise<readonly { readonly id: string; readonly ownerUserId: string | null }[]>
  deleteRoot(taskId: string): Promise<void>
  recomputeAncestors(parentTaskId: string | null): Promise<void>
}
