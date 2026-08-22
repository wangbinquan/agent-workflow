import {
  TaskCatalogPageSchema,
  type TaskOperationsFilters,
  type TaskCatalogPage,
  type TaskSourceId,
} from '@agent-workflow/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

export const TASK_OPERATIONS_QUERY_KEY = ['task-operations'] as const

export function useTaskOperationsPage(
  filters: TaskOperationsFilters,
  parentId?: string,
  enabled: boolean = true,
  sourceId?: TaskSourceId,
) {
  return useInfiniteQuery({
    queryKey: [
      ...TASK_OPERATIONS_QUERY_KEY,
      filters,
      sourceId ?? 'all-sources',
      parentId ?? 'root',
    ],
    initialPageParam: null as string | null,
    enabled,
    queryFn: async ({ pageParam, signal }): Promise<TaskCatalogPage> => {
      const query: Record<string, string | number | undefined> = {
        type: sourceId,
        view: filters.view,
        q: filters.q,
        statuses: filters.statuses.length > 0 ? filters.statuses.join(',') : undefined,
        scope: filters.scope,
        origin: filters.origin,
        parent_id: parentId,
        cursor: pageParam ?? undefined,
        limit: 50,
      }
      const payload = await api.get<unknown>('/api/task-catalog', query, signal)
      return TaskCatalogPageSchema.parse(payload)
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchOnWindowFocus: false,
  })
}
