import type { TaskStatus } from '@agent-workflow/shared'

/** Exact task-list row needed to project a committed task.created event. */
export interface TaskLifecycleCreatedProjection {
  readonly id: string
  readonly name: string
  readonly workflowId: string
  readonly workflowName: string | null
  readonly repoPath: string
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly status: TaskStatus
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly errorSummary: string | null
  readonly repoCount: number
  readonly spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
  readonly sourceAgentName: string | null
}

/** Provider-selected projection reader used only after committed delivery. */
export interface TaskLifecycleWsProjection {
  findCreatedTask(taskId: string): Promise<TaskLifecycleCreatedProjection | null>
}
