// RFC-151 PR-3 — shared list-page shell for the six ACL'd resource pages
// (agents / skills / mcps / plugins / workflows / workgroups).
//
// Collapses the query + delete-mutation + owner-lookup trio that每页逐字重复:
//   - useQuery<T[]> over the resource collection endpoint
//   - delete mutation that invalidates the same query key on success
//   - RFC-099 owner id → display-name batch lookup for the list badge
//
// Deliberately NOT for the other data-table routes (tasks / reviews / users /
// repos / clarify) — they have no owner/visibility semantics (RFC-151 D1,
// 伪抽象警戒). Page-specific columns, extra queries and row actions stay in
// the pages themselves; this hook only owns the shared common core.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useUserLookup } from '@/hooks/useUserLookup'

export interface UseResourceListOptions {
  /** React Query cache key of the collection (also the invalidation target). */
  queryKey: readonly unknown[]
  /** Collection endpoint, e.g. '/api/agents'. Rows are `GET {endpoint}`,
   *  deletes are `DELETE {endpoint}/{row.id}`. */
  endpoint: string
}

export function useResourceList<
  T extends { id: string; name: string; ownerUserId?: string | null | undefined },
>(opts: UseResourceListOptions) {
  const qc = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery<T[]>({
    queryKey: opts.queryKey,
    queryFn: ({ signal }) => api.get(opts.endpoint, undefined, signal),
  })

  const del = useMutation({
    mutationFn: (row: T) => api.delete(`${opts.endpoint}/${encodeURIComponent(row.id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: opts.queryKey }),
  })

  // RFC-099 — resolve owner ids to display names for the list badge.
  const owners = useUserLookup((data ?? []).map((r) => r.ownerUserId))

  return { data, isLoading, error, refetch, del, owners }
}
