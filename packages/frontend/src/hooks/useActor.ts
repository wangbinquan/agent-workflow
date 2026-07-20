// RFC-036 — current actor + permission set from /api/auth/me.
// Returns null while loading or when unauthenticated.
//
// Cache strategy: the auth token participates in the queryKey so logging
// out + back in with a different account invalidates the prior actor's
// /me payload immediately (instead of holding stale role/permission data
// until the 30-s staleTime elapses). A null token short-circuits the
// fetch and returns null.

import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { api } from '@/api/client'
import { getToken, subscribeAuth } from '@/stores/auth'

export interface MeResponse {
  user: {
    id: string
    username: string
    displayName: string
    role: 'admin' | 'user'
    status: 'active' | 'disabled' | 'invited'
  }
  source: 'session' | 'pat' | 'daemon'
  permissions: string[]
  linkedIdentities: unknown[]
  pats: unknown[]
}

/** Base queryKey prefix. Components that want to invalidate every actor
 *  variant can do `queryClient.invalidateQueries({ queryKey: ACTOR_QUERY_KEY })`. */
export const ACTOR_QUERY_KEY = ['auth', 'me'] as const

function useAuthTokenSnapshot(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

export function useActor() {
  const token = useAuthTokenSnapshot()
  return useQuery<MeResponse | null>({
    // Including the token in the key makes "log out → log in as someone
    // else" surface fresh /me data instantly. Token is process-local state
    // (not network-bound), so leaking it through the React Query devtools
    // is no different from leaking it through localStorage.
    queryKey: [...ACTOR_QUERY_KEY, token ?? 'no-token'],
    // RFC-208: consume the query's `signal`. Without it query-core never marks
    // the signal used (query.js `#abortSignalConsumed`), so unmounting does not
    // abort — and a first-load fetch that hangs can never be superseded either
    // (invalidate/refetch hand back the same never-settling promise). That made
    // a stalled /api/auth/me permanently strand every permission check in the
    // app: nav entries vanish and the account page spins forever, with a reload
    // the only way out. This query is mounted app-wide, so it is the single
    // highest-value place to get this right.
    queryFn: async ({ signal }) => {
      if (!token) return null
      return api.get<MeResponse>('/api/auth/me', undefined, signal)
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    // Drop the previously-cached value on token change so consumers don't
    // briefly render last-user data while the new query is in-flight.
    placeholderData: undefined,
  })
}

export function usePermission(perm: string): boolean {
  const { data } = useActor()
  if (!data) return false
  return data.permissions.includes(perm)
}

/**
 * Admin-IDENTITY gate — distinct from usePermission. Several permission points
 * now sit in the user baseline (e.g. memory:approve after RFC-099 D12), so a
 * surface that is genuinely admin-only must key off the ROLE: keying it off
 * such a permission would make the gate a no-op for every logged-in user.
 */
export function useIsAdmin(): boolean {
  return useActor().data?.user.role === 'admin'
}
