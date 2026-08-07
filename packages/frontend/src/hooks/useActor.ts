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
import type { PatPublic, Permission, UserIdentity, UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { getToken, subscribeAuth } from '@/stores/auth'

export interface MeResponse {
  user: UserPublic
  source: 'session' | 'pat' | 'daemon'
  permissions: Permission[]
  linkedIdentities: UserIdentity[]
  pats: PatPublic[]
}

/** Base queryKey prefix. Components that want to invalidate every actor
 *  variant can do `queryClient.invalidateQueries({ queryKey: ACTOR_QUERY_KEY })`. */
export const ACTOR_QUERY_KEY = ['auth', 'me'] as const

export function useAuthTokenSnapshot(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

/**
 * The /me query as a shareable options object.
 *
 * RFC-270 extracted this out of `useActor` so the `/settings` route guard can
 * `ensureQueryData` the SAME query: a guard that built its own key would fire a
 * second request per navigation and answer from a cache the components never
 * see, which is exactly how "the gear is hidden but the page still opens"
 * happens a second time.
 */
export function meQueryOptions(token: string | null) {
  return {
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
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<MeResponse | null> => {
      if (!token) return null
      return api.get<MeResponse>('/api/auth/me', undefined, signal)
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    // Drop the previously-cached value on token change so consumers don't
    // briefly render last-user data while the new query is in-flight.
    placeholderData: undefined,
  }
}

export function useActor() {
  const token = useAuthTokenSnapshot()
  return useQuery<MeResponse | null>(meQueryOptions(token))
}

export function usePermission(perm: Permission): boolean {
  const { data } = useActor()
  // Fails closed on anything that is not a permission array: loading, logged
  // out, and a malformed/partial /me payload all answer "no". RFC-270 made this
  // explicit because the hook moved into the canvas render path, where a
  // payload missing `permissions` used to throw and take the whole editor down
  // instead of merely hiding a control.
  if (!data || !Array.isArray(data.permissions)) return false
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
