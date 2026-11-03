import type {
  TaskCatalogListItem,
  TaskOperationsFacets,
  TaskSourceId,
} from '@agent-workflow/shared'

import type { TaskCatalogViewer } from '../public/types'

/** Consumer-owned input shared by every registered task source. */
export interface TaskCatalogSourceListInput {
  /** RFC-435: who is listing — user id and permissions only. */
  readonly viewer: TaskCatalogViewer
  readonly view?: string
  readonly q?: string
  readonly statuses?: string
  readonly scope?: string
  readonly origin?: string
  readonly parentItemId?: string
  readonly cursor?: string
  readonly limit?: string
}

export interface TaskCatalogSourcePage {
  readonly items: readonly TaskCatalogListItem[]
  readonly nextCursor: string | null
  readonly facets: TaskOperationsFacets
}

/** One adapter per public task source, keyed directly by its source identity. */
export interface TaskCatalogSource {
  readonly sourceId: TaskSourceId
  readonly supportsHierarchy: boolean
  list(input: TaskCatalogSourceListInput): Promise<TaskCatalogSourcePage>
}
