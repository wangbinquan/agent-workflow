// RFC-234 — live-invalidate intent-session queries from /ws/intent-sessions.
import type { IntentSessionWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'

import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export const INTENT_QUERY_KEYS = {
  list: ['intent-sessions', 'list'] as const,
  detail: (id: string) => ['intent-sessions', 'detail', id] as const,
}

const RULES: WsInvalidationRules<IntentSessionWsMessage> = {
  'intent.turn.started': (m) => [INTENT_QUERY_KEYS.list, INTENT_QUERY_KEYS.detail(m.sessionId)],
  'intent.turn.finished': (m) => [INTENT_QUERY_KEYS.list, INTENT_QUERY_KEYS.detail(m.sessionId)],
  'intent.session.updated': (m) => [INTENT_QUERY_KEYS.list, INTENT_QUERY_KEYS.detail(m.sessionId)],
  'intent.apply.committed': (m) => [
    INTENT_QUERY_KEYS.list,
    INTENT_QUERY_KEYS.detail(m.sessionId),
    // Committed bundles land real resources — refresh the six resource lists.
    ['agents'],
    ['skills'],
    ['mcps'],
    ['plugins'],
    ['workflows'],
    ['workgroups'],
  ],
}

export function useIntentSessionsWs(opts: { enabled?: boolean } = {}): void {
  const enabled = opts.enabled ?? true
  useWsInvalidation<IntentSessionWsMessage>(
    enabled ? WS_PATHS.intentSessions : null,
    RULES,
    undefined,
    { reconcileOnOpen: () => [['intent-sessions']] },
  )
}
