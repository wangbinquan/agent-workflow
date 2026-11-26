import type { TaskChildSummary, TaskChildrenPage } from '@agent-workflow/shared'

export interface TaskChildrenViewer {
  readonly userId: string
  readonly canReadAllTasks: boolean
}

export interface TaskChildrenBoundary {
  readonly startedAt: number
  readonly id: string
}

export interface TaskChildrenRead {
  page(input: {
    readonly parentTaskId: string
    readonly viewer: TaskChildrenViewer
    readonly take: number
    readonly after: TaskChildrenBoundary | null
  }): Promise<readonly (TaskChildSummary & { readonly startedAt: number })[]>
}

export interface TaskChildrenQuery {
  list(
    viewer: TaskChildrenViewer,
    input: {
      readonly parentTaskId: string
      readonly limit?: string
      readonly cursor?: string
    },
  ): Promise<TaskChildrenPage>
}
