// RFC-036 — current actor + permission set from /api/auth/me.
// Returns null while loading or when unauthenticated.
//
// Cache strategy: the auth token participates in the queryKey so logging
// out + back in with a different account invalidates the prior actor's
// /me payload immediately (instead of holding stale role/permission data
// until the 30-s staleTime elapses). A null token short-circuits the
// fetch and returns null.

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useMemo, useSyncExternalStore } from 'react'
import type {
  PatPublic,
  Permission,
  UserIdentity,
  UserPrivateProfile,
  UserPublic,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { getAuthSessionRevision, getToken, subscribeAuth } from '@/stores/auth'

export interface MeResponse {
  user: UserPublic
  profile: UserPrivateProfile
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

/** Settled current-authority snapshot for permission-shaped presentation. */
export function useCurrentPermissions(): ReadonlySet<Permission> {
  const actor = useActor()
  if (actor.status !== 'success' || actor.fetchStatus !== 'idle' || !isUsableActor(actor.data)) {
    return new Set()
  }
  return new Set(actor.data.permissions)
}

export interface ResolvedPermissionSnapshot {
  /** `/me` 至少成功解析过一次，且解析出的账号是可用的（active + 权限数组）。 */
  readonly resolved: boolean
  /** 末次成功解析出的权限集合；`resolved === false` 时恒为空集。 */
  readonly permissions: ReadonlySet<Permission>
}

/**
 * 末次**已解析**的权限快照 —— 只给「呈现」用：页面骨架、tab 可见性、以及某条**已经
 * 在屏幕上**的路由要不要继续留着。
 *
 * 与 `useCurrentPermissions` 的唯一区别是**不看 `fetchStatus`**。为什么必须有这个区别
 * （2026-08-25 用户实测的严重体验问题）：`/me` 的后台 refetch 是家常便饭——`/ws/authority`
 * 每次物理重连都会失效它（hooks/useAuthoritySync.ts）、staleTime 30s 过后任何一个新挂载的
 * 观察者都会触发 `refetchOnMount`。把这几百毫秒当成「暂时无权限」的后果是：
 *   - AppShell 把整条已授权路由塞进 `<Activity mode="hidden">` 并把 `RoutePortalScope`
 *     关掉，于是**所有挂在 body 上的 portal（Dialog / Select 浮层）被整体摘除**；
 *   - tasks.detail 同时整页早退成 `<LoadingState>`，把面板连同它持有的 UI 状态一起卸掉。
 * 两者叠加 = 用户正开着的任务结构图弹窗，一有新任务 / event 就"页面闪一下然后弹窗没了"。
 * 一次例行续期不是「授权不明」，呈现面不该为它买单。
 *
 * **写权判定绝不能用它**：动作面继续走 `usePermission` / `hasPermissionAtRequest`
 * （refetch 期间一律 false），请求到了服务端还会再判一次。真正的"不明"——从未解析成功
 * （`status === 'pending'`）或解析失败（`status === 'error'`）——在这里同样返回
 * `resolved: false`，调用方照旧按失败处置。
 */
export function useLastResolvedPermissions(): ResolvedPermissionSnapshot {
  const actor = useActor()
  const { status, data } = actor
  return useMemo(() => {
    if (status !== 'success' || !isUsableActor(data)) {
      return { resolved: false, permissions: new Set<Permission>() }
    }
    return { resolved: true, permissions: new Set<Permission>(data.permissions) }
  }, [status, data])
}
