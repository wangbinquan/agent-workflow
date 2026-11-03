import type { TaskCatalogPage, TaskCatalogSourcesDocument } from '@agent-workflow/shared'
import type { TaskCatalogListQuery, TaskCatalogViewer } from '../../public/types'

/** RFC-435: the task catalog's typed read use cases; the inbound route owns the wire encoding. */
export interface TaskCatalogQueries {
  listSources(viewer: TaskCatalogViewer): TaskCatalogSourcesDocument
  list(query: TaskCatalogListQuery, viewer: TaskCatalogViewer): Promise<TaskCatalogPage>
}
