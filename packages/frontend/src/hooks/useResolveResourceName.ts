// RFC-177: resolve a resource's CURRENT name from its stable id via the
// ACL-gated by-id endpoint (`GET /api/{kind}/by-id/:id` → `{name}`), so a task's
// frozen subject-id link can redirect to the resource's current canonical page —
// surviving a rename (and never opening a same-named replacement). A 404
// (missing OR invisible, identical shape per RFC-099 D1) surfaces as `isError`;
// `retry: false` keeps that from spinning. Shared by the workgroups/agents by-id
// redirect routes (single fetch/loading/error contract; each route keeps its own
// typed <Navigate> so the resolution logic isn't duplicated).
//
// FRESHNESS (Codex impl-gate P1): the mapping is security/identity-sensitive, so
// a redirect must NEVER fire on a cached-but-stale name (a mapping from before a
// rename / delete-and-reuse / permission revocation / login change). We therefore
//   - `gcTime: 0`         — never retain the result past unmount (no cross-visit reuse);
//   - `refetchOnMount: 'always'` + `staleTime: 0` — re-run the ACL-scoped fetch every mount;
//   - surface `name` ONLY once the fetch has SETTLED fresh (`!isFetching && isSuccess`),
//     never a value being revalidated — so navigation waits for the fresh result.

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
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  // Only a settled, fresh success yields a name; a value mid-(re)fetch reads as
  // loading so the redirect can't act on a stale/unauthorized cached mapping.
  const settledFresh = !q.isFetching && q.isSuccess
  return {
    name: settledFresh ? (q.data?.name ?? null) : null,
    isLoading: q.isFetching,
    isError: !q.isFetching && q.isError,
  }
}
