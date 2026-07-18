// Subscribe to /ws/tasks for instant list refresh. Replaces the 4s polling
// loop on the Tasks page once a WS connection is established; the polling
// fallback stays in place at a longer interval (15s) for the case where
// the daemon WS subsystem is temporarily unavailable.
//
// RFC-152 — thin wrapper over the useWsInvalidation rules table.

import type { TasksListWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

const RULES: WsInvalidationRules<TasksListWsMessage> = {
  'task.created': () => [['tasks']],
  'task.status': () => [['tasks']],
  'task.deleted': () => [['tasks']],
  // RFC-053 P-6: the banner on the detail page subscribes to
  // ['tasks', taskId, 'alerts']; refresh that query so a stuck task lights
  // up without waiting for the 30s poll fallback. Deliberately does NOT
  // touch the broad ['tasks'] key (saves a list-page round-trip).
  'lifecycle.alert': (msg) => [['tasks', msg.taskId, 'alerts']],
}

export function useTasksSync(enabled: boolean = true): void {
  useWsInvalidation<TasksListWsMessage>(enabled ? WS_PATHS.tasksList : null, RULES, undefined, {
    reconcileOnOpen: () => [['tasks']],
  })
}
