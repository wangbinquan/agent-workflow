import { useEffect } from 'react'
import { WS_PATHS } from '@agent-workflow/shared'
import { ACTOR_QUERY_KEY } from './useActor'
import { appQueryClient } from '@/lib/query-client'
import { useWebSocket } from './useWebSocket'

const ignoreProductFrame = (): void => {}

/** Keep current-account capabilities fresh on every authenticated route.
 * Frames invalidate immediately; reconnects reconcile anything missed. */
export function useAuthoritySync(): void {
  // Authority is app-wide and useWebSocket already routes authority.changed
  // frames to this exact global cache. Reconcile the same cache after every
  // physical open without adding a hidden QueryClientProvider requirement to
  // AppShell (it is also rendered in isolation by shell tests and embedders).
  const connectionState = useWebSocket({
    path: WS_PATHS.authority,
    onMessage: ignoreProductFrame,
  })
  useEffect(() => {
    if (connectionState.connectionEpoch === 0) return
    void appQueryClient.invalidateQueries({ queryKey: ACTOR_QUERY_KEY })
  }, [connectionState.connectionEpoch])
}
