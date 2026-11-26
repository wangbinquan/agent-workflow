// RFC-243 PR-5 — direct-children query for one parent task.
//
// One shared query per parent id, used by BOTH child navigation consumers of
// `GET /api/tasks/:id/children` paginated backend projection:
//   - task-detail call-node canvas navigation, and
//   - drawer/table ChildTaskLink status chips.
// Sharing the key means these surfaces share the whole cursor chain,
// and the tasks WS invalidation
// (['tasks'] prefix, useTasksSync / useTaskSync) refreshes it for free.
//
// RFC-602: load the entire cursor chain before publishing the new result. A
// partial page must never become evidence that a later child is unavailable.

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { TaskChildrenPageSchema, type TaskChildSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { isTerminal } from '@/lib/task-detail-tabs'

export function taskChildrenQueryKey(parentTaskId: string): readonly unknown[] {
  return ['tasks', 'children', parentTaskId]
}

export function useTaskChildren(
  parentTaskId: string,
  enabled: boolean = true,
  // RFC-245 (design gate P0-2): whether the PARENT task is still non-terminal.
  // See the refetchInterval comment — an empty child list is not proof that no
  // child is coming.
  parentActive: boolean = false,
): UseQueryResult<TaskChildSummary[]> {
  return useQuery<TaskChildSummary[]>({
    queryKey: taskChildrenQueryKey(parentTaskId),
    queryFn: async ({ signal }) => {
      const children = new Map<string, TaskChildSummary>()
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      do {
        signal.throwIfAborted()
        const page = TaskChildrenPageSchema.parse(
          await api.get<unknown>(
            `/api/tasks/${encodeURIComponent(parentTaskId)}/children`,
            { limit: 100, cursor: cursor ?? undefined },
            signal,
          ),
        )
        if (page.parentTaskId !== parentTaskId) throw new Error('task-children-parent-mismatch')
        for (const child of page.items) children.set(child.id, child)
        cursor = page.nextCursor
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new Error('task-children-cursor-repeated')
          seenCursors.add(cursor)
        }
      } while (cursor !== null)
      return [...children.values()]
    },
    enabled,
    // Poll fallback (WS invalidation is the primary refresh path).
    //
    // RFC-245: polling used to key ONLY off "some child is live", which made an
    // empty first response self-sealing: open a parent whose call node has not
    // dispatched yet → `[]` → polling off → and since useTaskSync's keys are all
    // `['tasks', taskId, …]` (never `['tasks','children',id]`), nothing ever
    // refetched. Consumers that treat "loaded and absent" as proof — the drawer
    // /table ChildTaskLink placeholder, and RFC-245's canvas click affordance —
    // then stayed wrong forever. Keep polling while the PARENT is active too, so
    // a child that appears later is picked up. (T10 additionally wires the WS
    // invalidation so the common case does not wait for this fallback.)
    refetchInterval: (q) =>
      parentActive || (q.state.data ?? []).some((child) => !isTerminal(child.status))
        ? 5000
        : false,
  })
}
