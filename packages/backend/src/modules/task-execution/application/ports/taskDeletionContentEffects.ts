import type { TaskDeletionRepositoryParticipant } from '@/modules/source-control/public/participants'

type Completion<T> = T | Promise<T>

/** Reference interpretation and cleanup owned by one selected content receiver. */
export interface TaskDeletionContentEffects {
  directories(taskId: string): readonly [string, string, string]
  removeIfPresent(reference: string): Completion<void>
}

export interface TaskDeletionEffects {
  readonly content: TaskDeletionContentEffects
  readonly repositories: TaskDeletionRepositoryParticipant
}
