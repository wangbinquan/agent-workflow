import type { TaskSourceId } from '@agent-workflow/shared'

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
