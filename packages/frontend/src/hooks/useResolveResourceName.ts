// RFC-177: resolve a resource's CURRENT name from its stable id via the
// ACL-gated by-id endpoint (`GET /api/{kind}/by-id/:id` → `{name}`), so a task's
// frozen subject-id link can redirect to the resource's current canonical page —
// surviving a rename (and never opening a same-named replacement). A 404
// (missing OR invisible, identical shape per RFC-099 D1) surfaces as `isError`;
// `retry: false` keeps that from spinning. Shared by the workgroups/agents by-id
// redirect routes (single fetch/loading/error contract; each route keeps its own
// typed <Navigate> so the resolution logic isn't duplicated).

import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

export type ResolvableResourceKind = 'workgroups' | 'agents'

export interface ResolvedResourceName {
  name: string | null
  isLoading: boolean
  isError: boolean
}

export function useResolveResourceName(
  kind: ResolvableResourceKind,
  id: string,
): ResolvedResourceName {
  const q = useQuery<{ name: string }>({
    queryKey: [kind, 'by-id', id],
    queryFn: ({ signal }) =>
      api.get(`/api/${kind}/by-id/${encodeURIComponent(id)}`, undefined, signal),
    retry: false,
  })
  return { name: q.data?.name ?? null, isLoading: q.isLoading, isError: q.isError }
}
