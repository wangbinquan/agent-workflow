// RFC-590: the catalog's only HTTP binding moved into this module's inbound layer, so nothing outside the module consumes this
// contract or its two parameter shapes any more; they left `public/` (which no longer exists) and live here.
import type {
  Permission,
  TaskCatalogPage,
  TaskCatalogSourcesDocument,
  TaskSourceId,
} from '@agent-workflow/shared'

/**
 * RFC-435: the caller the catalog lists for — its user id and effective permissions, never a full actor. The
 * request actor and identity-access's authority snapshot both satisfy it structurally.
 */
export interface TaskCatalogViewer {
  readonly user: Readonly<{ id: string }>
  readonly permissions: ReadonlySet<Permission>
}

export interface TaskCatalogListQuery {
  readonly sourceId?: TaskSourceId
  readonly view?: string
  readonly q?: string
  readonly statuses?: string
  readonly scope?: string
  readonly origin?: string
  readonly parentItemId?: string
  readonly cursor?: string
  readonly limit?: string
}

/** RFC-435: the task catalog's typed read use cases; the inbound route owns the wire encoding. */
export interface TaskCatalogQueries {
  listSources(viewer: TaskCatalogViewer): TaskCatalogSourcesDocument
  list(query: TaskCatalogListQuery, viewer: TaskCatalogViewer): Promise<TaskCatalogPage>
}
