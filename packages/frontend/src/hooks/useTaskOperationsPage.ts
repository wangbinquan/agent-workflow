import {
  TaskOperationsPageSchema,
  type TaskOperationsFilters,
  type TaskOperationsPage,
} from '@agent-workflow/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

export const TASK_OPERATIONS_QUERY_KEY = ['task-operations'] as const

export function useTaskOperationsPage(
  filters: TaskOperationsFilters,
  parentId?: string,
  enabled: boolean = true,
) {
  return useInfiniteQuery({
    queryKey: [...TASK_OPERATIONS_QUERY_KEY, filters, parentId ?? 'root'],
    initialPageParam: null as string | null,
    enabled,
    queryFn: async ({ pageParam, signal }): Promise<TaskOperationsPage> => {
      const query: Record<string, string | number | undefined> = {
        view: filters.view,
        q: filters.q,
        statuses: filters.statuses.length > 0 ? filters.statuses.join(',') : undefined,
        subject: filters.subject,
        scope: filters.scope,
        origin: filters.origin,
        parent_id: parentId,
        cursor: pageParam ?? undefined,
        limit: 50,
      }
      const payload = await api.get<unknown>('/api/tasks/page', query, signal)
      return TaskOperationsPageSchema.parse(payload)
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchOnWindowFocus: false,
  })
}
