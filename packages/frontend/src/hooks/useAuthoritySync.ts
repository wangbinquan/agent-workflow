import { WS_PATHS } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'

const ignoreProductFrame = (): void => {}

/** Keep current-account capabilities fresh on every authenticated route.
 * `useWebSocket` owns the authority.changed cache invalidation itself. */
export function useAuthoritySync(): void {
  useWebSocket({ path: WS_PATHS.authority, onMessage: ignoreProductFrame })
}
