import { TaskCatalogQueryService } from './application/taskCatalogQueryService'
import type { TaskCatalogSource } from './composition/required-ports'
import type { TaskCatalogQueries } from './application/ports/taskCatalogQueries'

export interface TaskCatalogModule {
  readonly queries: TaskCatalogQueries
}

export function composeTaskCatalog(input: {
  readonly sources: readonly TaskCatalogSource[]
}): TaskCatalogModule {
  return { queries: new TaskCatalogQueryService(input.sources) }
}
