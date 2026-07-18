// RFC-159 — live-invalidate scheduled-task queries from the /ws/scheduled-tasks stream.
import type { ScheduledTaskWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'

import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export const SCHEDULED_TASK_QUERY_KEYS = {
  list: ['scheduled-tasks', 'list'] as const,
  detail: (id: string) => ['scheduled-tasks', 'detail', id] as const,
  history: (id: string) => ['scheduled-tasks', 'history', id] as const,
}

const RULES: WsInvalidationRules<ScheduledTaskWsMessage> = {
  'scheduled.created': () => [SCHEDULED_TASK_QUERY_KEYS.list],
  'scheduled.deleted': () => [SCHEDULED_TASK_QUERY_KEYS.list],
  'scheduled.updated': (m) => [
    SCHEDULED_TASK_QUERY_KEYS.list,
    SCHEDULED_TASK_QUERY_KEYS.detail(m.id),
  ],
  'scheduled.fired': (m) => [
    SCHEDULED_TASK_QUERY_KEYS.list,
    SCHEDULED_TASK_QUERY_KEYS.detail(m.id),
    SCHEDULED_TASK_QUERY_KEYS.history(m.id),
  ],
}

export function useScheduledTaskWs(opts: { enabled?: boolean } = {}): void {
  const enabled = opts.enabled ?? true
  useWsInvalidation<ScheduledTaskWsMessage>(
    enabled ? WS_PATHS.scheduledTasks : null,
    RULES,
    undefined,
    { reconcileOnOpen: () => [['scheduled-tasks']] },
  )
}
