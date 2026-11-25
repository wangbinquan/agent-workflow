import { TaskCatalogQueryService } from './application/taskCatalogQueryService'
import type { TaskCatalogSource } from './composition/required-ports'
import type { TaskCatalogQueries } from './application/ports/taskCatalogQueries'
// RFC-590: the task catalog's HTTP binding (the module's only face outside the assembly root).
export { mountTaskCatalogRoutes } from './inbound/http/taskCatalogRoutes'

export interface TaskCatalogModule {
  readonly queries: TaskCatalogQueries
}

export function composeTaskCatalog(input: {
  readonly sources: readonly TaskCatalogSource[]
}): TaskCatalogModule {
  return { queries: new TaskCatalogQueryService(input.sources) }
}
