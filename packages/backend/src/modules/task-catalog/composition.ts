import type { Actor } from '@/auth/actor'
import { TaskCatalogQueryService } from './application/taskCatalogQueryService'
import type { TaskCatalogSource } from './composition/required-ports'
import type { TaskCatalogListQuery } from './public/types'

export interface TaskCatalogQueries {
  listSources(actor: Actor): string
  list(query: TaskCatalogListQuery, actor: Actor): Promise<string>
}

export interface TaskCatalogModule {
  readonly queries: TaskCatalogQueries
}

export function composeTaskCatalog(input: {
  readonly sources: readonly TaskCatalogSource[]
}): TaskCatalogModule {
  return { queries: new TaskCatalogQueryService(input.sources) }
}
