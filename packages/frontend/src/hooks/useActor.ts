// RFC-036 — current actor + permission set from /api/auth/me.
// Returns null while loading or when unauthenticated.
//
// Cache strategy: the auth token participates in the queryKey so logging
// out + back in with a different account invalidates the prior actor's
// /me payload immediately (instead of holding stale role/permission data
// until the 30-s staleTime elapses). A null token short-circuits the
// fetch and returns null.

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import type { PatPublic, Permission, UserIdentity, UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { getAuthSessionRevision, getToken, subscribeAuth } from '@/stores/auth'

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
 * Opaque, non-secret credential identity. It changes synchronously whenever
 * setToken/clearToken installs a different credential, so resource caches and
 * stale event handlers can be bound to the actor that created them without
 * retaining another copy of the token.
 */
export function useAuthSessionRevision(): number {
  return useSyncExternalStore(subscribeAuth, getAuthSessionRevision, () => 0)
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

/**
 * Return the actor only while the token-scoped `/me` query is a settled,
 * successful snapshot. React Query deliberately retains successful data while
 * a background refetch is pending or has failed; authorization must never use
 * that retained payload as current authority.
 */
export function currentActorAtRequest(client: QueryClient): MeResponse | null | undefined {
  const key = meQueryOptions(getToken()).queryKey
  const state = client.getQueryState(key)
  if (state?.status !== 'success' || state.fetchStatus !== 'idle') return undefined
  return client.getQueryData<MeResponse | null>(key)
}

function isUsableActor(value: unknown): value is MeResponse {
  if (typeof value !== 'object' || value === null) return false
  const actor = value as Partial<MeResponse>
  return (
    typeof actor.user === 'object' &&
    actor.user !== null &&
    typeof actor.user.id === 'string' &&
    actor.user.status === 'active' &&
    Array.isArray(actor.permissions)
  )
}

/** Final request-boundary permission check for detached/stale event handlers. */
export function hasPermissionAtRequest(client: QueryClient, perm: Permission): boolean {
  const actor = currentActorAtRequest(client)
  return isUsableActor(actor) && actor.permissions.includes(perm)
}

export function usePermission(perm: Permission): boolean {
  const actor = useActor()
  // Fails closed on anything that is not a permission array: loading, logged
  // out, a malformed/partial /me payload, or a refetch error all answer "no".
  // React Query deliberately retains the last successful data after a
  // background error; consulting data alone would keep stale write capability
  // visible indefinitely while `/me` is failing.
  if (actor.status !== 'success' || actor.fetchStatus !== 'idle' || !isUsableActor(actor.data)) {
    return false
  }
  return actor.data.permissions.includes(perm)
}
