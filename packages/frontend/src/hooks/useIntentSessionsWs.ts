// RFC-234 — live-invalidate intent-session queries from /ws/intent-sessions.
import type { IntentSessionListPage, IntentSessionWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useCallback } from 'react'
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'

import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export const INTENT_QUERY_KEYS = {
  list: ['intent-sessions', 'list'] as const,
  detail: (id: string) => ['intent-sessions', 'detail', id] as const,
  turnSession: (sessionId: string, turnId: string) =>
    ['intent-sessions', 'detail', sessionId, 'turns', turnId, 'session'] as const,
}

interface IntentWsContext {
  resetListPages: () => void
}

export function resetIntentListPages(qc: QueryClient): void {
  qc.setQueryData<InfiniteData<IntentSessionListPage, string | null>>(
    INTENT_QUERY_KEYS.list,
    (current) =>
      current === undefined || current.pages.length <= 1
        ? current
        : {
            pages: current.pages.slice(0, 1),
            pageParams: current.pageParams.slice(0, 1),
          },
  )
}

function listAndDetail(sessionId: string, ctx: IntentWsContext): readonly (readonly unknown[])[] {
  ctx.resetListPages()
  return [INTENT_QUERY_KEYS.list, INTENT_QUERY_KEYS.detail(sessionId)]
}

const RULES: WsInvalidationRules<IntentSessionWsMessage, IntentWsContext> = {
  'intent.turn.started': (m, ctx) => listAndDetail(m.sessionId, ctx),
  'intent.turn.finished': (m, ctx) => listAndDetail(m.sessionId, ctx),
  'intent.turn.execution.updated': (m) => [INTENT_QUERY_KEYS.turnSession(m.sessionId, m.turnId)],
  'intent.session.updated': (m, ctx) => listAndDetail(m.sessionId, ctx),
  'intent.apply.committed': (m, ctx) => {
    ctx.resetListPages()
    return [
      INTENT_QUERY_KEYS.list,
      INTENT_QUERY_KEYS.detail(m.sessionId),
      // Committed bundles land real resources — refresh the six resource lists.
      ['agents'],
      ['skills'],
      ['mcps'],
      ['plugins'],
      ['workflows'],
      ['workgroups'],
    ]
  },
}

export function useIntentSessionsWs(opts: { enabled?: boolean } = {}): void {
  const enabled = opts.enabled ?? true
  const qc = useQueryClient()
  const resetListPages = useCallback(() => resetIntentListPages(qc), [qc])
  useWsInvalidation<IntentSessionWsMessage, IntentWsContext>(
    enabled ? WS_PATHS.intentSessions : null,
    RULES,
    { resetListPages },
    {
      reconcileOnOpen: (ctx) => {
        ctx?.resetListPages()
        return [['intent-sessions']]
      },
    },
  )
}
