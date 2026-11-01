// RFC-412 — the ports of the read-only member inspection (engine/task/readonlyInspection.ts).
import type { TaskRepositoryMount } from '../../domain/taskRepository'
import type { SchedulerCompletionPersistence } from './schedulerCompletionPersistence'
import type { TaskExecutionContextRef } from './taskExecutionTopology'

export interface ReadonlyInspectionPorts {
  readonly taskId: string
  readonly repos: readonly TaskRepositoryMount[]
  readonly execution: TaskExecutionContextRef | undefined
  statusPorcelain(repo: TaskRepositoryMount): Promise<{ stdout: string }>
  recordReadonlyDirty: SchedulerCompletionPersistence['recordReadonlyDirty']
}
