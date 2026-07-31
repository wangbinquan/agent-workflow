// RFC-243 PR-5 — direct-children query for one parent task.
//
// One shared query per parent id, used by BOTH consumers of the new
// `GET /api/tasks?parent_id=<id>` backend filter:
//   - /tasks list row expansion (nested child rows), and
//   - task-detail call-node surfaces (ChildTaskLink status chips).
// Sharing the key means expanding a parent row and opening its detail page
// never issue duplicate child fetches, and the tasks WS invalidation
// (['tasks'] prefix, useTasksSync / useTaskSync) refreshes it for free.
//
// `include_owner=true` is requested up front because the list expansion
// renders the Owner column; the detail chip simply ignores the extra fields.

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { TaskListItem } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { isTerminal } from '@/lib/task-detail-tabs'

export function taskChildrenQueryKey(parentTaskId: string): readonly unknown[] {
  return ['tasks', 'children', parentTaskId]
}

export function useTaskChildren(
  parentTaskId: string,
  enabled: boolean = true,
): UseQueryResult<TaskListItem[]> {
  return useQuery<TaskListItem[]>({
    queryKey: taskChildrenQueryKey(parentTaskId),
    queryFn: ({ signal }) =>
      api.get(
        '/api/tasks',
        // limit=500: same explicit window as the list page (listTasks defaults
        // to 100 — a fan-out parent can exceed that).
        { parent_id: parentTaskId, include_owner: 'true', limit: '500' },
        signal,
      ),
    enabled,
    // Poll fallback while any child is still live (WS invalidation is the
    // primary refresh path; this mirrors the task-detail query idiom).
    refetchInterval: (q) =>
      (q.state.data ?? []).some((child) => !isTerminal(child.status)) ? 5000 : false,
  })
}
