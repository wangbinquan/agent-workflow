import { WS_PATHS } from '@agent-workflow/shared'
import { ACTOR_QUERY_KEY } from './useActor'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

interface AuthorityChangedFrame {
  readonly type: 'authority.changed'
  readonly revision: number
}

// useWebSocket already handles authority.changed globally. This hook adds the
// lossy-stream reconciliation contract: every physical open (including a
// reconnect after missed frames) re-reads the current actor once.
const AUTHORITY_RULES: WsInvalidationRules<AuthorityChangedFrame, void> = {}
const reconcileActorOnOpen = (): readonly (readonly string[])[] => [ACTOR_QUERY_KEY]

/** Keep current-account capabilities fresh on every authenticated route.
 * Frames invalidate immediately; reconnects reconcile anything missed. */
export function useAuthoritySync(): void {
  useWsInvalidation(WS_PATHS.authority, AUTHORITY_RULES, undefined, {
    reconcileOnOpen: reconcileActorOnOpen,
  })
}
