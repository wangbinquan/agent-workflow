import type { TaskFeedback } from '@agent-workflow/shared'

export interface TaskFeedbackTaskIdentity {
  readonly id: string
  readonly ownerUserId: string | null
}

export interface NewTaskFeedbackRecord {
  readonly id: string
  readonly taskId: string
  readonly authorUserId: string | null
  readonly bodyMd: string
  readonly createdAt: number
}

/** Provider-neutral persistence used by the task-feedback application service. */
export interface TaskFeedbackStore {
  loadTaskIdentity(taskId: string): Promise<TaskFeedbackTaskIdentity | null>
  insert(input: NewTaskFeedbackRecord): Promise<void>
  markDistilled(id: string, distillJobId: string): Promise<void>
  getById(id: string): Promise<TaskFeedback | null>
  listByTask(taskId: string): Promise<readonly TaskFeedback[]>
  listRecent(limit: number): Promise<readonly TaskFeedback[]>
}
