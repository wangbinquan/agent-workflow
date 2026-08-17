// RFC-099 — batch user-id → public-fields resolution for attribution chips
// (review comment authors, clarify per-question editors, owner badges).
//
// One POST /api/users/lookup per distinct id-set, shared via React Query so
// every chip on a page rides the same request. Ids that fail to resolve
// (deleted users, '__system__', legacy 'local') simply stay unmapped — the
// caller renders its own fallback.

import { useQuery } from '@tanstack/react-query'
import { LOCAL_DECIDER, SYSTEM_DECIDER, type UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { usePermission } from '@/hooks/useActor'

/** ids that are sentinels, never real users — skipped client-side. The two
 *  decider sentinels spell through the RFC-149 shared constants; '__system__'
 *  is the legacy clarify/task actor marker with no shared constant (yet). */
const SENTINELS = new Set<string>([LOCAL_DECIDER, SYSTEM_DECIDER, '__system__', ''])

export function useUserLookup(ids: ReadonlyArray<string | null | undefined>) {
  const canSearchUsers = usePermission('users:search')
  const wanted = [
    ...new Set(ids.filter((x): x is string => typeof x === 'string' && !SENTINELS.has(x))),
  ].sort()
  const query = useQuery<UserPublic[]>({
    queryKey: ['users', 'lookup', wanted],
    queryFn: () => api.post('/api/users/lookup', { ids: wanted }),
    enabled: wanted.length > 0 && canSearchUsers,
    staleTime: 5 * 60_000,
  })
  // A disabled query may retain data from before a permission downgrade. Do
  // not project those cached public identities without current users:search.
  const byId = new Map((canSearchUsers ? (query.data ?? []) : []).map((u) => [u.id, u]))
  return {
    /** Resolve one id to its public row, or undefined while loading / unknown. */
    get: (id: string | null | undefined): UserPublic | undefined => (id ? byId.get(id) : undefined),
    isLoading: query.isLoading,
    /** The lookup resolved with data (or was empty/disabled → false). */
    isSuccess: query.isSuccess,
    /** The lookup request failed — callers that seed from it must not treat the
     *  (empty) result as authoritative (RFC-159 edit-config collaborator gate). */
    isError: query.isError,
  }
}
