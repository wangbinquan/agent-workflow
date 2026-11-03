import type { Permission, TaskSourceId } from '@agent-workflow/shared'

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
