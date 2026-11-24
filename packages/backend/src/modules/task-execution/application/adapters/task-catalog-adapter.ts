import type { TaskCatalogSource } from '@/modules/task-catalog/composition/required-ports'

// RFC-556: Task Execution's infrastructure takes Task Catalog's source port from this designated adapter only.
export type { TaskCatalogSource }

export type TaskExecutionCatalogSourceId = 'agent' | 'workflow' | 'workgroup'

export interface TaskExecutionCatalogSourceFactory {
  create(sourceId: TaskExecutionCatalogSourceId): TaskCatalogSource
}

/** Provider-neutral catalog composition. Provider bootstrap supplies the
 * factory; application code never receives its database client. */
export function composeTaskExecutionCatalogSources(
  factory: TaskExecutionCatalogSourceFactory,
): TaskCatalogSource[] {
  return (['agent', 'workflow', 'workgroup'] as const).map((sourceId) => factory.create(sourceId))
}
