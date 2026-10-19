import type { TaskDeletionRepositoryParticipant } from '@/modules/source-control/public/participants'

type Completion<T> = T | Promise<T>

/** Reference interpretation and cleanup owned by one selected content receiver. */
export interface TaskDeletionContentEffects {
  /** Freeze the owning workspace before task rows disappear; inherited
   * children may share a physical volume while retaining separate content. */
  directories(taskId: string, workspaceReference?: string): readonly string[]
  removeIfPresent(reference: string): Completion<void>
}

export interface TaskDeletionEffects {
  readonly content: TaskDeletionContentEffects
  readonly repositories: TaskDeletionRepositoryParticipant
}
