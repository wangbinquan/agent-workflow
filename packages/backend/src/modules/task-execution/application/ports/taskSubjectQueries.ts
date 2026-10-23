import type { TaskDefinitionOrigin, TaskSubjectProjection } from '../../domain/taskSubject'

export type { TaskSubjectProjection } from '../../domain/taskSubject'

/** Authored workflows retain their live name, including null after deletion. */
export interface TaskDefinitionProjection extends TaskSubjectProjection {
  readonly origin: TaskDefinitionOrigin
}

export interface TaskSubjectQueries {
  taskDefinitionProjection(
    taskIds: readonly string[],
  ): Promise<ReadonlyMap<string, TaskDefinitionProjection>>
  taskSubjectProjection(
    taskIds: readonly string[],
  ): Promise<ReadonlyMap<string, TaskSubjectProjection>>
}
